/** On-disk layout of one task's store. Everything below `root` is derived from L0+L2. */
import { join } from 'node:path';

export interface StorePaths {
  root: string;
  /** L0 — append-only event log. */
  trace: string;
  /** L2 — content-addressed blobs. */
  blobs: string;
  /** L1 + L3 — SQLite. */
  db: string;
  /** L4 — generated markdown views. */
  views: string;
  /** Recorded model completions for offline contract tests (§17). */
  recorded: string;
}

export function storePaths(root: string): StorePaths {
  return {
    root,
    trace: join(root, 'trace.jsonl'),
    blobs: join(root, 'blobs'),
    db: join(root, 'tree.db'),
    views: join(root, 'views'),
    recorded: join(root, 'recorded'),
  };
}

/** Layers that a rebuild deletes and regenerates (D8). L0 and L2 are never touched. */
export const DERIVED_LAYERS: readonly (keyof StorePaths)[] = ['db', 'views'] as const;
