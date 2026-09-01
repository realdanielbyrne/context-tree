/**
 * Hermetic ingestion (§7.1, D15): L0 + L2 + tree-sitter -> L1. `enrich` is the
 * optional post-pass and is exported separately because nothing structural may
 * depend on it, and `ingest` never calls it.
 */
export { openTaskStore, type TaskStore } from './task-store.js';
export { applySegmentation } from './apply.js';
export { nodeIdMinter, type NodeIdMinter } from './node-ids.js';
export {
  extractSpansForFileNodes,
  type FileSpanInput,
  type FileSpanStats,
} from './spans.js';
export {
  appendEvent,
  ingest,
  rebuild,
  type AppendResult,
  type IngestOptions,
  type IngestResult,
  type IngestStats,
  type RebuildResult,
} from './ingest.js';
export { enrich, type EnrichInput, type EnrichResult } from './enrich.js';
