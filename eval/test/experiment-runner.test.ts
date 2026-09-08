import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModelProvider } from '@context-tree/core';
import { RunCapture } from '../src/capture.js';
import { compareCohorts, type ExperimentRow } from '../src/experiment.js';
import { artifactFingerprint, canonical, configurePolicyEnvironment, deriveCeilingEvidence, deriveHistoricalCeilingEvidence, inspectAttempt,
  scientificEpoch, scheduleSlots, sha256, validateEscalation, verifyCeilingEvidence, verifyEnvironmentGates, verifyResumedRow, recordInterruptedAttempt,
  writeJsonAtomic, type AttemptMarker, type GateIdentity } from '../src/experiment-runner.js';
import type { Scenario } from '../src/types.js';
import type { DockerRuntime } from '../src/sandbox.js';

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
const temp = () => { const path = mkdtempSync(join(tmpdir(), 'experiment-runner-')); temporary.push(path); return path; };
const imageId = `sha256:${'a'.repeat(64)}`;
const verifierImageId = `sha256:${'b'.repeat(64)}`;
const source = { repository: 'https://github.com/datacurve-ai/deep-swe', commit: 'c'.repeat(40), archiveSha256: 'd'.repeat(64), taskId: 'task', files: { 'task.toml': 'e'.repeat(64) } };
function scenario(): Scenario {
  return { id: 'task', benchmark: 'deepswe', task: 'Implement this task.', judge: { kind: 'deepswe' }, environment: {
    kind: 'deepswe', taskDirectory: '/import/tasks/task', image: 'public:task', baseCommit: 'f'.repeat(40), collect: [],
    verifierTimeoutSec: 1800, verifierBuildTimeoutSec: 1800, cpus: 2, memoryMb: 8192, verifierCpus: 2, verifierMemoryMb: 8192,
    agentNetwork: 'none', verifierNetwork: 'none', source: structuredClone(source),
  } };
}
function verifierFiles(path: string, reward: number) {
  mkdirSync(join(path, 'verifier'), { recursive: true });
  mkdirSync(join(path, 'artifacts'), { recursive: true });
  writeFileSync(join(path, 'artifacts', 'model.patch'), reward ? 'committed patch' : '');
  writeJsonAtomic(join(path, 'submission.json'), { source, imageId, verifierImageId });
  writeJsonAtomic(join(path, 'verifier', 'reward.json'), { reward });
  writeJsonAtomic(join(path, 'verifier-outcome.json'), { exitCode: 0, timedOut: false });
  return { reward, imageId, artifactsDirectory: path, patchSha256: sha256(reward ? 'committed patch' : '') };
}
function gates() {
  const root = temp();
  const verification = verifierFiles(join(root, 'nop'), 0);
  const reference = verifierFiles(join(root, 'reference'), 1);
  const document = { tasks: [{ task: 'task', source: structuredClone(source), execution: { imageId }, verification, reference }] };
  const runtime: DockerRuntime = {
    sync(args) { return { exitCode: 0, stderr: '', timedOut: false, stdout: String(args[3]).includes('Labels') ? imageId : String(args.at(-1)).startsWith('context-tree-') ? verifierImageId : imageId }; },
    async run() { throw new Error('no container/model work allowed in evidence checks'); },
  };
  const identity = verifyEnvironmentGates(scenario(), [document], runtime);
  return { root, document, runtime, identity };
}
async function captured(options: { pending?: boolean; unknown?: boolean; status?: string } = {}) {
  const root = temp();
  const path = join(root, 'capture');
  const expectedManifest = { version: 1, runId: 'task-native-r1', arm: 'native', scenario: scenario(), options: { model: 'model', maxTurns: Infinity, tokenCap: 500 } };
  const marker: AttemptMarker = { version: 1, arm: 'native', scenario: 'task', replicate: 1, runId: 'task-native-r1', epoch: 'epoch',
    model: 'model', configHash: sha256(canonical(expectedManifest.options)), capturePath: path, expectedManifest, state: 'running', startedAt: '2026-09-08T00:00:00Z' };
  const capture = new RunCapture(path);
  capture.record('manifest', expectedManifest);
  const provider: ModelProvider = { id: 'fake', async complete() { return { model: 'model', text: 'Finished.', toolCalls: [], stopReason: 'stop',
    usage: { input: 100, output: 20, cacheRead: 80, cacheWrite: 0 }, ...(options.unknown ? { usageKnown: false } : {}) }; } };
  await capture.provider(provider, 'agent').complete({ model: 'model', messages: [{ role: 'user', content: 'task' }] });
  const status = options.status ?? 'completed';
  if (options.pending) {
    const requestBlob = capture.blob(JSON.stringify({ model: 'model', messages: [] }));
    capture.record('request', { attempt: 2, role: 'agent', provider: 'fake', requestBlob, representation: 'CompletionRequest-v1' });
  } else {
    capture.record('judge', { status, success: true, score: 1, detail: 'official verifier' });
    capture.archiveStore(join(root, 'absent'));
  }
  verifierFiles(join(path, 'verifier'), 1);
  const result = { runId: marker.runId, scenarioId: 'task', model: 'model', arm: 'native', capturePath: path,
    configuration: expectedManifest.options, status, success: true, judge: { score: 1, detail: 'official verifier' },
    costByModel: [{ model: 'model', usd: 0.1, usageComplete: true, priceMatched: 'model' }] };
  const gate: GateIdentity = { source, imageId, verifierImageId, checks: [] };
  return { root, path, capture, marker, result, gate };
}

