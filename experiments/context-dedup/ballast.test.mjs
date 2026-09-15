/**
 * Unit tests for duplicate ballast, the superseded-read label, and the oracle
 * policy (node:test, stdlib). Run:
 *   node --test experiments/context-dedup/ballast.test.mjs
 *
 * Note this imports `stats.mjs`, NOT `sensitivity-control.mjs`: a review caught
 * that importing the experiment module executed its `main()` and launched a live
 * GPU run from the test command.
 *
 * Every cap test asserts BOTH that the budget is respected AND that eviction
 * actually happened, so none can pass against a no-op. The oracle test asserts a
 * strict improvement in USEFUL units kept — a test that only checked "oracle
 * drops duplicates" would pass even if the duplicates it dropped bought nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractUnits, estTokens } from '../coding-harness/lib.mjs';
import { evictByRecency, evictByOracle, rankOracle, evictToBudget } from './policies.mjs';
import {
  readKeyOf, supersededIndices, makeSupersededLabel, cloneReadUnit,
  makeBallastInjector, NO_BALLAST, SEP,
} from './ballast.mjs';
import { fisherOneSided, wilson, minDetectable } from './stats.mjs';

const PINNED = [{ role: 'system', content: 'SYSTEM' }, { role: 'user', content: 'TASK' }];
let _uid = 0;
const readUnit = (path, body) => {
  const id = `real${String(_uid++).padStart(4, '0')}`;
  return [
    { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path }) } }] },
    { role: 'tool', tool_call_id: id, content: body ?? `CONTENT OF ${path}\n${'x'.repeat(1560)}` },
  ];
};
const writeUnit = (path) => {
  const id = `w${String(_uid++).padStart(4, '0')}`;
  return [
    { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path, content: 'y'.repeat(1560) }) } }] },
    { role: 'tool', tool_call_id: id, content: `wrote ${path}` },
  ];
};
const unitsOf = (m) => extractUnits(m).units;
const junkCount = (m) => supersededIndices(unitsOf(m)).size;
const realCount = (m) => { const u = unitsOf(m); return u.length - supersededIndices(u).size; };

// ------------------------------------------------------------------ readKeyOf
test('readKeyOf identifies a single successful file read and nothing else', () => {
  _uid = 0;
  const m = [...PINNED, ...readUnit('a.py'), ...writeUnit('b.py')];
  const u = unitsOf(m);
  assert.ok(readKeyOf(u[0])?.startsWith(`a.py${SEP}`), 'a read must yield path+SEP+content');
  assert.equal(readKeyOf(u[1]), null, 'a write is not a read');
});

test('readKeyOf rejects failed reads — an error is not content to deduplicate', () => {
  _uid = 0;
  const m = [...PINNED, ...readUnit('missing.py', 'error: no such file missing.py')];
  assert.equal(readKeyOf(unitsOf(m)[0]), null);
});

test('readKeyOf distinguishes same path with DIFFERENT content', () => {
  _uid = 0;
  const m = [...PINNED, ...readUnit('a.py', 'v1'), ...readUnit('a.py', 'v2')];
  const u = unitsOf(m);
  assert.notEqual(readKeyOf(u[0]), readKeyOf(u[1]));
  assert.equal(supersededIndices(u).size, 0, 'an EDITED file re-read is not redundant');
});

// ---------------------------------------------------------------- the label
test('supersededIndices marks every copy but the LAST', () => {
  _uid = 0;
  const m = [...PINNED, ...readUnit('a.py'), ...readUnit('b.py'), ...readUnit('a.py'), ...readUnit('a.py')];
  const idx = supersededIndices(unitsOf(m));
  assert.deepEqual([...idx].sort((x, y) => x - y), [0, 2], 'units 0 and 2 are superseded by unit 3');
});

test('the label is DYNAMIC: a surviving lone copy stops being junk', () => {
  _uid = 0;
  const m = [...PINNED, ...readUnit('a.py'), ...readUnit('a.py')];
  assert.equal(supersededIndices(unitsOf(m)).size, 1);
  m.splice(2 + 2, 2);                                   // drop the later copy
  assert.equal(supersededIndices(unitsOf(m)).size, 0,
    'a static label would still call the remaining copy junk — that is the bug this avoids');
});

test('makeSupersededLabel agrees with supersededIndices and caches per buffer', () => {
  _uid = 0;
  const m = [...PINNED, ...readUnit('a.py'), ...readUnit('a.py'), ...readUnit('b.py')];
  const u = unitsOf(m);
  const label = makeSupersededLabel();
  const got = u.map((x, i) => label(x, i, u));
  assert.deepEqual(got, [true, false, false]);
});

// ---------------------------------------------------------------- the clone
test('cloneReadUnit reproduces content exactly and is recognised as superseded', () => {
  _uid = 0;
  const m = [...PINNED, ...readUnit('a.py')];
  const src = unitsOf(m)[0];
  const clone = cloneReadUnit(src);
  assert.equal(clone[1].content, src.slice[1].content, 'content must be byte-identical');
  assert.notEqual(clone[0].tool_calls[0].id, src.slice[0].tool_calls[0].id, 'ids must differ');
  m.splice(2, 0, ...clone);                              // clone now precedes the original
  assert.deepEqual([...supersededIndices(unitsOf(m))], [0], 'the earlier copy is the junk one');
});

// ---------------------------------------------------------------- the oracle
test('oracle never sacrifices a unique unit to keep a duplicate', () => {
  _uid = 0;
  const m = [...PINNED];
  for (let i = 0; i < 6; i++) m.push(...readUnit(`mod${i}.py`));
  const uniqueTokens = estTokens(m.slice(2));
  // duplicate each unique read once; the clone goes at the tail so the ORIGINAL is junk
  for (let i = 0; i < 6; i++) m.push(...cloneReadUnit(unitsOf(m)[i]));
  assert.equal(supersededIndices(unitsOf(m)).size, 6, 'fixture must contain 6 superseded units');
  const W = 4000;   // tight enough that the cap genuinely binds on 12 units
  assert.ok(uniqueTokens < W - 512 - estTokens(PINNED), 'fixture must let every unique unit fit');

  const r = evictByOracle(m, W, makeSupersededLabel(), { anchor: 2 });
  assert.equal(r.changed, true, 'cap must bind or the test is vacuous');
  assert.ok(estTokens(m) <= W, `budget violated: ${estTokens(m)} > ${W}`);
  assert.equal(realCount(m), 6, 'every unique unit must survive when they all fit');
  assert.ok(junkCount(m) < 6, 'duplicates must actually be evicted');
});

/** A buffer shaped like a live run: duplicates interleaved among unique reads. */
function interleaved() {
  _uid = 0;
  const m = [...PINNED.map((x) => ({ ...x }))];
  for (let i = 0; i < 8; i++) {
    m.push(...readUnit(`mod${i}.py`));
    if (i > 0) m.splice(m.length - 2, 0, ...cloneReadUnit(unitsOf(m)[0]));
  }
  return m;
}

