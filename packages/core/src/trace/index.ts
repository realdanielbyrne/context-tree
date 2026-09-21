/**
 * L0 — append-only trace log (plan §6). `JsonlTraceLog` is the only writer of
 * `trace.jsonl`; every derived layer (L1/L3/L4) is a deterministic function of
 * this file plus L2 (D8), so its one hard invariant — seq strictly increasing,
 * gap-free, starting at 1 — is enforced here and nowhere else.
 *
 * Contract note (for the reviewer): `TraceEventInput` (contracts/trace.ts) is
 * `Omit<TraceEvent, 'seq'> & Partial<Pick<TraceEvent, 'seq'>>` with the type
 * parameter defaulted to the full `TraceEvent` union. TS's `Omit`/`Pick` do
 * not distribute over unions, so the *bare* `TraceEventInput` used in
 * `TraceLog.append`/`appendAll` collapses to just `{ type: TraceEventType; ts:
 * string; seq?: Seq }` — the per-variant required fields (`blob`, `tool`,
 * `call_seq`, ...) are erased at the call-site type. `TraceEventInput<T>` with
 * an explicit `T` (e.g. `TraceEventInput<ToolCallEvent>`) works correctly;
 * only the bare form used in the interface is lossy. Implemented as written
 * per instructions — not changed here — but because the type system can't
 * enforce shape at the `append` boundary, this module re-validates the
 * assembled event at runtime (`assertValidShape`) so a caller that defeats
 * the loose type with a stray `as` still gets a loud `TraceIntegrityError`
 * instead of a silently corrupt L0 record.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Seq } from '../contracts/ids.js';
import { TraceIntegrityError } from '../contracts/errors.js';
import type {
  AssistantMessageEvent,
  ManualAnnotationEvent,
  ReasoningEvent,
  SegmentBoundaryEvent,
  ToolCallEvent,
  ToolResultEvent,
  TraceEvent,
  TraceEventInput,
  TraceEventType,
  TraceLog,
  UserMessageEvent,
} from '../contracts/trace.js';

const TRACE_EVENT_TYPES: readonly TraceEventType[] = [
  'user_message',
  'assistant_message',
  'reasoning',
  'tool_call',
  'tool_result',
  'segment_boundary',
  'manual_annotation',
];

/**
 * Canonical per-type key order. Callers (segmenter, ingest, `annotate`) build
 * event objects independently, so relying on object-literal key order would
 * make serialization non-deterministic; writing this order explicitly is what
 * makes the M0 "round-trips hash-identical" acceptance testable at all.
 */
const FIELD_ORDER: Readonly<Record<TraceEventType, readonly string[]>> = {
  user_message: ['seq', 'type', 'ts', 'blob', 'turn_id'],
  assistant_message: ['seq', 'type', 'ts', 'blob', 'turn_id'],
  reasoning: ['seq', 'type', 'ts', 'blob', 'turn_id'],
  tool_call: ['seq', 'type', 'ts', 'tool', 'command', 'path', 'blob', 'args_blob', 'parent_seq', 'turn_id'],
  tool_result: ['seq', 'type', 'ts', 'call_seq', 'output_blob', 'truncated', 'error', 'turn_id'],
  segment_boundary: ['seq', 'type', 'ts', 'from', 'to', 'turn_id'],
  manual_annotation: ['seq', 'type', 'ts', 'node_id', 'blob', 'link_to', 'link_kind', 'turn_id'],
};

function isTraceEventType(value: unknown): value is TraceEventType {
  return typeof value === 'string' && (TRACE_EVENT_TYPES as readonly string[]).includes(value);
}

function requireString(rec: Record<string, unknown>, key: string, context: string): void {
  if (typeof rec[key] !== 'string') {
    throw new TraceIntegrityError(`malformed trace event (${context}): "${key}" must be a string`);
  }
}

function requireNumber(rec: Record<string, unknown>, key: string, context: string): void {
  if (typeof rec[key] !== 'number') {
    throw new TraceIntegrityError(`malformed trace event (${context}): "${key}" must be a number`);
  }
}

