/**
 * Eviction SIGNALS for the two covariance hypotheses — PURE and importable, so a
 * unit test can exercise them without touching a model server (the `stats.mjs`
 * lesson: a test that imports an experiment starts a live GPU run).
 *
 * Two families live here.
 *
 * H1 — RECURRENCE (static co-occurrence).
 *   `experiments/assembler-weighting/` swept a *pure* recurrence term and it was the
 *   strongest single signal (priority-only recall 0.35/0.42 vs recency-only 0.25/0.24;
 *   LR mixing rate 4.12 vs recency 2.42). What SHIPS is not what was tested, in two
 *   ways, and both are reproduced here side by side so the difference is measurable
 *   rather than argued:
 *     `shippedPriority`  — `((wrote?2:0) + coOccurrence(units,i)) * decay`, the exact
 *                          semantics of `packages/core/src/assemble/flex.ts:268`. The
 *                          sum is formed BEFORE normalization and before any weight,
 *                          so no coefficient anywhere in the codebase can move the
 *                          recurrence half relative to the edit-boost half. That 2:1
 *                          internal ratio is an undefended hardcoded constant.
 *     `splitPriority`    — the ablatable form: normalize each half separately, then
 *                          mix at ratio `rho`. `rho` is the knob the shipped form
 *                          does not have. NOT a default: it must be swept.
 *   The second difference is DIRECTION. The tested term counted *later* turns that
 *   came to overlap this unit (`assembler-weighting/lib.mjs:57,69` — `refs[u]` holds
 *   only `j > u`, and `prio = nBefore` counts those before the decision turn). The
 *   shipped term counts ALL resident units sharing a fingerprint, earlier ones
 *   included. `recurrenceDirected` / `recurrenceUndirected` are both here so the
 *   transfer can be measured instead of assumed.
 *
 * H2 — TEMPORAL COVARIANCE (pairwise co-reference across turns). Never computed
 *   anywhere in this repo. Relevance-to-recent was measured WORST as an eviction
 *   signal (D-EV4, weight 0) for one reason: it drops the dormant unit that later
 *   returns. Temporal covariance is the signal that KEEPS that unit — dormant now,
 *   but historically co-active with whatever is hot now.
 *
 *   THREE design decisions that exist to stop it collapsing into a signal we already
 *   have, each of which a reviewer should check:
 *
 *   (a) It is keyed on FILE PATHS, not on the `fp` fingerprint set. `fp` admits any
 *       token with an underscore and length >= 5, so `__init__` — shared by every
 *       Python module — linked every unit to every other and pinned `idleOf` near
 *       zero, making a whole live arm inert (`policies.mjs` header, review BLOCKER 1).
 *       A pairwise statistic is *more* exposed to that failure than a scalar one.
 *   (b) The pairwise statistic is the phi coefficient (Pearson r on two binary
 *       series), NOT a raw co-occurrence count. phi divides by both margins, so a file
 *       touched on EVERY turn has n_f = n, the denominator vanishes, and it scores 0
 *       against everything. Promiscuity is neutralised by construction rather than by
 *       hoping the corpus is clean.
 *   (c) The history window and the hot window are DISJOINT: phi is fitted on turns
 *       s < t-K and the hot set is drawn from [t-K, t). A unit's own currently-hot
 *       files are excluded from the pairing. Without both exclusions the score would
 *       reward "your file is hot right now", which is relevance-to-recent — the exact
 *       signal that lost. The whole claim is that this is a DIFFERENT signal, so the
 *       leak has to be closed in the definition, not checked for afterwards.
 *
 * NOTHING here reads the network or the filesystem.
 */

// ── small helpers ────────────────────────────────────────────────────────────

export const unionSets = (sets) => {
  const s = new Set();
  for (const x of sets) for (const v of x) s.add(v);
  return s;
};

/** Min-max to [0,1]; a flat vector maps to all-zeros (no signal), as `eviction.ts` does. */
export function minMax(values) {
  if (values.length === 0) return [];
  let lo = Infinity, hi = -Infinity;
  for (const v of values) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const span = hi - lo;
  return span > 0 ? values.map((v) => (v - lo) / span) : values.map(() => 0);
}

// ── H1: recurrence ───────────────────────────────────────────────────────────

/**
 * SHIPPED form (`flex.ts:167`): number of OTHER resident units sharing at least one
 * fingerprint. Undirected — an earlier unit counts the same as a later one.
 */
