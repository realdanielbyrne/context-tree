/**
 * The pipeline stages as tools, and the HTTP transport. What these protect: every stage
 * works over the SAME units (turns = host messages); assemble represents and never removes;
 * evict takes the assembly as input and may overrule it; rulings are sticky; rendering onto
 * host messages adds no rules; parameters come from one registry; both transports share one
 * session; a stage can be swapped behind its name.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HeuristicTokenizer, TreeRetriever, ingest, openTaskStore, resolveConfig, type TaskStore } from '@context-tree/core';
import {
  PIPELINE_DEFAULTS,
  PIPELINE_PARAMS,
  TOOLS,
  contextAssemble,
  contextClassify,
  contextEvict,
  contextFetch,
  contextPeek,
  contextSearch,
  contextRestore,
  contextUnits,
  createHttpApi,
  createSession,
  describeParams,
  pipelineFromEnv,
  withHandlers,
  type PipelineParams,
  type HttpApi,
  type ToolContext,
  type ToolOutcome,
} from '../src/index.js';

const TS = '2026-09-20T00:00:00.000Z';
const temps: string[] = [];
const handles: TaskStore[] = [];
const apis: HttpApi[] = [];

afterEach(async () => {
  for (const api of apis.splice(0)) await api.close();
  for (const handle of handles.splice(0)) handle.close();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** One user message, then `turns` host messages alternating read/edit, each a tool call + result of ~`words` words. */
function seed(turns = 8, words = 400, params: Partial<PipelineParams> = {}): ToolContext {
  const root = mkdtempSync(join(tmpdir(), 'ct-pipe-'));
  temps.push(root);
  const config = resolveConfig({ root, taskTitle: 'pipeline fixture' });
  const handle = openTaskStore(config);
  handles.push(handle);
  const { trace, blobs } = handle;
  trace.append({ type: 'user_message', ts: TS, blob: blobs.put('fix the bug'), turn_id: 'm0' });
  for (let t = 0; t < turns; t += 1) {
    const body = Array.from({ length: words }, (_, w) => `turn${String(t)}word${String(w)}`).join(' ');
    const tool = t % 2 === 0 ? 'Read' : 'Edit';
    const turn_id = `m${String(t + 1)}`;
    const call = trace.append({ type: 'tool_call', ts: TS, tool, path: `src/f${String(t)}.ts`, turn_id, ...(tool === 'Edit' ? { blob: blobs.put(body) } : { args_blob: blobs.put('{}') }) });
    trace.append({ type: 'tool_result', ts: TS, call_seq: call.seq, output_blob: blobs.put(body), turn_id });
  }
  ingest({ handle });
  const retriever = new TreeRetriever({ store: handle.store, blobs, trace });
  return { config, handle, retriever, session: createSession({ ...PIPELINE_DEFAULTS, ...params }) };
}

const messages = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `m${String(i)}`, hasTools: i > 0 }));

function unwrap<T>(outcome: ToolOutcome<T>): T {
  if (!outcome.ok) throw new Error(`${outcome.error.code}: ${outcome.error.message}`);
  return outcome.data;
}

describe('units / classify — one unit list for every stage', () => {
  it('a unit is a turn: one per host message, the task statement and the newest pinned', async () => {
    const data = unwrap(await contextUnits(seed(), {}));
    expect(data.unit).toBe('turn');
    expect(data.units).toHaveLength(9);
    expect(data.units.map((u) => u.pinned)).toEqual([true, false, false, false, false, false, false, false, true]);
    expect(data.units.every((u) => u.state === 'keep' && u.chunks >= 1)).toBe(true);
    expect(data.units[1]).toMatchObject({ id: 'turn:2', from_seq: 2, to_seq: 3 });
    expect(data.tokens_current).toBe(data.tokens_raw);
  });

  it('a unit is sized by what the host sends — not by the rendering, whose headers and post-state no host sends', async () => {
    const data = unwrap(await contextUnits(seed(), {}));
    const count = (text: string): number => new HeuristicTokenizer().count(text);
    const body = (t: number): string => Array.from({ length: 400 }, (_, w) => `turn${String(t)}word${String(w)}`).join(' ');
    expect(data.units[0]!.tokens).toBe(count('fix the bug'));
    expect(data.units[1]!.tokens).toBe(count('{}') + count(body(0)));
    // An Edit's post-state blob repeats its args; only the result is host content here.
    expect(data.units[2]!.tokens).toBe(count(body(1)));
  });

  it("unit: 'phase' is the coarse legacy granularity over the same trace", async () => {
    const turns = unwrap(await contextUnits(seed(), {}));
    const phases = unwrap(await contextUnits(seed(8, 400, { unit: 'phase' }), {}));
    expect(phases.units.length).toBeLessThan(turns.units.length);
    expect(phases.tokens_raw).toBe(turns.tokens_raw);
  });

  it('classify names the same units, and asking twice does not count an observation twice', async () => {
    const ctx = seed();
    const first = unwrap(await contextClassify(ctx, {}));
    expect(unwrap(await contextClassify(ctx, {}))).toEqual(first);
    expect(first.units.map((u) => u.id)).toEqual(unwrap(await contextUnits(ctx, {})).units.map((u) => u.id));
  });
});

