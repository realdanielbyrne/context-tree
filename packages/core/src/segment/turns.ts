/**
 * Turns — the fine-grained unit, derived from L0 alone.
 *
 * A TURN is one host message: its text plus every tool call it issued and their
 * results. It is what a host can keep or drop exactly, which a phase (a run of many
 * messages) is not. Importers stamp `turn_id`; a trace without it falls back to a
 * deterministic rule, so old traces still rebuild to the same turns every time.
 *
 * Pure and L0-only (D15): no store, no model, no clock. Turns are NOT L1 nodes — they
 * are a function of L0, so there is nothing to persist or migrate (D8).
 */
import type { Seq, TraceEvent } from '../contracts/index.js';

export interface Turn {
  /** Stable for the life of the trace: L0 is append-only, so a start seq never moves. */
  readonly id: string;
  readonly startSeq: Seq;
  readonly endSeq: Seq;
  /** The host's own message id, when the importer recorded one. */
  readonly hostId?: string;
  /** True when the turn opens with the user speaking — the task statement is the first such turn. */
  readonly fromUser: boolean;
}

export const turnIdAt = (startSeq: Seq): string => `turn:${String(startSeq)}`;

interface OpenTurn {
  startSeq: Seq;
  endSeq: Seq;
  hostId?: string;
  fromUser: boolean;
  messageSeq?: Seq;
  /** Nothing but thinking so far: the message it precedes is still this turn. */
  onlyReasoning: boolean;
  callSeqs: Set<Seq>;
}

/** Does `event` continue `open`, given that neither carries a host id? */
function continuesUnstamped(open: OpenTurn, event: TraceEvent): boolean {
  switch (event.type) {
    case 'user_message':
    case 'reasoning':
      return false;
    case 'assistant_message':
      return open.onlyReasoning;
    case 'tool_call':
      return event.parent_seq === undefined ? open.onlyReasoning : event.parent_seq === open.messageSeq;
    case 'tool_result':
      return open.callSeqs.has(event.call_seq);
    case 'segment_boundary':
    case 'manual_annotation':
      return true;
  }
}

export function deriveTurns(events: Iterable<TraceEvent>): Turn[] {
  const turns: Turn[] = [];
  let open: OpenTurn | null = null;
  const close = (): void => {
    if (open === null) return;
    turns.push({
      id: turnIdAt(open.startSeq),
      startSeq: open.startSeq,
      endSeq: open.endSeq,
      fromUser: open.fromUser,
      ...(open.hostId !== undefined ? { hostId: open.hostId } : {}),
    });
    open = null;
  };

  for (const event of events) {
    const stamped = event.turn_id;
    // An UNSTAMPED event inside a stamped turn belongs to it: in middleware mode the server
    // appends its own retrieval events while a host message is still running, and splitting
    // there would yield two turns claiming one host message.
    const continues: boolean =
      open !== null &&
      (stamped !== undefined ? stamped === open.hostId : open.hostId !== undefined || continuesUnstamped(open, event));
    if (!continues) {
      close();
      open = {
        startSeq: event.seq,
        endSeq: event.seq,
        fromUser: event.type === 'user_message',
        onlyReasoning: true,
        callSeqs: new Set(),
        ...(stamped !== undefined ? { hostId: stamped } : {}),
      };
    }
    const current = open as OpenTurn;
    current.endSeq = event.seq;
    if (event.type !== 'reasoning') current.onlyReasoning = false;
    if (event.type === 'user_message' || event.type === 'assistant_message') current.messageSeq ??= event.seq;
    if (event.type === 'tool_call') current.callSeqs.add(event.seq);
  }
  close();
  return turns;
}