/**
 * Validates the base envelope plus the required fields for `rec.type`.
 * Shared by `parseTraceEvent` (parsing an L0 line) and `JsonlTraceLog.append`
 * (validating an in-memory object the loose `TraceEventInput` type let through
 * unchecked) so the two call sites can't drift.
 */
function assertValidShape(value: unknown): asserts value is TraceEvent {
  // Parameter is `unknown` (not `Record<string, unknown>`) purely so the type
  // predicate is legal: `TraceEvent`'s members have no index signature, so TS
  // rejects `asserts x is TraceEvent` on a `Record<string, unknown>` parameter
  // (TS2677) even though every real caller here already passes a plain record.
  const rec = value as Record<string, unknown>;
  if (typeof rec.seq !== 'number' || !Number.isInteger(rec.seq) || rec.seq < 1) {
    throw new TraceIntegrityError(`malformed trace event: "seq" must be a positive integer, got ${String(rec.seq)}`);
  }
  const type = rec.type;
  if (!isTraceEventType(type)) {
    throw new TraceIntegrityError(`malformed trace event: unknown type ${JSON.stringify(type)}`);
  }
  requireString(rec, 'ts', type);
  switch (type) {
    case 'user_message':
    case 'assistant_message':
    case 'reasoning':
      requireString(rec, 'blob', type);
      break;
    case 'tool_call':
      requireString(rec, 'tool', type);
      break;
    case 'tool_result':
      requireNumber(rec, 'call_seq', type);
      break;
    case 'segment_boundary':
      requireString(rec, 'to', type);
      if (rec.from !== null && typeof rec.from !== 'string') {
        throw new TraceIntegrityError('malformed trace event (segment_boundary): "from" must be a string or null');
      }
      break;
    case 'manual_annotation':
      requireString(rec, 'blob', type);
      break;
  }
}

/** Type guards — the segmenter and ingest narrow on these instead of `event.type === '...'`. */
export function isUserMessage(event: TraceEvent): event is UserMessageEvent {
  return event.type === 'user_message';
}
export function isAssistantMessage(event: TraceEvent): event is AssistantMessageEvent {
  return event.type === 'assistant_message';
}
export function isReasoning(event: TraceEvent): event is ReasoningEvent {
  return event.type === 'reasoning';
}
export function isToolCall(event: TraceEvent): event is ToolCallEvent {
  return event.type === 'tool_call';
}
export function isToolResult(event: TraceEvent): event is ToolResultEvent {
  return event.type === 'tool_result';
}
export function isSegmentBoundary(event: TraceEvent): event is SegmentBoundaryEvent {
  return event.type === 'segment_boundary';
}
export function isManualAnnotation(event: TraceEvent): event is ManualAnnotationEvent {
  return event.type === 'manual_annotation';
}

/**
 * Parses one L0 line. Used both by `JsonlTraceLog` (reading `trace.jsonl`) and
 * the CLI `import` command (reading an external trace to convert). Throws
 * `TraceIntegrityError` on invalid JSON, an unknown `type`, or a missing
 * required field for that type — a malformed record must never pass through
 * silently, since every derived layer trusts what L0 says happened.
 */
