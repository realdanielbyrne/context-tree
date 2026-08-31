/**
 * §12 step 3 — write the spans tree-sitter extracted into the file node's
 * `meta_json`. Steps 1 and 2 (parse, minimal enclosing node) live in `spans/`;
 * this file only supplies coordinates and does the storing, because D9 keeps
 * the parser out of the store and the store out of the parser.
 *
 * Everything here degrades and counts instead of throwing. A work-in-progress
 * file that does not parse, or an edit whose payload never made it to L2, is
 * the normal case §12 exists for — an ingestion that failed on it would be
 * useless exactly when the agent needs the tree most (§18).
 */
import { isToolCall } from '../trace/index.js';
import { fileKey } from '../segment/index.js';
import { StoreInvariantError } from '../contracts/index.js';
import type {
  BlobStore,
  DiffHunker,
  NodeId,
  NodeKey,
  Seq,
  SpanExtraction,
  SpanExtractor,
  SymbolSpan,
  TraceEvent,
  TreeStore,
} from '../contracts/index.js';

export interface FileSpanInput {
  /** The same L0 events the segmentation was computed from, in seq order. */
  events: readonly TraceEvent[];
  blobs: BlobStore;
  store: TreeStore;
  /** Output of `applySegmentation` — the authority on which node a key is. */
  keyMap: ReadonlyMap<NodeKey, NodeId>;
  extractor: SpanExtractor;
  hunker: DiffHunker;
}

export interface FileSpanStats {
  /** File nodes that received at least one span. */
  filesWithSpans: number;
  /** Spans stored across those nodes, after dedup. */
  spans: number;
  /** File nodes §12 could not give grammar-backed spans: missing blob, no grammar, or a failed parse. */
  degradedFiles: number;
  /** File nodes whose parse produced ERROR nodes — spans still stored (the WIP case). */
  parseErrorFiles: number;
}

export function extractSpansForFileNodes(input: FileSpanInput): FileSpanStats {
  const { events, blobs, store, keyMap, extractor, hunker } = input;
  const phaseStarts = phaseOpenSeqs(store);
  const degraded = new Set<NodeId>();
  const parseErrors = new Set<NodeId>();
  const spanCounts = new Map<NodeId, number>();

  // One transaction: the whole pass is a single derived-layer write, and the
  // parses inside it are ms-scale by §7.1's own latency budget.
  store.transaction(() => {
    /** Previous post-edit content per path, so a re-edit diffs against the last revision of that file *in this trace*. */
    const previous = new Map<string, string>();
    let phaseCursor = 0;

    for (const event of events) {
      if (!isToolCall(event) || event.path === undefined || event.blob === undefined) continue;
      // Phases never overlap and events arrive in seq order, so a monotone
      // cursor keeps the pass O(n) (§7.1 reason 2).
      for (;;) {
        const next = phaseStarts[phaseCursor + 1];
        if (next === undefined || next > event.seq) break;
        phaseCursor += 1;
      }
      // No mapped file node => the tool is not one of `config.fileTools`, so
      // §7 never opened a file node for it. Nothing to annotate.
      const nodeId = keyMap.get(fileKey(phaseCursor, event.path));
      if (nodeId === undefined) continue;

      let content: string;
      try {
        content = blobs.getText(event.blob);
      } catch {
        // The post-edit payload is gone, so this edit's coordinates are
        // unknowable. The node stays span-less and is counted, never dropped.
        degraded.add(nodeId);
        continue;
      }

      const before = previous.get(event.path) ?? null;
      previous.set(event.path, content);
      const hunks = hunker.hunks(before, content);
      // An idempotent write changed no line, so it has no span to contribute.
      if (hunks.length === 0) continue;

      let extraction: SpanExtraction;
      try {
        extraction = extractor.extract({ path: event.path, content, hunks });
      } catch {
        degraded.add(nodeId);
        continue;
      }
      if (extraction.degraded) degraded.add(nodeId);
      if (extraction.hasParseError) parseErrors.add(nodeId);

      spanCounts.set(nodeId, accumulate(store, nodeId, extraction));
    }
  });

  let spans = 0;
  for (const count of spanCounts.values()) spans += count;
  return {
    filesWithSpans: spanCounts.size,
    spans,
    degradedFiles: degraded.size,
    parseErrorFiles: parseErrors.size,
  };
}

/** Opening seq of each phase node in open order — the index a `file:<i>:<path>` key is built from. */
function phaseOpenSeqs(store: TreeStore): Seq[] {
  const root = store.root();
  if (root === null) return [];
  return store
    .children(root.id)
    .filter((node) => node.kind === 'phase')
    .map((node) => node.span_start_seq ?? 0);
}

/**
 * §7: "re-edits append spans to the same file node". Accumulating (rather than
 * letting the last edit win) is what makes the node's span list the whole set
 * of coordinates an agent touched there — and dedup by exact coordinate is what
 * keeps a re-ingest of the same L0 from growing it (D8 determinism).
 */
function accumulate(store: TreeStore, id: NodeId, extraction: SpanExtraction): number {
  const node = store.getNode(id);
  if (node === null) throw new StoreInvariantError(`span extraction targeted unknown node ${id}`);

  const spans = [...(node.meta_json.spans ?? [])];
  const seenSpans = new Set(spans.map(spanKey));
  for (const span of extraction.spans) {
    const key = spanKey(span);
    if (seenSpans.has(key)) continue;
    seenSpans.add(key);
    spans.push(span);
  }

  const symbols = [...(node.meta_json.symbols ?? [])];
  const seenSymbols = new Set(symbols);
  for (const symbol of extraction.symbols) {
    if (seenSymbols.has(symbol)) continue;
    seenSymbols.add(symbol);
    symbols.push(symbol);
  }

  store.mergeNodeMeta(id, { spans, symbols });
  return spans.length;
}

function spanKey(span: SymbolSpan): string {
  return `${span.path}:${span.start_line}-${span.end_line}:${span.symbol ?? ''}:${span.kind ?? ''}`;
}
