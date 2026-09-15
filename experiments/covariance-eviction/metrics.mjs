/**
 * Offline evaluation metrics, in their own module so tests import them without
 * importing a harness (the `stats.mjs` precedent: when `fisherOneSided` lived in an
 * experiment, `node --test` on its test file started a 60-cell live GPU run).
 *
 * The resampling scheme is the load-bearing choice, and it has TWO parts, because the
 * first version of this file got the second one wrong and reported every interval too
 * narrow as a result.
 *
 *  1. THE UNIT IS THE TURN, not the (turn x candidate) row. The corpus yields ~10^5 rows
 *     but only ~10^3 turns, and rows inside a turn share a hot set, a candidate pool and
 *     a label horizon. A row-level interval would be ~10x too narrow. (This part was
 *     right from the start.)
 *  2. TURNS ARE NOT INDEPENDENT OF EACH OTHER EITHER, so the resample must be a MOVING
 *     BLOCK, not i.i.d. Measured lag-1 autocorrelation of the paired per-turn series is
 *     +0.42 to +0.51. The original code drew turns i.i.d. while three files and two
 *     design documents called it a "block bootstrap" by name; correcting it widens every
 *     interval by roughly 1.3-1.6x and overturns at least one "excludes 0" flag.
 *
 * `movingBlockBootstrap` is the corrected primitive; `blockBootstrapValues` is a thin
 * wrapper that takes a pooled series plus session boundaries. `blockLen = 1` reproduces
 * the old behaviour and exists so the sensitivity to the scheme can be SHOWN.
 */

/** Ranks with average ties (1-based). */
export function rankAvg(values) {
  const idx = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(values.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j += 1;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) out[idx[k][1]] = r;
    i = j + 1;
  }
  return out;
}

/** Pearson correlation. */
export function pearson(a, b) {
  const n = a.length;
  if (n === 0 || b.length !== n) return null;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i += 1) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : null;
}

/** Spearman rank correlation — the relabelling check. */
export const spearman = (a, b) => pearson(rankAvg(a), rankAvg(b));

/**
 * AUC via the rank-sum identity (Mann-Whitney U), with tie handling: the probability
 * that a randomly chosen positive outranks a randomly chosen negative, ties counting
 * half. Returns null when one class is absent (undefined, not 0.5).
 */
export function auc(scores, labels) {
  const pos = labels.reduce((s, v) => s + (v ? 1 : 0), 0);
  const neg = labels.length - pos;
  if (pos === 0 || neg === 0) return null;
  const r = rankAvg(scores);
  let sumPos = 0;
  for (let i = 0; i < labels.length; i += 1) if (labels[i]) sumPos += r[i];
  return (sumPos - (pos * (pos + 1)) / 2) / (pos * neg);
}

/**
 * Keep-needed recall at a budget of M kept units — the metric
 * `assembler-weighting/report-assembler-weighting.md` ranks weightings with, kept
 * identical here so the two results are on the same scale.
 * `rows`: [{ score, needed }] for ONE decision turn. Higher score = keep first.
 */
export function recallAtBudget(rows, M) {
  const needed = rows.reduce((s, r) => s + (r.needed ? 1 : 0), 0);
  if (needed === 0) return null;
  const kept = [...rows].sort((a, b) => b.score - a.score).slice(0, M);
  return kept.reduce((s, r) => s + (r.needed ? 1 : 0), 0) / needed;
}

/** Deterministic PRNG (mulberry32), so every bootstrap reruns identically. */
export function makeRng(seed = 0x9e3779b9) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const quantile = (sorted, p) =>
  sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];

/** Lag-`k` autocorrelation of a series — the diagnostic that decides the block length. */
export function autocorr(values, k = 1) {
  const v = values.filter((x) => x !== null && Number.isFinite(x));
  if (v.length <= k + 1) return null;
  const m = meanOf(v);
  let num = 0, den = 0;
  for (let i = 0; i < v.length; i += 1) {
    den += (v[i] - m) ** 2;
    if (i + k < v.length) num += (v[i] - m) * (v[i + k] - m);
  }
  return den > 0 ? num / den : null;
}

