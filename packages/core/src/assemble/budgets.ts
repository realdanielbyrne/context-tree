/**
 * Zone allowances derived from ONE number: the host's context window.
 *
 * Why this file exists. Until 2026-09-02 the library carried two independent
 * constants — a Zone B allowance of 8,000 tokens and a Zone C allowance of
 * 30,000 — with no representation of the window anywhere, so nothing could
 * check either against the constraint that actually matters. "The largest fold
 * level whose Zone B fits" was therefore fitting to a share of a number the
 * library did not have. The portability rules this project is held to call that
 * a defect twice over: it is a budget (rule 1) and it is a constant nobody
 * validated off the host it was fitted on (rule 2).
 *
 * What replaces it. The host supplies its window; these fractions partition it;
 * one function does the arithmetic. That does not make the fractions right —
 * they are still a design allocation and rule 4 says which allocation wins has
 * to be measured — but it makes them ONE thing derived from a real quantity
 * rather than several unrelated guesses, and it gives the assembler a window to
 * report the true constraint against.
 *
 * The tokenizer divisor. The assembler counts with a heuristic tokenizer while
 * the provider bills its own, and on real corpora those disagree by a
 * measurable factor. Handing the assembler `0.20 * W` would make the real
 * prompt `0.20 * W * ratio`, off by however far the heuristic drifts. Dividing
 * by the measured ratio makes the real prompt `0.20 * W`, which is the number
 * the window is expressed in. The ratio is measured per corpus by the caller;
 * this function only applies it.
 */

/**
 * Shares of the window, summing to 1. Not validated: no experiment has swept
 * them, so they are an unvalidated design allocation and rule 2 marks them as
 * such. They are recorded here, in one place, so a sweep has something single
 * to vary.
 *
 * `switchPoint` is deliberately the same share as `zoneC`, not a separate
 * number. The rule it implements — summarize nothing while the whole trace
 * still fits where the active branch's detail would go — makes them the same
 * quantity by its own wording. They had drifted apart (0.35 against 0.20) in
 * the one harness that derived them at all, which is what that drift looks
 * like when two authors edit one occurrence.
 */
export const ZONE_FRACTIONS = Object.freeze({
  zoneA: 0.1,
  zoneB: 0.2,
  zoneC: 0.2,
  /**
   * FALLBACK ONLY. Reply headroom should come from the model, not from a share
   * — see `replyHeadroom`. This fraction applies when the host cannot say what
   * its model may emit, and it is a guess in exactly the way rule 2 forbids.
   */
  reply: 0.05,
  slack: 0.1,
  get switchPoint(): number {
    return 0.2;
  },
});

/**
 * Room left in the window so the model's answer can arrive.
 *
 * **The algorithm requires this**, and it is not a reply cap. Prompt plus reply
 * must fit the window — that is arithmetic, and if the prompt crowds the reply
 * out the provider truncates the answer and reports it as a length stop. What
 * the algorithm does NOT require, and what was removed on 2026-09-02, is a
 * limit on how much the model may say: that is a guess about the work, and on a
 * model that reasons before answering it can be spent thinking, leaving an
 * empty reply that a grader scores as wrong.
 *
 * So the reservation stays and the ceiling goes. The size of the reservation
 * comes from the model: every provider reports the largest completion it will
 * emit, and reserving that is the only figure that cannot be too small. Rule 3
 * permits exactly this — a parameter set from a model's limits, obtained by
 * asking rather than by guessing.
 *
 * `observedMax` refines it downward. Reserving a 64,000-token maximum on a
 * 200,000-token window spends a third of the window on an answer no task in
 * this corpus has ever produced, so a caller that has measured its own replies
 * may pass the largest it has actually seen, with margin. That is rule 4's
 * sweet spot rather than rule 1's cap, because exceeding it costs a truncated
 * answer that is reported, not a silently degraded one.
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
    return { tokens: Math.floor(ZONE_FRACTIONS.reply * window), source: 'window-fraction' };
  }
  throw new RangeError(
    'replyHeadroom needs one of modelMaxOutput (preferred), observedMax, or window — ' +
      'the algorithm requires headroom for the reply and this library will not invent it',
  );
}

export interface ZoneBudgets {
  /** The window these were derived from, carried so a report can name it. */
  window: number;
  /** The heuristic-to-provider ratio applied. 1 means no correction. */
  ratio: number;
  zoneA: number;
  zoneB: number;
  zoneC: number;
  /** Prompt size at which the tree stops showing the whole trace (= zoneC). */
  switchPoint: number;
  /** Reserved so a reply fits beside the prompt. NOT a limit on the reply. */
  reply: number;
  slack: number;
}

