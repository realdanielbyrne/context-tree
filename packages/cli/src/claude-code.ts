/**
 * Claude Code session transcript (JSONL) -> L0 events + L2 blobs.
 *
 * A real transcript carries lines L0 has no event for (session summaries,
 * system notices, file-history snapshots) and lines that are simply broken, so
 * this maps what it can and reports the rest by line number: a partially
 * importable transcript is the normal case, not an error condition.
 *
 * Nothing here interprets meaning — it produces coordinates and payload refs
 * only. The segmenter (§7) is what turns them into a tree, from L0 alone (D8),
 * which is why every synthesized field is a function of the input: a line with
 * no timestamp inherits the previous line's rather than reading the clock.
 */
import type {
  AssistantMessageEvent,
  BlobStore,
  ReasoningEvent,
  ToolCallEvent,
  ToolResultEvent,
  TraceEventInput,
  UserMessageEvent,
} from '@context-tree/core';

export interface LineFailure {
  /** 1-based line number in the source file. */
  line: number;
  error: string;
}

export interface TranscriptResult {
  /** L0 events with seqs already assigned, ready for `appendAll`. */
  events: TraceEventInput[];
  failures: LineFailure[];
  /** Lines carrying nothing L0 represents (summaries, system notices). */
  skipped: number;
  /** Payloads newly written to L2. */
  blobsWritten: number;
}

export interface TranscriptOptions {
  /** `trace.lastSeq()` — the first event minted gets `startSeq + 1`. */
  startSeq: number;
  blobs: BlobStore;
}

/** A line with no timestamp and no predecessor: fixed, so mapping is deterministic. */
const EPOCH = '1970-01-01T00:00:00.000Z';

const ERROR_DETAIL_CHARS = 200;

export function mapClaudeCodeTranscript(
  lines: readonly string[],
  options: TranscriptOptions,
): TranscriptResult {
  const events: TraceEventInput[] = [];
  const failures: LineFailure[] = [];
  /** tool_use id -> the seq of the `tool_call` it became, for `call_seq`. */
  const callSeqs = new Map<string, number>();
  let skipped = 0;
  let blobsWritten = 0;
  let ts = EPOCH;

  const nextSeq = (): number => options.startSeq + events.length + 1;
  const put = (content: string): string => {
    const ref = options.blobs.digest(content);
    if (!options.blobs.has(ref)) blobsWritten += 1;
    return options.blobs.put(content);
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = index + 1;
    const raw = lines[index] ?? '';
    if (raw.trim().length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      failures.push({ line, error: `invalid JSON: ${(error as Error).message}` });
      continue;
    }
    if (!isRecord(parsed)) {
      failures.push({ line, error: 'expected a JSON object' });
      continue;
    }
    if (typeof parsed.timestamp === 'string') ts = parsed.timestamp;

    const kind = parsed.type;
    if (kind !== 'user' && kind !== 'assistant') {
      skipped += 1;
      continue;
    }
    // Harness-injected lines (hook output, reminders) masquerade as user turns.
    if (parsed.isMeta === true) {
      skipped += 1;
      continue;
    }
    const message = parsed.message;
    if (!isRecord(message)) {
      failures.push({ line, error: `${kind} line has no "message" object` });
      continue;
    }
    const blocks = contentBlocks(message.content);
    if (blocks.length === 0) {
      failures.push({ line, error: `${kind} message has no content` });
      continue;
    }

    const thinking = joinText(blocks, 'thinking');
    if (thinking.length > 0) {
      const event: TraceEventInput<ReasoningEvent> = { seq: nextSeq(), type: 'reasoning', ts, blob: put(thinking) };
      events.push(event);
    }

    const text = joinText(blocks);
    let messageSeq: number | undefined;
    if (text.length > 0) {
      messageSeq = nextSeq();
      const blob = put(text);
      const event: TraceEventInput<UserMessageEvent> | TraceEventInput<AssistantMessageEvent> =
        kind === 'user'
          ? { seq: messageSeq, type: 'user_message', ts, blob }
          : { seq: messageSeq, type: 'assistant_message', ts, blob };
      events.push(event);
    }

    for (const block of blocks) {
      if (!isRecord(block)) continue;
      if (block.type === 'tool_use') {
        const seq = nextSeq();
        const call = toolCall(block, ts, seq, messageSeq, put);
        if (typeof call === 'string') {
          failures.push({ line, error: call });
          continue;
        }
        const id = block.id;
        if (typeof id === 'string') callSeqs.set(id, seq);
        events.push(call);
        continue;
      }
      if (block.type === 'tool_result') {
        const result = toolResult(block, ts, nextSeq(), callSeqs, put);
        if (typeof result === 'string') {
          failures.push({ line, error: result });
          continue;
        }
        events.push(result);
      }
    }
  }

  return { events, failures, skipped, blobsWritten };
}

/** Either the event, or the failure message describing why the block was unmappable. */
function toolCall(
  block: Record<string, unknown>,
  ts: string,
  seq: number,
  parentSeq: number | undefined,
  put: (content: string) => string,
): TraceEventInput<ToolCallEvent> | string {
  const tool = block.name;
  if (typeof tool !== 'string' || tool.length === 0) return 'tool_use block has no "name"';
  const input = isRecord(block.input) ? block.input : {};
  const event: TraceEventInput<ToolCallEvent> = { seq, type: 'tool_call', ts, tool };

  const path = firstString(input, ['file_path', 'path', 'notebook_path']);
  if (path !== undefined) event.path = path;
  // §12 parses this blob as a whole file, so only a whole-file payload belongs
  // here: an Edit's `new_string` is a fragment, and parsing a fragment as a file
  // would produce confident, wrong spans. Without it span extraction degrades to
  // nothing for that node, which is the honest outcome.
  if (typeof input.content === 'string') event.blob = put(input.content);
  if (Object.keys(input).length > 0) event.args_blob = put(JSON.stringify(input));
  if (parentSeq !== undefined) event.parent_seq = parentSeq;
  return event;
}

function toolResult(
  block: Record<string, unknown>,
  ts: string,
  seq: number,
  callSeqs: ReadonlyMap<string, number>,
  put: (content: string) => string,
): TraceEventInput<ToolResultEvent> | string {
  const id = block.tool_use_id;
  if (typeof id !== 'string') return 'tool_result block has no "tool_use_id"';
  const callSeq = callSeqs.get(id);
  if (callSeq === undefined) {
    // The call it answers was skipped or malformed. L0 requires `call_seq` to
    // point at a real event, so this result cannot be represented.
    return `tool_result references tool_use id ${id}, which was not imported`;
  }
  const text = resultText(block.content);
  const event: TraceEventInput<ToolResultEvent> = {
    seq,
    type: 'tool_result',
    ts,
    call_seq: callSeq,
  };
  if (text.length > 0) event.output_blob = put(text);
  if (block.is_error === true) {
    event.error = text.slice(0, ERROR_DETAIL_CHARS) || 'tool reported an error';
  }
  return event;
}

function contentBlocks(content: unknown): unknown[] {
  if (typeof content === 'string') return content.length > 0 ? [{ type: 'text', text: content }] : [];
  return Array.isArray(content) ? content : [];
}

function joinText(blocks: readonly unknown[], type: 'text' | 'thinking' = 'text'): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (!isRecord(block) || block.type !== type) continue;
    const text = block[type];
    if (typeof text === 'string' && text.length > 0) parts.push(text);
  }
  return parts.join('\n\n');
}

/** A tool result's content is a string, a block array, or something structured. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return joinText(content);
  return content === undefined || content === null ? '' : JSON.stringify(content);
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
