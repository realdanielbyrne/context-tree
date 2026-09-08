import { afterEach, describe, expect, it, vi } from 'vitest';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicProvider, OpenRouterProvider, createProvider, resolveConfig, type CompletionRequest } from '../src/index.js';

afterEach(() => vi.unstubAllGlobals());
const request: CompletionRequest = { model: 'test-model', messages: [{ role: 'user', content: 'reply' }] };
const serverError = () => new Response(JSON.stringify({ error: { message: 'synthetic server error', type: 'server_error' } }), {
  status: 503, headers: { 'content-type': 'application/json', 'retry-after': '0' },
});

describe('explicit evaluation transport retry policy', () => {
  it('overrides retries on an injected OpenAI SDK and disables the outer provider retry', async () => {
    const fetch = vi.fn(async () => serverError());
    const client = new OpenAI({ apiKey: 'test', fetch, maxRetries: 2 });
    const provider = new OpenRouterProvider({ client, sdkMaxRetries: 0, retry: { attempts: 1 } });
    await expect(provider.complete(request)).rejects.toThrow('after 1 attempt(s)');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('overrides retries on an injected Anthropic SDK and disables the outer provider retry', async () => {
    const fetch = vi.fn(async () => serverError());
    const client = new Anthropic({ apiKey: 'test', fetch, maxRetries: 2 });
    const provider = new AnthropicProvider({ client, sdkMaxRetries: 0, retry: { attempts: 1 } });
    await expect(provider.complete(request)).rejects.toThrow('after 1 attempt(s)');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['openrouter', 'anthropic'] as const)('forwards the explicit policy through the %s factory', async (providerId) => {
    const fetch = vi.fn(async () => serverError());
    vi.stubGlobal('fetch', fetch);
    const provider = createProvider(resolveConfig({ provider: providerId }), { openrouter: 'test', anthropic: 'test' }, { sdkMaxRetries: 0, retry: { attempts: 1 } });
    await expect(provider.complete(request)).rejects.toThrow('after 1 attempt(s)');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('preserves SDK retry behavior when the new option is omitted', async () => {
    const fetch = vi.fn()
      .mockImplementationOnce(async () => serverError())
      .mockImplementationOnce(async () => new Response(JSON.stringify({
        model: request.model, choices: [{ message: { content: 'answer' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const client = new OpenAI({ apiKey: 'test', fetch });
    expect(client.maxRetries).toBe(2);
    const result = await new OpenRouterProvider({ client, retry: { attempts: 1 } }).complete(request);
    expect(result.text).toBe('answer');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('preserves four outer attempts when the existing retry-attempt option is omitted', async () => {
    let calls = 0;
    const provider = new OpenRouterProvider({ sdkMaxRetries: 0, retry: { sleep: async () => {} }, client: { chat: { completions: { async create() {
      calls++;
      throw Object.assign(new Error('synthetic server error'), { status: 503 });
    } } } } });
    await expect(provider.complete(request)).rejects.toThrow('after 4 attempt(s)');
    expect(calls).toBe(4);
  });

  it('rejects invalid SDK retry limits before creating a client', () => {
    expect(() => new OpenRouterProvider({ sdkMaxRetries: -1 })).toThrow('nonnegative integer');
    expect(() => new AnthropicProvider({ sdkMaxRetries: 1.5 })).toThrow('nonnegative integer');
  });
});
