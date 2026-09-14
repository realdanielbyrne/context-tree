/**
 * Unit tests for the context-eviction policies (node:test, stdlib — no deps).
 * Run: node --test experiments/context-dedup/policies.test.mjs
 *
 * v2 after adversarial review. Every cap test asserts BOTH that the budget is
 * respected AND that eviction actually happened, so none can pass against a
 * no-op implementation (review M4). The discriminator is tested under a BINDING
 * cap, not W=1e9 (review BLOCKER 2).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractUnits, estTokens } from '../coding-harness/lib.mjs';
import {
  idleOf, anchorSet, rebuildLocal, makeRng,
  evictByRecency, evictByRandom, evictByIdle,
} from './policies.mjs';

const PINNED = [{ role: 'system', content: 'SYSTEM' }, { role: 'user', content: 'TASK' }];
/**
 * One unit = assistant(tool_call on `path`) + its tool result. `extra` pollutes the
 * fingerprint. Ids are a fixed-width counter (NOT Math.random) so unit sizes are
 * deterministic — otherwise greedy packing differs between arms for reasons that
 * have nothing to do with the selection signal.
 */
let _uid = 0;
const unit = (path, extra = '', body = 'x'.repeat(400)) => {
  const id = `c${String(_uid++).padStart(4, '0')}`;
  return [
    { role: 'assistant', content: extra, tool_calls: [{ id, function: { name: 'read_file', arguments: JSON.stringify({ path }) } }] },
    { role: 'tool', tool_call_id: id, content: body },
  ];
};
const build = (paths, extra = '', body = undefined) =>
  [...PINNED.map((m) => ({ ...m })), ...paths.flatMap((p) => unit(p, extra, body))];
const files = (m) => extractUnits(m).units.map((u) => [...u.files][0]);

function assertNoOrphans(messages) {
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== 'tool') continue;
    let j = i - 1;
    while (j >= 0 && messages[j].role === 'tool') j--;
    assert.ok(j >= 0 && messages[j].role === 'assistant' && messages[j].tool_calls?.length, `orphaned tool result @${i}`);
  }
  // reverse orphan: an assistant with tool_calls whose results were dropped
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'assistant' && messages[i].tool_calls?.length) {
      assert.equal(messages[i + 1]?.role, 'tool', `assistant tool_call @${i} lost its result`);
    }
  }
}

// ── idleOf ──────────────────────────────────────────────────────────────────
test('idleOf is NOT fooled by a shared boilerplate token (the __init__ regression)', () => {
  // Every unit's prose shares `__init__`/`do_work` — under the old fp-based idleOf
  // this collapsed every idle to ~0. Keying on file paths must give true ages.
  const m = build(['m0.py', 'm1.py', 'm2.py', 'm3.py'], 'class X:\n  def __init__(self): do_work()');
  assert.deepEqual(idleOf(extractUnits(m).units), [3, 2, 1, 0]);
});

test('idleOf resets when a file is re-referenced (reference recency, not position)', () => {
  const m = build(['a.py', 'b.py', 'c.py', 'a.py']);
  const idle = idleOf(extractUnits(m).units);
  assert.equal(idle[0], 0, 'old a.py re-referenced by the newest unit -> idle 0');
  assert.equal(idle[1], 2, 'b.py never re-referenced');
});

test('idleOf falls back to positional age for units with no file identity', () => {
  const m = [...PINNED, ...[
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'run_bash', arguments: JSON.stringify({ command: 'python3 -m unittest' }) } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'Ran 3 tests OK' },
  ], ...unit('z.py')];
  const idle = idleOf(extractUnits(m).units);
  assert.equal(idle[0], 1, 'file-less unit ages positionally');
});

test('anchorSet protects exactly the last N units and clamps', () => {
  assert.deepEqual([...anchorSet(6, 4)].sort((a, b) => a - b), [2, 3, 4, 5]);
  assert.deepEqual([...anchorSet(2, 4)].sort((a, b) => a - b), [0, 1]);
  assert.equal(anchorSet(5, 0).size, 0);
});

