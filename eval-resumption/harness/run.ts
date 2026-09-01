/**
 * §15's runner: N seeds per task (n>=5), every arm, results to
 * `eval/results/<timestamp>/` as JSON plus a markdown table.
 *
 * Three properties matter more than the code that produces them:
 *
 *  1. It refuses to start when the PROJECTED spend exceeds the cap. Discovering
 *     the cap halfway through leaves a half-populated result set, and a
 *     half-populated result set is the exact shape §15's criteria are most
 *     likely to be read off by mistake.
 *  2. It never emits a number it did not measure. An arm that could not run is
 *     `skipped` with a reason, its metrics are null, and `criteria.ts` reports
 *     UNKNOWN — a run with no API key exits saying so rather than passing.
 *  3. Degradations are reported, not hidden. Neither Anthropic nor OpenRouter
 *     has an embedding endpoint, so L3 is unbuildable and `context_search` runs
 *     §9's lexical beam fallback. That is a line in the report.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  DEFAULT_PRICES,
  ProviderCacheSimulator,
  Summarizer,
  createProvider,
  ingest,
  loadApiKeys,
  loadDotEnv,
  openTaskStore,
  priceFor,
  resolveConfig,
  usdFor,
  type ContextTreeConfig,
  type CostSnapshot,
  type ModelProvider,
  type TaskStore,
} from '@context-tree/core';
import {
  ARM_IDS,
  ARM_NAMES,
  ArmUnavailableError,
  buildArm,
  buildFlatSummary,
  createArmRuntime,
  parseArmId,
  renderTranscript,
  type ArmId,
  type ArmPrompt,
  type ArmRuntime,
} from './arms.js';
import { evaluateCriteria, type CriteriaReport } from './criteria.js';
import { runToolLoop } from './loop.js';
import { aggregate, type ArmMetrics, type ArmRunResult } from './metrics.js';
import { judgeRun, loadRubric, type Rubric } from './judge.js';
import {
  loadTasks,
  materializeTrace,
  resolveChecker,
  taskEvents,
  type CheckerFn,
  type EvalTask,
} from './task-spec.js';

export class EvalRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvalRunError';
  }
}

/** Thrown before the first model call — see property 1 in the file header. */
export class EvalBudgetError extends Error {
  constructor(
    readonly projectedUsd: number,
    readonly capUsd: number,
    message: string,
  ) {
    super(message);
    this.name = 'EvalBudgetError';
  }
}

export interface RunArgs {
  /** Task file or directory of `.json` task files. */
  tasksPath: string;
  arms: ArmId[];
  /** §15: n>=5. */
  seeds: number;
  outRoot: string;
  maxSteps: number;
  /** Arm B's window, in tokens. */
  windowTokens: number;
  capUsd: number | null;
  rubricPath: string;
  /** The one model every arm answers with. Defaults to the config's root model. */
  model: string | null;
  provider: ContextTreeConfig['provider'] | null;
  /** Project the spend, print it, and stop. */
  dryRun: boolean;
  cwd: string;
}

export const DEFAULT_RUN_ARGS: Omit<RunArgs, 'cwd'> = {
  tasksPath: join('eval', 'tasks'),
  arms: [...ARM_IDS],
  seeds: 5,
  outRoot: join('eval', 'results'),
  maxSteps: 6,
  windowTokens: 8_000,
  capUsd: 5,
  rubricPath: join('eval', 'rubric.md'),
  model: null,
  provider: null,
  dryRun: false,
};

function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined) throw new EvalRunError(`${flag} needs a value`);
  return value;
}

function positiveInt(flag: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new EvalRunError(`${flag}: expected a positive integer, got ${raw}`);
  return value;
}

