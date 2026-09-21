/**
 * `evict` / `restore` — WHAT is removed. `evict` takes an assembly as its input (passed
 * inline, else the session's latest) and rules on removal against the sizes assembly
 * produced, so it can overrule a representation: a unit `assemble` kept, reduced or
 * folded can still go. It never chooses a representation itself.
 *
 * Removal is sticky — a unit stays out until `restore` — so a caller's policy is simply
 * WHEN it calls: every turn, every Nth, only above some size, or never.
 */
import { z } from 'zod';
import { ensembleRetrieve, planRetention, tokensUnder, unitSignals, type RetentionUnit } from '@context-tree/core';
import { stageArgsShape, withOverrides, type PipelineParams } from '../params.js';
import { fail, failFrom, ok, parseArgs } from '../result.js';
import { advanceTurn, dispositionOf, sessionOf, sessionUnits, type Session, type SessionUnit } from '../session.js';
import type { ToolContext, ToolOutcome } from '../types.js';
import { pinnedIds } from './context-assemble.js';
import { budgetOf, messagesArg, turnArg, windowShape } from './pipeline-args.js';
import { countActions, decisionsFor, type Decision } from './render.js';

export const CONTEXT_EVICT = 'evict';
export const CONTEXT_RESTORE = 'restore';

export const CONTEXT_EVICT_DESCRIPTION =
  'Remove the least valuable units so what assemble produced fits window_tokens. Recent units are ' +
  'protected by a bonus that yields only if nothing else can pay. Removed units stay out until restore; ' +
  'nothing is lost and fetch still returns them. Reach for it when your context is large and earlier ' +
  'work no longer bears on what you are doing. dry_run shows what would go.';

export const CONTEXT_RESTORE_DESCRIPTION =
  'Undo rulings on units, by id or all at once: an evicted unit comes back, a reduced or folded one ' +
  'returns to raw. Reach for it when work you set aside has become relevant again and you want it ' +
  'present on every turn rather than fetched once.';

const evictShape = {
  ...windowShape,
  assembly: z
    .array(z.object({ id: z.string().min(1), assembled_tokens: z.number().nonnegative() }).loose())
    .optional()
    .describe("assemble's `units`, as returned. Omit to use the session's latest assembly."),
  query: z.string().optional().describe('The current task or question; ranks units when w_relevance > 0.'),
  dry_run: z.boolean().optional().describe('Report what would be removed; change nothing.'),
  messages: messagesArg,
  turn: turnArg,
  ...stageArgsShape('evict'),
};
export const contextEvictSchema = z.object(evictShape);
export const contextEvictInputShape = evictShape;

const restoreShape = {
  ids: z.array(z.string().min(1)).optional().describe('Unit ids, from `units`.'),
  all: z.boolean().optional().describe('Undo every ruling.'),
};
export const contextRestoreSchema = z.object(restoreShape);
export const contextRestoreInputShape = restoreShape;

export interface ContextEvictData {
  turn: number;
  applied: boolean;
  /** False when the assembly already fit: nothing was decided. */
  fired: boolean;
  evicted: string[];
  tokens_before: number;
  tokens_after: number;
  /** True when the pinned units alone exceed the budget: no policy can fix that overflow. */
  over_budget: boolean;
  evicted_total: number;
  decisions?: Decision[];
  actions?: Record<Decision['action'], number>;
}

/** 1 for the newest live unit, halving every `halfLife` units back, 0 outside the anchor. */
const protectionAt = (fromNewest: number, params: PipelineParams): number =>
  fromNewest < params.anchor ? Math.pow(0.5, fromNewest / params.priorityHalfLife) : 0;

async function relevanceRanks(session: Session, live: readonly SessionUnit[], params: PipelineParams, query: string | undefined): Promise<ReadonlyMap<string, number>> {
  if (params.wRelevance === 0 || params.topK === 0 || query === undefined || query.trim() === '') return new Map();
  const hits = await ensembleRetrieve(query, live.map((u) => ({ id: u.id, text: u.flex.raw })), undefined, {
    topK: params.topK,
    rrfK: session.params.rrfK,
    chunk: { chunkSize: session.params.chunkSize, chunkOverlap: session.params.chunkOverlap },
  });
  return new Map(hits.map((hit, rank) => [hit.unitId, 1 - rank / params.topK]));
}

export async function contextEvict(ctx: ToolContext, input: unknown): Promise<ToolOutcome<ContextEvictData>> {
  const parsed = parseArgs(contextEvictSchema, input);
  if (!parsed.ok) return parsed;
  const args = parsed.data;
  const budgetTokens = budgetOf(args);
  if (budgetTokens === null) return fail('invalid_input', 'reserve_tokens leaves no room in window_tokens');
  try {
    const session = sessionOf(ctx);
    const turn = advanceTurn(session, args.turn);
    const params = withOverrides(session.params, 'evict', args);
    const query = args.query ?? session.query;

    const { units } = await sessionUnits(ctx);
    const live = units.filter((u) => !session.evicted.has(u.id));
    const inline = new Map((args.assembly ?? []).map((row) => [row.id, row.assembled_tokens]));
    const pinned = pinnedIds(live);
    const signals = unitSignals(live.map((u) => u.flex), turn, params.priorityHalfLife);
    const relevance = await relevanceRanks(session, live, params, query);

    const plan = planRetention(
      live.map((u, i): RetentionUnit => ({
        id: u.id,
        tokens: inline.get(u.id) ?? tokensUnder(u, dispositionOf(session, u.id)),
        signals: signals[i]!,
        pinned: pinned.has(u.id),
        protection: protectionAt(live.length - 1 - i, params),
        relevance: relevance.get(u.id) ?? 0,
      })),
      {
        budgetTokens,
        headroomTokens: params.headroomTokens,
        weights: { priority: params.wPriority, recency: params.wRecency, refRecency: params.wRefRecency, dormancy: params.wDormancy, relevance: params.wRelevance },
        protection: params.protection,
        protectionBonus: params.protectionBonus,
      },
    );

    const applied = args.dry_run !== true;
    if (applied) for (const id of plan.dropped) session.evicted.add(id);
    const decisions = args.messages !== undefined ? await decisionsFor(ctx, args.messages) : undefined;
    return ok({
      turn,
      applied,
      fired: plan.fired,
      evicted: [...plan.dropped],
      tokens_before: plan.tokensBefore,
      tokens_after: plan.tokensAfter,
      over_budget: plan.overBudget,
      evicted_total: session.evicted.size,
      ...(decisions !== undefined ? { decisions, actions: countActions(decisions) } : {}),
    });
  } catch (error) {
    return failFrom(error);
  }
}

export interface ContextRestoreData {
  restored: string[];
  evicted_total: number;
}

export async function contextRestore(ctx: ToolContext, input: unknown): Promise<ToolOutcome<ContextRestoreData>> {
  const parsed = parseArgs(contextRestoreSchema, input);
  if (!parsed.ok) return parsed;
  const args = parsed.data;
  if (args.all !== true && (args.ids === undefined || args.ids.length === 0)) return fail('invalid_input', 'give ids, or all: true');
  const session = sessionOf(ctx);
  const targets = args.all === true ? [...new Set([...session.evicted, ...session.assembly.keys()])] : (args.ids ?? []);
  const restored = targets.filter((id) => {
    const wasEvicted = session.evicted.delete(id);
    const wasAssembled = session.assembly.delete(id);
    return wasEvicted || wasAssembled;
  });
  return ok({ restored, evicted_total: session.evicted.size });
}
