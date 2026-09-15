"""
Unit tests for the pure half of the attention-over-history design (stdlib
unittest; no torch, no GPU, no network).

Rerun:
  /mnt/data/ctx-swebench/tooling/venv/bin/python -m unittest discover \
      -s experiments/attention-over-history -p 'test_*.py' -v

EVERY TEST NAMES THE BROKEN IMPLEMENTATION IT CATCHES. A test that passes
against a stub is worse than no test — it manufactures confidence. The repo has
paid for this twice (a signal that was inert for a whole sweep; an eval harness
that silently dropped tool calls), so the bar here is: state the mutation, and
make sure the assertion fails under it.

  test_unit_sums_match_brute_force ........ prefix-sum indexing off by one
  test_signal_varies_across_units ......... an inert / constant signal
  test_inertness_gate_rejects_flat ........ a gate that always passes
  test_signal_diverges_from_recency ....... a signal that is position relabelled
  test_relabelling_gate_rejects_position .. a gate that always passes
  test_sink_is_excluded ................... normalising over the whole sequence
  test_mass_and_density_are_not_rescalings. reporting density as if it were mass
  test_layer_choice_changes_the_answer .... ignoring the `layers` argument
  test_head_agg_changes_the_answer ........ ignoring the `head_agg` argument
  test_head_weights_reward_concentration .. entropy weighting with the sign flipped
  test_partial_removes_a_pure_confound .... partial_spearman that returns raw rho
  test_residualize_removes_positional_trend a no-op residualiser
  test_naive_greedy_fails_the_gate ........ the pilot's own volume bug, as a regression
  test_stratified_matching_equalises ...... a matcher that does not equalise count
  test_matching_gate_rejects_count_mismatch a gate blind to unit count
  test_arm_orders_are_distinct ............ arms that collapse to the same order
  test_endpoints_are_zero_on_no_change .... endpoints with a sign or offset error
"""

import math
import unittest

import numpy as np

from attn_signal import (  # noqa: E402  (experiment module, same directory)
    DropSet, GateResult, LAYER_SETS,
    delta_nll, describe_drop, greedy_drop, head_weights, inertness_gate,
    kl_divergence, layer_indices, matching_gate, order_high_attention,
    order_low_attention, order_oldest, order_random, order_residual_attention,
    order_oracle, partial_spearman, per_unit_mass, relabelling_gate, residualize, treatment_gate,
    size_strata, spearman, stratified_drop, stratified_quota, _unit_sums,
)


def make_attn(n_layers=4, n_heads=3, spans=None, peaks=None, sink_tokens=10,
              sink_share=0.5, seed=0):
    """
    Build a synthetic [L, H, T] last-row attention tensor with a KNOWN answer.

    `peaks[j]` is the relative mass unit j should receive. `sink_share` of every
    row goes to the leading `sink_tokens` tokens, mimicking the 47-54% the pilot
    measured on a real transcript. Every row is a proper distribution.
    """
    rng = np.random.default_rng(seed)
    t = max(b for _, b in spans)
    attn = np.zeros((n_layers, n_heads, t), dtype=np.float64)
    peaks = np.asarray(peaks, dtype=np.float64)
    peaks = peaks / peaks.sum()
    for l in range(n_layers):
        for h in range(n_heads):
            row = np.zeros(t)
            row[:sink_tokens] = sink_share / sink_tokens
            for j, (a, b) in enumerate(spans):
                w = peaks[j] * (1 - sink_share)
                jitter = rng.uniform(0.98, 1.02)
                row[a:b] = w * jitter / max(1, b - a)
            attn[l, h] = row / row.sum()
    return attn


def uniform_spans(n_units, unit_len, start=10):
    p, spans = start, []
    for _ in range(n_units):
        spans.append((p, p + unit_len))
        p += unit_len
    return spans


def varied_spans(lengths, start=10):
    p, spans = start, []
    for L in lengths:
        spans.append((p, p + int(L)))
        p += int(L)
    return spans


