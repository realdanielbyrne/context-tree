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
  branchFacts,
  composeRootSummary,
  openTaskStore,
  priceFor,
  renderBranchDetail,
  resolveConfig,
  systemContract,
  toCompletionRequest,
  usdFor,
  type AppendResult,
  type AssembledPrompt,
  type ChatMessage,
  type CompletionRequest,
  type CompletionResult,
  type ContextTreeConfig,
  type ModelProvider,
  type SystemContractVersion,
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
import { HARNESS_STOPPED } from './types.js';
import type { Arm, HarnessOptions, RunResult, RunStatus, Scenario, TokenTotals, TurnRecord } from './types.js';
import { join } from 'node:path';

const NATIVE_SYSTEM_PROMPT = [
  'You are a capable coding agent working inside a task sandbox.',
  'Complete the task using the provided tools. Keep tool outputs and file edits precise,',
  'and verify your work by running the relevant commands.',
  'When the task is complete, STOP calling tools and reply with your final answer —',
  'a reply without tool calls ends the task, so make that reply the deliverable the task asks for.',
].join('\n');

/**
 * No reply budget. A number here is a guess about how much the model needs to
 * say, and it is wrong in both directions: too small truncates the deliverable
 * (and on a model that reasons before answering, the budget can be spent
 * thinking, leaving an empty reply that grades as a wrong answer), too large
 * reserves window that could have held context. Omitting `maxTokens` lets each
 * provider apply its own maximum, which is the only number that knows the
 * model. A host that genuinely needs a bound passes one; nothing here imposes
 * it. See `reports/algorithm.md`, "Not part of the algorithm".
 */
const AGENT_MAX_TOKENS: number | undefined = undefined;

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
  /** Tree arm only — item 1's one-way latch; undefined for native/dsa arms. */
  lazyCrossed?: boolean;
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
  /**
   * Consecutive turns in which every call was one the model had already made.
   * This is the non-progress signal that replaced the turn counter: a run ends
   * because it stopped making progress, which is a fact about the run, not
   * because it passed a number, which is a fact about the harness. Reset by any
   * call that had not been seen before.
   */
  let stalledTurns = 0;
  const guard = (call: ToolCallRequest, execute: () => Promise<ToolCallOutcome>): Promise<ToolCallOutcome> => {
    const signature = `${call.name}:${JSON.stringify(call.input)}`;
    if (seen.has(signature)) {
      guard.repeatsThisTurn += 1;
      return Promise.resolve({
        output:
          'error: you already ran this exact call and its result is recorded above. ' +
          'Repeating it cannot produce new information. Act on the recorded result, or reply with your final answer now.',
        isError: true,
      });
    }
    guard.freshThisTurn += 1;
    seen.add(signature);
    return execute();
  };
  guard.repeatsThisTurn = 0;
  guard.freshThisTurn = 0;
  /** Call once per turn, after its tool calls have run. Returns true if stalled. */
  guard.endTurn = (): boolean => {
    const repeated = guard.repeatsThisTurn > 0 && guard.freshThisTurn === 0;
    stalledTurns = repeated ? stalledTurns + 1 : 0;
    guard.repeatsThisTurn = 0;
    guard.freshThisTurn = 0;
    return stalledTurns >= STALL_TURNS;
  };
  return guard;
}

/**
 * How many consecutive no-progress turns end a run. Three, because one repeated
 * call can be a model re-reading before it edits and two can be a retry, while
 * three in a row has never been anything but a loop in this corpus.
 */
export const STALL_TURNS = 3;

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
    if (args.options.temperature != null) request.temperature = args.options.temperature;
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
    // Non-progress, not a counter, is what ends a run that will not finish.
    if (guard.endTurn()) return { status: 'stalled', finalText };
  }
  return { status: 'turn_cap', finalText };
}

