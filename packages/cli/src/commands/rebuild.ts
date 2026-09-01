/**
 * §5's rebuild rule, as a command: L1/L3/L4 are always deterministic functions
 * of L0 + L2 (D8), so a segmenter or prompt change is answered by deleting the
 * derived layers and replaying — never by migrating L1.
 *
 * It asks first. Deleting L1 is cheap (a replay of L0 rebuilds it in ms), but
 * L3 embeddings go with it and those cost real money to regenerate, so the
 * destructive half needs `--yes` rather than a habit-formed default.
 */
import { existsSync } from 'node:fs';
import {
  DERIVED_LAYERS,
  rebuild,
  storePaths,
  type IngestStats,
} from '@context-tree/core';
import { configFor, type GlobalOptions } from '../context.js';
import { CliError } from '../errors.js';
import { report, type Io } from '../io.js';

export interface RebuildOptions extends GlobalOptions {
  /** Required: the run deletes L3 embeddings along with L1 and L4. */
  yes?: boolean;
}

export interface RebuildReport {
  root: string;
  /** Derived-layer paths that existed and were deleted. */
  deleted: string[];
  stats: IngestStats;
}

export function rebuildCommand(opts: RebuildOptions, io: Io): RebuildReport {
  const config = configFor(opts);
  const paths = storePaths(config.root);
  if (!existsSync(paths.trace)) {
    throw new CliError(`no L0 trace at ${paths.trace} — there is nothing to rebuild from`);
  }

  const present = DERIVED_LAYERS.map((layer) => paths[layer]).filter((path) => existsSync(path));
  if (opts.yes !== true) {
    throw new CliError(
      `refusing to rebuild without --yes: this deletes ${describe(present)} and the L3 ` +
        'embeddings inside the database, which cost money to regenerate (L0 and L2 are never touched)',
    );
  }

  const result = rebuild(config);
  try {
    const payload: RebuildReport = { root: config.root, deleted: present, stats: result.stats };
    report(io, opts.json, payload, humanLines(payload));
    return payload;
  } finally {
    result.handle.close();
  }
}

function describe(paths: readonly string[]): string {
  return paths.length === 0 ? 'the derived layers (none present yet)' : paths.join(', ');
}

function humanLines(payload: RebuildReport): string[] {
  const lines = payload.deleted.map((path) => `deleted ${path}`);
  lines.push(
    `rebuilt from ${payload.stats.events} L0 event(s): ${payload.stats.nodes} node(s), ` +
      `${payload.stats.phases} phase(s), ${payload.stats.fileNodes} file node(s), ` +
      `${payload.stats.spans} span(s)`,
  );
  if (payload.stats.degradedFiles > 0) {
    lines.push(`${payload.stats.degradedFiles} file node(s) got no grammar-backed spans`);
  }
  return lines;
}
