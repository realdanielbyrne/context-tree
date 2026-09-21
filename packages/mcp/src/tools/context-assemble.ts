/**
 * `assemble` — HOW each unit is represented: raw, reduced to the per-unit budget, or
 * folded to its phase's summary. It removes nothing. `evict` runs after it, takes this
 * result as its input, and may overrule it.
 *
 * Representations are sticky: a unit once reduced or folded stays that way until
 * `restore`, so re-assembling each turn only ever adds to the ruling and the cached
 * prefix is not rewritten by a unit flipping back to raw.
 */
import { z } from 'zod';
import { foldLine, perUnitBudget, representUnits, tokensUnder, type AssembleUnit, type Disposition } from '@context-tree/core';
import { stageArgsShape, withOverrides } from '../params.js';
import { fail, failFrom, ok, parseArgs } from '../result.js';
import { advanceTurn, dispositionOf, sessionOf, sessionUnits, viewOf, type SessionUnit, type UnitView } from '../session.js';
import type { ToolContext, ToolOutcome } from '../types.js';
import { budgetOf, messagesArg, turnArg, windowShape } from './pipeline-args.js';
import { countActions, decisionsFor, type Decision } from './render.js';

export const CONTEXT_ASSEMBLE = 'assemble';

export const CONTEXT_ASSEMBLE_DESCRIPTION =
  'Decide how each unit of your context is represented for window_tokens: kept raw, reduced to the ' +
  'per-unit budget (the spans matching query survive), or folded to its phase summary. Removes nothing — ' +
  'evict does that, afterwards, and may overrule this. Reach for it when single units have grown large ' +
  'and you want them smaller without losing any of them.';

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

export interface ContextAssembleData {
  turn: number;
  per_unit_budget: number;
  tokens_raw: number;
  tokens_assembled: number;
  /** The assembly. Pass it to `evict` as `assembly`, or let `evict` read the session's copy. */
  units: AssembledUnit[];
  /** Phases that qualified for a fold but have no text-only unit to carry the summary; they stay as they are. */
  unfoldable_phases: string[];
  decisions?: Decision[];
  actions?: Record<Decision['action'], number>;
}

/** Units whose loss breaks the REQUEST, not the policy: the task statement (a chat template rejects a prompt with no user message) and the newest message. */
export function pinnedIds(units: readonly SessionUnit[]): ReadonlySet<string> {
  const taskStatement = units.find((u) => u.fromUser);
  const newest = units.at(-1);
  return new Set([taskStatement?.id, newest?.id].filter((id): id is string => id !== undefined));
}

export async function contextAssemble(ctx: ToolContext, input: unknown): Promise<ToolOutcome<ContextAssembleData>> {
  const parsed = parseArgs(contextAssembleSchema, input);
  if (!parsed.ok) return parsed;
  const args = parsed.data;
  if (budgetOf(args) === null) return fail('invalid_input', 'reserve_tokens leaves no room in window_tokens');
  try {
    const session = sessionOf(ctx);
    const turn = advanceTurn(session, args.turn);
    const params = withOverrides(session.params, 'assemble', args);
    if (args.query !== undefined) session.query = args.query;

    const { units } = await sessionUnits(ctx);
    const live = units.filter((u) => !session.evicted.has(u.id));
    const pinned = pinnedIds(live);
    const geometry = { windowTokens: args.window_tokens, reserveTokens: args.reserve_tokens ?? 0, anchor: params.anchor, softTargetFrac: params.softTargetFrac };
    const { dispositions: ruled, unfoldable } = representUnits(
      live.map((u): AssembleUnit => {
        const stored = ctx.handle.store.currentSummary(u.phase.id);
        const summary = stored === null ? undefined : foldLine(stored, params.summaryRender);
        return {
          id: u.id, tokens: u.tokens, raw: u.flex.raw, pinned: pinned.has(u.id), textOnly: !u.hasTools,
          group: { id: u.phase.id, closed: u.phase.status !== 'open', ...(summary !== undefined ? { summary } : {}) },
        };
      }),
      {
        ...geometry, summaries: params.summaries, reducer: params.reducer === 'none' ? null : params.reducer, tokenizer: session.tokenizer,
        ...(session.query !== undefined ? { query: session.query } : {}),
        chunkOptions: { chunkSize: session.params.chunkSize, chunkOverlap: session.params.chunkOverlap }, rrfK: session.params.rrfK,
      },
    );
    // Sticky, with one way forward: a unit never returns to raw here, but a phase whose summary
    // arrives AFTER its units were reduced (summarization is async) still folds.
    for (const [id, disposition] of ruled) {
      const prior = session.assembly.get(id)?.kind;
      const supersedes = disposition.kind === 'fold' || disposition.kind === 'drop';
      if (disposition.kind !== 'keep' && (prior === undefined || (prior === 'reduce' && supersedes))) session.assembly.set(id, disposition);
    }

    const rows = live.map((u): AssembledUnit => {
      const disposition = dispositionOf(session, u);
      return { ...viewOf(u), tokens: u.tokens, assembled_tokens: tokensUnder(u, disposition), representation: disposition.kind };
    });
    const decisions = args.messages !== undefined ? await decisionsFor(ctx, args.messages) : undefined;
    return ok({
      turn,
      per_unit_budget: perUnitBudget(geometry),
      tokens_raw: rows.reduce((n, r) => n + r.tokens, 0),
      tokens_assembled: rows.reduce((n, r) => n + r.assembled_tokens, 0),
      units: rows,
      unfoldable_phases: [...unfoldable],
      ...(decisions !== undefined ? { decisions, actions: countActions(decisions) } : {}),
    });
  } catch (error) {
    return failFrom(error);
  }
}
