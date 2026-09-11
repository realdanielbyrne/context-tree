import { describe, it, expect } from 'vitest';
import {
  driftScores,
  DriftClassifier,
  jaccard,
  cosine,
  type ClassifyUnit,
} from '../src/classify/index.js';

const unit = (fps: string[], emb: number[]): ClassifyUnit => ({
  fingerprints: new Set(fps),
  embedding: Float32Array.from(emb),
});

describe('jaccard', () => {
  it('identical sets = 1, disjoint = 0', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1);
    expect(jaccard(new Set(['a']), new Set(['b']))).toBe(0);
  });
  it('two empty sets are identical (1)', () => {
    expect(jaccard(new Set(), new Set())).toBe(1);
  });
  it('partial overlap', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['b', 'c']))).toBeCloseTo(1 / 3, 6);
  });
});

describe('cosine', () => {
  it('parallel = 1, orthogonal = 0', () => {
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([2, 0]))).toBeCloseTo(1, 6);
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([0, 1]))).toBeCloseTo(0, 6);
  });
  it('zero vector = 0', () => {
    expect(cosine(Float32Array.from([0, 0]), Float32Array.from([1, 1]))).toBe(0);
  });
});

describe('driftScores', () => {
  it('a unit matching the recent window has low drift; one disjoint from it has high drift', () => {
    // Recent window = last K units. Build: [dormant, recentA, recentB]
    const units = [
      unit(['old_symbol'], [0, 0, 1]), // disjoint from recent
      unit(['foo', 'bar'], [1, 0, 0]),
      unit(['foo', 'baz'], [1, 0, 0]),
    ];
    const d = driftScores(units, 2); // recent window = last 2 units
    expect(d[0]).toBeGreaterThan(d[1]!);
    expect(d[0]).toBeGreaterThan(d[2]!);
  });

  it('drift is bounded in [0,1]', () => {
    const units = [unit(['x'], [1, 0]), unit(['y'], [0, 1])];
    for (const v of driftScores(units)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('empty input yields empty output', () => {
    expect(driftScores([])).toEqual([]);
  });
});

describe('DriftClassifier', () => {
  it('dormancy is min-max normalized across the current units', () => {
    const c = new DriftClassifier();
    const units = [
      unit(['old'], [0, 0, 1]),
      unit(['foo', 'bar'], [1, 0, 0]),
      unit(['foo', 'baz'], [1, 0, 0]),
    ];
    const res = c.classify(units, 2);
    const dorm = res.map((r) => r.dormancy);
    expect(Math.min(...dorm)).toBe(0);
    expect(Math.max(...dorm)).toBe(1);
    // The disjoint unit is the most dormant.
    expect(res[0]!.dormancy).toBe(1);
  });

  it('z-drift is 0 until the session has enough history (causal, err toward keeping)', () => {
    const c = new DriftClassifier();
    const first = c.classify([unit(['a'], [1, 0]), unit(['b'], [0, 1])]);
    // First turn: running stats empty → no standardization, nothing flagged dormant.
    expect(first.every((r) => r.zDrift === 0)).toBe(true);
    expect(first.every((r) => r.dormant === false)).toBe(true);
  });

  it('flags a clearly dormant unit once history exists', () => {
    const c = new DriftClassifier();
    // Seed several turns with genuine spread of drift (a mildly off unit each
    // turn) so the running std is > 0 and the classifier becomes "ready".
    for (let t = 0; t < 5; t += 1) {
      c.classify(
        [unit(['foo', 'bar'], [1, 0, 0]), unit(['foo', 'baz'], [1, 0, 0]), unit(['qux'], [0, 1, 0])],
        2,
      );
    }
    // Now introduce a unit fully disjoint from the recent window (lexically and
    // semantically) — its drift is far above the seeded mean.
    const res = c.classify(
      [unit(['zzz_unrelated'], [0, 0, 1]), unit(['foo', 'bar'], [1, 0, 0]), unit(['foo', 'baz'], [1, 0, 0])],
      2,
    );
    expect(res[0]!.zDrift).toBeGreaterThan(res[1]!.zDrift);
    expect(res[0]!.zDrift).toBeGreaterThan(1); // more than one SD above the session mean
    expect(res[0]!.dormant).toBe(true);
  });
});
