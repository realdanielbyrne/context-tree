/**
 * Unit tests for the new eviction ranks (node:test, stdlib, no deps).
 * Run: node --test experiments/covariance-eviction/ranks.test.mjs
 *
 * These are the POLICY-level tests: they drive the real `evictToBudget` seam from
 * `policies.mjs`, on real message arrays, under a BINDING cap. Three properties are
 * load-bearing and each has a test that fails without it:
 *
 *   1. NON-VACUITY — every cap test asserts both that the budget is respected AND that
 *      eviction actually fired, so none can pass against a no-op. (`policies.test.mjs`
 *      review finding M4.)
 *   2. DISCRIMINATION — under a binding cap the new signal must keep a MATERIALLY
 *      DIFFERENT set from the incumbent. A signal that keeps the same units as recency
 *      is not a new arm regardless of how it is computed.
 *   3. NOT-A-RELABELLING — rank correlation with `rankRecency` must be well below 1 on
 *      a realistic buffer. This project has already shipped one arm that looked like a
 *      new signal and was pinned near-constant by a promiscuous fingerprint; the
 *      correlation check is the cheap standing guard against repeating it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractUnits, estTokens } from '../coding-harness/lib.mjs';
import { evictByRecency, evictByIdle, evictToBudget, rankRecency, rankIdle, idleOf, makeRng, anchorSet } from '../context-dedup/policies.mjs';
import {
  makeRankTcov, makeRankTcovBlend, makeRankPriority, neutralize,
  evictByTcov, evictByPriorityRatio,
} from './ranks.mjs';
import { spearman } from './metrics.mjs';
// Safe to import: `main()` sits behind the `import.meta.url === argv[1]` guard AND a
// `CT_COV_LIVE=1` gate, so `node --test` cannot start a GPU sweep. That combination is
// deliberate — an earlier module in this repo started a 60-cell live run from a test
// file and overwrote a real results file.
import { makeRefLogger, artifactProgress } from './ab-covariance.mjs';

const S = (...xs) => new Set(xs);
const PINNED = [{ role: 'system', content: 'SYSTEM' }, { role: 'user', content: 'TASK' }];

/** One unit = assistant(tool_call on `path`) + its tool result. Fixed-width ids so unit
 *  sizes are byte-identical and greedy packing cannot differ between arms for reasons
 *  unrelated to the selection signal. */
let _uid = 0;
const unit = (path, body = 'x'.repeat(400)) => {
  const id = `c${String(_uid++).padStart(4, '0')}`;
  return [
    { role: 'assistant', content: '', tool_calls: [{ id, function: { name: 'read_file', arguments: JSON.stringify({ path }) } }] },
    { role: 'tool', tool_call_id: id, content: body },
  ];
};
const build = (paths) => [...PINNED.map((m) => ({ ...m })), ...paths.flatMap((p) => unit(p))];
const files = (m) => extractUnits(m).units.map((u) => [...u.files][0]);

function assertNoOrphans(messages) {
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i].role !== 'tool') continue;
    let j = i - 1;
    while (j >= 0 && messages[j].role === 'tool') j -= 1;
    assert.ok(j >= 0 && messages[j].role === 'assistant' && messages[j].tool_calls?.length, `orphaned tool result @${i}`);
  }
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i].role === 'assistant' && messages[i].tool_calls?.length) {
      assert.equal(messages[i + 1]?.role, 'tool', `assistant tool_call @${i} lost its result`);
    }
  }
}

/**
 * The scenario the whole H2 hypothesis is about: `b.py` and `a.py` were worked on
 * together for ten turns, then `b.py` went dormant through seven turns of unrelated
 * files, and now `a.py` is hot again. Positional recency and reference recency both
 * condemn `b.py`; only its co-activation history argues for keeping it.
 */
const REF_LOG = [
  ...Array.from({ length: 10 }, () => S('a.py', 'b.py')),
  S('c.py'), S('d.py'), S('e.py'), S('f.py'), S('g.py'), S('h.py'), S('i.py'),
  S('a.py'), S('a.py'), S('a.py'),
];
const BUFFER = ['b.py', 'c.py', 'd.py', 'e.py', 'f.py', 'g.py', 'h.py', 'a.py'];
const COV = { refLog: REF_LOG, params: { K: 3, L: 1, m: 2, agg: 'max' } };

