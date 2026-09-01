/**
 * `TreeStore` on `better-sqlite3` (L1) with sqlite-vec for L3.
 *
 * Everything here is synchronous because ingestion (§7.1) is hermetic and has
 * one execution model end to end, and because L1 is derived (D8): the expensive
 * question — "is this node's summary current?" — is answered by a column, not by
 * a network call.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { load as loadVectorExtension } from 'sqlite-vec';
import { monotonicFactory } from 'ulid';
import { StoreInvariantError } from '../contracts/index.js';
import type {
  EmbeddingHit,
  LinkKind,
  NewNode,
  NewSummary,
  NodeId,
  NodeKind,
  NodeLink,
  NodeMeta,
  NodePatch,
  NodeStatus,
  NodeSummary,
  PhaseType,
  Seq,
  SummaryMeta,
  TreeNode,
  TreeStore,
} from '../contracts/index.js';
import {
  FALLBACK_EMBEDDINGS_DDL,
  L1_DDL,
  META_EMBEDDING_DIM,
  META_EMBEDDING_NATIVE,
  META_SCHEMA_VERSION,
  ORDER_CREATION,
  SCHEMA_VERSION,
  vec0EmbeddingsDdl,
} from './schema.js';

/**
 * Monotonic so that lexicographic id order equals mint order — the tie-break
 * half of Ruling C4's creation ordering. Module-scoped so two stores open in one
 * process can never mint a colliding id.
 */
const nextUlid = monotonicFactory();

interface NodeRow {
  id: string;
  parent_id: string | null;
  kind: string;
  title: string;
  phase_type: string | null;
  span_start_seq: number | null;
  span_end_seq: number | null;
  status: string;
  current_summary_version: number;
  stale_since_seq: number | null;
  meta_json: string;
}

interface SummaryRow {
  node_id: string;
  version: number;
  model: string;
  text: string;
  meta_json: string;
  created_at: string;
}

interface LinkRow {
  from_id: string;
  to_id: string;
  kind: string;
  created_at: string;
}

/** Columns `updateNode` may write, as a whitelist — the SET clause is built by hand. */
const PATCH_COLUMNS = [
  'parent_id',
  'title',
  'phase_type',
  'span_start_seq',
  'span_end_seq',
  'status',
  'meta_json',
] as const satisfies readonly (keyof NodePatch)[];

const NODE_COLUMNS =
  'id, parent_id, kind, title, phase_type, span_start_seq, span_end_seq, status, current_summary_version, stale_since_seq, meta_json';

function toNode(row: NodeRow): TreeNode {
  return {
    id: row.id,
    parent_id: row.parent_id,
    // Casts, not validation: every value in these columns was written through
    // the typed insert/update path below.
    kind: row.kind as NodeKind,
    title: row.title,
    phase_type: row.phase_type as PhaseType | null,
    span_start_seq: row.span_start_seq,
    span_end_seq: row.span_end_seq,
    status: row.status as NodeStatus,
    current_summary_version: row.current_summary_version,
    stale_since_seq: row.stale_since_seq,
    meta_json: JSON.parse(row.meta_json) as NodeMeta,
  };
}

function toSummary(row: SummaryRow): NodeSummary {
  return {
    node_id: row.node_id,
    version: row.version,
    model: row.model,
    text: row.text,
    meta: JSON.parse(row.meta_json) as SummaryMeta,
    created_at: row.created_at,
  };
}

function toLink(row: LinkRow): NodeLink {
  return { from_id: row.from_id, to_id: row.to_id, kind: row.kind as LinkKind, created_at: row.created_at };
}

/** Float32Array -> BLOB. Explicit, because an implicit copy here silently corrupts L3. */
function toBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/** BLOB -> Float32Array, read float-by-float: a Buffer's byteOffset need not be 4-aligned. */
function fromBlob(blob: Buffer): Float32Array {
  const out = new Float32Array(blob.byteLength / 4);
  for (let i = 0; i < out.length; i += 1) out[i] = blob.readFloatLE(i * 4);
  return out;
}

