/**
 * Small exact statistics, in their own module so a TEST CAN IMPORT THEM WITHOUT
 * IMPORTING AN EXPERIMENT. An adversarial review caught the alternative: when
 * `fisherOneSided` lived in `sensitivity-control.mjs`, running the documented
 * `node --test ballast.test.mjs` executed the module's `main()` and started a
 * 60-cell live GPU run that then overwrote the real results file.
 */

/** log(n!) by direct summation — exact enough for the cell counts used here. */
const lnFact = (n) => { let s = 0; for (let i = 2; i <= n; i++) s += Math.log(i); return s; };

/** Hypergeometric point probability of the table [[a,b],[c,d]]. */
const tableP = (a, b, c, d) => Math.exp(
  lnFact(a + b) + lnFact(c + d) + lnFact(a + c) + lnFact(b + d)
  - lnFact(a) - lnFact(b) - lnFact(c) - lnFact(d) - lnFact(a + b + c + d));

/**
 * One-sided Fisher exact test for TREATMENT > CONTROL.
 * Table is [[a, b], [c, d]] = [[treatment pass, treatment fail], [control pass, control fail]].
 * Sums the probability of the observed table and every more extreme one.
 */
export function fisherOneSided(a, b, c, d) {
  const n = a + b + c + d, r1 = a + b, c1 = a + c;
  let tot = 0;
  for (let k = a; k <= Math.min(r1, c1); k++) tot += tableP(k, r1 - k, c1 - k, n - r1 - c1 + k);
  return Math.min(1, tot);
}

/** Wilson 95% interval for k successes in n trials. */
export function wilson(k, n) {
  if (!n) return [0, 0];
  const z = 1.96, p = k / n, den = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/**
 * Smallest number of treatment successes that would reach `alpha` one-sided,
 * given `cPass` control successes out of `n` each. Returns null when no count
 * can reach significance — which is the honest answer about an underpowered
 * design, and is why this is computed BEFORE a run rather than after.
 */
export function minDetectable(n, cPass, alpha = 0.05) {
  for (let a = cPass; a <= n; a++) {
    if (fisherOneSided(a, n - a, cPass, n - cPass) < alpha) return a;
  }
  return null;
}
