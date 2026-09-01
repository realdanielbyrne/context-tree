/**
 * §15's v1 success criteria as code:
 *
 *   D >= A - 5 points on success rate
 *   D >= 50% cheaper than A in input tokens
 *   D >= 30% cheaper than C in input tokens
 *   tool-call overhead < 2.5 per task
 *
 * A criterion whose inputs are missing is `unknown`, never `pass`. That is the
 * whole reason this file exists as code rather than as four lines of prose in a
 * report: the failure mode of a hand-written results table is a criterion that
 * quietly reads as met because the arm it compares against never ran.
 */
import type { ArmId } from './arms.js';
import type { ArmMetrics, MeasurementSource } from './metrics.js';

export type CriterionStatus = 'pass' | 'fail' | 'unknown';

export interface CriterionOutcome {
  id: string;
  description: string;
  status: CriterionStatus;
  /** The measured value, in `unit`. Null exactly when the status is `unknown`. */
  actual: number | null;
  threshold: number;
  unit: string;
  /** Names the arms and the numbers, or names what was missing. */
  detail: string;
  /** Which kind of number produced `actual`; both sides always share it. */
  source?: MeasurementSource;
}

export interface CriteriaReport {
  criteria: CriterionOutcome[];
  passed: number;
  failed: number;
  unknown: number;
  /** `unproven` when nothing failed but something could not be evaluated. */
  verdict: 'met' | 'not-met' | 'unproven';
}

export const SUCCESS_RATE_GAP_POINTS = 5;
/**
 * Slack for binary floating point only. 0.95 - 1.0 is -5.000000000000004
 * points, and a criterion that fails on the fourteenth decimal of a ratio is
 * reporting the IEEE spec, not the system.
 */
export const EPSILON = 1e-9;
export const TOKEN_REDUCTION_VS_A = 0.5;
export const TOKEN_REDUCTION_VS_C = 0.3;
export const MAX_TOOL_CALLS_PER_TASK = 2.5;

function byArm(metrics: readonly ArmMetrics[]): Map<ArmId, ArmMetrics> {
  return new Map(metrics.map((entry) => [entry.arm, entry]));
}

function unknown(id: string, description: string, threshold: number, unit: string, detail: string): CriterionOutcome {
  return { id, description, status: 'unknown', actual: null, threshold, unit, detail };
}

/**
 * Both sides of a token comparison must come from the same kind of number.
 * Measured beats simulated when both arms have it; a measured-vs-simulated
 * comparison is refused outright rather than reported with a caveat.
 */
function comparableInputTokens(
  left: ArmMetrics,
  right: ArmMetrics,
): { left: number; right: number; source: MeasurementSource } | null {
  if (left.inputTokensPerRun !== null && right.inputTokensPerRun !== null) {
    return { left: left.inputTokensPerRun.value, right: right.inputTokensPerRun.value, source: 'measured' };
  }
  if (left.simulatedInputTokensPerRun !== null && right.simulatedInputTokensPerRun !== null) {
    return {
      left: left.simulatedInputTokensPerRun.value,
      right: right.simulatedInputTokensPerRun.value,
      source: 'simulated',
    };
  }
  return null;
}

