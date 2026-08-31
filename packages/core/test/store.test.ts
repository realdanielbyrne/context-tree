import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { StoreInvariantError } from '../src/contracts/index.js';
import type { NodeSummary, SummaryMeta, TreeNode } from '../src/contracts/index.js';
import {
  META_SCHEMA_VERSION,
  openInMemoryStore,
  openStore,
  type SqliteTreeStore,
} from '../src/store/index.js';

function summaryMeta(overrides: Partial<SummaryMeta> = {}): SummaryMeta {
  return {
    files: [],
    symbols: [],
    tests: [],
    artifacts: [],
    open_questions: [],
    decisions: [],
    node_ids: [],
    ...overrides,
  };
}

/**
 * root(task) -> p1(diagnosis) -> f1(file), and root -> p2(implementation) -> f2(file).
 * Two branches is the minimum shape that can prove the D4 cascade skips siblings.
 */
interface Fixture {
  store: SqliteTreeStore;
  root: TreeNode;
  p1: TreeNode;
  f1: TreeNode;
  p2: TreeNode;
  f2: TreeNode;
}

function fixture(store: SqliteTreeStore = openInMemoryStore()): Fixture {
  const root = store.insertNode({ parent_id: null, kind: 'task', title: 'fix pricing', span_start_seq: 1 });
  const p1 = store.insertNode({
    parent_id: root.id,
    kind: 'phase',
    title: 'diagnose',
    phase_type: 'diagnosis',
    span_start_seq: 2,
    span_end_seq: 9,
  });
  const f1 = store.insertNode({
    parent_id: p1.id,
    kind: 'file',
    title: 'pricing.go',
    span_start_seq: 3,
    span_end_seq: 3,
    meta_json: { path: 'pricing.go' },
  });
  const p2 = store.insertNode({
    parent_id: root.id,
    kind: 'phase',
    title: 'implement',
    phase_type: 'implementation',
    span_start_seq: 10,
  });
  const f2 = store.insertNode({
    parent_id: p2.id,
    kind: 'file',
    title: 'billing.go',
    span_start_seq: 11,
    span_end_seq: 11,
    meta_json: { path: 'billing.go' },
  });
  return { store, root, p1, f1, p2, f2 };
}

function tmpDb(name = 'tree.db'): string {
  return join(mkdtempSync(join(tmpdir(), 'ct-store-')), name);
}

describe('schema and pragmas', () => {
  it('runs in WAL so two agents can share one tree (§19 Q4)', () => {
    const path = tmpDb();
    const store = openStore(path);
    store.insertNode({ parent_id: null, kind: 'task', title: 't' });
    store.close();

    // WAL is recorded in the file header, so a second connection sees it.
    const probe = new Database(path);
    expect(probe.pragma('journal_mode', { simple: true })).toBe('wal');
    probe.close();
  });

  it('is idempotent on migrate() because import re-opens the same db every run', () => {
    const store = openInMemoryStore();
    const root = store.insertNode({ parent_id: null, kind: 'task', title: 't' });
    store.migrate();
    store.migrate();
    expect(store.getNode(root.id)?.title).toBe('t');
  });

  it('refuses a db written by another schema version instead of migrating it (D8)', () => {
    const path = tmpDb();
    const first = openStore(path);
    // D8: L1 is a derived layer, so the answer to a version skew is "rebuild",
    // and a data migration would be a bug, not a feature.
    first.setMeta(META_SCHEMA_VERSION, '999');
    first.close();
    expect(() => openStore(path)).toThrow(StoreInvariantError);
    expect(() => openStore(path)).toThrow(/rebuild/);
  });
});

