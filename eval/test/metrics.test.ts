/**
 * Offline tests for the §15 metric math — the numbers the A/B verdict rests on,
 * so the arithmetic here is table-driven and exhaustive on the edges.
 */
import { describe, expect, it } from 'vitest';
import {
  addTotals,
  aggregateArm,
  avgOf,
  deltasFor,
  deriveBatchingMetrics,
  percentile,
  summarizeMetrics,
  totalOf,
  ZERO_TOTALS,
} from '../src/metrics.js';
import type { RunResult, TurnRecord } from '../src/types.js';

const usageOf = (input: number, output: number): TurnRecord['usage'] => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
});

function turn(index: number, latencyMs: number, input = 100, output = 10): TurnRecord {
  return { index, latencyMs, usage: usageOf(input, output), toolCalls: [], stopReason: 'end_turn' };
}

describe('percentile (nearest-rank)', () => {
  it('returns 0 for an empty sample, because an honest aggregate never invents a number', () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([], 95)).toBe(0);
  });

  it('picks the ceil(p/100 * n)-th sorted value', () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 95)).toBe(5);
    expect(percentile([10], 95)).toBe(10);
    expect(percentile([4, 2], 50)).toBe(2);
  });
});

describe('token totals', () => {
  it('sums all four counters, with total = input + output + cacheRead + cacheWrite', () => {
    const totals = addTotals({ ...ZERO_TOTALS }, { input: 10, output: 5, cacheRead: 100, cacheWrite: 20 });
    expect(totals).toEqual({ input: 10, output: 5, cacheRead: 100, cacheWrite: 20, total: 135 });
    expect(totalOf({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 })).toBe(10);
  });
});

describe('summarizeMetrics', () => {
  it('counts model turns and tool calls, and reports turn-latency percentiles', () => {
    const turns = [
      { ...turn(0, 100), toolCalls: ['write_file'] },
      { ...turn(1, 200), toolCalls: ['run_command', 'read_file'] },
      turn(2, 600),
    ];
    const usage = addTotals(addTotals({ ...ZERO_TOTALS }, turns[0]!.usage), turns[1]!.usage);
    const metrics = summarizeMetrics({ turns, wallMs: 1000, usage, costUsd: 0.5 });
    expect(metrics.turns).toEqual({ modelTurns: 3, toolCalls: 3 });
    expect(metrics.speed.p50TurnMs).toBe(200);
    expect(metrics.speed.p95TurnMs).toBe(600);
    expect(metrics.speed.wallMs).toBe(1000);
    expect(metrics.tokens.total).toBe(usage.total);
    expect(metrics.costUsd).toBe(0.5);
  });
});

function makeResult(overrides: Partial<RunResult> & { arm: RunResult['arm'] } & Pick<RunResult, 'scenarioId'>): RunResult {
  return {
    runId: 'r',
    benchmark: 'b',
    model: 'm',
    status: 'completed',
    success: true,
    judge: { success: true, detail: '' },
    metrics: summarizeMetrics({ turns: [turn(0, 10, 500, 50)], wallMs: 100, usage: { ...ZERO_TOTALS, input: 500, output: 50, total: 550 }, costUsd: 0.01 }),
    turns: [],
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:00.100Z',
    ...overrides,
  };
}

