/**
 * §15's metric set: task success rate, tool-call count, input tokens split
 * cache-read vs cache-write, p50/p95 latency, cost per task, and organization
 * quality (stale-summary incidents, `context_peek` precision).
 *
 * The one rule that shapes every function here: a metric with no inputs is
 * `null`, never `0`. An arm that did not run has no success rate; reporting
 * 0% would read as "it failed everything" and would make §15's headline
 * comparison a lie told by arithmetic.
 *
 * The second rule: measured and simulated numbers never mix. Provider
 * `TokenUsage` is what the API billed; core's `ProviderCacheSimulator` is what
 * §17's model of the cache predicts. Both are useful and they are reported side
 * by side with their source stamped, but an average across the two would be a
 * number nothing produced.
 */
import { DEFAULT_PRICES, priceFor, usdFor, type TokenUsage } from '@context-tree/core';
import { CONTEXT_FETCH, CONTEXT_PEEK } from '@context-tree/mcp';
import { ARM_NAMES, type ArmId } from './arms.js';
import type { LoopStop, ToolCallRecord } from './loop.js';
import type { JudgeVerdict } from './judge.js';
import type { TaskKind, TrapKind } from './task-spec.js';

export type MeasurementSource = 'measured' | 'simulated';

/** A number that always travels with the thing that produced it. */
export interface Sourced {
  value: number;
  source: MeasurementSource;
}

export interface SimulatedCache {
  cacheRead: number;
  cacheWrite: number;
  fresh: number;
  total: number;
  tokenizerId: string;
  profileId: string;
}

export type RunStatus = 'ok' | 'skipped' | 'error';

/** One arm × one task × one seed. The unit every metric aggregates. */
export interface ArmRunResult {
  taskId: string;
  taskKind: TaskKind;
  trap?: TrapKind;
  arm: ArmId;
  seed: number;
  status: RunStatus;
  /** Why it was skipped, or what threw. Never empty when status is not `ok`. */
  reason?: string;
  model?: string;
  /** The script checker's verdict — §15's success rate. */
  success?: boolean;
  checkerDetail?: string;
  /** Undefined when no checker judged staleness; that is "not reported", not `false`. */
  staleSummaryIncident?: boolean;
  judge?: JudgeVerdict;
  steps?: number;
  stoppedBy?: LoopStop;
  toolCalls: ToolCallRecord[];
  latencyMs?: number;
  /** Initial prompt size under the shared tokenizer — comparable across arms. */
  promptTokens?: number;
  /** MEASURED: what the provider reported. */
  usage?: TokenUsage;
  /** SIMULATED: core's cache simulator over arm D's assembled prompt. */
  simulatedCache?: SimulatedCache;
  conditions: string[];
}

export interface TokenSplit {
  /** Uncached input tokens. */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  /** `input + cacheRead + cacheWrite` — every token the model read as input. */
  total: number;
  source: MeasurementSource;
}

export interface ArmMetrics {
  arm: ArmId;
  name: string;
  runs: number;
  skipped: number;
  errors: number;
  /** Distinct tasks with at least one completed run. */
  tasks: number;
  successes: number;
  successRate: number | null;
  toolCalls: number;
  toolCallsPerTask: number | null;
  latencyP50: number | null;
  latencyP95: number | null;
  usdTotal: number | null;
  usdPerTask: number | null;
  /** MEASURED input tokens per completed run. */
  inputTokensPerRun: Sourced | null;
  /** SIMULATED equivalent, reported beside it and never merged with it. */
  simulatedInputTokensPerRun: Sourced | null;
  cacheSplit: TokenSplit | null;
  simulatedCacheSplit: TokenSplit | null;
  peeks: number;
  peeksConverted: number;
  /** Peeks followed by a fetch of the same node / total peeks. Null when no peeks. */
  peekPrecision: number | null;
  staleSummaryIncidents: number;
  /** Runs whose checker actually judged staleness. 0 means "not reported". */
  staleSummaryReports: number;
  stepCapHits: number;
  /** `context_search` mechanism counts, from the tool results (§9: vector vs beam). */
  searchPaths: Record<string, number>;
  searchFallbacks: Record<string, number>;
  judgeOverall: number | null;
}

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

/**
 * Nearest-rank percentile: the smallest value at or above the p-th position of
 * the sorted sample. No interpolation — with n>=5 seeds per task (§15) the
 * sample is small enough that an interpolated p95 would invent a latency no
 * request ever had.
 */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] ?? null;
}

/**
 * §15's `context_peek` precision: a peek is converted when a LATER call in the
 * same run fetches the node that was peeked. That is the behaviour the §9
 * contract asks for — peek to test a suspicion, fetch when it is confirmed — so
 * a peek that led nowhere is the model paying for a look it did not use.
 */
export function peekPrecision(runs: readonly ArmRunResult[]): { peeks: number; converted: number; precision: number | null } {
  let peeks = 0;
  let converted = 0;
  for (const run of runs) {
    run.toolCalls.forEach((call, index) => {
      if (call.name !== CONTEXT_PEEK) return;
      peeks += 1;
      const nodeId = call.args.node_id;
      if (typeof nodeId !== 'string') return;
      const followed = run.toolCalls
        .slice(index + 1)
        .some((later) => later.name === CONTEXT_FETCH && later.args.branch_id === nodeId);
      if (followed) converted += 1;
    });
  }
  return { peeks, converted, precision: peeks === 0 ? null : converted / peeks };
}

