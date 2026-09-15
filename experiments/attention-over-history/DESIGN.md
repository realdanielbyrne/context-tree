# Attention over history — experiment design

**Status: DESIGN + PILOT. Nothing here is a result, and the recommendation is NOT to proceed to
stage 2 on this corpus** (§6.3). The pilot is 85 measured turns across 4 distinct sessions on a 1B
model, of which 60 are analysable; it was run while writing this document to settle questions that
could not be answered from the armchair. It is a leading indicator, not a finding.

> **This document was substantially rewritten after an adversarial review found five blockers.** Two
> of them invalidated the measurement itself — the attention row was being read at the end of the
> *continuation* rather than the context (§2a), and "units" were not paired with their tool results
> (§2f). Every number in the first draft was produced by that broken instrument and has been
> discarded. Where a claim changed, the old claim is shown struck through rather than deleted, so the
> record of what was wrong survives.

Pilot data: `reports/metrics/attention-over-history/results-primary-all-mean-20260915-105436.json`
(+ `.npz` tensor sidecar). Re-analysable offline with `reanalyse.py`.
Code: `attn_signal.py` (pure), `measure.py` (GPU), `floor.py` (numerical floor),
`reanalyse.py` (offline), `attn-policy.mjs` (live seam),
`test_attn_signal.py` (24 tests), `attn-policy.test.mjs` (16 tests).

---

## 1. The question

An agent re-sends its whole transcript every step. Past the input limit, material must be evicted.
**Which material?**

The hypothesis under test: **low measured attention identifies context that is safe to evict.**

This is not the claim the backlog previously rejected. That rejection (D-EV4) concerned *relevance
computed by embedding similarity to the recent window*, which was measured the worst eviction signal
for a comprehensible reason — a dormant-but-returning unit does not resemble the recent window, so
similarity-eviction drops exactly the unit that comes back. The present claim is about the model's
**actual attention mass**. A unit can be perfectly retrievable and receive almost none of it. The
cheap behavioural proxy for "the model stopped attending to this" is reference-recency (`idle`),
which *was* tested live and returned p = 1.000 — so the proxy is exhausted, and the direct
measurement has never been made.

### 1.1 What the signal is claiming to predict — and reconciling the position-probe null

`report-position-probe.md` is a clean null: 180/180 needle retrievals at every depth out to 155,773
real tokens with 7 distractors. If depth does not hurt retrieval, what is attention supposed to
predict?

The two experiments condition on different things, and the distinction is the whole design:

| | position probe | this experiment |
|---|---|---|
| What is fixed | a **pointed query** that names the needle | the agent's **own natural continuation** |
| What is measured | can the model find it **when asked** | how much the model's next tokens **actually depend on it** |
| Quantity | a **ceiling** — maximum retrievable content | an **operating point** — realised influence |

Formally: the probe measures `P(answer | context, q)` where `q` explicitly requests the unit's
content. This experiment measures `E[log P(continuation | context)] − E[log P(continuation | context \ u)]`
marginalised over the agent's real continuation, with no query pointing anywhere. A unit can have
`P(answer | context, q) = 1` and a deletion effect of essentially zero. The pilot shows exactly that
spread: within a single turn, per-unit |ΔNLL| runs from at/below the numerical floor to ~0.27
nats/token, a **p10–p90 spread of 4.6x the floor**, across units that are all equally present and,
per the probe, all equally retrievable.

> ~~"range over three orders of magnitude"~~ — **withdrawn.** The bottom decade of that range was
> below the measurement floor, so it was reporting rounding error as dynamic range (§4.3).

So the precise claim is: **attention mass predicts spontaneous influence, not retrievability.** The
position null constrains the first not at all. Conversely, nothing here contradicts the null — this
design would be incoherent if it predicted retrieval failures, and it does not.

---

## 2. Critique of the original sketch, and what changed

The brief's sketch was: export attention with `output_attentions=True`, compute per-unit mass from
the final position, ablate lowest-attention vs oldest vs random at matched volume, measure KL from
the full-context distribution. Five things are wrong or underspecified with it. Each was tested.

**(a) THE READOUT MUST RUN ON ITS OWN FORWARD — the first draft's did not.**
`output_attentions=True` is impossible here and unnecessary: at the pilot shape (16 layers, 32 heads,
9,985 tokens) the full set of T×T matrices is `16 · 32 · 9985² · 4 B = 204 GB` against 4.9 GiB free,
while the experiment needs only **one row** — `O(L·H·T)`, **19.5 MiB measured**, a 10,000× reduction,
and exact. Implemented as a custom `AttentionInterface` entry that sees the post-RoPE, post-GQA query
and key, records `softmax(q_last·Kᵀ·scaling)`, and delegates to SDPA so the forward is unperturbed.

The first draft then ruined this by capturing during the **scoring** forward, which runs over
`cat([context, continuation])`. The "last row" was therefore the last token of the 160-token
continuation. That is fatal three times over:

1. the predictor was conditioned on the very thing it predicts;
2. the signal was **not computable at eviction time**, so `attn-policy.mjs` could never reproduce it —
   the live seam and the offline measurement were computing different quantities;
3. a large share of the mass landed on continuation tokens, so the reported "sink" was mis-attributed.

Fixed: `capture_context()` runs its own forward over the context alone and **asserts the captured
width equals the context length**, so the defect cannot recur silently. `GEN_PREFIX_TOKENS` only
became a meaningful parameter once this was fixed; previously it was inert.