class TestAggregation(unittest.TestCase):

    def test_unit_sums_match_brute_force(self):
        """Prefix-sum span extraction must equal the naive per-span sum.
        BREAKS: an off-by-one in the cumsum indexing (cs[b] instead of cs[b-1],
        or forgetting the a==0 case) — the commonest silent bug in this file."""
        spans = varied_spans([3, 7, 1, 12, 5])
        attn = make_attn(spans=spans, peaks=[1, 2, 3, 4, 5], sink_tokens=10)
        got = _unit_sums(attn, spans)
        for l in range(attn.shape[0]):
            for h in range(attn.shape[1]):
                for j, (a, b) in enumerate(spans):
                    self.assertAlmostEqual(
                        got[l, h, j], float(attn[l, h, a:b].sum()), places=10,
                        msg=f"span {j}={(a, b)} mismatch")

    def test_signal_varies_across_units(self):
        """The treatment must actually discriminate between units.
        BREAKS: the inert-signal failure mode (`policies.mjs` BLOCKER 1) where a
        fingerprint defect pinned every unit to the same score and the arm became
        a no-op that nonetheless ran a full sweep."""
        spans = uniform_spans(12, 20)
        attn = make_attn(spans=spans, peaks=[1, 40, 2, 3, 25, 1, 1, 8, 2, 30, 1, 4])
        sig = per_unit_mass(attn, spans)
        gate = inertness_gate(sig.mass)
        self.assertTrue(gate.passed, gate.detail)
        self.assertGreater(gate.detail["cv"], 0.8)
        self.assertGreater(gate.detail["spread"], 10.0)

    def test_inertness_gate_rejects_flat(self):
        """A flat signal must FAIL the gate.
        BREAKS: a gate hardcoded to return True — which would let an inert arm
        through exactly as it did before."""
        spans = uniform_spans(12, 20)
        attn = make_attn(spans=spans, peaks=[1.0] * 12)
        sig = per_unit_mass(attn, spans)
        gate = inertness_gate(sig.mass)
        self.assertFalse(gate.passed, f"flat signal passed the inertness gate: {gate.detail}")
        self.assertLess(gate.detail["cv"], 0.25)

    def test_sink_is_excluded(self):
        """Changing how much mass the sink absorbs must not change the relative
        ranking or the renormalised masses of the evictable units.
        BREAKS: normalising over the whole sequence. The pilot measured the sink
        at 41-54% and drifting turn to turn, so an un-excluded sink injects that
        drift straight into the signal."""
        spans = uniform_spans(8, 25)
        peaks = [1, 9, 2, 7, 3, 5, 4, 6]
        a_lo = make_attn(spans=spans, peaks=peaks, sink_share=0.10)
        a_hi = make_attn(spans=spans, peaks=peaks, sink_share=0.80)
        s_lo, s_hi = per_unit_mass(a_lo, spans), per_unit_mass(a_hi, spans)
        self.assertAlmostEqual(float(s_lo.mass.sum()), 1.0, places=9)
        self.assertAlmostEqual(float(s_hi.mass.sum()), 1.0, places=9)
        np.testing.assert_allclose(s_lo.mass, s_hi.mass, rtol=0.05)
        self.assertGreater(s_hi.sink_fraction, s_lo.sink_fraction + 0.5)
        self.assertLess(s_lo.sink_fraction, 0.2)

    def test_mass_and_density_are_not_rescalings(self):
        """With heterogeneous unit lengths, mass and density must give different
        orderings. BREAKS: reporting one as the other. The pilot found mass
        predicts the causal effect at rho +0.73 and density at +0.006, so the
        confusion is not cosmetic. (A test on equal-length units would pass
        against the bug — the pilot's first probe had exactly that blind spot.)"""
        lengths = [200, 20, 400, 30, 150, 25]
        spans = varied_spans(lengths)
        attn = make_attn(spans=spans, peaks=[5, 1, 6, 1, 4, 1])
        sig = per_unit_mass(attn, spans)
        self.assertLess(spearman(sig.mass, sig.density), 0.8,
                        "mass and density are collinear; the fixture is not testing anything")
        self.assertNotEqual(list(np.argsort(sig.mass)), list(np.argsort(sig.density)))

    def test_layer_choice_changes_the_answer(self):
        """Layer selection must be a real parameter.
        BREAKS: ignoring `layers` and always pooling everything — which would
        turn a swept parameter into the hardcoded constant this repo forbids.
        The pilot measured Spearman(per-layer mass, position) swinging from +0.61
        at layer 0 to -0.07 at layer 15, so layers genuinely disagree."""
        spans = uniform_spans(10, 20)
        base = make_attn(n_layers=8, spans=spans, peaks=list(range(1, 11)))
        # make the late layers prefer the reverse order
        for l in range(6, 8):
            base[l] = base[l][:, ::-1]
        early = per_unit_mass(base, spans, layers="early")
        late = per_unit_mass(base, spans, layers="late")
        self.assertLess(spearman(early.mass, late.mass), 0.0)
        self.assertNotEqual(early.layers, late.layers)
        for name in LAYER_SETS:
            self.assertTrue(layer_indices(8, name), f"{name} resolved to no layers")

    def test_head_agg_changes_the_answer(self):
        """`head_agg` must be honoured.
        BREAKS: ignoring the argument. Constructed so one head is wildly
        concentrated on a unit the other heads ignore: the mean buries it, the
        max surfaces it."""
        spans = uniform_spans(6, 20)
        attn = make_attn(n_heads=4, spans=spans, peaks=[5, 5, 5, 5, 5, 1])
        # head 0 of every layer fixates on the last unit
        for l in range(attn.shape[0]):
            row = np.zeros(attn.shape[-1])
            row[spans[-1][0]:spans[-1][1]] = 1.0
            attn[l, 0] = row / row.sum()
        mean = per_unit_mass(attn, spans, head_agg="mean").mass
        mx = per_unit_mass(attn, spans, head_agg="max").mass
        self.assertLess(mean[-1], mx[-1],
                        "max-over-heads did not surface the single fixated head")
        self.assertEqual(int(np.argmax(mx)), len(spans) - 1)

    def test_head_weights_reward_concentration(self):
        """Entropy weighting must give a concentrated head a HIGHER weight than a
        uniform one. BREAKS: the sign flipped (1 - H vs H), which would weight
        the least informative heads most."""
        spans = uniform_spans(8, 10)
        attn = make_attn(n_layers=1, n_heads=2, spans=spans, peaks=[1] * 8, sink_share=0.0)
        row = np.zeros(attn.shape[-1])
        row[spans[3][0]:spans[3][1]] = 1.0
        attn[0, 1] = row / row.sum()                       # head 1: fully concentrated
        w = head_weights(attn, spans)
        self.assertGreater(w[0, 1], w[0, 0] + 0.5,
                           f"concentrated head not favoured: {w}")
        self.assertLess(w[0, 0], 0.1)
        self.assertGreater(w[0, 1], 0.9)


