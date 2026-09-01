/**
 * §15's second grader: "script checkers + LLM-as-judge (strong model, rubric at
 * `eval/rubric.md`)".
 *
 * The judge never replaces the checker. A checker is a deterministic assertion
 * about a run; the judge scores the things an assertion cannot see (did the
 * answer actually reconstruct the task's state, or did it bluff?). Both are
 * reported, and §15's success rate is the CHECKER's — a model grading a model
 * is evidence, not arithmetic.
 *
 * The rubric is a file, not a constant, for the same reason §11 makes prompts
 * versioned artifacts: editing the grading standard must show up as a diff.
 */
import { readFileSync } from 'node:fs';
import type { ModelProvider } from '@context-tree/core';
import type { EvalTask } from './task-spec.js';

export class JudgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JudgeError';
  }
}

export interface RubricCriterion {
  id: string;
  description: string;
  weight: number;
}

export interface Rubric {
  path: string;
  criteria: RubricCriterion[];
  /** Highest score a criterion can take. Fixed at 5; scores are normalized by it. */
  maxScore: number;
  text: string;
}

export const RUBRIC_MAX_SCORE = 5;

const HEADING = /^###\s+([A-Za-z0-9_-]+)\s*(?:\(weight:\s*([0-9]*\.?[0-9]+)\s*\))?\s*$/;

/**
 * Rubric format: one `### <criterion-id>` heading per criterion, an optional
 * `(weight: N)`, and prose beneath it. Deliberately minimal — the file is read
 * by a model, and a schema the author has to escape is a file that stops
 * getting edited.
 */
export function parseRubric(text: string, path = '<inline>'): Rubric {
  const criteria: RubricCriterion[] = [];
  let current: RubricCriterion | null = null;
  const body: string[] = [];

  const flush = (): void => {
    if (current === null) return;
    current.description = body.join('\n').trim();
    criteria.push(current);
    body.length = 0;
  };

  for (const line of text.split(/\r?\n/)) {
    const match = HEADING.exec(line);
    if (match === null) {
      if (current !== null) body.push(line);
      continue;
    }
    flush();
    const id = match[1] ?? '';
    const weight = match[2] === undefined ? 1 : Number(match[2]);
    if (criteria.some((criterion) => criterion.id === id)) {
      throw new JudgeError(`${path}: duplicate criterion id ${JSON.stringify(id)}`);
    }
    current = { id, description: '', weight };
  }
  flush();

  if (criteria.length === 0) {
    throw new JudgeError(`${path}: no criteria found — expected at least one "### <criterion-id>" heading`);
  }
  return { path, criteria, maxScore: RUBRIC_MAX_SCORE, text };
}

export function loadRubric(path: string): Rubric {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new JudgeError(`rubric ${path}: cannot read — ${(error as Error).message}`);
  }
  return parseRubric(text, path);
}

export interface JudgeVerdict {
  model: string;
  /** One entry per rubric criterion, 0..`Rubric.maxScore`. */
  scores: Record<string, number>;
  /** Weighted mean of `scores`, normalized to 0..1. */
  overall: number;
  passed: boolean;
  rationale: string;
}

const JSON_FENCE = /```(?:json)?[ \t]*\r?\n([\s\S]*?)```/;

/** Models wrap JSON in fences and prose; tolerate that and nothing else (as §8 does). */
function extractJson(raw: string): unknown {
  const candidates = [raw.trim()];
  const fenced = JSON_FENCE.exec(raw);
  if (fenced?.[1] !== undefined) candidates.push(fenced[1]);
  const open = raw.indexOf('{');
  const close = raw.lastIndexOf('}');
  if (open >= 0 && close > open) candidates.push(raw.slice(open, close + 1));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // next shape
    }
  }
  throw new JudgeError('verdict: no JSON object found in the judge reply');
}

export interface ParseVerdictOptions {
  model?: string;
  /** Normalized 0..1 overall at or above which the judge counts the run a pass. */
  passThreshold?: number;
}

export const DEFAULT_PASS_THRESHOLD = 0.6;

/**
 * Nothing is defaulted or coerced. A missing criterion is a judge that did not
 * grade it, and averaging over the ones it happened to return would silently
 * change the denominator of every §15 quality number.
 */