export function parseRunArgs(argv: readonly string[], cwd = process.cwd()): RunArgs {
  const args: RunArgs = { ...DEFAULT_RUN_ARGS, arms: [...DEFAULT_RUN_ARGS.arms], cwd };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] ?? '';
    const next = argv[i + 1];
    switch (flag) {
      case '--tasks':
        args.tasksPath = requireValue(flag, next);
        i += 1;
        break;
      case '--arms':
        args.arms = requireValue(flag, next)
          .split(',')
          .map((value) => parseArmId(value.trim()));
        i += 1;
        break;
      case '--seeds':
        args.seeds = positiveInt(flag, requireValue(flag, next));
        i += 1;
        break;
      case '--out':
        args.outRoot = requireValue(flag, next);
        i += 1;
        break;
      case '--max-steps':
        args.maxSteps = positiveInt(flag, requireValue(flag, next));
        i += 1;
        break;
      case '--window':
        args.windowTokens = positiveInt(flag, requireValue(flag, next));
        i += 1;
        break;
      case '--cap': {
        const raw = requireValue(flag, next);
        args.capUsd = raw === 'none' ? null : Number(raw);
        if (args.capUsd !== null && !Number.isFinite(args.capUsd)) {
          throw new EvalRunError(`--cap: expected a dollar amount or "none", got ${raw}`);
        }
        i += 1;
        break;
      }
      case '--rubric':
        args.rubricPath = requireValue(flag, next);
        i += 1;
        break;
      case '--model':
        args.model = requireValue(flag, next);
        i += 1;
        break;
      case '--provider': {
        const raw = requireValue(flag, next);
        if (!['anthropic', 'openrouter', 'mock', 'recorded'].includes(raw)) {
          throw new EvalRunError(`--provider: expected anthropic|openrouter|mock|recorded, got ${raw}`);
        }
        args.provider = raw as ContextTreeConfig['provider'];
        i += 1;
        break;
      }
      case '--dry-run':
        args.dryRun = true;
        break;
      default:
        throw new EvalRunError(`unknown flag ${JSON.stringify(flag)}`);
    }
  }
  if (args.arms.length === 0) throw new EvalRunError('--arms: at least one arm is required');
  return args;
}

export interface SpendProjection {
  tasks: number;
  /** arms x tasks x seeds. */
  runs: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedUsd: number;
  capUsd: number | null;
  model: string;
  /** Always true. Named so nothing downstream mistakes it for a measurement. */
  isEstimate: true;
}

export interface SkippedArm {
  arm: ArmId;
  reason: string;
}

/** Cost of building the context each arm reads — not part of a resumption's cost. */
export interface TaskSetupCost {
  taskId: string;
  /** §8 leaf + root summarization for arm D's tree. */
  treeBuildUsd: number | null;
  /** Arm C's one whole-transcript flatten. */
  flattenUsd: number | null;
  transcriptTokens: number;
}

export interface RunReport {
  startedAt: string;
  finishedAt: string;
  model: string;
  tokenizerId: string;
  arms: ArmId[];
  seeds: number;
  taskIds: string[];
  projection: SpendProjection;
  skippedArms: SkippedArm[];
  /** Degraded-but-running facts about this environment (§18). */
  conditions: string[];
  results: ArmRunResult[];
  metrics: ArmMetrics[];
  criteria: CriteriaReport;
  setupCosts: TaskSetupCost[];
  cost: CostSnapshot;
  outDir: string | null;
}

export interface RunDeps {
  /** Injected provider — the offline path. Skips key loading entirely. */
  provider?: ModelProvider;
  log?: (line: string) => void;
  /** Overrides the builtin checker registry. */
  checkers?: Readonly<Record<string, CheckerFn>>;
  /** Overrides the rubric file, so a test needs no disk. */
  rubric?: Rubric;
  now?: () => Date;
  /** Millisecond clock handed to the loop. */
  clock?: () => number;
  /** False keeps the run entirely in memory (tests). */
  write?: boolean;
}

interface ResolvedProvider {
  provider: ModelProvider | null;
  reason: string | null;
  conditions: string[];
}

function resolveProvider(config: ContextTreeConfig, args: RunArgs, deps: RunDeps): ResolvedProvider {
  if (deps.provider !== undefined) return { provider: deps.provider, reason: null, conditions: [] };
  const conditions: string[] = [];
  const dotenv = loadDotEnv(args.cwd);
  if (dotenv.loaded.length > 0) conditions.push(`loaded environment from ${dotenv.loaded.join(', ')}`);
  try {
    return { provider: createProvider(config, loadApiKeys()), reason: null, conditions };
  } catch (error) {
    return { provider: null, reason: (error as Error).message, conditions };
  }
}

