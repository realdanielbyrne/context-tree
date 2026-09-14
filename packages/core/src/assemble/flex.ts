/**
 * Flex-buffer assembler (spec stage 2) — frozen head + creation-order flex buffer.
 *
 * Provenance: `flex-append-sticky` beat the shipped Zone A/B/C layout on cache
 * economics (~14% cheaper effective input cost; `flex-remix`, which re-picks the
 * mix each turn, is cache-death). SETTLED on cache economics (offline);
 * task-quality parity vs zones is an owed live check.
 * `reports/metrics/assembler-flex-buffer/report.md`.
 *
 * Layout (prefix order):
 *   head   system + steering + ALL user prompts, append-only, frozen → cached
 *   ── cache breakpoint after head ──
 *   flex   the units in CREATION ORDER: older closed units as summaries (the
 *          "stable head"), the recency anchor + active phase raw (the "volatile
 *          tail"). Evicted to a soft-target floor by the D-EV score.
 *   ── secondary breakpoint after the stable (summary) run ──
 *   tail   retrieved results, appended after the buffer so the prefix is untouched
 *
 * The buffer only appends and evicts in place; it never re-mixes (re-ordering the
 * prefix is cache-death). Dormancy comes from the classifier (stage 1); this stage
 * consumes it and never computes embeddings itself.
 *
 * Reduce-on-overflow (spec §"Reduce-on-overflow") is implemented (`reduce.ts`): a raw
 * unit larger than the per-unit budget `b = (f − reply reserve) ÷ (A + 1)` — including
 * the recency anchor, which is never evicted — is shrunk in place by a reducer (default
 * `chunk`: keep the query-relevant spans; or `summarize`: fold to the §8 summary). The
 * query→reducer ROUTER that would auto-pick between them is deliberately NOT here — it is
 * an untested hypothesis (`reports/session-handoff.md`, backlog item 4). The assembler
 * applies the single default; a caller may override it but nothing auto-selects.
 *
 * `toMessages` / `toCompletionRequest` project an assembled prompt to a provider
 * request: the head ships as `system` (its cache breakpoint as a request flag), and
 * the flex + tail blocks ship as messages, split at the secondary breakpoint.
 */
import type {
  AssembledPrompt,
  BudgetReport,
  ChatMessage,
  CompletionRequest,
  NodeId,
  PromptBlock,
  Tokenizer,
  ToolSchema,
  Zone,
} from '../contracts/index.js';
import {
  planEviction,
  DEFAULT_EVICTION_WEIGHTS,
  type EvictionCandidate,
  type EvictionWeights,
} from './eviction.js';
import { resolveReducer, type Reducer, type ReducerName } from './reduce.js';
import type { ChunkOptions } from '../retrieve/chunk.js';

/**
 * Soft-target floor `f`, as a fraction of the window: the buffer is evicted down
 * to this and never below it. Spec range 25–50%; the midpoint is the default.
 * PROVISIONAL — `f` is untested on a genuinely overflowing session
 * (`reports/session-handoff.md`, backlog item 7).
 */
export const DEFAULT_SOFT_TARGET_FRAC = 0.375;

/**
 * Recency anchor `A`: the last A units are kept raw and never evicted.
 * PROVISIONAL — introduced as a read-loop guard, never swept.
 */
export const DEFAULT_ANCHOR = 4;

/** Priority-decay half-life in turns (spec left the law open; exponential, ≈ A). PROVISIONAL. */
export const DEFAULT_PRIORITY_HALFLIFE = DEFAULT_ANCHOR;

export type Representation = 'raw' | 'summary';

/** One unit the assembler places. `dormancy` is the classifier's output (stage 1). */
export interface FlexUnit {
  nodeId: NodeId;
  /** Creation-order index; higher = newer. Units are supplied in ascending order. */
  order: number;
  fingerprints: ReadonlySet<string>;
  /** The phase wrote a file or was fetched → priority boost. */
  wrote: boolean;
  /** Turn index of the unit's last reference (for reference-recency + priority decay). */
  lastReferencedTurn: number;
  /** Continuous topic-shift dormancy from the classifier, higher = more dormant. */
  dormancy: number;
  /** The unit's full raw text (kept for the anchor / active phase). */
  raw: string;
  /** The unit's summary text, when it has been latched (older units fold to this). */
  summary?: string;
}

