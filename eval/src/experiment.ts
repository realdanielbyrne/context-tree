/** Deterministic evidence checks. No provider calls or policy defaults live here. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ExperimentRow {
  arm: string;
  model: string;
  scenario: string;
  replicate: string | number;
  /** Shared frozen substrate, instrument, budgets and evaluation epoch. */
  epoch: string;
  /** Frozen per-arm configuration; candidate and baseline may differ. */
  configHash: string;
  status: string;
  success: boolean | null;
  score: number | null;
  evidenceVerified: boolean;
  allModelTokens: number | null;
  /** Known usage, including partial runs; never substitutes for a complete total. */
  observedAllModelTokens?: number | null;
  costByModel: Record<string, number | null> | null;
  providerErrors: number;
  attempted: number;
  usageComplete: boolean;
  mechanismEvents: number | null;
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const nonnegative = (value: unknown): value is number => finite(value) && value >= 0;
const mean = (values: number[]): number | null => values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;

/** Linear interpolation at (n - 1) p, fixed for reproducible paired verdicts. */
export function quantile(values: readonly number[], p: number): number | null {
  if (!finite(p) || p < 0 || p > 1 || values.some((v) => !finite(v))) throw new Error('invalid quantile input');
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lo = Math.floor(index);
  return sorted[lo]! + (sorted[Math.ceil(index)]! - sorted[lo]!) * (index - lo);
}

export function distribution(values: readonly (number | null)[]) {
  const known = values.filter(finite);
  return {
    n: known.length, missing: values.length - known.length,
    mean: mean(known), median: quantile(known, 0.5), q1: quantile(known, 0.25), q3: quantile(known, 0.75),
    total: known.length === 0 || known.length !== values.length ? null : known.reduce((a, b) => a + b, 0),
  };
}

export function summarizeCohort(rows: readonly ExperimentRow[]) {
  const scores = rows.map((row) => row.evidenceVerified && finite(row.score) ? row.score : null);
  const successes = rows.map((row) => row.evidenceVerified && typeof row.success === 'boolean' ? Number(row.success) : null);
  const models = [...new Set(rows.flatMap((row) => Object.keys(row.costByModel ?? {})))].sort();
  return {
    runs: rows.length,
    attempted: rows.reduce((sum, row) => sum + row.attempted, 0),
    providerErrors: rows.reduce((sum, row) => sum + row.providerErrors, 0),
    incomplete: rows.filter((row) => row.status !== 'completed').length,
    unverified: rows.filter((row) => !row.evidenceVerified).length,
    successes: distribution(successes).total,
    successRate: successes.length > 0 && successes.every(finite) ? mean(successes) : null,
    scores: distribution(scores),
    allModelTokens: distribution(rows.map((row) => row.usageComplete ? row.allModelTokens : null)),
    observedAllModelTokens: distribution(rows.map((row) =>
      row.observedAllModelTokens === undefined ? row.allModelTokens : row.observedAllModelTokens)),
    costByModel: Object.fromEntries(models.map((model) => [model, distribution(rows.map((row) =>
      row.usageComplete && row.costByModel !== null ? row.costByModel[model] ?? (model in row.costByModel ? null : 0) : null))])),
  };
}

export interface ComparisonOptions {
  baseline: string;
  candidate: string;
  model: string;
  epoch: string;
  primaryScenarios: readonly string[];
  escalated?: boolean;
}

/**
 * No decrease in earned discrete score on ANY primary scenario, and positive
 * Q1 of paired baseline-minus-candidate all-model token usage on EVERY scenario.
 * Five ambiguous pairs may escalate once to ten. Caps/errors are never dropped.
 */
