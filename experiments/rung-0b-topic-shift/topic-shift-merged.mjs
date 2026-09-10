/**
 * ============================================================================
 * EXPERIMENT: Rung 0b — MERGED topic-shift signal vs each alone
 * ============================================================================
 *
 * Source plan: reports/hypothesis-test-ladder.md, Rung 0 item 0b.
 * Results: reports/metrics/rung-0b-topic-shift/results-merged.json
 * Companions: topic-shift.mjs (lexical), topic-shift-embedding.mjs (semantic).
 *
 * WHY
 * ---
 * The lexical (fingerprint-Jaccard) and semantic (embedding-drift) detectors
 * catch DIFFERENT boundaries (34 shared, 30 lexical-only, 13 semantic-only at
 * n=3). We do not have to pick: merge them and test the merged signal against
 * each alone. Operator's thesis: the merged detector should be ROBUST — at least
 * as good as each single detector on that detector's own similarity, and better
 * on the other.
 *
 * THE PROBLEM AND THE OBJECTIVE
 * -----------------------------
 * "Merged beats both" needs an evaluation target, and we have NO shift labels. So
 * we use a label-free segmentation-quality objective: a good boundary set makes
 * turns WITHIN a segment coherent and turns ACROSS a boundary different.
 *   quality(space) = intra_segment_similarity − cross_boundary_similarity  (higher = crisper)
 * We score every detector in BOTH spaces — lexical Jaccard AND semantic cosine.
 * A single detector has home-field advantage on its own space; the merged
 * detector wins the operator's claim iff it is best/tied on BOTH spaces at once.
 *
 * FAIRNESS: each detector flags the SAME number of boundaries K (top-K by drop),
 * so quality differences are not a boundary-count artifact. K is swept.
 *
 * MERGE: z-normalise each drop signal per session, sum with equal weight
 * (mergedDrop = z(lexDrop) + z(semDrop)) — no tuned weight.
 *
 * CAVEAT: one session, directional. Segmentation quality is a PROXY objective;
 * the definitive "which detector is correct" still needs labels or a live
 * eviction outcome. What this settles: is the merged signal robust across both
 * notions of similarity, where each single signal is not?
 * RERUN: node topic-shift-merged.mjs   (needs @context-tree/core built + MiniLM)
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
const N = 3;                 // window
const KS = [20, 40, 60];     // number of boundaries flagged (matched across detectors)

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
    if (fp.size === 0) continue;
    turns.push({ text, fp });
  }
  return turns;
}

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / (xs.length || 1);
const sd = (xs, m = mean(xs)) => Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length || 1));
const z = (xs) => { const m = mean(xs), s = sd(xs, m) || 1; return xs.map((x) => (x - m) / s); };
function cos(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; } // vecs are normalised
function jac(a, b) { if (a.size === 0 && b.size === 0) return 1; let inter = 0; for (const x of a) if (b.has(x)) inter++; return inter / (a.size + b.size - inter || 1); }
function unionFp(fps, a, b) { const u = new Set(); for (let i = a; i < b; i++) for (const x of fps[i]) u.add(x); return u; }
function meanVec(vecs, idx) { const m = new Float64Array(vecs[0].length); for (const i of idx) for (let d = 0; d < m.length; d++) m[d] += vecs[i][d]; for (let d = 0; d < m.length; d++) m[d] /= idx.length; return m; }

// segmentation quality in a given similarity space: intra − cross
function quality(segments, simPair) {
  let intraNum = 0, intraDen = 0;
  for (const seg of segments) {
    for (let i = 0; i < seg.length; i++) for (let j = i + 1; j < seg.length; j++) { intraNum += simPair(seg[i], seg[j]); intraDen++; }
  }
  let crossNum = 0, crossDen = 0;
  for (let s = 0; s + 1 < segments.length; s++) {
    for (const a of segments[s]) for (const b of segments[s + 1]) { crossNum += simPair(a, b); crossDen++; }
  }
  const intra = intraDen ? intraNum / intraDen : 0;
  const cross = crossDen ? crossNum / crossDen : 0;
  return { intra: +intra.toFixed(4), cross: +cross.toFixed(4), quality: +(intra - cross).toFixed(4) };
}
function segmentsFrom(boundaries, T) {
  const cuts = [...new Set(boundaries)].sort((a, b) => a - b);
  const segs = []; let start = 0;
  for (const c of cuts) { if (c > start) segs.push(range(start, c)); start = c; }
  if (start < T) segs.push(range(start, T));
  return segs;
}
const range = (a, b) => { const r = []; for (let i = a; i < b; i++) r.push(i); return r; };

async function main() {
  const turns = loadTurns();
  const fps = turns.map((t) => t.fp);
  const embed = await makeEmbedder();
  const vecs = []; for (const t of turns) vecs.push(await embed(t.text));
  const T = turns.length;

  // Per-boundary drop signals (higher = more shift), for t in [N, T-N].
  const ts = []; const lexDrop = []; const semDrop = [];
  for (let t = N; t <= T - N; t++) {
    ts.push(t);
    lexDrop.push(1 - jac(unionFp(fps, t - N, t), unionFp(fps, t, t + N)));
    semDrop.push(1 - cos(meanVec(vecs, range(t - N, t)), meanVec(vecs, range(t, t + N))));
  }
  const zl = z(lexDrop), zs = z(semDrop);
  const merged = zl.map((v, i) => v + zs[i]);

  const detectors = { lexical: lexDrop, embedding: semDrop, merged };
  const simSem = (a, b) => cos(vecs[a], vecs[b]);
  const simLex = (a, b) => jac(fps[a], fps[b]);

  const results = {};
  for (const K of KS) {
    results[K] = {};
    for (const [name, drop] of Object.entries(detectors)) {
      const topIdx = drop.map((v, i) => [i, v]).sort((a, b) => b[1] - a[1]).slice(0, K).map(([i]) => ts[i]);
      const segs = segmentsFrom(topIdx, T);
      results[K][name] = { boundaries: K, segments: segs.length,
        lexicalSpace: quality(segs, simLex), semanticSpace: quality(segs, simSem) };
    }
  }

  const out = {
    runId: process.env.RUN_ID ?? `rung-0b-merged-${new Date().toISOString().slice(0, 10)}`,
    armId: 'topic-shift-merged@v1', rung: '0b-merged', offline: true, model: 'Xenova/all-MiniLM-L6-v2',
    session: 'packages/cli/test/fixtures/claude-code-session.jsonl', commit: gitSha(), date: new Date().toISOString(),
    corpus: { toolTurns: T }, window: N, Ks: KS,
    merge: 'mergedDrop = z(lexicalDrop) + z(semanticDrop), equal weight',
    objective: 'segmentation quality = intra_segment_similarity − cross_boundary_similarity, scored in BOTH lexical(Jaccard) and semantic(cosine) space; higher is crisper; boundary count K matched across detectors',
    caveat: 'One session; segmentation quality is a proxy objective (no shift labels). The claim tested: is the merged signal robust across BOTH spaces where each single signal wins only its own?',
    results,
  };
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'results-merged.json'), JSON.stringify(out, null, 2));

  console.log(`session: ${T} tool-turns | window n=${N} | merge = z(lex)+z(sem)`);
  console.log(`\nsegmentation quality (intra − cross); higher = crisper. Two spaces, matched boundary count K.`);
  for (const K of KS) {
    console.log(`\nK=${K} boundaries:`);
    console.log('  detector'.padEnd(12) + 'lexical-space'.padStart(15) + 'semantic-space'.padStart(16));
    for (const name of ['lexical', 'embedding', 'merged']) {
      const r = results[K][name];
      console.log('  ' + name.padEnd(10) + `${r.lexicalSpace.quality}`.padStart(15) + `${r.semanticSpace.quality}`.padStart(16));
    }
  }
  // Verdict: does merged win/tie on BOTH spaces at every K?
  const wins = KS.every((K) => {
    const m = results[K].merged, l = results[K].lexical, e = results[K].embedding;
    return m.lexicalSpace.quality >= Math.max(l.lexicalSpace.quality, e.lexicalSpace.quality) - 1e-9 &&
           m.semanticSpace.quality >= Math.max(l.semanticSpace.quality, e.semanticSpace.quality) - 1e-9;
  });
  console.log(`\nmerged dominates BOTH spaces at every K: ${wins ? 'YES' : 'NO (see per-K rows)'}`);
  console.log(`\nwrote ${join('reports', 'metrics', 'rung-0b-topic-shift', 'results-merged.json')}`);
}

main();
