/**
 * Arguments the pipeline tools share. Each is optional and falls back to the
 * server's `PipelineDefaults`; each exists because its default in core is
 * PROVISIONAL — never swept — so a caller must be able to vary it without a rebuild.
 */
import { z } from 'zod';
import type { FlexAssembleOptions } from '@context-tree/core';
import type { Session } from '../session.js';

export const turnArg = z
  .number()
  .int()
  .nonnegative()
  .optional()
  .describe("The host's turn number. Moves the session clock forward; omit to use the current one.");

export const budgetShape = {
  window_tokens: z
    .number()
    .positive()
    .describe('The limit to fit, in HEURISTIC tokens (core HeuristicTokenizer — not the served tokenizer).'),
  reserve_tokens: z
    .number()
    .nonnegative()
    .optional()
    .describe('Held back from the window for the reply and for whatever the caller cannot see (system block, tool schemas). Default 0.'),
  anchor: z.number().int().nonnegative().optional().describe('Recency anchor A: the last A units are never evictable.'),
  weights: z
    .object({
      priority: z.number().optional(),
      recency: z.number().optional(),
      refRecency: z.number().optional(),
      dormancy: z.number().optional(),
    })
    .optional()
    .describe('Eviction score weights. Higher score = keep.'),
  half_life: z.number().positive().optional().describe('Priority-decay half-life, in turns.'),
  headroom_tokens: z.number().nonnegative().optional().describe('Extra tokens to free beyond the limit when eviction fires.'),
};

/** What only the LAYOUT uses: how an oversized unit is shrunk in place, and against what query. */
export const layoutShape = {
  soft_target_frac: z.number().min(0).max(1).optional().describe('Sizes the reduce-on-overflow per-unit budget.'),
  reducer: z.enum(['chunk', 'summarize']).optional(),
  query: z.string().optional().describe('The current task or question; ranks chunks when a unit is reduced.'),
};

export type BudgetArgs = z.infer<z.ZodObject<typeof budgetShape>> & Partial<z.infer<z.ZodObject<typeof layoutShape>>>;

export function flexOptions(session: Session, args: BudgetArgs): FlexAssembleOptions {
  const p = session.pipeline;
  return {
    window: args.window_tokens,
    replyReserve: args.reserve_tokens ?? 0,
    anchor: args.anchor ?? p.anchor,
    weights: { ...p.weights, ...stripUndefined(args.weights ?? {}) },
    priorityHalfLife: args.half_life ?? p.priorityHalfLife,
    evictHeadroomTokens: args.headroom_tokens ?? p.evictHeadroomTokens,
    softTargetFrac: args.soft_target_frac ?? p.softTargetFrac,
    reducer: args.reducer ?? p.reducer,
    chunkOptions: { chunkSize: p.chunkSize, chunkOverlap: p.chunkOverlap },
    rrfK: p.rrfK,
    currentTurn: session.turn,
    ...(args.query !== undefined ? { query: args.query } : {}),
  };
}

function stripUndefined<T extends object>(o: T): Partial<{ [K in keyof T]: NonNullable<T[K]> }> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as never;
}
