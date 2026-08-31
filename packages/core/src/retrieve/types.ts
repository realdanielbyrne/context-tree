/**
 * §9 read-side types — the shapes the three read tools (`context_search`,
 * `context_fetch`, `context_peek`) return.
 *
 * This module knows the TREE only. External backends (graft, Serena, Augment,
 * ripgrep) live in `providers/`; the MCP package wires the two together, which
 * is why nothing here imports a provider implementation.
 */
import type { NodeId, NodeKind, PhaseType, SeqSpan, SummaryMeta } from '../contracts/index.js';

/**
 * Injected embedder — in production a partially applied `ModelProvider.embed`
 * (§11). Injected rather than constructed so no code path in this module can
 * reach the network on its own (§7.1's hermeticity rule generalized: retrieval
 * answers questions with what it is given).
 */
export type SummaryEmbedder = (texts: readonly string[]) => Promise<Float32Array[]>;

/** Which mechanism produced a result set. §15's eval attributes recall per path. */
export type SearchPath = 'vector' | 'beam';

/** Why `search` skipped the vector path. */
export type BeamFallbackReason = 'no-embedder' | 'no-embeddings';

export interface SummaryHit {
  nodeId: NodeId;
  kind: NodeKind;
  title: string;
  phaseType: PhaseType | null;
  /** File nodes: the repo-relative path the node is keyed by. */
  path?: string;
  /** The summary version that was scored, or 0 when the node has none yet. */
  version: number;
  text: string;
  /** The §8 rehydration pointers, or null when the node has no summary yet. */
  meta: SummaryMeta | null;
  /** Higher is better. Comparable within one `SearchPath`, never across two. */
  score: number;
}

export interface TreeSearchOptions {
  /** Filters the returned hits; never the traversal (see `beamSearch`). */
  kind?: NodeKind;
  limit?: number;
  /** Beam width per level — beam path only. Defaults to `limit`. */
  beamWidth?: number;
}

export interface TreeSearchResult {
  hits: SummaryHit[];
  /** Reported so the eval harness attributes recall to the right mechanism. */
  path: SearchPath;
  /** Set only when `path === 'beam'` because the vector path was unavailable. */
  fallback?: BeamFallbackReason;
}

export interface FetchBranchOptions {
  depth?: 'summary' | 'full';
  /**
   * Narrows the read to the file node(s) under the branch keyed by this path
   * (§9's common case, §10 rule 4). Only those nodes' L0 spans are read.
   */
  file?: string;
}

export interface FetchedBranch {
  /** The branch that was requested. */
  nodeId: NodeId;
  kind: NodeKind;
  title: string;
  phaseType: PhaseType | null;
  depth: 'summary' | 'full';
  /** Path this content is scoped to: the `file` narrowing, or a file node's own path. */
  file?: string;
  text: string;
  /** Nodes whose content this result actually covers. */
  nodes: NodeId[];
  /** 0 when there is no summary yet (§8 summarizes async) or several nodes were merged. */
  summaryVersion: number;
  meta: SummaryMeta | null;
  /** L0 ranges read. Empty at depth `summary`, which touches L1 only. */
  spans: SeqSpan[];
  /** L0 events rendered. 0 at depth `summary`. */
  events: number;
}

export interface EmbedSummariesResult {
  /** Nodes written to L3, in the order they were embedded. */
  embedded: NodeId[];
  /** Nodes with no current summary to embed (§8 runs async), or all of them when no embedder was injected. */
  skipped: NodeId[];
  /** False when no embedder was injected — L3 stays absent and `search` uses the beam. */
  embedderAvailable: boolean;
}
