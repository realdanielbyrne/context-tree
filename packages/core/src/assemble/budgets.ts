/**
 * Reply-reservation arithmetic derived from the host's window.
 *
 * The flex assembler bounds the flex buffer by a soft-target floor (a fraction of
 * the window; see `flex.ts`), so the old zone-fraction budgets are gone. What
 * remains is the one thing the algorithm genuinely requires: room for the reply.
 * Prompt + reply must fit the window — that is arithmetic, not a cap on how much
 * the model may say (a reasoning model can spend a fixed ceiling on thinking and
 * return an empty answer). The reservation stays; the ceiling does not.
 */

/**
 * FALLBACK ONLY. Reply headroom should come from the model's declared max output,
 * not a share of the window — see `replyHeadroom`. This fraction applies only when
 * the host cannot say what its model may emit.
 */
export const REPLY_WINDOW_FRACTION = 0.05;

/**
 * Room to reserve so the model's answer can arrive. Prefer the model's declared
 * max output; refine downward with an observed max; fall back to a window share
 * only when nothing is known (and say so).
 *
 * @param modelMaxOutput the largest completion the provider says it will emit
 * @param observedMax    the largest reply this caller has actually measured
 * @param window         used only for the fallback share, when nothing is known
 */
export function replyHeadroom(input: {
  modelMaxOutput?: number;
  observedMax?: number;
  window?: number;
}): { tokens: number; source: 'observed' | 'model-max' | 'window-fraction' } {
  const { modelMaxOutput, observedMax, window } = input;
  if (observedMax !== undefined && Number.isFinite(observedMax) && observedMax > 0) {
    // Never reserve more than the model could emit even if asked for more.
    const bounded =
      modelMaxOutput !== undefined && modelMaxOutput > 0 ? Math.min(observedMax, modelMaxOutput) : observedMax;
    return { tokens: Math.ceil(bounded), source: 'observed' };
  }
  if (modelMaxOutput !== undefined && Number.isFinite(modelMaxOutput) && modelMaxOutput > 0) {
    return { tokens: Math.ceil(modelMaxOutput), source: 'model-max' };
  }
  if (window !== undefined && Number.isFinite(window) && window > 0) {
    return { tokens: Math.floor(REPLY_WINDOW_FRACTION * window), source: 'window-fraction' };
  }
  throw new RangeError(
    'replyHeadroom needs one of modelMaxOutput (preferred), observedMax, or window — ' +
      'the algorithm requires headroom for the reply and this library will not invent it',
  );
}

/**
 * What to pass as the provider's `max_tokens` this turn: whatever the window has
 * left once the assembled prompt is accounted for. The honest form of a reply
 * limit — arithmetic, not a chosen ceiling. Early in a session it is nearly the
 * whole window; late in a long one it is small and the session CONTINUES on short
 * replies where a fixed ceiling would have made the request invalid. Never negative.
 *
 * @param window         the host's context window in provider tokens
 * @param promptTokens   the assembled prompt's size, in the same units
 * @param modelMaxOutput the largest completion the provider will emit, if known
 */
export function replyAllowance(input: {
  window: number;
  promptTokens: number;
  modelMaxOutput?: number;
}): { tokens: number; limitedBy: 'window' | 'model' | 'none' } {
  const { window, promptTokens, modelMaxOutput } = input;
  if (!Number.isFinite(window) || window <= 0) {
    throw new RangeError(`window must be a positive number of tokens, got ${String(window)}`);
  }
  const room = Math.max(0, Math.floor(window - promptTokens));
  if (modelMaxOutput === undefined || !Number.isFinite(modelMaxOutput) || modelMaxOutput <= 0) {
    return { tokens: room, limitedBy: room === 0 ? 'window' : 'none' };
  }
  return room <= modelMaxOutput
    ? { tokens: room, limitedBy: 'window' }
    : { tokens: Math.floor(modelMaxOutput), limitedBy: 'model' };
}
