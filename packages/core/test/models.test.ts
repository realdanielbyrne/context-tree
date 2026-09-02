import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import { resolveConfig } from '../src/config.js';
import {
  ConfigError,
  CostCapExceededError,
  ModelCallError,
  type CompletionRequest,
  type TokenUsage,
} from '../src/contracts/index.js';
import {
  AnthropicProvider,
  DEFAULT_PRICES,
  InMemoryCostMeter,
  MeteredProvider,
  MockProvider,
  OpenRouterProvider,
  RecordedProvider,
  RecordingProvider,
  createProvider,
  priceFor,
  requestKey,
  withRetry,
  type AnthropicClientLike,
  type AnthropicMessageLike,
  type OpenRouterClientLike,
  type OpenRouterCompletionLike,
} from '../src/models/index.js';

type AnthropicParams = Anthropic.Messages.MessageCreateParamsNonStreaming;
type OpenAIParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;

function request(overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    model: 'claude-haiku-4-5-20251001',
    messages: [{ role: 'user', content: 'hello' }],
    ...overrides,
  };
}

function usage(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...overrides };
}

/** Records what was sent; never touches the network. */
class AnthropicStub implements AnthropicClientLike {
  readonly sent: AnthropicParams[] = [];
  readonly messages: AnthropicClientLike['messages'];

  constructor(response: AnthropicMessageLike) {
    this.messages = {
      create: async (params: AnthropicParams): Promise<AnthropicMessageLike> => {
        this.sent.push(params);
        return response;
      },
    };
  }
}

class OpenRouterStub implements OpenRouterClientLike {
  readonly sent: OpenAIParams[] = [];
  readonly chat: OpenRouterClientLike['chat'];

  constructor(response: OpenRouterCompletionLike) {
    this.chat = {
      completions: {
        create: async (params: OpenAIParams): Promise<OpenRouterCompletionLike> => {
          this.sent.push(params);
          return response;
        },
      },
    };
  }
}

function anthropicResponse(
  overrides: Partial<AnthropicMessageLike> = {},
): AnthropicMessageLike {
  return {
    model: 'claude-haiku-4-5-20251001',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'ok' }],
    usage: { input_tokens: 10, output_tokens: 2 },
    ...overrides,
  };
}

/** Shaped like an SDK `APIError`: a numeric status and optional headers. */
function httpError(status: number, headers?: Record<string, string>): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status, headers });
}

