/**
 * §7.1 / D15 — the hermetic ingestion pass, plus the D8 properties that make it
 * worth having: L1 is a function of L0 + L2, so a rebuild is a replay, and an
 * incremental append must land on exactly the tree a rebuild produces.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig, type ContextTreeConfig } from '../src/config.js';
import { StoreInvariantError } from '../src/contracts/index.js';
import type {
  Annotation,
  AssistantMessageEvent,
  BlobStore,
  Candidate,
  ManualAnnotationEvent,
  NodeId,
  NodeLink,
  NodeMeta,
  RetrievalProvider,
  SummaryMeta,
  ToolCallEvent,
  TraceEventInput,
  TreeNode,
  TreeStore,
  UserMessageEvent,
} from '../src/contracts/index.js';
import { appendEvent, enrich, ingest, openTaskStore, rebuild, type TaskStore } from '../src/ingest/index.js';

const TS = '2026-01-01T00:00:00.000Z';
const PRICING = 'src/pricing.ts';
const UTIL = 'src/util.ts';

/** One function, so the first edit contributes exactly one span. */
const PRICING_V1 = `export function price(base: number): number {
  return base;
}
`;

/** Edits `price` *and* appends `discount`: the second edit must add a span without duplicating the first. */
const PRICING_V2 = `export function price(base: number): number {
  return base * 0.9;
}

export function discount(rate: number): number {
  return rate;
}
`;

const UTIL_V1 = `export function clamp(value: number): number {
  return value;
}
`;

// ---------------------------------------------------------------------------
// Fixture builders. Per-type `TraceEventInput<T>` factories, because the bare
// union collapses to the common keys and would erase `tool`/`path`/`blob`.
// ---------------------------------------------------------------------------

const userMessage = (blob: string): TraceEventInput<UserMessageEvent> => ({ type: 'user_message', ts: TS, blob });
const assistantMessage = (blob: string): TraceEventInput<AssistantMessageEvent> => ({
  type: 'assistant_message',
  ts: TS,
  blob,
});
const toolCall = (
  overrides: Partial<TraceEventInput<ToolCallEvent>> & { tool: string },
): TraceEventInput<ToolCallEvent> => ({ type: 'tool_call', ts: TS, ...overrides });

/** Deliberately later than `TS`: a replayed note must carry the event's clock, not the pass's. */
const ANNOTATED_AT = '2026-02-02T09:30:00.000Z';
const NOTE = 'superseded: the rounding moved into the tax helper';

const manualAnnotation = (
  overrides: Partial<TraceEventInput<ManualAnnotationEvent>> & { blob: string },
): TraceEventInput<ManualAnnotationEvent> => ({ type: 'manual_annotation', ts: ANNOTATED_AT, ...overrides });

/**
 * The canonical fixture session: a question, a read, two edits of one file, a
 * write of another, a test run, an answer. It deliberately opens with a
 * message-only prefix, which makes the first `ingest` of the incremental path
 * take §7's text fallback and the second take the tool state machine — the one
 * case where a re-segmentation reassigns what a `NodeKey` means.
 */
function fixtureEvents(blobs: BlobStore): TraceEventInput[] {
  const ask = blobs.put('pricing is wrong for discounted items');
  const v1 = blobs.put(PRICING_V1);
  const v2 = blobs.put(PRICING_V2);
  const util = blobs.put(UTIL_V1);
  const done = blobs.put('fixed the discount rounding');
  return [
    userMessage(ask),
    toolCall({ tool: 'Read', path: PRICING }),
    toolCall({ tool: 'Edit', path: PRICING, blob: v1 }),
    toolCall({ tool: 'Edit', path: PRICING, blob: v2 }),
    toolCall({ tool: 'Write', path: UTIL, blob: util }),
    toolCall({ tool: 'run_tests' }),
    assistantMessage(done),
  ];
}

interface Fixture {
  dir: string;
  config: ContextTreeConfig;
  handle: TaskStore;
}

function openFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'ct-ingest-'));
  const config = resolveConfig({ root: dir, taskTitle: 'fix pricing' });
  return { dir, config, handle: openTaskStore(config) };
}

/** Seeds L0 directly (no ingestion) — the "rebuild over this log" side of every comparison. */
function seed(handle: TaskStore, events: readonly TraceEventInput[] = fixtureEvents(handle.blobs)): void {
  handle.trace.appendAll(events);
}

interface Projected {
  path: string;
  kind: string;
  phase_type: string | null;
  span: [number | null, number | null];
  status: string;
  summary_version: number;
  stale_since_seq: number | null;
  meta: NodeMeta;
}

/**
 * The whole tree except the ULIDs, which are minted per run by design.
 * `stale_since_seq` is in here deliberately: it is derived from L0 like every
 * other column (ingest reconciles it with `setStale`), so an append path that
 * left it differing from a rebuild's value would be a tree that differs.
 */
function project(store: TreeStore): Projected[] {
  return store.nodesInCreationOrder().map((node) => ({
    path: store
      .ancestorPath(node.id)
      .map((ancestor) => ancestor.title)
      .join('/'),
    kind: node.kind,
    phase_type: node.phase_type,
    span: [node.span_start_seq, node.span_end_seq] as [number | null, number | null],
    status: node.status,
    summary_version: node.current_summary_version,
    stale_since_seq: node.stale_since_seq,
    meta: node.meta_json,
  }));
}

/** Title -> stale marker, for the nodes the summarizer would pick up (§8). */
function staleProfile(store: TreeStore): Array<[string, number | null]> {
  return store.staleNodes().map((node) => [node.title, node.stale_since_seq]);
}

