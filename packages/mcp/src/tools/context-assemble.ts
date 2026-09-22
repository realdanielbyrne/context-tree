/**
 * `assemble` — HOW each unit is represented: raw, or reduced to the per-unit budget. It
 * removes nothing and folds nothing: folding is the segmenter's (`fold`, the ledger), and
 * `evict` runs after both, takes this result as its input, and may overrule it.
 *
 * It is also where SUMMARIES ARE ASKED FOR (D26). When a run of folded blocks outside the
 * anchor holds more than `foldSummarizeAt` of the budget, assembly requests one summary over
 * that run — the segment that contains it when the whole segment is folded, else the run —
 * and reports the request. It does not wait: a summary takes a model call, and the caller
 * (a host adapter, an agent) fulfils it through `summarize`; the next view shows it.
 *
 * Reductions are sticky: a unit once reduced stays that way until `restore`, so
 * re-assembling each turn only ever adds to the ruling and the cached prefix is not
 * rewritten by a unit flipping back to raw.
 */
import { z } from 'zod';
import { perUnitBudget, representUnits, tokensUnder, type AssembleUnit, type Block, type Disposition } from '@context-tree/core';
import { stageArgsShape, withOverrides } from '../params.js';
import { fail, failFrom, ok, parseArgs } from '../result.js';
import { advanceTurn, dispositionOf, sessionOf, sessionUnits, viewOf, type SessionUnit, type UnitView } from '../session.js';
import type { ToolContext, ToolOutcome } from '../types.js';
import { budgetOf, messagesArg, turnArg, windowShape } from './pipeline-args.js';
import { countActions, decisionsFor, type Decision } from './render.js';

export const CONTEXT_ASSEMBLE = 'assemble';

export const CONTEXT_ASSEMBLE_DESCRIPTION =
  'Decide how each unit of your context is represented for window_tokens: kept raw, or reduced to the ' +
  'per-unit budget (the spans matching query survive). Removes nothing — evict does that, afterwards, and ' +
  'may overrule this. Reports the ranges of folded history it would like summarized (summary_requests); ' +
  'summarize writes them. Reach for it when single units have grown large and you want them smaller ' +
  'without losing any of them.';

const shape = {
  ...windowShape,
  query: z.string().optional().describe('The current task or question; ranks the spans a reduction keeps.'),
  messages: messagesArg,
  turn: turnArg,
  ...stageArgsShape('assemble'),
};
export const contextAssembleSchema = z.object(shape);
export const contextAssembleInputShape = shape;

export type Representation = Disposition['kind'];

export interface AssembledUnit extends UnitView {
  tokens: number;
  assembled_tokens: number;
  representation: Representation;
}

export interface SummaryRequest {
  from_seq: number;
  to_seq: number;
  from_stub: number;
  to_stub: number;
  /** The segment whose span this is, when it is one. */
  node_id: string | null;
  folded_tokens: number;
}

export interface ContextAssembleData {
  turn: number;
  per_unit_budget: number;
  tokens_raw: number;
  tokens_assembled: number;
  /** The assembly. Pass it to `evict` as `assembly`, or let `evict` read the session's copy. */
  units: AssembledUnit[];
  /** Ranges of folded history assembly would like summarized. Fulfil with `summarize`. */
  summary_requests: SummaryRequest[];
  decisions?: Decision[];
  actions?: Record<Decision['action'], number>;
}

/** Units whose loss breaks the REQUEST, not the policy: the task statement (a chat template rejects a prompt with no user message) and the newest message. */
export function pinnedIds(units: readonly SessionUnit[]): ReadonlySet<string> {
  const taskStatement = units.find((u) => u.fromUser);
  const newest = units.at(-1);
  return new Set([taskStatement?.id, newest?.id].filter((id): id is string => id !== undefined));
}

/**
 * The runs of consecutive stubbed blocks outside the anchor, each widened to its segment when
 * every block of that segment is folded; a run already under a summary is not asked for again.
 */
