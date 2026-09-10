/**
 * ============================================================================
 * EXPERIMENT: Rung 0e Phase 1 — retriever isolation (each retriever ALONE)
 * ============================================================================
 *
 * Source plan: reports/hypothesis-test-ladder.md §"Rung 0 · 0e".
 * Results: reports/metrics/rung-0e-retrievers/results-isolation.json
 * Reuses the rung-0a corpus, chunker, and deps (node_modules/fixtures symlinked).
 *
 * QUESTION
 * --------
 * Before testing any COMBINATION of retrievers (Rung 0e Phase 2), establish the
 * per-retriever baseline and the BEST SINGLE INDEX — the bar every combination
 * must clear (§0/S3: RRF fusion across disjoint indexes already lost to routing).
 * One variable per arm: same corpus, same chunker, same top-k budget; vary only
 * the retriever.
 *
 * RETRIEVERS (all text-applicable to the pooled-slice corpus; all local/offline)
 * -----------------------------------------------------------------------------
 *   bm25         — sparse lexical (wink-bm25-text-search)               [0a done]
 *   vector       — dense bi-encoder, MiniLM cosine (Xenova all-MiniLM-L6-v2)
 *   grep-exact   — deterministic: count of query terms present as substrings
 *   tfidf-beam   — the repo's OWN shipped ranker (@context-tree/core lexicalScore)
 *   fuzzy        — trigram Jaccard (query vs chunk)
 * Structural retrievers (graft/tree-sitter, Serena/LSP) are OUT — they retrieve
 * from a parseable code repo, not conversation-trace slices (that is HR1/1b).
 *
 * SETUP (held constant across retrievers — "similar setups")
 * ----------------------------------------------------------
 *   chunker = RecursiveCharacterTextSplitter(512/128); top-k ∈ {1,3,5}.
 *   metric  = fraction of queries whose answer_literals ALL appear in the union
 *             of the top-k retrieved chunks; corpus-wide AND oracle (rank within
 *             the correct doc, isolating retrieval quality from chunking).
 *
 * CAVEAT (same as 0a): corpus = pooled answer-windowed wide_context slices
 * (≤~2.1KB); the real s1 event store died with eval/ at 7d459f9. Relative
 * per-retriever comparison is the deliverable, not absolute rates.
 *
 * RERUN: node retriever-isolation.mjs  (needs rung-0a deps + MiniLM model)
 * ============================================================================
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import bm25Factory from 'wink-bm25-text-search';
import nlp from 'wink-nlp-utils';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const CACHE = join(HERE, 'fixtures');
const OUT_DIR = join(REPO, 'reports', 'metrics', 'rung-0e-retrievers');
const CORE = join(REPO, 'packages', 'core', 'dist', 'retrieve', 'lexical.js');
const FIXTURE_COMMIT = '7d459f9^';
const FIXTURE_BASE = 'eval/fixtures/transplant/s1/e1b289c32f40';
const FILES = ['questions.json', 'questions-deep.json', 'questions-overflow.json'];
const TOPK = [1, 3, 5];
const CHUNK = { chunkSize: 512, chunkOverlap: 128 };
const EST_TOK = (s) => Math.round(s.length / 4);

const { buildLexicalIndex, lexicalScore, terms: coreTerms } = await import(CORE);

// -------- fixtures / corpus (same as 0a) --------
function gitSha() { try { return execSync('git rev-parse HEAD', { cwd: REPO }).toString().trim(); } catch { return null; } }
function ensureFixtures() {
  if (!existsSync(CACHE)) mkdirSync(CACHE, { recursive: true });
  for (const f of FILES) {
    const dst = join(CACHE, f);
    if (existsSync(dst)) continue;
    writeFileSync(dst, execSync(`git show ${FIXTURE_COMMIT}:${FIXTURE_BASE}/${f.replace('.json', '')}.json`, { cwd: REPO, maxBuffer: 1 << 24 }));
  }
}
function loadCorpus() {
  ensureFixtures();
  const docs = []; const seen = new Set(); const perFile = {};
  for (const f of FILES) {
    const d = JSON.parse(readFileSync(join(CACHE, f), 'utf8'));
    perFile[f] = (d.questions ?? []).length;
    for (const q of d.questions ?? []) {
      const key = `${q.id}::${q.wide_context ?? ''}`;
      if (seen.has(key)) continue; seen.add(key);
      docs.push({ id: q.id, text: q.wide_context ?? '', question: q.question ?? '', literals: q.answer_literals ?? [] });
    }
  }
  return { docs, perFile };
}

// -------- query terms (replicated from retriever.ts, as in 0a) --------
const RX = {
  backtick: /`([^`]+)`/g, quoted: /['"]([^'"]{3,})['"]/g, path: /[\w\-.]+(?:\/[\w\-.]+)+/g,
  camel: /\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/g, pascal: /\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g, upper: /\b[A-Z][A-Z0-9_]{3,}\b/g,
};
const STOP = new Set('what when where which that this from with they their there were have been about only also after before into does most more than then each both such over even same other could would should will being under the and for not was are but how its'.split(' '));
function queryTerms(query) {
  const seen = new Set(); const out = [];
  const add = (s) => { if (s.length >= 3 && !seen.has(s)) { seen.add(s); out.push(s); } };
  for (const m of query.matchAll(RX.backtick)) add(m[1]);
  for (const m of query.matchAll(RX.quoted)) add(m[1]);
  for (const m of query.matchAll(RX.path)) add(m[0]);
  for (const m of query.matchAll(RX.camel)) add(m[0]);
  for (const m of query.matchAll(RX.pascal)) add(m[0]);
  for (const m of query.matchAll(RX.upper)) add(m[0]);
  if (out.length) return out;
  return query.split(/\s+/).map((w) => w.replace(/[^a-zA-Z0-9_-]/g, '')).filter((w) => w.length >= 4 && !STOP.has(w.toLowerCase()));
}
function trigrams(s) { const t = new Set(); const x = ` ${s.toLowerCase()} `; for (let i = 0; i < x.length - 2; i++) t.add(x.slice(i, i + 3)); return t; }
function jaccard(a, b) { let inter = 0; for (const g of a) if (b.has(g)) inter++; return inter / (a.size + b.size - inter || 1); }
function cosine(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }

// -------- embeddings (MiniLM) --------
async function makeEmbedder() {
  let pipe;
  try { const t = await import('@xenova/transformers'); t.env.allowRemoteModels = true; pipe = await t.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2'); }
  catch (e) { return { ok: false, reason: e.message }; }
  const cache = new Map();
  const embed = async (text) => { const h = cache.get(text); if (h) return h; const o = await pipe(text, { pooling: 'mean', normalize: true }); const v = Float32Array.from(o.data); cache.set(text, v); return v; };
  return { ok: true, embed };
}

// -------- chunking (fixed) --------
async function buildChunks(docs) {
  const splitter = new RecursiveCharacterTextSplitter(CHUNK);
  const chunks = []; let n = 0;
  for (const doc of docs) for (const piece of await splitter.splitText(doc.text)) chunks.push({ id: n++, text: piece, docId: doc.id });
  return chunks;
}

// -------- retrievers: each returns { [queryId]: rankedChunkIds } --------
function retrieveBM25(chunks, docs) {
  const eng = bm25Factory();
  eng.defineConfig({ fldWeights: { text: 1 } });
  eng.definePrepTasks([nlp.string.lowerCase, nlp.string.tokenize0, nlp.tokens.removeWords, nlp.tokens.stem]);
  for (const c of chunks) eng.addDoc({ text: c.text || ' ' }, c.id);
  eng.consolidate();
  const out = {};
  for (const d of docs) { let r = []; try { r = eng.search(d.question); } catch { r = []; } out[d.id] = r.map(([id]) => Number(id)); }
  return out;
}
function retrieveGrep(chunks, docs) {
  const out = {};
  for (const d of docs) {
    const ts = queryTerms(d.question).map((t) => t.toLowerCase());
    const scored = chunks.map((c) => { const low = c.text.toLowerCase(); let s = 0; for (const t of ts) if (low.includes(t)) s++; return [c.id, s]; });
    out[d.id] = scored.filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).map(([id]) => id);
  }
  return out;
}
function retrieveTfidfBeam(chunks, docs) {
  const index = buildLexicalIndex(chunks.map((c) => c.text));
  const out = {};
  for (const d of docs) {
    const qt = coreTerms(d.question);
    const scored = chunks.map((c) => [c.id, lexicalScore(index, qt, c.text)]);
    out[d.id] = scored.filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).map(([id]) => id);
  }
  return out;
}
function retrieveFuzzy(chunks, docs) {
  const chunkTri = chunks.map((c) => trigrams(c.text));
  const out = {};
  for (const d of docs) {
    const qt = trigrams(d.question);
    const scored = chunks.map((c, i) => [c.id, jaccard(qt, chunkTri[i])]);
    out[d.id] = scored.sort((a, b) => b[1] - a[1]).map(([id]) => id);
  }
  return out;
}
async function retrieveVector(chunks, docs, embed) {
  const ce = []; for (const c of chunks) ce.push(await embed(c.text || ' '));
  const out = {};
  for (const d of docs) { const qe = await embed(d.question); out[d.id] = chunks.map((c, i) => [c.id, cosine(qe, ce[i])]).sort((a, b) => b[1] - a[1]).map(([id]) => id); }
  return out;
}

// -------- scoring --------
function score(chunks, docs, ranked, oracle) {
  const byId = new Map(chunks.map((c) => [c.id, c]));
  const per = {};
  for (const k of TOPK) {
    let all = 0, sz = 0;
    for (const doc of docs) {
      let ids = ranked[doc.id] ?? [];
      if (oracle) ids = ids.filter((id) => byId.get(id)?.docId === doc.id);
      ids = ids.slice(0, k);
      const text = ids.map((id) => byId.get(id)?.text ?? '').join('\n');
      if (doc.literals.length > 0 && doc.literals.every((l) => text.includes(l))) all++;
      sz += EST_TOK(text);
    }
    per[k] = { allPresentRate: +(all / docs.length).toFixed(4), allPresentCount: all, meanReturnedTokens: Math.round(sz / docs.length) };
  }
  return per;
}

async function main() {
  const { docs, perFile } = loadCorpus();
  const emb = await makeEmbedder();
  const chunks = await buildChunks(docs);

  const retrievers = {
    bm25: retrieveBM25(chunks, docs),
    'grep-exact': retrieveGrep(chunks, docs),
    'tfidf-beam': retrieveTfidfBeam(chunks, docs),
    fuzzy: retrieveFuzzy(chunks, docs),
    ...(emb.ok ? { vector: await retrieveVector(chunks, docs, emb.embed) } : {}),
  };

  const cells = [];
  for (const [name, ranked] of Object.entries(retrievers)) {
    const corpusWide = score(chunks, docs, ranked, false);
    const oracle = score(chunks, docs, ranked, true);
    for (const k of TOPK) cells.push({
      retriever: name, topK: k, nChunks: chunks.length,
      allPresentRate: corpusWide[k].allPresentRate, allPresentCount: corpusWide[k].allPresentCount, meanReturnedTokens: corpusWide[k].meanReturnedTokens,
      oracleAllPresentRate: oracle[k].allPresentRate, oracleMeanReturnedTokens: oracle[k].meanReturnedTokens,
    });
  }

  // Best single index: highest corpus-wide allPresentRate (tie: fewer tokens).
  const best = [...cells].sort((a, b) => b.allPresentRate - a.allPresentRate || a.meanReturnedTokens - b.meanReturnedTokens)[0];

  const out = {
    runId: process.env.RUN_ID ?? `rung-0e-isolation-${new Date().toISOString().slice(0, 10)}`,
    armId: 'retriever-isolation@v1', rung: '0e-phase1', offline: true,
    setup: { chunker: `RecursiveCharacterTextSplitter(${CHUNK.chunkSize}/${CHUNK.chunkOverlap})`, topK: TOPK, embedModel: emb.ok ? 'Xenova/all-MiniLM-L6-v2' : null },
    judge: 'literal-substring-match over union of top-k returned chunks',
    commit: gitSha(), fixtureCommit: FIXTURE_COMMIT, date: new Date().toISOString(),
    caveat: 'Corpus = pooled answer-windowed slices (<=~2.1KB); real s1 event store deleted at 7d459f9. Relative per-retriever comparison is the deliverable. Structural retrievers (graft/Serena) excluded — wrong corpus type (HR1/1b).',
    corpus: { files: perFile, docs: docs.length, chunks: chunks.length },
    vectorAvailable: emb.ok, vectorSkipReason: emb.ok ? null : emb.reason,
    bestSingleIndex: best,
    cells,
  };
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'results-isolation.json'), JSON.stringify(out, null, 2));
  printSummary(out);
  console.log(`\nwrote ${join('reports', 'metrics', 'rung-0e-retrievers', 'results-isolation.json')}`);
}

function printSummary(out) {
  console.log(`corpus: ${out.corpus.docs} docs → ${out.corpus.chunks} chunks | chunker ${out.setup.chunker}${out.vectorAvailable ? '' : ' | vector SKIPPED: ' + out.vectorSkipReason}`);
  console.log('\nEach retriever ALONE — corpus-wide allPresentRate (oracle in parens), mean tokens:');
  console.log('retriever'.padEnd(13) + TOPK.map((k) => `k=${k}`.padStart(20)).join(''));
  const names = [...new Set(out.cells.map((c) => c.retriever))];
  for (const n of names) {
    const row = TOPK.map((k) => {
      const c = out.cells.find((x) => x.retriever === n && x.topK === k);
      return `${(c.allPresentRate * 100).toFixed(0)}%(${(c.oracleAllPresentRate * 100).toFixed(0)}%) ${c.meanReturnedTokens}t`.padStart(20);
    }).join('');
    console.log(n.padEnd(13) + row);
  }
  const b = out.bestSingleIndex;
  console.log(`\nBEST SINGLE INDEX (the bar for Phase 2): ${b.retriever} @ k=${b.topK} → ${(b.allPresentRate * 100).toFixed(1)}% corpus-wide, ${b.meanReturnedTokens}t`);
}

main().catch((e) => { console.error(e); process.exit(1); });
