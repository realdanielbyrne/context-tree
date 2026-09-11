/**
 * `retrieve/` — the tree-side read paths behind §9's three read tools:
 * collapsed-tree (RAPTOR) retrieval over L3, the lexical beam-search fallback
 * for when L3 is absent, and narrow expansion through `fetchBranch` / `peek`.
 *
 * The mnemonic from §7.1 applies in reverse here: ingestion produces
 * coordinates, retrieval answers questions. Nothing in this module writes L0,
 * L1 or L2 — only L3, which is disposable (D8).
 */
export { TreeRetriever, type TreeRetrieverDeps } from './retriever.js';
export { createVectorProvider } from './vector-provider.js';
export { excerptAround } from './excerpt.js';
// Current (RRF ensemble) retriever — replaces the summary-ranking + IDF path.
export { splitText, chunkUnits, DEFAULT_CHUNK_SIZE, DEFAULT_CHUNK_OVERLAP, type ChunkOptions, type UnitChunk } from './chunk.js';
export { BM25, tokenize, BM25_K1, BM25_B, type Scored } from './bm25.js';
export { reciprocalRankFusion, DEFAULT_RRF_K } from './rrf.js';
export {
  ensembleRetrieve,
  type EnsembleUnit,
  type EnsembleOptions,
  type RetrievedUnit,
} from './ensemble.js';
export type {
  BeamFallbackReason,
  EmbedSummariesResult,
  EventHit,
  EventSearchOptions,
  EventSearchResult,
  FetchBranchOptions,
  FetchedBranch,
  QueryRewriter,
  SearchPath,
  SummaryEmbedder,
  SummaryHit,
  TreeSearchOptions,
  TreeSearchResult,
} from './types.js';
