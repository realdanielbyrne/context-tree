/**
 * §15 evaluation harness — public surface.
 *
 * `runEval(args)` is the entry point `packages/cli/src/commands/eval.ts` calls
 * by path (`eval/harness/index.js` -> `runEval`). That convention was set by the
 * CLI; this file matches it so the shipped CLI can run the shipped harness. See
 * docs/EVAL.md for the one build caveat that comes with it.
 */
export {
  ARMS_NEEDING_SUMMARY,
  ARM_IDS,
  ARM_NAMES,
  ArmUnavailableError,
  FLATTEN_INSTRUCTION,
  RESUME_SYSTEM,
  TOOL_SCHEMAS,
  buildArm,
  buildFlatSummary,
  createArmRuntime,
  mcpToolBinding,
  parseArmId,
  renderTranscript,
  renderWindow,
  type ArmBuildInput,
  type ArmId,
  type ArmPrompt,
  type ArmRuntime,
} from './arms.js';
export {
  MAX_TOOL_CALLS_PER_TASK,
  SUCCESS_RATE_GAP_POINTS,
  TOKEN_REDUCTION_VS_A,
  TOKEN_REDUCTION_VS_C,
  evaluateCriteria,
  type CriteriaReport,
  type CriterionOutcome,
  type CriterionStatus,
} from './criteria.js';
export {
  DEFAULT_PASS_THRESHOLD,
  JudgeError,
  RUBRIC_MAX_SCORE,
  judgePrompt,
  judgeRun,
  loadRubric,
  parseJudgeVerdict,
  parseRubric,
  type JudgeOptions,
  type JudgeVerdict,
  type Rubric,
  type RubricCriterion,
} from './judge.js';
export { runToolLoop, type LoopStop, type ToolBinding, type ToolCallRecord, type ToolLoopOptions, type ToolLoopResult } from './loop.js';
export {
  aggregate,
  aggregateArm,
  mean,
  peekPrecision,
  percentile,
  runUsd,
  type ArmMetrics,
  type ArmRunResult,
  type MeasurementSource,
  type RunStatus,
  type SimulatedCache,
  type Sourced,
  type TokenSplit,
} from './metrics.js';
export {
  DEFAULT_RUN_ARGS,
  EvalBudgetError,
  EvalRunError,
  parseRunArgs,
  projectSpend,
  renderSummaryMarkdown,
  runEvaluation,
  type RunArgs,
  type RunDeps,
  type RunReport,
  type SkippedArm,
  type SpendProjection,
  type TaskSetupCost,
} from './run.js';
export {
  BUILTIN_CHECKERS,
  TASK_KINDS,
  TRAP_KINDS,
  TaskSpecError,
  goldenTextChecker,
  loadFixtureEvents,
  loadTaskFile,
  loadTasks,
  materializeTrace,
  parseTask,
  resolveChecker,
  taskEvents,
  validateTask,
  type CheckerFn,
  type CheckerInput,
  type CheckerResult,
  type EvalTask,
  type GoldenFile,
  type TaskEvent,
  type TaskExpectations,
  type TaskKind,
  type TaskValidation,
  type TrapKind,
} from './task-spec.js';

import { parseRunArgs, runEvaluation, type RunReport } from './run.js';

/**
 * CLI entry point. Exits non-zero when NOTHING was measured (no key, dry run,
 * every arm skipped): a run that measured nothing must not read as a pass. A
 * run that measured something and missed the §15 thresholds exits 0 with the
 * verdict in the report — that is a result, not a harness failure.
 */
export async function runEval(args: readonly string[]): Promise<RunReport> {
  const report = await runEvaluation(parseRunArgs(args));
  if (!report.results.some((result) => result.status === 'ok')) process.exitCode = 2;
  return report;
}