describe('assemble — represents, never removes', () => {
  it('reduces a unit over the per-unit budget and keeps every unit', async () => {
    const ctx = seed(4, 3000);
    const data = unwrap(await contextAssemble(ctx, { window_tokens: 20_000, anchor: 1, query: 'turn1word7' }));
    expect(data.per_unit_budget).toBe(3750);
    expect(data.units).toHaveLength(5);
    expect(data.units.filter((u) => u.representation === 'reduce').map((u) => u.id)).toEqual(['turn:2', 'turn:4', 'turn:6']);
    expect(data.units.every((u) => u.representation !== 'drop')).toBe(true);
    expect(data.tokens_assembled).toBeLessThan(data.tokens_raw);
    // The newest message is pinned: over budget, and still raw.
    expect(data.units.at(-1)).toMatchObject({ representation: 'keep' });
  });

  it('is sticky: a later, roomier assemble does not flip a reduced unit back to raw', async () => {
    const ctx = seed(4, 3000);
    await contextAssemble(ctx, { window_tokens: 20_000, anchor: 1 });
    const again = unwrap(await contextAssemble(ctx, { window_tokens: 10_000_000 }));
    expect(again.units.filter((u) => u.representation === 'reduce')).toHaveLength(3);
  });

  it("reducer 'none' leaves everything raw", async () => {
    const data = unwrap(await contextAssemble(seed(4, 3000), { window_tokens: 20_000, anchor: 1, reducer: 'none' }));
    expect(data.units.every((u) => u.representation === 'keep')).toBe(true);
  });
});

