/**
 * L1 — tree store types (plan §6). Typed node kinds + lateral links (D10).
 *
 * Two invariants live in code, not SQL:
 *  - `parent_id` forms a forest with exactly one root per task DB.
 *  - a node's content is its `span_*_seq` range over L0; message text is never
 *    inlined here.
 */
import type { NodeId, Seq } from './ids.js';

export type NodeKind = 'task' | 'phase' | 'file' | 'turn';

export type PhaseType =
  | 'diagnosis'
  | 'implementation'
  | 'verification'
  | 'delivery'
  | 'review'
  | 'other';

export const PHASE_TYPES: readonly PhaseType[] = [
  'diagnosis',
  'implementation',
  'verification',
  'delivery',
  'review',
  'other',
] as const;

export type NodeStatus = 'open' | 'closed' | 'superseded';

export type LinkKind = 'superseded_by' | 'relates_to' | 'blocks';

/** An exact source range, the unit that makes rehydration pointers trustworthy (D9). */
export interface SymbolSpan {
  path: string;
  /** 1-based, inclusive. */
  start_line: number;
  /** 1-based, inclusive. */
  end_line: number;
  /** Enclosing named symbol, when a grammar was available. */
  symbol?: string;
  /** tree-sitter node type, e.g. `function_declaration`. */
  kind?: string;
  /** True when this span is a raw diff hunk because no grammar was available (§12). */
  degraded?: boolean;
}

/** A note written by the `annotate` tool (plan §9; Ruling C10). */
export interface Annotation {
  /** L0 seq current when the note was written. */
  seq: Seq;
  text: string;
  created_at: string;
}

/**
 * Provenance-stamped output of the optional enrichment post-pass (plan §7.1).
 * Nothing structural may depend on these fields; they are dropped on rebuild.
 */
export interface EnrichmentRecord {
  provider: string;
  timestamp: string;
  index_version?: string;
  kind: string;
  data: unknown;
}

/** Parsed `nodes.meta_json`. Additive by design — unknown keys survive round-trips. */
export interface NodeMeta {
  /** File nodes: the repo-relative path this node is keyed by. */
  path?: string;
  /** §12 output: exact spans touched by edits under this node. */
  spans?: SymbolSpan[];
  /** §12 output: symbol names touched. */
  symbols?: string[];
  /** Tool names observed under this node, in first-seen order. */
  tools?: string[];
  annotations?: Annotation[];
  enrichment?: EnrichmentRecord[];
  [key: string]: unknown;
}

export interface TreeNode {
  id: NodeId;
  parent_id: NodeId | null;
  kind: NodeKind;
  title: string;
  phase_type: PhaseType | null;
  span_start_seq: Seq | null;
  span_end_seq: Seq | null;
  status: NodeStatus;
  current_summary_version: number;
  /** Set when content landed under this node after its last summary (D4). */
  stale_since_seq: Seq | null;
  meta_json: NodeMeta;
}

export interface NewNode {
  id?: NodeId;
  parent_id: NodeId | null;
  kind: NodeKind;
  title: string;
  phase_type?: PhaseType | null;
  span_start_seq?: Seq | null;
  span_end_seq?: Seq | null;
  status?: NodeStatus;
  meta_json?: NodeMeta;
}

export type NodePatch = Partial<
  Pick<
    TreeNode,
    'parent_id' | 'title' | 'phase_type' | 'span_start_seq' | 'span_end_seq' | 'status' | 'meta_json'
  >
>;

export interface TestOutcome {
  name: string;
  status: 'passed' | 'failed' | 'skipped' | 'unknown';
  detail?: string;
}

export interface ExternalArtifact {
  kind: 'ticket' | 'pr' | 'url' | 'other';
  ref: string;
  title?: string;
}

/**
 * The §8 summary content contract — the rehydration-pointer requirement.
 * Every field is mandatory (possibly empty) so relevance is detectable from
 * the summary alone; this is the mitigation for the unknown-unknowns failure
 * mode in §9.
 */
export interface SummaryMeta {
  files: SymbolSpan[];
  symbols: string[];
  tests: TestOutcome[];
  artifacts: ExternalArtifact[];
  open_questions: string[];
  decisions: string[];
  /** Child node ids this summary covers — the fetch targets. */
  node_ids: NodeId[];
}

export interface NodeSummary {
  node_id: NodeId;
  version: number;
  model: string;
  text: string;
  meta: SummaryMeta;
  created_at: string;
}

export interface NewSummary {
  node_id: NodeId;
  model: string;
  text: string;
  meta: SummaryMeta;
  created_at?: string;
}

export interface NodeLink {
  from_id: NodeId;
  to_id: NodeId;
  kind: LinkKind;
  created_at: string;
}

export interface EmbeddingHit {
  node_id: NodeId;
  version: number;
  distance: number;
}
