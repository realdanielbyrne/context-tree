/**
 * Offline tests for the loop-9 transplant harness's pure half
 * (`eval/scripts/transplant.mjs`). Three things here can silently invalidate
 * the whole experiment rather than fail it, so they are tested against
 * synthetic fixtures and spend nothing:
 *
 *   1. Answer-literal uniqueness. A literal that occurs twice in L0 is not an
 *      answer key, it is a coin flip, and a regex grader cannot tell the
 *      difference — so extraction must drop it before a question is written.
 *   2. The leakage gate's answer-literal carve-out. Without the carve-out the
 *      gate rejects every question that must contain its own answer token,
 *      which is most of them; with it, a question that paraphrases the stored
 *      summary must still be rejected. Both directions are load-bearing.
 *   3. Budget derivation. D19 makes every budget a function of W and the
 *      measured ratio, so an arithmetic slip here silently re-tunes the arm
 *      it was introduced to stop hand-tuning.
 */
import { describe, expect, it } from 'vitest';
import {
  FRACTIONS,
  answerRegexesFor,
  binomialN,
  ROOT_KEEP_LADDER,
  contextGrowthSeries,
  countOccurrences,
  deriveBudgets,
  deriveRootKeep,
  escalationN,
  extractLiterals,
  isContiguousSuffix,
  leakageGate,
  looksLikeAnswerKey,
  pickDeterministic,
  ratioVerdict,
  // @ts-expect-error — the harness is plain .mjs; vitest resolves it, tsc never sees it.
} from '../scripts/transplant.mjs';

// ── synthetic L0: two phases, one literal unique, one repeated ───────────
// Each blob is padded past the extractor's 200-char minimum context window:
// a literal with no surrounding prose cannot be paraphrased into a question,
// so the extractor drops it, and a fixture below that floor tests nothing.
const PADDING =
  ' The surrounding discussion runs on for a while about backoff, jitter, and the retry ceiling, ' +
  'so that every candidate literal in this fixture carries enough context for a paraphraser to work from, ' +
  'which is the same minimum the real extractor enforces over L0.';

const BLOBS = new Map<string, string>([
  ['b1', `Cap the retry budget at 2650 attempts in ../src/loader/retry.js, per the backoff note.${PADDING}`],
  ['b2', `Confirmed: the retry ceiling is right. Repeated token shared_marker_value sits here too.${PADDING}`],
  ['b3', `Later phase. The value shared_marker_value shows up a second time, which disqualifies it.${PADDING}`],
]);

const blobs = { getText: (ref: string) => BLOBS.get(ref) ?? '' };

const events = [
  { seq: 1, type: 'user_message', ts: 'T', blob: 'b1' },
  { seq: 2, type: 'assistant_message', ts: 'T', blob: 'b2' },
  { seq: 3, type: 'assistant_message', ts: 'T', blob: 'b3' },
];

const store = {
  nodesInCreationOrder: () => [
    { id: 'p1', kind: 'phase', phase_type: 'implementation', span_start_seq: 1, span_end_seq: 2 },
    { id: 'p2', kind: 'phase', phase_type: 'diagnosis', span_start_seq: 3, span_end_seq: 3 },
  ],
};

