/**
 * ============================================================================
 * EXPERIMENT: Rung 0b (non-deterministic) — embedding-drift topic-shift
 * ============================================================================
 *
 * Source plan: reports/hypothesis-test-ladder.md, Rung 0 item 0b.
 * Results: reports/metrics/rung-0b-topic-shift/results-embedding.json
 * Companion (deterministic, lexical): ./topic-shift.mjs
 *
 * WHY
 * ---
 * The deterministic 0b measures topic shift by fingerprint-Jaccard (LEXICAL): a
 * boundary is a shift when the tool inputs before and after share few file
 * paths/identifiers. That misses a CONCEPTUAL pivot that reuses no identifiers.
 * This non-deterministic version replaces Jaccard with SEMANTIC drift: cosine
 * similarity between the MEAN EMBEDDING (MiniLM) of the n turns before and after
 * a boundary. Still UNSUPERVISED — no labels — so it needs no fine-tuning and
 * stays within v1's "prompt/model-driven, no trained head" constraint. (A
 * supervised FFN/probe would need labels we don't have AND a trained head v1
 * forbids; this is the label-free counterpart.)
 *
 * VALIDATION: identical to the lexical run — within-session permutation null,
 * effect size in σ, and the SAME falsification. Plus the new question this run
 * exists to answer: does semantic drift flag boundaries the lexical detector
 * MISSES (and vice-versa)?
 *
 * NOTE ON THE PRE-REGISTERED CONDITION: the lexical run showed the permutation
 * metric was sign-mis-specified (real sessions cluster, so the null has MORE
 * low-overlap boundaries). We report the same statistics here for comparability
 * and read the clustering tail the same corrected way — labelled as such, not
 * renegotiated to force a pass.
 *
 * CAVEAT: one session, directional. Embeds tool-input text (name + JSON args).
 * RERUN: node topic-shift-embedding.mjs   (needs @context-tree/core built + MiniLM)
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

async function makeEmbedder() {
  const t = await import('@xenova/transformers');
  t.env.allowRemoteModels = true;
  const pipe = await t.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  return async (text) => { const o = await pipe(text.slice(0, 2000), { pooling: 'mean', normalize: true }); return Float32Array.from(o.data); };
}

function loadTurns() {
  const turns = [];
  for (const ln of readFileSync(SESSION, 'utf8').trim().split('\n')) {
    let d; try { d = JSON.parse(ln); } catch { continue; }
    if (d.type !== 'assistant') continue;
    const content = d.message?.content; if (!Array.isArray(content)) continue;
    const uses = content.filter((c) => c?.type === 'tool_use');
    if (uses.length === 0) continue;
    const text = uses.map((c) => `${c.name} ${JSON.stringify(c.input)}`).join(' ');
    const fp = extractFingerprints(text);
    if (fp.size === 0) continue; // keep the SAME turn set as the lexical run for comparability
    turns.push({ text, tools: uses.map((c) => c.name).join(','), files: [...fp].filter((t) => t.includes('/')).slice(0, 2) });
  }
  return turns;
}

function meanVec(vecs, a, b) {
  const dim = vecs[0].length; const m = new Float64Array(dim);
  for (let i = a; i < b; i++) for (let d = 0; d < dim; d++) m[d] += vecs[i][d];
  const c = b - a; for (let d = 0; d < dim; d++) m[d] /= c;
  return m;
}
function cos(a, b) { let s = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return s / (Math.sqrt(na * nb) || 1); }
function crossSims(vecs, n) {
  const out = [];
  for (let t = n; t <= vecs.length - n; t++) out.push({ t, sim: cos(meanVec(vecs, t - n, t), meanVec(vecs, t, t + n)) });
  return out;
}
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / (xs.length || 1);
const sd = (xs, m = mean(xs)) => Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length || 1));
function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function shuffled(arr, rand) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

function analyze(vecs, n, rand) {
  const cs = crossSims(vecs, n);
  const vals = cs.map((c) => c.sim);
  const mu = mean(vals); const sigma = sd(vals, mu);
  const threshold = mu - 0.5 * sigma; // LOW similarity = shift
  const flagged = cs.filter((c, i) => c.sim <= threshold && (i === 0 || cs[i - 1].sim >= c.sim) && (i === cs.length - 1 || cs[i + 1].sim >= c.sim));
  const effectSigma = sigma > 0 ? (mu - mean(flagged.map((c) => c.sim))) / sigma : 0;
  const realBelow = vals.filter((v) => v <= threshold).length;
  const nullCounts = [];
  for (let p = 0; p < N_PERM; p++) {
    const s = shuffled(vecs, rand);
    nullCounts.push(crossSims(s, n).filter((c) => c.sim <= threshold).length);
  }
  const nullMean = mean(nullCounts); const nullSd = sd(nullCounts, nullMean);
  return {
    n, boundaries: cs.length, mu: +mu.toFixed(4), sigma: +sigma.toFixed(4),
    flaggedCount: flagged.length, effectSigma: +effectSigma.toFixed(3),
    realBelowThreshold: realBelow, nullMeanBelow: +nullMean.toFixed(2),
    permZ: +((realBelow - nullMean) / (nullSd || 1)).toFixed(2),
    flaggedT: new Set(flagged.map((c) => c.t)),
    topFlagged: flagged.sort((a, b) => a.sim - b.sim).slice(0, 8).map((c) => ({ t: c.t, sim: +c.sim.toFixed(3) })),
  };
}

// Recompute the LEXICAL flagged set (fingerprint-Jaccard) to compare which boundaries each catches.
function lexicalFlagged(turns, n) {
  const fp = turns.map((t) => extractFingerprints(t.text));
  const uni = (a, b) => { const u = new Set(); for (let i = a; i < b; i++) for (const x of fp[i]) u.add(x); return u; };
  const jac = (a, b) => { if (a.size === 0 && b.size === 0) return 1; let inter = 0; for (const x of a) if (b.has(x)) inter++; return inter / (a.size + b.size - inter || 1); };
  const co = []; for (let t = n; t <= fp.length - n; t++) co.push({ t, o: jac(uni(t - n, t), uni(t, t + n)) });
  const vals = co.map((c) => c.o); const mu = mean(vals); const thr = mu - 0.5 * sd(vals, mu);
  return new Set(co.filter((c, i) => c.o <= thr && (i === 0 || co[i - 1].o >= c.o) && (i === co.length - 1 || co[i + 1].o >= c.o)).map((c) => c.t));
}

async function main() {
  const turns = loadTurns();
  const embed = await makeEmbedder();
  const vecs = []; for (const t of turns) vecs.push(await embed(t.text));
  const rand = rng(SEED);
  const perWindow = WINDOWS.map((n) => analyze(vecs, n, rand));

  // Agreement with the lexical detector at n=3.
  const n = 3;
  const semSet = perWindow.find((r) => r.n === n).flaggedT;
  const lexSet = lexicalFlagged(turns, n);
  const both = [...semSet].filter((t) => lexSet.has(t));
  const semOnly = [...semSet].filter((t) => !lexSet.has(t));
  const lexOnly = [...lexSet].filter((t) => !semSet.has(t));
  const ctx = (t) => turns.slice(Math.max(0, t - 1), t + 1).map((x) => `${x.tools}${x.files.length ? ' ' + x.files.map((f) => f.split('/').pop()).join(',') : ''}`).join(' → ');

  const out = {
    runId: process.env.RUN_ID ?? `rung-0b-embedding-${new Date().toISOString().slice(0, 10)}`,
    armId: 'topic-shift-embedding@v1', rung: '0b-nondeterministic', offline: true, model: 'Xenova/all-MiniLM-L6-v2',
    session: 'packages/cli/test/fixtures/claude-code-session.jsonl',
    commit: gitSha(), date: new Date().toISOString(),
    corpus: { toolTurnsWithFingerprints: turns.length }, permutations: N_PERM, seed: SEED,
    perWindow: perWindow.map(({ flaggedT, ...r }) => r),
    agreementN3: { semanticFlagged: semSet.size, lexicalFlagged: lexSet.size, both: both.length, semanticOnly: semOnly.length, lexicalOnly: lexOnly.length,
      semanticOnlyExamples: semOnly.slice(0, 5).map((t) => ({ t, ctx: ctx(t) })),
      lexicalOnlyExamples: lexOnly.slice(0, 5).map((t) => ({ t, ctx: ctx(t) })) },
  };
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'results-embedding.json'), JSON.stringify(out, null, 2));

  console.log(`session: ${turns.length} tool-turns | embedding: MiniLM | permutation null: ${N_PERM} shuffles`);
  console.log('\nwindow  boundaries  baseline μ±σ    flagged  effect(σ)  real<thr  null<thr   permZ');
  for (const r of out.perWindow) console.log(`n=${r.n}       ${String(r.boundaries).padStart(4)}      ${r.mu.toFixed(3)}±${r.sigma.toFixed(3)}   ${String(r.flaggedCount).padStart(5)}    ${r.effectSigma.toFixed(2).padStart(6)}   ${String(r.realBelowThreshold).padStart(6)}   ${r.nullMeanBelow.toFixed(1).padStart(6)}   ${r.permZ.toFixed(1).padStart(5)}`);
  const a = out.agreementN3;
  console.log(`\nsemantic vs lexical flagged (n=3): both=${a.both}, semantic-only=${a.semanticOnly}, lexical-only=${a.lexicalOnly}`);
  console.log('semantic-ONLY boundaries (drift a lexical detector missed):');
  for (const e of a.semanticOnlyExamples) console.log(`  t=${e.t}: ${e.ctx}`);
  console.log(`\nwrote ${join('reports', 'metrics', 'rung-0b-topic-shift', 'results-embedding.json')}`);
}

main();
