/**
 * §15 metrics: token totals with the cache split the §11 providers already
 * report honestly, turn counts, latency percentiles and USD cost. Aggregation
 * turns per-run results into per-arm tables; `deltasFor` turns two arms into
 * the A/B comparison the report prints.
 */
import type { TokenUsage } from '@context-tree/core';
import { READ_FILE, RUN_COMMAND, WRITE_FILE } from './tools.js';
import type { Arm, BatchingMetrics, RunMetrics, RunResult, TokenTotals, TurnRecord } from './types.js';

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

/**
 * loop9b-item3 §3: pure function of `turns[].toolCalls` (names only — no new
 * capture). The completion gate is a one-shot latch (`eval/src/loop.ts:1010`):
 * once tripped it never re-fires, so the FIRST zero-call turn that follows any
 * turn with a tool call is the only turn the nudge can ever have been emitted
 * on, regardless of where it falls in the run.
 */
export function deriveBatchingMetrics(turns: readonly TurnRecord[]): BatchingMetrics {
  const n = turns.length;

  let trailingBareTurns = 0;
  for (let i = n - 1; i >= 0; i -= 1) {
    if (turns[i]!.toolCalls.length !== 0) break;
    trailingBareTurns += 1;
  }

  let toolWorkSeen = false;
  let firstBareAfterWork = -1;
  for (let i = 0; i < n; i += 1) {
    if (turns[i]!.toolCalls.length === 0) {
      if (toolWorkSeen && firstBareAfterWork === -1) firstBareAfterWork = i;
    } else {
      toolWorkSeen = true;
    }
  }
  const gateFired = firstBareAfterWork !== -1;
  // Reachable only because every arm now nudges once on the first bare reply
  // after tool work (loop.ts COMPLETION_NUDGE). While the gate was tree-only
  // and the other arms returned on that first bare reply, there was never a
  // turn after `firstBareAfterWork` to inspect, so this was `false` in 0 of 48
  // recorded runs -- a metric measuring something the harness made impossible.
  const gateRescued = gateFired && firstBareAfterWork < n - 1 && turns[firstBareAfterWork + 1]!.toolCalls.length > 0;

  const toolUsingTurns = turns.filter((turn) => turn.toolCalls.length > 0);
  const totalCalls = turns.reduce((sum, turn) => sum + turn.toolCalls.length, 0);
  const countOf = (turn: TurnRecord, name: string) => turn.toolCalls.filter((call) => call === name).length;
  const writeBearingTurns = turns.filter((turn) => countOf(turn, WRITE_FILE) > 0);
  const totalWrites = turns.reduce((sum, turn) => sum + countOf(turn, WRITE_FILE), 0);

  return {
    trailingBareTurns,
    gateFired,
    gateRescued,
    callsPerToolUsingTurn: toolUsingTurns.length > 0 ? totalCalls / toolUsingTurns.length : 0,
    callsPerTurn: n > 0 ? totalCalls / n : 0,
    writesPerWriteBearingTurn: writeBearingTurns.length > 0 ? totalWrites / writeBearingTurns.length : 0,
    maxReadBatch: Math.max(0, ...turns.map((turn) => countOf(turn, READ_FILE))),
    maxWriteBatch: Math.max(0, ...turns.map((turn) => countOf(turn, WRITE_FILE))),
    runCommandOnlyTurns: turns.filter((turn) => turn.toolCalls.length > 0 && turn.toolCalls.every((call) => call === RUN_COMMAND))
      .length,
  };
}

export function summarizeMetrics(args: {
  turns: readonly TurnRecord[];
  wallMs: number;
  usage: TokenTotals;
  costUsd: number;
  /** item 1's one-way latch; omit (or false) for arms that have no lazy gate. */
  lazyCrossed?: boolean;
  finalTextChars?: number;
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
    batching: deriveBatchingMetrics(args.turns),
    lazyCrossed: args.lazyCrossed ?? false,
    finalTextChars: args.finalTextChars ?? 0,
  };
}

export interface ArmAggregate {
  arm: Arm;
  runs: number;
  completed: number;
  /** successes / judged runs — null when nothing was judged. */
  successRate: number | null;
  /** Mean graded score over judged runs (judge.score, 0-1); null when ungraded. */
  avgScore: number | null;
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
    avgScore: (() => {
      const scores = results
        .map((result) => result.judge?.score)
        .filter((score): score is number => typeof score === 'number');
      return scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
    })(),
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