function summaryRequests(ctx: ToolContext, live: readonly SessionUnit[], budgetTokens: number): SummaryRequest[] {
  const session = sessionOf(ctx);
  const { params } = session;
  const snapshot = session.snapshot;
  if (!params.foldSummaries || snapshot === null) return [];
  const anchored = new Set(live.slice(Math.max(0, live.length - params.anchor)).map((u) => u.id));
  const eligible = live.filter((u) => !anchored.has(u.id)).flatMap((u) => u.blocks);
  const stubbed = (b: Block): boolean => snapshot.view.get(b.stub)?.kind === 'stub';
  const runs: Block[][] = [];
  let run: Block[] = [];
  for (const block of eligible) {
    if (stubbed(block)) run.push(block);
    else if (run.length > 0) { runs.push(run); run = []; }
  }
  if (run.length > 0) runs.push(run);

  const phases = ctx.handle.store.nodesInCreationOrder().filter((n) => n.kind === 'phase' && n.span_start_seq !== null);
  const out: SummaryRequest[] = [];
  for (const r of runs) {
    if (r.length < params.foldMinRun) continue;
    const folded = r.reduce((n, b) => n + (snapshot.view.get(b.stub)?.tokens ?? 0), 0);
    if (folded <= params.foldSummarizeAt * budgetTokens) continue;
    let fromSeq = r[0]!.fromSeq;
    let toSeq = r[r.length - 1]!.toSeq;
    let nodeId: string | null = null;
    const phase = phases.find((p) => p.span_start_seq! <= fromSeq && toSeq <= (p.span_end_seq ?? p.span_start_seq!));
    if (phase !== undefined) {
      const span = { from: phase.span_start_seq!, to: phase.span_end_seq ?? phase.span_start_seq! };
      const whole = snapshot.blocks.filter((b) => span.from <= b.fromSeq && b.toSeq <= span.to);
      if (whole.every((b) => snapshot.view.get(b.stub)?.kind !== 'raw')) { fromSeq = span.from; toSeq = span.to; nodeId = phase.id; }
    }
    if (snapshot.folds.some((f) => f.kind === 'summary' && f.fromSeq <= fromSeq && toSeq <= f.toSeq)) continue;
    const inside = snapshot.blocks.filter((b) => fromSeq <= b.fromSeq && b.toSeq <= toSeq);
    out.push({ from_seq: fromSeq, to_seq: toSeq, from_stub: inside[0]!.stub, to_stub: inside[inside.length - 1]!.stub, node_id: nodeId, folded_tokens: folded });
  }
  return out;
}

export async function contextAssemble(ctx: ToolContext, input: unknown): Promise<ToolOutcome<ContextAssembleData>> {
  const parsed = parseArgs(contextAssembleSchema, input);
  if (!parsed.ok) return parsed;
  const args = parsed.data;
  const budgetTokens = budgetOf(args);
  if (budgetTokens === null) return fail('invalid_input', 'reserve_tokens leaves no room in window_tokens');
  try {
    const session = sessionOf(ctx);
    const turn = advanceTurn(session, args.turn);
    const params = withOverrides(session.params, 'assemble', args);
    if (args.query !== undefined) session.query = args.query;

    const { units } = await sessionUnits(ctx);
    const live = units.filter((u) => !session.evicted.has(u.id));
    const pinned = pinnedIds(live);
    const geometry = { windowTokens: args.window_tokens, reserveTokens: args.reserve_tokens ?? 0, anchor: params.anchor, softTargetFrac: params.softTargetFrac };
    const { dispositions: ruled } = representUnits(
      live.map((u): AssembleUnit => ({ id: u.id, tokens: u.shownTokens, raw: u.flex.raw, pinned: pinned.has(u.id), textOnly: !u.hasTools })),
      {
        ...geometry, summaries: false, reducer: params.reducer === 'none' ? null : params.reducer, tokenizer: session.tokenizer,
        ...(session.query !== undefined ? { query: session.query } : {}),
        chunkOptions: { chunkSize: session.params.chunkSize, chunkOverlap: session.params.chunkOverlap }, rrfK: session.params.rrfK,
      },
    );
    // Sticky: a unit never returns to raw here.
    for (const [id, disposition] of ruled) {
      if (disposition.kind === 'reduce' && !session.assembly.has(id)) session.assembly.set(id, disposition);
    }

    const rows = live.map((u): AssembledUnit => {
      const disposition = dispositionOf(session, u);
      return { ...viewOf(u), tokens: u.tokens, assembled_tokens: tokensUnder({ tokens: u.shownTokens }, disposition), representation: disposition.kind };
    });
    const decisions = args.messages !== undefined ? await decisionsFor(ctx, args.messages) : undefined;
    return ok({
      turn,
      per_unit_budget: perUnitBudget(geometry),
      tokens_raw: rows.reduce((n, r) => n + r.tokens, 0),
      tokens_assembled: rows.reduce((n, r) => n + r.assembled_tokens, 0),
      units: rows,
      summary_requests: summaryRequests(ctx, live, budgetTokens),
      ...(decisions !== undefined ? { decisions, actions: countActions(decisions) } : {}),
    });
  } catch (error) {
    return failFrom(error);
  }
}
