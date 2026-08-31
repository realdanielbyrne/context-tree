/**
 * The L0 write side of mode gating (D14, §9.2; controller ruling C9).
 *
 * Mode A — `tool-backend`, the v1 default (§19 Q5): the read tools are
 * read-only. Nothing is appended to L0, so installing context-tree alongside a
 * host's native tools cannot change the trace the host is producing.
 *
 * Mode B — `middleware`: "every retrieval (including proxied graft/grep calls)
 * lands in L0 as a normal `tool_call` event, so the segmenter indexes it into
 * the tree with zero new machinery". That is the whole implementation: an
 * ordinary call/result pair plus the ordinary ingestion pass. `context_fetch`
 * and friends are unmapped tool names, so §7 routes them to `other`, which is
 * neutral — retrieval history attaches to the open phase instead of splitting
 * it (§18: unknown tools never crash).
 *
 * `annotate` records in BOTH modes: it is an explicit write tool, so its L0
 * record is not mode-dependent.
 */
import { ingest, type LinkKind, type NodeId, type TraceEvent } from '@context-tree/core';
import { modeOf, type ToolContext } from './types.js';

/** Re-derives L1 so its spans cover the events just written (L1 is a function of L0 + L2, D8). */
function reindex(ctx: ToolContext): void {
  ingest({ handle: ctx.handle });
}

/**
 * Appends the Mode B call/result pair. The full result text goes to L2: it is
 * content-addressed, so re-fetching one branch N times costs one blob, and the
 * retrieval becomes replayable detail under the phase that asked for it.
 */
export function recordRetrieval(ctx: ToolContext, tool: string, args: unknown, output: unknown): void {
  if (modeOf(ctx) !== 'middleware') return;
  const { trace, blobs } = ctx.handle;
  const ts = new Date().toISOString();
  const call = trace.append({ type: 'tool_call', ts, tool, args_blob: blobs.put(JSON.stringify(args)) });
  trace.append({
    type: 'tool_result',
    ts,
    call_seq: call.seq,
    output_blob: blobs.put(JSON.stringify(output)),
  });
  reindex(ctx);
}

export interface AnnotationRecord {
  ts: string;
  nodeId: NodeId;
  text: string;
  linkTo?: NodeId;
  linkKind?: LinkKind;
}

/**
 * Writes the `manual_annotation` L0 event, then re-indexes so the note is
 * covered by a node span and replays with the branch. Returns the stored event
 * because its `seq` is the annotation's identity in `Annotation.seq`.
 */
export function recordAnnotation(ctx: ToolContext, record: AnnotationRecord): TraceEvent {
  const event = ctx.handle.trace.append({
    type: 'manual_annotation',
    ts: record.ts,
    node_id: record.nodeId,
    blob: ctx.handle.blobs.put(record.text),
    link_to: record.linkTo,
    link_kind: record.linkKind,
  });
  reindex(ctx);
  return event;
}
