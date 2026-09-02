import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextTreeError, StoreInvariantError } from '../src/contracts/index.js';
import type {
  AssistantMessageEvent,
  BlobRef,
  BlobStore,
  NodeId,
  SummaryMeta,
  ToolCallEvent,
  ToolResultEvent,
  TraceEventInput,
  TreeNode,
  UserMessageEvent,
} from '../src/contracts/index.js';
import { FsBlobStore } from '../src/blobs/index.js';
import { JsonlTraceLog } from '../src/trace/index.js';
import { openInMemoryStore, type SqliteTreeStore } from '../src/store/index.js';
import { TreeRetriever, createVectorProvider } from '../src/retrieve/index.js';

const TS = '2026-01-01T00:00:00.000Z';
const HUGE_BLOB_CHARS = 200_000;

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

// Per-type factories (TraceEventInput<X> with T explicit) returned from a
// function call, so TS's excess-property check doesn't reject them against the
// bare `TraceEventInput` that `TraceLog.append` declares — same pattern as
// test/trace.test.ts.
function userMessage(blob: BlobRef): TraceEventInput<UserMessageEvent> {
  return { type: 'user_message', ts: TS, blob };
}
function assistantMessage(blob: BlobRef): TraceEventInput<AssistantMessageEvent> {
  return { type: 'assistant_message', ts: TS, blob };
}
function toolCall(fields: Omit<TraceEventInput<ToolCallEvent>, 'type' | 'ts'>): TraceEventInput<ToolCallEvent> {
  return { type: 'tool_call', ts: TS, ...fields };
}
function toolResult(fields: Omit<TraceEventInput<ToolResultEvent>, 'type' | 'ts'>): TraceEventInput<ToolResultEvent> {
  return { type: 'tool_result', ts: TS, ...fields };
}

interface BlobCalls {
  /** Capped reads — what `context_peek` must use. */
  prefix: Array<{ ref: BlobRef; maxBytes: number }>;
  /** Whole-blob reads — what `context_peek` must never do. */
  full: BlobRef[];
}

/** Records which read path each retrieval took; the peek/narrowing tests assert on it. */
function spyBlobs(inner: BlobStore, calls: BlobCalls): BlobStore {
  return {
    root: inner.root,
    put: (content) => inner.put(content),
    digest: (content) => inner.digest(content),
    pathFor: (ref) => inner.pathFor(ref),
    has: (ref) => inner.has(ref),
    size: (ref) => inner.size(ref),
    get: (ref) => {
      calls.full.push(ref);
      return inner.get(ref);
    },
    getText: (ref) => {
      calls.full.push(ref);
      return inner.getText(ref);
    },
    getTextPrefix: (ref, maxBytes) => {
      calls.prefix.push({ ref, maxBytes });
      return inner.getTextPrefix(ref, maxBytes);
    },
  };
}

// ── the fake embedder ───────────────────────────────────────────────────────
// Three keyword axes plus a constant bias component (so no document embeds to
// the zero vector, whose cosine distance is undefined). Deterministic and
// offline: a test that reaches an embedding API tests the network, not §9.
const AXES = ['tier', 'oauth', 'rounding'] as const;
const BIAS = 0.25;

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

function fakeVector(text: string): Float32Array {
  const lower = text.toLowerCase();
  const raw = [...AXES.map((axis) => occurrences(lower, axis)), BIAS];
  const norm = Math.sqrt(raw.reduce((sum, value) => sum + value * value, 0));
  return new Float32Array(raw.map((value) => value / norm));
}

function fakeEmbedder(): { embed: (texts: readonly string[]) => Promise<Float32Array[]>; calls: number } {
  const state = {
    calls: 0,
    embed: async (texts: readonly string[]): Promise<Float32Array[]> => {
      state.calls += 1;
      return texts.map(fakeVector);
    },
  };
  return state;
}

