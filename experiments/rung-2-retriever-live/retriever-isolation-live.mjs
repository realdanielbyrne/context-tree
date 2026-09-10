/**
 * ============================================================================
 * EXPERIMENT: retriever isolation + ensemble, on a REAL MODEL endpoint
 * ============================================================================
 *
 * Promotes rung-0e (offline "file-in-top-k") to an END-TO-END live measurement:
 * each retriever's top-k passages are handed to the LOCAL model, which answers
 * the question; grading is deterministic (regex over the model's answer). This
 * tests what the retriever actually delivers to a model, not just whether the
 * right file ranked — the metric rung-0e could not reach without a model.
 *
 * CORPUS: packages/<pkg>/src (same as rung-0e repo-benchmark) — the code repo where
 *   graft applies. Chunked with rung-0e's chunker (one source of truth).
 * RETRIEVERS (isolated arms, one variable each) + graft (0e's best single):
 *   graft (structural, graft CLI) · bm25 · vector (MiniLM) · grep · fuzzy
 * ENSEMBLE arm: RRF fusion over the retrievers' ranked FILE lists (0e's rrf),
 *   then materialize the best passage per fused file (graft span if any, else top
 *   chunk). No cross-encoder rerank — 0e found it HURT on code; RRF IS the rerank.
 * QUESTIONS: 20, mixed strata (structural/literal/semantic/fuzzy), each with a
 *   verified ground-truth file and an authored deterministic answer.
 *
 * METRIC per arm:
 *   accuracy            = model answers correctly (regex), the end-to-end number
 *   answer_present_rate = gold answer literally in the retrieved context (the
 *                         retrieval ceiling for that arm — decouples retrieve/extract)
 *   mean_prompt_tokens  = real host accounting
 *
 * PRE-REGISTERED (fixed before run):
 *   F-graft  : graft is the best single retriever on this corpus (0e). FALSIFIED
 *              if graft's live accuracy is below the best chunk retriever's.
 *   F-ensemble: RRF ensemble >= best single retriever accuracy (0e: RRF wins on
 *              mixed traffic). FALSIFIED if ensemble < best single by >1 question.
 *   Thinking held ON for every arm (constant), so the retriever is the only variable.
 *
 * RERUN: node retriever-isolation-live.mjs [--limit N] [--k 5] [--arms a,b]
 *   needs: local host up, graft CLI, MiniLM (rung-0a deps symlinked).
 * ============================================================================
 */
import bm25Factory from 'wink-bm25-text-search';
import nlp from 'wink-nlp-utils';
import {
  buildChunks, makeEmbedder, graftSpans, rrf, cosine, trigrams, jaccard, queryTerms,
  fileText, sourceFiles, CHUNK, graftVersion,
} from '../rung-0e-retrievers/lib.mjs';
import { generate, writeResults, gitSha, nowISO, MODEL, WINDOW } from '../rung-1-live-probe/lib.mjs';
import { QUESTIONS, gradeLive } from './questions.mjs';

const argv = process.argv.slice(2);
const argVal = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const LIMIT = +argVal('--limit', '0') || 0;
const K = +argVal('--k', '5');
const ARMS_FILTER = argVal('--arms', '');
const PASSAGE_CHARS = 1600;
const SYSTEM = 'You answer a question about a software codebase using ONLY the retrieved code excerpts provided. Each excerpt is headed by its file path. Answer with just the specific value asked for — a file path or name, a symbol/identifier, or a literal value — and nothing else. If the excerpts do not contain the answer, reply exactly: UNKNOWN.';


const cap = (s) => (s.length > PASSAGE_CHARS ? s.slice(0, PASSAGE_CHARS) + '…' : s);
const chunkPassage = (c) => ({ file: c.file, startLine: c.startLine, endLine: c.endLine, text: cap(c.text) });
function graftPassage(span) {
  const lines = fileText(span.file).split('\n');
  const s = Math.max(1, span.startLine - 2), e = Math.min(lines.length, span.startLine + 22);
  return { file: span.file, startLine: s, endLine: e, text: cap(lines.slice(s - 1, e).join('\n')) };
}
const renderContext = (ps) => ps.map((p) => `// ${p.file}:${p.startLine}-${p.endLine}\n${p.text}`).join('\n\n');

