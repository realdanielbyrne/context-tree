/**
 * ============================================================================
 * EXPERIMENT: Rung 0e Phase 2 — style-tailored retriever benchmark (repo corpus)
 * ============================================================================
 *
 * Source plan: reports/hypothesis-test-ladder.md, Rung 0 item 0e.
 * Results: reports/metrics/rung-0e-retrievers/results-repo-benchmark.json
 * Shared retriever/corpus code: ./lib.mjs
 *
 * Uses the context-tree repo as corpus and a question set stratified BY RETRIEVER
 * STYLE (structural/literal/semantic/fuzzy), each with a verified ground-truth
 * file, to reveal per-style strengths — the premise of interleaving/routing. Only
 * a code repo lets the STRUCTURAL retriever (graft, real CLI) compete.
 *
 * RETRIEVERS: graft (real CLI), bm25, grep, vector (MiniLM), fuzzy (trigram).
 * COMBINATION ARMS: best-single, rrf, interleave (round-robin), router-oracle.
 * JUDGE: ground-truth answer FILE appears in the top-k retrieved files.
 * HR2-INVARIANT: here graft is a retriever WE run and assemble; combination arms
 * preserve each source's own ranking and never re-score a source.
 *
 * CAVEATS: file-level judge (not span); 16 Qs, 4/stratum (directional); the
 * semantic stratum is lexically contaminated — see semantic-hardening.mjs.
 *
 * RERUN: node repo-benchmark.mjs   (needs real graft CLI on PATH + MiniLM model)
 * ============================================================================
 */
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  OUT_DIR, buildChunks, makeEmbedder, buildRankers, rrf, interleave, hit, files,
  gitSha, graftVersion, sourceFiles, CHUNK,
} from './lib.mjs';

const TOPK = [1, 3, 5];
const STRATA = ['structural', 'literal', 'semantic', 'fuzzy'];
const EXPECTED = { structural: 'graft', literal: 'grep', semantic: 'vector', fuzzy: 'fuzzy' };

// Ground-truth files verified before authoring (grep/graft over the repo).
const QUESTIONS = [
  { id: 'st1', stratum: 'structural', q: 'What functions call excerptAround?', file: 'packages/core/src/retrieve/retriever.ts' },
  { id: 'st2', stratum: 'structural', q: 'Which file parses edited blobs into minimal enclosing named spans using tree-sitter grammars?', file: 'packages/core/src/spans/extractor.ts' },
  { id: 'st3', stratum: 'structural', q: 'Where is the lexical index built and which function consumes it during search?', file: 'packages/core/src/retrieve/retriever.ts' },
  { id: 'st4', stratum: 'structural', q: 'How does the MCP context_search tool connect to the retriever and providers?', file: 'packages/mcp/src/tools/context-search.ts' },
  { id: 'li1', stratum: 'literal', q: 'What is the value of the constant RRF_K?', file: 'packages/core/src/retrieve/retriever.ts' },
  { id: 'li2', stratum: 'literal', q: 'What is the default excerptChars in the retrieval config?', file: 'packages/core/src/config.ts' },
  { id: 'li3', stratum: 'literal', q: 'What DEFAULT_TIMEOUT_MS does the graft provider use?', file: 'packages/core/src/providers/graft.ts' },
  { id: 'li4', stratum: 'literal', q: 'What are the default retrieval provider names in the config?', file: 'packages/core/src/config.ts' },
  { id: 'se1', stratum: 'semantic', q: 'Where is the logic that keeps a cached prompt prefix stable when earlier content changes?', file: 'packages/core/src/cache/prefix.ts' },
  { id: 'se2', stratum: 'semantic', q: 'Which component decides what to drop from history when the conversation moves to a new topic?', file: 'packages/core/src/attention/policy.ts' },
  { id: 'se3', stratum: 'semantic', q: 'Where is the raw linear event log divided into phases for summarization?', file: 'packages/core/src/segment/segment.ts' },
  { id: 'se4', stratum: 'semantic', q: 'How are branches ranked by term overlap when embedding vectors are unavailable?', file: 'packages/core/src/retrieve/lexical.ts' },
  { id: 'fz1', stratum: 'fuzzy', q: 'excrptAround', file: 'packages/core/src/retrieve/excerpt.ts' },
  { id: 'fz2', stratum: 'fuzzy', q: 'detctAttentionSignals', file: 'packages/core/src/attention/signals.ts' },
  { id: 'fz3', stratum: 'fuzzy', q: 'TreeSiterSpanExtractor', file: 'packages/core/src/spans/extractor.ts' },
  { id: 'fz4', stratum: 'fuzzy', q: 'buildTopicIndx', file: 'packages/core/src/attention/topic-index.ts' },
];