describe('AnthropicProvider', () => {
  it('emits cache_control on the marked message only, because a breakpoint the assembler computes and the client drops silently forfeits all of D5 cache reuse', async () => {
    const stub = new AnthropicStub(anthropicResponse());
    const provider = new AnthropicProvider({ client: stub });

    await provider.complete(
      request({
        messages: [
          { role: 'user', content: 'zone B' },
          { role: 'assistant', content: 'boundary', cacheBreakpoint: true },
          { role: 'user', content: 'zone C' },
        ],
      }),
    );

    const sent = stub.sent[0];
    expect(sent).toBeDefined();
    const messages = sent?.messages ?? [];
    expect(messages[0]?.content).toBe('zone B');
    expect(messages[1]?.content).toEqual([
      { type: 'text', text: 'boundary', cache_control: { type: 'ephemeral' } },
    ]);
    expect(messages[2]?.content).toBe('zone C');
  });

  it('marks the system block with cache_control when systemCacheBreakpoint is set, because Zone A ships as `system` (never as a message) and is the largest permanently-cacheable segment in the prompt', async () => {
    const stub = new AnthropicStub(anthropicResponse());

    await new AnthropicProvider({ client: stub }).complete(
      request({ system: 'zone A', systemCacheBreakpoint: true }),
    );

    expect(stub.sent[0]?.system).toEqual([
      { type: 'text', text: 'zone A', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('sends system as a bare string when the flag is unset, because an unmarked Zone A must keep its byte-stable serialization (D5)', async () => {
    const stub = new AnthropicStub(anthropicResponse());

    await new AnthropicProvider({ client: stub }).complete(request({ system: 'zone A' }));

    expect(stub.sent[0]?.system).toBe('zone A');
  });

  it('maps both cache counters off usage, because §15 reports a cache-read vs cache-write split it cannot fabricate', async () => {
    const stub = new AnthropicStub(
      anthropicResponse({
        usage: {
          input_tokens: 120,
          output_tokens: 40,
          cache_read_input_tokens: 8_000,
          cache_creation_input_tokens: 512,
        },
      }),
    );

    const result = await new AnthropicProvider({ client: stub }).complete(request());

    expect(result.usage).toEqual({ input: 120, output: 40, cacheRead: 8_000, cacheWrite: 512 });
  });

  it('reports an absent cache counter as zero rather than NaN, because the cost meter sums it straight into the §16 cap', async () => {
    const stub = new AnthropicStub(
      anthropicResponse({
        usage: {
          input_tokens: 5,
          output_tokens: 1,
          cache_read_input_tokens: null,
          cache_creation_input_tokens: null,
        },
      }),
    );

    const result = await new AnthropicProvider({ client: stub }).complete(request());

    expect(result.usage.cacheRead).toBe(0);
    expect(result.usage.cacheWrite).toBe(0);
  });

  it('concatenates text blocks and lifts tool_use blocks into toolCalls, because §9 tool traffic is the whole retrieval path', async () => {
    const stub = new AnthropicStub(
      anthropicResponse({
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'fetching ' },
          { type: 'text', text: 'now' },
          { type: 'tool_use', id: 'tu_1', name: 'context_fetch', input: { node_id: 'n1' } },
        ],
      }),
    );

    const result = await new AnthropicProvider({ client: stub }).complete(request());

    expect(result.text).toBe('fetching now');
    expect(result.stopReason).toBe('tool_use');
    expect(result.toolCalls).toEqual([
      { id: 'tu_1', name: 'context_fetch', input: { node_id: 'n1' } },
    ]);
  });

  it('omits tools and temperature when the request omits them, because an empty tools array is a different cached prefix (D5) and current Claude models reject sampling params', async () => {
    const stub = new AnthropicStub(anthropicResponse());

    await new AnthropicProvider({ client: stub }).complete(request({ tools: [] }));

    expect(stub.sent[0]?.tools).toBeUndefined();
    expect(stub.sent[0]?.temperature).toBeUndefined();
  });
});

describe('OpenRouterProvider', () => {
  it('a reply with no content and no tool calls FAILS LOUDLY, naming the reasoning tokens that ate the budget', async () => {
    // Returning '' hands the caller a blank answer indistinguishable from a
    // real one: a batch of 180 scored runs once graded that empty string as a
    // wrong answer and had to be thrown away. The guard exists so that never
    // reaches a grader silently. It reports where the completion went, since
    // an empty reply with reasoning tokens spent means something different
    // from an empty reply with none.
    const stub = new OpenRouterStub({
      model: 'nvidia/nemotron-3-ultra-550b-a55b',
      choices: [
        {
          message: { content: '', reasoning: 'thinking about the question at length', tool_calls: [] },
          finish_reason: 'length',
        },
      ],
      usage: {
        prompt_tokens: 21,
        completion_tokens: 49,
        completion_tokens_details: { reasoning_tokens: 47 },
      },
    });

    await expect(new OpenRouterProvider({ client: stub }).complete(request())).rejects.toThrow(
      /no content and no tool calls.*finish_reason=length.*reasoning_tokens=47/s,
    );
  });

  it('empty content WITH tool calls stays valid — a tool-only turn is how the loop advances', async () => {
    // The guard above must not fire on the normal case. A model that answers
    // with a tool call and no prose is doing exactly what the contract asks.
    const stub = new OpenRouterStub({
      model: 'z-ai/glm-5.3-flash',
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ id: 't1', function: { name: 'context_search', arguments: '{"query":"x"}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    const result = await new OpenRouterProvider({ client: stub }).complete(request());
    expect(result.text).toBe('');
    expect(result.toolCalls).toEqual([{ id: 't1', name: 'context_search', input: { query: 'x' } }]);
  });

  it('reasoning text is never returned as the answer — the caller asked for an answer', async () => {
    // Reading `reasoning` to EXPLAIN an empty answer is diagnosis; returning it
    // as the answer would silently substitute the model's scratchpad for its
    // conclusion, which grades as nonsense and reads as a model failure.
    const stub = new OpenRouterStub({
      model: 'nvidia/nemotron-3-super-120b-a12b',
      choices: [
        { message: { content: 'the answer is 42', reasoning: 'let me think... maybe 41? no, 42' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 12 } },
    });

    const result = await new OpenRouterProvider({ client: stub }).complete(request());
    expect(result.text).toBe('the answer is 42');
  });

  it('passes cache_control through on the marked message, because §10 rule 5 requires provider-native caching wherever the field exists', async () => {
    const stub = new OpenRouterStub({
      model: 'anthropic/claude-haiku-4-5',
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    });

    await new OpenRouterProvider({ client: stub }).complete(
      request({
        model: 'anthropic/claude-haiku-4-5',
        system: 'zone A',
        messages: [
          { role: 'user', content: 'stable', cacheBreakpoint: true },
          { role: 'user', content: 'volatile' },
        ],
      }),
    );

    const messages = stub.sent[0]?.messages ?? [];
    expect(messages[0]).toEqual({ role: 'system', content: 'zone A' });
    expect(messages[1]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'stable', cache_control: { type: 'ephemeral' } }],
    });
    expect(messages[2]).toEqual({ role: 'user', content: 'volatile' });
  });

  it('marks the system message with cache_control when systemCacheBreakpoint is set, because the OpenAI-compatible shape allows a text part there and rule 5 needs the A/B boundary on the wire', async () => {
    const stub = new OpenRouterStub({
      model: 'anthropic/claude-haiku-4-5',
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    });

    await new OpenRouterProvider({ client: stub }).complete(
      request({
        model: 'anthropic/claude-haiku-4-5',
        system: 'zone A',
        systemCacheBreakpoint: true,
      }),
    );

    expect(stub.sent[0]?.messages[0]).toEqual({
      role: 'system',
      content: [{ type: 'text', text: 'zone A', cache_control: { type: 'ephemeral' } }],
    });
  });

  it('subtracts cached_tokens out of prompt_tokens, because OpenAI-compatible prompt_tokens includes cached input and the meter would charge it twice', async () => {
    const stub = new OpenRouterStub({
      model: 'anthropic/claude-haiku-4-5',
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 1_000,
        completion_tokens: 30,
        prompt_tokens_details: { cached_tokens: 900 },
      },
    });

    const result = await new OpenRouterProvider({ client: stub }).complete(request());

    expect(result.usage).toEqual({ input: 100, output: 30, cacheRead: 900, cacheWrite: 0 });
  });

  it('reports zero cache counters when the upstream returns none, because an unknown reported as zero is honest and an invented number is not', async () => {
    const stub = new OpenRouterStub({
      model: 'openai/gpt-4.1-mini',
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 42, completion_tokens: 7 },
    });

    const result = await new OpenRouterProvider({ client: stub }).complete(request());

    expect(result.usage).toEqual({ input: 42, output: 7, cacheRead: 0, cacheWrite: 0 });
  });

  it('maps json:true onto the native response_format and parses tool-call argument strings, because the §8 summary contract is JSON-only', async () => {
    const stub = new OpenRouterStub({
      model: 'anthropic/claude-haiku-4-5',
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id: 'call_1', function: { name: 'context_peek', arguments: '{"node_id":"n2"}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });

    const result = await new OpenRouterProvider({ client: stub }).complete(
      request({ json: true }),
    );

    expect(stub.sent[0]?.response_format).toEqual({ type: 'json_object' });
    expect(result.text).toBe('');
    expect(result.toolCalls).toEqual([
      { id: 'call_1', name: 'context_peek', input: { node_id: 'n2' } },
    ]);
  });

  it('throws on unparseable tool arguments instead of yielding an empty input, because a silently-empty tool call looks like a model that chose not to fetch', async () => {
    const stub = new OpenRouterStub({
      model: 'anthropic/claude-haiku-4-5',
      choices: [
        {
          message: { content: null, tool_calls: [{ id: 'call_2', function: { name: 'x', arguments: '{oops' } }] },
          finish_reason: 'tool_calls',
        },
      ],
    });

    await expect(new OpenRouterProvider({ client: stub }).complete(request())).rejects.toThrow(
      ModelCallError,
    );
  });
});

describe('withRetry', () => {
  function recorder() {
    const slept: number[] = [];
    return {
      slept,
      sleep: async (ms: number) => {
        slept.push(ms);
      },
    };
  }

  it('retries a 429 and a 503, because a rate limit and a bad gateway are both transient and losing the call wastes the tokens already spent', async () => {
    for (const status of [429, 503]) {
      let calls = 0;
      const { sleep } = recorder();
      const value = await withRetry(
        async () => {
          calls += 1;
          if (calls === 1) throw httpError(status);
          return 'ok';
        },
        { sleep, random: () => 0 },
      );
      expect(value).toBe('ok');
      expect(calls).toBe(2);
    }
  });

  it('never retries a 400, because a bad request retried is still a bad request and each retry burns the §16 cost cap', async () => {
    let calls = 0;
    const { sleep, slept } = recorder();

    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw httpError(400);
        },
        { sleep, random: () => 0 },
      ),
    ).rejects.toMatchObject({ status: 400, code: 'E_MODEL_CALL' });

    expect(calls).toBe(1);
    expect(slept).toEqual([]);
  });

  it('retries an error with no status, because a reset socket never got an HTTP response at all', async () => {
    let calls = 0;
    const { sleep } = recorder();

    const value = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('ECONNRESET');
        return 'ok';
      },
      { sleep, random: () => 0 },
    );

    expect(value).toBe('ok');
    expect(calls).toBe(3);
  });

  it('stops at the attempt cap and throws ModelCallError carrying the status, because an unbounded retry loop is an unbounded bill', async () => {
    let calls = 0;
    const { sleep } = recorder();

    const error = await withRetry(
      async () => {
        calls += 1;
        throw httpError(429);
      },
      { attempts: 4, sleep, random: () => 0 },
    ).catch((e: unknown) => e);

    expect(calls).toBe(4);
    expect(error).toBeInstanceOf(ModelCallError);
    expect((error as ModelCallError).status).toBe(429);
    expect((error as ModelCallError).message).toContain('4 attempt(s)');
  });

  it('applies full-jitter exponential backoff off the injected random, because a fixed backoff synchronises every retrying worker into the same thundering herd', async () => {
    const { sleep, slept } = recorder();

    await withRetry(
      async () => {
        throw httpError(500);
      },
      { attempts: 4, baseDelayMs: 100, sleep, random: () => 0.5 },
    ).catch(() => undefined);

    // ceiling doubles per attempt (100/200/400); full jitter scales it by random().
    expect(slept).toEqual([50, 100, 200]);
  });

  it('honours a retry-after header over its own backoff, because only the server knows when the rate-limit window reopens', async () => {
    const { sleep, slept } = recorder();
    let calls = 0;

    await withRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw httpError(429, { 'retry-after': '2' });
        return 'ok';
      },
      { baseDelayMs: 100, sleep, random: () => 0.5 },
    );

    expect(slept).toEqual([2_000]);
  });

  it('rejects an attempt cap below 1, because "zero attempts" would report a never-made call as a failed one', async () => {
    await expect(withRetry(async () => 'ok', { attempts: 0 })).rejects.toThrow(ConfigError);
  });
});

