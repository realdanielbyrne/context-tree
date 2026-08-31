/**
 * L1 DDL — plan §6, with the two controller-ruled additions:
 *  - `nodes.meta_json` (Ruling C5): §12 writes spans/symbols and §7.1 writes
 *    provenance-stamped enrichment onto the node itself.
 *  - a `meta` key/value table: schema version, L3 embedding dim, tokenizer id.
 *
 * There is deliberately no migration path in this file. D8 makes L1 a
 * deterministic function of L0 + L2, so a schema change is answered by deleting
 * `tree.db` and re-importing the trace — never by ALTER TABLE.
 */

/** Bumping this invalidates every existing `tree.db`; the store says "rebuild". */
export const SCHEMA_VERSION = 1;

export const META_SCHEMA_VERSION = 'schema_version';
export const META_EMBEDDING_DIM = 'embedding_dim';
/** '1' when the embeddings table is a sqlite-vec `vec0` table, '0' when it is the BLOB fallback. */
export const META_EMBEDDING_NATIVE = 'embedding_native';

/**
 * Creation order (Ruling C4): earliest L0 coverage first, ULID as tie-break, and
 * nodes with no coverage yet last. Zone B is emitted in exactly this order —
 * §10 rule 1 makes any reordering of the cached prefix a cache miss, so this
 * clause is load-bearing rather than cosmetic.
 */
export const ORDER_CREATION = 'ORDER BY span_start_seq IS NULL, span_start_seq, id';

export const L1_DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
  id                      TEXT PRIMARY KEY,
  parent_id               TEXT REFERENCES nodes(id),
  kind                    TEXT NOT NULL,
  title                   TEXT NOT NULL,
  phase_type              TEXT,
  span_start_seq          INTEGER,
  span_end_seq            INTEGER,
  status                  TEXT NOT NULL DEFAULT 'open',
  current_summary_version INTEGER NOT NULL DEFAULT 0,
  stale_since_seq         INTEGER,
  meta_json               TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS nodes_parent_idx   ON nodes(parent_id);
CREATE INDEX IF NOT EXISTS nodes_kind_idx     ON nodes(kind);
CREATE INDEX IF NOT EXISTS nodes_creation_idx ON nodes(span_start_seq, id);
CREATE INDEX IF NOT EXISTS nodes_stale_idx    ON nodes(stale_since_seq);

CREATE TABLE IF NOT EXISTS node_summaries (
  node_id    TEXT NOT NULL REFERENCES nodes(id),
  version    INTEGER NOT NULL,
  model      TEXT NOT NULL,
  text       TEXT NOT NULL,
  meta_json  TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (node_id, version)
);

CREATE TABLE IF NOT EXISTS node_links (
  from_id    TEXT NOT NULL REFERENCES nodes(id),
  to_id      TEXT NOT NULL REFERENCES nodes(id),
  kind       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id, kind)
);
`;

/**
 * L3, native path (Ruling C2). A plain BLOB column cannot serve `vec MATCH`, and
 * §9 needs KNN, so the table is a `vec0` virtual table created lazily at the
 * configured dim. `distance_metric=cosine` keeps the native and JS-fallback
 * distances numerically interchangeable.
 */
export function vec0EmbeddingsDdl(dim: number): string {
  return `CREATE VIRTUAL TABLE embeddings USING vec0(
  node_id TEXT,
  version INTEGER,
  vec float[${dim}] distance_metric=cosine
)`;
}

/** L3, degraded path (§18): sqlite-vec absent, so KNN is brute-forced in JS. */
export const FALLBACK_EMBEDDINGS_DDL = `CREATE TABLE embeddings (
  node_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  vec     BLOB NOT NULL,
  PRIMARY KEY (node_id, version)
)`;