/**
 * MOVING-BLOCK BOOTSTRAP over per-turn statistics, resampled WITHIN sessions.
 *
 * ⚠️ CORRECTED after adversarial review. The first version of this function drew turns
 * i.i.d. (`v[(rng()*v.length)|0]`) while three files and both design documents called it
 * a "block bootstrap" by name. It is not: consecutive decision turns in an agent
 * transcript share candidates, hot set and label horizon, and the measured lag-1
 * autocorrelation of the paired per-turn series here runs **+0.42 to +0.51**. An i.i.d.
 * resample of a positively autocorrelated series understates the variance — every
 * interval this project reported from it was too narrow by roughly 1.3-1.6x, and at
 * least one "excludes 0" flag did not survive the correction.
 *
 * `groups` is one array of per-turn values PER SESSION. Blocks are drawn with random
 * starts inside a session and never span a session boundary, so the scheme handles the
 * within-session serial dependence AND keeps the between-session structure C0 warns
 * about (4 sessions is too few for a pure cluster bootstrap, but a block bootstrap that
 * ignored session boundaries would splice unrelated transcripts together).
 *
 * `blockLen = 1` reduces to the old i.i.d. scheme and is kept only so the sensitivity of
 * a result to the scheme can be shown rather than asserted.
 *
 * NOTE ON THE AUC ESTIMAND. Averaging per-turn AUC is not the same as pooling every
 * candidate row into one ranking. The per-turn version is the right one here: the
 * eviction decision is made WITHIN a turn against that turn's candidates. A pooled AUC
 * would additionally reward a signal for being comparable ACROSS turns, which no
 * per-turn min-max-normalised score is — `eviction.ts` normalises per turn precisely
 * because absolute magnitudes are not comparable between turns.
 */
export function movingBlockBootstrap(groups, { B = 400, seed = 12345, alpha = 0.05, blockLen = 10 } = {}) {
  const gs = groups.map((g) => g.filter((x) => x !== null && Number.isFinite(x))).filter((g) => g.length > 0);
  const flat = gs.flat();
  const point = meanOf(flat);
  if (flat.length === 0) return { point: null, lo: null, hi: null, B: 0, n: 0, blockLen };
  const rng = makeRng(seed);
  const reps = new Array(B);
  for (let b = 0; b < B; b += 1) {
    let sum = 0, count = 0;
    for (const g of gs) {
      const L = Math.max(1, Math.min(blockLen, g.length));
      const nBlocks = Math.ceil(g.length / L);
      const maxStart = g.length - L;
      for (let k = 0; k < nBlocks; k += 1) {
        const start = maxStart > 0 ? (rng() * (maxStart + 1)) | 0 : 0;
        for (let j = 0; j < L && count < flat.length; j += 1) { sum += g[start + j]; count += 1; }
      }
    }
    reps[b] = sum / Math.max(1, count);
  }
  reps.sort((a, b) => a - b);
  // Two-sided bootstrap p-value for "the mean is 0": twice the smaller tail mass, floored
  // at the resolution B replicates can express. Returned so a multiple-comparison
  // correction has a real p to work on — an earlier version fed Holm a hand-made constant
  // (0.025 when the interval excluded zero, 1 otherwise), which made the correction
  // decorative.
  const below = reps.filter((v) => v <= 0).length;
  const above = reps.filter((v) => v >= 0).length;
  const p2 = Math.min(1, Math.max(1 / B, 2 * Math.min(below, above) / B));
  return {
    point, lo: quantile(reps, alpha / 2), hi: quantile(reps, 1 - alpha / 2),
    p: p2, B, n: flat.length, blockLen, lag1: autocorr(flat, 1),
  };
}

/**
 * PAIRED per-turn difference, session-grouped. `a` and `b` hold per-turn statistics for
 * two signals on the SAME turns, so the difference is taken WITHIN a turn before any
 * resampling — turn difficulty cancels exactly, the same reason `anchor-replay.mjs`
 * analyses paired discordant events rather than marginal rates. Turns where either
 * statistic is undefined are dropped from both. `bounds` is the session boundary index
 * list; omit it and the whole series is treated as one session (which is what the
 * pre-correction code effectively did, and is wrong for a pooled corpus).
 */
export function pairedDeltaValues(a, b, opts = {}, bounds = null) {
  const d = [];
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i], y = b[i];
    d.push(x === null || y === null || !Number.isFinite(x) || !Number.isFinite(y) ? null : x - y);
  }
  return movingBlockBootstrap(splitByBounds(d, bounds), opts);
}