/** The frozen head: never evicted, append-only. */
export interface FlexHead {
  system: string;
  steering?: string;
  /** All user prompts, in order — append-only so user intent is never evicted. */
  userPrompts: readonly string[];
}

export interface FlexAssembleOptions {
  /** Host context window in tokens. Required for eviction (the floor is a fraction of it). */
  window: number;
  softTargetFrac?: number;
  anchor?: number;
  weights?: EvictionWeights;
  /** Current turn index, for priority decay + reference-recency. Defaults to max unit order. */
  currentTurn?: number;
  /** Retrieved results to append after the buffer (untouched prefix). */
  tail?: readonly { id: string; text: string }[];
  priorityHalfLife?: number;
  /**
   * Room reserved for the reply, in tokens — the host-declared `Model.limit.output`
   * (spec). Subtracted from the floor to size the per-unit budget `b`. Default 0
   * (no reserve known → `b` is the whole floor's raw share).
   */
  replyReserve?: number;
  /**
   * The reduce-on-overflow reducer for oversized raw units. `'chunk'` (default,
   * detail-preserving), `'summarize'` (gist), or a custom function. NOT a router:
   * the assembler applies this one reducer; it never auto-selects (backlog item 4).
   */
  reducer?: ReducerName | Reducer;
  /** The current task/query driving chunk ranking. Defaults to the last user prompt. */
  query?: string;
  chunkOptions?: ChunkOptions;
  rrfK?: number;
}

function sumTokens(blocks: readonly PromptBlock[]): number {
  return blocks.reduce((s, b) => s + b.tokens, 0);
}

/** Number of other units sharing at least one fingerprint (recurrence). */
function coOccurrence(units: readonly FlexUnit[], i: number): number {
  const fp = units[i]!.fingerprints;
  let n = 0;
  for (let j = 0; j < units.length; j += 1) {
    if (j === i) continue;
    for (const f of fp) {
      if (units[j]!.fingerprints.has(f)) {
        n += 1;
        break;
      }
    }
  }
  return n;
}

/**
 * Assemble the flex prompt. Units MUST be supplied in creation order. Older units
 * fold to their summary (if present); the last `anchor` units + any that lack a
 * summary stay raw. Eviction removes the lowest-scoring non-anchor units until the
 * buffer fits the soft-target floor `f`.
 */
