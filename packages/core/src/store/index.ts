/** L1 tree store + L3 vectors (plan §6). L1 is derived from L0 + L2 (D8). */
export {
  SqliteTreeStore,
  openInMemoryStore,
  openStore,
  type SqliteTreeStoreOptions,
} from './sqlite.js';
export {
  FALLBACK_EMBEDDINGS_DDL,
  L1_DDL,
  META_EMBEDDING_DIM,
  META_EMBEDDING_NATIVE,
  META_SCHEMA_VERSION,
  ORDER_CREATION,
  SCHEMA_VERSION,
  vec0EmbeddingsDdl,
} from './schema.js';
