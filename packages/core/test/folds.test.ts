import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig } from '../src/config.js';
import { ingest, openTaskStore, type TaskStore } from '../src/ingest/index.js';
import { HeuristicTokenizer } from '../src/tokens/index.js';
import {
  adaptKappa, blocksOf, distanceOf, foldView, foldsFrom, irrelevanceOf, planDeletions, planGravity, pullOf, stubOf, tailOf,
  type Breakpoints, type GravityBlock,
} from '../src/segment/index.js';
import { summarizeRange } from '../src/summarize/index.js';

const TS = '2026-09-21T00:00:00.000Z';
const tokenizer = new HeuristicTokenizer();
const STUB = { foldReasoning: 'tail' as const, foldReasoningTail: 20 };

/** user task · [reasoning, text, Read a.ts] · [reasoning, Edit a.ts] — the two shapes a turn takes. */
function fixture(): { handle: TaskStore; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'ct-folds-'));
  const handle = openTaskStore(resolveConfig({ root, taskTitle: 'folds' }));
  const { trace, blobs } = handle;
  const big = (label: string) => Array.from({ length: 120 }, (_, i) => `${label}${String(i)} line`).join('\n');
  trace.append({ type: 'user_message', ts: TS, blob: blobs.put('fix price()'), turn_id: 'u0' });
  trace.append({ type: 'reasoning', ts: TS, blob: blobs.put(`${big('think')}\nSo price() rounds too early.`), turn_id: 'a1' });
  trace.append({ type: 'assistant_message', ts: TS, blob: blobs.put('price() rounds too early. Let me read it.'), turn_id: 'a1' });
  const read = trace.append({ type: 'tool_call', ts: TS, tool: 'Read', path: 'a.ts', args_blob: blobs.put('{"filePath":"a.ts"}'), turn_id: 'a1' });
  trace.append({ type: 'tool_result', ts: TS, call_seq: read.seq, output_blob: blobs.put(big('src')), turn_id: 'a1' });
  trace.append({ type: 'reasoning', ts: TS, blob: blobs.put(`${big('plan')}\nTherefore round at the end.`), turn_id: 'a2' });
  const edit = trace.append({ type: 'tool_call', ts: TS, tool: 'Edit', path: 'a.ts', args_blob: blobs.put('{"filePath":"a.ts","old":"x"}'), blob: blobs.put('y'), turn_id: 'a2' });
  trace.append({ type: 'tool_result', ts: TS, call_seq: edit.seq, output_blob: blobs.put('ok'), turn_id: 'a2' });
  ingest({ handle });
  return { handle, root };
}

