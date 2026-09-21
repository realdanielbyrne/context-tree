/**
 * The retention ruling — ONE decision about every unit, made in one place.
 *
 * What used to be three decisions in three places (an eviction plan, a reducer the
 * host never saw, and protected-message rules in the host adapter) is a ladder:
 *
 *   keep → reduce → fold → drop
 *
 * A unit moves down it only as far as the budget requires. Reduction runs first and
 * lowest-score-first, because it loses the least (principle 3: err toward MORE
 * context); only if the units still do not fit are whole units removed, by the same
 * score-priority packing `planEviction` uses.
 *
 * PROTECTION IS A SCORE, NOT A WALL. The recency anchor is a bonus that decays with a
 * unit's distance from the newest; a protected unit is touched only when the budget
 * cannot be met without it. `protection: 'hard'` restores the absolute anchor, under
 * which — with reduction off — this is `planEviction` exactly.
 */
import type { Tokenizer } from '../contracts/index.js';
import type { ChunkOptions } from '../retrieve/chunk.js';
import { scoreUnits, type EvictionSignals, type EvictionWeights } from './eviction.js';
import { resolveReducer, type ReducerName } from './reduce.js';

export type Disposition =
  | { readonly kind: 'keep' }
  | { readonly kind: 'reduce'; readonly tokens: number; readonly text: string }
  | { readonly kind: 'fold'; readonly tokens: number; readonly text: string }
  | { readonly kind: 'drop' };

export const KEEP: Disposition = Object.freeze({ kind: 'keep' });
export const DROP: Disposition = Object.freeze({ kind: 'drop' });

export type ProtectionMode = 'soft' | 'hard';

export interface RetentionUnit {
  readonly id: string;
  readonly tokens: number;
  readonly raw: string;
  /** What this unit folds to instead of vanishing — its phase's summary, offered once per phase. */
  readonly foldText?: string;
  readonly signals: EvictionSignals;
  /**
   * Removing it breaks the REQUEST, not the policy: the task statement (a chat template
   * rejects a prompt with no user message) and the newest message. Never degraded.
   */
  readonly pinned: boolean;
  /** 0 = unprotected … 1 = the newest anchored unit. */
  readonly protection: number;
  /** 0–1 rank among the retrieval hits for the current query; enters the score only when `weights.relevance > 0`. */
  readonly relevance: number;
}

export interface RetentionParams {
  readonly budgetTokens: number;
  readonly headroomTokens: number;
  readonly weights: EvictionWeights & { readonly relevance: number };
  readonly protection: ProtectionMode;
  /** Added to an anchored unit's score, scaled by its `protection`. */
  readonly protectionBonus: number;
  /** `null` turns the reduce step off. */
  readonly reducer: ReducerName | null;
  /** Only a unit at least this large is worth reducing. */
  readonly reduceMinTokens: number;
  /** A reduced unit's target size, as a fraction of its own. */
  readonly reduceFrac: number;
  readonly tokenizer: Tokenizer;
  readonly query?: string;
  readonly chunkOptions?: ChunkOptions;
  readonly rrfK?: number;
}

export interface RetentionPlan {
  /** False when everything already fit: nothing was decided and nothing changes. */
  readonly fired: boolean;
  readonly dispositions: ReadonlyMap<string, Disposition>;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  /** True when even the pinned units exceed the budget — the caller has an overflow no policy can fix. */
  readonly overBudget: boolean;
}

export const tokensUnder = (unit: RetentionUnit, disposition: Disposition): number => {
  switch (disposition.kind) {
    case 'keep': return unit.tokens;
    case 'reduce':
    case 'fold': return disposition.tokens;
    case 'drop': return 0;
  }
};

export function planRetention(units: readonly RetentionUnit[], params: RetentionParams): RetentionPlan {
  const dispositions = new Map<string, Disposition>(units.map((u) => [u.id, KEEP]));
  const tokensBefore = units.reduce((n, u) => n + u.tokens, 0);
  const total = (): number => units.reduce((n, u) => n + tokensUnder(u, dispositions.get(u.id) ?? KEEP), 0);
  if (tokensBefore <= params.budgetTokens) {
    return { fired: false, dispositions, tokensBefore, tokensAfter: tokensBefore, overBudget: false };
  }
  const target = Math.max(0, params.budgetTokens - params.headroomTokens);

  const hardWalled = (u: RetentionUnit): boolean => params.protection === 'hard' && u.protection > 0;
  const candidates = units.filter((u) => !u.pinned && !hardWalled(u));
  const base = scoreUnits(candidates.map((u) => u.signals), params.weights);
  const scored = candidates
    .map((unit, i) => ({
      unit,
      score:
        base[i]! +
        params.weights.relevance * unit.relevance +
        (params.protection === 'soft' ? params.protectionBonus * unit.protection : 0),
    }))
    .sort((a, b) => a.score - b.score);

  // ── reduce: lowest score first, until the units fit ─────────────────────────
  if (params.reducer !== null) {
    const reduce = resolveReducer(params.reducer);
    for (const { unit } of scored) {
      if (total() <= target) break;
      if (unit.tokens < params.reduceMinTokens) continue;
      const budgetTokens = Math.max(1, Math.floor(unit.tokens * params.reduceFrac));
      const text = reduce(
        { raw: unit.raw, ...(unit.foldText !== undefined ? { summary: unit.foldText } : {}) },
        { budgetTokens, tokenizer: params.tokenizer, query: params.query, chunkOptions: params.chunkOptions, rrfK: params.rrfK },
      );
      const tokens = params.tokenizer.count(text);
      if (tokens < unit.tokens) dispositions.set(unit.id, { kind: 'reduce', tokens, text });
    }
  }

  // ── remove: score-priority packing (as `planEviction`), over what reduction left ─
  if (total() > target) {
    const fixed = units.filter((u) => u.pinned || hardWalled(u)).reduce((n, u) => n + u.tokens, 0);
    let used = fixed;
    for (const { unit } of [...scored].reverse()) {
      const size = tokensUnder(unit, dispositions.get(unit.id) ?? KEEP);
      if (used + size <= target) {
        used += size;
        continue;
      }
      const folded = unit.foldText !== undefined ? params.tokenizer.count(unit.foldText) : Infinity;
      if (unit.foldText !== undefined && used + folded <= target) {
        dispositions.set(unit.id, { kind: 'fold', tokens: folded, text: unit.foldText });
        used += folded;
      } else {
        dispositions.set(unit.id, DROP);
      }
    }
  }

  const tokensAfter = total();
  return { fired: true, dispositions, tokensBefore, tokensAfter, overBudget: tokensAfter > target };
}
