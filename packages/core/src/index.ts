/**
 * @context-tree/core — public surface.
 *
 * Layer map (plan §5): L0 trace -> L2 blobs -> L1 SQLite tree -> L3 vectors ->
 * L4 markdown views, with L1/L3/L4 always derivable from L0 + L2 (D8).
 */

// contracts & config (no runtime deps)
export * from './contracts/index.js';
export * from './config.js';
export * from './paths.js';

// L0 / L2
export * from './trace/index.js';
export * from './blobs/index.js';

// L1 / L3
export * from './store/index.js';

// hermetic ingestion path (§7, §7.1, §12)
export * from './segment/index.js';
export * from './spans/index.js';
export * from './ingest/index.js';

// derived + model-facing
export * from './tokens/index.js';
export * from './cache/index.js';
export * from './models/index.js';
export * from './prompts/index.js';
export * from './summarize/index.js';
export * from './assemble/index.js';
export * from './retrieve/index.js';
export * from './providers/index.js';
export * from './render/index.js';
export * from './attention/index.js';