test('DISCRIMINATOR: at the same binding cap the oracle keeps strictly more UNIQUE units', () => {
  const W = 6000;
  const a = interleaved(), b = interleaved();
  assert.deepEqual([...supersededIndices(unitsOf(a))], [...supersededIndices(unitsOf(b))],
    'arms must start from identical buffers');

  const ro = evictByOracle(a, W, makeSupersededLabel(), { anchor: 2 });
  const rr = evictByRecency(b, W, { anchor: 2 });
  assert.equal(ro.changed && rr.changed, true, 'both arms must actually evict');
  assert.ok(estTokens(a) <= W && estTokens(b) <= W, 'both arms must respect the cap');
  assert.ok(realCount(a) > realCount(b),
    `oracle kept ${realCount(a)} unique units, recency kept ${realCount(b)} — no discrimination`);
});

test('oracle is volume-matched: it does not simply keep more tokens', () => {
  const W = 6000;
  const a = interleaved(), b = interleaved();
  evictByOracle(a, W, makeSupersededLabel(), { anchor: 2 });
  evictByRecency(b, W, { anchor: 2 });
  assert.ok(Math.abs(estTokens(a) - estTokens(b)) <= 450,
    `arms must fit the same budget: ${estTokens(a)} vs ${estTokens(b)}`);
});

test('with NO duplicates present the oracle is exactly positional recency', () => {
  const mk = () => { _uid = 0; const m = [...PINNED]; for (let i = 0; i < 10; i++) m.push(...readUnit(`mod${i}.py`)); return m; };
  const a = mk(), b = mk();
  evictToBudget(a, 5000, rankOracle(NO_BALLAST), { anchor: 2 });
  evictByRecency(b, 5000, { anchor: 2 });
  assert.deepEqual(unitsOf(a).map((u) => [...u.files][0]), unitsOf(b).map((u) => [...u.files][0]));
});

// -------------------------------------------------------------- the injector
test('injector fires on schedule, duplicates real reads, and cycles distinct files', () => {
  _uid = 0;
  const inject = makeBallastInjector({ every: 2, burst: 1 });
  const m = [...PINNED, ...readUnit('a.py'), ...readUnit('b.py')];
  const fired = [];
  for (let t = 0; t < 6; t++) { fired.push(inject(m, t)); m.push(...readUnit(`new${t}.py`)); }
  assert.deepEqual(fired, [1, 0, 1, 0, 1, 0], 'must fire only on turns divisible by `every`');
  assert.equal(junkCount(m), 3, 'each injection must produce exactly one superseded unit');
});

