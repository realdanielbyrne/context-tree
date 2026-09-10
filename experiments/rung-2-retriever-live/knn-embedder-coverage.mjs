/**
 * EXPERIMENT: does a DISTINCT kNN (different embedding model) improve coverage?
 *
 * kNN retrieval == dense cosine top-k. A second kNN over the SAME embeddings is
 * redundant (rung-0b: kNN-drift ≈ embedding-drift, not additive). The only way a
 * "third kNN method" adds coverage is a DIFFERENT embedder whose misses differ.
 * This is a RETRIEVAL question → answered OFFLINE, no model calls.
 *
 * Embedders (all local, Xenova ONNX, dim 384): MiniLM(all-MiniLM-L6-v2),
 *   bge-small-en-v1.5, gte-small. Corpus = packages/<pkg>/src chunks (rung-0e).
 * Per embedder: answer_present@k (gold answer regex in union of top-k chunk text)
 *   and gt_file@k (ground-truth file in top-k), on the shared 20-question set.
 * Coverage analysis: union across embedders, pairwise miss-overlap (does bge cover
 *   MiniLM's misses?), and RRF fusion of two embedders vs the best single.
 *
 * PRE-REGISTERED: a distinct kNN "improves coverage" IFF either
 *   (a) union(MiniLM,bge) answer_present@5 > best single by >=1 question, OR
 *   (b) RRF(MiniLM,bge) > best single by >=1 question.
 * If both embedders miss the same queries (misses overlap), a second kNN is
 * redundant — report that as the null.
 *
 * RERUN: node experiments/rung-2-retriever-live/knn-embedder-coverage.mjs
 */
import { buildChunks, cosine, rrf, sourceFiles } from '../rung-0e-retrievers/lib.mjs';
import { writeResults, gitSha, nowISO } from '../rung-1-live-probe/lib.mjs';
import { QUESTIONS, gradeLive } from './questions.mjs';

const MODELS = { minilm: 'Xenova/all-MiniLM-L6-v2', bge: 'Xenova/bge-small-en-v1.5', gte: 'Xenova/gte-small' };
const KS = [1, 3, 5];
const KMAX = 5;

