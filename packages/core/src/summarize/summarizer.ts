/**
 * §8 summarization engine (D2, D11) and the D4 invalidation cascade.
 *
 * There are exactly two summary roles, because §11 versions exactly two summary
 * prompts: a **leaf** reads a branch's raw L0+L2 detail on the cheap model, and
 * the **root** reads the set of leaf summaries — never raw events — on the
 * strong model. Summarizing raw events at the root is the flat-summary baseline
 * (§15 arm C) this whole design is measured against, so the root call is built
 * from `store.currentSummary(child)` and nothing else.
 *
 * That pairing fixes the tree's summarization shape: the root's direct children
 * are the leaves, and anything deeper (file nodes, D9) is a span carrier whose
 * content reaches the model as part of its leaf's detail.
 *
 * Nothing here depends on a concrete provider. `ModelProvider` and `CostMeter`
 * are interfaces (§11) so the mocked-LLM M2 acceptance, the recorded-completion
 * CI runs and a live Anthropic call are the same code path.
 */
import { DEFAULT_CONFIG } from '../config.js';
import {
  ConfigError,
  StoreInvariantError,
  SummaryContractError,
  SummaryInputError,
  type BlobStore,
  type CostMeter,
  type ModelProvider,
  type NodeId,
  type NodeSummary,
  type Seq,
  type SummaryMeta,
  type TraceLog,
  type TreeNode,
  type TreeStore,
} from '../contracts/index.js';
import { leafSummaryPrompt, rootSummaryPrompt, type ChildSummary } from '../prompts/index.js';
import {
  contractViolation,
  parseSummaryReply,
  summaryMetaFrom,
  type ContractExpectation,
} from './contract.js';
import { branchFacts, renderBranchDetail } from './detail.js';

export interface SummarizerOptions {
  store: TreeStore;
  provider: ModelProvider;
  /** Cheap, high-volume model for the leaves (D2). */
  leafModel: string;
  /** Strong model for the single root call (D2). */
  rootModel: string;
  /** §8 parallel-leaf cap. Defaults to `config.summarize.concurrency` (8). */
  concurrency?: number;
  /**
   * L0. Optional only so a caller can summarize the tree's coordinates without
   * the log; with it, leaf detail is the branch's real events (§6).
   */
  trace?: TraceLog;
  /** L2. Without it, payload refs are named in the detail but not resolved. */
  blobs?: BlobStore;
  /** §16 per-run spend cap. */
  costMeter?: CostMeter;
  /** Injected so `created_at` is deterministic in tests. */
  now?: () => string;
  maxSummaryTokens?: number;
}

export type SummarizeRole = 'leaf' | 'root';

/**
 * One node's result. Collected rather than thrown because §8 says the assembler
 * never blocks on the summarizer: a half-summarized tree is still usable, so a
 * dead leaf must not take the batch down with it.
 */
export interface SummarizeOutcome {
  nodeId: NodeId;
  role: SummarizeRole;
  status: 'summarized' | 'failed';
  /** The version `putSummary` appended (D3), when it succeeded. */
  version?: number;
  error?: Error;
}

const RETRY_PREAMBLE =
  'Your previous reply broke the output contract. Correct exactly this and reply again with the whole JSON object:';

export class Summarizer {
  private readonly store: TreeStore;
  private readonly provider: ModelProvider;
  private readonly leafModel: string;
  private readonly rootModel: string;
  private readonly concurrency: number;
  private readonly trace: TraceLog | undefined;
  private readonly blobs: BlobStore | undefined;
  private readonly costMeter: CostMeter | undefined;
  private readonly now: () => string;
  private readonly maxSummaryTokens: number;

  /** D11's queue: one promise chain, so background work never overlaps a caller's turn. */
  private queue: Promise<void> = Promise.resolve();
  private readonly background: SummarizeOutcome[] = [];

  constructor(options: SummarizerOptions) {
    this.store = options.store;
    this.provider = options.provider;
    this.leafModel = options.leafModel;
    this.rootModel = options.rootModel;
    this.concurrency = options.concurrency ?? DEFAULT_CONFIG.summarize.concurrency;
    this.trace = options.trace;
    this.blobs = options.blobs;
    this.costMeter = options.costMeter;
    this.now = options.now ?? (() => new Date().toISOString());
    this.maxSummaryTokens = options.maxSummaryTokens ?? DEFAULT_CONFIG.summarize.maxSummaryTokens;
    if (this.concurrency <= 0) throw new ConfigError(`summarize concurrency must be > 0, got ${this.concurrency}`);
  }

