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
export type {
  BeamFallbackReason,
  EmbedSummariesResult,
  FetchBranchOptions,
  FetchedBranch,
  QueryRewriter,
  SearchPath,
  SummaryEmbedder,
  SummaryHit,
  TreeSearchOptions,
  TreeSearchResult,
} from './types.js';