/** Split a pooled per-turn series back into per-session arrays. */
export function splitByBounds(values, bounds) {
  if (!bounds || bounds.length === 0) return [values];
  const out = [];
  let prev = 0;
  for (const b of bounds) { out.push(values.slice(prev, b)); prev = b; }
  if (prev < values.length) out.push(values.slice(prev));
  return out.filter((g) => g.length > 0);
}

/** Convenience wrapper: pooled series + session bounds -> moving-block interval. */
export const blockBootstrapValues = (values, opts = {}, bounds = null) =>
  movingBlockBootstrap(splitByBounds(values, bounds), opts);

// ── frequentist tests used by the LIVE harness ───────────────────────────────

/** Regularised incomplete beta, for an exact Student-t CDF. */
function betacf(a, b, x) {
  const FPMIN = 1e-300, qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c; h *= del;
    if (Math.abs(del - 1) < 3e-12) break;
  }
  return h;
}
function lnGamma(z) {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let x = z, y = z, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j += 1) ser += g[j] / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}
export function betaInc(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/**
 * WELCH'S t TEST — an exact Student-t tail with Welch-Satterthwaite df, not the normal
 * approximation the first version used. At n=12 per arm (df ~ 22) the difference is
 * decisive at the pre-registered boundary: t = 2.07 gives p = 0.038 under a normal and
 * p = 0.050 under t(22).
 */
export function welchT(a, b) {
  const A = a.filter(Number.isFinite), Bv = b.filter(Number.isFinite);
  const na = A.length, nb = Bv.length;
  if (na < 2 || nb < 2) return null;
  const ma = meanOf(A), mb = meanOf(Bv);
  const va = A.reduce((s, x) => s + (x - ma) ** 2, 0) / (na - 1);
  const vb = Bv.reduce((s, x) => s + (x - mb) ** 2, 0) / (nb - 1);
  const se2 = va / na + vb / nb;
  if (!(se2 > 0)) return { delta: +(ma - mb).toFixed(4), t: null, df: null, p: null, se: 0 };
  const se = Math.sqrt(se2);
  const t = (ma - mb) / se;
  const df = (se2 * se2) / ((va * va) / (na * na * (na - 1)) + (vb * vb) / (nb * nb * (nb - 1)));
  const p = betaInc(df / 2, 0.5, df / (df + t * t));      // two-sided
  return { delta: +(ma - mb).toFixed(4), t: +t.toFixed(3), df: +df.toFixed(1), p: +p.toFixed(4), se: +se.toFixed(4) };
}

/**
 * HOLM-BONFERRONI step-down. Both designs pre-register it and the first version
 * implemented it nowhere while emitting five raw p-values. Returns the input array with
 * `p_holm` and `reject_holm` attached, sorted order preserved.
 */
export function holm(entries, alpha = 0.05, key = 'p') {
  const idx = entries.map((e, i) => i).filter((i) => Number.isFinite(entries[i]?.[key]));
  idx.sort((x, y) => entries[x][key] - entries[y][key]);
  const m = idx.length;
  let running = 0;
  const out = entries.map((e) => ({ ...e }));
  idx.forEach((i, rank) => {
    const adj = Math.min(1, (m - rank) * entries[i][key]);
    running = Math.max(running, adj);                     // enforce monotonicity
    out[i].p_holm = +running.toFixed(4);
    out[i].reject_holm = running < alpha;
  });
  for (const o of out) if (o.p_holm === undefined) { o.p_holm = null; o.reject_holm = null; }
  return out;
}

/**
 * Ridge-regularised logistic regression by IRLS, for the CROSS-SESSION incremental
 * test: fit on one session, score another, and ask whether adding a feature raises
 * held-out AUC. Fitting and testing on the same session would reward a signal for
 * memorising that session's file graph, which is exactly the failure mode the
 * `assembler-weighting` LR refinement guarded against by training on one session and
 * testing on the other. The ridge term (`lambda`) exists only to keep IRLS from
 * diverging on a separable feature; it is not a tuned hyperparameter.
 */
export function fitLogistic(X, y, { iters = 40, lambda = 1e-3 } = {}) {
  const n = X.length;
  if (n === 0) return null;
  const p = X[0].length + 1;                                   // + intercept
  const w = new Array(p).fill(0);
  const row = (i) => [1, ...X[i]];
  for (let it = 0; it < iters; it += 1) {
    const g = new Array(p).fill(0);
    const H = Array.from({ length: p }, () => new Array(p).fill(0));
    for (let i = 0; i < n; i += 1) {
      const x = row(i);
      let z = 0;
      for (let k = 0; k < p; k += 1) z += w[k] * x[k];
      const mu = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
      const s = Math.max(1e-6, mu * (1 - mu));
      for (let k = 0; k < p; k += 1) {
        g[k] += (y[i] - mu) * x[k];
        for (let l = 0; l < p; l += 1) H[k][l] += s * x[k] * x[l];
      }
    }
    for (let k = 0; k < p; k += 1) { g[k] -= lambda * w[k]; H[k][k] += lambda; }
    const d = solveSym(H, g);
    if (!d) break;
    let delta = 0;
    for (let k = 0; k < p; k += 1) { w[k] += d[k]; delta += Math.abs(d[k]); }
    if (delta < 1e-8) break;
  }
  return w;
}

/** Gaussian elimination with partial pivoting; null if singular. */
function solveSym(A, b) {
  const p = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < p; c += 1) {
    let piv = c;
    for (let r = c + 1; r < p; r += 1) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < p; r += 1) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= p; k += 1) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[p] / r[i]);
}

