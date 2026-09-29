/**
 * The MCP transport over the tool registry, plus the system-prompt contract.
 *
 * Every pipeline stage is a tool (`tools/index.ts` TOOLS) and this file serves that
 * table; `http.ts` serves the same table to host plugins. Neither knows what any
 * tool does.
 *
 * The contract ships with the tools deliberately. There is no fine-tuning
 * anywhere (D7) — the tool schemas and this text ARE the policy, and a host
 * that installs the tools without the contract gets tools the model will not
 * reliably reach for. It goes out twice: as the server's `instructions` (which
 * hosts inject automatically) and as a named prompt a host can pull explicitly.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { systemContract, type SystemContractVersion, type ContextTreeConfig, type ProviderRegistry, type TaskStore, type TreeRetriever } from '@context-tree/core';
import { toCallToolResult } from './result.js';
import { createSession, type Session } from './session.js';
import { TOOLS, type ToolSpec } from './tools/index.js';
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
  /** Pipeline state. Pass the SAME session to `createHttpApi` so both transports share it. */
  session?: Session;
  /** The registry to serve. Defaults to `TOOLS`; `withHandlers` swaps a stage. */
  tools?: readonly ToolSpec[];
  /** Which contract text ships as `instructions`. `v4` describes the pipeline tools; default `v1`. */
  contract?: SystemContractVersion;
}

export function toolContext(options: CreateServerOptions): ToolContext {
  return {
    config: options.config,
    handle: options.handle,
    retriever: options.retriever,
    registry: options.registry,
    mode: options.mode ?? options.config.mode,
    session: options.session ?? createSession(),
  };
}

export function createServer(options: CreateServerOptions, shared?: ToolContext): McpServer {
  const ctx = shared ?? toolContext(options);

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: systemContract(options.contract) },
  );

  for (const tool of options.tools ?? TOOLS) {
    if (!tool.transports.includes('mcp')) continue;
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.inputShape, annotations: tool.annotations(ctx) },
      async (args: unknown) => toCallToolResult(await tool.handler(ctx, args)),
    );
  }

  server.registerPrompt(
    CONTRACT_PROMPT,
    {
      title: 'context-tree operating contract',
      description:
        'The §9 system-prompt contract: read-before-edit, follow summary metadata, peek when in doubt. Install it alongside the tools.',
    },
    () => ({
      messages: [{ role: 'user', content: { type: 'text', text: systemContract(options.contract) } }],
    }),
  );

  return server;
}
