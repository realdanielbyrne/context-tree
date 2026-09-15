/**
 * Unit tests for H2b — contextual covariance (node:test, stdlib, no deps).
 * Run: node --test experiments/covariance-eviction/contextual.test.mjs
 *
 * The centrepiece is the DIVERGENCE test: a fixture on which historical co-activation and
 * present similarity must give OPPOSITE orderings. H2b's entire claim is that contextual
 * covariance is not relevance-to-recent under a new name — relevance was already measured
 * as the worst eviction signal available (D-EV4, weight 0) — so a test that merely showed
 * the two differing by a little would not be evidence of anything. The fixture below is
 * built so that relevance must rank v above u and covariance must rank u above v.
 *
 * Every other test here names the specific broken implementation it excludes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyCounts, pushTurn, contextualCovariance, phiFrom, supportOf,
} from './signals.mjs';
import { jaccard } from './contextual-covariance.mjs';
import { lexicalTokens, extractFingerprints } from './transcript.mjs';

const S = (...xs) => new Set(xs);
const build = (turns) => { const c = emptyCounts(); for (const t of turns) pushTurn(c, t); return c; };

/**
 * The fixture. In history:
 *   X1 and Y1 are worked on together, repeatedly.       -> phi(X1, Y1) is high
 *   S and Y1 are also worked on together, repeatedly.    -> phi(S,  Y1) is high
 *   Z appears alone.                                     -> phi(Z,  *) is ~0 or negative
 * Now the agent is working on {Y1, S}.
 *   unit u = {X1}     shares NOTHING with the hot window, but X1 is historically tied to Y1.
 *   unit v = {S, Z}   shares S with the hot window, but its non-shared feature Z is tied to nothing.
 * Relevance sees overlap and prefers v. Covariance sees history and prefers u.
 */
function fixture() {
  const hist = [];
  for (let i = 0; i < 12; i += 1) hist.push(S('X1', 'Y1'));
  for (let i = 0; i < 12; i += 1) hist.push(S('S', 'Y1'));
  for (let i = 0; i < 12; i += 1) hist.push(S('Z'));
  for (let i = 0; i < 12; i += 1) hist.push(S('noise' + i));
  return { counts: build(hist), Q: S('Y1', 'S'), u: S('X1'), v: S('S', 'Z') };
}

test('DIVERGENCE: covariance and relevance give OPPOSITE orderings on the same pair of units', () => {
  const { counts, Q, u, v } = fixture();
  const relU = jaccard(u, Q);
  const relV = jaccard(v, Q);
  const covU = contextualCovariance(counts, Q, u, { m: 2, agg: 'max' }).score;
  const covV = contextualCovariance(counts, Q, v, { m: 2, agg: 'max' }).score;

  // relevance must prefer v: it shares a feature with the hot window and u shares none
  assert.equal(relU, 0, 'u must share nothing with the hot window');
  assert.ok(relV > 0, `v must share something with the hot window, got ${relV}`);
  assert.ok(relV > relU, 'relevance must rank v above u');

  // covariance must prefer u: its feature is historically tied to a hot feature,
  // while v's only non-shared feature is tied to nothing.
  // The magnitude is checked loosely and the ORDERING strictly — the ordering is the claim;
  // the magnitude depends on the fixture's margins (here phi(X1,Y1) = 0.577 shrunk to 0.495
  // because Y1 appears in twice as many history turns as X1).
  assert.ok(covU > 0.3, `u should score substantially above zero on covariance, got ${covU}`);
  assert.ok(covV < 0.1, `v's non-shared feature is tied to nothing, so it should score ~0, got ${covV}`);
  assert.ok(covU > 4 * Math.max(covV, 0.01), `covariance must clearly rank u above v: ${covU} vs ${covV}`);

  // and therefore the two orderings are opposite, which is the whole point
  assert.ok(Math.sign(relV - relU) !== Math.sign(covV - covU),
    'the two signals must disagree on this fixture, or the experiment cannot separate them');
});

test('EXCLUDING SHARED FEATURES is what removes relevance from the score', () => {
  // With the exclusion off, v scores through the feature it SHARES with the hot window —
  // i.e. through relevance. The sensitivity arm in the harness exists to detect exactly
  // this, so the mechanism has to be real here.
  const { counts, Q, v } = fixture();
  const excl = contextualCovariance(counts, Q, v, { m: 2, agg: 'max', exclude: true }).score;
  const incl = contextualCovariance(counts, Q, v, { m: 2, agg: 'max', exclude: false }).score;
  assert.ok(incl > excl + 0.3,
    `the inclusive form must gain from the shared feature: inclusive ${incl} vs exclusive ${excl}`);
});