/**
 * @param window the host's context window in provider tokens
 * @param ratio  measured heuristic-to-provider token ratio for this corpus
 */
export function deriveZoneBudgets(window: number, ratio = 1): ZoneBudgets {
  if (!Number.isFinite(window) || window <= 0) {
    throw new RangeError(`window must be a positive number of tokens, got ${String(window)}`);
  }
  if (!Number.isFinite(ratio) || ratio <= 0) {
    throw new RangeError(`ratio must be positive, got ${String(ratio)}`);
  }
  const per = (fraction: number): number => Math.floor((fraction * window) / ratio);
  return {
    window,
    ratio,
    zoneA: per(ZONE_FRACTIONS.zoneA),
    zoneB: per(ZONE_FRACTIONS.zoneB),
    zoneC: per(ZONE_FRACTIONS.zoneC),
    switchPoint: per(ZONE_FRACTIONS.switchPoint),
    reply: per(ZONE_FRACTIONS.reply),
    slack: per(ZONE_FRACTIONS.slack),
  };
}

/**
 * What Zone B may actually occupy: everything the window has left once the
 * fixed contract, the active branch's detail, the appended tail and the reply
 * reservation are accounted for.
 *
 * This is the answer to "fit against what?" that does not invent a share. A
 * caller with a window should prefer it to `ZoneBudgets.zoneB`, because a
 * summary block that fits the remainder is one the prompt can actually carry,
 * while one that fits 20% of the window may still overflow — and, conversely, a
 * block rejected for exceeding its 20% share may have had room all along. The
 * latter is not hypothetical: on the one measured store, six of seven fold
 * levels satisfied the share test, so the share was barely binding and the
 * choice between them fell to a hand-written ordering instead.
 *
 * Never negative: a caller gets 0 and the knowledge that nothing fits.
 */
export function zoneBRemainder(input: {
  window: number;
  zoneA: number;
  zoneC: number;
  tail?: number;
  reply?: number;
}): number {
  const { window, zoneA, zoneC, tail = 0, reply = 0 } = input;
  return Math.max(0, window - zoneA - zoneC - tail - reply);
}

/**
 * What to pass as the provider's `max_tokens` on THIS turn: whatever the window
 * has left once the assembled prompt is accounted for.
 *
 * This is the honest form of a reply limit, and it is not the thing rule 1
 * forbids. A fixed ceiling is a guess about how much the model needs to say. An
 * allowance computed per turn is arithmetic: the request either fits or it
 * fails, and this is the largest reply that fits. Nobody chose it.
 *
 * What it buys is the behaviour a fixed ceiling cannot have. Early in a session
 * the prompt is small and the allowance is nearly the whole window, so the model
 * may answer at length. Late in a long session the prompt is large and the
 * allowance is small, so the model answers briefly — and the session CONTINUES,
 * where a fixed ceiling would have made the request invalid and ended it. A
 * small-window model can therefore iterate through a long session on short
 * replies instead of failing at the point its prompt outgrew its ceiling.
 *
 * Sending it also tells the model its own allowance, which a prompt sentence
 * cannot do reliably: providers surface `max_tokens` to the model and stop at
 * it, so the model shortens its answer rather than being cut mid-sentence.
 *
 * The shrinking allowance is itself a signal, and it is the same quantity the
 * switch point is about: when the room left for an answer stops being enough
 * for a useful one, the prompt — not the answer — is what has to give. Callers
 * get the number and decide; this function does not pick a floor, because "a
 * useful reply" is task-shaped and picking one here would smuggle back the
 * constant this whole module exists to remove.
 *
 * @param window      the host's context window in provider tokens
 * @param promptTokens the assembled prompt's size, in the same units
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
  // Asking for more than the model can emit is not an error, but reporting
  // which side bound the allowance tells a caller whether a longer answer is
  // available by shrinking the prompt (window) or not at all (model).
  return room <= modelMaxOutput
    ? { tokens: room, limitedBy: 'window' }
    : { tokens: Math.floor(modelMaxOutput), limitedBy: 'model' };
}
