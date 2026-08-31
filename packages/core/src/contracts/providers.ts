/**
 * §9.1 retrieval backends (D13). context-tree does not reimplement code
 * semantics — it orchestrates the tools that already do it, behind one
 * interface with a deterministic merge policy.
 */
import type { NodeId } from './ids.js';
import type { NodeKind } from './tree.js';

/**
 * Merge tiers. Order is fixed in v1 (§9.1, §19 Q6): structural hits are exact
 * edges, fuzzy hits are recall assistants, grep is the universal fallback —
 * except in `exhaustive` mode, where grep is authoritative.
 */
export type ProviderTier = 'structural' | 'fuzzy' | 'fallback';

export const TIER_ORDER: readonly ProviderTier[] = ['structural', 'fuzzy', 'fallback'] as const;

export interface SearchQuery {
  query: string;
  kind?: NodeKind;
  /** `ranked` = top-N (graft `ask`); `exhaustive` = complete (graft `grep`). */
  mode?: 'ranked' | 'exhaustive';
  limit?: number;
  /** Scope hint, e.g. a repo subdirectory or a graft scope prefix. */
  scope?: string;
}

export interface Candidate {
  /** Repo-relative path, when the hit is code. */
  path?: string;
  span?: { start_line: number; end_line: number };
  symbol?: string;
  /** L1 node, when the hit came from the tree itself (VectorProvider). */
  node_id?: NodeId;
  /** Provider-local score; comparable only within a provider. */
  score: number;
  provider: string;
  tier: ProviderTier;
  snippet?: string;
}

export interface Content {
  text: string;
  path?: string;
  span?: { start_line: number; end_line: number };
  provider: string;
  truncated: boolean;
}

export interface RetrievalProvider {
  readonly id: string;
  readonly tier: ProviderTier;
  /** Capability probe run at init (§9.1). Must never throw. */
  available(): Promise<boolean>;
  search(query: SearchQuery): Promise<Candidate[]>;
  hydrate(ref: Candidate): Promise<Content>;
}

export interface MergeResult {
  candidates: Candidate[];
  /** Provider provenance for the eval harness: which tier actually contributed. */
  contributions: Array<{ provider: string; tier: ProviderTier; kept: number; dropped: number }>;
  /** Providers that failed their probe or threw — degraded, never fatal. */
  unavailable: string[];
}
