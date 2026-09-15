/**
 * Unit tests for the covariance signals and their metrics (node:test, stdlib, no deps).
 * Run: node --test experiments/covariance-eviction/signals.test.mjs
 *
 * These modules are imported here rather than the harnesses, deliberately: when
 * `fisherOneSided` lived inside an experiment module, `node --test` on its test file
 * executed that module's `main()` and started a 60-cell live GPU run which then
 * overwrote the real results file. Nothing under test here touches a network or a
 * model.
 *
 * EVERY TEST IS WRITTEN TO FAIL AGAINST A BROKEN OR NO-OP IMPLEMENTATION. A test that
 * only asserts "the function returned an array of the right length" would pass against
 * `() => units.map(() => 0)`, which is exactly the inert-arm failure this project has
 * already shipped once (`idleOf` keyed on `__init__`, pinning the signal near zero and
 * making a whole live arm a no-op). So each assertion below names a specific wrong
 * implementation it excludes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dilate, coCounts, pushTurn, emptyCounts, phiFrom, supportOf, shrink, shippedPriorityNormalized,
  tcovScores, scoreAgainstHot, unionSets,
  recurrenceUndirected, recurrenceDirected, recurrenceCounts,
  shippedPriority, splitPriority, minMax, dispersion,
} from './signals.mjs';
import {
  auc, spearman, rankAvg, recallAtBudget, blockBootstrapValues, pairedDeltaValues,
  movingBlockBootstrap, autocorr, welchT, holm, splitByBounds, makeRng,
  fitLogistic, predictLogit, meanOf,
} from './metrics.mjs';
import { extractFingerprints, bashPaths, normPath } from './transcript.mjs';

const S = (...xs) => new Set(xs);

// ── phi: the statistic the whole H2 arm rests on ─────────────────────────────

test('phi reproduces the closed-form value on a hand-computed table', () => {
  // a.py and b.py co-active on 4 turns, a.py alone on 2, b.py alone on 2, neither on 2.
  const series = [
    S('a.py', 'b.py'), S('a.py', 'b.py'), S('a.py', 'b.py'), S('a.py', 'b.py'),
    S('a.py'), S('a.py'), S('b.py'), S('b.py'), S(), S(),
  ];
  const c = coCounts(series);
  // n=10, n_a=6, n_b=6, a=4, b=2, c=2, d=2
  // phi = (4*2 - 2*2) / sqrt(6*4*6*4) = 4 / 24 = 0.16666...
  assert.equal(supportOf(c, 'a.py', 'b.py'), 4);
  assert.ok(Math.abs(phiFrom(c, 'a.py', 'b.py') - 4 / 24) < 1e-12,
    `expected 0.1667, got ${phiFrom(c, 'a.py', 'b.py')}`);
});

test('phi is symmetric and zero on the diagonal', () => {
  const c = coCounts([S('x', 'y'), S('x'), S('y'), S('x', 'y')]);
  assert.equal(phiFrom(c, 'x', 'y'), phiFrom(c, 'y', 'x'));
  assert.equal(phiFrom(c, 'x', 'x'), 0);
});

test('THE __init__ GUARD: a file active on every turn scores phi 0 against everything', () => {
  // This is the regression that made a whole live arm inert — a token shared by every
  // unit linked every unit to every other. A raw co-occurrence COUNT would rank this
  // file highest against all partners; phi must rank it at exactly zero.
  const series = [S('boiler', 'a'), S('boiler', 'b'), S('boiler', 'a'), S('boiler', 'c')];
  const c = coCounts(series);
  assert.equal(supportOf(c, 'boiler', 'a'), 2, 'raw co-count is high — a count-based signal would be fooled');
  assert.equal(phiFrom(c, 'boiler', 'a'), 0);
  assert.equal(phiFrom(c, 'boiler', 'b'), 0);
  assert.equal(phiFrom(c, 'boiler', 'c'), 0);
  // ...while a genuinely selective pair is NOT zero, so the guard is not just "return 0"
  const sel = coCounts([S('p', 'q'), S('p', 'q'), S('r'), S('r')]);
  assert.ok(phiFrom(sel, 'p', 'q') > 0.5, `selective pair should survive, got ${phiFrom(sel, 'p', 'q')}`);
});

test('incremental pushTurn agrees with the from-scratch coCounts reference', () => {
  const series = [S('a', 'b'), S('b', 'c'), S('a'), S('a', 'b', 'c')];
  const inc = emptyCounts();
  for (const s of series) pushTurn(inc, s);
  const ref = coCounts(series);
  assert.equal(inc.n, ref.n);
  for (const [k, v] of ref.nf) assert.equal(inc.nf.get(k), v, `margin ${k}`);
  for (const [k, v] of ref.pair) assert.equal(inc.pair.get(k), v, `pair ${k}`);
  assert.equal(inc.pair.size, ref.pair.size);
});

test('dilate widens the episode window and L=1 is the identity', () => {
  const log = [S('a'), S('b'), S('c')];
  assert.deepEqual(dilate(log, 1).map((s) => [...s].sort()), [['a'], ['b'], ['c']]);
  assert.deepEqual(dilate(log, 2).map((s) => [...s].sort()), [['a'], ['a', 'b'], ['b', 'c']]);
  // and it actually creates co-activation that L=1 does not see
  assert.equal(supportOf(coCounts(dilate(log, 1)), 'a', 'b'), 0);
  assert.equal(supportOf(coCounts(dilate(log, 2)), 'a', 'b'), 1);
});

test('shrinkage penalises a perfect phi built from a single co-occurrence', () => {
  assert.equal(shrink(1, 1, 2), 1 / 3);
  assert.ok(shrink(1, 20, 2) > 0.9, 'well-supported pairs must survive shrinkage');
  assert.equal(shrink(1, 1, 0), 1, 'm=0 disables shrinkage');
});

// ── tcov: the H2 signal end to end ───────────────────────────────────────────

/**
 * The canonical scenario this signal exists for: `b.py` was historically co-edited
 * with `a.py`, then went dormant while unrelated work happened; `a.py` is hot again.
 * Recency and reference-recency both condemn `b.py`. Covariance must save it.
 */
