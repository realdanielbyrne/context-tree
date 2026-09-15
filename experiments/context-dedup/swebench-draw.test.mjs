/**
 *   node --test experiments/context-dedup/swebench-draw.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stratumOf, drawCandidates, selectByQuota, isEligible, mulberry32, testFileOf, f2pOverlapsPatch } from './swebench-draw.mjs';

const SPECS = { 'a/x': { '1': { python: '3.9' }, old: { python: '3.6' } }, 'b/y': { '1': { python: '3.9' } }, 'c/z': { '1': { python: '3.9' } } };
const row = (id, repo, difficulty, version = '1') => ({ instance_id: id, repo, version, difficulty });
const ROWS = [
  ...Array.from({ length: 8 }, (_, i) => row(`x-${i}`, 'a/x', '<15 min fix')),
  ...Array.from({ length: 2 }, (_, i) => row(`y-${i}`, 'b/y', '<15 min fix')),
  ...Array.from({ length: 3 }, (_, i) => row(`z-${i}`, 'c/z', '15 min - 1 hour')),
  row('x-old', 'a/x', '<15 min fix', 'old'),
  row('held', 'a/x', '<15 min fix'),
];
const OPTS = { repos: ['a/x', 'b/y', 'c/z'], heldOut: ['held'], candidates: { E: 4, M: 2, H: 1 } };

test('stratumOf maps the dataset difficulty labels, merging the two longest', () => {
  assert.equal(stratumOf('<15 min fix'), 'E');
  assert.equal(stratumOf('15 min - 1 hour'), 'M');
  assert.equal(stratumOf('1-4 hours'), 'H');
  assert.equal(stratumOf('>4 hours'), 'H');
  assert.equal(stratumOf('unknown'), null);
});

test('isEligible excludes held-out, non-eligible repos and missing specs; 3.5/3.6 are now allowed', () => {
  assert.equal(isEligible(row('held', 'a/x', '<15 min fix'), SPECS, OPTS), false);
  assert.equal(isEligible(row('x-old', 'a/x', '<15 min fix', 'old'), SPECS, OPTS), true);
  assert.equal(isEligible(row('x-nospec', 'a/x', '<15 min fix', 'nope'), SPECS, OPTS), false);
  assert.equal(isEligible(row('q', 'd/w', '<15 min fix'), SPECS, OPTS), false);
  assert.equal(isEligible(row('x-1', 'a/x', '<15 min fix'), SPECS, OPTS), true);
});

test('drawCandidates is deterministic for a seed and changes with the seed', () => {
  const a = drawCandidates(ROWS, SPECS, { ...OPTS, seed: 1 }).map((c) => c.instance_id);
  const b = drawCandidates(ROWS, SPECS, { ...OPTS, seed: 1 }).map((c) => c.instance_id);
  const shuffledInput = drawCandidates([...ROWS].reverse(), SPECS, { ...OPTS, seed: 1 }).map((c) => c.instance_id);
  assert.deepEqual(a, b);
  assert.deepEqual(a, shuffledInput, 'input order must not matter');
  const seeds = new Set([1, 2, 3, 4, 5].map((s) => drawCandidates(ROWS, SPECS, { ...OPTS, seed: s }).map((c) => c.instance_id).join()));
  assert.ok(seeds.size > 1);
});

test('drawCandidates round-robins repos: a 2-instance repo is not crowded out by an 8-instance one', () => {
  // Over many seeds, so a lucky repo order cannot hide a draw that exhausts one repo first.
  for (let seed = 1; seed <= 30; seed++) {
    const e = drawCandidates(ROWS, SPECS, { ...OPTS, seed }).filter((c) => c.stratum === 'E');
    assert.equal(e.length, 4);
    assert.equal(e.filter((c) => c.repo === 'b/y').length, 2, `seed ${seed}: b/y crowded out`);
  }
});

test('drawCandidates never exceeds a stratum count and never emits ineligible rows', () => {
  const all = drawCandidates(ROWS, SPECS, { ...OPTS, seed: 3 });
  assert.equal(all.filter((c) => c.stratum === 'M').length, 2);
  assert.equal(all.filter((c) => c.stratum === 'H').length, 0);
  assert.ok(!all.some((c) => c.instance_id === 'held'));
});

test('selectByQuota accepts in order, rejects failures, and does not check past a full quota', () => {
  const cands = [
    { instance_id: '1', repo: 'r1', stratum: 'E' },
    { instance_id: '2', repo: 'r2', stratum: 'E' },
    { instance_id: '3', repo: 'r3', stratum: 'E' },
    { instance_id: '4', repo: 'r4', stratum: 'E' },
  ];
  const checked = [];
  const res = selectByQuota(cands, (c) => { checked.push(c.instance_id); return c.instance_id === '2' ? { ok: false, reason: 'install' } : { ok: true }; },
    { quota: { E: 2 }, perRepoCap: 3 });
  assert.deepEqual(res.accepted.map((c) => c.instance_id), ['1', '3']);
  assert.deepEqual(res.rejected.map((c) => [c.instance_id, c.reason]), [['2', 'install']]);
  assert.deepEqual(res.skipped.map((c) => c.instance_id), ['4']);
  assert.deepEqual(checked, ['1', '2', '3'], 'a candidate beyond a full quota must not be checked');
});

test('selectByQuota enforces the per-repo cap across strata', () => {
  const cands = [
    { instance_id: '1', repo: 'r', stratum: 'E' },
    { instance_id: '2', repo: 'r', stratum: 'M' },
    { instance_id: '3', repo: 'r', stratum: 'H' },
  ];
  const res = selectByQuota(cands, () => ({ ok: true }), { quota: { E: 5, M: 5, H: 5 }, perRepoCap: 2 });
  assert.deepEqual(res.accepted.map((c) => c.instance_id), ['1', '2']);
  assert.equal(res.skipped[0].reason, 'repo cap reached');
});

const targets = (diff) => [...String(diff).matchAll(/^\+\+\+ (?:b\/)?(.+)$/gm)].map((m) => m[1]).filter((p) => p !== '/dev/null');

test('testFileOf maps pytest and django ids to files and returns null for a docstring id', () => {
  assert.equal(testFileOf('tests/test_x.py::TestA::test_b[1 2]'), 'tests/test_x.py');
  assert.equal(testFileOf('test_foo (model_forms.tests.ModelFormBaseTest)'), 'tests/model_forms/tests.py');
  assert.equal(testFileOf("The system username is used if --username isn't provided."), null);
});

test('f2pOverlapsPatch EXCLUDES a django-10097-shaped instance: F2P modules the patches never touch', () => {
  const inst = {
    FAIL_TO_PASS: JSON.stringify(['test_a (model_forms.tests.ModelFormBaseTest)', 'test_b (expressions.tests.BasicExpressionsTests)']),
    patch: '+++ b/django/core/validators.py\n',
    test_patch: '+++ b/tests/validators/tests.py\n',
  };
  const r = f2pOverlapsPatch(inst, targets);
  assert.equal(r.ok, false);
  assert.match(r.reason, /f2p_not_in_patched_files/);
});

test('f2pOverlapsPatch keeps an instance whose F2P file is in the test patch', () => {
  const inst = { FAIL_TO_PASS: ['test_requests.py::TestRequests::test_binary_put'], patch: '+++ b/requests/models.py\n', test_patch: '+++ b/test_requests.py\n' };
  assert.equal(f2pOverlapsPatch(inst, targets).ok, true);
});

test('f2pOverlapsPatch keeps an instance whose F2P ids name no module (absence of evidence)', () => {
  const inst = { FAIL_TO_PASS: ['A docstring only.'], patch: '+++ b/x.py\n', test_patch: '+++ b/tests/y/tests.py\n' };
  assert.equal(f2pOverlapsPatch(inst, targets).ok, true);
});

test('mulberry32 is in [0,1) and reproducible', () => {
  const r1 = mulberry32(42), r2 = mulberry32(42);
  for (let i = 0; i < 100; i++) { const v = r1(); assert.equal(v, r2()); assert.ok(v >= 0 && v < 1); }
});