describe('evict — takes the assembly as input, and may overrule it', () => {
  it('does nothing while the assembly fits', async () => {
    expect(unwrap(await contextEvict(seed(), { window_tokens: 1_000_000 }))).toMatchObject({ fired: false, evicted: [], evicted_total: 0 });
  });

  it("budgets on assemble's sizes: the same window evicts less after assembly than before it", async () => {
    const ctx = seed(4, 3000);
    const assembly = unwrap(await contextAssemble(ctx, { window_tokens: 20_000, anchor: 1 }));
    const window = assembly.tokens_assembled;
    const after = unwrap(await contextEvict(ctx, { window_tokens: window, dry_run: true }));
    expect(after).toMatchObject({ fired: false, tokens_before: assembly.tokens_assembled });
    // Un-assembled, the same window has to remove units to fit.
    expect(unwrap(await contextEvict(seed(4, 3000), { window_tokens: window, dry_run: true })).evicted.length).toBeGreaterThan(0);
    // The inline form is the same input, made explicit.
    expect(unwrap(await contextEvict(ctx, { window_tokens: window, dry_run: true, assembly: assembly.units }))).toEqual(after);
  });

  it('overrules assembly: a unit assemble chose to keep reduced can still be removed', async () => {
    const ctx = seed(4, 3000);
    await contextAssemble(ctx, { window_tokens: 20_000, anchor: 1 });
    const { evicted } = unwrap(await contextEvict(ctx, { window_tokens: 9000 }));
    expect(evicted).toContain('turn:2');
    expect(unwrap(await contextUnits(ctx, {})).units.find((u) => u.id === 'turn:2')).toMatchObject({ state: 'drop', current_tokens: 0 });
  });

  it('is sticky, never touches a pinned unit, and dry_run changes nothing', async () => {
    const ctx = seed();
    const total = unwrap(await contextUnits(ctx, {})).tokens_raw;
    expect(unwrap(await contextEvict(ctx, { window_tokens: total / 2, dry_run: true })).fired).toBe(true);
    expect(unwrap(await contextUnits(ctx, {})).units.some((u) => u.state === 'drop')).toBe(false);

    const { evicted, tokens_after } = unwrap(await contextEvict(ctx, { window_tokens: total / 2 }));
    expect(tokens_after).toBeLessThanOrEqual(total / 2);
    expect(evicted).not.toContain('turn:1');
    expect(evicted).not.toContain('turn:16');
    // No further call: still out. A cadence's off turn is exactly this.
    expect(unwrap(await contextUnits(ctx, {})).units.filter((u) => u.state === 'drop').map((u) => u.id)).toEqual(evicted);
    expect(unwrap(await contextEvict(ctx, { window_tokens: total / 2 })).fired).toBe(false);
  });

  it("evict_mode 'stub' cuts a unit to a visible residue before anything is dropped", async () => {
    const ctx = seed();
    const total = unwrap(await contextUnits(ctx, {})).tokens_raw;
    const data = unwrap(await contextEvict(ctx, { window_tokens: total / 2, evict_mode: 'stub', messages: messages(9) }));
    expect(data.stubbed.length).toBeGreaterThan(0);
    expect(data.evicted).toEqual([]);
    expect(data.tokens_after).toBeLessThanOrEqual(total / 2);

    const stub = data.decisions!.find((d) => d.action === 'stub') as { unit: string; outputs: { index: number; text: string }[] };
    expect(stub.outputs).toHaveLength(1);
    expect(stub.outputs[0]!.text).toMatch(new RegExp(`^\\[evicted · \\d+ tokens · began: "turn\\d+word0 .*recall: fetch \\{"unit":"${stub.unit}"\\}\\]$`));
    const row = unwrap(await contextUnits(ctx, {})).units.find((u) => u.id === stub.unit)!;
    expect(row.state).toBe('stub');
    expect(row.current_tokens).toBeLessThan(row.tokens / 10);

    // The id in the tag works in one call, and returns what the tag replaced.
    const back = unwrap(await contextFetch(ctx, { unit: stub.unit }));
    expect(back.text).toContain('word399');
    // Sticky, and written once: the same stub text on the next turn, so the cached prefix holds.
    const again = unwrap(await contextEvict(ctx, { window_tokens: total / 2, evict_mode: 'stub', messages: messages(9) }));
    expect(again.fired).toBe(false);
    expect(again.decisions!.find((d) => d.id === (stub as unknown as { id: string }).id)).toEqual(stub);
  });

  it('stubs that still do not fit are dropped, worst first; restore brings a stub back whole', async () => {
    const ctx = seed();
    const data = unwrap(await contextEvict(ctx, { window_tokens: 1400, evict_mode: 'stub' }));
    expect(data.evicted.length).toBeGreaterThan(0);
    expect(data.stubbed.length).toBeGreaterThan(0);
    expect(data).toMatchObject({ over_budget: false });
    expect(data.tokens_after).toBeLessThanOrEqual(1400);
    const gentle = seed();
    const total = unwrap(await contextUnits(gentle, {})).tokens_raw;
    const { stubbed } = unwrap(await contextEvict(gentle, { window_tokens: total / 2, evict_mode: 'stub' }));
    expect(unwrap(await contextRestore(gentle, { ids: [stubbed[0]!] })).restored).toEqual([stubbed[0]]);
    expect(unwrap(await contextUnits(gentle, {})).units.find((u) => u.id === stubbed[0])!.state).toBe('keep');
  });

  it('reasoning is content: search finds it, peek shows it, fetch returns it alone with part', async () => {
    const ctx = seed(2, 50);
    const { trace, blobs } = ctx.handle;
    trace.append({ type: 'reasoning', ts: TS, blob: blobs.put('the fixture is stale because zebraquux moved'), turn_id: 'm3' });
    trace.append({ type: 'assistant_message', ts: TS, blob: blobs.put('Stale fixture.'), turn_id: 'm3' });
    ingest({ handle: ctx.handle });
    const hits = unwrap(await contextSearch(ctx, { query: 'zebraquux' }));
    expect(hits.hits.some((h) => (h.excerpt ?? '').includes('zebraquux'))).toBe(true);
    const unit = unwrap(await contextUnits(ctx, {})).units.at(-1)!;
    const only = unwrap(await contextFetch(ctx, { unit: unit.id, part: 'reasoning' }));
    expect(only.text).toContain('zebraquux');
    expect(only.text).not.toContain('Stale fixture.');
    const peeked = unwrap(await contextPeek(ctx, { node_id: unit.phase_id, max_chars: 4000 }));
    expect(peeked.text).toContain('zebraquux');
  });

  it('fetch takes exactly one of branch_id or unit', async () => {
    const ctx = seed();
    expect((await contextFetch(ctx, {})).ok).toBe(false);
    expect((await contextFetch(ctx, { unit: 'turn:999' })).ok).toBe(false);
  });

  it('soft protection yields when nothing else can pay; hard does not', async () => {
    const soft = seed();
    const total = unwrap(await contextUnits(soft, {})).tokens_raw;
    const tight = { window_tokens: total / 4, anchor: 8, protection_bonus: 100 };
    expect(unwrap(await contextEvict(soft, tight)).tokens_after).toBeLessThanOrEqual(total / 4);
    const hard = unwrap(await contextEvict(seed(), { ...tight, protection: 'hard' }));
    expect(hard).toMatchObject({ evicted: [], over_budget: true });
  });

  it('top_k and w_relevance: inert at weight 0, decisive above it', async () => {
    const query = 'turn0word5 turn0word6 turn0word7';
    const ctx = seed();
    const total = unwrap(await contextUnits(ctx, {})).tokens_raw;
    const base = { window_tokens: total / 2, dry_run: true, query, anchor: 0 };
    expect(unwrap(await contextEvict(ctx, base)).evicted).toContain('turn:2');
    expect(unwrap(await contextEvict(ctx, { ...base, top_k: 3, w_relevance: 10 })).evicted).not.toContain('turn:2');
    expect(unwrap(await contextEvict(ctx, { ...base, top_k: 0, w_relevance: 10 })).evicted).toContain('turn:2');
  });

  it('restore undoes either ruling, by id or all at once', async () => {
    const ctx = seed(4, 3000);
    await contextAssemble(ctx, { window_tokens: 20_000, anchor: 1 });
    await contextEvict(ctx, { window_tokens: 9000 });
    expect(unwrap(await contextRestore(ctx, { ids: ['turn:2'] })).restored).toEqual(['turn:2']);
    expect(unwrap(await contextUnits(ctx, {})).units.find((u) => u.id === 'turn:2')?.state).toBe('keep');
    unwrap(await contextRestore(ctx, { all: true }));
    expect(unwrap(await contextUnits(ctx, {})).units.every((u) => u.state === 'keep')).toBe(true);
    expect((await contextRestore(ctx, {})).ok).toBe(false);
  });

  it('rejects a reserve that leaves no window', async () => {
    expect((await contextEvict(seed(), { window_tokens: 100, reserve_tokens: 100 })).ok).toBe(false);
  });
});

