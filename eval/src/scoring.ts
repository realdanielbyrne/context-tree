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
  if (expected === '') return { success: null, detail: 'exact_match judge has an empty answer' };
  const matched = produced === expected || produced.includes(expected);
  return {
    success: matched,
    detail: matched
      ? `final answer matched "${expected}"`
      : `final answer did not match "${expected}" — agent said: "${produced.slice(0, 400)}"`,
  };
}

export async function commandJudge(sandbox: Sandbox, command: string): Promise<JudgeResult> {
  const outcome = await sandbox.run(command, COMMAND_TIMEOUT_MS);
  return { success: outcome.exitCode === 0 && !outcome.timedOut, detail: renderOutcome(outcome, 4000) };
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
    '{"success": <true|false>, "reason": "<one short paragraph>"}',
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
  const request: CompletionRequest = {
    model: args.model,
    messages: [{ role: 'user', content: prompt }],
    maxTokens: JUDGE_MAX_TOKENS,
    json: true,
  };
  const result = await args.provider.complete(request);
  const parsed = extractJson(result.text);
  if (parsed === null || typeof parsed['success'] !== 'boolean') {
    return { success: null, detail: `judge reply was not the expected JSON: ${result.text.slice(0, 200)}` };
  }
  const reason = typeof parsed['reason'] === 'string' ? parsed['reason'] : '(judge returned no reason)';
  return { success: parsed['success'], detail: reason };
}

export interface JudgeArgs {
  scenario: Scenario;
  sandbox: Sandbox;
  finalText: string;
  provider: ModelProvider;
  judgeModel: string;
}

export async function judgeScenario(args: JudgeArgs): Promise<JudgeResult> {
  const { judge } = args.scenario;
  switch (judge.kind) {
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