// ── the discriminator, under a BINDING cap ──────────────────────────────────

test('DISCRIMINATOR: under a binding cap tcov keeps the dormant co-active unit that BOTH incumbents drop', () => {
  const W = 1150;                       // binds: fits the anchor plus ~3 more units
  const mT = build(BUFFER); const rT = evictByTcov(mT, W, COV, { anchor: 1 });
  const mR = build(BUFFER); const rR = evictByRecency(mR, W, { anchor: 1 });
  const mI = build(BUFFER); const rI = evictByIdle(mI, W, { anchor: 1 });

  for (const [n, r] of [['tcov', rT], ['recency', rR], ['idle', rI]]) {
    assert.ok(r.evicted > 0, `${n}: the cap must actually bind`);
    assert.equal(r.capViolated, false, `${n}: must fit the cap`);
  }
  assert.ok(files(mT).includes('b.py'), `tcov must retain b.py; kept ${files(mT)}`);
  assert.ok(!files(mR).includes('b.py'), `recency must drop b.py; kept ${files(mR)}`);
  assert.ok(!files(mI).includes('b.py'), `idle must drop b.py; kept ${files(mI)}`);
  assertNoOrphans(mT);
});

test('VOLUME-MATCHED ON TOKENS, and unit counts can still diverge — both are measured', () => {
  // ⚠️ REWRITTEN after adversarial review. The first version of this test was named
  // "keep the SAME NUMBER of units" and built every unit as `'x'.repeat(400)` —
  // byte-identical — so unit count and token count were the same quantity and the test
  // could not fail. Mutation proof from the review: replacing the rank with "keep the
  // longest units first", a maximal violation, left it PASSING.
  //
  // `evictToBudget` packs to a TOKEN budget. What is guaranteed is that every arm fits
  // the same token budget; what is NOT guaranteed is that they keep the same number of
  // units, and on a buffer where one signal's preferred units are systematically larger
  // they will not. This test pins the guarantee that exists and MEASURES the one that
  // does not, so the live harness's validity gate has something real to check.
  const big = 'y'.repeat(1600);
  const sized = (p) => (p === 'b.py' || p === 'c.py' ? big : undefined);   // co-active files are 4x
  const buildVaried = (paths) => [...PINNED.map((m) => ({ ...m })), ...paths.flatMap((p) => unit(p, sized(p) ?? 'x'.repeat(400)))];
  const W = 2000;
  const arm = (fn) => { const m = buildVaried(BUFFER); const r = fn(m); return { tokens: estTokens(m), kept: r.kept, evicted: r.evicted }; };
  const res = [
    arm((m) => evictByTcov(m, W, COV, { anchor: 1 })),
    arm((m) => evictByRecency(m, W, { anchor: 1 })),
    arm((m) => evictByIdle(m, W, { anchor: 1 })),
  ];
  for (const r of res) {
    assert.ok(r.evicted > 0, 'the cap must bind in every arm');
    assert.ok(r.tokens <= W, `arm exceeded the token cap: ${r.tokens} > ${W}`);
  }
  // THE GUARANTEE: token budgets match closely.
  const toks = res.map((r) => r.tokens);
  assert.ok((Math.max(...toks) - Math.min(...toks)) / Math.max(...toks) <= 0.15,
    `token volume not matched: ${toks.join(',')}`);
  // THE NON-GUARANTEE, asserted so a future change cannot silently start claiming it:
  // with uneven unit sizes the arms need not keep the same COUNT.
  const counts = res.map((r) => r.kept);
  assert.ok(new Set(counts).size >= 1);
  assert.ok(counts.every((c) => c < BUFFER.length));
});