export function assembleFlex(
  head: FlexHead,
  units: readonly FlexUnit[],
  tokenizer: Tokenizer,
  options: FlexAssembleOptions,
): AssembledPrompt {
  const window = options.window;
  if (!Number.isFinite(window) || window <= 0) {
    throw new RangeError('window must be a finite positive number of tokens');
  }
  const anchor = options.anchor ?? DEFAULT_ANCHOR;
  const softFrac = options.softTargetFrac ?? DEFAULT_SOFT_TARGET_FRAC;
  const weights = options.weights ?? DEFAULT_EVICTION_WEIGHTS;
  const halfLife = options.priorityHalfLife ?? DEFAULT_PRIORITY_HALFLIFE;
  const currentTurn = options.currentTurn ?? (units.length > 0 ? units[units.length - 1]!.order : 0);
  if (!Number.isFinite(softFrac) || softFrac < 0 || softFrac > 1) {
    throw new RangeError('softTargetFrac must be in [0, 1]');
  }
  if (!Number.isInteger(anchor) || anchor < 0) throw new RangeError('anchor must be a non-negative integer');
  if (!Number.isFinite(halfLife) || halfLife <= 0) throw new RangeError('priorityHalfLife must be > 0');
  // The buffer's cache discipline and anchor/eviction logic depend on creation order.
  for (let i = 1; i < units.length; i += 1) {
    if (units[i]!.order < units[i - 1]!.order) {
      throw new RangeError('units must be supplied in creation order (non-decreasing order)');
    }
  }

  const block = (zone: PromptBlock['zone'], id: string, text: string, nodeId?: NodeId): PromptBlock => {
    const b: PromptBlock = { zone, id, text, tokens: tokenizer.count(text) };
    if (nodeId !== undefined) b.nodeId = nodeId;
    return b;
  };

  // ── frozen head: system + steering + all user prompts, append-only ──────────
  const headBlocks: PromptBlock[] = [block('head', 'head:system', head.system)];
  if (head.steering !== undefined && head.steering !== '') {
    headBlocks.push(block('head', 'head:steering', head.steering));
  }
  head.userPrompts.forEach((p, i) => headBlocks.push(block('head', `head:user:${i}`, p)));

  // ── representation: the last `anchor` units raw; older units fold to summary ─
  const n = units.length;
  const anchorFrom = Math.max(0, n - anchor);
  const repr = (i: number): Representation =>
    i >= anchorFrom || units[i]!.summary === undefined ? 'raw' : 'summary';

  // ── reduce-on-overflow: shrink any RAW unit over the per-unit budget `b` ─────
  // `b = (f − reply reserve) ÷ (A + 1)`: the floor's raw space, shared across the
  // active phase + the `A` anchor units (the units kept raw), so no single raw
  // unit claims more than its share. Applies to raw units only — a summary is
  // already the `summarize` reduction — and to anchors too: they are never
  // evicted but can still be reduced. The default reducer is `chunk` (keep the
  // query-relevant spans); the router that would pick chunk-vs-summarize is an
  // untested hypothesis and lives in the backlog, so nothing auto-selects here.
  const floor = Math.max(0, softFrac * window);
  const replyReserve = options.replyReserve ?? 0;
  const perUnitBudget = Math.max(0, (floor - replyReserve) / (anchor + 1));
  const reducer = resolveReducer(options.reducer);
  const query = options.query ?? head.userPrompts.at(-1);
  const reducedIds: NodeId[] = [];
  const rendered: string[] = units.map((u, i) => {
    const base = repr(i) === 'summary' ? u.summary! : u.raw;
    if (repr(i) === 'raw' && perUnitBudget > 0 && tokenizer.count(base) > perUnitBudget) {
      reducedIds.push(u.nodeId);
      const reduceCtx = { budgetTokens: perUnitBudget, tokenizer, query, chunkOptions: options.chunkOptions, rrfK: options.rrfK };
      return reducer({ raw: u.raw, summary: u.summary }, reduceCtx);
    }
    return base;
  });
  const unitText = (i: number): string => rendered[i]!;
  const unitTokens = (i: number): number => tokenizer.count(unitText(i));

  // ── eviction: score every non-anchor unit; keep down to the floor `f` ───────
  const candidates: EvictionCandidate[] = units.map((u, i) => {
    const decay = Math.pow(0.5, Math.max(0, currentTurn - u.lastReferencedTurn) / halfLife);
    return {
      index: i,
      tokens: unitTokens(i),
      anchor: i >= anchorFrom,
      signals: {
        priority: ((u.wrote ? 2 : 0) + coOccurrence(units, i)) * decay,
        recency: u.order,
        refRecency: -(currentTurn - u.lastReferencedTurn),
        dormancy: u.dormancy,
      },
    };
  });
  const plan = planEviction(candidates, floor, weights);
  const keptIndices = new Set(plan.keep);

  // ── flex blocks, CREATION ORDER, kept units only (append-only, never remixed) ─
  // The stable run is the LEADING CONTIGUOUS run of summary blocks; the secondary
  // breakpoint falls after it. A raw block — an anchor OR an old unit whose summary
  // has not latched yet (summarization is async) — CLOSES the stable run, so a later
  // raw→summary latch can never rewrite a block inside the cached prefix. Placing the
  // breakpoint after the last summary *anywhere* would trap such a raw hole before it.
  const flexBlocks: PromptBlock[] = [];
  let lastStableId: string | null = null;
  let stableRunOpen = true;
  for (let i = 0; i < n; i += 1) {
    if (!keptIndices.has(i)) continue;
    const u = units[i]!;
    const isSummary = repr(i) === 'summary';
    const b = block('flex', `flex:${u.nodeId}`, unitText(i), u.nodeId);
    flexBlocks.push(b);
    if (stableRunOpen && isSummary) lastStableId = b.id;
    else if (!isSummary) stableRunOpen = false;
  }

  // ── tail: retrieved results, appended after the buffer ──────────────────────
  const tailEntries = options.tail ?? [];
  const tailBlocks = tailEntries.map((e) => block('tail', `tail:${e.id}`, e.text));

  // ── breakpoints: after the head, and after the stable (summary) run ─────────
  const cacheBreakpoints: string[] = [];
  const lastHead = headBlocks.at(-1);
  if (lastHead !== undefined) {
    lastHead.cacheBreakpointAfter = true;
    cacheBreakpoints.push(lastHead.id);
  }
  if (lastStableId !== null) {
    const stable = flexBlocks.find((b) => b.id === lastStableId)!;
    stable.cacheBreakpointAfter = true;
    cacheBreakpoints.push(stable.id);
  }

  const blocks = [...headBlocks, ...flexBlocks, ...tailBlocks];
  const headTokens = sumTokens(headBlocks);
  const flexTokens = sumTokens(flexBlocks);
  const tailTokens = sumTokens(tailBlocks);
  const total = headTokens + flexTokens + tailTokens;

  const budgets: BudgetReport = {
    head: headTokens,
    flex: flexTokens,
    tail: tailTokens,
    total,
    overBudget: [],
    evicted: plan.evict.map((i) => units[i]!.nodeId),
    reduced: reducedIds,
    window,
    windowRemaining: window - total,
    // The prompt itself exceeds the window; reply room is reported via replyAllowance.
    overWindow: total > window,
    replyAllowance: Math.max(0, window - total),
    evictedFromTail: [],
  };

  return {
    system: headBlocks.map((b) => b.text).join('\n\n'),
    blocks,
    budgets,
    cacheBreakpoints,
  };
}

