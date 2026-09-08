/**
 * §9 `context_search` — collapsed-tree (RAPTOR) retrieval over node-summary
 * vectors, falling back to beam search over summary TEXT when L3 is absent, and
 * fanning out to the §9.1 providers when a registry is wired.
 *
 * §19 Q2, revised 2026-09-04: the RANKING is over summaries (fingerprint-enriched,
 * grep re-ranked), but the HIT is an event — the best-matching raw events across
 * the ranked branches, each with its seq and an excerpt of its own text. Measured
 * 15/25 vs 6/25 against branch coordinates, every success with zero fetches
 * (`reports/metrics/window-regime-and-retrieval-unit-report.md` §7). `context_fetch` /
 * `context_peek` remain the way to read more than the excerpt.
 */
import { z } from 'zod';
import {
  mergeCandidates,
  type Candidate,
  type EventHit,
  type MergeResult,
  type NodeId,
  type NodeKind,
  type PhaseType,
  type ProviderOutcome,
  type ProviderTier,
  type SearchPath,
  type SummaryHit,
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


export const CONTEXT_SEARCH_DESCRIPTION =
  'Search this task\'s recorded history. Reach for it when you know WHAT you need but not WHERE it ' +
  'happened — before re-deriving a decision, re-reading a file another phase already changed, or ' +
  'answering anything that must reproduce a literal. Each hit is one recorded EVENT: the branch it ' +
  'belongs to (node_id, title, meta pointers), its position (`seq`), and an `excerpt` of that ' +
  'event\'s own text. If the excerpt already shows the exact literal you need, answer from it. ' +
  'Otherwise call context_fetch with the hit\'s node_id as branch_id and `from`/`to` a few events ' +
  'either side of `seq` — that is the cheap read; a whole branch is the expensive one.';

const shape = {
  query: z.string().min(1).describe('What you are looking for: a few content words or identifiers that appeared in the work, not a question.'),
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
  /** Event relevance for an event hit; the branch score for a bare coordinate. */
  score: number;
  /** 1-based rank of the hit's branch in the underlying branch search. */
  branch_rank: number;
  /** L0 event number the hit names, or null for a bare branch coordinate. */
  seq: number | null;
  /**
   * The hit's payload: a slice of the event's own rendered text; null for a bare
   * coordinate. This replaces the pointer `meta` a branch hit used to carry: on
   * the measured store a phase's file-span records ran to thousands of tokens
   * per hit list (the reason the compact-coordinate arm existed), and the
   * excerpt is what makes a hit legible now. The §8 metadata is one
   * context_fetch away.
   */
  excerpt: string | null;
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


function toHitPayload(hit: EventHit): SearchHitPayload {
  return {
    node_id: hit.nodeId,
    kind: hit.kind,
    title: hit.title,
    phase_type: hit.phaseType,
    path: hit.path ?? null,
    summary_version: hit.version,
    score: hit.score,
    branch_rank: hit.branchRank,
    seq: hit.seq,
    excerpt: hit.excerpt,
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
  const { limit, eventHits, excerptChars } = ctx.config.retrieval;

  try {
    const tree = await ctx.retriever.searchEvents(args.query, { kind: args.kind, limit, hits: eventHits, excerptChars });
    const query = { query: args.query, kind: args.kind, limit, mode: 'ranked' as const };
    const fanout = ctx.registry === undefined ? null : await ctx.registry.search(query);
    const merged = mergeCandidates(
      [
        { provider: TREE_PROVIDER, tier: 'fuzzy', candidates: tree.branches.map(toCandidate) },
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
