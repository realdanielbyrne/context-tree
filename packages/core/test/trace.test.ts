import { describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JsonlTraceLog,
  isAssistantMessage,
  isManualAnnotation,
  isSegmentBoundary,
  isToolCall,
  isToolResult,
  isUserMessage,
  parseTraceEvent,
  serializeTraceEvent,
} from '../src/trace/index.js';
import { TraceIntegrityError } from '../src/contracts/errors.js';
import type {
  AssistantMessageEvent,
  ManualAnnotationEvent,
  SegmentBoundaryEvent,
  ToolCallEvent,
  ToolResultEvent,
  TraceEvent,
  TraceEventInput,
  UserMessageEvent,
} from '../src/contracts/trace.js';

const TS = '2026-01-01T00:00:00.000Z';
const REF_A = 'a'.repeat(64);
const REF_B = 'b'.repeat(64);

function tmpPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ct-trace-'));
  return { dir, path: join(dir, 'trace.jsonl') };
}

function newLog(): { dir: string; path: string; log: JsonlTraceLog } {
  const { dir, path } = tmpPath();
  return { dir, path, log: new JsonlTraceLog(path) };
}

// Per-type factories return `TraceEventInput<X>` (T explicit, not defaulted), which
// carries the real required fields — unlike the bare `TraceEventInput` that
// `TraceLog.append` declares (see the contract note in src/trace/index.ts). Passing
// the result of a function call (not an object literal) into `append` sidesteps
// TS's excess-property check, so these compile cleanly against the narrower
// interface type while still exercising every field at runtime.
function userMessage(overrides: Partial<TraceEventInput<UserMessageEvent>> = {}): TraceEventInput<UserMessageEvent> {
  return { type: 'user_message', ts: TS, blob: REF_A, ...overrides };
}
function assistantMessage(
  overrides: Partial<TraceEventInput<AssistantMessageEvent>> = {},
): TraceEventInput<AssistantMessageEvent> {
  return { type: 'assistant_message', ts: TS, blob: REF_A, ...overrides };
}
function toolCall(overrides: Partial<TraceEventInput<ToolCallEvent>> = {}): TraceEventInput<ToolCallEvent> {
  return { type: 'tool_call', ts: TS, tool: 'Edit', path: 'src/foo.ts', blob: REF_B, ...overrides };
}
function toolResult(overrides: Partial<TraceEventInput<ToolResultEvent>> = {}): TraceEventInput<ToolResultEvent> {
  return { type: 'tool_result', ts: TS, call_seq: 1, output_blob: REF_B, truncated: false, ...overrides };
}
function segmentBoundary(
  overrides: Partial<TraceEventInput<SegmentBoundaryEvent>> = {},
): TraceEventInput<SegmentBoundaryEvent> {
  return { type: 'segment_boundary', ts: TS, from: 'diagnosis', to: 'implementation', ...overrides };
}
function manualAnnotation(
  overrides: Partial<TraceEventInput<ManualAnnotationEvent>> = {},
): TraceEventInput<ManualAnnotationEvent> {
  return { type: 'manual_annotation', ts: TS, blob: REF_A, ...overrides };
}

describe('JsonlTraceLog — construction', () => {
  it('creates parent directories and an empty file on demand, starting an empty log at seq 0', () => {
    const { path } = tmpPath();
    const nested = join(path, '..', 'nested', 'deeper', 'trace.jsonl');
    const log = new JsonlTraceLog(nested);
    expect(log.lastSeq()).toBe(0);
    expect(readFileSync(nested, 'utf8')).toBe('');
  });

  it('recovers lastSeq() from disk when reopening an existing log, so a resumed session keeps appending gap-free', () => {
    const { path } = tmpPath();
    const log1 = new JsonlTraceLog(path);
    log1.appendAll([userMessage(), assistantMessage(), toolCall()]);
    log1.close();

    const log2 = new JsonlTraceLog(path);
    expect(log2.lastSeq()).toBe(3);
    expect(log2.append(userMessage()).seq).toBe(4);
  });
});