export function parseJudgeVerdict(raw: string, rubric: Rubric, options: ParseVerdictOptions = {}): JudgeVerdict {
  const root = extractJson(raw);
  if (typeof root !== 'object' || root === null || Array.isArray(root)) {
    throw new JudgeError('verdict: expected a JSON object');
  }
  const record = root as Record<string, unknown>;

  const rawScores = record.scores;
  if (typeof rawScores !== 'object' || rawScores === null || Array.isArray(rawScores)) {
    throw new JudgeError('verdict.scores: expected an object of criterion id -> number');
  }
  const scoreRecord = rawScores as Record<string, unknown>;

  const scores: Record<string, number> = {};
  let weighted = 0;
  let weight = 0;
  for (const criterion of rubric.criteria) {
    const value = scoreRecord[criterion.id];
    if (value === undefined) throw new JudgeError(`verdict.scores.${criterion.id}: missing required criterion`);
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new JudgeError(`verdict.scores.${criterion.id}: expected a number, got ${JSON.stringify(value)}`);
    }
    if (value < 0 || value > rubric.maxScore) {
      throw new JudgeError(
        `verdict.scores.${criterion.id}: expected 0..${String(rubric.maxScore)}, got ${String(value)}`,
      );
    }
    scores[criterion.id] = value;
    weighted += value * criterion.weight;
    weight += criterion.weight;
  }
  for (const key of Object.keys(scoreRecord)) {
    if (!rubric.criteria.some((criterion) => criterion.id === key)) {
      throw new JudgeError(`verdict.scores.${key}: not a criterion in ${rubric.path}`);
    }
  }

  const rationale = record.rationale;
  if (typeof rationale !== 'string' || rationale.trim().length === 0) {
    throw new JudgeError('verdict.rationale: expected a non-empty string');
  }

  const overall = weight === 0 ? 0 : weighted / (weight * rubric.maxScore);
  return {
    model: options.model ?? 'unknown',
    scores,
    overall,
    passed: overall >= (options.passThreshold ?? DEFAULT_PASS_THRESHOLD),
    rationale: rationale.trim(),
  };
}

export interface JudgeOptions {
  provider: ModelProvider;
  /** §11: the strong model. Same one for every arm, or the grade is not comparable. */
  model: string;
  rubric: Rubric;
  task: EvalTask;
  /** The resuming agent's final answer. */
  answer: string;
  passThreshold?: number;
  maxTokens?: number;
}

function goldenBlock(task: EvalTask): string {
  if (task.golden.length === 0) return '(no golden file states declared)';
  return task.golden.map((file) => `--- ${file.path}\n${file.content}`).join('\n\n');
}

export function judgePrompt(options: JudgeOptions): string {
  const { rubric, task } = options;
  const criteria = rubric.criteria
    .map((criterion) => `- ${criterion.id} (weight ${String(criterion.weight)}): ${criterion.description}`)
    .join('\n');
  return [
    `# Task: ${task.title}`,
    `## Request given to the resuming agent\n${task.prompt}`,
    `## Golden end state (ground truth)\n${goldenBlock(task)}`,
    `## The agent's answer\n${options.answer}`,
    `## Rubric\n${rubric.text.trim()}`,
    `## Criteria to score, 0..${String(rubric.maxScore)}\n${criteria}`,
    'Reply with ONLY a JSON object: {"scores": {<criterion id>: <number>, ...}, "rationale": "<one paragraph>"}.',
    'Score every criterion listed and no others.',
  ].join('\n\n');
}

/** Runs the judge. Works against `MockProvider` unchanged, which is how it is tested. */
export async function judgeRun(options: JudgeOptions): Promise<JudgeVerdict> {
  const result = await options.provider.complete({
    model: options.model,
    messages: [{ role: 'user', content: judgePrompt(options) }],
    json: true,
    maxTokens: options.maxTokens ?? 1_024,
  });
  const parseOptions: ParseVerdictOptions = { model: result.model };
  if (options.passThreshold !== undefined) parseOptions.passThreshold = options.passThreshold;
  return parseJudgeVerdict(result.text, options.rubric, parseOptions);
}