async function makeEmbedder(modelId) {
  const t = await import('@xenova/transformers'); t.env.allowRemoteModels = true;
  const pipe = await t.pipeline('feature-extraction', modelId);
  const cache = new Map();
  return async (text) => { const h = cache.get(text); if (h) return h; const o = await pipe(text.slice(0, 2000), { pooling: 'mean', normalize: true }); const v = Float32Array.from(o.data); cache.set(text, v); return v; };
}
// ranked chunk ids for one query under one embedder
async function rankChunks(embed, chunks, chunkEmb, query) {
  const qe = await embed(query);
  return chunks.map((c, i) => [c.id, cosine(qe, chunkEmb[i])]).sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

async function main() {
  const chunks = await buildChunks();
  const byId = new Map(chunks.map((c) => [c.id, c]));
  console.error(`corpus: ${sourceFiles().length} files → ${chunks.length} chunks | embedders: ${Object.keys(MODELS).join(', ')}`);

  // embed corpus + rank every question under every embedder
  const ranked = {}; // model -> qid -> [chunkId...]
  for (const [name, id] of Object.entries(MODELS)) {
    const embed = await makeEmbedder(id);
    const chunkEmb = []; for (const c of chunks) chunkEmb.push(await embed(c.text));
    ranked[name] = {};
    for (const q of QUESTIONS) ranked[name][q.id] = await rankChunks(embed, chunks, chunkEmb, q.q);
    console.error(`  embedded + ranked: ${name}`);
  }

  const present = (ids, q, k) => gradeLive(ids.slice(0, k).map((id) => byId.get(id).text).join('\n'), q.answer);
  const gtfile = (ids, q, k) => ids.slice(0, k).some((id) => byId.get(id).file === q.file);

  const names = Object.keys(MODELS);
  const perModel = {};
  for (const name of names) {
    perModel[name] = {};
    for (const k of KS) {
      const rows = QUESTIONS.map((q) => ({ id: q.id, stratum: q.stratum, present: present(ranked[name][q.id], q, k), gtfile: gtfile(ranked[name][q.id], q, k) }));
      perModel[name][`k${k}`] = { answer_present: +(rows.filter((r) => r.present).length / rows.length).toFixed(4), gt_file: +(rows.filter((r) => r.gtfile).length / rows.length).toFixed(4) };
    }
  }

  // coverage analysis at KMAX (answer_present)
  const covered = (name) => new Set(QUESTIONS.filter((q) => present(ranked[name][q.id], q, KMAX)).map((q) => q.id));
  const cov = Object.fromEntries(names.map((n) => [n, covered(n)]));
  const union2 = (a, b) => new Set([...cov[a], ...cov[b]]);
  const rrf2 = (a, b) => QUESTIONS.filter((q) => present(rrf([ranked[a][q.id], ranked[b][q.id]]), q, KMAX)).length;

  const best = names.map((n) => [n, cov[n].size]).sort((x, y) => y[1] - x[1])[0];
  const pairs = [['minilm', 'bge'], ['minilm', 'gte'], ['bge', 'gte']];
  const pairStats = pairs.map(([a, b]) => ({
    pair: `${a}+${b}`,
    single_a: cov[a].size, single_b: cov[b].size,
    union: union2(a, b).size,
    a_only: [...cov[a]].filter((x) => !cov[b].has(x)).length,
    b_only: [...cov[b]].filter((x) => !cov[a].has(x)).length,
    rrf: rrf2(a, b),
  }));
  const allUnion = new Set(names.flatMap((n) => [...cov[n]])).size;

  const bestUnionPair = [...pairStats].sort((x, y) => y.union - x.union)[0];
  const bestRrfPair = [...pairStats].sort((x, y) => y.rrf - x.rrf)[0];
  const improves_union = bestUnionPair.union >= best[1] + 1;
  const improves_rrf = bestRrfPair.rrf >= best[1] + 1;

  const out = {
    manifest: {
      run_id: `knn-coverage-${Date.now()}`, experiment: 'rung-2-retriever-live / knn-embedder-coverage',
      corpus: 'packages/<pkg>/src (code)', embedders: MODELS, k: KS, n: QUESTIONS.length,
      metric: 'answer_present@k (regex over union of top-k chunk text) + gt_file@k', offline: true,
      commit: gitSha(), date: nowISO(),
      falsification: '{union OR rrf}(two embedders) answer_present@5 >= best single + 1 question, else a distinct kNN is redundant',
      caveats: ['n=20, directional.', 'CODE corpus — transfer to transcript untested.', 'answer_present is a retrieval ceiling, not model accuracy.'],
    },
    per_model: perModel,
    best_single_answer_present_k5: { model: best[0], covered: best[1], of: QUESTIONS.length },
    pairwise: pairStats,
    all_three_union: allUnion,
    verdict: { improves_by_union: improves_union, improves_by_rrf: improves_rrf },
  };
  const path = writeResults('rung-2-retriever-live', 'results-knn-coverage.json', out);

  console.error('\n=== kNN EMBEDDER COVERAGE (answer_present@k / gt_file@k) ===');
  for (const n of names) console.error(`  ${n.padEnd(7)} ` + KS.map((k) => `k${k}: ${perModel[n][`k${k}`].answer_present}/${perModel[n][`k${k}`].gt_file}`).join('  '));
  console.error(`\n  best single (answer_present@5): ${best[0]} = ${best[1]}/${QUESTIONS.length}`);
  for (const p of pairStats) console.error(`  ${p.pair.padEnd(13)} union=${p.union} rrf=${p.rrf}  (a_only=${p.a_only} b_only=${p.b_only})`);
  console.error(`  all-three union: ${allUnion}/${QUESTIONS.length}`);
  console.error(`  VERDICT: distinct-kNN improves coverage?  union=${improves_union}  rrf=${improves_rrf}`);
  console.error(`  written: ${path}`);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
