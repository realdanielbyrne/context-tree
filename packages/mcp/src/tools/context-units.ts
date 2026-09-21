/**
 * `context_units` — what the pipeline is working over. A UNIT is one segmenter
 * phase: the thing the classifier scores, eviction removes and the reducer shrinks.
 * Everything else in the pipeline is opaque without this listing.
 */
import { z } from 'zod';
import type { NodeId, PhaseType } from '@context-tree/core';
import { failFrom, ok } from '../result.js';
import { advanceTurn, sessionOf, sessionUnits } from '../session.js';
import type { ToolContext, ToolOutcome } from '../types.js';
import { turnArg } from './pipeline-args.js';

export const CONTEXT_UNITS = 'context_units';

export const CONTEXT_UNITS_DESCRIPTION =
  'List the units of this session in creation order — one per work phase — with their size in heuristic ' +
  'tokens, whether each is currently evicted from the prompt, and whether the recency anchor protects it. ' +
  'Reach for it when you need to know what is still in your context and what has been removed, before ' +
  'deciding to fetch, evict or restore something.';

const shape = { turn: turnArg };
export const contextUnitsSchema = z.object(shape);
export const contextUnitsInputShape = shape;

export interface UnitRow {
  node_id: NodeId;
  title: string;
  phase_type: PhaseType | null;
  order: number;
  status: string;
  /** HEURISTIC tokens (core `HeuristicTokenizer`), not the served tokenizer's count. */
  tokens: number;
  has_summary: boolean;
  wrote: boolean;
  last_referenced_turn: number;
  evicted: boolean;
  /** Inside the last `anchor` LIVE units, so not evictable at the server's default anchor. */
  anchored: boolean;
}

export interface ContextUnitsData {
  turn: number;
  last_seq: number;
  anchor: number;
  total_tokens: number;
  live_tokens: number;
  units: UnitRow[];
}

export async function contextUnits(ctx: ToolContext, input: unknown): Promise<ToolOutcome<ContextUnitsData>> {
  const parsed = contextUnitsSchema.safeParse(input ?? {});
  if (!parsed.success) return { ok: false, error: { code: 'invalid_input', message: parsed.error.message } };
  try {
    const session = sessionOf(ctx);
    const turn = advanceTurn(session, parsed.data.turn);
    const { units } = await sessionUnits(ctx);
    const live = units.filter((u) => !session.evicted.has(u.node.id));
    const anchored = new Set(live.slice(Math.max(0, live.length - session.pipeline.anchor)).map((u) => u.node.id));
    return ok({
      turn,
      last_seq: ctx.handle.trace.lastSeq(),
      anchor: session.pipeline.anchor,
      total_tokens: units.reduce((n, u) => n + u.tokens, 0),
      live_tokens: live.reduce((n, u) => n + u.tokens, 0),
      units: units.map((u) => ({
        node_id: u.node.id,
        title: u.node.title,
        phase_type: u.node.phase_type,
        order: u.unit.order,
        status: u.node.status,
        tokens: u.tokens,
        has_summary: u.unit.summary !== undefined,
        wrote: u.unit.wrote,
        last_referenced_turn: u.unit.lastReferencedTurn,
        evicted: session.evicted.has(u.node.id),
        anchored: anchored.has(u.node.id),
      })),
    });
  } catch (error) {
    return failFrom(error);
  }
}
