/**
 * §9.1's deterministic merge policy. Reproducibility is the stated point: the
 * same provider outputs must always yield the same candidate list, byte for
 * byte, so a change in eval scores means retrieval changed — not that two
 * promises settled in a new order or that a Map iterated differently.
 *
 * The order is fixed in v1 (§19 Q6):
 *   1. structural hits (graft, Serena) — exact edges, verifiable spans
 *   2. fuzzy hits (Augment, vector)
 *   3. grep last — EXCEPT `mode: 'exhaustive'`, where grep is authoritative and
 *      goes first (graft's own ask-vs-grep distinction, D13).
 * Dedup is by `(path, span)`, and because tier is the primary sort key,
 * "keep the first survivor" *is* "keep the highest-tier occurrence".
 */
import { TIER_ORDER, type Candidate, type MergeResult, type ProviderTier, type SearchQuery } from '../contracts/index.js';

/** One provider's contribution to a single fan-out. */
export interface ProviderOutcome {
  provider: string;
  tier: ProviderTier;
  candidates: Candidate[];
  /**
   * Probe said no, or `search` threw / timed out. Its candidates are ignored
   * wholesale: a provider that failed mid-stream may have returned half an
   * answer, and §18's degradation rule is drop-the-provider, not merge-half.
   */
  unavailable?: boolean;
}

/** grep is authoritative for an exhaustive sweep, so its tier leads. */
const EXHAUSTIVE_TIER_ORDER: readonly ProviderTier[] = ['fallback', 'structural', 'fuzzy'] as const;

export function tierOrderFor(query: SearchQuery): readonly ProviderTier[] {
  return query.mode === 'exhaustive' ? EXHAUSTIVE_TIER_ORDER : TIER_ORDER;
}

interface Ranked {
  candidate: Candidate;
  /** Index into `byProvider`, so a candidate is always attributable. */
  outcome: number;
  tierRank: number;
  provider: string;
}

/**
 * Total and machine-independent. Every comparison is `<`/`>` on raw strings,
 * never `localeCompare` — collation is locale-dependent and would make the
 * merge differ between two machines running the same eval.
 */
function compare(a: Ranked, b: Ranked): number {
  if (a.tierRank !== b.tierRank) return a.tierRank - b.tierRank;
  // Provider id before score, deliberately: `Candidate.score` is documented as
  // provider-local, so ranking graft's 0.5 against augment's 0.9 would be noise
  // dressed up as relevance.
  if (a.provider !== b.provider) return a.provider < b.provider ? -1 : 1;
  if (a.candidate.score !== b.candidate.score) return b.candidate.score - a.candidate.score;

  const pathA = a.candidate.path ?? '';
  const pathB = b.candidate.path ?? '';
  if (pathA !== pathB) return pathA < pathB ? -1 : 1;

  const startA = a.candidate.span?.start_line ?? 0;
  const startB = b.candidate.span?.start_line ?? 0;
  if (startA !== startB) return startA - startB;

  const endA = a.candidate.span?.end_line ?? 0;
  const endB = b.candidate.span?.end_line ?? 0;
  if (endA !== endB) return endA - endB;

  const symbolA = a.candidate.symbol ?? '';
  const symbolB = b.candidate.symbol ?? '';
  if (symbolA !== symbolB) return symbolA < symbolB ? -1 : 1;
  return 0;
}

/**
 * `(path, span)` per §9.1, with fallbacks for the hits that have no path: a
 * VectorProvider returns `node_id`, and a symbol-only hit keys on the symbol.
 * A candidate with nothing identifying gets a unique key — collapsing those
 * would merge unrelated hits, which is worse than a duplicate.
 */
function dedupKey(candidate: Candidate, position: number): string {
  if (candidate.path !== undefined && candidate.path !== '') {
    return `p:${candidate.path}:${candidate.span?.start_line ?? ''}-${candidate.span?.end_line ?? ''}`;
  }
  if (candidate.node_id !== undefined) return `n:${candidate.node_id}`;
  if (candidate.symbol !== undefined) return `s:${candidate.symbol}`;
  return `u:${position}`;
}

export function mergeCandidates(byProvider: readonly ProviderOutcome[], query: SearchQuery): MergeResult {
  const order = tierOrderFor(query);
  const ranked: Ranked[] = [];

  for (const [index, outcome] of byProvider.entries()) {
    if (outcome.unavailable === true) continue;
    // The *outcome's* tier ranks the hit, never the candidate's own `tier`
    // field: otherwise a provider could jump the merge order it was registered
    // at just by mislabelling what it returns.
    const tierRank = order.indexOf(outcome.tier);
    for (const candidate of outcome.candidates) {
      ranked.push({
        candidate,
        outcome: index,
        tierRank: tierRank < 0 ? order.length : tierRank,
        provider: outcome.provider,
      });
    }
  }
  ranked.sort(compare);

  const limit = query.limit !== undefined && query.limit > 0 ? query.limit : Number.POSITIVE_INFINITY;
  const keptPerOutcome = new Map<number, number>();
  const seen = new Set<string>();
  const candidates: Candidate[] = [];

  for (const [position, entry] of ranked.entries()) {
    if (candidates.length >= limit) break;
    const key = dedupKey(entry.candidate, position);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(entry.candidate);
    keptPerOutcome.set(entry.outcome, (keptPerOutcome.get(entry.outcome) ?? 0) + 1);
  }

  // `kept + dropped === candidates supplied`, always: `dropped` counts both the
  // dedup losers and anything cut by `limit`, so the eval harness can read
  // which tier actually contributed without reconstructing the arithmetic.
  const contributions: MergeResult['contributions'] = [];
  for (const [index, outcome] of byProvider.entries()) {
    if (outcome.unavailable === true) continue;
    const kept = keptPerOutcome.get(index) ?? 0;
    contributions.push({
      provider: outcome.provider,
      tier: outcome.tier,
      kept,
      dropped: outcome.candidates.length - kept,
    });
  }
  // Sorted by id, not by registration order, so the report is identical however
  // the registry was assembled.
  contributions.sort((a, b) => (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0));

  const unavailable = byProvider
    .filter((outcome) => outcome.unavailable === true)
    .map((outcome) => outcome.provider)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  return { candidates, contributions, unavailable };
}
