/**
 * §7 segmentation — a pure function from L0 events to tree operations.
 *
 * Purity is the point: D1 requires O(n), zero LLM calls, and bit-identical
 * output across runs. Emitting *ops* rather than writing to the store keeps the
 * state machine snapshot-testable and keeps ULID minting (non-deterministic) in
 * `ingest/`, where it belongs.
 */
import type { Seq } from './ids.js';
import type { NodeKind, PhaseType } from './tree.js';

/**
 * A stable, deterministic handle for a node within one segmentation run.
 * `ingest/` maps keys to ULIDs. Same trace + same config => same keys.
 */
export type NodeKey = string;

export type TreeOp =
  | {
      op: 'open';
      key: NodeKey;
      parent: NodeKey | null;
      kind: NodeKind;
      title: string;
      phase_type: PhaseType | null;
      start_seq: Seq;
      /** File nodes: the path this node is keyed by. */
      path?: string;
    }
  | { op: 'extend'; key: NodeKey; seq: Seq }
  | { op: 'close'; key: NodeKey; end_seq: Seq }
  /** Records a tool name observed under a node, for `meta_json.tools`. */
  | { op: 'tool'; key: NodeKey; tool: string };

export interface SegmentStats {
  events: number;
  phases: number;
  fileNodes: number;
  /** Tool names with no `toolPhase` mapping — routed to `other`, never a crash (§18). */
  unmappedTools: string[];
  /** True when the text-segmentation fallback ran (no tool calls present). */
  usedTextFallback: boolean;
}

export interface Segmentation {
  ops: TreeOp[];
  /** Keys in the order they were first opened — Zone B's order source (§10). */
  nodeOrder: NodeKey[];
  stats: SegmentStats;
}

export interface SegmentConfig {
  /** Tool name -> phase. Config-remappable because names differ per harness. */
  toolPhase: Readonly<Record<string, PhaseType>>;
  /**
   * Phases that attach to the open phase instead of opening a new one
   * (Ruling C6). Default `['other']`; `[]` restores the literal §7 rule.
   */
  neutralPhases: readonly PhaseType[];
  /** Tools whose `path` argument creates a file node under the phase. */
  fileTools: readonly string[];
  /** Title for the single task root. */
  taskTitle: string;
}
