import { describe, expect, it } from 'vitest';
import { buildTopicIndex, detectAttentionSignals, isRederivable, renderTopicIndex, selectAttention, selectPayload } from '../src/attention/index.js';
import type { AttentionInput, AttentionUnit, PayloadSelectionInput } from '../src/attention/index.js';
import { excerptAround } from '../src/retrieve/excerpt.js';

const unit = (id: string, seq: number, overrides: Partial<AttentionUnit> = {}): AttentionUnit => ({
  id, seq, tokens: 10, state: 'resident', fingerprints: [], ...overrides,
});
const run = (units: AttentionUnit[], overrides: Partial<AttentionInput> = {}) => selectAttention({
  units, asOfSeq: 20, turn: 4, queryFingerprints: [], ...overrides,
});
const irrelevant = { value: 'irrelevant' as const, turn: 4, sourceSeq: 18, reason: 'operator explicitly excluded this phase for this turn' };

describe('opt-in L0 attention policy', () => {
  it('retains unknown history regardless of zero overlap, length or request budget', () => {
    const units = [unit('api', 1, { tokens: 1_000_000, relevanceScore: 0 }), unit('ui', 2)];
    expect(run(units, { policy: { excludeIrrelevant: true }, demand: { kind: 'explicit', budgetTokens: 0 } }).selectedIds).toEqual(['api', 'ui']);
  });

  it('H1 excludes only current-turn explicit evidence and is off by default', () => {
    const units = [unit('unrelated', 1, { relevance: irrelevant }), unit('old-label', 2, { relevance: { ...irrelevant, turn: 3 } })];
    expect(run(units).selectedIds).toEqual(['unrelated', 'old-label']);
    const selected = run(units, { policy: { excludeIrrelevant: true } });
    expect(selected.selectedIds).toEqual(['old-label']);
    expect(selected.mechanism.excludedTokens).toBe(10);
    expect(selected.audit[0]?.evidenceSeq).toBe(18);
  });

  it('restores an earlier API unit when the later tests identify it', () => {
    const api = unit('api', 1, { fingerprints: ['api.encode'], relevance: irrelevant });
    const ui = run([api], { queryFingerprints: ['ui.render'], policy: { excludeIrrelevant: true } });
    const tests = run([api], { queryFingerprints: ['api.encode'], policy: { excludeIrrelevant: true } });
    expect(ui.selectedIds).toEqual([]);
    expect(tests.selectedIds).toEqual(['api']);
    expect(tests.mechanism.recurrenceRestorations).toBe(1);
  });

  it('H3 pins the plan independently; task and steering are always protected', () => {
    const units = ['task', 'plan', 'steering'].map((role, index) => unit(role, index + 1, { role: role as AttentionUnit['role'], relevance: irrelevant }));
    expect(run(units, { policy: { excludeIrrelevant: true } }).selectedIds).toEqual(['task', 'steering']);
    expect(run(units, { policy: { excludeIrrelevant: true, pinPlan: true } }).selectedIds).toEqual(['task', 'plan', 'steering']);
  });

  it('H6 uses exchange or subtask boundaries and retains when boundaries are unknown', () => {
    const units = [unit('old', 1, { exchangeId: 'old', relevance: irrelevant }), unit('step-start', 10, { exchangeId: 'prior', relevance: irrelevant }), unit('latest', 15, { exchangeId: 'latest', relevance: irrelevant })];
    const options = { currentExchangeId: 'latest', subtaskStartSeq: 10 };
    expect(run(units, { ...options, policy: { excludeIrrelevant: true, recency: 'exchange' } }).selectedIds).toEqual(['latest']);
    expect(run(units, { ...options, policy: { excludeIrrelevant: true, recency: 'subtask' } }).selectedIds).toEqual(['step-start', 'latest']);
    expect(run(units, { policy: { excludeIrrelevant: true, recency: 'subtask' } }).selectedIds).toEqual(['old', 'step-start', 'latest']);
  });

  it('requires calibration artifacts instead of providing fitted defaults', () => {
    expect(() => run([], { policy: { priority: { boost: 1, halfLifeTurns: 2, calibrationId: '' } } })).toThrow(/calibration/);
    expect(() => run([], { policy: { breadth: { relevanceMass: 0, calibrationId: 'fixture' } } })).toThrow(/relevanceMass/);
  });

  it('isolates priority admission while preserving creation order and excluding future references', () => {
    const units = [unit('older', 1, { state: 'candidate', relevanceScore: 1 }), unit('newer', 2, { state: 'candidate', relevanceScore: 2 })];
    const common: Partial<AttentionInput> = { demand: { kind: 'explicit', budgetTokens: 10 }, references: [{ unitId: 'older', seq: 10, turn: 3, kind: 'fetch' }, { unitId: 'newer', seq: 21, turn: 5, kind: 'fetch' }] };
    expect(run(units, common).selectedIds).toEqual(['newer']);
    const result = run(units, { ...common, policy: { priority: { boost: 1, halfLifeTurns: 1, calibrationId: 'test-calibration' } } });
    expect(result.selectedIds).toEqual(['older']);
    expect(result.mechanism.priorityChangedOrder).toBe(true);
    expect(result.audit[1]?.priority).toBe(0);
    expect(run(units, { ...common, demand: { kind: 'explicit', budgetTokens: 20 } }).selectedIds).toEqual(['older', 'newer']);
  });

  it('supersession zeros priority without declaring unknown content irrelevant', () => {
    const result = run([unit('api', 1)], { references: [{ unitId: 'api', seq: 10, turn: 2, kind: 'fetch' }, { unitId: 'api', seq: 11, turn: 3, kind: 'supersede' }], policy: { priority: { boost: 3, halfLifeTurns: 1, calibrationId: 'test' } } });
    expect(result.audit[0]?.priority).toBe(0);
    expect(result.selectedIds).toEqual(['api']);
  });

  it('H2 changes breadth at the same envelope; H5 changes explicit demand only', () => {
    const units = [unit('a', 1, { state: 'candidate', relevanceScore: 4 }), unit('b', 2, { state: 'candidate', relevanceScore: 1 })];
    const demand = { kind: 'explicit' as const, budgetTokens: 10, expandedBudgetTokens: 20 };
    const breadth = { relevanceMass: 1, calibrationId: 'test' };
    expect(run(units, { demand, policy: { breadth } }).selectedIds).toEqual(['a']);
    const expanded = run(units, { demand, policy: { breadth, demandExpansion: true } });
    expect(expanded.selectedIds).toEqual(['a', 'b']);
    expect(expanded.mechanism.demandExtraTokens).toBe(10);
    expect(run(units, { demand: { ...demand, kind: 'exploratory' }, policy: { breadth, demandExpansion: true } }).selectedIds).toEqual(['a']);
    const narrow = run(units, { demand: { ...demand, budgetTokens: 20 }, policy: { breadth: { relevanceMass: 0.8, calibrationId: 'test' } } });
    expect(narrow.selectedIds).toEqual(['a']);
    expect(narrow.mechanism.massDeferredUnits).toBe(1);
  });

  it('H4 gates exploration, preserves explicit demand, and topic shifts reopen it', () => {
    const units = [unit('history', 1), unit('retrieved', 2, { state: 'candidate' })];
    const signals = detectAttentionSignals('Should I implement the plan?', 18);
    expect(signals.map((s) => s.kind)).toEqual(['research_done']);
    expect(run(units, { signals, demand: { kind: 'exploratory', budgetTokens: 10 } }).selectedIds).toEqual(['history', 'retrieved']);
    const gated = run(units, { signals, policy: { sufficiencyGate: true }, demand: { kind: 'exploratory', budgetTokens: 10 } });
    expect(gated.selectedIds).toEqual(['history']);
    expect(gated.mechanism.sufficiencyDeferredUnits).toBe(1);
    expect(run(units, { signals, policy: { sufficiencyGate: true }, demand: { kind: 'explicit', budgetTokens: 10 } }).selectedIds).toEqual(['history', 'retrieved']);
    const shifted = detectAttentionSignals('I have enough information. Now let\'s look at the API.', 18);
    expect(run(units, { signals: shifted, policy: { sufficiencyGate: true }, demand: { kind: 'exploratory', budgetTokens: 10 } }).selectedIds).toEqual(['history', 'retrieved']);
  });

  it('rejects future units or relevance evidence instead of leaking later L0', () => {
    expect(() => run([unit('future', 21)])).toThrow(/L0 prefix/);
    expect(() => run([unit('future-evidence', 1, { relevance: { ...irrelevant, sourceSeq: 21 } })])).toThrow(/L0 prefix/);
  });

  it('runs an API → UI → tests recurrence instrument with protected task, plan and steering', () => {
    const pins = [unit('task', 1, { role: 'task' }), unit('plan', 2, { role: 'plan' }), unit('steering', 3, { role: 'steering' })];
    const api = unit('api-signature', 4, { phaseId: 'api', exchangeId: 'api-exchange', tokens: 20, fingerprints: ['api.encode'], relevanceScore: 1 });
    const source = JSON.stringify({ pins, api });
    const shared = { excludeIrrelevant: true, pinPlan: true };
    const apiPhase = run([...pins, api], { asOfSeq: 5, turn: 1, activePhaseId: 'api', queryFingerprints: ['api.encode'], policy: shared });
    expect(apiPhase.selectedIds).toEqual(['task', 'plan', 'steering', 'api-signature']);

    const ui = unit('ui-result', 8, { phaseId: 'ui', exchangeId: 'ui-exchange' });
    const dormantApi = { ...api, relevance: { value: 'irrelevant' as const, turn: 2, sourceSeq: 9, reason: 'explicit instrument relevance label: API signature is unused in the independent UI phase' } };
    const uiPhase = run([...pins, dormantApi, ui], { asOfSeq: 9, turn: 2, activePhaseId: 'ui', queryFingerprints: ['ui.render'], currentExchangeId: 'ui-exchange', policy: { ...shared, recency: 'exchange' } });
    expect(uiPhase.selectedIds).toEqual(['task', 'plan', 'steering', 'ui-result']);
    expect(uiPhase.mechanism.excludedTokens).toBe(20);
    expect(uiPhase.audit.find((row) => row.id === 'api-signature')?.evidenceSeq).toBe(9);

    const testRequest = unit('test-request', 14, { exchangeId: 'test-exchange' });
    const irrelevantUi = { ...ui, relevance: { value: 'irrelevant' as const, turn: 3, sourceSeq: 12, reason: 'explicit instrument relevance label: the API tests do not inspect UI output' } };
    const testUnits: AttentionUnit[] = [...pins, { ...dormantApi, state: 'candidate' }, irrelevantUi, testRequest];
    const testInputs: Partial<AttentionInput> = {
      asOfSeq: 14, turn: 3, queryFingerprints: ['api.encode'], currentExchangeId: 'test-exchange',
      signals: detectAttentionSignals('I have enough information. Now let\'s look at API tests.', 13),
      references: [{ unitId: api.id, seq: 5, turn: 1, kind: 'reference' }],
      demand: { kind: 'explicit', budgetTokens: 10, expandedBudgetTokens: 20 },
      policy: { ...shared, recency: 'exchange', breadth: { relevanceMass: 1, calibrationId: 'synthetic-gate-only' }, priority: { boost: 1, halfLifeTurns: 1, calibrationId: 'synthetic-gate-only' }, sufficiencyGate: true, topicShiftReset: true },
    };
    const tooNarrow = run(testUnits, testInputs);
    expect(tooNarrow.selectedIds).not.toContain('api-signature');
    const tests = run(testUnits, { ...testInputs, policy: { ...testInputs.policy, demandExpansion: true } });
    expect(tests.selectedIds).toEqual(['task', 'plan', 'steering', 'api-signature', 'test-request']);
    expect(tests.mechanism.demandExtraTokens).toBe(10);
    expect(tests.mechanism.topicShiftReset).toBe(true);
    expect(tests.audit.find((row) => row.id === 'api-signature')?.priority).toBe(0);
    // Each artifact is independently necessary to this synthetic gate; it is
    // an instrument assertion, not a live success or portability claim.
    const required = ['task', 'plan', 'steering', 'api-signature'];
    const gate = (ids: string[]) => required.every((id) => ids.includes(id));
    expect(gate(tests.selectedIds)).toBe(true);
    for (const omitted of required) expect(gate(tests.selectedIds.filter((id) => id !== omitted))).toBe(false);
    expect(JSON.stringify({ pins, api })).toBe(source);
  });
});