describe('JsonlTraceLog — seq assignment and the gap-free invariant', () => {
  it('assigns lastSeq()+1 when the caller omits seq, so callers never do their own bookkeeping', () => {
    const { log } = newLog();
    expect(log.append(userMessage()).seq).toBe(1);
    expect(log.append(assistantMessage()).seq).toBe(2);
    expect(log.lastSeq()).toBe(2);
  });

  it('accepts an explicit seq when it equals lastSeq()+1', () => {
    const { log } = newLog();
    expect(log.append(userMessage({ seq: 1 })).seq).toBe(1);
  });

  it('rejects a non-monotonic explicit seq — L0 gap-free ordering is the log\'s one hard invariant', () => {
    const { log } = newLog();
    log.append(userMessage());
    expect(() => log.append(assistantMessage({ seq: 9 }))).toThrow(TraceIntegrityError);
    // The rejected append must not have advanced the log.
    expect(log.lastSeq()).toBe(1);
  });

  it('appendAll validates every seq before writing anything — a bad seq mid-batch leaves the log untouched', () => {
    const { path, log } = newLog();
    log.append(userMessage());
    const before = readFileSync(path, 'utf8');

    expect(() => log.appendAll([toolCall(), toolCall({ seq: 99 })])).toThrow(TraceIntegrityError);

    expect(log.lastSeq()).toBe(1);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('rejects an in-memory event missing a required field for its type, even though the loose bare TraceEventInput type would let it through', () => {
    // contracts/trace.ts: TraceEventInput defaults its type param to the full
    // TraceEvent union, and TS's Omit/Pick do not distribute over unions, so
    // the bare type TraceLog.append declares collapses to {type, ts, seq?} —
    // a tool_call missing `tool` type-checks at that call site. The runtime
    // shape check below is what still catches it.
    const { log } = newLog();
    const malformed = { type: 'tool_call', ts: TS } as unknown as TraceEventInput;
    expect(() => log.append(malformed)).toThrow(TraceIntegrityError);
    expect(log.lastSeq()).toBe(0);
  });
});

describe('JsonlTraceLog — round-trip identity (M0 acceptance: fixture round-trips hash-identical)', () => {
  it('re-serializing every parsed line reproduces the exact bytes on disk, regardless of caller key order', () => {
    const { path, log } = newLog();
    log.appendAll([
      userMessage(),
      toolCall({ path: 'a.ts' }),
      toolResult({ call_seq: 2 }),
      segmentBoundary({ from: null }),
      manualAnnotation({ node_id: 'n_01', link_to: 'n_02', link_kind: 'relates_to' }),
      assistantMessage(),
    ]);

    const original = readFileSync(path, 'utf8');
    const lines = original.trimEnd().split('\n');
    expect(lines).toHaveLength(6);

    // Stable field ordering (not caller object-literal order) is what makes
    // this deterministic: parse -> serialize must reproduce the same bytes.
    const rebuilt = lines.map((line) => serializeTraceEvent(parseTraceEvent(line))).join('\n') + '\n';
    expect(rebuilt).toBe(original);
  });
});

describe('JsonlTraceLog — read()', () => {
  it('honors inclusive from/to bounds', () => {
    const { log } = newLog();
    log.appendAll([userMessage(), assistantMessage(), toolCall(), toolResult({ call_seq: 3 }), userMessage()]);
    expect([...log.read({ from: 2, to: 4 })].map((e) => e.seq)).toEqual([2, 3, 4]);
  });

  it('all() materializes the full log in seq order', () => {
    const { log } = newLog();
    log.appendAll([userMessage(), assistantMessage()]);
    expect(log.all().map((e) => e.seq)).toEqual([1, 2]);
  });

  it('at() returns the single event at a seq, or null when absent', () => {
    const { log } = newLog();
    log.append(userMessage());
    expect(log.at(1)?.type).toBe('user_message');
    expect(log.at(2)).toBeNull();
  });

  it('ignores a trailing partial line (a crashed write) instead of failing the whole log', () => {
    const { path } = tmpPath();
    const log1 = new JsonlTraceLog(path);
    log1.append(userMessage());
    // Simulate a write cut off mid-flight: an incomplete JSON line with no
    // terminating newline appended after a fully-written event.
    appendFileSync(path, JSON.stringify({ seq: 2, type: 'user_message', ts: TS, blob: REF_A }).slice(0, -5));

    const log2 = new JsonlTraceLog(path);
    expect(log2.lastSeq()).toBe(1);
    expect(log2.all().map((e) => e.seq)).toEqual([1]);
  });

  it('throws TraceIntegrityError on a malformed line in the MIDDLE of the file rather than silently dropping it', () => {
    const { path } = tmpPath();
    const good1 = serializeTraceEvent({ seq: 1, type: 'user_message', ts: TS, blob: REF_A } as TraceEvent);
    const good2 = serializeTraceEvent({ seq: 2, type: 'user_message', ts: TS, blob: REF_A } as TraceEvent);
    // The bad line is followed by a real newline and another good line, so it
    // is unambiguously "in the middle", not a trailing crashed write.
    writeFileSync(path, `${good1}\nnot valid json\n${good2}\n`);

    expect(() => new JsonlTraceLog(path)).toThrow(TraceIntegrityError);
  });
});

describe('parseTraceEvent', () => {
  it('throws on invalid JSON', () => {
    expect(() => parseTraceEvent('{not json')).toThrow(TraceIntegrityError);
  });

  it('throws on an unrecognized type — an unknown event shape must not silently pass through to L1', () => {
    expect(() => parseTraceEvent(JSON.stringify({ seq: 1, type: 'bogus', ts: TS }))).toThrow(TraceIntegrityError);
  });

  it('throws when a type-specific required field is missing', () => {
    expect(() => parseTraceEvent(JSON.stringify({ seq: 1, type: 'tool_result', ts: TS }))).toThrow(
      TraceIntegrityError,
    );
  });
});

describe('type guards', () => {
  const fixtures: TraceEvent[] = [
    { seq: 1, type: 'user_message', ts: TS, blob: REF_A },
    { seq: 2, type: 'assistant_message', ts: TS, blob: REF_A },
    { seq: 3, type: 'tool_call', ts: TS, tool: 'Edit' },
    { seq: 4, type: 'tool_result', ts: TS, call_seq: 3 },
    { seq: 5, type: 'segment_boundary', ts: TS, from: null, to: 'implementation' },
    { seq: 6, type: 'manual_annotation', ts: TS, blob: REF_A },
  ];
  const guards: Record<TraceEvent['type'], (e: TraceEvent) => boolean> = {
    user_message: isUserMessage,
    assistant_message: isAssistantMessage,
    tool_call: isToolCall,
    tool_result: isToolResult,
    segment_boundary: isSegmentBoundary,
    manual_annotation: isManualAnnotation,
  };

  it('each guard matches only its own event type — the segmenter narrows on these instead of string comparisons', () => {
    for (const event of fixtures) {
      for (const [type, guard] of Object.entries(guards)) {
        expect(guard(event)).toBe(type === event.type);
      }
    }
  });
});
