/**
 * `context_reduce` — reduce-on-overflow as a call. One unit, shrunk to a budget by
 * the named reducer. It returns text and changes nothing: what a caller does with a
 * reduced unit (show it, fold a message to it) is the caller's decision.
 */
import { z } from 'zod';
import { resolveReducer, type NodeId, type ReducerName } from '@context-tree/core';
import { failFrom, ok, parseArgs, requireNode } from '../result.js';
import { sessionOf, sessionUnits } from '../session.js';
import type { ToolContext, ToolOutcome } from '../types.js';

export const CONTEXT_REDUCE = 'context_reduce';

export const CONTEXT_REDUCE_DESCRIPTION =
  'Shrink one unit to budget_tokens: "chunk" keeps the spans most relevant to query and marks the gaps, ' +
  '"summarize" returns its summary. Reach for it when a single phase is too large to keep whole but you ' +
  'still need its substance, and a full context_fetch would cost more than you want to spend.';

const shape = {
  node_id: z.string().min(1).describe('The unit to reduce, from context_units or a context_search hit.'),
  budget_tokens: z.number().positive().describe('Target size in heuristic tokens.'),
  reducer: z.enum(['chunk', 'summarize']).optional(),
  query: z.string().optional().describe('Ranks the spans "chunk" keeps. Omit to keep the leading spans.'),
};
export const contextReduceSchema = z.object(shape);
export const contextReduceInputShape = shape;

export interface ContextReduceData {
  node_id: NodeId;
  reducer: ReducerName;
  original_tokens: number;
  tokens: number;
  text: string;
}

export async function contextReduce(ctx: ToolContext, input: unknown): Promise<ToolOutcome<ContextReduceData>> {
  const parsed = parseArgs(contextReduceSchema, input);
  if (!parsed.ok) return parsed;
  const args = parsed.data;
  const found = requireNode(ctx, 'node_id', args.node_id as NodeId);
  if (!found.ok) return found;
  try {
    const session = sessionOf(ctx);
    const { units } = await sessionUnits(ctx);
    const unit = units.find((u) => u.node.id === found.data.id);
    if (unit === undefined) {
      return { ok: false, error: { code: 'unknown_node', message: `node_id ${JSON.stringify(args.node_id)} is not a unit (a work phase). context_units lists them.` } };
    }
    const p = session.pipeline;
    const reducer = args.reducer ?? p.reducer;
    const text = resolveReducer(reducer)(
      { raw: unit.unit.raw, ...(unit.unit.summary !== undefined ? { summary: unit.unit.summary } : {}) },
      {
        budgetTokens: args.budget_tokens,
        tokenizer: session.tokenizer,
        ...(args.query !== undefined ? { query: args.query } : {}),
        chunkOptions: { chunkSize: p.chunkSize, chunkOverlap: p.chunkOverlap },
        rrfK: p.rrfK,
      },
    );
    return ok({ node_id: unit.node.id, reducer, original_tokens: unit.tokens, tokens: session.tokenizer.count(text), text });
  } catch (error) {
    return failFrom(error);
  }
}