// ── the discriminator, under a BINDING cap ──────────────────────────────────
test('BINDING CAP: idle keeps the old re-referenced unit; recency drops it', () => {
  // a.py is read FIRST and re-read LAST -> positionally oldest but idle 0.
  const paths = ['a.py', 'b.py', 'c.py', 'd.py', 'e.py', 'f.py', 'a.py'];
  const W = 900; // binds hard: fits only a few units
  const mIdle = build(paths);
  const rIdle = evictByIdle(mIdle, W, { anchor: 1 });
  const mRec = build(paths);
  const rRec = evictByRecency(mRec, W, { anchor: 1 });

  assert.ok(rIdle.evicted > 0 && rRec.evicted > 0, 'cap must actually bind in both arms');
  assert.ok(files(mIdle).includes('a.py'), 'idle arm retains the re-referenced old unit');
  assert.ok(!files(mRec).slice(0, -1).includes('a.py'), 'recency arm drops the old a.py (keeps only a suffix)');
  assertNoOrphans(mIdle);
  assertNoOrphans(mRec);
});

// ── budget enforcement (non-vacuous) ────────────────────────────────────────
for (const [name, run] of [
  ['recency', (m, W) => evictByRecency(m, W, { anchor: 1 })],
  ['idle', (m, W) => evictByIdle(m, W, { anchor: 1 })],
  ['random', (m, W) => evictByRandom(m, W, makeRng(5), { anchor: 1 })],
]) {
  test(`${name}: respects the cap AND actually evicts (non-vacuous)`, () => {
    const m = build(Array.from({ length: 14 }, (_, i) => `f${i}.py`));
    const before = extractUnits(m).units.length;
    const W = 1200;
    const r = run(m, W);
    assert.ok(r.evicted > 0, 'must have evicted something');
    assert.ok(extractUnits(m).units.length < before, 'unit count strictly decreased');
    assert.ok(estTokens(m) <= W, `must fit the cap: ${estTokens(m)} > ${W}`);
    assert.equal(r.capViolated, false);
    assertNoOrphans(m);
  });
}

test('all three arms are VOLUME-MATCHED at the same cap (same budget, different selection)', () => {
  // fixed-width paths so every unit is byte-identical in size
  const paths = Array.from({ length: 14 }, (_, i) => `f${String(i).padStart(2, '0')}.py`);
  const W = 1200;
  const arm = (fn) => { const m = build(paths); const r = fn(m); return { tokens: estTokens(m), kept: r.kept, evicted: r.evicted }; };
  const results = [
    arm((m) => evictByRecency(m, W, { anchor: 1 })),
    arm((m) => evictByIdle(m, W, { anchor: 1 })),
    arm((m) => evictByRandom(m, W, makeRng(5), { anchor: 1 })),
  ];
  for (const r of results) {
    assert.ok(r.tokens <= W, `arm exceeded cap: ${r.tokens}`);
    assert.ok(r.evicted > 0, 'cap must bind in every arm');
  }
  // with uniform units every arm must keep the SAME NUMBER of units — only WHICH ones differ
  assert.equal(new Set(results.map((r) => r.kept)).size, 1,
    `arms not volume-matched: kept=${results.map((r) => r.kept).join(',')}`);
});

test('capViolated is reported when the forced anchor alone exceeds the cap', () => {
  const m = build(['big0.py', 'big1.py'], '', 'y'.repeat(40000));
  const r = evictByIdle(m, 500, { anchor: 2 });
  assert.equal(r.capViolated, true, 'anchor floor overriding the cap must be visible, not silent');
});

test('no-op when everything already fits (and the idle rule cannot fire)', () => {
  const m = build(['a.py', 'b.py']);
  const copy = JSON.stringify(m);
  const r = evictByIdle(m, 1e9, { anchor: 1 });
  assert.equal(r.changed, false);
  assert.equal(JSON.stringify(m), copy, 'must not mutate when nothing is evicted');
});

// ── the random control ──────────────────────────────────────────────────────
test('random control: same seed reproduces, different seeds diverge', () => {
  const paths = Array.from({ length: 16 }, (_, i) => `f${i}.py`);
  const run = (seed) => { const m = build(paths); evictByRandom(m, 1400, makeRng(seed), { anchor: 1 }); return files(m).join(','); };
  assert.equal(run(7), run(7), 'same seed must reproduce exactly');
  assert.notEqual(run(7), run(999), 'different seeds must select differently (rng is actually used)');
});

test('rebuildLocal preserves the pinned head and creation order', () => {
  const m = build(['a.py', 'b.py', 'c.py']);
  const { pinned, units } = extractUnits(m);
  rebuildLocal(m, pinned, [units[0], units[2]]);
  assert.equal(m[0].content, 'SYSTEM');
  assert.equal(m[1].content, 'TASK');
  assert.deepEqual(files(m), ['a.py', 'c.py']);
  assertNoOrphans(m);
});