describe('node invariants (§6)', () => {
  it('rejects a second task root because one db holds exactly one task tree (§19 Q3)', () => {
    const store = openInMemoryStore();
    store.insertNode({ parent_id: null, kind: 'task', title: 'first' });
    expect(() => store.insertNode({ parent_id: null, kind: 'task', title: 'second' })).toThrow(StoreInvariantError);
    expect(store.byKind('task')).toHaveLength(1);
  });

  it('rejects reparenting a node under its own descendant, keeping parent_id a forest', () => {
    const { store, p1, f1 } = fixture();
    // A cycle here would make ancestorPath — and therefore the D4 cascade — never
    // terminate, so this is rejected at the write, not tolerated at the read.
    expect(() => store.updateNode(p1.id, { parent_id: f1.id })).toThrow(StoreInvariantError);
    expect(() => store.updateNode(p1.id, { parent_id: p1.id })).toThrow(StoreInvariantError);
    expect(store.getNode(p1.id)?.parent_id).toBe(store.root()?.id);
  });

  it('rejects a duplicate id and an unknown parent, so no node is orphaned or overwritten', () => {
    const { store, root } = fixture();
    expect(() => store.insertNode({ id: root.id, parent_id: null, kind: 'turn', title: 'dup' })).toThrow(
      StoreInvariantError,
    );
    expect(() => store.insertNode({ parent_id: 'n_missing', kind: 'turn', title: 'orphan' })).toThrow(
      StoreInvariantError,
    );
  });

  it('mints n_ + monotonic ULID ids so lexicographic id order is mint order (Ruling C4 tie-break)', () => {
    const store = openInMemoryStore();
    const root = store.insertNode({ parent_id: null, kind: 'task', title: 't' });
    const ids = [1, 2, 3].map((n) => store.insertNode({ parent_id: root.id, kind: 'turn', title: `turn ${n}` }).id);
    expect(ids.every((id) => id.startsWith('n_'))).toBe(true);
    expect([...ids].sort()).toEqual(ids);
  });
});

describe('creation order (Ruling C4, §10 rule 1)', () => {
  it('orders by span_start_seq with unspanned nodes last, because Zone B is never reordered', () => {
    const store = openInMemoryStore();
    const root = store.insertNode({ parent_id: null, kind: 'task', title: 't', span_start_seq: 1 });
    // Deliberately inserted out of seq order: a node with no L0 coverage yet
    // (a freshly opened phase) must not jump ahead of covered branches in the
    // cached prefix, and covered branches must appear in trace order.
    const late = store.insertNode({ parent_id: root.id, kind: 'phase', title: 'late', span_start_seq: 40 });
    const unspannedA = store.insertNode({ parent_id: root.id, kind: 'phase', title: 'unspanned a' });
    const early = store.insertNode({ parent_id: root.id, kind: 'phase', title: 'early', span_start_seq: 5 });
    const unspannedB = store.insertNode({ parent_id: root.id, kind: 'phase', title: 'unspanned b' });

    expect(store.nodesInCreationOrder().map((n) => n.id)).toEqual([
      root.id,
      early.id,
      late.id,
      unspannedA.id,
      unspannedB.id,
    ]);
    // Same ordering inside a sibling set — children() feeds the same prefix.
    expect(store.children(root.id).map((n) => n.title)).toEqual(['early', 'late', 'unspanned a', 'unspanned b']);
  });

  it('walks descendants depth-first in creation order so a rendered branch reads top-down', () => {
    const { store, root, p1, f1, p2, f2 } = fixture();
    expect(store.descendants(root.id).map((n) => n.id)).toEqual([p1.id, f1.id, p2.id, f2.id]);
    expect(store.ancestorPath(f2.id).map((n) => n.id)).toEqual([root.id, p2.id, f2.id]);
  });

  it('returns the newest open phase and finds a file node by its meta path (§7 keying)', () => {
    const { store, p1, p2, f2 } = fixture();
    expect(store.openPhase()?.id).toBe(p2.id);
    store.updateNode(p2.id, { status: 'closed' });
    expect(store.openPhase()?.id).toBe(p1.id);
    expect(store.findFileNode(p2.id, 'billing.go')?.id).toBe(f2.id);
    expect(store.findFileNode(p1.id, 'billing.go')).toBeNull();
  });
});

describe('spans are coordinates, not content (§6)', () => {
  it('widens an existing file node on re-edit instead of needing a second node (§7)', () => {
    const { store, f1 } = fixture();
    // §7 appends a re-edit of the same path to the same file node, so coverage
    // has to grow; a new node per edit would fragment the branch summary.
    const widened = store.extendSpan(f1.id, 20);
    expect(widened.span_start_seq).toBe(3);
    expect(widened.span_end_seq).toBe(20);
    // An earlier seq must not shrink the covered range.
    expect(store.extendSpan(f1.id, 7).span_end_seq).toBe(20);
  });

  it('sets span_start_seq on the first append to an as-yet-uncovered node', () => {
    const store = openInMemoryStore();
    const root = store.insertNode({ parent_id: null, kind: 'task', title: 't' });
    const turn = store.insertNode({ parent_id: root.id, kind: 'turn', title: 'turn' });
    expect(turn.span_start_seq).toBeNull();
    const covered = store.extendSpan(turn.id, 12);
    expect(covered.span_start_seq).toBe(12);
    expect(covered.span_end_seq).toBe(12);
  });
});

