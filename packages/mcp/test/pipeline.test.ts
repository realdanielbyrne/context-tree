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
  contextFold,
  contextPeek,
  contextSearch,
  contextRestore,
  contextSummarize,
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

  it('evict deletes at the FOLDED size: a folded unit is cheap to keep, and evict writes no fold', async () => {
    const ctx = seed();
    const total = unwrap(await contextUnits(ctx, {})).tokens_raw;
    const folded = unwrap(await contextFold(ctx, { window_tokens: total / 2, g_fold: 0.01 }));
    expect(folded.fired).toBe(true);
    expect(folded.tokens_after).toBeLessThanOrEqual(total / 2);
    const after = unwrap(await contextEvict(ctx, { window_tokens: total / 2, dry_run: true }));
    expect(after.fired).toBe(false);
    expect(unwrap(await contextUnits(ctx, {})).folds.every((f) => f.kind === 'stub')).toBe(true);
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
    const only = unwrap(await contextFetch(ctx, { from_seq: unit.from_seq, to_seq: unit.to_seq, part: 'reasoning' }));
    expect(only.text).toContain('zebraquux');
    expect(only.text).not.toContain('Stale fixture.');
    const peeked = unwrap(await contextPeek(ctx, { node_id: unit.phase_id, max_chars: 4000 }));
    expect(peeked.text).toContain('zebraquux');
  });

  it('fetch takes exactly one of branch_id, stub, or a seq range', async () => {
    const ctx = seed();
    expect((await contextFetch(ctx, {})).ok).toBe(false);
    expect((await contextFetch(ctx, { stub: 999 })).ok).toBe(false);
    expect(unwrap(await contextFetch(ctx, { stub: 2 })).text).toContain('turn0word0');
    expect(unwrap(await contextFetch(ctx, { from_seq: 2, to_seq: 3 })).text).toContain('turn0word0');
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
    const reduced = decisions!.find((d) => d.action === 'edit');
    expect(reduced).toMatchObject({ id: 'm1', unit: 'turn:2' });
    const output = reduced?.action === 'edit' ? reduced.edits[0]! : null;
    expect(output).toMatchObject({ part: 'tool', index: 0 });
    expect((output as { text: string }).text.length).toBeLessThan(3000 * 8);
    expect((output as { text: string }).text).toContain('turn0word');
  });
});

