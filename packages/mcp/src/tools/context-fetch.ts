/**
 * §9 `fetch` — expansion. `depth: 'summary'` is an L1 read;
 * `depth: 'full'` (the default, R9) replays the branch's L0 span through L2;
 * `depth: 'index'` (R10) lists that span's events instead of reading them.
 * `file` narrows any depth to the file node(s) keyed by one path (§10 rule 4);
 * `from`/`to` (R10) additionally narrows a `'full'`/`'index'` read to an
 * inclusive L0 `seq` range.
 */
import { z } from 'zod';
import type { NodeId, NodeKind, PhaseType, SeqSpan, SummaryMeta } from '@context-tree/core';
import { failFrom, ok, parseArgs, requireNode } from '../result.js';
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
  branch_id: z.string().min(1).describe('Node id of the branch to read, as returned by search.'),
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

export async function contextFetch(ctx: ToolContext, input: unknown): Promise<ToolOutcome<ContextFetchData>> {
  const parsed = parseArgs(contextFetchSchema, input);
  if (!parsed.ok) return parsed;
  const args = parsed.data;

  const branch = requireNode(ctx, 'branch_id', args.branch_id);
  if (!branch.ok) return branch;

  try {
    const fetched = ctx.retriever.fetchBranch(args.branch_id, {
      depth: args.depth ?? 'full',
      file: args.file,
      from: args.from,
      to: args.to,
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
      text: fetched.text,
    };
    recordRetrieval(ctx, CONTEXT_FETCH, args, data);
    return ok(data);
  } catch (error) {
    return failFrom(error);
  }
}
