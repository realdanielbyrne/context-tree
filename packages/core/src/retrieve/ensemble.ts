/**
 * Ensemble retriever (spec stage 3) — the SETTLED retrieval design.
 *
 * Corpus = the L0 units chunked by the recursive character splitter. Fan out
 * BM25 (lexical) + vector kNN (cosine over the SAME chunks) and fuse by RRF, then
 * return the best-matching WHOLE units (the caller fetches whole-unit text and
 * appends it after the buffer, retained whole — never re-chunked).
 *
 * Embedder-agnostic: it takes the `SummaryEmbedder` abstraction, so it works with
 * any vector source. Switching the default embedder from the remote
 * `text-embedding-3-small` to a local MiniLM is a deployment follow-up (NOT-
 * CARRIED-FORWARD provenance — never A/B'd), not part of this settled logic.
 * `reports/session-handoff.md`.
 */
import type { SummaryEmbedder } from './types.js';
import { cosine } from '../classify/drift.js';
import { chunkUnits, type ChunkOptions } from './chunk.js';
import { BM25 } from './bm25.js';
import { reciprocalRankFusion } from './rrf.js';

export interface EnsembleUnit {
  id: string;
  text: string;
}

export interface EnsembleOptions {
  chunk?: ChunkOptions;
  rrfK?: number;
  /** Return at most this many whole units (all, if omitted). */
  topK?: number;
}

export interface RetrievedUnit {
  unitId: string;
  score: number;
}

/**
 * Retrieve the best whole units for `query`. Returns unit ids ranked by fused
 * score (best first). A unit's score is its best-ranked chunk's fused score.
 */
export async function ensembleRetrieve(
  query: string,
  units: readonly EnsembleUnit[],
  embed: SummaryEmbedder,
  options: EnsembleOptions = {},
): Promise<RetrievedUnit[]> {
  const chunks = chunkUnits(units, options.chunk);
  if (chunks.length === 0) return [];

  // BM25 (lexical) ranking over the chunks; chunk id = its global index.
  const bm25 = new BM25(chunks.map((c) => ({ id: String(c.index), text: c.text })));
  const bm25Ranking = bm25.search(query).map((s) => s.id);

  // Vector kNN (cosine) over the SAME chunks. One batched embed call: [query, ...chunks].
  const vectors = await embed([query, ...chunks.map((c) => c.text)]);
  const qVec = vectors[0]!;
  const vecRanking = chunks
    .map((c, i) => ({ id: String(c.index), score: cosine(qVec, vectors[i + 1]!) }))
    .sort((a, b) => b.score - a.score)
    .map((s) => s.id);

  // Fuse the two chunk rankings; overlapping coverage fuses, single-coverage routes.
  const fused = reciprocalRankFusion([bm25Ranking, vecRanking], options.rrfK);

  // Collapse chunks → whole units: a unit's score is its best-ranked chunk (fused
  // is sorted desc, so the first chunk seen for a unit is its best).
  const byIndex = new Map(chunks.map((c) => [String(c.index), c]));
  const unitBest = new Map<string, number>();
  for (const { id, score } of fused) {
    const unitId = byIndex.get(id)!.unitId;
    if (!unitBest.has(unitId)) unitBest.set(unitId, score);
  }

  const ranked = [...unitBest.entries()]
    .map(([unitId, score]) => ({ unitId, score }))
    .sort((a, b) => b.score - a.score);
  return options.topK !== undefined ? ranked.slice(0, options.topK) : ranked;
}
