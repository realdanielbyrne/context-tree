/**
 * `fold` — the segmenter's stage (D26, D27): which blocks fold, which come back, and which
 * runs of folded blocks should be summarized, all read off one pull (`segment/gravity.ts`).
 *
 * Every fold and unfold is an L0 event, so what the model was shown on any turn replays.
 * A fold's text never changes once written (D5); a fold may END, when its block regains
 * relevance or the well releases it, and the host then sends the block raw again. Nothing is
 * deleted here — that is `evict`, afterwards — and no summary is written here: the runs
 * the pull reaches are reported as `summary_requests` and `summarize` writes them.
 */
import { z } from 'zod';
import { distanceOf, planGravity, stubFoldId, stubOf, type GravityBlock, type GravitySummary } from '@context-tree/core';
import { contextMass, irrelevance, kappaFor, observe } from '../gravity.js';
import { stageArgsShape, withOverrides } from '../params.js';
import { fail, failFrom, ok, parseArgs } from '../result.js';
import { advanceTurn, residueOf, sessionOf, sessionUnits, unitShownTokens, type Snapshot } from '../session.js';
import type { ToolContext, ToolOutcome } from '../types.js';
import { pinnedIds } from './context-assemble.js';
import { budgetOf, messagesArg, turnArg, windowShape } from './pipeline-args.js';
import { countActions, decisionsFor, type Decision } from './render.js';

export const CONTEXT_FOLD = 'fold';

export const CONTEXT_FOLD_DESCRIPTION =
  'Fold blocks of your context to their short form — a tool output becomes a tag naming what it was and how ' +
  'to get it back, a thinking block keeps its conclusion — as your context nears window_tokens, or the stubs ' +
  'you name; blocks that matter again come back. Nothing is deleted and the content is one fetch away. Reach ' +
  'for it when older work is crowding your context but you may still need to look something up.';

const shape = {
  ...windowShape,
  stubs: z.array(z.number().int().positive()).optional().describe('Fold exactly these stub ids (from `units`), whatever the pull says.'),
  messages: messagesArg,
  turn: turnArg,
  dry_run: z.boolean().optional().describe('Report what would fold; write nothing.'),
  ...stageArgsShape('fold'),
};
export const contextFoldSchema = z.object(shape);
export const contextFoldInputShape = shape;

export interface SummaryRequest {
  from_seq: number;
  to_seq: number;
  from_stub: number;
  to_stub: number;
  /** The segment whose span this is, when it is one. */
  node_id: string | null;
  /** What the run's stubs take in the prompt now. */
  folded_tokens: number;
  /** What the summary would cover. */
  raw_tokens: number;
}

export interface ContextFoldData {
  turn: number;
  applied: boolean;
  fired: boolean;
  /** Stub ids folded this call. */
  folded: number[];
  /** Stub ids whose fold ended this call: they show raw again. */
  unfolded: number[];
  /** Summary fold ids retired this call. */
  unsummarized: string[];
  /** Runs of folded blocks the pull reaches. Fulfil with `summarize`. */
  summary_requests: SummaryRequest[];
  folds_total: number;
  tokens_before: number;
  tokens_after: number;
  kappa: number;
  /** The context's irrelevance mass M. */
  mass: number;
  /** Distance from the window, as a fraction of the budget, before and after. */
  d_before: number;
  d_after: number;
  /** What moved κ this turn (adaptive only). */
  signals?: Record<string, number>;
  decisions?: Decision[];
  actions?: Record<Decision['action'], number>;
}

