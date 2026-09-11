import { describe, it, expect } from 'vitest';
import { HeuristicTokenizer } from '../src/tokens/index.js';
import { assembleFlex, type FlexUnit } from '../src/assemble/index.js';
import { assertPrefixStable } from '../src/cache/index.js';

const tok = new HeuristicTokenizer();
const words = (n: number): string => 'ok '.repeat(Math.max(1, n)).trim(); // ~n tokens

interface UnitOpts {
  nodeId?: string;
  fps?: string[];
  wrote?: boolean;
  ref?: number;
  dormancy?: number;
  rawTok?: number;
  sumTok?: number;
  noSummary?: boolean;
}
const unit = (order: number, o: UnitOpts = {}): FlexUnit => ({
  nodeId: o.nodeId ?? `n${order}`,
  order,
  fingerprints: new Set(o.fps ?? []),
  wrote: o.wrote ?? false,
  lastReferencedTurn: o.ref ?? order,
  dormancy: o.dormancy ?? 0,
  raw: `RAW${order} ${words(o.rawTok ?? 30)}`,
  summary: o.noSummary ? undefined : `SUM${order} ${words(o.sumTok ?? 30)}`,
});

const bigWindow = { window: 1_000_000 };

describe('assembleFlex — frozen head', () => {
  it('head is system + steering + all user prompts, in order, zone head', () => {
    const p = assembleFlex(
      { system: 'SYS', steering: 'STEER', userPrompts: ['p0', 'p1'] },
      [unit(0)],
      tok,
      bigWindow,
    );
    const head = p.blocks.filter((b) => b.zone === 'head').map((b) => b.id);
    expect(head).toEqual(['head:system', 'head:steering', 'head:user:0', 'head:user:1']);
    expect(p.system).toContain('SYS');
    expect(p.system).toContain('p1');
  });

  it('a cache breakpoint is emitted after the head', () => {
    const p = assembleFlex({ system: 'SYS', userPrompts: ['p0'] }, [unit(0)], tok, bigWindow);
    const lastHead = p.blocks.filter((b) => b.zone === 'head').at(-1)!;
    expect(lastHead.cacheBreakpointAfter).toBe(true);
    expect(p.cacheBreakpoints).toContain(lastHead.id);
  });
});

describe('assembleFlex — representation & order', () => {
  it('the last A units stay raw; older units fold to summary', () => {
    const units = [unit(0), unit(1), unit(2), unit(3), unit(4)];
    const p = assembleFlex({ system: 'S', userPrompts: [] }, units, tok, { ...bigWindow, anchor: 2 });
    const flex = p.blocks.filter((b) => b.zone === 'flex');
    // older three summarised, last two raw
    expect(flex.slice(0, 3).every((b) => b.text.startsWith('SUM'))).toBe(true);
    expect(flex.slice(3).every((b) => b.text.startsWith('RAW'))).toBe(true);
  });

  it('kept units are emitted in creation order (append-only, never re-mixed)', () => {
    const units = [unit(0), unit(1), unit(2)];
    const p = assembleFlex({ system: 'S', userPrompts: [] }, units, tok, bigWindow);
    const ids = p.blocks.filter((b) => b.zone === 'flex').map((b) => b.nodeId);
    expect(ids).toEqual(['n0', 'n1', 'n2']);
  });

  it('a secondary breakpoint lands after the stable (summary) run', () => {
    const units = [unit(0), unit(1), unit(2), unit(3)];
    const p = assembleFlex({ system: 'S', userPrompts: [] }, units, tok, { ...bigWindow, anchor: 1 });
    // stable run = n0,n1,n2 (summaries); n3 raw. breakpoint after n2.
    const bpIds = p.cacheBreakpoints;
    expect(bpIds).toContain('flex:n2');
    const stable = p.blocks.find((b) => b.id === 'flex:n2')!;
    expect(stable.cacheBreakpointAfter).toBe(true);
  });
});

describe('assembleFlex — eviction to the floor', () => {
  it('over the floor, evicts the lowest-scoring (dormant, low-priority) unit; keeps anchors & high-priority', () => {
    const units = [
      unit(0, { nodeId: 'dormant', dormancy: 1, wrote: false }), // lowest score → evict
      unit(1, { nodeId: 'wrote', dormancy: 0, wrote: true }), // priority boost → keep
      unit(2, { nodeId: 'mid', dormancy: 0, wrote: false }), // keep
      unit(3, { nodeId: 'anchor', dormancy: 1, wrote: false }), // anchor: kept despite dormancy
    ];
    // window 200, floor 0.5 -> 100; each unit ~31 tokens; anchor=1.
    const p = assembleFlex({ system: 'S', userPrompts: [] }, units, tok, {
      window: 200,
      softTargetFrac: 0.5,
      anchor: 1,
    });
    const kept = p.blocks.filter((b) => b.zone === 'flex').map((b) => b.nodeId);
    expect(kept).toContain('anchor'); // anchor survives despite dormancy=1
    expect(kept).toContain('wrote');
    expect(kept).not.toContain('dormant'); // the lowest-scoring unit is evicted
    expect(p.budgets.droppedFromZoneB).toContain('dormant');
  });

  it('below the floor, keeps everything', () => {
    const units = [unit(0, { dormancy: 1 }), unit(1), unit(2)];
    const p = assembleFlex({ system: 'S', userPrompts: [] }, units, tok, bigWindow);
    expect(p.blocks.filter((b) => b.zone === 'flex')).toHaveLength(3);
    expect(p.budgets.droppedFromZoneB).toEqual([]);
  });
});

describe('assembleFlex — cache stability', () => {
  it('the head prefix is byte-stable when a new unit is appended', () => {
    const head = { system: 'SYS', userPrompts: ['p0'] };
    const before = assembleFlex(head, [unit(0), unit(1)], tok, bigWindow);
    const after = assembleFlex(head, [unit(0), unit(1), unit(2)], tok, bigWindow);
    // adding a flex unit must not disturb the frozen head prefix
    expect(() => assertPrefixStable(before, after, { throughZone: 'head' })).not.toThrow();
  });

  it('the head grows only at its end when a user prompt is appended', () => {
    const before = assembleFlex({ system: 'SYS', userPrompts: ['p0'] }, [unit(0)], tok, bigWindow);
    const after = assembleFlex({ system: 'SYS', userPrompts: ['p0', 'p1'] }, [unit(0)], tok, bigWindow);
    // append-only head: p0 stays put, p1 lands after it — the prefix only grew.
    expect(() => assertPrefixStable(before, after, { throughZone: 'head' })).not.toThrow();
    const headIds = after.blocks.filter((b) => b.zone === 'head').map((b) => b.id);
    expect(headIds).toEqual(['head:system', 'head:user:0', 'head:user:1']);
  });
});
