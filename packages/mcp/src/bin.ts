#!/usr/bin/env node
/**
 * stdio entry point.
 *
 * stdout IS the transport: one stray `console.log` frames as garbage and
 * corrupts the session, so every diagnostic here goes to stderr and nothing in
 * this file writes to stdout.
 */
import { TreeRetriever, loadConfig, openTaskStore, type TaskStore } from '@context-tree/core';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

function log(message: string): void {
  process.stderr.write(`context-tree-mcp: ${message}\n`);
}

async function main(): Promise<void> {
  const config = loadConfig(process.cwd());
  const handle: TaskStore = openTaskStore(config);

  /**
   * No embedder is wired here, so `context_search` runs the §9 beam fallback
   * over summary text. That is deliberate for v1: no `ModelProvider` implements
   * `embed` yet (§19 Q1 defers the embedding default to M6), and it keeps the
   * stdio server free of network calls. A host with an embedder builds its own
   * `TreeRetriever` and calls `createServer`.
   */
  const retriever = new TreeRetriever({ store: handle.store, blobs: handle.blobs, trace: handle.trace });
  const server = createServer({ config, handle, retriever, mode: config.mode });

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    log(`${signal}: closing`);
    void server.close().finally(() => {
      handle.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await server.connect(new StdioServerTransport());
  log(`ready (root=${config.root}, mode=${config.mode})`);
}

main().catch((error: unknown) => {
  log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