describe('answer-literal extraction', () => {
  it('keeps a literal that occurs exactly once and drops one that repeats', () => {
    const { onceOnly, all } = extractLiterals(events, blobs, store) as {
      onceOnly: { literal: string; node_id: string; seq: number }[];
      all: { literal: string; occurrences: number }[];
    };
    const kept = onceOnly.map((r) => r.literal);
    expect(kept).toContain('2650');
    expect(kept).toContain('../src/loader/retry.js');
    // Present as a candidate, counted twice, therefore not an answer key.
    expect(all.find((r) => r.literal === 'shared_marker_value')?.occurrences).toBe(2);
    expect(kept).not.toContain('shared_marker_value');
  });

  it('binds each literal to the phase whose span covers its seq — the answer key needs a node', () => {
    const { onceOnly } = extractLiterals(events, blobs, store) as {
      onceOnly: { literal: string; node_id: string }[];
    };
    expect(onceOnly.find((r) => r.literal === '2650')?.node_id).toBe('p1');
  });

  it('counts non-overlapping occurrences, so a self-overlapping needle is not double-counted', () => {
    expect(countOccurrences('aaaa', 'aa')).toBe(2);
    expect(countOccurrences('the cap is 50', '50')).toBe(1);
    expect(countOccurrences('nothing here', '50')).toBe(0);
  });

  it('rejects markup and shell fragments a raw regex sweep picks up', () => {
    const inHtml = { literal: 'nold_k3', kind: 'ident', context: 'x <div class="row">nold_k3</div> y' };
    expect(looksLikeAnswerKey(inHtml)).toBe(false);
    expect(looksLikeAnswerKey({ literal: '2>/dev/null || python3 -c "', kind: 'quoted', context: 'plain' })).toBe(false);
    // A truncated path fragment ("v/p.ymax") is not a path anyone can name.
    expect(looksLikeAnswerKey({ literal: 'v/p.ymax', kind: 'path', context: 'plain prose' })).toBe(false);
    expect(looksLikeAnswerKey({ literal: 'src/loader/retry.js', kind: 'path', context: 'plain prose' })).toBe(true);
  });

  it('picks the same items on every run, and tops up when branches run out', () => {
    const pool = [
      { literal: 'alpha_one', node_id: 'p1' },
      { literal: 'beta_two', node_id: 'p1' },
      { literal: 'gamma_three', node_id: 'p2' },
    ];
    const first = pickDeterministic(pool, 3).map((r: { literal: string }) => r.literal);
    const second = pickDeterministic(pool, 3).map((r: { literal: string }) => r.literal);
    expect(first).toEqual(second);
    // Only two distinct branches exist, but the stratum is pre-registered at 3:
    // returning 2 would silently shrink it.
    expect(first).toHaveLength(3);
  });
});

describe('leakage gate', () => {
  const summaryText = 'We capped the retry budget at 2650 attempts to stop the backoff storm.';

  // Every 3-gram this question shares with the summary runs THROUGH "2650"
  // ("budget at 2650", "at 2650 attempts"), so it is safe iff the answer
  // literal is carved out first.
  const answerOnlyOverlap = 'Did we set the budget at 2650 attempts or fewer?';

  it('carves the answer literal out before comparing, so a question may contain its own answer', () => {
    const gate = leakageGate({ question: answerOnlyOverlap, summaryText, answerLiterals: ['2650'] });
    expect(gate.ok).toBe(true);
    expect(gate.shared).toEqual([]);
  });

  it('still rejects a question that paraphrases the summary outside the answer literal', () => {
    const gate = leakageGate({
      question: 'What did we do to stop the backoff storm, and at what number?',
      summaryText,
      answerLiterals: ['2650'],
    });
    expect(gate.ok).toBe(false);
    expect(gate.shared).toContain('stop the backoff');
  });

  it('without the carve-out the same safe question would be rejected — that is why it exists', () => {
    const gate = leakageGate({ question: answerOnlyOverlap, summaryText, answerLiterals: [] });
    expect(gate.ok).toBe(false);
    expect(gate.shared).toContain('budget at 2650');
  });

  it('builds boundary-anchored answer regexes, so a longer number is not a match', () => {
    const [re] = answerRegexesFor(['2650']) as string[];
    expect(new RegExp(re).test('we chose 2650 attempts')).toBe(true);
    expect(new RegExp(re).test('we chose 26500 attempts')).toBe(false);
  });
});

