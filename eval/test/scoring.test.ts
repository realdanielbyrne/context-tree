/**
 * Graded scores are the A/B metric benchmark tables report (fraction of hidden
 * cases), where `success` is only the all-or-nothing bit. What matters here:
 * the canonical `SCORE: p/t` line must win over exit status — partial credit
 * on a failing run is the entire point — and a runner without one must degrade
 * to the binary per-task convention, never to a fabricated fraction.
 */
import { describe, expect, it } from 'vitest';
import { exactMatchJudge, parseCommandScore } from '../src/scoring.js';

describe('parseCommandScore', () => {
  it('reads the canonical SCORE line, giving partial credit on a FAILING run', () => {
    const stdout = 'FAIL [rle] ...\nSCORE: 54/69\n15 case(s) failed';
    expect(parseCommandScore(stdout, false)).toBeCloseTo(54 / 69, 10);
  });

  it('degrades to binary 1/0 when no SCORE line exists (legacy runners, plain commands)', () => {
    expect(parseCommandScore('all checks passed', true)).toBe(1);
    expect(parseCommandScore('something broke', false)).toBe(0);
  });

  it('rejects malformed or impossible SCORE lines instead of trusting them', () => {
    // p > t is impossible; 0 total is meaningless — fall back to exit status.
    expect(parseCommandScore('SCORE: 9/5', false)).toBe(0);
    expect(parseCommandScore('SCORE: 0/0', true)).toBe(1);
    // Prose mentioning SCORE mid-line must not match (anchored, own line).
    expect(parseCommandScore('the SCORE: 3/4 estimate is wrong', false)).toBe(0);
  });

  it('accepts a perfect score and a zero score from the line itself', () => {
    expect(parseCommandScore('SCORE: 69/69\nall 69 cases passed', true)).toBe(1);
    expect(parseCommandScore('SCORE: 0/69\n69 case(s) failed', false)).toBe(0);
  });
});

describe('exactMatchJudge score', () => {
  it('mirrors the binary match as 1/0 and stays null when there is no answer key', () => {
    expect(exactMatchJudge('the answer is 42', '42').score).toBe(1);
    expect(exactMatchJudge('the answer is 41', '42').score).toBe(0);
    expect(exactMatchJudge('anything', '').score).toBeNull();
  });
});
