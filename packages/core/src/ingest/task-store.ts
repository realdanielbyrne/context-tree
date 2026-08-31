/**
 * The one on-disk entry point: opens (or creates) a task's whole layout from
 * `storePaths(config.root)` — L0 trace, L2 blobs, L1+L3 SQLite, the L4 views
 * directory — and returns them as a single handle.
 *
 * Every other package needs exactly these four things, and the hermetic
 * ingestion path (§7.1) needs only the first three: it reads L0 and L2 and
 * writes L1. Nothing here reaches the network.
 */
import { mkdirSync } from 'node:fs';
import type { ContextTreeConfig } from '../config.js';
import type { BlobStore, TraceLog, TreeStore } from '../contracts/index.js';
import { storePaths, type StorePaths } from '../paths.js';
import { FsBlobStore } from '../blobs/index.js';
import { JsonlTraceLog } from '../trace/index.js';
import { openStore } from '../store/index.js';

export interface TaskStore {
  readonly config: ContextTreeConfig;
  readonly paths: StorePaths;
  /** L0 — source of truth. */
  readonly trace: TraceLog;
  /** L2 — content-addressed payloads. */
  readonly blobs: BlobStore;
  /** L1 + L3 — derived from L0 + L2 (D8). */
  readonly store: TreeStore;
  close(): void;
}

export function openTaskStore(config: ContextTreeConfig): TaskStore {
  const paths = storePaths(config.root);
  mkdirSync(paths.root, { recursive: true });
  // L4 exists as a directory before anything renders into it, so a renderer
  // never has to decide whether it is allowed to create the layout.
  mkdirSync(paths.views, { recursive: true });

  const trace = new JsonlTraceLog(paths.trace);
  const blobs = new FsBlobStore(paths.blobs);
  // Opened last and unguarded: a schema-version refusal must propagate (D8
  // answers a schema change with a rebuild, never a migration), and the two
  // layers above hold no OS handle that could leak when it does.
  const store = openStore(paths.db);

  return {
    config,
    paths,
    trace,
    blobs,
    store,
    close(): void {
      store.close();
      trace.close();
    },
  };
}