**(b) Attention is not importance, so it must not be the primary quantity.** Attention weights are a
contested proxy for causal influence, and this codebase has already shipped a signal that correlated
with something real and caused nothing. The fix is to **measure the counterfactual directly**:
leave-one-unit-out. It needs no attention export, it is the definition of what an eviction policy
destroys, and on this hardware it costs **0.11 s per unit**. So:

> **LOUO is the ground truth. Attention is demoted to a cheap predictor whose entire value is its
> rank correlation with LOUO.** The hypothesis becomes falsifiable without anyone having to agree
> about what attention "means".

Both are designed and both are run; the causal one is primary.

**(c) "Matched volume" in tokens is not matched.** Measured on the **real harness** —
`evictToBudget` from `experiments/context-dedup/policies.mjs`, 50 units with heavy-tailed lengths,
ρ(mass, length) = +0.65, W = 8000, 12 trials:

| arm | kept tokens | kept units | drop splices |
|---|---|---|---|
| recency | 7,454 | 28.5 | 2.3 |
| lowattn | 7,467 | **20.9** | **10.5** |
| random | 7,446 | 29.9 | **12.3** |
| **within-trial ratio** | **1.004 mean, 1.013 max** | **1.56 mean, 2.00 max** | **6.97 mean, 13.0 max** |

Because attention mass correlates with unit length, "drop the lowest-attention units" means "drop
many small units" and "drop the oldest" means "drop a few large contiguous ones". So volume matching
is **necessary but not sufficient**: the incumbent harness already matches kept tokens to ~0.4%, and
the arms still diverge up to 2× in unit count and 13× in splice count.

> **Correction to an earlier draft of this document.** It reported 26% / 4× / 4.5× and attributed
> those to `evictToBudget`. Those figures came from `greedy_drop` — a *drop-side* greedy written as a
> foil in `attn_signal.py` — whereas `evictToBudget` is a *keep-side best-fit fill* that does not stop
> at the first non-fitting unit and therefore matches kept tokens far more tightly. The confound is
> real; the mechanism and the magnitudes were wrong. The correction matters in both directions: it
> would have discredited the prior A/B series for a defect it does not have, while understating the
> splice divergence, which is the larger of the two.

The design replaces token-greedy matching with **stratified quota matching plus a caliper repair**
(§5.3), and adds `matching_gate` covering all three axes.

**(d) One axis cannot be matched at all, and this changes which contrast is primary.** Dropping the
oldest units is contiguous *by construction* — one splice — while any content-selective rule
scatters. No matcher can fix that without forbidding the treatment from expressing itself. So
splices are a **reported covariate**, and the **primary policy contrast is lowattn vs random**
(comparable splice structure), with `oldest` reported as the real-world reference carrying an
acknowledged structural advantage. `test_oldest_arm_is_structurally_less_fragmented` pins this so it
cannot be quietly forgotten.

**(e) Deletion confounds "content removed" with "positions shifted".** Removing a unit moves every
later token to a lower index, changing its RoPE phase. The design adds a **same-length substitution
control**: replace the unit with neutral filler of identical token length, holding all positions
fixed. Measured: `spearman(deletion, substitution) = +0.713` pooled.

> ~~"so roughly 35% of the raw deletion effect is positional"~~ — **withdrawn**. A rank correlation
> of ρ between two measures does not license a statement that `1 − ρ²` or `1 − ρ` of one "is" the
> other; that is a variance-decomposition claim and Spearman does not support it. What the number
> honestly says is: deletion and substitution agree on the ordering of units but are not
> interchangeable. Both are reported; substitution is primary because only it isolates content.

**(f) The "unit" was not the harness's unit.** The first draft's loader emitted one unit per
assistant message *and* a separate unit per tool result, while its docstring claimed the pairing
`coding-harness/lib.mjs extractUnits` performs. Every single-unit deletion therefore **orphaned a
tool_call from its tool_result** — a malformed transcript that `attn-policy.test.mjs` explicitly
asserts the live policy never produces. A share of the measured "causal effect" was the model
reacting to a structural violation, not to lost information.

Fixed, and harder than it looks: tool results do **not** always follow their call immediately — real
sessions interleave, and a result can arrive after a later assistant message. Attaching by arrival
order still orphans calls, so units are assembled by **`tool_use_id` ownership**.
`assert_units_wellformed()` checks the invariant once per session and fired on real data twice during
development. Side effect: paired units are much larger, which raises deletion effects well clear of
the numerical floor (§4.3) — the fix improved the endpoint as well as the construct.

---

## 3. The signal, precisely

### 3.1 Definition

Let the context be tokens `1..T`, partitioned into a pinned head `H`, evictable units `u ∈ U` with
token spans `[a_u, b_u)`, and a generation prefix `G` (§3.3). For layer `l`, head `h`, let

```
    α_{l,h,t} = softmax_t ( q_{l,h,T} · k_{l,h,t} / √d )        (the last row; Σ_t α = 1)
    m_{l,h}(u) = Σ_{t ∈ [a_u, b_u)} α_{l,h,t}                    (raw per-unit mass)
```

Head aggregation, then layer aggregation, then renormalisation over the evictable set:

```
    m_l(u) = A_head( { m_{l,h}(u) }_h )         A_head ∈ { mean, max, entropy-weighted }
    m(u)   = (1/|L|) Σ_{l ∈ L} m_l(u)           L ⊆ layers, a named subset
    m̃(u)   = m(u) / Σ_{v ∈ U} m(v)              THE SIGNAL
```

Two derived quantities are reported alongside:

