/**
 * Reciprocal Rank Fusion (spec stage 3) — the SETTLED ensemble combinator.
 *
 * Provenance: plain RRF over a shared, overlapping-coverage corpus beat
 * best-single retriever, a feature router, and margin-gated fusion, both offline
 * and live (`reports/metrics/rung-0e-retrievers/`, `rung-2-retriever-live/`).
 * RRF is rank-based (scale-free): it never puts disjoint retrievers' scores on
 * one scale; overlapping coverage fuses, and a single-coverage query routes to
 * the sole coverer.
 *
 * `rrf(u) = Σ_r 1/(RRF_K + rank_r(u))`, rank 1-based.
 *
 * PROVISIONAL: `RRF_K = 60` is the literature default, never swept on this corpus.
 */
export const DEFAULT_RRF_K = 60;

import type { Scored } from './bm25.js';

/**
 * Fuse ranked id-lists into one ranking. Each input is a list of ids in rank
 * order (best first). Ids may appear in any subset of the inputs. Returns fused
 * ids with their RRF scores, highest first.
 */
export function reciprocalRankFusion(
  rankings: readonly (readonly string[])[],
  k: number = DEFAULT_RRF_K,
): Scored[] {
  if (!Number.isFinite(k) || k < 0) throw new RangeError('RRF k must be finite and ≥ 0');
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((id, i) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1)); // rank = i + 1
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}
