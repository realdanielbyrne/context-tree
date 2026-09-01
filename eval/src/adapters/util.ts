/**
 * Shared adapter machinery. Every adapter fails loud: a missing directory, a
 * missing scenario file, or a malformed row is an error naming the file and
 * line — never a silently skipped benchmark, because a benchmark that loaded
 * zero scenarios silently would report an A/B on nothing.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Scenario, ScenarioJudge } from '../types.js';

export class AdapterLoadError extends Error {
  constructor(benchmark: string, message: string) {
    super(`[${benchmark}] ${message}`);
    this.name = 'AdapterLoadError';
  }
}

export function readJsonlRows(benchmark: string, path: string): Record<string, unknown>[] {
  const text = readFileSync(path, 'utf8');
  const rows: Record<string, unknown>[] = [];
  for (const [index, line] of text.split('\n').entries()) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new AdapterLoadError(benchmark, `${path} line ${index + 1}: invalid JSON — ${(error as Error).message}`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new AdapterLoadError(benchmark, `${path} line ${index + 1}: expected a JSON object`);
    }
    rows.push(parsed as Record<string, unknown>);
  }
  return rows;
}

/** First present, non-empty string among `keys`. */
export function fieldOf(row: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}

/**
 * Judge inference from row shape: an explicit command wins, then an expected
 * answer (exact match), then a rubric — and plain tasks get a generic rubric
 * judged by the judge model rather than being silently ungraded.
 */
export function judgeFromRow(row: Record<string, unknown>): ScenarioJudge {
  const command = fieldOf(row, ['judge_command', 'test_command']);
  if (command !== undefined) return { kind: 'command', command };
  const answer = fieldOf(row, ['answer', 'expected', 'reference_answer']);
  if (answer !== undefined) return { kind: 'exact_match', answer };
  const rubric = fieldOf(row, ['rubric', 'grading_rubric']);
  return {
    kind: 'llm_rubric',
    rubric:
      rubric ??
      'Did the agent complete the task correctly and completely? Grade the final answer against the task requirements.',
  };
}

/** Optional per-scenario input files under a `files` object of path -> content. */
export function filesFromRow(
  benchmark: string,
  row: Record<string, unknown>,
  where: string,
): Record<string, string> | undefined {
  const files = row['files'];
  if (files === undefined) return undefined;
  if (typeof files !== 'object' || files === null || Array.isArray(files)) {
    throw new AdapterLoadError(benchmark, `${where}: "files" must be an object of path -> content`);
  }
  const out: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) {
    if (typeof content !== 'string') {
      throw new AdapterLoadError(benchmark, `${where}: file "${path}" content must be a string`);
    }
    out[path] = content;
  }
  return out;
}

export function assertScenarioShape(benchmark: string, scenario: Scenario, where: string): void {
  if (scenario.id.trim() === '') throw new AdapterLoadError(benchmark, `${where}: empty scenario id`);
  if (scenario.task.trim() === '') throw new AdapterLoadError(benchmark, `${where}: empty task text`);
}

/**
 * Loads every recognized JSONL file in `dir` (each benchmark's native filename
 * first, then a normalized `scenarios.jsonl`), maps rows through `mapRow`, and
 * validates each result. This is the contract every JSONL adapter shares.
 */
export function loadJsonlScenarios(
  benchmark: string,
  dir: string,
  nativeFilenames: readonly string[],
  mapRow: (row: Record<string, unknown>, index: number, where: string) => Scenario,
): Scenario[] {
  if (!existsSync(dir)) {
    throw new AdapterLoadError(
      benchmark,
      `scenarios directory not found: ${dir} — place the dataset there or point --scenarios-dir at it`,
    );
  }
  const filenames = [...nativeFilenames, 'scenarios.jsonl'];
  const found = filenames.map((name) => join(dir, name)).filter((path) => existsSync(path));
  if (found.length === 0) {
    throw new AdapterLoadError(benchmark, `no scenario files in ${dir} — expected one of ${filenames.join(', ')}`);
  }
  const scenarios: Scenario[] = [];
  for (const path of found) {
    const rows = readJsonlRows(benchmark, path);
    if (rows.length === 0) {
      throw new AdapterLoadError(benchmark, `${path}: no rows`);
    }
    for (const [index, row] of rows.entries()) {
      const where = `${path} line ${index + 1}`;
      const scenario = mapRow(row, index, where);
      assertScenarioShape(benchmark, scenario, where);
      scenarios.push(scenario);
    }
  }
  return scenarios;
}