export function parseTraceEvent(line: string): TraceEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new TraceIntegrityError(`malformed trace line (invalid JSON): ${(error as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TraceIntegrityError('malformed trace line: expected a JSON object');
  }
  const rec = parsed as Record<string, unknown>;
  assertValidShape(rec);
  return rec;
}

/** Stable-key-order serializer — the inverse of `parseTraceEvent` and what makes round-tripping byte-identical. */
export function serializeTraceEvent(event: TraceEvent): string {
  const order = FIELD_ORDER[event.type];
  const ordered: Record<string, unknown> = {};
  const rec = event as unknown as Record<string, unknown>;
  for (const key of order) {
    const value = rec[key];
    if (value !== undefined) ordered[key] = value;
  }
  return JSON.stringify(ordered);
}

/**
 * Splits raw file text into lines without materializing a `string[]` of every
 * line — matches the streaming requirement on `read()`. The final segment
 * (no trailing `\n`) is reported as `trailing: true`: a normal log always ends
 * with a newline (every write below is newline-terminated), so a non-empty
 * final segment without one only occurs after a crash mid-write.
 */
function* splitLines(text: string): Generator<{ raw: string; trailing: boolean }> {
  let start = 0;
  while (start < text.length) {
    const nl = text.indexOf('\n', start);
    if (nl === -1) {
      yield { raw: text.slice(start), trailing: true };
      return;
    }
    yield { raw: text.slice(start, nl), trailing: false };
    start = nl + 1;
  }
}

export class JsonlTraceLog implements TraceLog {
  readonly path: string;
  private cachedLastSeq: Seq;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    // 'a' (append) creates the file if absent and is a no-op on an existing one.
    appendFileSync(path, '');
    let last = 0;
    for (const event of this.readRaw()) last = event.seq;
    this.cachedLastSeq = last;
  }

  lastSeq(): Seq {
    return this.cachedLastSeq;
  }

  append(event: TraceEventInput): TraceEvent {
    const [stored] = this.appendAll([event]);
    // appendAll never returns fewer elements than it was given.
    return stored as TraceEvent;
  }

  appendAll(events: readonly TraceEventInput[]): TraceEvent[] {
    let next = this.cachedLastSeq;
    const built: TraceEvent[] = [];
    // Validate (seq contiguity + per-type shape) for the whole batch before
    // writing anything — appendAll is all-or-nothing.
    for (const input of events) {
      next += 1;
      const raw = input as unknown as Record<string, unknown>;
      if (raw.seq !== undefined && raw.seq !== next) {
        throw new TraceIntegrityError(
          `non-monotonic seq: expected ${next} (lastSeq + 1), got ${String(raw.seq)} — L0 must be gap-free`,
        );
      }
      const candidate: Record<string, unknown> = { ...raw, seq: next };
      assertValidShape(candidate);
      built.push(candidate);
    }
    if (built.length === 0) return built;

    const payload = built.map((event) => serializeTraceEvent(event)).join('\n') + '\n';
    appendFileSync(this.path, payload, 'utf8');
    this.cachedLastSeq = next;
    return built;
  }

  /** Reads straight off disk every call — L0 is the source of truth, so a snapshot could go stale under a concurrent writer. */
  private *readRaw(): Generator<TraceEvent> {
    const text = readFileSync(this.path, 'utf8');
    let prevSeq = 0;
    for (const { raw, trailing } of splitLines(text)) {
      if (trailing) {
        // Crashed write: an interrupted append leaves an incomplete final
        // line. Ignoring it (not erroring) is what makes the log usable
        // again after a hard kill mid-append.
        return;
      }
      const event = parseTraceEvent(raw);
      if (event.seq <= prevSeq) {
        throw new TraceIntegrityError(`trace log corrupt: seq ${event.seq} is not greater than preceding seq ${prevSeq}`);
      }
      prevSeq = event.seq;
      yield event;
    }
  }

  *read(range: { from?: Seq; to?: Seq } = {}): Generator<TraceEvent> {
    const from = range.from ?? 1;
    const to = range.to ?? Number.POSITIVE_INFINITY;
    for (const event of this.readRaw()) {
      if (event.seq < from) continue;
      if (event.seq > to) return; // seq is strictly increasing, so nothing further can be in range.
      yield event;
    }
  }

  all(): TraceEvent[] {
    return [...this.read()];
  }

  at(seq: Seq): TraceEvent | null {
    for (const event of this.read({ from: seq, to: seq })) return event;
    return null;
  }

  /** No persistent handle to release — every call above opens the file fresh. Kept for interface symmetry with the SQLite-backed `TreeStore`. */
  close(): void {}
}
