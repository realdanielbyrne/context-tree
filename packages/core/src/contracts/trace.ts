/**
 * L0 — the append-only trace log (plan §6). Source of truth for every derived
 * layer; never edited. One JSON object per line in `trace.jsonl`.
 */
import type { BlobRef, NodeId, Seq } from './ids.js';
import type { LinkKind, PhaseType } from './tree.js';

export type TraceEventType =
  | 'user_message'
  | 'assistant_message'
  | 'reasoning'
  | 'tool_call'
  | 'tool_result'
  | 'segment_boundary'
  | 'manual_annotation'
  | 'fold'
  | 'unfold';

export interface TraceEventBase {
  seq: Seq;
  type: TraceEventType;
  /** ISO-8601 UTC. Supplied by the caller so replay is deterministic. */
  ts: string;
  /**
   * The host message this event came from. One host message is one TURN — the unit
   * the pipeline retains or drops — and a message with tool parts but no text emits no
   * message event, so without this the boundary cannot be recovered from L0.
   */
  turn_id?: string;
}

export interface UserMessageEvent extends TraceEventBase {
  type: 'user_message';
  blob: BlobRef;
}

export interface AssistantMessageEvent extends TraceEventBase {
  type: 'assistant_message';
  blob: BlobRef;
}

/**
 * The model's thinking for one host message. It segments nothing and carries no
 * coordinates, but a host that replays it sends it on every turn, so a trace without it
 * under-sizes the prompt (D24).
 */
export interface ReasoningEvent extends TraceEventBase {
  type: 'reasoning';
  blob: BlobRef;
}

export interface ToolCallEvent extends TraceEventBase {
  type: 'tool_call';
  /** Harness-native tool name. Mapped to a phase via `config.toolPhase`. */
  tool: string;
  /**
   * The shell command a shell-shaped tool ran, when the harness exposes one
   * (D21). One tool name (`bash`) covers test runs, inspection and edits, so
   * the name alone cannot phase it; `config.toolPhaseByCommand` reads this.
   */
  command?: string;
  /** Repo-relative path for file-shaped tools; keys the file node. */
  path?: string;
  /** Post-edit content (edits/writes) — what `spans/` parses. */
  blob?: BlobRef;
  /** Serialized tool arguments. */
  args_blob?: BlobRef;
  /** The assistant_message event that issued this call, when known. */
  parent_seq?: Seq;
}

export interface ToolResultEvent extends TraceEventBase {
  type: 'tool_result';
  call_seq: Seq;
  output_blob?: BlobRef;
  truncated?: boolean;
  error?: string;
}

/** An explicit boundary supplied by the host, honoured over the state machine. */
export interface SegmentBoundaryEvent extends TraceEventBase {
  type: 'segment_boundary';
  from: PhaseType | null;
  to: PhaseType;
}

/** Written by the `annotate` MCP tool (plan §9). */
export interface ManualAnnotationEvent extends TraceEventBase {
  type: 'manual_annotation';
  node_id?: NodeId;
  blob: BlobRef;
  link_to?: NodeId;
  link_kind?: LinkKind;
}

/**
 * THE LEDGER (D26). A fold is a stretch of the transcript shown in a shorter form: a
 * `stub` over one block (summary-free), or a `summary` over a range of blocks. Both are
 * appended here, so what the model was shown is replayable and a rebuild loses no summary.
 * `node_id` names the segment whose span this range is, when it is one — then it IS that
 * node's summary (`node_summaries` is derived from these events).
 */
export interface FoldEvent extends TraceEventBase {
  type: 'fold';
  fold_id: string;
  kind: 'stub' | 'summary';
  from_seq: Seq;
  to_seq: Seq;
  /** A stub's text; a summary's `{ text, meta }` JSON. */
  blob: BlobRef;
  node_id?: NodeId;
  model?: string;
  /** What asked for it: a policy name, a tool caller, a CLI command. */
  trigger?: string;
}

/** Written by `restore`: the fold no longer shows. Its record stays. */
export interface UnfoldEvent extends TraceEventBase {
  type: 'unfold';
  fold_id: string;
}

export type TraceEvent =
  | UserMessageEvent
  | AssistantMessageEvent
  | ReasoningEvent
  | ToolCallEvent
  | ToolResultEvent
  | SegmentBoundaryEvent
  | ManualAnnotationEvent
  | FoldEvent
  | UnfoldEvent;

/**
 * A trace event before a `seq` has been assigned by the writer.
 *
 * The conditional is load-bearing: `Omit` does not distribute over a union, so a
 * non-distributive definition would collapse the bare `TraceEventInput` down to
 * the union's common keys and erase every per-variant required field (`tool`,
 * `blob`, `call_seq`). That would let a malformed L0 record typecheck, and L0 is
 * the source of truth for every derived layer.
 */
export type TraceEventInput<T extends TraceEvent = TraceEvent> = T extends TraceEvent
  ? Omit<T, 'seq'> & { seq?: Seq }
  : never;

/**
 * Append-only writer + replayer over `trace.jsonl`.
 *
 * Synchronous by design: ingestion is inline and ms-scale (plan §7.1), and the
 * L1 store is synchronous too (`better-sqlite3`), so one execution model spans
 * the whole hermetic path.
 */
export interface TraceLog {
  /** Absolute path of the backing `trace.jsonl`. */
  readonly path: string;
  /** Highest seq written, or 0 for an empty log. */
  lastSeq(): Seq;
  /** Assigns `lastSeq() + 1` when the input omits `seq`; returns the stored event. */
  append(event: TraceEventInput): TraceEvent;
  /** Appends many events in one write, preserving order. */
  appendAll(events: readonly TraceEventInput[]): TraceEvent[];
  /** Streams events in seq order. `from`/`to` are inclusive. */
  read(range?: { from?: Seq; to?: Seq }): Iterable<TraceEvent>;
  /** Materializes `read()`. Convenience for the segmenter, which needs one pass. */
  all(): TraceEvent[];
  /** Single event by seq, or null. */
  at(seq: Seq): TraceEvent | null;
  close(): void;
}