```
    density(u)  = m̃(u) / (b_u − a_u)
    resid(u)    = rank-space residual of m̃(u) regressed on rank(position(u))
```

**Sink handling is the renormalisation.** Measured, the pinned head — as few as **13 tokens** —
absorbs **47–54%** of all last-row mass, rising to **59–80%** once a generation prefix is present,
leaving the 40–70 evictable units to share **20–41%**. Any "fraction of attention" over the whole
sequence is therefore mostly a measurement of the sink, and the sink's share *drifts turn to turn*,
injecting that drift straight into the signal. Excluding `H` and `G` from the normaliser removes it.
`sink_fraction` is reported per turn so a turn where the evictable set sits near the numerical floor
can be flagged rather than silently analysed.

**Mass, not density.** Pilot: mass correlates with the causal effect at +0.31…+0.73 (median +0.61
against ΔKL); density at **+0.006**. Density is nevertheless computed and swept, because "mass wins"
must stay a measured claim.

### 3.2 Aggregation is swept, never hardcoded

The repo's rule forbids undefended constants, and layers genuinely disagree: pilot
`spearman(per-layer mass, position)` runs **+0.61 at layer 0 to −0.07 at layer 15** on the same turn.
So `A_head × L` is a 15-cell sweep:

- `L ∈ { all, early (0–25%), mid (25–75%), late (75–100%), upper-half }` — fractions, not indices, so
  the same names transfer across model depths.
- `A_head ∈ { mean, max, entropy-weighted }`. `mean` is **pre-registered primary**; the other two
  exist so the choice is defended, and specifically so a weighting scheme cannot be tuned into
  producing a result after the fact.
- Entropy weighting: `w_{l,h} = 1 − H(p_{l,h}) / log|U|` where `p` is the head's normalised mass over
  units. A head attending uniformly across history tells us nothing about which unit matters.

**Sweep selection must be done on a held-out session split, never on the test set.** With 15 cells
and a ~0.1 spread of noise, selecting the best cell post hoc would manufacture a positive result.

**Implementation requirement:** cache the per-turn `[L, H, U]` tensor (≈287 KB/turn, ≈57 MB for 200
turns) so all 15 aggregations are recomputed offline from one GPU pass. Without this the sweep costs
15× the GPU budget; with it, it is free.

### 3.3 The readout position — a parameter the pilot proved load-bearing

Where the last row is read matters more than any aggregation choice. Reading it at the end of the raw
transcript — i.e. at whatever token the previous tool result happened to end on — collapsed the
partial correlation with the causal effect to **+0.05**. Reading it after a short **generation
prefix** (the first `GEN_PREFIX_TOKENS` of the agent's real next message, so the model is genuinely
mid-decision) is the state the hypothesis is actually about.

`GEN_PREFIX_TOKENS = 12` is a **flagged placeholder**, swept over `{0, 4, 12, 32}`. Likewise the
number of readout rows: the design averages the last row over the final `R ∈ {1, 8, 32}` positions.
Neither has been optimised and neither may be reported as canon without the sweep.

---

## 4. Endpoints — and the pilot's most consequential finding

### 4.1 ΔKL is WITHDRAWN — it sits below its own numerical floor

> ~~"attention mass predicts ΔKL at +0.535 / partial +0.423"~~ and ~~"the two endpoints are
> uncorrelated, ρ = −0.061"~~ — **both withdrawn. No claim in this design rests on ΔKL.**

ΔKL was computed in float32 from a **bfloat16** forward. At `|log p| ≈ 10` the float32 ulp is ~1e−6,
which is the same order as the differences being summed. The consequences are visible in the first
draft's own shipped artefact:

- it contains `louo_kl = −5.006e−08`, and **KL is non-negative by construction**;
- **45% of 296 values were below 1e−6**, i.e. at or under the representable resolution;
- a cross-kernel / fp32-CPU replication disagreed by **40–70%** on values already at 1e−4.

And the apparent correlation had a mundane explanation that needed no attention at all:
`length_vs_louo_kl` median +0.327 with `mass_vs_length` median +0.571 — mass tracks length, length
tracks the artefact.

ΔKL is still computed and stored, under keys prefixed `UNRELIABLE_`, purely so the defect stays
visible in the artefact. Reinstating it as an endpoint would require a float64 KL from a
float32-or-better forward **plus** a demonstrated cross-kernel replication. An fp32 1B model is
4.95 GiB and does not fit the 4.9 GiB of spare VRAM, so on this hardware that means CPU or a stopped
server — i.e. it is not a small fix, and the design does not depend on it.

Separately, the first draft quoted §4.1 magnitudes that were **one turn's** numbers presented as
pooled, and presented a *median of six per-turn ρ* as if it were a single pooled ρ. Both framings are
corrected throughout: every statistic below is labelled **pooled** (over turn×unit rows) or
**per-turn** (median/mean of per-turn values), because on this data the two disagree, sometimes in
sign, and that disagreement is itself a finding (§6.2).

### 4.2 Why ΔNLL is primary

1. It is grounded in what the agent **actually did next**, not in a distribution over what it might.
2. It averages over ~160 real tokens rather than one position, so it is not hostage to local
   formatting.
3. It survives the numerical audit that ΔKL fails (§4.3).

### 4.3 The numerical floor — the first draft's claim of zero was false

> ~~"The measurement floor is exactly zero."~~ — **withdrawn.** That was measured by re-scoring an
> *identical* tensor twice, which tests **determinism, not accuracy**: the same kernel on the same
> shape reproduces the same rounding errors, so of course it agrees with itself.

