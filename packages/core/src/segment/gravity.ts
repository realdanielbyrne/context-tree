/**
 * GRAVITY — when anything folds, is summarized, is deleted, or comes back (D27).
 *
 * One pull, the same for every kind of block (reasoning, text, a tool call with its result):
 *
 *   d     = max(ε, (B − live) / B)        distance from the window, B = window − reserve
 *   e(u)  ∈ [0,1]                         irrelevance: 1 − the retention score, min-max over live units
 *   m(b)  = e(unit(b)) · raw(b) / B       a block's irrelevance mass
 *   M     = Σ m over live blocks          the context's irrelevance mass
 *   g(b)  = κ · M · m(b) / d²             the pull
 *
 * Folding, summarizing and deleting are BREAKPOINTS on g, each with a lower breakpoint for
 * the way back, so a block crosses back only when the pull has clearly fallen (the record
 * favours ejecting rarely and deeply over trimming a little every turn). Every rung recomputes
 * `live` after the previous one, so the well is self-limiting: folding raises d and every
 * other pull falls. What a fold SHOWS is per kind (`stubs.ts`); WHEN is not.
 *
 * Pure and deterministic: the caller supplies e, sizes and states; nothing here reads a trace.
 */
import type { BlockKind } from './blocks.js';

export const GRAVITY_EPSILON = 1e-3;

export type BlockFoldState = 'raw' | 'stub' | 'carrier' | 'covered';

export interface GravityBlock {
  readonly stub: number;
  readonly kind: BlockKind;
  readonly unit: string;
  /** Irrelevance of its unit, 0 (most relevant, or pinned) … 1. */
  readonly e: number;
  /** Tokens it would show raw. */
  readonly raw: number;
  /** Tokens it shows now. */
  readonly shown: number;
  readonly state: BlockFoldState;
  /** Tokens as a stub when `state` is raw and it can shrink; else null. */
  readonly residue: number | null;
  readonly pinned: boolean;
}

export interface GravitySummary {
  readonly id: string;
  /** Stub ids inside its range, in order. */
  readonly stubs: readonly number[];
}

export interface Breakpoints {
  readonly fold: number;
  readonly unfold: number;
  readonly summarize: number;
  readonly unsummarize: number;
}

export interface GravityInput {
  readonly budget: number;
  /** Everything the host sends of the live units now (folds, reductions and pins included). */
  readonly live: number;
  readonly kappa: number;
  readonly blocks: readonly GravityBlock[];
  readonly summaries: readonly GravitySummary[];
  readonly breakpoints: Breakpoints;
}

export interface GravityPlan {
  readonly unfolds: readonly number[];
  readonly folds: readonly number[];
  /** Runs of consecutive folded blocks to summarize: first and last stub id. */
  readonly summarize: readonly { readonly fromStub: number; readonly toStub: number }[];
  readonly unsummarize: readonly string[];
  readonly mass: number;
  readonly dBefore: number;
  readonly dAfter: number;
  readonly liveAfter: number;
}

export const distanceOf = (live: number, budget: number): number => Math.max(GRAVITY_EPSILON, (budget - live) / budget);

export const massOf = (e: number, raw: number, budget: number): number => (e * raw) / budget;

export const pullOf = (kappa: number, mass: number, m: number, d: number): number => (kappa * mass * m) / (d * d);

/** 1 − score, min-max over the live units; a pinned unit has none. A flat field is all-irrelevant-equally: 0. */
export function irrelevanceOf(scores: readonly number[], pinned: readonly boolean[]): number[] {
  let lo = Infinity;
  let hi = -Infinity;
  scores.forEach((s, i) => {
    if (pinned[i]) return;
    if (s < lo) lo = s;
    if (s > hi) hi = s;
  });
  const span = hi - lo;
  return scores.map((s, i) => (pinned[i] || !(span > 0) ? 0 : (hi - s) / span));
}