describe('MockProvider', () => {
  it('records every request verbatim, because the cache-breakpoint and prompt-layout tests assert on what was actually sent', async () => {
    const provider = new MockProvider({ reply: 'r' });
    const first = request({ messages: [{ role: 'user', content: 'a', cacheBreakpoint: true }] });

    await provider.complete(first);
    await provider.complete(request({ messages: [{ role: 'user', content: 'b' }] }));

    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0]).toBe(first);
    expect(provider.requests[1]?.messages[0]?.content).toBe('b');
  });

  it('serves a queue in order and throws when it is exhausted, because reusing the last reply would let a test that over-calls the model pass', async () => {
    const provider = new MockProvider({ queue: ['one', 'two'] });

    expect((await provider.complete(request())).text).toBe('one');
    expect((await provider.complete(request())).text).toBe('two');
    await expect(provider.complete(request())).rejects.toThrow(ModelCallError);
  });

  it('gives the responder the request, so a fake summarizer can answer per branch', async () => {
    const provider = new MockProvider({
      responder: (req) => `saw:${req.messages[0]?.content ?? ''}`,
    });

    const result = await provider.complete(request({ messages: [{ role: 'user', content: 'x' }] }));

    expect(result.text).toBe('saw:x');
    expect(result.model).toBe('claude-haiku-4-5-20251001');
  });

  it('refuses ambiguous or empty construction, because a mock that silently picks a mode hides which reply a test asserted on', () => {
    expect(() => new MockProvider({})).toThrow(ConfigError);
    expect(() => new MockProvider({ reply: 'a', queue: ['b'] })).toThrow(ConfigError);
  });
});