describe('scientific freeze and gate provenance', () => {
  it('loads dotenv first and excludes its undeclared EVAL flags from actual and frozen policy', () => {
    const target: NodeJS.ProcessEnv = { EVAL_INHERITED: '1' };
    const env = configurePolicyEnvironment(() => { target.EVAL_DOTENV = '1'; target.PRIVATE_API_KEY = 'secret'; }, { EVAL_NATIVE_CACHE: true }, target);
    expect(env).toEqual({ EVAL_NATIVE_CACHE: 'true' });
    expect(target).toEqual({ EVAL_NATIVE_CACHE: 'true', PRIVATE_API_KEY: 'secret' });
  });
  it('keeps scheduling/output out of the epoch while changing any scientific input changes it', () => {
    const { identity } = gates();
    const input = { common: { model: 'model', tokenCap: 1000, window: 131072 }, arms: [{ id: 'native', arm: 'native' }], scenarios: [scenario()], environment: {}, gates: [identity], instrument: { 'loop.ts': 'hash' }, runtime: { node: '22' } };
    const initial = scientificEpoch(input);
    const moved = structuredClone(input); moved.scenarios[0]!.environment!.taskDirectory = '/elsewhere/tasks/task';
    expect(scientificEpoch(moved).epoch).toBe(initial.epoch);
    for (const change of [
      (next: typeof input) => { next.scenarios[0]!.task = 'Different instruction'; },
      (next: typeof input) => { next.scenarios[0]!.environment!.memoryMb++; },
      (next: typeof input) => { next.gates[0]!.verifierImageId = imageId; },
      (next: typeof input) => { next.instrument['loop.ts'] = 'changed'; },
      (next: typeof input) => { next.common.tokenCap++; },
    ]) { const next = structuredClone(input); change(next); expect(scientificEpoch(next).epoch).not.toBe(initial.epoch); }
    expect(initial.science).not.toHaveProperty('n');
    expect(initial.science).not.toHaveProperty('output');
  });
  it('rejects a task hash mismatch even when the benchmark Git commit matches', () => {
    const { document, runtime } = gates();
    const changed = scenario(); changed.environment!.source.files['task.toml'] = '0'.repeat(64);
    expect(() => verifyEnvironmentGates(changed, [document], runtime)).toThrow('full imported source');
  });
  it('rejects verifier image drift and modified gate patches', () => {
    const { document, runtime } = gates();
    writeJsonAtomic(join(document.tasks[0]!.reference.artifactsDirectory, 'submission.json'), { source, imageId, verifierImageId: imageId });
    expect(() => verifyEnvironmentGates(scenario(), [document], runtime)).toThrow('verifier image identities differ');
    writeFileSync(join(document.tasks[0]!.verification.artifactsDirectory, 'artifacts/model.patch'), 'tampered');
    expect(() => verifyEnvironmentGates(scenario(), [document], runtime)).toThrow('invalid nop gate');
  });
});