test('injector is inert before the agent has read anything', () => {
  const inject = makeBallastInjector({ every: 1, burst: 2 });
  const m = [...PINNED];
  assert.equal(inject(m, 0), 0, 'nothing to duplicate yet');
  assert.equal(m.length, PINNED.length);
  m.push(...writeUnit('x.py'), ...writeUnit('y.py'));
  assert.equal(inject(m, 0), 0, 'writes are not duplicable reads');
});

test('injector with every<=0 or burst<=0 is inert', () => {
  _uid = 0;
  const m = [...PINNED, ...readUnit('a.py'), ...readUnit('b.py')];
  const before = m.length;
  assert.equal(makeBallastInjector({ every: 0, burst: 2 }).inject?.(m, 0) ?? makeBallastInjector({ every: 0, burst: 2 })(m, 0), 0);
  assert.equal(makeBallastInjector({ every: 2, burst: 0 })(m, 0), 0);
  assert.equal(m.length, before, 'nothing may be appended');
});

test('ANCHOR PROTECTION: injection never displaces the agent\'s own newest unit', () => {
  _uid = 0;
  const inject = makeBallastInjector({ every: 1, burst: 2 });
  const m = [...PINNED, ...readUnit('a.py'), ...readUnit('b.py')];
  for (let t = 0; t < 5; t++) { inject(m, t); m.push(...readUnit(`new${t}.py`)); }
  inject(m, 5);
  const u = unitsOf(m);
  const junk = supersededIndices(u);
  assert.equal(junk.has(u.length - 1), false,
    'the newest unit must be the agent\'s own, or the recency anchor pins junk every turn');
});

test('POSITIONAL RECENCY GETS NO FREE RIDE: it does not preferentially shed duplicates', () => {
  // The property that matters is not abstract "decorrelation" but this: under a
  // BINDING cap, does truncate-tail drop junk at a higher rate than it drops
  // unique content? If it did, it would score like the oracle without knowing
  // anything, and the oracle-vs-incumbent contrast would be meaningless.
  // Measured on a BOUNDED buffer, as the live run has — an unbounded fixture
  // skews junk early for a reason that has nothing to do with the policy.
  _uid = 0;
  const inject = makeBallastInjector({ every: 2, burst: 1 });
  const W = 6000;
  const m = [...PINNED, ...readUnit('a.py'), ...readUnit('b.py')];
  const shareOf = (mm) => { const u = unitsOf(mm); return u.length ? supersededIndices(u).size / u.length : 0; };
  let beforeSum = 0, afterSum = 0, n = 0;
  for (let t = 0; t < 30; t++) {
    inject(m, t);
    m.push(...readUnit(`new${t}.py`));
    const before = shareOf(m);
    const r = evictByRecency(m, W, { anchor: 4 });
    if (r.changed) { beforeSum += before; afterSum += shareOf(m); n += 1; }
  }
  assert.ok(n >= 5, `the cap must bind repeatedly for this to mean anything (bound ${n} times)`);
  const drift = (beforeSum - afterSum) / n;
  assert.ok(Math.abs(drift) < 0.15,
    `positional recency shifts junk share by ${drift.toFixed(3)} per eviction — it is getting the oracle's answer for free`);
});

test('duplicates are size-matched to real units by construction', () => {
  _uid = 0;
  const m = interleaved();
  const u = unitsOf(m);
  const junk = supersededIndices(u);
  const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const j = avg(u.filter((_, i) => junk.has(i)).map((x) => estTokens(x.slice)));
  const r = avg(u.filter((_, i) => !junk.has(i)).map((x) => estTokens(x.slice)));
  assert.ok(j / r > 0.8 && j / r < 1.25, `size ratio ${(j / r).toFixed(2)} biases the knapsack`);
});

// ------------------------------------------------------------------ the stats
test('fisherOneSided matches known values and respects direction', () => {
  assert.ok(Math.abs(fisherOneSided(8, 2, 2, 8) - 0.011507) < 1e-4);
  assert.ok(Math.abs(fisherOneSided(7, 3, 2, 8) - 0.034889) < 1e-4);
  assert.ok(fisherOneSided(5, 5, 5, 5) > 0.5);
  assert.ok(fisherOneSided(2, 8, 8, 2) > 0.99, 'a worse treatment must never be significant');
});

test('minDetectable states honestly when a design CANNOT reach significance', () => {
  assert.equal(minDetectable(10, 0), 4);
  assert.equal(minDetectable(10, 3), 8);
  assert.equal(minDetectable(10, 7), null, 'at 7/10 control, no treatment count reaches p<0.05');
});

test('wilson brackets the point estimate and stays in [0,1]', () => {
  const [lo, hi] = wilson(3, 10);
  assert.ok(lo > 0 && lo < 0.3 && hi > 0.3 && hi < 1);
  assert.deepEqual(wilson(0, 0), [0, 0]);
});
