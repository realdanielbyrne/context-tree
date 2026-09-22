import { describe, it, expect } from 'vitest';
import {
  minMaxNormalize,
  scoreUnits,
  planEviction,
  DEFAULT_EVICTION_WEIGHTS,
  type EvictionSignals,
  type EvictionCandidate,
} from '../src/assemble/eviction.js';

const sig = (p: number, r: number, rr: number, d: number): EvictionSignals => ({
  priority: p,
  recency: r,
  refRecency: rr,
  dormancy: d,
});

describe('minMaxNormalize', () => {
  it('maps to [0,1] with endpoints at 0 and 1', () => {
    expect(minMaxNormalize([2, 4, 6])).toEqual([0, 0.5, 1]);
  });
  it('a flat vector carries no signal (all zeros)', () => {
    expect(minMaxNormalize([5, 5, 5])).toEqual([0, 0, 0]);
  });
  it('empty in, empty out', () => {
    expect(minMaxNormalize([])).toEqual([]);
  });
});

describe('scoreUnits (D-EV shape)', () => {
  it('priority dominates: the highest-priority unit outscores a merely-recent one', () => {
    const s = [
      sig(10, 0, 0, 0), // high priority, old
      sig(0, 10, 0, 0), // low priority, recent
    ];
    const scores = scoreUnits(s);
    // priority weight 2 vs recency weight 1, both normalized to 1 → 2 > 1
    expect(scores[0]).toBeGreaterThan(scores[1]!);
  });

  it('dormancy subtracts: a dormant unit scores below an identical non-dormant one', () => {
    const s = [sig(5, 5, 5, 0), sig(5, 5, 5, 10)];
    const scores = scoreUnits(s);
    expect(scores[0]).toBeGreaterThan(scores[1]!);
  });

  it('relevance is not a parameter — weights carry no relevance term', () => {
    expect(DEFAULT_EVICTION_WEIGHTS).not.toHaveProperty('relevance');
  });

  it('normalization is per-call across the given candidates', () => {
    // Same unit scored among different peers yields different normalized scores.
    const alone = scoreUnits([sig(5, 0, 0, 0)]);
    const withPeer = scoreUnits([sig(5, 0, 0, 0), sig(10, 0, 0, 0)]);
    expect(alone[0]).toBe(0); // flat → 0
    expect(withPeer[0]).toBe(0); // the min of the pair → 0
    expect(withPeer[1]).toBeGreaterThan(0);
  });
});

describe('planEviction', () => {
  const cand = (
    index: number,
    tokens: number,
    s: EvictionSignals,
    extra: Partial<EvictionCandidate> = {},
  ): EvictionCandidate => ({ index, tokens, signals: s, ...extra });

  it('below the floor: keeps everything, evicts nothing', () => {
    const cs = [cand(0, 10, sig(0, 0, 0, 9)), cand(1, 10, sig(0, 0, 0, 9))];
    const plan = planEviction(cs, 100);
    expect(plan.keep).toEqual([0, 1]);
    expect(plan.evict).toEqual([]);
  });

  it('over the floor: evicts the lowest-scoring first', () => {
    const cs = [
      cand(0, 40, sig(10, 10, 10, 0)), // strong keep
      cand(1, 40, sig(0, 0, 0, 10)), // dormant, low priority → evict
    ];
    const plan = planEviction(cs, 40);
    expect(plan.keep).toEqual([0]);
    expect(plan.evict).toEqual([1]);
  });

  it('never evicts anchors or pinned units, even when dormant', () => {
    const cs = [
      cand(0, 50, sig(0, 0, 0, 10), { anchor: true }), // dormant but anchored
      cand(1, 50, sig(10, 10, 10, 0)), // strong keep
      cand(2, 50, sig(1, 1, 1, 5)), // weakest evictable
    ];
    const plan = planEviction(cs, 100);
    expect(plan.keep).toContain(0); // anchor survives
    expect(plan.keep).toContain(1);
    expect(plan.evict).toEqual([2]);
  });

  it('kept indices come back in creation order (append-only, never re-mixed)', () => {
    const cs = [
      cand(0, 30, sig(0, 0, 0, 8)),
      cand(1, 30, sig(10, 10, 10, 0)),
      cand(2, 30, sig(5, 5, 5, 2)),
    ];
    const plan = planEviction(cs, 60);
    expect(plan.keep).toEqual([...plan.keep].sort((a, b) => a - b));
  });

  it('pinned tokens are the caller’s to account — budget governs the flex buffer', () => {
    const cs = [
      cand(0, 1000, sig(0, 0, 0, 0), { pinned: true }), // huge head, not counted vs budget
      cand(1, 40, sig(10, 0, 0, 0)),
      cand(2, 40, sig(0, 0, 0, 10)),
    ];
    const plan = planEviction(cs, 40);
    expect(plan.keep).toContain(0); // pinned always kept
    expect(plan.keep).toContain(1); // best evictable fits
    expect(plan.evict).toEqual([2]);
  });
});

describe('covariance (D26): historical co-activation with what is hot, at weight 0 unless asked', () => {
  it('scores a block by pairing history with the hot set, never by present overlap', async () => {
    const { covarianceScores } = await import('../src/segment/index.js');
    const fp = (...xs: string[]) => new Set(xs);
    // a.ts and b.ts were always touched together; c.ts never with either. The hot window is {b.ts}.
    const blocks = [fp('a.ts', 'b.ts'), fp('c.ts'), fp('a.ts', 'b.ts'), fp('c.ts', 'd.ts'), fp('a.ts', 'b.ts'), fp('a.ts'), fp('c.ts'), fp('b.ts')];
    const scores = covarianceScores(blocks, { k: 1, m: 0 });
    // The block that holds only a.ts: not hot itself, but a.ts co-fired with the hot b.ts every time.
    expect(scores[5]).toBeGreaterThan(0);
    // c.ts never co-fired with b.ts.
    expect(scores[6]).toBeLessThanOrEqual(0);
    // The hot block itself scores by nothing: its features are removed from both sides.
    expect(scores[7]).toBe(0);
  });

  it('is inert in the score until wCovariance is set', () => {
    const base = [{ priority: 0, recency: 1, refRecency: 0, dormancy: 0, covariance: 1 }, { priority: 0, recency: 2, refRecency: 0, dormancy: 0, covariance: 0 }];
    const off = scoreUnits(base, { priority: 0, recency: 1, refRecency: 0, dormancy: 0 });
    expect(off[1]).toBeGreaterThan(off[0]!);
    const on = scoreUnits(base, { priority: 0, recency: 1, refRecency: 0, dormancy: 0, covariance: 5 });
    expect(on[0]).toBeGreaterThan(on[1]!);
  });
});
