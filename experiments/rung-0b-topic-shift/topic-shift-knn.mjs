/**
 * ============================================================================
 * EXPERIMENT: Rung 0b — kNN drift as a third classifier signal
 * ============================================================================
 *
 * Source plan: reports/hypothesis-test-ladder.md, Rung 0 item 0b.
 * Results: reports/metrics/rung-0b-topic-shift/results-knn.json
 * Companions: topic-shift.mjs (lexical), -embedding.mjs (drift), -merged.mjs (2-way).
 *
 * SCOPE: the CLASSIFICATION layer only — a third per-turn shift signal and how it
 * compares/merges with the other two. Nothing about eviction or the assembler.
 *
 * kNN-DRIFT (the operator's candidate). Distinct from centroid embedding-drift:
 * embedding-drift compares the MEAN embedding of the before/after windows (blurs a
 * mixed window); kNN-drift matches each AFTER-boundary turn to its NEAREST recent
 * turn and averages that similarity — sharper, robust to a window holding two
 * topics. knnSim[t] = mean_{a in [t,t+n)} max_{b in [t-n,t)} cos(a,b); drop = 1−sim.
 *
 * QUESTIONS
 * ---------
 *  (1) Is kNN just embedding-drift by another name? — measured by boundary agreement.
 *  (2) Does adding kNN to the merge improve ROBUSTNESS? — merged3 (lex+emb+knn) vs
 *      merged2 (lex+emb) vs each single, on the label-free segmentation objective
 *      (intra−cross similarity, scored in BOTH lexical and semantic space, matched K).
 *
 * CAVEAT: one session, directional; segmentation quality is a proxy (no shift labels).
 * RERUN: node topic-shift-knn.mjs   (needs @context-tree/core built + MiniLM)
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
const N = 3;
const KS = [20, 40, 60];

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
function cos(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
function jac(a, b) { if (a.size === 0 && b.size === 0) return 1; let inter = 0; for (const x of a) if (b.has(x)) inter++; return inter / (a.size + b.size - inter || 1); }
function unionFp(fps, a, b) { const u = new Set(); for (let i = a; i < b; i++) for (const x of fps[i]) u.add(x); return u; }
function meanVec(vecs, a, b) { const m = new Float64Array(vecs[0].length); for (let i = a; i < b; i++) for (let d = 0; d < m.length; d++) m[d] += vecs[i][d]; for (let d = 0; d < m.length; d++) m[d] /= (b - a); return m; }
const range = (a, b) => { const r = []; for (let i = a; i < b; i++) r.push(i); return r; };
function quality(segments, sim) {
  let iN = 0, iD = 0; for (const s of segments) for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) { iN += sim(s[i], s[j]); iD++; }
  let cN = 0, cD = 0; for (let s = 0; s + 1 < segments.length; s++) for (const a of segments[s]) for (const b of segments[s + 1]) { cN += sim(a, b); cD++; }
  return +(((iD ? iN / iD : 0) - (cD ? cN / cD : 0))).toFixed(4);
}
function segmentsFrom(bnds, T) { const cuts = [...new Set(bnds)].sort((a, b) => a - b); const segs = []; let st = 0; for (const c of cuts) { if (c > st) segs.push(range(st, c)); st = c; } if (st < T) segs.push(range(st, T)); return segs; }

async function main() {
  const turns = loadTurns();
  const fps = turns.map((t) => t.fp);
  const embed = await makeEmbedder();
  const vecs = []; for (const t of turns) vecs.push(await embed(t.text));
  const T = turns.length;

  const ts = [], lexDrop = [], semDrop = [], knnDrop = [];
  for (let t = N; t <= T - N; t++) {
    ts.push(t);
    lexDrop.push(1 - jac(unionFp(fps, t - N, t), unionFp(fps, t, t + N)));
    semDrop.push(1 - cos(meanVec(vecs, t - N, t), meanVec(vecs, t, t + N)));
    // kNN: each after-turn to its nearest recent (before-window) turn
    let acc = 0; for (let a = t; a < t + N; a++) { let best = -1; for (let b = t - N; b < t; b++) { const s = cos(vecs[a], vecs[b]); if (s > best) best = s; } acc += best; }
    knnDrop.push(1 - acc / N);
  }
  const zl = z(lexDrop), zs = z(semDrop), zk = z(knnDrop);
  const detectors = {
    lexical: lexDrop, embedding: semDrop, knn: knnDrop,
    merged2: zl.map((v, i) => v + zs[i]),
    merged3: zl.map((v, i) => v + zs[i] + zk[i]),
  };
  const simLex = (a, b) => jac(fps[a], fps[b]);
  const simSem = (a, b) => cos(vecs[a], vecs[b]);
  const topBoundaries = (drop, K) => drop.map((v, i) => [i, v]).sort((a, b) => b[1] - a[1]).slice(0, K).map(([i]) => ts[i]);

  // (2) robustness table
  const results = {};
  for (const K of KS) {
    results[K] = {};
    for (const [name, drop] of Object.entries(detectors)) {
      const segs = segmentsFrom(topBoundaries(drop, K), T);
      results[K][name] = { lexicalSpace: quality(segs, simLex), semanticSpace: quality(segs, simSem) };
    }
  }
  // (1) agreement at K=40: kNN vs embedding vs lexical (Jaccard of flagged sets)
  const K = 40; const flagged = Object.fromEntries(Object.entries(detectors).map(([n, d]) => [n, new Set(topBoundaries(d, K))]));
  const setJac = (A, B) => { let i = 0; for (const x of A) if (B.has(x)) i++; return +(i / (A.size + B.size - i)).toFixed(3); };
  const agreement = {
    'knn~embedding': setJac(flagged.knn, flagged.embedding),
    'knn~lexical': setJac(flagged.knn, flagged.lexical),
    'embedding~lexical': setJac(flagged.embedding, flagged.lexical),
    knnUniqueVsEmbedding: [...flagged.knn].filter((t) => !flagged.embedding.has(t)).length,
  };

  const out = {
    runId: process.env.RUN_ID ?? `rung-0b-knn-${new Date().toISOString().slice(0, 10)}`,
    armId: 'topic-shift-knn@v1', rung: '0b-knn', offline: true, model: 'Xenova/all-MiniLM-L6-v2',
    session: 'packages/cli/test/fixtures/claude-code-session.jsonl', commit: gitSha(), date: new Date().toISOString(),
    corpus: { toolTurns: T }, window: N, Ks: KS,
    knnDefinition: 'knnSim[t] = mean_{a in [t,t+n)} max_{b in [t-n,t)} cos(a,b); drop = 1 - sim',
    objective: 'segmentation quality (intra − cross) in both lexical and semantic space, matched K',
    caveat: 'One session; proxy objective (no labels). Classification layer only.',
    agreementK40: agreement, results,
  };
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'results-knn.json'), JSON.stringify(out, null, 2));

  console.log(`session: ${T} tool-turns | window n=${N}`);
  console.log(`\n(1) Is kNN just embedding-drift? boundary agreement (Jaccard of flagged sets, K=40):`);
  console.log(`    knn~embedding=${agreement['knn~embedding']}  knn~lexical=${agreement['knn~lexical']}  embedding~lexical=${agreement['embedding~lexical']}  | kNN-unique-vs-embedding=${agreement.knnUniqueVsEmbedding}/40`);
  console.log(`\n(2) segmentation quality (intra − cross); higher = crisper. worst-case = min across spaces:`);
  for (const K of KS) {
    console.log(`\nK=${K}:`);
    console.log('  detector'.padEnd(12) + 'lexical'.padStart(10) + 'semantic'.padStart(10) + 'worst'.padStart(9));
    for (const name of ['lexical', 'embedding', 'knn', 'merged2', 'merged3']) {
      const r = results[K][name]; const worst = Math.min(r.lexicalSpace, r.semanticSpace);
      console.log('  ' + name.padEnd(10) + `${r.lexicalSpace}`.padStart(10) + `${r.semanticSpace}`.padStart(10) + `${worst.toFixed(4)}`.padStart(9));
    }
  }
  console.log(`\nwrote ${join('reports', 'metrics', 'rung-0b-topic-shift', 'results-knn.json')}`);
}

main();
