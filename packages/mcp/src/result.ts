/**
 * Every handler returns a structured outcome; nothing throws across the
 * protocol boundary (§9's failure-mode design). A crash costs the host the
 * session, while a named error costs the model one retry — and the two
 * commonest failures here (a stale node id, a file the branch never touched)
 * are expected model mistakes, not bugs.
 */
import { ContextTreeError, type NodeId, type TreeNode } from '@context-tree/core';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ZodError, ZodType } from 'zod';
import type { ToolContext, ToolErrorCode, ToolOutcome } from './types.js';

export function ok<T>(data: T): ToolOutcome<T> {
  return { ok: true, data };
}

export function fail(code: ToolErrorCode, message: string): ToolOutcome<never> {
  return { ok: false, error: { code, message } };
}

function issuesOf(error: ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length === 0 ? '(root)' : issue.path.join('.')}: ${issue.message}`)
    .join('; ');
}

/**
 * Validation lives in the handler, not only in the MCP tool schema: the eval
 * harness's own tool-use loop calls handlers directly, so a schema-only check
 * would leave the measured path unvalidated.
 */
export function parseArgs<T>(schema: ZodType<T>, input: unknown): ToolOutcome<T> {
  const result = schema.safeParse(input);
  if (result.success) return ok(result.data);
  return fail('invalid_input', issuesOf(result.error));
}

/**
 * Resolves a node id the model supplied. The message names the id and the
 * argument it came from, and points at `context_search`, because the model's
 * only route back to a valid id is a search over summaries (§9).
 */
export function requireNode(ctx: ToolContext, field: string, id: NodeId): ToolOutcome<TreeNode> {
  const node = ctx.handle.store.getNode(id);
  if (node !== null) return ok(node);
  return fail(
    'unknown_node',
    `${field} ${JSON.stringify(id)} is not a node in this task tree. Node ids change when the tree is rebuilt — call context_search to get current ones.`,
  );
}

/** Core error codes that describe a *configuration* gap rather than a fault. */
const DEGRADED_CODES: readonly string[] = ['E_RETRIEVE_NO_TRACE', 'E_RETRIEVE_NO_EMBEDDER'];

/** Last-resort mapper for anything a core call throws after input validation passed. */
export function failFrom(error: unknown): ToolOutcome<never> {
  if (error instanceof ContextTreeError) {
    if (error.code === 'E_RETRIEVE_NO_FILE_NODE') return fail('unknown_file', error.message);
    if (DEGRADED_CODES.includes(error.code)) return fail('unavailable', error.message);
    return fail('internal', `${error.code}: ${error.message}`);
  }
  return fail('internal', error instanceof Error ? error.message : String(error));
}

/**
 * Handler outcome -> MCP wire result. One compact JSON block, deliberately:
 * the handler's `data` is what the eval harness scores, so what the model reads
 * and what the harness measures stay byte-identical. `isError` is how a tool
 * failure reaches the model as content it can act on.
 */
export function toCallToolResult(outcome: ToolOutcome<unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(outcome.ok ? outcome.data : outcome.error) }],
    isError: !outcome.ok,
  };
}
