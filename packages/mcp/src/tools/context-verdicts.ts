/**
 * `verdicts` — the HOST-facing end of the pipeline: given the host's own
 * message list, which messages stay, which drop, which fold to a summary.
 *
 * It SELECTS whole messages and never re-renders them. A host keeps a tool call and
 * its result in one message, so a whole-message verdict cannot orphan a result —
 * re-rendering a transcript from the tree is what invalidated the deleted in-repo
 * harness (D20). It reads the session's evicted set and decides nothing itself: the
 * eviction POLICY is `evict`, and when to call it is the host's.
 *
 * HTTP only. Its input is the host's message array, which an agent never holds.
 */
import { z } from 'zod';
import type { NodeId } from '@context-tree/core';
import { ok, parseArgs } from '../result.js';
import { advanceTurn, sessionOf } from '../session.js';
import type { ToolContext, ToolOutcome } from '../types.js';
import { turnArg } from './pipeline-args.js';

export const CONTEXT_VERDICTS = 'verdicts';

export const CONTEXT_VERDICTS_DESCRIPTION =
  'For a host plugin: map the evicted units onto the host\'s message list and return keep / drop / fold ' +
  'per message. Reach for it on every turn, immediately before the prompt is sent.';

const shape = {
  messages: z
    .array(z.object({ id: z.string().min(1), tokens: z.number().nonnegative().optional(), hasTools: z.boolean().optional() }).loose())
    .min(1)
    .describe('The host\'s messages in order. `tokens` is the host\'s own estimate; it is only summed, never trusted as served tokens.'),
  protect_tail: z.number().int().min(1).optional().describe('Trailing messages never dropped (the live working set).'),
  summaries: z.boolean().optional().describe('Fold the first droppable text-only message of a unit to its summary instead of dropping it.'),
  ceiling_tokens: z
    .number()
    .positive()
    .optional()
    .describe('Hard bound on kept tokens. When the protected tail alone exceeds it, the tail shrinks — a host with compaction off has nothing else between it and a provider overflow.'),
  turn: turnArg,
};
export const contextVerdictsSchema = z.object(shape);
export const contextVerdictsInputShape = shape;

export type Verdict =
  | { id: string; action: 'keep' }
  | { id: string; action: 'fold'; text: string }
  | { id: string; action: 'drop'; unit: NodeId; foldWanted?: true };

export interface ContextVerdictsData {
  turn: number;
  /** False when no adapter has published a message index: every verdict is `keep`. */
  indexed: boolean;
  total_tokens: number;
  kept_tokens: number;
  protect_tail: number;
  escalations: number;
  over_ceiling: boolean;
  evicted_units: number;
  decisions: Verdict[];
}

interface Span {
  nodeId: NodeId;
  start: number;
  end: number;
  summary: string | null;
}

/**
 * Protected, in order of precedence: a message with no L0 range yet (not ingested, so
 * nothing is known about it), the first message (the task statement), and the last
 * `protectTail` messages. Everything else drops when its seq range overlaps an evicted
 * unit. `fold` is offered only for a text-only message — one carrying tool parts is
 * keep-or-drop, so a call and its result always travel together.
 */
export function planVerdicts(
  messages: readonly { id: string; hasTools?: boolean | undefined }[],
  index: ReadonlyMap<string, { start: number; end: number }> | null,
  spans: readonly Span[],
  protectTail: number,
  summaries: boolean,
): Verdict[] {
  const lastIndex = messages.length - 1;
  const folded = new Set<NodeId>();
  const wanted = new Set<NodeId>();
  return messages.map((message, i): Verdict => {
    const range = index?.get(message.id);
    if (range === undefined || i === 0 || i > lastIndex - protectTail) return { id: message.id, action: 'keep' };
    const unit = spans.find((u) => range.start <= u.end && range.end >= u.start);
    if (unit === undefined) return { id: message.id, action: 'keep' };
    const wantsFold = summaries && unit.summary !== null && !folded.has(unit.nodeId);
    if (wantsFold && message.hasTools !== true) {
      folded.add(unit.nodeId);
      return { id: message.id, action: 'fold', text: unit.summary! };
    }
    // A fold the message shape cannot take is recorded ONCE PER UNIT, not swallowed: when
    // nearly every message carries tool parts, a summaries policy that never finds a
    // text-only message is its own control and has to say so.
    const firstMiss = wantsFold && !wanted.has(unit.nodeId);
    if (firstMiss) wanted.add(unit.nodeId);
    return { id: message.id, action: 'drop', unit: unit.nodeId, ...(firstMiss ? { foldWanted: true as const } : {}) };
  });
}

export async function contextVerdicts(ctx: ToolContext, input: unknown): Promise<ToolOutcome<ContextVerdictsData>> {
  const parsed = parseArgs(contextVerdictsSchema, input);
  if (!parsed.ok) return parsed;
  const args = parsed.data;
  const session = sessionOf(ctx);
  const turn = advanceTurn(session, args.turn);
  const { store, trace } = ctx.handle;
  const lastSeq = trace.lastSeq();

  const spans: Span[] = [];
  for (const id of session.evicted) {
    const node = store.getNode(id);
    if (node === null || node.span_start_seq === null) continue;
    // An OPEN phase has no end yet and is read to the end of the trace, so its span has
    // to reach there too — or the whole tail is billed to it while one message drops.
    const end = node.span_end_seq ?? (node.status === 'open' ? lastSeq : node.span_start_seq);
    spans.push({ nodeId: id, start: node.span_start_seq, end, summary: store.currentSummary(id)?.text ?? null });
  }

  const tokensOf = (id: string): number => args.messages.find((m) => m.id === id)?.tokens ?? 0;
  const kept = (ds: readonly Verdict[]): number => ds.reduce((n, d) => n + (d.action === 'drop' ? 0 : tokensOf(d.id)), 0);

  let protectTail = args.protect_tail ?? session.pipeline.protectTail;
  let decisions = planVerdicts(args.messages, session.messageIndex, spans, protectTail, args.summaries === true);
  let escalations = 0;
  if (args.ceiling_tokens !== undefined) {
    while (kept(decisions) > args.ceiling_tokens && protectTail > 1) {
      protectTail -= 1;
      escalations += 1;
      decisions = planVerdicts(args.messages, session.messageIndex, spans, protectTail, args.summaries === true);
    }
  }
  const keptTokens = kept(decisions);
  return ok({
    turn,
    indexed: session.messageIndex !== null,
    total_tokens: args.messages.reduce((n, m) => n + (m.tokens ?? 0), 0),
    kept_tokens: keptTokens,
    protect_tail: protectTail,
    escalations,
    over_ceiling: args.ceiling_tokens !== undefined && keptTokens > args.ceiling_tokens,
    evicted_units: spans.length,
    decisions,
  });
}