describe('budget derivation (D19)', () => {
  it('divides every fraction of W by the measured ratio', () => {
    const b = deriveBudgets(16_384, 0.850_896_663_206_653);
    // 0.20 * 16384 / 0.8508967 = 3850.98 -> floor
    expect(b.zoneB).toBe(3850);
    expect(b.zoneC).toBe(3850);
    expect(b.zoneA).toBe(1925);
    expect(b.lazy).toBe(6739);
    expect(b.reply).toBe(962);
    // K = 0.85 * W / ratio - reply
    expect(b.K).toBe(Math.floor((0.85 * 16_384) / 0.850_896_663_206_653) - 962);
  });

  it('scales linearly in W: doubling the window doubles every budget, up to one floor unit', () => {
    const small = deriveBudgets(16_384, 1);
    const large = deriveBudgets(32_768, 1);
    for (const key of ['zoneA', 'zoneB', 'zoneC', 'lazy', 'reply', 'slack'] as const) {
      // `floor` can round the doubled value up by one (0.20·16384 = 3276.8 -> 3276,
      // 0.20·32768 = 6553.6 -> 6553 = 2·3276 + 1). Anything wider than that is
      // not a rounding artefact, it is a broken derivation.
      expect(large[key] - small[key] * 2).toBeGreaterThanOrEqual(0);
      expect(large[key] - small[key] * 2).toBeLessThanOrEqual(1);
    }
  });

  it('at ratio 1 a budget is exactly its fraction of W — the identity case', () => {
    const b = deriveBudgets(100_000, 1);
    expect(b.zoneB).toBe(FRACTIONS.zoneB * 100_000);
    expect(b.lazy).toBe(FRACTIONS.lazy * 100_000);
  });

  it('re-floors slack above ratio 1.15 and pays for it out of Zone C, never Zone B', () => {
    const b = deriveBudgets(32_768, 1.2);
    expect(b.slackFraction).toBe(0.15);
    expect(b.zoneCFraction).toBeCloseTo(0.15, 10);
    // Zone B keeps its 0.20 share: shrinking it would drop branch summaries,
    // which is the very thing under test.
    expect(b.zoneB).toBe(Math.floor((0.2 * 32_768) / 1.2));
  });

  it('caps maxTokens at the design reply size but never above the window 5% share', () => {
    expect(deriveBudgets(16_384, 0.85).maxReplyTokens).toBe(800);
    expect(deriveBudgets(4_096, 0.85).maxReplyTokens).toBe(204);
  });

  it('refuses a non-positive window or ratio rather than emitting a nonsense budget', () => {
    expect(() => deriveBudgets(0, 1)).toThrow(/window must be > 0/);
    expect(() => deriveBudgets(16_384, 0)).toThrow(/ratio must be > 0/);
  });

  // The rule is "largest rung for which the ASSEMBLED Zone B satisfies gate 8"
  // — no share constant, no modelled arithmetic. The integration half (does the
  // real prompt fit) is what `--phase gates` exercises against the real store;
  // what is unit-testable, and tested here, is the ladder walk itself.
  it('picks the LARGEST rung whose supplied predicate passes, and stops there', () => {
    // Shaped like the measured store: keep=16 is the first rung at which a
    // branch survives at W=32,768, and rungs above it overflow Zone B.
    const passes = new Set([16, 12, 8, 6, 4, 2]);
    const walked: number[] = [];
    const fits = (keep: number) => {
      walked.push(keep);
      return { ok: passes.has(keep), rootBlockTokens: keep * 100, branchesSurviving: passes.has(keep) ? 2 : 0 };
    };

    const derived = deriveRootKeep(fits);
    expect(derived.rootKeep).toBe(16);
    expect(derived.rootKeepOk).toBe(true);
    // Short-circuits: rungs below the first pass are never assembled.
    expect(walked).toEqual([40, 16]);
    // Reportable detail comes off the rung that passed, not off a model.
    expect(derived.rootBlockTokens).toBe(1_600);
    expect(derived.branchesSurviving).toBe(2);
  });

  it('accepts a bare boolean predicate as well as a detail object', () => {
    const derived = deriveRootKeep((keep: number) => keep <= 8);
    expect(derived.rootKeep).toBe(8);
  });

  it('declares a window DEAD rather than forcing a fit when no rung passes', () => {
    // W=8,192 on the real store: even keep=2's root leaves no room for a
    // single branch summary, so the cell is genuinely dead.
    const derived = deriveRootKeep(() => ({ ok: false, rootBlockTokens: 2_587, branchesSurviving: 0, overBudget: ['B'] }));
    expect(derived.rootKeep).toBeNull();
    expect(derived.rootKeepOk).toBe(false);
    expect(derived.rootLadder).toHaveLength(ROOT_KEEP_LADDER.length);
    // The failing rung's numbers are still reported — a dead cell must say why.
    expect(derived.branchesSurviving).toBe(0);
    expect(derived.overBudget).toEqual(['B']);
  });

  it('hands the predicate the budgets it must fit inside, and stays pure without one', () => {
    const seen: number[] = [];
    const withPredicate = deriveBudgets(32_768, 0.850_896_663_206_653, {
      fitsRoot: (_keep: number, budgets: { zoneB: number }) => {
        seen.push(budgets.zoneB);
        return true;
      },
    });
    expect(withPredicate.rootKeep).toBe(40);
    // The predicate cannot decide "fits" without the budget it must fit in.
    expect(seen).toEqual([withPredicate.zoneB]);
    // No predicate: the arithmetic still stands alone and stays pure.
    expect(deriveBudgets(32_768, 0.850_896_663_206_653).rootKeep).toBeUndefined();
  });

  it('names the slack re-floor and the kill condition at the documented thresholds', () => {
    expect(ratioVerdict(1.0).action).toBe('slack-stays-0.10');
    expect(ratioVerdict(1.2).action).toBe('slack-refloored-to-0.15');
    expect(ratioVerdict(1.7).ok).toBe(false);
    expect(ratioVerdict(1.6).ok).toBe(true);
  });
});

