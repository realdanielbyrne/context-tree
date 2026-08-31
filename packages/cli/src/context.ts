/**
 * Shared resolution for every subcommand: which config, which store root.
 *
 * `cwd` is an explicit option rather than an implicit `process.cwd()` read so a
 * test can drive a command against a temp directory without chdir'ing the whole
 * process — the same seam the store's own tests use.
 */
import { existsSync } from 'node:fs';
import {
  loadConfig,
  openTaskStore,
  resolveConfig,
  storePaths,
  type ContextTreeConfig,
  type TaskStore,
} from '@context-tree/core';
import { CliError } from './errors.js';

export interface GlobalOptions {
  /** Store root; overrides `root` from `context-tree.config.json`. */
  root?: string;
  /** Machine-readable output: one JSON document on stdout. */
  json?: boolean;
  /** Directory the config is read from and relative paths resolve against. */
  cwd?: string;
}

export function cwdOf(opts: GlobalOptions): string {
  return opts.cwd ?? process.cwd();
}

export function configFor(opts: GlobalOptions): ContextTreeConfig {
  const cwd = cwdOf(opts);
  const config = loadConfig(cwd);
  if (opts.root === undefined) return config;
  // Re-resolving (rather than assigning `root`) keeps the flag on the same
  // validation path as the file, so a bad value fails here instead of at the
  // first store write.
  return resolveConfig({ ...config, root: opts.root }, cwd);
}

/**
 * Opens a store that already exists. `openTaskStore` would happily create an
 * empty one, and a command that reported an empty tree for a mistyped `--root`
 * would be reporting a lie as an answer (Rule 8: fail loud).
 */
export function openExistingStore(config: ContextTreeConfig): TaskStore {
  if (!existsSync(storePaths(config.root).trace)) {
    throw new CliError(
      `no context-tree store at ${config.root} — import a trace first: ` +
        `context-tree import <trace.jsonl> --root ${config.root}`,
    );
  }
  return openTaskStore(config);
}