class TestDivergenceFromRecency(unittest.TestCase):

    def test_signal_diverges_from_recency(self):
        """The whole point: attention must be able to rank an OLD unit above a
        RECENT one. BREAKS: a signal that is positional recency relabelled —
        precisely what reference-recency turned out to be (backlog item 8,
        pooled p = 1.000). Here the oldest unit carries the most mass and the
        newest the least, so any position-derived implementation gets rho near
        +1 and fails."""
        spans = uniform_spans(10, 20)
        attn = make_attn(spans=spans, peaks=[30, 1, 1, 2, 1, 1, 2, 1, 1, 1])
        sig = per_unit_mass(attn, spans)
        rho = spearman(sig.mass, list(range(len(spans))))
        self.assertLess(rho, 0.0, f"attention tracked position (rho={rho:+.3f})")
        self.assertEqual(int(np.argmax(sig.mass)), 0)
        self.assertTrue(relabelling_gate(sig.mass).passed)
        # and the orderings really differ
        cands = list(range(len(spans)))
        self.assertNotEqual(order_low_attention(sig.mass, cands), order_oldest(cands))

    def test_relabelling_gate_rejects_position(self):
        """A perfectly positional signal must FAIL the gate.
        BREAKS: a gate hardcoded to pass, which would let the experiment
        re-discover recency and report it as attention."""
        mass = np.linspace(0.01, 0.2, 12)
        gate = relabelling_gate(mass)
        self.assertFalse(gate.passed, f"positional signal passed: {gate.detail}")
        self.assertGreater(abs(gate.detail["rho_position"]), 0.9)

    def test_residualize_removes_positional_trend(self):
        """Residualising against position must leave no positional trend.
        BREAKS: a no-op residualiser that returns its input."""
        mass = np.linspace(0.01, 0.2, 15) + np.array([0.0, 0.05, -0.04] * 5)
        pos = list(range(15))
        self.assertGreater(spearman(mass, pos), 0.8)
        r = residualize(mass, pos)
        self.assertLess(abs(spearman(r, pos)), 0.15,
                        "positional trend survived residualisation")
        self.assertNotEqual(list(np.argsort(r)), list(np.argsort(mass)))


