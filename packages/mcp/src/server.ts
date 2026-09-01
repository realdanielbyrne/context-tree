/**
 * The §9 MCP surface: four tools plus the system-prompt contract.
 *
 * The contract ships with the tools deliberately. There is no fine-tuning
 * anywhere (D7) — the tool schemas and this text ARE the policy, and a host
 * that installs the tools without the contract gets tools the model will not
 * reliably reach for. It goes out twice: as the server's `instructions` (which
 * hosts inject automatically) and as a named prompt a host can pull explicitly.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { systemContract, type ContextTreeConfig, type ProviderRegistry, type TaskStore, type TreeRetriever } from '@context-tree/core';
import { toCallToolResult } from './result.js';
import {
  ANNOTATE,
  ANNOTATE_DESCRIPTION,
  CONTEXT_FETCH,
  CONTEXT_FETCH_DESCRIPTION,
  CONTEXT_PEEK,
  CONTEXT_PEEK_DESCRIPTION,
  CONTEXT_SEARCH,
  CONTEXT_SEARCH_DESCRIPTION,
  annotate,
  annotateInputShape,
  contextFetch,
  contextFetchInputShape,
  contextPeek,
  contextPeekInputShape,
  contextSearch,
  contextSearchInputShape,
} from './tools/index.js';
import type { OperatingMode, ToolContext } from './types.js';

export const SERVER_NAME = 'context-tree';
export const SERVER_VERSION = '0.1.0';

/** MCP prompt id for the §9 contract. */
export const CONTRACT_PROMPT = 'context_tree_contract';

export interface CreateServerOptions {
  config: ContextTreeConfig;
  handle: TaskStore;
  retriever: TreeRetriever;
  /** §9.1 fan-out. Omit for tree-only retrieval. */
  registry?: ProviderRegistry;
  /** Defaults to `config.mode` — D14's gate has one source of truth. */
  mode?: OperatingMode;
}

export function createServer(options: CreateServerOptions): McpServer {
  const mode: OperatingMode = options.mode ?? options.config.mode;
  const ctx: ToolContext = {
    config: options.config,
    handle: options.handle,
    retriever: options.retriever,
    registry: options.registry,
    mode,
  };

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: systemContract() },
  );

  /**
   * Mode A's read tools touch nothing; Mode B appends a `tool_call` +
   * `tool_result` pair to L0 per retrieval (D14). The hint has to follow the
   * mode or it is a lie a host may cache on.
   */
  const readOnly = mode === 'tool-backend';

  server.registerTool(
    CONTEXT_FETCH,
    {
      title: 'Fetch a branch',
      description: CONTEXT_FETCH_DESCRIPTION,
      inputSchema: contextFetchInputShape,
      annotations: { readOnlyHint: readOnly, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toCallToolResult(await contextFetch(ctx, args)),
  );

  server.registerTool(
    CONTEXT_SEARCH,
    {
      title: 'Search branch summaries',
      description: CONTEXT_SEARCH_DESCRIPTION,
      inputSchema: contextSearchInputShape,
      annotations: {
        readOnlyHint: readOnly,
        idempotentHint: true,
        // §9.1 providers shell out to graft/ripgrep and call the Augment API.
        openWorldHint: options.registry !== undefined,
      },
    },
    async (args) => toCallToolResult(await contextSearch(ctx, args)),
  );

  server.registerTool(
    CONTEXT_PEEK,
    {
      title: 'Peek at a node',
      description: CONTEXT_PEEK_DESCRIPTION,
      inputSchema: contextPeekInputShape,
      annotations: { readOnlyHint: readOnly, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toCallToolResult(await contextPeek(ctx, args)),
  );

  server.registerTool(
    ANNOTATE,
    {
      title: 'Annotate a node',
      description: ANNOTATE_DESCRIPTION,
      inputSchema: annotateInputShape,
      annotations: {
        readOnlyHint: false,
        // Summaries are versioned and never overwritten (D3); a note appends.
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) => toCallToolResult(await annotate(ctx, args)),
  );

  server.registerPrompt(
    CONTRACT_PROMPT,
    {
      title: 'context-tree operating contract',
      description:
        'The §9 system-prompt contract: read-before-edit, follow summary metadata, peek when in doubt. Install it alongside the tools.',
    },
    () => ({
      messages: [{ role: 'user', content: { type: 'text', text: systemContract() } }],
    }),
  );

  return server;
}