/** Projection with the optional enrichment stripped — used to prove enrichment changed nothing else. */
function withoutEnrichment(rows: Projected[]): Projected[] {
  return rows.map((row) => {
    const { enrichment: _dropped, ...meta } = row.meta;
    return { ...row, meta };
  });
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function blobInventory(dir: string): string[] {
  return readdirSync(join(dir, 'blobs'), { recursive: true })
    .map((entry) => String(entry))
    .sort();
}

function annotationsOf(store: TreeStore, id: NodeId): Annotation[] {
  return store.getNode(id)?.meta_json.annotations ?? [];
}

/** The two §7 phases every annotation test links: implementation superseded by verification. */
function phasePair(store: TreeStore): [TreeNode, TreeNode] {
  const [, implementation, verification] = store.byKind('phase');
  if (implementation === undefined || verification === undefined) throw new Error('fixture has no phase pair');
  return [implementation, verification];
}

function fileNode(store: TreeStore, path: string): TreeNode {
  const node = store.byKind('file').find((candidate) => candidate.meta_json.path === path);
  if (node === undefined) throw new Error(`no file node for ${path}`);
  return node;
}

function summaryMeta(): SummaryMeta {
  return { files: [], symbols: [], tests: [], artifacts: [], open_questions: [], decisions: [], node_ids: [] };
}

// ---------------------------------------------------------------------------

describe('openTaskStore', () => {
  it('creates L0, L2, L1 and the L4 views directory in one call, because every other package enters the store through this handle', () => {
    const { dir, handle } = openFixture();
    try {
      expect(statSync(join(dir, 'trace.jsonl')).isFile()).toBe(true);
      expect(statSync(join(dir, 'blobs')).isDirectory()).toBe(true);
      expect(statSync(join(dir, 'tree.db')).isFile()).toBe(true);
      expect(statSync(join(dir, 'views')).isDirectory()).toBe(true);
      // A store with no trace has no tree: an empty L0 is a legal state.
      expect(handle.store.root()).toBeNull();
    } finally {
      handle.close();
    }
  });
});

describe('ingest', () => {
  it('maps every §7 NodeKey to exactly one n_<ULID> node, because the segmenter stays pure only if id minting lives here', () => {
    const { handle } = openFixture();
    try {
      seed(handle);
      const { keyMap, stats } = ingest({ handle });

      expect([...keyMap.keys()].sort()).toEqual([
        'file:1:src/pricing.ts',
        'file:1:src/util.ts',
        'phase:0',
        'phase:1',
        'phase:2',
        'task',
      ]);
      for (const id of keyMap.values()) expect(id).toMatch(/^n_[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(new Set(keyMap.values()).size).toBe(keyMap.size);
      expect(stats.nodes).toBe(handle.store.nodesInCreationOrder().length);
    } finally {
      handle.close();
    }
  });

  it('derives the phase sequence and file parentage from tool names alone, which is D1 — zero LLM calls in the mandatory path', () => {
    const { handle } = openFixture();
    try {
      seed(handle);
      const stats = ingest({ handle }).stats;
      const store = handle.store;

      expect(store.byKind('phase').map((node) => node.phase_type)).toEqual([
        'diagnosis',
        'implementation',
        'verification',
      ]);
      const implementation = store.byKind('phase')[1];
      expect(implementation?.phase_type).toBe('implementation');
      // §7 keys file nodes by path under the phase that edited them.
      expect(store.children(implementation?.id ?? '').map((node) => node.meta_json.path)).toEqual([PRICING, UTIL]);
      // Every node closes at the end of the session, so the summarizer has a
      // closed branch to work on (§8's trigger).
      expect(store.nodesInCreationOrder().every((node) => node.status === 'closed')).toBe(true);
      expect(stats).toMatchObject({
        events: 7,
        nodes: 6,
        phases: 3,
        fileNodes: 2,
        unmappedTools: [],
        usedTextFallback: false,
      });
    } finally {
      handle.close();
    }
  });

  it('accumulates the root tool vocabulary in first-seen order without duplicates, because that list is what a resumed session reads first', () => {
    const { handle } = openFixture();
    try {
      seed(handle);
      ingest({ handle });
      const root = handle.store.root();
      expect(root?.meta_json.tools).toEqual(['Read', 'Edit', 'Write', 'run_tests']);
      // `Read` mapped to diagnosis, so only that phase saw it.
      expect(handle.store.byKind('phase')[0]?.meta_json.tools).toEqual(['Read']);
      expect(handle.store.byKind('phase')[1]?.meta_json.tools).toEqual(['Edit', 'Write']);
    } finally {
      handle.close();
    }
  });

  it('leaves every unsummarized node stale at its own span start, because that seq is a function of L0 and so survives a rebuild', () => {
    const { handle } = openFixture();
    try {
      seed(handle);
      ingest({ handle });
      const stale = handle.store.staleNodes();
      expect(stale.length).toBe(6);
      for (const node of stale) expect(node.stale_since_seq).toBe(node.span_start_seq);
    } finally {
      handle.close();
    }
  });

  it('refuses to reconcile an L1 node the segmentation does not produce and says rebuild, because L1 is derived and TreeStore has no delete', () => {
    const { handle } = openFixture();
    try {
      seed(handle);
      ingest({ handle });
      const root = handle.store.root();
      handle.store.insertNode({
        parent_id: root?.id ?? null,
        kind: 'phase',
        title: 'hand-written',
        phase_type: 'other',
        span_start_seq: 99,
      });
      expect(() => ingest({ handle })).toThrow(StoreInvariantError);
      expect(() => ingest({ handle })).toThrow(/rebuild/);
    } finally {
      handle.close();
    }
  });
});

describe('determinism (D8)', () => {
  it('produces an identical canonical projection from the same L0 in a fresh store, which is the whole D8 claim about L1', () => {
    const a = openFixture();
    const b = openFixture();
    try {
      seed(a.handle);
      seed(b.handle);
      ingest({ handle: a.handle });
      ingest({ handle: b.handle });
      expect(project(b.handle.store)).toEqual(project(a.handle.store));
      expect(staleProfile(b.handle.store)).toEqual(staleProfile(a.handle.store));
      // Same L0 => same ids, deliberately (D8). L0 *names* L1 nodes — a
      // `manual_annotation` carries the `node_id` its note belongs to — so an id
      // minted from a clock made that reference unresolvable after a rebuild.
      // The projection is still comparing something: it has a row per node.
      expect(project(a.handle.store)).toHaveLength(6);
      expect(b.handle.store.root()?.id).toBe(a.handle.store.root()?.id);
    } finally {
      a.handle.close();
      b.handle.close();
    }
  });

  it('rebuilds L1 from L0+L2 while leaving trace.jsonl byte-identical and L2 untouched, because a rebuild is a replay, never a migration', () => {
    const { dir, config, handle } = openFixture();
    seed(handle);
    ingest({ handle });
    const expected = project(handle.store);
    const expectedStale = staleProfile(handle.store);
    const traceHash = sha256(join(dir, 'trace.jsonl'));
    const blobsBefore = blobInventory(dir);

    // Tamper with the derived layer: a rebuild must not preserve this.
    handle.store.insertNode({
      parent_id: handle.store.root()?.id ?? null,
      kind: 'phase',
      title: 'stale hand-written branch',
      phase_type: 'other',
      span_start_seq: 99,
    });
    handle.close();

    const rebuilt = rebuild(config);
    try {
      expect(sha256(join(dir, 'trace.jsonl'))).toBe(traceHash);
      expect(blobInventory(dir)).toEqual(blobsBefore);
      expect(project(rebuilt.handle.store)).toEqual(expected);
      expect(staleProfile(rebuilt.handle.store)).toEqual(expectedStale);
      expect(rebuilt.stats.nodes).toBe(6);
    } finally {
      rebuilt.handle.close();
    }
  });
});

describe('appendEvent', () => {
  it('lands on exactly the tree rebuild produces after N appends, which is the evidence for the plan’s incremental-consistency claim (gap 2)', () => {
    const incremental = openFixture();
    const replayed = openFixture();
    try {
      const events = fixtureEvents(incremental.handle.blobs);
      const first = appendEvent(incremental.handle, events[0] as TraceEventInput);
      expect(first.event.seq).toBe(1);
      // A message-only prefix has no tool signal, so §7's text fallback owns it.
      expect(first.stats.usedTextFallback).toBe(true);
      expect(incremental.handle.store.byKind('phase')[0]?.phase_type).toBe('other');

      for (const event of events.slice(1)) appendEvent(incremental.handle, event);
      // The re-segmentation reassigned `phase:0`; reconciliation, not luck, is
      // what makes the two trees comparable at all.
      expect(incremental.handle.store.byKind('phase')[0]?.phase_type).toBe('diagnosis');

      seed(replayed.handle, fixtureEvents(replayed.handle.blobs));
      ingest({ handle: replayed.handle });

      expect(project(incremental.handle.store)).toEqual(project(replayed.handle.store));
      expect(readFileSync(join(incremental.dir, 'trace.jsonl'), 'utf8')).toBe(
        readFileSync(join(replayed.dir, 'trace.jsonl'), 'utf8'),
      );

      // Staleness converges exactly, marker for marker — `project` already
      // compares it, and this spells out the case that used to differ: §7's
      // text fallback opened a phase at seq 1, and re-segmentation adopts the
      // trace start too (§7's `pendingStart`), so `diagnosis` stays at seq 1
      // and reconciliation via `setStale` follows the span rather than
      // stranding the superseded lower bound `markStale` would have kept.
      const incrementalStale = staleProfile(incremental.handle.store);
      expect(incrementalStale).toEqual(staleProfile(replayed.handle.store));
      expect(incrementalStale.find(([title]) => title === 'diagnosis')).toEqual(['diagnosis', 1]);
    } finally {
      incremental.handle.close();
      replayed.handle.close();
    }
  });

  it('marks the leaf that covers the new event and its ancestors stale, never a sibling, because D4’s amortized cost depends on it', () => {
    const { handle } = openFixture();
    try {
      seed(handle);
      ingest({ handle });
      const store = handle.store;
      // Summarize everything, so the next append's cascade is visible rather
      // than hidden behind the "unsummarized is stale" rule.
      for (const node of store.nodesInCreationOrder()) {
        store.putSummary({ node_id: node.id, model: 'stub', text: node.title, meta: summaryMeta() });
      }
      expect(store.staleNodes()).toEqual([]);

      const blob = handle.blobs.put('one more thought');
      appendEvent(handle, userMessage(blob));

      const stale = store.staleNodes().map((node) => node.title);
      // seq 8 lands in the verification phase, so root + that phase go stale;
      // the diagnosis and implementation branches must not.
      expect(stale).toEqual(['fix pricing', 'verification']);
    } finally {
      handle.close();
    }
  });
});

describe('annotation replay (§9, D8, D10)', () => {
  it('carries a note and its lateral link through rebuild() with the same seq and created_at, because a rebuild that loses annotate’s output is data loss dressed as a replay', () => {
    const { config, handle } = openFixture();
    seed(handle);
    ingest({ handle });
    const [implementation, verification] = phasePair(handle.store);

    // Exactly what §9's `annotate` records: the L0 event is the conclusion,
    // L1 is derived from it.
    const { event } = appendEvent(
      handle,
      manualAnnotation({
        node_id: implementation.id,
        blob: handle.blobs.put(NOTE),
        link_to: verification.id,
        link_kind: 'superseded_by',
      }),
    );
    const note: Annotation = { seq: event.seq, text: NOTE, created_at: ANNOTATED_AT };
    const link: NodeLink = {
      from_id: implementation.id,
      to_id: verification.id,
      kind: 'superseded_by',
      created_at: ANNOTATED_AT,
    };
    expect(annotationsOf(handle.store, implementation.id)).toEqual([note]);
    expect(handle.store.linksFrom(implementation.id)).toEqual([link]);
    handle.close();

    const rebuilt = rebuild(config);
    try {
      // The subject id survives because it is minted from the segmentation key
      // rather than from a clock. That is what makes L1 a function of L0 for
      // the write-side tool too: the plan tells users to rebuild after a
      // segmenter or prompt change, so anything a rebuild drops is destroyed by
      // the documented workflow.
      expect(rebuilt.handle.store.byKind('phase')[1]?.id).toBe(implementation.id);
      expect(annotationsOf(rebuilt.handle.store, implementation.id)).toEqual([note]);
      expect(rebuilt.handle.store.linksFrom(implementation.id)).toEqual([link]);
      expect(rebuilt.handle.store.linksTo(verification.id)).toEqual([link]);
      expect(rebuilt.stats).toMatchObject({ annotations: 1, annotationLinks: 1, unresolvedAnnotations: 0 });
    } finally {
      rebuilt.handle.close();
    }
  });

  it('lands on one note and one edge however often the same log is ingested, because a re-derivation converges on the tree instead of accumulating it', () => {
    const { handle } = openFixture();
    try {
      seed(handle);
      ingest({ handle });
      const [implementation, verification] = phasePair(handle.store);
      // L0 only — no L1 write — so the derivation is the only thing under test.
      handle.trace.append(
        manualAnnotation({
          node_id: implementation.id,
          blob: handle.blobs.put(NOTE),
          link_to: verification.id,
          link_kind: 'superseded_by',
        }),
      );

      const first = ingest({ handle }).stats;
      const second = ingest({ handle }).stats;
      expect(annotationsOf(handle.store, implementation.id)).toHaveLength(1);
      expect(handle.store.linksFrom(implementation.id)).toHaveLength(1);
      // The counts describe L0, not what this particular pass wrote, so they do
      // not decay to zero once the rows are already there.
      expect([first.annotations, second.annotations]).toEqual([1, 1]);
      expect([first.annotationLinks, second.annotationLinks]).toEqual([1, 1]);

      // A runtime writer that appends the note to L1 as well as to L0 (what
      // `annotate` does today) converges here rather than doubling for good:
      // the merge key is the note's L0 seq, which is its identity (§9).
      const stored = annotationsOf(handle.store, implementation.id);
      handle.store.mergeNodeMeta(implementation.id, { annotations: [...stored, ...stored] });
      ingest({ handle });
      expect(annotationsOf(handle.store, implementation.id)).toEqual(stored);
    } finally {
      handle.close();
    }
  });

  it('counts an annotation it cannot place instead of dropping it in silence or failing the pass, because silent loss is the defect being fixed', () => {
    const { handle } = openFixture();
    try {
      seed(handle);
      ingest({ handle });
      const root = handle.store.root() as TreeNode;
      // A note on a node this trace does not produce (a foreign trace, or a
      // node a later segmentation dropped)...
      handle.trace.append(manualAnnotation({ node_id: 'n_ghost', blob: handle.blobs.put('note from another tree') }));
      // ...and a note whose body never reached L2.
      handle.trace.append(manualAnnotation({ node_id: root.id, blob: 'f'.repeat(64) }));

      const stats = ingest({ handle }).stats;
      expect(stats).toMatchObject({ annotations: 0, annotationLinks: 0, unresolvedAnnotations: 2 });
      // The rest of the pass is untouched: an unplaceable note is a reported
      // gap, not a broken ingestion (§18).
      expect(stats.nodes).toBe(6);
      expect(handle.store.nodesInCreationOrder().every((node) => node.meta_json.annotations === undefined)).toBe(true);
    } finally {
      handle.close();
    }
  });

  it('derives the identical L1 twice from an L0 that carries an annotation, which is the D8 claim with the write-side tool included', () => {
    const a = openFixture();
    const b = openFixture();
    try {
      seed(a.handle);
      ingest({ handle: a.handle });
      const [implementation, verification] = phasePair(a.handle.store);
      const annotation = manualAnnotation({
        node_id: implementation.id,
        blob: a.handle.blobs.put(NOTE),
        link_to: verification.id,
        link_kind: 'superseded_by',
      });
      a.handle.trace.append(annotation);
      ingest({ handle: a.handle });

      // The same L0, derived once instead of twice: the annotation names its
      // subject by an id the second store has to mint identically.
      b.handle.blobs.put(NOTE);
      seed(b.handle, [...fixtureEvents(b.handle.blobs), annotation]);
      ingest({ handle: b.handle });

      expect(project(b.handle.store)).toEqual(project(a.handle.store));
      expect(b.handle.store.linksFrom(implementation.id)).toEqual(a.handle.store.linksFrom(implementation.id));
      expect(annotationsOf(b.handle.store, implementation.id)).toHaveLength(1);
    } finally {
      a.handle.close();
      b.handle.close();
    }
  });
});

describe('span extraction (§12 step 3)', () => {
  it('writes spans onto the file node that covers the edit, and accumulates a re-edit without duplicating a span', () => {
    const { handle } = openFixture();
    try {
      seed(handle);
      const stats = ingest({ handle }).stats;
      const pricing = fileNode(handle.store, PRICING);
      const util = fileNode(handle.store, UTIL);

      // Edit 1 created the file with `price`; edit 2 changed `price` and added
      // `discount`. So: two spans, `price` present once.
      expect(pricing.meta_json.symbols).toEqual(['price', 'discount']);
      const keys = (pricing.meta_json.spans ?? []).map((span) => `${span.path}:${span.start_line}-${span.end_line}`);
      expect(keys.length).toBe(2);
      expect(new Set(keys).size).toBe(2);
      expect(keys[0]).toBe('src/pricing.ts:1-3');
      expect(util.meta_json.symbols).toEqual(['clamp']);
      expect(stats.spans).toBe(3);
      expect(stats.degradedFiles).toBe(0);
    } finally {
      handle.close();
    }
  });

  it('still spans a syntactically broken edit and counts the parse error, which is the entire reason §12 uses tree-sitter', () => {
    const { handle } = openFixture();
    try {
      const blob = handle.blobs.put('export function halfWritten(): number {\n  const x = 1;\n');
      seed(handle, [toolCall({ tool: 'Edit', path: 'src/wip.ts', blob })]);
      const stats = ingest({ handle }).stats;

      expect(stats.parseErrorFiles).toBe(1);
      expect((fileNode(handle.store, 'src/wip.ts').meta_json.spans ?? []).length).toBeGreaterThan(0);
    } finally {
      handle.close();
    }
  });

  it('degrades a file with no grammar to raw hunk spans and counts it, because ingestion must never fail on an unparseable file', () => {
    const { handle } = openFixture();
    try {
      const blob = handle.blobs.put('def price(base)\n  base * 0.9\nend\n');
      seed(handle, [toolCall({ tool: 'Edit', path: 'lib/pricing.rb', blob })]);
      const stats = ingest({ handle }).stats;

      expect(stats.degradedFiles).toBe(1);
      const node = fileNode(handle.store, 'lib/pricing.rb');
      expect(node.meta_json.spans?.[0]?.degraded).toBe(true);
      expect(node.meta_json.symbols).toEqual([]);
    } finally {
      handle.close();
    }
  });

  it('degrades a file node whose post-edit blob is missing and counts it, instead of failing the pass on an L2 gap', () => {
    const { handle } = openFixture();
    try {
      // A ref that was never `put`: L2 has no payload, so no coordinate exists.
      seed(handle, [toolCall({ tool: 'Edit', path: 'src/gone.ts', blob: 'a'.repeat(64) })]);
      const stats = ingest({ handle }).stats;

      expect(stats.degradedFiles).toBe(1);
      expect(stats.spans).toBe(0);
      // The node still exists: the tree's shape comes from L0, not from L2.
      expect(fileNode(handle.store, 'src/gone.ts').meta_json.spans).toBeUndefined();
    } finally {
      handle.close();
    }
  });
});

describe('hermeticity (D15)', () => {
  it('completes a full ingest with fetch trapped and a provider registry that throws on any access, which is the whole of D15', () => {
    const trap = new Proxy(
      {},
      {
        get() {
          throw new Error('D15 violated: ingestion consulted a retrieval provider');
        },
      },
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error('D15 violated: ingestion made a network call');
    }) as typeof globalThis.fetch;

    const { handle } = openFixture();
    try {
      seed(handle);
      // The registry is reachable from the handle, so *any* read of it throws.
      const trapped = { ...handle, providers: trap, retrieval: trap } as unknown as TaskStore;
      const stats = ingest({ handle: trapped }).stats;
      expect(stats.nodes).toBe(6);
      expect(stats.spans).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
      handle.close();
    }
  });

  it('imports nothing outside L0, L2, L1 and tree-sitter, because D15 is a property of the source and not of one lucky run', () => {
    const dir = fileURLToPath(new URL('../src/ingest', import.meta.url));
    const allowed = [
      '../config.js',
      '../contracts/index.js',
      '../paths.js',
      '../trace/index.js',
      '../blobs/index.js',
      '../store/index.js',
      '../segment/index.js',
      '../spans/index.js',
    ];
    const files = readdirSync(dir).filter((name) => name.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(1);
    for (const name of files) {
      const source = readFileSync(join(dir, name), 'utf8');
      for (const match of source.matchAll(/from '([^']+)'/g)) {
        const specifier = match[1] as string;
        if (specifier.startsWith('node:') || specifier.startsWith('./')) continue;
        expect(allowed).toContain(specifier);
      }
      expect(source).not.toMatch(/\bfetch\s*\(/);
    }
  });
});

describe('enrich (§7.1 optional post-pass)', () => {
  const NOW = '2026-02-02T00:00:00.000Z';

  function callersProvider(overrides: Partial<RetrievalProvider> = {}): RetrievalProvider {
    return {
      id: 'fake-graft',
      tier: 'structural',
      available: async () => true,
      search: async (query): Promise<Candidate[]> => [
        {
          path: 'src/checkout.ts',
          span: { start_line: 10, end_line: 12 },
          symbol: `calls_${query.query}`,
          score: 1,
          provider: 'fake-graft',
          tier: 'structural',
        },
      ],
      hydrate: async () => {
        // Enrichment annotates coordinates; pulling content is retrieval's job (§9).
        throw new Error('enrich must not hydrate');
      },
      ...overrides,
    };
  }

  /** Similar iff both texts mention `discount` — deterministic, and no model call in a test. */
  const embed = (text: string): Float32Array =>
    new Float32Array([text.includes('discount') ? 1 : 0, text.includes('unrelated') ? 1 : 0, 0.1, 0]);

  it('leaves the canonical projection identical with no providers, because absent providers must yield the same tree minus annotations', async () => {
    const { handle } = openFixture();
    try {
      seed(handle);
      ingest({ handle });
      const before = project(handle.store);

      expect(await enrich({ handle })).toEqual({ annotated: 0, links: 0, unavailable: [], failed: [] });
      expect(project(handle.store)).toEqual(before);
    } finally {
      handle.close();
    }
  });

  it('writes only provenance-stamped enrichment records, because nothing structural may depend on what a provider said', async () => {
    const { handle } = openFixture();
    try {
      seed(handle);
      ingest({ handle });
      const before = project(handle.store);

      const result = await enrich({ handle, providers: [callersProvider()], now: () => NOW });
      expect(result.annotated).toBe(2);
      expect(result.failed).toEqual([]);

      const records = fileNode(handle.store, PRICING).meta_json.enrichment ?? [];
      expect(records.length).toBe(1);
      expect(records[0]).toMatchObject({ provider: 'fake-graft', timestamp: NOW, kind: 'callers' });
      expect(JSON.stringify(records[0]?.data)).toContain('calls_price');
      // Spans, symbols, tools, spans-coordinates, staleness: all untouched.
      expect(withoutEnrichment(project(handle.store))).toEqual(withoutEnrichment(before));

      // A second pass replaces its own record instead of growing the array,
      // so re-enriching a long session cannot inflate L1 without bound.
      await enrich({ handle, providers: [callersProvider()], now: () => NOW });
      expect((fileNode(handle.store, PRICING).meta_json.enrichment ?? []).length).toBe(1);
    } finally {
      handle.close();
    }
  });

  it('reports a provider whose capability probe throws as unavailable and annotates nothing, because enrichment is best-effort', async () => {
    const { handle } = openFixture();
    try {
      seed(handle);
      ingest({ handle });
      const before = project(handle.store);

      const result = await enrich({
        handle,
        providers: [
          callersProvider({
            id: 'exploding',
            available: async () => {
              throw new Error('probe exploded');
            },
          }),
        ],
      });
      expect(result).toEqual({ annotated: 0, links: 0, unavailable: ['exploding'], failed: [] });
      expect(project(handle.store)).toEqual(before);
    } finally {
      handle.close();
    }
  });

  it('links two branches whose summary embeddings are close and leaves an unrelated branch unlinked, because a wrong lateral link misroutes a resumed session', async () => {
    const { handle } = openFixture();
    try {
      seed(handle);
      ingest({ handle });
      const store = handle.store;
      const texts = ['discount rounding in pricing', 'discount rounding fix applied', 'unrelated build tooling'];
      const phases = store.byKind('phase');
      phases.forEach((phase, index) => {
        store.putSummary({ node_id: phase.id, model: 'stub', text: texts[index] as string, meta: summaryMeta() });
      });

      // No embedder => the L3 pass cannot run, and nothing is written.
      expect((await enrich({ handle })).links).toBe(0);

      const result = await enrich({ handle, embed, now: () => NOW });
      expect(result.links).toBe(2);

      const [diagnosis, implementation, verification] = phases as [TreeNode, TreeNode, TreeNode];
      expect(store.linksFrom(diagnosis.id)).toEqual([
        { from_id: diagnosis.id, to_id: implementation.id, kind: 'relates_to', created_at: NOW },
      ]);
      expect(store.linksFrom(verification.id)).toEqual([]);

      const record = (store.getNode(diagnosis.id)?.meta_json.enrichment ?? [])[0];
      expect(record).toMatchObject({ provider: 'l3-summary-embeddings', timestamp: NOW, kind: 'relates_to' });
      expect(store.getNode(verification.id)?.meta_json.enrichment).toBeUndefined();
    } finally {
      handle.close();
    }
  });
});
