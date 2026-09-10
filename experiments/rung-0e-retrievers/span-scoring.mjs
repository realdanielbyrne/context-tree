/**
 * ============================================================================
 * EXPERIMENT: Rung 0e Phase 2d — span-level scoring
 * ============================================================================
 *
 * Source plan: reports/hypothesis-test-ladder.md, Rung 0 item 0e.
 * Results: reports/metrics/rung-0e-retrievers/results-span-scoring.json
 * Shared retriever/corpus code: ./lib.mjs
 *
 * WHY
 * ---
 * Every prior 0e judge was FILE-level: did the answer's home file appear in the
 * top-k. That rewards a retriever that surfaces the right file but returns a span
 * NOT containing the answer — exactly the Rung 0a excerpt-precision failure. This
 * run judges at SPAN level: a unit counts only if its line range actually contains
 * the ground-truth answer line. Three metrics:
 *   fileHit@k     — right file among top-k units (the old judge, for reference)
 *   spanHit@k     — a top-k unit in the right file whose [start,end] holds the answer line
 *   span|file     — spanHit conditioned on fileHit: "when it found the file, did the
 *                   returned span contain the answer?" (the excerpt-precision question)
 *
 * UNITS: chunk retrievers return chunks with line ranges; graft returns its spans.
 * Retrievers: grep (lexical), fuzzy (trigram), vector (MiniLM), graft (real CLI).
 * (bm25 omitted — it needs a chunk-level index; grep is the lexical representative.)
 *
 * GROUND TRUTH: 9 questions with a single crisp answer line (structural/literal/
 * fuzzy), line numbers verified by grep before authoring.
 *
 * CAVEAT: n=9, directional. Chunk line ranges are recovered by forward-search and
 * may be ±1 line; the answer lines are interiors, so this does not bite.
 * RERUN: node span-scoring.mjs   (needs real graft CLI + MiniLM model)
 * ============================================================================
 */
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  OUT_DIR, buildChunks, makeEmbedder, graftSpans, queryTerms, trigrams, jaccard, cosine,
  gitSha, graftVersion, sourceFiles, CHUNK,
} from './lib.mjs';

const TOPK = [1, 3, 5];

// { file, line } ground truth verified by grep (structural/literal/fuzzy, crisp lines).
const QUESTIONS = [
  { id: 'st1', stratum: 'structural', q: 'What functions call excerptAround?', file: 'packages/core/src/retrieve/retriever.ts', line: 206 },
  { id: 'st2', stratum: 'structural', q: 'Which file parses edited blobs into minimal enclosing named spans using tree-sitter grammars?', file: 'packages/core/src/spans/extractor.ts', line: 20 },
  { id: 'li1', stratum: 'literal', q: 'What is the value of the constant RRF_K?', file: 'packages/core/src/retrieve/retriever.ts', line: 836 },
  { id: 'li2', stratum: 'literal', q: 'What is the default excerptChars in the retrieval config?', file: 'packages/core/src/config.ts', line: 139 },
  { id: 'li3', stratum: 'literal', q: 'What DEFAULT_TIMEOUT_MS does the graft provider use?', file: 'packages/core/src/providers/graft.ts', line: 16 },
  { id: 'fz1', stratum: 'fuzzy', q: 'excrptAround', file: 'packages/core/src/retrieve/excerpt.ts', line: 13 },
  { id: 'fz2', stratum: 'fuzzy', q: 'detctAttentionSignals', file: 'packages/core/src/attention/signals.ts', line: 15 },
  { id: 'fz3', stratum: 'fuzzy', q: 'TreeSiterSpanExtractor', file: 'packages/core/src/spans/extractor.ts', line: 20 },
  { id: 'fz4', stratum: 'fuzzy', q: 'buildTopicIndx', file: 'packages/core/src/attention/topic-index.ts', line: 52 },
];

// Chunk-level rankers → ranked list of units { file, startLine, endLine }.
function grepUnits(chunks) {
  return (q) => {
    const ts = queryTerms(q).map((t) => t.toLowerCase());
    return chunks.map((c) => { const low = c.text.toLowerCase(); let s = 0; for (const t of ts) if (low.includes(t)) s++; return [c, s]; })
      .filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).map(([c]) => c);
  };
}
function fuzzyUnits(chunks) {
  const tri = chunks.map((c) => trigrams(c.text));
  return (q) => { const qt = trigrams(q); return chunks.map((c, i) => [c, jaccard(qt, tri[i])]).sort((a, b) => b[1] - a[1]).map(([c]) => c); };
}
function vectorUnits(chunks, emb, embed) {
  return async (q) => { const qe = await embed(q); return chunks.map((c, i) => [c, cosine(qe, emb[i])]).sort((a, b) => b[1] - a[1]).map(([c]) => c); };
}

