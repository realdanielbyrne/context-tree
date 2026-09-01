/**
 * The §15 report: `results.json` (every RunResult, machine-readable) and
 * `report.md` (the human A/B table — per-benchmark per-arm aggregates plus the
 * context-tree vs native delta rows).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { aggregateArm, deltasFor, type ArmAggregate } from './metrics.js';
import { ARMS, type Arm, type RunResult } from './types.js';

export interface BenchmarkAggregate {
  benchmark: string;
  arms: Partial<Record<Arm, ArmAggregate>>;
}

export function aggregateByBenchmark(results: readonly RunResult[]): BenchmarkAggregate[] {
  const byBenchmark = new Map<string, RunResult[]>();
  for (const result of results) {
    const bucket = byBenchmark.get(result.benchmark) ?? [];
    bucket.push(result);
    byBenchmark.set(result.benchmark, bucket);
  }
  return [...byBenchmark.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([benchmark, runs]) => {
    const arms: Partial<Record<Arm, ArmAggregate>> = {};
    for (const arm of ARMS) {
      const armRuns = runs.filter((run) => run.arm === arm);
      if (armRuns.length > 0) arms[arm] = aggregateArm(arm, armRuns);
    }
    return { benchmark, arms };
  });
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function usd(value: number): string {
  return `$${value.toFixed(4)}`;
}

function num(value: number): string {
  return value.toFixed(0);
}

function armRow(aggregate: ArmAggregate): string {
  return [
    aggregate.arm,
    num(aggregate.runs),
    num(aggregate.completed),
    aggregate.successRate === null ? 'n/a' : pct(aggregate.successRate),
    num(aggregate.avgInputTokens),
    num(aggregate.avgOutputTokens),
    num(aggregate.avgCacheReadTokens),
    num(aggregate.avgCacheWriteTokens),
    num(aggregate.avgTotalTokens),
    num(aggregate.avgToolCalls),
    num(aggregate.avgModelTurns),
    num(aggregate.p50WallMs),
    num(aggregate.p95WallMs),
    usd(aggregate.avgCostUsd),
  ].join(' | ');
}

const ARM_COLUMNS = [
  'arm',
  'runs',
  'ok',
  'success',
  'in tok',
  'out tok',
  'cache r',
  'cache w',
  'total tok',
  'tool calls',
  'turns',
  'p50 ms',
  'p95 ms',
  'avg cost',
];

function armTable(aggregate: BenchmarkAggregate): string {
  const lines = [`### ${aggregate.benchmark}`, '', `| ${ARM_COLUMNS.join(' | ')} |`];
  lines.push(`| ${ARM_COLUMNS.map(() => '---').join(' | ')} |`);
  for (const arm of ARMS) {
    const armAggregate = aggregate.arms[arm];
    if (armAggregate !== undefined) lines.push(`| ${armRow(armAggregate)} |`);
  }
  return lines.join('\n');
}

function deltaTable(aggregate: BenchmarkAggregate): string | null {
  const native = aggregate.arms['native'];
  const tree = aggregate.arms['context-tree'];
  if (native === undefined || tree === undefined) return null;
  const lines = ['', `**context-tree vs native (deltas):**`, '', '| metric | native | context-tree | delta | reads |',
    '| --- | --- | --- | --- | --- |'];
  for (const delta of deltasFor(native, tree)) {
    const fmt = delta.metric.includes('cost') ? usd : delta.reads === 'pp' ? pct : num;
    const nativeCell = fmt(delta.native);
    const treeCell = fmt(delta.contextTree);
    const deltaCell =
      delta.deltaPct === null
        ? 'n/a'
        : `${delta.deltaPct >= 0 ? '+' : ''}${delta.deltaPct.toFixed(1)}${delta.reads === 'pp' ? ' pp' : '%'}`;
    lines.push(`| ${delta.metric} | ${nativeCell} | ${treeCell} | ${deltaCell} | ${delta.reads} |`);
  }
  return lines.join('\n');
}

export function renderMarkdownReport(args: {
  runId: string;
  results: readonly RunResult[];
  model: string;
  provider: string;
}): string {
  const aggregates = aggregateByBenchmark(args.results);
  const errors = args.results.filter((result) => result.error !== undefined);
  const lines: string[] = [
    `# context-tree eval — ${args.runId}`,
    '',
    `- model: \`${args.model}\` (provider \`${args.provider}\`)`,
    `- runs: ${args.results.length} across ${aggregates.length} benchmark(s)`,
    `- errors: ${errors.length}`,
    '',
  ];
  if (errors.length > 0) {
    lines.push('## Errors', '');
    for (const result of errors) {
      lines.push(`- \`${result.benchmark}/${result.scenarioId}\` arm=${result.arm}: ${result.error}`);
    }
    lines.push('');
  }
  lines.push('## Results', '');
  for (const aggregate of aggregates) {
    lines.push(armTable(aggregate), '');
    const delta = deltaTable(aggregate);
    if (delta !== null) lines.push(delta, '');
  }
  return lines.join('\n');
}

export function writeReportFiles(
  outDir: string,
  runId: string,
  results: readonly RunResult[],
  markdown: string,
): { resultsPath: string; reportPath: string } {
  const dir = join(outDir, runId);
  mkdirSync(dir, { recursive: true });
  const resultsPath = join(dir, 'results.json');
  const reportPath = join(dir, 'report.md');
  writeFileSync(resultsPath, JSON.stringify(results, null, 2));
  writeFileSync(reportPath, markdown);
  return { resultsPath, reportPath };
}

