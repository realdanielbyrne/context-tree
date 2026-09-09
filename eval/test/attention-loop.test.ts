import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendEvent, openTaskStore, resolveConfig, selectAttention, type AttentionUnit, type CompletionRequest, type CompletionResult, type ModelProvider, type TraceEventInput } from '@context-tree/core';
import { CONTEXT_SEARCH, HANDLERS } from '@context-tree/mcp';
import { parseAttentionDeclaration, parseAttentionProfile, projectAttentionPrefix, runAttentionArm, selectSearchAdmission, type AttentionProfile } from '../src/attention-loop.js';
import { callModel, makeRepeatGuard, NATIVE_SYSTEM_PROMPT, type ArmArgs } from '../src/loop.js';
import { RunCapture } from '../src/capture.js';
import { disabledSink } from '../src/langfuse.js';
import { ZERO_TOTALS } from '../src/metrics.js';
import { createSandbox } from '../src/sandbox.js';
import type { Scenario } from '../src/types.js';

// HANDLERS is intentionally frozen in the product. Replace its test-only
// container, preserving real implementations unless a test scripts one.
vi.mock('@context-tree/mcp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@context-tree/mcp')>();
  return { ...actual, HANDLERS: { ...actual.HANDLERS } };
});

const profile = (mode: AttentionProfile['payload']['mode'] = 'excerpt'): AttentionProfile => ({
  version: 1, id: `test-${mode}`, payload: { mode, excerptChars: 64, anchor: 'first' },
});
const reply = (text: string, toolCalls: CompletionResult['toolCalls'] = []): CompletionResult => ({
  text, toolCalls, model: 'test-model', usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }, stopReason: toolCalls.length ? 'tool_use' : 'end_turn',
});
/**
 * The completion gate nudges once on the first bare reply after tool work and
 * only a second bare reply ends the run (loop.ts COMPLETION_NUDGE), so a script
 * that completes must answer bare twice. These tests are about payload
 * selection and signals, not the gate, so they stay on the default path rather
 * than disabling it.
 */
const confirming = (text: string): CompletionResult[] => [reply(text), reply(text)];
const contextCall = { id: 'search-1', name: CONTEXT_SEARCH, input: { query: 'NEEDLE' } };
const originalData = { query: 'NEEDLE', text: 'unrelated '.repeat(100) + 'NEEDLE original full producer response ' + 'tail '.repeat(100) };
const cleanup: (() => void)[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const remove of cleanup.splice(0)) remove();
});