const inFile = (u, f) => u.file === f;
const holdsLine = (u, f, line) => u.file === f && u.startLine <= line && line <= u.endLine;

async function main() {
  const emb = await makeEmbedder();
  const chunks = await buildChunks();
  const chunkEmb = emb.ok ? await Promise.all(chunks.map((c) => emb.embed(c.text))) : null;
  const rankers = {
    grep: grepUnits(chunks),
    fuzzy: fuzzyUnits(chunks),
    graft: (q) => graftSpans(q),
    ...(emb.ok ? { vector: vectorUnits(chunks, chunkEmb, emb.embed) } : {}),
  };
  const names = Object.keys(rankers);

  const perQ = [];
  for (const item of QUESTIONS) {
    const units = {};
    for (const n of names) units[n] = await rankers[n](item.q);
    perQ.push({ ...item, units });
    process.stderr.write('.');
  }
  process.stderr.write('\n');

  const res = {};
  for (const n of names) {
    res[n] = {};
    for (const k of TOPK) {
      const fileHits = perQ.filter((x) => x.units[n].slice(0, k).some((u) => inFile(u, x.file)));
      const spanHits = perQ.filter((x) => x.units[n].slice(0, k).some((u) => holdsLine(u, x.file, x.line)));
      res[n][k] = {
        fileHit: +(fileHits.length / perQ.length).toFixed(3),
        spanHit: +(spanHits.length / perQ.length).toFixed(3),
        spanGivenFile: fileHits.length ? +(spanHits.length / fileHits.length).toFixed(3) : null,
        fileHitCount: fileHits.length, spanHitCount: spanHits.length,
      };
    }
  }

  const out = {
    runId: process.env.RUN_ID ?? `rung-0e-span-scoring-${new Date().toISOString().slice(0, 10)}`,
    armId: 'span-scoring@v1', rung: '0e-phase2d', offline: true,
    corpus: 'context-tree repo (each package src TypeScript)', graft: 'real CLI ' + graftVersion(),
    setup: { chunker: `RecursiveCharacterTextSplitter(${CHUNK.chunkSize}/${CHUNK.chunkOverlap})`, chunks: chunks.length, files: sourceFiles().length, topK: TOPK, embedModel: emb.ok ? 'Xenova/all-MiniLM-L6-v2' : null },
    judge: 'span-level: a top-k unit in the right file whose line range contains the answer line',
    commit: gitSha(), date: new Date().toISOString(),
    questions: QUESTIONS.length,
    caveat: 'n=9 crisp-line questions (structural/literal/fuzzy). bm25 omitted (needs chunk index). Chunk line ranges recovered by forward-search (±1 line).',
    vectorAvailable: emb.ok, results: res,
    perQuery: perQ.map((x) => ({ id: x.id, file: x.file, line: x.line, topUnits: Object.fromEntries(names.map((n) => [n, x.units[n].slice(0, 3).map((u) => `${u.file.split('/').pop()}:${u.startLine}-${u.endLine}`)])) })),
  };
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'results-span-scoring.json'), JSON.stringify(out, null, 2));
  printSummary(out, names);
  console.log(`\nwrote ${join('reports', 'metrics', 'rung-0e-retrievers', 'results-span-scoring.json')}`);
}

function printSummary(out, names) {
  console.log(`corpus: ${out.setup.files} files → ${out.setup.chunks} chunks | graft ${out.graft} | n=${out.questions}`);
  console.log(`\n@5 — fileHit → spanHit (span|file): does the returned span contain the answer line?`);
  console.log('retriever'.padEnd(10) + 'fileHit@5  spanHit@5  span|file@5');
  for (const n of names) {
    const r = out.results[n][5];
    console.log(n.padEnd(10) + `${(r.fileHit * 100).toFixed(0)}%`.padStart(8) + `${(r.spanHit * 100).toFixed(0)}%`.padStart(11) + `${r.spanGivenFile === null ? '—' : (r.spanGivenFile * 100).toFixed(0) + '%'}`.padStart(12));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