describe('assistant signal observations', () => {
  it.each([
    'I do not think I have enough information to implement this.',
    '"I have enough information to implement this."',
    '> I have enough information to implement this.',
    '`I have enough information to implement this.`',
    '```text\nI have enough information to implement this.\n```',
    "'I have enough information to implement this.'",
    'If I have enough information to implement this, I will.',
    'I am not ready to implement.',
    'I have enough information, but still need to inspect another file.',
  ])('does not treat negated, conditional or quoted words as intent: %s', (text) => {
    expect(detectAttentionSignals(text, 2)).toEqual([]);
  });

  it('records exact source offsets for an unquoted own statement', () => {
    const text = 'The tests pass. I have enough context to implement the fix.';
    const signal = detectAttentionSignals(text, 3)[0];
    expect(signal?.kind).toBe('sufficiency');
    expect(text.slice(signal?.start, signal?.end)).toBe(signal?.phrase);
  });
});

const chars = { count: (text: string) => text.length };
const payload = (text: string, overrides: Partial<PayloadSelectionInput> = {}) => selectPayload({
  original: { text, blobId: 'l2-original' }, mode: 'whole', availableTokens: 100, tokenizer: chars, ...overrides,
});

describe('payload selection hypotheses', () => {
  it('compares the same producer response without promoting whole preservation', () => {
    const original = 'prefix '.repeat(20) + 'NEEDLE' + ' suffix'.repeat(20);
    const whole = payload(original, { availableTokens: 30 });
    const excerpt = payload(original, { mode: 'excerpt', availableTokens: 30, excerpt: { chars: 100, terms: ['NEEDLE'], anchor: 'first' } });
    expect(whole.status).toBe('overflow');
    expect(whole.text).toBeNull();
    expect(excerpt.status).toBe('ready');
    expect(excerpt.text).toContain('NEEDLE');
    expect(excerpt.tokens).toBeLessThanOrEqual(30);
    expect(excerpt.sourceBlobId).toBe(whole.sourceBlobId);
    expect(excerpt).not.toHaveProperty('delivered');
  });

  it('requires original L2 preservation and discloses producer truncation separately', () => {
    expect(() => payload('abc', { original: { text: 'abc', blobId: '' } })).toThrow(/L2/);
    const selected = payload('abc', { original: { text: 'abc', blobId: 'original', producerTruncated: true } });
    expect(selected.producerStatus).toBe('producer_truncated');
    expect(selected.status).toBe('ready');
  });

  it('requires supported complete structural coverage; unknown sections survive', () => {
    const original = 'keepDROPunknown';
    const structure = { parser: 'test-parser', sections: [{ start: 0, end: 4, relevance: 'relevant' as const }, { start: 4, end: 8, relevance: 'irrelevant' as const, reason: 'explicitly unrelated result section' }, { start: 8, end: 15, relevance: 'unknown' as const }] };
    const selected = payload(original, { mode: 'structural', structure });
    expect(selected.text).toBe('keepunknown');
    expect(selected.omittedChars).toBe(4);
    expect(payload(original, { mode: 'structural' }).status).toBe('unsupported_structure');
    expect(payload(original, { mode: 'structural', structure: { ...structure, sections: structure.sections.slice(1) } }).status).toBe('unsupported_structure');
    expect(payload(original, { mode: 'structural', availableTokens: 3, structure }).status).toBe('overflow');
  });

  it('retains structurally unrelated labels without evidence and yields a stable selection ID', () => {
    const config: Partial<PayloadSelectionInput> = { mode: 'structural', structure: { parser: 'test', sections: [{ start: 0, end: 3, relevance: 'irrelevant' }] } };
    expect(payload('abc', config).text).toBe('abc');
    expect(payload('abc', config).selectionId).toBe(payload('abc', config).selectionId);
  });

  it('tests rarest anchoring as a separate same-size candidate', () => {
    const text = 'common '.repeat(40) + 'RARE answer-literal' + ' common'.repeat(40);
    expect(excerptAround(text, ['common', 'RARE'], 40)).not.toContain('RARE');
    expect(excerptAround(text, ['common', 'RARE'], 40, 'rarest')).toContain('answer-literal');
    const selected = payload(text, { mode: 'excerpt', excerpt: { chars: 40, terms: ['common', 'RARE'], anchor: 'rarest' } });
    expect(selected.text).toContain('answer-literal');
    expect(selected.configuration.excerpt?.anchor).toBe('rarest');
  });

  it('does not turn a narrow Unicode excerpt into a broken surrogate', () => {
    const result = payload('😀😀NEEDLE😀😀', { mode: 'excerpt', availableTokens: 12, excerpt: { chars: 12, terms: ['NEEDLE'], anchor: 'first' } });
    expect(result.status).toBe('ready');
    const codePoints = [...result.text ?? ''].map((char) => char.codePointAt(0) ?? 0);
    expect(codePoints.some((point) => point >= 0xd800 && point <= 0xdfff)).toBe(false);
    expect(result.text).toContain('NEEDLE');
  });
});