function harness(policyProfile: AttentionProfile, replies: CompletionResult[], window = 100_000) {
  const root = mkdtempSync(join(tmpdir(), 'ct-attention-loop-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const scenario: Scenario = { id: 'attention-test', benchmark: 'unit', task: 'Inspect and update the fixture, then report the result.', judge: { kind: 'exact_match', answer: 'done' } };
  const sandbox = createSandbox(scenario, 'attention');
  cleanup.push(() => sandbox.cleanup());
  const capture = new RunCapture(join(root, 'capture'));
  const config = resolveConfig({ root: join(root, 'store'), provider: 'mock' });
  const requests: CompletionRequest[] = [];
  const scripted: ModelProvider = {
    id: 'scripted-attention',
    async complete(request) {
      requests.push(JSON.parse(JSON.stringify(request)) as CompletionRequest);
      const result = replies[requests.length - 1];
      if (result === undefined) throw new Error('unexpected model call');
      return result;
    },
  };
  const sink = disabledSink();
  const args: ArmArgs = {
    scenario, config, sandbox, capture,
    options: { model: 'test-model', leafModel: 'test-model', rootModel: 'test-model', judgeModel: 'test-model', provider: 'anthropic', maxTurns: Infinity, timeCapMs: Infinity, costCapUsd: null, budgets: { zoneB: 8000, zoneC: 30000 }, window, keepSandbox: false, policyProfile },
    provider: capture.provider(scripted, 'agent', window), turns: [], usage: { ...ZERO_TOTALS }, deadlineMs: Infinity,
    runHandle: sink.startRun({ runId: 'attention-test', benchmark: scenario.benchmark, scenarioId: scenario.id, arm: 'attention', model: 'test-model', scenarioTask: scenario.task, meta: {} }),
  };
  const events = () => readFileSync(join(root, 'capture', 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { kind: string; value: Record<string, unknown> });
  return { args, requests, events, root, run: () => runAttentionArm(args, { callModel, guard: makeRepeatGuard(), system: NATIVE_SYSTEM_PROMPT }) };
}

describe('attention profile preflight', () => {
  it('requires an explicit, strictly typed profile and calibrated parameters', () => {
    expect(() => parseAttentionProfile(undefined)).toThrow(/object/);
    expect(() => parseAttentionProfile({ ...profile(), magicTarget: 0.5 })).toThrow(/unknown key/);
    expect(() => parseAttentionProfile({ ...profile(), payload: { ...profile().payload, unknown: true } })).toThrow(/unknown key/);
    expect(() => parseAttentionProfile({ ...profile(), ledger: 'true' })).toThrow(/boolean/);
    expect(() => parseAttentionProfile({ ...profile(), attention: { priority: { boost: 1, halfLifeTurns: 2 } } })).toThrow(/calibrationId/);
    expect(() => parseAttentionProfile({ ...profile(), attention: { breadth: { relevanceMass: 0.5, calibrationId: 'fixture', target: 0.5 } } })).toThrow(/unknown key/);
    expect(() => parseAttentionProfile({ ...profile(), payload: { ...profile().payload, producers: ['run_command'] } })).toThrow(/producers/);
    expect(() => parseAttentionProfile({ ...profile(), payload: { ...profile().payload, producers: null } })).toThrow(/producers/);
    expect(() => parseAttentionProfile({ ...profile(), payload: { ...profile().payload, mode: ['whole'] } })).toThrow(/mode/);
    expect(() => parseAttentionProfile({ ...profile(), attention: { recency: ['all'] } })).toThrow(/recency/);
    expect(parseAttentionProfile(profile())).toEqual({ ...profile(), payload: { ...profile().payload, producers: ['context'] } });
  });
});

describe('real multi-turn attention arm', () => {
  it('applies breadth to actual scored search hits while preserving original and unknown hits', async () => {
    const data = { query: 'NEEDLE', hits: [{ seq: 1, score: 9, excerpt: 'task' }, { seq: 2, score: 1, excerpt: 'assistant' }, { seq: null, score: 0, excerpt: null }] };
    vi.spyOn(HANDLERS, CONTEXT_SEARCH).mockResolvedValue({ ok: true, data });
    const run = harness({ ...profile('whole'), payload: { ...profile('whole').payload, excerptChars: 10000 }, attention: { breadth: { relevanceMass: 0.8, calibrationId: 'synthetic-fixture-only' } } }, [reply('search', [contextCall]), ...confirming('done')]);
    await run.run();
    const admission = run.events().find((event) => event.kind === 'attention_admission')!.value;
    expect(admission.mechanismApplied).toBe(true);
    expect(admission.evidence).toMatchObject({ scoredCandidates: 2, unknownCandidates: 1 });
    const selected = JSON.parse(readFileSync(join(run.root, 'capture', 'blobs', admission.selectedPayloadBlob as string), 'utf8'));
    expect(selected.hits.map((hit: { seq: number | null }) => hit.seq)).toEqual([1, null]);
    expect(readFileSync(join(run.root, 'capture', 'blobs', admission.originalBlob as string), 'utf8')).toBe(JSON.stringify(data));
    expect(run.events().filter((event) => event.kind === 'attention_delivery').at(-1)!.value).toEqual(expect.objectContaining({ entries: expect.arrayContaining([expect.objectContaining({ selectedPayloadBlob: admission.selectedPayloadBlob })]) }));
  });
  it('changes only selected context payloads across modes and retains full L0/L2 originals', async () => {
    vi.spyOn(HANDLERS, CONTEXT_SEARCH).mockResolvedValue({ ok: true, data: originalData });
    const replies = [
      reply('Inspect the fixture.', [{ id: 'write-1', name: 'write_file', input: { path: 'fixture.txt', content: 'retained source file' } }, contextCall]),
      reply('Verify the file.', [{ id: 'read-1', name: 'read_file', input: { path: 'fixture.txt' } }]),
      ...confirming('done'),
    ];
    const excerpt = harness(profile('excerpt'), replies);
    const whole = harness(profile('whole'), replies);
    expect(await excerpt.run()).toEqual({ status: 'completed', finalText: 'done' });
    expect(await whole.run()).toEqual({ status: 'completed', finalText: 'done' });
    // 4, not 3: the completion gate spends one turn re-asking before the run ends.
    expect(excerpt.requests).toHaveLength(4);
    expect(excerpt.args.turns.flatMap((turn) => turn.toolCalls)).toEqual(['write_file', CONTEXT_SEARCH, 'read_file']);
    expect(excerpt.requests.map((request) => request.tools)).toEqual(whole.requests.map((request) => request.tools));
    expect(excerpt.requests[0]).toEqual(whole.requests[0]);
    const toolText = (request: CompletionRequest, tool: string) => request.messages.map((message) => String(message.content)).find((text) => text.startsWith(`[tool_result ${tool}]`));
    expect(toolText(excerpt.requests[1]!, 'write_file')).toEqual(toolText(whole.requests[1]!, 'write_file'));
    expect(toolText(excerpt.requests[1]!, CONTEXT_SEARCH)).not.toEqual(toolText(whole.requests[1]!, CONTEXT_SEARCH));
    expect(toolText(whole.requests[1]!, CONTEXT_SEARCH)).toContain(JSON.stringify(originalData));

    const payload = excerpt.events().find((event) => event.kind === 'attention_payload')!.value;
    expect(payload.mechanismApplied).toBe(true);
    expect(payload.deliveryAcknowledged).toBe(false);
    expect(payload.originalBlob).not.toBe(payload.selectedPayloadBlob);
    const handle = openTaskStore(excerpt.args.config);
    try {
      const event = handle.trace.all().find((event) => event.seq === payload.sourceSeq);
      expect(event?.type).toBe('tool_result');
      expect(event && 'output_blob' in event ? event.output_blob : null).toBe(payload.originalBlob);
      expect(handle.blobs.getText(payload.originalBlob as string)).toBe(JSON.stringify(originalData));
      expect(handle.blobs.has(payload.selectedPayloadBlob as string)).toBe(true);
      expect(handle.trace.all().filter((event) => event.type === 'tool_call' && event.tool === CONTEXT_SEARCH)).toHaveLength(1);
    } finally { handle.close(); }
    const delivered = excerpt.events().filter((event) => event.kind === 'attention_delivery');
    expect(JSON.stringify(delivered)).toContain(payload.selectedPayloadBlob);
    // 440 = four scripted calls at 100 input + 10 output each; the fourth is
    // the completion-gate turn.
    expect(excerpt.args.usage.total).toBe(440);
  });

  it('treats unsupported structural selection as unchanged control, with no mechanism credit', async () => {
    vi.spyOn(HANDLERS, CONTEXT_SEARCH).mockResolvedValue({ ok: true, data: originalData });
    const run = harness(profile('structural'), [reply('', [contextCall]), ...confirming('done')]);
    await run.run();
    const payload = run.events().find((event) => event.kind === 'attention_payload')!.value;
    expect(payload.fallback).toBe('unchanged_control');
    expect(payload.mechanismApplied).toBe(false);
    expect((payload.selection as Record<string, unknown>).status).toBe('unsupported_structure');
    expect(payload.originalBlob).toBe(payload.selectedPayloadBlob);
    expect(JSON.stringify(run.requests[1])).toContain('original full producer response');
  });

  it('compares read_file payloads only when the producer is explicitly selected', async () => {
    const replies = [reply('', [{ id: 'file-read', name: 'read_file', input: { path: 'input.txt' } }]), ...confirming('done')];
    const producerProfile = (mode: AttentionProfile['payload']['mode']) => ({ ...profile(mode), payload: { ...profile(mode).payload, producers: ['context', 'read_file'] as ('context' | 'read_file')[] } });
    const excerpt = harness(producerProfile('excerpt'), replies);
    const whole = harness(producerProfile('whole'), replies);
    const control = harness(profile('excerpt'), replies);
    const original = 'original file context '.repeat(300);
    for (const run of [excerpt, whole, control]) { run.args.sandbox.writeFile('input.txt', original); await run.run(); }
    const response = (run: ReturnType<typeof harness>) => String(run.requests[1]!.messages.at(-1)!.content);
    expect(response(excerpt)).not.toContain(original);
    expect(response(whole)).toContain(original);
    expect(response(control)).toBe(response(whole));
    expect(control.events().filter((event) => event.kind === 'attention_payload')).toHaveLength(0);
    const audit = excerpt.events().find((event) => event.kind === 'attention_payload')!.value;
    expect(audit.producer).toBe('read_file');
    expect(audit.boundary).toBe('read_file_producer_response');
    expect(audit.mechanismApplied).toBe(true);
    expect(readFileSync(join(excerpt.root, 'capture', 'blobs', audit.originalBlob as string), 'utf8')).toBe(original);
  });

  it('preserves original overflow and lets the common physical guard fail the send', async () => {
    vi.spyOn(HANDLERS, CONTEXT_SEARCH).mockResolvedValue({ ok: true, data: { text: 'long original response '.repeat(5000) } });
    const run = harness(profile('whole'), [reply('', [contextCall]), reply('must not be called')], 2000);
    await expect(run.run()).rejects.toThrow(/ProtectedContentOverflow/);
    expect(run.requests).toHaveLength(1);
    const payload = run.events().find((event) => event.kind === 'attention_payload')!.value;
    expect((payload.selection as Record<string, unknown>).status).toBe('overflow');
    expect(payload.mechanismApplied).toBe(false);
    expect(payload.originalBlob).toBe(payload.selectedPayloadBlob);
    expect(run.events().filter((event) => event.kind === 'attention_delivery')).toHaveLength(1);
    expect(run.events().find((event) => event.kind === 'attention_send_failed')?.value.deliveryAcknowledged).toBe(false);
  });

  it('observes signals only in assistant L0, retaining tool text and unknown history', async () => {
    vi.spyOn(HANDLERS, CONTEXT_SEARCH).mockResolvedValue({ ok: true, data: { text: 'I have enough information to implement this. Should I implement the plan?' } });
    const run = harness({ ...profile('whole'), attention: { excludeIrrelevant: true, sufficiencyGate: true } }, [
      reply('"I have enough information to implement this."', [contextCall]),
      reply('Should I implement the plan?', [{ id: 'read-2', name: 'read_file', input: { path: 'missing.txt' } }]),
      ...confirming('done'),
    ]);
    await run.run();
    const signals = run.events().filter((event) => event.kind === 'attention_signals');
    expect(signals[0]?.value.signals).toEqual([]);
    expect((signals[1]?.value.signals as { kind: string }[]).map((signal) => signal.kind)).toEqual(['research_done']);
    const turn = run.events().filter((event) => event.kind === 'attention_turn').at(-1)!.value;
    expect((turn.attention as { mechanism: { excludedTokens: number } }).mechanism.excludedTokens).toBe(0);
    expect(JSON.stringify(run.requests[2])).toContain('missing.txt');
    expect(JSON.stringify(run.requests[2])).toContain('I have enough information');
  });

  it('adds an opt-in ledger of actual edit outcomes with source coordinates', async () => {
    const run = harness({ ...profile('whole'), ledger: true }, [
      reply('', [{ id: 'write-1', name: 'write_file', input: { path: 'actual.txt', content: 'actual edit' } }]),
      ...confirming('done'),
    ]);
    await run.run();
    const ledgerMessage = run.requests[1]!.messages.find((message) => String(message.content).startsWith('[Recorded action outcomes;'));
    expect(ledgerMessage).toBeDefined();
    const rows = JSON.parse(String(ledgerMessage!.content).split('\n')[1]!) as { sourceSeq: number; outcome: string; path: string }[];
    expect(rows[0]?.outcome).toBe('success');
    expect(rows[0]?.path).toBe('actual.txt');
    expect(rows[0]?.sourceSeq).toBeGreaterThan(0);
    expect(rows[0]).not.toHaveProperty('taskComplete');
    expect(run.events().filter((event) => event.kind === 'attention_turn').at(-1)?.value.mechanismApplied).toBe(true);
  });
});

describe('explicit prefix projection', () => {
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'ct-attention-projection-'));
    const handle = openTaskStore(resolveConfig({ root, provider: 'mock' }));
    cleanup.push(() => { handle.close(); rmSync(root, { recursive: true, force: true }); });
    const append = (event: Omit<TraceEventInput, 'ts'>) => appendEvent(handle, { ...event, ts: '2026-01-01T00:00:00.000Z' } as TraceEventInput).event;
    const text = (type: 'user_message' | 'assistant_message' | 'manual_annotation', value: unknown) => append({ type, blob: handle.blobs.put(typeof value === 'string' ? value : JSON.stringify({ attention_v1: value })) } as TraceEventInput);
    const unit = (seq: number, extra: Partial<AttentionUnit> = {}): AttentionUnit => ({ id: `l0:${seq}`, seq, tokens: 10, state: 'resident', fingerprints: [], ...extra });
    return { handle, append, text, unit };
  }

  it('validates declarations and restores a scoped-out API source on the tests subtask', () => {
    expect(parseAttentionDeclaration('Should I implement the plan?')).toBeNull();
    expect(() => parseAttentionDeclaration('{"attention_v1":{"kind":"relevance","unit_seqs":[1],"scope_seq":2,"evidence_seqs":[1],"value":["irrelevant"]}}')).toThrow(/value/);
    const { handle, text, unit } = fixture();
    const task = text('user_message', 'repair API, UI, and tests');
    const plan = text('assistant_message', 'API implementation, UI work, then API-dependent tests');
    const api = text('assistant_message', 'API.encode implementation details');
    text('manual_annotation', { kind: 'plan', source_seq: plan.seq });
    const subtask = text('manual_annotation', { kind: 'subtask', id: 'UI', state: 'begin' });
    const steering = text('user_message', { kind: 'relevance', unit_seqs: [api.seq], scope_seq: subtask.seq, evidence_seqs: [task.seq], value: 'irrelevant' });
    text('manual_annotation', { kind: 'relevance', unit_seqs: [task.seq], scope_seq: subtask.seq, evidence_seqs: [task.seq], value: 'irrelevant' });
    const units = [unit(task.seq, { role: 'task' }), unit(plan.seq), unit(api.seq, { fingerprints: ['API.encode'] }), unit(steering.seq, { role: 'steering' })];
    const run = (turn: number, queryFingerprints: string[]) => {
      const p = projectAttentionPrefix(handle, units, turn);
      return { p, result: selectAttention({ ...p, asOfSeq: handle.trace.lastSeq(), turn, queryFingerprints, policy: { excludeIrrelevant: true, pinPlan: true, recency: 'subtask' } }) };
    };
    const ui = run(2, ['UI.render']);
    expect(ui.p.evidence).toMatchObject({ planArtifacts: 1, subtaskBoundaries: 1, scopedRelevanceDeclarations: 1 });
    expect(ui.p.evidence.rejectedDeclarations).toHaveLength(1);
    expect(ui.result.selectedIds).toEqual([`l0:${task.seq}`, `l0:${plan.seq}`, `l0:${steering.seq}`]);
    expect(run(2, ['API.encode']).result.selectedIds).toContain(`l0:${api.seq}`);
    const uiPrefix = handle.trace.lastSeq();
    text('manual_annotation', { kind: 'subtask', id: 'API-tests', state: 'begin' });
    expect(run(3, []).result.selectedIds).toContain(`l0:${api.seq}`);
    expect(projectAttentionPrefix(handle, units, 2, uiPrefix).evidence.subtaskBoundaries).toBe(1);
  });

  it('maps successful edits and only acknowledged full-source fetch exposure', () => {
    const { handle, text, append, unit } = fixture();
    text('user_message', 'inspect');
    const read = append({ type: 'tool_call', tool: 'read_file', path: 'api.ts', args_blob: handle.blobs.put('{"path":"api.ts"}') } as TraceEventInput);
    const source = append({ type: 'tool_result', call_seq: read.seq, output_blob: handle.blobs.put('unique API source bytes') } as TraceEventInput);
    const write = append({ type: 'tool_call', tool: 'write_file', path: 'api.ts', args_blob: handle.blobs.put('{"path":"api.ts"}') } as TraceEventInput);
    append({ type: 'tool_result', call_seq: write.seq, output_blob: handle.blobs.put('written') } as TraceEventInput);
    const rootNode = handle.store.nodesInCreationOrder()[0]!;
    const fetch = append({ type: 'tool_call', tool: 'context_fetch', args_blob: handle.blobs.put(JSON.stringify({ branch_id: rootNode.id })) } as TraceEventInput);
    const raw = JSON.stringify({ spans: [{ start: source.seq, end: source.seq }], text: 'unique API source bytes' });
    const fetched = append({ type: 'tool_result', call_seq: fetch.seq, output_blob: handle.blobs.put(raw) } as TraceEventInput);
    const project = (receipt: string | undefined) => projectAttentionPrefix(handle, [unit(source.seq)], 2, handle.trace.lastSeq(), receipt === undefined ? new Map() : new Map([[fetched.seq, receipt]]));
    expect(project(undefined).evidence).toMatchObject({ mappedEdits: 1, mappedFetches: 0 });
    expect(project(raw).references).toContainEqual(expect.objectContaining({ unitId: `l0:${source.seq}`, kind: 'fetch', seq: fetched.seq }));
    expect(project(JSON.stringify({ spans: [{ start: source.seq, end: source.seq }], text: 'unique API' })).evidence.mappedFetches).toBe(0);
  });

  it('uses explicit demand headroom separately from relevance mass and keeps unmapped scores', () => {
    const { handle, text } = fixture();
    const a = text('user_message', 'task');
    const b = text('assistant_message', 'response');
    const original = JSON.stringify({ hits: [{ seq: a.seq, score: 3, excerpt: 'source alpha '.repeat(200) }, { seq: b.seq, score: 1, excerpt: 'source beta '.repeat(200) }, { seq: 9999, score: 9, excerpt: 'unmapped' }] });
    const args = { handle, original, asOfSeq: handle.trace.lastSeq(), turn: 1, query: 'alpha', excerptChars: 100, anchor: 'first' as const, availableTokens: 10000, signals: [] };
    const control = selectSearchAdmission({ ...args, policy: { demandExpansion: false } });
    const expanded = selectSearchAdmission({ ...args, policy: { demandExpansion: true } });
    expect(JSON.parse(control.text).hits.map((hit: { seq: number }) => hit.seq)).toEqual([9999]);
    expect(JSON.parse(expanded.text).hits.map((hit: { seq: number }) => hit.seq)).toEqual([a.seq, b.seq, 9999]);
    expect(expanded.envelope!.demand.budgetTokens).toBe(control.envelope!.demand.budgetTokens);
    const breadth = selectSearchAdmission({ ...args, policy: { demandExpansion: true, breadth: { relevanceMass: 0.7, calibrationId: 'synthetic-only' } } });
    expect(JSON.parse(breadth.text).hits.map((hit: { seq: number }) => hit.seq)).toEqual([a.seq, 9999]);
  });
});
