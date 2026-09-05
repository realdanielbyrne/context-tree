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
  ARM_IDS,
  TREE_ARMS,
  binomialN,
  ROOT_KEEP_LADDER,
  ladderFor,
  classifyRunError,
  selfRetrieval,
  capToolResult,
  compactionSummaryValid,
  coordinateSearchData,
  fitHitsToBudget,
  flatEventHits,
  questionTextValid,
  requestTokens,
  runOneReplicate,
  contextGrowthSeries,
  countOccurrences,
  deriveBudgets,
  deriveRootKeep,
  escalationN,
  exact,
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

  it('reserves the window reply share with NO absolute clamp, so a bigger window buys a longer answer', () => {
    // The reservation is arithmetic on W: it exists so a reply fits beside the
    // prompt, not to limit what the model may say. A clamp (this was 800) wins
    // at every window above ~16k and makes the derivation decorative — and on a
    // model that reasons before answering it is worse than decorative, because
    // the reasoning is billed as completion tokens and a small budget is spent
    // thinking, leaving an empty reply that a grader scores as a wrong answer.
    // So the only property to hold is proportionality to W.
    expect(deriveBudgets(16_384, 0.85).maxReplyTokens).toBe(Math.floor(0.05 * 16_384));
    expect(deriveBudgets(4_096, 0.85).maxReplyTokens).toBe(Math.floor(0.05 * 4_096));
    // Ten times the window, ten times the reply reservation. Under the old
    // clamp both of these were 800.
    expect(deriveBudgets(200_000, 0.85).maxReplyTokens).toBe(
      10 * deriveBudgets(20_000, 0.85).maxReplyTokens,
    );
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

describe('window cap on appended tool results', () => {
  const window = 16_384;
  const maxReplyTokens = 800;

  it('counts the native tool payload, which is not in the system text', () => {
    const base = { system: 'sys', messages: [{ role: 'user', content: 'hi' }] };
    const tools = [{ name: 'context_search', description: 'Search branch summaries by meaning. '.repeat(40) }];
    // The delta is exactly the serialized tool list — the part a count over
    // system+messages alone cannot see, and the part that made the 16k tree
    // arm overflow on turn 2.
    const delta = requestTokens({ ...base, tools }) - requestTokens({ ...base, tools: [] });
    expect(delta).toBe(exact.count(JSON.stringify(tools)));
    expect(delta).toBeGreaterThan(200);
  });

  // A prompt already sized to the window, then a search result on top — the
  // shape that produced "requested about 17209" on gpt-3.5.
  const loadedMessages = [{ role: 'user', content: 'x '.repeat(6_000) }];
  const capIt = (text: string) =>
    capToolResult({
      text,
      prefix: '[tool_result context_search] ',
      system: 'system contract',
      messages: loadedMessages,
      tools: [],
      window,
      maxReplyTokens,
    });

  it('truncates an oversized result to the real headroom and marks it visibly', () => {
    // Realistic search-result prose at ~3.4 chars/token: over the headroom in
    // tokens, but under the pre-cut threshold in chars, so it is counted exactly.
    const capped = capIt('search hit: node n_ABC path src/foo.ts line 42. '.repeat(1_000));
    expect(capped.truncated).toBeGreaterThan(0);
    expect(capped.beforeExact).toBe(true);
    expect(capped.after).toBeLessThanOrEqual(capped.headroom);
    // Core's elision marker: a model that lost detail can see that it did.
    expect(capped.text).toMatch(/…|\.\.\.|elided|truncated/i);
    // And the whole request now fits with the reply reserved.
    const total = requestTokens({
      system: 'system contract',
      messages: [...loadedMessages, { role: 'user', content: `[tool_result context_search] ${capped.text}` }],
      tools: [],
    });
    expect(total + maxReplyTokens).toBeLessThanOrEqual(window);
  });

  it('reports a lower bound, never a guess, when the payload was pre-cut unread', () => {
    const capped = capIt('payload '.repeat(20_000));
    expect(capped.beforeExact).toBe(false);
    // The token figure would be a fabrication, so it is null...
    expect(capped.truncated).toBeNull();
    // ...and the character figure, which is always exact, carries the report.
    expect(capped.droppedChars).toBeGreaterThan(80_000);
    expect(capped.after).toBeLessThanOrEqual(capped.headroom);
  });

  it('leaves a result that already fits completely untouched', () => {
    const capped = capToolResult({
      text: 'a short search result',
      prefix: '[tool_result context_search] ',
      system: 'sys',
      messages: [{ role: 'user', content: 'question' }],
      tools: [],
      window,
      maxReplyTokens,
    });
    expect(capped.truncated).toBe(0);
    expect(capped.text).toBe('a short search result');
  });

  it('drops the result entirely rather than overflowing when there is no headroom left', () => {
    const capped = capToolResult({
      text: 'anything',
      prefix: '[tool_result context_search] ',
      system: 'x '.repeat(20_000),
      messages: [],
      tools: [],
      window,
      maxReplyTokens,
    });
    expect(capped.headroom).toBeLessThanOrEqual(0);
    expect(capped.text).toBe('');
  });

  it('keeps the assembled request under W end-to-end, with a synthetic oversized handler', async () => {
    // Drives the REAL turn loop: a stub provider that issues one context_search,
    // and a stub handler returning a payload far larger than the window.
    const requests: { system: string; messages: { content: string }[]; tools?: unknown[] }[] = [];
    let turn = 0;
    const provider = {
      id: 'stub',
      async complete(request: { system: string; messages: { content: string }[]; tools?: unknown[]; model: string }) {
        requests.push(request);
        turn += 1;
        const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
        return turn === 1
          ? { text: '', model: request.model, usage, toolCalls: [{ id: 'c1', name: 'context_search', input: { query: 'q' } }], stopReason: 'tool_use' }
          : { text: 'final answer', model: request.model, usage, toolCalls: [], stopReason: 'end_turn' };
      },
    };
    const built = {
      system: 'system contract',
      messages: [{ role: 'user', content: 'zone b and c' }],
      tools: [{ name: 'context_search' }],
      handlers: { context_search: async () => ({ ok: true, data: { hits: 'H'.repeat(500_000) } }) },
      toolCtx: {},
    };
    const budgets = { window, maxReplyTokens };

    const question = 'What value did we settle on for that limit, and in which file?';
    const result = await runOneReplicate(null, built, question, 'stub-model', provider, budgets);

    expect(result.status).toBe('completed');
    expect(result.resultsTruncated).toBe(1);
    // 500 KB of a single repeated character: the pathological shape that made
    // cl100k counting take 84 s before the pre-cut guard. The char figure stays
    // exact; the token figure is a lower bound and is reported as one.
    expect(result.resultCharsTruncated).toBeGreaterThan(400_000);
    expect(result.resultTruncationEstimated).toBe(1);
    // The turn-2 request — the one that 400'd in the smoke — now fits.
    expect(requests).toHaveLength(2);
    expect(requestTokens(requests[1]) + maxReplyTokens).toBeLessThanOrEqual(window);
    expect(result.peakRequestTokens + maxReplyTokens).toBeLessThanOrEqual(window);
  });

  it('elastic tail: rebuilds the request every turn so appended results displace the oldest tail events and nothing is ever truncated', async () => {
    const W = 16_384;
    const reply = 800;
    const requests: { system: string; messages: { role: string; content: string }[]; tools?: unknown[] }[] = [];
    let turn = 0;
    const provider = {
      id: 'stub',
      async complete(request: { system: string; messages: { role: string; content: string }[]; tools?: unknown[]; model: string }) {
        requests.push(request);
        turn += 1;
        const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
        return turn <= 3
          ? { text: '', model: request.model, usage, toolCalls: [{ id: `c${turn}`, name: 'context_search', input: { query: `q${turn}` } }], stopReason: 'tool_use' }
          : { text: 'final answer', model: request.model, usage, toolCalls: [], stopReason: 'end_turn' };
      },
    };
    // Each result is ~28% of the window in EXACT tokens: three of them cannot
    // coexist with a full tail, so the tail must give way and no result may be cut.
    let payload = '';
    while (exact.count(payload) < W * 0.28) payload += 'search hit: node n_ABC path src/foo.ts line 42. ';
    const tailCalls: Array<{ budget: number; minFrom: number }> = [];
    const built = {
      system: 'system contract',
      messages: [{ role: 'user', content: 'zone a+b prefix' }],
      tools: [{ name: 'context_search' }],
      handlers: { context_search: async () => ({ ok: true, data: { hits: payload } }) },
      toolCtx: {},
      elastic: {
        header: '# recent events',
        // A stub tail that fills exactly the budget it is given, from a boundary
        // that only ever moves later (fewer events), never back.
        tail(budget: number, minFrom: number) {
          tailCalls.push({ budget, minFrom });
          const fromSeq = Math.max(minFrom, 1000 - Math.max(0, Math.floor(budget / 10)));
          const events = Math.max(0, 1000 - fromSeq);
          return { text: 'e '.repeat(events * 5), fromSeq, events };
        },
      },
    };
    const result = await runOneReplicate(null, built, 'what is the literal?', 'stub-model', provider, { window: W, maxReplyTokens: reply });

    expect(result.status).toBe('completed');
    expect(result.resultsTruncated).toBe(0);
    expect(requests).toHaveLength(4);
    for (const request of requests) {
      expect(requestTokens(request) + reply).toBeLessThanOrEqual(W);
      // Wire order: prefix, tail, question, then appended turns in arrival order.
      expect(request.messages[0]?.content).toBe('zone a+b prefix');
      expect(request.messages[1]?.content.startsWith('# recent events')).toBe(true);
      expect(request.messages[2]?.content).toBe('what is the literal?');
    }
    expect(requests[3]!.messages.slice(3).map((m) => m.role)).toEqual(['assistant', 'user', 'assistant', 'user', 'assistant', 'user']);
    const froms = result.turns.map((t: { tailFromSeq: number | null }) => t.tailFromSeq);
    expect(froms.every((f: number | null) => typeof f === 'number')).toBe(true);
    for (let i = 1; i < froms.length; i += 1) expect(froms[i]!).toBeGreaterThanOrEqual(froms[i - 1]!);
    expect(froms.at(-1)!).toBeGreaterThan(froms[0]!);
    expect(result.turns.filter((t: { tailMoved: boolean }) => t.tailMoved).length).toBeGreaterThan(0);
  });

});

describe('question text validity — the check that voided a batch', () => {
  // 12 questions came back as "" and every downstream check accepted them:
  // an empty string shares no 3-gram with any summary, so the leakage gate
  // passed it and printed [ok], and 180 scored runs then asked two models
  // nothing at all. Rule 8: a check that can pass on garbage is worse than
  // no check, so the same predicate now guards prep, gate 12, and dispatch.
  it('rejects exactly the shapes that sailed through: empty, blank, too short, too few words', () => {
    expect(questionTextValid('').ok).toBe(false);
    expect(questionTextValid('').reason).toBe('empty');
    expect(questionTextValid('   \n  ').ok).toBe(false);
    expect(questionTextValid('What was it?').ok).toBe(false); // 12 chars
    expect(questionTextValid('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa').ok).toBe(false); // long, 1 word
    expect(questionTextValid(undefined).ok).toBe(false);
    expect(questionTextValid(null).ok).toBe(false);
  });

  it('accepts a real paraphrased question', () => {
    const q = 'What limit did we agree on for the retry behaviour discussed early in that session?';
    expect(questionTextValid(q).ok).toBe(true);
    expect(questionTextValid(q).reason).toBeNull();
  });

  it('shows why the leakage gate alone could not catch it', () => {
    // The gate is not wrong — it is vacuous on an empty input, which is
    // precisely why the input must be checked before the gate's verdict counts.
    const gate = leakageGate({ question: '', summaryText: 'anything at all here', answerLiterals: [] });
    expect(gate.ok).toBe(true);
    expect(questionTextValid('').ok).toBe(false);
  });

  it('refuses to dispatch a run whose question is unusable', async () => {
    const provider = { id: 'never-called', async complete() { throw new Error('the model must not be called'); } };
    const built = { system: 's', messages: [{ role: 'user', content: 'ctx' }], tools: [], toolCtx: {} };
    await expect(
      runOneReplicate(null, built, '', 'm', provider, { window: 16_384, maxReplyTokens: 800 }),
    ).rejects.toThrow(/unusable question \(empty\)/);
  });
});

describe('R6 ablation — tree vs tree-wide', () => {
  // One variable, Zone B composition. `tree` walks the keep ladder
  // largest-first (most root headlines); `tree-wide` smallest-first (most
  // visible branch summaries). Everything else — window, K, zone budgets,
  // reply cap, store, questions, epoch — is identical.
  it('walks the ladder from opposite ends, over the same rungs', () => {
    expect(ladderFor('tree')).toEqual(ROOT_KEEP_LADDER);
    expect(ladderFor('tree-wide')).toEqual([...ROOT_KEEP_LADDER].reverse());
    expect([...ladderFor('tree-wide')].sort((a: number, b: number) => a - b)).toEqual(
      [...ROOT_KEEP_LADDER].sort((a: number, b: number) => a - b),
    );
  });

  it('tree-static shares tree\'s ladder, and an unknown arm falls back to it', () => {
    expect(ladderFor('tree-static')).toEqual(ROOT_KEEP_LADDER);
    expect(ladderFor('truncate-tail')).toEqual(ROOT_KEEP_LADDER);
  });

  it('picks opposite rungs when several pass — the whole point of the ablation', () => {
    // Shaped like W=32768 on the real store: keep16 and everything below it fit.
    const passes = new Set([16, 12, 8, 6, 4, 2]);
    const fits = (keep: number) => ({ ok: passes.has(keep), branchesSurviving: passes.has(keep) ? 40 / keep : 0 });
    expect(deriveRootKeep(fits, ladderFor('tree')).rootKeep).toBe(16);
    expect(deriveRootKeep(fits, ladderFor('tree-wide')).rootKeep).toBe(2);
  });

  it('collapses to the SAME keep when only one rung passes — a real no-op, not a bug', () => {
    // W=16384 on the real store: only keep2 leaves room for a branch, so both
    // arms derive keep2 and the ablation cannot say anything at that window.
    const fits = (keep: number) => ({ ok: keep === 2, branchesSurviving: keep === 2 ? 1 : 0 });
    expect(deriveRootKeep(fits, ladderFor('tree')).rootKeep).toBe(2);
    expect(deriveRootKeep(fits, ladderFor('tree-wide')).rootKeep).toBe(2);
  });

  it('keeps every tree-shaped arm in the pin set, and no baseline in it', () => {
    expect(TREE_ARMS).toContain('tree');
    expect(TREE_ARMS).toContain('tree-wide');
    expect(TREE_ARMS).toContain('tree-center-filename');
    expect(TREE_ARMS).toContain('tree-search-coordinates');
    expect(TREE_ARMS).not.toContain('truncate-tail');
    expect(TREE_ARMS).not.toContain('compact-rolling');
    expect(ARM_IDS).toContain('tree-wide');
    expect(ARM_IDS).toContain('tree-center-filename');
    expect(ARM_IDS).toContain('tree-search-coordinates');
    expect(ladderFor('tree-center-filename')).toEqual(ladderFor('tree-tail-v2'));
    expect(ladderFor('tree-search-coordinates')).toEqual(ladderFor('tree-center-filename'));
  });
});

describe('DS-STAR all-rank search-coordinate projection', () => {
  it('preserves every hit order and score while removing rich duplicate views', () => {
    const data = {
      query: 'needle', path: 'beam', fallback: null, provenance: [], unavailable: [],
      hits: [
        { node_id: 'n2', kind: 'phase', title: 'second', phase_type: 'diagnosis', path: null, summary_version: 4, score: 2, meta: { files: [{ path: '/large' }] } },
        { node_id: 'n1', kind: 'file', title: 'first', phase_type: null, path: '/a.ts', summary_version: 7, score: 1, meta: { symbols: ['huge'] } },
      ],
      candidates: [{ node_id: 'n2', score: 2, provider: 'tree', tier: 'fuzzy', snippet: 'duplicate prose' }],
    };
    const projected = coordinateSearchData(data);
    expect(projected.hits).toEqual([
      { node_id: 'n2', kind: 'phase', title: 'second', phase_type: 'diagnosis', path: null, score: 2 },
      { node_id: 'n1', kind: 'file', title: 'first', phase_type: null, path: '/a.ts', score: 1 },
    ]);
    expect(projected.candidates).toEqual([]);
    expect(projected.query).toBe('needle');
    expect(projected.path).toBe('beam');
    expect(data.hits[0].meta.files[0].path).toBe('/large');
  });

  it('handles an empty upstream result without inventing rows', () => {
    expect(coordinateSearchData({ hits: [], candidates: [], query: 'none' })).toEqual({
      hits: [], candidates: [], query: 'none',
    });
  });
});

describe('question self-retrieval (g15)', () => {
  // g11 proves the ANSWER is a unique string in L0; g15 proves the QUESTION
  // has a unique referent in the world the model searches. Batch 2 scored ~0
  // because only the first was checked: "how many characters were omitted when
  // it was truncated?" has a string-unique answer and hundreds of referents.
  // `selfRetrieval` takes its search function as an option, defaulting to the
  // real `context_search` handler — so the ranking logic is unit-testable
  // while the gate still exercises the exact beam the tree arm calls.
  const fakeSearch = (nodeIds: string[]) => async () => ({ ok: true, data: { candidates: nodeIds.map((id) => ({ node_id: id })) } });

  it('accepts a question whose source ranks inside the top K, root excluded', async () => {
    const question = { question: 'a specific anchored question about the loader', node_id: 'p2' };
    const result = await selfRetrieval(question, {}, { topK: 3, rootId: 'root', search: fakeSearch(['root', 'p1', 'p2', 'p3']) });
    // Root is filtered out first, so p2 is rank 2, not rank 3.
    expect(result.ok).toBe(true);
    expect(result.rank).toBe(2);
  });

  it('rejects a question whose source ranks below the cut — the batch-2 shape', async () => {
    const question = { question: 'how many characters were omitted when it was truncated?', node_id: 'p9' };
    const ranked = ['root', 'p1', 'p2', 'p3', 'p4', 'p9'];
    const result = await selfRetrieval(question, {}, { topK: 3, rootId: 'root', search: fakeSearch(ranked) });
    expect(result.ok).toBe(false);
    expect(result.rank).toBe(5);
    expect(result.reason).toMatch(/outside top 3/);
  });

  it('rejects a question whose source never appears at all', async () => {
    const result = await selfRetrieval({ question: 'unanchored question text here', node_id: 'p9' }, {}, { topK: 3, rootId: 'root', search: fakeSearch(['root', 'p1']) });
    expect(result.ok).toBe(false);
    expect(result.rank).toBeNull();
    expect(result.reason).toMatch(/absent from/);
  });

  it('accepts a spanning question when EITHER source branch ranks', async () => {
    const question = { question: 'a two-branch question', node_id: 'pA', node_ids: ['pA', 'pB'] };
    const result = await selfRetrieval(question, {}, { topK: 3, rootId: 'root', search: fakeSearch(['root', 'pB', 'pZ']) });
    expect(result.ok).toBe(true);
    expect(result.rank).toBe(1);
  });

  it('excluding the task root is load-bearing: it ranks first for every query', async () => {
    const question = { question: 'a specific anchored question', node_id: 'p3' };
    const withRootExcluded = await selfRetrieval(question, {}, { topK: 3, rootId: 'root', search: fakeSearch(['root', 'p1', 'p2', 'p3']) });
    const withRootCounted = await selfRetrieval(question, {}, { topK: 3, rootId: null, search: fakeSearch(['root', 'p1', 'p2', 'p3']) });
    expect(withRootExcluded.ok).toBe(true); // rank 3
    expect(withRootCounted.ok).toBe(false); // rank 4 — the root ate a slot
  });
});

describe('one literal, one question', () => {
  it('never draws the same literal into two strata', () => {
    // `deep` is a SUBSET of `head` (a head fact absent from every summary), so
    // without an explicit carry-over the two strata cut the same literals —
    // observed: all three deep questions duplicated all three head questions.
    const pool = [
      { literal: 'alpha_one', node_id: 'p1' },
      { literal: 'beta_two', node_id: 'p2' },
      { literal: 'gamma_three', node_id: 'p3' },
    ];
    const claimed = new Set<string>();
    const head = pickDeterministic(pool, 2, { exclude: claimed });
    for (const item of head) claimed.add(item.literal);
    const deep = pickDeterministic(pool, 2, { exclude: claimed });
    const overlap = deep.filter((d: { literal: string }) => head.some((h: { literal: string }) => h.literal === d.literal));
    expect(overlap).toEqual([]);
    expect(deep).toHaveLength(1); // only one candidate was left unclaimed
  });
});

describe('run-error classification', () => {
  it('names the OpenRouter no-choices bug rather than logging a bare message', () => {
    const kind = classifyRunError(new Error("Cannot read properties of undefined (reading '0')"));
    expect(kind.status).toBe('provider_bad_response');
    expect(kind.retryable).toBe(true);
    expect(kind.hint).toMatch(/openrouter\.ts:153/);
    expect(kind.hint).toMatch(/response\.choices\?\.\[0\]/);
  });

  it('leaves other failures classified but not retried', () => {
    expect(classifyRunError(new Error('boom')).status).toBe('error');
    expect(classifyRunError(new Error('boom')).retryable).toBe(false);
  });
});

describe('compaction summary validity', () => {
  const document = 'The session began with '.padEnd(700, 'x');

  it('rejects the 169-char conversational fragment that stood in for a 196k-token session', () => {
    expect(
      compactionSummaryValid(
        'The fixable structure is clear, but the work is post-MVP scope. Shall I open an issue for hierarchical Zone B collapse, or would you rather measure it first in a loop-7?',
      ),
    ).toBe(false);
  });

  it('rejects a document-length reply that still ends by asking the user something', () => {
    expect(compactionSummaryValid(`${document}Shall I continue?`)).toBe(false);
  });

  it('accepts a real rolling summary', () => {
    expect(compactionSummaryValid(document)).toBe(true);
  });

  it('rejects the placeholder a fully-skipped build leaves behind', () => {
    // Skipping keeps a build alive; it must not become a way to freeze an
    // artifact that summarises nothing.
    expect(compactionSummaryValid('(no earlier summary)')).toBe(false);
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


describe('elastic tail — last valve', () => {
  it('once the tail is exhausted, the oldest already-seen appended result is evicted so the request still fits; a result appended since the last send never is', async () => {
    // Added after the replay gate (elastic-tail-killgate.mjs EG1) found two
    // requests over the window with an empty tail: the model's own reply text,
    // appended after the cap, tipped the next request. The assembler rule applies.
    const W = 16_384;
    const reply = 800;
    const requests: { messages: { role: string; content: string }[] }[] = [];
    let turn = 0;
    const provider = {
      id: 'stub',
      async complete(request: { messages: { role: string; content: string }[]; model: string }) {
        requests.push(request);
        turn += 1;
        const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
        return turn <= 3
          ? { text: 'thinking '.repeat(60), model: request.model, usage, toolCalls: [{ id: `c${turn}`, name: 'context_search', input: { query: `q${turn}` } }], stopReason: 'tool_use' }
          : { text: 'final answer', model: request.model, usage, toolCalls: [], stopReason: 'end_turn' };
      },
    };
    let payload = '';
    while (exact.count(payload) < W * 0.31) payload += 'search hit: node n_ABC path src/foo.ts line 42. ';
    const built = {
      system: 'system contract',
      messages: [{ role: 'user', content: 'zone a+b prefix' }],
      tools: [{ name: 'context_search' }],
      handlers: { context_search: async () => ({ ok: true, data: { hits: payload } }) },
      toolCtx: {},
      elastic: { header: '# recent events', tail: () => ({ text: '', fromSeq: 1, events: 0 }) }, // nothing left to give
    };
    const result = await runOneReplicate(null, built, 'what is the literal?', 'stub-model', provider, { window: W, maxReplyTokens: reply });

    expect(result.status).toBe('completed');
    for (const request of requests) expect(requestTokens({ system: 'system contract', messages: request.messages, tools: built.tools }) + reply).toBeLessThanOrEqual(W);
    const evicted = result.turns.map((t: { evictedResults: number }) => t.evictedResults);
    expect(evicted.reduce((a: number, b: number) => a + b, 0)).toBeGreaterThan(0);
    // The newest result is always intact in the request that follows it.
    const last = requests[3]!.messages;
    expect(last.at(-1)!.content.includes('evicted to fit the window')).toBe(false);
    expect(last.some((m) => m.content.includes('evicted to fit the window'))).toBe(true);
  });
});

describe('null arms — flat event hits and budget-filled retrieval', () => {
  it('flatEventHits scores every event of the whole trace with the fetch-centring scorer and attributes each hit to the smallest phase holding it', () => {
    const phases: Record<string, [number, number]> = { root: [1, 9], p1: [1, 4], p2: [5, 9] };
    const ctx = {
      handle: {
        store: {
          root: () => ({ id: 'root', kind: 'task', title: 'task', span_start_seq: 1, span_end_seq: 9 }),
          nodesInCreationOrder: () => Object.entries(phases).map(([id, [a, b]]) => ({ id, kind: id === 'root' ? 'task' : 'phase', title: id, phase_type: 'implementation', span_start_seq: a, span_end_seq: b })),
        },
        trace: { read: ({ from }: { from: number }) => [{ seq: from, type: 'user_message', blob: `b${from}` }] },
        blobs: { getText: (ref: string) => `event ${ref} mentions needle` },
      },
      retriever: {
        findRelevantCenter(_q: string, [span]: Array<{ start: number; end: number }>) {
          expect(span).toEqual({ start: 1, end: 9 }); // the WHOLE trace, no branch pool
          return { centerSeq: 7, terms: [{ value: 'needle' }], scores: [{ seq: 7, score: 3 }, { seq: 2, score: 2 }, { seq: 8, score: 1 }] };
        },
      },
    };
    const hits = flatEventHits(ctx as never, 'needle', 2, 200);
    expect(hits.map((h) => h.seq)).toEqual([7, 2]);
    expect(hits.map((h) => h.node_id)).toEqual(['p2', 'p1']);
    expect(hits.every((h) => typeof h.excerpt === 'string' && h.excerpt.includes('needle'))).toBe(true);
  });

  it('fitHitsToBudget keeps hits in rank order until the serialized result would exceed the budget, and reports how many it kept', () => {
    const hits = Array.from({ length: 10 }, (_, i) => ({ node_id: `n${i}`, seq: i, excerpt: 'word '.repeat(50) }));
    const budget = exact.count(JSON.stringify(hits.slice(0, 3))) + 5;
    const kept = fitHitsToBudget(hits, budget);
    expect(kept.length).toBe(3);
    expect(kept.map((h) => h.seq)).toEqual([0, 1, 2]);
    expect(fitHitsToBudget(hits, 0)).toEqual([]);
  });
});
