/**
 * §8 summarization — the only subcommand that spends money, which is what
 * shapes its interface:
 *
 *  - `--dry-run` prints the plan and the call count and never constructs a live
 *    provider, so the cost of asking "what would this cost?" is zero.
 *  - a real run needs its API key up front. Discovering a missing key inside the
 *    third parallel leaf call means a half-summarized tree and a stack trace;
 *    refusing here means neither.
 *  - a real run prints the cost meter (§16) at the end, always.
 */
import {
  InMemoryCostMeter,
  MockProvider,
  Summarizer,
  createProvider,
  loadApiKeys,
  type ContextTreeConfig,
  type CostSnapshot,
  type ModelProvider,
  type NodeId,
  type Seq,
} from '@context-tree/core';
import { configFor, openExistingStore, type GlobalOptions } from '../context.js';
import { CliError, messageOf } from '../errors.js';
import { report, type Io } from '../io.js';

export interface SummarizeOptions extends GlobalOptions {
  /** Only re-summarize what the D4 cascade marked stale. */
  staleOnly?: boolean;
  /** Print the plan and the estimated call count; call no model. */
  dryRun?: boolean;
  /**
   * Provider override. The CLI builds one from the config; tests inject one to
   * assert that a dry run never reaches it.
   */
  provider?: ModelProvider;
}

export interface SummarizePlanEntry {
  nodeId: NodeId;
  title: string;
  /** D2: leaves run on the cheap model, the root on the strong one. */
  role: 'leaf' | 'root';
  staleSinceSeq: Seq | null;
}

export interface SummarizeOutcomeReport {
  nodeId: NodeId;
  role: 'leaf' | 'root';
  status: 'summarized' | 'failed';
  version?: number;
  error?: string;
}

export interface SummarizeReport {
  root: string;
  dryRun: boolean;
  staleOnly: boolean;
  plan: SummarizePlanEntry[];
  /** One model call per planned node, before any contract retry. */
  estimatedCalls: number;
  outcomes: SummarizeOutcomeReport[];
  cost: CostSnapshot | null;
}

export async function summarizeCommand(
  opts: SummarizeOptions,
  io: Io,
): Promise<SummarizeReport> {
  const config = configFor(opts);
  const handle = openExistingStore(config);
  try {
    const root = handle.store.root();
    if (root === null) {
      throw new CliError(`no tree at ${config.root} — import a trace before summarizing it`);
    }
    const dryRun = opts.dryRun === true;
    const staleOnly = opts.staleOnly === true;
    if (!dryRun && opts.provider === undefined) assertKeyPresent(config);

    const costMeter = dryRun ? undefined : new InMemoryCostMeter({ capUsd: config.costCapUsd });
    const summarizer = new Summarizer({
      store: handle.store,
      // A dry run must not be able to spend by accident: this provider throws on
      // the first call rather than quietly answering one.
      provider: opts.provider ?? (dryRun ? new MockProvider({ queue: [] }) : createProvider(config, loadApiKeys())),
      leafModel: config.leafModel,
      rootModel: config.rootModel,
      concurrency: config.summarize.concurrency,
      maxSummaryTokens: config.summarize.maxSummaryTokens,
      trace: handle.trace,
      blobs: handle.blobs,
      costMeter,
    });

    const planIds = staleOnly
      ? summarizer.stalePlan(root.id)
      : [...handle.store.children(root.id).map((child) => child.id), root.id];
    const plan: SummarizePlanEntry[] = planIds.map((id) => {
      const node = handle.store.getNode(id);
      return {
        nodeId: id,
        title: node?.title ?? id,
        role: id === root.id ? 'root' : 'leaf',
        staleSinceSeq: node?.stale_since_seq ?? null,
      };
    });

    if (dryRun) {
      const payload: SummarizeReport = {
        root: config.root,
        dryRun,
        staleOnly,
        plan,
        estimatedCalls: plan.length,
        outcomes: [],
        cost: null,
      };
      report(io, opts.json, payload, humanLines(payload));
      return payload;
    }

    const outcomes = staleOnly
      ? await summarizer.resummarizeStale()
      : await summarizer.summarizeTree(root.id);

    const payload: SummarizeReport = {
      root: config.root,
      dryRun,
      staleOnly,
      plan,
      estimatedCalls: plan.length,
      outcomes: outcomes.map((outcome) => ({
        nodeId: outcome.nodeId,
        role: outcome.role,
        status: outcome.status,
        version: outcome.version,
        error: outcome.error === undefined ? undefined : messageOf(outcome.error),
      })),
      cost: costMeter?.snapshot() ?? null,
    };
    report(io, opts.json, payload, humanLines(payload));

    // §8 collects per-node failures instead of throwing so one dead leaf cannot
    // take the batch down — but a command that summarized nothing must not exit 0.
    const failed = payload.outcomes.filter((outcome) => outcome.status === 'failed');
    if (failed.length > 0) {
      throw new CliError(
        `${failed.length} of ${payload.outcomes.length} summaries failed; see the report above`,
      );
    }
    return payload;
  } finally {
    handle.close();
  }
}

/** §11: keys live in the environment only, and are never printed back. */
function assertKeyPresent(config: ContextTreeConfig): void {
  const keys = loadApiKeys();
  if (config.provider === 'anthropic' && keys.anthropic === undefined) {
    throw new CliError(
      'provider "anthropic" needs ANTHROPIC_API_KEY in the environment — set it, or use --dry-run',
    );
  }
  if (config.provider === 'openrouter' && keys.openrouter === undefined) {
    throw new CliError(
      'provider "openrouter" needs OPENROUTER_API_KEY in the environment — set it, or use --dry-run',
    );
  }
}

function humanLines(payload: SummarizeReport): string[] {
  const scope = payload.staleOnly ? 'stale nodes' : 'the whole tree';
  const lines = [
    payload.dryRun
      ? `dry run over ${scope}: ${payload.estimatedCalls} model call(s), none made`
      : `summarizing ${scope}: ${payload.estimatedCalls} planned call(s)`,
  ];
  for (const entry of payload.plan) {
    const stale = entry.staleSinceSeq === null ? '' : ` stale@${entry.staleSinceSeq}`;
    lines.push(`  ${entry.role.padEnd(4)} ${entry.nodeId}  ${entry.title}${stale}`);
  }
  for (const outcome of payload.outcomes) {
    lines.push(
      outcome.status === 'summarized'
        ? `  ok   ${outcome.nodeId} -> v${outcome.version ?? '?'}`
        : `  FAIL ${outcome.nodeId}: ${outcome.error ?? 'unknown error'}`,
    );
  }
  const cost = payload.cost;
  if (cost !== null) {
    const cap = cost.capUsd === null ? 'no cap' : `cap $${cost.capUsd.toFixed(2)}`;
    lines.push(`cost: $${cost.totalUsd.toFixed(4)} (${cap})`);
    for (const entry of cost.entries) {
      lines.push(
        `  ${entry.model}: ${entry.calls} call(s), ${entry.usage.input} in / ` +
          `${entry.usage.output} out, $${entry.usd.toFixed(4)}`,
      );
    }
  }
  return lines;
}
