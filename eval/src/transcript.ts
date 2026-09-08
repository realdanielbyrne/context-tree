import type { ToolCallRequest } from '@context-tree/core';
import type { ToolCallOutcome } from './tools.js';

export const TOOL_RESULT_TRANSCRIPT_VERSION = 'tool-result-call-v1';

/** Keep action metadata with its result even when the adjacent assistant text is empty or omitted. */
export function renderToolResult(call: ToolCallRequest, outcome: ToolCallOutcome): string {
  const action = JSON.stringify({ id: call.id, name: call.name, input: call.input, isError: outcome.isError });
  return `[tool_result ${call.name}]\n[call] ${action}\n[output] ${outcome.isError ? 'ERROR: ' : ''}${outcome.output}`;
}