class TestStatistics(unittest.TestCase):

    def test_partial_removes_a_pure_confound(self):
        """When y is a deterministic function of z and x is only correlated with
        y THROUGH z, the partial correlation must collapse while the raw one
        stays large. BREAKS: a partial_spearman that ignores its controls and
        returns the raw rho — the exact error that would let 'attention counts
        tokens' masquerade as 'attention finds what matters' (mass~length +0.45,
        length~effect +0.44 in the pilot)."""
        rng = np.random.default_rng(3)
        z = rng.normal(size=60)
        y = 3.0 * z                                   # y depends ONLY on z
        x = z + rng.normal(scale=0.2, size=60)        # x correlates with y via z
        raw = spearman(x, y)
        par = partial_spearman(x, y, z)
        self.assertGreater(abs(raw), 0.85, f"fixture is weak (raw={raw:.3f})")
        self.assertLess(abs(par), 0.25, f"confound survived partialling (partial={par:.3f})")

    def test_partial_keeps_a_genuine_effect(self):
        """The complement: a real effect independent of the control must SURVIVE.
        BREAKS: a partial that over-corrects (e.g. residualising y twice) and
        reports 0 for everything, which would make the primary endpoint
        unfalsifiable in the safe direction."""
        rng = np.random.default_rng(4)
        z = rng.normal(size=60)
        x = rng.normal(size=60)
        y = 2.0 * x + 2.0 * z
        self.assertGreater(partial_spearman(x, y, z), 0.6)

    def test_spearman_handles_ties_and_degenerates(self):
        """BREAKS: a rank function that breaks ties by index, inventing an
        ordering where the data has none, or a divide-by-zero on a constant."""
        self.assertEqual(spearman([1, 1, 1, 1, 1], [1, 2, 3, 4, 5]), 0.0)
        self.assertAlmostEqual(spearman([1, 2, 3, 4], [1, 2, 3, 4]), 1.0, places=9)
        self.assertAlmostEqual(spearman([1, 2, 3, 4], [4, 3, 2, 1]), -1.0, places=9)
        # tied pairs must not produce a perfect correlation
        self.assertLess(abs(spearman([1, 1, 2, 2], [1, 2, 1, 2])), 1e-9)


