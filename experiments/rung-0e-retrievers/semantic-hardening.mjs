/**
 * ============================================================================
 * EXPERIMENT: Rung 0e Phase 2b — hardened SEMANTIC stratum
 * ============================================================================
 *
 * Source plan: reports/hypothesis-test-ladder.md, Rung 0 item 0e.
 * Results: reports/metrics/rung-0e-retrievers/results-semantic-hardening.json
 * Shared retriever/corpus code: ./lib.mjs
 *
 * WHY
 * ---
 * In the repo benchmark the "semantic" stratum was lexically contaminated —
 * the questions reused words that appear in the target file (code AND comments),
 * so BM25/grep matched them and vector's advantage was never isolated. This run
 * replaces them with PARAPHRASE-PURE questions: each describes the file's
 * behaviour using vocabulary the file avoids.
 *
 * HARDNESS IS VERIFIED, NOT ASSUMED — and questions are NOT selected for vector wins.
 * For every question we report `overlap` = how many of the question's content
 * words (4+ chars, non-stopword) actually occur in the target file's text. LOW
 * overlap = genuinely hard for a lexical retriever. We author by describing
 * behaviour, measure overlap, and report the result whatever it is; the headline
 * is computed on the hard subset (overlap ≤ median), so a question that turns out
 * lexically easy cannot inflate vector's apparent edge.
 *
 * RETRIEVERS + COMBOS + JUDGE: identical to repo-benchmark.mjs (via lib.mjs).
 *
 * CAVEAT: 8 questions — directional. The deliverable is whether, once the lexical
 * shortcut is removed, dense (vector) separates from sparse (bm25/grep) on
 * conceptual queries, and by how much.
 *
 * RERUN: node semantic-hardening.mjs   (needs real graft CLI + MiniLM model)
 * ============================================================================
 */
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  OUT_DIR, buildChunks, makeEmbedder, buildRankers, rrf, interleave, hit, files,
  gitSha, graftVersion, sourceFiles, fileText, contentWords, CHUNK,
} from './lib.mjs';

const TOPK = [1, 3, 5];

