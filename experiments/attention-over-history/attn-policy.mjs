/**
 * The eviction seam for a measured-attention policy.
 *
 * `measure.py` produces a per-unit attention score offline; this is the only
 * thing needed to turn that score into a policy the existing live A/B harness
 * can run. It plugs into `evictToBudget(messages, W, rank, opts)` from
 * `experiments/context-dedup/policies.mjs` exactly like `rankIdle` or
 * `rankRecency`, so an attention arm costs no new harness — which matters,
 * because the last bespoke harness this project built could not represent a tool
 * call and every measurement it produced had to be thrown away (D20).
 *
 * WHY A SEPARATE FILE AND NOT AN EDIT TO `policies.mjs`
 * ----------------------------------------------------
 * `policies.mjs` holds the rules that have been through a live sweep. Attention
 * has not: the pilot in `DESIGN.md` is 6 turns on one session with a 1B model,
 * and its leading indicator on the primary endpoint is NEGATIVE. Until the
 * staged plan clears stage 2 this is unfinished research, and the repo's
 * convention is that unfinished research lives in `experiments/`, not beside
 * settled results. Promotion happens when a report says so.
 *
 * WHAT THE POLICY MUST NOT DO
 * ---------------------------
 * Re-ranking the prefix every turn is measured cache-death (`flex-remix`,
 * 433k vs 341k effCost) and the break-even for invalidating a cached prefix is
 * ~12.5 turns at keep=0.5. So `rankAttention` is a RANKING, not a schedule: the
 * caller decides cadence, and any live arm using it must report cacheWrite /
 * cacheRead alongside token volume. A score is also a per-turn quantity that
 * goes stale, hence `halfLifeTurns` — without decay, a unit that mattered thirty
 * turns ago keeps its score forever and the policy becomes an archaeologist.
 */

/** Ranks are "preferred KEEP order, best first" — the contract `evictToBudget` expects. */

const byDesc = (score) => (a, b) => (score[b] ?? -Infinity) - (score[a] ?? -Infinity) || b - a;

/**
 * Normalise raw per-unit attention mass to a comparable score.
 *
 * Renormalises over the CANDIDATE set rather than over everything, for the same
 * reason the offline signal does: the pinned head absorbs 47-80% of all last-row
 * mass (measured), and a score that includes it is mostly a measurement of the
 * sink drifting turn to turn.
 */
export function normalizeMass(raw, candidates) {
  const idx = candidates ?? raw.map((_, i) => i);
  let total = 0;
  for (const i of idx) total += Number.isFinite(raw[i]) ? raw[i] : 0;
  const out = new Array(raw.length).fill(0);
  if (total <= 0) {
    for (const i of idx) out[i] = 1 / idx.length;
    return out;
  }
  for (const i of idx) out[i] = (Number.isFinite(raw[i]) ? raw[i] : 0) / total;
  return out;
}

/**
 * Exponential staleness decay. A score measured `age` turns ago is worth
 * `0.5 ** (age / halfLifeTurns)` of a fresh one.
 *
 * `halfLifeTurns` is a PLACEHOLDER, flagged as such: no experiment in this repo
 * has swept it. The default of 8 is chosen only because it sits below the ~12.5
 * turn cache break-even, so a decayed score cannot keep recommending a rewrite
 * more often than the rewrite pays for itself. Sweep it before any value is canon.
 */
export const DEFAULT_HALF_LIFE_TURNS = 8;

export function decayScores(score, ages, halfLifeTurns = DEFAULT_HALF_LIFE_TURNS) {
  if (!(halfLifeTurns > 0)) return score.slice();
  return score.map((s, i) => s * Math.pow(0.5, (ages?.[i] ?? 0) / halfLifeTurns));
}

/** Median of a numeric array; NaN for an empty one. */
export function median(xs) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * TREATMENT: keep the units that received the most attention at the last
 * measurement; sacrifice the lowest-attention units first.
 *
 * UNSCORED UNITS GET THE MEDIAN, NOT ZERO. A unit created since the last
 * measurement has no attention reading. Scoring it 0 ranks it below every
 * measured unit, so the policy would evict the FRESHEST content first — the
 * exact inverse of every incumbent, and a bug that would masquerade as "the
 * attention arm did badly". Scoring it at the median makes it neutral: it keeps
 * its place by the recency tie-break and is neither rewarded nor punished for
 * the measurement not having caught up. (This was found by mutation-testing the
 * test suite: the original implementation and the `missing -> 0` bug produced
 * identical orders, so no test could tell them apart.)
 *
 * Degrading rather than throwing follows the segmenter's rule: unknown input
 * yields a defined fallback, never a crash.
 */
export function rankAttention(scoreOf, opts = {}) {
  const { halfLifeTurns = DEFAULT_HALF_LIFE_TURNS } = opts;
  return (units, anchorIdx) => {
    const rest = units.map((_, i) => i).filter((i) => !anchorIdx.has(i));
    const raw = units.map((u, i) => scoreOf(u, i, units));
    const known = rest.filter((i) => Number.isFinite(raw[i]));
    const norm = normalizeMass(raw, known);
    const ages = units.map((u) => u?.scoreAgeTurns ?? 0);
    const score = decayScores(norm, ages, halfLifeTurns);
    const neutral = known.length ? median(known.map((i) => score[i])) : 0;
    for (const i of rest) if (!Number.isFinite(raw[i])) score[i] = neutral;
    // one ranking over ALL candidates: attention first, recency as the tie-break
    return rest.sort(byDesc(score));
  };
}