/** A run widened to its segment when every block of that segment is folded; null when a summary already covers it. */
function requestOf(ctx: ToolContext, snapshot: Snapshot, fromStub: number, toStub: number): SummaryRequest | null {
  const inRun = snapshot.blocks.filter((b) => fromStub <= b.stub && b.stub <= toStub);
  let fromSeq = inRun[0]!.fromSeq;
  let toSeq = inRun[inRun.length - 1]!.toSeq;
  let nodeId: string | null = null;
  const phase = ctx.handle.store.nodesInCreationOrder()
    .find((n) => n.kind === 'phase' && n.span_start_seq !== null && n.span_start_seq <= fromSeq && toSeq <= (n.span_end_seq ?? n.span_start_seq));
  if (phase !== undefined) {
    const span = { from: phase.span_start_seq!, to: phase.span_end_seq ?? phase.span_start_seq! };
    const whole = snapshot.blocks.filter((b) => span.from <= b.fromSeq && b.toSeq <= span.to);
    if (whole.every((b) => snapshot.view.get(b.stub)?.kind !== 'raw')) { fromSeq = span.from; toSeq = span.to; nodeId = phase.id; }
  }
  if (snapshot.folds.some((f) => f.kind === 'summary' && f.fromSeq <= fromSeq && toSeq <= f.toSeq)) return null;
  const inside = snapshot.blocks.filter((b) => fromSeq <= b.fromSeq && b.toSeq <= toSeq);
  return {
    from_seq: fromSeq, to_seq: toSeq, from_stub: inside[0]!.stub, to_stub: inside[inside.length - 1]!.stub, node_id: nodeId,
    folded_tokens: inside.reduce((n, b) => n + (snapshot.view.get(b.stub)?.tokens ?? b.tokens), 0),
    raw_tokens: inside.reduce((n, b) => n + b.tokens, 0),
  };
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
    const liveTokens = live.reduce((n, u) => n + unitShownTokens(session, u), 0);
    const events = ctx.handle.trace.all();
    const byStart = new Map(events.map((e) => [e.seq, e]));

    const state = session.gravity;
    const foldedPaths = new Set(snapshot.blocks.flatMap((b) => {
      const kind = snapshot.view.get(b.stub)?.kind;
      const call = byStart.get(b.fromSeq);
      return (kind === 'stub' || kind === 'covered') && call?.type === 'tool_call' && call.path !== undefined ? [call.path] : [];
    }));
    const kappa = kappaFor(state, params, turn, () => observe(state, events, foldedPaths, turn, params));
    const e = await irrelevance(session, live, pinned, params, turn);

    const blocks: GravityBlock[] = live.flatMap((u) => u.blocks.map((b): GravityBlock => {
      const view = snapshot.view.get(b.stub);
      const kind = view?.kind ?? 'raw';
      return {
        stub: b.stub, kind: b.kind, unit: u.id, e: e.get(u.id) ?? 0, raw: b.tokens, shown: view?.tokens ?? b.tokens,
        state: kind, residue: kind === 'raw' ? residueOf(ctx, snapshot, b) : null, pinned: pinned.has(u.id),
      };
    }));
    const inLive = new Set(blocks.map((b) => b.stub));
    const summaries: GravitySummary[] = snapshot.folds
      .filter((f) => f.kind === 'summary')
      .map((f) => ({ id: f.id, stubs: snapshot.blocks.filter((b) => f.fromSeq <= b.fromSeq && b.toSeq <= f.toSeq && inLive.has(b.stub)).map((b) => b.stub) }));

    const plan = args.stubs === undefined
      ? planGravity({
        budget: budgetTokens, live: liveTokens, kappa, blocks, summaries,
        breakpoints: { fold: params.gFold, unfold: params.gUnfold, summarize: params.gSummarize, unsummarize: params.gUnsummarize },
      })
      : {
        unfolds: [], folds: args.stubs.filter((s) => blocks.some((b) => b.stub === s && b.residue !== null)), summarize: [], unsummarize: [],
        mass: contextMass(live, e, budgetTokens), dBefore: distanceOf(liveTokens, budgetTokens), dAfter: Number.NaN, liveAfter: Number.NaN,
      };

    const applied = args.dry_run !== true && (plan.folds.length + plan.unfolds.length + plan.unsummarize.length) > 0;
    if (applied) {
      const byStub = new Map(snapshot.blocks.map((b) => [b.stub, b]));
      const ts = new Date().toISOString();
      const trigger = args.stubs === undefined ? `gravity:k=${kappa.toPrecision(4)}` : 'caller';
      for (const id of plan.unfolds) {
        const block = byStub.get(id);
        if (block === undefined) continue;
        ctx.handle.trace.append({ type: 'unfold', ts, fold_id: stubFoldId(block.fromSeq) });
        const at = state.foldedAt.get(id);
        if (at !== undefined && turn - at <= params.repeatWindow) state.thrash += 1;
        state.unfoldedAt.set(id, turn);
      }
      for (const id of plan.unsummarize) ctx.handle.trace.append({ type: 'unfold', ts, fold_id: id });
      for (const id of plan.folds) {
        const block = byStub.get(id);
        if (block === undefined) continue;
        const stub = stubOf(block, events, ctx.handle.blobs, session.tokenizer, { foldReasoning: params.foldReasoning, foldReasoningTail: params.foldReasoningTail });
        ctx.handle.trace.append({
          type: 'fold', ts, fold_id: stubFoldId(block.fromSeq), kind: 'stub',
          from_seq: block.fromSeq, to_seq: block.toSeq, blob: ctx.handle.blobs.put(JSON.stringify({ parts: stub.parts, tokens: stub.tokens })), trigger,
        });
        const at = state.unfoldedAt.get(id);
        if (at !== undefined && turn - at <= params.repeatWindow) state.thrash += 1;
        state.foldedAt.set(id, turn);
      }
    }
    const after = applied ? await sessionUnits(ctx) : snapshot;
    const requests = plan.summarize.flatMap((r) => requestOf(ctx, after, r.fromStub, r.toStub) ?? []);
    const decisions = args.messages !== undefined ? await decisionsFor(ctx, args.messages) : undefined;
    const tokensAfter = applied ? after.units.filter((u) => !session.evicted.has(u.id)).reduce((n, u) => n + unitShownTokens(session, u), 0) : liveTokens;
    return ok({
      turn,
      applied,
      fired: plan.folds.length + plan.unfolds.length + plan.unsummarize.length + requests.length > 0,
      folded: [...plan.folds],
      unfolded: [...plan.unfolds],
      unsummarized: [...plan.unsummarize],
      summary_requests: requests,
      folds_total: after.folds.filter((f) => f.kind === 'stub').length,
      tokens_before: liveTokens,
      tokens_after: tokensAfter,
      kappa,
      mass: plan.mass,
      d_before: plan.dBefore,
      d_after: distanceOf(tokensAfter, budgetTokens),
      ...(params.gravityMode === 'adaptive' ? { signals: { ...state.lastSignals } } : {}),
      ...(decisions !== undefined ? { decisions, actions: countActions(decisions) } : {}),
    });
  } catch (error) {
    return failFrom(error);
  }
}
