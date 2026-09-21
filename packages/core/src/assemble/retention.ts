/**
 * EVICTION — the removal ruling. It runs AFTER assembly (`represent.ts`), takes what
 * assembly produced as its input, and may overrule it: a unit assembly chose to keep,
 * reduce or fold can still be dropped here. It never chooses a representation — that is
 * assembly's rule, and the two are kept apart on purpose so either can change alone.
 *
 * Units are sized AS ASSEMBLED, so a unit assembly reduced competes at its reduced size.
 * Removal is the score-priority packing `planEviction` uses.
 *
 * PROTECTION IS A SCORE, NOT A WALL. The recency anchor is a bonus that decays with a
 * unit's distance from the newest; a protected unit is removed only when the budget
 * cannot be met without it. `protection: 'hard'` restores the absolute anchor, under
 * which this is `planEviction` exactly.
 */
import { scoreUnits, type EvictionSignals, type EvictionWeights } from './eviction.js';

export type ProtectionMode = 'soft' | 'hard';

export interface RetentionUnit {
  readonly id: string;
  /** Its size AS ASSEMBLED — raw, reduced or folded. */
  readonly tokens: number;
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
}

export interface RetentionPlan {
  /** False when everything already fit: nothing was decided and nothing changes. */
  readonly fired: boolean;
  /** Ids to remove, in creation order. */
  readonly dropped: readonly string[];
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  /** True when even the pinned units exceed the budget — the caller has an overflow no policy can fix. */
  readonly overBudget: boolean;
}

export function planRetention(units: readonly RetentionUnit[], params: RetentionParams): RetentionPlan {
  const tokensBefore = units.reduce((n, u) => n + u.tokens, 0);
  if (tokensBefore <= params.budgetTokens) {
    return { fired: false, dropped: [], tokensBefore, tokensAfter: tokensBefore, overBudget: false };
  }
  const target = Math.max(0, params.budgetTokens - params.headroomTokens);

  const walled = (u: RetentionUnit): boolean => u.pinned || (params.protection === 'hard' && u.protection > 0);
  const candidates = units.filter((u) => !walled(u));
  const base = scoreUnits(candidates.map((u) => u.signals), params.weights);
  const byScore = candidates
    .map((unit, i) => ({
      unit,
      score:
        base[i]! +
        params.weights.relevance * unit.relevance +
        (params.protection === 'soft' ? params.protectionBonus * unit.protection : 0),
    }))
    .sort((a, b) => b.score - a.score);

  let used = units.filter(walled).reduce((n, u) => n + u.tokens, 0);
  const removed = new Set<string>();
  for (const { unit } of byScore) {
    if (used + unit.tokens <= target) used += unit.tokens;
    else removed.add(unit.id);
  }
  return {
    fired: true,
    dropped: units.filter((u) => removed.has(u.id)).map((u) => u.id),
    tokensBefore,
    tokensAfter: used,
    overBudget: used > target,
  };
}
