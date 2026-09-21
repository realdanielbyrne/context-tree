/**
 * `context_evict` / `context_restore` — stage 2, and the only tools that change
 * what the next prompt contains.
 *
 * Eviction is STICKY. `context_evict` runs the settled policy (`assembleFlex`: D-EV
 * score, recency anchor, fire only when the limit binds) over the units still live
 * and adds what it removes to the session's evicted set; nothing comes back until
 * `context_restore`.
 *
 * It budgets on RAW unit size, with reduce-on-overflow and summary folding switched
 * off. The assembler can shrink a unit in its own rendering, but a host's messages
 * are keep-or-drop: a unit counted at its reduced size would still arrive whole, and
 * the limit would be met on paper only.
 *
 * So a caller's policy is simply WHEN it calls: every turn, every
 * Nth turn, only above some size, or never. Not calling is a no-op on the prompt —
 * which is what keeps a cadence from rewriting the cached prefix on its off turns.
 */
import { z } from 'zod';
import { assembleFlex, type NodeId } from '@context-tree/core';
import { fail, failFrom, ok, parseArgs } from '../result.js';
import { advanceTurn, sessionOf, sessionUnits } from '../session.js';
import type { ToolContext, ToolOutcome } from '../types.js';
import { budgetShape, flexOptions, turnArg } from './pipeline-args.js';

export const CONTEXT_EVICT = 'context_evict';
export const CONTEXT_RESTORE = 'context_restore';

export const CONTEXT_EVICT_DESCRIPTION =
  'Remove the least valuable units from your working context so it fits window_tokens. Units stay ' +
  'evicted until context_restore; their content is never lost and context_fetch still returns it. Reach ' +
  'for it when your context is large and earlier phases no longer bear on what you are doing. Use ' +
  'dry_run to see what would go without removing it.';

export const CONTEXT_RESTORE_DESCRIPTION =
  'Bring evicted units back into your working context, by id or all at once. Reach for it when work you ' +
  'set aside has become relevant again and you want it present on every turn rather than fetched once.';

const evictShape = {
  ...budgetShape,
  dry_run: z.boolean().optional().describe('Report what would be evicted; change nothing.'),
  turn: turnArg,
};
export const contextEvictSchema = z.object(evictShape);
export const contextEvictInputShape = evictShape;

const restoreShape = {
  node_ids: z.array(z.string().min(1)).optional().describe('Units to restore.'),
  all: z.boolean().optional().describe('Restore every evicted unit.'),
};
export const contextRestoreSchema = z.object(restoreShape);
export const contextRestoreInputShape = restoreShape;

export interface ContextEvictData {
  turn: number;
  applied: boolean;
  /** False when the live units already fit: the policy declined to evict anything. */
  fired: boolean;
  evicted: NodeId[];
  live_units: number;
  live_tokens_before: number;
  live_tokens_after: number;
  evicted_total: number;
}

export async function contextEvict(ctx: ToolContext, input: unknown): Promise<ToolOutcome<ContextEvictData>> {
  const parsed = parseArgs(contextEvictSchema, input);
  if (!parsed.ok) return parsed;
  const args = parsed.data;
  if ((args.reserve_tokens ?? 0) >= args.window_tokens) {
    return fail('invalid_input', `reserve_tokens (${String(args.reserve_tokens)}) leaves no room in window_tokens (${String(args.window_tokens)})`);
  }
  try {
    const session = sessionOf(ctx);
    const turn = advanceTurn(session, args.turn);
    const { units } = await sessionUnits(ctx);
    const live = units.filter((u) => !session.evicted.has(u.node.id));
    const before = live.reduce((n, u) => n + u.tokens, 0);
    const prompt = assembleFlex(
      { system: '', userPrompts: [] },
      live.map(({ unit: { summary: _summary, ...raw } }) => raw),
      session.tokenizer,
      { ...flexOptions(session, args), softTargetFrac: 0 },
    );
    const evicted = prompt.budgets.evicted;
    const gone = new Set<NodeId>(evicted);
    const applied = args.dry_run !== true;
    if (applied) for (const id of evicted) session.evicted.add(id);
    return ok({
      turn,
      applied,
      fired: evicted.length > 0,
      evicted,
      live_units: live.length - evicted.length,
      live_tokens_before: before,
      live_tokens_after: live.filter((u) => !gone.has(u.node.id)).reduce((n, u) => n + u.tokens, 0),
      evicted_total: session.evicted.size,
    });
  } catch (error) {
    return failFrom(error);
  }
}

export interface ContextRestoreData {
  restored: NodeId[];
  evicted_total: number;
}

export async function contextRestore(ctx: ToolContext, input: unknown): Promise<ToolOutcome<ContextRestoreData>> {
  const parsed = parseArgs(contextRestoreSchema, input);
  if (!parsed.ok) return parsed;
  const args = parsed.data;
  if (args.all !== true && (args.node_ids === undefined || args.node_ids.length === 0)) {
    return fail('invalid_input', 'give node_ids, or all: true');
  }
  const session = sessionOf(ctx);
  const targets = args.all === true ? [...session.evicted] : (args.node_ids as NodeId[]);
  const restored = targets.filter((id) => session.evicted.delete(id));
  return ok({ restored, evicted_total: session.evicted.size });
}