/**
 * A deliberately coarse upper estimate, computed from token counts the harness
 * already measured (the transcripts) and the budgets it will spend against. It
 * is not a prediction of the bill; it is the number the cap is checked against
 * BEFORE any money is spent. The meter enforces the real cap during the run.
 */
export function projectSpend(
  transcripts: readonly { taskId: string; tokens: number }[],
  args: RunArgs,
  config: ContextTreeConfig,
  model: string,
): SpendProjection {
  const price = priceFor(model, DEFAULT_PRICES).price;
  const answerTokens = config.summarize.maxSummaryTokens;
  let input = 0;
  let output = 0;

  for (const transcript of transcripts) {
    // Per-task setup, paid once regardless of seeds.
    if (args.arms.includes('C')) {
      input += transcript.tokens;
      output += answerTokens;
    }
    if (args.arms.includes('D')) {
      // §8: leaves read the raw detail once, the root reads the leaf summaries.
      input += Math.round(transcript.tokens * 1.2);
      output += answerTokens * 2;
    }
    for (const arm of args.arms) {
      const perRun =
        arm === 'A'
          ? transcript.tokens
          : arm === 'B'
            ? Math.min(args.windowTokens, transcript.tokens)
            : arm === 'C'
              ? Math.min(answerTokens, transcript.tokens)
              : Math.min(config.budgets.zoneB + config.budgets.zoneC, transcript.tokens);
      input += perRun * args.seeds * args.maxSteps;
      output += answerTokens * args.seeds * args.maxSteps;
    }
  }

  return {
    tasks: transcripts.length,
    runs: transcripts.length * args.arms.length * args.seeds,
    estimatedInputTokens: input,
    estimatedOutputTokens: output,
    estimatedUsd: usdFor({ input, output, cacheRead: 0, cacheWrite: 0 }, price),
    capUsd: args.capUsd,
    model,
    isEstimate: true,
  };
}

interface PreparedTask {
  task: EvalTask;
  handle: TaskStore;
  root: string;
  transcript: string;
  transcriptTokens: number;
}

function prepareTask(task: EvalTask, args: RunArgs, runtimeTokens: (text: string) => number): PreparedTask {
  const root = mkdtempSync(join(tmpdir(), `ct-eval-${task.id}-`));
  const config = resolveConfig(
    args.provider === null ? { root, taskTitle: task.title } : { root, taskTitle: task.title, provider: args.provider },
  );
  const handle = openTaskStore(config);
  materializeTrace(taskEvents(task), handle);
  ingest({ handle });
  const transcript = renderTranscript(handle);
  return { task, handle, root, transcript, transcriptTokens: runtimeTokens(transcript) };
}

function fmt(value: number | null, digits = 2): string {
  return value === null ? 'not run' : value.toFixed(digits);
}

function pct(value: number | null): string {
  return value === null ? 'not run' : `${(value * 100).toFixed(1)}%`;
}

