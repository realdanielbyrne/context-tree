/**
 * §9 `context_peek` — "suspicion costs one small call, not a full expansion".
 * Reads RAW L0 payloads, not the summary: the contract's rule 3 points here
 * precisely when a summary is suspected of lagging the branch it describes.
 */
import { z } from 'zod';
import type { NodeId, NodeKind, PhaseType } from '@context-tree/core';
import { failFrom, ok, parseArgs, requireNode } from '../result.js';
import { recordRetrieval } from '../observe.js';
import type { ToolContext, ToolOutcome } from '../types.js';

export const CONTEXT_PEEK = 'context_peek';

/** Small on purpose: a peek that returns a branch is a `context_fetch` wearing a cheaper name. */
export const DEFAULT_PEEK_CHARS = 2_000;
/** Hard ceiling. A model that asks for 200k here has decided to fetch; make it say so. */
export const MAX_PEEK_CHARS = 8_000;

export const CONTEXT_PEEK_DESCRIPTION =
  'Return a short raw excerpt from one node — the recorded events themselves, not their summary. ' +
  'Reach for it when you suspect a summary is stale, thin or wrong and want to check before paying ' +
  `for a full fetch. Excerpts are capped at ${String(MAX_PEEK_CHARS)} characters; if you need more than that, ` +
  'the honest call is context_fetch.';

const shape = {
  node_id: z.string().min(1).describe('Node to excerpt, from a context_search hit or a fetched branch.'),
  max_chars: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(`Excerpt length, default ${String(DEFAULT_PEEK_CHARS)}, capped at ${String(MAX_PEEK_CHARS)}.`),
};

export const contextPeekSchema = z.object(shape);
export const contextPeekInputShape = shape;

export interface ContextPeekData {
  node_id: NodeId;
  kind: NodeKind;
  title: string;
  phase_type: PhaseType | null;
  /** The cap actually applied, after clamping — may be smaller than requested. */
  max_chars: number;
  chars: number;
  /** True when the excerpt filled its cap, so more content exists below it. */
  truncated: boolean;
  text: string;
}

export async function contextPeek(ctx: ToolContext, input: unknown): Promise<ToolOutcome<ContextPeekData>> {
  const parsed = parseArgs(contextPeekSchema, input);
  if (!parsed.ok) return parsed;
  const args = parsed.data;

  const found = requireNode(ctx, 'node_id', args.node_id);
  if (!found.ok) return found;
  const node = found.data;

  const cap = Math.min(args.max_chars ?? DEFAULT_PEEK_CHARS, MAX_PEEK_CHARS);
  try {
    const text = ctx.retriever.peek(node.id, cap);
    const data: ContextPeekData = {
      node_id: node.id,
      kind: node.kind,
      title: node.title,
      phase_type: node.phase_type,
      max_chars: cap,
      chars: text.length,
      truncated: text.length >= cap,
      text,
    };
    recordRetrieval(ctx, CONTEXT_PEEK, args, data);
    return ok(data);
  } catch (error) {
    return failFrom(error);
  }
}