class TestVolumeMatching(unittest.TestCase):
    """
    The pilot's decisive finding, encoded as tests.

    Matching arms on dropped TOKENS to within 4% still left them dropping 30.8 vs
    11.6 vs 7.3 units through 11.3 vs 2.5 vs 6.0 splice points, because attention
    mass correlates with unit length. The naive matcher must be shown to fail and
    the stratified matcher to fix it, or this experiment repeats the flaw that
    voided `report-sensitivity-control.md`.
    """

    # Lengths shaped like the pilot's real transcript: 18-880 tokens, heavy
    # tailed, ~50 units per turn. The unit COUNT matters as much as the shape —
    # with only a handful of units the caliper repair has no freedom and every
    # arm converges on the same drop set, which is a property of the fixture, not
    # of the matcher.
    LENGTHS = [20, 22, 25, 28, 30, 33, 35, 38, 40, 45, 50, 55, 60, 70, 80, 90,
               110, 125, 140, 160, 180, 200, 240, 270, 320, 360, 420, 480, 560,
               620, 700, 790, 880, 24, 36, 48, 65, 95, 150, 210, 300, 400, 520,
               640, 750, 860, 27, 42, 75, 130]

    def _mass_correlated_with_length(self):
        """Attention mass that tracks unit length at roughly the measured
        strength (Spearman ~ +0.45), NOT a deterministic function of it. The
        distinction matters: with mass == f(length) exactly, every arm's
        within-stratum preference collapses to the same ordering and the fixture
        would 'pass' the distinctness assertions for the wrong reason."""
        rng = np.random.default_rng(7)
        L = np.asarray(self.LENGTHS, dtype=float)
        raw = (L ** 0.6) * np.exp(rng.normal(0.0, 1.0, size=L.size))
        m = raw / raw.sum()
        rho = spearman(m, self.LENGTHS)
        assert 0.35 < rho < 0.60, f"fixture lost its intended correlation (rho={rho:.3f})"
        return m.tolist()

    def test_naive_greedy_fails_the_gate(self):
        """REGRESSION TEST for the pilot bug: token-greedy matching lets arms
        diverge in unit count, so `matching_gate` must reject it.
        BREAKS: a gate that only inspects token volume — which is exactly what
        every previous experiment in this repo checked."""
        lens = self.LENGTHS
        cands = list(range(len(lens)))
        mass = self._mass_correlated_with_length()
        target = 0.30 * sum(lens)
        arms = {
            "lowattn": greedy_drop(order_low_attention(mass, cands), lens, target),
            "oldest": greedy_drop(order_oldest(cands), lens, target),
            "highattn": greedy_drop(order_high_attention(mass, cands), lens, target),
        }
        counts = {k: v.count for k, v in arms.items()}
        self.assertGreater(max(counts.values()), 2 * min(counts.values()),
                           f"fixture failed to reproduce the divergence: {counts}")
        gate = matching_gate(arms)
        self.assertFalse(gate.passed,
                         f"naive greedy passed the matching gate: {gate.detail} counts={counts}")
        self.assertGreater(gate.detail["count_ratio"], 1.25)

    def test_stratified_matching_equalises(self):
        """The fix: a shared per-stratum quota gives every arm the SAME unit
        count and near-identical token volume, leaving only WHICH unit free.
        BREAKS: a matcher that ignores the quota, or strata that collapse to one
        bucket (which would silently degrade to the naive matcher)."""
        lens = self.LENGTHS
        cands = list(range(len(lens)))
        mass = self._mass_correlated_with_length()
        target = 0.30 * sum(lens)
        quota = stratified_quota(lens, cands, target, n_strata=4, seed=1)
        self.assertGreater(sum(quota.values()), 1, f"empty quota {quota}")
        kw = dict(n_strata=4, target_tokens=target)
        arms = {
            "lowattn": stratified_drop(order_low_attention(mass, cands), lens, quota, **kw),
            "oldest": stratified_drop(order_oldest(cands), lens, quota, **kw),
            "highattn": stratified_drop(order_high_attention(mass, cands), lens, quota, **kw),
            "random": stratified_drop(order_random(cands, seed=2), lens, quota, **kw),
        }
        counts = {k: v.count for k, v in arms.items()}
        self.assertEqual(len(set(counts.values())), 1, f"unit counts differ: {counts}")
        gate = matching_gate(arms)
        self.assertTrue(gate.passed, f"stratified matching failed the gate: {gate.detail}")
        self.assertLessEqual(gate.detail["token_ratio"], 1.05)
        # the CONTENT-SELECTIVE arms match each other tightly on every axis
        selective = matching_gate({k: arms[k] for k in ("lowattn", "highattn", "random")})
        self.assertTrue(selective.passed, selective.detail)
        self.assertLessEqual(selective.detail["splice_ratio"], 1.5)
        # and the arms must still make DIFFERENT choices, or matching has
        # destroyed the treatment along with the confound
        self.assertNotEqual(arms["lowattn"].indices, arms["oldest"].indices)
        self.assertNotEqual(arms["lowattn"].indices, arms["highattn"].indices)
        tg = treatment_gate(arms["lowattn"], arms["oldest"])
        self.assertTrue(tg.passed, f"matching erased the treatment: {tg.detail}")

    def test_treatment_gate_catches_matching_that_erased_the_arm(self):
        """The tension between the two gates, made explicit: a caliper repair
        tight enough to equalise everything can drive the treatment arm onto the
        incumbent's drop set, guaranteeing a null for a reason that has nothing to
        do with attention. BREAKS: shipping only `matching_gate`, which such a
        cell passes with flying colours."""
        lens = [100.0] * 24
        # identical tokens, identical count, comparable splice structure —
        # everything `matching_gate` inspects — yet 9 of 10 units are shared
        a = describe_drop([0, 1, 4, 5, 8, 9, 12, 13, 16, 17], lens)
        near_identical = describe_drop([0, 1, 4, 5, 8, 9, 12, 13, 16, 20], lens)
        different = describe_drop([2, 3, 6, 7, 10, 11, 14, 15, 18, 19], lens)
        self.assertTrue(matching_gate({"a": a, "b": near_identical}).passed,
                        "fixture: the matching gate should be happy with these")
        self.assertFalse(treatment_gate(a, near_identical).passed)
        self.assertTrue(treatment_gate(a, different).passed)
        self.assertEqual(treatment_gate(a, different).detail["jaccard"], 0.0)

    def test_oldest_arm_is_structurally_less_fragmented(self):
        """Documents the one axis that CANNOT be matched, so nobody later reads
        an oldest-first win as purely informational: dropping the oldest units is
        contiguous by construction (1 splice), while any content-selective rule
        scatters. The pilot measured 2.5 vs 11.3 splices at matched tokens — and
        oldest won. BREAKS: a design that quietly treats lowattn-vs-oldest as a
        clean contrast."""
        lens = self.LENGTHS
        cands = list(range(len(lens)))
        mass = self._mass_correlated_with_length()
        target = 0.30 * sum(lens)
        quota = stratified_quota(lens, cands, target, n_strata=4, seed=1)
        kw = dict(n_strata=4, target_tokens=target)
        old = stratified_drop(order_oldest(cands), lens, quota, **kw)
        low = stratified_drop(order_low_attention(mass, cands), lens, quota, **kw)
        self.assertLess(old.splices, low.splices,
                        f"fixture: oldest ({old.splices}) should fragment less than lowattn ({low.splices})")

    def test_matching_gate_rejects_count_mismatch(self):
        """BREAKS: a gate blind to unit count. Identical tokens, 4x the units."""
        a = DropSet(frozenset(range(4)), tokens=1000.0, count=4, splices=1)
        b = DropSet(frozenset(range(16)), tokens=1000.0, count=16, splices=1)
        self.assertFalse(matching_gate({"a": a, "b": b}).passed)
        c = DropSet(frozenset(range(4, 8)), tokens=1020.0, count=4, splices=1)
        self.assertTrue(matching_gate({"a": a, "c": c}).passed)

    def test_strata_are_populated(self):
        """BREAKS: quantile strata that dump everything into one bucket on a
        heavy-tailed length distribution."""
        s = size_strata(self.LENGTHS, 4)
        self.assertEqual(len(set(s)), 4, f"strata collapsed: {s}")
        for k in range(4):
            self.assertGreaterEqual(s.count(k), 3)

    def test_describe_drop_counts_splices(self):
        """BREAKS: a splice counter that counts dropped units instead of
        contiguous runs — the statistic that distinguishes 'one block gone' from
        'the transcript shredded'."""
        lens = [10] * 10
        self.assertEqual(describe_drop([0, 1, 2], lens).splices, 1)
        self.assertEqual(describe_drop([0, 2, 4], lens).splices, 3)
        self.assertEqual(describe_drop([0, 1, 5, 6, 9], lens).splices, 3)
        self.assertEqual(describe_drop([], lens).splices, 0)


