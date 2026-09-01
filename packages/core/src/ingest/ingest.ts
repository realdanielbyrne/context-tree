/**
 * The mandatory ingestion pass (§7.1, D15): **hermetic**. It reads L0 and L2,
 * parses blobs with tree-sitter, writes L1 — and calls no provider, no graft,
 * no network, ever. The reasons are D8 (a tree that depended on an external
 * index could not be rebuilt reproducibly), latency (this path is inline and
 * ms-scale; a semantic query is seconds-scale), and coverage (the semantics
 * ingestion needs is local to the edited file, which is tree-sitter's job).
 *
 * Mnemonic from the plan: ingestion produces coordinates, retrieval answers
 * questions, enrichment decorates — never the reverse. Enrichment therefore
 * lives in `enrich.ts` and is never called from here.
 */
import { rmSync } from 'node:fs';
import type { ContextTreeConfig } from '../config.js';
import type {
  Annotation,
  BlobStore,
  DiffHunker,
  LinkKind,
  NodeId,
  NodeKey,
  Seq,
  SpanExtractor,
  TraceEvent,
  TraceEventInput,
  TreeNode,
  TreeStore,
} from '../contracts/index.js';
import { DERIVED_LAYERS, storePaths, type StorePaths } from '../paths.js';
import { segment } from '../segment/index.js';
import { LineDiffHunker, TreeSitterSpanExtractor } from '../spans/index.js';
import { isManualAnnotation } from '../trace/index.js';
import { applySegmentation } from './apply.js';
import { nodeIdMinter } from './node-ids.js';
import { extractSpansForFileNodes } from './spans.js';
import { openTaskStore, type TaskStore } from './task-store.js';

export interface IngestOptions {
  handle: TaskStore;
  /**
   * §12 span extraction. Injected so a test can supply a stub; the default is
   * the tree-sitter extractor, which is the only outside code the hermetic path
   * is allowed to consult (D15).
   */
  extractor?: SpanExtractor;
  hunker?: DiffHunker;
}

export interface IngestStats {
  events: number;
  /** Nodes in the tree after the pass — root + phases + file nodes. */
  nodes: number;
  phases: number;
  fileNodes: number;
  /** Spans stored on file nodes (§12). */
  spans: number;
  /** File nodes that got no grammar-backed spans — degraded, never fatal. */
  degradedFiles: number;
  /** File nodes whose parse had ERROR nodes; spans were still stored. */
  parseErrorFiles: number;
  /** Tool names with no phase mapping; routed to `other` (§18). */
  unmappedTools: string[];
  usedTextFallback: boolean;
  /** §9 `annotate` notes replayed from L0 onto their subject node. */
  annotations: number;
  /** D10 lateral edges replayed from L0. */
  annotationLinks: number;
  /**
   * `manual_annotation` events that did not replay in full — an unknown
   * subject, a missing L2 body, or an unknown link target. Counted rather than
   * dropped: silent loss is exactly the defect this replay exists to fix.
   */
  unresolvedAnnotations: number;
}

export interface IngestResult {
  stats: IngestStats;
  /** Deterministic key -> minted node id. Callers need it; it also makes the mapping assertable. */
  keyMap: Map<NodeKey, NodeId>;
}

export function ingest(options: IngestOptions): IngestResult {
  const { config, trace, blobs, store } = options.handle;
  const events = trace.all();

  const segmentation = segment(events, {
    toolPhase: config.toolPhase,
    neutralPhases: config.neutralPhases,
    fileTools: config.fileTools,
    taskTitle: config.taskTitle,
    textOf: textResolver(blobs),
  });

  const keyMap = applySegmentation(segmentation, store, nodeIdMinter(events));
  const spans = extractSpansForFileNodes({
    events,
    blobs,
    store,
    keyMap,
    extractor: options.extractor ?? new TreeSitterSpanExtractor(config.languages),
    hunker: options.hunker ?? new LineDiffHunker(),
  });
  const notes = replayAnnotations(events, blobs, store);
  markStaleForSummarizer(store, events.at(-1)?.seq ?? null);

  return {
    keyMap,
    stats: {
      events: segmentation.stats.events,
      nodes: keyMap.size,
      phases: segmentation.stats.phases,
      fileNodes: segmentation.stats.fileNodes,
      spans: spans.spans,
      degradedFiles: spans.degradedFiles,
      parseErrorFiles: spans.parseErrorFiles,
      unmappedTools: segmentation.stats.unmappedTools,
      usedTextFallback: segmentation.stats.usedTextFallback,
      annotations: notes.annotations,
      annotationLinks: notes.annotationLinks,
      unresolvedAnnotations: notes.unresolved,
    },
  };
}

export interface AppendResult extends IngestResult {
  /** The event as stored, with the seq L0 assigned it. */
  event: TraceEvent;
}