describe('decisions for host messages — a rendering of the rulings, with no rules of its own', () => {
  it('a turn IS a message: a dropped unit drops exactly its message, an unknown message is kept', async () => {
    const ctx = seed();
    const total = unwrap(await contextUnits(ctx, {})).tokens_raw;
    const data = unwrap(await contextEvict(ctx, { window_tokens: total / 2, messages: [...messages(9), { id: 'not-ingested-yet' }] }));
    const dropped = data.decisions!.filter((d) => d.action === 'drop');
    expect(dropped.map((d) => (d.action === 'drop' ? d.unit : ''))).toEqual(data.evicted);
    expect(data.decisions!.at(-1)).toEqual({ id: 'not-ingested-yet', action: 'keep' });
    expect(data.actions).toMatchObject({ drop: data.evicted.length });
  });

  it('assemble and evict render the same state: either call can be the last one a plugin makes', async () => {
    const ctx = seed(4, 3000);
    const a = unwrap(await contextAssemble(ctx, { window_tokens: 20_000, anchor: 1, messages: messages(5) }));
    const e = unwrap(await contextEvict(ctx, { window_tokens: 10_000_000, messages: messages(5) }));
    expect(e.fired).toBe(false);
    expect(e.decisions).toEqual(a.decisions);
  });

  it('a reduction edits tool OUTPUTS in place — the call and its result stay in their message', async () => {
    const ctx = seed(4, 3000);
    const { decisions } = unwrap(await contextAssemble(ctx, { window_tokens: 20_000, anchor: 1, query: 'turn1word9', messages: messages(5) }));
    const reduced = decisions!.find((d) => d.action === 'reduce');
    expect(reduced).toMatchObject({ id: 'm1', unit: 'turn:2' });
    const output = reduced?.action === 'reduce' ? reduced.outputs[0]! : null;
    expect(output?.index).toBe(0);
    expect(output!.text.length).toBeLessThan(3000 * 8);
    expect(output!.text).toContain('turn0word');
  });
});

