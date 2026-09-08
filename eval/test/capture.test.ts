import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RunCapture, TokenBudgetExceeded } from '../src/capture.js';
import type { CompletionRequest, ModelProvider } from '@context-tree/core';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const request: CompletionRequest = { model: 'mock', messages: [{ role: 'user', content: 'task' }] };
const provider: ModelProvider = { id: 'mock', complete: async () => ({ model: 'mock', text: 'done', toolCalls: [], stopReason: 'end_turn', usage: { input: 10, output: 2, cacheRead: 20, cacheWrite: 3 } }) };

describe('durable capture', () => {
  it('preserves the exact interface request and all provider roles before cleanup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-capture-')); dirs.push(dir);
    const capture = new RunCapture(dir);
    await capture.provider(provider, 'agent').complete(request);
    await capture.provider(provider, 'summarizer').complete(request);
    const rows = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(readFileSync(join(dir, 'blobs', rows[0].value.requestBlob), 'utf8')).toBe(JSON.stringify(request));
    expect(capture.snapshot()).toMatchObject({ calls: 2, agent: { total: 35 }, allModels: { total: 70 }, usageComplete: true });
  });
  it('retains unknown usage on provider failure rather than asserting zero', async () => {
    const capture = new RunCapture(undefined);
    const failed = capture.provider({ id: 'failed', complete: async () => { throw new Error('transport'); } }, 'agent');
    await expect(failed.complete(request)).rejects.toThrow('transport');
    expect(capture.snapshot()).toMatchObject({ calls: 1, providerErrors: 1, usageComplete: false });
  });
  it('stops the next request at the all-model token ceiling', async () => {
    const capture = new RunCapture(undefined, 35);
    await capture.provider(provider, 'summarizer').complete(request);
    await expect(capture.provider(provider, 'agent').complete(request)).rejects.toBeInstanceOf(TokenBudgetExceeded);
    expect(capture.snapshot().calls).toBe(1);
  });
  it('isolates provider mutations from the retained request', async () => {
    const capture = new RunCapture(undefined);
    await capture.provider({ ...provider, complete: async (r) => { r.messages.length = 0; return provider.complete(r); } }, 'agent').complete(request);
    expect(request.messages).toHaveLength(1);
  });
});