describe('RecordedProvider', () => {
  function cassettePath(): string {
    return join(mkdtempSync(join(tmpdir(), 'ct-models-')), 'recorded', 'completions.json');
  }

  it('replays what RecordingProvider wrote, because §17 runs the prompt suite against recorded completions with no network in CI', async () => {
    const path = cassettePath();
    const live = new MockProvider({ reply: '{"text":"summary"}', usage: usage({ input: 9 }) });
    const recording = new RecordingProvider(live, path);
    const req = request({ system: 'zone A', json: true });

    const recorded = await recording.complete(req);
    const replayed = await new RecordedProvider(path).complete(req);

    expect(replayed).toEqual(recorded);
    expect(Object.keys(JSON.parse(readFileSync(path, 'utf8')) as object)).toEqual([
      requestKey(req),
    ]);
  });

  it('names the key, the cassette path and the LIVE=1 remedy on a miss, because a cassette miss with no coordinates is unfixable', async () => {
    const path = cassettePath();
    await new RecordingProvider(new MockProvider({ reply: 'a' }), path).complete(request());

    const miss = request({ messages: [{ role: 'user', content: 'never recorded' }] });
    const error = await new RecordedProvider(path).complete(miss).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ModelCallError);
    const message = (error as Error).message;
    expect(message).toContain(requestKey(miss));
    expect(message).toContain(path);
    expect(message).toContain('LIVE=1');
  });

  it('keys only the semantic fields, so moving a cache breakpoint or a max-token cap does not invalidate the whole recorded corpus', () => {
    const base = request({ system: 's', messages: [{ role: 'user', content: 'm' }] });
    const rebreakpointed = request({
      system: 's',
      messages: [{ role: 'user', content: 'm', cacheBreakpoint: true }],
      maxTokens: 99,
      temperature: 0.5,
    });

    expect(requestKey(rebreakpointed)).toBe(requestKey(base));
    expect(requestKey(request({ system: 's', json: true }))).not.toBe(requestKey(base));
  });
});

