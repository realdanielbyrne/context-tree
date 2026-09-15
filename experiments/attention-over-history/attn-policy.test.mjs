/**
 * Unit tests for the attention eviction seam (node:test, stdlib).
 *
 * Rerun:
 *   node --test experiments/attention-over-history/attn-policy.test.mjs
 *
 * Every test names the broken implementation it catches. Three of these mirror
 * defects that actually shipped in this repo:
 *   - an INERT signal that ranked every unit the same (`policies.mjs` BLOCKER 1)
 *   - a treatment that turned out to be positional recency (pooled p = 1.000)
 *   - arms that were not volume-matched (`report-sensitivity-control.md`)
 * A test that passes against a stub would let all three back in.
 *
 * Note this imports only `attn-policy.mjs` and `policies.mjs`, never an
 * experiment driver — the ballast tests learned the hard way that importing an
 * experiment module runs its `main()` and launches a live GPU sweep from `npm test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractUnits, estTokens } from '../coding-harness/lib.mjs';
import { evictToBudget, rankRecency, DEFAULT_ANCHOR } from '../context-dedup/policies.mjs';
import {
  rankAttention, rankAntiAttention, rankResidualAttention,
  normalizeMass, decayScores, residualizeAgainstPosition, spearman,
  scoresFromResults, DEFAULT_HALF_LIFE_TURNS,
} from './attn-policy.mjs';

const PINNED = [{ role: 'system', content: 'SYSTEM' }, { role: 'user', content: 'TASK' }];
let _uid = 0;
const readUnit = (path, filler = 1560) => {
  const id = `r${String(_uid++).padStart(4, '0')}`;
  return [
    { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path }) } }] },
    { role: 'tool', tool_call_id: id, content: `CONTENT OF ${path}\n${'x'.repeat(filler)}` },
  ];
};
const buildMessages = (n) => {
  const m = [...PINNED];
  for (let i = 0; i < n; i++) m.push(...readUnit(`f${i}.py`));
  return m;
};
const anchorOf = (n, k = DEFAULT_ANCHOR) =>
  new Set(Array.from({ length: Math.min(k, n) }, (_, j) => n - 1 - j));

// ---------------------------------------------------------------------------

test('rankAttention keeps the highest-attention units first', () => {
  // BREAKS: a comparator with the sign flipped, which would evict exactly the
  // units the hypothesis says to keep.
  const mass = [0.01, 0.40, 0.05, 0.30, 0.02, 0.22];
  const units = mass.map(() => ({}));
  const order = rankAttention((u, i) => mass[i])(units, new Set());
  assert.equal(order[0], 1, 'highest mass not ranked first');
  assert.equal(order[1], 3);
  assert.equal(order.at(-1), 0, 'lowest mass not ranked last');
  assert.deepEqual([...order].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]);
});

test('rankAttention is NOT positional recency', () => {
  // BREAKS: any implementation that falls through to index order. This is the
  // exact failure mode that made reference-recency indistinguishable from plain
  // recency in the live A/B (pooled p = 1.000), so the ordering here is built to
  // be maximally anti-positional: the OLDEST unit carries the most mass.
  const mass = [0.50, 0.03, 0.05, 0.02, 0.30, 0.10];
  const units = mass.map(() => ({}));
  const attn = rankAttention((u, i) => mass[i])(units, new Set());
  const rec = rankRecency(units, new Set());
  assert.notDeepEqual(attn, rec);
  assert.equal(attn[0], 0, 'oldest-but-highest-attention unit was not kept first');
  const rho = spearman(attn.map((_, k) => k), attn);
  assert.ok(rho < 0.5, `attention order tracks position too closely (rho=${rho.toFixed(3)})`);
});

test('rankAttention respects the anchor and never orphans a tool result', () => {
  // BREAKS: a policy that ignores the protected recency anchor, or one that
  // slices messages instead of units and separates a tool_call from its result —
  // the structural trap `extractUnits` exists to prevent.
  const messages = buildMessages(14);
  const { units } = extractUnits(messages);
  const mass = units.map((_, i) => (i % 3 === 0 ? 0.2 : 0.01));
  const anchor = anchorOf(units.length);
  const order = rankAttention((u, i) => mass[i])(units, anchor);
  for (const a of anchor) assert.ok(!order.includes(a), `anchor unit ${a} appeared in the rank`);

  const before = estTokens(messages);
  const res = evictToBudget(messages, 3000, rankAttention((u, i) => mass[i]));
  assert.ok(res.changed, 'nothing was evicted; the test would pass against a no-op');
  assert.ok(estTokens(messages) < before, 'context did not shrink');
  assert.ok(estTokens(messages) <= 3000, "budget violated");
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'tool') {
      const prev = messages[i - 1];
      const ok = prev && ((prev.role === 'assistant' && prev.tool_calls?.length) || prev.role === 'tool');
      assert.ok(ok, `orphaned tool result at ${i}`);
    }
  }
});

test('evictToBudget matches arms on TOKENS but NOT on unit count or splices', () => {
  // This test was previously named "arms are VOLUME-matched, differing only in
  // what they keep" and asserted only a token ratio — which cannot catch the
  // divergence this design calls decisive. It now asserts the real behaviour,
  // measured on the actual harness (50 units, heavy-tailed, rho(mass,len)=+0.65,
  // W=8000, 12 trials): kept tokens match to ~0.4% while kept UNITS diverge
  // 1.56x mean / 2.0x max and drop SPLICES diverge 7.0x mean / 13x max.
  //
  // BREAKS: the claim that fitting a shared budget makes arms comparable. It
  // does not, and a test that only checks tokens would certify these arms as
  // matched when they are not.
  const mkMessages = () => {
    const m = [...PINNED];
    for (let i = 0; i < 26; i++) m.push(...readUnit(`f${i}.py`, 120 + ((i * 37) % 11) * 520));
    return m;
  };
  const a = mkMessages(), b = mkMessages();
  const { units } = extractUnits(a);
  const lens = units.map((u) => estTokens(u.slice));
  // attention correlated with length, as measured
  const mass = lens.map((L, i) => Math.pow(L, 0.6) * (1 + ((i * 7919) % 53) / 53));

  const W = 6000;
  const ra = evictToBudget(a, W, rankAttention((u, i) => mass[i]));
  const rb = evictToBudget(b, W, rankRecency);
  assert.ok(ra.changed && rb.changed, 'one arm did not evict; the comparison is vacuous');
  assert.ok(estTokens(a) <= W && estTokens(b) <= W, 'budget violated');

  // TOKENS: tightly matched, which is all the incumbent design ever checked
  const tokRatio = Math.max(estTokens(a), estTokens(b)) / Math.min(estTokens(a), estTokens(b));
  assert.ok(tokRatio <= 1.10, `token ratio ${tokRatio.toFixed(3)} — fixture is not budget-bound`);

  // UNIT COUNT: free to diverge, and it does
  const unitRatio = Math.max(ra.kept, rb.kept) / Math.min(ra.kept, rb.kept);
  assert.ok(unitRatio > 1.10,
    `kept-unit counts did not diverge (${ra.kept} vs ${rb.kept}); the fixture no longer ` +
    'demonstrates the confound this design is built around');
  assert.notDeepEqual(a.map((m) => m.content), b.map((m) => m.content));
});

test('an INERT (constant) score degrades to recency instead of ranking arbitrarily', () => {
  // BREAKS: a policy that silently produces a meaningless order when the signal
  // carries no information. The live consequence of not noticing this was a full
  // sweep of an arm that could not differ from its control.
  const units = Array.from({ length: 10 }, () => ({}));
  const order = rankAttention(() => 0.1)(units, new Set());
  assert.deepEqual(order, rankRecency(units, new Set()),
    'a constant score did not fall back to recency');
});

test('an unscored unit is NEUTRAL (median), not worthless', () => {
  // BREAKS: treating a missing score as 0. That ranks every not-yet-measured
  // unit below every measured one, so the policy evicts its FRESHEST content
  // first — the inverse of every incumbent. The bug is invisible to a test that
  // only checks "unscored units come last", because that is exactly what the bug
  // does; this fixture is built so the median lands in the MIDDLE of the scored
  // range and the two implementations must order differently.
  const scores = [0.50, 0.30, 0.02, NaN, 0.01, 0.40];
  const units = scores.map(() => ({}));
  const order = rankAttention((u, i) => scores[i])(units, new Set());
  assert.deepEqual([...order].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]);
  const posOfUnscored = order.indexOf(3);
  assert.ok(posOfUnscored > 0 && posOfUnscored < order.length - 1,
    `unscored unit landed at an extreme (index ${posOfUnscored} of ${order.length})`);
  // it must outrank the genuinely low-attention units...
  assert.ok(posOfUnscored < order.indexOf(2), 'unscored ranked below a low-attention unit');
  assert.ok(posOfUnscored < order.indexOf(4));
  // ...and rank below the genuinely high-attention ones
  assert.ok(posOfUnscored > order.indexOf(0), 'unscored ranked above the top-attention unit');
  assert.ok(posOfUnscored > order.indexOf(5));
});

test('rankAttention never throws on a fully unscored context', () => {
  // BREAKS: a NaN comparator or a divide-by-zero when nothing has been measured
  // yet — the state every run is in on turn 1.
  const units = Array.from({ length: 5 }, () => ({}));
  const order = rankAttention(() => NaN)(units, new Set());
  assert.deepEqual(order, rankRecency(units, new Set()),
    'an entirely unscored context did not fall back to recency');
});

test('normalizeMass renormalises over the CANDIDATES, not the whole array', () => {
  // BREAKS: normalising over everything. The pinned head absorbs 47-80% of all
  // last-row attention (measured), so a whole-array normaliser mostly reports
  // how big the sink was on that turn.
  const raw = [10, 0.1, 0.2, 0.3, 0.4];      // index 0 is the sink
  const n = normalizeMass(raw, [1, 2, 3, 4]);
  assert.ok(Math.abs(n.slice(1).reduce((s, v) => s + v, 0) - 1) < 1e-12);
  assert.equal(n[0], 0, 'the excluded sink received weight');
  assert.ok(Math.abs(n[4] / n[1] - 4) < 1e-9, 'relative proportions were not preserved');
  // a degenerate all-zero candidate set must not produce NaN
  const z = normalizeMass([0, 0, 0], [0, 1, 2]);
  assert.ok(z.every(Number.isFinite));
});

test('decayScores actually decays, and halves at the half-life', () => {
  // BREAKS: a no-op decay, which would let a score measured 30 turns ago keep
  // driving eviction forever.
  const s = [1, 1, 1];
  const d = decayScores(s, [0, DEFAULT_HALF_LIFE_TURNS, 2 * DEFAULT_HALF_LIFE_TURNS]);
  assert.equal(d[0], 1);
  assert.ok(Math.abs(d[1] - 0.5) < 1e-12, 'no halving at the half-life');
  assert.ok(Math.abs(d[2] - 0.25) < 1e-12);
  assert.deepEqual(decayScores(s, [5, 5, 5], 0), s, 'halfLife<=0 should disable decay');
});

test('rankResidualAttention removes the positional trend that rankAttention keeps', () => {
  // BREAKS: a residualiser that is a no-op. On a signal with a strong positional
  // trend the two arms MUST differ, or the strict form buys nothing.
  const mass = [0.02, 0.18, 0.06, 0.10, 0.30, 0.24];   // trending up with position
  const units = mass.map(() => ({}));
  const plain = rankAttention((u, i) => mass[i])(units, new Set());
  const resid = rankResidualAttention((u, i) => mass[i])(units, new Set());
  assert.notDeepEqual(plain, resid);
  const rhoPlain = Math.abs(spearman(mass, mass.map((_, i) => i)));
  const r = residualizeAgainstPosition(mass, mass.map((_, i) => i));
  const rhoResid = Math.abs(spearman(r, mass.map((_, i) => i)));
  assert.ok(rhoPlain > 0.7, `fixture has no positional trend (rho=${rhoPlain.toFixed(3)})`);
  assert.ok(rhoResid < 0.2, `trend survived residualisation (rho=${rhoResid.toFixed(3)})`);
});

test('rankAntiAttention is the exact reverse — a real direction check', () => {
  // BREAKS: a direction check that is accidentally the same as the treatment,
  // which would make the required sign unfalsifiable.
  const mass = [0.4, 0.1, 0.25, 0.05, 0.2];
  const units = mass.map(() => ({}));
  const pro = rankAttention((u, i) => mass[i])(units, new Set());
  const anti = rankAntiAttention((u, i) => mass[i])(units, new Set());
  assert.deepEqual(anti, [...pro].reverse());
  assert.notDeepEqual(anti, pro);
});

test('spearman is correct on known cases and safe on degenerates', () => {
  // BREAKS: tie handling that invents an ordering, or a divide-by-zero.
  assert.ok(Math.abs(spearman([1, 2, 3, 4], [1, 2, 3, 4]) - 1) < 1e-12);
  assert.ok(Math.abs(spearman([1, 2, 3, 4], [4, 3, 2, 1]) + 1) < 1e-12);
  assert.equal(spearman([1, 1, 1, 1], [1, 2, 3, 4]), 0);
  assert.ok(Math.abs(spearman([1, 1, 2, 2], [1, 2, 1, 2])) < 1e-12);
});

test('scoresFromResults keys on an explicit unit key, not array position', () => {
  // BREAKS: aligning the offline replay's indices with the live run's by
  // position. After a single eviction those indexings differ, and a silently
  // misaligned score is an inert arm that still looks like it is working.
  const turn = { mass: [0.9, 0.1, 0.5] };
  const units = [{ k: '2' }, { k: '0' }, { k: 'missing' }];
  const scoreOf = scoresFromResults(turn, (u) => u.k);
  assert.equal(scoreOf(units[0], 0, units), 0.5);
  assert.equal(scoreOf(units[1], 1, units), 0.9);
  assert.ok(Number.isNaN(scoreOf(units[2], 2, units)), 'unknown key did not yield NaN');
});

test('scoresFromResults REFUSES to default to positional alignment', () => {
  // BREAKS: a convenience default of String(i). The function's own docstring
  // warns against index alignment, so silently providing it is worse than
  // throwing — it makes the footgun the path of least resistance.
  assert.throws(() => scoresFromResults({ mass: [1, 2, 3] }), TypeError);
  assert.throws(() => scoresFromResults({ mass: [1, 2, 3] }, 'notafunction'), TypeError);
});

test('rankResidualAttention also treats an unscored unit as neutral', () => {
  // BREAKS: appending unscored units last in keep order, i.e. evicting the
  // freshest content first. This is the same defect that was found and fixed in
  // `rankAttention`; the sibling had it too and no test covered it.
  const scores = [0.50, 0.30, 0.02, NaN, 0.01, 0.40];
  const units = scores.map(() => ({}));
  const order = rankResidualAttention((u, i) => scores[i])(units, new Set());
  assert.deepEqual([...order].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]);
  const p = order.indexOf(3);
  assert.ok(p > 0 && p < order.length - 1, `unscored unit landed at an extreme (index ${p})`);
});

test('rankAntiAttention inverts the attention axis only, not the tie-break', () => {
  // BREAKS: implementing the direction check as `rankAttention(...).reverse()`,
  // which also flips the recency tie-break — so the check would differ from the
  // treatment on two axes and a difference could not be attributed to attention.
  // Here two units share a score, so only the tie-break can separate them.
  const scores = [0.5, 0.2, 0.2, 0.9];
  const units = scores.map(() => ({}));
  const pro = rankAttention((u, i) => scores[i])(units, new Set());
  const anti = rankAntiAttention((u, i) => scores[i])(units, new Set());
  assert.notDeepEqual(anti, pro);
  assert.equal(anti.at(-1), 3, 'highest-attention unit not sacrificed first by the anti arm');
  assert.equal(pro[0], 3, 'highest-attention unit not kept first by the treatment');
  // the tied pair keeps the SAME internal order in both arms — with reverse()
  // it would be [1,2] in one and [2,1] in the other
  const proTied = pro.filter((i) => i === 1 || i === 2);
  const antiTied = anti.filter((i) => i === 1 || i === 2);
  assert.deepEqual(proTied, antiTied,
    'the recency tie-break was inverted along with the attention axis');
});