describe('verdict-side arithmetic', () => {
  it('escalates on the LARGER of the binomial and pooled-σ forms, capped at 20', () => {
    const esc = escalationN(0.8, 0.6);
    expect(esc.binomial).toBe(binomialN(0.7, 0.2));
    expect(esc.required).toBe(Math.max(esc.binomial, esc.pooled));
    expect(esc.capped).toBeLessThanOrEqual(20);
  });

  it('asserts Zone B nesting as a contiguous, newest-aligned suffix', () => {
    // Rule-4 drops the OLDEST branches first, so a smaller window keeps the
    // NEWEST ones — the small list is a suffix of the large, never a prefix.
    expect(isContiguousSuffix(['b', 'c'], ['a', 'b', 'c'])).toBe(true);
    expect(isContiguousSuffix(['a', 'b'], ['a', 'b', 'c'])).toBe(false);
    // Same members, reordered — a D5 cache killer, so it must NOT pass.
    expect(isContiguousSuffix(['c', 'b'], ['a', 'b', 'c'])).toBe(false);
    // Non-contiguous: skipping a middle branch is not a drop-oldest result.
    expect(isContiguousSuffix(['a', 'c'], ['a', 'b', 'c'])).toBe(false);
    expect(isContiguousSuffix(['a', 'b', 'c'], ['b', 'c'])).toBe(false);
    expect(isContiguousSuffix([], ['a'])).toBe(true);
  });

  it('builds a per-turn context series with a per-turn median across reps', () => {
    const rows = [
      {
        model: 'm',
        window: 16_384,
        arm: 'tree',
        question: 'q1',
        stratum: 'head',
        rep: 1,
        turns: [
          { turn: 1, promptTokens: 100, input: 100, cacheRead: 0, cacheWrite: 0, output: 10 },
          { turn: 2, promptTokens: 300, input: 300, cacheRead: 0, cacheWrite: 0, output: 20 },
        ],
      },
      {
        model: 'm',
        window: 16_384,
        arm: 'tree',
        question: 'q1',
        stratum: 'head',
        rep: 2,
        turns: [{ turn: 1, promptTokens: 200, input: 200, cacheRead: 0, cacheWrite: 0, output: 30 }],
      },
    ];
    const [cell] = contextGrowthSeries(rows) as {
      arm: string;
      reps: unknown[];
      medianByTurn: { turn: number; n: number; promptTokens: number }[];
    }[];
    expect(cell.arm).toBe('tree');
    expect(cell.reps).toHaveLength(2);
    expect(cell.medianByTurn[0]).toMatchObject({ turn: 1, n: 2, promptTokens: 150 });
    // Turn 2 exists in one rep only — the median is over what ran, not over zeros.
    expect(cell.medianByTurn[1]).toMatchObject({ turn: 2, n: 1, promptTokens: 300 });
  });
});