/**
 * STRICT TREATMENT: attention with the positional trend removed.
 *
 * The only form of the signal that cannot be a relabelling of recency. If the
 * raw form wins and this one does not, the honest reading is "recency again" —
 * which is exactly what happened to reference-recency (pooled p = 1.000).
 */
export function rankResidualAttention(scoreOf, opts = {}) {
  return (units, anchorIdx) => {
    const rest = units.map((_, i) => i).filter((i) => !anchorIdx.has(i));
    const raw = units.map((u, i) => scoreOf(u, i, units));
    const known = rest.filter((i) => Number.isFinite(raw[i]));
    const resid = residualizeAgainstPosition(known.map((i) => raw[i]), known);
    const score = {};
    known.forEach((i, k) => { score[i] = resid[k]; });
    // Unscored units take the MEDIAN residual, for the same reason as
    // `rankAttention`: appending them last in keep order would evict the
    // freshest content first. The sibling function was fixed for this and this
    // one was not — it is the same bug, so it gets the same fix and its own test.
    const neutral = known.length ? median(known.map((i) => score[i])) : 0;
    for (const i of rest) if (!Number.isFinite(raw[i])) score[i] = neutral;
    return rest.sort((a, b) => (score[b] - score[a]) || b - a);
  };
}

/** Rank-space residuals of `values` against the rank of `positions`. */
export function residualizeAgainstPosition(values, positions) {
  const n = values.length;
  if (n < 3) return values.slice();
  const rank = (arr) => {
    const order = arr.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
    const r = new Array(n);
    let i = 0;
    while (i < n) {
      let j = i;
      while (j + 1 < n && order[j + 1][0] === order[i][0]) j++;
      const avg = (i + j) / 2;
      for (let k = i; k <= j; k++) r[order[k][1]] = avg;
      i = j + 1;
    }
    return r;
  };
  const rv = rank(values);
  const rp = rank(positions);
  const mx = rp.reduce((s, v) => s + v, 0) / n;
  const my = rv.reduce((s, v) => s + v, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (rp[i] - mx) * (rv[i] - my); den += (rp[i] - mx) ** 2; }
  const beta = den > 0 ? num / den : 0;
  return rv.map((v, i) => v - my - beta * (rp[i] - mx));
}

/**
 * DIRECTION CHECK, never a shippable policy: sacrifice the HIGHEST-attention
 * units first. If this is not measurably worse than `rankAttention`, the signal
 * carries no usable direction and the treatment's result is noise whichever way
 * it fell. Same role as the `clean` arm in the sensitivity control.
 */
export function rankAntiAttention(scoreOf, opts = {}) {
  return (units, anchorIdx) => {
    const rest = units.map((_, i) => i).filter((i) => !anchorIdx.has(i));
    const raw = units.map((u, i) => scoreOf(u, i, units));
    const known = rest.filter((i) => Number.isFinite(raw[i]));
    const norm = normalizeMass(raw, known);
    const ages = units.map((u) => u?.scoreAgeTurns ?? 0);
    const score = decayScores(norm, ages, opts.halfLifeTurns ?? DEFAULT_HALF_LIFE_TURNS);
    const neutral = known.length ? median(known.map((i) => score[i])) : 0;
    for (const i of rest) if (!Number.isFinite(raw[i])) score[i] = neutral;
    // Invert the ATTENTION axis only. Reversing `rankAttention`'s whole output
    // would also flip the recency tie-break, so the direction check would differ
    // from the treatment on two axes and a difference could not be attributed to
    // attention alone.
    return rest.sort((a, b) => (score[a] - score[b]) || b - a);
  };
}

/**
 * Spearman rank correlation — exported because the live arm must REPORT
 * `spearman(attentionRank, positionRank)` in its results file. An arm that turns
 * out to be positional recency wearing a hat has to be caught at analysis time,
 * not defended afterwards.
 */
export function spearman(x, y) {
  const n = x.length;
  if (n !== y.length) throw new Error('length mismatch');
  if (n < 3) return 0;
  const rank = (arr) => {
    const order = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(n);
    let i = 0;
    while (i < n) {
      let j = i;
      while (j + 1 < n && order[j + 1][0] === order[i][0]) j++;
      const avg = (i + j) / 2;
      for (let k = i; k <= j; k++) r[order[k][1]] = avg;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(x), ry = rank(y);
  const mx = rx.reduce((s, v) => s + v, 0) / n, my = ry.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0;
}

/**
 * Load per-unit scores produced by `measure.py` and key them to live units.
 *
 * Deliberately keyed on an explicit `unitKey` rather than on array position: the
 * offline replay and the live run do not have the same unit indices once
 * eviction has fired even once, and silently aligning two different indexings is
 * how an arm becomes inert without anyone noticing.
 */
export function scoresFromResults(turn, unitKey) {
  if (typeof unitKey !== 'function') {
    // No default. Falling back to String(i) is the index-alignment footgun this
    // function exists to prevent: after one eviction the offline replay's unit
    // indices and the live run's no longer correspond, and a silently misaligned
    // score is an inert arm that still looks like it is working.
    throw new TypeError('scoresFromResults requires an explicit unitKey(unit, i, units) — ' +
      'positional alignment between an offline replay and a live run is not safe');
  }
  const mass = turn?.mass ?? [];
  const keys = turn?.unitKeys;
  const byKey = new Map();
  mass.forEach((m, i) => byKey.set(String(keys ? keys[i] : i), m));
  return (unit, i, units) => {
    const v = byKey.get(String(unitKey(unit, i, units)));
    return v === undefined ? NaN : v;
  };
}
