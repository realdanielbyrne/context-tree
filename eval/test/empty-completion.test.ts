import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EmptyCompletionError, InMemoryCostMeter, MeteredProvider, OpenRouterProvider, type CompletionRequest, type CompletionResult, type OpenRouterClientLike, type OpenRouterCompletionLike, type ModelProvider } from '@context-tree/core';
import { RunCapture, TokenBudgetExceeded } from '../src/capture.js';
import { readCapture } from '../src/experiment.js';
import { callModel } from '../src/loop.js';
import { ZERO_TOTALS } from '../src/metrics.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const request: CompletionRequest = { model: 'z-ai/glm-5.3-flash', system: 'unchanged', messages: [{ role: 'user', content: 'answer' }], maxTokens: 300 };
const result = (text: string): CompletionResult => ({ model: request.model, text, toolCalls: [], stopReason: 'stop', usage: { input: 10, output: 5, cacheRead: 20, cacheWrite: 0 } });
const runHandle = { generation() {}, score() {}, finish() {} };

function harness(inner: ModelProvider, tokenLimit?: number) {
  const directory = mkdtempSync(join(tmpdir(), 'ct-empty-completion-')); directories.push(directory);
  const capture = new RunCapture(directory, tokenLimit);
  const meter = new InMemoryCostMeter();
  const provider = new MeteredProvider(capture.provider(inner, 'agent'), meter);
  return {
    capture, meter,
    run: () => callModel({ provider, request, turnIndex: 0, runHandle, usage: { ...ZERO_TOTALS }, capture }),
    replay: () => { capture.archiveStore(join(directory, 'absent')); return readCapture(directory); },
  };
}

describe('one identical empty-completion retry with complete accounting', () => {
  it('retries the actual OpenRouter typed error, preserves both billed results, and makes no wire-byte claim', async () => {
    const sent: string[] = [];
    const replies: OpenRouterCompletionLike[] = ['', 'answer'].map((content) => ({ model: request.model, choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 20 } } }));
    const client: OpenRouterClientLike = { chat: { completions: { async create(params) { sent.push(JSON.stringify(params)); return replies[sent.length - 1]!; } } } };
    const h = harness(new OpenRouterProvider({ client }));
    const completed = await h.run();
    expect(sent).toHaveLength(2); expect(sent[1]).toBe(sent[0]);
    expect(completed.record.attempts).toBe(2);
    expect(completed.result).toMatchObject({ text: 'answer', usage: { input: 20, output: 10, cacheRead: 40, cacheWrite: 0 } });
    expect(h.meter.snapshot().entries[0]).toMatchObject({ calls: 2, usage: { input: 20, output: 10, cacheRead: 40, cacheWrite: 0 } });
    const replay = h.replay();
    expect(replay).toMatchObject({ attempted: 2, attemptScope: 'ModelProvider.complete', transportAttempts: null,
      responses: 2, providerErrors: 1, allModelTokens: 70, usageComplete: true, httpWireVerified: false });
    expect(replay.frames[0]?.requestBlob).toBe(replay.frames[1]?.requestBlob);
  });

  it('handles a raw empty mock result through the same typed path and rejects the second empty result', async () => {
    let calls = 0;
    const h = harness({ id: 'empty-mock', async complete() { calls++; return result(''); } });
    await expect(h.run()).rejects.toThrow('empty response after one identical retry');
    expect(calls).toBe(2);
    expect(h.replay()).toMatchObject({ attempted: 2, providerErrors: 2, allModelTokens: 70, usageComplete: true });
    expect(h.meter.snapshot().entries[0]?.calls).toBe(2);
  });

  it('never retries unknown provider errors or invents their token usage', async () => {
    let calls = 0;
    const error = new Error('network failure');
    const h = harness({ id: 'unknown', async complete() { calls++; throw error; } });
    await expect(h.run()).rejects.toBe(error);
    expect(calls).toBe(1);
    expect(h.replay()).toMatchObject({ attempted: 1, providerErrors: 1, allModelTokens: null, observedAllModelTokens: null, usageComplete: false });
    expect(h.meter.snapshot().entries).toHaveLength(0);
  });

  it('keeps unknown usage unknown even if the second attempt succeeds', async () => {
    let calls = 0;
    const h = harness({ id: 'unknown-empty', async complete() {
      calls++; if (calls === 1) throw new EmptyCompletionError('empty with unknown usage', result(''), false);
      return result('answer');
    } });
    const completed = await h.run();
    expect(completed.record.usageComplete).toBe(false);
    expect(completed.result.usageKnown).toBe(false);
    expect(h.capture.snapshot()).toMatchObject({ calls: 2, providerErrors: 1, usageComplete: false });
    expect(h.replay()).toMatchObject({ allModelTokens: null, observedAllModelTokens: 35 });
    expect(h.meter.snapshot().entries[0]?.calls).toBe(1);
  });

  it('does not spend a retry after the first billed empty response reaches the token ceiling', async () => {
    let calls = 0;
    const h = harness({ id: 'empty', async complete() { calls++; return result(''); } }, 35);
    await expect(h.run()).rejects.toBeInstanceOf(TokenBudgetExceeded);
    expect(calls).toBe(1);
    expect(h.replay()).toMatchObject({ attempted: 1, allModelTokens: 35, providerErrors: 1 });
  });

  it('retains successful OpenRouter answers with missing usage without retrying or asserting zero totals', async () => {
    let calls = 0;
    const client: OpenRouterClientLike = { chat: { completions: { async create() {
      calls++;
      return { model: request.model, choices: [{ message: { content: 'answer' }, finish_reason: 'stop' }] };
    } } } };
    const h = harness(new OpenRouterProvider({ client }));
    const completed = await h.run();
    expect(calls).toBe(1);
    expect(completed.result).toMatchObject({ text: 'answer', usageKnown: false });
    expect(completed.record.usageComplete).toBe(false);
    expect(h.meter.snapshot().entries).toEqual([]);
    expect(h.replay()).toMatchObject({ attempted: 1, responses: 1, providerErrors: 0, allModelTokens: null,
      observedAllModelTokens: null, usageComplete: false, unknownUsageModels: [request.model], callsByModel: { [request.model]: 1 } });
  });

  it('keeps a known failed attempt as an observed subtotal when the successful retry has unknown usage', async () => {
    let calls = 0;
    const h = harness({ id: 'partial-retry', async complete() {
      calls++;
      return calls === 1 ? result('') : { ...result('answer'), usageKnown: false };
    } });
    const completed = await h.run();
    expect(completed.result).toMatchObject({ text: 'answer', usageKnown: false, usage: result('').usage });
    expect(h.replay()).toMatchObject({ attempted: 2, providerErrors: 1, allModelTokens: null, observedAllModelTokens: 35,
      usageComplete: false, callsByModel: { [request.model]: 2 } });
    expect(h.meter.snapshot().entries[0]?.calls).toBe(1);
  });
});