ΔNLL is a difference between forwards over sequences of **different lengths**, which changes tile
boundaries, reduction order and kernel selection. `floor.py` measures the disagreement between two
numerically-equivalent ways of computing the *same shape-changing edit*:

| probe | max | RMS |
|---|---|---|
| default SDPA vs MATH backend (same device, same dtype) | 1.55e−2 | **6.30e−3** |
| bf16 GPU vs fp32 CPU (different device and precision) | 4.64e−2 | **2.48e−2** |
| *repeat, same kernel (determinism only — the misleading probe)* | 0.00 | 0.00 |

**Two floors, two jobs, and they are not interchangeable:**

- **6.30e−3 governs the validity gate.** Every comparison this design makes is between two forwards
  on the same GPU in the same dtype, so same-device reproducibility is what bounds internal validity.
- **2.48e−2 governs absolute quotes.** Any ΔNLL reported as a physical quantity is accurate only to
  this, so absolute values are quoted to one significant figure and never compared across hardware.

Gating on the cross-device floor would be over-conservative and discards 93% of the corpus (6/85
turns survive); gating on the same-device floor keeps **60/85**. `reanalyse.py` reports both so the
choice is a visible, re-runnable parameter rather than a constant someone must trust.

**What the floor does and does not damage.** At the same-device floor, 26% of turn×unit rows are
noise-ties — a real cost to per-unit rank statistics. But the quantity the design actually depends on
is the *reproducibility of the ranking*, and that is high:

| rank reproducibility of the ground truth | Spearman |
|---|---|
| default vs MATH kernel (same device, same dtype) | **+0.981** |
| bf16 GPU vs fp32 CPU (different device and precision) | **+0.946** |

This is the honest **ceiling on how well any predictor could correlate with this ground truth** — a
signal cannot beat the reproducibility of the thing it predicts. At +0.95 that ceiling is not the
binding constraint; the corpus is (§8).

### 4.4 Endpoint hierarchy

- **Primary:** `ΔNLL_substituted` — same-length substitution, which isolates content from position.
- **Co-primary:** `ΔNLL_deleted` — raw deletion, what a policy actually does.
- ~~Secondary: ΔKL~~ — withdrawn, §4.1.
- **Tertiary (stage 5 only):** live task success on `longbuild`. Reported, never used to adjudicate —
  it has returned null four times and item 0 showed it may be insensitive.

---

## 5. Arms and matching

### 5.1 Arms

| arm | order | role |
|---|---|---|
| `lowattn` | ascending `m̃` | **treatment** |
| `residattn` | ascending `resid` | **treatment, strict** — immune to the relabelling objection by construction |
| `random` | seeded shuffle | **control**, and the primary comparator (matched splice structure) |
| `oldest` | ascending index | **incumbent** — what real harnesses do; structurally less fragmented, see §2(d) |
| `highattn` | descending `m̃` | **direction check**, never a policy |

`highattn` plays the role `clean` played in the sensitivity control: if dropping the *highest*-attention
units is not measurably worse than dropping the lowest, the signal carries no usable direction and the
treatment's result is noise whichever way it fell. **This is a required sign, pre-registered.**

### 5.2 Volume matching (the mandatory constraint)

Arms differ in **which** content is kept, never **how much**. "More context is better" is established
at OR 42× per e-fold; any arm winning on volume has proven nothing.

### 5.3 The matcher

1. Partition units into `n_strata = 4` equal-frequency size strata.
2. Draw a **shared per-stratum quota** from a seeded sample over the candidate pool — arm-independent
   by construction. This forces every arm to drop the same number of small units and the same number
   of large ones, so unit count is **identical** and token volume near-identical.
3. Each arm fills its quota by its **own** preference order. What remains free — and what the
   experiment is about — is *which* unit inside each stratum goes.
