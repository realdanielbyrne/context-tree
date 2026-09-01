/**
 * L4 — the generated markdown view (§6). Render-only: the output is a function
 * of L1, so it is regenerated and diffed, never hand-edited (D8). That is also
 * why nothing here adds a timestamp or a header of its own — two runs over an
 * unchanged tree must produce identical bytes.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { renderTask, writeTaskView, StoreInvariantError } from '@context-tree/core';
import { configFor, cwdOf, openExistingStore, type GlobalOptions } from '../context.js';
import { CliError } from '../errors.js';
import { report, type Io } from '../io.js';

export interface RenderOptions extends GlobalOptions {
  /** Write the view to this file instead of stdout. */
  out?: string;
  /** Write it to the store's own L4 directory (`<root>/views/<rootId>.md`). */
  views?: boolean;
}

export interface RenderReport {
  root: string;
  /** Files written; empty when the view went to stdout. */
  written: string[];
  chars: number;
  markdown: string;
}

export function renderCommand(opts: RenderOptions, io: Io): RenderReport {
  const config = configFor(opts);
  const handle = openExistingStore(config);
  try {
    let markdown: string;
    try {
      markdown = renderTask(handle.store);
    } catch (error) {
      // An empty L1 is a state, not a crash: it means nothing has been ingested
      // or a rebuild is pending.
      if (error instanceof StoreInvariantError) throw new CliError(error.message);
      throw error;
    }

    const written: string[] = [];
    if (opts.views === true) written.push(writeTaskView(handle.store, handle.paths.views));
    if (opts.out !== undefined) {
      const out = resolve(cwdOf(opts), opts.out);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, markdown, 'utf8');
      written.push(out);
    }

    const payload: RenderReport = {
      root: config.root,
      written,
      chars: markdown.length,
      markdown,
    };
    report(
      io,
      opts.json,
      payload,
      // With no destination the view *is* the output; with one, the paths are.
      written.length === 0 ? [markdown.trimEnd()] : written.map((path) => `wrote ${path}`),
    );
    return payload;
  } finally {
    handle.close();
  }
}
