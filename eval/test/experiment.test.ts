import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { auc, compareCohorts, readCapture, replayCapture, summarizeCohort, type CaptureEvent, type ExperimentRow } from '../src/experiment.js';
import { RunCapture } from '../src/capture.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const options = { baseline: 'native', candidate: 'candidate', model: 'model', epoch: 'frozen', primaryScenarios: ['task'] };
function rows(n = 5): ExperimentRow[] {
  return ['native', 'candidate'].flatMap((arm) => Array.from({ length: n }, (_, replicate) => ({
    arm, model: 'model', scenario: 'task', replicate, epoch: 'frozen', configHash: arm,
    status: 'completed', success: true, score: 1, evidenceVerified: true,
    allModelTokens: arm === 'native' ? 200 : 100, costByModel: { agent: 1, summarizer: 0.2 },
    providerErrors: 0, attempted: 2, usageComplete: true, mechanismEvents: arm === 'native' ? 0 : 1,
  })));
}

describe('frozen paired cohort decisions', () => {
  it('requires a verified discrete non-regression and Q1-positive all-model token benefit per primary scenario', () => {
    const result = compareCohorts(rows(), options);
    expect(result.promotable).toBe(true);
    expect(result.perScenario[0]?.pairedTokenBenefit.q1).toBe(100);
  });

  it.each(['epoch', 'model', 'configHash'] as const)('rejects changing %s within an arm', (key) => {
    const input = rows();
    input[0]![key] = 'changed';
    expect(compareCohorts(input, options).verdict).toBe('invalid');
  });

  it('rejects unequal n, duplicate replicates, missing primary scenarios and n below five', () => {
    expect(compareCohorts(rows().slice(1), options).verdict).toBe('invalid');
    const duplicate = rows(); duplicate[0]!.replicate = 1;
    expect(compareCohorts(duplicate, options).verdict).toBe('invalid');
    expect(compareCohorts(rows(), { ...options, primaryScenarios: ['missing'] }).verdict).toBe('invalid');
    expect(compareCohorts(rows(3), options).verdict).toBe('invalid');
  });

  it('does not turn capped passing tests or absent outcome provenance into promotion', () => {
    for (const change of [{ status: 'cost_cap' }, { status: 'stalled' }, { evidenceVerified: false }, { allModelTokens: null }]) {
      const input = rows(); Object.assign(input[5]!, change);
      expect(compareCohorts(input, options).promotable).toBe(false);
    }
  });

  it('a loss on one primary scenario cannot be hidden by another', () => {
    const input = [...rows(), ...rows().map((row) => ({ ...row, scenario: 'other' }))];
    input.find((row) => row.scenario === 'other' && row.arm === 'candidate')!.score = 0;
    expect(compareCohorts(input, { ...options, primaryScenarios: ['task', 'other'] }).verdict).toBe('regression');
  });

  it('requires the proposed mechanism to have fired and been measured', () => {
    for (const mechanismEvents of [0, null]) {
      const input = rows().map((row) => row.arm === 'candidate' ? { ...row, mechanismEvents } : row);
      expect(compareCohorts(input, options).verdict).toBe('invalid');
    }
  });

  it('permits recovered known-usage provider failures while keeping them in the denominator', () => {
    const input = rows().map((row) => ({ ...row, providerErrors: 1, attempted: 3 }));
    const result = compareCohorts(input, options);
    expect(result.promotable).toBe(true);
    expect(result.perScenario[0]?.candidate.providerErrors).toBe(5);
    expect(result.perScenario[0]?.candidate.attempted).toBe(15);
  });

  it('escalates ambiguous n=5 once to n=10, then stops without promotion', () => {
    const tie = (n: number) => rows(n).map((row) => ({ ...row, allModelTokens: 100 }));
    expect(compareCohorts(tie(5), options)).toMatchObject({ verdict: 'escalate', nextN: 10, promotable: false });
    expect(compareCohorts(tie(10), { ...options, escalated: true })).toMatchObject({ verdict: 'inconclusive', nextN: null });
    expect(compareCohorts(tie(10), options).verdict).toBe('invalid');
  });

  it('keeps provider failures in attempted accounting and missing values null', () => {
    const failed = { ...rows()[0]!, providerErrors: 1, attempted: 3, usageComplete: false, success: null, score: null };
    const summary = summarizeCohort([failed]);
    expect(summary).toMatchObject({ attempted: 3, providerErrors: 1, successRate: null, successes: null });
    expect(summary.allModelTokens.total).toBeNull();
    expect(summary.observedAllModelTokens.total).toBe(200);
    expect(summary.costByModel.agent?.total).toBeNull();
    expect(summarizeCohort([]).successRate).toBeNull();
    expect(summarizeCohort([]).allModelTokens.total).toBeNull();
  });

  it('reports partial runner usage without making incomplete totals eligible for comparison', () => {
    const input = rows();
    Object.assign(input[5]!, {
      status: 'error', success: null, score: null, evidenceVerified: false,
      providerErrors: 1, attempted: 11, usageComplete: false,
      allModelTokens: null, observedAllModelTokens: 112336, costByModel: { agent: null },
    });
    const summary = summarizeCohort(input.filter((row) => row.arm === 'candidate'));
    expect(summary.observedAllModelTokens).toMatchObject({ n: 5, missing: 0, total: 112736 });
    expect(summary.allModelTokens).toMatchObject({ n: 4, missing: 1, total: null });
    expect(summary.costByModel.agent?.total).toBeNull();
    expect(summary.successRate).toBeNull();
    expect(compareCohorts(input, options).promotable).toBe(false);
    expect(summarizeCohort([{ ...rows()[0]!, observedAllModelTokens: null }])
      .observedAllModelTokens.total).toBeNull();
    expect(summarizeCohort([{ ...rows()[0]!, observedAllModelTokens: 0 }])
      .observedAllModelTokens.total).toBe(0);
  });

  it('AUC is null without both observed classes; ties contribute half credit', () => {
    expect(auc([])).toBeNull();
    expect(auc([{ score: 1, used: true }])).toBeNull();
    expect(auc([{ score: 1, used: null }])).toBeNull();
    expect(auc([{ score: 1, used: true }, { score: 1, used: false }])).toBe(0.5);
  });
});

