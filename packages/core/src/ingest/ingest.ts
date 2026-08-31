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
  BlobStore,
  DiffHunker,
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
import { applySegmentation } from './apply.js';
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

  const keyMap = applySegmentation(segmentation, store);
  const spans = extractSpansForFileNodes({
    events,
    blobs,
    store,
    keyMap,
    extractor: options.extractor ?? new TreeSitterSpanExtractor(config.languages),
    hunker: options.hunker ?? new LineDiffHunker(),
  });
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

/**
 * Hands the summarizer its work queue (§8) without ever calling it.
 *
 * Two marks, and the choice of *seq* in each is what makes the incremental path
 * converge on the rebuild's answer — `markStale` keeps the earliest seq, so both
 * marks have to be functions of L0 alone, not of when the mark was written:
 *  - every node that has no summary yet is stale at its own `span_start_seq`;
 *  - the leaf that covers the last event, plus its ancestors, are stale at that
 *    event (D4: leaf + ancestor path only — a sibling re-summarization is what
 *    breaks the amortized 1–3 calls per turn). For an unsummarized leaf this is
 *    a no-op, since the first mark is always earlier.
 */
function markStaleForSummarizer(store: TreeStore, lastSeq: Seq | null): void {
  store.transaction(() => {
    for (const node of store.nodesInCreationOrder()) {
      if (node.current_summary_version === 0 && node.span_start_seq !== null) {
        store.markStale(node.id, node.span_start_seq);
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