export function planGravity(input: GravityInput): GravityPlan {
  const { budget, kappa, breakpoints: bp } = input;
  const mass = input.blocks.reduce((n, b) => n + massOf(b.e, b.raw, budget), 0);
  const dBefore = distanceOf(input.live, budget);
  let live = input.live;
  const pull = (b: GravityBlock, at: number = live): number => pullOf(kappa, mass, massOf(b.e, b.raw, budget), distanceOf(at, budget));

  // Back first: what the well has released comes back before anything new is folded, and only
  // if it would not be pulled straight back out once its raw form is in.
  const unfolds: number[] = [];
  const stubs = input.blocks.filter((b) => b.state === 'stub' && !b.pinned).sort((a, b) => a.e * a.raw - b.e * b.raw || a.stub - b.stub);
  for (const b of stubs) {
    if (!(pull(b) < bp.unfold)) break;
    const after = live + (b.raw - b.shown);
    if (after > budget || !(pull(b, after) < bp.unfold)) continue;
    live = after;
    unfolds.push(b.stub);
  }

  const back = new Set(unfolds);
  // d is shared, so the order of pulls is the order of masses: sort once, stop at the first
  // block the (falling) pull no longer reaches.
  const folds: number[] = [];
  const raws = input.blocks
    .filter((b) => b.state === 'raw' && !back.has(b.stub) && !b.pinned && b.residue !== null && b.residue < b.shown)
    .sort((a, b) => b.e * b.raw - a.e * a.raw || a.stub - b.stub);
  for (const b of raws) {
    if (!(pull(b) > 0 && pull(b) >= bp.fold)) break;
    folds.push(b.stub);
    live -= b.shown - b.residue!;
  }

  const folded = new Set([...input.blocks.filter((b) => b.state === 'stub' && !back.has(b.stub)).map((b) => b.stub), ...folds]);
  const covered = new Set(input.summaries.flatMap((s) => s.stubs));
  const summarize: { fromStub: number; toStub: number }[] = [];
  let run: GravityBlock[] = [];
  const close = (): void => {
    if (run.length >= 2) summarize.push({ fromStub: run[0]!.stub, toStub: run[run.length - 1]!.stub });
    run = [];
  };
  for (const b of input.blocks) {
    if (folded.has(b.stub) && !covered.has(b.stub) && !b.pinned && pull(b) > 0 && pull(b) >= bp.summarize) run.push(b);
    else close();
  }
  close();

  const byStub = new Map(input.blocks.map((b) => [b.stub, b]));
  const unsummarize = input.summaries
    .filter((s) => {
      const inside = s.stubs.map((id) => byStub.get(id)).filter((b): b is GravityBlock => b !== undefined);
      return inside.length > 0 && inside.every((b) => pull(b) < bp.unsummarize);
    })
    .map((s) => s.id);

  return { unfolds, folds, summarize, unsummarize, mass, dBefore, dAfter: distanceOf(live, budget), liveAfter: live };
}

export interface GravityUnit {
  readonly id: string;
  readonly e: number;
  readonly raw: number;
  readonly shown: number;
  readonly pinned: boolean;
}

export interface DeletePlan {
  readonly deleted: readonly string[];
  readonly liveAfter: number;
  readonly dAfter: number;
}

/**
 * The delete rung: a unit goes once its whole pull, κ·M·m(u)/d² with m(u) = e·raw(u)/B,
 * reaches `gDelete`, most pulled first, `live` recomputed after each. The ceiling is the
 * caller's (`planRetention`, the fit guarantee), run after this on what remains.
 */
export function planDeletions(units: readonly GravityUnit[], input: { budget: number; live: number; kappa: number; mass: number; gDelete: number }): DeletePlan {
  const { budget, kappa, mass, gDelete } = input;
  let live = input.live;
  const pull = (u: GravityUnit): number => pullOf(kappa, mass, massOf(u.e, u.raw, budget), distanceOf(live, budget));
  const deleted: string[] = [];
  const open = units.filter((u) => !u.pinned && u.shown > 0).sort((a, b) => b.e * b.raw - a.e * a.raw);
  for (const u of open) {
    if (!(pull(u) > 0 && pull(u) >= gDelete)) break;
    deleted.push(u.id);
    live -= u.shown;
  }
  return { deleted, liveAfter: live, dAfter: distanceOf(live, budget) };
}

export interface KappaSignals {
  /** The model reached for what it lacks: a recall call, a repeated identical call, a read of something folded away. */
  readonly starvation: number;
  /** Our own churn: a block folded and unfolded within the repeat window. */
  readonly thrash: number;
  /** A turn that needed the fit guarantee. */
  readonly overflow: number;
}

/** κ ← κ · exp(η · (overflow − starvation − thrash)), each signal counted once per turn, bounded. */
export function adaptKappa(kappa: number, s: KappaSignals, p: { eta: number; min: number; max: number }): number {
  const step = (s.overflow > 0 ? 1 : 0) - (s.starvation > 0 ? 1 : 0) - (s.thrash > 0 ? 1 : 0);
  return Math.min(p.max, Math.max(p.min, kappa * Math.exp(p.eta * step)));
}
