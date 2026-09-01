/**
 * §15 metrics: token totals with the cache split the §11 providers already
 * report honestly, turn counts, latency percentiles and USD cost. Aggregation
 * turns per-run results into per-arm tables; `deltasFor` turns two arms into
 * the A/B comparison the report prints.
 */
import type { TokenUsage } from '@context-tree/core';
import type { Arm, RunMetrics, RunResult, TokenTotals, TurnRecord } from './types.js';

export const ZERO_TOTALS: TokenTotals = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
});

export function totalOf(usage: TokenUsage): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

export function addTotals(a: TokenTotals, b: TokenUsage): TokenTotals {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    total: a.total + totalOf(b),
  };
}

/** Nearest-rank percentile of a sample; an empty sample is an honest 0. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] as number;
}

export function avgOf(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function summarizeMetrics(args: {
  turns: readonly TurnRecord[];
  wallMs: number;
  usage: TokenTotals;
  costUsd: number;
}): RunMetrics {
  const latencies = args.turns.map((turn) => turn.latencyMs);
  const toolCalls = args.turns.reduce((sum, turn) => sum + turn.toolCalls.length, 0);
  const wallSec = args.wallMs / 1000;
  return {
    tokens: args.usage,
    turns: { modelTurns: args.turns.length, toolCalls },
    speed: {
      wallMs: args.wallMs,
      p50TurnMs: percentile(latencies, 50),
      p95TurnMs: percentile(latencies, 95),
      outputTokensPerSec: wallSec > 0 ? args.usage.output / wallSec : 0,
    },
    costUsd: args.costUsd,
  };
}

export interface ArmAggregate {
  arm: Arm;
  runs: number;
  completed: number;
  /** successes / judged runs — null when nothing was judged. */
  successRate: number | null;
  avgInputTokens: number;
  avgOutputTokens: number;
  avgCacheReadTokens: number;
  avgCacheWriteTokens: number;
  avgTotalTokens: number;
  avgModelTurns: number;
  avgToolCalls: number;
  p50WallMs: number;
  p95WallMs: number;
  avgWallMs: number;
  totalCostUsd: number;
  avgCostUsd: number;
}

export function aggregateArm(arm: Arm, results: readonly RunResult[]): ArmAggregate {
  const judged = results.filter((result) => result.success !== null);
  const wallTimes = results.map((result) => result.metrics.speed.wallMs);
  return {
    arm,
    runs: results.length,
    completed: results.filter((result) => result.status === 'completed').length,
    successRate:
      judged.length > 0
        ? results.filter((result) => result.success === true).length / judged.length
        : null,
    avgInputTokens: avgOf(results.map((result) => result.metrics.tokens.input)),
    avgOutputTokens: avgOf(results.map((result) => result.metrics.tokens.output)),
    avgCacheReadTokens: avgOf(results.map((result) => result.metrics.tokens.cacheRead)),
    avgCacheWriteTokens: avgOf(results.map((result) => result.metrics.tokens.cacheWrite)),
    avgTotalTokens: avgOf(results.map((result) => result.metrics.tokens.total)),
    avgModelTurns: avgOf(results.map((result) => result.metrics.turns.modelTurns)),
    avgToolCalls: avgOf(results.map((result) => result.metrics.turns.toolCalls)),
    p50WallMs: percentile(wallTimes, 50),
    p95WallMs: percentile(wallTimes, 95),
    avgWallMs: avgOf(wallTimes),
    totalCostUsd: results.reduce((sum, result) => sum + result.metrics.costUsd, 0),
    avgCostUsd: avgOf(results.map((result) => result.metrics.costUsd)),
  };
}

export interface ArmDelta {
  metric: string;
  native: number;
  contextTree: number;
  /** Relative change of context-tree vs native, in percent. */
  deltaPct: number | null;
  /** How to read the delta: lower is better, higher is better, or pp (percentage points). */
  reads: 'lower-is-better' | 'higher-is-better' | 'pp';
}

function relPct(native: number, tree: number): number | null {
  if (native === 0) return null;
  return ((tree - native) / native) * 100;
}

export function deltasFor(native: ArmAggregate, tree: ArmAggregate): ArmDelta[] {
  return [
    {
      metric: 'success rate',
      native: native.successRate ?? 0,
      contextTree: tree.successRate ?? 0,
      // Fractions differ by at most 1.0 — report the gap in percentage points.
      deltaPct: ((tree.successRate ?? 0) - (native.successRate ?? 0)) * 100,
      reads: 'pp',
    },
    { metric: 'avg total tokens', native: native.avgTotalTokens, contextTree: tree.avgTotalTokens, deltaPct: relPct(native.avgTotalTokens, tree.avgTotalTokens), reads: 'lower-is-better' },
    { metric: 'avg output tokens', native: native.avgOutputTokens, contextTree: tree.avgOutputTokens, deltaPct: relPct(native.avgOutputTokens, tree.avgOutputTokens), reads: 'lower-is-better' },
    { metric: 'avg cache-read tokens', native: native.avgCacheReadTokens, contextTree: tree.avgCacheReadTokens, deltaPct: relPct(native.avgCacheReadTokens, tree.avgCacheReadTokens), reads: 'lower-is-better' },
    { metric: 'avg tool calls', native: native.avgToolCalls, contextTree: tree.avgToolCalls, deltaPct: relPct(native.avgToolCalls, tree.avgToolCalls), reads: 'lower-is-better' },
    { metric: 'avg model turns', native: native.avgModelTurns, contextTree: tree.avgModelTurns, deltaPct: relPct(native.avgModelTurns, tree.avgModelTurns), reads: 'lower-is-better' },
    { metric: 'p50 wall ms', native: native.p50WallMs, contextTree: tree.p50WallMs, deltaPct: relPct(native.p50WallMs, tree.p50WallMs), reads: 'lower-is-better' },
    { metric: 'p95 wall ms', native: native.p95WallMs, contextTree: tree.p95WallMs, deltaPct: relPct(native.p95WallMs, tree.p95WallMs), reads: 'lower-is-better' },
    { metric: 'avg cost usd', native: native.avgCostUsd, contextTree: tree.avgCostUsd, deltaPct: relPct(native.avgCostUsd, tree.avgCostUsd), reads: 'lower-is-better' },
  ];
}

