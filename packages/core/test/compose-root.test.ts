/**
 * v5.7 deterministic root: the Zone B root is composed from leaf summaries by
 * a pure function. The two properties that matter:
 *   1. it never calls a model — the whole point is deleting the strong-model
 *      root call and its truncation-retry failure mode;
 *   2. it is byte-stable — an unchanged composition writes NO new version, so
 *      the Zone B root block only churns when a leaf actually changed (D5).
 */
import { describe, expect, it } from 'vitest';
import type { SummaryMeta } from '../src/contracts/index.js';
import { openInMemoryStore, type SqliteTreeStore } from '../src/store/index.js';
import { DETERMINISTIC_ROOT_MODEL, composeRootSummary } from '../src/summarize/index.js';

const NOW = '2026-09-01T00:00:00.000Z';

function meta(overrides: Partial<SummaryMeta> = {}): SummaryMeta {
  return {
    files: [],
    symbols: [],
    tests: [],
    artifacts: [],
    open_questions: [],
    decisions: [],
    node_ids: [],
    ...overrides,
  };
}

function fixture(): { store: SqliteTreeStore; root: string; p1: string; p2: string } {
  const store = openInMemoryStore();
  const root = store.insertNode({
    parent_id: null,
    kind: 'task',
    title: 'fix the parser',
    span_start_seq: 1,
    span_end_seq: 6,
    meta_json: {},
  });
  const p1 = store.insertNode({
    parent_id: root.id,
    kind: 'phase',
    title: 'diagnosis',
    phase_type: 'diagnosis',
    span_start_seq: 1,
    span_end_seq: 4,
    meta_json: {},
  });
  const p2 = store.insertNode({
    parent_id: root.id,
    kind: 'phase',
    title: 'verification',
    phase_type: 'verification',
    span_start_seq: 5,
    span_end_seq: 6,
    meta_json: {},
  });
  return { store, root: root.id, p1: p1.id, p2: p2.id };
}

describe('composeRootSummary', () => {
  it('returns null when no child has a summary yet — below-k there is nothing to index', () => {
    const fx = fixture();
    expect(composeRootSummary(fx.store, fx.root, () => NOW)).toBeNull();
    expect(fx.store.currentSummary(fx.root)).toBeNull();
  });

  it('composes the task title plus one headline per summarized branch, in creation order', () => {
    const fx = fixture();
    fx.store.putSummary({
      node_id: fx.p1,
      model: 'leaf',
      text: 'Read the parser and found the off-by-one. It lives in scan().\nMore detail here.',
      meta: meta({ open_questions: ['is scan() called elsewhere?'] }),
    });
    fx.store.putSummary({
      node_id: fx.p2,
      model: 'leaf',
      text: 'Ran the tests; all green.',
      meta: meta(),
    });

    const summary = composeRootSummary(fx.store, fx.root, () => NOW);

    expect(summary).not.toBeNull();
    expect(summary?.model).toBe(DETERMINISTIC_ROOT_MODEL);
    expect(summary?.text).toBe(
      [
        'fix the parser',
        '- Read the parser and found the off-by-one.',
        '- Ran the tests; all green.',
        'open: is scan() called elsewhere?',
      ].join('\n'),
    );
    // The §9 fetch targets: root + every covered child.
    expect(summary?.meta.node_ids).toEqual([fx.root, fx.p1, fx.p2]);
  });

  it('is byte-stable: an unchanged composition writes no new version', () => {
    const fx = fixture();
    fx.store.putSummary({ node_id: fx.p1, model: 'leaf', text: 'Did the work.', meta: meta() });

    const first = composeRootSummary(fx.store, fx.root, () => NOW);
    expect(first?.version).toBe(1);
    expect(composeRootSummary(fx.store, fx.root, () => NOW)).toBeNull();
    expect(fx.store.currentSummary(fx.root)?.version).toBe(1);

    // A leaf change IS a new composition — version bumps exactly then.
    fx.store.putSummary({ node_id: fx.p2, model: 'leaf', text: 'Verified it.', meta: meta() });
    const second = composeRootSummary(fx.store, fx.root, () => NOW);
    expect(second?.version).toBe(2);
  });

  it('merges child open questions and decisions with duplicates dropped', () => {
    const fx = fixture();
    fx.store.putSummary({
      node_id: fx.p1,
      model: 'leaf',
      text: 'Investigated.',
      meta: meta({ open_questions: ['q1'], decisions: ['use dataclass'] }),
    });
    fx.store.putSummary({
      node_id: fx.p2,
      model: 'leaf',
      text: 'Fixed.',
      meta: meta({ open_questions: ['q1', 'q2'], decisions: ['use dataclass'] }),
    });

    const summary = composeRootSummary(fx.store, fx.root, () => NOW);

    expect(summary?.meta.open_questions).toEqual(['q1', 'q2']);
    expect(summary?.meta.decisions).toEqual(['use dataclass']);
  });
});