describe('folds (D26, D27): one pull folds, unfolds and asks for summaries; summarize writes them', () => {
  const meta = { files: [{ path: 'src/a.ts', start_line: 1, end_line: 2 }], symbols: [], tests: [], artifacts: [], open_questions: [], decisions: [], node_ids: [] };
  const provider = (text: string) => ({ id: 'fake', complete: async () => ({ text: JSON.stringify({ text, meta }), model: 'fake-m', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, toolCalls: [], stopReason: 'stop' }) });

  it('a fold is a ledger event: sticky, byte-stable, rendered as part edits, and fetchable by its stub id', async () => {
    const ctx = seed(6, 400);
    const total = unwrap(await contextUnits(ctx, {})).tokens_raw;
    const first = unwrap(await contextFold(ctx, { window_tokens: total / 2, g_fold: 0.01, messages: messages(7) }));
    expect(first.folded.length).toBeGreaterThan(0);
    const edit = first.decisions!.find((d) => d.action === 'edit') as { id: string; edits: { part: string; index?: number; text: string | null }[] };
    expect(edit.edits[0]).toMatchObject({ part: 'tool', index: 0 });
    expect(edit.edits[0]!.text).toMatch(/^\[folded · \d+ tokens · began: "turn\d+word0 .*recall: fetch \{"stub":\d+\}\]$/);
    const stub = Number(/"stub":(\d+)/.exec(edit.edits[0]!.text!)![1]);
    expect(unwrap(await contextFetch(ctx, { stub })).text).toContain('word399');
    // The next turn: nothing new folds, the same edit is rendered from the ledger.
    const again = unwrap(await contextFold(ctx, { window_tokens: total / 2, g_fold: 0.01, messages: messages(7) }));
    expect(again.fired).toBe(false);
    expect(again.decisions!.find((d) => d.id === edit.id)).toEqual(first.decisions!.find((d) => d.id === edit.id));
    expect(ctx.handle.trace.all().filter((e) => e.type === 'fold')).toHaveLength(first.folded.length);
    // restore unfolds by fold id; the record stays.
    const foldId = unwrap(await contextUnits(ctx, {})).folds[0]!.id;
    expect(unwrap(await contextRestore(ctx, { ids: [foldId] })).restored).toEqual([foldId]);
    expect(unwrap(await contextUnits(ctx, {})).folds.map((f) => f.id)).not.toContain(foldId);
    expect(ctx.handle.trace.all().filter((e) => e.type === 'fold')).toHaveLength(first.folded.length);
  });

  it('nothing folds at infinite breakpoints; thinking folds under the same pull as everything else, to its tagged tail', async () => {
    const ctx = seed(4, 100);
    const { trace, blobs } = ctx.handle;
    trace.append({ type: 'reasoning', ts: TS, blob: blobs.put(Array.from({ length: 300 }, (_, i) => `thought ${String(i)}`).join('\n')), turn_id: 'm5' });
    const c = trace.append({ type: 'tool_call', ts: TS, tool: 'Read', path: 'src/z.ts', args_blob: blobs.put('{}'), turn_id: 'm5' });
    trace.append({ type: 'tool_result', ts: TS, call_seq: c.seq, output_blob: blobs.put('z'), turn_id: 'm5' });
    for (const id of ['m6', 'm7']) {
      const k = trace.append({ type: 'tool_call', ts: TS, tool: 'Read', path: 'src/y.ts', args_blob: blobs.put('{}'), turn_id: id });
      trace.append({ type: 'tool_result', ts: TS, call_seq: k.seq, output_blob: blobs.put('y'), turn_id: id });
    }
    ingest({ handle: ctx.handle });
    expect(unwrap(await contextFold(ctx, { window_tokens: 10 })).fired).toBe(false);
    const total = unwrap(await contextUnits(ctx, {})).tokens_raw;
    const pulled = unwrap(await contextFold(ctx, { window_tokens: total, g_fold: 0.001, messages: messages(8) }));
    const edit = pulled.decisions!.find((d) => d.id === 'm5') as { edits: { part: string; text: string | null }[] };
    const thinking = edit.edits.find((x) => x.part === 'reasoning')!;
    expect(thinking.text).toMatch(/^\[folded thinking · \d+ tokens · recall: fetch \{"stub":\d+\}\]\n/);
    expect(thinking.text).toContain('thought 299');
  });

  it('a folded block comes back when the pull falls below the lower breakpoint; refolded, it is byte-identical', async () => {
    const ctx = seed(6, 400);
    const total = unwrap(await contextUnits(ctx, {})).tokens_raw;
    const tight = unwrap(await contextFold(ctx, { window_tokens: total / 2, g_fold: 0.01, messages: messages(7), turn: 1 }));
    expect(tight.folded.length).toBeGreaterThan(0);
    const loose = unwrap(await contextFold(ctx, { window_tokens: total * 20, g_fold: 0.01, g_unfold: 0.005, messages: messages(7), turn: 2 }));
    expect(loose.unfolded.length).toBeGreaterThan(0);
    expect(loose.d_after).toBeGreaterThan(0.9);
    expect(ctx.handle.trace.all().filter((e) => e.type === 'unfold')).toHaveLength(loose.unfolded.length);
    expect(loose.decisions!.filter((d) => d.action === 'edit').length).toBeLessThan(tight.decisions!.filter((d) => d.action === 'edit').length);
    const refold = unwrap(await contextFold(ctx, { window_tokens: total / 2, g_fold: 0.01, messages: messages(7), turn: 3 }));
    const was = tight.decisions!.find((d) => d.action === 'edit')!;
    expect(refold.decisions!.find((d) => d.id === was.id)).toEqual(was);
  });

  it('adaptive κ falls when the model repeats itself and rises after the fit guarantee', async () => {
    const ctx = seed(6, 400);
    const total = unwrap(await contextUnits(ctx, {})).tokens_raw;
    const k0 = unwrap(await contextFold(ctx, { window_tokens: total, gravity_mode: 'adaptive', turn: 1 })).kappa;
    const { trace, blobs } = ctx.handle;
    for (const id of ['m7', 'm8']) {
      const k = trace.append({ type: 'tool_call', ts: TS, tool: 'bash', command: 'grep -rn Date django', args_blob: blobs.put('{"command":"grep -rn Date django"}'), turn_id: id });
      trace.append({ type: 'tool_result', ts: TS, call_seq: k.seq, output_blob: blobs.put(''), turn_id: id });
    }
    ingest({ handle: ctx.handle });
    const starved = unwrap(await contextFold(ctx, { window_tokens: total, gravity_mode: 'adaptive', turn: 2 }));
    expect(starved.signals?.repeat).toBeGreaterThan(0);
    expect(starved.kappa).toBeLessThan(k0);
    unwrap(await contextEvict(ctx, { window_tokens: total / 3, gravity_mode: 'adaptive', turn: 2 }));
    // Rerunning the tests after an edit is work, not a repeat: same call, different result.
    for (const [id, out] of [['m9', '1 failed'], ['m10', '1 passed']]) {
      const k = trace.append({ type: 'tool_call', ts: TS, tool: 'bash', command: 'pytest t.py', args_blob: blobs.put('{"command":"pytest t.py"}'), turn_id: id });
      trace.append({ type: 'tool_result', ts: TS, call_seq: k.seq, output_blob: blobs.put(out), turn_id: id });
    }
    ingest({ handle: ctx.handle });
    const after = unwrap(await contextFold(ctx, { window_tokens: total, gravity_mode: 'adaptive', turn: 3 }));
    expect(after.signals?.repeat).toBe(0);
    expect(after.signals?.overflow).toBe(1);
    expect(after.kappa).toBeGreaterThan(starved.kappa);
  });

  it('fold asks for a summary over a run of folded blocks the pull reaches; summarize writes it; the view shows it through a carrier', async () => {
    const ctx = seed(6, 400);
    ctx.summarizer = { provider: provider('Read and edited f0..f3.'), model: 'fake-m' };
    const total = unwrap(await contextUnits(ctx, {})).tokens_raw;
    const asked = unwrap(await contextFold(ctx, { window_tokens: total / 3, g_fold: 0.01, g_summarize: 0 }));
    expect(asked.summary_requests.length).toBeGreaterThan(0);
    const req = asked.summary_requests[0]!;
    const written = unwrap(await contextSummarize(ctx, { from_stub: req.from_stub, to_stub: req.to_stub, trigger: 'test' }));
    expect(written.status).toBe('written');
    const units = unwrap(await contextUnits(ctx, {}));
    expect(units.folds.some((f) => f.kind === 'summary')).toBe(true);
    const states = units.units.flatMap((u) => u.blocks.map((b) => b.state));
    expect(states).toContain('carrier');
    expect(states).toContain('covered');
    expect(unwrap(await contextFold(ctx, { window_tokens: total / 3, g_fold: 0.01, g_summarize: 0 })).summary_requests.some((r) => r.from_seq === req.from_seq && r.to_seq === req.to_seq)).toBe(false);
    const { decisions } = unwrap(await contextAssemble(ctx, { window_tokens: total / 3, messages: messages(7) }));
    const line = decisions!.flatMap((d) => (d.action === 'edit' ? d.edits : [])).find((e) => typeof e.text === 'string' && e.text.startsWith('[summary '));
    // Files come from the tree (D9), never from the reply's meta.
    expect(line?.text).toMatch(/^\[summary m\d+ · Read and edited f0\.\.f3\. · files: src\/f\d\.ts.* · recall: fetch \{"from_seq":\d+,"to_seq":\d+\}\]$/);
    expect(line?.text).not.toContain('src/a.ts');
    // The well releases it: once every covered block is pulled below g_unsummarize, the summary retires.
    const released = unwrap(await contextFold(ctx, { window_tokens: total * 50, g_unsummarize: 1e9 }));
    expect(released.unsummarized.length).toBeGreaterThan(0);
    expect(unwrap(await contextUnits(ctx, {})).folds.some((f) => f.kind === 'summary')).toBe(false);
  });

  it('evict deletes by the pull once a unit reaches g_delete, never a pinned one, then fits the rest', async () => {
    const ctx = seed(8, 400);
    const total = unwrap(await contextUnits(ctx, {})).tokens_raw;
    const out = unwrap(await contextEvict(ctx, { window_tokens: total * 0.9, g_delete: 0.01 }));
    expect(out.deleted_by_pull.length).toBeGreaterThan(0);
    expect(out.evicted).toEqual(expect.arrayContaining(out.deleted_by_pull));
    expect(out.evicted).not.toContain(unwrap(await contextUnits(ctx, {})).units.at(-1)!.id);
    expect(out.tokens_after).toBeLessThanOrEqual(total * 0.9);
  });

  it('summarize is unavailable without a provider and rejects a summary over the ratio', async () => {
    const ctx = seed(2, 100);
    expect((await contextSummarize(ctx, { from_stub: 1, to_stub: 2 })).ok).toBe(false);
    ctx.summarizer = { provider: provider('word '.repeat(3000)), model: 'fake-m' };
    expect(unwrap(await contextSummarize(ctx, { from_stub: 1, to_stub: 3 })).status).toBe('rejected');
    expect(unwrap(await contextUnits(ctx, {})).folds).toHaveLength(0);
  });
});

describe('the parameter registry', () => {
  it('is the single source: env, defaults, tool arguments and /v1/params all derive from it', () => {
    const p = pipelineFromEnv({ CT_CT_ANCHOR: '3', CT_CT_W_DORMANCY: '2.5', CT_CT_REDUCER: 'summarize', CT_CT_G_FOLD: '0.5', CT_CT_G_DELETE: 'Infinity', CT_CT_GRAVITY_MODE: 'adaptive', CT_CT_UNIT: 'phase', CT_CT_TOPK: '9' });
    expect(p).toMatchObject({ anchor: 3, wDormancy: 2.5, reducer: 'summarize', gFold: 0.5, gDelete: Number.POSITIVE_INFINITY, gravityMode: 'adaptive', unit: 'phase', topK: 9 });
    expect(pipelineFromEnv({})).toEqual(PIPELINE_DEFAULTS);
    const described = describeParams(p);
    expect(described.map((d) => d.key)).toEqual(PIPELINE_PARAMS.map((s) => s.key));
    expect(described.find((d) => d.key === 'anchor')).toMatchObject({ env: 'CT_CT_ANCHOR', argument: 'anchor', value: 3, stages: ['assemble', 'fold', 'evict'] });
    expect(described.find((d) => d.key === 'chunkSize')?.argument).toBeNull();
    expect(new Set(PIPELINE_PARAMS.map((s) => s.env)).size).toBe(PIPELINE_PARAMS.length);
  });

  it('refuses a value that does not parse — from the environment and from a tool call alike', async () => {
    for (const env of [{ CT_CT_ANCHOR: 'three' }, { CT_CT_ANCHOR: '2.5' }, { CT_CT_REDUCER: 'magic' }, { CT_CT_GRAVITY_MODE: 'magic' }, { CT_CT_G_FOLD: '-1' }, { CT_CT_ANCHOR: 'Infinity' }, { CT_CT_PRIORITY_HALFLIFE: '0' }, { CT_CT_SOFT_TARGET_FRAC: '1.5' }]) {
      expect(() => pipelineFromEnv(env), JSON.stringify(env)).toThrow(/pipeline misconfigured/);
    }
    const bad = await contextEvict(seed(), { window_tokens: 1000, anchor: -1 });
    expect(bad.ok ? '' : bad.error.code).toBe('invalid_input');
    // The message names the actual violation, not a generic one.
    expect(bad.ok ? '' : bad.error.message).toMatch(/anchor: must be >= 0/);
    const fractional = await contextEvict(seed(), { window_tokens: 1000, anchor: 2.5 });
    expect(fractional.ok ? '' : fractional.error.message).toMatch(/must be an integer/);
    // A stage takes only the parameters it reads.
    expect(Object.keys((TOOLS.find((t) => t.name === 'assemble')!).inputShape)).toEqual(expect.arrayContaining(['anchor', 'reducer', 'soft_target_frac']));
    expect(Object.keys((TOOLS.find((t) => t.name === 'assemble')!).inputShape)).not.toContain('w_relevance');
    expect(Object.keys((TOOLS.find((t) => t.name === 'evict')!).inputShape)).toEqual(expect.arrayContaining(['anchor', 'top_k', 'w_relevance', 'protection', 'g_delete', 'gravity_k']));
    expect(Object.keys((TOOLS.find((t) => t.name === 'fold')!).inputShape)).toEqual(expect.arrayContaining(['g_fold', 'g_unfold', 'g_summarize', 'g_unsummarize', 'gravity_k', 'gravity_mode', 'w_priority']));
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