describe('dependency-tracking eviction (re-derivability)', () => {
  it('classifies durable-view tools as re-derivable and transient observations as not', () => {
    // Recoverable by a re-read of the filesystem or the append-only trace.
    for (const tool of ['read_file', 'write_file', 'edit_file', 'context_fetch', 'context_search', 'context_peek']) {
      expect(isRederivable(tool)).toBe(true);
    }
    // run_command observes transient state: exit codes, test results, the tree
    // at one instant. ABS's `git stash` A/B established which failures
    // pre-existed and was referenced 10 and 11 turns later; nothing on disk
    // could have reconstructed it.
    expect(isRederivable('run_command')).toBe(false);
    // Unknown degrades to undefined -> treated as NOT re-derivable. Never a
    // crash, and never a drop.
    expect(isRederivable('some_future_tool')).toBeUndefined();
    expect(isRederivable(undefined)).toBeUndefined();
    expect(isRederivable('  ')).toBeUndefined();
  });

  const cand = (over: Partial<AttentionUnit> = {}): AttentionUnit => ({
    id: over.id ?? 'u1', seq: over.seq ?? 1, tokens: over.tokens ?? 100,
    state: over.state ?? 'candidate', fingerprints: over.fingerprints ?? [], ...over,
  });

  it('evicts a re-derivable unit only when the cadence gate is open', () => {
    const units = [cand({ id: 'read', rederivable: true, tokens: 5000 })];
    const policy = { evictRederivable: { minCadenceTurns: 12 } };
    // Turn 20, last eviction at turn 15 -> only 5 turns elapsed, gate shut.
    const shut = selectAttention({ units, asOfSeq: 1, turn: 20, lastEvictionTurn: 15, queryFingerprints: [], policy });
    expect(shut.mechanism.cadenceOpen).toBe(false);
    expect(shut.mechanism.evictedRederivableTokens).toBe(0);
    // Turn 30, last eviction at turn 15 -> 15 turns elapsed, gate open.
    const open = selectAttention({ units, asOfSeq: 1, turn: 30, lastEvictionTurn: 15, queryFingerprints: [], policy });
    expect(open.mechanism.cadenceOpen).toBe(true);
    expect(open.mechanism.evictedRederivableTokens).toBe(5000);
    expect(open.selectedIds).not.toContain('read');
  });

  it('NEVER evicts an unrepeatable observation, at any cadence or age', () => {
    // The policy's one unrecoverable mistake. run_command output is gone if dropped.
    const units = [cand({ id: 'stash-ab', rederivable: false, seq: 1, tokens: 9000 })];
    const result = selectAttention({
      units, asOfSeq: 1, turn: 999, lastEvictionTurn: 0, queryFingerprints: [],
      policy: { evictRederivable: { minCadenceTurns: 0 } },
    });
    expect(result.mechanism.cadenceOpen).toBe(true);
    expect(result.mechanism.evictedRederivableTokens).toBe(0);
    expect(result.audit.find((row) => row.id === 'stash-ab')!.disposition).not.toBe('evicted_rederivable');
  });

  it('treats an unknown tool as unrepeatable rather than dropping it', () => {
    // rederivable is left undefined when isRederivable cannot classify.
    const units = [cand({ id: 'mystery', rederivable: undefined, tokens: 4000 })];
    const result = selectAttention({
      units, asOfSeq: 1, turn: 50, queryFingerprints: [],
      policy: { evictRederivable: { minCadenceTurns: 0 } },
    });
    expect(result.mechanism.evictedRederivableUnits).toBe(0);
  });

  it('keeps a re-derivable unit the current turn is actually asking about', () => {
    // Recurrence beats re-derivability: ABS turn 40 needed the turn-4 sed
    // window after 16 dormant turns, and re-reading it cost 29,082 tokens.
    const units = [cand({ id: 'functions.go', rederivable: true, fingerprints: ['evaluator/functions.go'], tokens: 5000 })];
    const result = selectAttention({
      units, asOfSeq: 1, turn: 40, queryFingerprints: ['evaluator/functions.go'],
      demand: { kind: 'explicit', budgetTokens: 20_000 },
      policy: { evictRederivable: { minCadenceTurns: 0 } },
    });
    expect(result.mechanism.evictedRederivableTokens).toBe(0);
    expect(result.audit.find((row) => row.id === 'functions.go')!.disposition).toBe('selected');
    expect(result.selectedIds).toContain('functions.go');
  });

  it('never evicts pinned task, steering or plan text even when re-derivable', () => {
    const units = [
      cand({ id: 'task', role: 'task', rederivable: true, tokens: 600 }),
      cand({ id: 'steering', role: 'steering', rederivable: true, tokens: 300 }),
      cand({ id: 'plan', role: 'plan', rederivable: true, tokens: 900 }),
    ];
    const result = selectAttention({
      units, asOfSeq: 1, turn: 80, queryFingerprints: [],
      policy: { evictRederivable: { minCadenceTurns: 0 }, pinPlan: true },
    });
    expect(result.mechanism.evictedRederivableTokens).toBe(0);
  });

  it('rejects a negative or fractional cadence rather than guessing one', () => {
    const units = [cand()];
    for (const minCadenceTurns of [-1, 2.5]) {
      expect(() => selectAttention({
        units, asOfSeq: 1, turn: 5, queryFingerprints: [], policy: { evictRederivable: { minCadenceTurns } },
      })).toThrow(RangeError);
    }
  });

  it('is inert when the switch is absent — the default changes nothing', () => {
    const units = [cand({ id: 'read', rederivable: true, tokens: 5000 })];
    const result = selectAttention({ units, asOfSeq: 1, turn: 99, queryFingerprints: [] });
    expect(result.mechanism.cadenceOpen).toBe(false);
    expect(result.mechanism.evictedRederivableTokens).toBe(0);
  });
});

