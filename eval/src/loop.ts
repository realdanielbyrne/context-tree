/**
 * The §15 harness agent loop — "implements its own minimal tool-use loop"
 * (packages/mcp contract). Each scenario runs twice on the same frontier model:
 *
 *   native        full-transcript context. The message list grows every turn;
 *                 tools are the four harness tools only.
 *   context-tree  the tree IS the context. Every turn's events are appended to
 *                 L0 via `appendEvent`, the §8 summarizer refreshes stale
 *                 branches, and the request is assembled by ZoneAssembler
 *                 (Zone A contract + schemas, Zone B summaries, Zone C active
 *                 branch, tail fetches). The four §9 tools are dispatched
 *                 through the same HANDLERS the MCP server registers.
 *
 * Metrics per run: token totals with the provider's cache split, model turns +
 * tool calls, per-turn latency percentiles, and USD cost via InMemoryCostMeter
 * over every model call in the run — agent, §8 summarizer and judge alike, so
 * the A/B pays for what it actually spends.
 */
import {
  CostCapExceededError,
  HeuristicTokenizer,
  InMemoryCostMeter,
  MeteredProvider,
  Summarizer,
  TreeRetriever,
  ZoneAssembler,
  appendEvent,
  openTaskStore,
  priceFor,
  resolveConfig,
  systemContract,
  toCompletionRequest,
  usdFor,
  type AppendResult,
  type ChatMessage,
  type CompletionRequest,
  type CompletionResult,
  type ContextTreeConfig,
  type ModelProvider,
  type TaskStore,
  type ToolCallRequest,
  type TraceEventInput,
} from '@context-tree/core';
import { HANDLERS, type ToolContext, type ToolName } from '@context-tree/mcp';
import {
  CONTEXT_TOOL_SCHEMAS,
  HARNESS_TOOL_SCHEMAS,
  TREE_COMPLETION_ADDENDUM,
  TREE_ZONE_A_TOOL_SCHEMAS_TEXT,
  executeHarnessTool,
  isContextTool,
  isHarnessTool,
  pathOf,
  type ToolCallOutcome,
} from './tools.js';
import { addTotals, summarizeMetrics, ZERO_TOTALS } from './metrics.js';
import { judgeScenario } from './scoring.js';
import { createSandbox, type Sandbox } from './sandbox.js';
import type { LangfuseRunHandle, LangfuseSink } from './langfuse.js';
import type { Arm, HarnessOptions, RunResult, RunStatus, Scenario, TokenTotals, TurnRecord } from './types.js';
import { join } from 'node:path';

const NATIVE_SYSTEM_PROMPT = [
  'You are a capable coding agent working inside a task sandbox.',
  'Complete the task using the provided tools. Keep tool outputs and file edits precise,',
  'and verify your work by running the relevant commands.',
  'When the task is complete, STOP calling tools and reply with your final answer —',
  'a reply without tool calls ends the task, so make that reply the deliverable the task asks for.',
].join('\n');

const AGENT_MAX_TOKENS = 8192;

export interface LoopOptions {
  runId: string;
  scenario: Scenario;
  arm: Arm;
  agentProvider: ModelProvider;
  /**
   * The §8 summarizer's provider, separate from the agent's only so an offline
   * test can script the two independently. Live runs leave it unset and the
   * agent's provider is reused.
   */
  summarizerProvider?: ModelProvider;
  options: HarnessOptions;
  sink: LangfuseSink;
}

export interface LoopOutput {
  result: RunResult;
  finalText: string;
}

interface ArmArgs {
  scenario: Scenario;
  config: ContextTreeConfig;
  options: HarnessOptions;
  provider: ModelProvider;
  sandbox: Sandbox;
  turns: TurnRecord[];
  usage: TokenTotals;
  runHandle: LangfuseRunHandle;
  deadlineMs: number;
}

interface ArmOutput {
  status: RunStatus;
  finalText: string;
}

