/** Experiment orchestration evidence rules, separated from provider execution. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { deepSweVerifierImage, type DeepSweEnvironment } from './adapters/deepswe.js';
import { submissionDigest, submissionLines, type LhtbEnvironment } from './adapters/lhtb.js';
import { compareCohorts, readCapture, replayCapture, type CaptureEvent, type ExperimentRow } from './experiment.js';
import type { DockerRuntime } from './sandbox.js';
import type { Scenario } from './types.js';

export const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
export const readJson = (path: string): any => JSON.parse(readFileSync(path, 'utf8'));

/** Match serialized provider/capture options, including unbounded Infinity -> null. */
export function canonical(value: unknown): string {
  const normalize = (input: any): any => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input !== null && typeof input === 'object') return Object.fromEntries(Object.keys(input).sort().filter((key) => input[key] !== undefined).map((key) => [key, normalize(input[key])]));
    return typeof input === 'number' && !Number.isFinite(input) ? null : input;
  };
  return JSON.stringify(normalize(value));
}

export function artifactHashes(directory: string): Record<string, string> {
  const root = resolve(directory);
  const walk = (path: string): [string, string][] => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error(`nonregular evidence artifact: ${path}`);
    if (stat.isDirectory()) return readdirSync(path).sort().flatMap((name) => walk(join(path, name)));
    return [[relative(root, path), sha256(readFileSync(path))]];
  };
  return Object.fromEntries(walk(root));
}

export const artifactFingerprint = (directory: string): string => sha256(canonical(artifactHashes(directory)));

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n');
  renameSync(temporary, path);
}

/** Dotenv is loaded first; inherited or dotenv EVAL flags cannot leak into arms. */
export function configurePolicyEnvironment(loadDotenv: () => void, requested: Record<string, unknown>, target: NodeJS.ProcessEnv = process.env): Record<string, string> {
  loadDotenv();
  const frozen: Record<string, string> = {};
  for (const [key, value] of Object.entries(requested).sort(([a], [b]) => a.localeCompare(b))) {
    if (!/^EVAL_[A-Z0-9_]+$/.test(key) || !['string', 'number', 'boolean'].includes(typeof value)) throw new Error('manifest environment must contain scalar EVAL_ policy toggles only');
    frozen[key] = String(value);
  }
  for (const key of Object.keys(target)) if (key.startsWith('EVAL_')) delete target[key];
  Object.assign(target, frozen);
  return frozen;
}

export interface CeilingSource { path: string; sha256: string; measuredTokens: number }
export interface CaptureCeilingEvidence { method: 'max-run-plus-max-request'; sources: CeilingSource[] }
export interface HistoricalCeilingEvidence {
  method: 'historical-max-run-times-two';
  purpose: 'qualification-sizing-only';
  accountingScope: 'reported-usage-only; hidden-transport-retries-unobservable';
  sources: (CeilingSource & { runId: string })[];
}
export type CeilingEvidence = CaptureCeilingEvidence | HistoricalCeilingEvidence;