describe('Zone B as a topic index (operator specification)', () => {
  const regions = [
    { id: 'b1', text: 'edited evaluator/functions.go to add requireFn and requireCache handling', spanStartSeq: 1, spanEndSeq: 20 },
    { id: 'b2', text: 'wired valueFlags in repl/repl.go for the CLI, touching evaluator/functions.go once', spanStartSeq: 21, spanEndSeq: 40 },
    { id: 'b3', text: 'added modulePathEntries and cycleError to evaluator/module.go', spanStartSeq: 41, spanEndSeq: 60 },
  ];

  it('indexes identifiers, not prose, and carries a retrieval coordinate per region', () => {
    const index = buildTopicIndex({ regions, keywordsPerRegion: 4, maxRegionFraction: 0.6 });
    expect(index.entries).toHaveLength(3);
    for (const entry of index.entries) {
      expect(entry.spanEndSeq).toBeGreaterThan(entry.spanStartSeq);
      // Keywords are identifiers/paths, never sentences.
      for (const kw of entry.keywords) expect(kw).not.toMatch(/\s/);
    }
    expect(index.entries[2]!.keywords).toContain('modulePathEntries');
  });

  it('drops an identifier that appears in too many regions, and says which', () => {
    // functions.go is in 2 of 3 regions; at a 0.6 fraction the limit is 1, so
    // it routes nowhere and must be dropped rather than listed everywhere.
    const index = buildTopicIndex({ regions, keywordsPerRegion: 8, maxRegionFraction: 0.6 });
    expect(index.droppedCommon).toContain('evaluator/functions.go');
    for (const entry of index.entries) expect(entry.keywords).not.toContain('evaluator/functions.go');
    // A rarer path in a single region survives.
    expect(index.entries[1]!.keywords).toContain('repl/repl.go');
  });

  it('ranks rarest first, so a keyword resolves to one region unambiguously', () => {
    const index = buildTopicIndex({ regions, keywordsPerRegion: 2, maxRegionFraction: 1 });
    const b2 = index.entries.find((e) => e.id === 'b2')!;
    // With the cap at 1.0 nothing is dropped, so the shared path is eligible —
    // but it must not outrank an identifier unique to this region.
    expect(b2.keywords[0]).not.toBe('evaluator/functions.go');
  });

  it('caps keywords per region so the index is a fixed cost as history grows', () => {
    const many = Array.from({ length: 40 }, (_, i) => `symbolNumber${i}`).join(' ');
    const index = buildTopicIndex({ regions: [{ id: 'big', text: many, spanStartSeq: 1, spanEndSeq: 9 }], keywordsPerRegion: 5, maxRegionFraction: 1 });
    expect(index.entries[0]!.keywords).toHaveLength(5);
    expect(index.totalKeywords).toBe(5);
  });

  it('renders pointers with the retrieval instruction, and nothing when empty', () => {
    const text = renderTopicIndex(buildTopicIndex({ regions, keywordsPerRegion: 3, maxRegionFraction: 0.6 }));
    expect(text).toContain('These are pointers, not content');
    expect(text).toContain('call context_search');
    expect(text).toMatch(/b3 \[41-60\]/);
    // No prose from the source text leaks in.
    expect(text).not.toContain('added modulePathEntries and cycleError to');
    expect(renderTopicIndex(buildTopicIndex({ regions: [], keywordsPerRegion: 3, maxRegionFraction: 1 }))).toBe('');
    // A region with no distinctive identifiers contributes no line rather than a blank one.
    expect(renderTopicIndex(buildTopicIndex({ regions: [{ id: 'x', text: 'we talked about it', spanStartSeq: 1, spanEndSeq: 2 }], keywordsPerRegion: 3, maxRegionFraction: 1 }))).toBe('');
  });

  it('rejects unusable parameters rather than guessing', () => {
    for (const bad of [{ keywordsPerRegion: 0, maxRegionFraction: 0.5 }, { keywordsPerRegion: 2.5, maxRegionFraction: 0.5 },
      { keywordsPerRegion: 3, maxRegionFraction: 0 }, { keywordsPerRegion: 3, maxRegionFraction: 1.5 }]) {
      expect(() => buildTopicIndex({ regions, ...bad })).toThrow(RangeError);
    }
  });

  it('measures document frequency over regions, not occurrences', () => {
    // One region naming a symbol many times must not make it look common.
    const repeated = [
      { id: 'r1', text: 'alphaSymbol alphaSymbol alphaSymbol alphaSymbol betaSymbol', spanStartSeq: 1, spanEndSeq: 5 },
      { id: 'r2', text: 'gammaSymbol', spanStartSeq: 6, spanEndSeq: 9 },
    ];
    const index = buildTopicIndex({ regions: repeated, keywordsPerRegion: 5, maxRegionFraction: 0.5 });
    expect(index.droppedCommon).toEqual([]);
    expect(index.entries[0]!.keywords).toContain('alphaSymbol');
  });
});
