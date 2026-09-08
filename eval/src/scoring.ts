/**
 * The three §15 judges. `exact_match` grades short-answer benchmarks (HLE);
 * `command` runs a hidden test script against the sandbox (terminal-bench);
 * `llm_rubric` asks the judge model to grade open-ended deliverables against a
 * rubric (GDPval-AA, Automation Bench). The judge's provider arrives pre-wired
 * through a MeteredProvider, so its tokens are accounted like any other call.
 */
import type { CompletionRequest, ModelProvider } from '@context-tree/core';
import { renderOutcome, type Sandbox } from './sandbox.js';
import type { JudgeResult, Scenario } from './types.js';

const JUDGE_MAX_CHARS = 16_000;
const JUDGE_MAX_TOKENS = 512;
const COMMAND_TIMEOUT_MS = 120_000;

/** Lowercase, whitespace-collapsed — the honest minimum before calling a match. */
export function normalizeAnswer(text: string): string {
  return text.trim().toLowerCase().replaceAll(/\s+/g, ' ');
}

export function exactMatchJudge(finalText: string, answer: string): JudgeResult {
  const produced = normalizeAnswer(finalText);
  const expected = normalizeAnswer(answer);
  if (expected === '') return { success: null, score: null, detail: 'exact_match judge has an empty answer' };
  const matched = produced === expected || produced.includes(expected);
  return {
    success: matched,
    // Exact match is binary by nature — the score just mirrors it.
    score: matched ? 1 : 0,
    detail: matched
      ? `final answer matched "${expected}"`
      : `final answer did not match "${expected}" — agent said: "${produced.slice(0, 400)}"`,
  };
}

/**
 * Graded score from a hidden runner's stdout: the canonical `SCORE: <p>/<t>`
 * line wins (partial credit even on a failing exit); without one, exit status
 * degrades to binary 1/0 — the per-task convention benchmark tables use.
 */
export function parseCommandScore(stdout: string, passed: boolean): number | null {
  const match = /^\s*SCORE:\s*(\d+)\s*\/\s*(\d+)\s*$/m.exec(stdout);
  if (match !== null) {
    const p = Number.parseInt(match[1] ?? '0', 10);
    const t = Number.parseInt(match[2] ?? '0', 10);
    if (t > 0 && p >= 0 && p <= t) return p / t;
  }
  return passed ? 1 : 0;
}

export async function commandJudge(sandbox: Sandbox, command: string): Promise<JudgeResult> {
  const outcome = await sandbox.run(command, COMMAND_TIMEOUT_MS);
  const passed = outcome.exitCode === 0 && !outcome.timedOut;
  return { success: passed, score: parseCommandScore(outcome.stdout, passed), detail: renderOutcome(outcome, 4000) };
}

function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export interface RubricJudgeArgs {
  task: string;
  rubric: string;
  finalText: string;
  provider: ModelProvider;
  model: string;
}

export async function rubricJudge(args: RubricJudgeArgs): Promise<JudgeResult> {
  const prompt = [
    'You are grading an AI agent on one task. Reply with ONLY a JSON object of the shape',
    '{"success": <true|false>, "score": <0.0-1.0 fraction of the rubric satisfied>, "reason": "<one short paragraph>"}',
    '',
    '# Rubric',
    args.rubric,
    '',
    '# Task given to the agent',
    args.task.slice(0, JUDGE_MAX_CHARS),
    '',
    '# Agent final answer',
    args.finalText.slice(0, JUDGE_MAX_CHARS) || '(the agent produced no final text)',
  ].join('\n');
  // No temperature pin: the Claude 5 API rejects the param outright
  // ("`temperature` is deprecated for this model"), so judge variance is
  // controlled statistically (replicates + medians), not by sampling args.
  const request: CompletionRequest = {
    model: args.model,
    messages: [{ role: 'user', content: prompt }],
    maxTokens: JUDGE_MAX_TOKENS,
    json: true,
  };
  const result = await args.provider.complete(request);
  const parsed = extractJson(result.text);
  if (parsed === null || typeof parsed['success'] !== 'boolean') {
    return { success: null, score: null, detail: `judge reply was not the expected JSON: ${result.text.slice(0, 200)}` };
  }
  const reason = typeof parsed['reason'] === 'string' ? parsed['reason'] : '(judge returned no reason)';
  const rawScore = parsed['score'];
  const score =
    typeof rawScore === 'number' && rawScore >= 0 && rawScore <= 1 ? rawScore : parsed['success'] ? 1 : 0;
  return { success: parsed['success'], score, detail: reason };
}

export interface JudgeArgs {
  artifactDirectory?: string;
  scenario: Scenario;
  sandbox: Sandbox;
  finalText: string;
  provider: ModelProvider;
  judgeModel: string;
}

export async function judgeScenario(args: JudgeArgs): Promise<JudgeResult> {
  const { judge } = args.scenario;
  switch (judge.kind) {
    case 'deepswe': {
      if (args.sandbox.verify === undefined) throw new Error('DeepSWE requires its independent container verifier');
      const verified = await args.sandbox.verify(args.artifactDirectory ?? `${args.sandbox.path}-verifier`);
      return { success: verified.reward === 1, score: verified.reward, detail: JSON.stringify(verified) };
    }
    case 'exact_match':
      return exactMatchJudge(args.finalText, judge.answer ?? '');
    case 'command':
      if (judge.command === undefined) {
        throw new Error(`scenario ${args.scenario.id}: judge kind "command" requires judge.command`);
      }
      for (const [relPath, content] of Object.entries(judge.files ?? {})) {
        args.sandbox.writeFile(relPath, content);
      }
      return commandJudge(args.sandbox, judge.command);
    case 'llm_rubric': {
      const rubric =
        judge.rubric ??
        `Did the agent complete the task correctly and completely? Task: ${args.scenario.task.slice(0, 2000)}`;
      return rubricJudge({
        task: args.scenario.task,
        rubric,
        finalText: args.finalText,
        provider: args.provider,
        model: args.judgeModel,
      });
    }
  }
}
