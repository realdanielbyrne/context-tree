/**
 * Achieved-peak logistic regression shared by report-cadence-confound and
 * report-window-metric, so both quote the same fitted numbers from the same
 * pinned batches.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// PINNED, not globbed: a new batch must be added here deliberately.
export const CADENCE_FILES = ['results-ab-longbuild-cadence10.json', 'results-ab-longbuild-cadence2.json',
  'results-ab-longbuild-cadence5.json', 'results-ab-longbuild-v2-n3.json',
  'results-ab-longbuild-v2.json', 'results-ab-longbuild-winwA.json',
  'results-ab-longbuild-winwB.json'];

export function loadCappedCells(dir, files = CADENCE_FILES) {
  const present = new Set(readdirSync(dir));
  const missing = files.filter((f) => !present.has(f));
  if (missing.length) throw new Error(`missing result files: ${missing.join(', ')}`);
  const cells = [];
  for (const f of files) {
    const d = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const cadence = d.manifest.cadence ?? 1;
    for (const c of d.cells) {
      if (c.window === null) continue;
      cells.push({ file: f, cadence, W: c.window, arm: c.arm, pass: !!c.pass,
        peak: c.peak_history_tokens, evictions: c.evictions, tokens: c.total_prompt_tokens });
    }
  }
  return cells;
}

/** Newton-Raphson logistic fit. X columns include an intercept. */
export function logit(X, y, iters = 60) {
  const n = X.length, p = X[0].length;
  let b = new Array(p).fill(0);
  for (let it = 0; it < iters; it++) {
    const g = new Array(p).fill(0);
    const H = Array.from({ length: p }, () => new Array(p).fill(0));
    for (let i = 0; i < n; i++) {
      let z = 0; for (let j = 0; j < p; j++) z += X[i][j] * b[j];
      const mu = 1 / (1 + Math.exp(-z)), w = Math.max(mu * (1 - mu), 1e-9);
      for (let j = 0; j < p; j++) {
        g[j] += X[i][j] * (y[i] - mu);
        for (let k = 0; k < p; k++) H[j][k] += X[i][j] * X[i][k] * w;
      }
    }
    const A = H.map((r, i) => [...r, g[i]]);
    for (let c = 0; c < p; c++) {
      let piv = c; for (let r = c + 1; r < p; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      [A[c], A[piv]] = [A[piv], A[c]];
      if (Math.abs(A[c][c]) < 1e-12) return { b, llf: -Infinity };
      for (let r = 0; r < p; r++) {
        if (r === c) continue;
        const f = A[r][c] / A[c][c];
        for (let k = c; k <= p; k++) A[r][k] -= f * A[c][k];
      }
    }
    let maxStep = 0;
    for (let j = 0; j < p; j++) { const d = A[j][p] / A[j][j]; b[j] += d; maxStep = Math.max(maxStep, Math.abs(d)); }
    if (maxStep < 1e-10) break;
  }
  let llf = 0;
  for (let i = 0; i < X.length; i++) {
    let z = 0; for (let j = 0; j < X[0].length; j++) z += X[i][j] * b[j];
    const mu = Math.min(Math.max(1 / (1 + Math.exp(-z)), 1e-12), 1 - 1e-12);
    llf += y[i] ? Math.log(mu) : Math.log(1 - mu);
  }
  return { b, llf };
}

/** Upper tail of chi-square with 1 df via erfc (Abramowitz-Stegun 7.1.26). */
export function chi2sf1(x) {
  const z = Math.sqrt(Math.max(x, 0));
  const t = 1 / (1 + 0.3275911 * (z / Math.SQRT2));
  const u = z / Math.SQRT2;
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(u * u));
  return Math.min(1, Math.max(0, 1 - y));
}

/**
 * Likelihood-ratio tests on log(peak), log(cadence), log(W). ARM DUMMIES ARE
 * MANDATORY: the signal-free `random` arm appears only at cadence 1, so omitting
 * it inflates the peak odds ratio.
 */
export function peakRegression(cells) {
  const y = cells.map((c) => (c.pass ? 1 : 0));
  const lpeak = cells.map((c) => Math.log(c.peak));
  const lcad = cells.map((c) => Math.log(c.cadence));
  const lW = cells.map((c) => Math.log(c.W));
  const ARMS = [...new Set(cells.map((c) => c.arm))].sort();
  const armDummies = ARMS.slice(1).map((a) => cells.map((c) => (c.arm === a ? 1 : 0)));
  const fit = (cols) => logit(cells.map((_, i) => [1, ...cols.map((f) => f[i])]), y);
  const mPeak = fit([lpeak, ...armDummies]);
  const mPeakCad = fit([lpeak, ...armDummies, lcad]);
  const mPeakW = fit([lpeak, ...armDummies, lW]);
  const mCad = fit([lcad, ...armDummies]);
  const mCadPeak = fit([lcad, ...armDummies, lpeak]);
  const mPeakNoArm = fit([lpeak]);
  const lr = (a, b) => { const s = 2 * (b.llf - a.llf); return { stat: s, p: chi2sf1(s) }; };
  const separated = (m) => !Number.isFinite(m.llf) || Math.max(...m.b.map(Math.abs)) > 50 || m.llf > -1e-6;
  if (separated(mPeak)) throw new Error('logistic fit hit quasi-complete separation — odds ratio not estimable; refusing to render a number');
  return {
    tCad: lr(mPeak, mPeakCad), tW: lr(mPeak, mPeakW), tPeak: lr(mCad, mCadPeak),
    orPeak: Math.exp(mPeak.b[1]), orPeakUnadj: Math.exp(mPeakNoArm.b[1]),
  };
}
