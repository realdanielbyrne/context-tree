/**
 * L0 -> text for `context_fetch depth:"full"` and `context_peek` (§9).
 *
 * L1 stores coordinates, not content (§6): a node's content IS its `seq` range
 * over L0, with payloads behind L2 refs. So "the branch's raw detail" is a
 * replay of that range — never a column somebody remembered to keep in sync.
 */
import type { BlobRef, BlobStore, SeqSpan, TraceEvent, TraceLog, TreeNode } from '../contracts/index.js';
import {
  isAssistantMessage,
  isManualAnnotation,
  isSegmentBoundary,
  isToolCall,
  isToolResult,
  isUserMessage,
} from '../trace/index.js';

export interface RenderedDetail {
  text: string;
  events: number;
}

/** A node's L0 range, or null when nothing has landed under it yet. */
export function nodeSpan(node: TreeNode): SeqSpan | null {
  if (node.span_start_seq === null) return null;
  return { start: node.span_start_seq, end: node.span_end_seq ?? node.span_start_seq };
}

/**
 * Sorted, non-overlapping union. Overlaps are real — a phase node's span
 * covers its file children's — and each span costs one full L0 scan, so
 * merging is what keeps a narrowed fetch from re-reading the log per node.
 */
export function mergeSpans(spans: readonly SeqSpan[]): SeqSpan[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: SeqSpan[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.start <= last.end + 1) {
      last.end = Math.max(last.end, span.end);
      continue;
    }
    merged.push({ start: span.start, end: span.end });
  }
  return merged;
}

/**
 * The event's primary L2 payload, or null when it carries none. Used by
 * `context_peek`, which wants one cheap excerpt rather than every blob an
 * event references.
 */
export function payloadRef(event: TraceEvent): BlobRef | null {
  if (isUserMessage(event) || isAssistantMessage(event) || isManualAnnotation(event)) return event.blob;
  if (isToolCall(event)) return event.blob ?? event.args_blob ?? null;
  if (isToolResult(event)) return event.output_blob ?? null;
  return null;
}

function renderEvent(event: TraceEvent, blobs: BlobStore): string {
  const head = `[${event.seq}] ${event.type}`;
  if (isUserMessage(event) || isAssistantMessage(event)) {
    return `${head}\n${blobs.getText(event.blob)}`;
  }
  if (isToolCall(event)) {
    const lines = [event.path === undefined ? `${head} ${event.tool}` : `${head} ${event.tool} path=${event.path}`];
    if (event.args_blob !== undefined) lines.push(`--- args\n${blobs.getText(event.args_blob)}`);
    if (event.blob !== undefined) lines.push(`--- content\n${blobs.getText(event.blob)}`);
    return lines.join('\n');
  }
  if (isToolResult(event)) {
    const lines = [`[${event.seq}] tool_result(call=${event.call_seq})${event.truncated === true ? ' truncated' : ''}`];
    if (event.error !== undefined) lines.push(`error: ${event.error}`);
    if (event.output_blob !== undefined) lines.push(blobs.getText(event.output_blob));
    return lines.join('\n');
  }
  if (isSegmentBoundary(event)) {
    return `${head} ${event.from ?? 'null'} -> ${event.to}`;
  }
  if (isManualAnnotation(event)) {
    const target = event.node_id === undefined ? '' : ` node=${event.node_id}`;
    return `${head}${target}\n${blobs.getText(event.blob)}`;
  }
  return head;
}

/**
 * Replays `spans` out of L0 in seq order. A missing blob throws (L2 is
 * write-once and L1 points into it) — a derived layer pointing at content that
 * was never durably written is a corruption, not a degradable condition.
 */
export function renderSpans(trace: TraceLog, blobs: BlobStore, spans: readonly SeqSpan[]): RenderedDetail {
  const blocks: string[] = [];
  for (const span of spans) {
    for (const event of trace.read({ from: span.start, to: span.end })) {
      blocks.push(renderEvent(event, blobs));
    }
  }
  return { text: blocks.join('\n\n'), events: blocks.length };
}
