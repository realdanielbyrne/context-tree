/**
 * Rulings → host messages. RULE-FREE: it applies what `assemble` and `evict` decided and
 * decides nothing itself. Shared by both so a plugin gets decisions from whichever call it
 * made last.
 *
 * It SELECTS and EDITS IN PLACE; it never re-renders a transcript (D20). A host keeps a
 * tool call and its result in one message, so a whole-message drop cannot orphan a result,
 * and a reduction replaces a tool's OUTPUT TEXT while the call and its result stay paired.
 */
import { deriveTurns, resolveReducer, type NodeId, type TraceEvent } from '@context-tree/core';
import { dispositionOf, sessionOf, sessionUnits } from '../session.js';
import { stubOf } from '../stub.js';
import type { ToolContext } from '../types.js';

export type Decision =
  | { id: string; action: 'keep' }
  | { id: string; action: 'drop'; unit: string }
  | { id: string; action: 'fold'; unit: string; text: string }
  /** The message stays, without its reasoning; `outputs` are the tags that replace tool outputs. */
  | { id: string; action: 'stub'; unit: string; outputs: { index: number; text: string }[] }
  /** `index` counts the message's tool parts, in order. */
  | { id: string; action: 'reduce'; unit: string; outputs: { index: number; text: string }[] };

/** An output this small is not worth the gap marker a reduction inserts. */
const MIN_REDUCIBLE_TOKENS = 64;

function reducedOutputs(ctx: ToolContext, events: readonly TraceEvent[], ratio: number): { index: number; text: string }[] {
  const session = sessionOf(ctx);
  const reducer = session.params.reducer === 'none' ? null : resolveReducer(session.params.reducer);
  if (reducer === null) return [];
  const calls = events.filter((e) => e.type === 'tool_call').map((e) => e.seq);
  const out: { index: number; text: string }[] = [];
  for (const event of events) {
    if (event.type !== 'tool_result' || event.output_blob === undefined) continue;
    const raw = ctx.handle.blobs.getText(event.output_blob);
    const tokens = session.tokenizer.count(raw);
    if (tokens < MIN_REDUCIBLE_TOKENS) continue;
    const text = reducer({ raw }, {
      budgetTokens: Math.max(1, Math.floor(tokens * ratio)),
      tokenizer: session.tokenizer,
      query: session.query,
      chunkOptions: { chunkSize: session.params.chunkSize, chunkOverlap: session.params.chunkOverlap },
      rrfK: session.params.rrfK,
    });
    if (text.length < raw.length) out.push({ index: calls.indexOf(event.call_seq), text });
  }
  return out;
}

export async function decisionsFor(
  ctx: ToolContext,
  messages: readonly { id: string; hasTools?: boolean | undefined }[],
): Promise<Decision[]> {
  const session = sessionOf(ctx);
  const { units } = await sessionUnits(ctx);
  const lastSeq = ctx.handle.trace.lastSeq();
  const events = lastSeq >= 1 ? [...ctx.handle.trace.read({ from: 1, to: lastSeq })] : [];
  const turnOf = new Map(deriveTurns(events).flatMap((t) => (t.hostId !== undefined ? [[t.hostId, t] as const] : [])));

  const located = messages.map((message) => {
    const turn = turnOf.get(message.id);
    const unit = turn === undefined ? undefined : units.find((u) => u.startSeq <= turn.startSeq && turn.startSeq <= u.endSeq);
    return { message, turn, unit, disposition: unit === undefined ? undefined : dispositionOf(session, unit) };
  });

  return located.map(({ message, turn, unit, disposition }): Decision => {
    const keep: Decision = { id: message.id, action: 'keep' };
    // Not ingested yet: nothing is known about it, so nothing is done to it.
    if (turn === undefined || unit === undefined || disposition === undefined) return keep;
    switch (disposition.kind) {
      case 'keep':
        return keep;
      case 'reduce': {
        const outputs = reducedOutputs(ctx, events.slice(turn.startSeq - 1, turn.endSeq), disposition.tokens / Math.max(1, unit.tokens));
        return outputs.length > 0 ? { id: message.id, action: 'reduce', unit: unit.id, outputs } : keep;
      }
      // Assembly chose a text-only unit to carry the summary, and a turn IS a message — so this
      // holds unless the host's view of the message differs, in which case it is left alone.
      case 'fold':
        return message.hasTools === true ? keep : { id: message.id, action: 'fold', unit: unit.id, text: disposition.text };
      case 'stub':
        return { id: message.id, action: 'stub', unit: unit.id, outputs: [...stubOf(events.slice(turn.startSeq - 1, turn.endSeq), ctx.handle.blobs, session.tokenizer, unit.id).outputs] };
      case 'drop':
        return { id: message.id, action: 'drop', unit: unit.id };
    }
  });
}

export const countActions = (decisions: readonly Decision[]): Record<Decision['action'], number> => ({
  keep: decisions.filter((d) => d.action === 'keep').length,
  drop: decisions.filter((d) => d.action === 'drop').length,
  fold: decisions.filter((d) => d.action === 'fold').length,
  stub: decisions.filter((d) => d.action === 'stub').length,
  reduce: decisions.filter((d) => d.action === 'reduce').length,
});

export type { NodeId };