describe('InMemoryCostMeter', () => {
  it('computes USD from the price table per million tokens, because §16 gates a PR on this number', () => {
    const meter = new InMemoryCostMeter({
      prices: { fake: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
    });

    meter.record('fake-1', usage({ input: 1_000_000, output: 100_000 }));
    meter.record('fake-1', usage({ cacheRead: 2_000_000, cacheWrite: 400_000 }));

    const snapshot = meter.snapshot();
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0]?.calls).toBe(2);
    expect(snapshot.entries[0]?.usage).toEqual(
      usage({ input: 1_000_000, output: 100_000, cacheRead: 2_000_000, cacheWrite: 400_000 }),
    );
    // 3 + 1.5 + 0.6 + 1.5
    expect(snapshot.entries[0]?.usd).toBeCloseTo(6.6, 10);
    expect(snapshot.totalUsd).toBeCloseTo(6.6, 10);
  });

  it('matches the longest model-id prefix and strips an OpenRouter vendor, because a dated snapshot and a vendor-qualified id are the same model at the same rate', () => {
    expect(priceFor('claude-haiku-4-5-20251001').matched).toBe('claude-haiku');
    expect(priceFor('anthropic/claude-haiku-4-5').matched).toBe('claude-haiku');
    // 'claude-sonnet-5' must win over the shorter 'claude-sonnet' entry.
    expect(priceFor('claude-sonnet-5').price).toEqual(DEFAULT_PRICES['claude-sonnet-5']);
    expect(priceFor('claude-sonnet-4-6').price).toEqual(DEFAULT_PRICES['claude-sonnet']);
  });

  it('prices the OpenRouter eval-matrix models from the table, not the fallback, because a $0.07/M model billed at the $10/M fallback makes every cross-model cost verdict fiction', () => {
    for (const id of [
      'z-ai/glm-5.3-flash',
      'deepseek/deepseek-v4-flash',
      'qwen/qwen3.7-flash',
      'qwen/qwen-2.5-72b-instruct',
      'openai/gpt-3.5-turbo',
    ]) {
      const match = priceFor(id);
      expect(match.matched).toBe(id);
      expect(match.price).toEqual(DEFAULT_PRICES[id]);
    }
  });

  it('charges an unknown model the fallback rate and lists it, because a silently-free model defeats the §16 cap entirely', () => {
    const meter = new InMemoryCostMeter();

    meter.record('some-new-model-v9', usage({ input: 1_000_000 }));

    const snapshot = meter.snapshot();
    expect(snapshot.entries.map((entry) => entry.model)).toEqual(['some-new-model-v9']);
    expect(snapshot.entries[0]?.usd).toBeGreaterThan(0);
    expect(meter.unpricedModels()).toEqual(['some-new-model-v9']);
  });

  it('throws exactly at the cap and not one token before, because the call that lands on the cap has spent the whole budget', () => {
    const prices = { fake: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const meter = new InMemoryCostMeter({ capUsd: 1, prices });

    meter.record('fake', usage({ input: 999_999 }));
    expect(() => meter.assertUnderCap()).not.toThrow();

    meter.record('fake', usage({ input: 1 }));
    expect(meter.totalUsd()).toBe(1);
    expect(() => meter.assertUnderCap()).toThrow(CostCapExceededError);
    // The message must state the condition the code actually applies. Reading
    // "$1.0000 > $1.0000" on the boundary case sends whoever hits the cap
    // looking for a rounding bug that isn't there.
    expect(() => meter.assertUnderCap()).toThrow('$1.0000 >= $1.0000');
  });

  it('never throws when the cap is null, because §16 caps CI runs and must not block an unbudgeted local run', () => {
    const meter = new InMemoryCostMeter({ capUsd: null });
    meter.record('claude-opus-5', usage({ input: 10_000_000 }));
    expect(() => meter.assertUnderCap()).not.toThrow();
    expect(meter.snapshot().capUsd).toBeNull();
  });
});