/** Generate a reviewable ceiling from COMPLETE measured captures, never prose. */
export function deriveCeilingEvidence(paths: readonly string[]): { tokenCap: number; ceilingEvidence: CaptureCeilingEvidence } {
  if (paths.length === 0 || new Set(paths.map((path) => resolve(path))).size !== paths.length) throw new Error('distinct measured ceiling source captures required');
  let largestRequest = 0;
  const sources = paths.map((source) => {
    const path = resolve(source);
    const capture = readCapture(path);
    if (!capture.complete || !capture.usageComplete || capture.allModelTokens === null || capture.allModelTokens <= 0) throw new Error(`ceiling source has incomplete or unknown usage: ${path}`);
    const events: CaptureEvent[] = readFileSync(join(path, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    for (const event of events) {
      if (event.kind !== 'response' && event.kind !== 'empty_completion') continue;
      const usage = event.value.usage as Record<string, unknown>;
      const tokens = ['input', 'output', 'cacheRead', 'cacheWrite'].map((key) => usage?.[key]);
      if (tokens.some((count) => typeof count !== 'number' || !Number.isFinite(count) || count < 0)) throw new Error('ceiling source has incomplete request usage');
      largestRequest = Math.max(largestRequest, (tokens as number[]).reduce((a, b) => a + b, 0));
    }
    return { path, sha256: artifactFingerprint(path), measuredTokens: capture.allModelTokens };
  });
  return { tokenCap: Math.ceil(Math.max(...sources.map((source) => source.measuredTokens)) + largestRequest), ceilingEvidence: { method: 'max-run-plus-max-request', sources } };
}

/** Reproduce the already registered bootstrap from committed historical artifacts.
 * It confers no efficacy, transport-attempt, or complete-billing evidence. */
export function deriveHistoricalCeilingEvidence(paths: readonly string[]): { tokenCap: number; ceilingEvidence: HistoricalCeilingEvidence } {
  if (paths.length === 0 || new Set(paths.map((path) => resolve(path))).size !== paths.length) throw new Error('distinct historical usage files required');
  const sources = paths.map((sourcePath) => {
    const path = resolve(sourcePath);
    const rows: unknown = readJson(path);
    if (!Array.isArray(rows) || rows.length === 0) throw new Error('historical source must be a nonempty run-results array');
    const runs = rows.map((row) => {
      if (typeof row.runId !== 'string' || !row.runId || !Array.isArray(row.costByModel) || row.costByModel.length === 0) throw new Error('historical run lacks identity or all-model usage');
      const measuredTokens = row.costByModel.reduce((sum: number, entry: any) => {
        const counts = ['input', 'output', 'cacheRead', 'cacheWrite'].map((key) => entry.usage?.[key]);
        if (counts.some((count) => !Number.isSafeInteger(count) || count < 0) || entry.usageComplete === false) throw new Error('historical run contains unknown usage');
        return sum + counts.reduce((a: number, b: number) => a + b, 0);
      }, 0);
      return { runId: row.runId as string, measuredTokens };
    }).sort((a, b) => b.measuredTokens - a.measuredTokens || a.runId.localeCompare(b.runId));
    if (runs[0]!.measuredTokens <= 0) throw new Error('historical run has no positive measured usage');
    return { path, sha256: sha256(readFileSync(path)), ...runs[0]! };
  });
  return { tokenCap: 2 * Math.max(...sources.map((source) => source.measuredTokens)), ceilingEvidence: {
    method: 'historical-max-run-times-two', purpose: 'qualification-sizing-only',
    accountingScope: 'reported-usage-only; hidden-transport-retries-unobservable', sources,
  } };
}

export function verifyCeilingEvidence(evidence: CeilingEvidence, tokenCap: number, options: { allowHistorical?: boolean } = {}): CeilingEvidence {
  if (!['max-run-plus-max-request', 'historical-max-run-times-two'].includes(evidence?.method) || !Array.isArray(evidence.sources) || evidence.sources.length === 0) throw new Error('structured, measured ceiling evidence is required');
  if (evidence.sources.some((source) => typeof source?.path !== 'string' || !/^[a-f0-9]{64}$/.test(source.sha256) || !Number.isSafeInteger(source.measuredTokens) || source.measuredTokens <= 0)) throw new Error('ceiling sources require paths, SHA256 hashes and measured token totals');
  if (evidence.method === 'historical-max-run-times-two' && options.allowHistorical !== true) throw new Error('historical bootstrap is permitted for qualification sizing only');
  const measured = evidence.method === 'historical-max-run-times-two'
    ? deriveHistoricalCeilingEvidence(evidence.sources.map((source) => source.path))
    : deriveCeilingEvidence(evidence.sources.map((source) => source.path));
  if (canonical(measured.ceilingEvidence) !== canonical(evidence) || measured.tokenCap !== tokenCap) throw new Error('ceiling evidence or derived token ceiling does not match measured sources');
  return measured.ceilingEvidence;
}

/**
 * A benchmark's gate identity. Discriminated rather than optional-everything,
 * because the two benchmarks pin genuinely different things: DEEPSWE pins a
 * BUILT verifier image (whose ancestry label is inspectable), LHTB pins the
 * per-file hashes of hidden tests staged into the verifier container, since no
 * verifier image is built for it.
 */
export interface DeepSweGateIdentity {
  benchmark: 'deepswe';
  source: DeepSweEnvironment['source'];
  imageId: string;
  verifierImageId: string;
  checks: { kind: 'nop' | 'reference'; path: string; hashes: Record<string, string> }[];
}

export interface LhtbGateIdentity {
  benchmark: 'lhtb';
  source: LhtbEnvironment['source'];
  imageId: string;
  verifierImageId: string;
  /** Substitute for DEEPSWE's verifier-image ancestry label; see below. */
  stagedTests: Record<string, string>;
  checks: { kind: 'pristine' | 'reference'; path: string; hashes: Record<string, string> }[];
}

export type GateIdentity = DeepSweGateIdentity | LhtbGateIdentity;

function verifiedGateResult(result: any, kind: 'nop' | 'reference', environment: DeepSweEnvironment, imageId: string) {
  const path = resolve(String(result?.artifactsDirectory));
  const reward = readJson(join(path, 'verifier', 'reward.json'));
  const outcome = readJson(join(path, 'verifier-outcome.json'));
  const submission = readJson(join(path, 'submission.json'));
  const expectedReward = kind === 'nop' ? 0 : 1;
  if (result?.reward !== expectedReward || reward.reward !== expectedReward || outcome.exitCode !== 0 || outcome.timedOut !== false
    || canonical(submission.source) !== canonical(environment.source) || submission.imageId !== imageId || result.imageId !== imageId
    || typeof submission.verifierImageId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(submission.verifierImageId)
    || sha256(readFileSync(join(path, 'artifacts', 'model.patch'))) !== result.patchSha256) throw new Error(`invalid ${kind} gate artifacts: ${environment.source.taskId}`);
  return { verifierImageId: submission.verifierImageId, check: { kind, path, hashes: artifactHashes(path) } };
}

/** Match all task bytes and both image identities, not just repository commit. */
function verifyDeepSweGates(scenario: Scenario, documents: readonly any[], runtime: DockerRuntime): DeepSweGateIdentity {
  const environment = scenario.environment;
  if (environment?.kind !== 'deepswe') throw new Error('official DEEPSWE environment required');
  const rows = documents.flatMap((document) => document.tasks ?? []).filter((row) => row.task === scenario.id);
  if (rows.length === 0 || rows.some((row) => canonical(row.source) !== canonical(environment.source))) throw new Error(`task ${scenario.id} gate source differs from full imported source`);
  const imageIds = new Set(rows.map((row) => row.execution?.imageId));
  if (imageIds.size !== 1) throw new Error(`mixed gate image identities: ${scenario.id}`);
  const imageId = [...imageIds][0];
  if (typeof imageId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error('invalid gate agent image ID');
  const nopRows = rows.filter((row) => row.verification);
  const referenceRows = rows.filter((row) => row.reference);
  if (nopRows.length !== 1 || referenceRows.length !== 1) throw new Error(`task ${scenario.id} needs exactly one nop and reference gate`);
  const nop = verifiedGateResult(nopRows[0].verification, 'nop', environment, imageId);
  const reference = verifiedGateResult(referenceRows[0].reference, 'reference', environment, imageId);
  if (nop.verifierImageId !== reference.verifierImageId) throw new Error('nop/reference verifier image identities differ');
  const inspect = (format: string, name: string) => {
    const response = runtime.sync(['image', 'inspect', '--format', format, name]);
    if (response.exitCode !== 0) throw new Error(`cannot inspect gated image: ${response.stderr}`);
    return response.stdout.trim();
  };
  if (inspect('{{.Id}}', environment.image) !== imageId || inspect('{{.Id}}', deepSweVerifierImage(environment)) !== nop.verifierImageId
    || inspect('{{index .Config.Labels "context-tree.deepswe.base-image"}}', nop.verifierImageId) !== imageId) throw new Error(`current Docker images differ from gates: ${scenario.id}`);
  return { benchmark: 'deepswe', source: environment.source, imageId, verifierImageId: nop.verifierImageId, checks: [nop.check, reference.check] };
}

/**
 * One LHTB gate, re-read from disk rather than trusted from the document.
 *
 * The dense reward is read from the raw `reward.txt` the official verifier
 * wrote and is required to be EXACTLY 0 (pristine) or 1 (reference); a
 * nonzero verifier exit is expected on the pristine gate, because a failing
 * suite makes `test.sh` exit nonzero by design, so `timedOut` and a recorded
 * exit code are the infrastructure signals here instead.
 */
function verifiedLhtbGate(result: any, kind: 'pristine' | 'reference', environment: LhtbEnvironment, imageId: string) {
  const path = resolve(String(result?.artifactsDirectory));
  const rewardRaw = readFileSync(join(path, 'verifier', 'reward.txt'), 'utf8');
  const outcome = readJson(join(path, 'verifier-outcome.json'));
  const submission = readJson(join(path, 'submission.json'));
  const verification = readJson(join(path, 'verification.json'));
  const expectedReward = kind === 'pristine' ? 0 : 1;
  const digest = submissionDigest(join(path, 'submission'));
  const stagedTests = Object.fromEntries(Object.entries(environment.source.files).filter(([name]) => name.startsWith('tests/')));
  const hiddenTestHashes = new Set(Object.values(stagedTests));
  if (Number.parseFloat(rewardRaw.trim()) !== expectedReward || result?.reward !== expectedReward
    || outcome.timedOut !== false || !Number.isSafeInteger(outcome.exitCode)
    || (kind === 'reference' && (outcome.exitCode !== 0 || result.total <= 0 || result.passed !== result.total || (result.failedTests ?? []).length !== 0))
    // Every field the sandbox durably recorded must be reproduced in the gate
    // document; the document's own annotations (failedTests, solveExitCode)
    // are additive, so compare on verification.json's key set rather than
    // maintaining an exclusion list that silently rots.
    || canonical(verification) !== canonical(Object.fromEntries(Object.keys(verification).map((key) => [key, result[key]])))
    || canonical(submission.source) !== canonical(environment.source) || submission.imageId !== imageId || result.imageId !== imageId
    || submission.verifierMode !== environment.verifierMode
    || submission.agentNetwork !== environment.agentNetwork || submission.verifierNetwork !== environment.verifierNetwork
    || typeof submission.verifierImageId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(submission.verifierImageId)
    || digest.submissionSha256 !== result.submissionSha256 || digest.files !== submission.files
    || canonical(result.stagedTests) !== canonical(stagedTests)
    // Hidden tests never entered the agent container, so no byte the agent
    // container exported may hash to a pinned hidden test. Checked by content,
    // not path, so a renamed copy cannot slip through.
    || submissionLines(join(path, 'submission')).some((line) => hiddenTestHashes.has(line.slice(0, 64)))) throw new Error(`invalid ${kind} gate artifacts: ${environment.source.taskId}`);
  return { verifierImageId: submission.verifierImageId, stagedTests, check: { kind, path, hashes: artifactHashes(path) } };
}

/**
 * LHTB's gate identity. Enforces the same guarantees as the DEEPSWE branch:
 * every pinned task byte (including the whole-task `sourceHash` and the
 * recorded reference-solution hashes) matches the import, exactly one pristine
 * and one reference gate exist, pristine reward is 0 and reference reward is 1,
 * and both image identities are pinned in the document and re-inspected live.
 *
 * One DEEPSWE check has no LHTB analogue: there is no verifier-image ancestry
 * label to inspect, because no verifier image is built (the aarch64 host has
 * no buildx and the legacy builder cannot export a child of a single-platform
 * amd64 image). It is replaced, not dropped: the hidden tests staged into the
 * verifier container were hashed INSIDE that container at grade time, and those
 * hashes must equal the pinned `tests/` hashes here.
 */
function verifyLhtbGates(scenario: Scenario, documents: readonly any[], runtime: DockerRuntime): LhtbGateIdentity {
  const environment = scenario.environment;
  if (environment?.kind !== 'lhtb') throw new Error('official LHTB environment required');
  const rows = documents.flatMap((document) => document.tasks ?? []).filter((row) => row.task === scenario.id);
  if (rows.length === 0 || rows.some((row) => canonical(row.source) !== canonical(environment.source))) throw new Error(`task ${scenario.id} gate source differs from full imported source`);
  const imageIds = new Set(rows.map((row) => row.images?.task?.id));
  const verifierBaseIds = new Set(rows.map((row) => row.images?.verifierBase?.id));
  if (imageIds.size !== 1 || verifierBaseIds.size !== 1) throw new Error(`mixed gate image identities: ${scenario.id}`);
  const imageId = [...imageIds][0];
  const verifierBaseId = [...verifierBaseIds][0];
  for (const id of [imageId, verifierBaseId]) {
    if (typeof id !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(id)) throw new Error('invalid gate image ID');
  }
  const isolationRows = rows.filter((row) => row.isolation);
  if (isolationRows.length !== 1) throw new Error(`task ${scenario.id} needs exactly one recorded agent-isolation probe`);
  const isolation = isolationRows[0].isolation;
  if (isolation.exitCode !== 0 || isolation.agentHasHiddenTests !== false || isolation.agentHasSolution !== false
    || !String(isolation.probe).includes('test ! -e /tests') || !String(isolation.probe).includes('test ! -e /solution')) {
    throw new Error(`task ${scenario.id} agent container was not proven free of hidden tests and the reference solution`);
  }
  const pristineRows = rows.filter((row) => row.pristine);
  const referenceRows = rows.filter((row) => row.reference);
  if (pristineRows.length !== 1 || referenceRows.length !== 1) throw new Error(`task ${scenario.id} needs exactly one pristine and reference gate`);
  const pristine = verifiedLhtbGate(pristineRows[0].pristine, 'pristine', environment, imageId);
  const reference = verifiedLhtbGate(referenceRows[0].reference, 'reference', environment, imageId);
  if (pristine.verifierImageId !== reference.verifierImageId) throw new Error('pristine/reference verifier image identities differ');
  if (pristine.verifierImageId !== verifierBaseId) throw new Error('gate verifier image differs from the recorded pinned verifier base');
  const inspect = (name: string) => {
    const response = runtime.sync(['image', 'inspect', '--format', '{{.Id}}', name]);
    if (response.exitCode !== 0) throw new Error(`cannot inspect gated image: ${response.stderr}`);
    return response.stdout.trim();
  };
  if (inspect(environment.image) !== imageId || inspect(environment.verifierImage) !== pristine.verifierImageId) {
    throw new Error(`current Docker images differ from gates: ${scenario.id}`);
  }
  return { benchmark: 'lhtb', source: environment.source, imageId, verifierImageId: pristine.verifierImageId,
    stagedTests: pristine.stagedTests, checks: [pristine.check, reference.check] };
}

/** Dispatch on the scenario's own environment, never on a manifest claim. */
export function verifyEnvironmentGates(scenario: Scenario, documents: readonly any[], runtime: DockerRuntime): GateIdentity {
  if (scenario.environment?.kind === 'lhtb') return verifyLhtbGates(scenario, documents, runtime);
  return verifyDeepSweGates(scenario, documents, runtime);
}

export function scientificEpoch(inputs: { common: Record<string, unknown>; arms: readonly unknown[]; scenarios: readonly Scenario[]; environment: Record<string, string>; gates: readonly GateIdentity[]; instrument: Record<string, string>; runtime: unknown }) {
  const science = {
    version: 2, common: inputs.common, arms: inputs.arms, environment: inputs.environment,
    scenarios: inputs.scenarios.map((scenario) => ({ ...scenario, environment: scenario.environment === undefined ? undefined : { ...scenario.environment, taskDirectory: undefined } })),
    gates: inputs.gates.map((gate) => ({ ...gate, checks: gate.checks.map(({ kind, hashes }) => ({ kind, hashes })) })),
    instrument: inputs.instrument, runtime: inputs.runtime,
    protocol: { initialN: 5, escalatedN: 10, maximumEscalations: 1, trigger: 'compareCohorts.verdict=escalate', completionRequired: true },
  };
  return { version: 2, epoch: sha256(canonical(science)), science };
}

export interface Slot { arm: string; scenario: string; replicate: number }
export interface EscalationEvidence { summaryPath: string; sha256: string; candidates: string[] }

/** Retain n=5 for clear pairs; extend only ambiguous candidates AND their baseline. */
export function scheduleSlots(arms: readonly string[], tasks: readonly string[], n: number, escalatedCandidates: readonly string[] = []): Slot[] {
  if (![1, 5, 10].includes(n) || arms.length === 0 || tasks.length === 0) throw new Error('invalid experiment schedule');
  if (n === 10 && (escalatedCandidates.length === 0 || escalatedCandidates.some((arm) => arm === arms[0] || !arms.includes(arm)))) throw new Error('n=10 needs explicitly selected ambiguous candidates');
  const raised = new Set([arms[0], ...escalatedCandidates]);
  const slots: Slot[] = [];
  for (let replicate = 1; replicate <= n; replicate++) for (const scenario of tasks) {
    const offset = (replicate - 1) % arms.length;
    for (const arm of [...arms.slice(offset), ...arms.slice(0, offset)]) if (replicate <= 5 || n === 1 || raised.has(arm)) slots.push({ arm, scenario, replicate });
  }
  return slots;
}

export function validateEscalation(evidence: EscalationEvidence, output: string, epoch: string, arms: readonly string[], tasks: readonly string[], rows: readonly ExperimentRow[]): string[] {
  if (!evidence || !Array.isArray(evidence.candidates) || evidence.candidates.length === 0 || new Set(evidence.candidates).size !== evidence.candidates.length
    || resolve(evidence.summaryPath) !== join(resolve(output), 'summary-n5.json') || sha256(readFileSync(evidence.summaryPath)) !== evidence.sha256) throw new Error('n=10 requires the immutable same-output n=5 checkpoint and selected candidates');
  const summary = readJson(evidence.summaryPath);
  if (summary.epoch !== epoch || summary.n !== 5) throw new Error('escalation checkpoint belongs to another epoch or n');
  for (const candidate of evidence.candidates) {
    if (candidate === arms[0] || !arms.includes(candidate) || summary.comparisons?.find((row: any) => row.candidate === candidate)?.verdict !== 'escalate') throw new Error(`candidate is not an ambiguous n=5 comparison: ${candidate}`);
    for (const scenario of tasks) for (const arm of [arms[0], candidate]) for (let replicate = 1; replicate <= 5; replicate++) {
      if (rows.filter((row) => row.epoch === epoch && row.arm === arm && row.scenario === scenario && row.replicate === replicate).length !== 1) throw new Error('escalation requires complete paired n=5 rows');
    }
    const comparison = compareCohorts(rows.filter((row) => Number(row.replicate) <= 5), { baseline: arms[0]!, candidate,
      model: rows.find((row) => row.arm === arms[0])?.model ?? '', epoch, primaryScenarios: tasks });
    if (comparison.verdict !== 'escalate' || canonical({ candidate, ...comparison }) !== canonical(summary.comparisons.find((row: any) => row.candidate === candidate))) {
      throw new Error('n=5 escalation checkpoint does not match reverified paired outcomes');
    }
  }
  return evidence.candidates;
}

export interface AttemptMarker extends Slot {
  version: 1; runId: string; epoch: string; configHash: string; model: string;
  capturePath: string; expectedManifest: Record<string, unknown>; state: 'running' | 'settled'; startedAt: string;
}

export interface RunnerRow extends ExperimentRow {
  runId: string; capturePath: string; captureHashes: Record<string, string>;
  artifactHashes: Record<string, string>; observedAllModelTokens: number | null;
  interruption?: string; result?: any;
  attemptScope: 'ModelProvider.complete';
  transportAttempts: null;
  captureAuditError?: string;
  attemptCountComplete?: boolean;
}

/** Even corrupt evidence cannot erase a spent logical attempt. Counts from
 * parseable records are explicitly incomplete; no score/token total is earned. */
export function recordInterruptedAttempt(marker: AttemptMarker, gate: GateIdentity, reason: string): RunnerRow {
  try { return inspectAttempt(marker, gate, undefined, reason); }
  catch (error) {
    const walk = (path: string): [string, string][] => {
      const stat = lstatSync(path);
      if (stat.isDirectory()) return readdirSync(path).sort().flatMap((name) => walk(join(path, name)));
      return [[relative(marker.capturePath, path), sha256(stat.isSymbolicLink() ? `symlink:${readlinkSync(path)}` : readFileSync(path))]];
    };
    let captureHashes: Record<string, string> = {};
    let lines: any[] = [];
    try { captureHashes = Object.fromEntries(walk(marker.capturePath)); } catch { /* Unreadable files remain unverified. */ }
    try { lines = readFileSync(join(marker.capturePath, 'events.jsonl'), 'utf8').split('\n').flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }); } catch { /* No trustworthy request count. */ }
    return {
      arm: marker.arm, model: marker.model, scenario: marker.scenario, replicate: marker.replicate, epoch: marker.epoch,
      configHash: marker.configHash, runId: marker.runId, capturePath: marker.capturePath,
      status: 'interrupted', success: null, score: null, evidenceVerified: false,
      allModelTokens: null, observedAllModelTokens: null, costByModel: null,
      providerErrors: lines.filter((line) => line?.kind === 'provider_error' || line?.kind === 'empty_completion').length,
      attempted: lines.filter((line) => line?.kind === 'request').length,
      usageComplete: false, mechanismEvents: null, captureHashes, artifactHashes: {},
      attemptScope: 'ModelProvider.complete', transportAttempts: null, attemptCountComplete: false,
      interruption: reason, captureAuditError: String(error),
    };
  }
}

/** An interrupted final append may be partial; retain its bytes in the hash. */
function inspectCapture(path: string, allowPartial: boolean) {
  if (!existsSync(join(path, 'events.jsonl'))) return null;
  const text = readFileSync(join(path, 'events.jsonl'), 'utf8');
  const lines = text.split('\n');
  const events: CaptureEvent[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]?.trim()) continue;
    try { events.push(JSON.parse(lines[i]!)); }
    catch (error) { if (!allowPartial || i !== lines.length - 1 || text.endsWith('\n')) throw error; }
  }
  const replay = replayCapture(events, (hash) => readFileSync(join(path, 'blobs', hash), 'utf8'));
  return { replay, events };
}

