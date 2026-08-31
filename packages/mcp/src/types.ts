/**
 * Shared shapes for the four §9 tool handlers.
 *
 * The handlers are plain functions over an explicit context rather than
 * closures the server owns, because §11's eval harness "implements its own
 * minimal tool-use loop" and must call the SAME handlers the MCP server
 * exposes — otherwise the eval measures a surface the agent never sees.
 */
import type { ContextTreeConfig, ProviderRegistry, TaskStore, TreeRetriever } from '@context-tree/core';

/** §9.2 / D14. Mode A (`tool-backend`) is the v1 default (§19 Q5). */
export type OperatingMode = ContextTreeConfig['mode'];

export interface ToolContext {
  config: ContextTreeConfig;
  /** L0 + L2 + L1 for one task. The read tools use L1/L2; Mode B also writes L0. */
  handle: TaskStore;
  retriever: TreeRetriever;
  /**
   * §9.1 fan-out. Absent means tree-only retrieval — `context_search` still
   * answers, which is the degradation §18's last row requires.
   */
  registry?: ProviderRegistry;
  /**
   * Overrides `config.mode`. Separable only because §15's Mode A/B arm builds
   * two contexts over one config; `createServer` defaults it to `config.mode`
   * so there is one source of truth in normal use.
   */
  mode?: OperatingMode;
}

/**
 * `unknown_node` / `unknown_file` are NORMAL model mistakes, not faults: the
 * model works from summaries and can name a node that has been rebuilt away.
 * They must reach it as a message it can act on, never as a protocol error.
 */
export type ToolErrorCode = 'invalid_input' | 'unknown_node' | 'unknown_file' | 'unavailable' | 'internal';

export interface ToolError {
  code: ToolErrorCode;
  message: string;
}

export type ToolOutcome<T> = { ok: true; data: T } | { ok: false; error: ToolError };

/** One uniform signature, so the eval harness can dispatch by tool name. */
export type ToolHandler = (ctx: ToolContext, input: unknown) => Promise<ToolOutcome<unknown>>;

export function modeOf(ctx: ToolContext): OperatingMode {
  return ctx.mode ?? ctx.config.mode;
}
