/**
 * LR REFINEMENT of the assembler eviction weighting.
 *
 * Sharpens the grid sweep: fit logistic regression to predict needed(u,t) from the
 * 4 signals — CALIBRATED coefficients ARE the mixing rates, interpretable and
 * portable (no black box). Validated ACROSS SESSIONS (train one, test the other),
 * because turns within a session are correlated — the honest split is by session.
 * Tests whether an interaction (priority×dormancy: "kept because it mattered even
 * though dormant") lifts held-out AUC over the linear mix.
 *
 * Ground truth is fingerprint overlap (observational proxy) — this refines the
 * mixing on that proxy; the causal test is the live coding harness.
 *
 * RERUN: node experiments/assembler-weighting/lr-refinement.mjs
 */
import { buildTurnData, PARAMS } from './lib.mjs';
import { writeResults, gitSha, nowISO } from '../rung-1-live-probe/lib.mjs';

const SEED = 7; const mul = (a) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const rng = mul(SEED);
const CAP = 30000, ITERS = 700, LR = 0.4, L2 = 1.0;
const LIN = ['rec', 'rel', 'prio', 'refrec'];

function samples(n, withInteractions) {
  const { perTurn } = buildTurnData(n);
  const rows = [];
  for (const { raw } of perTurn) for (const x of raw) {
    const f = [1, x.rec, x.relN, x.prioN, x.refrec];
    if (withInteractions) f.push(x.prioN * (1 - x.refrec), x.relN * x.refrec, x.prioN * x.relN); // prio×dormancy, rel×refrec, prio×rel
    rows.push({ f, y: x.neededH ? 1 : 0 });
  }
  // subsample (seeded) to keep GD snappy
  for (let i = rows.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [rows[i], rows[j]] = [rows[j], rows[i]]; }
  return rows.slice(0, CAP);
}
function fit(rows) {
  const d = rows[0].f.length; let w = new Array(d).fill(0);
  for (let it = 0; it < ITERS; it++) {
    const g = new Array(d).fill(0);
    for (const { f, y } of rows) { let z = 0; for (let j = 0; j < d; j++) z += w[j] * f[j]; const p = 1 / (1 + Math.exp(-z)); const e = p - y; for (let j = 0; j < d; j++) g[j] += e * f[j]; }
    for (let j = 0; j < d; j++) w[j] -= LR * (g[j] / rows.length + (j > 0 ? L2 * w[j] / rows.length : 0));
  }
  return w;
}
function auc(rows, w) {
  const scored = rows.map(({ f, y }) => { let z = 0; for (let j = 0; j < w.length; j++) z += w[j] * f[j]; return [z, y]; }).sort((a, b) => a[0] - b[0]);
  let pos = 0, rankSum = 0; const N = scored.length;
  for (let i = 0; i < N; i++) if (scored[i][1] === 1) { rankSum += i + 1; pos++; }
  const neg = N - pos; if (!pos || !neg) return null;
  return +(((rankSum - pos * (pos + 1) / 2) / (pos * neg))).toFixed(4);
}
const baseRate = (rows) => +(rows.filter((r) => r.y === 1).length / rows.length).toFixed(4);

function main() {
  const out = { linear: {}, interactions: {} };
  for (const mode of ['linear', 'interactions']) {
    const wi = mode === 'interactions';
    const s1 = samples('1', wi), s2 = samples('2', wi);
    const w12 = fit(s1), w21 = fit(s2);      // train s1 / train s2
    const wAll = fit([...s1, ...s2]);
    out[mode] = {
      base_rate: { s1: baseRate(s1), s2: baseRate(s2) },
      test_auc: { train_s1_test_s2: auc(s2, w12), train_s2_test_s1: auc(s1, w21) },
      train_auc: { s1: auc(s1, w12), s2: auc(s2, w21) },
      coefficients_pooled: Object.fromEntries((wi ? [...LIN, 'prio×dormancy', 'rel×refrec', 'prio×rel'] : LIN).map((name, i) => [name, +wAll[i + 1].toFixed(3)])),
      bias_pooled: +wAll[0].toFixed(3),
    };
  }
  const lift = {
    train_s1_test_s2: +((out.interactions.test_auc.train_s1_test_s2 ?? 0) - (out.linear.test_auc.train_s1_test_s2 ?? 0)).toFixed(4),
    train_s2_test_s1: +((out.interactions.test_auc.train_s2_test_s1 ?? 0) - (out.linear.test_auc.train_s2_test_s1 ?? 0)).toFixed(4),
  };
  const interactions_help = lift.train_s1_test_s2 >= 0.01 && lift.train_s2_test_s1 >= 0.01;

  const result = {
    manifest: {
      run_id: `lr-refinement-${Date.now()}`, experiment: 'assembler-weighting / LR refinement',
      corpus: 'claude-code-session(-2).jsonl', validation: 'cross-session (train one, test the other)',
      params: { ...PARAMS, CAP, ITERS, LR, L2, SEED }, ground_truth: 'needed = fingerprint overlap within H (observational proxy)',
      commit: gitSha(), date: nowISO(),
      caveats: ['Proxy label (fingerprint overlap), not causal.', 'Two sessions → one cross-session fold each way.', 'Coefficients on per-turn min-max-normalized signals (comparable magnitudes).'],
    },
    ...out, interaction_auc_lift: lift, interactions_help,
  };
  const path = writeResults('assembler-weighting', 'results-lr-refinement.json', result);

  console.error('=== LR REFINEMENT (cross-session) ===');
  for (const mode of ['linear', 'interactions']) {
    const m = out[mode];
    console.error(`\n[${mode}] base-rate s1=${m.base_rate.s1} s2=${m.base_rate.s2}`);
    console.error(`  test AUC: train_s1→test_s2=${m.test_auc.train_s1_test_s2}  train_s2→test_s1=${m.test_auc.train_s2_test_s1}`);
    console.error(`  pooled coefficients (mixing rates): ${JSON.stringify(m.coefficients_pooled)}`);
  }
  console.error(`\ninteraction AUC lift over linear: ${JSON.stringify(lift)} → interactions help: ${interactions_help}`);
  console.error(`written: ${path}`);
}
main();
