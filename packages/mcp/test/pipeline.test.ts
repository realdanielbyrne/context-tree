/**
 * The pipeline stages as tools, and the HTTP transport. What these protect: eviction
 * is sticky (a policy that does not call evict leaves the prompt alone), both
 * transports are one registry over one session, and a stage can be swapped behind
 * its name.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TreeRetriever, ingest, openTaskStore, resolveConfig, type NodeId, type TaskStore } from '@context-tree/core';
import {
  PIPELINE_DEFAULTS,
  TOOLS,
  contextAssemble,
  contextClassify,
  contextEvict,
  contextReduce,
  contextRestore,
  contextUnits,
  contextVerdicts,
  createHttpApi,
  createSession,
  pipelineFromEnv,
  planVerdicts,
  withHandlers,
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

/** `phases` alternating read/edit phases, each carrying ~`words` distinct words. */
function seed(phases = 8, words = 400): { ctx: ToolContext; ranges: Map<string, { start: number; end: number }> } {
  const root = mkdtempSync(join(tmpdir(), 'ct-pipe-'));
  temps.push(root);
  const config = resolveConfig({ root, taskTitle: 'pipeline fixture' });
  const handle = openTaskStore(config);
  handles.push(handle);
  const { trace, blobs } = handle;
  const ranges = new Map<string, { start: number; end: number }>();
  trace.append({ type: 'user_message', ts: TS, blob: blobs.put('fix the bug') });
  ranges.set('m0', { start: 1, end: 1 });
  for (let p = 0; p < phases; p += 1) {
    const body = Array.from({ length: words }, (_, w) => `phase${String(p)}word${String(w)}`).join(' ');
    const tool = p % 2 === 0 ? 'Read' : 'Edit';
    const call = trace.append({ type: 'tool_call', ts: TS, tool, path: `src/f${String(p)}.ts`, ...(tool === 'Edit' ? { blob: blobs.put(body) } : { args_blob: blobs.put('{}') }) });
    const result = trace.append({ type: 'tool_result', ts: TS, call_seq: call.seq, output_blob: blobs.put(body) });
    ranges.set(`m${String(p + 1)}`, { start: call.seq, end: result.seq });
  }
  ingest({ handle });
  const retriever = new TreeRetriever({ store: handle.store, blobs, trace });
  return { ctx: { config, handle, retriever, session: createSession() }, ranges };
}

function unwrap<T>(outcome: ToolOutcome<T>): T {
  if (!outcome.ok) throw new Error(`${outcome.error.code}: ${outcome.error.message}`);
  return outcome.data;
}

describe('units / classify', () => {
  it('lists one unit per phase, sized in heuristic tokens, with the recency anchor marked', async () => {
    const { ctx } = seed();
    const data = unwrap(await contextUnits(ctx, {}));
    expect(data.units).toHaveLength(8);
    expect(data.units.every((u) => u.tokens > 300 && !u.evicted)).toBe(true);
    expect(data.anchor).toBe(PIPELINE_DEFAULTS.anchor);
    expect(data.units.map((u) => u.anchored)).toEqual([false, false, false, false, true, true, true, true]);
    expect(data.live_tokens).toBe(data.total_tokens);
  });

  it('classifying twice does not count the same observation twice', async () => {
    const { ctx } = seed();
    const first = unwrap(await contextClassify(ctx, {}));
    const second = unwrap(await contextClassify(ctx, {}));
    expect(second).toEqual(first);
    expect(first.units).toHaveLength(8);
    expect(first.units.every((u) => u.dormancy >= 0 && u.dormancy <= 1)).toBe(true);
  });
});