/**
 * The incremental path: append to L0, then re-derive L1 from the whole log.
 *
 * Documented v1 tradeoff: this is O(n) per append rather than O(1), because
 * re-segmenting everything and reconciling is the cheapest way to *guarantee*
 * that N appends leave exactly the tree a `rebuild()` produces — the property
 * the plan lists as literature gap 2 and that `ingest.test.ts` asserts. The
 * segmenter is a single zero-LLM pass, so the constant is microseconds; if a
 * long session ever makes it matter, the fix is a resume-from-seq segmenter,
 * not a divergent second write path.
 *
 * The appended event is by construction the last one, so the leaf `ingest`
 * cascades staleness from (below) is the leaf this append touched (D4).
 */
export function appendEvent(
  handle: TaskStore,
  input: TraceEventInput,
  options: Omit<IngestOptions, 'handle'> = {},
): AppendResult {
  const event = handle.trace.append(input);
  return { event, ...ingest({ handle, ...options }) };
}

export interface RebuildResult extends IngestResult {
  /** Opened by the rebuild (the db file had to be deleted first); the caller closes it. */
  handle: TaskStore;
}

/**
 * §5's rebuild rule: L1/L3/L4 are always deterministic functions of L0 + L2, so
 * a segmenter or prompt change is answered by **deleting the derived layers and
 * replaying**, never by migrating L1 (D8). L0 and L2 are not touched here.
 *
 * Any handle on the old db must be closed before calling: the db file is
 * deleted, not truncated.
 */
export function rebuild(
  config: ContextTreeConfig,
  options: Omit<IngestOptions, 'handle'> = {},
): RebuildResult {
  deleteDerivedLayers(storePaths(config.root));
  const handle = openTaskStore(config);
  return { handle, ...ingest({ handle, ...options }) };
}

function deleteDerivedLayers(paths: StorePaths): void {
  for (const layer of DERIVED_LAYERS) {
    const target = paths[layer];
    rmSync(target, { recursive: true, force: true });
    if (layer === 'db') {
      // `journal_mode = WAL` leaves `-wal`/`-shm` beside the db. A surviving
      // WAL would replay committed rows into the fresh file, which is the one
      // way a "rebuild" could quietly stop being a function of L0 + L2.
      rmSync(`${target}-wal`, { force: true });
      rmSync(`${target}-shm`, { force: true });
    }
  }
}

interface AnnotationReplay {
  annotations: number;
  annotationLinks: number;
  unresolved: number;
}

/** §9 makes `link_kind` optional; the neutral "these are related" edge is the kind it means. */
const DEFAULT_LINK_KIND: LinkKind = 'relates_to';

/**
 * Replays every `manual_annotation` (§6's sixth L0 type, written by §9's
 * `annotate`) into L1: the note onto `meta_json.annotations[]`, the edge into
 * `node_links` (D10).
 *
 * This is what makes D8 true of the write-side tool. Ingestion used to see the
 * event only as an "extend the open phase" tick, so the notes and edges in L1
 * were there purely because `annotate` had written them at runtime — and
 * `rebuild()`, which derives L1 from scratch, dropped every one of them. The
 * plan instructs users to rebuild after a segmenter or summary-prompt change,
 * so the documented workflow was the thing destroying the data.
 *
 * Three properties, each a requirement rather than a nicety:
 *  - **Replay, not re-creation.** `created_at` is the event's own `ts` and the
 *    note's identity is its own `seq`. A fresh clock here would make two
 *    derivations of one log differ, which is the invariant this fixes.
 *  - **Idempotent.** Notes merge by seq and land in seq order, so ingesting a
 *    log twice yields one note; `putLink` upserts on (from, to, kind), so the
 *    edge is written once however often the pass runs.
 *  - **Loud.** A subject id that is absent or resolves to nothing (a foreign
 *    trace, a note on a node a later segmentation no longer produces), a body
 *    missing from L2, or an unknown link target is counted in the stats. Silent
 *    loss is the defect being fixed, so it must not reappear as a silent skip.
 *
 * Hermetic like the rest of the pass (D15): L0 for the coordinates, L2 for the
 * text, nothing else.
 */
