/**
 * The window is the only real constraint, and prompt + reply must fit it — that
 * is arithmetic, not a cap on how much the model may say. These tests hold that
 * distinction. (The old zone-fraction budgets are gone with ZoneAssembler; the
 * flex buffer bounds itself by the soft-target floor in flex.ts.)
 */
import { describe, expect, it } from 'vitest';
import { replyAllowance, replyHeadroom, REPLY_WINDOW_FRACTION } from '../src/assemble/index.js';

describe('replyHeadroom', () => {
  it('is required by the algorithm and comes from the MODEL, not from a share of the window', () => {
    const fromModel = replyHeadroom({ modelMaxOutput: 8_192, window: 200_000 });
    expect(fromModel).toEqual({ tokens: 8_192, source: 'model-max' });
    // The window share is available but loses to the model's own figure.
    expect(fromModel.tokens).toBeGreaterThan(REPLY_WINDOW_FRACTION * 20_000);
  });

  it('a measured reply size refines it downward, bounded by what the model can emit', () => {
    expect(replyHeadroom({ modelMaxOutput: 64_000, observedMax: 900 })).toEqual({
      tokens: 900,
      source: 'observed',
    });
    // But never MORE than the model could emit, however large the observation.
    expect(replyHeadroom({ modelMaxOutput: 4_096, observedMax: 99_999 })).toEqual({
      tokens: 4_096,
      source: 'observed',
    });
  });

  it('falls back to a window share only when nothing is known, and says so', () => {
    // 32_768 * 0.05 = 1_638 (floored).
    expect(replyHeadroom({ window: 32_768 })).toEqual({ tokens: 1_638, source: 'window-fraction' });
  });

  it('refuses to invent headroom when it knows nothing', () => {
    expect(() => replyHeadroom({})).toThrow(RangeError);
  });
});

describe('replyAllowance — the per-turn form of a reply limit', () => {
  it('is arithmetic, not a chosen ceiling: whatever the window has left', () => {
    expect(replyAllowance({ window: 32_768, promptTokens: 20_000 })).toEqual({
      tokens: 12_768,
      limitedBy: 'none',
    });
  });

  it('shrinks as the session grows, so a long session CONTINUES on short replies', () => {
    const window = 32_768;
    const early = replyAllowance({ window, promptTokens: 4_000 });
    const late = replyAllowance({ window, promptTokens: 31_000 });
    expect(early.tokens).toBeGreaterThan(late.tokens);
    expect(late.tokens).toBe(1_768);
    expect(late.tokens).toBeGreaterThan(0); // still a usable turn, not a failure
  });

  it('reports WHICH side bound it, so a caller knows whether shrinking the prompt would help', () => {
    expect(replyAllowance({ window: 32_768, promptTokens: 30_000, modelMaxOutput: 8_192 })).toEqual({
      tokens: 2_768,
      limitedBy: 'window',
    });
    expect(replyAllowance({ window: 200_000, promptTokens: 10_000, modelMaxOutput: 8_192 })).toEqual({
      tokens: 8_192,
      limitedBy: 'model',
    });
  });

  it('reaches zero rather than going negative, and says the window did it', () => {
    expect(replyAllowance({ window: 8_192, promptTokens: 9_000 })).toEqual({
      tokens: 0,
      limitedBy: 'window',
    });
  });

  it('refuses a missing window rather than inventing one', () => {
    expect(() => replyAllowance({ window: 0, promptTokens: 10 })).toThrow(RangeError);
  });
});