function tokenCriterion(
  id: string,
  baseline: ArmId,
  threshold: number,
  metrics: Map<ArmId, ArmMetrics>,
): CriterionOutcome {
  const description = `arm D uses at least ${String(Math.round(threshold * 100))}% fewer input tokens than arm ${baseline}`;
  const unit = 'fraction reduction';
  const d = metrics.get('D');
  const other = metrics.get(baseline);
  if (d === undefined || other === undefined) {
    return unknown(id, description, threshold, unit, `arm ${d === undefined ? 'D' : baseline} is not in the result set`);
  }
  const pair = comparableInputTokens(d, other);
  if (pair === null) {
    const detail =
      d.inputTokensPerRun === null && d.simulatedInputTokensPerRun === null
        ? 'arm D reported no input tokens (it did not run)'
        : `arms D and ${baseline} have no token figure of the same kind — measured and simulated are never blended`;
    return unknown(id, description, threshold, unit, detail);
  }
  if (pair.right === 0) {
    return unknown(id, description, threshold, unit, `arm ${baseline} reported 0 input tokens — no ratio to take`);
  }
  const reduction = 1 - pair.left / pair.right;
  return {
    id,
    description,
    status: reduction >= threshold - EPSILON ? 'pass' : 'fail',
    actual: reduction,
    threshold,
    unit,
    source: pair.source,
    detail: `D ${pair.left.toFixed(0)} vs ${baseline} ${pair.right.toFixed(0)} input tokens per run (${pair.source})`,
  };
}

export function evaluateCriteria(metrics: readonly ArmMetrics[]): CriteriaReport {
  const map = byArm(metrics);
  const criteria: CriterionOutcome[] = [];

  // 1. success rate within 5 points of the full-transcript ceiling.
  {
    const id = 'success-rate-gap';
    const description = `arm D's success rate is within ${String(SUCCESS_RATE_GAP_POINTS)} points of arm A`;
    const unit = 'percentage points (D - A)';
    const d = map.get('D');
    const a = map.get('A');
    if (d?.successRate == null || a?.successRate == null) {
      const missing = [d?.successRate == null ? 'D' : null, a?.successRate == null ? 'A' : null]
        .filter((value): value is string => value !== null)
        .join(' and ');
      criteria.push(unknown(id, description, -SUCCESS_RATE_GAP_POINTS, unit, `no graded runs for arm ${missing}`));
    } else {
      const gap = (d.successRate - a.successRate) * 100;
      criteria.push({
        id,
        description,
        status: gap >= -SUCCESS_RATE_GAP_POINTS - EPSILON ? 'pass' : 'fail',
        actual: gap,
        threshold: -SUCCESS_RATE_GAP_POINTS,
        unit,
        source: 'measured',
        detail: `D ${(d.successRate * 100).toFixed(1)}% (${String(d.successes)}/${String(d.runs)}) vs A ${(a.successRate * 100).toFixed(1)}% (${String(a.successes)}/${String(a.runs)})`,
      });
    }
  }

  criteria.push(tokenCriterion('input-tokens-vs-a', 'A', TOKEN_REDUCTION_VS_A, map));
  criteria.push(tokenCriterion('input-tokens-vs-c', 'C', TOKEN_REDUCTION_VS_C, map));

  // 4. tool-call overhead — the price D pays for being smaller.
  {
    const id = 'tool-call-overhead';
    const description = `arm D makes fewer than ${String(MAX_TOOL_CALLS_PER_TASK)} tool calls per task`;
    const unit = 'tool calls per run';
    const d = map.get('D');
    if (d == null || d.toolCallsPerTask === null) {
      criteria.push(unknown(id, description, MAX_TOOL_CALLS_PER_TASK, unit, 'arm D has no completed runs'));
    } else {
      criteria.push({
        id,
        description,
        status: d.toolCallsPerTask < MAX_TOOL_CALLS_PER_TASK ? 'pass' : 'fail',
        actual: d.toolCallsPerTask,
        threshold: MAX_TOOL_CALLS_PER_TASK,
        unit,
        source: 'measured',
        detail: `${String(d.toolCalls)} tool calls across ${String(d.runs)} runs`,
      });
    }
  }

  const passed = criteria.filter((criterion) => criterion.status === 'pass').length;
  const failed = criteria.filter((criterion) => criterion.status === 'fail').length;
  const unproven = criteria.filter((criterion) => criterion.status === 'unknown').length;
  return {
    criteria,
    passed,
    failed,
    unknown: unproven,
    verdict: failed > 0 ? 'not-met' : unproven > 0 ? 'unproven' : 'met',
  };
}
