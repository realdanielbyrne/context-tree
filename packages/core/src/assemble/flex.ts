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
 */
import type {
  AssembledPrompt,
  BudgetReport,
  NodeId,
  PromptBlock,
  Tokenizer,
} from '../contracts/index.js';
import { replyHeadroom } from './budgets.js';
import {
  planEviction,
  DEFAULT_EVICTION_WEIGHTS,
  type EvictionCandidate,
  type EvictionWeights,
} from './eviction.js';

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
  /** Reply reservation; defaults to `replyHeadroom({ window })`. */
  reserve?: number;
  weights?: EvictionWeights;
  /** Current turn index, for priority decay + reference-recency. Defaults to max unit order. */
  currentTurn?: number;
  /** Retrieved results to append after the buffer (untouched prefix). */
  tail?: readonly { id: string; text: string }[];
  priorityHalfLife?: number;
}

function sumTokens(blocks: readonly PromptBlock[]): number {
  return blocks.reduce((s, b) => s + b.tokens, 0);
}

/** Number of other units sharing at least one fingerprint (recurrence). */
function corecurrence(units: readonly FlexUnit[], i: number): number {
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
  const reserve = options.reserve ?? replyHeadroom({ window }).tokens;
  const halfLife = options.priorityHalfLife ?? DEFAULT_PRIORITY_HALFLIFE;
  const currentTurn = options.currentTurn ?? (units.length > 0 ? units[units.length - 1]!.order : 0);

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
  const unitText = (i: number): string =>
    repr(i) === 'summary' ? units[i]!.summary! : units[i]!.raw;
  const unitTokens = (i: number): number => tokenizer.count(unitText(i));

  // ── eviction: score every non-anchor unit; keep down to the floor `f` ───────
  const candidates: EvictionCandidate[] = units.map((u, i) => {
    const decay = Math.pow(0.5, Math.max(0, currentTurn - u.lastReferencedTurn) / halfLife);
    return {
      index: i,
      tokens: unitTokens(i),
      anchor: i >= anchorFrom,
      signals: {
        priority: ((u.wrote ? 2 : 0) + corecurrence(units, i)) * decay,
        recency: u.order,
        refRecency: -(currentTurn - u.lastReferencedTurn),
        dormancy: u.dormancy,
      },
    };
  });
  const floor = Math.max(0, softFrac * window);
  const plan = planEviction(candidates, floor, weights);
  const keptIndices = new Set(plan.keep);

  // ── flex blocks, CREATION ORDER, kept units only (append-only, never remixed) ─
  const flexBlocks: PromptBlock[] = [];
  let lastStableId: string | null = null;
  for (let i = 0; i < n; i += 1) {
    if (!keptIndices.has(i)) continue;
    const u = units[i]!;
    const isSummary = repr(i) === 'summary';
    const b = block('flex', `flex:${u.nodeId}`, unitText(i), u.nodeId);
    flexBlocks.push(b);
    if (isSummary) lastStableId = b.id; // stable (summary) run precedes the raw tail
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

  // BudgetReport is the legacy shape (its zoneA/B/C fields are renamed in the
  // final swap that removes ZoneAssembler): head → zoneA, flex → zoneB, zoneC 0.
  const budgets: BudgetReport = {
    zoneA: headTokens,
    zoneB: flexTokens,
    zoneC: 0,
    tail: tailTokens,
    total,
    overBudget: [],
    droppedFromZoneB: plan.evict.map((i) => units[i]!.nodeId),
    window,
    windowRemaining: window - total,
    overWindow: total + reserve > window,
    replyAllowance: Math.max(0, window - total),
    evictedFromTail: [],
    droppedFromZoneC: 0,
  };

  return {
    system: headBlocks.map((b) => b.text).join('\n\n'),
    blocks,
    budgets,
    cacheBreakpoints,
  };
}