test('a unit whose features are all in the hot window has NO eligible pair', () => {
  const { counts, Q } = fixture();
  const r = contextualCovariance(counts, Q, S('Y1', 'S'), { m: 2, agg: 'max' });
  assert.equal(r.pairs, 0);
  assert.equal(r.score, null, 'no pairs must yield null, not 0 — 0 is a real score');
});

test('a feature present on EVERY history turn contributes nothing (the saturation guard)', () => {
  // The failure mode opposite to starvation: if a promiscuous feature scored highly it
  // would pin every unit at the ceiling and the arm would be inert.
  const hist = [];
  for (let i = 0; i < 20; i += 1) hist.push(S('EVERYWHERE', `t${i % 4}`));
  const counts = build(hist);
  assert.ok(supportOf(counts, 'EVERYWHERE', 't0') > 0, 'the promiscuous feature DOES co-occur a lot');
  assert.equal(phiFrom(counts, 'EVERYWHERE', 't0'), 0, 'but phi must score it zero');
  const r = contextualCovariance(counts, S('t0'), S('EVERYWHERE'), { m: 0, agg: 'max' });
  assert.equal(r.score, 0, 'so a unit carrying only a promiscuous feature scores zero, not high');
});

test('shrinkage suppresses a perfect phi built from one co-occurrence', () => {
  const hist = [S('p', 'q')];
  for (let i = 0; i < 10; i += 1) hist.push(S(`x${i}`));
  const counts = build(hist);
  const raw = contextualCovariance(counts, S('q'), S('p'), { m: 0, agg: 'max' }).score;
  const shrunk = contextualCovariance(counts, S('q'), S('p'), { m: 2, agg: 'max' }).score;
  assert.ok(raw > 0.9, `unshrunk phi on a single co-occurrence is near 1, got ${raw}`);
  assert.ok(shrunk < raw / 2, `shrinkage must cut it hard: ${shrunk} vs ${raw}`);
});

test('the aggregator is a live choice', () => {
  const { counts, Q } = fixture();
  const F = S('X1', 'Z');                       // one strongly-tied feature, one tied to nothing
  const mx = contextualCovariance(counts, Q, F, { m: 2, agg: 'max' }).score;
  const mn = contextualCovariance(counts, Q, F, { m: 2, agg: 'mean' }).score;
  assert.ok(mx > mn, `max (${mx}) must exceed mean (${mn}) on a mixed unit`);
});

test('jaccard is the plain overlap the relevance arm claims to be', () => {
  assert.equal(jaccard(S('a', 'b'), S('b', 'c')), 1 / 3);
  assert.equal(jaccard(S('a'), S('a')), 1);
  assert.equal(jaccard(S('a'), S('b')), 0);
  assert.equal(jaccard(new Set(), S('a')), 0, 'an empty unit is not similar to everything');
});

test('lexicalTokens drops stopwords and short tokens, keeps content', () => {
  const t = lexicalTokens('The parser should return the ledger balance for each account in money.py');
  assert.ok(t.has('parser') && t.has('ledger') && t.has('balance') && t.has('account'));
  assert.equal(t.has('the'), false, 'stopword');
  assert.equal(t.has('return'), false, 'code boilerplate is stopworded');
  assert.equal(t.has('should'), false);
  for (const x of t) assert.ok(x.length >= 3, `token too short: ${x}`);
});

test('the three feature spaces really are different densities on the same text', () => {
  // The premise of this whole experiment: file-keying is starved and the others are not.
  // If this ever stopped holding, H2b would be re-testing H2.
  const text = 'Read packages/core/src/assemble/flex.ts and fix coOccurrence so the EvictionWeights '
    + 'apply to `priority` separately from the edit boost in scoreUnits';
  const fp = extractFingerprints(text);
  const lex = lexicalTokens(text);
  assert.ok(fp.size >= 4, `fingerprints should be plural, got ${fp.size}`);
  assert.ok(lex.size > fp.size, `lexical (${lex.size}) must be denser than fingerprints (${fp.size})`);
});
