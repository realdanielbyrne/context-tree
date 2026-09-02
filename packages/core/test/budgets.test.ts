/**
 * The window is the only real constraint; the zone shares are an allocation.
 * These tests hold that distinction, because losing it is what let the library
 * ship two unrelated constants and no window to check them against.
 */
import { describe, expect, it } from 'vitest';
import {
  ZONE_FRACTIONS,
  deriveZoneBudgets,
  replyAllowance,
  replyHeadroom,
  zoneBRemainder,
} from '../src/assemble/index.js';

describe('deriveZoneBudgets', () => {
  it('derives every allowance from the window, so ten times the window is ten times each', () => {
    // The property that makes a port possible: nothing here is fitted to one
    // host's window. A constant would break this test, which is the point.
    const small = deriveZoneBudgets(20_000);
    const big = deriveZoneBudgets(200_000);
    for (const key of ['zoneA', 'zoneB', 'zoneC', 'switchPoint', 'reply', 'slack'] as const) {
      expect(big[key]).toBe(10 * small[key]);
    }
  });

  it('makes the switch point the SAME quantity as Zone C, not a second number', () => {
    // The rule is "summarize nothing while the whole trace still fits where the
    // active branch's detail would go", which makes these one quantity by its
    // own wording. They had drifted to 0.35 against 0.20 in the one harness
    // that derived them, which is what that drift looks like in practice.
    expect(ZONE_FRACTIONS.switchPoint).toBe(ZONE_FRACTIONS.zoneC);
    const b = deriveZoneBudgets(200_000, 0.851);
    expect(b.switchPoint).toBe(b.zoneC);
  });

  it('applies the tokenizer ratio so the REAL prompt matches the share, not the heuristic one', () => {
    // The assembler counts with a heuristic; the provider bills its own. Handing
    // the assembler 0.20*W would make the real prompt 0.20*W*ratio. Dividing by
    // the measured ratio is what makes the real prompt 0.20*W.
    const ratio = 0.851;
    const b = deriveZoneBudgets(100_000, ratio);
    expect(b.zoneB).toBe(Math.floor((0.2 * 100_000) / ratio));
    expect(Math.round(b.zoneB * ratio)).toBeCloseTo(0.2 * 100_000, -1);
  });

  it('the shares sum to the whole window and no more', () => {
    const f = ZONE_FRACTIONS;
    // switchPoint is an alias for zoneC, not an additional slice.
    expect(f.zoneA + f.zoneB + f.zoneC + f.reply + f.slack).toBeCloseTo(0.65, 10);
    expect(f.zoneA + f.zoneB + f.zoneC + f.reply + f.slack).toBeLessThanOrEqual(1);
  });

  it('refuses a missing or nonsensical window rather than defaulting one', () => {
    // A default window would be a guess about the host, which is the defect
    // this module exists to remove.
    expect(() => deriveZoneBudgets(0)).toThrow(RangeError);
    expect(() => deriveZoneBudgets(-1)).toThrow(RangeError);
    expect(() => deriveZoneBudgets(Number.NaN)).toThrow(RangeError);
    expect(() => deriveZoneBudgets(1000, 0)).toThrow(RangeError);
  });
});

describe('zoneBRemainder', () => {
  it('is what the window has left, not a share of it — the answer to "fit against what?"', () => {
    // A block that fits the remainder is one the prompt can actually carry. A
    // block that fits 20% of the window may still overflow, and one rejected
    // for exceeding 20% may have had room all along.
    expect(zoneBRemainder({ window: 32_768, zoneA: 1_677, zoneC: 6_000, tail: 500, reply: 1_638 })).toBe(
      32_768 - 1_677 - 6_000 - 500 - 1_638,
    );
  });

  it('can exceed the fixed share, which is the case the share was silently refusing', () => {
    // Measured on the one frozen store: Zone A is about 1,677 tokens and the
    // active branch's detail is often far below its own share, so the room
    // actually available to summaries is larger than the 20% they were held to.
    const window = 32_768;
    const share = deriveZoneBudgets(window).zoneB;
    const remainder = zoneBRemainder({ window, zoneA: 1_677, zoneC: 2_000, reply: 1_638 });
    expect(remainder).toBeGreaterThan(share);
  });

  it('never goes negative — a caller learns nothing fits rather than getting a bad number', () => {
    expect(zoneBRemainder({ window: 8_192, zoneA: 5_000, zoneC: 5_000 })).toBe(0);
  });
});

