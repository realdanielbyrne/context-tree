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
import { EmptyCompletionError, ModelCallError } from '../contracts/index.js';
import { withRetry, type RetryOptions } from './retry.js';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/** Only the response fields this provider reads (see `AnthropicMessageLike`). */
export interface OpenRouterUsageLike {
  prompt_tokens: number;
  completion_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number | null } | null;
  /** Reasoning tokens are billed as completion tokens; read to explain an empty answer. */
  completion_tokens_details?: { reasoning_tokens?: number | null } | null;
}

export interface OpenRouterToolCallLike {
  id: string;
  function?: { name?: string; arguments?: string } | null;
}

export interface OpenRouterChoiceLike {
  message: {
    content?: string | null;
    /**
     * Where a reasoning model puts its thinking. Read only to explain an empty
     * `content`, never returned as the answer — the caller asked for an answer.
     */
    reasoning?: string | null;
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
        options?: { maxRetries?: number },
      ): Promise<OpenRouterCompletionLike>;
    };
  };
}

export interface OpenRouterProviderOptions {
  apiKey?: string;
  /** Injected in tests; a real client is constructed when absent. */
  client?: OpenRouterClientLike;
  retry?: RetryOptions;
  /** SDK retries per wrapper attempt; omitted preserves the SDK default. */
  sdkMaxRetries?: number;
  /**
   * Per-request timeout. The SDK default is 10 MINUTES, which is the wrong
   * shape for this workload: an agent turn on a 25 KB request either answers in
   * seconds or never, so a 10-minute wait buys nothing and a 3-attempt policy
   * spends 30 minutes discovering the provider is unresponsive. Observed: the
   * loop3 attn-control arm managed 4 turns in 26 minutes before exhausting its
   * attempts. Fail fast and retry more instead.
   */
  timeoutMs?: number;
  baseURL?: string;
}

export class OpenRouterProvider implements ModelProvider {
  readonly id = 'openrouter';
  private readonly client: OpenRouterClientLike;
  private readonly retry: RetryOptions;
  private readonly sdkRequestOptions: { maxRetries: number } | undefined;

  constructor(options: OpenRouterProviderOptions = {}) {
    if (options.sdkMaxRetries !== undefined && (!Number.isSafeInteger(options.sdkMaxRetries) || options.sdkMaxRetries < 0)) {
      throw new RangeError('sdkMaxRetries must be a nonnegative integer');
    }
    if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)) {
      throw new RangeError('timeoutMs must be a positive integer');
    }
    this.sdkRequestOptions = options.sdkMaxRetries === undefined ? undefined : { maxRetries: options.sdkMaxRetries };
    this.client =
      options.client ??
      new OpenAI({ apiKey: options.apiKey, baseURL: options.baseURL ?? OPENROUTER_BASE_URL,
        maxRetries: options.sdkMaxRetries,
        ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }) });
    this.retry = options.retry ?? {};
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const params = toParams(request);
    const response = await withRetry(() => this.client.chat.completions.create(params, this.sdkRequestOptions), {
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
  // `?.` matters: an error body has no `choices` key at all, and indexing
  // undefined throws before the guard can name the real problem. Cost 14/60
  // runs in the first scored transplant batch.
  const choice = response.choices?.[0];
  if (choice === undefined) {
    throw new ModelCallError('openrouter returned no choices');
  }
  const cacheRead = response.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const promptTokens = response.usage?.prompt_tokens ?? 0;
  const usageKnown = response.usage != null
    && Number.isSafeInteger(response.usage.prompt_tokens) && response.usage.prompt_tokens >= 0
    && Number.isSafeInteger(response.usage.completion_tokens) && response.usage.completion_tokens >= 0
    && Number.isSafeInteger(cacheRead) && cacheRead >= 0 && cacheRead <= promptTokens;
  const text = choice.message.content ?? '';
  const toolCalls = choice.message.tool_calls ?? [];
  const result: CompletionResult = {
    text,
    model: response.model,
    usageKnown,
    usage: usageKnown ? {
      input: Math.max(0, promptTokens - cacheRead),
      output: response.usage?.completion_tokens ?? 0,
      cacheRead,
      cacheWrite: 0,
    } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    toolCalls: toolCalls.map(toToolCall),
    stopReason: choice.finish_reason ?? null,
  };
  // An empty answer with no tool call is a FAILED call, not an empty answer.
  //
  // Returning '' hands the caller a blank answer indistinguishable from a real
  // one: a batch of 180 scored runs once graded that empty string as a wrong
  // answer and had to be thrown away. So this fails loudly and reports what the
  // completion was actually spent on.
  //
  // The usual cause was a reply budget the caller imposed — models reason
  // before answering and the reasoning is billed as completion tokens, so a
  // small `maxTokens` is spent thinking. Both harnesses in this repo have since
  // stopped setting one (see `reports/algorithm.md`), which is the real fix; a
  // caller that still passes one gets told, because it is the only party that
  // can raise it.
  //
  // `content` is legitimately empty when the model returned only tool calls, so
  // that case is excluded rather than special-cased later.
  if (text.trim().length === 0 && toolCalls.length === 0) {
    const reasoningTokens = response.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
    const reasoned = (choice.message.reasoning ?? '').length;
    throw new EmptyCompletionError(
      `openrouter returned no content and no tool calls (finish_reason=${choice.finish_reason ?? 'null'}` +
        `, completion_tokens=${response.usage?.completion_tokens ?? 0}` +
        `, reasoning_tokens=${reasoningTokens}, reasoning_chars=${reasoned})` +
        (choice.finish_reason === 'length'
          ? ' — the completion budget ran out before any answer was emitted; the caller set maxTokens, so only the caller can raise it'
          : reasoningTokens > 0
            ? ' — the completion was spent entirely on reasoning tokens'
            : ''),
      result,
      usageKnown,
    );
  }
  return result;
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
