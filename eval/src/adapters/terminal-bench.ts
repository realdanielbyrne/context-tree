/**
 * terminal-bench adapter: a directory of task directories, each with a
 * `task.yaml` declaring the instruction (the terminal-bench task schema), any
 * environment files the task needs, and a `run-tests.sh` that grades the final
 * filesystem state.
 *
 * The test script is NOT materialized for the agent (terminal-bench keeps
 * tests hidden); it is attached to the judge and written into the sandbox only
 * at scoring time. `solution.sh` / `solution/` are excluded everywhere.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { Adapter, Scenario, ScenarioJudge } from '../types.js';
import { AdapterLoadError, assertScenarioShape, judgeFromRow } from './util.js';

export const TERMINAL_BENCH_ID = 'terminal-bench';

const EXCLUDED_FILES = new Set(['task.yaml', 'task.yml', 'solution.sh', 'run-tests.sh', 'tests.sh']);
const EXCLUDED_DIRS = new Set(['solution', 'tests']);
const MAX_FILE_BYTES = 256 * 1024;

function instructionOf(parsed: Record<string, unknown>): string | undefined {
  for (const key of ['instruction', 'description', 'prompt', 'task']) {
    const value = parsed[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}

function readTaskFiles(taskDir: string, prefix: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(taskDir).sort()) {
    const full = join(taskDir, entry);
    const rel = prefix === '' ? entry : `${prefix}/${entry}`;
    const stats = statSync(full);
    if (stats.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry)) Object.assign(files, readTaskFiles(full, rel));
      continue;
    }
    if (EXCLUDED_FILES.has(entry) || stats.size > MAX_FILE_BYTES) continue;
    files[rel] = readFileSync(full, 'utf8');
  }
  return files;
}

export const terminalBenchAdapter: Adapter = {
  id: TERMINAL_BENCH_ID,
  load(dir: string): Scenario[] {
    if (!existsSync(dir)) {
      throw new AdapterLoadError(
        TERMINAL_BENCH_ID,
        `scenarios directory not found: ${dir} — point --scenarios-dir at your terminal-bench tasks checkout`,
      );
    }
    const scenarios: Scenario[] = [];
    for (const entry of readdirSync(dir).sort()) {
      const taskDir = join(dir, entry);
      if (!statSync(taskDir).isDirectory()) continue;
      const yamlPath = ['task.yaml', 'task.yml'].map((name) => join(taskDir, name)).find(existsSync);
      if (yamlPath === undefined) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = (parse(readFileSync(yamlPath, 'utf8')) ?? {}) as Record<string, unknown>;
      } catch (error) {
        throw new AdapterLoadError(TERMINAL_BENCH_ID, `${yamlPath}: invalid YAML — ${(error as Error).message}`);
      }
      const task = instructionOf(parsed);
      if (task === undefined) {
        throw new AdapterLoadError(TERMINAL_BENCH_ID, `${yamlPath}: no instruction/description field`);
      }
      const testScript = ['run-tests.sh', 'tests.sh'].map((name) => join(taskDir, name)).find(existsSync);
      const judge: ScenarioJudge = testScript
        ? { kind: 'command', command: 'bash run-tests.sh', files: { 'run-tests.sh': readFileSync(testScript, 'utf8') } }
        : judgeFromRow({});
      const scenario: Scenario = {
        id: entry,
        benchmark: TERMINAL_BENCH_ID,
        task,
        files: readTaskFiles(taskDir, ''),
        judge,
        meta: { difficulty: typeof parsed['difficulty'] === 'string' ? parsed['difficulty'] : undefined },
      };
      assertScenarioShape(TERMINAL_BENCH_ID, scenario, yamlPath);
      scenarios.push(scenario);
    }
    if (scenarios.length === 0) {
      throw new AdapterLoadError(TERMINAL_BENCH_ID, `no task directories with task.yaml found in ${dir}`);
    }
    return scenarios;
  },
};
