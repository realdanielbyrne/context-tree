/**
 * BEST-OF-BREED middleware — ties the validated pieces into one preprocessing layer.
 * Only the good stuff from prior experiments:
 *   - RETRIEVER: ensemble RRF over BM25(term-overlap) + vector(MiniLM cosine) as the
 *     footprint reducer / on-demand chunk (rung-0e: RRF over one corpus wins).
 *   - CLASSIFIER: topic-shift dormancy = z(lexical fingerprint-Jaccard) + z(semantic
 *     embedding cosine) drift vs the recent window (rung-0b / online-segmentation).
 *   - ASSEMBLER/EVICTOR: D-EV weighting (priority-dominant + recency, relevance≈0),
 *     dormant-first ejection, recency anchor, reduce-on-overflow router (D-EV6).
 * Embeddings run locally (MiniLM), independent of the served LLM.
 */
import { makeEmbedder, cosine, jaccard, rrf } from '../rung-0e-retrievers/lib.mjs';
import { extractUnits, estTokens } from './lib.mjs';
import { reduceSummarize, OVERFLOW_CHARS } from './reducers.mjs';

export { makeEmbedder };
const norm = (a) => { const lo = Math.min(...a), hi = Math.max(...a); return a.map((v) => (hi > lo ? (v - lo) / (hi - lo) : 0)); };

// ---- RETRIEVER: ensemble RRF chunk-retrieve, wrapped by the router (D-EV6) ----
export function makeEnsembleReducer(embed) {
  return async ({ out, task }) => {
    if (!out || out.length < OVERFLOW_CHARS) return out;
    const detail = /price|cost|value|number|rate|limit|count|exact|specific|how many|what is the|\d/i.test(task || '');
    if (!detail) return reduceSummarize({ out }); // router → gist when not detail-seeking
    const chunks = []; for (let i = 0; i < out.length; i += 400) chunks.push(out.slice(i, i + 520));
    const terms = [...new Set((task.toLowerCase().match(/[a-z0-9]{3,}/g) || []))];
    const bm25 = chunks.map((c, i) => [i, terms.reduce((s, t) => s + (c.toLowerCase().includes(t) ? 1 : 0), 0)]).sort((a, b) => b[1] - a[1]).map(([i]) => i);
    const qe = await embed(task); const ce = []; for (const c of chunks) ce.push(await embed(c));
    const vec = chunks.map((c, i) => [i, cosine(qe, ce[i])]).sort((a, b) => b[1] - a[1]).map(([i]) => i);
    const fused = rrf([bm25, vec]); // RRF over the two chunk rankings (ensemble)
    const top = fused.slice(0, 2).map((i) => chunks[i]);
    return `[middleware:ensemble RRF(bm25,vector) chunk-retrieve]\n${top.join('\n…\n')}`;
  };
}

// ---- CLASSIFIER (drift dormancy) + ASSEMBLER (D-EV eviction) as one hook ----
export function makeAssembler(embed, budget, { K_RECENT = 4, reserve = 512 } = {}) {
  const cache = new Map();
  const embOf = async (t) => { if (cache.has(t)) return cache.get(t); const v = await embed((t || ' ').slice(0, 2000)); cache.set(t, v); return v; };
  return async (messages) => {
    const { pinned, units } = extractUnits(messages);
    const N = units.length;
    if (!N) return false;
    const avail = budget - estTokens(pinned) - reserve;
    if (avail <= 0 || estTokens(units.flatMap((u) => u.slice)) <= avail) return false;
    const texts = units.map((u) => u.slice.map((m) => (m.content || '') + ' ' + (m.tool_calls || []).map((tc) => tc.function.arguments || '').join(' ')).join(' '));
    const embs = []; for (const t of texts) embs.push(await embOf(t));
    const lo = Math.max(0, N - K_RECENT);
    const recentFp = new Set(); for (let k = lo; k < N; k++) for (const f of units[k].fp) recentFp.add(f);
    const recentMean = new Float32Array(embs[0].length); for (let k = lo; k < N; k++) for (let d = 0; d < recentMean.length; d++) recentMean[d] += embs[k][d] / (N - lo);
    // CLASSIFIER: dormancy = drift from recent = z(lexical) + z(semantic)
    const dLex = norm(units.map((u) => 1 - jaccard(u.fp, recentFp)));
    const dSem = norm(embs.map((e) => 1 - cosine(e, recentMean)));
    const dormancy = units.map((_, i) => 0.5 * dLex[i] + 0.5 * dSem[i]);
    // ASSEMBLER: D-EV priority (editBoost + fp-recurrence) + recency − dormancy (relevance≈0)
    const coref = units.map((u, i) => units.filter((v, j) => j !== i && [...u.fp].some((f) => v.fp.has(f))).length);
    const pN = norm(units.map((u, i) => (u.wrote ? 2 : 0) + coref[i]));
    const rN = norm(units.map((_, i) => i));
    const score = units.map((_, i) => 2 * pN[i] + 1 * rN[i] - 1.5 * dormancy[i]); // dormant-first ejection
    const order = units.map((u, i) => i).sort((a, b) => score[b] - score[a]);
    const keep = new Set(); for (let k = 0; k < Math.min(K_RECENT, N); k++) keep.add(N - 1 - k); // recency anchor
    let used = [...keep].reduce((s, i) => s + estTokens(units[i].slice), 0);
    for (const i of order) { if (keep.has(i)) continue; const t = estTokens(units[i].slice); if (used + t <= avail) { keep.add(i); used += t; } }
    if (keep.size === N) return false;
    const kept = [...keep].sort((a, b) => a - b).map((i) => units[i]);
    messages.length = 0; messages.push(...pinned, ...kept.flatMap((u) => u.slice)); // in-place, creation order
    return true;
  };
}
