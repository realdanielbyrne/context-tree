/**
 * §15 harness types. A `Scenario` is the benchmark-neutral unit of work: one
 * task, an optional set of files materialized into the sandbox, and one judge.
 * An `Adapter` turns a benchmark's native layout into scenarios; the loop runs
 * every scenario twice — arm `native` (full transcript) and arm
 * `context-tree` (tree summaries + the four tools) — and a `RunResult` carries
 * the metrics for exactly one of those runs.
 */
import type { TokenUsage } from '@context-tree/core';
import type { AttentionProfile } from './attention-loop.js';
import type { DeepSweEnvironment } from './adapters/deepswe.js';
import type { LhtbEnvironment } from './adapters/lhtb.js';

/** §15's arms: raw transcript vs the tree, plus the top-k filtered variants. */
export type Arm = 'native' | 'context-tree' | 'dsa' | 'tree-dsa' | 'prefix-retrieval' | 'attention';

export const ARMS: readonly Arm[] = ['native', 'context-tree', 'dsa', 'tree-dsa', 'prefix-retrieval', 'attention'] as const;

export function isArm(value: string): value is Arm {
  return (ARMS as readonly string[]).includes(value);
}

export type JudgeKind = 'exact_match' | 'command' | 'llm_rubric' | 'deepswe' | 'lhtb';

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
  environment?: DeepSweEnvironment | LhtbEnvironment;
}

/** One benchmark's loader: native layout on disk -> scenarios. Fails loud. */
export interface Adapter {
  readonly id: string;
  load(dir: string): Scenario[];
}

/**
 * `stalled` is a fact about the run: three consecutive turns in which the model
 * only repeated calls it had already made. `turn_cap`, `time_cap` and
 * `cost_cap` are facts about the HARNESS — a run carrying one of them was
 * stopped before it could finish, so it is not evidence of task failure and
 * `success` stays null rather than false. Turn and wall-clock ceilings are
 * unbounded unless a probe deliberately sets one.
 */
export type RunStatus = 'completed' | 'stalled' | 'turn_cap' | 'time_cap' | 'cost_cap' | 'token_cap' | 'error';

/** Statuses that mean the harness stopped the run, not that the task failed. */
export const HARNESS_STOPPED: readonly RunStatus[] = ['turn_cap', 'time_cap', 'cost_cap', 'token_cap'];

export interface TurnRecord {
  index: number;
  latencyMs: number;
  usage: TokenUsage;
  /** False means usage contains only the known subtotal from this turn's attempts. */
  usageComplete?: boolean;
  toolCalls: string[];
  stopReason: string | null;
  attempts?: number;
  promptTokens?: number;
}

export type TokenTotals = TokenUsage & { total: number };

/**
 * loop9b-item3 §3: pure derivations of `turns[].toolCalls` (names only, no
 * new capture) that separate the completion-gate's own trailing-turn
 * contribution from the batching-density question the null test (§5.4) asks.
 */
export interface BatchingMetrics {
  /** Consecutive zero-tool-call turns at the tail of the run. */
  trailingBareTurns: number;
  /** The tree-only completion-gate nudge fired at least once this run. */
  gateFired: boolean;
  /** After the gate fired, the very next turn issued tool calls again. */
  gateRescued: boolean;
  /** Total tool calls / turns that made at least one call — the corrected density. */
  callsPerToolUsingTurn: number;
  /** Total tool calls / all turns (mixes in the trailing-empty-turn question). */
  callsPerTurn: number;
  /** `write_file` calls / turns containing at least one `write_file`. */
  writesPerWriteBearingTurn: number;
  /** Largest single-turn `read_file` fan-out. */
  maxReadBatch: number;
  /** Largest single-turn `write_file` fan-out. */
  maxWriteBatch: number;
  /** Turns whose only tool calls are `run_command`. */
  runCommandOnlyTurns: number;
}

export interface RunMetrics {
  tokens: TokenTotals;
  /** All providers, including retries and summaries; old tokens remains agent-only. */
  allModelTokens?: TokenTotals;
  usageComplete?: boolean;
  turns: { modelTurns: number; toolCalls: number };
  speed: { wallMs: number; p50TurnMs: number; p95TurnMs: number; outputTokensPerSec: number };
  costUsd: number;
  batching: BatchingMetrics;
  /** item 1's one-way latch (`runTreeArm`'s `lazyCrossed`); false for non-tree arms. */
  lazyCrossed: boolean;
  finalTextChars: number;
}

export interface JudgeResult {
  success: boolean | null;
  /**
   * Graded score in [0, 1] — the A/B metric HF-style benchmark tables report
   * (fraction of hidden cases, rubric grade), where `success` is only the
   * all-or-nothing bit. `null` = ungraded (no SCORE line, judge errored).
   * Command judges read a canonical `SCORE: <passed>/<total>` stdout line;
   * without one, exit status degrades to binary 1/0.
   */
  score: number | null;
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
  costByModel?: {
    model: string; calls: number; usage: TokenUsage;
    /** Price-table estimate of the known usage subtotal, not a provider invoice. */
    usd: number;
    priceMatched?: string | null;
    usageComplete?: boolean;
  }[];
  status: RunStatus;
  success: boolean | null;
  judge: JudgeResult | null;
  metrics: RunMetrics;
  turns: TurnRecord[];
  error?: string;
  /** Present only when the sandbox was kept for inspection. */
  sandboxPath?: string;
  capturePath?: string;
  configuration?: Record<string, unknown>;
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
  /**
   * The model's context window in tokens. When set, the tree arm's assembler
   * enforces it per turn (evicting already-seen retrieval results, then Zone C
   * events, so prompt + reply fit); unset keeps the report-only behaviour.
   */
  window?: number;
  keepSandbox: boolean;
  /** Durable evidence outside disposable sandboxes; CLI enables it by default. */
  captureDir?: string;
  tokenCap?: number;
  policyProfile?: AttentionProfile;
  /**
   * Pinned sampling temperature for every agent-loop and summarizer call, or
   * null for the provider default. Unpinned sampling is the program's largest
   * error bar (10-vs-37-turn forks on identical binaries) — but the Claude 5
   * API rejects the param ("deprecated for this model"), so on that family
   * variance is controlled with replicates + medians and this stays unset.
   */
  temperature?: number | null;
}