function dormantReturnLog() {
  const log = [];
  for (let i = 0; i < 10; i += 1) log.push(S('a.py', 'b.py'));   // the pair's shared history
  for (const f of ['c.py', 'd.py', 'e.py', 'f.py', 'g.py', 'h.py', 'i.py']) log.push(S(f));
  for (let i = 0; i < 3; i += 1) log.push(S('a.py'));            // the hot window
  return log;
}

test('tcov ranks the dormant co-active unit above the dormant unrelated ones', () => {
  const log = dormantReturnLog();
  const units = [S('b.py'), S('c.py'), S('d.py'), S('e.py')];
  const s = tcovScores(log, units, { K: 3, L: 1, m: 2, agg: 'max' });
  assert.ok(s[0] > 0.5, `b.py should score high, got ${s[0]}`);
  for (let i = 1; i < s.length; i += 1) {
    assert.ok(s[0] > s[i] + 0.4, `b.py (${s[0]}) must clearly beat unit ${i} (${s[i]})`);
  }
  // non-vacuous: the scores are not all equal, so this cannot pass against a constant
  assert.ok(new Set(s).size > 1, 'scores must vary across units');
});

test('tcov gives a unit NO credit for its own file being hot (the relevance leak)', () => {
  // If this failed, tcov would be a rename of relevance-to-recent — the signal D-EV4
  // measured as the WORST eviction signal. The whole claim is that it is a different
  // quantity, so the leak is closed in the definition and asserted here.
  const log = dormantReturnLog();
  const [selfHot] = tcovScores(log, [S('a.py')], { K: 3, L: 1, m: 2, agg: 'max' });
  assert.equal(selfHot, null, 'a unit whose only file IS the hot file has no eligible pair');
});

test('tcov returns null for a unit with no file identity', () => {
  const s = tcovScores(dormantReturnLog(), [new Set()], { K: 3 });
  assert.deepEqual(s, [null]);
});

test('tcov history and hot windows are DISJOINT — the hot turns do not train phi', () => {
  // Only the last K turns are hot, and they must not contribute to the fitted counts.
  // Build a log whose ONLY co-occurrence of (x,y) is inside the hot window: phi must
  // then have no support and the score must collapse to ~0.
  const log = [S('p'), S('q'), S('p'), S('q'), S('x', 'y'), S('x', 'y')];
  const s = tcovScores(log, [S('y')], { K: 2, L: 1, m: 2, agg: 'max' });
  assert.ok(s[0] === null || Math.abs(s[0]) < 1e-9,
    `co-occurrence seen only inside the hot window must not count, got ${s[0]}`);
});

