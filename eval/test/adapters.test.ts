/**
 * Adapter tests against tiny local fixtures — format contract, judge inference,
 * and the fail-loud guarantees (missing dir, malformed row). No network, no
 * dataset downloads: the fixtures mirror each benchmark's on-disk layout.
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ADAPTERS, adapterFor, BENCHMARK_IDS } from '../src/adapters/index.js';

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

describe('the benchmark registry', () => {
  it('registers exactly the five benchmarks the harness runs', () => {
    expect(BENCHMARK_IDS).toEqual([
      'terminal-bench',
      'deepswe-agents-last-exam',
      'automation-bench',
      'hle-tools',
      'gdpval-aa-v2',
    ]);
  });

  it('fails loud on an unknown benchmark id', () => {
    expect(() => adapterFor('swe-bench')).toThrow(/unknown benchmark/);
  });

  it('every registered adapter is present', () => {
    expect(ADAPTERS).toHaveLength(5);
  });
});

describe('terminal-bench adapter', () => {
  it('parses task.yaml, hides tests and solutions from the agent, and grades via run-tests.sh', () => {
    const scenarios = adapterFor('terminal-bench').load(fixture('terminal-bench'));
    expect(scenarios).toHaveLength(1);
    const scenario = scenarios[0]!;
    expect(scenario.id).toBe('task-01');
    expect(scenario.task).toContain('hello.txt');
    expect(scenario.judge.kind).toBe('command');
    expect(scenario.judge.command).toBe('bash run-tests.sh');
    expect(scenario.judge.files?.['run-tests.sh']).toContain('hello.txt');
    expect(scenario.files?.['main.py']).toContain('fixture');
    expect(scenario.files?.['solution.sh']).toBeUndefined();
    expect(scenario.files?.['run-tests.sh']).toBeUndefined();
  });

  it('fails loud when the task directory is missing', () => {
    expect(() => adapterFor('terminal-bench').load(fixture('does-not-exist'))).toThrow(/not found/);
  });
});

describe('JSONL adapters', () => {
  it('deepswe-agents-last-exam maps rows with an answer to exact_match and rows with a rubric to llm_rubric', () => {
    const scenarios = adapterFor('deepswe-agents-last-exam').load(fixture('deepswe-agents-last-exam'));
    expect(scenarios.map((scenario) => scenario.id)).toEqual(['ale-1', 'ale-2']);
    expect(scenarios[0]!.judge.kind).toBe('llm_rubric');
    expect(scenarios[0]!.files?.['counter.py']).toContain('range(1, n)');
    expect(scenarios[1]!.judge.rubric).toContain('compiles');
  });

  it('automation-bench honours an explicit judge_command over everything else', () => {
    const scenarios = adapterFor('automation-bench').load(fixture('automation-bench'));
    expect(scenarios[0]!.judge.kind).toBe('llm_rubric');
    expect(scenarios[1]!.judge).toMatchObject({ kind: 'command', command: 'python check.py' });
  });

  it('hle-tools grades by exact match and rejects rows without an answer', () => {
    const scenarios = adapterFor('hle-tools').load(fixture('hle-tools'));
    expect(scenarios).toHaveLength(2);
    expect(scenarios[0]!.judge).toMatchObject({ kind: 'exact_match', answer: '2' });
    expect(scenarios[0]!.meta?.['category']).toBe('astronomy');
  });

  it('gdpval-aa-v2 carries occupation and rubric provenance', () => {
    const scenarios = adapterFor('gdpval-aa-v2').load(fixture('gdpval-aa-v2'));
    expect(scenarios[0]!.judge.kind).toBe('llm_rubric');
    expect(scenarios[0]!.meta?.['occupation']).toBe('project management');
    expect(scenarios[1]!.judge.kind).toBe('exact_match');
  });

  it('fails loud when pointed at a directory with no recognized scenario file', () => {
    expect(() => adapterFor('hle-tools').load(fixture('gdpval-aa-v2'))).toThrow(/expected one of/);
  });
});