describe('deriveBatchingMetrics (loop9b-item3 §3, pure over turns[].toolCalls)', () => {
  // [1 read, 5 writes, 0, 0]: one tool-using turn, one 5-fan-out write turn,
  // then two trailing bare turns — the gate fires on the first bare turn and
  // is NOT rescued (the run just ends on the second).
  const turnWith = (toolCalls: string[]): TurnRecord => ({
    index: 0,
    latencyMs: 1,
    usage: usageOf(0, 0),
    toolCalls,
    stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
  });
  const fixture: TurnRecord[] = [
    turnWith(['read_file']),
    turnWith(Array(5).fill('write_file')),
    turnWith([]),
    turnWith([]),
  ];

  it('derives every field from a synthetic fixture with a known shape', () => {
    const batching = deriveBatchingMetrics(fixture);
    expect(batching).toEqual({
      trailingBareTurns: 2,
      gateFired: true,
      gateRescued: false,
      callsPerToolUsingTurn: 3,
      callsPerTurn: 1.5,
      writesPerWriteBearingTurn: 5,
      maxReadBatch: 1,
      maxWriteBatch: 5,
      runCommandOnlyTurns: 0,
    });
  });

  it('marks a run rescued when tool work resumes right after the first bare-after-work turn', () => {
    const rescued: TurnRecord[] = [
      turnWith(['write_file']),
      turnWith([]), // gate fires here
      turnWith(['run_command']), // rescued
      turnWith([]), // run ends here — not a second nudge (the latch already tripped)
    ];
    const batching = deriveBatchingMetrics(rescued);
    expect(batching.gateFired).toBe(true);
    expect(batching.gateRescued).toBe(true);
    expect(batching.trailingBareTurns).toBe(1);
    expect(batching.runCommandOnlyTurns).toBe(1);
  });

  it('never fires on a bare-only run with no prior tool work', () => {
    const batching = deriveBatchingMetrics([turnWith([])]);
    expect(batching.gateFired).toBe(false);
    expect(batching.gateRescued).toBe(false);
    expect(batching.trailingBareTurns).toBe(1);
  });

  it('composes into summarizeMetrics as metrics.batching, alongside lazyCrossed and finalTextChars', () => {
    const metrics = summarizeMetrics({
      turns: fixture,
      wallMs: 100,
      usage: { ...ZERO_TOTALS },
      costUsd: 0,
      lazyCrossed: true,
      finalTextChars: 42,
    });
    expect(metrics.batching).toEqual(deriveBatchingMetrics(fixture));
    expect(metrics.lazyCrossed).toBe(true);
    expect(metrics.finalTextChars).toBe(42);
  });

  it('defaults lazyCrossed to false and finalTextChars to 0 when omitted (native/dsa arms)', () => {
    const metrics = summarizeMetrics({ turns: fixture, wallMs: 100, usage: { ...ZERO_TOTALS }, costUsd: 0 });
    expect(metrics.lazyCrossed).toBe(false);
    expect(metrics.finalTextChars).toBe(0);
  });
});

describe('aggregateArm', () => {
  it('averages across runs and computes success rate over judged runs only', () => {
    const results = [
      makeResult({ arm: 'native', scenarioId: 's1' }),
      makeResult({ arm: 'native', scenarioId: 's2', success: false }),
      makeResult({ arm: 'native', scenarioId: 's3', success: null }),
    ];
    const aggregate = aggregateArm('native', results);
    expect(aggregate.runs).toBe(3);
    expect(aggregate.successRate).toBeCloseTo(1 / 2);
    expect(aggregate.avgInputTokens).toBe(500);
    expect(aggregate.avgTotalTokens).toBe(550);
    expect(aggregate.totalCostUsd).toBeCloseTo(0.03);
  });

  it('reports successRate null when nothing was judged, never a fake 0%', () => {
    const aggregate = aggregateArm('native', [makeResult({ arm: 'native', scenarioId: 's1', success: null })]);
    expect(aggregate.successRate).toBeNull();
  });
});

describe('deltasFor (the A/B verdict)', () => {
  it('expresses context-tree vs native as relative percent, and success rate in pp', () => {
    const native = aggregateArm('native', [makeResult({ arm: 'native', scenarioId: 's1' })]);
    const tree = aggregateArm('context-tree', [
      makeResult({ arm: 'context-tree', scenarioId: 's1', success: true }),
    ]);
    const deltas = deltasFor(native, tree);
    const success = deltas.find((delta) => delta.metric === 'success rate');
    expect(success?.deltaPct).toBeCloseTo(0);
    const tokens = deltas.find((delta) => delta.metric === 'avg total tokens');
    expect(tokens?.deltaPct).not.toBeNull();
    expect(avgOf([1, 2, 3])).toBe(2);
  });

  it('returns a null delta when the native baseline is zero', () => {
    const native = aggregateArm('native', [makeResult({ arm: 'native', scenarioId: 's1' })]);
    const tree = aggregateArm('context-tree', [makeResult({ arm: 'context-tree', scenarioId: 's1' })]);
    const deltas = deltasFor({ ...native, avgTotalTokens: 0 }, tree);
    expect(deltas.find((delta) => delta.metric === 'avg total tokens')?.deltaPct).toBeNull();
  });
});