describe('evict / restore', () => {
  it('does nothing while the live units fit', async () => {
    const { ctx } = seed();
    const data = unwrap(await contextEvict(ctx, { window_tokens: 1_000_000 }));
    expect(data).toMatchObject({ fired: false, evicted: [], applied: true, evicted_total: 0 });
  });

  it('evicts down to the window, never touching the anchor, and the eviction STICKS', async () => {
    const { ctx } = seed();
    const before = unwrap(await contextUnits(ctx, {}));
    const window = Math.round(before.total_tokens * 0.7);
    const evict = unwrap(await contextEvict(ctx, { window_tokens: window }));
    expect(evict.fired).toBe(true);
    expect(evict.live_tokens_after).toBeLessThanOrEqual(window);
    const anchored = before.units.filter((u) => u.anchored).map((u) => u.node_id);
    for (const id of evict.evicted) expect(anchored).not.toContain(id);

    // No further call: the units are still out. A cadence's off turn is exactly this.
    const after = unwrap(await contextUnits(ctx, {}));
    expect(after.units.filter((u) => u.evicted).map((u) => u.node_id).sort()).toEqual([...evict.evicted].sort());
    // And a second evict at the same window has nothing left to do.
    expect(unwrap(await contextEvict(ctx, { window_tokens: window })).fired).toBe(false);
  });

  it('dry_run reports and changes nothing; anchor is an argument', async () => {
    const { ctx } = seed();
    const total = unwrap(await contextUnits(ctx, {})).total_tokens;
    const dry = unwrap(await contextEvict(ctx, { window_tokens: total / 2, dry_run: true }));
    expect(dry.fired && !dry.applied).toBe(true);
    expect(unwrap(await contextUnits(ctx, {})).units.some((u) => u.evicted)).toBe(false);

    // With every unit anchored, nothing is evictable at any window.
    expect(unwrap(await contextEvict(ctx, { window_tokens: total / 2, anchor: 8, dry_run: true })).evicted).toEqual([]);
    expect(unwrap(await contextEvict(ctx, { window_tokens: total / 2, anchor: 0, dry_run: true })).evicted.length).toBeGreaterThan(dry.evicted.length - 1);
  });

  it('restore brings units back, by id or all at once', async () => {
    const { ctx } = seed();
    const total = unwrap(await contextUnits(ctx, {})).total_tokens;
    const { evicted } = unwrap(await contextEvict(ctx, { window_tokens: total / 2 }));
    expect(evicted.length).toBeGreaterThan(1);
    expect(unwrap(await contextRestore(ctx, { node_ids: [evicted[0]!] }))).toEqual({ restored: [evicted[0]], evicted_total: evicted.length - 1 });
    expect(unwrap(await contextRestore(ctx, { all: true })).evicted_total).toBe(0);
    expect((await contextRestore(ctx, {})).ok).toBe(false);
  });

  it('rejects a reserve that leaves no window', async () => {
    const { ctx } = seed();
    const outcome = await contextEvict(ctx, { window_tokens: 100, reserve_tokens: 100 });
    expect(outcome.ok).toBe(false);
  });
});

describe('reduce / assemble', () => {
  it('reduces one unit to a budget without changing anything', async () => {
    const { ctx } = seed();
    const unit = unwrap(await contextUnits(ctx, {})).units[2]!;
    const data = unwrap(await contextReduce(ctx, { node_id: unit.node_id, budget_tokens: 100, query: 'phase2word7' }));
    expect(data.original_tokens).toBe(unit.tokens);
    expect(data.tokens).toBeLessThanOrEqual(100);
    expect(data.tokens).toBeGreaterThan(0);
    const bad = await contextReduce(ctx, { node_id: 'nope', budget_tokens: 10 });
    expect(bad.ok ? '' : bad.error.code).toBe('unknown_node');
  });

  it('assemble reports the composed prompt and commits nothing', async () => {
    const { ctx } = seed();
    const total = unwrap(await contextUnits(ctx, {})).total_tokens;
    const data = unwrap(await contextAssemble(ctx, { window_tokens: total / 2, query: 'phase3word9', top_k: 2 }));
    // The layout may shrink units in place instead of evicting — that is its business.
    expect(data.evicted.length + data.reduced.length).toBeGreaterThan(0);
    expect(data.budgets.total).toBeLessThanOrEqual(total);
    expect(data.blocks.some((b) => b.zone === 'tail')).toBe(true);
    expect(data.blocks.every((b) => !('text' in b))).toBe(true);
    expect(unwrap(await contextUnits(ctx, {})).units.some((u) => u.evicted)).toBe(false);
  });
});

describe('verdicts', () => {
  const messages = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `m${String(i)}`, tokens: 100, hasTools: i > 0 }));

  it('keeps everything until an adapter publishes a message index, and says so', async () => {
    const { ctx } = seed();
    const total = unwrap(await contextUnits(ctx, {})).total_tokens;
    await contextEvict(ctx, { window_tokens: total / 2 });
    const data = unwrap(await contextVerdicts(ctx, { messages: messages(9) }));
    expect(data.indexed).toBe(false);
    expect(data.decisions.every((d) => d.action === 'keep')).toBe(true);
  });

  it('drops the messages of evicted units; the task statement and the tail are protected', async () => {
    const { ctx, ranges } = seed();
    ctx.session!.messageIndex = ranges;
    const total = unwrap(await contextUnits(ctx, {})).total_tokens;
    const { evicted } = unwrap(await contextEvict(ctx, { window_tokens: total / 2 }));
    const data = unwrap(await contextVerdicts(ctx, { messages: messages(9), protect_tail: 2, turn: 5 }));
    expect(data.turn).toBe(5);
    expect(data.decisions[0]).toEqual({ id: 'm0', action: 'keep' });
    expect(data.decisions.slice(-2).every((d) => d.action === 'keep')).toBe(true);
    const dropped = data.decisions.filter((d) => d.action === 'drop');
    expect(dropped.length).toBe(evicted.length);
    expect(data.kept_tokens).toBe(data.total_tokens - 100 * dropped.length);
  });

  it('shrinks the protected tail when the ceiling would otherwise be breached', async () => {
    const { ctx, ranges } = seed();
    ctx.session!.messageIndex = ranges;
    const total = unwrap(await contextUnits(ctx, {})).total_tokens;
    await contextEvict(ctx, { window_tokens: total / 3, anchor: 0 });
    const loose = unwrap(await contextVerdicts(ctx, { messages: messages(9), protect_tail: 8 }));
    const tight = unwrap(await contextVerdicts(ctx, { messages: messages(9), protect_tail: 8, ceiling_tokens: 500 }));
    expect(tight.escalations).toBeGreaterThan(0);
    expect(tight.kept_tokens).toBeLessThan(loose.kept_tokens);
  });

  it('folds only a text-only message, once per unit, and records a fold the shape refused', () => {
    const index = new Map([['a', { start: 1, end: 1 }], ['b', { start: 2, end: 3 }], ['c', { start: 4, end: 5 }], ['d', { start: 9, end: 9 }]]);
    const spans = [{ nodeId: 'u1' as NodeId, start: 2, end: 5, summary: 'S' }];
    const out = planVerdicts([{ id: 'a' }, { id: 'b', hasTools: true }, { id: 'c' }, { id: 'd' }], index, spans, 1, true);
    expect(out).toEqual([
      { id: 'a', action: 'keep' },
      { id: 'b', action: 'drop', unit: 'u1', foldWanted: true },
      { id: 'c', action: 'fold', text: 'S' },
      { id: 'd', action: 'keep' },
    ]);
  });
});

