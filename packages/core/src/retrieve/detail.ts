/**
 * L0 -> text for `fetch depth:"full"` and `peek` (§9).
 *
 * L1 stores coordinates, not content (§6): a node's content IS its `seq` range
 * over L0, with payloads behind L2 refs. So "the branch's raw detail" is a
 * replay of that range — never a column somebody remembered to keep in sync.
 */
import type { BlobRef, BlobStore, SeqSpan, TraceEvent, TraceLog, TreeNode } from '../contracts/index.js';
import { ARGS_CAP_WITH_BLOB, elision, safeCut } from '../assemble/format.js';
import {
  isAssistantMessage,
  isManualAnnotation,
  isReasoning,
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
 * Intersects each span with `[from ?? -inf, to ?? +inf]` — `fetch`'s
 * `from`/`to` (§9, R10). A span that lands entirely outside the range is
 * dropped rather than emitted empty, so an out-of-range request reads as "no
 * span here" instead of a zero-length one a caller has to special-case.
 *
 * An over-wide range is a no-op (the clamp cannot widen past the node's own
 * span), and this is what makes the concatenation of a partition of ranges
 * byte-identical to no range at all: `renderSpans`/`renderIndex` only ever see
 * narrower or equal spans, never a reordered or padded one.
 */
export function clampSpans(spans: readonly SeqSpan[], from?: number, to?: number): SeqSpan[] {
  if (from === undefined && to === undefined) return spans.map((span) => ({ ...span }));
  const result: SeqSpan[] = [];
  for (const span of spans) {
    const start = from === undefined ? span.start : Math.max(span.start, from);
    const end = to === undefined ? span.end : Math.min(span.end, to);
    if (start <= end) result.push({ start, end });
  }
  return result;
}

/**
 * The event's primary L2 payload, or null when it carries none. Used by
 * `peek`, which wants one cheap excerpt rather than every blob an
 * event references.
 */
export function payloadRef(event: TraceEvent): BlobRef | null {
  // Exhaustive: an event type this switch does not name is a type error, so the next one
  // cannot vanish from `peek` and the index the way `reasoning` did.
  switch (event.type) {
    case 'user_message':
    case 'assistant_message':
    case 'reasoning':
    case 'manual_annotation':
      return event.blob;
    case 'tool_call':
      return event.blob ?? event.args_blob ?? null;
    case 'tool_result':
      return event.output_blob ?? null;
    case 'segment_boundary':
      return null;
  }
}

function renderEvent(event: TraceEvent, blobs: BlobStore): string {
  const head = `[${event.seq}] ${event.type}`;
  if (isUserMessage(event) || isAssistantMessage(event) || isReasoning(event)) {
    return `${head}\n${blobs.getText(event.blob)}`;
  }
  if (isToolCall(event)) {
    const lines = [event.path === undefined ? `${head} ${event.tool}` : `${head} ${event.tool} path=${event.path}`];
    // Same rule as Zone C's renderer (`assemble/format.ts`, v5.9b): when a
    // post-state blob is present the args are capped, because a write's content
    // would otherwise appear twice in one payload — once JSON-escaped here and
    // once raw below. This renderer was missing the cap, so `fetch`
    // results carried the duplicate that Zone C had stopped carrying: measured
    // on the frozen store, 6 of 754 events duplicate byte-for-byte that way,
    // and it inflates exactly the branches that already tokenize larger than
    // the window they are read into. Dropping args instead went too far when
    // it was tried in Zone C (turns 13 → 25 on one scenario) — the args are the
    // model's only record of WHAT changed.
    if (event.args_blob !== undefined) {
      const args = blobs.getText(event.args_blob);
      const capped =
        event.blob !== undefined && args.length > ARGS_CAP_WITH_BLOB
          ? `${args.slice(0, safeCut(args, ARGS_CAP_WITH_BLOB))}${elision(args.length - safeCut(args, ARGS_CAP_WITH_BLOB))}`
          : args;
      lines.push(`--- args\n${capped}`);
    }
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
export function renderSpans(trace: TraceLog, blobs: BlobStore, spans: readonly SeqSpan[], part?: readonly TraceEvent['type'][]): RenderedDetail {
  const blocks: string[] = [];
  for (const span of spans) {
    for (const event of trace.read({ from: span.start, to: span.end })) {
      if (part !== undefined && !part.includes(event.type)) continue;
      blocks.push(renderEvent(event, blobs));
    }
  }
  return { text: blocks.join('\n\n'), events: blocks.length };
}

/**
 * `fetch depth:"index"` (§9, R10): one row per event — `seq · type ·
 * tool · path · bytes` — from L0 plus an L2 *stat*, never L2 text. This is
 * what keeps `index` a hermetic, D15-compliant peek at a branch's shape: it
 * lets a model decide WHERE to range-fetch without ever paying for, or
 * leaking, the content it hasn't asked for yet.
 *
 * Capped at `INDEX_ROW_CAP` rows with one D18-style elision line, reusing the
 * existing "no rendered list grows unboundedly" idiom (`assemble/format.ts`)
 * rather than inventing a second cap rule.
 */
const INDEX_ROW_CAP = 120;

export function renderIndex(trace: TraceLog, blobs: BlobStore, spans: readonly SeqSpan[]): RenderedDetail {
  const rows: string[] = [];
  let total = 0;
  for (const span of spans) {
    for (const event of trace.read({ from: span.start, to: span.end })) {
      total += 1;
      if (rows.length >= INDEX_ROW_CAP) continue;
      const ref = payloadRef(event);
      const bytes = ref === null ? 0 : blobs.size(ref);
      const tool = event.type === 'tool_call' ? event.tool : undefined;
      const path = event.type === 'tool_call' ? event.path : undefined;
      const parts = [`[${event.seq}] ${event.type}`];
      if (tool !== undefined) parts.push(tool);
      if (path !== undefined) parts.push(`path=${path}`);
      parts.push(`bytes=${bytes}`);
      rows.push(parts.join(' '));
    }
  }
  const more = total - rows.length;
  if (more > 0) rows.push(`(+${more} more)`);
  return { text: rows.join('\n'), events: Math.min(total, INDEX_ROW_CAP) };
}
