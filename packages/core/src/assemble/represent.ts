/**
 * ASSEMBLY — how each unit is represented. It removes nothing; removal is eviction
 * (`retention.ts`), which runs afterwards on what this produces and may overrule it.
 *
 * Two rules, both from the spec (`reports/algorithm.md`):
 *   fold     a CLOSED phase that lies wholly outside the recency anchor and has a summary
 *            is represented by that summary: its first TEXT-ONLY unit carries the text, the
 *            rest are covered by it. A phase with no such unit cannot be folded and stays as
 *            it is — reported, never silently dropped to nothing.
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
  /**
   * Evicted, but still visible: the unit keeps its own text and its tool calls, loses its
   * reasoning, and each tool output becomes a tag naming what it was and how to recall it.
   * Eviction's first step; `drop` is its last.
   */
  | { readonly kind: 'stub'; readonly tokens: number }
  /** `covered`: a sibling's fold stands in for it. `evicted`: the removal ruling took it. */
  | { readonly kind: 'drop'; readonly why: 'covered' | 'evicted' };

export const KEEP: Disposition = Object.freeze({ kind: 'keep' });

export interface AssembleUnit {
  readonly id: string;
  readonly tokens: number;
  readonly raw: string;
  readonly pinned: boolean;
  /**
   * Has no tool call. Only such a unit can CARRY a fold: a host keeps a call and its result
   * in one message, so a message with tool parts is keep-or-drop and cannot become a summary.
   */
  readonly textOnly: boolean;
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
    case 'fold':
    case 'stub': return disposition.tokens;
    case 'drop': return 0;
  }
};

export interface Assembly {
  readonly dispositions: Map<string, Disposition>;
  /** Groups that qualified for a fold but have no text-only unit to carry it. */
  readonly unfoldable: readonly string[];
}

export function representUnits(units: readonly AssembleUnit[], params: AssembleParams): Assembly {
  const unfoldable: string[] = [];
  const out = new Map<string, Disposition>(units.map((u) => [u.id, KEEP]));
  const anchorFrom = Math.max(0, units.length - params.anchor);

  if (params.summaries) {
    const groups = new Map<string, number[]>();
    // A pinned member stays raw and stays out of the fold; it does not stop its phase folding.
    units.forEach((u, i) => { if (u.group !== undefined && !u.pinned) groups.set(u.group.id, [...(groups.get(u.group.id) ?? []), i]); });
    for (const members of groups.values()) {
      const group = units[members[0]!]!.group!;
      const foldable = group.closed && group.summary !== undefined && members.every((i) => i < anchorFrom);
      if (!foldable) continue;
      const carrier = members.find((i) => units[i]!.textOnly);
      if (carrier === undefined) {
        unfoldable.push(group.id);
        continue;
      }
      for (const i of members) {
        out.set(units[i]!.id, i === carrier
          ? { kind: 'fold', tokens: params.tokenizer.count(group.summary!), text: group.summary! }
          : { kind: 'drop', why: 'covered' });
      }
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
  return { dispositions: out, unfoldable };
}
