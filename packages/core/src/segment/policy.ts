/**
 * FOLD POLICY — what makes a block fold. This is the research variable: nobody knows the
 * best rule yet, so the rule is a parameter, and each candidate lives here behind one
 * interface. Folding is the FIRST step of the compression ladder (fold → summarize →
 * delete); the assembler requests summaries and `evict` deletes, neither is decided here.
 *
 *   none       nothing folds (today's `soft`: eviction without a visible trace)
 *   pressure   over `foldStubAt`·budget, fold the lowest-scored blocks until the prompt
 *              fits. Pressure stands in for "less relevant to what is being discussed now":
 *              the score ranks, the budget decides how far down the ranking to go
 *   cadence    the pressure rule, but only every `cadenceN` turns (DV3: N=25 was +33.5%
 *              cheaper than every turn, N=1 −183% — the cost lever)
 *
 * Independently of the trigger, `foldReasoningAfter = K` folds the reasoning of every turn
 * older than the newest K — the cheapest loss there is (deliberation, not observation) and
 * a third of the prompt, so it is testable on its own (the `think` arm).
 *
 * Within a turn, blocks fold in the order reasoning → tool → text: what it thought, what it
 * saw, what it said. Protection is the turn's: a block in the anchor or a pinned turn stays.
 */
import type { BlockKind } from './blocks.js';

export type FoldTrigger = 'none' | 'pressure' | 'cadence';

export interface FoldCandidate {
  readonly stub: number;
  readonly kind: BlockKind;
  /** 0 = the newest turn. */
  readonly turnsFromNewest: number;
  /** The turn's retention score: higher = keep. */
  readonly score: number;
  /** Tokens it shows now. */
  readonly tokens: number;
  /** Tokens it would show as a stub; `null` when it is already folded, covered, or cannot shrink. */
  readonly residue: number | null;
  readonly pinned: boolean;
}

export interface FoldPolicyParams {
  readonly trigger: FoldTrigger;
  readonly budgetTokens: number;
  readonly foldStubAt: number;
  readonly cadenceN: number;
  readonly turn: number;
  readonly anchor: number;
  readonly foldReasoningAfter: number;
}

export interface FoldPlan {
  /** Stub ids to fold, in the order chosen. */
  readonly stubs: readonly number[];
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly fired: boolean;
}

const KIND_ORDER: Record<BlockKind, number> = { reasoning: 0, tool: 1, text: 2 };

export function planFolds(candidates: readonly FoldCandidate[], params: FoldPolicyParams): FoldPlan {
  const tokensBefore = candidates.reduce((n, c) => n + c.tokens, 0);
  let live = tokensBefore;
  const chosen: number[] = [];
  const foldable = (c: FoldCandidate): boolean => c.residue !== null && c.residue < c.tokens && !c.pinned;

  if (params.foldReasoningAfter > 0) {
    for (const c of candidates) {
      if (c.kind === 'reasoning' && c.turnsFromNewest >= params.foldReasoningAfter && foldable(c)) {
        chosen.push(c.stub);
        live -= c.tokens - (c.residue ?? 0);
      }
    }
  }

  const due = params.trigger === 'pressure' || (params.trigger === 'cadence' && params.cadenceN > 0 && params.turn % params.cadenceN === 0);
  const target = params.foldStubAt * params.budgetTokens;
  if (due && live > target) {
    const picked = new Set(chosen);
    const order = candidates
      .filter((c) => foldable(c) && !picked.has(c.stub) && c.turnsFromNewest >= params.anchor)
      .sort((a, b) => a.score - b.score || b.turnsFromNewest - a.turnsFromNewest || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
    for (const c of order) {
      if (live <= target) break;
      chosen.push(c.stub);
      live -= c.tokens - (c.residue ?? 0);
    }
  }
  return { stubs: chosen, tokensBefore, tokensAfter: live, fired: chosen.length > 0 };
}