function replayAnnotations(
  events: readonly TraceEvent[],
  blobs: BlobStore,
  store: TreeStore,
): AnnotationReplay {
  const notes = new Map<NodeId, Annotation[]>();
  const links: Array<{ from_id: NodeId; to_id: NodeId; kind: LinkKind; created_at: string }> = [];
  let unresolved = 0;
  let annotations = 0;

  for (const event of events) {
    if (!isManualAnnotation(event)) continue;
    // The id L0 carries was minted by `node-ids.ts` from the segmentation key,
    // so the same trace mints it again here — that is why a plain lookup is a
    // sound resolution and why the raw id in L0 survives a rebuild at all.
    const subject = event.node_id === undefined ? null : store.getNode(event.node_id);
    if (subject === null || !blobs.has(event.blob)) {
      unresolved += 1;
      continue;
    }
    const list = notes.get(subject.id) ?? [];
    list.push({ seq: event.seq, text: blobs.getText(event.blob), created_at: event.ts });
    notes.set(subject.id, list);
    annotations += 1;

    if (event.link_to === undefined) continue;
    const target = store.getNode(event.link_to);
    if (target === null) {
      // The note still landed; the edge did not. Counted either way — a partial
      // replay a caller cannot see is the same failure in a smaller box.
      unresolved += 1;
      continue;
    }
    links.push({
      from_id: subject.id,
      to_id: target.id,
      kind: event.link_kind ?? DEFAULT_LINK_KIND,
      created_at: event.ts,
    });
  }

  store.transaction(() => {
    for (const [id, derived] of notes) {
      const current = store.getNode(id)?.meta_json.annotations ?? [];
      const merged = mergeAnnotations(current, derived);
      if (merged !== null) store.mergeNodeMeta(id, { annotations: merged });
    }
    for (const link of links) store.putLink(link);
  });

  return { annotations, annotationLinks: links.length, unresolved };
}

/**
 * Canonical annotation list: one entry per L0 seq, ascending. Returns null when
 * the stored list already is that list, so a re-ingestion writes nothing.
 *
 * Seq is the merge key because it is the note's identity (§9). Where L0 speaks
 * it wins, since L1 is the derived layer (D8); an entry L0 says nothing about
 * is kept rather than deleted, because `annotate` also writes L1 directly today
 * and dropping what this pass cannot see would be the same silent loss in the
 * other direction.
 */
function mergeAnnotations(current: readonly Annotation[], derived: readonly Annotation[]): Annotation[] | null {
  const bySeq = new Map<Seq, Annotation>();
  for (const annotation of current) bySeq.set(annotation.seq, annotation);
  for (const annotation of derived) bySeq.set(annotation.seq, annotation);
  const merged = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  const unchanged =
    merged.length === current.length &&
    merged.every((annotation, index) => {
      const existing = current[index];
      return (
        existing !== undefined &&
        existing.seq === annotation.seq &&
        existing.text === annotation.text &&
        existing.created_at === annotation.created_at
      );
    });
  return unchanged ? null : merged;
}

/**
 * Hands the summarizer its work queue (§8) without ever calling it.
 *
 * Two marks, and the choice of *seq* in each is what makes the incremental path
 * converge on the rebuild's answer — both have to be functions of L0 alone, not
 * of when the mark was written:
 *  - every node that has no summary yet is stale at its own `span_start_seq`,
 *    written with `setStale` because this is reconciliation: a re-segmentation
 *    can move a node's `span_start_seq` *later* (§7's text fallback handing over
 *    to the tool state machine does exactly that), and `markStale` keeps the
 *    earliest seq by contract, so it would leave the superseded lower bound
 *    behind — the one field on which N appends used to differ from a rebuild
 *    (the plan's literature gap 2 is that they do not);
 *  - the leaf that covers the last event, plus its ancestors, are stale at that
 *    event (D4: leaf + ancestor path only — a sibling re-summarization is what
 *    breaks the amortized 1–3 calls per turn). For an unsummarized leaf this is
 *    a no-op, since the first mark is always earlier.
 *
 * A node that *has* a summary is left to `markStale`: its staleness records
 * appends made since that summary, which is genuinely incremental state and not
 * derivable from L0.
 */
function markStaleForSummarizer(store: TreeStore, lastSeq: Seq | null): void {
  store.transaction(() => {
    for (const node of store.nodesInCreationOrder()) {
      if (node.current_summary_version === 0) {
        store.setStale(node.id, node.span_start_seq);
      }
    }
    if (lastSeq === null) return;
    const leaf = deepestCovering(store, lastSeq);
    if (leaf !== null) store.markStaleCascade(leaf.id, lastSeq);
  });
}

/** Deepest node whose span covers `seq` — the leaf the newest content landed in. */
function deepestCovering(store: TreeStore, seq: Seq): TreeNode | null {
  let best: TreeNode | null = null;
  let bestDepth = -1;
  for (const node of store.nodesInCreationOrder()) {
    const { span_start_seq: start, span_end_seq: end } = node;
    if (start === null || end === null || seq < start || seq > end) continue;
    const depth = store.ancestorPath(node.id).length;
    if (depth > bestDepth) {
      best = node;
      bestDepth = depth;
    }
  }
  return best;
}

/**
 * L0 holds blob refs, not text, so the §7 text-segmentation fallback needs L2
 * resolved for it — and doing that here is what keeps `segment()` pure (D1).
 * A missing blob resolves to no text rather than failing the pass: the fallback
 * only ever affects boundary placement, and ingestion must not die on L2 gaps.
 */
function textResolver(blobs: BlobStore): (event: TraceEvent) => string {
  return (event) => {
    const ref = 'blob' in event ? event.blob : undefined;
    if (typeof ref !== 'string') return '';
    try {
      return blobs.getText(ref);
    } catch {
      return '';
    }
  };
}
