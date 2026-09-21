/**
 * Assembly, eviction, and the turns both work over. What these protect: assembly never
 * removes and eviction never represents; protection yields only when it must; pinned units
 * never yield; and eviction under hard protection is `planEviction`.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EVICTION_WEIGHTS,
  HeuristicTokenizer,
  deriveTurns,
  planEviction,
  perUnitBudget,
  planRetention,
  representUnits,
  tokensUnder,
  type AssembleParams,
  type AssembleUnit,
  type EvictionSignals,
  type RetentionParams,
  type RetentionUnit,
  type TraceEvent,
} from '../src/index.js';

const tokenizer = new HeuristicTokenizer();
function unit(i: number, tokens: number, extra: Partial<RetentionUnit> = {}): RetentionUnit {
  const signals: EvictionSignals = { priority: 0, recency: i, refRecency: 0, dormancy: 0 };
  return { id: `u${String(i)}`, tokens, signals, pinned: false, protection: 0, relevance: 0, ...extra };
}

const params = (extra: Partial<RetentionParams> = {}): RetentionParams => ({
  budgetTokens: 1000, headroomTokens: 0, weights: { ...DEFAULT_EVICTION_WEIGHTS, relevance: 0 },
  protection: 'soft', protectionBonus: 10, ...extra,
});

describe('planRetention — removal only, over units sized as assembled', () => {
  it('decides nothing while the units fit', () => {
    expect(planRetention([unit(0, 100), unit(1, 100)], params())).toMatchObject({ fired: false, dropped: [] });
  });

  it('removes the lowest-value units until the rest fit', () => {
    const plan = planRetention([unit(0, 400), unit(1, 400), unit(2, 400), unit(3, 400)], params());
    expect(plan.dropped).toEqual(['u0', 'u1']);
    expect(plan.tokensAfter).toBeLessThanOrEqual(1000);
  });

  it('with residues, removal is two steps: stub the worst, drop only if the stubs do not fit', () => {
    const units = [0, 1, 2, 3].map((i) => ({ ...unit(i, 400), residueTokens: 50 }));
    const gentle = planRetention(units, params());
    expect(gentle).toMatchObject({ stubbed: ['u0', 'u1'], dropped: [] });
    expect(gentle.tokensAfter).toBe(900);

    const harsh = planRetention(units.map((u) => ({ ...u, residueTokens: 300 })), params());
    expect(harsh.dropped.length).toBeGreaterThan(0);
    expect(harsh.tokensAfter).toBeLessThanOrEqual(1000);
    // A residue that saves nothing is no residue: that unit can only be dropped.
    expect(planRetention(units.map((u) => ({ ...u, residueTokens: 400 })), params())).toMatchObject({ stubbed: [], dropped: ['u0', 'u1'] });
  });

  it('protection yields only when the budget cannot otherwise be met', () => {
    const anchored = { protection: 1 };
    // Unprotected units can pay: the protected one survives even though it is oldest.
    expect(planRetention([unit(0, 400, anchored), unit(1, 400), unit(2, 400), unit(3, 400)], params()).dropped).not.toContain('u0');
    // Every unit protected and still over budget: a wall would overflow, a score gives way.
    const all = [0, 1, 2, 3].map((i) => unit(i, 400, anchored));
    expect(planRetention(all, params()).tokensAfter).toBeLessThanOrEqual(1000);
    expect(planRetention(all, params({ protection: 'hard' }))).toMatchObject({ dropped: [], overBudget: true });
  });

  it('soft protection is GRADED: on the weights\' own scale an anchored unit can be outscored; a bonus above their sum yields only last', () => {
    const worst: EvictionSignals = { priority: 0, recency: 0, refRecency: 0, dormancy: 1 };
    const best: EvictionSignals = { priority: 5, recency: 9, refRecency: 0, dormancy: 0 };
    const units = [unit(0, 600, { protection: 0.6, signals: worst }), unit(1, 600, { signals: best }), unit(2, 100, { signals: { ...best, recency: 1, priority: 1 } })];
    // The anchored unit is worst on every signal; the unprotected one is best on every signal.
    expect(planRetention(units, params({ protectionBonus: 2 })).dropped).toEqual(['u0']);
    expect(planRetention(units, params({ protectionBonus: 10 })).dropped).toEqual(['u1']);
    expect(planRetention(units, params({ protectionBonus: 2, protection: 'hard' })).dropped).toEqual(['u1']);
  });

  it('never removes a pinned unit, and says so when the pins alone overflow', () => {
    const plan = planRetention([unit(0, 900, { pinned: true }), unit(1, 900, { pinned: true }), unit(2, 300)], params());
    expect(plan.dropped).toEqual(['u2']);
    expect(plan.overBudget).toBe(true);
  });

  it('relevance is inert at weight 0 and decides at weight > 0', () => {
    const units = [unit(0, 400, { relevance: 1 }), unit(1, 400), unit(2, 400), unit(3, 400)];
    expect(planRetention(units, params()).dropped).toContain('u0');
    expect(planRetention(units, params({ weights: { ...DEFAULT_EVICTION_WEIGHTS, relevance: 5 } })).dropped).not.toContain('u0');
  });

  it('under hard protection it IS planEviction', () => {
    const sizes = [300, 120, 450, 80, 260, 500, 90, 310];
    const units = sizes.map((t, i) => unit(i, t, { protection: i >= sizes.length - 3 ? 1 : 0, signals: { priority: (i * 7) % 3, recency: i, refRecency: -(i % 4), dormancy: ((i * 5) % 7) / 7 } }));
    for (const budget of [400, 900, 1400, 2000]) {
      const legacy = planEviction(units.map((u, index) => ({ index, tokens: u.tokens, signals: u.signals, anchor: u.protection > 0 })), budget);
      const plan = planRetention(units, params({ budgetTokens: budget, protection: 'hard' }));
      expect(plan.dropped, `budget ${String(budget)}`).toEqual(legacy.evict.map((i) => `u${String(i)}`));
    }
  });
});

describe('representUnits — assembly chooses a representation and removes nothing', () => {
  const words = (n: number, tag: string): string => Array.from({ length: n }, (_, i) => `${tag}w${String(i)}`).join(' ');
  const au = (i: number, n: number, extra: Partial<AssembleUnit> = {}): AssembleUnit => {
    const raw = words(n, `u${String(i)}`);
    return { id: `u${String(i)}`, raw, tokens: tokenizer.count(raw), pinned: false, textOnly: true, ...extra };
  };
  const ap = (extra: Partial<AssembleParams> = {}): AssembleParams => ({
    windowTokens: 8000, reserveTokens: 0, anchor: 1, softTargetFrac: 0.5, summaries: false, reducer: 'chunk', tokenizer, ...extra,
  });

  it('reduces a unit over the per-unit budget to it, and leaves the rest raw', () => {
    expect(perUnitBudget(ap())).toBe(2000);
    const units = [au(0, 3000), au(1, 100), au(2, 100)];
    const out = representUnits(units, ap()).dispositions;
    expect([...out.values()].map((d) => d.kind)).toEqual(['reduce', 'keep', 'keep']);
    expect(tokensUnder(units[0]!, out.get('u0')!)).toBeLessThanOrEqual(2000);
    expect(representUnits(units, ap({ reducer: null })).dispositions.get('u0')?.kind).toBe('keep');
  });

  it('folds a closed phase outside the anchor: its first TEXT-ONLY unit carries the summary, its siblings are covered', () => {
    const closed = { id: 'p1', closed: true, summary: 'what phase one did' };
    const open = { id: 'p2', closed: false, summary: 'unfinished' };
    const units = [au(0, 50, { group: closed, textOnly: false }), au(1, 50, { group: closed }), au(2, 50, { group: open }), au(3, 50, { group: open })];
    const { dispositions: out, unfoldable } = representUnits(units, ap({ summaries: true }));
    // u0 carries a tool call, so it cannot become a summary; u1 can.
    expect(out.get('u0')).toEqual({ kind: 'drop', why: 'covered' });
    expect(out.get('u1')).toMatchObject({ kind: 'fold', text: 'what phase one did' });
    expect(out.get('u2')?.kind).toBe('keep');
    expect(unfoldable).toEqual([]);
    // Summaries off, or a member inside the anchor: the phase stays raw.
    expect([...representUnits(units, ap()).dispositions.values()].every((d) => d.kind === 'keep')).toBe(true);
    expect(representUnits(units.slice(0, 2), ap({ summaries: true })).dispositions.get('u1')?.kind).toBe('keep');
    // A pinned member stays raw and out of the fold; the rest of its phase still folds.
    const pinnedFirst = representUnits([au(0, 50, { group: closed, pinned: true }), ...units.slice(1)], ap({ summaries: true })).dispositions;
    expect([pinnedFirst.get('u0')?.kind, pinnedFirst.get('u1')?.kind]).toEqual(['keep', 'fold']);
  });

  it('a phase with no text-only unit is NOT folded — it stays as it is and is reported, never dropped to nothing', () => {
    const closed = { id: 'p1', closed: true, summary: 's' };
    const units = [au(0, 50, { group: closed, textOnly: false }), au(1, 50, { group: closed, textOnly: false }), au(2, 50), au(3, 50)];
    const { dispositions, unfoldable } = representUnits(units, ap({ summaries: true }));
    expect([...dispositions.values()].every((d) => d.kind === 'keep')).toBe(true);
    expect(unfoldable).toEqual(['p1']);
  });

  it('never reduces a pinned unit', () => {
    expect(representUnits([au(0, 3000, { pinned: true }), au(1, 10)], ap()).dispositions.get('u0')?.kind).toBe('keep');
  });
});

describe('deriveTurns', () => {
  const ev = (seq: number, e: Record<string, unknown>): TraceEvent => ({ seq, ts: 't', ...e }) as TraceEvent;

  it('one stamped host message is one turn, even with no text event to mark it', () => {
    const turns = deriveTurns([
      ev(1, { type: 'user_message', blob: 'b', turn_id: 'm0' }),
      ev(2, { type: 'tool_call', tool: 'read', turn_id: 'm1' }),
      ev(3, { type: 'tool_result', call_seq: 2, turn_id: 'm1' }),
      ev(4, { type: 'tool_call', tool: 'grep', turn_id: 'm1' }),
      ev(5, { type: 'tool_result', call_seq: 4, turn_id: 'm1' }),
      ev(6, { type: 'assistant_message', blob: 'b', turn_id: 'm2' }),
    ]);
    expect(turns.map((t) => [t.id, t.startSeq, t.endSeq, t.hostId, t.fromUser])).toEqual([
      ['turn:1', 1, 1, 'm0', true], ['turn:2', 2, 5, 'm1', false], ['turn:6', 6, 6, 'm2', false],
    ]);
  });

  it('an unstamped trace falls back deterministically: a message plus the calls it issued', () => {
    const events = [
      ev(1, { type: 'user_message', blob: 'b' }),
      ev(2, { type: 'assistant_message', blob: 'b' }),
      ev(3, { type: 'tool_call', tool: 'read', parent_seq: 2 }),
      ev(4, { type: 'tool_result', call_seq: 3 }),
      ev(5, { type: 'tool_call', tool: 'bash' }),
      ev(6, { type: 'tool_result', call_seq: 5 }),
      ev(7, { type: 'manual_annotation', blob: 'b' }),
    ];
    const turns = deriveTurns(events);
    expect(turns.map((t) => [t.startSeq, t.endSeq])).toEqual([[1, 1], [2, 4], [5, 7]]);
    expect(deriveTurns(events)).toEqual(turns);
  });

  it('an unstamped event inside a stamped turn joins it — one host message is never two turns', () => {
    // Middleware mode: the server appends its own retrieval events while a host message is running.
    const turns = deriveTurns([
      ev(1, { type: 'assistant_message', blob: 'b', turn_id: 'X' }),
      ev(2, { type: 'tool_call', tool: 'search' }),
      ev(3, { type: 'tool_result', call_seq: 2 }),
      ev(4, { type: 'tool_call', tool: 'read', turn_id: 'X' }),
      ev(5, { type: 'tool_result', call_seq: 4, turn_id: 'X' }),
      ev(6, { type: 'assistant_message', blob: 'b', turn_id: 'Y' }),
    ]);
    expect(turns.map((t) => [t.hostId, t.startSeq, t.endSeq])).toEqual([['X', 1, 5], ['Y', 6, 6]]);
  });

  it('reasoning opens the turn of the message it precedes, stamped or not', () => {
    const unstamped = deriveTurns([
      ev(1, { type: 'user_message', blob: 'b' }),
      ev(2, { type: 'reasoning', blob: 'b' }),
      ev(3, { type: 'assistant_message', blob: 'b' }),
      ev(4, { type: 'tool_call', tool: 'read', parent_seq: 3 }),
      ev(5, { type: 'tool_result', call_seq: 4 }),
      ev(6, { type: 'reasoning', blob: 'b' }),
      ev(7, { type: 'tool_call', tool: 'bash' }),
      ev(8, { type: 'tool_result', call_seq: 7 }),
    ]);
    expect(unstamped.map((t) => [t.startSeq, t.endSeq, t.fromUser])).toEqual([[1, 1, true], [2, 5, false], [6, 8, false]]);

    const stamped = deriveTurns([
      ev(1, { type: 'reasoning', blob: 'b', turn_id: 'm1' }),
      ev(2, { type: 'assistant_message', blob: 'b', turn_id: 'm1' }),
      ev(3, { type: 'reasoning', blob: 'b', turn_id: 'm2' }),
    ]);
    expect(stamped.map((t) => [t.hostId, t.startSeq, t.endSeq])).toEqual([['m1', 1, 2], ['m2', 3, 3]]);
  });

  it('covers every event exactly once, in order', () => {
    const events = Array.from({ length: 40 }, (_, i) => ev(i + 1, i % 3 === 0 ? { type: 'assistant_message', blob: 'b' } : i % 3 === 1 ? { type: 'tool_call', tool: 'x' } : { type: 'tool_result', call_seq: i }));
    const turns = deriveTurns(events);
    expect(turns[0]!.startSeq).toBe(1);
    expect(turns.at(-1)!.endSeq).toBe(40);
    for (let i = 1; i < turns.length; i += 1) expect(turns[i]!.startSeq).toBe(turns[i - 1]!.endSeq + 1);
  });
});