describe('measured stage ceilings', () => {
  it('reproduces historical all-model bootstrap and confines it to qualification', () => {
    const root = temp(); const path = join(root, 'old-results.json');
    writeJsonAtomic(path, [{ runId: 'old-run', metrics: { tokens: { total: 999999 } }, costByModel: [
      { model: 'agent', usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 10 } },
      { model: 'summarizer', usage: { input: 40, output: 10, cacheRead: 0, cacheWrite: 0 } },
    ] }]);
    const derived = deriveHistoricalCeilingEvidence([path]);
    expect(derived.tokenCap).toBe(420);
    expect(derived.ceilingEvidence.sources[0]!.measuredTokens).toBe(210);
    expect(verifyCeilingEvidence(derived.ceilingEvidence, 420, { allowHistorical: true })).toEqual(derived.ceilingEvidence);
    expect(() => verifyCeilingEvidence(derived.ceilingEvidence, 420)).toThrow('qualification sizing only');
    writeFileSync(path, '[]');
    expect(() => verifyCeilingEvidence(derived.ceilingEvidence, 420, { allowHistorical: true })).toThrow('nonempty');
  });
  it('derives the ceiling from reverified usage and a measured in-flight request reserve', async () => {
    const { path } = await captured();
    const derived = deriveCeilingEvidence([path]);
    expect(derived.tokenCap).toBe(400);
    expect(derived.ceilingEvidence.sources[0]).toEqual({ path, sha256: artifactFingerprint(path), measuredTokens: 200 });
    expect(verifyCeilingEvidence(derived.ceilingEvidence, 400)).toEqual(derived.ceilingEvidence);
    expect(() => verifyCeilingEvidence(derived.ceilingEvidence, 401)).toThrow('does not match');
  });
  it('accepts a closed censored pilot for sizing but rejects unknown or in-flight usage', async () => {
    expect(deriveCeilingEvidence([(await captured({ status: 'token_cap' })).path]).tokenCap).toBe(400);
    expect(() => deriveCeilingEvidence([])).toThrow('distinct');
    const pending = await captured({ pending: true });
    expect(() => deriveCeilingEvidence([pending.path])).toThrow('incomplete or unknown');
    const unknown = await captured({ unknown: true });
    expect(() => deriveCeilingEvidence([unknown.path])).toThrow('incomplete or unknown');
  });
  it('rejects changed source artifacts or a prose-only ceiling claim', async () => {
    const { path } = await captured();
    const derived = deriveCeilingEvidence([path]);
    writeFileSync(join(path, 'extra-artifact'), 'changed after registration');
    expect(() => verifyCeilingEvidence(derived.ceilingEvidence, derived.tokenCap)).toThrow('does not match');
    expect(() => verifyCeilingEvidence('measured yesterday' as any, 400)).toThrow('structured');
  });
});

