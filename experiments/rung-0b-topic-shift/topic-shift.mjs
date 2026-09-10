/**
 * ============================================================================
 * EXPERIMENT: Rung 0b — topic-shift detector (deterministic, ZERO model calls)
 * ============================================================================
 *
 * Source plan: reports/hypothesis-test-ladder.md, Rung 0 item 0b (topic-shift half).
 * Results: reports/metrics/rung-0b-topic-shift/results.json
 *
 * CLAIM UNDER TEST (§14, HR3/H4 topic-shift half)
 * -----------------------------------------------
 * A topic shift is a turn whose content words share little with the previous n
 * turns, and this is detectable deterministically (no model) from tool-input
 * fingerprints. If real, it is a signal to release dormant history (eviction).
 *
 * MEASURE
 * -------
 * Per tool-turn t, fingerprints fp[t] = extractFingerprints(tool inputs).
 * cross-boundary overlap at t = Jaccard( ∪fp[t-n..t-1], ∪fp[t..t+n-1] ) — how much
 * the n turns before boundary t share with the n turns at/after it. A real topic
 * shift is a LOW-overlap boundary. Session baseline = mean μ, sd σ of cross-overlap
 * over all boundaries. The detector flags a local-minimum boundary with overlap
 * ≤ μ − 0.5σ.
 *
 * VALIDATION — within-session permutation null (the plan's requirement)
 * --------------------------------------------------------------------
 * Shuffle the turn ORDER M times (seeded) and recompute; this destroys real topic
 * structure while preserving the fingerprint multiset. If the real sequence has
 * far more below-threshold boundaries (and deeper ones) than the shuffled null,
 * real topic structure exists and the measure separates a shift from an arbitrary
 * boundary.
 *
 * FALSIFICATION (fixed before the run): the measure FAILS if the flagged
 * boundaries are NOT at least 0.5σ below the session baseline vs the permutation
 * null — i.e. real low-overlap boundaries look like what random shuffling produces
 * (permutation p ≥ 0.05, or effect < 0.5σ). PASSES otherwise.
 *
 * CAVEAT: one real Claude Code session (committed fixture). Fingerprints come from
 * tool INPUTS only (file paths, identifiers). Directional — one session.
 * RERUN: node topic-shift.mjs   (needs @context-tree/core built)
 * ============================================================================
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const OUT_DIR = join(REPO, 'reports', 'metrics', 'rung-0b-topic-shift');
const SESSION = join(REPO, 'packages', 'cli', 'test', 'fixtures', 'claude-code-session.jsonl');
const WINDOWS = [1, 3, 5];
const N_PERM = 2000;
const SEED = 12345;

const { extractFingerprints } = await import(join(REPO, 'packages', 'core', 'dist', 'retrieve', 'lexical.js'));
function gitSha() { try { return execSync('git rev-parse HEAD', { cwd: REPO }).toString().trim(); } catch { return null; } }

// ---- build per-turn fingerprint sets from the real session ----
function loadTurns() {
  const turns = [];
  for (const ln of readFileSync(SESSION, 'utf8').trim().split('\n')) {
    let d; try { d = JSON.parse(ln); } catch { continue; }
    if (d.type !== 'assistant') continue;
    const content = d.message?.content;
    if (!Array.isArray(content)) continue;
    const uses = content.filter((c) => c?.type === 'tool_use');
    if (uses.length === 0) continue;
    const fp = extractFingerprints(uses.map((c) => `${c.name} ${JSON.stringify(c.input)}`).join(' '));
    if (fp.size === 0) continue;
    turns.push({ tools: uses.map((c) => c.name).join(','), files: [...fp].filter((t) => t.includes('/')).slice(0, 2), fp });
  }
  return turns;
}

// ---- cross-boundary overlaps for a fingerprint sequence ----
function unionFp(seq, a, b) { const u = new Set(); for (let i = a; i < b; i++) for (const t of seq[i]) u.add(t); return u; }
function jaccard(a, b) { if (a.size === 0 && b.size === 0) return 1; let inter = 0; for (const t of a) if (b.has(t)) inter++; return inter / (a.size + b.size - inter || 1); }
function crossOverlaps(seq, n) {
  const out = [];
  for (let t = n; t <= seq.length - n; t++) out.push({ t, overlap: jaccard(unionFp(seq, t - n, t), unionFp(seq, t, t + n)) });
  return out;
}
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / (xs.length || 1);
const sd = (xs, m = mean(xs)) => Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length || 1));

// seeded RNG (mulberry32) for a reproducible permutation null
function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function shuffled(arr, rand) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

function analyze(seq, n, rand) {
  const co = crossOverlaps(seq, n);
  const vals = co.map((c) => c.overlap);
  const mu = mean(vals); const sigma = sd(vals, mu);
  const threshold = mu - 0.5 * sigma;
  // flagged = local-minimum boundaries at or below threshold
  const flagged = co.filter((c, i) => c.overlap <= threshold && (i === 0 || co[i - 1].overlap >= c.overlap) && (i === co.length - 1 || co[i + 1].overlap >= c.overlap));
  const flaggedMean = mean(flagged.map((c) => c.overlap));
  const effectSigma = sigma > 0 ? (mu - flaggedMean) / sigma : 0;

  // permutation null: how many below-threshold boundaries does a shuffled sequence produce?
  const nullCounts = [];
  for (let p = 0; p < N_PERM; p++) {
    const s = shuffled(seq, rand);
    const co2 = crossOverlaps(s, n).map((c) => c.overlap);
    nullCounts.push(co2.filter((v) => v <= threshold).length);
  }
  const nullMean = mean(nullCounts); const nullSd = sd(nullCounts, nullMean);
  const realBelow = vals.filter((v) => v <= threshold).length;
  const z = nullSd > 0 ? (realBelow - nullMean) / nullSd : 0;
  const pPerm = (nullCounts.filter((c) => c >= realBelow).length + 1) / (N_PERM + 1);

  return { n, boundaries: co.length, mu: +mu.toFixed(4), sigma: +sigma.toFixed(4), threshold: +threshold.toFixed(4),
    flaggedCount: flagged.length, flaggedMeanOverlap: +flaggedMean.toFixed(4), effectSigma: +effectSigma.toFixed(3),
    realBelowThreshold: realBelow, nullMeanBelow: +nullMean.toFixed(2), nullSd: +nullSd.toFixed(2),
    permZ: +z.toFixed(2), permP: +pPerm.toFixed(4),
    pass: effectSigma >= 0.5 && pPerm < 0.05,
    topFlagged: flagged.sort((a, b) => a.overlap - b.overlap).slice(0, 6).map((c) => ({ t: c.t, overlap: +c.overlap.toFixed(3) })) };
}

function main() {
  const turns = loadTurns();
  const seq = turns.map((t) => t.fp);
  const rand = rng(SEED);
  const perWindow = WINDOWS.map((n) => analyze(seq, n, rand));

  // Human-readable context for the primary window's flagged boundaries.
  const primary = perWindow.find((r) => r.n === 3) ?? perWindow[0];
  const flaggedContext = primary.topFlagged.map(({ t, overlap }) => ({
    t, overlap,
    before: turns.slice(Math.max(0, t - 2), t).map((x) => `${x.tools}${x.files.length ? ' ' + x.files.map((f) => f.split('/').pop()).join(',') : ''}`),
    after: turns.slice(t, t + 2).map((x) => `${x.tools}${x.files.length ? ' ' + x.files.map((f) => f.split('/').pop()).join(',') : ''}`),
  }));

  const out = {
    runId: process.env.RUN_ID ?? `rung-0b-topic-shift-${new Date().toISOString().slice(0, 10)}`,
    armId: 'topic-shift-detector@v1', rung: '0b', offline: true, model: null,
    session: 'packages/cli/test/fixtures/claude-code-session.jsonl',
    commit: gitSha(), date: new Date().toISOString(),
    corpus: { toolTurnsWithFingerprints: turns.length },
    permutations: N_PERM, seed: SEED,
    falsification: 'PASS if flagged boundaries are ≥0.5σ below baseline AND permutation p<0.05 (real low-overlap structure beyond chance)',
    perWindow, flaggedContext,
  };
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'results.json'), JSON.stringify(out, null, 2));

  console.log(`session: ${turns.length} tool-turns with fingerprints | permutation null: ${N_PERM} shuffles (seed ${SEED})`);
  console.log('\nwindow  boundaries  baseline μ±σ    flagged  effect(σ)  real<thr  null<thr   permZ  permP  verdict');
  for (const r of perWindow) {
    console.log(`n=${r.n}       ${String(r.boundaries).padStart(4)}      ${r.mu.toFixed(3)}±${r.sigma.toFixed(3)}   ${String(r.flaggedCount).padStart(5)}    ${r.effectSigma.toFixed(2).padStart(6)}   ${String(r.realBelowThreshold).padStart(6)}   ${r.nullMeanBelow.toFixed(1).padStart(6)}   ${r.permZ.toFixed(1).padStart(5)}  ${r.permP.toFixed(4)}  ${r.pass ? 'PASS' : 'FAIL'}`);
  }
  console.log(`\nExample flagged topic-shift boundaries (n=3), before → after:`);
  for (const c of flaggedContext) console.log(`  boundary t=${c.t} (overlap ${c.overlap}): [${c.before.join(' | ')}]  →  [${c.after.join(' | ')}]`);
  console.log(`\nwrote ${join('reports', 'metrics', 'rung-0b-topic-shift', 'results.json')}`);
}

main();