describe('meta_json (Ruling C5)', () => {
  it('round-trips spans, annotations and enrichment, with arrays replacing not concatenating', () => {
    const { store, f1 } = fixture();
    const withSpans = store.mergeNodeMeta(f1.id, {
      spans: [{ path: 'pricing.go', start_line: 142, end_line: 168, symbol: 'Quote', kind: 'function_declaration' }],
      symbols: ['Quote'],
    });
    expect(withSpans.meta_json.spans?.[0]?.end_line).toBe(168);
    // The §12 span pass is re-runnable on rebuild, so a second write must not
    // accumulate duplicate spans.
    const respanned = store.mergeNodeMeta(f1.id, {
      spans: [{ path: 'pricing.go', start_line: 200, end_line: 210, degraded: true }],
    });
    expect(respanned.meta_json.spans).toHaveLength(1);
    expect(respanned.meta_json.spans?.[0]?.degraded).toBe(true);
    // A merge must not drop keys written by a different pass (§7.1 enrichment is
    // additive and provenance-stamped; annotations come from the `annotate` tool).
    expect(respanned.meta_json.symbols).toEqual(['Quote']);
    expect(respanned.meta_json.path).toBe('pricing.go');

    const enriched = store.mergeNodeMeta(f1.id, {
      annotations: [{ seq: 33, text: 'root cause lives here', created_at: '2026-08-31T12:00:00Z' }],
      enrichment: [{ provider: 'graft', timestamp: '2026-08-31T12:00:01Z', kind: 'callers', data: ['Quote'] }],
    });
    expect(enriched.meta_json.annotations?.[0]?.seq).toBe(33);
    expect(enriched.meta_json.enrichment?.[0]?.provider).toBe('graft');
    expect(enriched.meta_json.spans).toHaveLength(1);
  });
});

describe('staleness cascade (D4)', () => {
  it('marks the leaf and every ancestor, and no sibling', () => {
    const { store, root, p1, f1, p2, f2 } = fixture();
    // D4's amortized 1-3 summarizer calls per turn depends on exactly this: a
    // sibling branch that did not change is not re-summarized.
    const touched = store.markStaleCascade(f1.id, 12);
    expect(touched).toEqual([f1.id, p1.id, root.id]);
    expect(store.staleNodes().map((n) => n.id).sort()).toEqual([root.id, f1.id, p1.id].sort());
    expect(store.getNode(p2.id)?.stale_since_seq).toBeNull();
    expect(store.getNode(f2.id)?.stale_since_seq).toBeNull();
  });

  it('keeps the earliest unsummarized seq, because that is what the next summary must cover', () => {
    const { store, f1 } = fixture();
    store.markStale(f1.id, 30);
    store.markStale(f1.id, 12);
    expect(store.getNode(f1.id)?.stale_since_seq).toBe(12);
    // A later append cannot narrow the window.
    store.markStale(f1.id, 44);
    expect(store.getNode(f1.id)?.stale_since_seq).toBe(12);
  });

  it('refuses to mark an unknown node rather than silently no-op', () => {
    const { store } = fixture();
    expect(() => store.markStale('n_missing', 1)).toThrow(StoreInvariantError);
    expect(() => store.markStaleCascade('n_missing', 1)).toThrow(StoreInvariantError);
  });
});