test('scoreAgainstHot and tcovScores agree (the incremental path is not a different signal)', () => {
  const log = dormantReturnLog();
  const K = 3;
  const counts = coCounts(dilate(log.slice(0, log.length - K), 1));
  const hot = unionSets(log.slice(log.length - K));
  const direct = scoreAgainstHot(counts, hot, S('b.py'), { m: 2, agg: 'max' });
  const viaTcov = tcovScores(log, [S('b.py')], { K, L: 1, m: 2, agg: 'max' })[0];
  assert.ok(Math.abs(direct - viaTcov) < 1e-12, `${direct} vs ${viaTcov}`);
});

test('the aggregator is a real choice — max and mean disagree on a mixed unit', () => {
  const log = [];
  for (let i = 0; i < 8; i += 1) log.push(S('a.py', 'b.py'));
  for (let i = 0; i < 8; i += 1) log.push(S('z.py'));
  log.push(S('a.py'), S('z.py'));     // hot: {a.py, z.py}
  const unit = [S('b.py')];
  const mx = tcovScores(log, unit, { K: 2, L: 1, m: 1, agg: 'max' })[0];
  const mn = tcovScores(log, unit, { K: 2, L: 1, m: 1, agg: 'mean' })[0];
  assert.ok(mx > mn, `max (${mx}) must exceed mean (${mn}) when one pair is strong and one is not`);
});

// ── H1: recurrence forms and the unreachable ratio ───────────────────────────

test('directed and undirected recurrence are genuinely different functions', () => {
  const fps = [S('a'), S('a'), S('b'), S('a')];
  assert.deepEqual(recurrenceUndirected(fps), [2, 2, 0, 2]);
  assert.deepEqual(recurrenceDirected(fps), [2, 1, 0, 0]);
});

test('the fast inverted-index recurrence matches the naive reference exactly', () => {
  const fps = [S('a', 'b'), S('b'), S('c'), S('a', 'c'), new Set(), S('b', 'c')];
  const fast = recurrenceCounts(fps);
  assert.deepEqual(fast.undirected, recurrenceUndirected(fps));
  assert.deepEqual(fast.directed, recurrenceDirected(fps));
});

test('SHIPPED priority cannot reorder the two halves — no outer weight can; the split form can', () => {
  // Unit 0: edited, no recurrence.  Unit 1: not edited, recurrence 2.
  // flex.ts forms `(wrote?2:0) + coOccurrence` BEFORE any weight, so the outer
  // EvictionWeights.priority scales both halves together and leaves the order fixed.
  const units = [
    { wrote: true, fp: S('solo') },
    { wrote: false, fp: S('x') },
    { wrote: false, fp: S('x') },
    { wrote: false, fp: S('x') },
  ];
  const shipped = shippedPriority(units);
  assert.equal(shipped[0], 2, 'edited unit: boost 2 + 0 recurrence');
  assert.equal(shipped[1], 2, 'recurring unit: 0 boost + 2 recurrence');
  for (const w of [0.5, 1, 2, 10]) {
    const scaled = shipped.map((v) => v * w);
    assert.equal(Math.sign(scaled[0] - scaled[1]), Math.sign(shipped[0] - shipped[1]),
      `outer weight ${w} changed nothing about the ordering — which is the point`);
  }
  // the split form CAN move them: rho=0 is pure recurrence, rho large is pure edit
  const pureRec = splitPriority(units, { rho: 0 });
  const pureEdit = splitPriority(units, { rho: 8 });
  assert.ok(pureRec[1] > pureRec[0], 'rho=0 must prefer the recurring unit');
  assert.ok(pureEdit[0] > pureEdit[1], 'large rho must prefer the edited unit');
});