// Paraphrase-pure semantic questions: describe the behaviour, avoid the file's
// own identifiers/filenames. Ground-truth files verified to exist.
const QUESTIONS = [
  { id: 'h1', file: 'packages/core/src/cache/prefix.ts',
    q: 'When someone rewrites an early message, which part works out how much of the previously sent conversation the model host can still reuse without being billed to read it again?' },
  { id: 'h2', file: 'packages/core/src/cache/simulator.ts',
    q: 'What imitates the way a language-model host charges for input so a test can prove that a small change to the prompt did not needlessly force the whole thing to be re-read and re-paid?' },
  { id: 'h3', file: 'packages/core/src/attention/policy.ts',
    q: 'Which piece ranks older parts of the dialogue by how likely they still matter and sets aside the ones that no longer bear on the work at hand?' },
  { id: 'h4', file: 'packages/core/src/segment/segment.ts',
    q: 'Where is the running record of actions split into stages so that each stage can later be condensed on its own?' },
  { id: 'h5', file: 'packages/core/src/retrieve/lexical.ts',
    q: 'How does the tool judge which earlier passage best answers a request using only word counts, for the case where numeric meaning vectors are not available?' },
  { id: 'h6', file: 'packages/core/src/assemble/assembler.ts',
    q: 'Which part builds the final block of text handed to the model out of a frozen header, short overviews of past work, and the detail of whatever is being worked on now?' },
  { id: 'h7', file: 'packages/core/src/providers/merge.ts',
    q: 'Where are hits from several different lookup helpers combined into one ordered list, taking care that a confident answer from one helper is not buried by noise from the others?' },
  { id: 'h8', file: 'packages/core/src/attention/rederive.ts',
    q: 'Which piece judges whether a past step could simply be run again to reproduce its output, so that output need not be carried along?' },
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
    // Objective hardness: query content-words that actually occur in the target file.
    const fileWords = new Set(contentWords(fileText(item.file)));
    const qWords = contentWords(item.q);
    const overlapWords = qWords.filter((w) => fileWords.has(w));
    const ranks = Object.fromEntries(names.map((n) => {
      const idx = lists[n].indexOf(item.file);
      return [n, idx < 0 ? null : idx + 1];
    }));
    perQ.push({ ...item, lists, overlap: overlapWords.length, overlapWords, qWordCount: qWords.length, ranks });
    process.stderr.write('.');
  }
  process.stderr.write('\n');

  const overlaps = perQ.map((x) => x.overlap).sort((a, b) => a - b);
  const medianOverlap = overlaps[Math.floor(overlaps.length / 2)];
  const hardSet = perQ.filter((x) => x.overlap <= medianOverlap);

  function rates(set) {
    const r = { individual: {}, combos: {} };
    for (const n of names) { r.individual[n] = {}; for (const k of TOPK) r.individual[n][k] = +(set.filter((x) => hit(x.lists[n], x.file, k)).length / (set.length || 1)).toFixed(3); }
    for (const k of TOPK) {
      r.combos[`rrf@${k}`] = +(set.filter((x) => hit(rrf(Object.values(x.lists)), x.file, k)).length / (set.length || 1)).toFixed(3);
      r.combos[`interleave@${k}`] = +(set.filter((x) => hit(interleave(Object.values(x.lists)), x.file, k)).length / (set.length || 1)).toFixed(3);
    }
    return r;
  }

  const out = {
    runId: process.env.RUN_ID ?? `rung-0e-semantic-hardening-${new Date().toISOString().slice(0, 10)}`,
    armId: 'semantic-hardening@v1', rung: '0e-phase2b', offline: true,
    corpus: 'context-tree repo (each package src TypeScript)', graft: 'real CLI ' + graftVersion(),
    setup: { chunker: `RecursiveCharacterTextSplitter(${CHUNK.chunkSize}/${CHUNK.chunkOverlap})`, chunks: chunks.length, files: sourceFiles().length, topK: TOPK, embedModel: emb.ok ? 'Xenova/all-MiniLM-L6-v2' : null },
    judge: 'ground-truth answer FILE appears in top-k; hardness = query content-words present in target file',
    commit: gitSha(), date: new Date().toISOString(),
    caveat: '8 paraphrase-pure semantic questions; headline computed on the hard subset (overlap<=median) so lexically-easy questions cannot inflate vector. Directional (n=8).',
    vectorAvailable: emb.ok, vectorSkipReason: emb.ok ? null : emb.reason,
    medianOverlap, hardSetSize: hardSet.length,
    all: rates(perQ), hard: rates(hardSet),
    perQuery: perQ.map((x) => ({ id: x.id, file: x.file, overlap: x.overlap, qWordCount: x.qWordCount, overlapWords: x.overlapWords, ranks: x.ranks })),
  };
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'results-semantic-hardening.json'), JSON.stringify(out, null, 2));
  printSummary(out, names);
  console.log(`\nwrote ${join('reports', 'metrics', 'rung-0e-retrievers', 'results-semantic-hardening.json')}`);
}

function printSummary(out, names) {
  console.log(`corpus: ${out.setup.files} files → ${out.setup.chunks} chunks | graft ${out.graft}`);
  console.log(`\nper-question hardness (overlap = query content-words found in target file) and target rank per retriever:`);
  console.log('id  overlap  ' + names.map((n) => n.padStart(8)).join(''));
  for (const x of out.perQuery) console.log(`${x.id}    ${String(x.overlap).padStart(2)}/${x.qWordCount}   ` + names.map((n) => String(x.ranks[n] ?? '—').padStart(8)).join(''));
  console.log(`\nmedian overlap = ${out.medianOverlap}; hard subset (overlap ≤ median) = ${out.hardSetSize} questions`);
  for (const [label, r] of [['ALL (n=8)', out.all], [`HARD (n=${out.hardSetSize})`, out.hard]]) {
    console.log(`\nfile-in-top-k — ${label}:`);
    console.log('retriever'.padEnd(11) + TOPK.map((k) => `@${k}`.padStart(7)).join(''));
    for (const n of names) console.log(n.padEnd(11) + TOPK.map((k) => `${(r.individual[n][k] * 100).toFixed(0)}%`.padStart(7)).join(''));
    console.log('rrf'.padEnd(11) + TOPK.map((k) => `${(r.combos[`rrf@${k}`] * 100).toFixed(0)}%`.padStart(7)).join(''));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
