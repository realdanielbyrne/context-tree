/**
 * §9 `context_search` — collapsed-tree (RAPTOR) retrieval over node-summary
 * vectors, falling back to beam search over summary TEXT when L3 is absent, and
 * fanning out to the §9.1 providers when a registry is wired.
 *
 * §19 Q2 is decided in core: search covers SUMMARIES ONLY. Raw turns are
 * reachable only through an explicit `context_fetch` / `context_peek` on a node
 * a summary pointed at.
 */
import { z } from 'zod';
import {
  mergeCandidates,
  type Candidate,
  type MergeResult,
  type NodeId,
  type NodeKind,
  type PhaseType,
  type ProviderOutcome,
  type ProviderTier,
  type SearchPath,
  type SummaryHit,
  type SummaryMeta,
} from '@context-tree/core';
import { failFrom, ok, parseArgs } from '../result.js';
import { recordRetrieval } from '../observe.js';
import type { ToolContext, ToolOutcome } from '../types.js';

export const CONTEXT_SEARCH = 'context_search';

/**
 * The tree's own hits enter the §9.1 merge under this id. Not `vector`: a
 * registry may also hold `createVectorProvider`, and two outcomes sharing an id
 * would collapse two distinct contributions into one provenance row. Duplicate
 * node hits are then deduped by `mergeCandidates` on `node_id`.
 */
const TREE_PROVIDER = 'tree';

/** R8: a hit's snippet length — the same 240 `toCandidate` already computes below. */
const SNIPPET_CHARS = 240;

export const CONTEXT_SEARCH_DESCRIPTION =
  'Rank this task\'s branch summaries against a query and return their node ids and pointers. ' +
  'Reach for it when you know WHAT you need but not WHICH branch it happened in — before re-deriving ' +
  'a decision, re-reading a file another phase already changed, or re-answering an open question. ' +
  'It searches summaries, never raw turns, and each hit carries a short snippet, not the summary body: ' +
  'the content is one context_fetch away.';

const shape = {
  query: z.string().min(1).describe('What you are looking for, in words. Matched against branch summaries.'),
  kind: z
    .enum(['task', 'phase', 'file', 'turn'])
    .optional()
    .describe("Narrow the answer to one node kind — 'file' to find which branch touched a path."),
};

export const contextSearchSchema = z.object(shape);
export const contextSearchInputShape = shape;

/**
 * The pointer-only slice of `SummaryMeta` a search hit carries (R8): `files`,
 * `symbols` and `node_ids` are what a model uses to judge relevance or aim a
 * follow-up fetch; the prose fields (`tests`, `artifacts`, `open_questions`,
 * `decisions`) stay in Zone B, which already renders them for every branch a
 * prompt shows — a search hit repeating them would be a second, truncatable
 * copy of content that is never gone from the prompt in the first place.
 */
export type SearchHitMeta = Pick<SummaryMeta, 'files' | 'symbols' | 'node_ids'>;

export interface SearchHitPayload {
  node_id: NodeId;
  kind: NodeKind;
  title: string;
  phase_type: PhaseType | null;
  path: string | null;
  summary_version: number;
  score: number;
  /** Pointer fields only (R8) — the full §8 metadata is one context_fetch away. */
  meta: SearchHitMeta | null;
  /** First 240 chars of the summary — enough to judge relevance, not a duplicate of Zone B (R8). */
  snippet: string;
}

export interface ContextSearchData {
  query: string;
  /** Which mechanism answered, so §15's eval attributes recall to it. */
  path: SearchPath;
  /** Set only when the vector path was unavailable. */
  fallback: string | null;
  hits: SearchHitPayload[];
  /** Tree hits + §9.1 provider hits under §9.1's fixed tier order. */
  candidates: Candidate[];
  /** Per-provider kept/dropped — which tier actually contributed. */
  provenance: Array<{ provider: string; tier: ProviderTier; kept: number; dropped: number }>;
  /** Providers that failed their capability probe or threw. Degraded, never fatal (§18). */
  unavailable: string[];
}

function toHitMeta(meta: SummaryMeta | null): SearchHitMeta | null {
  if (meta === null) return null;
  return { files: meta.files, symbols: meta.symbols, node_ids: meta.node_ids };
}

function toHitPayload(hit: SummaryHit): SearchHitPayload {
  return {
    node_id: hit.nodeId,
    kind: hit.kind,
    title: hit.title,
    phase_type: hit.phaseType,
    path: hit.path ?? null,
    summary_version: hit.version,
    score: hit.score,
    meta: toHitMeta(hit.meta),
    snippet: hit.text.slice(0, SNIPPET_CHARS),
  };
}

/** Mirrors `createVectorProvider`'s mapping: `path`/`span` only when a §8 pointer backs both. */
function toCandidate(hit: SummaryHit): Candidate {
  const file = hit.path === undefined ? undefined : hit.meta?.files.find((entry) => entry.path === hit.path);
  return {
    node_id: hit.nodeId,
    path: hit.path,
    span: file === undefined ? undefined : { start_line: file.start_line, end_line: file.end_line },
    symbol: hit.meta?.symbols?.[0],
    score: hit.score,
    provider: TREE_PROVIDER,
    tier: 'fuzzy',
    snippet: hit.text.slice(0, 240),
  };
}

/**
 * Regroups the registry's already-merged candidates by provider so the tree can
 * be folded in under the same fixed order. The registry owns probing, timeouts
 * and failure isolation, so its merged list is the only view of the fan-out
 * available — and re-merging is safe because `mergeCandidates` is a total,
 * machine-independent sort.
 */
function providerOutcomes(fanout: MergeResult): ProviderOutcome[] {
  const byId = new Map<string, ProviderOutcome>();
  for (const candidate of fanout.candidates) {
    const existing = byId.get(candidate.provider);
    if (existing === undefined) {
      byId.set(candidate.provider, { provider: candidate.provider, tier: candidate.tier, candidates: [candidate] });
      continue;
    }
    existing.candidates.push(candidate);
  }
  return [...byId.values()].sort((a, b) => (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0));
}

export async function contextSearch(ctx: ToolContext, input: unknown): Promise<ToolOutcome<ContextSearchData>> {
  const parsed = parseArgs(contextSearchSchema, input);
  if (!parsed.ok) return parsed;
  const args = parsed.data;
  const limit = ctx.config.retrieval.limit;

  try {
    const tree = await ctx.retriever.search(args.query, { kind: args.kind, limit });
    const query = { query: args.query, kind: args.kind, limit, mode: 'ranked' as const };
    const fanout = ctx.registry === undefined ? null : await ctx.registry.search(query);
    const merged = mergeCandidates(
      [
        { provider: TREE_PROVIDER, tier: 'fuzzy', candidates: tree.hits.map(toCandidate) },
        ...(fanout === null ? [] : providerOutcomes(fanout)),
      ],
      query,
    );

    const data: ContextSearchData = {
      query: args.query,
      path: tree.path,
      fallback: tree.fallback ?? null,
      hits: tree.hits.map(toHitPayload),
      candidates: merged.candidates,
      provenance: merged.contributions,
      unavailable: fanout?.unavailable ?? [],
    };
    recordRetrieval(ctx, CONTEXT_SEARCH, args, data);
    return ok(data);
  } catch (error) {
    return failFrom(error);
  }
}