export function renderSummaryMarkdown(report: RunReport): string {
  const lines: string[] = [
    `# context-tree §15 evaluation — ${report.startedAt}`,
    '',
    `Model (all arms): \`${report.model}\` · tokenizer: \`${report.tokenizerId}\` · seeds/task: ${String(report.seeds)} · tasks: ${String(report.taskIds.length)}`,
    '',
    '## Arms',
    '',
    '| Arm | Runs | Success | Tool calls/run | Input tok/run (measured) | cache read/write | p50 ms | p95 ms | USD/run | Peek precision | Stale incidents |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const metrics of report.metrics) {
    const split = metrics.cacheSplit;
    lines.push(
      `| ${metrics.arm} ${ARM_NAMES[metrics.arm]} | ${String(metrics.runs)}${metrics.skipped > 0 ? ` (+${String(metrics.skipped)} skipped)` : ''} | ${pct(metrics.successRate)} | ${fmt(metrics.toolCallsPerTask)} | ${metrics.inputTokensPerRun === null ? 'not run' : metrics.inputTokensPerRun.value.toFixed(0)} | ${split === null ? 'not run' : `${String(split.cacheRead)} / ${String(split.cacheWrite)}`} | ${fmt(metrics.latencyP50, 0)} | ${fmt(metrics.latencyP95, 0)} | ${metrics.usdPerTask === null ? 'not run' : metrics.usdPerTask.toFixed(4)} | ${metrics.peeks === 0 ? 'no peeks' : pct(metrics.peekPrecision)} | ${metrics.staleSummaryReports === 0 ? 'not reported' : `${String(metrics.staleSummaryIncidents)}/${String(metrics.staleSummaryReports)}`} |`,
    );
  }

  lines.push('', '## §15 v1 success criteria', '', '| Criterion | Status | Actual | Threshold | Detail |', '|---|---|---|---|---|');
  for (const criterion of report.criteria.criteria) {
    lines.push(
      `| ${criterion.id} | ${criterion.status.toUpperCase()} | ${criterion.actual === null ? '—' : criterion.actual.toFixed(3)} | ${criterion.threshold.toFixed(3)} | ${criterion.detail} |`,
    );
  }
  lines.push('', `**Verdict: ${report.criteria.verdict}** (${String(report.criteria.passed)} pass, ${String(report.criteria.failed)} fail, ${String(report.criteria.unknown)} unknown)`);

  if (report.skippedArms.length > 0) {
    lines.push('', '## Arms that did not run', '');
    for (const skipped of report.skippedArms) {
      lines.push(`- **${skipped.arm} ${ARM_NAMES[skipped.arm]}**: ${skipped.reason}`);
    }
  }
  if (report.conditions.length > 0) {
    lines.push('', '## Conditions of this run', '');
    for (const condition of [...new Set(report.conditions)]) lines.push(`- ${condition}`);
  }

  lines.push(
    '',
    '## Spend',
    '',
    `Projected before the run (estimate): $${report.projection.estimatedUsd.toFixed(2)} against a cap of ${report.projection.capUsd === null ? 'none' : `$${report.projection.capUsd.toFixed(2)}`}.`,
    `Measured: $${report.cost.totalUsd.toFixed(4)} across ${String(report.cost.entries.length)} model(s).`,
    '',
    'Per-task setup (building the context each arm reads; not part of a resumption\'s cost):',
    '',
    '| Task | Transcript tokens | Tree build USD (arm D) | Flatten USD (arm C) |',
    '|---|---|---|---|',
  );
  for (const cost of report.setupCosts) {
    lines.push(
      `| ${cost.taskId} | ${String(cost.transcriptTokens)} | ${cost.treeBuildUsd === null ? 'not run' : cost.treeBuildUsd.toFixed(4)} | ${cost.flattenUsd === null ? 'not run' : cost.flattenUsd.toFixed(4)} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

export async function runEvaluation(args: RunArgs, deps: RunDeps = {}): Promise<RunReport> {
  const log = deps.log ?? ((line: string): void => {
    console.log(line);
  });
  const now = deps.now ?? ((): Date => new Date());
  const startedAt = now().toISOString();

  const tasks = loadTasks(resolve(args.cwd, args.tasksPath));
  if (tasks.length === 0) throw new EvalRunError(`no tasks found under ${args.tasksPath}`);

  // A throwaway config only for provider selection and the model defaults; each
  // task gets its own store config (§19 Q3: one DB per task).
  const baseConfig = resolveConfig(args.provider === null ? {} : { provider: args.provider });
  const model = args.model ?? baseConfig.rootModel;
  const resolved = resolveProvider(baseConfig, args, deps);
  const conditions: string[] = [...resolved.conditions];

  const runtime = createArmRuntime(
    resolved.provider ?? nullProvider(),
    model,
    args.capUsd,
  );

  // Ingestion is hermetic and free (§7.1), so every task is prepared before any
  // model call — which is what makes the projection a real number.
  const prepared: PreparedTask[] = [];
  const cleanup = (): void => {
    for (const entry of prepared) {
      entry.handle.close();
      rmSync(entry.root, { recursive: true, force: true });
    }
  };

  try {
    for (const task of tasks) {
      prepared.push(prepareTask(task, args, (text) => runtime.tokenizer.count(text)));
    }
    const projection = projectSpend(
      prepared.map((entry) => ({ taskId: entry.task.id, tokens: entry.transcriptTokens })),
      args,
      baseConfig,
      model,
    );

    if (args.capUsd !== null && projection.estimatedUsd > args.capUsd) {
      throw new EvalBudgetError(
        projection.estimatedUsd,
        args.capUsd,
        `projected spend $${projection.estimatedUsd.toFixed(2)} exceeds the cap of $${args.capUsd.toFixed(2)} — raise --cap, cut --seeds (${String(args.seeds)}), or run fewer tasks. Nothing was sent.`,
      );
    }

    const skippedArms: SkippedArm[] = [];
    const results: ArmRunResult[] = [];
    const setupCosts: TaskSetupCost[] = [];

    if (resolved.provider === null || args.dryRun) {
      const reason =
        resolved.provider === null
          ? `no model provider: ${resolved.reason ?? 'unavailable'}`
          : 'dry run: --dry-run projects the spend and stops';
      for (const arm of args.arms) skippedArms.push({ arm, reason });
      for (const entry of prepared) {
        setupCosts.push({
          taskId: entry.task.id,
          treeBuildUsd: null,
          flattenUsd: null,
          transcriptTokens: entry.transcriptTokens,
        });
      }
      const report = finish({
        args,
        startedAt,
        finishedAt: now().toISOString(),
        model,
        runtime,
        taskIds: tasks.map((task) => task.id),
        projection,
        skippedArms,
        conditions,
        results,
        setupCosts,
        outDir: null,
      });
      log(
        `no results: ${reason}. Arms skipped: ${args.arms.join(', ')}. ` +
          `§15 criteria are UNKNOWN, not met — nothing was measured.`,
      );
      return report;
    }

    const rubric = deps.rubric ?? loadRubricOrNull(args.rubricPath, args.cwd, conditions);
    let capReached: string | null = null;

    for (const entry of prepared) {
      const { task, handle } = entry;
      const beforeTree = runtime.meter.totalUsd();
      let treeBuildUsd: number | null = null;
      let flattenUsd: number | null = null;
      let flatSummary: string | undefined;

      if (capReached === null && args.arms.includes('D')) {
        try {
          const built = await summarizeTree(handle, runtime, baseConfig);
          treeBuildUsd = runtime.meter.totalUsd() - beforeTree;
          if (built.failures.length > 0) {
            conditions.push(
              `task ${task.id}: ${String(built.failures.length)} summar(ies) failed the §8 contract, so arm D's Zone B is incomplete — ${built.failures[0] ?? ''}`,
            );
          }
        } catch (error) {
          capReached = capReached ?? capReasonOf(error);
          conditions.push(`task ${task.id}: tree build failed — ${(error as Error).message}`);
        }
      }
      if (capReached === null && args.arms.includes('C')) {
        const beforeFlatten = runtime.meter.totalUsd();
        try {
          flatSummary = await buildFlatSummary(runtime, entry.transcript, task.title);
          flattenUsd = runtime.meter.totalUsd() - beforeFlatten;
        } catch (error) {
          capReached = capReached ?? capReasonOf(error);
          conditions.push(`task ${task.id}: arm C flatten failed — ${(error as Error).message}`);
        }
      }
      setupCosts.push({
        taskId: task.id,
        treeBuildUsd,
        flattenUsd,
        transcriptTokens: entry.transcriptTokens,
      });

      for (let seed = 0; seed < args.seeds; seed += 1) {
        for (const arm of args.arms) {
          if (capReached !== null) {
            results.push(skeleton(task, arm, seed, 'skipped', capReached));
            continue;
          }
          const result = await runOne({
            arm,
            seed,
            task,
            handle,
            runtime,
            args,
            deps,
            rubric,
            flatSummary,
            model,
          });
          results.push(result);
          if (result.status === 'error') {
            const capReason = capReasonOf(new Error(result.reason ?? ''));
            if (capReason !== null) capReached = capReason;
          }
        }
      }
    }

    const outDir = writeResults(args, deps, startedAt);
    const report = finish({
      args,
      startedAt,
      finishedAt: now().toISOString(),
      model,
      runtime,
      taskIds: tasks.map((task) => task.id),
      projection,
      skippedArms,
      conditions,
      results,
      setupCosts,
      outDir: outDir.dir,
    });
    if (outDir.dir !== null) {
      writeFileSync(join(outDir.dir, 'results.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      writeFileSync(join(outDir.dir, 'criteria.json'), `${JSON.stringify(report.criteria, null, 2)}\n`, 'utf8');
      writeFileSync(join(outDir.dir, 'summary.md'), renderSummaryMarkdown(report), 'utf8');
      log(`wrote ${outDir.dir}/{results.json,criteria.json,summary.md}`);
    }
    log(`§15 criteria: ${report.criteria.verdict} (${String(report.criteria.passed)} pass, ${String(report.criteria.failed)} fail, ${String(report.criteria.unknown)} unknown)`);
    return report;
  } finally {
    cleanup();
  }
}