// ── the seeded tree ────────────────────────────────────────────────────────
// root(task 1..12)
//  ├ p1 diagnosis 2..5 ─ f1 file src/pricing.ts 3..4
//  └ p2 implementation 6..12 ─ f2 file src/pricing.ts 7..8
//                            └ f3 file docs/authentication.md 10..11
// Two phases touching the same path is the minimum shape that can prove the
// `file` narrowing reads spans rather than filtering a loaded branch.
interface Fixture {
  store: SqliteTreeStore;
  blobs: BlobStore;
  calls: BlobCalls;
  trace: JsonlTraceLog;
  nodes: Record<'root' | 'p1' | 'f1' | 'p2' | 'f2' | 'f3', TreeNode>;
  refs: Record<'pricingEdit' | 'docsWrite' | 'hugeOutput', BlobRef>;
}

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'ct-retrieve-'));
  const inner = new FsBlobStore(join(dir, 'blobs'));
  const calls: BlobCalls = { prefix: [], full: [] };
  const blobs = spyBlobs(inner, calls);
  const trace = new JsonlTraceLog(join(dir, 'trace.jsonl'));

  const pricingEdit = inner.put('export function applyTier(cents: number) { /* tier brackets */ }');
  const docsWrite = inner.put('# Authentication\noauth login flow');
  const hugeOutput = inner.put('x'.repeat(HUGE_BLOB_CHARS));

  trace.appendAll([
    userMessage(inner.put('add tiered pricing to the billing service')),
    assistantMessage(inner.put('first I will reproduce the failing test')),
    toolCall({ tool: 'Read', path: 'src/pricing.ts', args_blob: inner.put('{"path":"src/pricing.ts"}') }),
    toolResult({ call_seq: 3, output_blob: hugeOutput }),
    assistantMessage(inner.put('the rounding happens too early')),
    assistantMessage(inner.put('now implementing the tier brackets')),
    toolCall({ tool: 'Edit', path: 'src/pricing.ts', blob: pricingEdit }),
    toolResult({ call_seq: 7, output_blob: inner.put('edit applied to src/pricing.ts') }),
    assistantMessage(inner.put('and the docs')),
    toolCall({ tool: 'Write', path: 'docs/authentication.md', blob: docsWrite }),
    toolResult({ call_seq: 10, output_blob: inner.put('wrote docs/authentication.md') }),
    assistantMessage(inner.put('done')),
  ]);

  const store = openInMemoryStore();
  const root = store.insertNode({
    parent_id: null,
    kind: 'task',
    title: 'add tiered pricing to the billing service',
    span_start_seq: 1,
    span_end_seq: 12,
  });
  const p1 = store.insertNode({
    parent_id: root.id,
    kind: 'phase',
    title: 'diagnose the failing test',
    phase_type: 'diagnosis',
    span_start_seq: 2,
    span_end_seq: 5,
  });
  const f1 = store.insertNode({
    parent_id: p1.id,
    kind: 'file',
    title: 'src/pricing.ts',
    span_start_seq: 3,
    span_end_seq: 4,
    meta_json: { path: 'src/pricing.ts' },
  });
  const p2 = store.insertNode({
    parent_id: root.id,
    kind: 'phase',
    title: 'implement the tier brackets',
    phase_type: 'implementation',
    span_start_seq: 6,
    span_end_seq: 12,
  });
  const f2 = store.insertNode({
    parent_id: p2.id,
    kind: 'file',
    title: 'src/pricing.ts',
    span_start_seq: 7,
    span_end_seq: 8,
    meta_json: { path: 'src/pricing.ts' },
  });
  const f3 = store.insertNode({
    parent_id: p2.id,
    kind: 'file',
    title: 'docs/authentication.md',
    span_start_seq: 10,
    span_end_seq: 11,
    meta_json: { path: 'docs/authentication.md' },
  });

  const put = (node: TreeNode, text: string, meta: SummaryMeta = summaryMeta()): void => {
    store.putSummary({ node_id: node.id, model: 'test-model', text, meta, created_at: TS });
  };
  put(root, 'Session goal: billing service changes across two phases.', summaryMeta({ node_ids: [p1.id, p2.id] }));
  put(p1, 'Reproduced the failing rounding error in computeDiscount.');
  put(f1, 'Read computeDiscount and confirmed the rounding error.', summaryMeta({
    files: [{ path: 'src/pricing.ts', start_line: 10, end_line: 20, symbol: 'computeDiscount' }],
    symbols: ['computeDiscount'],
  }));
  // A parent legitimately mentions its children's content — that is what makes
  // top-down beam search able to find a leaf at all.
  put(p2, 'Added tiered brackets in applyTier, then documented the oauth login flow.');
  put(f2, 'applyTier now returns the tier bracket.', summaryMeta({
    files: [{ path: 'src/pricing.ts', start_line: 30, end_line: 44, symbol: 'applyTier' }],
    symbols: ['applyTier'],
  }));
  put(f3, 'Documented the oauth login flow.');

  return {
    store,
    blobs,
    calls,
    trace,
    nodes: {
      root: store.getNode(root.id) as TreeNode,
      p1: store.getNode(p1.id) as TreeNode,
      f1: store.getNode(f1.id) as TreeNode,
      p2: store.getNode(p2.id) as TreeNode,
      f2: store.getNode(f2.id) as TreeNode,
      f3: store.getNode(f3.id) as TreeNode,
    },
    refs: { pricingEdit, docsWrite, hugeOutput },
  };
}

