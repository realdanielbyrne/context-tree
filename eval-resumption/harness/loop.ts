/**
 * The harness's own minimal tool-use loop (§11: "the eval harness implements
 * its own minimal tool-use loop so tests don't depend on any host").
 *
 * request -> tool calls -> tool results -> repeat, until the model stops or the
 * step cap trips. Every tool call is recorded with its arguments and latency,
 * because §15's tool-call count and `context_peek` precision are computed from
 * exactly this record and nowhere else.
 *
 * The loop is provider-shaped, not host-shaped: it speaks `ModelProvider` and a
 * `ToolBinding`, so arm D binds the four handlers `@context-tree/mcp` exports —
 * the same objects the MCP server registers.
 */
import type {
  ChatMessage,
  CompletionRequest,
  ModelProvider,
  TokenUsage,
  ToolSchema,
} from '@context-tree/core';
import { ZERO_USAGE, addUsage } from '@context-tree/core';
import type { ToolOutcome } from '@context-tree/mcp';

export interface ToolBinding {
  /** Advertised to the model verbatim; arm D's are the §9 four. */
  schemas: readonly ToolSchema[];
  invoke(name: string, input: Record<string, unknown>): Promise<ToolOutcome<unknown>>;
}

/** Why the loop ended. `step-cap` is a measured outcome, never an error. */
export type LoopStop = 'stop' | 'step-cap' | 'no-tools';

export interface ToolCallRecord {
  /** 1-based model turn that issued this call. */
  step: number;
  id: string;
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  errorCode?: string;
  latencyMs: number;
  resultChars: number;
  /**
   * Top-level scalar fields of the tool's result (`path`, `fallback`,
   * `summary_version`, `truncated`, …). Scalars only: the full text of a
   * fetched branch is megabytes across a run, and every §15 metric that reads a
   * result reads one of these fields.
   */
  digest: Record<string, string | number | boolean | null>;
}

export interface ToolLoopOptions {
  provider: ModelProvider;
  /** The arm's initial request. Mutated only by copy — the caller keeps its own. */
  request: CompletionRequest;
  /** Omit for the arms with no tools (A, B, C). */
  tools?: ToolBinding;
  /** Hard cap on model turns. §15 measures how often it trips. */
  maxSteps: number;
  /** Injected clock, in milliseconds. Defaults to `performance.now`. */
  now?: () => number;
}

export interface ToolLoopResult {
  steps: number;
  finalText: string;
  stopReason: string | null;
  stoppedBy: LoopStop;
  toolCalls: ToolCallRecord[];
  /** Summed across every model call — MEASURED, straight from the provider. */
  usage: TokenUsage;
  modelLatenciesMs: number[];
  /** Wall time of the whole loop: model calls plus tool calls. */
  totalLatencyMs: number;
  /** The full message list as sent on the final turn. */
  messages: ChatMessage[];
}

function digestOf(data: unknown): Record<string, string | number | boolean | null> {
  const digest: Record<string, string | number | boolean | null> = {};
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return digest;
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (value === null || typeof value === 'number' || typeof value === 'boolean') {
      digest[key] = value;
    } else if (typeof value === 'string' && value.length <= 120) {
      digest[key] = value;
    }
  }
  return digest;
}

/** The model's turn, replayed into the transcript so the next turn is coherent. */
function assistantMessage(text: string, calls: readonly { name: string; input: unknown }[]): string {
  const lines = text.trim().length > 0 ? [text.trim()] : [];
  for (const call of calls) lines.push(`[tool_use ${call.name} ${JSON.stringify(call.input)}]`);
  // Providers reject an empty assistant turn; a model that emitted neither text
  // nor a call has said nothing, and the transcript should say exactly that.
  return lines.length === 0 ? '(no output)' : lines.join('\n');
}

export async function runToolLoop(options: ToolLoopOptions): Promise<ToolLoopResult> {
  if (options.maxSteps < 1) throw new Error(`maxSteps must be >= 1, got ${String(options.maxSteps)}`);
  const now = options.now ?? ((): number => performance.now());
  const started = now();

  const messages: ChatMessage[] = [...options.request.messages];
  const toolCalls: ToolCallRecord[] = [];
  const modelLatenciesMs: number[] = [];
  let usage: TokenUsage = ZERO_USAGE;
  let finalText = '';
  let stopReason: string | null = null;
  let stoppedBy: LoopStop = 'step-cap';
  let steps = 0;

  while (steps < options.maxSteps) {
    steps += 1;
    const request: CompletionRequest = { ...options.request, messages: [...messages] };
    if (options.tools !== undefined) request.tools = options.tools.schemas;

    const callStarted = now();
    const result = await options.provider.complete(request);
    modelLatenciesMs.push(now() - callStarted);

    usage = addUsage(usage, result.usage);
    stopReason = result.stopReason;
    if (result.text.trim().length > 0) finalText = result.text;

    if (result.toolCalls.length === 0) {
      stoppedBy = 'stop';
      break;
    }
    if (options.tools === undefined) {
      // Arms A–C advertise no tools. A model that calls one anyway has ended
      // its turn on something this arm cannot answer; recording that is the
      // point, and inventing a tool result would fabricate the arm's behaviour.
      stoppedBy = 'no-tools';
      break;
    }

    messages.push({ role: 'assistant', content: assistantMessage(result.text, result.toolCalls) });

    const rendered: string[] = [];
    for (const call of result.toolCalls) {
      const toolStarted = now();
      const outcome = await options.tools.invoke(call.name, call.input);
      const latencyMs = now() - toolStarted;
      const payload = JSON.stringify(outcome.ok ? outcome.data : outcome.error);
      const record: ToolCallRecord = {
        step: steps,
        id: call.id,
        name: call.name,
        args: call.input,
        ok: outcome.ok,
        latencyMs,
        resultChars: payload.length,
        digest: digestOf(outcome.ok ? outcome.data : outcome.error),
      };
      if (!outcome.ok) record.errorCode = outcome.error.code;
      toolCalls.push(record);
      rendered.push(`[tool_result ${call.name} ${call.id}]\n${payload}`);
    }
    messages.push({ role: 'user', content: rendered.join('\n\n') });
  }

  return {
    steps,
    finalText,
    stopReason,
    stoppedBy,
    toolCalls,
    usage,
    modelLatenciesMs,
    totalLatencyMs: now() - started,
    messages,
  };
}