test('A FLAT RECURRENCE TERM IS NOT DELETED BY NORMALISATION — it becomes a decay ranking', () => {
  // ⚠️ THIS TEST EXISTS BECAUSE THE FIRST VERSION OF THIS EXPERIMENT CLAIMED THE OPPOSITE.
  // It asserted that when `coOccurrence` is flat, `minMaxNormalize` maps it to zeros and
  // the shipped priority term "reduces to the edit boost times decay, with the recurrence
  // half deleted". That is false: `eviction.ts:79` normalises the PRODUCT
  // `(2*wrote + coOccurrence) * decay`, not `coOccurrence`. With R constant at c the term
  // becomes `c * decay`, which for NON-WRITING units is a live ranking signal that would
  // not exist if R were zero. A saturated R changes what the term ranks by; it does not
  // switch the term off — the opposite of inert.
  const units = [
    { wrote: true, fp: S('x') }, { wrote: false, fp: S('x') },
    { wrote: false, fp: S('x') }, { wrote: false, fp: S('x') },
  ];
  const idle = [0, 1, 8, 16];                       // decay = 1, 0.841, 0.25, 0.0625
  const withR = shippedPriorityNormalized(units, idle, { halfLife: 4 });
  // recurrence is FLAT here: every unit shares `x` with the other three, so R === 3
  assert.equal(new Set([3, 3, 3, 3]).size, 1);
  // the three non-writing units are STRICTLY ORDERED by decay — the term is not inert
  assert.ok(withR[1] > withR[2] && withR[2] > withR[3],
    `flat R must still rank the non-writers by decay, got ${withR.join(', ')}`);
  assert.ok(withR[0] === 1 && withR[3] === 0, 'min-max endpoints');

  // and with R actually absent the same three units COLLAPSE to a tie — which is what
  // "the recurrence half is deleted" would have to look like, and does not happen.
  const noR = shippedPriorityNormalized(units.map((u) => ({ ...u, fp: new Set() })), idle, { halfLife: 4 });
  assert.equal(noR[1], 0);
  assert.equal(noR[2], 0);
  assert.equal(noR[3], 0);
  assert.ok(new Set(withR.slice(1)).size === 3 && new Set(noR.slice(1)).size === 1,
    'the two forms must induce DIFFERENT orderings — that is the whole point');
});

test('minMax maps a flat vector to zeros — but that is the term BEFORE decay, not after', () => {
  assert.deepEqual(minMax([3, 3, 3, 3]), [0, 0, 0, 0]);
  assert.deepEqual(minMax([0, 5, 10]), [0, 0.5, 1]);
});

test('dispersion detects a flat signal, and does not flag a varying one', () => {
  assert.equal(dispersion([4, 4, 4]).distinct, 1);
  assert.equal(dispersion([4, 4, 4]).sd, 0);
  assert.ok(dispersion([1, 5, 9]).sd > 0);
  assert.equal(dispersion([null, null]).n, 0);
});

// ── metrics ──────────────────────────────────────────────────────────────────

test('auc is 1 on a perfect ranking, 0 on an inverted one, 0.5 on all-ties', () => {
  assert.equal(auc([3, 2, 1], [1, 1, 0]), 1);
  assert.equal(auc([1, 2, 3], [1, 1, 0]), 0);
  assert.equal(auc([1, 1, 1], [1, 0, 1]), 0.5);
  assert.equal(auc([1, 2], [1, 1]), null, 'undefined with one class, not 0.5');
});

test('rankAvg averages ties', () => {
  assert.deepEqual(rankAvg([10, 20, 20, 30]), [1, 2.5, 2.5, 4]);
});