interface FinishInput {
  args: RunArgs;
  startedAt: string;
  finishedAt: string;
  model: string;
  runtime: ArmRuntime;
  taskIds: string[];
  projection: SpendProjection;
  skippedArms: SkippedArm[];
  conditions: string[];
  results: ArmRunResult[];
  setupCosts: TaskSetupCost[];
  outDir: string | null;
}

function finish(input: FinishInput): RunReport {
  const metrics = aggregate(input.results, input.args.arms);
  // Per-run conditions (an absent embedder, a failed judge) are conditions of
  // the run as a whole; a reader of summary.md must not have to open
  // results.json to find out the search path degraded.
  const conditions = [...input.conditions];
  for (const result of input.results) conditions.push(...result.conditions);
  return {
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    model: input.model,
    tokenizerId: input.runtime.tokenizer.id,
    arms: input.args.arms,
    seeds: input.args.seeds,
    taskIds: input.taskIds,
    projection: input.projection,
    skippedArms: input.skippedArms,
    conditions: [...new Set(conditions)],
    results: input.results,
    metrics,
    criteria: evaluateCriteria(metrics),
    setupCosts: input.setupCosts,
    cost: input.runtime.meter.snapshot(),
    outDir: input.outDir,
  };
}

function writeResults(args: RunArgs, deps: RunDeps, startedAt: string): { dir: string | null } {
  if (deps.write === false) return { dir: null };
  const stamp = startedAt.replace(/[:.]/g, '-');
  const dir = resolve(args.cwd, args.outRoot, stamp);
  mkdirSync(dir, { recursive: true });
  return { dir };
}