describe('blocks (D26): the leaf segments, on natural boundaries inside a turn', () => {
  it('cuts reasoning, text and call+result apart; ordinals are the stub ids; a result joins its call', () => {
    const { handle, root } = fixture();
    try {
      const blocks = blocksOf(handle.trace.all(), handle.blobs, tokenizer);
      expect(blocks.map((b) => [b.stub, b.kind, b.fromSeq, b.toSeq, b.turn.hostId])).toEqual([
        [1, 'text', 1, 1, 'u0'], [2, 'reasoning', 2, 2, 'a1'], [3, 'text', 3, 3, 'a1'], [4, 'tool', 4, 5, 'a1'], [5, 'reasoning', 6, 6, 'a2'], [6, 'tool', 7, 8, 'a2'],
      ]);
      expect(blocks[1]!.followedByText).toBe(true);
      expect(blocks[4]!.followedByText).toBe(false);
      expect(blocks.reduce((n, b) => n + b.tokens, 0)).toBeGreaterThan(0);
    } finally {
      handle.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('stubs: summary-free, and reasoning folds to its own conclusion', () => {
  it('a reasoning block followed by the model\'s text folds to nothing; one without keeps its tail under a tag', () => {
    const { handle, root } = fixture();
    try {
      const events = handle.trace.all();
      const blocks = blocksOf(events, handle.blobs, tokenizer);
      const summarizedByText = stubOf(blocks[1]!, events, handle.blobs, tokenizer, STUB);
      expect(summarizedByText).toEqual({ parts: [{ part: 'reasoning', text: null }], tokens: 0 });
      const alone = stubOf(blocks[4]!, events, handle.blobs, tokenizer, STUB);
      expect(alone.parts[0]!.part).toBe('reasoning');
      expect(alone.parts[0]!.text).toMatch(/^\[folded thinking · \d+ tokens · recall: fetch \{"stub":5\}\]\n/);
      expect(alone.parts[0]!.text).toContain('Therefore round at the end.');
      expect(alone.parts[0]!.text).not.toContain('plan0 line');
      expect(alone.tokens).toBeLessThan(blocks[4]!.tokens / 4);
      // drop keeps none; keep leaves it raw.
      expect(stubOf(blocks[4]!, events, handle.blobs, tokenizer, { ...STUB, foldReasoning: 'drop' }).tokens).toBe(0);
      expect(stubOf(blocks[4]!, events, handle.blobs, tokenizer, { ...STUB, foldReasoning: 'keep' })).toEqual({ parts: [], tokens: blocks[4]!.tokens });
    } finally {
      handle.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a tool block keeps its input and tags its output; a tiny output is left alone', () => {
    const { handle, root } = fixture();
    try {
      const events = handle.trace.all();
      const blocks = blocksOf(events, handle.blobs, tokenizer);
      const read = stubOf(blocks[3]!, events, handle.blobs, tokenizer, STUB);
      expect(read.parts).toEqual([{ part: 'output', text: expect.stringMatching(/^\[folded · \d+ tokens · began: "src0 line" · recall: fetch \{"stub":4\}\]$/) }]);
      expect(read.tokens).toBeLessThan(blocks[3]!.tokens / 4);
      expect(stubOf(blocks[5]!, events, handle.blobs, tokenizer, STUB)).toEqual({ parts: [], tokens: blocks[5]!.tokens });
    } finally {
      handle.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('tailOf keeps the end, on a line boundary', () => {
    expect(tailOf('a\nb\nc', 100, tokenizer)).toBe('a\nb\nc');
    expect(tailOf('first line here\nsecond line here\nthird', 3, tokenizer)).toBe('third');
  });
});

describe('the fold view: summary over stub over raw, overlapping summaries both show', () => {
  it('sizes every block by what it shows; a summary takes the first text block as carrier and hides the rest', () => {
    const { handle, root } = fixture();
    try {
      const events = handle.trace.all();
      const blocks = blocksOf(events, handle.blobs, tokenizer);
      const folds = foldsFrom([
        ...events,
        { seq: 100, ts: TS, type: 'fold', fold_id: 's4', kind: 'stub', from_seq: 4, to_seq: 5, blob: 'sb' },
        { seq: 101, ts: TS, type: 'fold', fold_id: 'm101', kind: 'summary', from_seq: 2, to_seq: 5, blob: 'x' },
        { seq: 102, ts: TS, type: 'fold', fold_id: 'm102', kind: 'summary', from_seq: 3, to_seq: 8, blob: 'y' },
      ]);
      const view = foldView(blocks, folds, {
        stub: () => ({ parts: [{ part: 'output', text: 't' }], tokens: 7 }),
        summary: (f) => ({ text: `sum ${f.id}`, tokens: 5 }),
      });
      expect(view.get(1)).toEqual({ kind: 'raw', tokens: blocks[0]!.tokens });
      expect(view.get(3)).toMatchObject({ kind: 'carrier', fold: 'm101', text: 'sum m101' });
      expect(view.get(2)).toMatchObject({ kind: 'covered', fold: 'm101' });
      expect(view.get(4)).toMatchObject({ kind: 'covered' });
      // The second summary overlaps the first; its carrier is the first free text-or-reasoning block in its range.
      expect(view.get(5)).toMatchObject({ kind: 'carrier', fold: 'm102', text: 'sum m102' });
      expect(view.get(6)).toMatchObject({ kind: 'covered', fold: 'm102' });
    } finally {
      handle.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('gravity (D27): one pull for every block; fold, summarize and their way back are breakpoints on it', () => {
  const INF = Number.POSITIVE_INFINITY;
  const bp = (over: Partial<Breakpoints> = {}): Breakpoints => ({ fold: INF, unfold: 0, summarize: INF, unsummarize: 0, ...over });
  const blk = (stub: number, e: number, raw: number, over: Partial<GravityBlock> = {}): GravityBlock =>
    ({ stub, kind: 'tool', unit: `u${String(stub)}`, e, raw, shown: raw, state: 'raw', residue: 10, pinned: false, ...over });
  const input = (blocks: GravityBlock[], live: number, over: Partial<Breakpoints> = {}, kappa = 1) =>
    ({ budget: 1000, live, kappa, blocks, summaries: [], breakpoints: bp(over) });

  it('the pull rises without bound toward the window and is monotone in irrelevance, size and κ', () => {
    expect(distanceOf(500, 1000)).toBe(0.5);
    expect(distanceOf(1200, 1000)).toBeGreaterThan(0);
    const g = (d: number, m = 0.1, k = 1) => pullOf(k, 1, m, d);
    expect(g(0.1)).toBeGreaterThan(g(0.5));
    expect(g(0.001)).toBeGreaterThan(1e5 * g(1));
    expect(g(0.5, 0.2)).toBeGreaterThan(g(0.5, 0.1));
    expect(g(0.5, 0.1, 2)).toBe(2 * g(0.5, 0.1, 1));
  });

  it('is blind to kind: the same masses give the same plan whatever the blocks are', () => {
    const kinds = ['reasoning', 'text', 'tool'] as const;
    const plan = (rot: number) => planGravity(input([0, 1, 2].map((i) => blk(i + 1, [1, 0.5, 0.2][i]!, 200, { kind: kinds[(i + rot) % 3]! })), 700, { fold: 0.05 }));
    expect(plan(1).folds).toEqual(plan(0).folds);
    expect(plan(2).folds).toEqual(plan(0).folds);
  });

  it('folds nothing while every pull is under the breakpoint, and folding is self-limiting', () => {
    const blocks = [blk(1, 1, 300), blk(2, 0.6, 300), blk(3, 0.3, 300)];
    expect(planGravity(input(blocks, 300, { fold: 10 })).folds).toEqual([]);
    const plan = planGravity(input(blocks, 950, { fold: 2 }));
    // The first fold widens the gap to the window; the next pulls fall below the breakpoint.
    expect(plan.folds[0]).toBe(1);
    expect(plan.folds.length).toBeLessThan(3);
    expect(plan.dAfter).toBeGreaterThan(plan.dBefore);
  });

  it('never folds a pinned or most-relevant block', () => {
    const plan = planGravity(input([blk(1, 1, 300, { pinned: true }), blk(2, 0, 300), blk(3, 1, 300)], 990, { fold: 0 }));
    expect(plan.folds).toEqual([3]);
  });

  it('unfolds a folded block once its pull falls below the lower breakpoint, not between the two', () => {
    const folded = (e: number) => blk(1, e, 400, { state: 'stub', shown: 20, residue: null });
    const other = blk(2, 0.5, 100);
    const d = (live: number) => distanceOf(live, 1000);
    // The pull on the folded block with the window far away:
    const m = (0.2 * 400) / 1000;
    const M = m + (0.5 * 100) / 1000;
    const g = pullOf(1, M, m, d(120 + 380));
    expect(planGravity(input([folded(0.2), other], 120, { fold: g * 4, unfold: g * 2 })).unfolds).toEqual([1]);
    expect(planGravity(input([folded(0.2), other], 120, { fold: g * 4, unfold: g / 2 })).unfolds).toEqual([]);
  });

  it('an unfold that would be pulled straight back, or overflow the budget, is skipped', () => {
    const b = blk(1, 1, 900, { state: 'stub', shown: 20, residue: null });
    expect(planGravity(input([b], 200, { fold: 1e9, unfold: 1e9 })).unfolds).toEqual([]);
  });

  it('asks for a summary over a run of two or more folded blocks the pull reaches, never one already covered; and releases a summary', () => {
    const st = (stub: number, e: number) => blk(stub, e, 300, { state: 'stub', shown: 20, residue: null });
    const blocks = [st(1, 1), st(2, 1), blk(3, 0, 300), st(4, 1)];
    const plan = planGravity(input(blocks, 700, { summarize: 0.01 }));
    expect(plan.summarize).toEqual([{ fromStub: 1, toStub: 2 }]);
    const covered = planGravity({ ...input(blocks, 700, { summarize: 0.01 }), summaries: [{ id: 'm9', stubs: [1, 2] }] });
    expect(covered.summarize).toEqual([]);
    const release = planGravity({ ...input(blocks, 100, { unsummarize: 1e9 }), summaries: [{ id: 'm9', stubs: [1, 2] }] });
    expect(release.unsummarize).toEqual(['m9']);
  });

  it('irrelevance is 1 − score, min-max over the unpinned units; pinned is 0', () => {
    expect(irrelevanceOf([3, 1, 2, 9], [false, false, false, true])).toEqual([0, 1, 0.5, 0]);
    expect(irrelevanceOf([2, 2], [false, false])).toEqual([0, 0]);
  });

  it('the delete rung takes the most-pulled units first and stops when the pull no longer reaches', () => {
    const units = [{ id: 'a', e: 1, raw: 400, shown: 400, pinned: false }, { id: 'b', e: 0.1, raw: 400, shown: 400, pinned: false }, { id: 'p', e: 1, raw: 400, shown: 400, pinned: true }];
    expect(planDeletions(units, { budget: 1000, live: 950, kappa: 1, mass: 1, gDelete: INF }).deleted).toEqual([]);
    expect(planDeletions(units, { budget: 1000, live: 950, kappa: 1, mass: 1, gDelete: 1 }).deleted).toEqual(['a']);
  });

  it('adaptive κ falls on starvation and on thrash, rises on overflow, and stays in bounds', () => {
    const p = { eta: Math.log(2), min: 0.25, max: 4 };
    expect(adaptKappa(1, { starvation: 3, thrash: 0, overflow: 0 }, p)).toBeCloseTo(0.5);
    expect(adaptKappa(1, { starvation: 0, thrash: 1, overflow: 0 }, p)).toBeCloseTo(0.5);
    expect(adaptKappa(1, { starvation: 0, thrash: 0, overflow: 1 }, p)).toBeCloseTo(2);
    expect(adaptKappa(0.25, { starvation: 1, thrash: 1, overflow: 0 }, p)).toBe(0.25);
    expect(adaptKappa(4, { starvation: 0, thrash: 0, overflow: 1 }, p)).toBe(4);
  });
});

describe('summarizeRange: one prompt for any range, accepted only when much smaller than what it summarizes', () => {
  const meta = { files: [], symbols: [], tests: [], artifacts: [], open_questions: [], decisions: [], node_ids: [] };
  const provider = (text: string) => ({ id: 'fake', complete: async () => ({ text: JSON.stringify({ text, meta }), model: 'm', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, toolCalls: [], stopReason: 'stop' }) });

  it('writes a fold event (and the node\'s summary when the range is a node), rejects one over the ratio', async () => {
    const { handle, root } = fixture();
    try {
      const opts = { store: handle.store, trace: handle.trace, blobs: handle.blobs, tokenizer, model: 'm', ratio: 0.1, maxTokens: 512, now: () => TS };
      const phase = handle.store.byKind('phase')[0]!;
      const done = await summarizeRange({ fromSeq: phase.span_start_seq!, toSeq: phase.span_end_seq!, trigger: 'test' }, { ...opts, provider: provider('Read and fixed price().') });
      expect(done).toMatchObject({ status: 'written', nodeId: phase.id });
      expect(handle.store.currentSummary(phase.id)?.text).toBe('Read and fixed price().');
      const adhoc = await summarizeRange({ fromSeq: 2, toSeq: 5, trigger: 'test' }, { ...opts, provider: provider('Looked at a.ts.') });
      expect(adhoc).toMatchObject({ status: 'written', nodeId: null });
      expect(foldsFrom(handle.trace.all()).filter((f) => f.kind === 'summary')).toHaveLength(2);
      const long = await summarizeRange({ fromSeq: 2, toSeq: 5, trigger: 'test' }, { ...opts, provider: provider('word '.repeat(2000)) });
      expect(long).toMatchObject({ status: 'rejected' });
      expect(foldsFrom(handle.trace.all()).filter((f) => f.kind === 'summary')).toHaveLength(2);
    } finally {
      handle.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
