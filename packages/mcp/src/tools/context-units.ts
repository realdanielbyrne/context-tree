/**
 * `units` — what the pipeline is working over, and what has been ruled about each.
 * A unit is a TURN (one host message) by default, or a whole phase; every stage —
 * classification, assembly, eviction, retrieval — operates on this same list.
 */
import { z } from 'zod';
import { tokensUnder, type Disposition } from '@context-tree/core';
import { failFrom, ok, parseArgs } from '../result.js';
import { advanceTurn, dispositionOf, sessionOf, sessionUnits, viewOf, type UnitView } from '../session.js';
import type { ToolContext, ToolOutcome } from '../types.js';
import { pinnedIds } from './context-assemble.js';
import { turnArg } from './pipeline-args.js';

export const CONTEXT_UNITS = 'units';

export const CONTEXT_UNITS_DESCRIPTION =
  'List the units of this session in creation order — one per message you exchanged — with their size in ' +
  'heuristic tokens and what has been ruled about each: kept raw, reduced, folded to a summary, or removed. ' +
  'Reach for it when you need to know what is still in your context before deciding to fetch, evict or ' +
  'restore. A unit is read with fetch { branch_id: phase_id, from: from_seq, to: to_seq }.';

const shape = { turn: turnArg };
export const contextUnitsSchema = z.object(shape);
export const contextUnitsInputShape = shape;

export interface UnitRow extends UnitView {
  order: number;
  /** HEURISTIC tokens of the raw unit — not the served tokenizer's count. */
  tokens: number;
  current_tokens: number;
  state: Disposition['kind'];
  chunks: number;
  wrote: boolean;
  last_referenced_turn: number;
  /** Removing it would break the request itself; no ruling touches it. */
  pinned: boolean;
}

export interface ContextUnitsData {
  turn: number;
  last_seq: number;
  unit: 'turn' | 'phase';
  tokens_raw: number;
  tokens_current: number;
  units: UnitRow[];
}

export async function contextUnits(ctx: ToolContext, input: unknown): Promise<ToolOutcome<ContextUnitsData>> {
  const parsed = parseArgs(contextUnitsSchema, input ?? {});
  if (!parsed.ok) return parsed;
  try {
    const session = sessionOf(ctx);
    const turn = advanceTurn(session, parsed.data.turn);
    const { units, lastSeq } = await sessionUnits(ctx);
    const pinned = pinnedIds(units.filter((u) => !session.evicted.has(u.id)));
    const rows = units.map((u, order): UnitRow => {
      const disposition = dispositionOf(session, u.id);
      return {
        ...viewOf(u), order, tokens: u.tokens, current_tokens: tokensUnder(u, disposition), state: disposition.kind,
        chunks: u.chunks, wrote: u.flex.wrote, last_referenced_turn: u.flex.lastReferencedTurn, pinned: pinned.has(u.id),
      };
    });
    return ok({
      turn, last_seq: lastSeq, unit: session.params.unit,
      tokens_raw: rows.reduce((n, r) => n + r.tokens, 0),
      tokens_current: rows.reduce((n, r) => n + r.current_tokens, 0),
      units: rows,
    });
  } catch (error) {
    return failFrom(error);
  }
}