export function recurrenceUndirected(fpSets) {
  return fpSets.map((fp, i) => {
    let n = 0;
    for (let j = 0; j < fpSets.length; j += 1) {
      if (j === i) continue;
      for (const f of fp) if (fpSets[j].has(f)) { n += 1; break; }
    }
    return n;
  });
}

/**
 * TESTED form (`assembler-weighting/lib.mjs:57,69`): number of LATER units that came
 * to overlap this one. Directional and causal at the buffer's current time.
 */
export function recurrenceDirected(fpSets) {
  return fpSets.map((fp, i) => {
    let n = 0;
    for (let j = i + 1; j < fpSets.length; j += 1) {
      for (const f of fp) if (fpSets[j].has(f)) { n += 1; break; }
    }
    return n;
  });
}

/**
 * Both recurrence forms in one inverted-index pass. The naive definitions above are
 * O(N^2 * |fp|) per decision turn, which on the 1,046-turn fixture with a 200-unit
 * buffer is ~10^10 operations and does not finish; they stay as the reference
 * implementation the tests check this against, which is the same relationship
 * `coCounts` has to `pushTurn`.
 */
export function recurrenceCounts(sets) {
  const n = sets.length;
  const post = new Map();
  sets.forEach((S, i) => {
    for (const f of S) {
      let a = post.get(f);
      if (!a) post.set(f, (a = []));
      a.push(i);
    }
  });
  const undirected = new Array(n).fill(0);
  const directed = new Array(n).fill(0);
  const seen = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i += 1) {
    let u = 0, d = 0;
    for (const f of sets[i]) {
      const a = post.get(f);
      if (!a) continue;
      for (let k = 0; k < a.length; k += 1) {
        const j = a[k];
        if (j === i || seen[j] === i) continue;
        seen[j] = i;
        u += 1;
        if (j > i) d += 1;
      }
    }
    undirected[i] = u;
    directed[i] = d;
  }
  return { undirected, directed };
}

/**
 * Exact reproduction of `flex.ts:268` — `((wrote ? 2 : 0) + coOccurrence) * decay`.
 * `editBoost` is the hardcoded 2. It is a PARAMETER here only so a test can prove it
 * is unreachable in the shipped form: changing `EvictionWeights.priority` scales the
 * whole sum and cannot move the two halves relative to each other.
 */
export function shippedPriority(units, { editBoost = 2, decay = null } = {}) {
  const rec = recurrenceUndirected(units.map((u) => u.fp));
  return units.map((u, i) => ((u.wrote ? editBoost : 0) + rec[i]) * (decay ? decay[i] : 1));
}

/**
 * The ABLATABLE form. Each half is min-max normalized across the current candidates
 * FIRST, then mixed: `score = rho * edit + 1 * recurrence`. `rho` is the ratio the
 * shipped code cannot express.
 *
 * `rho` has NO defensible default — it is the quantity under test. The value 2 is
 * passed here only to reproduce the shipped ratio's *intent* as one point of a sweep;
 * it is not a recommendation. `directed` selects the tested vs shipped recurrence.
 */
export function splitPriority(units, { rho = 2, directed = false, decay = null } = {}) {
  const fps = units.map((u) => u.fp);
  const rec = minMax(directed ? recurrenceDirected(fps) : recurrenceUndirected(fps));
  const ed = minMax(units.map((u) => (u.wrote ? 1 : 0)));
  return units.map((_, i) => (rho * ed[i] + rec[i]) * (decay ? decay[i] : 1));
}

// ── H2: temporal covariance ──────────────────────────────────────────────────

/**
 * Dilate a per-turn reference log by L turns: turn t's active set becomes the union
 * of turns [t-L+1, t]. Two files used one turn apart are part of the same episode;
 * strict same-turn co-reference (L=1) would miss that. L MUST be swept — it trades
 * episode sensitivity against autocorrelation inflation of the counts.
 */
export function dilate(refLog, L = 1) {
  if (L <= 1) return refLog.map((s) => new Set(s));
  const out = [];
  for (let t = 0; t < refLog.length; t += 1) {
    out.push(unionSets(refLog.slice(Math.max(0, t - L + 1), t + 1)));
  }
  return out;
}

const pairKey = (f, g) => (f < g ? `${f} ${g}` : `${g} ${f}`);

export const emptyCounts = () => ({ n: 0, nf: new Map(), pair: new Map() });

/**
 * Fold one already-dilated turn into a counts accumulator, in place.
 *
 * The offline replay needs counts for every decision turn t over history [0, t-K), and
 * that window only ever grows, so rebuilding it per turn is O(T^2) work for an O(T)
 * quantity — enough to make the sweep unrunnable on the 1,046-turn fixture. This is
 * the incremental path; `coCounts` is the same thing computed from scratch, kept as
 * the reference implementation the tests check this against.
 */