/** A provider that cannot be called — held by the runtime when no key exists. */
function nullProvider(): ModelProvider {
  return {
    id: 'unavailable',
    complete(): never {
      throw new EvalRunError('no model provider is configured — this call should never have been made');
    },
  };
}

function capReasonOf(error: unknown): string | null {
  const name = (error as { name?: string }).name;
  const message = error instanceof Error ? error.message : String(error);
  if (name === 'CostCapExceededError' || message.includes('cost cap')) {
    return `cost cap reached: ${message}`;
  }
  return null;
}

function loadRubricOrNull(rubricPath: string, cwd: string, conditions: string[]): Rubric | null {
  try {
    return loadRubric(resolve(cwd, rubricPath));
  } catch (error) {
    conditions.push(`no LLM judge: ${(error as Error).message} — script checkers still ran`);
    return null;
  }
}

/**
 * Builds arm D's tree with §8's real summarizer. Failed leaves are RETURNED,
 * not swallowed: a half-summarized tree still assembles, so the only way a
 * thin Zone B shows up in the results is if this says so.
 */
async function summarizeTree(
  handle: TaskStore,
  runtime: ArmRuntime,
  config: ContextTreeConfig,
): Promise<{ summarized: number; failures: string[] }> {
  const root = handle.store.root();
  if (root === null) throw new EvalRunError('ingestion produced no root node');
  const summarizer = new Summarizer({
    store: handle.store,
    provider: runtime.provider,
    leafModel: config.leafModel,
    rootModel: config.rootModel,
    trace: handle.trace,
    blobs: handle.blobs,
    concurrency: config.summarize.concurrency,
  });
  const outcomes = await summarizer.summarizeTree(root.id);
  return {
    summarized: outcomes.filter((outcome) => outcome.status === 'summarized').length,
    failures: outcomes
      .filter((outcome) => outcome.status === 'failed')
      .map((outcome) => `${outcome.nodeId} (${outcome.role}): ${outcome.error?.message ?? 'unknown error'}`),
  };
}

