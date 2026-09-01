/**
 * §15 harness types. A `Scenario` is the benchmark-neutral unit of work: one
 * task, an optional set of files materialized into the sandbox, and one judge.
 * An `Adapter` turns a benchmark's native layout into scenarios; the loop runs
 * every scenario twice — arm `native` (full transcript) and arm
 * `context-tree` (tree summaries + the four tools) — and a `RunResult` carries
 * the metrics for exactly one of those runs.
 */
import type { TokenUsage } from '@context-tree/core';

/** §15's arms: raw transcript vs the tree, plus the top-k filtered variants. */
export type Arm = 'native' | 'context-tree' | 'dsa' | 'tree-dsa';

export const ARMS: readonly Arm[] = ['native', 'context-tree', 'dsa', 'tree-dsa'] as const;

export function isArm(value: string): value is Arm {
  return (ARMS as readonly string[]).includes(value);
}

export type JudgeKind = 'exact_match' | 'command' | 'llm_rubric';

export interface ScenarioJudge {
  kind: JudgeKind;
  /** `exact_match`: the expected answer; matched against the agent's final text. */
  answer?: string;
  /** `llm_rubric`: the grading rubric shown to the judge model. */
  rubric?: string;
  /** `command`: shell command run in the sandbox; exit 0 = success. */
  command?: string;
  /** Files written into the sandbox only for the judge (e.g. hidden tests). */
  files?: Record<string, string>;
}

export interface Scenario {
  id: string;
  benchmark: string;
  task: string;
  /** Files materialized into the sandbox before the agent starts. */
  files?: Record<string, string>;
  judge: ScenarioJudge;
  meta?: Record<string, unknown>;
}

/** One benchmark's loader: native layout on disk -> scenarios. Fails loud. */
export interface Adapter {
  readonly id: string;
  load(dir: string): Scenario[];
}

export type RunStatus = 'completed' | 'turn_cap' | 'time_cap' | 'cost_cap' | 'error';

export interface TurnRecord {
  index: number;
  latencyMs: number;
  usage: TokenUsage;
  toolCalls: string[];
  stopReason: string | null;
}

export type TokenTotals = TokenUsage & { total: number };

export interface RunMetrics {
  tokens: TokenTotals;
  turns: { modelTurns: number; toolCalls: number };
  speed: { wallMs: number; p50TurnMs: number; p95TurnMs: number; outputTokensPerSec: number };
  costUsd: number;
}

export interface JudgeResult {
  success: boolean | null;
  detail: string;
}

export interface RunResult {
  runId: string;
  benchmark: string;
  scenarioId: string;
  arm: Arm;
  model: string;
  /** Present when sampling temperature was pinned for this run. */
  temperature?: number;
  /**
   * Per-model spend ledger (agent + summarizer + judge), from the cost meter.
   * This is what makes summarizer overhead attributable per run instead of a
   * stderr-only residual.
   */
  costByModel?: { model: string; calls: number; usage: TokenUsage; usd: number }[];
  status: RunStatus;
  success: boolean | null;
  judge: JudgeResult | null;
  metrics: RunMetrics;
  turns: TurnRecord[];
  error?: string;
  /** Present only when the sandbox was kept for inspection. */
  sandboxPath?: string;
  startedAt: string;
  finishedAt: string;
}

export interface HarnessOptions {
  model: string;
  leafModel: string;
  rootModel: string;
  judgeModel: string;
  provider: 'anthropic' | 'openrouter';
  maxTurns: number;
  timeCapMs: number;
  costCapUsd: number | null;
  budgets: { zoneB: number; zoneC: number };
  keepSandbox: boolean;
  /**
   * Pinned sampling temperature for every agent-loop and summarizer call, or
   * null for the provider default. Unpinned sampling is the program's largest
   * error bar (10-vs-37-turn forks on identical binaries) — but the Claude 5
   * API rejects the param ("deprecated for this model"), so on that family
   * variance is controlled with replicates + medians and this stays unset.
   */
  temperature?: number | null;
}
