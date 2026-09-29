/**
 * `summarize` — the ONLY way a summary is made (D26). Any range of the transcript, by stub
 * ids or L0 seqs, through the context's model provider; written to the ledger as a `fold`
 * (and as the segment's summary when the range is a segment's span). Accepted only if the
 * summary is much smaller than what it summarizes (`summaryRatio`); otherwise nothing is
 * written and the stubs stand. Callable by `assemble`'s host (it reports `summary_requests`),
 * by the agent, and by the CLI; `unavailable` when the context has no provider.
 */
import { z } from 'zod';
import { summarizeRange } from '@context-tree/core';
import { stageArgsShape, withOverrides } from '../params.js';
import { fail, failFrom, ok, parseArgs } from '../result.js';
import { sessionOf, sessionUnits } from '../session.js';
import type { ToolContext, ToolOutcome } from '../types.js';

export const CONTEXT_SUMMARIZE = 'summarize';

export const CONTEXT_SUMMARIZE_DESCRIPTION =
  'Summarize a range of your recorded history into one short fold that stands in for it, by stub ids ' +
  '(from_stub/to_stub, as `units` lists them) or by L0 event numbers (from_seq/to_seq). Reach for it when ' +
  'a stretch of earlier work is finished and its folded remains still take room; the content stays one ' +
  'fetch away. Rejected when the summary would not be much smaller than what it summarizes.';

const shape = {
  from_stub: z.number().int().positive().optional(),
  to_stub: z.number().int().positive().optional(),
  from_seq: z.number().int().positive().optional(),
  to_seq: z.number().int().positive().optional(),
  trigger: z.string().optional().describe('Who asked: recorded on the fold.'),
  ...stageArgsShape('summarize'),
};
export const contextSummarizeSchema = z.object(shape);
export const contextSummarizeInputShape = shape;

export interface ContextSummarizeData {
  status: 'written' | 'rejected';
  fold_id: string | null;
  node_id: string | null;
  from_seq: number;
  to_seq: number;
  summary_tokens: number;
  summarized_tokens: number;
  reason: string | null;
  text: string | null;
}

export async function contextSummarize(ctx: ToolContext, input: unknown): Promise<ToolOutcome<ContextSummarizeData>> {
  const parsed = parseArgs(contextSummarizeSchema, input);
  if (!parsed.ok) return parsed;
  const args = parsed.data;
  if (ctx.summarizer === undefined) return fail('unavailable', 'this server has no model provider for summaries');
  const bySeq = args.from_seq !== undefined && args.to_seq !== undefined;
  const byStub = args.from_stub !== undefined && args.to_stub !== undefined;
  if (bySeq === byStub) return fail('invalid_input', 'give from_seq and to_seq, or from_stub and to_stub');
  try {
    const session = sessionOf(ctx);
    const params = withOverrides(session.params, 'summarize', args);
    let fromSeq = args.from_seq ?? 0;
    let toSeq = args.to_seq ?? 0;
    if (byStub) {
      const { blocks } = await sessionUnits(ctx);
      const first = blocks.find((b) => b.stub === args.from_stub);
      const last = blocks.find((b) => b.stub === args.to_stub);
      if (first === undefined || last === undefined) return fail('invalid_input', 'no such stub ids — `units` lists them');
      fromSeq = first.fromSeq;
      toSeq = last.toSeq;
    }
    if (toSeq < fromSeq) return fail('invalid_input', 'the range ends before it starts');
    const outcome = await summarizeRange(
      { fromSeq, toSeq, trigger: args.trigger ?? 'summarize' },
      {
        store: ctx.handle.store, trace: ctx.handle.trace, blobs: ctx.handle.blobs, tokenizer: session.tokenizer,
        provider: ctx.summarizer.provider, model: ctx.summarizer.model, ratio: params.summaryRatio, maxTokens: params.summaryMaxTokens,
      },
    );
    return ok(outcome.status === 'written'
      ? { status: 'written', fold_id: outcome.foldId, node_id: outcome.nodeId, from_seq: fromSeq, to_seq: toSeq, summary_tokens: outcome.tokens, summarized_tokens: outcome.summarized, reason: null, text: outcome.text }
      : { status: 'rejected', fold_id: null, node_id: null, from_seq: fromSeq, to_seq: toSeq, summary_tokens: outcome.tokens, summarized_tokens: outcome.summarized, reason: outcome.reason, text: null });
  } catch (error) {
    return failFrom(error);
  }
}