// ── provider projection ──────────────────────────────────────────────────────

function isMarked(prompt: AssembledPrompt, block: PromptBlock): boolean {
  return block.cacheBreakpointAfter === true || prompt.cacheBreakpoints.includes(block.id);
}

/** Does `zone` end at a cache breakpoint? */
function zoneEndsAtBreakpoint(prompt: AssembledPrompt, zone: Zone): boolean {
  const last = prompt.blocks.filter((b) => b.zone === zone).at(-1);
  return last !== undefined && isMarked(prompt, last);
}

/**
 * Split a zone's blocks at its LAST marked block, so a breakpoint planted inside a
 * zone (the flex buffer's secondary breakpoint after the stable summary run) still
 * lands on a message boundary: everything through the marked block is one cacheable
 * message, the remainder is a second, uncached message.
 */
function splitAtLastMark(
  prompt: AssembledPrompt,
  blocks: readonly PromptBlock[],
): { cached: readonly PromptBlock[]; rest: readonly PromptBlock[] } {
  let cut = -1;
  for (let i = 0; i < blocks.length; i += 1) if (isMarked(prompt, blocks[i]!)) cut = i;
  if (cut === -1) return { cached: [], rest: blocks };
  return { cached: blocks.slice(0, cut + 1), rest: blocks.slice(cut + 1) };
}

/**
 * Provider-facing projection: the head ships as `AssembledPrompt.system` (its
 * cache breakpoint is the system/messages boundary — carried by
 * `toCompletionRequest`, not here), and the `flex` and `tail` blocks ship as user
 * messages, one per zone, splitting a zone at its internal breakpoint.
 */
export function toMessages(prompt: AssembledPrompt): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const zone of ['flex', 'tail'] as const) {
    const blocks = prompt.blocks.filter((b) => b.zone === zone);
    if (blocks.length === 0) continue;
    const { cached, rest } = splitAtLastMark(prompt, blocks);
    if (cached.length > 0) {
      messages.push({ role: 'user', content: cached.map((b) => b.text).join('\n\n'), cacheBreakpoint: true });
    }
    if (rest.length > 0) {
      messages.push({ role: 'user', content: rest.map((b) => b.text).join('\n\n') });
    }
  }
  return messages;
}

/** Per-call knobs that are not the assembler's business (§11). */
export interface CompletionRequestOptions {
  maxTokens?: number;
  temperature?: number;
  /** Tool schemas as the provider's native tool list, not as prompt text. */
  tools?: readonly ToolSchema[];
  json?: boolean;
}

/**
 * The whole prompt as one provider request — the frozen head as `system`, the
 * flex + tail blocks as messages, and both cache breakpoints attached (the head's
 * as `systemCacheBreakpoint`, the buffer's on its message).
 */
export function toCompletionRequest(
  prompt: AssembledPrompt,
  model: string,
  options: CompletionRequestOptions = {},
): CompletionRequest {
  const request: CompletionRequest = { model, system: prompt.system, messages: toMessages(prompt) };
  if (prompt.system !== '' && zoneEndsAtBreakpoint(prompt, 'head')) {
    request.systemCacheBreakpoint = true;
  }
  if (options.maxTokens !== undefined) request.maxTokens = options.maxTokens;
  if (options.temperature !== undefined) request.temperature = options.temperature;
  if (options.tools !== undefined) request.tools = options.tools;
  if (options.json !== undefined) request.json = options.json;
  return request;
}
