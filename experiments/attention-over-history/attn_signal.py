"""
Attention-over-history: the PURE half. No torch, no CUDA, no model — every
function here is a deterministic transform of arrays, so the whole design is
unit-testable on a laptop and the GPU half (`measure.py`) stays a thin driver.

WHY THE MODULE IS SPLIT THIS WAY
--------------------------------
Three of this project's experiments were voided by defects that live entirely in
this layer, not in the model call:

  1. an INERT signal (a bug made the treatment near-constant across units, so the
     arm was a no-op — `policies.mjs` header, BLOCKER 1);
  2. a RELABELLED signal (reference-recency turned out to be positional recency
     wearing a hat, pooled p=1.000);
  3. VOLUME-MISMATCHED arms (the arm that "won" simply held more content —
     `report-sensitivity-control.md`, "What this experiment could never have
     shown").

All three are properties of the ranking + matching code. Putting them behind a
GPU makes them expensive to catch; putting them here makes them cheap. Hence the
`*_gate` functions: they are not diagnostics printed at the end, they are
pre-registered validity conditions the driver must evaluate BEFORE it is allowed
to interpret a cell.

THE SINK PROBLEM
----------------
Attention is not a free-floating importance score. The pinned head absorbs a
large and turn-varying share of all last-row mass, so any "fraction of attention"
computed over the whole sequence is mostly a measurement of the sink — and of how
big the sink happened to be on that turn. `per_unit_mass` excludes non-evictable
spans from the normaliser and renormalises over the evictable set only;
`sink_fraction` reports what was excluded so a turn where the evictable set sits
near the numerical floor can be flagged rather than silently analysed. Current
measured values live in the results artefact, not in this docstring — see the
note on stale numbers below.

MASS, NOT DENSITY
-----------------
Two obvious per-unit summaries: total mass (sum over the unit's tokens) and
density (mass / tokens). Mass is primary because density discards the fact that a
larger unit removes more information; density is computed and swept anyway, so
"mass wins" stays a measured claim rather than a hardcoded choice. Mass also
correlates with unit length, and length is itself predictive of deletion damage,
so the load-bearing statistic is neither raw correlation — it is the PARTIAL
correlation of mass with the causal effect GIVEN length (`partial_spearman`).

AGGREGATION IS A SWEPT PARAMETER, NOT A CONSTANT
------------------------------------------------
Heads and layers need not agree, so a single hardcoded layer choice would be an
undefended constant of exactly the kind this repo's rules forbid. `per_unit_mass`
takes `layers` and `head_agg` explicitly and the driver sweeps them; the sweep is
cheap because every combination is a different reduction of the SAME captured
tensor, which `measure.py` caches to a .npz sidecar.

A NOTE ON QUOTED NUMBERS
------------------------
This docstring deliberately quotes NO pilot correlations. An earlier version did,
and every one of them went stale when two measurement defects were fixed (the
attention row was being read at the end of the CONTINUATION rather than the
context, and units were not paired with their tool results). The stale numbers
then stood as the stated justification for design choices they no longer
supported. Numbers belong in the results artefact and the report, which are
regenerated together; design rationale belongs here.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, asdict
from typing import Callable, Iterable, Sequence

import numpy as np

# ---------------------------------------------------------------------------
# aggregation over heads and layers
# ---------------------------------------------------------------------------

#: Named layer subsets. `all` is the pre-registered default; the rest are the
#: sweep. Fractions, not indices, so the same names work across model depths.
LAYER_SETS: dict[str, tuple[float, float]] = {
    "all": (0.0, 1.0),
    "early": (0.0, 0.25),
    "mid": (0.25, 0.75),
    "late": (0.75, 1.0),
    "upper-half": (0.5, 1.0),
}

HEAD_AGGS = ("mean", "max", "entropy")


def layer_indices(n_layers: int, name: str) -> list[int]:
    """Resolve a named layer subset to concrete indices. Always non-empty."""
    if name not in LAYER_SETS:
        raise KeyError(f"unknown layer set {name!r}; known: {sorted(LAYER_SETS)}")
    lo, hi = LAYER_SETS[name]
    a, b = int(math.floor(lo * n_layers)), int(math.ceil(hi * n_layers))
    idx = list(range(max(0, a), min(n_layers, max(b, a + 1))))
    return idx or [n_layers - 1]


def head_weights(attn: np.ndarray, spans: Sequence[tuple[int, int]]) -> np.ndarray:
    """
    Informativeness weight per (layer, head), in [0, 1].

    A head whose last-row distribution over the EVICTABLE units is uniform tells
    us nothing about which unit matters; a head concentrated on one unit tells us
    a lot. Weight = 1 - H(p)/log(U), the normalised entropy deficit, where p is
    the head's mass distribution over units after renormalisation.

    This is the principled alternative to a uniform head mean. It is a SWEEP
    OPTION, not the default — `head_agg="mean"` is pre-registered as primary
    precisely so that a weighting scheme cannot be tuned into producing a result.
    """
    per_unit = _unit_sums(attn, spans)                      # [L, H, U]
    tot = per_unit.sum(axis=-1, keepdims=True)
    p = np.divide(per_unit, tot, out=np.zeros_like(per_unit), where=tot > 0)
    u = p.shape[-1]
    if u <= 1:
        return np.ones(p.shape[:2], dtype=np.float64)
    ent = -(np.where(p > 0, p * np.log(np.maximum(p, 1e-30)), 0.0)).sum(axis=-1)
    return np.clip(1.0 - ent / math.log(u), 0.0, 1.0)


def _unit_sums(attn: np.ndarray, spans: Sequence[tuple[int, int]]) -> np.ndarray:
    """[L, H, T] attention -> [L, H, U] mass per unit. Uses a prefix sum so the
    cost is O(L*H*T) once rather than O(L*H*T*U)."""
    if attn.ndim != 3:
        raise ValueError(f"expected [L,H,T], got shape {attn.shape}")
    cs = np.cumsum(attn.astype(np.float64), axis=-1)
    t = attn.shape[-1]
    out = np.empty(attn.shape[:2] + (len(spans),), dtype=np.float64)
    for j, (a, b) in enumerate(spans):
        if not (0 <= a <= b <= t):
            raise ValueError(f"span {(a, b)} outside sequence of length {t}")
        lo = cs[..., a - 1] if a > 0 else 0.0
        out[..., j] = cs[..., b - 1] - lo if b > a else 0.0
    return out


@dataclass(frozen=True)
class UnitSignal:
    """Per-unit attention summary for one turn."""

    mass: np.ndarray            # renormalised over evictable units; sums to 1
    density: np.ndarray         # mass / tokens
    lengths: np.ndarray         # tokens per unit
    sink_fraction: float        # share of TOTAL mass outside the evictable set
    layers: list[int]
    head_agg: str

    def as_dict(self) -> dict:
        d = asdict(self)
        for k in ("mass", "density", "lengths"):
            d[k] = np.asarray(d[k]).tolist()
        return d


def per_unit_mass(
    attn: np.ndarray,
    spans: Sequence[tuple[int, int]],
    *,
    layers: str | Sequence[int] = "all",
    head_agg: str = "mean",
) -> UnitSignal:
    """
    Reduce a captured last-row attention tensor to one number per evictable unit.

    `attn`  : [L, H, T]; each [l, h, :] is a probability distribution over the
              whole key sequence (it sums to 1 including the sink).
    `spans` : half-open [start, end) token ranges of the EVICTABLE units only.
              Pinned head, protected recency anchor and the trailing question are
              simply absent from this list; their mass becomes `sink_fraction`.

    Returns mass renormalised to sum to 1 over the evictable set. Renormalisation
    is what makes turns comparable: without it the signal is dominated by how
    much mass the sink happened to take on that turn, which varies substantially
    turn to turn and has nothing to do with which unit is worth keeping.
    """
    if head_agg not in HEAD_AGGS:
        raise KeyError(f"unknown head_agg {head_agg!r}; known: {HEAD_AGGS}")
    nl = attn.shape[0]
    idx = layer_indices(nl, layers) if isinstance(layers, str) else list(layers)
    if not idx:
        raise ValueError("empty layer selection")
    sel = attn[idx]                                       # [l, H, T]
    per = _unit_sums(sel, spans)                          # [l, H, U]

    if head_agg == "mean":
        pooled = per.mean(axis=1)
    elif head_agg == "max":
        pooled = per.max(axis=1)
    else:
        w = head_weights(sel, spans)                      # [l, H]
        denom = w.sum(axis=1, keepdims=True)
        w = np.divide(w, denom, out=np.full_like(w, 1.0 / w.shape[1]), where=denom > 0)
        pooled = (per * w[..., None]).sum(axis=1)
    raw = pooled.mean(axis=0)                             # [U]

    total_evictable = float(raw.sum())
    # total mass over the whole sequence, per (layer, head), averaged the same way
    whole = float(sel.sum(axis=-1).mean())
    sink = 1.0 - (total_evictable / whole) if whole > 0 else 1.0

    mass = raw / total_evictable if total_evictable > 0 else np.full(len(spans), 1.0 / max(1, len(spans)))
    lengths = np.array([b - a for a, b in spans], dtype=np.float64)
    density = np.divide(mass, lengths, out=np.zeros_like(mass), where=lengths > 0)
    return UnitSignal(
        mass=mass, density=density, lengths=lengths,
        sink_fraction=float(np.clip(sink, 0.0, 1.0)),
        layers=idx, head_agg=head_agg,
    )


def sink_fraction(attn: np.ndarray, spans: Sequence[tuple[int, int]]) -> float:
    """Share of total last-row attention mass falling OUTSIDE the evictable units."""
    return per_unit_mass(attn, spans).sink_fraction


# ---------------------------------------------------------------------------
# rank statistics
# ---------------------------------------------------------------------------

def _rank(v: Sequence[float]) -> np.ndarray:
    """Average ranks, so ties do not fabricate an ordering."""
    a = np.asarray(v, dtype=np.float64)
    order = np.argsort(a, kind="mergesort")
    ranks = np.empty(len(a), dtype=np.float64)
    ranks[order] = np.arange(len(a), dtype=np.float64)
    # average tied groups
    srt = a[order]
    i = 0
    while i < len(srt):
        j = i
        while j + 1 < len(srt) and srt[j + 1] == srt[i]:
            j += 1
        if j > i:
            ranks[order[i:j + 1]] = np.mean(ranks[order[i:j + 1]])
        i = j + 1
    return ranks


def spearman(x: Sequence[float], y: Sequence[float]) -> float:
    """Spearman rho. Returns 0.0 for a degenerate (constant) input."""
    if len(x) != len(y):
        raise ValueError("length mismatch")
    if len(x) < 3:
        return 0.0
    rx, ry = _rank(x), _rank(y)
    sx, sy = rx.std(), ry.std()
    if sx == 0 or sy == 0:
        return 0.0
    return float(np.mean((rx - rx.mean()) * (ry - ry.mean())) / (sx * sy))


def partial_spearman(x: Sequence[float], y: Sequence[float], *controls: Sequence[float]) -> float:
    """
    Spearman(x, y) with one or more covariates partialled out, computed by
    regressing the RANKS of x and y on the ranks of the controls and correlating
    the residuals.

    This is the statistic the primary hypothesis is stated on. Attention mass
    correlates with unit length, and length independently predicts deletion
    damage, so the raw correlation cannot distinguish "attention identifies what
    matters" from "attention counts tokens".
    """
    if not controls:
        return spearman(x, y)
    n = len(x)
    if n < len(controls) + 3:
        return 0.0
    rx, ry = _rank(x), _rank(y)
    Z = np.column_stack([_rank(c) for c in controls] + [np.ones(n)])
    if np.linalg.matrix_rank(Z) < Z.shape[1]:
        Z = Z[:, np.linalg.qr(Z, mode="r").diagonal().nonzero()[0]] if n > 1 else Z
    def resid(v: np.ndarray) -> np.ndarray:
        beta, *_ = np.linalg.lstsq(Z, v, rcond=None)
        return v - Z @ beta
    ex, ey = resid(rx), resid(ry)
    if ex.std() == 0 or ey.std() == 0:
        return 0.0
    return float(np.mean((ex - ex.mean()) * (ey - ey.mean())) / (ex.std() * ey.std()))


def residualize(values: Sequence[float], covariate: Sequence[float]) -> np.ndarray:
    """
    Values with the monotone trend in `covariate` removed (rank-space residuals).

    Used to build the `mass-resid` arm: attention mass with the positional trend
    stripped out, which is the only form of the signal that CANNOT be a
    relabelling of recency. If raw mass wins but residualised mass does not, the
    honest conclusion is "recency again", not "attention works".
    """
    v, c = _rank(values), _rank(covariate)
    Z = np.column_stack([c, np.ones(len(c))])
    beta, *_ = np.linalg.lstsq(Z, v, rcond=None)
    return v - Z @ beta


# ---------------------------------------------------------------------------
# pre-registered validity gates
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class GateResult:
    passed: bool
    detail: dict


#: A treatment arm whose signal barely moves across units is a no-op dressed as
#: a policy. Thresholds are deliberately loose — this catches "the bug made it
#: constant", not "the effect is small". Current pilot values live in the results
#: artefact; this gate has passed on every measured turn so far.
INERT_CV_MIN = 0.25
INERT_SPREAD_MIN = 3.0


def inertness_gate(mass: Sequence[float], *, cv_min: float = INERT_CV_MIN,
                   spread_min: float = INERT_SPREAD_MIN) -> GateResult:
    """FAIL means the signal is near-constant, so the arm cannot differ from its
    control for reasons that have nothing to do with the hypothesis."""
    m = np.asarray(mass, dtype=np.float64)
    mean = float(m.mean()) if m.size else 0.0
    cv = float(m.std() / mean) if mean > 0 else 0.0
    lo = float(m[m > 0].min()) if np.any(m > 0) else 0.0
    spread = float(m.max() / lo) if lo > 0 else float("inf") if m.max() > 0 else 0.0
    ok = cv >= cv_min and spread >= spread_min
    return GateResult(ok, {"cv": cv, "spread": spread, "n": int(m.size),
                           "cv_min": cv_min, "spread_min": spread_min})


#: Above this, "lowest attention" is materially the same ordering as "oldest"
#: and the experiment would be re-running backlog item 8 (pooled p=1.000). The
#: threshold is a PLACEHOLDER: no experiment has established where a signal stops
#: being usefully distinct from position, and 0.5 is a judgement call, not a
#: finding. Report the observed rho alongside any result rather than leaning on
#: the pass/fail.
RELABEL_RHO_MAX = 0.5


def relabelling_gate(mass: Sequence[float], positions: Sequence[float] | None = None,
                     *, rho_max: float = RELABEL_RHO_MAX) -> GateResult:
    """FAIL means the attention signal is a positional-recency signal in
    disguise, and any win it posts belongs to recency."""
    pos = list(range(len(mass))) if positions is None else list(positions)
    rho = spearman(mass, pos)
    return GateResult(abs(rho) <= rho_max, {"rho_position": rho, "rho_max": rho_max})


#: Arms must differ in WHICH content is kept, never in how much. Token-matching
#: alone is NOT enough (see `matching_gate` for the measurement), so the gate
#: also covers unit count and splice count.
VOLUME_TOL = 0.05
COUNT_TOL = 0.25
#: Deliberately loose, and the reason is a finding rather than a fudge: splice
#: count CANNOT be matched against an oldest-first incumbent. "Drop the oldest"
#: removes a contiguous prefix — one splice, by construction — while any
#: content-selective rule removes a scattered set. Measured on the real harness,
#: `oldest` drops through 2.3 splices against `lowattn`'s 10.5 at matched kept
#: tokens; part of any oldest advantage is structural, not informational. So
#: splices are a
#: REPORTED COVARIATE partialled out in the analysis, with this gate left wide
#: enough to catch only gross shredding. The consequence for the design is that
#: the primary policy contrast is lowattn vs RANDOM (comparable splice
#: structure); oldest is reported as the real-world reference with its
#: structural advantage stated.
SPLICE_TOL = 2.00


def matching_gate(arms: dict[str, "DropSet"], *, volume_tol: float = VOLUME_TOL,
                  count_tol: float = COUNT_TOL, splice_tol: float = SPLICE_TOL) -> GateResult:
    """
    FAIL means the arms are not comparable and the cell is void.

    THE MEASUREMENT THAT MOTIVATES THIS GATE. Run on the REAL harness —
    `evictToBudget` from `experiments/context-dedup/policies.mjs`, 50 units with
    heavy-tailed lengths, rho(mass, length) = +0.65, W = 8000, 12 trials — the
    arms `recency` / `lowattn` / `random` came out as:

        kept tokens   7454 / 7467 / 7446      within-trial ratio 1.004 mean, 1.013 max
        kept units    28.5 / 20.9 / 29.9      within-trial ratio 1.56 mean, 2.00 max
        drop splices   2.3 / 10.5 / 12.3      within-trial ratio 6.97 mean, 13.0 max

    So volume matching is NECESSARY BUT NOT SUFFICIENT: the incumbent harness
    already matches kept tokens to ~0.4%, and the arms still diverge up to 2x in
    unit count and 13x in splice count. Attention mass correlates with unit
    length, so "drop the lowest-attention units" means "drop many small units"
    while "drop the oldest" means "drop a few large contiguous ones". Tokens were
    matched; nothing else was, and the structural difference can swamp the
    content difference.

    This does NOT mean the prior A/B series was measuring nothing — its arms were
    genuinely volume-matched in the sense it claimed. It means the series could
    not distinguish a content effect from a fragmentation effect, which is a
    narrower and more specific criticism.
    """
    def ratio(vals: list[float]) -> float:
        lo = min(vals)
        return max(vals) / lo if lo > 0 else float("inf")
    tok = ratio([a.tokens for a in arms.values()])
    cnt = ratio([float(a.count) for a in arms.values()])
    spl = ratio([float(max(a.splices, 1)) for a in arms.values()])
    ok = (tok <= 1 + volume_tol) and (cnt <= 1 + count_tol) and (spl <= 1 + splice_tol)
    return GateResult(ok, {"token_ratio": tok, "count_ratio": cnt, "splice_ratio": spl,
                           "volume_tol": volume_tol, "count_tol": count_tol,
                           "splice_tol": splice_tol})


#: Arms must still be DIFFERENT after matching. Jaccard overlap above this and
#: the treatment and the incumbent are dropping substantially the same units.
TREATMENT_JACCARD_MAX = 0.8


def treatment_gate(treatment: DropSet, incumbent: DropSet,
                   *, jaccard_max: float = TREATMENT_JACCARD_MAX) -> GateResult:
    """
    FAIL means matching succeeded so thoroughly that it erased the thing being
    tested — the arms now evict nearly the same units, so a null is guaranteed
    and uninformative.

    This is the third gate, and it exists because the first two are in tension:
    tightening comparability (matching_gate) removes the arms' freedom to differ.
    It is the direct analogue of the validity condition added after the
    sensitivity control — where `clean` and `random` both scored 0/10 because the
    control had stopped attempting the task, so the comparison was vacuous
    despite passing both pre-registered checks. A cell that fails here is
    reported as UNINFORMATIVE, never as a null.
    """
    a, b = treatment.indices, incumbent.indices
    union = len(a | b)
    j = len(a & b) / union if union else 1.0
    return GateResult(j <= jaccard_max, {"jaccard": j, "jaccard_max": jaccard_max,
                                         "n_treatment": len(a), "n_incumbent": len(b),
                                         "n_shared": len(a & b)})


# ---------------------------------------------------------------------------
# volume matching
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class DropSet:
    """What one arm chose to evict, plus the structure statistics the matching
    gate checks."""

    indices: frozenset[int]
    tokens: float
    count: int
    splices: int
    swaps: int = 0          # caliper repairs applied; see `stratified_drop`

    def as_dict(self) -> dict:
        return {"indices": sorted(self.indices), "tokens": self.tokens,
                "count": self.count, "splices": self.splices, "swaps": self.swaps}


def describe_drop(indices: Iterable[int], lengths: Sequence[float], swaps: int = 0) -> DropSet:
    s = frozenset(int(i) for i in indices)
    splices = sum(1 for i in sorted(s) if (i - 1) not in s)
    return DropSet(s, float(sum(lengths[i] for i in s)), len(s), splices, swaps)


def greedy_drop(order: Sequence[int], lengths: Sequence[float], target_tokens: float) -> DropSet:
    """
    The NAIVE matcher: walk the arm's preference order, dropping until the token
    target is met.

    Kept in the module on purpose, as the thing the primary matcher must beat:
    it lets arms diverge by up to 26% in dropped tokens and 4x in dropped unit
    count. `test_attn_signal.py` asserts it FAILS `matching_gate`, so the
    regression cannot come back unnoticed.

    CORRECTION — this is NOT what `evictToBudget` does. An earlier version of
    this docstring said it was. `evictToBudget` (policies.mjs:82-104) is a
    KEEP-side best-fit fill: it walks the keep-preference order and takes every
    unit that still fits, so it does not stop at the first non-fitting unit and
    its kept-token total lands much closer to the budget than a drop-side greedy
    manages. The confound is real but the mechanism is different, and the
    magnitudes differ accordingly — see `matching_gate` for the measured figures.
    """
    drop, tot = [], 0.0
    for i in order:
        if tot >= target_tokens:
            break
        drop.append(int(i))
        tot += lengths[i]
    return describe_drop(drop, lengths)


def size_strata(lengths: Sequence[float], n_strata: int = 4) -> list[int]:
    """Assign each unit to a size stratum by quantile. Equal-frequency, so the
    strata are populated even on a heavy-tailed length distribution (real units
    run 18-880 tokens)."""
    a = np.asarray(lengths, dtype=np.float64)
    if a.size == 0:
        return []
    n_strata = max(1, min(n_strata, a.size))
    ranks = _rank(a)
    return [int(min(n_strata - 1, r * n_strata // a.size)) for r in ranks]


def stratified_quota(lengths: Sequence[float], candidates: Sequence[int],
                     target_tokens: float, *, n_strata: int = 4,
                     seed: int = 0) -> dict[int, int]:
    """
    Decide HOW MANY units to drop from each size stratum, once, for all arms.

    This is the fix for the measured flaw. Matching arms on total
    dropped tokens is insufficient because the arms' rankings correlate with unit
    size; a shared per-stratum quota forces every arm to drop the same number of
    small units, the same number of large ones, and therefore near-identical
    token volume AND identical unit count. What remains free — and what the
    experiment is actually about — is WHICH unit inside each stratum goes.

    The quota is drawn by a seeded sample over the candidate pool, so it is
    deterministic and reruns identically, and it is arm-independent by
    construction.
    """
    strata = size_strata(lengths, n_strata)
    pool = {s: [] for s in range(max(strata) + 1)} if strata else {}
    for i in candidates:
        pool.setdefault(strata[i], []).append(int(i))
    rng = np.random.default_rng(seed)
    quota = {s: 0 for s in pool}
    tot = 0.0
    keys = sorted(pool)
    # round-robin across strata so the quota inherits the pool's size mix rather
    # than filling from the largest units first
    remaining = {s: len(v) for s, v in pool.items()}
    while tot < target_tokens and any(remaining[s] > quota[s] for s in keys):
        avail = [s for s in keys if remaining[s] > quota[s]]
        s = int(rng.choice(avail))
        step = float(np.mean([lengths[i] for i in pool[s]]))
        if tot + step > target_tokens * (1 + VOLUME_TOL) and tot >= target_tokens * (1 - VOLUME_TOL):
            break
        quota[s] += 1
        tot += step
    return quota


def stratified_drop(order: Sequence[int], lengths: Sequence[float],
                    quota: dict[int, int], *, n_strata: int = 4,
                    target_tokens: float | None = None, tol: float = VOLUME_TOL,
                    max_swaps: int = 100) -> DropSet:
    """
    An arm drops exactly `quota[s]` units from each size stratum `s`, choosing
    within the stratum by its own preference order.

    Guarantees identical unit COUNT across arms and identical per-stratum
    composition. Splice count is left free and reported, because forcing it would
    constrain WHICH units may go, which is the variable under test.

    CALIPER REPAIR (`target_tokens`). Equal-frequency strata over a heavy-tailed
    length distribution still span a wide range internally — a top stratum over
    real unit lengths runs 320-880 tokens — so equal counts alone leave a ~1.7x
    spread in dropped tokens between arms. The repair fixes this without breaking the
    design: repeatedly apply the single WITHIN-STRATUM swap (one dropped unit out,
    one kept unit of the same stratum in) that most reduces |tokens - target|,
    until the tolerance is met or no swap improves. A within-stratum swap changes
    neither the unit count nor the stratum quota, so the matched design survives;
    what it costs is a little fidelity to the arm's own preference order, which is
    why `swaps` is recorded and the driver must check the arms used a comparable
    number (an arm that needed far more repair than its rivals is no longer
    cleanly that arm's policy).
    """
    strata = size_strata(lengths, n_strata)
    taken: dict[int, int] = {s: 0 for s in quota}
    drop: list[int] = []
    for i in order:
        s = strata[i]
        if taken.get(s, 0) < quota.get(s, 0):
            drop.append(int(i))
            taken[s] = taken.get(s, 0) + 1

    if target_tokens is None:
        return describe_drop(drop, lengths)

    chosen = set(drop)
    pool = {s: [i for i in order if strata[i] == s and i not in chosen] for s in quota}
    tot = float(sum(lengths[i] for i in chosen))
    swaps = 0
    while swaps < max_swaps and abs(tot - target_tokens) > tol * target_tokens:
        best, best_err = None, abs(tot - target_tokens)
        for out in sorted(chosen):
            s = strata[out]
            for inn in pool.get(s, []):
                err = abs(tot - lengths[out] + lengths[inn] - target_tokens)
                if err < best_err - 1e-12:
                    best, best_err = (out, inn), err
        if best is None:
            break
        out, inn = best
        chosen.discard(out)
        chosen.add(inn)
        pool[strata[out]] = [i for i in pool[strata[out]] if i != inn] + [out]
        tot = tot - lengths[out] + lengths[inn]
        swaps += 1
    return describe_drop(sorted(chosen), lengths, swaps)


# ---------------------------------------------------------------------------
# arm orderings (the policies under test)
# ---------------------------------------------------------------------------

def order_low_attention(mass: Sequence[float], candidates: Sequence[int]) -> list[int]:
    """TREATMENT: sacrifice the lowest-attention units first."""
    return sorted(candidates, key=lambda i: (mass[i], i))


def order_high_attention(mass: Sequence[float], candidates: Sequence[int]) -> list[int]:
    """DIRECTION CHECK, not a policy. If dropping the HIGHEST-attention units is
    not worse than dropping the lowest, the signal carries no usable direction
    and the treatment arm's result is noise. Pre-registered as a required sign,
    the same role `clean` plays in the sensitivity control."""
    return sorted(candidates, key=lambda i: (-mass[i], i))


def order_oldest(candidates: Sequence[int]) -> list[int]:
    """INCUMBENT: positional recency — what every real harness does."""
    return sorted(candidates)


def order_random(candidates: Sequence[int], seed: int = 0) -> list[int]:
    """CONTROL: no signal, same volume."""
    rng = np.random.default_rng(seed)
    c = list(candidates)
    rng.shuffle(c)
    return [int(i) for i in c]


def order_oracle(louo: Sequence[float], candidates: Sequence[int]) -> list[int]:
    """
    CEILING, not a policy: sacrifice the units whose measured leave-one-out
    effect is smallest, using the ground truth itself as the ranking.

    No real policy can compute this — it requires having already run the
    counterfactual for every unit, which is the expensive thing a cheap signal is
    supposed to avoid. That is the point. It answers a question no between-signal
    contrast can: **how much is there to win at all?** If a perfect ranker barely
    beats random at matched volume, then every candidate signal — attention,
    covariance, the 4-term D-EV score — is competing for a prize that does not
    exist, and the whole "which units to evict" line is answered.

    SCOPE, stated precisely. This is the ceiling for the class of
    UNIT-INDEPENDENT RANKING policies: those that score each unit on its own and
    drop the lowest. It is not the global optimum, because single-unit effects are
    not additive — the best set of k units to drop need not be the k units with
    the smallest individual effect. So it is an upper bound on every signal this
    project has proposed, and a lower bound on what a set-aware policy could do.
    Both halves of that matter and both are stated in the report.

    `louo` must be indexed by CANDIDATE POSITION, matching `candidates` order.
    """
    if len(louo) != len(candidates):
        raise ValueError(f"louo has {len(louo)} entries for {len(candidates)} candidates; "
                         "the oracle must be scored on exactly the evictable set")
    order = sorted(range(len(candidates)), key=lambda k: (louo[k], candidates[k]))
    return [int(candidates[k]) for k in order]


def order_residual_attention(mass: Sequence[float], candidates: Sequence[int]) -> list[int]:
    """TREATMENT, strict form: attention with the positional trend removed. The
    only arm that is immune to the relabelling objection by construction."""
    sub = [mass[i] for i in candidates]
    r = residualize(sub, list(range(len(sub))))
    return [c for _, c in sorted(zip(r.tolist(), candidates), key=lambda t: (t[0], t[1]))]


# ---------------------------------------------------------------------------
# endpoints
# ---------------------------------------------------------------------------

def kl_divergence(logp_full: np.ndarray, logp_ablated: np.ndarray) -> float:
    """KL(full || ablated) in nats at a single next-token position. SECONDARY
    endpoint: cheap, but a one-position readout is sensitive to local formatting
    perturbation, which is precisely the structural confound the matching gate
    is trying to hold still."""
    p = np.exp(logp_full)
    return float((p * (logp_full - logp_ablated)).sum())


def delta_nll(nll_full: float, nll_ablated: float) -> float:
    """PRIMARY endpoint: how much harder the agent's ACTUAL continuation became,
    in nats/token, once the unit was removed. Averaged over ~160 real tokens, so
    it is far less hostage to a single position, and it is grounded in what the
    agent really did next rather than in a distribution over what it might."""
    return float(nll_ablated - nll_full)