describe('MeteredProvider', () => {
  it('records the inner result usage and enforces the cap after the call, so no call site has to remember to meter', async () => {
    const prices = { fake: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const meter = new InMemoryCostMeter({ capUsd: 1, prices });
    const inner = new MockProvider({ reply: 'ok', usage: usage({ input: 600_000 }) });
    const provider = new MeteredProvider(inner, meter);

    const first = await provider.complete(request({ model: 'fake' }));
    expect(first.text).toBe('ok');
    expect(meter.totalUsd()).toBeCloseTo(0.6, 10);

    // The second call happens, is recorded, and then trips the cap.
    await expect(provider.complete(request({ model: 'fake' }))).rejects.toThrow(
      CostCapExceededError,
    );
    expect(meter.snapshot().entries[0]?.calls).toBe(2);
    expect(provider.id).toBe('metered:mock');
  });
});

describe('createProvider', () => {
  it('throws ConfigError when the selected provider has no key, because §11 takes keys from the environment only and a 401 mid-run wastes the whole session', () => {
    const config = resolveConfig({ provider: 'anthropic', root: mkdtempSync(join(tmpdir(), 'ct-cfg-')) });
    expect(() => createProvider(config, {})).toThrow(ConfigError);
    expect(() => createProvider({ ...config, provider: 'openrouter' }, {})).toThrow(ConfigError);
    expect(() => createProvider({ ...config, provider: 'openrouter' }, { anthropic: 'k' })).toThrow(
      ConfigError,
    );
  });

  it('selects the offline providers without any key, because M0-M2 must run on zero LLM budget (§16)', () => {
    const root = mkdtempSync(join(tmpdir(), 'ct-cfg-'));
    expect(createProvider(resolveConfig({ provider: 'mock', root }), {}).id).toBe('mock');
    const recorded = createProvider(resolveConfig({ provider: 'recorded', root }), {});
    expect(recorded.id).toBe('recorded');
    expect((recorded as RecordedProvider).cassettePath).toBe(
      join(root, 'recorded', 'completions.json'),
    );
  });
});
