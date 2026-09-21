/**
 * The retention ruling and the turn derivation it rules over. What these protect:
 * one ladder (reduce before remove), protection that yields only when it must, two
 * invariants that never yield, and equivalence with `planEviction` in the legacy mode.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EVICTION_WEIGHTS,
  HeuristicTokenizer,
  deriveTurns,
  planEviction,
  planRetention,
  type EvictionSignals,
  type RetentionParams,
  type RetentionUnit,
  type TraceEvent,
} from '../src/index.js';

const tokenizer = new HeuristicTokenizer();
const words = (n: number, tag: string): string => Array.from({ length: n }, (_, i) => `${tag}w${String(i)}`).join(' ');

function unit(i: number, tokens: number, extra: Partial<RetentionUnit> = {}): RetentionUnit {
  const raw = words(tokens, `u${String(i)}`);
  const signals: EvictionSignals = { priority: 0, recency: i, refRecency: 0, dormancy: 0 };
  return { id: `u${String(i)}`, tokens: tokenizer.count(raw), raw, signals, pinned: false, protection: 0, relevance: 0, ...extra };
}

const params = (extra: Partial<RetentionParams> = {}): RetentionParams => ({
  budgetTokens: 1000, headroomTokens: 0, weights: { ...DEFAULT_EVICTION_WEIGHTS, relevance: 0 },
  protection: 'soft', protectionBonus: 10, reducer: null, reduceMinTokens: 200, reduceFrac: 0.25, tokenizer, ...extra,
});

const kinds = (plan: ReturnType<typeof planRetention>): string[] => [...plan.dispositions.values()].map((d) => d.kind);

describe('planRetention', () => {
  it('decides nothing while the units fit', () => {
    const plan = planRetention([unit(0, 100), unit(1, 100)], params());
    expect(plan.fired).toBe(false);
    expect(kinds(plan)).toEqual(['keep', 'keep']);
  });

  it('reduces before it removes: an oversized unit shrinks and nothing is dropped', () => {
    const units = [unit(0, 900), unit(1, 150), unit(2, 150)];
    const budgetTokens = units[0]!.tokens;
    const plan = planRetention(units, params({ reducer: 'chunk', budgetTokens }));
    expect(kinds(plan)).toEqual(['reduce', 'keep', 'keep']);
    expect(plan.tokensAfter).toBeLessThanOrEqual(budgetTokens);
    const reduced = plan.dispositions.get('u0');
    expect(reduced?.kind === 'reduce' && reduced.text.length > 0 && reduced.tokens < units[0]!.tokens).toBe(true);
  });

  it('removes lowest-value units only when reduction was not enough, and folds when a fold fits', () => {
    const units = [unit(0, 400, { foldText: 'phase summary' }), unit(1, 400), unit(2, 400), unit(3, 400)];
    const plan = planRetention(units, params());
    expect(plan.tokensAfter).toBeLessThanOrEqual(1000);
    expect(plan.dispositions.get('u0')?.kind).toBe('fold');
    expect(plan.dispositions.get('u3')?.kind).toBe('keep');
  });

  it('protection yields only when the budget cannot otherwise be met', () => {
    const anchored = { protection: 1 };
    // Unprotected units can pay: the protected one is untouched even though it is oldest.
    const easy = planRetention([unit(0, 400, anchored), unit(1, 400), unit(2, 400), unit(3, 400)], params());
    expect(easy.dispositions.get('u0')?.kind).toBe('keep');
    // Every unit protected and still over budget: a wall would overflow, a score gives way.
    const all = [0, 1, 2, 3].map((i) => unit(i, 400, anchored));
    expect(planRetention(all, params()).tokensAfter).toBeLessThanOrEqual(1000);
    const walled = planRetention(all, params({ protection: 'hard' }));
    expect(kinds(walled)).toEqual(['keep', 'keep', 'keep', 'keep']);
    expect(walled.overBudget).toBe(true);
  });

  it('never degrades a pinned unit, and says so when the pins alone overflow', () => {
    const plan = planRetention([unit(0, 900, { pinned: true }), unit(1, 900, { pinned: true }), unit(2, 300)], params({ reducer: 'chunk' }));
    expect(plan.dispositions.get('u0')?.kind).toBe('keep');
    expect(plan.dispositions.get('u1')?.kind).toBe('keep');
    expect(plan.overBudget).toBe(true);
  });

  it("relevance is inert at weight 0 and decides at weight > 0", () => {
    const units = [unit(0, 400, { relevance: 1 }), unit(1, 400), unit(2, 400), unit(3, 400)];
    expect(planRetention(units, params()).dispositions.get('u0')?.kind).toBe('drop');
    const weighted = params({ weights: { ...DEFAULT_EVICTION_WEIGHTS, relevance: 5 } });
    expect(planRetention(units, weighted).dispositions.get('u0')?.kind).toBe('keep');
  });

  it("in the legacy mode — hard protection, no reduction — it IS planEviction", () => {
    const sizes = [300, 120, 450, 80, 260, 500, 90, 310];
    const units = sizes.map((t, i) => unit(i, t, { protection: i >= sizes.length - 3 ? 1 : 0, signals: { priority: (i * 7) % 3, recency: i, refRecency: -(i % 4), dormancy: ((i * 5) % 7) / 7 } }));
    for (const budget of [400, 900, 1400, 2000]) {
      const legacy = planEviction(units.map((u, index) => ({ index, tokens: u.tokens, signals: u.signals, anchor: u.protection > 0 })), budget);
      const plan = planRetention(units, params({ budgetTokens: budget, protection: 'hard' }));
      const dropped = units.map((u, i) => (plan.dispositions.get(u.id)?.kind === 'drop' ? i : -1)).filter((i) => i >= 0);
      expect(dropped, `budget ${String(budget)}`).toEqual(legacy.evict);
    }
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

  it('covers every event exactly once, in order', () => {
    const events = Array.from({ length: 40 }, (_, i) => ev(i + 1, i % 3 === 0 ? { type: 'assistant_message', blob: 'b' } : i % 3 === 1 ? { type: 'tool_call', tool: 'x' } : { type: 'tool_result', call_seq: i }));
    const turns = deriveTurns(events);
    expect(turns[0]!.startSeq).toBe(1);
    expect(turns.at(-1)!.endSeq).toBe(40);
    for (let i = 1; i < turns.length; i += 1) expect(turns[i]!.startSeq).toBe(turns[i - 1]!.endSeq + 1);
  });
});
