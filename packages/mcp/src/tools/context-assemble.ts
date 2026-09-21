/**
 * `context_assemble` — the whole pipeline in one call, for a caller that wants the
 * composed answer rather than the stages: classify, evict, reduce and lay out, plus
 * the retrieval tail. STATELESS — it reports what the assembler would build over the
 * live units and changes nothing; `context_evict` is the call that commits.
 */
import { z } from 'zod';
import { assembleFlex, ensembleRetrieve, type NodeId } from '@context-tree/core';
import { fail, failFrom, ok, parseArgs } from '../result.js';
import { advanceTurn, sessionOf, sessionUnits } from '../session.js';
import type { ToolContext, ToolOutcome } from '../types.js';
import { budgetShape, flexOptions, layoutShape, turnArg } from './pipeline-args.js';

export const CONTEXT_ASSEMBLE = 'context_assemble';

export const CONTEXT_ASSEMBLE_DESCRIPTION =
  'Report the prompt the assembler would build for window_tokens: which units stay raw, which fold to ' +
  'summaries, which are evicted or reduced, what retrieval appends, and the token budget of each zone. ' +
  'Changes nothing. Reach for it when you want to see the consequence of a limit before committing to it ' +
  'with context_evict.';

const shape = {
  ...budgetShape,
  ...layoutShape,
  top_k: z.number().int().nonnegative().optional().describe('Retrieval hits appended as the tail (needs query). Default 0.'),
  include_text: z.boolean().optional().describe('Return block text as well as sizes.'),
  turn: turnArg,
};
export const contextAssembleSchema = z.object(shape);
export const contextAssembleInputShape = shape;

export interface ContextAssembleData {
  turn: number;
  budgets: { head: number; flex: number; tail: number; total: number; window: number; over_window: boolean };
  evicted: NodeId[];
  reduced: NodeId[];
  cache_breakpoints: string[];
  blocks: { zone: string; id: string; node_id: NodeId | null; tokens: number; text?: string }[];
}

export async function contextAssemble(ctx: ToolContext, input: unknown): Promise<ToolOutcome<ContextAssembleData>> {
  const parsed = parseArgs(contextAssembleSchema, input);
  if (!parsed.ok) return parsed;
  const args = parsed.data;
  if ((args.reserve_tokens ?? 0) >= args.window_tokens) {
    return fail('invalid_input', `reserve_tokens (${String(args.reserve_tokens)}) leaves no room in window_tokens (${String(args.window_tokens)})`);
  }
  try {
    const session = sessionOf(ctx);
    const turn = advanceTurn(session, args.turn);
    const { units, corpus } = await sessionUnits(ctx);
    const live = units.filter((u) => !session.evicted.has(u.node.id));
    const liveIds = new Set<string>(live.map((u) => u.node.id));
    let tail: { id: string; text: string }[] = [];
    if (args.query !== undefined && (args.top_k ?? 0) > 0) {
      const hits = await ensembleRetrieve(args.query, corpus.filter((c) => liveIds.has(c.id)), undefined, {
        topK: args.top_k,
        rrfK: session.pipeline.rrfK,
        chunk: { chunkSize: session.pipeline.chunkSize, chunkOverlap: session.pipeline.chunkOverlap },
      });
      tail = hits.map((h) => ({ id: h.unitId, text: h.excerpt }));
    }
    const prompt = assembleFlex({ system: '', userPrompts: [] }, live.map((u) => u.unit), session.tokenizer, {
      ...flexOptions(session, args),
      tail,
    });
    const b = prompt.budgets;
    return ok({
      turn,
      budgets: { head: b.head, flex: b.flex, tail: b.tail, total: b.total, window: args.window_tokens, over_window: b.overWindow },
      evicted: b.evicted,
      reduced: b.reduced,
      cache_breakpoints: prompt.cacheBreakpoints,
      blocks: prompt.blocks.map((block) => ({
        zone: block.zone,
        id: block.id,
        node_id: block.nodeId ?? null,
        tokens: block.tokens,
        ...(args.include_text === true ? { text: block.text } : {}),
      })),
    });
  } catch (error) {
    return failFrom(error);
  }
}
