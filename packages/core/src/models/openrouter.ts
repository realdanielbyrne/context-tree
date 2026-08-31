/**
 * §11 OpenRouter provider — the `openai` client with the base URL overridden,
 * same tool-schema shape, model ids from the OpenRouter catalog.
 *
 * Two honesty rules govern the usage mapping:
 *  - OpenAI-compatible `prompt_tokens` *includes* cached tokens, unlike
 *    Anthropic's `input_tokens`. Reporting both in full would double-charge
 *    every cached token in the §16 meter, so the cached count is subtracted out.
 *  - There is no upstream cache-*write* counter, so `cacheWrite` is a reported
 *    zero. An unknown reported as zero is honest; a fabricated number is not.
 */
import OpenAI from 'openai';
import type {
  ChatMessage,
  CompletionRequest,
  CompletionResult,
  ModelProvider,
  ToolCallRequest,
} from '../contracts/index.js';
import { ModelCallError } from '../contracts/index.js';
import { withRetry, type RetryOptions } from './retry.js';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/** Only the response fields this provider reads (see `AnthropicMessageLike`). */
export interface OpenRouterUsageLike {
  prompt_tokens: number;
  completion_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number | null } | null;
}

export interface OpenRouterToolCallLike {
  id: string;
  function?: { name?: string; arguments?: string } | null;
}

export interface OpenRouterChoiceLike {
  message: {
    content?: string | null;
    tool_calls?: readonly OpenRouterToolCallLike[] | null;
  };
  finish_reason?: string | null;
}

export interface OpenRouterCompletionLike {
  model: string;
  choices: readonly OpenRouterChoiceLike[];
  usage?: OpenRouterUsageLike | null;
}

export interface OpenRouterClientLike {
  chat: {
    completions: {
      create(
        params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
      ): Promise<OpenRouterCompletionLike>;
    };
  };
}

export interface OpenRouterProviderOptions {
  apiKey?: string;
  /** Injected in tests; a real client is constructed when absent. */
  client?: OpenRouterClientLike;
  retry?: RetryOptions;
  baseURL?: string;
}

export class OpenRouterProvider implements ModelProvider {
  readonly id = 'openrouter';
  private readonly client: OpenRouterClientLike;
  private readonly retry: RetryOptions;

  constructor(options: OpenRouterProviderOptions = {}) {
    this.client =
      options.client ??
      new OpenAI({ apiKey: options.apiKey, baseURL: options.baseURL ?? OPENROUTER_BASE_URL });
    this.retry = options.retry ?? {};
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const params = toParams(request);
    const response = await withRetry(() => this.client.chat.completions.create(params), {
      label: 'openrouter chat.completions.create',
      ...this.retry,
    });
    return fromOpenRouterResponse(response);
  }
}

function toParams(
  request: CompletionRequest,
): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming {
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  // The system prompt is Zone A (D5) and therefore the prefix — it goes first.
  // Its rule 5 breakpoint has no message to ride on, so it marks a text part of
  // the system message itself, the same way `cacheBreakpoint` marks one below.
  if (request.system !== undefined) {
    messages.push(
      request.systemCacheBreakpoint === true
        ? { role: 'system', content: [cachedTextPart(request.system)] }
        : { role: 'system', content: request.system },
    );
  }
  for (const message of request.messages) messages.push(toMessageParam(message));

  const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
    model: request.model,
    messages,
  };
  if (request.maxTokens !== undefined) params.max_tokens = request.maxTokens;
  if (request.temperature !== undefined) params.temperature = request.temperature;
  if (request.json === true) params.response_format = { type: 'json_object' };
  if (request.tools && request.tools.length > 0) {
    params.tools = request.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema as Record<string, unknown>,
      },
    }));
  }
  return params;
}

/**
 * OpenRouter forwards an Anthropic-style `cache_control` on a text part to the
 * providers that support it; the OpenAI types have no field for it, hence the
 * cast. §10 rule 5 / D5: the breakpoint has to reach the wire or it is lost.
 */
function cachedTextPart(text: string): OpenAI.Chat.Completions.ChatCompletionContentPartText {
  return {
    type: 'text',
    text,
    cache_control: { type: 'ephemeral' },
  } as OpenAI.Chat.Completions.ChatCompletionContentPartText;
}

function toMessageParam(
  message: ChatMessage,
): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  if (message.cacheBreakpoint !== true) {
    return { role: message.role, content: message.content };
  }
  const part = cachedTextPart(message.content);
  return message.role === 'assistant'
    ? { role: 'assistant', content: [part] }
    : { role: 'user', content: [part] };
}

function fromOpenRouterResponse(response: OpenRouterCompletionLike): CompletionResult {
  const choice = response.choices[0];
  if (choice === undefined) {
    throw new ModelCallError('openrouter returned no choices');
  }
  const cacheRead = response.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const promptTokens = response.usage?.prompt_tokens ?? 0;
  return {
    text: choice.message.content ?? '',
    model: response.model,
    usage: {
      input: Math.max(0, promptTokens - cacheRead),
      output: response.usage?.completion_tokens ?? 0,
      cacheRead,
      cacheWrite: 0,
    },
    toolCalls: (choice.message.tool_calls ?? []).map(toToolCall),
    stopReason: choice.finish_reason ?? null,
  };
}

function toToolCall(call: OpenRouterToolCallLike): ToolCallRequest {
  const raw = call.function?.arguments ?? '{}';
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch (error) {
    // Fail loud: a tool call whose arguments cannot be parsed is not a tool call.
    throw new ModelCallError(
      `openrouter tool call ${call.id} has unparseable arguments: ${(error as Error).message}`,
    );
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ModelCallError(`openrouter tool call ${call.id} arguments are not a JSON object`);
  }
  return { id: call.id, name: call.function?.name ?? '', input: input as Record<string, unknown> };
}