async function runNativeArm(args: ArmArgs): Promise<ArmOutput> {
  const messages: ChatMessage[] = [{ role: 'user', content: args.scenario.task }];
  const guard = makeRepeatGuard();
  // v5.2 (EVAL_NATIVE_CACHE=1): real harnesses cache the growing transcript
  // prefix; without this the native arm re-bills the whole conversation as
  // fresh input every turn — a strawman baseline (iter4: 207k cumulative input
  // tokens, cacheRead 0). One breakpoint on the newest message per turn is the
  // provider-documented incremental pattern: each turn reads the prefix the
  // previous turn wrote. Only the copy is marked — mutating history would
  // accumulate markers past the provider's 4-breakpoint limit.
  const nativeCache = process.env.EVAL_NATIVE_CACHE === '1';
  let finalText = '';
  for (let turnIndex = 0; turnIndex < args.options.maxTurns; turnIndex += 1) {
    if (Date.now() >= args.deadlineMs) return { status: 'time_cap', finalText };
    const turnMessages = [...messages];
    if (nativeCache && turnMessages.length > 0) {
      const last = turnMessages.length - 1;
      turnMessages[last] = { ...turnMessages[last]!, cacheBreakpoint: true };
    }
    const request: CompletionRequest = {
      model: args.options.model,
      system: NATIVE_SYSTEM_PROMPT,
      messages: turnMessages,
      tools: HARNESS_TOOL_SCHEMAS,
      maxTokens: AGENT_MAX_TOKENS,
    };
    if (args.options.temperature != null) request.temperature = args.options.temperature;
    if (nativeCache) request.systemCacheBreakpoint = true;
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
    // Non-progress, not a counter, is what ends a run that will not finish.
    if (guard.endTurn()) return { status: 'stalled', finalText };
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
 * Cosine dedup-before-summarize (report §9 Phase 1 item 5), gated behind
 * EVAL_SUMMARY_DEDUP=1 so arms can A/B it. A stale branch whose content is
 * near-identical (>= threshold cosine, in the same idf space the tree-dsa
 * selector uses) to an already-summarized sibling — or to an earlier branch
 * kept in the same plan — is skipped: one summary serves the group. Skipping
 * leaves the branch stale (its old summary or bare title stays in Zone B),
 * which §8 defines as usable degradation, and saves the leaf model call that
 * is the tree arm's dominant marginal cost. The root is never deduped: its
 * input is the leaf summaries, not raw content.
 */
export const SUMMARY_DEDUP_COSINE = 0.9;

export function dedupSummarizePlan(
  pending: readonly { id: string; text: string }[],
  summarized: readonly { id: string; text: string }[],
  threshold: number = SUMMARY_DEDUP_COSINE,
): { kept: string[]; deduped: { id: string; against: string; cosine: number }[] } {
  const entries = [...pending, ...summarized];
  const { vectors } = idfVectors(entries.map((entry) => entry.text), new Set());
  const vecOf = new Map<string, Map<string, number>>();
  entries.forEach((entry, i) => vecOf.set(entry.id, vectors[i]!));
  const kept: string[] = [];
  const deduped: { id: string; against: string; cosine: number }[] = [];
  const anchors = summarized.map((entry) => entry.id);
  for (const entry of pending) {
    let nearest: { against: string; cosine: number } | undefined;
    for (const other of [...anchors, ...kept]) {
      const cosine = cosineSimilarity(vecOf.get(entry.id)!, vecOf.get(other)!);
      if (nearest === undefined || cosine > nearest.cosine) nearest = { against: other, cosine };
    }
    if (nearest !== undefined && nearest.cosine >= threshold) deduped.push({ id: entry.id, ...nearest });
    else kept.push(entry.id);
  }
  return { kept, deduped };
}

/**
 * The comparable slice of a branch's detail: the L0 events, without the
 * coordinates header (node ids and seq ranges are unique per branch and would
 * dilute the cosine between genuinely identical contents).
 */
export function branchContentText(detail: string): string {
  const index = detail.indexOf('EVENTS (L0');
  return index === -1 ? detail : detail.slice(index);
}

/**
 * Optional Zone B branch filter for the tree arm, evaluated each turn BEFORE
 * assemble(). Returning `undefined` means "no selection" — the plain tree
 * path, byte-identical prompt. This is the seam the tree-dsa arm hangs its
 * top-k branch sampling on without forking the loop.
 */
type BranchSelector = (handle: TaskStore, activeNodeId: string | undefined) => ReadonlySet<string> | undefined;

/**
 * v6 keep-set combinator (pure, for tests): the score-selected branches, plus
 * two overrides that turn top-k from an evictor into an admitter —
 *
 *   guards    branches whose §8 meta shows unfinished work (open questions or
 *             failing tests) are never evicted; evicting the unsolved dedent
 *             branch is exactly how iter6's only selector-active run failed.
 *   monotone  once kept, always kept: membership only grows, so a later turn
 *             never churns the Zone B prefix that an earlier turn cached.
 *
 * Returns undefined (the floor property: no selection, byte-identical prompt)
 * when the merged keep-set covers every branch.
 */
export function mergeKeepSets(
  allIds: readonly string[],
  selected: ReadonlySet<string> | undefined,
  guarded: ReadonlySet<string>,
  keptEver: Set<string>,
): ReadonlySet<string> | undefined {
  const keep = new Set<string>(selected ?? allIds);
  for (const id of guarded) keep.add(id);
  for (const id of keptEver) if (allIds.includes(id)) keep.add(id);
  for (const id of keep) keptEver.add(id);
  if (allIds.every((id) => keep.has(id))) return undefined;
  return keep;
}

/**
 * v5.5 (EVAL_ZONEC_CACHE=1): the correspondence-principle request builder.
 * `toCompletionRequest` folds all of Zone C into ONE message, so a breakpoint
 * there would re-WRITE the whole zone at 1.25x on every turn — worse than
 * paying it fresh. Native v5.2 is cheap because its transcript is many
 * messages and the moving breakpoint bills only the newest message as a cache
 * write; everything before it is a 0.1x read. Zone C is append-only within a
 * phase, so emitting one message per Zone C block with the breakpoint on the
 * last reproduces native's incremental economics exactly: at short horizons
 * (one phase) the tree degenerates to cached-native behavior, and the tree
 * only pays for its machinery at phase boundaries, where Zone C swaps
 * wholesale and the old detail has collapsed into a Zone B summary. Requires
 * the Zone C header to carry no volatile bits (seq ranges) — the header is the
 * zone's first block, and a byte of churn there rewrites everything after it.
 */
export function toZoneCCachedRequest(
  prompt: AssembledPrompt,
  model: string,
  options: { tools?: CompletionRequest['tools']; maxTokens?: number; temperature?: number },
): CompletionRequest {
  const byZone = (zone: string) => prompt.blocks.filter((block) => block.zone === zone);
  const messages: ChatMessage[] = [];
  const zoneB = byZone('B');
  if (zoneB.length > 0) {
    messages.push({
      role: 'user',
      content: zoneB.map((block) => block.text).join('\n\n'),
      cacheBreakpoint: true,
    });
  }
  // The C:map block (descendant index) churns on every edit; it must ride
  // AFTER the moving breakpoint or its churn voids the cached event stream —
  // Anthropic cache lookups match previously cached prefixes byte-for-byte,
  // so one changed block ahead of the marker re-writes the whole zone
  // (measured: iter8-rep1, 10–16k cacheWrite/turn with cacheRead pinned).
  const zoneC = byZone('C');
  const cached = zoneC.filter((block) => !block.id.startsWith('C:map:'));
  cached.forEach((block, index) => {
    const message: ChatMessage = { role: 'user', content: block.text };
    if (index === cached.length - 1) message.cacheBreakpoint = true;
    messages.push(message);
  });
  const uncached = [
    ...zoneC.filter((block) => block.id.startsWith('C:map:')),
    ...byZone('tail'),
  ];
  if (uncached.length > 0) {
    messages.push({ role: 'user', content: uncached.map((block) => block.text).join('\n\n') });
  }
  const request: CompletionRequest = { model, system: prompt.system, messages };
  if (prompt.system !== '') request.systemCacheBreakpoint = true;
  if (options.tools !== undefined) request.tools = options.tools;
  if (options.maxTokens !== undefined) request.maxTokens = options.maxTokens;
  if (options.temperature !== undefined) request.temperature = options.temperature;
  return request;
}

/**
 * v6 selector (EVAL_DSA_V6=1): the DSA question asked properly — "given the
 * CURRENT context, which branches matter?" The v2 selector scored against the
 * static task text; on a multi-module task every branch matches the task about
 * equally, so eviction degenerated to recency+diversity noise. Here the query
 * is the tail of the active branch's own detail (what the agent is doing right
 * now) blended with the task, matching DSA's real formulation where the
 * selection query is the current token, not the prompt head.
 */
const DSA_V6_FOCUS_TAIL_CHARS = 2_000;
const DSA_V6_KEEP_FRACTION = 0.5;

function makeTreeDsaV6Selector(task: string): BranchSelector {
  const keptEver = new Set<string>();
  return (handle, activeNodeId) => {
    const rootId = handle.store.root()?.id;
    const nodes = handle.store
      .nodesInCreationOrder()
      .filter((node) => node.id !== rootId && node.id !== activeNodeId && node.parent_id === rootId);
    const branches = nodes.map((node) => ({
      id: node.id as string,
      text: `${node.title}\n${handle.store.currentSummary(node.id)?.text ?? ''}`,
    }));
    const k = Math.max(TREE_DSA_TOP_K_BRANCHES, Math.ceil(branches.length * DSA_V6_KEEP_FRACTION));
    let focus = task;
    const active = handle.store.nodesInCreationOrder().find((node) => node.id === activeNodeId);
    if (active !== undefined) {
      const detail = renderBranchDetail(handle.store, active, branchFacts(handle.store, active), {
        trace: handle.trace,
        blobs: handle.blobs,
      });
      focus = `${task}\n${detail.slice(-DSA_V6_FOCUS_TAIL_CHARS)}`;
    }
    const selected = selectTopKBranches(branches, contentWords(focus), k);
    const guarded = new Set<string>();
    for (const node of nodes) {
      const meta = handle.store.currentSummary(node.id)?.meta;
      if (meta === undefined) continue;
      if (meta.open_questions.length > 0 || meta.tests.some((t) => t.status === 'failed')) {
        guarded.add(node.id as string);
      }
    }
    return mergeKeepSets(branches.map((b) => b.id), selected, guarded, keptEver);
  };
}

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
      ...(args.options.temperature != null ? { temperature: args.options.temperature } : {}),
    });
    const retriever = new TreeRetriever({ store: handle.store, blobs: handle.blobs, trace: handle.trace });
    const toolCtx: ToolContext = { config: args.config, handle, retriever };
    const guard = makeRepeatGuard();
    // loop9-item3 step 1 (EVAL_CONTRACT_VERSION=v2): selects the Zone A trim
    // candidate — system-contract.v2.md, v1 minus its "Two ways this goes
    // wrong" section (§7, loop9-item3-sw3-overhead.md). Unset stays v1
    // (systemContract()'s own default), so the transplant experiment's frozen
    // epoch is untouched; an unrecognized value throws (systemContract itself
    // validates it) rather than silently falling back.
    const contractVersion = process.env.EVAL_CONTRACT_VERSION as SystemContractVersion | undefined;
    const assembler = new ZoneAssembler({
      store: handle.store,
      blobs: handle.blobs,
      trace: handle.trace,
      tokenizer: new HeuristicTokenizer(),
      systemContract: systemContract(contractVersion) + TREE_COMPLETION_ADDENDUM,
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
    // v5.4 (EVAL_SUMMARIZE_ON_CLOSE=1): event-driven summarization replaces
    // the SUMMARIZE_MIN_NEW_EVENTS threshold. A branch is summarized exactly
    // once, when it CLOSES (a newer branch appears after it); the newest
    // branch is never summarized because its raw detail is Zone C. The
    // threshold made summarizer cost a function of turn-count noise (a run
    // ending one event shy of a crossing paid zero; its twin paid a full
    // pass); on-close makes it a deterministic function of tree structure —
    // one leaf call per closed branch, one root update per phase close, and
    // Zone B changes once per transition, which is the §17 cache model.
    const summarizeOnClose = process.env.EVAL_SUMMARIZE_ON_CLOSE === '1';
    // v5.7 (EVAL_LAZY_K=<k>): below k branches the tree devolves to baseline
    // behavior by design — Zone C is the whole (cached) trace and Zone B is
    // empty — so summaries buy nothing and we spend nothing building them.
    // Staleness accumulates anyway (the D4 cascade runs on append), so the
    // first pass at the k-th branch catches up on every skipped branch in one
    // parallel leaf batch: one cache epoch instead of k-1 boundary resets.
    const lazyK = Number.parseInt(process.env.EVAL_LAZY_K ?? '0', 10) || 0;
    // v6.0 (EVAL_LAZY_TOKENS=<n>): the below-k rule in token form. While the
    // WHOLE trace fits where the active branch's detail would go, showing it
    // all IS the optimal context — summaries buy nothing, so build none.
    // Branch-count k was the first cut and its failure mode was the LATE
    // crossing (v5.7: runs crossing at turn 11-17 flailed to the 40-turn cap;
    // crossings at 6-8 were fine) — the shock scales with how much raw trace
    // the swap replaces. A token threshold bounds that swap by construction:
    // short tasks never transition, long tasks transition early.
    const lazyTokens = Number.parseInt(process.env.EVAL_LAZY_TOKENS ?? '0', 10) || 0;
    // Upper-bound proxy for the rendered trace size; 4 chars/token heuristic.
    let traceChars = args.scenario.task.length;
    // Real tokens from the last completed turn — free (already returned by the
    // API), exact for whatever model is running, no chars/4 approximation.
    // 0 at turn 0: a fresh trace is always small enough to stay devolved.
    let lastPromptTokens = 0;
    // One-way. The rule asks whether the WHOLE trace still fits; after the
    // crossing the prompt no longer contains the whole trace (Zone C is the
    // active branch), so its size says nothing about that question — and L0 is
    // append-only, so a trace that once exceeded the budget never fits again.
    // Without the latch the first live crossing oscillated: 40k at turn 8,
    // summarized prompt under 30k at turn 9, whole trace re-expanded and 43k
    // at turn 10 (long-v65-gate-oscillating, 2x the loop-8 cost).
    let lazyCrossed = false;
    const belowLazyBudget = (): boolean => lazyTokens > 0 && !lazyCrossed && lastPromptTokens < lazyTokens;
    // v5.7 (EVAL_DET_ROOT=1): the Zone B root is composed from leaf headlines
    // by a pure function — no strong-model call, no truncation-retry path.
    const detRoot = process.env.EVAL_DET_ROOT === '1';
    // v6.3 (EVAL_ROOT_KEEP=<n>): the deterministic root renders at most n
    // branch headlines; older members collapse to one fold line (member ids
    // stay in meta.node_ids). 0 = uncapped = prior behaviour, byte-for-byte.
    const rootKeep = Number.parseInt(process.env.EVAL_ROOT_KEEP ?? '0', 10) || 0;
    const composeRoot = (rootId: string): void => {
      const summary = composeRootSummary(
        handle.store,
        rootId,
        undefined,
        rootKeep > 0 ? rootKeep : Number.POSITIVE_INFINITY,
      );
      if (summary !== null && rootKeep > 0) {
        const total = summary.meta.node_ids.filter((id) => id !== rootId).length;
        const folded = total - Math.min(total, rootKeep);
        if (folded > 0) process.stderr.write(`[eval] root fold: ${folded} of ${total} branches folded\n`);
      }
    };
    // v5.8 (EVAL_FETCH_EVENTS=1): context-tool results and the completion
    // nudge are appended to L0 like every other exchange, replacing the
    // never-actually-dropped ephemeral tail (see the isContextTool branch).
    const fetchEvents = process.env.EVAL_FETCH_EVENTS === '1';
    const branchCount = (): number => {
      const rootId = handle.store.root()?.id;
      return rootId === undefined
        ? 0
        : handle.store.nodesInCreationOrder().filter((node) => node.parent_id === rootId).length;
    };
    let summarizedBranchCount = 1; // the newest branch never summarizes
    const maybeResummarize = async (): Promise<void> => {
      const rootId = handle.store.root()?.id;
      let latestBranchIdForPlan: string | undefined;
      if (summarizeOnClose) {
        const branches =
          rootId === undefined
            ? []
            : handle.store.nodesInCreationOrder().filter((node) => node.parent_id === rootId);
        if (branches.length <= summarizedBranchCount) return;
        if (lazyK > 0 && branches.length < lazyK) return;
        if (belowLazyBudget()) return;
        summarizedBranchCount = branches.length;
        latestBranchIdForPlan = branches.at(-1)?.id;
      } else if (newEventsSinceSummary < SUMMARIZE_MIN_NEW_EVENTS) {
        return;
      }
      const plan =
        rootId === undefined
          ? []
          : summarizer
              .stalePlan(rootId)
              .filter((nodeId) => nodeId !== latestBranchIdForPlan)
              .filter((nodeId) => !(detRoot && nodeId === rootId));
      let { pending, skipped } = splitSummarizePlan(plan, failedSummaryNodes);
      if (skipped > 0) {
        process.stderr.write(
          `[eval] summary circuit breaker: skipping ${skipped} node(s) that already failed the §8 contract once\n`,
        );
      }
      if (process.env.EVAL_SUMMARY_DEDUP === '1' && rootId !== undefined && pending.length > 0) {
        const contentOf = (id: string): string | undefined => {
          const node = handle.store.nodesInCreationOrder().find((candidate) => candidate.id === id);
          if (node === undefined) return undefined;
          return branchContentText(
            renderBranchDetail(handle.store, node, branchFacts(handle.store, node), {
              trace: handle.trace,
              blobs: handle.blobs,
            }),
          );
        };
        const pendingLeaves = pending
          .filter((id) => id !== rootId)
          .flatMap((id) => {
            const text = contentOf(id);
            return text === undefined ? [] : [{ id, text }];
          });
        const summarizedSiblings = handle.store
          .nodesInCreationOrder()
          .filter(
            (node) =>
              node.parent_id === rootId &&
              !pending.includes(node.id) &&
              handle.store.currentSummary(node.id) !== undefined,
          )
          .flatMap((node) => {
            const text = contentOf(node.id);
            return text === undefined ? [] : [{ id: node.id as string, text }];
          });
        const { kept, deduped } = dedupSummarizePlan(pendingLeaves, summarizedSiblings);
        for (const skip of deduped) {
          process.stderr.write(
            `[eval] summary dedup: skipping ${skip.id} (cosine ${skip.cosine.toFixed(3)} to ${skip.against})\n`,
          );
        }
        if (deduped.length > 0) {
          const keptSet = new Set(kept);
          pending = pending.filter((id) => id === rootId || keptSet.has(id));
        }
      }
      if (pending.length === 0) {
        if (detRoot && rootId !== undefined) composeRoot(rootId);
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
      // After the leaves land: the root is a pure compose over them, and a
      // byte-identical composition writes no new version (Zone B stability).
      if (detRoot && rootId !== undefined) composeRoot(rootId);
      newEventsSinceSummary = 0;
    };

    const treeTools = [...HARNESS_TOOL_SCHEMAS, ...CONTEXT_TOOL_SCHEMAS];
    let finalText = '';
    let tailCounter = 0;
    // Completion-gate state (see the bare-text branch below).
    let toolWorkDone = false;
    let completionConfirmed = false;
    for (let turnIndex = 0; turnIndex < args.options.maxTurns; turnIndex += 1) {
      if (Date.now() >= args.deadlineMs) return { status: 'time_cap', finalText, lazyCrossed };
      // v5.3 (EVAL_ZONEC_LATEST=1): expand the LATEST branch instead of the
      // root. Expanding the root makes Zone C the entire raw trace — the tree
      // arm then pays summaries AND full detail, which is native with extra
      // steps (iter4: tree fresh input grew monotonically to 14.5k/turn).
      // The latest branch always holds the newest events (the segmenter
      // assigns trailing events to the last phase), so the model still sees
      // its own last tool results; older detail is summaries + context_fetch,
      // which is the actual design promise.
      const rootIdForZoneC = handle.store.root()?.id;
      const latestBranchId =
        process.env.EVAL_ZONEC_LATEST === '1'
          ? handle.store
              .nodesInCreationOrder()
              .filter((node) => node.parent_id === rootIdForZoneC)
              .at(-1)?.id
          : undefined;
      // v5.7 below-k: nothing is summarized yet, so hiding closed branches
      // behind (nonexistent) Zone B summaries would blind the model. Expand
      // the root — Zone C is the whole trace, cached per-block, and the prompt
      // is economically native until the k-th branch closes.
      const belowLazyK = (lazyK > 0 && branchCount() < lazyK) || belowLazyBudget();
      const activeNodeId = belowLazyK
        ? rootIdForZoneC
        : (handle.store.openPhase()?.id ?? latestBranchId ?? rootIdForZoneC);
      const keepBranches = args.selectBranches?.(handle, activeNodeId);
      if (args.selectBranches !== undefined) {
        // Telemetry: whether branch sampling fired this turn, and how much it kept.
        const total = handle.store.nodesInCreationOrder().filter((n) => n.parent_id === handle.store.root()?.id).length;
        process.stderr.write(
          `[tree-dsa] turn ${turnIndex}: ${keepBranches === undefined ? `all ${total} branches (within k)` : `kept ${keepBranches.size}/${total} branches`}\n`,
        );
      }
      let prompt = assembler.assemble({
        // v5.7 (EVAL_NO_ATOOLS=1): the schemas already ship as the API `tools`
        // param on every request — the Zone A text copy is a 1.1k-token/turn
        // duplicate (analyzer-verified). Deleting it is pure prefix diet.
        ...(process.env.EVAL_NO_ATOOLS === '1' ? {} : { toolSchemasText: TREE_ZONE_A_TOOL_SCHEMAS_TEXT }),
        // appendEvent re-ingests the whole log each turn, and the segmenter ends
        // every trace by closing phases and the task node — so openPhase()
        // is ALWAYS null here and the assembler would emit an empty Zone C (the
        // investigate-1 root cause: the model never saw its own tool results and
        // looped on stale summaries). Zone C must not vanish: expand the root,
        // which spans the whole trace.
        activeNodeId,
        selection: keepBranches === undefined ? undefined : { keepBranches },
        // v6.4: devolved mode promises the WHOLE trace, but the fixed 30k Zone C
        // budget silently contradicted that once the real tokenizer (which
        // charges punctuation runs the chars/4 lazy gate does not) pushed a
        // code-heavy trace over it. Past that point fitZoneC recomputed its
        // shared truncation cap every turn, and a one-token cap shift resized
        // EVERY truncated block — rewriting the whole ~30k cached prefix once
        // per turn (measured: sw-6-ripple cacheWrite 162k vs native 20k).
        ...(belowLazyK ? { zoneCBudget: Number.POSITIVE_INFINITY } : {}),
      });

      // Same-turn lazy gate check (Step 4): check the candidate prompt's
      // heuristic token count BEFORE sending, not the previous turn's billed
      // tokens. The heuristic over-counts by ~18% on this corpus, so the gate
      // fires slightly early — the correct direction (a smaller overshoot).
      if (belowLazyK && !lazyCrossed && lazyTokens > 0) {
        const candidateTokens = prompt.budgets.total;
        if (candidateTokens >= lazyTokens) {
          lazyCrossed = true;
          process.stderr.write(`[eval] lazy gate crossed at turn ${turnIndex}: ${candidateTokens} >= ${lazyTokens} (candidate prompt)\n`);
          prompt = assembler.assemble({
            ...(process.env.EVAL_NO_ATOOLS === '1' ? {} : { toolSchemasText: TREE_ZONE_A_TOOL_SCHEMAS_TEXT }),
            activeNodeId: handle.store.openPhase()?.id ?? latestBranchId ?? rootIdForZoneC,
            selection: keepBranches === undefined ? undefined : { keepBranches },
          });
        }
      }

      const request =
        process.env.EVAL_ZONEC_CACHE === '1'
          ? toZoneCCachedRequest(prompt, args.options.model, {
              tools: treeTools,
              maxTokens: AGENT_MAX_TOKENS,
              ...(args.options.temperature != null ? { temperature: args.options.temperature } : {}),
            })
          : toCompletionRequest(prompt, args.options.model, {
              tools: treeTools,
              maxTokens: AGENT_MAX_TOKENS,
              ...(args.options.temperature != null ? { temperature: args.options.temperature } : {}),
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
      lastPromptTokens = result.usage.input + result.usage.cacheRead + result.usage.cacheWrite;

      const openBefore = handle.store.openPhase()?.id ?? null;
      const assistantEvent = appendTo(handle, {
        type: 'assistant_message',
        ts: ts(),
        blob: handle.blobs.put(result.text),
      });
      traceChars += result.text.length;
      if (result.toolCalls.length === 0) {
        // Completion gate (iter 3): a bare-text reply right after tool work can
        // be premature completion — the thin early tree prompt lacks the "look
        // how much is still undone" signal native's growing transcript gives.
        // The first such reply gets one ephemeral nudge; only a SECOND
        // consecutive bare-text reply ends the run. Costs one cheap cached
        // turn exactly when the failure mode would otherwise fire.
        // loop9b-item3 (EVAL_NO_COMPLETION_GATE=1): the gate is a tree-only
        // stopping rule the native arm never had (native returns on the first
        // bare-text reply, loop.ts:339-342), so while it stands every tree
        // turn-count number is `the arm's effect + 1`. Corpus replay over
        // eval/results: 204 tree runs, 185 fires, 23 rescues; on sw-3-refactor
        // 14 fires and 0 rescues, at a mean 13,793 tokens — the run's most
        // expensive turn, because cacheRead bills the whole prefix and that
        // turn carries the largest prefix the run ever has.
        if (toolWorkDone && !completionConfirmed && process.env.EVAL_NO_COMPLETION_GATE !== '1') {
          completionConfirmed = true;
          const nudge =
            'system: you stopped calling tools. If every step of the task is verifiably done, reply with your final answer again; otherwise continue working.';
          if (fetchEvents) {
            // v5.8: the nudge is an L0 event like everything else — it rides
            // behind the moving breakpoint instead of re-billing fresh forever.
            appendTo(handle, { type: 'user_message', ts: ts(), blob: handle.blobs.put(nudge) });
            traceChars += nudge.length;
          } else {
            tailCounter += 1;
            assembler.appendTail({ id: `completion-check-${tailCounter}`, text: nudge, ephemeral: true });
          }
          newEventsSinceSummary += 1;
          await maybeResummarize();
          continue;
        }
        finalText = result.text;
        // No end-of-run summarize pass: refreshing the tree for a hypothetical
        // next resumer is D11 sleep-time compute (`scheduleSummarize`), not
        // part of this run's critical path — and this sandbox is discarded
        // anyway. Charging it to the run would bill maintenance as task work.
        return { status: 'completed', finalText, lazyCrossed };
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
          traceChars += (outcome.postContent?.length ?? 0) + outcome.output.length + JSON.stringify(call.input).length;
          newEventsSinceSummary += 2;
        } else if (isContextTool(call.name)) {
          const outcome = await HANDLERS[call.name as ToolName](toolCtx, call.input);
          const text = outcome.ok
            ? JSON.stringify(outcome.data)
            : `error ${outcome.error.code}: ${outcome.error.message}`;
          if (fetchEvents) {
            // v5.8 (EVAL_FETCH_EVENTS=1): context-tool exchanges are L0 events,
            // identical to harness tools — one rule applied everywhere. The
            // "ephemeral tail" they used to land in never actually dropped
            // (openPhase() is always null here, so onPhaseTransition() is dead
            // code) while claiming it would: a fetched payload re-billed FRESH
            // at 1x every remaining turn (measured: 7.6k tokens pinned for 12
            // turns, $0.19 of one run). As events they ride behind the moving
            // breakpoint at 0.1x and collapse into the branch summary at close.
            const callEvent = appendTo(handle, {
              type: 'tool_call',
              ts: ts(),
              tool: call.name,
              args_blob: handle.blobs.put(JSON.stringify(call.input)),
              parent_seq: assistantEvent.event.seq,
            });
            appendTo(handle, {
              type: 'tool_result',
              ts: ts(),
              call_seq: callEvent.event.seq,
              output_blob: handle.blobs.put(text),
              error: outcome.ok ? undefined : text.slice(0, 500),
            });
            traceChars += text.length + JSON.stringify(call.input).length;
            newEventsSinceSummary += 2;
          } else {
            tailCounter += 1;
            assembler.appendTail({ id: `${call.name}-${tailCounter}`, text, ephemeral: true });
          }
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
      // Non-progress, not a counter, is what ends a run that will not finish.
      if (guard.endTurn()) return { status: 'stalled', finalText, lazyCrossed };
    }
    return { status: 'turn_cap', finalText, lazyCrossed };
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
  let lazyCrossed = false;
  let success: boolean | null = null;
  let judgeDetail = '';
  let judgeScore: number | null = null;

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
                selectBranches:
                  process.env.EVAL_DSA_V6 === '1'
                    ? makeTreeDsaV6Selector(scenario.task)
                    : makeTreeDsaSelector(scenario.task),
              })
            : await runTreeArm({ ...armArgs, summarizerProvider: meteredSummarizer });
    status = output.status;
    finalText = output.finalText;
    lazyCrossed = output.lazyCrossed ?? false;
  } catch (error) {
    if (error instanceof CostCapExceededError) {
      status = 'cost_cap';
    } else {
      errorText = `${(error as Error).name}: ${(error as Error).message}`;
    }
  }

  // Grade every run that produced a state to grade, then apply one asymmetry.
  //
  // These scenarios are judged by running their hidden tests against the
  // sandbox, so the grade is a fact about the FILESYSTEM, not about whether the
  // model announced it was finished. That makes the two directions mean
  // different things for a run the harness stopped:
  //
  //   passing  -> the work was done. The ceiling only cut off the talking, so
  //               this is a real success and is kept.
  //   failing  -> unknown. The tests did not pass at an arbitrary stopping
  //               point chosen by the harness, which is not evidence the model
  //               could not have finished. Recording it as a failure invents a
  //               failure the model never committed, and that zero then enters
  //               the arm's mean. It becomes `null`: not measured.
  //
  // `completed` and `stalled` are the run's own outcomes and keep both
  // directions — ending in a repeat loop is a genuine failure.
  if (errorText === undefined && status !== 'error') {
    try {
      const judge = await judgeScenario({
        scenario,
        sandbox,
        finalText,
        provider: meteredAgent,
        judgeModel: options.judgeModel,
      });
      const stoppedByHarness = (HARNESS_STOPPED as readonly RunStatus[]).includes(status);
      success = stoppedByHarness && judge.success === false ? null : judge.success;
      judgeDetail = judge.detail;
      judgeScore = stoppedByHarness && judge.success === false ? null : judge.score;
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
  const metrics = summarizeMetrics({
    turns,
    wallMs,
    usage,
    costUsd: costMeter.totalUsd(),
    lazyCrossed,
    finalTextChars: finalText.length,
  });
  runHandle.finish(status, metrics, success, judgeDetail);
  if (options.keepSandbox) sandbox.writeFile('.final-answer.txt', finalText);
  else sandbox.cleanup();

  const result: RunResult = {
    runId: loop.runId,
    benchmark: scenario.benchmark,
    scenarioId: scenario.id,
    arm,
    model: options.model,
    ...(options.temperature != null ? { temperature: options.temperature } : {}),
    costByModel: costMeter.snapshot().entries.map((entry) => ({
      model: entry.model,
      calls: entry.calls,
      usage: entry.usage,
      usd: entry.usd,
    })),
    status,
    success,
    judge: { success, score: judgeScore, detail: judgeDetail },
    metrics,
    turns: [...turns],
    error: errorText,
    sandboxPath: options.keepSandbox ? sandbox.path : undefined,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
  };
  return { result, finalText };
}