/** Matches `vec0(distance_metric=cosine)` so the two knn paths return the same numbers. */
function cosineDistance(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 1;
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Ties broken by id so knn output is reproducible across runs and across both paths. */
function byDistance(a: EmbeddingHit, b: EmbeddingHit): number {
  return a.distance - b.distance || a.node_id.localeCompare(b.node_id) || a.version - b.version;
}

function nowIso(): string {
  return new Date().toISOString();
}

export interface SqliteTreeStoreOptions {
  /**
   * Skips the sqlite-vec load, so `knn` takes the §18 brute-force path. Nothing
   * else can make that load fail in-process, and a degradation no test has ever
   * executed is a hope rather than a fallback — this is the seam that runs it.
   */
  forceBruteForceKnn?: boolean;
}

export class SqliteTreeStore implements TreeStore {
  readonly vectorSearchNative: boolean;
  private readonly stmts = new Map<string, Database.Statement<unknown[], unknown>>();

  constructor(
    private readonly db: Database.Database,
    options: SqliteTreeStoreOptions = {},
  ) {
    // §18: a missing extension degrades, it never hard-fails. The BLOB fallback
    // costs a linear scan, which is acceptable for one task's worth of nodes.
    if (options.forceBruteForceKnn === true) {
      this.vectorSearchNative = false;
      return;
    }
    try {
      loadVectorExtension(this.db);
      this.vectorSearchNative = true;
    } catch {
      this.vectorSearchNative = false;
    }
  }

  resetDerived(): void {
    // Order matters only for readability; foreign keys are declared but every
    // row goes, so there is no dangling reference at any point.
    this.transaction(() => {
      this.db.exec('DELETE FROM node_links');
      this.db.exec('DELETE FROM node_summaries');
      this.db.exec('DELETE FROM nodes');
      this.dropEmbeddings();
    });
  }

  migrate(): void {
    // §19 Q4: WAL is the working assumption for two agents on one tree.
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(L1_DDL);

    const recorded = this.getMeta(META_SCHEMA_VERSION);
    if (recorded === null) {
      this.setMeta(META_SCHEMA_VERSION, String(SCHEMA_VERSION));
      return;
    }
    if (Number(recorded) !== SCHEMA_VERSION) {
      throw new StoreInvariantError(
        `L1 schema version ${recorded} != ${SCHEMA_VERSION}. L1 is derived (D8): rebuild it — delete the db and re-import the trace. There is no migration path.`,
      );
    }
  }

  close(): void {
    this.stmts.clear();
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ── nodes ──────────────────────────────────────────────────────────────────

  insertNode(node: NewNode): TreeNode {
    const id = node.id ?? `n_${nextUlid()}`;
    return this.transaction(() => {
      if (this.getNode(id) !== null) {
        throw new StoreInvariantError(`node ${id} already exists`);
      }
      if (node.parent_id !== null && this.getNode(node.parent_id) === null) {
        throw new StoreInvariantError(`parent ${node.parent_id} does not exist`);
      }
      // §6: exactly one root per task DB, and §19 Q3 keeps one DB per task.
      if (node.kind === 'task' && this.root() !== null) {
        throw new StoreInvariantError('a task root already exists; one DB holds one task tree');
      }
      this.stmt(
        `INSERT INTO nodes (id, parent_id, kind, title, phase_type, span_start_seq, span_end_seq, status, meta_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        node.parent_id,
        node.kind,
        node.title,
        node.phase_type ?? null,
        node.span_start_seq ?? null,
        node.span_end_seq ?? null,
        node.status ?? 'open',
        JSON.stringify(node.meta_json ?? {}),
      );
      return this.requireNode(id);
    });
  }

  getNode(id: NodeId): TreeNode | null {
    const row = this.stmt<NodeRow>(`SELECT ${NODE_COLUMNS} FROM nodes WHERE id = ?`).get(id);
    return row ? toNode(row) : null;
  }

  updateNode(id: NodeId, patch: NodePatch): TreeNode {
    return this.transaction(() => {
      this.requireNode(id);
      if (patch.parent_id !== undefined && patch.parent_id !== null) {
        const parent = this.getNode(patch.parent_id);
        if (parent === null) throw new StoreInvariantError(`parent ${patch.parent_id} does not exist`);
        // ancestorPath includes the node itself, so this rejects both `parent = id`
        // and reparenting under a descendant — §6's forest invariant.
        if (this.ancestorPath(patch.parent_id).some((n) => n.id === id)) {
          throw new StoreInvariantError(`reparenting ${id} under ${patch.parent_id} would create a cycle`);
        }
      }

      const sets: string[] = [];
      const values: unknown[] = [];
      for (const column of PATCH_COLUMNS) {
        const value = patch[column];
        if (value === undefined) continue;
        sets.push(`${column} = ?`);
        values.push(column === 'meta_json' ? JSON.stringify(value) : value);
      }
      if (sets.length > 0) {
        this.stmt(`UPDATE nodes SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
      }
      return this.requireNode(id);
    });
  }

  mergeNodeMeta(id: NodeId, patch: Record<string, unknown>): TreeNode {
    return this.transaction(() => {
      const node = this.requireNode(id);
      // Shallow by contract: an array in `patch` replaces the stored array, so a
      // re-run of §12 span extraction overwrites rather than duplicates spans.
      const merged: NodeMeta = { ...node.meta_json, ...patch };
      this.stmt('UPDATE nodes SET meta_json = ? WHERE id = ?').run(JSON.stringify(merged), id);
      return this.requireNode(id);
    });
  }

  root(): TreeNode | null {
    const row = this.stmt<NodeRow>(
      `SELECT ${NODE_COLUMNS} FROM nodes WHERE kind = 'task' ${ORDER_CREATION} LIMIT 1`,
    ).get();
    return row ? toNode(row) : null;
  }

  children(parentId: NodeId | null): TreeNode[] {
    const rows =
      parentId === null
        ? this.stmt<NodeRow>(`SELECT ${NODE_COLUMNS} FROM nodes WHERE parent_id IS NULL ${ORDER_CREATION}`).all()
        : this.stmt<NodeRow>(`SELECT ${NODE_COLUMNS} FROM nodes WHERE parent_id = ? ${ORDER_CREATION}`).all(parentId);
    return rows.map(toNode);
  }

  descendants(id: NodeId): TreeNode[] {
    this.requireNode(id);
    const out: TreeNode[] = [];
    const walk = (parentId: NodeId): void => {
      for (const child of this.children(parentId)) {
        out.push(child);
        walk(child.id);
      }
    };
    walk(id);
    return out;
  }

  ancestorPath(id: NodeId): TreeNode[] {
    let node = this.requireNode(id);
    const path: TreeNode[] = [node];
    const seen = new Set<NodeId>([node.id]);
    while (node.parent_id !== null) {
      const parent = this.getNode(node.parent_id);
      if (parent === null) throw new StoreInvariantError(`node ${node.id} references missing parent ${node.parent_id}`);
      // Insert/update reject cycles, so this only fires on a corrupted db — but
      // without it a corrupted db hangs the summarizer's cascade instead.
      if (seen.has(parent.id)) throw new StoreInvariantError(`cycle in parent chain at ${parent.id}`);
      seen.add(parent.id);
      path.push(parent);
      node = parent;
    }
    return path.reverse();
  }

  nodesInCreationOrder(): TreeNode[] {
    return this.stmt<NodeRow>(`SELECT ${NODE_COLUMNS} FROM nodes ${ORDER_CREATION}`).all().map(toNode);
  }

  byKind(kind: NodeKind): TreeNode[] {
    return this.stmt<NodeRow>(`SELECT ${NODE_COLUMNS} FROM nodes WHERE kind = ? ${ORDER_CREATION}`)
      .all(kind)
      .map(toNode);
  }

  openPhase(): TreeNode | null {
    // The segmenter closes a phase before opening the next, so at most one is
    // open; take the newest anyway so a torn write can't strand us on an old one.
    const rows = this.stmt<NodeRow>(
      `SELECT ${NODE_COLUMNS} FROM nodes WHERE kind = 'phase' AND status = 'open' ${ORDER_CREATION}`,
    ).all();
    const last = rows.at(-1);
    return last ? toNode(last) : null;
  }

  findFileNode(parentId: NodeId, path: string): TreeNode | null {
    const row = this.stmt<NodeRow>(
      `SELECT ${NODE_COLUMNS} FROM nodes
       WHERE parent_id = ? AND kind = 'file' AND json_extract(meta_json, '$.path') = ?
       ${ORDER_CREATION} LIMIT 1`,
    ).get(parentId, path);
    return row ? toNode(row) : null;
  }

  extendSpan(id: NodeId, seq: Seq): TreeNode {
    return this.transaction(() => {
      this.requireNode(id);
      // §7 appends a re-edit of the same file to the same file node, so coverage
      // widens instead of a second node appearing.
      this.stmt(
        `UPDATE nodes
         SET span_start_seq = COALESCE(span_start_seq, ?),
             span_end_seq   = MAX(COALESCE(span_end_seq, ?), ?)
         WHERE id = ?`,
      ).run(seq, seq, seq, id);
      return this.requireNode(id);
    });
  }

  // ── staleness (D4) ─────────────────────────────────────────────────────────

  markStale(id: NodeId, seq: Seq): void {
    this.requireNode(id);
    // Keep the EARLIEST unsummarized change: that seq is what the next summary
    // has to cover, so a later append must not narrow it.
    this.stmt(
      'UPDATE nodes SET stale_since_seq = ? WHERE id = ? AND (stale_since_seq IS NULL OR stale_since_seq > ?)',
    ).run(seq, id, seq);
  }

  setStale(id: NodeId, seq: Seq | null): void {
    this.requireNode(id);
    // Unlike `markStale` this can raise the mark or clear it, which is why the
    // contract reserves it for reconciliation by a derived-layer rebuild (D8):
    // raising a mark on the incremental path could skip unsummarized content.
    this.stmt('UPDATE nodes SET stale_since_seq = ? WHERE id = ?').run(seq, id);
  }

  markStaleCascade(id: NodeId, seq: Seq): NodeId[] {
    return this.transaction(() => {
      // D4: leaf + ancestors only. Touching siblings is what turns an amortized
      // 1-3 summarizer calls per turn into a full re-summarization.
      const leafToRoot = this.ancestorPath(id).reverse();
      for (const node of leafToRoot) this.markStale(node.id, seq);
      return leafToRoot.map((node) => node.id);
    });
  }

  staleNodes(): TreeNode[] {
    return this.stmt<NodeRow>(`SELECT ${NODE_COLUMNS} FROM nodes WHERE stale_since_seq IS NOT NULL ${ORDER_CREATION}`)
      .all()
      .map(toNode);
  }

  // ── summaries (D3) ─────────────────────────────────────────────────────────

  putSummary(summary: NewSummary): NodeSummary {
    return this.transaction(() => {
      const node = this.requireNode(summary.node_id);
      // D3: append version n+1. The history is the audit trail of what the model
      // actually saw, so an existing row is never updated.
      const version = node.current_summary_version + 1;
      const created_at = summary.created_at ?? nowIso();
      this.stmt(
        `INSERT INTO node_summaries (node_id, version, model, text, meta_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(summary.node_id, version, summary.model, summary.text, JSON.stringify(summary.meta), created_at);
      this.stmt('UPDATE nodes SET current_summary_version = ?, stale_since_seq = NULL WHERE id = ?').run(
        version,
        summary.node_id,
      );
      return {
        node_id: summary.node_id,
        version,
        model: summary.model,
        text: summary.text,
        meta: summary.meta,
        created_at,
      };
    });
  }

  currentSummary(id: NodeId): NodeSummary | null {
    const node = this.getNode(id);
    if (node === null || node.current_summary_version === 0) return null;
    return this.summaryVersion(id, node.current_summary_version);
  }

  summaryVersion(id: NodeId, version: number): NodeSummary | null {
    const row = this.stmt<SummaryRow>('SELECT * FROM node_summaries WHERE node_id = ? AND version = ?').get(
      id,
      version,
    );
    return row ? toSummary(row) : null;
  }

  summaryVersions(id: NodeId): NodeSummary[] {
    return this.stmt<SummaryRow>('SELECT * FROM node_summaries WHERE node_id = ? ORDER BY version')
      .all(id)
      .map(toSummary);
  }

  // ── links (D10) ────────────────────────────────────────────────────────────

  putLink(link: { from_id: NodeId; to_id: NodeId; kind: LinkKind; created_at?: string }): NodeLink {
    const created_at = link.created_at ?? nowIso();
    return this.transaction(() => {
      this.requireNode(link.from_id);
      this.requireNode(link.to_id);
      this.stmt(
        `INSERT INTO node_links (from_id, to_id, kind, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (from_id, to_id, kind) DO UPDATE SET created_at = excluded.created_at`,
      ).run(link.from_id, link.to_id, link.kind, created_at);
      return { from_id: link.from_id, to_id: link.to_id, kind: link.kind, created_at };
    });
  }

  linksFrom(id: NodeId): NodeLink[] {
    return this.stmt<LinkRow>('SELECT * FROM node_links WHERE from_id = ? ORDER BY created_at, to_id, kind')
      .all(id)
      .map(toLink);
  }

  linksTo(id: NodeId): NodeLink[] {
    return this.stmt<LinkRow>('SELECT * FROM node_links WHERE to_id = ? ORDER BY created_at, from_id, kind')
      .all(id)
      .map(toLink);
  }

  // ── L3 embeddings (disposable) ─────────────────────────────────────────────

  embeddingDim(): number | null {
    const raw = this.getMeta(META_EMBEDDING_DIM);
    return raw === null ? null : Number(raw);
  }

  putEmbedding(id: NodeId, version: number, vec: Float32Array): void {
    this.ensureEmbeddingsTable(vec.length);
    const blob = toBlob(vec);
    this.transaction(() => {
      // vec0 does not enforce uniqueness on metadata columns, so the §6
      // `PRIMARY KEY (node_id, version)` semantics are delete-then-insert here.
      this.stmt('DELETE FROM embeddings WHERE node_id = ? AND version = ?').run(id, BigInt(version));
      this.stmt('INSERT INTO embeddings (node_id, version, vec) VALUES (?, ?, ?)').run(id, BigInt(version), blob);
    });
  }

  knn(vec: Float32Array, k: number): EmbeddingHit[] {
    const dim = this.embeddingDim();
    // L3 is optional: nothing embedded yet is an empty result, not an error.
    if (k <= 0 || dim === null) return [];
    if (vec.length !== dim) {
      throw new StoreInvariantError(`query vector has dim ${vec.length}, embeddings table has ${dim}`);
    }
    const hits = this.vectorSearchNative ? this.knnNative(vec, k) : this.knnBruteForce(vec);
    return hits.sort(byDistance).slice(0, k);
  }

  dropEmbeddings(): void {
    // L3 is disposable (D8): dropping it also drops the recorded dim so the next
    // putEmbedding may legitimately rebuild at a different width.
    this.stmts.clear();
    this.db.exec('DROP TABLE IF EXISTS embeddings');
    this.stmt('DELETE FROM meta WHERE key IN (?, ?)').run(META_EMBEDDING_DIM, META_EMBEDDING_NATIVE);
  }

  // ── key/value meta ─────────────────────────────────────────────────────────

  getMeta(key: string): string | null {
    const row = this.stmt<{ value: string }>('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? row.value : null;
  }

  setMeta(key: string, value: string): void {
    this.stmt('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(
      key,
      value,
    );
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Lazy, memoized prepare. Statements outlive schema changes except a table DROP. */
  private stmt<R = unknown>(sql: string): Database.Statement<unknown[], R> {
    let prepared = this.stmts.get(sql);
    if (prepared === undefined) {
      prepared = this.db.prepare(sql);
      this.stmts.set(sql, prepared);
    }
    return prepared as Database.Statement<unknown[], R>;
  }

  private requireNode(id: NodeId): TreeNode {
    const node = this.getNode(id);
    if (node === null) throw new StoreInvariantError(`unknown node ${id}`);
    return node;
  }

  private ensureEmbeddingsTable(dim: number): void {
    const recorded = this.embeddingDim();
    if (recorded === null) {
      this.db.exec(this.vectorSearchNative ? vec0EmbeddingsDdl(dim) : FALLBACK_EMBEDDINGS_DDL);
      this.setMeta(META_EMBEDDING_DIM, String(dim));
      this.setMeta(META_EMBEDDING_NATIVE, this.vectorSearchNative ? '1' : '0');
      return;
    }
    if (recorded !== dim) {
      throw new StoreInvariantError(
        `embeddings table is dim ${recorded}, got a dim-${dim} vector; L3 is disposable — dropEmbeddings() and re-embed`,
      );
    }
    // Reopening a vec0 db on a host without the extension (or vice versa) leaves
    // an unreadable table; say so rather than fail cryptically at query time.
    if ((this.getMeta(META_EMBEDDING_NATIVE) === '1') !== this.vectorSearchNative) {
      throw new StoreInvariantError(
        `embeddings table was built ${this.vectorSearchNative ? 'without' : 'with'} sqlite-vec but this process loaded it ${this.vectorSearchNative ? 'with' : 'without'}; dropEmbeddings() and re-embed`,
      );
    }
  }

  private knnNative(vec: Float32Array, k: number): EmbeddingHit[] {
    return this.stmt<{ node_id: string; version: number; distance: number }>(
      'SELECT node_id, version, distance FROM embeddings WHERE vec MATCH ? AND k = ? ORDER BY distance',
    )
      .all(toBlob(vec), BigInt(k))
      .map((row) => ({ node_id: row.node_id, version: row.version, distance: row.distance }));
  }

  private knnBruteForce(vec: Float32Array): EmbeddingHit[] {
    return this.stmt<{ node_id: string; version: number; vec: Buffer }>(
      'SELECT node_id, version, vec FROM embeddings',
    )
      .all()
      .map((row) => ({
        node_id: row.node_id,
        version: row.version,
        distance: cosineDistance(vec, fromBlob(row.vec)),
      }));
  }
}

/** Opens (creating parent dirs) and migrates the L1/L3 db at `path`. */
export function openStore(path: string): SqliteTreeStore {
  mkdirSync(dirname(path), { recursive: true });
  const store = new SqliteTreeStore(new Database(path));
  try {
    store.migrate();
  } catch (error) {
    // A schema-version refusal must not leak the file handle the caller never got.
    store.close();
    throw error;
  }
  return store;
}

/** Migrated, throwaway store — the default for tests and for `rebuild --dry-run`. */
export function openInMemoryStore(options: SqliteTreeStoreOptions = {}): SqliteTreeStore {
  const store = new SqliteTreeStore(new Database(':memory:'), options);
  store.migrate();
  return store;
}