test('spearman is 1 for a monotone relabelling and near 0 for an unrelated one', () => {
  assert.equal(spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  assert.equal(spearman([1, 2, 3, 4], [4, 3, 2, 1]), -1);
  const s = spearman([1, 2, 3, 4, 5, 6], [3, 1, 6, 2, 5, 4]);
  assert.ok(Math.abs(s) < 0.6, `unrelated orderings should not correlate strongly, got ${s}`);
});

test('recallAtBudget keeps the top-M by score and is null with nothing needed', () => {
  const rows = [
    { score: 9, needed: true }, { score: 8, needed: false },
    { score: 7, needed: true }, { score: 1, needed: true },
  ];
  assert.equal(recallAtBudget(rows, 3), 2 / 3);
  assert.equal(recallAtBudget(rows, 4), 1);
  assert.equal(recallAtBudget(rows.map((r) => ({ ...r, needed: false })), 3), null);
});

test('the bootstrap is deterministic, brackets the mean, and narrows with n', () => {
  const xs = Array.from({ length: 200 }, (_, i) => (i % 10) / 10);
  const a = blockBootstrapValues(xs, { B: 200, seed: 42, blockLen: 10 });
  const b = blockBootstrapValues(xs, { B: 200, seed: 42, blockLen: 10 });
  assert.deepEqual(a, b, 'same seed must reproduce exactly');
  assert.ok(a.lo < a.point && a.point < a.hi);
  const wide = blockBootstrapValues(xs.slice(0, 20), { B: 200, seed: 42, blockLen: 10 });
  assert.ok((wide.hi - wide.lo) > (a.hi - a.lo), 'fewer turns must give a wider interval');
});

test('THE BOOTSTRAP IS A MOVING BLOCK: on an autocorrelated series it is WIDER than i.i.d.', () => {
  // The defect this replaces: the first version drew turns i.i.d. while three files and
  // two design documents called it a block bootstrap. On a positively autocorrelated
  // series an i.i.d. resample understates the variance, so every interval was too narrow.
  // A random walk has lag-1 autocorrelation near 1 and is the clean discriminator.
  const rng = makeRng(3);
  const walk = []; let v = 0;
  for (let i = 0; i < 600; i += 1) { v += rng() - 0.5; walk.push(v); }
  assert.ok(autocorr(walk, 1) > 0.9, `fixture must be autocorrelated, got ${autocorr(walk, 1)}`);
  const iid = movingBlockBootstrap([walk], { B: 400, seed: 9, blockLen: 1 });
  const blk = movingBlockBootstrap([walk], { B: 400, seed: 9, blockLen: 20 });
  assert.ok((blk.hi - blk.lo) > 2 * (iid.hi - iid.lo),
    `block interval ${(blk.hi - blk.lo).toFixed(4)} must be much wider than i.i.d. ${(iid.hi - iid.lo).toFixed(4)}`);
  // and on an i.i.d. series the two should agree closely, so the widening is not a bias
  const noise = Array.from({ length: 600 }, () => rng() - 0.5);
  const n1 = movingBlockBootstrap([noise], { B: 400, seed: 9, blockLen: 1 });
  const n2 = movingBlockBootstrap([noise], { B: 400, seed: 9, blockLen: 20 });
  assert.ok(Math.abs((n2.hi - n2.lo) / (n1.hi - n1.lo) - 1) < 0.5,
    'on an independent series the block and i.i.d. widths must be comparable');
});

test('blocks never span a session boundary', () => {
  // Session A is all zeros, session B all ones. A scheme that spliced them would produce
  // replicate means strictly between 0 and 1 in a pattern that ignores the 50/50 split;
  // the invariant we can assert cheaply is that every replicate stays in range and the
  // point estimate is the pooled mean.
  const A = new Array(50).fill(0), B = new Array(50).fill(1);
  const r = movingBlockBootstrap([A, B], { B: 200, seed: 5, blockLen: 10 });
  assert.equal(r.point, 0.5);
  assert.ok(r.lo >= 0 && r.hi <= 1);
  assert.deepEqual(splitByBounds([...A, ...B], [50]).map((g) => g.length), [50, 50]);
});

test('welchT uses the t distribution, not a normal approximation', () => {
  // At n=12/arm the two disagree across the pre-registered alpha=0.05 boundary.
  const a = [], b = [];
  for (let i = 0; i < 12; i += 1) { a.push(0.5 + (i % 4) * 0.1); b.push(0.2 + (i % 4) * 0.1); }
  const r = welchT(a, b);
  assert.ok(r.df > 0 && r.df <= a.length + b.length, `Welch-Satterthwaite df, got ${r.df}`);
  assert.ok(Math.abs(r.delta - 0.3) < 1e-9);
  assert.ok(r.p < 0.05 && r.p >= 0, `a large separation should be significant, got ${r.p}`);
  const eq = welchT([1, 2, 3, 4], [1, 2, 3, 4]);
  assert.ok(eq.p > 0.9, 'identical samples must not be significant');
  // THE DISCRIMINATOR vs the normal approximation it replaces: a borderline separation.
  // Construct t ~ 2.07 on df ~ 22, where the normal gives p = 0.038 and t(22) gives 0.050.
  const na = 12, nb = 12;
  const mkSample = (mean, sd, n) => Array.from({ length: n }, (_, i) => mean + sd * (i - (n - 1) / 2) / Math.sqrt((n * n - 1) / 12));
  const A = mkSample(0.50, 0.30, na), Bx = mkSample(0.25, 0.30, nb);
  const w = welchT(A, Bx);
  const normalP = 2 * (1 - 0.5 * (1 + erfApprox(Math.abs(w.t) / Math.SQRT2)));
  assert.ok(w.p > normalP, `the t tail (${w.p}) must be heavier than the normal (${normalP.toFixed(4)}) at df=${w.df}`);
});

/** The normal approximation welchT replaces — reproduced only to show it is different. */
function erfApprox(x) {
  const t = 1 / (1 + 0.3275911 * x);
  return 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
}

test('holm steps down, is monotone, and is more conservative than raw p', () => {
  const e = [{ p: 0.01 }, { p: 0.02 }, { p: 0.03 }, { p: 0.5 }];
  const h = holm(e, 0.05);
  assert.equal(h[0].p_holm, 0.04, '0.01 * 4');
  assert.ok(h[1].p_holm >= h[0].p_holm, 'monotone');
  assert.equal(h[3].reject_holm, false);
  assert.ok(h.every((x, i) => x.p_holm >= e[i].p), 'Holm can only raise a p-value');
  assert.equal(holm([{ p: null }], 0.05)[0].p_holm, null, 'a missing p is not silently rejected');
});

test('pairedDeltaValues differences WITHIN a turn — a constant offset has a tight interval', () => {
  // Two signals that differ by exactly +0.1 on every turn, on very noisy turns. An
  // unpaired comparison would drown in the turn-to-turn noise; the paired one must not.
  const a = Array.from({ length: 100 }, (_, i) => (i % 7) / 7);
  const b = a.map((x) => x - 0.1);
  const d = pairedDeltaValues(a, b, { B: 300, seed: 7 });
  assert.ok(Math.abs(d.point - 0.1) < 1e-9);
  assert.ok(d.lo > 0.099 && d.hi < 0.101, `paired interval should be tight, got [${d.lo}, ${d.hi}]`);
});

test('logistic regression recovers the sign of a known effect and predicts monotonically', () => {
  const X = [], y = [];
  for (let i = 0; i < 200; i += 1) {
    const x = (i % 20) / 20;
    X.push([x]); y.push(x > 0.5 ? 1 : 0);
  }
  const w = fitLogistic(X, y, { iters: 25 });
  assert.ok(w[1] > 0, `slope should be positive, got ${w[1]}`);
  assert.ok(predictLogit(w, [0.9]) > predictLogit(w, [0.1]));
});

test('meanOf ignores nulls rather than counting them as zero', () => {
  assert.equal(meanOf([1, null, 3]), 2);
  assert.equal(meanOf([null, null]), null);
});

// ── transcript parsing ───────────────────────────────────────────────────────

test('bashPaths extracts real paths and rejects flags, bare dirs and URLs', () => {
  const p = bashPaths('node --test experiments/a.test.mjs && cat packages/core/src/x.ts');
  assert.ok(p.has('experiments/a.test.mjs'), [...p].join(','));
  assert.ok(p.has('packages/core/src/x.ts'), [...p].join(','));
  const q = bashPaths('pnpm vitest run packages/core --pool=forks https://x.dev/a.html');
  assert.ok(!q.has('packages/core'), 'a bare directory is not a file reference');
  assert.equal([...q].filter((x) => x.includes('http')).length, 0, 'URLs are not file references');
});

test('extractFingerprints matches the SHIPPED classes — and NOT snake_case', () => {
  // ⚠️ REWRITTEN. The first version of this test was named "the promiscuous token classes
  // the shipped extractor uses" and asserted `fp.has('parse_line')` — which the shipped
  // extractor does NOT match. The test passed while its name asserted the opposite,
  // because the code under test was a hand-written regex family, not the shipped one.
  // `lexical.ts` has no snake_case rule, so neither `__init__` nor `parse_line` matches;
  // the `__init__` regression belongs to `coding-harness/lib.mjs:82`, a different
  // extractor, and both DESIGN docs now attribute it there.
  const fp = extractFingerprints(
    'call parse_line in packages/core/src/money.py from ParseError, MAX_RETRIES, camelCase, obj.attr, `a literal`, __init__');
  assert.ok(fp.has('packages/core/src/money.py'), 'FILE_PATH requires a slash');
  assert.ok(fp.has('camelCase'), 'CAMEL');
  assert.ok(fp.has('ParseError'), 'PASCAL');
  assert.ok(fp.has('MAX_RETRIES'), 'UPPER_SNAKE');
  assert.ok(fp.has('obj.attr'), 'DOTTED — omitted by the hand-written version');
  assert.ok(fp.has('a literal'), 'BACKTICK — omitted by the hand-written version');
  assert.equal(fp.has('__init__'), false, 'the shipped extractor does NOT match __init__');
  assert.equal(fp.has('parse_line'), false, 'the shipped extractor does NOT match snake_case');
});

test('normPath collapses an absolute checkout path to a repo-relative one', () => {
  assert.equal(normPath('/home/u/GitHub/context-tree/packages/core/src/a.ts'), 'packages/core/src/a.ts');
  assert.equal(normPath('packages/core/src/a.ts'), 'packages/core/src/a.ts');
  assert.equal(normPath(null), null);
});
