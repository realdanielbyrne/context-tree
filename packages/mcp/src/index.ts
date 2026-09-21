/**
 * `@context-tree/mcp` — the pipeline as tools (§9): one registry, served to agents
 * over MCP stdio and to host plugins over loopback HTTP, plus the contract.
 *
 * The handlers are exported beside the server on purpose: §11's eval harness
 * runs its own tool-use loop, and an eval that called a different code path
 * would measure a surface the agent never sees.
 */
export { CONTRACT_PROMPT, SERVER_NAME, SERVER_VERSION, createServer, toolContext, type CreateServerOptions } from './server.js';
export { createHttpApi, type HttpApi, type HttpApiOptions } from './http.js';
export {
  PIPELINE_DEFAULTS,
  PIPELINE_ENV_KEYS,
  advanceTurn,
  createSession,
  pipelineFromEnv,
  sessionOf,
  sessionUnits,
  type PipelineDefaults,
  type Session,
  type SessionUnit,
} from './session.js';
export * from './tools/index.js';
export { fail, failFrom, ok, parseArgs, requireNode, toCallToolResult } from './result.js';
export { recordAnnotation, recordRetrieval, type AnnotationRecord } from './observe.js';
export {
  modeOf,
  type OperatingMode,
  type ToolContext,
  type ToolError,
  type ToolErrorCode,
  type ToolHandler,
  type ToolOutcome,
} from './types.js';

/**
 * §9's system-prompt contract, re-exported from its one versioned file in core
 * (§14: a learned edit policy replaces that file and nothing else). Tools
 * without it are tools an untrained model will not reliably use.
 */
export { TOOL_CONTRACT_RULES, systemContract } from '@context-tree/core';