/** Linear predictor of a fitted logistic model (monotone in probability, so AUC-equivalent). */
export const predictLogit = (w, x) => w.reduce((s, wk, k) => s + wk * (k === 0 ? 1 : x[k - 1]), 0);

/** Mean of a numeric array, ignoring nulls. */
export function meanOf(xs) {
  const v = xs.filter((x) => x !== null && Number.isFinite(x));
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
}

/** Wilson 95% interval for k successes in n trials — for the sampled-diagnostic shares. */
export function wilson95(k, n) {
  if (!n) return [0, 0];
  const z = 1.96, p = k / n, den = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return [+Math.max(0, centre - half).toFixed(4), +Math.min(1, centre + half).toFixed(4)];
}

/**
 * MOVING-BLOCK BOOTSTRAP OF A RATIO OF SUMS — the MICRO-average.
 *
 * This exists because two defensible ways to average recall over turns give different
 * answers, and the experiment being replicated used the one this project's other code
 * does not. `assembler-weighting.mjs` accumulates `hit` and `need` across every
 * (turn x needed-unit) pair and reports `sum(hit)/sum(need)` — a MICRO-average, which
 * weights a turn by how many needed units it has. Averaging per-turn recall instead is a
 * MACRO-average, which weights every turn equally.
 *
 * They are not close on this data: on the same corpus and clock the two disagree on the
 * SIGN of the priority-vs-recency contrast, because turns with many needed units are
 * exactly the turns where a recurrence signal does well. Neither is wrong, but only one
 * of them is the estimand the published result refers to, so a replication has to use
 * that one and a comparison has to report both.
 *
 * `groups` holds per-session arrays of `{ hit, need }` (or `{ hitA, hitB, need }` via
 * `num`/`den` accessors). Blocks are resampled exactly as in `movingBlockBootstrap`.
 */
export function movingBlockBootstrapRatio(groups, num, den, { B = 400, seed = 12345, alpha = 0.05, blockLen = 10 } = {}) {
  const gs = groups.map((g) => g.filter((x) => x && Number.isFinite(den(x)) && den(x) > 0)).filter((g) => g.length > 0);
  const flat = gs.flat();
  if (flat.length === 0) return { point: null, lo: null, hi: null, B: 0, n: 0, blockLen };
  const point = flat.reduce((s, x) => s + num(x), 0) / flat.reduce((s, x) => s + den(x), 0);
  const rng = makeRng(seed);
  const reps = new Array(B);
  for (let b = 0; b < B; b += 1) {
    let n = 0, d = 0, count = 0;
    for (const g of gs) {
      const L = Math.max(1, Math.min(blockLen, g.length));
      const nBlocks = Math.ceil(g.length / L);
      const maxStart = g.length - L;
      for (let k = 0; k < nBlocks; k += 1) {
        const start = maxStart > 0 ? (rng() * (maxStart + 1)) | 0 : 0;
        for (let j = 0; j < L && count < flat.length; j += 1) { n += num(g[start + j]); d += den(g[start + j]); count += 1; }
      }
    }
    reps[b] = d > 0 ? n / d : NaN;
  }
  const clean = reps.filter(Number.isFinite).sort((a, b) => a - b);
  return {
    point, lo: clean.length ? quantile(clean, alpha / 2) : null,
    hi: clean.length ? quantile(clean, 1 - alpha / 2) : null, B: clean.length, n: flat.length, blockLen,
  };
}
