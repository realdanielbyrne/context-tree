/**
 * Reduce-on-overflow (spec stage 2, §"Reduce-on-overflow") — the overflow VALVE
 * for a single raw unit that exceeds the per-unit budget `b`. Distinct from
 * eviction (which drops whole low-scoring units to the floor): this shrinks an
 * oversized *raw* unit in place, so an anchor or active-phase unit that is never
 * evicted can still be brought under budget.
 *
 * Two SETTLED reducers (`coding-harness/report-{buried-detail,hard-window-synthesis}.md`):
 *   chunk   — lossless: keep the spans of the unit most relevant to the query, in
 *             document order, with the gaps marked. Preserves a buried detail.
 *   summarize — lossy: fold to the unit's latched §8 summary (gist). Drops detail.
 * Default is `chunk` (err toward preserving detail).
 *
 * This is an IMPROVEMENT over the experiment's crude reducer
 * (`experiments/coding-harness/reducers.mjs`, fixed 400/520-char slices +
 * `includes()` term-count + hardcoded top-2). Here the chunk reducer is built on
 * the package's own SETTLED retrieval primitives: the recursive character splitter
 * (`retrieve/chunk.ts`), Okapi BM25 (`retrieve/bm25.ts`), RRF fusion
 * (`retrieve/rrf.ts`), and tokenizer-aware budgeting (`format.ts`). It is
 * intra-unit retrieval: the same machinery `ensembleRetrieve` runs across units,
 * scoped to the chunks of one oversized unit.
 *
 * The query→reducer HEURISTIC (the "router" that auto-picks chunk vs summarize
 * per query) is NOT here — it is an untested hypothesis
 * (`reports/session-handoff.md`, backlog item 4). The assembler applies the
 * `chunk` default; a caller may name `summarize` or inject a custom `Reducer`,
 * but nothing in the package selects between them automatically.
 *
 * The vector arm of the ensemble is optional (`vectorRanking`): embeddings are
 * async and `assembleFlex` is synchronous, so the in-assembler path is BM25-only
 * — the same principled degradation `ensembleRetrieve` uses without an embedder.
 * A caller that has precomputed a chunk-level vector ranking can pass it to get
 * the full RRF ensemble.
 */
import type { Tokenizer } from '../contracts/index.js';
import { splitText, type ChunkOptions } from '../retrieve/chunk.js';
import { BM25 } from '../retrieve/bm25.js';
import { reciprocalRankFusion, DEFAULT_RRF_K } from '../retrieve/rrf.js';
import { truncateToTokens } from './format.js';

export type ReducerName = 'chunk' | 'summarize';

/** Default reducer: preserve detail (spec §"Reduce-on-overflow"). */
export const DEFAULT_REDUCER: ReducerName = 'chunk';

/** The oversized unit's content, as the assembler holds it. */
export interface ReduceInput {
  /** The unit's full raw text — what reduce-on-overflow shrinks. */
  raw: string;
  /** The unit's latched §8 summary, when present (the `summarize` reducer's target). */
  summary?: string;
}

export interface ReduceContext {
  /** The per-unit budget `b` in tokens: the result must fit within it. */
  budgetTokens: number;
  tokenizer: Tokenizer;
  /** The current task/query — drives chunk ranking. Absent → leading spans. */
  query?: string;
  chunkOptions?: ChunkOptions;
  rrfK?: number;
  /**
   * An optional chunk-level ranking from a vector arm (chunk indices as `${i}`,
   * best-first), fused with BM25 via RRF. Absent → BM25 only (sync assembler path).
   */
  vectorRanking?: readonly string[];
}

export type Reducer = (input: ReduceInput, ctx: ReduceContext) => string;

/**
 * A visible gap marker between kept spans, so the loss is not silent (§10 rule 4;
 * the surrounding summary blocks carry the `fetch` affordance). Kept
 * compact: it is charged against the per-unit budget once per elided run, so a
 * verbose marker would crowd out the content it is annotating.
 */
function gapMarker(droppedChunks: number): string {
  const n = droppedChunks;
  return `\n…[+${n} span${n === 1 ? '' : 's'} elided]…\n`;
}

/** Render kept chunk indices in DOCUMENT order, marking every elided run. */
function renderKept(chunks: readonly string[], kept: readonly number[]): string {
  const parts: string[] = [];
  let prev = -1;
  for (const i of kept) {
    const dropped = i - prev - 1;
    if (dropped > 0) parts.push(gapMarker(dropped));
    parts.push(chunks[i]!);
    prev = i;
  }
  const trailing = chunks.length - 1 - prev;
  if (trailing > 0) parts.push(gapMarker(trailing));
  return parts.join('');
}