4. **Caliper repair.** Equal-frequency strata over a heavy-tailed length distribution still span
   widely (the pilot's top stratum ran 320–880 tokens), leaving a 1.72× token spread. Repeatedly apply
   the single **within-stratum** swap that most reduces `|tokens − target|`. A within-stratum swap
   changes neither unit count nor quota, so the matched design survives; it costs a little fidelity to
   the arm's preference order, which is why `swaps` is recorded and arms must use comparable numbers.

Measured result: token ratio ≤ 1.05, unit-count ratio 1.00, splice ratio ≤ 1.5 among the
content-selective arms.

### 5.4 Gates — three, in tension, all pre-registered

A cell failing any gate is reported **UNINFORMATIVE**, never as a null.

| gate | fails when | threshold | pilot |
|---|---|---|---|
| `inertness_gate` | the signal is near-constant across units, so the arm is a no-op | CV ≥ 0.25 **and** spread ≥ 3× | 6/6 pass (CV 0.83–0.86, spread 13–46×) |
| `relabelling_gate` | the signal is positional recency in disguise | \|ρ(m̃, position)\| ≤ 0.5 | 5/6 pass (median +0.31) |
| `matching_gate` | arms are not comparable | token ≤ 1.05, count ≤ 1.25, splice ≤ 3.0 | 3–5 of 6 cells pass |
| `treatment_gate` | matching succeeded so well it **erased** the treatment | Jaccard(treatment, comparator) ≤ 0.8 | checked per cell |

The last one exists because the first three are in tension: tightening comparability removes the arms'
freedom to differ. It is the direct analogue of the validity condition added after the sensitivity
control, where `clean` and `random` both scored 0/10 because the control had **stopped attempting the
task** — vacuous despite passing every pre-registered check.

---

## 6. Pre-registered falsification

Evaluated on stage 2, over ≥ 200 turns from ≥ 5 sessions, with a **session-clustered bootstrap**
(sessions are the independent unit; turns within a session are heavily autocorrelated — C0: sample
problems, not seeds).

**F0 — instrument.** `inertness_gate` and `relabelling_gate` pass on ≥ 90% of turns.
*If not:* the arm cannot differ from its control for reasons unrelated to the hypothesis. Stop.

**F1 — direction.** `highattn` is worse than `lowattn` on primary ΔNLL, with the session-clustered
95% CI of the paired difference excluding 0.
*If not:* the signal carries no usable direction; everything downstream is noise. **Retire.**

**F2 — PRIMARY.** The partial rank correlation of attention mass with primary ΔNLL, controlling for
unit length, **exceeds the same partial for the best incumbent signal (position, `idle`) by ≥ 0.10**,
consistently across session clusters.
*If not:* attention adds nothing over what the harness already knows for free. **Retire
attention-as-eviction-signal.** This is a margin over an incumbent, not a test against zero — beating
nothing is not the bar, because position is already available at zero cost.

*Where the 0.10 comes from, stated plainly:* **it is a judgement call, not a derivation.** The first
draft presented it as pre-registered and then used it as the assumed effect size in the power
calculation — circular. The defensible content is the *direction* of the requirement (a new signal
must beat a free one by enough to pay for computing it), and the specific number is the smallest
margin that would survive the rank-reproducibility ceiling of the ground truth (§4.3) with room to
spare. It is reported as a threshold with the observed margin alongside, never as a significance
test.

**F3 — policy, secondary.** At matched tokens, unit count and (among selective arms) splice count,
`lowattn` ≤ `random` on primary ΔNLL across keep-fractions **pooled**, not at a best-of-three
fraction.
*If not:* the signal may still be scientifically interesting but is not a policy.

### 6.1 What stage 1 actually returned, after the fixes

85 turns measured across **4 distinct sessions**; 60 analysable at the same-device floor.

| | pooled (1,304 turn×unit rows) | per-turn (n = 60) |
|---|---|---|
| mass, partial \| length | **+0.065** | — |
| position, partial \| length | **−0.040** | — |
| **F2 margin** | **+0.105** | median **+0.037**, mean +0.051, sd 0.306, **wins 33/60** |

Per session cluster — the level at which C0 says inference must happen:

| session | n turns | mean F2 margin | wins |
|---|---|---|---|
| claude-code-session-2 | 17 | +0.091 | 10/17 |
| claude-code-session-3 | 3 | **−0.039** | 2/3 |
| claude-code-session-5 | 19 | +0.080 | 10/19 |
| claude-code-session | 21 | **+0.004** | 11/21 |

Read honestly: the pooled margin lands exactly on the 0.10 threshold, the per-turn win rate is
**55% — a coin flip**, one of four clusters is negative, and the largest cluster is +0.004. The
between-cluster spread swamps the effect. **This is not a pass.**

### 6.2 The aggregations disagree, and that instability is the finding

At the same-device floor: pooled margin **+0.105**, per-turn median **+0.037**.
At the cross-device floor (6 turns): pooled margin **−0.010**, per-turn median **+0.168**.

The two aggregations disagree **in opposite directions in the two subsets**. A result that flips sign
depending on whether you pool rows or average per-turn correlations, and flips again when the
inclusion threshold moves, is not measuring something stable at this n. Reporting either number alone
would be cherry-picking; the design now reports both by construction (`reanalyse.py`).

### 6.3 The ablation advantage is small and partly fragmentation

At the properly-powered read (96 gate-passing cells, same-device floor):

- `lowattn − random`: mean **−0.028**, **d = −0.157**, wins **58/96 (60%)**
- mean splice difference −0.64 (lowattn fragments slightly less)
- ρ(splice difference, advantage) = **+0.093**
- restricted to **splice-matched** cells (n = 65): mean −0.019, wins **36/65 (55%)**

> ~~"lowattn − random d = −1.24, wins 5/5"~~ — **withdrawn.** That was the 50%-keep-fraction alone at
> n = 5, selected post hoc from a pre-registered three-fraction sweep, and produced by the broken
> instrument. The first draft also transcribed `lowattn − highattn` (−0.211) into the
> `lowattn − random` row of its effect table, a 2× overstatement. Both are corrected.

The fragmentation confound the review flagged is **real but not the explanation at adequate n**: at
n = 7 cells it looked decisive (ρ = +0.964), at n = 96 it is ρ = +0.093, and the advantage survives
splice-matching — at 55% of cells, which is to say barely. The honest summary is that F3 shows a
small effect in the predicted direction that is not distinguishable from noise on this corpus.

---

## 7. Validity conditions

- **V1 — RESOLUTION (restated).** A turn is analysable only if **≥ 50% of its units produce a deletion
  effect above the same-device floor** (6.30e−3). Below that the per-unit ranking *is* the rounding
  error. Implemented as `gate_resolution`, evaluated per turn, with the exclusion list printed.
  Measured: **60/85 turns analysable**; 26% of surviving rows are still noise-ties.
  > ~~"exclude turns whose median |ΔNLL| < 10× floor; 0% excluded"~~ — **withdrawn.** With floor = 0
  > that gate could never fire, so "0% excluded" was an artefact of the false floor, not a property of
  > the data. With the real floor, a 10× rule would exclude every turn measured.
- **V2 — sink.** If the evictable set receives < 5% of total mass, flag the turn.
- **V3 — sessions (restated, and now a blocking problem).** The five committed fixtures are **four
  distinct sessions**: `claude-code-session-4.jsonl` is a strict subset of
  `claude-code-session-5.jsonl` — same `sessionId` (11bef7b8-…), **1584/1584 shared event uuids**.
  `dedupe_sessions()` collapses them, keeping the longer. This is not tidiness: a session-clustered
  bootstrap that counted the duplicate as an independent cluster would let it vote twice, which is
  anti-conservative in exactly the direction that manufactures a positive F2.
- **V4 — no post-hoc sweep selection.** Aggregation cell chosen on a held-out session split. With 4
  clusters there is no honest held-out split, so **the sweep is not run** and `layers="all"`,
  `head_agg="mean"` stand as the pre-registered defaults (§8.2).
- **V5 — determinism.** The pipeline reruns bit-identically (seeded PRNG for quota and control arms;
  manifest records git sha, torch/transformers/numpy versions, dtype, and every parameter).
  Determinism is **not** accuracy — see §4.3.
- **V6 — the arms must still differ.** `treatment_gate`, §5.4.
- **V7 — structural well-formedness.** `assert_units_wellformed()` verifies every tool_result shares a
  unit with its tool_call, per session, before any measurement. Added after §2f.

---

## 8. Power, and why the corpus cannot support the pre-registration

### 8.1 The corpus, audited

> ~~"The design targets 200 turns across 5 sessions."~~ — **withdrawn as unreachable.**

| | available |
|---|---|
| committed fixtures | 5 files → **4 distinct sessions** (V3) |
| turns measurable (stride 1, all sessions) | **85** |
| turns analysable at the same-device floor | **60** |
| independent clusters | **4** |

The local `~/.claude/projects` store does not rescue this: 45 files → **13 distinct sessionIds**, of
which only **4 have ≥ 300 events**, and two of those *are* the committed fixtures (11bef7b8 = session-5,
0bfb1ba3 = session-3). At most **2 genuinely new** long sessions exist locally, one from an unrelated
project. Ceiling on this machine today: **~6 clusters**.

### 8.2 What 4 clusters can and cannot support

- **Cannot:** a session-clustered bootstrap CI. A percentile cluster bootstrap on 4 clusters covers
  roughly 50–60% at nominal 95%. The first draft's F2 required "the session-clustered 95% CI of the
  margin excluding 0" and **no such bootstrap exists in the code** — `summarise()` did turn-level
  inference, which V3 forbids. That is now replaced by **listing every cluster individually and
  quoting no CI at all**, which is the only honest option at this n.
- **Cannot:** the 15-cell aggregation sweep. Selecting the best of 15 cells with 4 clusters and a
  between-cluster spread of ±0.09 would manufacture a result. The sweep is therefore **not run**; the
  pre-registered defaults stand. (The `.npz` sidecar makes it free to run *later*, on a corpus that
  can support it — that is why the caching exists.)
- **Can:** descriptive, per-cluster reporting of the observed margin — which is what §6.1 does.

### 8.3 The power calculation, corrected

The first draft computed *n* for 80% power using the 0.10 threshold as the assumed effect size — the
same number it had pre-registered as the decision boundary. That is circular: it assumes the effect
it is testing for. Replaced with the observed dispersion:

per-turn F2 margin sd = **0.306**; between-cluster sd of the per-session mean = **0.060** (from
+0.091 / −0.039 / +0.080 / +0.004). To detect a true margin of +0.10 at the cluster level with 80%
power requires roughly `(2.8 · 0.060 / 0.10)² ≈ 3` clusters **if** the cluster means were that tight
around a common value — but they are not tight around +0.10, they straddle zero. Treating the
observed cluster spread as the sampling distribution, the 4 cluster means have mean +0.034 and sd
0.060, giving a *t* of 1.1 on 3 df: **nowhere near significant, and no *n* of turns fixes it.**
Clusters are the scarce resource and there are four.

**Required corpus for a confirmatory F2: ≥ 20 distinct long sessions.** That does not exist here and
cannot be harvested from this machine.

---

## 9. Feasibility — verified, not assumed

All figures measured on this host, 2026-09-15.

### 9.1 Hardware

| | GPU 0 | GPU 1 |
|---|---|---|
| total | 32,607 MiB | 32,607 MiB |
| used by `llama-server` (PID 1183607) + desktop | 29,470 MiB | 27,702 MiB |
| **free** | **3,137 MiB** | **4,905 MiB** |

**The experiment does not require evicting the server.** Measured footprint on GPU 1: model 2.30 GiB,
peak 2.82–2.93 GiB at T ≈ 12k. It fits in the spare 4.9 GiB with headroom, and the pilot ran
repeatedly without disturbing the server.

Two memory facts, both counter-intuitive and both measured:
- Attention readout is **not** the constraint: 19.5 MiB.
- **Logits are.** A full `[T, 128256]` float tensor OOMs at 2.68 GiB. `logits_to_keep` bounds it to
  the continuation window. This is the one place the design would fail naively.

### 9.2 Software

`torch 2.11.0+cu130`, `transformers 5.5.0`, `accelerate 1.15.0` already present at
`/home/realdanielbyrne/.unsloth/studio/unsloth_studio/bin/python`. **Used read-only; nothing is
installed into it** — it belongs to another workflow. `transformers ≥ 5.0` is required for
`AttentionInterface.register`, which is what makes the cheap readout possible at all.
`/mnt/data/ctx-swebench/tooling/venv` has numpy/scipy/statsmodels/pandas but **no torch**; it runs the
pure half and the analysis. If a dedicated environment is wanted, create it on `/mnt/data` (16 TB
free) — the main drive has 977 GB and should not carry a second torch.

### 9.3 Vehicle, and the small-model objection

`meta-llama/Llama-3.2-1B-Instruct` is **already cached** (2.4 GB, bf16 safetensors) — zero download.
No dense HF Qwen3 weights are cached; the local Qwen3 models are GGUF, which is precisely why the
server cannot export attention.

**Yes, a 1B is the only comfortable vehicle in 4.9 GiB, and yes that is a real threat to validity.**
The honest statement:

- Fits now: ~0.6B–1.7B in bf16 alongside a 12k context. Llama-3.2-1B (cached), Qwen3-0.6B and
  Qwen3-1.7B (downloads).
- Does **not** fit: 3B+ in bf16. Would need 4-bit (bitsandbytes not verified present) or the server
  stopped.

Three transfer checks, in increasing cost:

1. **Rank-stability ladder (cheap, no coordination).** Compute `m̃` and LOUO on 0.6B / 1B / 1.7B over
   the same turns and report `spearman` of the per-unit signal across sizes. High stability (> 0.7)
   makes size-invariance plausible; a signal that reshuffles between 0.6B and 1.7B will not survive to
   27B and the whole line should be dropped.
2. **Cross-model prediction (cheap).** Does the *small* model's LOUO effect predict the *larger*
   small model's? This is the transfer question in miniature and needs no big model at all.
3. **The decisive test (needs coordination).** The 27B cannot export attention, so it can only supply
   the **endpoint**: rank units with the small model, ablate at matched volume, and score the 27B's
   continuation log-probabilities through the OpenAI-compatible API.
   - **Pre-flight gate, not yet run:** verify the server returns a `logprobs` field. *I did not test
     this, deliberately — other work is using the server.* One small request settles it.
   - If `logprobs` is unavailable, the fallback is running the 27B under transformers, which needs
     ~54 GiB bf16 across both cards and therefore the server **stopped**. **Coordination cost:
     2–4 h of exclusive GPU time, blocking the other workload.** That is the only step in this design
     that requires it, it is the last step, and it should not be paid until stages 1–3 have earned it.

### 9.4 Endpoint determinism is NOT endpoint accuracy

Reruns are bit-identical (repeat noise `0.000e+00`), which makes the pipeline reproducible. It says
nothing about accuracy: the same kernel on the same shape reproduces the same rounding errors. The
accuracy floor is 6.30e-3 same-device / 2.48e-2 cross-device — see §4.3, where the first draft's
"floor is exactly zero" claim is withdrawn.

---

## 10. Staged plan — cheapest thing that could kill it, first

| stage | what | gate to proceed | GPU | status |
|---|---|---|---|---|
| **0** | pure-half unit tests, no GPU | 24 + 16 tests green, mutation-checked | 0 | **done** |
| **0b** | numerical floor (`floor.py`) | a floor exists and the rank survives it | ~8 min | **done** |
| **1** | **kill probe** — all 4 distinct sessions, 85 turns, default aggregation | F0, F1 | ~35 min | **done** |
| **2** | confirmatory F2 on >= 20 distinct sessions + 15-cell sweep | **F2** | ~1.5 h | **BLOCKED — corpus (§8)** |
| **3** | policy ablation, all fractions pooled, splice-covaried | **F3** | ~10 min | ran with stage 1; §6.3 |
| **4** | transfer ladder, 0.6B / 1B / 1.7B | rank stability > 0.7 | ~4 h | not started |
| **5** | 27B endpoint transfer — **requires coordination** | only if 2–4 pass | 2–4 h exclusive | not started |
| **6** | live `longbuild` A/B through `attn-policy.mjs`, with cacheWrite/cacheRead | — | — | not started |

**Stage 1 outcome.** F0 passes (inertness 6/6 of gate-passing turns; relabelling 5/6 — one turn
breached the rho <= 0.5 threshold). F1 shows the right sign: `highattn` is the worst arm at every
keep-fraction. **F2 does not pass** (§6.1): pooled margin +0.105, but per-turn wins 33/60, one
cluster negative, and the largest cluster +0.004. **F3 shows a small effect in the predicted
direction that is not distinguishable from noise** (§6.3).

**Stage 2 must not be entered on this corpus.** Not because the indicator is weak — a weak indicator
is a reason to run a better-powered test — but because the better-powered test **does not exist
here**: 4 clusters cannot support the cluster-level inference F2 requires, and running it anyway
would produce a number whose confidence interval is known in advance to be wrong (§8.2).

**Cost actually incurred: ~50 GPU-minutes** (stage 1 ~35 min, floor ~8 min, development the rest).
Stage 2 as specified is ~1.5 GPU-hours *once a corpus exists*; the corpus is the blocker, not the
compute.

---

## 11. Caveats any result from this design will carry

1. **One model family, small.** Everything is measured on a 1B model. The project's own vehicle is a
   27B, and attention structure is depth- and scale-dependent. Stage 4 would bound this; it has not
   been run.
2. **Four session clusters.** This is the binding limit and it is not fixable by measuring more turns
   from the same sessions (§8). Every headline number is descriptive.
3. **Attention is read at one position** (or a short window). A unit may matter at turn *t+3* and
   receive nothing at *t*. This measures instantaneous influence; eviction is a decision about the
   future — the same gap that makes `idle` a lagging indicator.
4. **Teacher-forced continuation, not rollout.** ΔNLL scores the agent's *recorded* next message. It
   cannot see a counterfactual where losing a unit sends the agent down a different but equally good
   path.
5. **26% of analysed rows are noise-ties** even after the resolution gate, which attenuates every
   rank statistic toward zero. A null here is partly a null about resolution.
6. **Splice structure is not matched against `oldest`** and cannot be (§2d). Any `oldest` comparison
   carries that caveat permanently.
7. **Replayed transcripts, not live agents.** The transcript is fixed; the agent never reacts to the
   eviction. This is the immediate information cost of a deletion, not the trajectory cost.
8. **`GEN_PREFIX_TOKENS`, `R`, `n_strata`, `halfLifeTurns`, the caliper tolerance, the 0.5 resolution
   threshold, `RELABEL_RHO_MAX` and the F2 margin of 0.10 are all placeholders until swept**, and each
   is flagged as such at its definition. The 15-cell aggregation sweep was deliberately **not run**,
   because 4 clusters cannot support selecting among 15 cells (§8.2).
9. **ΔKL is withdrawn, not merely deprioritised** (§4.1).
10. **The first draft of this design was wrong in ways that changed its conclusion.** Two measurement
    defects (§2a, §2f) and a false floor (§4.3) between them produced a `lowattn − random` effect of
    d = −1.24 that is, correctly measured, d = −0.157. That is the strongest available evidence for
    the project's own rule that instrument validation precedes measurement.

## 12. If the honest verdict is "retire"

F2 has not passed, and on this corpus it cannot be given a fair test (§8). That does not make the
work worthless; four things survive independently and should be written up regardless:

- **The measurement instrument.** Last-row attention at `O(L·H·T)` and bit-deterministic LOUO at
  0.11 s/unit make per-unit causal importance *cheap*. Any future eviction signal — temporal
  covariance (backlog 0c), the 4-term D-EV score, a learned policy — can now be validated offline
  against ground truth before a single live token is spent. That is a reusable asset and arguably
  worth more than the hypothesis.
- **The matching finding.** Token-volume matching is insufficient; unit count and splice count must be
  matched or covaried. `evictToBudget` matches kept tokens to ~0.4% while diverging up to 2x in unit
  count and 13x in splice count (§2c), so the existing A/B series could not have separated a content
  effect from a fragmentation effect. That is a narrower criticism than "the series was confounded",
  and it is the correct one.
- **The endpoint finding.** The intuitive choice — KL from the full-context distribution, as the
  brief proposed — is **not measurable at this precision**: in bf16 it lands below its own float32
  ulp, producing negative "KL" values in a shipped artefact (§4.1). Anyone reaching for that endpoint
  should cost the fp32 forward first.
- **The floor method.** `floor.py`'s distinction between determinism and accuracy, and between the
  same-device and cross-device floors, applies to every future offline measurement in this repo.

### 12.1 The oracle ceiling — RUN, and it changes the reading of everything above

Full report: `reports/metrics/attention-over-history/report-attention-over-history.{md,html}`.
Data: `results-primary-all-mean-20260915-111951.json`. 86 volume-matched cells, 60 analysable turns,
4 clusters, ~35 GPU-minutes.

| contrast | mean dNLL | vs floor (6.30e-3) | d | cells favouring |
|---|---|---|---|---|
| oracle - random | **-0.0810** | **13x** | -0.63 | 72/86 |
| oracle - recency | **-0.0666** | **11x** | -0.50 | 70/86 |
| low-attention - random | -0.0204 | 3x | -0.13 | 53/86 |

**All four session clusters agree in sign** (-0.064, -0.067, -0.144, -0.046 against random), which F2
conspicuously did not. Matching held: 3,168-3,179 tokens across arms (0.3%), identical unit counts
(8.9), and the oracle sits *between* recency and random on splices (4.9 vs 4.3 and 5.3), so it is not
winning by fragmenting less.

**96% of the damage random deletion causes is avoidable. Recency captures 18% of that prize,
attention 25%, leaving ~75% unclaimed.** At the 30% keep-fraction the oracle's dNLL is *negative* —
deleting the right half of the history made the agent's next message easier to predict than keeping
all of it.

This inverts the reading of the five previous nulls, including F2 above. **They were not evidence
that the choice does not matter.** The choice matters a great deal; the candidates tested so far
capture little of it. The bottleneck is the signal, not the opportunity.

### 12.2 What to do next, in priority order

1. **Keep looking for a selection signal — the prize is real.** ~75% of the available headroom is
   unclaimed by either incumbent. Temporal covariance (backlog 0c) is the best-motivated untried
   candidate, and it can now be validated offline against measured ground truth for ~0.11 s/unit
   before any live token is spent.
2. **Build the corpus before any confirmatory between-signal test.** >= 20 distinct long sessions.
   The SWE-bench substrate (backlog item 9, 156 instances runnable here) is the obvious generator.
   The oracle result is robust at 4 clusters because all four agree; a between-signal contrast is not,
   because the effects are ~4x smaller.
3. **Then** re-run F2, with the 15-cell sweep on a held-out split and a cluster bootstrap.
4. **Test the set-aware gap.** The oracle bounds unit-INDEPENDENT ranking only. Since single-unit
   effects are not additive, a set-aware policy could exceed it — worth measuring once a signal exists
   that captures more of the unit-independent ceiling.