async function callModel(args: {
  provider: ModelProvider;
  request: CompletionRequest;
  turnIndex: number;
  runHandle: LangfuseRunHandle;
  usage: TokenTotals;
}): Promise<{ result: CompletionResult; record: TurnRecord }> {
  const startedAt = Date.now();
  const result = await args.provider.complete(args.request);
  const latencyMs = Math.max(1, Date.now() - startedAt);
  const record: TurnRecord = {
    index: args.turnIndex,
    latencyMs,
    usage: result.usage,
    toolCalls: result.toolCalls.map((call) => call.name),
    stopReason: result.stopReason,
  };
  args.runHandle.generation({
    name: `turn-${args.turnIndex}`,
    model: result.model,
    input: {
      systemChars: args.request.system?.length ?? 0,
      messageCount: args.request.messages.length,
      tools: args.request.tools?.map((tool) => tool.name) ?? [],
    },
    output: { textChars: result.text.length, toolCalls: record.toolCalls, stopReason: result.stopReason },
    usage: {
      input: result.usage.input,
      output: result.usage.output,
      unit: 'TOKENS',
      totalCost: usdFor(result.usage, priceFor(result.model).price),
    },
    metadata: { cacheRead: result.usage.cacheRead, cacheWrite: result.usage.cacheWrite, latencyMs },
  });
  return { result, record };
}

function toolResultMessage(call: ToolCallRequest, outcome: ToolCallOutcome): string {
  return `[tool_result ${call.name}] ${outcome.isError ? 'ERROR: ' : ''}${outcome.output}`;
}

/**
 * Repeat-call guard, identical in both arms (so the A/B stays fair): a harness
 * capability, not a context feature. Re-issuing a byte-identical tool call is
 * the signature of an autopilot loop — the result is already in context — so
 * the second call gets guidance instead of another execution.
 */
export function makeRepeatGuard() {
  const seen = new Set<string>();
  return (call: ToolCallRequest, execute: () => Promise<ToolCallOutcome>): Promise<ToolCallOutcome> => {
    const signature = `${call.name}:${JSON.stringify(call.input)}`;
    if (seen.has(signature)) {
      return Promise.resolve({
        output:
          'error: you already ran this exact call and its result is recorded above. ' +
          'Repeating it cannot produce new information. Act on the recorded result, or reply with your final answer now.',
        isError: true,
      });
    }
    seen.add(signature);
    return execute();
  };
}

/**
 * DSA arm — DeepSeek-Sparse-Attention-style top-k selection, lifted from token
 * space to event space. Vanilla (`native`) attends to the whole transcript; the
 * tree attends to a two-level summary. This arm keeps the raw transcript but,
 * each turn, scores every past event and injects only the top-k:
 *
 *   score(event) = w_role + α·recency + β·lexical overlap with the task
 *
 * with recency = index/total and overlap = shared content words with the task
 * text. The caveat the design carries from DSA's sparse-attention kernel: the
 * head of the context is NEVER re-selected or re-ordered — the system prompt
 * and the first user message (the task) are emitted verbatim at the top every
 * turn, so the provider's prompt cache keeps one stable prefix and only the
 * tail varies. Selected events are re-emitted in chronological order (the
 * model reads a coherent transcript, not a ranking).
 *
 * The latest turn's tool results are pinned unconditionally: an agent that
 * cannot see what its own last action returned loops, and the investigate-1
 * incident is the receipt for that failure mode.
 */
const DSA_TOP_K = 6;
const DSA_RECENCY_WEIGHT = 2;
const DSA_RELEVANCE_WEIGHT = 3;
/**
 * The eval floor: below this many tail messages the selector passes the
 * transcript through untouched. Filtering only pays when there is something
 * worth dropping, and every re-selection moves the cache boundary backwards.
 */
const DSA_MIN_TAIL = 10;
const DSA_ROLE_WEIGHTS: Record<string, number> = { user: 1.5, assistant: 0.5 };

const STOP_WORDS = new Set(
  ('a an and are as at be by containing exactly file for from in is it named of on or reply that the then this to verify with word you your'
    .split(' ')),
);

