/**
 * L1 store interface. Synchronous (`better-sqlite3`) so the hermetic ingestion
 * path (§7.1) has one execution model end to end.
 *
 * L1 is *derived*: it is always a deterministic function of L0 + L2 (D8), so it
 * is rebuilt, never migrated (see `rebuild()` in `ingest/`).
 */
import type { NodeId, Seq } from './ids.js';
import type {
  EmbeddingHit,
  LinkKind,
  NewNode,
  NewSummary,
  NodeKind,
  NodeLink,
  NodePatch,
  NodeSummary,
  TreeNode,
} from './tree.js';

export interface TreeStore {
  /** Creates tables and indexes if absent. Idempotent. */
  migrate(): void;
  close(): void;
  /** Runs `fn` inside one SQLite transaction; rolls back on throw. */
  transaction<T>(fn: () => T): T;

  /**
   * Deletes every derived L1/L3 row — nodes, summaries, links, embeddings —
   * leaving the schema and the `meta` table intact.
   *
   * This is a replay primitive, not a migration (D8): when a re-segmentation no
   * longer produces a node L1 holds, the positional key scheme (`phase:<i>`)
   * means the whole key -> id mapping is invalid, so the only correct answer is
   * to re-derive L1 from L0 + L2. Reconciling a shrunk tree in place would
   * leave ids bound to the wrong branches.
   */
  resetDerived(): void;

  // ── nodes ────────────────────────────────────────────────────────────────
  insertNode(node: NewNode): TreeNode;
  getNode(id: NodeId): TreeNode | null;
  updateNode(id: NodeId, patch: NodePatch): TreeNode;
  /** Merges `patch` into `meta_json`; arrays in `patch` replace, they do not concat. */
  mergeNodeMeta(id: NodeId, patch: Record<string, unknown>): TreeNode;
  /** The single `kind: 'task'` node, or null on an empty DB. */
  root(): TreeNode | null;
  children(parentId: NodeId | null): TreeNode[];
  /** Depth-first, creation-ordered, excluding `id` itself. */
  descendants(id: NodeId): TreeNode[];
  /** Root-first path down to and including `id`. */
  ancestorPath(id: NodeId): TreeNode[];
  /**
   * All nodes in creation order — `ORDER BY span_start_seq, id` (Ruling C4).
   * This is the order Zone B must use (§10 rule 1); never relevance order.
   */
  nodesInCreationOrder(): TreeNode[];
  byKind(kind: NodeKind): TreeNode[];
  /** The open phase node, if one is open. */
  openPhase(): TreeNode | null;
  /** File node under `parentId` keyed by `path`, or null. */
  findFileNode(parentId: NodeId, path: string): TreeNode | null;
  /** Widens `span_end_seq` (and `span_start_seq` when unset) to cover `seq`. */
  extendSpan(id: NodeId, seq: Seq): TreeNode;

  // ── staleness (D4) ───────────────────────────────────────────────────────
  /** Marks `id` stale at `seq` if it is not already stale at an earlier seq. */
  markStale(id: NodeId, seq: Seq): void;
  /**
   * *Sets* the mark to `seq`, raising it if it was lower, or clears it with
   * `null`. Reserved for a derived-layer reconciliation — the append path
   * re-segments and has to write the mark a fresh derivation from the same L0
   * would produce (D8), which `markStale` cannot do because it keeps the
   * earliest seq.
   *
   * `markStale` stays the only incremental primitive (earliest-wins, the D4
   * path): a summarizer that could raise a mark could skip content that was
   * never summarized, which is precisely the failure D4 exists to prevent.
   */
  setStale(id: NodeId, seq: Seq | null): void;
  /** Marks `id` and every ancestor stale — the §8 cascade's write half. */
  markStaleCascade(id: NodeId, seq: Seq): NodeId[];
  staleNodes(): TreeNode[];

  // ── summaries (D3: versioned, never overwritten) ─────────────────────────
  /**
   * Appends version `current_summary_version + 1`, bumps the pointer, and
   * clears `stale_since_seq`. Never updates an existing row.
   */
  putSummary(summary: NewSummary): NodeSummary;
  currentSummary(id: NodeId): NodeSummary | null;
  summaryVersion(id: NodeId, version: number): NodeSummary | null;
  /** Ascending by version — the audit trail of what the model actually saw. */
  summaryVersions(id: NodeId): NodeSummary[];

  // ── links (D10) ──────────────────────────────────────────────────────────
  putLink(link: { from_id: NodeId; to_id: NodeId; kind: LinkKind; created_at?: string }): NodeLink;
  linksFrom(id: NodeId): NodeLink[];
  linksTo(id: NodeId): NodeLink[];

  // ── L3 embeddings (disposable) ───────────────────────────────────────────
  /** True when sqlite-vec loaded; false means `knn` uses the JS fallback. */
  readonly vectorSearchNative: boolean;
  /** Dimension the embeddings table was created with, or null if unused. */
  embeddingDim(): number | null;
  putEmbedding(id: NodeId, version: number, vec: Float32Array): void;
  knn(vec: Float32Array, k: number): EmbeddingHit[];
  dropEmbeddings(): void;

  // ── key/value meta ───────────────────────────────────────────────────────
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
}
