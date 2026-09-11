/**
 * §9 `context_search` — RRF ensemble retrieval over the L0-unit corpus.
 *
 * The corpus is the store's nodes chunked by the recursive character splitter; the
 * ranker is BM25 + vector kNN fused by RRF (`ensembleRetrieve`), degrading to
 * BM25-only when no embedder is available. Each HIT is a whole UNIT (a phase/branch,
 * or a file node under `kind: "file"`): its coordinates plus an excerpt of its
 * best-matching chunk. `context_fetch` / `context_peek` read the whole unit.
 *
 * This replaced the tested-and-lost summary-ranking path + the never-compared
 * provider fan-out (see `reports/session-handoff.md`); `retrieve/retriever.ts`
 * survives only for `context_fetch` / `context_peek` (L0 replay + expansion).
 */
import { z } from 'zod';
import {
  ensembleRetrieve,
  readNodeText,
  type NodeId,
  type NodeKind,
  type PhaseType,
} from '@context-tree/core';
import { failFrom, ok, parseArgs } from '../result.js';
import { recordRetrieval } from '../observe.js';
import type { ToolContext, ToolOutcome } from '../types.js';

export const CONTEXT_SEARCH = 'context_search';

export const CONTEXT_SEARCH_DESCRIPTION =
  "Search this task's recorded history. Reach for it when you know WHAT you need but not WHERE it " +
  'happened — before re-deriving a decision, re-reading a file another phase already changed, or ' +
  'answering anything that must reproduce a literal. Each hit is one UNIT of work (a phase/branch, or a ' +
  'file node when `kind: "file"`): its `node_id`, `title`, position (`seq`), and an `excerpt` of its ' +
  "best-matching content. If the excerpt already shows the exact literal you need, answer from it. " +
  "Otherwise call context_fetch with the hit's node_id as branch_id to read the whole unit — that is the " +
  'expensive read; the excerpt is the cheap one.';

const shape = {
  query: z
    .string()
    .min(1)
    .describe('What you are looking for: a few content words or identifiers that appeared in the work, not a question.'),
  kind: z
    .enum(['task', 'phase', 'file', 'turn'])
    .optional()
    .describe("Narrow the answer to one node kind — 'file' to find which branch touched a path."),
};

export const contextSearchSchema = z.object(shape);
export const contextSearchInputShape = shape;

export interface SearchHitPayload {
  node_id: NodeId;
  kind: NodeKind;
  title: string;
  phase_type: PhaseType | null;
  path: string | null;
  summary_version: number;
  /** Fused RRF score of the unit's best-matching chunk. */
  score: number;
  /** 1-based rank of the unit in the ensemble ranking. */
  branch_rank: number;
  /** The L0 seq the unit's span starts at. */
  seq: number | null;
  /** The unit's best-matching chunk text, capped to `excerptChars`. */
  excerpt: string;
}

export interface ContextSearchData {
  query: string;
  /** 'ensemble' (BM25 + vector) or 'bm25' when no embedder is available. */
  path: 'ensemble' | 'bm25';
  /** Set only when the vector arm was unavailable (BM25-only). */
  fallback: string | null;
  hits: SearchHitPayload[];
}

export async function contextSearch(ctx: ToolContext, input: unknown): Promise<ToolOutcome<ContextSearchData>> {
  const parsed = parseArgs(contextSearchSchema, input);
  if (!parsed.ok) return parsed;
  const args = parsed.data;
  const { limit, excerptChars } = ctx.config.retrieval;

  try {
    const { store, trace, blobs } = ctx.handle;
    // Corpus = the store's content-bearing nodes (filtered to one kind on request).
    const nodes = store
      .nodesInCreationOrder()
      .filter(
        (n) =>
          n.span_start_seq !== null &&
          n.status !== 'superseded' &&
          (args.kind === undefined || n.kind === args.kind),
      );
    const corpus = nodes.map((n) => ({ id: n.id, text: readNodeText(n, trace, blobs) }));

    // Vector arm runs only when the retriever carries an embedder; else BM25-only.
    const embed = ctx.retriever.embedder;
    const ranked = await ensembleRetrieve(args.query, corpus, embed, { topK: limit });

    const byId = new Map(nodes.map((n) => [n.id, n]));
    const hits: SearchHitPayload[] = ranked.map((r, i) => {
      const node = byId.get(r.unitId)!;
      return {
        node_id: node.id,
        kind: node.kind,
        title: node.title,
        phase_type: node.phase_type ?? null,
        path: node.meta_json.path ?? null,
        summary_version: node.current_summary_version,
        score: r.score,
        branch_rank: i + 1,
        seq: node.span_start_seq,
        excerpt: r.excerpt.slice(0, excerptChars),
      };
    });

    const data: ContextSearchData = {
      query: args.query,
      path: embed === undefined ? 'bm25' : 'ensemble',
      fallback: embed === undefined ? 'no-embedder' : null,
      hits,
    };
    recordRetrieval(ctx, CONTEXT_SEARCH, args, data);
    return ok(data);
  } catch (error) {
    return failFrom(error);
  }
}
