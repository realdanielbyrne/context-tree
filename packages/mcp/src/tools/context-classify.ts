/**
 * `context_classify` — the drift classifier's verdict per unit (stage 1). Read-only
 * and repeatable: classification is computed once per state of the trace
 * (`session.ts`), so asking twice does not count an observation twice.
 */
import { z } from 'zod';
import type { NodeId } from '@context-tree/core';
import { failFrom, ok } from '../result.js';
import { sessionOf, sessionUnits } from '../session.js';
import type { ToolContext, ToolOutcome } from '../types.js';

export const CONTEXT_CLASSIFY = 'context_classify';

export const CONTEXT_CLASSIFY_DESCRIPTION =
  'Score every unit for topic drift against the recent work: a drift value, its z-score against the ' +
  "session's own history, a 0-1 dormancy, and a dormant flag. Reach for it when you want to know which " +
  'earlier phases have gone quiet and are the natural candidates to evict.';

const shape = {};
export const contextClassifySchema = z.object(shape);
export const contextClassifyInputShape = shape;

export interface ContextClassifyData {
  k: number;
  tau: number;
  units: { node_id: NodeId; title: string; drift: number; z_drift: number; dormancy: number; dormant: boolean }[];
}

export async function contextClassify(ctx: ToolContext, _input: unknown): Promise<ToolOutcome<ContextClassifyData>> {
  try {
    const { pipeline } = sessionOf(ctx);
    const { units } = await sessionUnits(ctx);
    return ok({
      k: pipeline.driftK,
      tau: pipeline.driftTau,
      units: units.map((u) => ({
        node_id: u.node.id,
        title: u.node.title,
        drift: u.drift.drift,
        z_drift: u.drift.zDrift,
        dormancy: u.drift.dormancy,
        dormant: u.drift.dormant,
      })),
    });
  } catch (error) {
    return failFrom(error);
  }
}