function skeleton(task: EvalTask, arm: ArmId, seed: number, status: 'skipped' | 'error', reason: string): ArmRunResult {
  const result: ArmRunResult = {
    taskId: task.id,
    taskKind: task.kind,
    arm,
    seed,
    status,
    reason,
    toolCalls: [],
    conditions: [],
  };
  if (task.trap !== undefined) result.trap = task.trap;
  return result;
}

interface RunOneInput {
  arm: ArmId;
  seed: number;
  task: EvalTask;
  handle: TaskStore;
  runtime: ArmRuntime;
  args: RunArgs;
  deps: RunDeps;
  rubric: Rubric | null;
  flatSummary: string | undefined;
  model: string;
}

type BuiltPrompt =
  | { ok: true; prompt: ArmPrompt }
  | { ok: false; status: 'skipped' | 'error'; reason: string };

/** Building an arm can fail two ways, and they mean different things: an arm
 *  whose input never existed is SKIPPED, anything else is an ERROR. */
function buildPrompt(input: RunOneInput): BuiltPrompt {
  try {
    return {
      ok: true,
      prompt: buildArm(input.arm, {
        task: input.task,
        handle: input.handle,
        runtime: input.runtime,
        windowTokens: input.args.windowTokens,
        ...(input.flatSummary === undefined ? {} : { flatSummary: input.flatSummary }),
      }),
    };
  } catch (error) {
    if (error instanceof ArmUnavailableError) return { ok: false, status: 'skipped', reason: error.reason };
    return { ok: false, status: 'error', reason: (error as Error).message };
  }
}

async function runOne(input: RunOneInput): Promise<ArmRunResult> {
  const { arm, seed, task, runtime } = input;
  const result = skeleton(task, arm, seed, 'error', 'not started');

  const built = buildPrompt(input);
  if (!built.ok) return { ...result, status: built.status, reason: built.reason };
  const prompt = built.prompt;

  result.conditions = prompt.conditions;
  result.promptTokens = prompt.promptTokens;
  result.model = input.model;

  try {
    const loop = await runToolLoop({
      provider: runtime.provider,
      request: prompt.request,
      ...(prompt.tools === undefined ? {} : { tools: prompt.tools }),
      maxSteps: input.args.maxSteps,
      ...(input.deps.clock === undefined ? {} : { now: input.deps.clock }),
    });

    result.status = 'ok';
    delete result.reason;
    result.steps = loop.steps;
    result.stoppedBy = loop.stoppedBy;
    result.toolCalls = loop.toolCalls;
    result.usage = loop.usage;
    result.latencyMs = loop.totalLatencyMs;

    // Arm D only, and one submission only: a resumption is a COLD cache by
    // definition, so the honest simulated split is the first submission's —
    // Zone A+B written, the rest fresh. Priming it first would report a saving
    // no resuming agent ever sees.
    if (prompt.assembled !== undefined) {
      const simulator = new ProviderCacheSimulator({ tokenizer: runtime.tokenizer });
      const outcome = simulator.submit(prompt.assembled);
      result.simulatedCache = {
        cacheRead: outcome.cacheRead,
        cacheWrite: outcome.cacheWrite,
        fresh: outcome.fresh,
        total: outcome.total,
        tokenizerId: outcome.tokenizerId,
        profileId: outcome.profileId,
      };
    }

    const checkerOptions = input.deps.checkers === undefined ? {} : { registry: input.deps.checkers };
    const checker = await resolveChecker(task, checkerOptions);
    const checked = await checker({
      task,
      finalText: loop.finalText,
      toolCalls: loop.toolCalls,
      steps: loop.steps,
      stoppedBy: loop.stoppedBy,
    });
    result.success = checked.passed;
    result.checkerDetail = checked.detail;
    if (checked.staleSummaryIncident !== undefined) result.staleSummaryIncident = checked.staleSummaryIncident;

    if (input.rubric !== null) {
      try {
        result.judge = await judgeRun({
          provider: runtime.provider,
          model: input.model,
          rubric: input.rubric,
          task,
          answer: loop.finalText,
        });
      } catch (error) {
        // A judge that fails does not invalidate the checker's grade; it is
        // recorded as a condition so the missing scores are visible.
        result.conditions = [...result.conditions, `judge failed: ${(error as Error).message}`];
      }
    }
    return result;
  } catch (error) {
    return { ...result, status: 'error', reason: (error as Error).message };
  }
}