describe('replyHeadroom', () => {
  it('is required by the algorithm and comes from the MODEL, not from a share of the window', () => {
    // Prompt plus reply must fit the window. That is arithmetic, so the
    // reservation stays. What was removed is the reply CAP — a limit on how
    // much the model may say — which is a guess about the work. The provider
    // reports the largest completion it will emit, and asking is rule 3.
    const fromModel = replyHeadroom({ modelMaxOutput: 8_192, window: 200_000 });
    expect(fromModel).toEqual({ tokens: 8_192, source: 'model-max' });
    // The window share is available but loses to the model's own figure, which
    // here would have under-reserved by a factor of more than three.
    expect(fromModel.tokens).toBeGreaterThan(ZONE_FRACTIONS.reply * 20_000);
  });

  it('a measured reply size refines it downward, bounded by what the model can emit', () => {
    // Reserving a 64,000-token maximum on a 200,000-token window spends a third
    // of the window on an answer no task in this corpus has produced. A caller
    // that has measured its own replies may reserve what it has actually seen.
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
    // The fallback is a guess in the way rule 2 forbids, so the caller is told
    // which source produced the number rather than being left to assume.
    expect(replyHeadroom({ window: 32_768 })).toEqual({ tokens: 1_638, source: 'window-fraction' });
  });

  it('refuses to invent headroom when it knows nothing', () => {
    expect(() => replyHeadroom({})).toThrow(RangeError);
  });
});

describe('replyAllowance — the per-turn form of a reply limit', () => {
  it('is arithmetic, not a chosen ceiling: whatever the window has left', () => {
    // Nobody picked this number. The request either fits or it fails, and this
    // is the largest reply that fits beside the prompt just assembled.
    expect(replyAllowance({ window: 32_768, promptTokens: 20_000 })).toEqual({
      tokens: 12_768,
      limitedBy: 'none',
    });
  });

  it('shrinks as the session grows, so a long session CONTINUES on short replies', () => {
    // This is the behaviour a fixed ceiling cannot have. Early on the prompt is
    // small and the model may answer at length; late on it answers briefly —
    // and the session survives, where a fixed ceiling would have made the
    // request invalid at the point the prompt outgrew it.
    const window = 32_768;
    const early = replyAllowance({ window, promptTokens: 4_000 });
    const late = replyAllowance({ window, promptTokens: 31_000 });
    expect(early.tokens).toBeGreaterThan(late.tokens);
    expect(late.tokens).toBe(1_768);
    expect(late.tokens).toBeGreaterThan(0); // still a usable turn, not a failure
  });

  it('reports WHICH side bound it, so a caller knows whether shrinking the prompt would help', () => {
    // Bound by the window: a smaller prompt buys a longer answer.
    expect(replyAllowance({ window: 32_768, promptTokens: 30_000, modelMaxOutput: 8_192 })).toEqual({
      tokens: 2_768,
      limitedBy: 'window',
    });
    // Bound by the model: no amount of prompt-shrinking buys more.
    expect(replyAllowance({ window: 200_000, promptTokens: 10_000, modelMaxOutput: 8_192 })).toEqual({
      tokens: 8_192,
      limitedBy: 'model',
    });
  });

  it('reaches zero rather than going negative, and says the window did it', () => {
    // Zero is the signal that the PROMPT has to give, not the answer — the same
    // quantity the switch point is about. It is reported, not enforced with a
    // floor: "a useful reply" is task-shaped, and choosing one here would
    // smuggle back the constant this module exists to remove.
    expect(replyAllowance({ window: 8_192, promptTokens: 9_000 })).toEqual({
      tokens: 0,
      limitedBy: 'window',
    });
  });

  it('refuses a missing window rather than inventing one', () => {
    expect(() => replyAllowance({ window: 0, promptTokens: 10 })).toThrow(RangeError);
  });
});

