/**
 * §9 `fetch` — expansion. `depth: 'summary'` is an L1 read;
 * `depth: 'full'` (the default, R9) replays the branch's L0 span through L2;
 * `depth: 'index'` (R10) lists that span's events instead of reading them.
 * `file` narrows any depth to the file node(s) keyed by one path (§10 rule 4);
 * `from`/`to` (R10) additionally narrows a `'full'`/`'index'` read to an
 * inclusive L0 `seq` range.
 */
import { z } from 'zod';
import { resolveReducer } from '@context-tree/core';
import { sessionOf, sessionUnits } from '../session.js';
import type { NodeId, NodeKind, PhaseType, SeqSpan, SummaryMeta } from '@context-tree/core';
import { fail, failFrom, ok, parseArgs, requireNode } from '../result.js';
import { recordRetrieval } from '../observe.js';
import type { ToolContext, ToolOutcome } from '../types.js';

export const CONTEXT_FETCH = 'fetch';

/**
 * Zone A content (D5): permanent in every prompt, so every token is paid for
 * forever. It states the TRIGGER, not the mechanics — with no fine-tuning
 * anywhere (D7), this text plus the system contract is the entire policy.
 *
 * The read-before-edit rule (§9 contract rule 1) is stated here rather than
 * left to the system prompt because a host may install the tools without the
 * contract, and the tool list is the one thing it cannot install without.
 */
export const CONTEXT_FETCH_DESCRIPTION =
  'Return a recorded branch of this task: the full events under it (the default), an index of those ' +
  'events, or its summary. Reach for it BEFORE EDITING any file whose current content is not already ' +
  'in your context — your memory of a file predates whatever a later branch did to it — and whenever a ' +
  'summary names a file, test or ticket you are about to touch, or whenever your answer must reproduce ' +
  "a number, an identifier, or someone's exact words: a summary can tell you something happened, never " +
  "what it said. A branch too large to read whole: call with `depth: 'index'` first to see its events, " +
  'then narrow with `from`/`to`. The result lands in the transcript tail only: it never mutates the ' +
  'stored tree and never invalidates the cached prompt prefix.';

const shape = {
  branch_id: z.string().min(1).optional().describe('Node id of the branch to read, as returned by search or named in a folded phase. Give this or `unit`.'),
  unit: z
    .string()
    .min(1)
    .optional()
    .describe('A unit id exactly as an `[evicted …]` tag gives it, e.g. "turn:31": returns that one turn in full. Give this or `branch_id`.'),
  depth: z
    .enum(['summary', 'index', 'full'])
    .optional()
    .describe(
      "'full' (default) replays every recorded event under the branch; 'index' lists those events " +
        "(seq, type, tool, path, bytes) without reading their content; 'summary' returns the branch's " +
        'stored paraphrase, which cannot contain a literal the paraphrase dropped.',
    ),
  file: z
    .string()
    .min(1)
    .optional()
    .describe('Repo-relative path: read only the file node(s) under this branch keyed by it.'),
  from: z
    .number()
    .int()
    .optional()
    .describe("Inclusive L0 event number to start at (depth 'full'/'index' only). Clamped to the branch's own span."),
  to: z
    .number()
    .int()
    .optional()
    .describe("Inclusive L0 event number to end at (depth 'full'/'index' only). Clamped to the branch's own span."),
  budget_tokens: z
    .number()
    .positive()
    .optional()
    .describe("Shrink a 'full' read to this many heuristic tokens, keeping the spans that match `query` and marking the gaps."),
  query: z.string().optional().describe('Ranks the spans `budget_tokens` keeps. Omit to keep the leading spans.'),
};

export const contextFetchSchema = z.object(shape);
export const contextFetchInputShape = shape;

export interface ContextFetchData {
  branch_id: NodeId;
  kind: NodeKind;
  title: string;
  phase_type: PhaseType | null;
  depth: 'summary' | 'index' | 'full';
  file: string | null;
  /** 0 when §8 has not summarized this branch yet, or several nodes were merged. */
  summary_version: number;
  /** The §8 rehydration pointers — read these first to judge what else to fetch. */
  meta: SummaryMeta | null;
  /** Nodes this result actually covers; each is a valid `peek` target. */
  nodes: NodeId[];
  /** L0 ranges read. Empty at depth `summary`, which touches L1 only. */
  spans: SeqSpan[];
  events: number;
  text: string;
}

/** The same reducer assembly uses, so a budgeted read and a reduced unit keep the same spans. */
function withinBudget(ctx: ToolContext, text: string, depth: string, budgetTokens: number | undefined, query: string | undefined): string {
  if (budgetTokens === undefined || depth !== 'full') return text;
  const { params, tokenizer } = sessionOf(ctx);
  return resolveReducer(params.reducer === 'none' ? 'chunk' : params.reducer)({ raw: text }, {
    budgetTokens, tokenizer, ...(query !== undefined ? { query } : {}),
    chunkOptions: { chunkSize: params.chunkSize, chunkOverlap: params.chunkOverlap }, rrfK: params.rrfK,
  });
}

export async function contextFetch(ctx: ToolContext, input: unknown): Promise<ToolOutcome<ContextFetchData>> {
  const parsed = parseArgs(contextFetchSchema, input);
  if (!parsed.ok) return parsed;
  const args = parsed.data;

  if ((args.branch_id === undefined) === (args.unit === undefined)) return fail('invalid_input', 'give exactly one of branch_id or unit');

  try {
    // A unit is a span of one phase, so it resolves to that branch narrowed to the unit's events.
    const unit = args.unit === undefined ? undefined : (await sessionUnits(ctx)).units.find((u) => u.id === args.unit);
    if (args.unit !== undefined && unit === undefined) return fail('unknown_node', `no unit "${args.unit}" — ids are listed by the units tool`);
    const branchId = unit?.phase.id ?? (args.branch_id as string);
    const branch = requireNode(ctx, 'branch_id', branchId);
    if (!branch.ok) return branch;

    const fetched = ctx.retriever.fetchBranch(branchId, {
      depth: args.depth ?? 'full',
      file: args.file,
      from: unit?.startSeq ?? args.from,
      to: unit?.endSeq ?? args.to,
    });
    const data: ContextFetchData = {
      branch_id: fetched.nodeId,
      kind: fetched.kind,
      title: fetched.title,
      phase_type: fetched.phaseType,
      depth: fetched.depth,
      file: fetched.file ?? null,
      summary_version: fetched.summaryVersion,
      meta: fetched.meta,
      nodes: fetched.nodes,
      spans: fetched.spans,
      events: fetched.events,
      text: withinBudget(ctx, fetched.text, fetched.depth, args.budget_tokens, args.query),
    };
    recordRetrieval(ctx, CONTEXT_FETCH, args, data);
    return ok(data);
  } catch (error) {
    return failFrom(error);
  }
}
