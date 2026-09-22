/**
 * `fold` — the segmenter's stage: WHICH blocks fold, written to the ledger (D26).
 *
 * Runs the fold policy (`foldTrigger`) over the blocks of every live unit, or folds the
 * `stubs` a caller names. Each fold is a `fold` event in L0 with the stub's text, so it is
 * sticky and byte-stable from then on (D5), and replayable. Nothing is deleted here — that
 * is `evict`, afterwards — and no summary is written here — `assemble` asks, `summarize`
 * writes.
 */
import { z } from 'zod';
import { planFolds, stubFoldId, stubOf, unitSignals, type FoldCandidate } from '@context-tree/core';
import { stageArgsShape, withOverrides } from '../params.js';
import { fail, failFrom, ok, parseArgs } from '../result.js';
import { advanceTurn, residueOf, sessionOf, sessionUnits, unitShownTokens } from '../session.js';
import type { ToolContext, ToolOutcome } from '../types.js';
import { pinnedIds } from './context-assemble.js';
import { budgetOf, messagesArg, turnArg, windowShape } from './pipeline-args.js';
import { countActions, decisionsFor, type Decision } from './render.js';

export const CONTEXT_FOLD = 'fold';

export const CONTEXT_FOLD_DESCRIPTION =
  'Fold blocks of your context to their short form — a tool output becomes a tag naming what it was and how ' +
  'to get it back, a thinking block keeps its conclusion — under the fold policy for window_tokens, or the ' +
  'stubs you name. Nothing is deleted and the content is one fetch away. Reach for it when older work is ' +
  'crowding your context but you may still need to look something up.';

const shape = {
  ...windowShape,
  stubs: z.array(z.number().int().positive()).optional().describe('Fold exactly these stub ids (from `units`), whatever the policy says.'),
  messages: messagesArg,
  turn: turnArg,
  dry_run: z.boolean().optional().describe('Report what would fold; write nothing.'),
  ...stageArgsShape('fold'),
};
export const contextFoldSchema = z.object(shape);
export const contextFoldInputShape = shape;

export interface ContextFoldData {
  turn: number;
  applied: boolean;
  fired: boolean;
  /** Stub ids folded this call. */
  folded: number[];
  folds_total: number;
  tokens_before: number;
  tokens_after: number;
  decisions?: Decision[];
  actions?: Record<Decision['action'], number>;
}

export async function contextFold(ctx: ToolContext, input: unknown): Promise<ToolOutcome<ContextFoldData>> {
  const parsed = parseArgs(contextFoldSchema, input);
  if (!parsed.ok) return parsed;
  const args = parsed.data;
  const budgetTokens = budgetOf(args);
  if (budgetTokens === null) return fail('invalid_input', 'reserve_tokens leaves no room in window_tokens');
  try {
    const session = sessionOf(ctx);
    const turn = advanceTurn(session, args.turn);
    const params = withOverrides(session.params, 'fold', args);
    const snapshot = await sessionUnits(ctx);
    const live = snapshot.units.filter((u) => !session.evicted.has(u.id));
    const pinned = pinnedIds(live);
    const signals = unitSignals(live.map((u) => u.flex), turn, params.priorityHalfLife);
    const scoreOf = new Map(live.map((u, i) => [u.id, signals[i]!.priority + signals[i]!.recency + signals[i]!.refRecency - signals[i]!.dormancy]));

    const candidates: FoldCandidate[] = live.flatMap((u, i) =>
      u.blocks.map((b): FoldCandidate => ({
        stub: b.stub,
        kind: b.kind,
        turnsFromNewest: live.length - 1 - i,
        score: scoreOf.get(u.id) ?? 0,
        tokens: snapshot.view.get(b.stub)?.tokens ?? b.tokens,
        residue: residueOf(ctx, snapshot, b),
        pinned: pinned.has(u.id),
      })),
    );
    const plan = args.stubs === undefined
      ? planFolds(candidates, { trigger: params.foldTrigger, budgetTokens, foldStubAt: params.foldStubAt, cadenceN: params.cadenceN, turn, anchor: params.anchor, foldReasoningAfter: params.foldReasoningAfter })
      : { stubs: args.stubs.filter((s) => candidates.some((c) => c.stub === s && c.residue !== null)), tokensBefore: live.reduce((n, u) => n + unitShownTokens(session, u), 0), tokensAfter: NaN, fired: true };

    const applied = args.dry_run !== true && plan.stubs.length > 0;
    if (applied) {
      const events = ctx.handle.trace.all();
      const byStub = new Map(snapshot.blocks.map((b) => [b.stub, b]));
      for (const id of plan.stubs) {
        const block = byStub.get(id);
        if (block === undefined) continue;
        const stub = stubOf(block, events, ctx.handle.blobs, session.tokenizer, { foldReasoning: params.foldReasoning, foldReasoningTail: params.foldReasoningTail });
        ctx.handle.trace.append({
          type: 'fold', ts: new Date().toISOString(), fold_id: stubFoldId(block.fromSeq), kind: 'stub',
          from_seq: block.fromSeq, to_seq: block.toSeq, blob: ctx.handle.blobs.put(JSON.stringify({ parts: stub.parts, tokens: stub.tokens })),
          trigger: args.stubs === undefined ? `policy:${params.foldTrigger}` : 'caller',
        });
      }
    }
    const after = applied ? await sessionUnits(ctx) : snapshot;
    const decisions = args.messages !== undefined ? await decisionsFor(ctx, args.messages) : undefined;
    return ok({
      turn,
      applied,
      fired: plan.fired,
      folded: [...plan.stubs],
      folds_total: after.folds.filter((f) => f.kind === 'stub').length,
      tokens_before: plan.tokensBefore,
      tokens_after: applied ? after.units.filter((u) => !session.evicted.has(u.id)).reduce((n, u) => n + unitShownTokens(session, u), 0) : plan.tokensBefore,
      ...(decisions !== undefined ? { decisions, actions: countActions(decisions) } : {}),
    });
  } catch (error) {
    return failFrom(error);
  }
}
