/**
 * RANGE SUMMARIES — the model-facing half of folding (D26).
 *
 * A summary is a fold over a range of the transcript: the segmenter decides the range
 * (a phase, a run of stubbed blocks, whatever the assembler or the agent asks for) and this
 * writes it. One prompt for every range — the leaf prompt, over the range's events, with a
 * thinking block shown head-and-tail — and one contract: a summary counts only if it is
 * much smaller than what it summarizes (`ratio`), or the stubs it would replace stand.
 *
 * The result goes to the ledger through `writeSummary` when the range is a node's span,
 * and as a plain `fold` event otherwise; either way L0 is the truth for it.
 */
import type { BlobStore, ModelProvider, NodeId, Seq, SummaryMeta, Tokenizer, TraceLog, TreeStore } from '../contracts/index.js';
import type { FoldEvent } from '../contracts/trace.js';
import { leafSummaryPrompt } from '../prompts/index.js';
import { summaryFoldId, writeSummary } from '../segment/ledger.js';
import { parseSummaryReply } from './contract.js';
import { renderRangeDetail } from './detail.js';

export interface RangeSummaryRequest {
  readonly fromSeq: Seq;
  readonly toSeq: Seq;
  readonly trigger: string;
}

export interface RangeSummaryOptions {
  readonly store: TreeStore;
  readonly trace: TraceLog;
  readonly blobs: BlobStore;
  readonly tokenizer: Tokenizer;
  readonly provider: ModelProvider;
  readonly model: string;
  /** Accept only when summary tokens ≤ ratio × tokens summarized. */
  readonly ratio: number;
  readonly maxTokens: number;
  readonly now?: () => string;
}

export type RangeSummaryOutcome =
  | { readonly status: 'written'; readonly foldId: string; readonly nodeId: NodeId | null; readonly text: string; readonly tokens: number; readonly summarized: number }
  | { readonly status: 'rejected'; readonly reason: string; readonly tokens: number; readonly summarized: number };

/** The node whose span is exactly this range, when there is one: the summary is then that node's. */
function nodeOfRange(store: TreeStore, fromSeq: Seq, toSeq: Seq): NodeId | null {
  for (const node of store.nodesInCreationOrder()) {
    if (node.span_start_seq === fromSeq && (node.span_end_seq ?? node.span_start_seq) === toSeq) return node.id;
  }
  return null;
}

export async function summarizeRange(request: RangeSummaryRequest, options: RangeSummaryOptions): Promise<RangeSummaryOutcome> {
  const { store, trace, blobs, tokenizer } = options;
  const detail = renderRangeDetail(request.fromSeq, request.toSeq, { trace, blobs });
  const summarized = tokenizer.count(detail);
  const nodeId = nodeOfRange(store, request.fromSeq, request.toSeq);
  const node = nodeId === null ? null : store.getNode(nodeId);
  const prompt = leafSummaryPrompt({
    title: node?.title ?? `transcript ${String(request.fromSeq)}–${String(request.toSeq)}`,
    phaseType: node?.phase_type ?? null,
    nodeIds: nodeId === null ? [] : [nodeId],
    detail,
  });
  const reply = await options.provider.complete({ model: options.model, messages: [{ role: 'user', content: prompt }], maxTokens: options.maxTokens });
  let parsed: { text: string; meta: SummaryMeta };
  try {
    parsed = parseSummaryReply(reply.text);
  } catch (error) {
    return { status: 'rejected', reason: `reply broke the summary contract: ${error instanceof Error ? error.message : String(error)}`, tokens: 0, summarized };
  }
  const tokens = tokenizer.count(parsed.text);
  if (tokens > options.ratio * summarized) {
    return { status: 'rejected', reason: `summary is ${String(tokens)} tokens for ${String(summarized)} summarized (ratio ${options.ratio})`, tokens, summarized };
  }
  const ts = options.now?.() ?? new Date().toISOString();
  if (nodeId !== null) {
    writeSummary(store, { node_id: nodeId, model: reply.model, text: parsed.text, meta: parsed.meta, created_at: ts }, { trace, blobs }, request.trigger);
    const last = trace.all().findLast((e) => e.type === 'fold');
    return { status: 'written', foldId: last?.type === 'fold' ? last.fold_id : summaryFoldId(trace.lastSeq()), nodeId, text: parsed.text, tokens, summarized };
  }
  const at = trace.lastSeq() + 1;
  const event: Omit<FoldEvent, 'seq'> = {
    type: 'fold', ts, fold_id: summaryFoldId(at), kind: 'summary', from_seq: request.fromSeq, to_seq: request.toSeq,
    blob: blobs.put(JSON.stringify({ text: parsed.text, meta: parsed.meta })), model: reply.model, trigger: request.trigger,
  };
  trace.append(event);
  return { status: 'written', foldId: event.fold_id, nodeId: null, text: parsed.text, tokens, summarized };
}
