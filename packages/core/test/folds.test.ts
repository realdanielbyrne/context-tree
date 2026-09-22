import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig } from '../src/config.js';
import { ingest, openTaskStore, type TaskStore } from '../src/ingest/index.js';
import { HeuristicTokenizer } from '../src/tokens/index.js';
import { blocksOf, foldView, foldsFrom, planFolds, stubOf, tailOf, type FoldCandidate } from '../src/segment/index.js';
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

describe('the fold policy: nothing below the threshold; reasoning first; the think rule folds on its own', () => {
  const cand = (stub: number, kind: FoldCandidate['kind'], turnsFromNewest: number, score: number, tokens: number, residue: number | null = 10): FoldCandidate =>
    ({ stub, kind, turnsFromNewest, score, tokens, residue, pinned: false });
  const base = { budgetTokens: 1000, foldStubAt: 1, cadenceN: 0, turn: 7, anchor: 1, foldReasoningAfter: 0 };

  it('none folds nothing; pressure folds the lowest-scored, reasoning before tools before text, never inside the anchor', () => {
    const cs = [cand(1, 'text', 3, 0.1, 300), cand(2, 'reasoning', 2, 0.2, 300), cand(3, 'tool', 2, 0.2, 300), cand(4, 'text', 0, 0.9, 300)];
    expect(planFolds(cs, { ...base, trigger: 'none' })).toMatchObject({ fired: false, stubs: [] });
    const plan = planFolds(cs, { ...base, trigger: 'pressure', budgetTokens: 700 });
    expect(plan.stubs).toEqual([1, 2]);
    expect(plan.tokensAfter).toBeLessThanOrEqual(700);
    expect(planFolds(cs, { ...base, trigger: 'pressure', budgetTokens: 2000 })).toMatchObject({ fired: false });
  });

  it('cadence acts only on its turn', () => {
    const cs = [cand(1, 'text', 3, 0.1, 900), cand(2, 'text', 0, 0.9, 900)];
    expect(planFolds(cs, { ...base, trigger: 'cadence', cadenceN: 5, turn: 7 }).fired).toBe(false);
    expect(planFolds(cs, { ...base, trigger: 'cadence', cadenceN: 5, turn: 10 }).fired).toBe(true);
  });

  it('foldReasoningAfter folds old reasoning with no pressure at all, and nothing else', () => {
    const cs = [cand(1, 'reasoning', 3, 0.1, 100), cand(2, 'tool', 3, 0.1, 100), cand(3, 'reasoning', 1, 0.5, 100), cand(4, 'reasoning', 0, 0.9, 100)];
    expect(planFolds(cs, { ...base, trigger: 'none', foldReasoningAfter: 2, budgetTokens: 10_000 }).stubs).toEqual([1]);
  });
});

describe('summarizeRange: one prompt for any range, accepted only when much smaller than what it summarizes', () => {
  const meta = { files: [], symbols: [], tests: [], artifacts: [], open_questions: [], decisions: [], node_ids: [] };
  const provider = (text: string) => ({ id: 'fake', complete: async () => ({ text: JSON.stringify({ text, meta }), model: 'm', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, toolCalls: [], stopReason: 'stop' }) });

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