describe('restarts preserve denominator and verify evidence', () => {
  it('records an explicit unverified row even when interrupted capture evidence is corrupt', async () => {
    const { marker, gate, path } = await captured({ pending: true });
    const events = readFileSync(join(path, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const request = events.find((event) => event.kind === 'request');
    writeFileSync(join(path, 'blobs', request.value.requestBlob), 'corrupted');
    const row = recordInterruptedAttempt(marker, gate, 'process interrupted');
    expect(row.captureAuditError).toContain('blob hash mismatch');
    expect(row.attemptCountComplete).toBe(false); expect(row.attempted).toBe(2);
    expect(row.evidenceVerified).toBe(false); expect(row.allModelTokens).toBeNull();
    expect(verifyResumedRow(row, marker, gate)).toEqual(row);
  });
  it('reverifies completed rows and rejects modified captures or cost provenance', async () => {
    const { marker, gate, result, path } = await captured();
    const row = inspectAttempt(marker, gate, result);
    expect(row.evidenceVerified).toBe(true);
    expect(row.allModelTokens).toBe(200);
    expect(verifyResumedRow(row, marker, gate)).toEqual(row);
    expect(() => verifyResumedRow({ ...row, allModelTokens: 1 }, marker, gate)).toThrow('evidence changed');
    expect(() => verifyResumedRow({ ...row, epoch: 'other' }, marker, gate)).toThrow('different epoch');
    writeFileSync(join(path, 'verifier/verifier/reward.json'), '{"reward":0}');
    expect(() => verifyResumedRow(row, marker, gate)).toThrow('evidence changed');
  });
  it('retains an interrupted slot and all observed attempts without inventing complete usage', async () => {
    const { marker, gate, path } = await captured({ pending: true });
    writeFileSync(join(path, 'events.jsonl'), readFileSync(join(path, 'events.jsonl'), 'utf8') + '{"seq":999');
    const row = inspectAttempt(marker, gate, undefined, 'process interrupted');
    expect(row.status).toBe('interrupted'); expect(row.attempted).toBe(2);
    expect(row.allModelTokens).toBeNull(); expect(row.observedAllModelTokens).toBe(200);
    expect(row.usageComplete).toBe(false); expect(row.score).toBeNull();
    expect(verifyResumedRow(row, marker, gate)).toEqual(row);
    const remaining = scheduleSlots(['native'], ['task'], 5).filter((slot) => !(slot.arm === row.arm && slot.scenario === row.scenario && slot.replicate === row.replicate));
    expect(remaining.map((slot) => slot.replicate)).toEqual([2, 3, 4, 5]);
  });
  it('preserves a pre-provider crash as a logical run with zero observed calls', () => {
    const root = temp();
    const marker = { version: 1, arm: 'native', scenario: 'task', replicate: 1, runId: 'run', epoch: 'epoch', model: 'model', configHash: 'config', capturePath: join(root, 'absent'), expectedManifest: {}, state: 'running', startedAt: 'now' } as AttemptMarker;
    const row = inspectAttempt(marker, { source, imageId, verifierImageId, checks: [] }, undefined, 'container startup failed');
    expect(row.status).toBe('interrupted'); expect(row.attempted).toBe(0); expect(row.usageComplete).toBe(false);
    expect(row.captureHashes).toEqual({});
  });
  it('rejects capture configuration substitution and marks missing price/usage provenance unknown', async () => {
    const { marker, gate, result } = await captured();
    expect(() => inspectAttempt({ ...marker, expectedManifest: { ...marker.expectedManifest, options: { model: 'other' } } }, gate, result)).toThrow('frozen options');
    result.costByModel[0]!.priceMatched = null as any;
    expect(inspectAttempt(marker, gate, result).costByModel).toEqual({ model: null });
    result.costByModel[0]!.priceMatched = 'model'; result.costByModel[0]!.usageComplete = false;
    expect(inspectAttempt(marker, gate, result).costByModel).toEqual({ model: null });
  });
});

describe('registered equal-pair escalation', () => {
  const rows = (): ExperimentRow[] => ['baseline', 'ambiguous', 'clear'].flatMap((arm) => Array.from({ length: 5 }, (_, index) => ({
    arm, model: 'model', scenario: 'task', replicate: index + 1, epoch: 'epoch', configHash: arm,
    status: 'completed', success: true, score: 1, evidenceVerified: true, allModelTokens: arm === 'clear' ? 50 : 100,
    costByModel: null, providerErrors: 0, attempted: 1, usageComplete: true, mechanismEvents: 1,
  })));
  it('appends exactly five replicates to both sides of ambiguous comparisons', () => {
    const initial = scheduleSlots(['baseline', 'ambiguous', 'clear'], ['task'], 5);
    const extended = scheduleSlots(['baseline', 'ambiguous', 'clear'], ['task'], 10, ['ambiguous']);
    expect(extended.slice(0, initial.length)).toEqual(initial);
    expect(extended.filter((slot) => slot.arm === 'baseline')).toHaveLength(10);
    expect(extended.filter((slot) => slot.arm === 'ambiguous')).toHaveLength(10);
    expect(extended.filter((slot) => slot.arm === 'clear')).toHaveLength(5);
  });
  it('requires the hashed same-epoch checkpoint and recomputes its ambiguity', () => {
    const output = temp();
    const path = join(output, 'summary-n5.json');
    const comparisons = ['ambiguous', 'clear'].map((candidate) => ({ candidate, ...compareCohorts(rows(), { baseline: 'baseline', candidate, model: 'model', epoch: 'epoch', primaryScenarios: ['task'] }) }));
    writeJsonAtomic(path, { epoch: 'epoch', n: 5, comparisons });
    const evidence = { summaryPath: path, sha256: sha256(readFileSync(path)), candidates: ['ambiguous'] };
    expect(validateEscalation(evidence, output, 'epoch', ['baseline', 'ambiguous', 'clear'], ['task'], rows())).toEqual(['ambiguous']);
    expect(() => validateEscalation({ ...evidence, candidates: ['clear'] }, output, 'epoch', ['baseline', 'ambiguous', 'clear'], ['task'], rows())).toThrow('not an ambiguous');
    expect(() => validateEscalation(evidence, output, 'other', ['baseline', 'ambiguous', 'clear'], ['task'], rows())).toThrow('another epoch');
    const changed = rows(); changed[5]!.allModelTokens = 1;
    expect(() => validateEscalation(evidence, output, 'epoch', ['baseline', 'ambiguous', 'clear'], ['task'], changed)).toThrow('reverified paired outcomes');
  });
});