describe('server defaults from the environment', () => {
  it('reads every provisional value, and refuses one that does not parse', () => {
    const p = pipelineFromEnv({ CT_CT_ANCHOR: '3', CT_CT_W_DORMANCY: '2.5', CT_CT_REDUCER: 'summarize', CT_CT_DRIFT_K: '7' });
    expect(p).toMatchObject({ anchor: 3, reducer: 'summarize', driftK: 7 });
    expect(p.weights).toEqual({ ...PIPELINE_DEFAULTS.weights, dormancy: 2.5 });
    expect(pipelineFromEnv({})).toEqual(PIPELINE_DEFAULTS);
    expect(() => pipelineFromEnv({ CT_CT_ANCHOR: 'three' })).toThrow(/CT_CT_ANCHOR/);
    expect(() => pipelineFromEnv({ CT_CT_ANCHOR: '2.5' })).toThrow(/integer/);
    expect(() => pipelineFromEnv({ CT_CT_REDUCER: 'magic' })).toThrow(/CT_CT_REDUCER/);
  });

  it('the session default is what a tool falls back to', async () => {
    const { ctx } = seed();
    ctx.session = createSession({ ...PIPELINE_DEFAULTS, anchor: 2 });
    expect(unwrap(await contextUnits(ctx, {})).units.filter((u) => u.anchored)).toHaveLength(2);
  });
});

describe('HTTP transport', () => {
  async function api(ctx: ToolContext, extra: Partial<Parameters<typeof createHttpApi>[0]> = {}): Promise<{ call: (name: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; json: any }>; port: number }> {
    const http = await createHttpApi({ ctx, port: 0, ...extra });
    apis.push(http);
    const call = async (name: string, body?: unknown, headers: Record<string, string> = {}) => {
      const res = await fetch(`http://127.0.0.1:${String(http.port)}/v1/tools${name === '' ? '' : `/${name}`}`, body === undefined && name === '' ? { headers } : { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
      return { status: res.status, json: await res.json() };
    };
    return { call, port: http.port };
  }

  it('lists the registry with JSON schemas, including the host-only tool', async () => {
    const { ctx } = seed();
    const { call } = await api(ctx);
    const { json } = await call('');
    expect(json.tools.map((t: { name: string }) => t.name).sort()).toEqual(TOOLS.map((t) => t.name).sort());
    const evict = json.tools.find((t: { name: string }) => t.name === 'evict');
    expect(evict.input_schema.required).toContain('window_tokens');
  });

  it('shares ONE session with direct (MCP-side) handler calls', async () => {
    const { ctx } = seed();
    const { call } = await api(ctx);
    const total = (await call('units')).json.data.total_tokens;
    const evicted = (await call('evict', { window_tokens: total / 2 })).json.data.evicted;
    expect(evicted.length).toBeGreaterThan(0);
    // Seen from the other transport's side of the same context:
    expect(unwrap(await contextUnits(ctx, {})).units.filter((u) => u.evicted).map((u) => u.node_id).sort()).toEqual([...evicted].sort());
  });

  it('answers a bad input as a structured outcome, an unknown tool as 404, a bad token as 403', async () => {
    const { ctx } = seed();
    const open = await api(ctx);
    expect((await open.call('evict', {})).json).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect((await open.call('nope', {})).status).toBe(404);
    const locked = await api(ctx, { token: 's3cret' });
    expect((await locked.call('units', {})).status).toBe(403);
    expect((await locked.call('units', {}, { authorization: 'Bearer s3cret' })).status).toBe(200);
  });

  it('a stage is swapped behind its name', async () => {
    const { ctx } = seed();
    const tools = withHandlers({ classify: async () => ({ ok: true, data: { swapped: true } }) });
    const { call } = await api(ctx, { tools });
    expect((await call('classify')).json).toEqual({ ok: true, data: { swapped: true } });
    expect(() => withHandlers({ nope: async () => ({ ok: true, data: null }) })).toThrow(/no such tool/);
  });
});