class TestArmsAndEndpoints(unittest.TestCase):

    def test_arm_orders_are_distinct(self):
        """Four arms that produce the same ordering are one arm.
        BREAKS: a copy-paste error making two arms identical — an ablation that
        would then report a null it could never have avoided.

        The mass here carries a deliberate positional trend, because that is the
        only regime in which `resid` is allowed to differ from `low` at all — on
        a trendless signal the two SHOULD coincide, and asserting otherwise would
        be asserting a bug. It is a trend, not a ramp: a perfectly monotone mass
        would make `low` and `old` the same order and the fixture, not the code,
        would be what failed."""
        mass = [0.03, 0.26, 0.07, 0.11, 0.33, 0.20]
        cands = list(range(6))
        orders = {
            "low": order_low_attention(mass, cands),
            "high": order_high_attention(mass, cands),
            "old": order_oldest(cands),
            "rand": order_random(cands, seed=5),
            "resid": order_residual_attention(mass, cands),
        }
        for a in orders:
            self.assertEqual(sorted(orders[a]), cands, f"{a} is not a permutation")
        seen = {}
        for k, v in orders.items():
            self.assertNotIn(tuple(v), seen, f"{k} duplicates {seen.get(tuple(v))}")
            seen[tuple(v)] = k
        self.assertEqual(orders["low"], list(reversed(orders["high"])))

    def test_oracle_sacrifices_the_least_damaging_units_first(self):
        """The ceiling arm must rank by the ground truth, ascending.
        BREAKS: a sign error, which would make the "ceiling" the worst possible
        policy and invert the headline result."""
        cands = [0, 1, 2, 3, 4]
        louo = [0.30, 0.01, 0.20, 0.02, 0.10]     # indexed by CANDIDATE position
        order = order_oracle(louo, cands)
        self.assertEqual(order, [1, 3, 4, 2, 0])
        self.assertEqual(order[0], 1, "least-damaging unit not sacrificed first")
        self.assertEqual(order[-1], 0, "most-damaging unit not sacrificed last")

    def test_oracle_refuses_a_misaligned_ground_truth(self):
        """`louo` is indexed by candidate POSITION, not by unit id. Silently
        accepting a mismatched length would let the oracle rank on the wrong
        units and still look like a ceiling.
        BREAKS: dropping the length check."""
        with self.assertRaises(ValueError):
            order_oracle([0.1, 0.2], [0, 1, 2, 3])

    def test_oracle_is_matched_like_every_other_arm(self):
        """The ceiling must go through the SAME stratified quota, so it cannot
        win by keeping more tokens or more units.
        BREAKS: exempting the oracle from matching — which is exactly the flaw
        that voided the sensitivity control, where the winning arm simply held
        more useful content."""
        lens = TestVolumeMatching.LENGTHS
        cands = list(range(len(lens)))
        rng = np.random.default_rng(3)
        louo = rng.random(len(cands)).tolist()
        target = 0.30 * sum(lens)
        quota = stratified_quota(lens, cands, target, n_strata=4, seed=1)
        kw = dict(n_strata=4, target_tokens=target)
        oracle = stratified_drop(order_oracle(louo, cands), lens, quota, **kw)
        oldest = stratified_drop(order_oldest(cands), lens, quota, **kw)
        self.assertEqual(oracle.count, oldest.count, "oracle dropped a different number of units")
        gate = matching_gate({"oracle": oracle, "oldest": oldest})
        self.assertLessEqual(gate.detail["token_ratio"], 1.05,
                             f"oracle is not volume-matched: {gate.detail}")
        self.assertNotEqual(oracle.indices, oldest.indices,
                            "oracle and incumbent chose identically; the fixture proves nothing")

    def test_endpoints_are_zero_on_no_change(self):
        """Both endpoints must read exactly 0 when nothing changed, and be
        positive when the ablation hurt. BREAKS: a sign error or a stray offset —
        which would invert the entire conclusion."""
        lp = np.log(np.array([0.5, 0.3, 0.2]))
        self.assertAlmostEqual(kl_divergence(lp, lp), 0.0, places=12)
        self.assertAlmostEqual(delta_nll(2.0, 2.0), 0.0, places=12)
        worse = np.log(np.array([0.2, 0.3, 0.5]))
        self.assertGreater(kl_divergence(lp, worse), 0.0)
        self.assertGreater(delta_nll(2.0, 2.5), 0.0)
        self.assertLess(delta_nll(2.0, 1.5), 0.0)

    def test_kl_matches_closed_form(self):
        """BREAKS: KL computed in the wrong direction or with log-base drift."""
        p = np.array([0.7, 0.3])
        q = np.array([0.4, 0.6])
        want = float((p * np.log(p / q)).sum())
        self.assertAlmostEqual(kl_divergence(np.log(p), np.log(q)), want, places=12)


if __name__ == "__main__":
    unittest.main(verbosity=2)
