/**
 * Eviction scoring (D-EV) — the SETTLED eviction *policy shape*.
 *
 * Provenance: the priority-dominant / relevance≈0 ordering is a settled result —
 * it won an offline head-to-head over real sessions at every budget and was once
 * confirmed live (−26% vs none / −14% vs recency at equal task success). See
 * `reports/metrics/assembler-weighting/report-assembler-weighting.md` (D-EV1–5)
 * and `reports/metrics/coding-harness/report-eviction.md`.
 *
 * What is settled is the SHAPE: priority dominates, recency and reference-recency
 * are protective, topic-dormancy subtracts, and query-relevance is weighted ZERO
 * (relevance is an *admission* signal, not an eviction one — on non-monotonic
 * history it drops exactly the dormant unit that later returns). What is NOT yet
 * settled is the exact coefficients: `DEFAULT_EVICTION_WEIGHTS` are the
 * hand-rounded D-EV defaults, and the sweep's own optimum differed
 * (`[rec .5, rel 0, prio .5, refrec 1]`), so treat them as tunable defaults, not
 * canon. `reports/session-handoff.md` → backlog item 2.
 */

/** Per-unit eviction signals, each a raw (un-normalized) magnitude. */
export interface EvictionSignals {
  /** Edit/fetch boost + fingerprint-recurrence, decayed by turns since last reference. Higher = keep. */
  priority: number;
  /** 1 − normalized age (turns since created). Higher = more recent = keep. */
  recency: number;
  /** 1 − normalized turns since the unit's fingerprints were last referenced. Higher = keep. */
  refRecency: number;
  /** The classifier's continuous topic-shift drift. Higher = more dormant = evict. */
  dormancy: number;
}

export interface EvictionWeights {
  priority: number;
  recency: number;
  refRecency: number;
  dormancy: number;
}

/**
 * The hand-rounded D-EV defaults. PROVISIONAL — the offline sweep's optimum was
 * `[recency .5, relevance 0, priority .5, refRecency 1]` and the LR rates put
 * priority far ahead (`prio 4.12 ≫ rec 2.42 ≈ rel 2.37 > refrec 1.04`); the
 * dormancy term is the classifier's contribution and is the least tuned. Refit
 * before hardcoding any of these as canon (handoff backlog item 2). Relevance is
 * absent by design (weight 0): it never enters eviction.
 */
export const DEFAULT_EVICTION_WEIGHTS: Readonly<EvictionWeights> = Object.freeze({
  priority: 2,
  recency: 1,
  refRecency: 0.5,
  dormancy: 1,
});

/** Min-max normalize to [0,1]; a flat vector maps to all-zeros (no signal). */
export function minMaxNormalize(values: readonly number[]): number[] {
  if (values.length === 0) return [];
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = hi - lo;
  if (span <= 0) return values.map(() => 0);
  return values.map((v) => (v - lo) / span);
}

/**
 * Score each candidate unit. Signals are min-max normalized ACROSS THE CURRENT
 * CANDIDATES this turn (per-turn normalization is part of the settled policy —
 * absolute magnitudes are not comparable across turns), then mixed linearly.
 * Higher score = keep; lower = evict first.
 */
export function scoreUnits(
  signals: readonly EvictionSignals[],
  weights: EvictionWeights = DEFAULT_EVICTION_WEIGHTS,
): number[] {
  if (signals.length === 0) return [];
  const priorityN = minMaxNormalize(signals.map((s) => s.priority));
  const recencyN = minMaxNormalize(signals.map((s) => s.recency));
  const refRecencyN = minMaxNormalize(signals.map((s) => s.refRecency));
  const dormancyN = minMaxNormalize(signals.map((s) => s.dormancy));
  return signals.map(
    (_, i) =>
      weights.priority * priorityN[i]! +
      weights.recency * recencyN[i]! +
      weights.refRecency * refRecencyN[i]! -
      weights.dormancy * dormancyN[i]!,
  );
}

export interface EvictionCandidate {
  /** Stable index/id of the unit in the caller's buffer. */
  index: number;
  signals: EvictionSignals;
  /** Token cost of keeping this unit raw/summarized in the buffer. */
  tokens: number;
  /** Pinned units (head, active phase) are never scored or evicted. */
  pinned?: boolean;
  /** Recency-anchor units are never evicted regardless of score. */
  anchor?: boolean;
}

export interface EvictionPlan {
  /** Indices to keep, in the caller's original order (creation order preserved). */
  keep: number[];
  /** Indices evicted this turn. */
  evict: number[];
  /** Total kept tokens after eviction (excludes pinned, which the caller accounts separately). */
  keptTokens: number;
}

/**
 * Decide what to keep to fit `budget` tokens. Eviction fires only when the
 * candidates exceed the budget (the soft-target floor `f` — never prune below
 * it); above it, evict the LOWEST-scoring first; anchors and pinned units are
 * always kept. Kept indices are returned in ascending (creation) order so the
 * caller re-emits the buffer append-only, never re-mixed (cache discipline).
 *
 * `budget` is the soft-target floor `f` — a fraction of the window (spec: 25–50%
 * of W), NOT the window minus head/reserve. The buffer is evicted down to `f`.
 * Anchors count against `f` but are never dropped ("never drop the recency anchor").
 */
export function planEviction(
  candidates: readonly EvictionCandidate[],
  budget: number,
  weights: EvictionWeights = DEFAULT_EVICTION_WEIGHTS,
): EvictionPlan {
  const evictable = candidates.filter((c) => !c.pinned && !c.anchor);
  const alwaysKeep = candidates.filter((c) => c.pinned || c.anchor);
  const total = candidates.filter((c) => !c.pinned).reduce((s, c) => s + c.tokens, 0);

  const keepSet = new Set<number>(alwaysKeep.map((c) => c.index));
  let used = alwaysKeep.filter((c) => !c.pinned).reduce((s, c) => s + c.tokens, 0);

  // Below the floor: keep everything.
  if (total <= budget) {
    for (const c of evictable) {
      keepSet.add(c.index);
      used += c.tokens;
    }
  } else {
    const scores = scoreUnits(evictable.map((c) => c.signals), weights);
    // Highest score first; fill until the next unit would exceed the budget.
    const order = evictable
      .map((c, i) => ({ index: c.index, tokens: c.tokens, score: scores[i]! }))
      .sort((a, b) => b.score - a.score);
    for (const c of order) {
      if (used + c.tokens <= budget) {
        keepSet.add(c.index);
        used += c.tokens;
      }
    }
  }

  const keep = candidates
    .map((c) => c.index)
    .filter((i) => keepSet.has(i))
    .sort((a, b) => a - b);
  const evict = candidates
    .map((c) => c.index)
    .filter((i) => !keepSet.has(i))
    .sort((a, b) => a - b);
  return { keep, evict, keptTokens: used };
}
