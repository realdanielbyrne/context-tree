/**
 * New `rank*` functions for the eviction seam, in a NEW module: `policies.mjs` carries
 * four live results and two adversarial-review fixes, so it is imported here and not
 * touched. Every function below plugs into `evictToBudget(messages, W, rank, opts)`
 * unchanged, which is what keeps the arms VOLUME-MATCHED by construction — all capped
 * arms fit the same budget with the same anchor and the same reserve and differ only
 * in the order they sacrifice units. That property is not negotiable: a control was
 * voided once because its treatment arm simply held more useful content, and
 * "more context is better" is already established at OR 42x per e-fold.
 *
 * Two families, matching the two DESIGN docs:
 *   makeRankPriority   H1 — the recurrence/edit-boost ratio the shipped scorer cannot express
 *   makeRankTcov       H2 — temporal covariance with the currently-hot file set
 *   makeRankTcovBlend  H2 — TCOV blended with positional recency (the deployable shape)
 *
 * TWO CONVENTIONS THAT ARE LOAD-BEARING:
 *
 * 1. `makeRankTcov` takes a `refLog` — an append-only per-turn list of touched file
 *    paths that OUTLIVES eviction. Computing covariance from the resident buffer would
 *    be a feedback loop: evicting a unit deletes the history that would later justify
 *    keeping it, so the signal would decay toward whatever it had already decided. The
 *    log holds paths, never content, so it adds nothing to the model's context — which
 *    matters, because three separate designs that added material to this agent's
 *    transcript each stopped it working entirely.
 *
 * 2. A unit with no file identity (a `run_bash` test run has no path to co-occur with)
 *    scores `null`. Nulls are NOT sacrificed for lacking a signal — they are given the
 *    MEDIAN score of the scored units, so they fall back to the recency tie-break and
 *    the arm degrades toward the incumbent rather than toward a random one. A rank
 *    function that quietly evicted every file-less unit would be measuring "does the
 *    agent need its test output", not "does covariance beat recency".
 */
import { evictToBudget, DEFAULT_ANCHOR } from '../context-dedup/policies.mjs';
import { tcovScores, splitPriority, neutralize } from './signals.mjs';

/** Local copy — `policies.mjs` does not export this and must not be edited. */
const nonAnchor = (units, anchorIdx) => units.map((_, i) => i).filter((i) => !anchorIdx.has(i));

export { neutralize };

/** Rank position of each index in a KEEP-preferred ordering (0 = kept first). */
function rankPositions(indices, cmp) {
  const m = new Map();
  [...indices].sort(cmp).forEach((i, r) => m.set(i, r));
  return m;
}

// ── H1 ───────────────────────────────────────────────────────────────────────

/**
 * Keep the highest `rho * editBoost + 1 * recurrence`. `rho` is the ratio the shipped
 * scorer hardcodes at 2 by summing before normalizing; `directed` chooses the tested
 * (later-units-only) recurrence over the shipped undirected one.
 *
 * NEITHER PARAMETER HAS A DEFENSIBLE DEFAULT. `rho = 2, directed = false` reproduces
 * the shipped point so it can appear in a sweep as one arm among others; it is not a
 * recommendation, and DESIGN-H1 pre-registers the sweep that would earn one.
 */
export const makeRankPriority = ({ rho = 2, directed = false } = {}) => (units, anchorIdx) => {
  const s = splitPriority(units, { rho, directed });
  return nonAnchor(units, anchorIdx).sort((a, b) => (s[b] - s[a]) || (b - a));
};

// ── H2 ───────────────────────────────────────────────────────────────────────

/**
 * Keep the units whose files are historically co-referenced with the currently-hot
 * files. Ties break toward the newer unit, so on a buffer where the signal is flat
 * this arm is exactly `rankRecency` and can never be worse than it for want of a
 * tie-break — the same discipline `rankIdle` uses.
 */
export const makeRankTcov = ({ refLog, params = {} } = {}) => (units, anchorIdx) => {
  const s = neutralize(tcovScores(refLog ?? [], units.map((u) => u.files), params));
  return nonAnchor(units, anchorIdx).sort((a, b) => (s[b] - s[a]) || (b - a));
};

/**
 * TCOV blended with positional recency, `alpha` in [0,1]: 0 = pure recency, 1 = pure
 * TCOV. Rank-space blending (not score-space) so the two incommensurable scales never
 * have to be calibrated against each other — the same construction as `rankBlend`.
 *
 * This is the DEPLOYABLE shape, and the reason it exists is that the record says
 * recency is protective (D-EV3) while pure relevance-to-recent is the worst eviction
 * signal there is (D-EV4). A new signal that throws recency away is not obviously an
 * improvement on either, so `alpha` is swept rather than assumed, and `alpha = 0`
 * recovers the incumbent exactly, which makes the sweep's own floor checkable.
 */
export const makeRankTcovBlend = (alpha, { refLog, params = {} } = {}) => (units, anchorIdx) => {
  const rest = nonAnchor(units, anchorIdx);
  const s = neutralize(tcovScores(refLog ?? [], units.map((u) => u.files), params));
  const posRank = rankPositions(rest, (a, b) => b - a);
  const covRank = rankPositions(rest, (a, b) => (s[b] - s[a]) || (b - a));
  const key = (i) => alpha * covRank.get(i) + (1 - alpha) * posRank.get(i);
  return rest.sort((a, b) => (key(a) - key(b)) || (b - a));
};

// ── evictBy* wrappers, mirroring policies.mjs ────────────────────────────────

export const evictByPriorityRatio = (messages, W, cfg, opts) =>
  evictToBudget(messages, W, makeRankPriority(cfg), opts);
export const evictByTcov = (messages, W, cfg, opts) =>
  evictToBudget(messages, W, makeRankTcov(cfg), opts);
export const evictByTcovBlend = (messages, W, alpha, cfg, opts) =>
  evictToBudget(messages, W, makeRankTcovBlend(alpha, cfg), opts);

export { DEFAULT_ANCHOR };