describe('folding a phase to its summary', () => {
  /** user | assistant text + Read | Read | Edit … so the closed diagnosis phase has one text-bearing message. */
  function folding(textInPhase: boolean): ToolContext {
    const ctx = seed(0, 0, { summaries: true, anchor: 1, reducer: 'none' });
    const { trace, blobs, store } = ctx.handle;
    const call = (tool: string, turn_id: string): void => {
      const c = trace.append({ type: 'tool_call', ts: TS, tool, path: 'src/a.ts', turn_id, ...(tool === 'Edit' ? { blob: blobs.put('x') } : {}) });
      trace.append({ type: 'tool_result', ts: TS, call_seq: c.seq, output_blob: blobs.put('out'), turn_id });
    };
    call('Read', 'm1');
    if (textInPhase) trace.append({ type: 'assistant_message', ts: TS, blob: blobs.put('I see the bug'), turn_id: 'm2' });
    call('Read', 'm3');
    call('Edit', 'm4');
    call('Edit', 'm5');
    ingest({ handle: ctx.handle });
    const diagnosis = store.byKind('phase').find((n) => n.phase_type === 'diagnosis')!;
    store.putSummary({ node_id: diagnosis.id, model: 'test', text: 'Read a.ts; the bug is in price().', meta: { files: [], symbols: [], tests: [], artifacts: [], open_questions: [], decisions: [], node_ids: [] } });
    return ctx;
  }
  const ids = ['m0', 'm1', 'm2', 'm3', 'm4', 'm5'];
  const host = (hasText: boolean) => ids.filter((id) => hasText || id !== 'm2').map((id) => ({ id, hasTools: id !== 'm0' && id !== 'm2' }));

  it('the first TEXT-ONLY message of the phase carries the summary; its other messages go', async () => {
    const data = unwrap(await contextAssemble(folding(true), { window_tokens: 100_000, messages: host(true) }));
    const by = Object.fromEntries(data.decisions!.map((d) => [d.id, d]));
    // Headline form by default: one sentence and the call that brings the phase back.
    expect(by['m2']).toMatchObject({ action: 'fold' });
    expect((by['m2'] as { text: string }).text).toMatch(/^\[folded phase · Read a\.ts; the bug is in price\(\)\. · recall: search, or fetch \{"branch_id":"n_[^"]+"\}\]$/);
    expect([by['m1']!.action, by['m3']!.action]).toEqual(['drop', 'drop']);
    expect([by['m0']!.action, by['m4']!.action, by['m5']!.action]).toEqual(['keep', 'keep', 'keep']);
    expect(data.actions).toMatchObject({ fold: 1, drop: 2 });
  });

  it('a phase with no text-only message is not folded: every message stays, and assemble says why', async () => {
    const data = unwrap(await contextAssemble(folding(false), { window_tokens: 100_000, messages: host(false) }));
    expect(data.actions).toMatchObject({ fold: 0, drop: 0 });
    expect(data.unfoldable_phases).toHaveLength(1);
    expect(data.tokens_assembled).toBe(data.tokens_raw);
  });

  it('what assemble reports is what gets rendered: the fold\'s tokens belong to the message that carries it', async () => {
    const data = unwrap(await contextAssemble(folding(true), { window_tokens: 100_000, messages: host(true) }));
    const carrierUnit = data.units.find((u) => u.representation === 'fold')!;
    expect(data.decisions!.find((d) => d.action === 'fold')).toMatchObject({ unit: carrierUnit.id });
  });

  it('a summary that arrives AFTER its units were reduced still folds them (summarization is async)', async () => {
    const ctx = seed(0, 0, { summaries: true, anchor: 1 });
    const { trace, blobs, store } = ctx.handle;
    const big = Array.from({ length: 3000 }, (_, w) => `diagword${String(w)}`).join(' ');
    trace.append({ type: 'assistant_message', ts: TS, blob: blobs.put(big), turn_id: 'm1' });
    for (const [tool, id] of [['Edit', 'm2'], ['Edit', 'm3']] as const) {
      const c = trace.append({ type: 'tool_call', ts: TS, tool, path: 'src/a.ts', blob: blobs.put('x'), turn_id: id });
      trace.append({ type: 'tool_result', ts: TS, call_seq: c.seq, output_blob: blobs.put('ok'), turn_id: id });
    }
    ingest({ handle: ctx.handle });
    const first = unwrap(await contextAssemble(ctx, { window_tokens: 20_000 }));
    const reduced = first.units.find((u) => u.representation === 'reduce')!;
    expect(reduced).toBeDefined();

    const phase = store.getNode(reduced.phase_id)!;
    expect(phase.status).not.toBe('open');
    store.putSummary({ node_id: phase.id, model: 'test', text: 'diagnosed it', meta: { files: [], symbols: [], tests: [], artifacts: [], open_questions: [], decisions: [], node_ids: [] } });
    const second = unwrap(await contextAssemble(ctx, { window_tokens: 20_000 }));
    expect(second.units.find((u) => u.id === reduced.id)?.representation).toBe('fold');
  });
});

describe('the parameter registry', () => {
  it('is the single source: env, defaults, tool arguments and /v1/params all derive from it', () => {
    const p = pipelineFromEnv({ CT_CT_ANCHOR: '3', CT_CT_W_DORMANCY: '2.5', CT_CT_REDUCER: 'summarize', CT_CT_SUMMARIES: '1', CT_CT_UNIT: 'phase', CT_CT_TOPK: '9' });
    expect(p).toMatchObject({ anchor: 3, wDormancy: 2.5, reducer: 'summarize', summaries: true, unit: 'phase', topK: 9 });
    expect(pipelineFromEnv({})).toEqual(PIPELINE_DEFAULTS);
    const described = describeParams(p);
    expect(described.map((d) => d.key)).toEqual(PIPELINE_PARAMS.map((s) => s.key));
    expect(described.find((d) => d.key === 'anchor')).toMatchObject({ env: 'CT_CT_ANCHOR', argument: 'anchor', value: 3, stages: ['assemble', 'evict'] });
    expect(described.find((d) => d.key === 'chunkSize')?.argument).toBeNull();
    expect(new Set(PIPELINE_PARAMS.map((s) => s.env)).size).toBe(PIPELINE_PARAMS.length);
  });

  it('refuses a value that does not parse — from the environment and from a tool call alike', async () => {
    for (const env of [{ CT_CT_ANCHOR: 'three' }, { CT_CT_ANCHOR: '2.5' }, { CT_CT_REDUCER: 'magic' }, { CT_CT_SUMMARIES: 'yes' }, { CT_CT_PRIORITY_HALFLIFE: '0' }, { CT_CT_SOFT_TARGET_FRAC: '1.5' }]) {
      expect(() => pipelineFromEnv(env), JSON.stringify(env)).toThrow(/pipeline misconfigured/);
    }
    const bad = await contextEvict(seed(), { window_tokens: 1000, anchor: -1 });
    expect(bad.ok ? '' : bad.error.code).toBe('invalid_input');
    // The message names the actual violation, not a generic one.
    expect(bad.ok ? '' : bad.error.message).toMatch(/anchor: must be >= 0/);
    const fractional = await contextEvict(seed(), { window_tokens: 1000, anchor: 2.5 });
    expect(fractional.ok ? '' : fractional.error.message).toMatch(/must be an integer/);
    // A stage takes only the parameters it reads.
    expect(Object.keys((TOOLS.find((t) => t.name === 'assemble')!).inputShape)).toEqual(expect.arrayContaining(['anchor', 'reducer', 'soft_target_frac', 'summaries']));
    expect(Object.keys((TOOLS.find((t) => t.name === 'assemble')!).inputShape)).not.toContain('w_relevance');
    expect(Object.keys((TOOLS.find((t) => t.name === 'evict')!).inputShape)).toEqual(expect.arrayContaining(['anchor', 'top_k', 'w_relevance', 'protection']));
  });
});

describe('fetch with a budget', () => {
  it('shrinks a full read with the reducer assembly uses', async () => {
    const ctx = seed(2, 3000);
    const unit = unwrap(await contextUnits(ctx, {})).units[1]!;
    const args = { branch_id: unit.phase_id, from: unit.from_seq, to: unit.to_seq };
    const full = unwrap(await contextFetch(ctx, args));
    const small = unwrap(await contextFetch(ctx, { ...args, budget_tokens: 500, query: 'turn0word42' }));
    expect(small.text.length).toBeLessThan(full.text.length / 4);
    expect(small.text).toContain('turn0word42');
  });
});

describe('HTTP transport', () => {
  async function api(ctx: ToolContext, extra: Partial<Parameters<typeof createHttpApi>[0]> = {}): Promise<{ call: (name: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; json: any }>; get: (path: string) => Promise<any> }> {
    const http = await createHttpApi({ ctx, port: 0, ...extra });
    apis.push(http);
    const base = `http://127.0.0.1:${String(http.port)}/v1`;
    return {
      call: async (name, body, headers = {}) => {
        const res = await fetch(`${base}/tools/${name}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
        return { status: res.status, json: await res.json() };
      },
      get: async (path) => (await fetch(`${base}/${path}`)).json(),
    };
  }

  it('lists the registry with JSON schemas, and the parameters with this server\'s values', async () => {
    const { get } = await api(seed(8, 400, { anchor: 2 }));
    const { tools } = await get('tools');
    expect(tools.map((t: { name: string }) => t.name).sort()).toEqual(TOOLS.map((t) => t.name).sort());
    expect(tools.find((t: { name: string }) => t.name === 'evict').input_schema.required).toContain('window_tokens');
    const { params } = await get('params');
    expect(params.find((p: { key: string }) => p.key === 'anchor')).toMatchObject({ value: 2, default: 4, env: 'CT_CT_ANCHOR' });
  });

  it('shares ONE session with direct (MCP-side) handler calls', async () => {
    const ctx = seed();
    const { call } = await api(ctx);
    const total = (await call('units')).json.data.tokens_raw;
    const evicted = (await call('evict', { window_tokens: total / 2 })).json.data.evicted;
    expect(evicted.length).toBeGreaterThan(0);
    expect(unwrap(await contextUnits(ctx, {})).units.filter((u) => u.state === 'drop').map((u) => u.id)).toEqual(evicted);
  });

  it('answers a bad input as a structured outcome, an unknown tool as 404, a bad token as 403', async () => {
    const ctx = seed();
    const open = await api(ctx);
    expect((await open.call('evict', {})).json).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect((await open.call('verdicts', {})).status).toBe(404);
    const locked = await api(ctx, { token: 's3cret' });
    expect((await locked.call('units', {})).status).toBe(403);
    expect((await locked.call('units', {}, { authorization: 'Bearer s3cret' })).status).toBe(200);
  });

  it('a stage is swapped behind its name', async () => {
    const tools = withHandlers({ classify: async () => ({ ok: true, data: { swapped: true } }) });
    const { call } = await api(seed(), { tools });
    expect((await call('classify')).json).toEqual({ ok: true, data: { swapped: true } });
    expect(() => withHandlers({ nope: async () => ({ ok: true, data: null }) })).toThrow(/no such tool/);
  });
});