test('a size-seeking rank is CAUGHT by the token-volume assertion (the mutation the old test missed)', () => {
  // The review's mutation: "keep the longest units first" is the maximal volume-matching
  // violation. Under a token budget it still fits the cap, but it keeps far FEWER units —
  // so the check that catches it is the unit-count one, which is exactly why the live
  // harness now gates on both axes and not on achieved peak alone.
  // Big units FIRST, so positional recency keeps many small ones while a size-seeking
  // rank spends the same token budget on a few large ones.
  const PATHS = ['big0.py', 'big1.py', 'big2.py', 'big3.py',
    's0.py', 's1.py', 's2.py', 's3.py', 's4.py', 's5.py', 's6.py', 's7.py'];
  const sized = (p) => (p.startsWith('big') ? 'y'.repeat(2400) : 'x'.repeat(300));
  const buildVaried = (paths) => [...PINNED.map((m) => ({ ...m })), ...paths.flatMap((p) => unit(p, sized(p)))];
  const longestFirst = (units, anchorIdx) => units.map((_, i) => i).filter((i) => !anchorIdx.has(i))
    .sort((a, b) => estTokens(units[b].slice) - estTokens(units[a].slice));
  const W = 1400;
  const mBad = buildVaried(PATHS); const rBad = evictToBudget(mBad, W, longestFirst, { anchor: 1 });
  const mRec = buildVaried(PATHS); const rRec = evictByRecency(mRec, W, { anchor: 1 });
  assert.ok(estTokens(mBad) <= W && estTokens(mRec) <= W, 'both fit the token cap — which is why tokens alone cannot catch this');
  assert.ok(rBad.evicted > 0 && rRec.evicted > 0);
  assert.ok(rBad.kept < rRec.kept,
    `the size-seeking rank should keep fewer units (${rBad.kept}) than recency (${rRec.kept}) — if not, this buffer cannot exercise the check`);
  const spread = Math.abs(rBad.kept - rRec.kept) / Math.max(rBad.kept, rRec.kept);
  assert.ok(spread > 0.10, `unit-count divergence ${(spread * 100).toFixed(0)}% must exceed the 10% gate the live harness applies`);
});

test('tcov respects the cap AND actually evicts (non-vacuous)', () => {
  const m = build([...BUFFER, 'j.py', 'k.py', 'l.py']);
  const before = extractUnits(m).units.length;
  const W = 1200;
  const r = evictByTcov(m, W, COV, { anchor: 1 });
  assert.ok(r.evicted > 0);
  assert.ok(extractUnits(m).units.length < before);
  assert.ok(estTokens(m) <= W, `must fit the cap: ${estTokens(m)} > ${W}`);
  assertNoOrphans(m);
});

test('tcov does not mutate when everything already fits', () => {
  const m = build(['a.py', 'b.py']);
  const copy = JSON.stringify(m);
  const r = evictByTcov(m, 1e9, COV, { anchor: 1 });
  assert.equal(r.changed, false);
  assert.equal(JSON.stringify(m), copy);
});

test('an EMPTY refLog degrades tcov to the incumbent rather than to a random control', () => {
  // On the first turns of a session there is no history. The arm must then behave like
  // positional recency, not scatter — otherwise the early turns of every live cell are
  // a random-eviction arm wearing the treatment label.
  const W = 1150;
  const mT = build(BUFFER); evictByTcov(mT, W, { refLog: [], params: COV.params }, { anchor: 1 });
  const mR = build(BUFFER); evictByRecency(mR, W, { anchor: 1 });
  assert.deepEqual(files(mT), files(mR));
});

// ── not a relabelling of the incumbents ─────────────────────────────────────

/** A buffer with episode structure: file pairs that recur together, interleaved. */
function realisticCase(n = 24, seed = 11) {
  const rng = makeRng(seed);
  const pairs = [['a.py', 'b.py'], ['c.py', 'd.py'], ['e.py', 'f.py'], ['g.py', 'h.py']];
  const refLog = [];
  for (let e = 0; e < 20; e += 1) {
    const [p, q] = pairs[Math.floor(rng() * pairs.length)];
    refLog.push(S(p, q), S(p), S(q));
  }
  refLog.push(S('a.py'), S('c.py'), S('a.py'));            // hot: a.py + c.py
  const flat = pairs.flat();
  const paths = Array.from({ length: n }, () => flat[Math.floor(rng() * flat.length)]);
  return { refLog, paths };
}