function tokenSplit(usages: readonly TokenUsage[], source: MeasurementSource): TokenSplit | null {
  if (usages.length === 0) return null;
  const split: TokenSplit = { input: 0, cacheRead: 0, cacheWrite: 0, total: 0, source };
  for (const usage of usages) {
    split.input += usage.input;
    split.cacheRead += usage.cacheRead;
    split.cacheWrite += usage.cacheWrite;
  }
  split.total = split.input + split.cacheRead + split.cacheWrite;
  return split;
}

function bump(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1;
}

/** Cost of one run from its MEASURED usage, priced with core's published table. */
export function runUsd(result: ArmRunResult): number | null {
  if (result.usage === undefined || result.model === undefined) return null;
  return usdFor(result.usage, priceFor(result.model, DEFAULT_PRICES).price);
}

export function aggregateArm(results: readonly ArmRunResult[], arm: ArmId): ArmMetrics {
  const mine = results.filter((result) => result.arm === arm);
  const ok = mine.filter((result) => result.status === 'ok');

  const metrics: ArmMetrics = {
    arm,
    name: ARM_NAMES[arm],
    runs: ok.length,
    skipped: mine.filter((result) => result.status === 'skipped').length,
    errors: mine.filter((result) => result.status === 'error').length,
    tasks: new Set(ok.map((result) => result.taskId)).size,
    successes: 0,
    successRate: null,
    toolCalls: 0,
    toolCallsPerTask: null,
    latencyP50: null,
    latencyP95: null,
    usdTotal: null,
    usdPerTask: null,
    inputTokensPerRun: null,
    simulatedInputTokensPerRun: null,
    cacheSplit: null,
    simulatedCacheSplit: null,
    peeks: 0,
    peeksConverted: 0,
    peekPrecision: null,
    staleSummaryIncidents: 0,
    staleSummaryReports: 0,
    stepCapHits: 0,
    searchPaths: {},
    searchFallbacks: {},
    judgeOverall: null,
  };

  if (ok.length === 0) return metrics;

  // Success rate counts only runs whose checker actually ran: a run that threw
  // is an error, and folding it in as a failure would blame the arm for the
  // harness's fault.
  const graded = ok.filter((result) => result.success !== undefined);
  metrics.successes = graded.filter((result) => result.success === true).length;
  metrics.successRate = graded.length === 0 ? null : metrics.successes / graded.length;

  metrics.toolCalls = ok.reduce((sum, result) => sum + result.toolCalls.length, 0);
  metrics.toolCallsPerTask = metrics.toolCalls / ok.length;

  const latencies = ok.map((result) => result.latencyMs).filter((value): value is number => value !== undefined);
  metrics.latencyP50 = percentile(latencies, 50);
  metrics.latencyP95 = percentile(latencies, 95);

  const usds = ok.map(runUsd).filter((value): value is number => value !== null);
  if (usds.length > 0) {
    const total = usds.reduce((sum, value) => sum + value, 0);
    metrics.usdTotal = total;
    metrics.usdPerTask = total / usds.length;
  }

  const usages = ok.map((result) => result.usage).filter((value): value is TokenUsage => value !== undefined);
  metrics.cacheSplit = tokenSplit(usages, 'measured');
  if (metrics.cacheSplit !== null) {
    metrics.inputTokensPerRun = { value: metrics.cacheSplit.total / usages.length, source: 'measured' };
  }

  const simulated = ok
    .map((result) => result.simulatedCache)
    .filter((value): value is SimulatedCache => value !== undefined);
  if (simulated.length > 0) {
    metrics.simulatedCacheSplit = tokenSplit(
      simulated.map((entry) => ({
        input: entry.fresh,
        output: 0,
        cacheRead: entry.cacheRead,
        cacheWrite: entry.cacheWrite,
      })),
      'simulated',
    );
    if (metrics.simulatedCacheSplit !== null) {
      metrics.simulatedInputTokensPerRun = {
        value: metrics.simulatedCacheSplit.total / simulated.length,
        source: 'simulated',
      };
    }
  }

  const peeked = peekPrecision(ok);
  metrics.peeks = peeked.peeks;
  metrics.peeksConverted = peeked.converted;
  metrics.peekPrecision = peeked.precision;

  for (const result of ok) {
    if (result.staleSummaryIncident !== undefined) {
      metrics.staleSummaryReports += 1;
      if (result.staleSummaryIncident) metrics.staleSummaryIncidents += 1;
    }
    if (result.stoppedBy === 'step-cap') metrics.stepCapHits += 1;
    for (const call of result.toolCalls) {
      const path = call.digest.path;
      if (typeof path === 'string') bump(metrics.searchPaths, path);
      const fallback = call.digest.fallback;
      if (typeof fallback === 'string') bump(metrics.searchFallbacks, fallback);
    }
  }

  const judged = ok.map((result) => result.judge?.overall).filter((value): value is number => value !== undefined);
  metrics.judgeOverall = mean(judged);

  return metrics;
}

/** Every arm present in the result set, in §15's table order. */
export function aggregate(results: readonly ArmRunResult[], arms: readonly ArmId[]): ArmMetrics[] {
  return arms.map((arm) => aggregateArm(results, arm));
}
