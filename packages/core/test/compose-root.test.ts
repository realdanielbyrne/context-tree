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

/**
 * D17: past `rootKeep` branches the root stops growing — older members fold
 * into ONE line. Without this the root added ~50-125 tok per closed branch
 * while being exempt from rule-4 dropping, so it alone overflowed the 8k
 * Zone B budget at n≈70-160 and the prompt grew without bound thereafter.
 */
describe('composeRootSummary D17 fold', () => {
  function manyBranches(n: number): { store: SqliteTreeStore; root: string; ids: string[] } {
    const store = openInMemoryStore();
    const root = store.insertNode({
      parent_id: null,
      kind: 'task',
      title: 'marathon task',
      span_start_seq: 1,
      span_end_seq: n * 2,
      meta_json: {},
    });
    const ids: string[] = [];
    for (let i = 1; i <= n; i += 1) {
      const node = store.insertNode({
        parent_id: root.id,
        kind: 'phase',
        title: `step ${i}`,
        phase_type: 'implementation',
        span_start_seq: i * 2 - 1,
        span_end_seq: i * 2,
        meta_json: {},
      });
      store.putSummary({
        node_id: node.id,
        model: 'leaf',
        text: `Step ${i} did the thing.`,
        meta: meta({ open_questions: i === 1 ? ['oldest question'] : [] }),
      });
      ids.push(node.id);
    }
    return { store, root: root.id, ids };
  }

  it('folds all but the newest rootKeep branches into one line carrying ids AND titles, keeps every id in node_ids', () => {
    const fx = manyBranches(5);
    const summary = composeRootSummary(fx.store, fx.root, () => NOW, 3);

    const lines = summary?.text.split('\n') ?? [];
    expect(lines[0]).toBe('marathon task');
    // The fold line sits at its oldest members' position — creation order (D5 rule 1).
    expect(lines[1]).toBe(
      `- branches 1..2 (2 folded: ${fx.ids[0]}..${fx.ids[1]}) ` +
        '— "Step 1 did the thing." .. "Step 2 did the thing." ' +
        '— call context_search or context_fetch to recall',
    );
    expect(lines.slice(2, 5)).toEqual([
      '- Step 3 did the thing.',
      '- Step 4 did the thing.',
      '- Step 5 did the thing.',
    ]);
    // open question from the FOLDED window is out of the prompt...
    expect(summary?.text).not.toContain('oldest question');
    // ...but nothing is lost on disk: ALL member ids stay fetchable.
    expect(summary?.meta.node_ids).toEqual([fx.root, ...fx.ids]);
  });

  it('is a provable no-op at or below rootKeep — the loop-7 regression guarantee', () => {
    const fx = manyBranches(3);
    const capped = composeRootSummary(fx.store, fx.root, () => NOW, 3);
    expect(capped?.text).not.toContain('folded');

    const fx2 = manyBranches(3);
    const uncapped = composeRootSummary(fx2.store, fx2.root, () => NOW, Number.POSITIVE_INFINITY);
    expect(capped?.text).toBe(uncapped?.text);
  });

  it('is deterministic and byte-stable across identical builds, fold line included', () => {
    const a = manyBranches(60);
    const b = manyBranches(60);
    const sa = composeRootSummary(a.store, a.root, () => NOW);
    const sb = composeRootSummary(b.store, b.root, () => NOW);
    // Hand-built fixtures mint clock-based node ids (the D16 deterministic-id
    // guarantee lives on the segmenter path), so compare modulo the ids: any
    // window/ordering nondeterminism would still surface here.
    const anonymize = (text?: string): string | undefined => text?.replace(/n_[0-9A-Z]{26}/g, 'n_ID');
    expect(anonymize(sa?.text)).toBe(anonymize(sb?.text));
    // Byte-stability: recomposing the same store writes no new version.
    expect(composeRootSummary(a.store, a.root, () => NOW)).toBeNull();
  });

  it('renders a flat root as branch count grows: same line count and near-same size at 500 and 5000', () => {
    const small = manyBranches(500);
    const large = manyBranches(5000);
    const s = composeRootSummary(small.store, small.root, () => NOW);
    const l = composeRootSummary(large.store, large.root, () => NOW);

    expect(s?.text.split('\n').length).toBe(l?.text.split('\n').length);
    // Node ids are fixed-width; the only growth left is digits in the fold
    // count and in the kept headlines' step numbers — O(log n), not O(n).
    // Uncapped, 4500 extra branches would have added ~100k chars.
    expect(Math.abs((l?.text.length ?? 0) - (s?.text.length ?? 0))).toBeLessThanOrEqual(60);
    // A folded member's own summary row is untouched and still queryable.
    expect(large.store.currentSummary(large.ids[0])?.text).toBe('Step 1 did the thing.');
  });
});
