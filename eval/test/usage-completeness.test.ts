import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CompletionResult } from '@context-tree/core';
import { runScenario } from '../src/loop.js';
import { readCapture } from '../src/experiment.js';
import { disabledSink, type LangfuseGenerationFields } from '../src/langfuse.js';

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
const usage = { input: 10, output: 5, cacheRead: 1, cacheWrite: 0 };

async function run(response: CompletionResult) {
  const directory = mkdtempSync(join(tmpdir(), 'ct-usage-completeness-'));
  directories.push(directory);
  const generations: LangfuseGenerationFields[] = [];
  const sink = disabledSink();
  const baseStart = sink.startRun;
  sink.startRun = (info) => ({ ...baseStart(info), generation: (fields) => { generations.push(fields); } });
  const { result } = await runScenario({
    runId: 'usage-check', arm: 'native',
    scenario: { id: 'usage', benchmark: 'unit-test', task: 'Reply done.', judge: { kind: 'exact_match', answer: 'done' } },
    agentProvider: { id: 'stub', async complete() { return response; } },
    options: { provider: 'openrouter', model: response.model, leafModel: response.model, rootModel: response.model,
      judgeModel: response.model, maxTurns: 2, timeCapMs: 60_000, costCapUsd: null,
      budgets: { zoneB: 8000, zoneC: 30000 }, keepSandbox: false, captureDir: directory },
    sink,
  });
  return { result, generations, replay: readCapture(result.capturePath!) };
}

describe('completed outcomes and accounting completeness are independent', () => {
  it('retains a verified answer while reporting unknown usage without a scalar usage claim', async () => {
    const { result, replay, generations } = await run({ model: 'z-ai/glm-5.3-flash', text: 'done', toolCalls: [], stopReason: 'stop', usage, usageKnown: false });
    expect(result).toMatchObject({ status: 'completed', success: true, judge: { score: 1 }, metrics: { usageComplete: false } });
    expect(result.costByModel).toEqual([expect.objectContaining({ model: 'z-ai/glm-5.3-flash', calls: 1, usageComplete: false, priceMatched: 'z-ai/glm-5.3-flash' })]);
    expect(replay).toMatchObject({ allModelTokens: null, observedAllModelTokens: null, attempted: 1, providerErrors: 0, judge: { success: true } });
    expect(generations[0]?.usage).toBeUndefined();
    expect(generations[0]?.metadata.usageComplete).toBe(false);
  });

  it('discloses fallback pricing while preserving measured token totals', async () => {
    const { result, replay, generations } = await run({ model: 'unpriced-eval-model', text: 'done', toolCalls: [], stopReason: 'stop', usage });
    expect(result.costByModel).toEqual([expect.objectContaining({ model: 'unpriced-eval-model', calls: 1, usageComplete: true, priceMatched: null })]);
    expect(result.costByModel![0]!.usd).toBeGreaterThan(0);
    expect(replay).toMatchObject({ allModelTokens: 16, usageComplete: true });
    expect(generations[0]?.usage?.totalCost).toBeUndefined();
    expect(generations[0]?.metadata.priceMatched).toBeNull();
  });
});