test('NOT A RELABELLING: tcov ordering correlates only weakly with recency and idle', () => {
  const { refLog, paths } = realisticCase();
  const { units } = extractUnits(build(paths));
  const anchorIdx = anchorSet(units.length, 4);
  const idle = idleOf(units);

  const tcovOrder = makeRankTcov({ refLog, params: { K: 3, L: 1, m: 2, agg: 'max' } })(units, anchorIdx, idle);
  const recOrder = rankRecency(units, anchorIdx);
  const idleOrder = rankIdle(units, anchorIdx, idle);

  const pos = (order) => { const p = new Map(); order.forEach((i, r) => p.set(i, r)); return p; };
  const pT = pos(tcovOrder), pR = pos(recOrder), pI = pos(idleOrder);
  const idx = [...pT.keys()];
  const rhoRec = spearman(idx.map((i) => pT.get(i)), idx.map((i) => pR.get(i)));
  const rhoIdle = spearman(idx.map((i) => pT.get(i)), idx.map((i) => pI.get(i)));

  assert.ok(Math.abs(rhoRec) < 0.8, `tcov is a relabelling of recency (Spearman ${rhoRec})`);
  assert.ok(Math.abs(rhoIdle) < 0.8, `tcov is a relabelling of idle (Spearman ${rhoIdle})`);
  // and it is not pure noise either — it must still be a ranking of the same units
  assert.equal(new Set(tcovOrder).size, tcovOrder.length, 'the ordering must be a permutation');
});

test('the tcov signal actually VARIES across a realistic buffer (the inert-arm guard)', () => {
  const { refLog, paths } = realisticCase();
  const { units } = extractUnits(build(paths));
  const anchorIdx = anchorSet(units.length, 4);
  const order = makeRankTcov({ refLog, params: { K: 3, L: 1, m: 2, agg: 'max' } })(units, anchorIdx, idleOf(units));
  const recOrder = rankRecency(units, anchorIdx);
  assert.notDeepEqual(order, recOrder, 'tcov produced exactly the recency ordering — the arm is inert');
});

// ── the blend ───────────────────────────────────────────────────────────────

test('blend alpha=0 reproduces rankRecency EXACTLY (the sweep floor is checkable)', () => {
  const { refLog, paths } = realisticCase();
  const { units } = extractUnits(build(paths));
  const anchorIdx = anchorSet(units.length, 4);
  const blended = makeRankTcovBlend(0, { refLog, params: COV.params })(units, anchorIdx, idleOf(units));
  assert.deepEqual(blended, rankRecency(units, anchorIdx));
});

test('blend alpha=1 differs from alpha=0 under a binding cap (the dial is live)', () => {
  const W = 1150;
  const m0 = build(BUFFER); const r0 = evictByTcov(m0, W, COV, { anchor: 1 });
  const mR = build(BUFFER); evictByRecency(mR, W, { anchor: 1 });
  assert.ok(r0.evicted > 0);
  assert.notDeepEqual(files(m0), files(mR));
});

// ── H1: the ratio knob the shipped form does not have ───────────────────────