export function compareCohorts(rows: readonly ExperimentRow[], options: ComparisonOptions) {
  const reasons: string[] = [];
  const selected = rows.filter((row) => row.arm === options.baseline || row.arm === options.candidate);
  if (options.baseline === options.candidate) reasons.push('baseline and candidate must differ');
  if (options.primaryScenarios.length === 0 || new Set(options.primaryScenarios).size !== options.primaryScenarios.length) reasons.push('primary scenarios must be nonempty and unique');
  if (!options.epoch || !options.model) reasons.push('model and epoch must be explicit');
  if (selected.some((row) => row.model !== options.model || row.epoch !== options.epoch)) reasons.push('mixed model or epoch');
  for (const arm of [options.baseline, options.candidate]) {
    const hashes = new Set(selected.filter((row) => row.arm === arm).map((row) => row.configHash));
    if (hashes.size !== 1 || hashes.has('')) reasons.push(`${arm}: configuration is missing or changed within cohort`);
  }
  const perScenario = options.primaryScenarios.map((scenario) => {
    const baseline = selected.filter((row) => row.scenario === scenario && row.arm === options.baseline);
    const candidate = selected.filter((row) => row.scenario === scenario && row.arm === options.candidate);
    const ids = (arm: ExperimentRow[]) => arm.map((row) => String(row.replicate));
    const left = ids(baseline), right = ids(candidate);
    if (new Set(left).size !== left.length || new Set(right).size !== right.length) reasons.push(`${scenario}: duplicate replicate`);
    if (baseline.length !== candidate.length || left.some((id) => !right.includes(id))) reasons.push(`${scenario}: unequal or unpaired n`);
    if (baseline.length !== 5 && baseline.length !== 10) reasons.push(`${scenario}: requires n=5 or the single n=10 escalation`);
    if (baseline.length === 10 && options.escalated !== true) reasons.push(`${scenario}: n=10 needs the registered escalation`);
    if (baseline.length === 5 && options.escalated === true) reasons.push(`${scenario}: escalated cohort is incomplete`);
    for (const row of [...baseline, ...candidate]) {
      if (row.status !== 'completed') reasons.push(`${scenario}/${row.arm}/${row.replicate}: incomplete (${row.status})`);
      if (!row.evidenceVerified || typeof row.success !== 'boolean' || !finite(row.score) || row.score < 0 || row.score > 1) reasons.push(`${scenario}/${row.arm}/${row.replicate}: missing earned outcome`);
      if (!row.usageComplete || !nonnegative(row.allModelTokens) || !nonnegative(row.attempted) || row.attempted === 0 || !nonnegative(row.providerErrors) || row.providerErrors > row.attempted) reasons.push(`${scenario}/${row.arm}/${row.replicate}: missing provider accounting`);
    }
    if (candidate.some((row) => !nonnegative(row.mechanismEvents)) || !candidate.some((row) => (row.mechanismEvents ?? 0) > 0)) reasons.push(`${scenario}: candidate mechanism unmeasured or inert`);
    const benefits = baseline.map((row) => {
      const paired = candidate.find((other) => String(other.replicate) === String(row.replicate));
      return nonnegative(row.allModelTokens) && nonnegative(paired?.allModelTokens) ? row.allModelTokens - paired.allModelTokens : null;
    });
    return { scenario, n: baseline.length, baseline: summarizeCohort(baseline), candidate: summarizeCohort(candidate), pairedTokenBenefit: distribution(benefits) };
  });
  const invalid = reasons.length > 0;
  const regression = perScenario.some((s) => (s.candidate.scores.mean ?? -Infinity) < (s.baseline.scores.mean ?? Infinity)
    || (s.candidate.successRate ?? -Infinity) < (s.baseline.successRate ?? Infinity));
  const win = perScenario.length > 0 && perScenario.every((s) => (s.pairedTokenBenefit.q1 ?? -Infinity) > 0);
  const loss = perScenario.some((s) => (s.pairedTokenBenefit.q3 ?? Infinity) < 0);
  const verdict = invalid ? 'invalid' : regression || loss ? 'regression' : win ? 'win' : options.escalated ? 'inconclusive' : 'escalate';
  return { verdict, promotable: verdict === 'win', reasons, perScenario, nextN: verdict === 'escalate' ? 10 : null };
}

