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
import { embedInBatches } from '../models/embeddings.js';
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
  /** The unit's best-matching chunk text — a ready-to-show excerpt. */
  excerpt: string;
}

/**
 * Retrieve the best whole units for `query`. Returns unit ids ranked by fused
 * score (best first), each with the excerpt of its best-ranked chunk. A unit's
 * score is its best-ranked chunk's fused score.
 *
 * `embed` is OPTIONAL: with an embedder this is the full BM25 + vector ensemble;
 * without one it degrades to BM25-only (RRF over a single list = BM25 order), so
 * it works offline / with no embedding key.
 */
export async function ensembleRetrieve(
  query: string,
  units: readonly EnsembleUnit[],
  embed?: SummaryEmbedder,
  options: EnsembleOptions = {},
): Promise<RetrievedUnit[]> {
  const { topK } = options;
  if (topK !== undefined && (!Number.isInteger(topK) || topK < 0)) {
    throw new RangeError('topK must be a non-negative integer');
  }
  const chunks = chunkUnits(units, options.chunk);
  if (chunks.length === 0) return [];

  // BM25 (lexical) ranking over the chunks; chunk id = its global index.
  const bm25 = new BM25(chunks.map((c) => ({ id: String(c.index), text: c.text })));
  const rankings: string[][] = [bm25.search(query).map((s) => s.id)];

  // Vector kNN (cosine) over the SAME chunks, when an embedder is supplied. Embed
  // [query, ...chunks] in bounded, shape-validated batches so a large corpus never
  // exceeds the provider's per-request limits and a malformed embedder fails loud.
  if (embed !== undefined) {
    const vectors = await embedInBatches(embed, [query, ...chunks.map((c) => c.text)]);
    const qVec = vectors[0]!;
    rankings.push(
      chunks
        .map((c, i) => ({ id: String(c.index), score: cosine(qVec, vectors[i + 1]!) }))
        .sort((a, b) => b.score - a.score)
        .map((s) => s.id),
    );
  }

  // Fuse the chunk rankings; overlapping coverage fuses, single-coverage routes.
  const fused = reciprocalRankFusion(rankings, options.rrfK);

  // Collapse chunks → whole units: a unit's score + excerpt come from its best-ranked
  // chunk (fused is sorted desc, so the first chunk seen for a unit is its best).
  const byIndex = new Map(chunks.map((c) => [String(c.index), c]));
  const unitBest = new Map<string, { score: number; excerpt: string }>();
  for (const { id, score } of fused) {
    const chunk = byIndex.get(id)!;
    if (!unitBest.has(chunk.unitId)) unitBest.set(chunk.unitId, { score, excerpt: chunk.text });
  }

  const ranked = [...unitBest.entries()]
    .map(([unitId, v]) => ({ unitId, score: v.score, excerpt: v.excerpt }))
    .sort((a, b) => b.score - a.score);
  return topK !== undefined ? ranked.slice(0, topK) : ranked;
}
