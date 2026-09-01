/**
 * The debugging view of L1: one line per node, in the store's creation order —
 * the same order §10 rule 1 requires for Zone B, so what this prints is the
 * order the model would see the branch summaries in.
 *
 * Staleness and summary version are on every line because those two fields are
 * what D3/D4 questions are actually asked about ("did the cascade mark this?",
 * "which version did the model see?").
 */
import type { NodeId, NodeKind, NodeStatus, PhaseType, Seq } from '@context-tree/core';
import { configFor, openExistingStore, type GlobalOptions } from '../context.js';
import { report, type Io } from '../io.js';

export type TreeOptions = GlobalOptions;

export interface TreeRow {
  id: NodeId;
  /** Root-relative depth, for indentation. */
  depth: number;
  kind: NodeKind;
  phase: PhaseType | null;
  spanStart: Seq | null;
  spanEnd: Seq | null;
  status: NodeStatus;
  summaryVersion: number;
  /** Seq content landed at after the last summary, or null when fresh (D4). */
  staleSinceSeq: Seq | null;
  title: string;
}

export interface TreeReport {
  root: string;
  nodes: TreeRow[];
}

export function treeCommand(opts: TreeOptions, io: Io): TreeReport {
  const config = configFor(opts);
  const handle = openExistingStore(config);
  try {
    const nodes: TreeRow[] = handle.store.nodesInCreationOrder().map((node) => ({
      id: node.id,
      depth: handle.store.ancestorPath(node.id).length - 1,
      kind: node.kind,
      phase: node.phase_type,
      spanStart: node.span_start_seq,
      spanEnd: node.span_end_seq,
      status: node.status,
      summaryVersion: node.current_summary_version,
      staleSinceSeq: node.stale_since_seq,
      title: node.title,
    }));
    const payload: TreeReport = { root: config.root, nodes };
    report(io, opts.json, payload, nodes.map(line));
    return payload;
  } finally {
    handle.close();
  }
}

function line(row: TreeRow): string {
  const kind = row.phase === null ? row.kind : `${row.kind}/${row.phase}`;
  const span = `[${row.spanStart ?? '-'}..${row.spanEnd ?? '-'}]`;
  const summary = row.summaryVersion === 0 ? 'v-' : `v${row.summaryVersion}`;
  const stale = row.staleSinceSeq === null ? 'fresh' : `stale@${row.staleSinceSeq}`;
  return `${'  '.repeat(row.depth)}${row.id}  ${kind}  ${span}  ${summary}  ${stale}  ${row.title}`;
}