  /** One branch, from its raw detail, on the cheap model (D2). */
  async summarizeLeaf(nodeId: NodeId): Promise<NodeSummary> {
    const node = this.requireNode(nodeId);
    const facts = branchFacts(this.store, node);
    const childIds = this.store.children(nodeId).map((child) => child.id);
    // Self first: a childless branch still needs one fetch target of its own.
    const nodeIds = [nodeId, ...childIds];
    const prompt = leafSummaryPrompt({
      title: node.title,
      phaseType: node.phase_type,
      nodeIds,
      detail: renderBranchDetail(this.store, node, facts, { trace: this.trace, blobs: this.blobs }),
    });
    const reply = await this.complete(this.leafModel, prompt, { childIds });
    return this.store.transaction(() => {
      const summary = this.store.putSummary({
        node_id: nodeId,
        model: reply.model,
        text: reply.text,
        meta: summaryMetaFrom(reply.meta, facts, nodeIds),
        created_at: this.now(),
      });
      // `putSummary` clears the leaf's own mark; the span carriers beneath it
      // (D9 file nodes) are the same content, reaching the model inside this
      // leaf's detail, and `stalePlan` will never visit them. Clearing them here
      // is what lets `staleNodes()` empty — otherwise a caller that reads a
      // non-empty stale set as "work remains" (`summarize --stale-only`, a
      // background scheduler) has work forever.
      for (const carrier of this.store.descendants(nodeId)) {
        if (carrier.stale_since_seq !== null) this.store.setStale(carrier.id, null);
      }
      return summary;
    });
  }

  /**
   * One call to the strong model over the child summaries (§8). Children without
   * a summary are skipped rather than fetched as raw events: that would be arm C.
   */
  async summarizeRoot(rootId: NodeId): Promise<NodeSummary> {
    const root = this.requireNode(rootId);
    const covered: ChildSummary[] = [];
    for (const child of this.store.children(rootId)) {
      const summary = this.store.currentSummary(child.id);
      if (summary === null) continue;
      covered.push({ nodeId: child.id, title: child.title, text: summary.text, meta: summary.meta });
    }
    if (covered.length === 0) {
      throw new SummaryInputError(
        `node ${rootId} has no summarized child branches to roll up — summarize the leaves first`,
      );
    }
    const facts = branchFacts(this.store, root);
    const childIds = covered.map((child) => child.nodeId);
    const nodeIds = [rootId, ...childIds];
    const prompt = rootSummaryPrompt({ taskTitle: root.title, children: covered });
    const reply = await this.complete(this.rootModel, prompt, { childIds });
    return this.store.putSummary({
      node_id: rootId,
      model: reply.model,
      text: reply.text,
      meta: summaryMetaFrom(reply.meta, facts, nodeIds),
      created_at: this.now(),
    });
  }

  /** Every leaf in parallel under the cap, then the root (§8). */
  async summarizeTree(rootId: NodeId): Promise<SummarizeOutcome[]> {
    const root = this.requireNode(rootId);
    const outcomes = await this.pool(this.store.children(root.id).map((child) => child.id));
    outcomes.push(await this.outcome(root.id, 'root'));
    return outcomes;
  }

  /**
   * D4: mark the leaf and its ancestors stale. Siblings are untouched — that
   * property *is* the amortized 1–3 calls per turn.
   */
  onAppend(nodeId: NodeId, seq: Seq): NodeId[] {
    return this.store.markStaleCascade(nodeId, seq);
  }

  /**
   * The nodes `resummarizeStale` would process, bottom-up with the root last so
   * every parent reads fresh children. Stale nodes deeper than a leaf are absent
   * on purpose: their content is part of their leaf's detail, so re-summarizing
   * that leaf is what refreshes them.
   */
  stalePlan(rootId: NodeId): NodeId[] {
    const root = this.requireNode(rootId);
    const leaves: NodeId[] = [];
    let rootStale = false;
    for (const node of this.store.staleNodes()) {
      if (node.id === root.id) rootStale = true;
      else if (node.parent_id === root.id) leaves.push(node.id);
    }
    return rootStale ? [...leaves, root.id] : leaves;
  }

  async resummarizeStale(): Promise<SummarizeOutcome[]> {
    const root = this.store.root();
    if (root === null) return [];
    const plan = this.stalePlan(root.id);
    const rootStale = plan[plan.length - 1] === root.id;
    const outcomes = await this.pool(rootStale ? plan.slice(0, -1) : plan);
    if (rootStale) outcomes.push(await this.outcome(root.id, 'root'));
    return outcomes;
  }

