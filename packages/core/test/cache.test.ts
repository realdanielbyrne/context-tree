/**
 * §17 cache-assertion harness against the flex-buffer layout. The frozen head
 * (system + steering + all user prompts) is the cached prefix; the flex buffer's
 * volatile tail (the raw anchor) churns after the secondary breakpoint; the tail
 * is appended after the buffer. A dropped breakpoint is total cache loss — the D5
 * regression this harness exists to catch.
 */
import { describe, it, expect } from 'vitest';
import { HeuristicTokenizer } from '../src/tokens/index.js';
import { assembleFlex, type FlexUnit } from '../src/assemble/index.js';
import { ProviderCacheSimulator, cacheReport, assertPrefixStable } from '../src/cache/index.js';

const tok = new HeuristicTokenizer();
const words = (n: number): string => 'ok '.repeat(Math.max(1, n)).trim();

const unit = (order: number, o: { nodeId?: string; noSummary?: boolean } = {}): FlexUnit => ({
  nodeId: o.nodeId ?? `n${order}`,
  order,
  fingerprints: new Set(),
  wrote: false,
  lastReferencedTurn: order,
  dormancy: 0,
  raw: `RAW${order} ${words(20)}`,
  summary: o.noSummary ? undefined : `SUM${order} ${words(20)}`,
});

const HEAD = { system: `SYSTEM CONTRACT ${words(120)}`, userPrompts: [`user prompt ${words(40)}`] };
const W = 1_000_000;
const mk = (units: FlexUnit[], opts: Record<string, unknown> = {}) =>
  assembleFlex(HEAD, units, tok, { window: W, anchor: 1, ...opts });

describe('flex cache economics (§17)', () => {
  it('first submission is all fresh; re-submitting the identical prompt reads the cached prefix', () => {
    const sim = new ProviderCacheSimulator({ tokenizer: tok });
    const p = mk([unit(0), unit(1), unit(2)]);
    const first = sim.submit(p);
    expect(first.cacheRead).toBe(0);
    expect(first.fresh).toBeGreaterThan(0);
    const second = sim.submit(p);
    expect(second.cacheRead).toBeGreaterThan(0); // frozen head + stable summary run cached
    expect(second.divergedInZone).toBeNull();
  });

  it('appending a flex unit keeps the head prefix cache-read and charges only new content', () => {
    const sim = new ProviderCacheSimulator({ tokenizer: tok });
    sim.submit(mk([unit(0), unit(1), unit(2)]));
    const after = sim.submit(mk([unit(0), unit(1), unit(2), unit(3)]));
    expect(after.cacheRead).toBeGreaterThan(0); // head + stable summaries reused
    expect(after.cacheWrite + after.fresh).toBeGreaterThan(0); // the new unit is not free
  });

  it('a tail appended after the buffer leaves the head+flex prefix cache-read', () => {
    const sim = new ProviderCacheSimulator({ tokenizer: tok });
    sim.submit(mk([unit(0), unit(1), unit(2)]));
    const withTail = sim.submit(mk([unit(0), unit(1), unit(2)], { tail: [{ id: 'r1', text: `retrieved ${words(30)}` }] }));
    expect(withTail.cacheRead).toBeGreaterThan(0);
  });

  it('a dropped head breakpoint is total cache loss even when every block is byte-identical', () => {
    const sim = new ProviderCacheSimulator({ tokenizer: tok });
    sim.submit(mk([unit(0), unit(1)]));
    const p2 = mk([unit(0), unit(1)]);
    for (const b of p2.blocks) b.cacheBreakpointAfter = false; // strip the markers
    p2.cacheBreakpoints = [];
    const dropped = sim.submit(p2);
    expect(dropped.cacheRead).toBe(0); // an unmarked prefix is never cached
  });

  it('every submission conserves its input tokens (cacheRead + cacheWrite + fresh = total)', () => {
    const sim = new ProviderCacheSimulator({ tokenizer: tok });
    sim.submit(mk([unit(0)]));
    sim.submit(mk([unit(0), unit(1)]));
    sim.submit(mk([unit(0), unit(1), unit(2)]));
    for (const o of sim.outcomes()) {
      expect(o.cacheRead + o.cacheWrite + o.fresh).toBe(o.total);
    }
    const report = cacheReport(sim.outcomes());
    expect(report).toBeDefined();
  });

  it('the frozen-head prefix stays byte-stable across an append (assertPrefixStable through head)', () => {
    const before = mk([unit(0), unit(1), unit(2)]);
    const after = mk([unit(0), unit(1), unit(2), unit(3)]);
    expect(() => assertPrefixStable(before, after, { throughZone: 'head' })).not.toThrow();
  });
});