function rankOf(ids: readonly NodeId[], id: NodeId): number {
  return ids.indexOf(id);
}

describe('TreeRetriever.searchSummaries — collapsed-tree (RAPTOR) retrieval over L3', () => {
  it('returns nearest-first over the seeded tree, because collapsed-tree retrieval must let a leaf outrank its ancestors', async () => {
    const f = fixture();
    const embedder = fakeEmbedder();
    const retriever = new TreeRetriever({ store: f.store, blobs: f.blobs, trace: f.trace, embed: embedder.embed });
    await retriever.embedSummaries();

    const result = await retriever.searchSummaries('oauth');

    expect(result.path).toBe('vector');
    // f3 is the only node whose summary carries the oauth axis; its parent p2
    // mentions it too, so a hierarchy-walking search could have stopped at p2.
    expect(result.hits[0]?.nodeId).toBe(f.nodes.f3.id);
    const scores = result.hits.map((hit) => hit.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('searches summaries only, never raw turns (§19 Q2), so every hit carries a summary version', async () => {
    const f = fixture();
    const embedder = fakeEmbedder();
    const retriever = new TreeRetriever({ store: f.store, blobs: f.blobs, trace: f.trace, embed: embedder.embed });
    await retriever.embedSummaries();

    const result = await retriever.searchSummaries('tier brackets', { limit: 10 });

    expect(result.hits.length).toBe(6);
    for (const hit of result.hits) {
      expect(hit.version).toBeGreaterThan(0);
      expect(f.store.getNode(hit.nodeId)).not.toBeNull();
    }
    // One hit per node: L3 rows are keyed (node, version) and a re-summarized
    // node must not appear twice in one ranking.
    expect(new Set(result.hits.map((hit) => hit.nodeId)).size).toBe(6);
  });

  it('returns a re-summarized node once, at the version that actually matched (D3), not at the newest one', async () => {
    const f = fixture();
    const embedder = fakeEmbedder();
    const retriever = new TreeRetriever({ store: f.store, blobs: f.blobs, trace: f.trace, embed: embedder.embed });
    await retriever.embedSummaries();
    // A second version whose text drops the oauth axis, embedded alongside v1 —
    // exactly the stale-row state L3 lands in after a §8 re-summary.
    f.store.putSummary({
      node_id: f.nodes.f3.id,
      model: 'test-model',
      text: 'Reverted the login docs.',
      meta: summaryMeta(),
      created_at: TS,
    });
    await retriever.embedSummaries([f.nodes.f3.id]);

    const hits = (await retriever.searchSummaries('oauth', { limit: 10 })).hits;

    expect(hits.filter((hit) => hit.nodeId === f.nodes.f3.id).length).toBe(1);
    const hit = hits.find((entry) => entry.nodeId === f.nodes.f3.id);
    expect(hit?.version).toBe(1);
    expect(hit?.text).toBe('Documented the oauth login flow.');
  });

  it('honours the kind filter by over-fetching from knn, which cannot filter by kind itself', async () => {
    const f = fixture();
    const embedder = fakeEmbedder();
    const retriever = new TreeRetriever({ store: f.store, blobs: f.blobs, trace: f.trace, embed: embedder.embed });
    await retriever.embedSummaries();

    const result = await retriever.searchSummaries('rounding', { kind: 'file', limit: 2 });

    expect(result.hits.map((hit) => hit.kind)).toEqual(['file', 'file']);
    expect(result.hits[0]?.nodeId).toBe(f.nodes.f1.id);
  });

  it('throws without an embedder, so a caller cannot read an empty L3 as "nothing matched"', async () => {
    const f = fixture();
    const retriever = new TreeRetriever({ store: f.store, blobs: f.blobs, trace: f.trace });
    await expect(retriever.searchSummaries('oauth')).rejects.toThrow(ContextTreeError);
  });
});

describe('TreeRetriever.search — path selection and attribution', () => {
  it('falls back to the beam path with no embedder injected, because §9 must answer offline (which is most of CI)', async () => {
    const f = fixture();
    const retriever = new TreeRetriever({ store: f.store, blobs: f.blobs, trace: f.trace });

    const result = await retriever.search('oauth login flow');

    expect(result.path).toBe('beam');
    expect(result.fallback).toBe('no-embedder');
    expect(result.hits.length).toBeGreaterThan(0);
  });

  it('falls back to the beam path when L3 is empty even though an embedder exists, then uses vectors once L3 is built', async () => {
    const f = fixture();
    const embedder = fakeEmbedder();
    const retriever = new TreeRetriever({ store: f.store, blobs: f.blobs, trace: f.trace, embed: embedder.embed });

    const before = await retriever.search('oauth login flow');
    expect(before.path).toBe('beam');
    expect(before.fallback).toBe('no-embeddings');
    // The fallback must not have spent an embedding call.
    expect(embedder.calls).toBe(0);

    await retriever.embedSummaries();
    const after = await retriever.search('oauth login flow');
    expect(after.path).toBe('vector');
    expect(after.fallback).toBeUndefined();
  });
});

describe('TreeRetriever.beamSearch — the L3-absent fallback (§9)', () => {
  it('ranks an obviously matching branch above an unrelated one with no embeddings and no network', () => {
    const f = fixture();
    const retriever = new TreeRetriever({ store: f.store, blobs: f.blobs, trace: f.trace });

    const ids = retriever.beamSearch('oauth login flow', { limit: 10 }).hits.map((hit) => hit.nodeId);

    expect(rankOf(ids, f.nodes.f3.id)).toBeLessThan(rankOf(ids, f.nodes.f1.id));
    expect(rankOf(ids, f.nodes.p2.id)).toBeLessThan(rankOf(ids, f.nodes.p1.id));
  });

  it('is byte-identical across two runs, because §15 can only attribute recall to a reproducible mechanism', () => {
    const f = fixture();
    const retriever = new TreeRetriever({ store: f.store, blobs: f.blobs, trace: f.trace });

    const first = JSON.stringify(retriever.beamSearch('rounding error in computeDiscount', { limit: 10 }));
    const second = JSON.stringify(retriever.beamSearch('rounding error in computeDiscount', { limit: 10 }));

    expect(second).toBe(first);
  });

  it('expands only the top-k of each level — a beam that visits every node is a scan, not a fallback', () => {
    const f = fixture();
    const retriever = new TreeRetriever({ store: f.store, blobs: f.blobs, trace: f.trace });

    const ids = retriever.beamSearch('oauth login flow', { beamWidth: 1, limit: 10 }).hits.map((hit) => hit.nodeId);

    // p1 beats nothing at level 1, so its subtree is never scored...
    expect(ids).not.toContain(f.nodes.f1.id);
    // ...while the winning branch's children are.
    expect(ids).toContain(f.nodes.f3.id);
    expect(ids).toContain(f.nodes.p1.id);
  });

  it('filters the answer by kind without pruning the descent, since file nodes are only reachable through phases', () => {
    const f = fixture();
    const retriever = new TreeRetriever({ store: f.store, blobs: f.blobs, trace: f.trace });

    const result = retriever.beamSearch('oauth login flow', { kind: 'file', limit: 10 });

    expect(result.hits.map((hit) => hit.kind)).toEqual(['file', 'file', 'file']);
    expect(result.hits[0]?.nodeId).toBe(f.nodes.f3.id);
  });
});

describe('TreeRetriever.fetchBranch — context_fetch', () => {
  it('defaults to depth full (R9), because a summary can never contain a literal the paraphrase dropped', () => {
    const f = fixture();
    const retriever = new TreeRetriever({ store: f.store, blobs: f.blobs, trace: f.trace });

    const fetched = retriever.fetchBranch(f.nodes.f2.id);

    expect(fetched.depth).toBe('full');
    expect(fetched.text).toContain('applyTier');
    expect(fetched.spans).toEqual([{ start: 7, end: 8 }]);
  });

  it('at depth summary returns the stored summary and its §8 rehydration pointers without touching L0', () => {
    const f = fixture();
    const retriever = new TreeRetriever({ store: f.store, blobs: f.blobs, trace: f.trace });

    const fetched = retriever.fetchBranch(f.nodes.f1.id, { depth: 'summary' });

    expect(fetched.depth).toBe('summary');
    expect(fetched.text).toBe('Read computeDiscount and confirmed the rounding error.');
    expect(fetched.summaryVersion).toBe(1);
    expect(fetched.meta?.symbols).toEqual(['computeDiscount']);
    expect(fetched.events).toBe(0);
    expect(fetched.spans).toEqual([]);
    expect(f.calls.full).toEqual([]);
  });

  it('at depth full replays the branch span out of L0 through L2, because L1 stores coordinates not content', () => {
    const f = fixture();
    const retriever = new TreeRetriever({ store: f.store, blobs: f.blobs, trace: f.trace });

    const fetched = retriever.fetchBranch(f.nodes.f2.id, { depth: 'full' });

    expect(fetched.spans).toEqual([{ start: 7, end: 8 }]);
    expect(fetched.events).toBe(2);
    expect(fetched.text).toContain('applyTier');
    expect(fetched.text).toContain('edit applied to src/pricing.ts');
    expect(fetched.text).toContain('[7] tool_call Edit path=src/pricing.ts');
  });

  it('at depth full carries the same §8 meta a depth-summary fetch would, not the old hard-coded null (2h)', () => {
    const f = fixture();
    const retriever = new TreeRetriever({ store: f.store, blobs: f.blobs, trace: f.trace });

    const full = retriever.fetchBranch(f.nodes.f2.id, { depth: 'full' });
    const summary = retriever.fetchBranch(f.nodes.f2.id, { depth: 'summary' });

    expect(full.meta).toEqual(summary.meta);
    expect(full.meta?.symbols).toEqual(['applyTier']);
  });

  it('at depth index lists events (seq/type/tool/path/bytes) from L0 + L2 stat only, never blob text', () => {
    const f = fixture();
    const retriever = new TreeRetriever({ store: f.store, blobs: f.blobs, trace: f.trace });

    const fetched = retriever.fetchBranch(f.nodes.p2.id, { depth: 'index' });

    expect(fetched.depth).toBe('index');
    expect(fetched.text).toContain('[7] tool_call Edit path=src/pricing.ts bytes=');
    expect(fetched.text).toContain('[10] tool_call Write path=docs/authentication.md bytes=');
    // The whole point of `index`: it never reads a blob's content.
    expect(f.calls.full).toEqual([]);
    expect(f.calls.prefix).toEqual([]);
  });

  it('narrows a full/index read with from/to, clamped to the branch\'s own span (R10)', () => {
    const f = fixture();
    const retriever = new TreeRetriever({ store: f.store, blobs: f.blobs, trace: f.trace });

    // p2 spans 6-12; narrow to just the Edit call + its result (7-8).
    const narrowed = retriever.fetchBranch(f.nodes.p2.id, { depth: 'full', from: 7, to: 8 });
    expect(narrowed.spans).toEqual([{ start: 7, end: 8 }]);
    expect(narrowed.text).toContain('applyTier');
    expect(narrowed.text).not.toContain('oauth login flow');

    // An over-wide range is a no-op — clamped back to the node's own span.
    const overWide = retriever.fetchBranch(f.nodes.p2.id, { depth: 'full', from: 0, to: 1_000 });
    const full = retriever.fetchBranch(f.nodes.p2.id, { depth: 'full' });
    expect(overWide.text).toBe(full.text);
    expect(overWide.spans).toEqual(full.spans);

    // A disjoint range yields an empty result, never a throw.
    const disjoint = retriever.fetchBranch(f.nodes.p2.id, { depth: 'full', from: 1_000, to: 1_010 });
    expect(disjoint.text).toBe('');
    expect(disjoint.spans).toEqual([]);
  });

  it('concatenating a partition of from/to ranges is byte-identical to depth full (G3 partition identity)', () => {
    const f = fixture();
    const retriever = new TreeRetriever({ store: f.store, blobs: f.blobs, trace: f.trace });

    const full = retriever.fetchBranch(f.nodes.p2.id, { depth: 'full' });
    const partA = retriever.fetchBranch(f.nodes.p2.id, { depth: 'full', to: 8 });
    const partB = retriever.fetchBranch(f.nodes.p2.id, { depth: 'full', from: 9 });

    expect(`${partA.text}\n\n${partB.text}`).toBe(full.text);
    expect(partA.events + partB.events).toBe(full.events);
  });

  it('with file restricts the READ to that file node rather than loading the branch and filtering (§10 rule 4)', () => {
    const f = fixture();
    const retriever = new TreeRetriever({ store: f.store, blobs: f.blobs, trace: f.trace });

    const fetched = retriever.fetchBranch(f.nodes.p2.id, { depth: 'full', file: 'src/pricing.ts' });

    expect(fetched.nodes).toEqual([f.nodes.f2.id]);
    expect(fetched.spans).toEqual([{ start: 7, end: 8 }]);
    expect(fetched.text).toContain('applyTier');
    expect(fetched.text).not.toContain('oauth login flow');
    // The proof it narrowed the read: the sibling file's blob was never opened.
    expect(f.calls.full).not.toContain(f.refs.docsWrite);
    expect(f.calls.full).toContain(f.refs.pricingEdit);
  });

  it('returns every file node for a path under the branch, because dropping a later phase would silently hide an edit', () => {
    const f = fixture();
    const retriever = new TreeRetriever({ store: f.store, blobs: f.blobs, trace: f.trace });

    const fetched = retriever.fetchBranch(f.nodes.root.id, { depth: 'full', file: 'src/pricing.ts' });

    expect(fetched.nodes).toEqual([f.nodes.f1.id, f.nodes.f2.id]);
    expect(fetched.spans).toEqual([
      { start: 3, end: 4 },
      { start: 7, end: 8 },
    ]);
    expect(fetched.text).not.toContain('oauth login flow');
  });

  it('throws for a path that no file node under the branch is keyed by, instead of returning an empty branch', () => {
    const f = fixture();
    const retriever = new TreeRetriever({ store: f.store, blobs: f.blobs, trace: f.trace });

    expect(() => retriever.fetchBranch(f.nodes.p1.id, { file: 'docs/authentication.md' })).toThrow(ContextTreeError);
  });

  it('throws at depth full when no TraceLog was injected — a plausible empty replay would be worse than a failure', () => {
    const f = fixture();
    const retriever = new TreeRetriever({ store: f.store, blobs: f.blobs });

    expect(() => retriever.fetchBranch(f.nodes.f2.id, { depth: 'full' })).toThrow(/TraceLog/);
  });

  it('also throws with no depth argument at all, because the default is now full, not summary (R9)', () => {
    const f = fixture();
    const retriever = new TreeRetriever({ store: f.store, blobs: f.blobs });

    expect(() => retriever.fetchBranch(f.nodes.f2.id)).toThrow(/TraceLog/);
  });

  it('throws for an unknown node id', () => {
    const f = fixture();
    const retriever = new TreeRetriever({ store: f.store, blobs: f.blobs, trace: f.trace });

    expect(() => retriever.fetchBranch('n_nope')).toThrow(StoreInvariantError);
  });
});

describe('TreeRetriever.peek — context_peek', () => {
  it('caps the excerpt at maxChars and never pages in the whole blob, because suspicion costs one small call (§9)', () => {
    const f = fixture();
    const retriever = new TreeRetriever({ store: f.store, blobs: f.blobs, trace: f.trace });

    const excerpt = retriever.peek(f.nodes.f1.id, 100);

    expect(excerpt.length).toBe(100);
    expect(f.calls.full).toEqual([]);
    expect(f.calls.prefix.length).toBeGreaterThan(0);
    for (const read of f.calls.prefix) expect(read.maxBytes).toBeLessThanOrEqual(100);
    // The 200k-char tool output was reached but only its head was read.
    expect(f.calls.prefix.some((read) => read.ref === f.refs.hugeOutput)).toBe(true);
  });

  it('reads raw L0 payloads rather than the summary, since the contract points here when a summary is suspect', () => {
    const f = fixture();
    const retriever = new TreeRetriever({ store: f.store, blobs: f.blobs, trace: f.trace });

    const excerpt = retriever.peek(f.nodes.f3.id, 200);

    expect(excerpt).toContain('oauth login flow');
    expect(excerpt).not.toContain('Documented the oauth login flow.');
  });
});

describe('createVectorProvider — §9.1 always-available fuzzy tier', () => {
  it('is available with an empty L3 and no embedder, because the beam fallback makes the probe unfailable', async () => {
    const f = fixture();
    const provider = createVectorProvider(new TreeRetriever({ store: f.store, blobs: f.blobs, trace: f.trace }));

    expect(await provider.available()).toBe(true);
    expect(f.store.embeddingDim()).toBeNull();

    const candidates = await provider.search({ query: 'oauth login flow', limit: 3 });
    expect(candidates.length).toBe(3);
    for (const candidate of candidates) {
      expect(candidate.node_id).toBeDefined();
      expect(candidate.provider).toBe('vector');
      expect(candidate.tier).toBe('fuzzy');
    }
  });

  it('hydrates a candidate back to its branch summary, so a merged ranking can be expanded without a second search', async () => {
    const f = fixture();
    const provider = createVectorProvider(new TreeRetriever({ store: f.store, blobs: f.blobs, trace: f.trace }));

    const candidates = await provider.search({ query: 'applyTier tier bracket', kind: 'file', limit: 1 });
    const candidate = candidates[0];
    expect(candidate?.node_id).toBe(f.nodes.f2.id);
    expect(candidate?.path).toBe('src/pricing.ts');
    expect(candidate?.span).toEqual({ start_line: 30, end_line: 44 });

    const content = await provider.hydrate(candidate as NonNullable<typeof candidate>);
    expect(content.text).toBe('applyTier now returns the tier bracket.');
    expect(content.truncated).toBe(false);
    expect(content.provider).toBe('vector');
  });

  it('rejects a candidate with no node_id, because this provider only ever emits tree nodes', async () => {
    const f = fixture();
    const provider = createVectorProvider(new TreeRetriever({ store: f.store, blobs: f.blobs, trace: f.trace }));

    await expect(
      provider.hydrate({ score: 1, provider: 'grep', tier: 'fallback', path: 'src/pricing.ts' }),
    ).rejects.toThrow(ContextTreeError);
  });
});

describe('TreeRetriever.embedSummaries — L3 is disposable (D8)', () => {
  it('is idempotent: a second run rebuilds the same L3, so a rebuild is never a migration', async () => {
    const f = fixture();
    const embedder = fakeEmbedder();
    const retriever = new TreeRetriever({ store: f.store, blobs: f.blobs, trace: f.trace, embed: embedder.embed });

    const first = await retriever.embedSummaries();
    const firstKnn = JSON.stringify(f.store.knn(fakeVector('oauth'), 6));
    const second = await retriever.embedSummaries();
    const secondKnn = JSON.stringify(f.store.knn(fakeVector('oauth'), 6));

    expect(second.embedded).toEqual(first.embedded);
    expect(second.embedded.length).toBe(6);
    expect(secondKnn).toBe(firstKnn);
    expect(f.store.embeddingDim()).toBe(AXES.length + 1);
  });

  it('embeds only the requested nodes and skips one with no summary yet, because §8 summarizes async', async () => {
    const f = fixture();
    const embedder = fakeEmbedder();
    const retriever = new TreeRetriever({ store: f.store, blobs: f.blobs, trace: f.trace, embed: embedder.embed });
    const fresh = f.store.insertNode({
      parent_id: f.nodes.p2.id,
      kind: 'file',
      title: 'src/new.ts',
      span_start_seq: 12,
      meta_json: { path: 'src/new.ts' },
    });

    const result = await retriever.embedSummaries([f.nodes.f3.id, fresh.id]);

    expect(result.embedded).toEqual([f.nodes.f3.id]);
    expect(result.skipped).toEqual([fresh.id]);
  });

  it('no-ops without an embedder, leaving L3 absent so search keeps answering on the beam path', async () => {
    const f = fixture();
    const retriever = new TreeRetriever({ store: f.store, blobs: f.blobs, trace: f.trace });

    const result = await retriever.embedSummaries();

    expect(result.embedderAvailable).toBe(false);
    expect(result.embedded).toEqual([]);
    expect(result.skipped.length).toBe(6);
    expect(f.store.embeddingDim()).toBeNull();
    expect((await retriever.search('oauth login flow')).path).toBe('beam');
  });
});