export function pushTurn(counts, activeSet) {
  const fs = [...activeSet];
  counts.n += 1;
  for (let i = 0; i < fs.length; i += 1) {
    counts.nf.set(fs[i], (counts.nf.get(fs[i]) || 0) + 1);
    for (let j = i + 1; j < fs.length; j += 1) {
      const k = pairKey(fs[i], fs[j]);
      counts.pair.set(k, (counts.pair.get(k) || 0) + 1);
    }
  }
  return counts;
}

/** Marginal and pairwise co-activation counts over a (dilated) reference log. */
export function coCounts(series) {
  const c = emptyCounts();
  for (const S of series) pushTurn(c, S);
  return c;
}

/** Co-activation support (number of turns both files were active). */
export const supportOf = (counts, f, g) => (f === g ? 0 : counts.pair.get(pairKey(f, g)) || 0);

/**
 * Phi coefficient — Pearson correlation of the two binary activation series.
 *
 *     a = # turns both active      b = n_f - a
 *     c = n_g - a                  d = n - n_f - n_g + a
 *     phi = (ad - bc) / sqrt( n_f (n - n_f) n_g (n - n_g) )
 *
 * Returns 0 whenever a margin is degenerate (n_f in {0, n}): a file touched on every
 * turn, or on none, carries no pairwise information. That is the `__init__` guard —
 * it is in the denominator, not in a heuristic filter.
 */
export function phiFrom(counts, f, g) {
  if (f === g) return 0;
  const { n, nf } = counts;
  const Nf = nf.get(f) || 0, Ng = nf.get(g) || 0;
  const den = Nf * (n - Nf) * Ng * (n - Ng);
  if (!(den > 0)) return 0;
  const a = supportOf(counts, f, g);
  const b = Nf - a, c = Ng - a, d = n - Nf - Ng + a;
  return (a * d - b * c) / Math.sqrt(den);
}

/**
 * Low-support shrinkage. A phi of 1.0 built from a single co-occurrence is noise, and
 * a max-aggregator will find one in any large file set. `m` is a PLACEHOLDER pending
 * the sweep in DESIGN-H2 §"Parameters" — it is not a fitted value.
 */
export const shrink = (phi, a, m) => (m <= 0 ? phi : phi * (a / (a + m)));

export const AGG_NAMES = ['max', 'mean', 'top3'];

function aggregate(values, agg) {
  if (values.length === 0) return null;
  if (agg === 'mean') return values.reduce((s, v) => s + v, 0) / values.length;
  if (agg === 'top3') {
    const s = [...values].sort((a, b) => b - a).slice(0, 3);
    return s.reduce((x, v) => x + v, 0) / s.length;
  }
  if (agg === 'max') return Math.max(...values);
  throw new Error(`unknown aggregator ${agg}`);
}

/**
 * TEMPORAL COVARIANCE, per unit.
 *
 *     history  H = turns [0, T-K)           (phi is fitted here)
 *     hot set  Q = union of turns [T-K, T)  (what the agent is working on now)
 *
 *     TCOV(u) = agg_{ f in files(u), g in Q \ files(u) }  shrink( phi_H(f, g), a_fg, m )
 *
 * The two windows are disjoint and `Q \ files(u)` removes the unit's own hot files, so
 * a unit cannot score by being hot — only by having been *paired with* what is hot,
 * historically. That is what makes it a different quantity from relevance-to-recent.
 *
 * `refLog` is an append-only per-turn list of the file paths touched that turn. It is
 * a log of REFERENCES, not of content, so it survives eviction. Computing covariance
 * from the resident buffer instead would be a feedback loop: evicting a unit erases
 * the statistics that would later justify bringing it back.
 *
 * Returns one score per unit, or `null` for a unit with no file identity (a `run_bash`
 * test run has no path to co-occur with) and for a unit with no eligible pair. The
 * caller decides how to order nulls — `ranks.mjs` places them at the incumbent's
 * ordering, so an un-scorable unit falls back to positional recency rather than being
 * sacrificed for lacking a signal.
 */
export function scoreAgainstHot(counts, hot, F, { m = 2, agg = 'max' } = {}) {
  if (!F || F.size === 0) return null;
  const vals = [];
  for (const f of F) {
    for (const g of hot) {
      if (F.has(g)) continue;                // residency, not covariance
      vals.push(shrink(phiFrom(counts, f, g), supportOf(counts, f, g), m));
    }
  }
  return aggregate(vals, agg);
}