  /** D11 sleep-time compute: returns before any model call, work runs off the caller's path. */
  scheduleSummarize(nodeId: NodeId): void {
    this.queue = this.queue.then(() => this.outcome(nodeId)).then(
      (outcome) => {
        this.background.push(outcome);
      },
      (error: unknown) => {
        // The chain must never stay rejected, or every later drain() throws
        // someone else's failure.
        this.background.push({ nodeId, role: 'leaf', status: 'failed', error: asError(error) });
      },
    );
  }

  /** Awaits quiescence of the D11 queue, including work scheduled while draining. */
  async drain(): Promise<void> {
    let awaited: Promise<void> | null = null;
    while (awaited !== this.queue) {
      awaited = this.queue;
      await awaited;
    }
  }

  /** Where a background failure surfaces — D11 runs off the caller's path, so nothing else would report it. */
  backgroundOutcomes(): readonly SummarizeOutcome[] {
    return this.background;
  }

  /**
   * §8's content contract, enforced before the write. One retry naming the
   * violation, then a throw: storing a contract-violating summary silently
   * would break §9's relevance detection, the plan's only mitigation for the
   * model not knowing what it does not know.
   */
  private async complete(
    model: string,
    prompt: string,
    expected: ContractExpectation,
  ): Promise<{ text: string; meta: SummaryMeta; model: string }> {
    let violation: string | null = null;
    let maxTokens = this.maxSummaryTokens;
    for (let attempt = 0; ; attempt += 1) {
      const content = violation === null ? prompt : `${prompt}\n\n${RETRY_PREAMBLE}\n${violation}`;
      // §16: refuse to spend past the cap *before* the call. In a batch this
      // makes every remaining leaf fail fast and be reported, rather than
      // silently overrunning the per-PR budget.
      this.costMeter?.assertUnderCap();
      const result = await this.provider.complete({
        model,
        messages: [{ role: 'user', content }],
        json: true,
        maxTokens,
      });
      this.costMeter?.record(result.model || model, result.usage);

      let parsed: { text: string; meta: SummaryMeta } | null = null;
      let problem: string | null = null;
      if (result.stopReason === 'max_tokens') {
        // A reply cut off mid-JSON is not a contract violation by the model —
        // it is a budget failure by us, and retrying at the SAME cap fails
        // byte-identically (the retry preamble even lengthens the prompt).
        // Double the budget for the retry instead of lecturing the model.
        maxTokens *= 2;
        problem = `reply truncated at ${maxTokens / 2} output tokens; answer completely`;
      } else {
        try {
          parsed = parseSummaryReply(result.text);
          problem = contractViolation(parsed.meta, expected);
        } catch (error) {
          if (!(error instanceof SummaryContractError)) throw error;
          problem = error.message;
        }
      }
      if (parsed !== null && problem === null) {
        return { text: parsed.text, meta: parsed.meta, model: result.model || model };
      }
      if (attempt >= 1) {
        throw new SummaryContractError(`${model} broke the §8 summary contract after one retry: ${problem}`);
      }
      violation = problem;
    }
  }

  /**
   * A fixed set of workers pulling from a shared cursor. Written rather than
   * pulled in as a dependency, and the cap matters for a real reason: §8 puts
   * every leaf of a long session in flight at once otherwise.
   */
  private async pool(nodeIds: readonly NodeId[]): Promise<SummarizeOutcome[]> {
    const outcomes = new Array<SummarizeOutcome>(nodeIds.length);
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        const nodeId = nodeIds[index];
        if (nodeId === undefined) return;
        outcomes[index] = await this.outcome(nodeId, 'leaf');
      }
    };
    const width = Math.min(this.concurrency, nodeIds.length);
    await Promise.all(Array.from({ length: width }, () => worker()));
    return outcomes;
  }

  private async outcome(nodeId: NodeId, role?: SummarizeRole): Promise<SummarizeOutcome> {
    const resolved = role ?? (this.store.getNode(nodeId)?.parent_id === null ? 'root' : 'leaf');
    try {
      const summary =
        resolved === 'root' ? await this.summarizeRoot(nodeId) : await this.summarizeLeaf(nodeId);
      return { nodeId, role: resolved, status: 'summarized', version: summary.version };
    } catch (error) {
      return { nodeId, role: resolved, status: 'failed', error: asError(error) };
    }
  }

  private requireNode(id: NodeId): TreeNode {
    const node = this.store.getNode(id);
    if (node === null) throw new StoreInvariantError(`unknown node ${id}`);
    return node;
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