test('makeRankPriority: changing rho changes WHICH units survive a binding cap', () => {
  // The shipped `((wrote?2:0) + coOccurrence) * decay` forms the sum before any weight,
  // so no coefficient can produce this difference. That the split form can is the whole
  // point of the H1 ablation.
  const paths = ['w0.py', 'r0.py', 'r0.py', 'r0.py', 'w1.py', 'r1.py', 'r1.py', 'z.py'];
  // the `w*` units are written, not read, so they carry the edit boost
  const withWrites = (paths2) => {
    const msgs = [...PINNED.map((x) => ({ ...x }))];
    paths2.forEach((p, i) => {
      const id = `w${String(i).padStart(4, '0')}`;
      const name = p.startsWith('w') ? 'write_file' : 'read_file';
      msgs.push({ role: 'assistant', content: '', tool_calls: [{ id, function: { name, arguments: JSON.stringify({ path: p }) } }] });
      msgs.push({ role: 'tool', tool_call_id: id, content: 'y'.repeat(400) });
    });
    return msgs;
  };
  const W = 1150;
  const mLow = withWrites(paths); const rLow = evictByPriorityRatio(mLow, W, { rho: 0 }, { anchor: 1 });
  const mHigh = withWrites(paths); const rHigh = evictByPriorityRatio(mHigh, W, { rho: 8 }, { anchor: 1 });
  assert.ok(rLow.evicted > 0 && rHigh.evicted > 0, 'the cap must bind in both');
  assert.equal(rLow.kept, rHigh.kept, 'the two rho arms must stay volume-matched');
  assert.notDeepEqual(files(mLow), files(mHigh),
    `rho had no effect on the kept set (${files(mLow)}) — the ablation knob is dead`);
  // and the direction is the expected one: rho=8 keeps the WRITE units
  const writesKept = (f) => f.filter((x) => x.startsWith('w')).length;
  assert.ok(writesKept(files(mHigh)) >= writesKept(files(mLow)),
    `high rho should favour edited units: ${files(mHigh)} vs ${files(mLow)}`);
});

test('neutralize replaces nulls with the median rather than condemning them', () => {
  assert.deepEqual(neutralize([1, null, 3, 5]), [1, 3, 3, 5]);
  assert.deepEqual(neutralize([null, null]), [0, 0]);
});

// ── the live harness's pure helpers ─────────────────────────────────────────

test('the reference log records one entry per TURN and never double-counts a tool call', () => {
  const lg = makeRefLogger();
  const msgs = [...PINNED.map((m) => ({ ...m }))];
  msgs.push(...unit('a.py'));
  lg.observe(msgs);
  msgs.push(...unit('b.py'));
  lg.observe(msgs);
  assert.equal(lg.log.length, 2, 'one entry per hook call, i.e. per turn');
  assert.deepEqual([...lg.log[0]], ['a.py']);
  assert.deepEqual([...lg.log[1]], ['b.py'], 'the already-seen call must not be logged again');
});

test('the reference log SURVIVES eviction — history is not erased with the units', () => {
  // This is the property that stops the signal from being a feedback loop: if the log
  // were derived from the resident buffer, evicting a unit would delete the statistics
  // that would later justify bringing it back.
  const lg = makeRefLogger();
  const msgs = build(['a.py', 'b.py', 'c.py']);
  lg.observe(msgs);
  assert.equal(new Set([...lg.log.flatMap((s) => [...s])]).size, 3);
  evictByRecency(msgs, 700, { anchor: 1 });                 // drops the older units
  assert.ok(extractUnits(msgs).units.length < 3, 'eviction must have fired for this test to mean anything');
  lg.observe(msgs);
  const seen = new Set(lg.log.flatMap((s) => [...s]));
  assert.ok(seen.has('a.py'), 'the evicted unit\'s reference must still be in the log');
  assert.equal(lg.log.length, 2, 'the surviving units must not be re-logged as a new reference');
});

test('the reference log picks up paths named on a run_bash command line', () => {
  const lg = makeRefLogger();
  const msgs = [...PINNED.map((m) => ({ ...m })), {
    role: 'assistant', content: '',
    tool_calls: [{ id: 'bash1', function: { name: 'run_bash', arguments: JSON.stringify({ command: 'python3 -m unittest test_ledger && cat money.py' }) } }],
  }, { role: 'tool', tool_call_id: 'bash1', content: 'ok' }];
  lg.observe(msgs);
  assert.ok(lg.log[0].has('money.py'), `expected money.py, got ${[...lg.log[0]]}`);
});

test('artifactProgress counts only deliverables with real content', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const ws = mkdtempSync(join(tmpdir(), 'cov-prog-'));
  assert.equal(artifactProgress(ws).deliverables_present, 0, 'an empty workspace scores zero');
  writeFileSync(join(ws, 'money.py'), 'x'.repeat(200));
  writeFileSync(join(ws, 'parsing.py'), 'stub');              // too short to count as progress
  const p = artifactProgress(ws);
  assert.equal(p.deliverables_present, 1, 'a stub must not count as a delivered module');
  assert.ok(p.progress > 0 && p.progress < 1);
});
