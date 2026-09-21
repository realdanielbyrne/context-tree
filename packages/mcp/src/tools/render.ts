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
import { dispositionOf, sessionOf, sessionUnits, type SessionUnit } from '../session.js';
import type { ToolContext } from '../types.js';

export type Decision =
  | { id: string; action: 'keep' }
  | { id: string; action: 'drop'; unit: string; foldWanted?: true }
  | { id: string; action: 'fold'; unit: string; text: string }
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
  const folded = new Set<string>();
  const foldRefused = new Set<string>();

  return messages.map((message): Decision => {
    const keep: Decision = { id: message.id, action: 'keep' };
    // Not ingested yet: nothing is known about it, so nothing is done to it.
    const turn = turnOf.get(message.id);
    if (turn === undefined) return keep;
    const unit: SessionUnit | undefined = units.find((u) => u.startSeq <= turn.startSeq && turn.startSeq <= u.endSeq);
    if (unit === undefined) return keep;

    const disposition = dispositionOf(session, unit.id);
    switch (disposition.kind) {
      case 'keep':
        return keep;
      case 'drop':
        return { id: message.id, action: 'drop', unit: unit.id };
      case 'reduce': {
        const outputs = reducedOutputs(ctx, events.slice(turn.startSeq - 1, turn.endSeq), disposition.tokens / Math.max(1, unit.tokens));
        return outputs.length > 0 ? { id: message.id, action: 'reduce', unit: unit.id, outputs } : keep;
      }
      case 'fold': {
        // One message carries the summary; a message with tool parts cannot (a call and its
        // result must travel together), so the refusal is recorded ONCE rather than swallowed.
        if (!folded.has(unit.id) && message.hasTools !== true) {
          folded.add(unit.id);
          return { id: message.id, action: 'fold', unit: unit.id, text: disposition.text };
        }
        const firstRefusal = !folded.has(unit.id) && !foldRefused.has(unit.id);
        if (firstRefusal) foldRefused.add(unit.id);
        return { id: message.id, action: 'drop', unit: unit.id, ...(firstRefusal ? { foldWanted: true as const } : {}) };
      }
    }
  });
}

export const countActions = (decisions: readonly Decision[]): Record<Decision['action'], number> => ({
  keep: decisions.filter((d) => d.action === 'keep').length,
  drop: decisions.filter((d) => d.action === 'drop').length,
  fold: decisions.filter((d) => d.action === 'fold').length,
  reduce: decisions.filter((d) => d.action === 'reduce').length,
});

export type { NodeId };