/** No positive or no negative labels means the ranking is unidentifiable. */
export function auc(samples: readonly { score: number; used: boolean | null }[]): number | null {
  const positive = samples.filter((s) => s.used === true && finite(s.score));
  const negative = samples.filter((s) => s.used === false && finite(s.score));
  if (positive.length === 0 || negative.length === 0) return null;
  let wins = 0;
  for (const p of positive) for (const n of negative) wins += p.score > n.score ? 1 : p.score === n.score ? 0.5 : 0;
  return wins / (positive.length * negative.length);
}

export interface CaptureEvent { seq: number; kind: string; value: Record<string, unknown> }
export interface ReplayFrame {
  seq: number;
  attempt: number;
  role: string;
  requestBlob: string;
  requestText: string;
  request: Record<string, unknown>;
  /** Earlier runtime events only: no later response, manifest answer key, or judge label. */
  priorEvents: readonly CaptureEvent[];
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Dependency-injected blob reader makes replay deterministic and testable. */
export function replayCapture(events: readonly CaptureEvent[], readBlob: (hash: string) => string, onRequest?: (frame: ReplayFrame) => void) {
  const verified = new Map<string, string>();
  const blob = (hash: unknown): string => {
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('invalid capture blob hash');
    const text = verified.get(hash) ?? readBlob(hash);
    if (createHash('sha256').update(text, 'utf8').digest('hex') !== hash) throw new Error(`capture blob hash mismatch: ${hash}`);
    verified.set(hash, text);
    return text;
  };
  const requests = new Map<number, { blob: string; role: string; model: string; settled: boolean }>();
  const frames: ReplayFrame[] = [];
  const prior: CaptureEvent[] = [];
  const tokensByModel: Record<string, number> = {};
  const callsByModel: Record<string, number> = {};
  const unknownModels = new Set<string>();
  const accountCall = (model: string, known: boolean): void => {
    callsByModel[model] = (callsByModel[model] ?? 0) + 1;
    if (!known) unknownModels.add(model);
  };
  let providerErrors = 0, responses = 0, usageComplete = true, complete = false;
  let manifest: Record<string, unknown> | null = null;
  let judge: Record<string, unknown> | null = null;
  for (const event of events) {
    if (event.seq !== prior.length + 1 || typeof event.kind !== 'string' || !record(event.value)) throw new Error('capture sequence or event shape is invalid');
    const value = event.value;
    const fields = event.kind === 'command_result' ? ['stdout', 'stderr']
      : event.kind === 'read_file' || event.kind === 'write_file' || event.kind === 'context_tool_result' ? ['blob']
      : event.kind === 'attention_payload' ? ['originalBlob', 'selectedPayloadBlob']
      : event.kind === 'attention_tool' ? ['inputBlob', 'originalBlob', 'messageBlob'] : [];
    for (const field of fields) blob(value[field]);
    if (event.kind === 'manifest') manifest = value;
    if (event.kind === 'judge') judge = value;
    if (event.kind === 'request') {
      if (value.representation !== 'CompletionRequest-v1') throw new Error('unsupported capture representation');
      if (value.attemptScope !== undefined && value.attemptScope !== 'ModelProvider.complete') throw new Error('unsupported attempt scope');
      if (!Number.isSafeInteger(value.attempt) || (value.attempt as number) < 1 || requests.has(value.attempt as number)) throw new Error('invalid or duplicate request attempt');
      const requestText = blob(value.requestBlob);
      const request: unknown = JSON.parse(requestText);
      if (!record(request) || typeof request.model !== 'string') throw new Error('invalid captured request');
      const runtimeKinds = new Set(['request', 'response', 'empty_completion', 'provider_error', 'command', 'command_result', 'read_file', 'write_file', 'context_tool_result', 'attention_payload', 'attention_tool', 'delivery_acknowledged']);
      const frame: ReplayFrame = { seq: event.seq, attempt: value.attempt as number, role: String(value.role), requestBlob: value.requestBlob as string, requestText, request, priorEvents: structuredClone(prior.filter((entry) => runtimeKinds.has(entry.kind))) };
      requests.set(frame.attempt, { blob: frame.requestBlob, role: frame.role, model: request.model, settled: false });
      frames.push(frame);
      onRequest?.(structuredClone(frame));
    }
    if (event.kind === 'response' || event.kind === 'empty_completion' || event.kind === 'provider_error') {
      const request = requests.get(value.attempt as number);
      if (request === undefined || request.settled || request.blob !== value.requestBlob || request.role !== value.role) throw new Error('orphan, duplicate, or mismatched response');
      request.settled = true;
      if (event.kind === 'provider_error') {
        if (value.model !== undefined && value.model !== request.model) throw new Error('provider error model mismatch');
        providerErrors++; usageComplete = false; accountCall(request.model, false);
      }
      else {
        const response: unknown = JSON.parse(blob(value.responseBlob));
        if (!record(response) || !record(response.usage) || typeof response.model !== 'string' || response.model !== value.model) throw new Error('invalid captured response');
        if (event.kind === 'empty_completion' && (typeof response.text !== 'string' || response.text.trim() !== '' || !Array.isArray(response.toolCalls) || response.toolCalls.length !== 0 || typeof value.usageKnown !== 'boolean')) throw new Error('invalid empty completion evidence');
        if ((value.usageKnown !== undefined && typeof value.usageKnown !== 'boolean') || (response.usageKnown !== undefined && typeof response.usageKnown !== 'boolean')) throw new Error('invalid usage completeness flag');
        const usageKnown = value.usageKnown ?? response.usageKnown ?? true;
        if (usageKnown && response.usageKnown === false) throw new Error('captured usage completeness mismatch');
        accountCall(response.model, usageKnown as boolean);
        if (event.kind === 'empty_completion') providerErrors++;
        if (!usageKnown) {
          if (value.usage !== null) throw new Error('unknown captured usage must be null');
          usageComplete = false;
        }
        else {
          if (!record(value.usage)) throw new Error('missing captured usage');
          const responseUsage = response.usage;
          const recordedUsage = value.usage;
          const counts = ['input', 'output', 'cacheRead', 'cacheWrite'].map((key) => {
            const count = responseUsage[key];
            if (!nonnegative(count) || !Number.isSafeInteger(count) || recordedUsage[key] !== count) throw new Error('captured usage mismatch');
            return count;
          });
          tokensByModel[response.model] = (tokensByModel[response.model] ?? 0) + counts.reduce((a, b) => a + b, 0);
        }
        responses++;
      }
    }
    if (event.kind === 'capture_complete') complete = event.seq === events.length;
    prior.push(structuredClone(event));
  }
  for (const request of requests.values()) if (!request.settled) {
    usageComplete = false; accountCall(request.model, false);
  }
  const observedAllModelTokens = Object.keys(tokensByModel).length === 0 ? null : Object.values(tokensByModel).reduce((a, b) => a + b, 0);
  return {
    representation: 'exact-interface-body-replay' as const, httpWireVerified: false as const,
    attemptScope: 'ModelProvider.complete' as const, transportAttempts: null,
    complete, verifiedBlobs: verified.size, attempted: requests.size, responses, providerErrors,
    usageComplete, observedAllModelTokens, allModelTokens: usageComplete && complete ? observedAllModelTokens : null,
    tokensByModel, callsByModel, unknownUsageModels: [...unknownModels].sort(), manifest, judge, frames,
  };
}

export function readCapture(directory: string, onRequest?: (frame: ReplayFrame) => void) {
  const text = readFileSync(join(directory, 'events.jsonl'), 'utf8');
  const events = text.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as CaptureEvent);
  return replayCapture(events, (hash) => readFileSync(join(directory, 'blobs', hash), 'utf8'), onRequest);
}
