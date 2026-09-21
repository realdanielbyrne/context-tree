/**
 * ASSEMBLY — how each unit is represented. It removes nothing; removal is eviction
 * (`retention.ts`), which runs afterwards on what this produces and may overrule it.
 *
 * Two rules, both from the spec (`reports/algorithm.md`):
 *   fold     a CLOSED phase that lies wholly outside the recency anchor and has a summary
 *            is represented by that summary: its first unit carries the text, the rest
 *            are covered by it.
 *   reduce   a raw unit larger than the per-unit budget `b` is shrunk to `b`
 *            (reduce-on-overflow). `b = (f·W − reserve) ÷ (A + 1)`.
 *
 * A pinned unit — one whose loss breaks the request — is always raw.
 */
import type { Tokenizer } from '../contracts/index.js';
import type { ChunkOptions } from '../retrieve/chunk.js';
import { resolveReducer, type ReducerName } from './reduce.js';

export type Disposition =
  | { readonly kind: 'keep' }
  | { readonly kind: 'reduce'; readonly tokens: number; readonly text: string }
  | { readonly kind: 'fold'; readonly tokens: number; readonly text: string }
  /** `covered`: a sibling's fold stands in for it. `evicted`: the removal ruling took it. */
  | { readonly kind: 'drop'; readonly why: 'covered' | 'evicted' };

export const KEEP: Disposition = Object.freeze({ kind: 'keep' });

export interface AssembleUnit {
  readonly id: string;
  readonly tokens: number;
  readonly raw: string;
  readonly pinned: boolean;
  /** Groups units for folding; a unit with no `group` is never folded. */
  readonly group?: { readonly id: string; readonly closed: boolean; readonly summary?: string };
}

export interface AssembleParams {
  readonly windowTokens: number;
  readonly reserveTokens: number;
  readonly anchor: number;
  readonly softTargetFrac: number;
  readonly summaries: boolean;
  /** `null` turns reduce-on-overflow off. */
  readonly reducer: ReducerName | null;
  readonly tokenizer: Tokenizer;
  readonly query?: string;
  readonly chunkOptions?: ChunkOptions;
  readonly rrfK?: number;
}

export const perUnitBudget = (p: Pick<AssembleParams, 'windowTokens' | 'reserveTokens' | 'anchor' | 'softTargetFrac'>): number =>
  Math.max(0, Math.floor((p.softTargetFrac * p.windowTokens - p.reserveTokens) / (p.anchor + 1)));

export const tokensUnder = (unit: { readonly tokens: number }, disposition: Disposition): number => {
  switch (disposition.kind) {
    case 'keep': return unit.tokens;
    case 'reduce':
    case 'fold': return disposition.tokens;
    case 'drop': return 0;
  }
};

export function representUnits(units: readonly AssembleUnit[], params: AssembleParams): Map<string, Disposition> {
  const out = new Map<string, Disposition>(units.map((u) => [u.id, KEEP]));
  const anchorFrom = Math.max(0, units.length - params.anchor);

  if (params.summaries) {
    const groups = new Map<string, number[]>();
    units.forEach((u, i) => { if (u.group !== undefined) groups.set(u.group.id, [...(groups.get(u.group.id) ?? []), i]); });
    for (const members of groups.values()) {
      const group = units[members[0]!]!.group!;
      const foldable = group.closed && group.summary !== undefined && members.every((i) => i < anchorFrom && !units[i]!.pinned);
      if (!foldable) continue;
      members.forEach((i, n) => {
        out.set(units[i]!.id, n === 0
          ? { kind: 'fold', tokens: params.tokenizer.count(group.summary!), text: group.summary! }
          : { kind: 'drop', why: 'covered' });
      });
    }
  }

  const budgetTokens = perUnitBudget(params);
  if (params.reducer !== null && budgetTokens > 0) {
    const reduce = resolveReducer(params.reducer);
    for (const unit of units) {
      if (unit.pinned || out.get(unit.id)?.kind !== 'keep' || unit.tokens <= budgetTokens) continue;
      const text = reduce(
        { raw: unit.raw, ...(unit.group?.summary !== undefined ? { summary: unit.group.summary } : {}) },
        { budgetTokens, tokenizer: params.tokenizer, query: params.query, chunkOptions: params.chunkOptions, rrfK: params.rrfK },
      );
      const tokens = params.tokenizer.count(text);
      if (tokens < unit.tokens) out.set(unit.id, { kind: 'reduce', tokens, text });
    }
  }
  return out;
}
