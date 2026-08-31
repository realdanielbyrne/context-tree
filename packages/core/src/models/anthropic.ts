/**
 * §11 Anthropic provider. Nothing here is fine-tuned — leaf and root
 * summarizers are the same hosted-model surface with different model ids.
 *
 * The load-bearing detail is the cache breakpoint: §10 rule 5 has the assembler
 * mark the Zone A/B and B/C boundaries, and D5 is the decision those markers
 * serve. A breakpoint the assembler computes and this client drops costs the
 * entire caching benefit while looking like it works, so `cacheBreakpoint`
 * becomes a native `cache_control` on that message's last content block.
 */
import Anthropic from '@anthropic-ai/sdk';
import type {
  ChatMessage,
  CompletionRequest,
  CompletionResult,
  ModelProvider,
  ToolCallRequest,
} from '../contracts/index.js';
import { withRetry, type RetryOptions } from './retry.js';

/**
 * The response fields this provider reads. Narrower than `Anthropic.Message` on
 * purpose: a test stub has to satisfy exactly what is used, not 20 fields the
 * mapping ignores.
 */
export interface AnthropicUsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export interface AnthropicContentBlockLike {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

export interface AnthropicMessageLike {
  model: string;
  stop_reason?: string | null;
  content: readonly AnthropicContentBlockLike[];
  usage: AnthropicUsageLike;
}

export interface AnthropicClientLike {
  messages: {
    create(
      params: Anthropic.Messages.MessageCreateParamsNonStreaming,
    ): Promise<AnthropicMessageLike>;
  };
}

/** Anthropic requires `max_tokens`; the contract makes it optional. */
export const DEFAULT_MAX_TOKENS = 4096;

export interface AnthropicProviderOptions {
  apiKey?: string;
  /** Injected in tests; a real client is constructed when absent. */
  client?: AnthropicClientLike;
  retry?: RetryOptions;
  maxTokens?: number;
}

export class AnthropicProvider implements ModelProvider {
  readonly id = 'anthropic';
  private readonly client: AnthropicClientLike;
  private readonly retry: RetryOptions;
  private readonly defaultMaxTokens: number;

  constructor(options: AnthropicProviderOptions = {}) {
    this.client = options.client ?? new Anthropic({ apiKey: options.apiKey });
    this.retry = options.retry ?? {};
    this.defaultMaxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const params = this.toParams(request);
    const response = await withRetry(() => this.client.messages.create(params), {
      label: 'anthropic messages.create',
      ...this.retry,
    });
    return fromAnthropicResponse(response);
  }

  private toParams(
    request: CompletionRequest,
  ): Anthropic.Messages.MessageCreateParamsNonStreaming {
    const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
      model: request.model,
      max_tokens: request.maxTokens ?? this.defaultMaxTokens,
      messages: request.messages.map(toMessageParam),
    };
    if (request.system !== undefined) params.system = request.system;
    // An empty `tools` array is a different cached prefix from no tools at all.
    if (request.tools && request.tools.length > 0) {
      params.tools = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema as Anthropic.Messages.Tool['input_schema'],
      }));
    }
    // Passed only when set: current Claude models reject sampling params (400).
    if (request.temperature !== undefined) params.temperature = request.temperature;
    // `request.json` has no schemaless native equivalent here (structured
    // outputs need a JSON Schema), and the §8 prompts already demand a JSON
    // object that `parseSummaryResponse` extracts from fences. Inventing a
    // system-prompt suffix in the client would fork the two providers' prompts
    // away from the versioned §11 templates, so this flag is a no-op.
    return params;
  }
}

function toMessageParam(message: ChatMessage): Anthropic.Messages.MessageParam {
  if (message.cacheBreakpoint !== true) {
    return { role: message.role, content: message.content };
  }
  return {
    role: message.role,
    content: [
      { type: 'text', text: message.content, cache_control: { type: 'ephemeral' } },
    ],
  };
}

/**
 * §15 reports a cache-read vs cache-write token split and cannot fabricate it,
 * so both counters come straight off `usage`. A `null` counter means the request
 * had no cache activity, which is an honest zero.
 */
function fromAnthropicResponse(response: AnthropicMessageLike): CompletionResult {
  let text = '';
  const toolCalls: ToolCallRequest[] = [];
  for (const block of response.content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      text += block.text;
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id ?? '',
        name: block.name ?? '',
        input: asRecord(block.input),
      });
    }
  }
  return {
    text,
    model: response.model,
    usage: {
      input: response.usage.input_tokens,
      output: response.usage.output_tokens,
      cacheRead: response.usage.cache_read_input_tokens ?? 0,
      cacheWrite: response.usage.cache_creation_input_tokens ?? 0,
    },
    toolCalls,
    stopReason: response.stop_reason ?? null,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}