describe('summaries (D3)', () => {
  it('appends a new version instead of overwriting, keeping the audit trail of what the model saw', () => {
    const { store, p1 } = fixture();
    const v1 = store.putSummary({
      node_id: p1.id,
      model: 'claude-haiku-4-5-20251001',
      text: 'looked at pricing.go',
      meta: summaryMeta({ open_questions: ['is rounding the bug?'] }),
      created_at: '2026-08-31T12:00:00Z',
    });
    const v2 = store.putSummary({
      node_id: p1.id,
      model: 'claude-sonnet-5',
      text: 'rounding in Quote is the bug',
      meta: summaryMeta({ decisions: ['round half-up'] }),
      created_at: '2026-08-31T12:05:00Z',
    });

    expect([v1.version, v2.version]).toEqual([1, 2]);
    expect(store.getNode(p1.id)?.current_summary_version).toBe(2);
    expect(store.currentSummary(p1.id)?.text).toBe('rounding in Quote is the bug');
    // The superseded row is still readable — that is the whole point of D3.
    expect(store.summaryVersion(p1.id, 1)?.text).toBe('looked at pricing.go');
    expect(store.summaryVersions(p1.id).map((s: NodeSummary) => s.version)).toEqual([1, 2]);
    expect(store.summaryVersion(p1.id, 1)?.meta.open_questions).toEqual(['is rounding the bug?']);
    expect(store.summaryVersion(p1.id, 1)?.model).toBe('claude-haiku-4-5-20251001');
  });

  it('clears stale_since_seq, because the new version is what closes the D4 cascade', () => {
    const { store, p1, root } = fixture();
    store.markStaleCascade(p1.id, 12);
    store.putSummary({ node_id: p1.id, model: 'm', text: 'fresh', meta: summaryMeta() });
    expect(store.getNode(p1.id)?.stale_since_seq).toBeNull();
    // The ancestor is still stale: summarizing a leaf does not make the root current.
    expect(store.getNode(root.id)?.stale_since_seq).toBe(12);
  });

  it('reports no current summary before the first version, so the assembler never renders a stub', () => {
    const { store, p2 } = fixture();
    expect(store.getNode(p2.id)?.current_summary_version).toBe(0);
    expect(store.currentSummary(p2.id)).toBeNull();
    expect(store.summaryVersions(p2.id)).toEqual([]);
  });
});

describe('links (D10)', () => {
  it('records lateral edges in both directions and stays idempotent on re-link', () => {
    const { store, p1, p2 } = fixture();
    store.putLink({ from_id: p1.id, to_id: p2.id, kind: 'superseded_by', created_at: '2026-08-31T12:00:00Z' });
    store.putLink({ from_id: p1.id, to_id: p2.id, kind: 'superseded_by', created_at: '2026-08-31T13:00:00Z' });
    expect(store.linksFrom(p1.id)).toEqual([
      { from_id: p1.id, to_id: p2.id, kind: 'superseded_by', created_at: '2026-08-31T13:00:00Z' },
    ]);
    expect(store.linksTo(p2.id).map((l) => l.from_id)).toEqual([p1.id]);
    expect(() => store.putLink({ from_id: p1.id, to_id: 'n_missing', kind: 'relates_to' })).toThrow(
      StoreInvariantError,
    );
  });
});

