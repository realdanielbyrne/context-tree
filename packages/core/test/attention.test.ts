import { describe, expect, it } from 'vitest';
import { detectAttentionSignals, selectAttention, selectPayload } from '../src/attention/index.js';
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