export function contentWords(text: string): Set<string> {
  const words = new Set<string>();
  for (const match of text.toLowerCase().matchAll(/[a-z0-9_.-]{3,}/g)) {
    if (!STOP_WORDS.has(match[0])) words.add(match[0]);
  }
  return words;
}

function overlapScore(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return b.size === 0 ? 0 : shared / b.size;
}

function messageText(message: ChatMessage): string {
  return typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
}

export function selectTopKMessages(
  messages: readonly ChatMessage[],
  taskWords: Set<string>,
  k: number,
  minTail: number = DSA_MIN_TAIL,
): ChatMessage[] {
  const head = messages[0]; // the task — the stable cache prefix ends here
  if (head === undefined || messages.length <= 1 + minTail) return [...messages];
  const tail = messages.slice(1);
  const pinned = Math.min(2, tail.length); // latest tool results / replies, always visible
  const pool = tail.slice(0, tail.length - pinned);
  const scored = pool.map((message, i) => {
    const recency = (i + 1) / pool.length;
    const role = DSA_ROLE_WEIGHTS[message.role] ?? 0;
    const relevance = overlapScore(contentWords(messageText(message)), taskWords);
    return { message, score: role + DSA_RECENCY_WEIGHT * recency + DSA_RELEVANCE_WEIGHT * relevance };
  });
  const keep = new Set(
    scored
      .map((entry, index) => ({ ...entry, index }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(0, k - pinned))
      .map((entry) => entry.index),
  );
  // Chronological re-emission only within the selected middle: the head is
  // fixed and the pinned suffix is the freshest tail, so the selected block
  // keeps transcript order.
  const selected = pool.filter((_, index) => keep.has(index));
  return [head, ...selected, ...tail.slice(tail.length - pinned)];
}

async function runDsaArm(args: ArmArgs): Promise<ArmOutput> {
  const messages: ChatMessage[] = [{ role: 'user', content: args.scenario.task }];
  const taskWords = contentWords(args.scenario.task);
  const guard = makeRepeatGuard();
  let finalText = '';
  for (let turnIndex = 0; turnIndex < args.options.maxTurns; turnIndex += 1) {
    if (Date.now() >= args.deadlineMs) return { status: 'time_cap', finalText };
    const request: CompletionRequest = {
      model: args.options.model,
      system: NATIVE_SYSTEM_PROMPT,
      messages: selectTopKMessages(messages, taskWords, DSA_TOP_K),
      tools: HARNESS_TOOL_SCHEMAS,
      maxTokens: AGENT_MAX_TOKENS,
    };
    const { result, record } = await callModel({
      provider: args.provider,
      request,
      turnIndex,
      runHandle: args.runHandle,
      usage: args.usage,
    });
    args.turns.push(record);
    Object.assign(args.usage, addTotals(args.usage, result.usage));
    messages.push({ role: 'assistant', content: result.text });
    if (result.toolCalls.length === 0) {
      finalText = result.text;
      return { status: 'completed', finalText };
    }
    for (const call of result.toolCalls) {
      const outcome = await guard(call, () => executeHarnessTool(args.sandbox, call.name, call.input));
      messages.push({ role: 'user', content: toolResultMessage(call, outcome) });
    }
  }
  return { status: 'turn_cap', finalText };
}

async function runNativeArm(args: ArmArgs): Promise<ArmOutput> {
  const messages: ChatMessage[] = [{ role: 'user', content: args.scenario.task }];
  const guard = makeRepeatGuard();
  let finalText = '';
  for (let turnIndex = 0; turnIndex < args.options.maxTurns; turnIndex += 1) {
    if (Date.now() >= args.deadlineMs) return { status: 'time_cap', finalText };
    const request: CompletionRequest = {
      model: args.options.model,
      system: NATIVE_SYSTEM_PROMPT,
      messages: [...messages],
      tools: HARNESS_TOOL_SCHEMAS,
      maxTokens: AGENT_MAX_TOKENS,
    };
    const { result, record } = await callModel({
      provider: args.provider,
      request,
      turnIndex,
      runHandle: args.runHandle,
      usage: args.usage,
    });
    args.turns.push(record);
    Object.assign(args.usage, addTotals(args.usage, result.usage));
    messages.push({ role: 'assistant', content: result.text });
    if (result.toolCalls.length === 0) {
      finalText = result.text;
      return { status: 'completed', finalText };
    }
    for (const call of result.toolCalls) {
      const outcome = await guard(call, () => executeHarnessTool(args.sandbox, call.name, call.input));
      messages.push({ role: 'user', content: toolResultMessage(call, outcome) });
    }
  }
  return { status: 'turn_cap', finalText };
}

function appendTo(handle: TaskStore, input: TraceEventInput): AppendResult {
  return appendEvent(handle, input);
}

/**
 * Branch-level DSA for the tree arm: instead of attending to every branch
 * summary in Zone B, keep only the top-k branches by
 *
 *   score(branch) = α·recency + β·lexical overlap of its summary with the task
 *
 * recency = creation-order index / count. The task root is exempt (the anchor
 * Zone B never drops) and the active branch is exempt (its detail is Zone C).
 * Selection changes MEMBERSHIP only — kept branches render in creation order,
 * so the Zone B prefix stays as stable as the tree's own rule 1 allows.
 *
 * The eval-floor property the design requires: k >= branch count returns
 * `undefined` — "no selection" — so short problems take the exact same code
 * path as the plain tree arm and there is no cache perturbation to pay for.
 */
const TREE_DSA_TOP_K_BRANCHES = 3;
const TREE_DSA_RECENCY_WEIGHT = 1;
const TREE_DSA_RELEVANCE_WEIGHT = 4;
const TREE_DSA_DIVERSITY_WEIGHT = 2;

/** Lowercased, stopword-filtered term counts (same tokenizer as contentWords). */
export function termCounts(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const word of contentWords(text)) out.set(word, (out.get(word) ?? 0) + 1);
  return out;
}