function fixture() {
  const blobs = new Map<string, string>();
  const put = (value: unknown) => {
    const text = JSON.stringify(value), hash = createHash('sha256').update(text).digest('hex');
    blobs.set(hash, text); return hash;
  };
  const events: CaptureEvent[] = [];
  const add = (kind: string, value: Record<string, unknown>) => events.push({ seq: events.length + 1, kind, value });
  const usage = { input: 10, output: 2, cacheRead: 20, cacheWrite: 3 };
  const request = (attempt: number, role = 'agent') => {
    const requestBlob = put({ model: role, system: 'system', messages: [{ role: 'user', content: `request ${attempt}` }] });
    add('request', { attempt, role, requestBlob, representation: 'CompletionRequest-v1' });
    return requestBlob;
  };
  const response = (attempt: number, requestBlob: string, role = 'agent') => add('response', {
    attempt, role, requestBlob, model: role, usage,
    responseBlob: put({ model: role, text: 'future answer', toolCalls: [], usage }),
  });
  return { blobs, events, add, request, response, put, read: (hash: string) => { const text = blobs.get(hash); if (text === undefined) throw new Error('missing blob'); return text; } };
}

describe('capture replay is bounded by recorded request time', () => {
  it('verifies exact interface-body hashes, includes summarizer usage, and makes no HTTP wire claim', () => {
    const f = fixture();
    f.add('manifest', { scenario: { judge: { answer: 'hidden answer key' } } });
    const first = f.request(1); f.response(1, first);
    const second = f.request(2, 'summarizer'); f.response(2, second, 'summarizer');
    f.add('judge', { success: true }); f.add('capture_complete', {});
    const callbackHistory: string[] = [];
    const result = replayCapture(f.events, f.read, (frame) => callbackHistory.push(JSON.stringify(frame.priorEvents)));
    expect(result).toMatchObject({ representation: 'exact-interface-body-replay', httpWireVerified: false, attempted: 2, allModelTokens: 70, complete: true });
    expect(result.tokensByModel).toEqual({ agent: 35, summarizer: 35 });
    expect(callbackHistory[0]).toBe('[]');
    expect(callbackHistory.every((history) => !history.includes('"judge"'))).toBe(true);
    expect(callbackHistory.every((history) => !history.includes('hidden answer key'))).toBe(true);
    expect(result.frames[0]?.requestText).toBe(f.read(first));
  });

  it('rejects corrupt or missing blobs and unmatched responses', () => {
    const f = fixture(); const hash = f.request(1); f.response(1, hash);
    expect(() => replayCapture(f.events, () => 'tampered')).toThrow(/hash mismatch/);
    expect(() => replayCapture(f.events, () => { throw new Error('missing'); })).toThrow(/missing/);
    const orphan = structuredClone(f.events); orphan[1]!.value.attempt = 2;
    expect(() => replayCapture(orphan, f.read)).toThrow(/orphan/);
  });

  it('verifies every captured context-tool and attention payload hash', () => {
    const f = fixture(); const hash = f.request(1); f.response(1, hash);
    f.add('context_tool_result', { tool: 'context_search', blob: hash });
    f.add('attention_payload', { originalBlob: hash, selectedPayloadBlob: hash });
    f.add('attention_tool', { inputBlob: hash, originalBlob: hash, messageBlob: hash });
    f.add('capture_complete', {});
    expect(replayCapture(f.events, f.read).complete).toBe(true);
    f.events[3]!.value.selectedPayloadBlob = 'a'.repeat(64);
    expect(() => replayCapture(f.events, f.read)).toThrow('missing blob');
  });

  it('reports errors and unfinished captures without pretending missing usage is zero', () => {
    const f = fixture(); const hash = f.request(1);
    f.add('provider_error', { attempt: 1, role: 'agent', requestBlob: hash, usage: null });
    f.add('capture_complete', {});
    expect(replayCapture(f.events, f.read)).toMatchObject({ attempted: 1, providerErrors: 1, allModelTokens: null, observedAllModelTokens: null, usageComplete: false });
    const pending = fixture(); pending.request(1);
    expect(replayCapture(pending.events, pending.read)).toMatchObject({ complete: false, usageComplete: false, allModelTokens: null });
  });

  it('keeps successful summarizer calls with unknown usage in attempted totals and rejects upgraded completeness', () => {
    const f = fixture(); const first = f.request(1); f.response(1, first);
    const requestBlob = f.request(2, 'summarizer');
    f.add('response', { attempt: 2, role: 'summarizer', requestBlob, model: 'summarizer', usageKnown: false, usage: null,
      responseBlob: f.put({ model: 'summarizer', text: 'valid summary', toolCalls: [], usageKnown: false, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }) });
    f.add('judge', { success: true, score: 1 }); f.add('capture_complete', {});
    expect(replayCapture(f.events, f.read)).toMatchObject({ attempted: 2, responses: 2, providerErrors: 0,
      allModelTokens: null, observedAllModelTokens: 35, usageComplete: false, judge: { success: true },
      unknownUsageModels: ['summarizer'], callsByModel: { agent: 1, summarizer: 1 } });
    f.events[3]!.value.usageKnown = true;
    expect(() => replayCapture(f.events, f.read)).toThrow('completeness mismatch');
  });

  it('reads actual RunCapture artifacts without changing them', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ct-capture-replay-'));
    try {
      const capture = new RunCapture(directory);
      const provider = capture.provider({ id: 'stub', async complete() { return { model: 'stub', text: 'done', toolCalls: [], stopReason: 'end_turn', usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 } }; } }, 'agent');
      await provider.complete({ model: 'stub', messages: [] });
      capture.archiveStore(join(directory, 'absent'));
      expect(readCapture(directory)).toMatchObject({ attempted: 1, responses: 1, allModelTokens: 3 });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
