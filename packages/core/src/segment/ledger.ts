/**
 * THE FOLD LEDGER — what has been shown in a shorter form, read from and written to L0.
 *
 * A fold is a range of the transcript (`from_seq..to_seq`) standing in as a `stub` (one
 * block, summary-free text) or a `summary` (many blocks, model-written). Both are `fold`
 * events, so L0 is the truth for them as for everything else: a rebuild replays them, and
 * what the model was shown on any turn can be reconstructed. An `unfold` retires one; its
 * record stays. Ranges may overlap — two summaries over `1:65` and `40:85` are both legal.
 *
 * A summary whose range is exactly a segment's span carries that `node_id`, and IS that
 * node's summary: `node_summaries` (D3) is derived from these events by `ingest`, in order,
 * so versions come out the same on every rebuild.
 *
 * Pure over events; the one writer that touches a store (`writeSummary`) lives here so
 * every summary in the system goes through the same door.
 */
import type { BlobStore, NewSummary, NodeId, NodeSummary, Seq, SummaryMeta, TraceEvent, TraceLog, TreeStore } from '../contracts/index.js';
import type { FoldEvent } from '../contracts/trace.js';

export interface Fold {
  readonly id: string;
  readonly kind: 'stub' | 'summary';
  readonly fromSeq: Seq;
  readonly toSeq: Seq;
  readonly blob: string;
  readonly nodeId?: NodeId;
  readonly model?: string;
  readonly trigger?: string;
  /** The L0 position of the fold event itself: the turn it was made on. */
  readonly seq: Seq;
  readonly ts: string;
}

/** Every fold still in force, in the order written. */
export function foldsFrom(events: Iterable<TraceEvent>): Fold[] {
  const byId = new Map<string, Fold>();
  for (const event of events) {
    if (event.type === 'fold') {
      byId.set(event.fold_id, {
        id: event.fold_id, kind: event.kind, fromSeq: event.from_seq, toSeq: event.to_seq, blob: event.blob, seq: event.seq, ts: event.ts,
        ...(event.node_id !== undefined ? { nodeId: event.node_id } : {}),
        ...(event.model !== undefined ? { model: event.model } : {}),
        ...(event.trigger !== undefined ? { trigger: event.trigger } : {}),
      });
    } else if (event.type === 'unfold') {
      byId.delete(event.fold_id);
    }
  }
  return [...byId.values()];
}

/** Fold ids are the ordinal of the event that made them — unique, stable, and readable. */
export const summaryFoldId = (seq: Seq): string => `m${String(seq)}`;
export const stubFoldId = (fromSeq: Seq): string => `s${String(fromSeq)}`;

interface SummaryBlob {
  text: string;
  meta: SummaryMeta;
}

export const parseSummaryBlob = (text: string): SummaryBlob => JSON.parse(text) as SummaryBlob;

export interface Ledger {
  readonly trace: TraceLog;
  readonly blobs: BlobStore;
}

/**
 * The one way a summary is written. With a ledger, the fold event is appended FIRST (L0 is
 * the truth); the `node_summaries` row is the derived index of it. Without one — a store
 * summarized on its own, as older tests do — only the row is written.
 */
export function writeSummary(store: TreeStore, summary: NewSummary, ledger: Ledger | null, trigger?: string): NodeSummary {
  if (ledger !== null) {
    const node = store.getNode(summary.node_id);
    if (node !== null && node.span_start_seq !== null) {
      const payload: SummaryBlob = { text: summary.text, meta: summary.meta };
      const at = ledger.trace.lastSeq() + 1;
      const event: Omit<FoldEvent, 'seq'> = {
        type: 'fold',
        ts: summary.created_at ?? new Date().toISOString(),
        fold_id: summaryFoldId(at),
        kind: 'summary',
        from_seq: node.span_start_seq,
        to_seq: node.span_end_seq ?? node.span_start_seq,
        blob: ledger.blobs.put(JSON.stringify(payload)),
        node_id: summary.node_id,
        model: summary.model,
        ...(trigger !== undefined ? { trigger } : {}),
      };
      ledger.trace.append(event);
    }
  }
  return store.putSummary(summary);
}

/**
 * Derive `node_summaries` from the ledger: every summary fold with a node id, in L0 order,
 * so versions come out as the live run wrote them. Idempotent — `ingest` runs on every
 * append, so only the folds the store does not hold yet are written (a node's versions are
 * a prefix of its ledger folds). Returns how many were written and how many named a node
 * this segmentation does not have.
 */
export function replaySummaries(events: readonly TraceEvent[], blobs: BlobStore, store: TreeStore): { summaries: number; unresolved: number } {
  let summaries = 0;
  let unresolved = 0;
  const seen = new Map<NodeId, number>();
  store.transaction(() => {
    for (const event of events) {
      if (event.type !== 'fold' || event.kind !== 'summary' || event.node_id === undefined) continue;
      if (store.getNode(event.node_id) === null || !blobs.has(event.blob)) {
        unresolved += 1;
        continue;
      }
      const ordinal = (seen.get(event.node_id) ?? 0) + 1;
      seen.set(event.node_id, ordinal);
      if (store.summaryVersions(event.node_id).length >= ordinal) continue;
      const { text, meta } = parseSummaryBlob(blobs.getText(event.blob));
      store.putSummary({ node_id: event.node_id, model: event.model ?? 'unknown', text, meta, created_at: event.ts });
      summaries += 1;
    }
  });
  return { summaries, unresolved };
}