// ---- per-chunk rankers (chunk-granular, so we can materialize passages) ----
function bm25Chunks(chunks) {
  const eng = bm25Factory();
  eng.defineConfig({ fldWeights: { text: 1 } });
  eng.definePrepTasks([nlp.string.lowerCase, nlp.string.tokenize0, nlp.tokens.removeWords, nlp.tokens.stem]);
  for (const c of chunks) eng.addDoc({ text: c.text || ' ' }, c.id);
  eng.consolidate();
  return (q) => { let r = []; try { r = eng.search(q); } catch { r = []; } return r.map(([id]) => Number(id)); };
}
const grepChunks = (chunks) => (q) => {
  const ts = queryTerms(q).map((t) => t.toLowerCase());
  return chunks.map((c) => { const low = c.text.toLowerCase(); let s = 0; for (const t of ts) if (low.includes(t)) s++; return [c.id, s]; })
    .filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).map(([id]) => id);
};
const fuzzyChunks = (chunks) => { const tri = chunks.map((c) => trigrams(c.text)); return (q) => { const qt = trigrams(q); return chunks.map((c, i) => [c.id, jaccard(qt, tri[i])]).sort((a, b) => b[1] - a[1]).map(([id]) => id); }; };
const vectorChunks = (chunks, ce, embed) => async (q) => { const qe = await embed(q); return chunks.map((c, i) => [c.id, cosine(qe, ce[i])]).sort((a, b) => b[1] - a[1]).map(([id]) => id); };

const uniqFiles = (chunkIds, byId) => { const seen = new Set(), out = []; for (const id of chunkIds) { const f = byId.get(id)?.file; if (f && !seen.has(f)) { seen.add(f); out.push(f); } } return out; };

