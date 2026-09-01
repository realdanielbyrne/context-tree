/**
 * The report: per-benchmark per-arm tables, delta rows, and the on-disk
 * artifacts. Runs against synthetic RunResults only.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { aggregateByBenchmark, renderMarkdownReport, writeReportFiles } from '../src/report.js';
import { summarizeMetrics, ZERO_TOTALS } from '../src/metrics.js';
import type { Arm, RunResult } from '../src/types.js';

let counter = 0;
function makeResult(arm: Arm, benchmark: string, overrides: Partial<RunResult> = {}): RunResult {
  counter += 1;
  return {
    runId: 'r1',
    benchmark,
    scenarioId: `s${counter}`,
    arm,
    model: 'test-model',
    status: 'completed',
    success: true,
    judge: { success: true, detail: '' },
    metrics: summarizeMetrics({
      turns: [],
      wallMs: 500,
      usage: { ...ZERO_TOTALS, input: 1000, output: 100, cacheRead: 2000, cacheWrite: 100, total: 3200 },
      costUsd: 0.02,
    }),
    turns: [],
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:00.500Z',
    ...overrides,
  };
}

describe('aggregateByBenchmark', () => {
  it('groups runs per benchmark and only emits arms that actually ran', () => {
    const aggregates = aggregateByBenchmark([
      makeResult('native', 'hle-tools'),
      makeResult('context-tree', 'hle-tools'),
      makeResult('native', 'gdpval-aa-v2'),
    ]);
    expect(aggregates.map((aggregate) => aggregate.benchmark)).toEqual(['gdpval-aa-v2', 'hle-tools']);
    const hle = aggregates.find((aggregate) => aggregate.benchmark === 'hle-tools')!;
    expect(hle.arms['native']).toBeDefined();
    expect(hle.arms['context-tree']).toBeDefined();
    const gdp = aggregates.find((aggregate) => aggregate.benchmark === 'gdpval-aa-v2')!;
    expect(gdp.arms['context-tree']).toBeUndefined();
  });
});

describe('renderMarkdownReport', () => {
  it('renders an arm table and an A/B delta table for paired benchmarks', () => {
    const markdown = renderMarkdownReport({
      runId: 'r1',
      results: [makeResult('native', 'hle-tools'), makeResult('context-tree', 'hle-tools')],
      model: 'test-model',
      provider: 'anthropic',
    });
    expect(markdown).toContain('# context-tree eval — r1');
    expect(markdown).toContain('### hle-tools');
    expect(markdown).toContain('| native |');
    expect(markdown).toContain('| context-tree |');
    expect(markdown).toContain('context-tree vs native (deltas)');
    expect(markdown).toContain('avg total tokens');
  });

  it('lists error runs in their own section', () => {
    const markdown = renderMarkdownReport({
      runId: 'r1',
      results: [makeResult('native', 'hle-tools', { error: 'boom' })],
      model: 'test-model',
      provider: 'anthropic',
    });
    expect(markdown).toContain('## Errors');
    expect(markdown).toContain('boom');
  });
});

describe('writeReportFiles', () => {
  it('writes results.json and report.md under <out>/<runId>', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'ct-eval-report-'));
    try {
      const results = [makeResult('native', 'hle-tools'), makeResult('context-tree', 'hle-tools')];
      const markdown = renderMarkdownReport({ runId: 'r1', results, model: 'm', provider: 'anthropic' });
      const paths = writeReportFiles(outDir, 'r1', results, markdown);
      expect(existsSync(paths.resultsPath)).toBe(true);
      expect(existsSync(paths.reportPath)).toBe(true);
      expect(JSON.parse(readFileSync(paths.resultsPath, 'utf8'))).toHaveLength(2);
      expect(readFileSync(paths.reportPath, 'utf8')).toContain('# context-tree eval');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