/** Cosine similarity between two weighted term vectors. */
export function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const value of a.values()) normA += value * value;
  for (const value of b.values()) normB += value * value;
  for (const [term, value] of a) {
    const other = b.get(term);
    if (other !== undefined) dot += value * other;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}

/**
 * idf-weighted TF vectors over a corpus (here: the branch summaries) plus the
 * query. This is the "latent space" the DSA selector works in — a deterministic
 * lexical vector space (cosine / KNN-adjacent) with no embedding API call and
 * no LLM tokens: relevance = cosine(branch, task).
 */
export function idfVectors(
  texts: readonly string[],
  queryTerms: ReadonlySet<string>,
): { vectors: Map<string, number>[]; query: Map<string, number> } {
  const raw = texts.map(termCounts);
  const df = new Map<string, number>();
  const bump = (terms: Map<string, number>): void => {
    for (const term of terms.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  };
  for (const terms of raw) bump(terms);
  const querySource = termCounts(Array.from(queryTerms).join(' '));
  bump(querySource);
  const n = raw.length + 1;
  const idf = (term: string): number => 1 + Math.log(n / (1 + (df.get(term) ?? 0)));
  const weighted = (terms: Map<string, number>): Map<string, number> => {
    const out = new Map<string, number>();
    for (const [term, count] of terms) out.set(term, count * idf(term));
    return out;
  };
  return { vectors: raw.map(weighted), query: weighted(querySource) };
}

export function selectTopKBranches(
  branches: readonly { id: string; text: string }[],
  taskWords: Set<string>,
  k: number,
): ReadonlySet<string> | undefined {
  if (branches.length <= k) return undefined;
  const { vectors, query } = idfVectors(branches.map((branch) => branch.text), taskWords);
  const scored = branches.map((branch, i) => {
    const recency = (i + 1) / branches.length;
    const relevance = cosineSimilarity(vectors[i]!, query);
    return { branch, index: i, recency, relevance };
  });
  // Greedy farthest-point (max-min diversity) sampling: pick the best branch
  // first, then repeatedly the branch that is relevant/recency-strong AND
  // semantically furthest (smallest cosine) from the picks so far. Top-k by
  // score alone over-selects near-duplicate relevant branches; spreading the
  // kept branches is the DSA-style sparse-attention move, done in the vector
  // space instead of with an embedding model's tokens.
  const selected: number[] = [];
  while (selected.length < k) {
    let best = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < scored.length; i++) {
      if (selected.includes(i)) continue;
      const candidate = scored[i]!;
      const minCosine =
        selected.length === 0
          ? 0
          : Math.min(...selected.map((picked) => cosineSimilarity(vectors[i]!, vectors[picked]!)));
      const diversity = 1 - minCosine;
      const score =
        TREE_DSA_RECENCY_WEIGHT * candidate.recency +
        TREE_DSA_RELEVANCE_WEIGHT * candidate.relevance +
        TREE_DSA_DIVERSITY_WEIGHT * diversity;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    selected.push(best);
  }
  return new Set(selected.map((index) => branches[index]!.id));
}

/**
 * Lazy-summarization policy for the tree arm. Awaited summarization on every
 * turn charges two model calls (leaf + root) against a trace whose raw events
 * still fit comfortably in Zone C — on short tasks the summarizer costs more
 * than the context it saves. So the arm summarizes only once enough new events
 * have accumulated to make a summary cheaper than the raw detail it replaces,
 * and reports how many summarize passes each run actually paid for.
 */
const SUMMARIZE_MIN_NEW_EVENTS = 8;

/**
 * The summary circuit breaker's decision: split a summarization plan into the
 * nodes that should still run and the nodes to skip. A node whose summarization
 * broke the §8 contract already cost a full try+retry (two model calls) and
 * threw — re-processing it re-pays that for the identical failure, while fresh
 * siblings in the same plan still deserve their summary. §8's contract is that
 * a half-summarized tree is still usable, so skipping is graceful degradation,
 * not a correctness loss.
 */
export function splitSummarizePlan(
  plan: readonly string[],
  failed: ReadonlySet<string>,
): { pending: string[]; skipped: number } {
  const pending = plan.filter((nodeId) => !failed.has(nodeId));
  return { pending, skipped: plan.length - pending.length };
}

/**
 * Optional Zone B branch filter for the tree arm, evaluated each turn BEFORE
 * assemble(). Returning `undefined` means "no selection" — the plain tree
 * path, byte-identical prompt. This is the seam the tree-dsa arm hangs its
 * top-k branch sampling on without forking the loop.
 */
type BranchSelector = (handle: TaskStore, activeNodeId: string | undefined) => ReadonlySet<string> | undefined;

/** The tree-dsa arm's selector: top-k branch summaries by recency + task relevance. */
function makeTreeDsaSelector(task: string): BranchSelector {
  const taskWords = contentWords(task);
  return (handle, activeNodeId) => {
    const rootId = handle.store.root()?.id;
    const branches = handle.store
      .nodesInCreationOrder()
      .filter((node) => node.id !== rootId && node.id !== activeNodeId && node.parent_id === rootId)
      .map((node) => ({
        id: node.id as string,
        text: `${node.title}\n${handle.store.currentSummary(node.id)?.text ?? ''}`,
      }));
    return selectTopKBranches(branches, taskWords, TREE_DSA_TOP_K_BRANCHES);
  };
}

async function runTreeArm(
  args: ArmArgs & { summarizerProvider: ModelProvider; selectBranches?: BranchSelector },
): Promise<ArmOutput> {
  const handle = openTaskStore(args.config);
  try {
    const summarizer = new Summarizer({
      store: handle.store,
      provider: args.summarizerProvider,
      leafModel: args.options.leafModel,
      rootModel: args.options.rootModel,
      trace: handle.trace,
      blobs: handle.blobs,
      maxSummaryTokens: 1024,
    });
    const retriever = new TreeRetriever({ store: handle.store, blobs: handle.blobs, trace: handle.trace });
    const toolCtx: ToolContext = { config: args.config, handle, retriever };
    const guard = makeRepeatGuard();
    const assembler = new ZoneAssembler({
      store: handle.store,
      blobs: handle.blobs,
      trace: handle.trace,
      tokenizer: new HeuristicTokenizer(),
      systemContract: systemContract() + TREE_COMPLETION_ADDENDUM,
      budgets: { ...args.options.budgets },
    });

    const ts = () => new Date().toISOString();
    appendTo(handle, { type: 'user_message', ts: ts(), blob: handle.blobs.put(args.scenario.task) });
    // Lazy summarization (see SUMMARIZE_MIN_NEW_EVENTS): a one-event trace has
    // nothing to summarize — Zone C carries the raw event within budget. The
    // first summarize pass waits until enough events exist to be worth two
    // model calls.
    let newEventsSinceSummary = 1;
    // Summary circuit breaker: record nodes whose summarization broke the §8
    // contract (each failure = a full try+retry, two model calls) and exclude
    // them from later plans while still summarising fresh siblings — via the
    // D11 per-node scheduler (scheduleSummarize + drain), which preserves the
    // plan's leaves-then-root order on its promise chain.
    const failedSummaryNodes = new Set<string>();
    const maybeResummarize = async (): Promise<void> => {
      if (newEventsSinceSummary < SUMMARIZE_MIN_NEW_EVENTS) return;
      const rootId = handle.store.root()?.id;
      const plan = rootId === undefined ? [] : summarizer.stalePlan(rootId);
      const { pending, skipped } = splitSummarizePlan(plan, failedSummaryNodes);
      if (skipped > 0) {
        process.stderr.write(
          `[eval] summary circuit breaker: skipping ${skipped} node(s) that already failed the §8 contract once\n`,
        );
      }
      if (pending.length === 0) {
        newEventsSinceSummary = 0;
        return;
      }
      const before = summarizer.backgroundOutcomes().length;
      for (const nodeId of pending) summarizer.scheduleSummarize(nodeId);
      await summarizer.drain();
      for (const outcome of summarizer.backgroundOutcomes().slice(before)) {
        if (outcome.status === 'failed') {
          failedSummaryNodes.add(outcome.nodeId);
          process.stderr.write(
            `[eval] summarization failed on ${outcome.nodeId} (${outcome.role}): ${outcome.error?.message ?? 'unknown error'}\n`,
          );
        }
      }
      newEventsSinceSummary = 0;
    };

    const treeTools = [...HARNESS_TOOL_SCHEMAS, ...CONTEXT_TOOL_SCHEMAS];
    let finalText = '';
    let tailCounter = 0;
    // Completion-gate state (see the bare-text branch below).
    let toolWorkDone = false;
    let completionConfirmed = false;
    for (let turnIndex = 0; turnIndex < args.options.maxTurns; turnIndex += 1) {
      if (Date.now() >= args.deadlineMs) return { status: 'time_cap', finalText };
      const activeNodeId = handle.store.openPhase()?.id ?? handle.store.root()?.id;
      const keepBranches = args.selectBranches?.(handle, activeNodeId);
      if (args.selectBranches !== undefined) {
        // Telemetry: whether branch sampling fired this turn, and how much it kept.
        const total = handle.store.nodesInCreationOrder().filter((n) => n.parent_id === handle.store.root()?.id).length;
        process.stderr.write(
          `[tree-dsa] turn ${turnIndex}: ${keepBranches === undefined ? `all ${total} branches (within k)` : `kept ${keepBranches.size}/${total} branches`}\n`,
        );
      }
      const prompt = assembler.assemble({
        toolSchemasText: TREE_ZONE_A_TOOL_SCHEMAS_TEXT,
        // appendEvent re-ingests the whole log each turn, and the segmenter ends
        // every trace by closing all phases and the task node — so openPhase()
        // is ALWAYS null here and the assembler would emit an empty Zone C (the
        // investigate-1 root cause: the model never saw its own tool results and
        // looped on stale summaries). Zone C must not vanish: expand the root,
        // which spans the whole trace.
        activeNodeId,
        selection: keepBranches === undefined ? undefined : { keepBranches },
      });
      const request = toCompletionRequest(prompt, args.options.model, {
        tools: treeTools,
        maxTokens: AGENT_MAX_TOKENS,
      });
      const { result, record } = await callModel({
        provider: args.provider,
        request,
        turnIndex,
        runHandle: args.runHandle,
        usage: args.usage,
      });
      args.turns.push(record);
      Object.assign(args.usage, addTotals(args.usage, result.usage));

      const openBefore = handle.store.openPhase()?.id ?? null;
      const assistantEvent = appendTo(handle, {
        type: 'assistant_message',
        ts: ts(),
        blob: handle.blobs.put(result.text),
      });
      if (result.toolCalls.length === 0) {
        // Completion gate (iter 3): a bare-text reply right after tool work can
        // be premature completion — the thin early tree prompt lacks the "look
        // how much is still undone" signal native's growing transcript gives.
        // The first such reply gets one ephemeral nudge; only a SECOND
        // consecutive bare-text reply ends the run. Costs one cheap cached
        // turn exactly when the failure mode would otherwise fire.
        if (toolWorkDone && !completionConfirmed) {
          completionConfirmed = true;
          tailCounter += 1;
          assembler.appendTail({
            id: `completion-check-${tailCounter}`,
            text: 'system: you stopped calling tools. If every step of the task is verifiably done, reply with your final answer again; otherwise continue working.',
            ephemeral: true,
          });
          newEventsSinceSummary += 1;
          await maybeResummarize();
          continue;
        }
        finalText = result.text;
        // No end-of-run summarize pass: refreshing the tree for a hypothetical
        // next resumer is D11 sleep-time compute (`scheduleSummarize`), not
        // part of this run's critical path — and this sandbox is discarded
        // anyway. Charging it to the run would bill maintenance as task work.
        return { status: 'completed', finalText };
      }
      toolWorkDone = true;
      for (const call of result.toolCalls) {
        if (isHarnessTool(call.name)) {
          const outcome = await guard(call, () => executeHarnessTool(args.sandbox, call.name, call.input));
          const contentBlob =
            outcome.postContent !== undefined ? handle.blobs.put(outcome.postContent) : undefined;
          const callEvent = appendTo(handle, {
            type: 'tool_call',
            ts: ts(),
            tool: call.name,
            path: pathOf(call.input),
            args_blob: handle.blobs.put(JSON.stringify(call.input)),
            blob: contentBlob,
            parent_seq: assistantEvent.event.seq,
          });
          appendTo(handle, {
            type: 'tool_result',
            ts: ts(),
            call_seq: callEvent.event.seq,
            output_blob: handle.blobs.put(outcome.output),
            error: outcome.isError ? outcome.output.slice(0, 500) : undefined,
          });
          newEventsSinceSummary += 2;
        } else if (isContextTool(call.name)) {
          const outcome = await HANDLERS[call.name as ToolName](toolCtx, call.input);
          const text = outcome.ok
            ? JSON.stringify(outcome.data)
            : `error ${outcome.error.code}: ${outcome.error.message}`;
          tailCounter += 1;
          assembler.appendTail({ id: `${call.name}-${tailCounter}`, text, ephemeral: true });
        } else {
          tailCounter += 1;
          assembler.appendTail({
            id: `unknown-tool-${tailCounter}`,
            text: `error invalid_input: unknown tool ${call.name}`,
            ephemeral: true,
          });
        }
      }
      newEventsSinceSummary += 1; // the assistant message itself
      await maybeResummarize();
      const openAfter = handle.store.openPhase()?.id ?? null;
      if (openAfter !== openBefore) assembler.onPhaseTransition();
    }
    return { status: 'turn_cap', finalText };
  } finally {
    handle.close();
  }
}


export async function runScenario(loop: LoopOptions): Promise<LoopOutput> {
  const { scenario, arm, options } = loop;
  const label = `${scenario.benchmark}-${scenario.id}`;
  const sandbox = createSandbox(scenario, label);
  const startedAt = new Date();
  const turns: TurnRecord[] = [];
  const usage: TokenTotals = { ...ZERO_TOTALS };
  const costMeter = new InMemoryCostMeter({ capUsd: options.costCapUsd });
  const meteredAgent = new MeteredProvider(loop.agentProvider, costMeter);
  const meteredSummarizer = new MeteredProvider(loop.summarizerProvider ?? loop.agentProvider, costMeter);

  const runHandle = loop.sink.startRun({
    runId: loop.runId,
    benchmark: scenario.benchmark,
    scenarioId: scenario.id,
    arm,
    model: options.model,
    scenarioTask: scenario.task,
    meta: { judgeKind: scenario.judge.kind, ...(scenario.meta ?? {}) },
  });

  let status: RunStatus = 'error';
  let errorText: string | undefined;
  let finalText = '';
  let success: boolean | null = null;
  let judgeDetail = '';

  try {
    const config = resolveConfig({
      root: join(sandbox.path, '.context-tree'),
      provider: options.provider,
      leafModel: options.leafModel,
      rootModel: options.rootModel,
      judgeModel: options.judgeModel,
      budgets: { ...options.budgets },
      taskTitle: `${scenario.benchmark}/${scenario.id}`,
    });
    const armArgs: ArmArgs = {
      scenario,
      config,
      options,
      provider: meteredAgent,
      sandbox,
      turns,
      usage,
      runHandle,
      deadlineMs: startedAt.getTime() + options.timeCapMs,
    };
    const output =
      arm === 'native'
        ? await runNativeArm(armArgs)
        : arm === 'dsa'
          ? await runDsaArm(armArgs)
          : arm === 'tree-dsa'
            ? await runTreeArm({
                ...armArgs,
                summarizerProvider: meteredSummarizer,
                selectBranches: makeTreeDsaSelector(scenario.task),
              })
            : await runTreeArm({ ...armArgs, summarizerProvider: meteredSummarizer });
    status = output.status;
    finalText = output.finalText;
  } catch (error) {
    if (error instanceof CostCapExceededError) {
      status = 'cost_cap';
    } else {
      errorText = `${(error as Error).name}: ${(error as Error).message}`;
    }
  }

  if (errorText === undefined && (status === 'completed' || status === 'turn_cap' || status === 'time_cap')) {
    try {
      const judge = await judgeScenario({
        scenario,
        sandbox,
        finalText,
        provider: meteredAgent,
        judgeModel: options.judgeModel,
      });
      success = judge.success;
      judgeDetail = judge.detail;
    } catch (error) {
      if (error instanceof CostCapExceededError) {
        status = 'cost_cap';
      } else {
        errorText = `judge: ${(error as Error).name}: ${(error as Error).message}`;
      }
    }
  }

  const finishedAt = new Date();
  const wallMs = finishedAt.getTime() - startedAt.getTime();
  const metrics = summarizeMetrics({ turns, wallMs, usage, costUsd: costMeter.totalUsd() });
  runHandle.finish(status, metrics, success, judgeDetail);
  if (options.keepSandbox) sandbox.writeFile('.final-answer.txt', finalText);
  else sandbox.cleanup();

  const result: RunResult = {
    runId: loop.runId,
    benchmark: scenario.benchmark,
    scenarioId: scenario.id,
    arm,
    model: options.model,
    status,
    success,
    judge: { success, detail: judgeDetail },
    metrics,
    turns: [...turns],
    error: errorText,
    sandboxPath: options.keepSandbox ? sandbox.path : undefined,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
  };
  return { result, finalText };
}

