/**
 * THE ARM, as the sequence of calls the plugin makes each turn.
 *
 * The pipeline is tools (`@context-tree/mcp`) and its rulings are sticky, so a treatment
 * turn is `assemble` (how each unit is represented — removes nothing), then `fold` (the
 * segmenter folds blocks under its own policy, a registry parameter: `CT_CT_FOLD_TRIGGER`),
 * then an OPTIONAL `evict`, which takes the assembly as input and may overrule it. What is
 * decided HERE is only when `evict` is called, and at what window:
 *
 *   off      never                                   the control
 *   hard     every turn, at the model's real context   the plumbing-matched control
 *   soft     every turn, at a limit well below it      U18
 *
 * `fold` is called on every turn the arm assembles, plus on every turn when folding is
 * configured on its own (`fold_reasoning_after`, the `think` arm) with eviction off.
 *
 * Lives beside the plugin, not in it: opencode calls every export of a plugin module as
 * a plugin factory, so the plugin module may export exactly one thing.
 */
export const TRIGGERS = Object.freeze(['off', 'hard', 'soft']);

const num = (env, key, fallback) => (env[key] === undefined || env[key] === '' ? fallback : Number(env[key]));

/** Defaults are INERT: a run that loses its environment is the control, never a silent arm. */
export function policyFromEnv(env = process.env) {
  return Object.freeze({
    trigger: env.CT_CT_TRIGGER || 'off',
    softWindow: num(env, 'CT_CT_WINDOW', 50_347),
    hardWindow: num(env, 'CT_CT_HARD_WINDOW', 151_040),
    replyReserve: num(env, 'CT_CT_REPLY_RESERVE', 8192),
    /** What the plugin cannot see: opencode's system block, tool schemas and skills. */
    headTokens: num(env, 'CT_CT_HEAD_TOKENS', 12_000),
    /** Folding that runs without eviction: the segmenter's own trigger, or the think rule. */
    foldsAlone: (env.CT_CT_FOLD_TRIGGER || 'none') !== 'none' || num(env, 'CT_CT_FOLD_REASONING_AFTER', 0) > 0,
    /** The G0 gate: every turn calls `assemble`, whose handler the sidecar has swapped for the gate's edits. */
    gate: env.CT_G0_DROP_FIRST === '1',
  });
}

/**
 * A mistyped knob must stop the run, not quietly turn the arm into its control.
 * `CT_CT_WINDOW=50k` reads as NaN, and a NaN window evicts nothing with nothing logged.
 */
export function validatePolicy(policy) {
  const problems = [];
  if (!TRIGGERS.includes(policy.trigger)) problems.push(`CT_CT_TRIGGER must be one of ${TRIGGERS.join('|')}, got "${policy.trigger}"`);
  for (const [name, value] of [['CT_CT_WINDOW', policy.softWindow], ['CT_CT_HARD_WINDOW', policy.hardWindow]]) {
    if (!Number.isFinite(value) || value <= 0) problems.push(`${name} must be a positive number, got ${value}`);
  }
  for (const [name, value] of [['CT_CT_REPLY_RESERVE', policy.replyReserve], ['CT_CT_HEAD_TOKENS', policy.headTokens]]) {
    if (!Number.isFinite(value) || value < 0) problems.push(`${name} must be a non-negative number, got ${value}`);
  }
  if (Number.isFinite(policy.softWindow) && Number.isFinite(policy.hardWindow) && policy.softWindow > policy.hardWindow) {
    problems.push(`CT_CT_WINDOW (${policy.softWindow}) exceeds CT_CT_HARD_WINDOW (${policy.hardWindow})`);
  }
  if (policy.replyReserve + policy.headTokens >= policy.softWindow) {
    problems.push(`reserve + head (${policy.replyReserve + policy.headTokens}) leaves no room in CT_CT_WINDOW (${policy.softWindow})`);
  }
  return problems;
}

/** Kept tokens may never exceed this: the arms run with host compaction off, so an overflow is a hard session error. */
export const ceilingOf = (policy) => policy.hardWindow - policy.headTokens - policy.replyReserve;

/** The window assembly and folding size their budgets against — or null when this arm does neither (the control). */
export function assembleWindowFor(policy) {
  if (policy.gate) return policy.hardWindow;
  if (policy.trigger === 'hard') return policy.hardWindow;
  if (policy.trigger === 'soft' || policy.foldsAlone) return policy.softWindow;
  return null;
}

export const reserveOf = (policy, window) => Math.min(window - 1, policy.replyReserve + policy.headTokens);

/**
 * The evict call for this turn, or null. `hostTokens` is the plugin's own size of the
 * message array; when it alone would overflow the real context the floor fires whatever
 * the trigger says — that floor is under every arm and is reported as such, not as the arm.
 */
export function evictCallFor(policy, turn, hostTokens) {
  if (policy.gate) return null;
  const at = (window, floor) => ({ window_tokens: window, reserve_tokens: reserveOf(policy, window), turn, floor });
  if (policy.trigger === 'soft') return at(policy.softWindow, false);
  if (policy.trigger === 'hard') return at(policy.hardWindow, false);
  if (hostTokens > ceilingOf(policy)) return at(policy.hardWindow, true);
  return null;
}