/**
 * CONTEXTUAL COVARIANCE (H2b) — one resident unit scored against the CURRENT hot window.
 *
 *     score(u) = agg over f in F\Q, g in Q\F  of  shrink(phi_H(f, g))
 *
 * `exclude` (default true) is the anti-relabelling construction and the reason this is a
 * separate function rather than an option on `scoreAgainstHot`: features the unit SHARES
 * with the hot window are removed from BOTH sides, so a unit can score only through the
 * historical association of features it has and the window does not with features the
 * window has and it does not. Present overlap — which is relevance, the signal D-EV4
 * measured as worst — cannot contribute. Setting `exclude: false` restores it, and exists
 * so the sensitivity arm can show whether the shared features were doing the work.
 *
 * Returns `{ score, support, support1, pairs }`: the score, the best co-activation count
 * behind it under the dilated history and under same-turn history, and how many pairs were
 * scored. The two support figures are what the validity gate reads.
 */
export function contextualCovariance(counts, Q, F, { m = 2, agg = 'max', exclude = true, counts1 = null } = {}) {
  const left = exclude ? [...F].filter((x) => !Q.has(x)) : [...F];
  const right = exclude ? [...Q].filter((x) => !F.has(x)) : [...Q];
  const vals = [];
  let support = 0, support1 = 0;
  for (const f of left) {
    for (const g of right) {
      if (f === g) continue;
      const a = supportOf(counts, f, g);
      if (a > support) support = a;
      if (counts1) { const a1 = supportOf(counts1, f, g); if (a1 > support1) support1 = a1; }
      vals.push(shrink(phiFrom(counts, f, g), a, m));
    }
  }
  return { score: aggregate(vals, agg), support, support1, pairs: vals.length, vals };
}

export function tcovScores(refLog, unitFiles, opts = {}) {
  const { K = 5, L = 3, m = 2, agg = 'max' } = opts;
  const T = refLog.length;
  const histEnd = Math.max(0, T - K);
  const counts = coCounts(dilate(refLog.slice(0, histEnd), L));
  const hot = unionSets(refLog.slice(histEnd, T));
  return unitFiles.map((F) => scoreAgainstHot(counts, hot, F, { m, agg }));
}

/** Median over non-null finite values; 0 when there are none. */
export function medianOf(xs) {
  const v = xs.filter((x) => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return 0;
  return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
}

/**
 * Fill nulls with the median so an un-scorable unit is NEUTRAL, not condemned.
 * Exported from here so the policy path (`ranks.mjs`) and the offline replay use the
 * SAME rule — an earlier version had two different medians in two files, which meant
 * the offline arm was not scoring the policy the live arm would run.
 */
export function neutralize(scores) {
  const m = medianOf(scores);
  return scores.map((s) => (s === null || !Number.isFinite(s) ? m : s));
}

/**
 * The SHIPPED priority term, with decay, exactly as `flex.ts:268` + `eviction.ts:79`
 * compute it: the raw sum is formed first, multiplied by decay, and only THEN min-max
 * normalised across the turn's candidates.
 *
 * ⚠️ This exists because of a false claim in the first version of this experiment. It
 * asserted that a flat recurrence term is "deleted" by `minMaxNormalize`. It is not:
 * normalisation is applied to `(2w + R)·decay`, not to `R`. With R ≡ c constant the
 * term does not vanish — it becomes `c·decay`, which for non-writing units is a LIVE
 * ranking signal (decay alone) that would not be there if R were absent. A saturated R
 * changes what the term ranks by; it does not switch it off.
 */
export function shippedPriorityNormalized(units, idle, { editBoost = 2, halfLife = 4 } = {}) {
  const rec = recurrenceUndirected(units.map((u) => u.fp));
  const raw = units.map((u, i) => ((u.wrote ? editBoost : 0) + rec[i]) * Math.pow(0.5, Math.max(0, idle[i]) / halfLife));
  return minMax(raw);
}

/** Diagnostic: how much does a scalar signal actually VARY across a buffer? */
export function dispersion(values) {
  const xs = values.filter((v) => v !== null && Number.isFinite(v));
  if (xs.length === 0) return { n: 0, distinct: 0, min: null, max: null, sd: null, cv: null };
  const mean = xs.reduce((s, v) => s + v, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((s, v) => s + (v - mean) ** 2, 0) / xs.length);
  return {
    n: xs.length,
    distinct: new Set(xs).size,
    min: Math.min(...xs),
    max: Math.max(...xs),
    mean,
    sd,
    cv: mean !== 0 ? sd / Math.abs(mean) : null,
  };
}
