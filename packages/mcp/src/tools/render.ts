/**
 * Rulings → host messages. RULE-FREE: it applies what the ledger, `assemble` and `evict`
 * decided and decides nothing itself. Shared by every tool that takes `messages`, so a
 * plugin gets decisions from whichever call it made last.
 *
 * It EDITS IN PLACE; it never re-renders a transcript (D20). A decision names a message
 * and the edits to its parts: a reasoning or text part replaced or removed, a tool part's
 * OUTPUT replaced or the part removed — the call and its result stay paired. A message
 * with nothing left is dropped whole.
 */
import { resolveReducer, type NodeId, type TraceEvent } from '@context-tree/core';
import { dispositionOf, sessionOf, sessionUnits, type SessionUnit } from '../session.js';
import type { ToolContext } from '../types.js';

/**
 * One edit to a host message. `reasoning`/`text` apply to every part of that kind in the
 * message (the importer joins them into one block); `tool` names the n-th tool part and
 * replaces its OUTPUT. `text: null` removes the part(s).
 */
export type PartEdit =
  | { part: 'reasoning' | 'text'; text: string | null }
  | { part: 'tool'; index: number; text: string | null };

export type Decision =
  | { id: string; action: 'keep' }
  | { id: string; action: 'drop'; unit: string }
  | { id: string; action: 'edit'; unit: string; edits: PartEdit[] };

/** An output this small is not worth the gap marker a reduction inserts. */
const MIN_REDUCIBLE_TOKENS = 64;

function reducedOutputs(ctx: ToolContext, events: readonly TraceEvent[], ratio: number): PartEdit[] {
  const session = sessionOf(ctx);
  const reducer = session.params.reducer === 'none' ? null : resolveReducer(session.params.reducer);
  if (reducer === null) return [];
  const calls = events.filter((e) => e.type === 'tool_call').map((e) => e.seq);
  const out: PartEdit[] = [];
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
    if (text.length < raw.length) out.push({ part: 'tool', index: calls.indexOf(event.call_seq), text });
  }
  return out;
}

/** The edits the ledger asks for on one unit's blocks. */
function foldEdits(ctx: ToolContext, unit: SessionUnit, view: ReadonlyMap<number, { kind: string; parts?: readonly { part: string; text: string | null }[]; text?: string }>): PartEdit[] {
  const edits: PartEdit[] = [];
  const toolIndex = new Map(unit.blocks.filter((b) => b.kind === 'tool').map((b, i) => [b.stub, i]));
  for (const block of unit.blocks) {
    const state = view.get(block.stub);
    if (state === undefined || state.kind === 'raw') continue;
    if (state.kind === 'stub') {
      for (const p of state.parts ?? []) {
        if (p.part === 'output') edits.push({ part: 'tool', index: toolIndex.get(block.stub) ?? 0, text: p.text });
        else edits.push({ part: p.part as 'reasoning' | 'text', text: p.text });
      }
    } else if (state.kind === 'carrier') {
      if (block.kind === 'tool') edits.push({ part: 'tool', index: toolIndex.get(block.stub) ?? 0, text: state.text ?? '' });
      else edits.push({ part: block.kind, text: state.text ?? '' });
    } else if (state.kind === 'covered') {
      if (block.kind === 'tool') edits.push({ part: 'tool', index: toolIndex.get(block.stub) ?? 0, text: null });
      else edits.push({ part: block.kind, text: null });
    }
  }
  void ctx;
  return edits;
}

export async function decisionsFor(
  ctx: ToolContext,
  messages: readonly { id: string; hasTools?: boolean | undefined }[],
): Promise<Decision[]> {
  const session = sessionOf(ctx);
  const snapshot = await sessionUnits(ctx);
  const events = ctx.handle.trace.all();
  const byHost = new Map(snapshot.units.flatMap((u) => (u.hostId === null ? [] : [[u.hostId, u] as const])));

  return messages.map((message): Decision => {
    const unit = byHost.get(message.id);
    // Not ingested yet: nothing is known about it, so nothing is done to it.
    if (unit === undefined) return { id: message.id, action: 'keep' };
    const ruling = dispositionOf(session, unit);
    if (ruling.kind === 'drop') return { id: message.id, action: 'drop', unit: unit.id };
    const edits = foldEdits(ctx, unit, snapshot.view);
    if (ruling.kind === 'reduce') {
      const touched = new Set(edits.filter((e) => e.part === 'tool').map((e) => (e as { index: number }).index));
      for (const e of reducedOutputs(ctx, events.slice(unit.startSeq - 1, unit.endSeq), ruling.tokens / Math.max(1, unit.tokens))) {
        if (e.part === 'tool' && !touched.has(e.index)) edits.push(e);
      }
    }
    return edits.length > 0 ? { id: message.id, action: 'edit', unit: unit.id, edits } : { id: message.id, action: 'keep' };
  });
}

export const countActions = (decisions: readonly Decision[]): Record<Decision['action'], number> => ({
  keep: decisions.filter((d) => d.action === 'keep').length,
  drop: decisions.filter((d) => d.action === 'drop').length,
  edit: decisions.filter((d) => d.action === 'edit').length,
});

export type { NodeId };