describe('L3 embeddings (disposable)', () => {
  it('loads sqlite-vec so KNN is a vec0 MATCH, not a linear scan (Ruling C2)', () => {
    const store = openInMemoryStore();
    expect(store.vectorSearchNative).toBe(true);
  });

  it('returns nearest-first and records the dim it was created at', () => {
    const { store, p1, p2, f1 } = fixture();
    expect(store.embeddingDim()).toBeNull();
    store.putEmbedding(p1.id, 1, new Float32Array([1, 0, 0]));
    store.putEmbedding(p2.id, 1, new Float32Array([0.9, 0.1, 0]));
    store.putEmbedding(f1.id, 2, new Float32Array([0, 1, 0]));

    // The dim is recorded so a config change to embedDim is detectable rather
    // than silently mixing vector widths.
    expect(store.embeddingDim()).toBe(3);

    const hits = store.knn(new Float32Array([1, 0, 0]), 2);
    expect(hits.map((h) => h.node_id)).toEqual([p1.id, p2.id]);
    expect(hits[0]?.version).toBe(1);
    expect(hits[0]?.distance).toBeLessThan(hits[1]?.distance ?? Infinity);
    expect(hits[0]?.distance).toBeCloseTo(0, 5);

    // (node_id, version) is a key: re-embedding replaces, it does not duplicate.
    store.putEmbedding(p1.id, 1, new Float32Array([0, 0, 1]));
    expect(store.knn(new Float32Array([1, 0, 0]), 5).filter((h) => h.node_id === p1.id)).toHaveLength(1);
    expect(store.knn(new Float32Array([1, 0, 0]), 5)[0]?.node_id).toBe(p2.id);

    expect(() => store.knn(new Float32Array([1, 0]), 1)).toThrow(StoreInvariantError);
  });

  it('drops L3 without touching L1, because only L3 is disposable (D8)', () => {
    const { store, p1 } = fixture();
    store.putSummary({ node_id: p1.id, model: 'm', text: 'summary', meta: summaryMeta() });
    store.putEmbedding(p1.id, 1, new Float32Array([1, 0, 0]));

    store.dropEmbeddings();

    expect(store.embeddingDim()).toBeNull();
    expect(store.knn(new Float32Array([1, 0, 0]), 3)).toEqual([]);
    // L1 survives: nodes and the versioned summary are derived from L0+L2, not from L3.
    expect(store.nodesInCreationOrder()).toHaveLength(5);
    expect(store.currentSummary(p1.id)?.text).toBe('summary');
    // And L3 can be rebuilt at a different width after a drop.
    store.putEmbedding(p1.id, 1, new Float32Array([1, 0, 0, 0]));
    expect(store.embeddingDim()).toBe(4);
  });

  it('rejects a vector of the wrong width instead of corrupting the index', () => {
    const { store, p1, p2 } = fixture();
    store.putEmbedding(p1.id, 1, new Float32Array([1, 0, 0]));
    expect(() => store.putEmbedding(p2.id, 1, new Float32Array([1, 0]))).toThrow(StoreInvariantError);
  });
});

describe('durability', () => {
  it('rolls back the whole transaction on throw, so a failed import leaves no half-tree', () => {
    const { store, root } = fixture();
    const before = store.nodesInCreationOrder().length;
    expect(() =>
      store.transaction(() => {
        store.insertNode({ parent_id: root.id, kind: 'phase', title: 'doomed', span_start_seq: 50 });
        throw new Error('segmenter blew up');
      }),
    ).toThrow('segmenter blew up');
    expect(store.nodesInCreationOrder()).toHaveLength(before);
    expect(store.children(root.id).map((n) => n.title)).not.toContain('doomed');
  });

  it('preserves nodes, versioned summaries, links, meta and vectors across a reopen', () => {
    const path = tmpDb();
    const first = fixture(openStore(path));
    first.store.mergeNodeMeta(first.f1.id, { symbols: ['Quote'] });
    first.store.putSummary({ node_id: first.p1.id, model: 'm', text: 'v1', meta: summaryMeta() });
    first.store.putSummary({ node_id: first.p1.id, model: 'm', text: 'v2', meta: summaryMeta() });
    first.store.putLink({ from_id: first.p1.id, to_id: first.p2.id, kind: 'relates_to' });
    first.store.markStaleCascade(first.f2.id, 60);
    first.store.putEmbedding(first.p1.id, 2, new Float32Array([1, 0, 0]));
    first.store.setMeta('tokenizer_id', 'cl100k-stub');
    first.store.close();

    // Resumption is the whole product: a fresh process must see the same tree.
    const second = openStore(path);
    expect(second.nodesInCreationOrder().map((n) => n.id)).toEqual([
      first.root.id,
      first.p1.id,
      first.f1.id,
      first.p2.id,
      first.f2.id,
    ]);
    expect(second.getNode(first.f1.id)?.meta_json.symbols).toEqual(['Quote']);
    expect(second.summaryVersions(first.p1.id).map((s) => s.text)).toEqual(['v1', 'v2']);
    expect(second.getNode(first.p1.id)?.current_summary_version).toBe(2);
    expect(second.linksTo(first.p2.id).map((l) => l.kind)).toEqual(['relates_to']);
    expect(second.staleNodes().map((n) => n.id)).toEqual([first.root.id, first.p2.id, first.f2.id]);
    expect(second.getMeta('tokenizer_id')).toBe('cl100k-stub');
    expect(second.embeddingDim()).toBe(3);
    expect(second.knn(new Float32Array([1, 0, 0]), 1)).toEqual([
      { node_id: first.p1.id, version: 2, distance: 0 },
    ]);
    second.close();
  });
});