export function verifyCaptureManifest(actual: Record<string, unknown> | null, expected: Record<string, unknown>): void {
  if (actual === null) throw new Error('capture has no manifest');
  for (const [key, value] of Object.entries(expected)) if (canonical(actual[key]) !== canonical(value)) throw new Error(`capture manifest differs from frozen ${key}`);
}

/** Recompute evidence, including null unknown usage, for BOTH fresh and resumed rows. */
export function inspectAttempt(marker: AttemptMarker, gate: GateIdentity, result?: any, interruption?: string): RunnerRow {
  const capture = inspectCapture(marker.capturePath, interruption !== undefined);
  if (capture?.replay.manifest) verifyCaptureManifest(capture.replay.manifest, marker.expectedManifest);
  else if (interruption === undefined) throw new Error('completed attempt is missing its capture manifest');
  const replay = capture?.replay;
  const captureHashes = existsSync(marker.capturePath) ? artifactHashes(marker.capturePath) : {};
  let evidenceVerified = false;
  let verifierHashes: Record<string, string> = {};
  if (result !== undefined) {
    if (result.runId !== marker.runId || result.scenarioId !== marker.scenario || result.model !== marker.model
      || result.arm !== marker.expectedManifest.arm || resolve(result.capturePath) !== resolve(marker.capturePath)
      || canonical(result.configuration) !== canonical(marker.expectedManifest.options)) throw new Error('run result identity/configuration differs from frozen attempt');
    const verifierPath = join(marker.capturePath, 'verifier');
    if (existsSync(verifierPath)) {
      verifierHashes = artifactHashes(verifierPath);
      const outcome = readJson(join(verifierPath, 'verifier-outcome.json'));
      const submission = readJson(join(verifierPath, 'submission.json'));
      // LHTB's reward is a dense float in a raw reward.txt, and a failing suite
      // exits nonzero by design, so neither the DEEPSWE reward.json shape nor
      // its exitCode===0 requirement applies. Everything else is identical.
      const reward = gate.benchmark === 'lhtb'
        ? Number.parseFloat(readFileSync(join(verifierPath, 'verifier', 'reward.txt'), 'utf8').trim())
        : readJson(join(verifierPath, 'verifier', 'reward.json')).reward;
      const rewardInRange = gate.benchmark === 'lhtb' ? Number.isFinite(reward) && reward >= 0 && reward <= 1 : [0, 1].includes(reward);
      const exitAcceptable = gate.benchmark === 'lhtb' ? Number.isSafeInteger(outcome.exitCode) : outcome.exitCode === 0;
      const stagedTestsMatch = gate.benchmark !== 'lhtb' || canonical(readJson(join(verifierPath, 'verification.json')).stagedTests) === canonical(gate.stagedTests);
      evidenceVerified = replay?.complete === true && exitAcceptable && outcome.timedOut === false && rewardInRange && stagedTestsMatch
        && result.judge?.score === reward && result.success === (reward === 1)
        && canonical(submission.source) === canonical(gate.source) && submission.imageId === gate.imageId && submission.verifierImageId === gate.verifierImageId
        && canonical(replay.judge) === canonical({ status: result.status, success: result.success, score: result.judge?.score, detail: result.judge?.detail });
    }
  }
  const costByModel = result === undefined ? null : Object.fromEntries((result.costByModel ?? []).map((entry: any) => [entry.model,
    entry.usageComplete === true && entry.priceMatched !== null && typeof entry.priceMatched === 'string' ? entry.usd : null]));
  return {
    arm: marker.arm, model: marker.model, scenario: marker.scenario, replicate: marker.replicate, epoch: marker.epoch,
    configHash: marker.configHash, runId: marker.runId, capturePath: marker.capturePath,
    status: interruption === undefined ? result?.status ?? 'interrupted' : 'interrupted',
    success: interruption === undefined ? result?.success ?? null : null, score: interruption === undefined ? result?.judge?.score ?? null : null,
    evidenceVerified: interruption === undefined && evidenceVerified,
    allModelTokens: interruption === undefined ? replay?.allModelTokens ?? null : null,
    observedAllModelTokens: replay?.observedAllModelTokens ?? null,
    costByModel, providerErrors: replay?.providerErrors ?? 0, attempted: replay?.attempted ?? 0,
    attemptScope: 'ModelProvider.complete', transportAttempts: null,
    usageComplete: interruption === undefined && replay?.complete === true && replay.usageComplete,
    mechanismEvents: capture === null ? null : capture.events.filter((event) => event.value?.mechanismApplied === true).length,
    captureHashes, artifactHashes: verifierHashes,
    ...(interruption === undefined ? {} : { interruption }), ...(result === undefined ? {} : { result }),
  };
}

export function verifyResumedRow(row: RunnerRow, marker: AttemptMarker, gate: GateIdentity): RunnerRow {
  if (row.epoch !== marker.epoch || row.configHash !== marker.configHash || row.runId !== marker.runId || row.arm !== marker.arm
    || row.scenario !== marker.scenario || row.replicate !== marker.replicate || row.model !== marker.model) throw new Error('resumed row has a different epoch/configuration/slot');
  const actual = row.captureAuditError === undefined ? inspectAttempt(marker, gate, row.result, row.interruption)
    : recordInterruptedAttempt(marker, gate, row.interruption ?? 'interrupted');
  if (canonical(actual) !== canonical(row)) throw new Error(`resumed evidence changed: ${marker.runId}`);
  return actual;
}