/**
 * `chunk` reducer: intra-unit retrieval. Split the raw text, rank the chunks
 * against the query (BM25, fused with any vector ranking via RRF), then keep the
 * highest-ranked chunks that fit `budgetTokens` and emit them in DOCUMENT order
 * with the gaps between them marked. No query (and no vector ranking) → the
 * leading chunks, in order (deterministic head-preservation).
 */
export function reduceChunk(input: ReduceInput, ctx: ReduceContext): string {
  const { budgetTokens, tokenizer } = ctx;
  const text = input.raw;
  if (budgetTokens <= 0) return '';
  if (tokenizer.count(text) <= budgetTokens) return text;

  const chunks = splitText(text, ctx.chunkOptions);
  if (chunks.length <= 1) return truncateToTokens(text, budgetTokens, tokenizer);

  // Relevance order over chunk indices: RRF(BM25, [vector]) when there is a query,
  // else document order (leading spans).
  const query = ctx.query?.trim();
  let order: number[];
  if (query !== undefined && query !== '') {
    const corpus = chunks.map((c, i) => ({ id: String(i), text: c }));
    const bm25Ranking = new BM25(corpus).search(query).map((s) => s.id);
    const rankings = ctx.vectorRanking === undefined ? [bm25Ranking] : [bm25Ranking, ctx.vectorRanking];
    const fused = reciprocalRankFusion(rankings, ctx.rrfK ?? DEFAULT_RRF_K).map((s) => Number(s.id));
    // Chunks that no ranker scored fall to the back, in document order — every
    // chunk keeps a place so budget left over after the ranked ones still fills.
    const ranked = new Set(fused);
    order = [...fused, ...chunks.map((_, i) => i).filter((i) => !ranked.has(i))];
  } else {
    order = chunks.map((_, i) => i);
  }

  // Greedy fill by relevance, budget-checking the ACTUAL rendered output (markers
  // included) on every add — so the result fits by construction and never needs a
  // head-truncation that would keep a leading gap marker and drop the mid-document
  // span it annotates. Highest-relevance chunks are tried first; a lower one that
  // still fits is taken (best-effort fill), always emitted in document order.
  const kept: number[] = [];
  for (const idx of order) {
    const trial = [...kept, idx].sort((a, b) => a - b);
    if (tokenizer.count(renderKept(chunks, trial)) <= budgetTokens) kept.push(idx);
  }
  if (kept.length > 0) return renderKept(chunks, [...kept].sort((a, b) => a - b));

  // Even the single most-relevant span, wrapped in position markers, overflows
  // (budget ≈ one chunk). Keep that span, reserving room for the markers, and let
  // `truncateToTokens` clamp the span body — the loss stays visible either way.
  const top = order[0] ?? 0;
  const markerRoom = (top > 0 ? tokenizer.count(gapMarker(top)) : 0) + tokenizer.count(gapMarker(chunks.length - top));
  const body = truncateToTokens(chunks[top]!, Math.max(1, budgetTokens - markerRoom), tokenizer);
  const lead = top > 0 ? gapMarker(top) : '';
  const trail = top < chunks.length - 1 ? gapMarker(chunks.length - 1 - top) : '';
  return truncateToTokens(lead + body + trail, budgetTokens, tokenizer);
}

/**
 * `summarize` reducer: fold to the unit's latched §8 summary (gist), clamped to
 * budget. No summary yet (async latch pending) → fall back to `chunk` so an
 * oversized raw unit is still brought under budget rather than left to overflow.
 */
export function reduceSummarize(input: ReduceInput, ctx: ReduceContext): string {
  if (input.summary === undefined) return reduceChunk(input, ctx);
  return truncateToTokens(input.summary, ctx.budgetTokens, ctx.tokenizer);
}

const REDUCERS: Record<ReducerName, Reducer> = {
  chunk: reduceChunk,
  summarize: reduceSummarize,
};

/** Resolve a reducer name or a caller-supplied function to a `Reducer`. */
export function resolveReducer(reducer: ReducerName | Reducer = DEFAULT_REDUCER): Reducer {
  return typeof reducer === 'function' ? reducer : REDUCERS[reducer];
}
