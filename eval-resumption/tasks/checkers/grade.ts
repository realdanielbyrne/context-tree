/**
 * The grading kernel every task checker is built from (§15: "a checker script"
 * per task).
 *
 * Two rules the design is built around:
 *
 *  1. **Grade the outcome, not the prose.** A checker that greps the model's
 *     explanation for a stylistic keyword grades style. So the required facts
 *     are DERIVED FROM `task.golden` — the file the task had to end at and a
 *     symbol that actually exists in it — plus the task's own `expect` block.
 *     Nothing here rewards phrasing, ordering or length.
 *  2. **A checker that cannot fail is the worst defect in a benchmark.** Every
 *     rule below names the thing it rejected in `detail`, and `tasks.test.ts`
 *     runs each of the 30 checkers against a deliberately wrong answer and
 *     requires it to fail.
 *
 * What is deliberately NOT graded here is judgement: whether an answer says
 * *which* version of a contradiction it is acting on and why is a rubric
 * criterion, and `rules.judged` records that delegation in the result detail so
 * the results file states it rather than implying a script covered it.
 */
import { basename } from 'node:path';
import {
  goldenTextChecker,
  type CheckerFn,
  type CheckerInput,
  type CheckerResult,
  type GoldenFile,
} from '../../harness/task-spec.js';

/**
 * Top-level exported names of a golden file. A fresh regex per call: a `/g`
 * regex carries `lastIndex` between calls, and a checker whose result depended
 * on how many times it had run before would be worse than no checker.
 */
export function exportedSymbols(content: string): string[] {
  const pattern = /^export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
  const names: string[] = [];
  for (const match of content.matchAll(pattern)) {
    const name = match[1];
    if (name !== undefined && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * The golden-state assertion: the answer names the file it had to end at, and
 * at least one symbol that really exists in that file's end state.
 *
 * "At least one" rather than "all": a golden file with a constant and a
 * function does not make naming both a condition of having resumed correctly,
 * and a checker calibrated so tightly that a right answer fails is a benchmark
 * that measures its author's phrasing. A file with no exported symbols (a TOML
 * config) is graded on its path alone.
 */
function goldenFailures(golden: readonly GoldenFile[], text: string): string[] {
  const failures: string[] = [];
  for (const file of golden) {
    const name = basename(file.path);
    if (!text.includes(name)) {
      failures.push(`answer never names the file it had to end at (${file.path})`);
      continue;
    }
    const symbols = exportedSymbols(file.content);
    if (symbols.length > 0 && !symbols.some((symbol) => text.includes(symbol))) {
      failures.push(`answer names ${name} but none of its symbols (${symbols.join(', ')})`);
    }
  }
  return failures;
}

export interface CheckerRules {
  /** What a pass means for this one task. Printed verbatim in `detail`. */
  what: string;
  /**
   * Facts the answer must state that `golden` cannot express — a value in a
   * test output, a queue name, an HTTP status. Empty on most tasks, because
   * `expect.answerContains` is the declared home for them.
   */
  mustName?: readonly string[];
  /**
   * §15's stale-summary trap. `expect.staleMarkers` are strings true only of
   * the SUPERSEDED state, and their presence is always reported as the
   * organization-quality incident.
   *
   * They are fatal only when the answer also fails to name the current state.
   * Mentioning that `retry.ts` was replaced is not following a stale summary;
   * naming it as the thing to work on now, while never naming what replaced it,
   * is — and that is the difference this rule keeps.
   */
  staleIsFatal?: boolean;
  /** Criteria this task hands to the LLM judge instead of faking a script check. */
  judged?: readonly string[];
}

export function grade(input: CheckerInput, rules: CheckerRules): CheckerResult {
  const text = input.finalText;
  const failures: string[] = [];

  // The `expect` block first: it is the task's own declared contract, and
  // reusing the harness's checker keeps this from drifting away from it.
  const base = goldenTextChecker(input) as CheckerResult;
  if (!base.passed) failures.push(base.detail);

  failures.push(...goldenFailures(input.task.golden, text));
  for (const fact of rules.mustName ?? []) {
    if (!text.includes(fact)) failures.push(`answer never states ${JSON.stringify(fact)}`);
  }

  const markers = input.task.expect.staleMarkers ?? [];
  const hit = markers.filter((marker) => text.includes(marker));
  const namedCurrent = failures.length === 0;
  if (rules.staleIsFatal === true && hit.length > 0 && !namedCurrent) {
    failures.push(`answer acted on the superseded state (${hit.join(', ')}) and never reached the current one`);
  }

  const detail =
    failures.length === 0
      ? [`${rules.what} — met`, ...(rules.judged ?? []).map((c) => `judged by rubric: ${c}`)].join('; ')
      : `${rules.what} — ${failures.join('; ')}`;

  const result: CheckerResult = { passed: failures.length === 0, detail };
  // Reported only where the trap exists, so the metric says "not reported"
  // elsewhere instead of a false zero (§15).
  if (input.task.trap === 'stale-summary') result.staleSummaryIncident = hit.length > 0;
  return result;
}

/** One task's checker. Every export in this directory is one of these. */
export function checkerFor(rules: CheckerRules): CheckerFn {
  return (input) => grade(input, rules);
}

/**
 * `fresh-01-invoice-rounding` -> `fresh01InvoiceRounding`. The task JSON names
 * its checker export, and deriving the name from the id in one place is what
 * keeps 30 task files and 30 exports from drifting apart silently.
 */
export function checkerExportName(taskId: string): string {
  const [head, ...rest] = taskId.split('-');
  return [head ?? '', ...rest.map((part) => `${(part[0] ?? '').toUpperCase()}${part.slice(1)}`)].join('');
}