async function main() {
  const chunks = await buildChunks();
  const byId = new Map(chunks.map((c) => [c.id, c]));
  const emb = await makeEmbedder();
  if (!emb.ok) throw new Error('vector arm needs MiniLM: ' + emb.reason);
  const chunkEmb = await Promise.all(chunks.map((c) => emb.embed(c.text)));
  console.error(`corpus: ${sourceFiles().length} files → ${chunks.length} chunks | k=${K} | vector=MiniLM`);

  const rankers = {
    bm25: bm25Chunks(chunks),
    vector: vectorChunks(chunks, chunkEmb, emb.embed),
    grep: grepChunks(chunks),
    fuzzy: fuzzyChunks(chunks),
  };
  const CHUNK_RETRIEVERS = Object.keys(rankers);
  let armNames = [...CHUNK_RETRIEVERS, 'graft', 'ensemble'];
  if (ARMS_FILTER) armNames = armNames.filter((a) => ARMS_FILTER.split(',').includes(a));

  const questions = LIMIT ? QUESTIONS.slice(0, LIMIT) : QUESTIONS;
  const cells = [];

  for (const qd of questions) {
    // rank per chunk-retriever + graft, once per question
    const chunkRanked = {};
    for (const r of CHUNK_RETRIEVERS) chunkRanked[r] = await rankers[r](qd.q);
    const spans = graftSpans(qd.q);

    // passage lists per arm
    const passagesByArm = {};
    for (const r of CHUNK_RETRIEVERS) passagesByArm[r] = chunkRanked[r].slice(0, K).map((id) => chunkPassage(byId.get(id)));
    // graft: top-k spans, dedupe by file:startLine
    { const seen = new Set(), out = []; for (const sp of spans) { const key = `${sp.file}#${sp.startLine}`; if (seen.has(key)) continue; seen.add(key); out.push(graftPassage(sp)); if (out.length >= K) break; } passagesByArm.graft = out; }
    // ensemble: RRF over per-retriever ranked FILE lists (incl. graft), best passage per fused file
    {
      const fileLists = CHUNK_RETRIEVERS.map((r) => uniqFiles(chunkRanked[r], byId));
      const graftFiles = []; { const seen = new Set(); for (const sp of spans) if (!seen.has(sp.file)) { seen.add(sp.file); graftFiles.push(sp.file); } }
      fileLists.push(graftFiles);
      const fused = rrf(fileLists).slice(0, K);
      const graftSpanByFile = new Map(); for (const sp of spans) if (!graftSpanByFile.has(sp.file)) graftSpanByFile.set(sp.file, sp);
      const bestChunkByFile = new Map(); for (const id of chunkRanked.bm25.concat(chunkRanked.vector)) { const f = byId.get(id)?.file; if (f && !bestChunkByFile.has(f)) bestChunkByFile.set(f, byId.get(id)); }
      passagesByArm.ensemble = fused.map((f) => graftSpanByFile.has(f) ? graftPassage(graftSpanByFile.get(f)) : (bestChunkByFile.has(f) ? chunkPassage(bestChunkByFile.get(f)) : null)).filter(Boolean);
    }

    for (const arm of armNames) {
      const ps = passagesByArm[arm] || [];
      const context = renderContext(ps);
      const present = gradeLive(context, qd.answer);
      const files = ps.map((p) => p.file);
      const gt_in_topk = files.includes(qd.file);
      const r = await generate({ system: SYSTEM, user: `Retrieved code excerpts:\n\n${context}\n\n---\nQuestion: ${qd.q}`, maxTokens: 512, temperature: 0, think: true });
      const correct = gradeLive(r.grade_text, qd.answer);
      cells.push({
        arm, id: qd.id, stratum: qd.stratum, correct, answer_present: present, gt_file_in_topk: gt_in_topk,
        output: r.content.slice(0, 160), reasoning_len: r.reasoning_len, finish: r.finish,
        prompt_tokens: r.usage.prompt_tokens ?? null, completion_tokens: r.usage.completion_tokens ?? null,
        n_passages: ps.length, files: files.slice(0, K),
      });
      process.stderr.write(correct ? '.' : (present ? 'x' : '_')); // . correct | x present-but-wrong | _ not-retrieved
    }
    process.stderr.write(` ${qd.id}\n`);
  }

  const agg = {};
  for (const arm of armNames) {
    const rows = cells.filter((c) => c.arm === arm); const n = rows.length;
    agg[arm] = {
      n, accuracy: +(rows.filter((c) => c.correct).length / n).toFixed(4),
      answer_present_rate: +(rows.filter((c) => c.answer_present).length / n).toFixed(4),
      gt_file_in_topk_rate: +(rows.filter((c) => c.gt_file_in_topk).length / n).toFixed(4),
      extraction_given_present: (() => { const p = rows.filter((c) => c.answer_present); return p.length ? +(p.filter((c) => c.correct).length / p.length).toFixed(4) : null; })(),
      mean_prompt_tokens: Math.round(rows.reduce((s, c) => s + (c.prompt_tokens || 0), 0) / n),
    };
  }
  const bestSingle = CHUNK_RETRIEVERS.concat('graft').filter((a) => armNames.includes(a))
    .map((a) => ({ a, acc: agg[a].accuracy })).sort((x, y) => y.acc - x.acc)[0];

  const out = {
    manifest: {
      run_id: `retriever-live-${Date.now()}`, arm_id: 'retriever-isolation-live@v1',
      experiment: 'rung-2-retriever-live / retriever-isolation-live',
      corpus: 'packages/**/src (code repo)', chunker: `Recursive(${CHUNK.chunkSize}/${CHUNK.chunkOverlap})`,
      model: MODEL, window: WINDOW, thinking: true, k: K, graft_version: graftVersion(),
      grader: 'deterministic regex over model answer (flags: i,s)', judge_files: 'authored ground-truth file + answer regex',
      commit: gitSha(), date: nowISO(),
      falsification: { F_graft: 'graft accuracy >= best chunk retriever', F_ensemble: 'ensemble accuracy >= best single (within 1 question)' },
      caveats: ['n=20, directional.', 'Answer regex can over-credit if a filename token appears in an excerpt the model echoes; spot-check.', 'Passages capped at ' + PASSAGE_CHARS + ' chars; k=' + K + ' held constant, not token-neutral.', 'Thinking ON (extraction lever); retriever is the only variable across arms.'],
    },
    aggregate: agg, best_single: bestSingle, cells,
  };
  const path = writeResults('rung-2-retriever-live', 'results-isolation-live.json', out);

  console.error('\n=== RETRIEVER ISOLATION (LIVE) ===  [acc | ans-present | gt-file@k | tokens]');
  for (const arm of armNames) { const a = agg[arm]; console.error(`  ${arm.padEnd(9)} acc=${a.accuracy}  present=${a.answer_present_rate}  gtfile=${a.gt_file_in_topk_rate}  tok=${a.mean_prompt_tokens}`); }
  console.error(`  best single retriever: ${bestSingle.a} (acc=${bestSingle.acc})`);
  if (armNames.includes('ensemble')) console.error(`  ensemble acc=${agg.ensemble.accuracy} vs best single ${bestSingle.acc} → F_ensemble ${agg.ensemble.accuracy >= bestSingle.acc - (1 / agg.ensemble.n) ? 'PASS' : 'FAIL'}`);
  if (armNames.includes('graft')) { const bestChunk = CHUNK_RETRIEVERS.map((a) => agg[a].accuracy).sort((x, y) => y - x)[0]; console.error(`  F_graft: graft ${agg.graft.accuracy} vs best chunk ${bestChunk} → ${agg.graft.accuracy >= bestChunk ? 'PASS' : 'FAIL'}`); }
  console.error(`  written: ${path}`);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