async function main() {
  const emb = await makeEmbedder();
  const chunks = await buildChunks();
  const rankers = await buildRankers(chunks, emb);
  const names = Object.keys(rankers);

  const perQ = [];
  for (const item of QUESTIONS) {
    const lists = {};
    for (const n of names) lists[n] = files(await rankers[n](item.q));
    perQ.push({ ...item, lists });
    process.stderr.write('.');
  }
  process.stderr.write('\n');

  const individual = {};
  for (const n of names) {
    individual[n] = { overall: {}, byStratum: {} };
    for (const k of TOPK) {
      individual[n].overall[k] = +(perQ.filter((x) => hit(x.lists[n], x.file, k)).length / perQ.length).toFixed(3);
      for (const s of STRATA) individual[n].byStratum[`${s}@${k}`] = perQ.filter((x) => x.stratum === s && hit(x.lists[n], x.file, k)).length;
    }
  }

  const combos = { rrf: {}, interleave: {}, 'router-oracle': {}, 'best-single': {} };
  for (const k of TOPK) {
    combos.rrf[k] = +(perQ.filter((x) => hit(rrf(Object.values(x.lists)), x.file, k)).length / perQ.length).toFixed(3);
    combos.interleave[k] = +(perQ.filter((x) => hit(interleave(Object.values(x.lists)), x.file, k)).length / perQ.length).toFixed(3);
    combos['router-oracle'][k] = +(perQ.filter((x) => hit(x.lists[EXPECTED[x.stratum]] ?? [], x.file, k)).length / perQ.length).toFixed(3);
    combos['best-single'][k] = Math.max(...names.map((n) => individual[n].overall[k]));
  }

  const out = {
    runId: process.env.RUN_ID ?? `rung-0e-repo-benchmark-${new Date().toISOString().slice(0, 10)}`,
    armId: 'style-tailored-repo-benchmark@v1', rung: '0e-phase2', offline: true,
    corpus: 'context-tree repo (each package src TypeScript)', graft: 'real CLI ' + graftVersion(),
    setup: { chunker: `RecursiveCharacterTextSplitter(${CHUNK.chunkSize}/${CHUNK.chunkOverlap})`, chunks: chunks.length, files: sourceFiles().length, topK: TOPK, embedModel: emb.ok ? 'Xenova/all-MiniLM-L6-v2' : null },
    judge: 'ground-truth answer FILE appears in top-k retrieved files',
    commit: gitSha(), date: new Date().toISOString(),
    questions: QUESTIONS.length, strata: STRATA, expectedWinner: EXPECTED,
    caveats: 'File-level judge (not span). 16 Qs, 4/stratum — directional. Semantic stratum lexically contaminated (see semantic-hardening.mjs).',
    vectorAvailable: emb.ok, vectorSkipReason: emb.ok ? null : emb.reason,
    individual, combos,
    perQuery: perQ.map((x) => ({ id: x.id, stratum: x.stratum, q: x.q, file: x.file, topFilePerRetriever: Object.fromEntries(names.map((n) => [n, x.lists[n].slice(0, 3)])) })),
  };
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'results-repo-benchmark.json'), JSON.stringify(out, null, 2));
  printSummary(out, names, STRATA, TOPK);
  console.log(`\nwrote ${join('reports', 'metrics', 'rung-0e-retrievers', 'results-repo-benchmark.json')}`);
}

function printSummary(out, names, STRATA, TOPK) {
  console.log(`corpus: ${out.setup.files} files → ${out.setup.chunks} chunks | graft ${out.graft}${out.vectorAvailable ? '' : ' | vector SKIPPED'}`);
  console.log(`\nfile-in-top-5 by retriever × stratum (count out of 4), and overall@5:`);
  console.log('retriever'.padEnd(9) + STRATA.map((s) => s.slice(0, 6).padStart(9)).join('') + '   overall@5');
  for (const n of names) console.log(n.padEnd(9) + STRATA.map((s) => String(out.individual[n].byStratum[`${s}@5`]).padStart(9)).join('') + `   ${(out.individual[n].overall[5] * 100).toFixed(0)}%`);
  console.log(`\ncombination arms overall (file-in-top-k):`);
  console.log('arm'.padEnd(15) + TOPK.map((k) => `@${k}`.padStart(8)).join(''));
  for (const [arm, byK] of Object.entries(out.combos)) console.log(arm.padEnd(15) + TOPK.map((k) => `${(byK[k] * 100).toFixed(0)}%`.padStart(8)).join(''));
}

main().catch((e) => { console.error(e); process.exit(1); });
