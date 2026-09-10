/**
 * Shared corpus + retriever library for Rung 0e experiments.
 * Used by repo-benchmark.mjs and semantic-hardening.mjs so both run the SAME
 * retriever implementations (one source of truth, no drift).
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import bm25Factory from 'wink-bm25-text-search';
import nlp from 'wink-nlp-utils';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = join(HERE, '..', '..');
export const OUT_DIR = join(REPO, 'reports', 'metrics', 'rung-0e-retrievers');
export const CHUNK = { chunkSize: 800, chunkOverlap: 100 };
export const EST_TOK = (s) => Math.round(s.length / 4);

export function gitSha() { try { return execSync('git rev-parse HEAD', { cwd: REPO }).toString().trim(); } catch { return null; } }
export function graftVersion() { try { return execSync('graft --version', { cwd: REPO }).toString().trim(); } catch { return '?'; } }

// ---- corpus: chunk every packages/<pkg>/src TypeScript file (production source only) ----
export function sourceFiles() {
  const out = execSync(`find packages -path '*/src/*' -name '*.ts' ! -name '*.d.ts'`, { cwd: REPO, maxBuffer: 1 << 24 }).toString().trim().split('\n');
  return out.filter((p) => p && !p.includes('/dist/') && !p.includes('/test/'));
}
export async function buildChunks() {
  const splitter = new RecursiveCharacterTextSplitter(CHUNK);
  const chunks = []; let n = 0;
  for (const rel of sourceFiles()) {
    const text = readFileSync(join(REPO, rel), 'utf8');
    let cursor = 0;
    for (const piece of await splitter.splitText(text)) {
      // Recover the piece's line range by locating it forward from a moving cursor.
      const at = text.indexOf(piece, Math.max(0, cursor - CHUNK.chunkOverlap - 5));
      const off = at >= 0 ? at : cursor;
      const startLine = text.slice(0, off).split('\n').length;
      const endLine = startLine + piece.split('\n').length - 1;
      chunks.push({ id: n++, file: rel, text: piece, startLine, endLine });
      cursor = off + piece.length;
    }
  }
  return chunks;
}
export function fileText(rel) { return readFileSync(join(REPO, rel), 'utf8'); }

// ---- query terms (same derivation as retriever.ts findRelevantCenter) ----
const RX = { backtick: /`([^`]+)`/g, quoted: /['"]([^'"]{3,})['"]/g, path: /[\w\-.]+(?:\/[\w\-.]+)+/g, camel: /\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/g, pascal: /\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g, upper: /\b[A-Z][A-Z0-9_]{3,}\b/g };
const STOP = new Set('what when where which that this from with does what are the and for not was how its list value default names name file files uses use'.split(' '));
export function queryTerms(query) {
  const seen = new Set(); const out = [];
  const add = (s) => { if (s.length >= 3 && !seen.has(s)) { seen.add(s); out.push(s); } };
  for (const rx of [RX.backtick, RX.quoted]) for (const m of query.matchAll(rx)) add(m[1]);
  for (const rx of [RX.path, RX.camel, RX.pascal, RX.upper]) for (const m of query.matchAll(rx)) add(m[0]);
  if (out.length) return out;
  return query.split(/\s+/).map((w) => w.replace(/[^a-zA-Z0-9_-]/g, '')).filter((w) => w.length >= 4 && !STOP.has(w.toLowerCase()));
}
// Content words (4+ chars, non-stopword) — for measuring plain-word overlap with a file.
export function contentWords(text) {
  return [...new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOP.has(w)))];
}
export function trigrams(s) { const t = new Set(); const x = ` ${s.toLowerCase()} `; for (let i = 0; i < x.length - 2; i++) t.add(x.slice(i, i + 3)); return t; }
export function jaccard(a, b) { let inter = 0; for (const g of a) if (b.has(g)) inter++; return inter / (a.size + b.size - inter || 1); }
export function cosine(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }

// ---- retrievers: each returns a ranked list of { file, score }, deduped to the
// best (max) score per file, sorted desc. `files()` extracts just the paths.
// Scores are provider-local (not cross-retriever comparable) — use them only
// within one retriever (e.g. min-max normalise for a confidence gate).
export function files(scored) { return scored.map((e) => e.file); }
export function dedupeScored(idScores, chunks) {
  const byId = new Map(chunks.map((c) => [c.id, c]));
  const best = new Map();
  for (const [id, s] of idScores) { const f = byId.get(id)?.file; if (f && (!best.has(f) || s > best.get(f))) best.set(f, s); }
  return [...best.entries()].sort((a, b) => b[1] - a[1]).map(([file, score]) => ({ file, score }));
}
export function bm25Ranker(chunks) {
  const eng = bm25Factory();
  eng.defineConfig({ fldWeights: { text: 1 } });
  eng.definePrepTasks([nlp.string.lowerCase, nlp.string.tokenize0, nlp.tokens.removeWords, nlp.tokens.stem]);
  for (const c of chunks) eng.addDoc({ text: c.text || ' ' }, c.id);
  eng.consolidate();
  return (q) => { let r = []; try { r = eng.search(q); } catch { r = []; } return dedupeScored(r.map(([id, s]) => [Number(id), s]), chunks); };
}
export function grepRanker(chunks) {
  return (q) => {
    const ts = queryTerms(q).map((t) => t.toLowerCase());
    const scored = chunks.map((c) => { const low = c.text.toLowerCase(); let s = 0; for (const t of ts) if (low.includes(t)) s++; return [c.id, s]; });
    return dedupeScored(scored.filter(([, s]) => s > 0), chunks);
  };
}
export function fuzzyRanker(chunks) {
  const tri = chunks.map((c) => trigrams(c.text));
  return (q) => { const qt = trigrams(q); return dedupeScored(chunks.map((c, i) => [c.id, jaccard(qt, tri[i])]), chunks); };
}
export function vectorRanker(chunks, chunkEmb, embed) {
  return async (q) => { const qe = await embed(q); return dedupeScored(chunks.map((c, i) => [c.id, cosine(qe, chunkEmb[i])]), chunks); };
}
export function graftRanker() {
  return (q) => {
    let out = '';
    try { out = execSync(`graft ask ${JSON.stringify(q)} --in packages/ --source`, { cwd: REPO, maxBuffer: 1 << 24, timeout: 20000 }).toString(); } catch { return []; }
    const seen = new Set(); const scored = []; let rank = 0;
    for (const m of out.matchAll(/(packages\/[A-Za-z0-9_./-]+\.[A-Za-z0-9_]+):L?\d+/g)) {
      const f = m[1]; if (f.includes('/dist/') || f.includes('/test/') || seen.has(f)) continue;
      seen.add(f); scored.push({ file: f, score: 1 / (++rank) }); // graft's output order IS its ranking (graft.ts)
    }
    return scored;
  };
}

// graft ranked as SPANS: { file, startLine, endLine, score } in output (=rank) order.
export function graftSpans(q) {
  let out = '';
  try { out = execSync(`graft ask ${JSON.stringify(q)} --in packages/ --source`, { cwd: REPO, maxBuffer: 1 << 24, timeout: 20000 }).toString(); } catch { return []; }
  const spans = []; let rank = 0;
  for (const m of out.matchAll(/(packages\/[A-Za-z0-9_./-]+\.[A-Za-z0-9_]+):L?(\d+)(?:\s*[-–]\s*L?(\d+))?/g)) {
    const file = m[1]; if (file.includes('/dist/') || file.includes('/test/')) continue;
    spans.push({ file, startLine: +m[2], endLine: m[3] ? +m[3] : +m[2], score: 1 / (++rank) });
  }
  return spans;
}

// ---- embeddings (MiniLM), cached by exact string ----
export async function makeEmbedder() {
  let pipe;
  try { const t = await import('@xenova/transformers'); t.env.allowRemoteModels = true; pipe = await t.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2'); }
  catch (e) { return { ok: false, reason: e.message }; }
  const cache = new Map();
  const embed = async (text) => { const h = cache.get(text); if (h) return h; const o = await pipe(text.slice(0, 2000), { pooling: 'mean', normalize: true }); const v = Float32Array.from(o.data); cache.set(text, v); return v; };
  return { ok: true, embed };
}

// ---- combination arms over per-retriever ranked file lists ----
export function interleave(lists) { // round-robin by rank, rank-preserving, dedup
  const seen = new Set(); const out = []; const max = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < max; i++) for (const l of lists) { const f = l[i]; if (f && !seen.has(f)) { seen.add(f); out.push(f); } }
  return out;
}
export function rrf(lists, k = 60) {
  const score = new Map();
  for (const l of lists) l.forEach((f, r) => score.set(f, (score.get(f) ?? 0) + 1 / (k + r + 1)));
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
}
export const hit = (files, gt, k) => files.slice(0, k).includes(gt);

// Build the standard retriever set (graft, bm25, grep, fuzzy, vector) over a chunk set.
export async function buildRankers(chunks, emb) {
  const chunkEmb = emb.ok ? await Promise.all(chunks.map((c) => emb.embed(c.text))) : null;
  return {
    graft: graftRanker(),
    bm25: bm25Ranker(chunks),
    grep: grepRanker(chunks),
    fuzzy: fuzzyRanker(chunks),
    ...(emb.ok ? { vector: vectorRanker(chunks, chunkEmb, emb.embed) } : {}),
  };
}
