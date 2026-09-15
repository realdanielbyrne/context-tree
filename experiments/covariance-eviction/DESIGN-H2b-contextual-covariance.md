# DESIGN — H2b: contextual covariance (unit against the current turn)

> **Status:** designed, implemented, **run**. Both dense feature spaces pass their gates;
> the file-keyed floor fails, replicating H2.
> Code: `contextual-covariance.mjs`, `signals.mjs → contextualCovariance`,
> `transcript.mjs → lexicalTokens`; 9 tests in `contextual.test.mjs` (58 in the directory).
> Results: `reports/metrics/covariance-eviction/results-contextual-covariance-v1.json`.
> Report: `reports/metrics/covariance-eviction/report-contextual-covariance.{md,html}`.

---

## 1. The question, and what was wrong with the last one

H2 keyed covariance on **file paths**, found that 80% of turns name exactly one file, and
concluded that a pairwise co-reference statistic is starved on agent transcripts. The first
half is a real finding. The second half over-generalised from one keying to covariance as
such. Measured on the same four transcripts:

| keying | features per turn | turns able to form a same-turn pair |
|---|---|---|
| file paths (what H2 tested) | 1.02 | 14.3% |
| fingerprints (`extractFingerprints`) | 9.97 | 94.1% |
| lexical content tokens | 53.44 | 98.8% |

`files` is starved; the others are not. **What H2 established is that FILE-KEYED pairwise
signals are undeployable on agent transcripts** — cheap, real, and it retires that family.
It establishes nothing about covariance on a dense keying.

**H2b also changes the relation, not just the keying.** H2 scored unit against unit. H2b
scores every resident unit against the **current turn** — structurally what attention does,
and the form in which the signal could serve either eviction (what to drop) or admission
(what to pull back).

**Question.** Does a unit's *historical co-activation* with what the agent is doing right
now predict that the unit is about to be needed — and is that different from the unit
merely *resembling* what the agent is doing right now?

---

## 2. The signal, exactly

Let $G_t$ be the feature set of turn $t$ under the space being tested, dilated by $L$ turns
into episodes $G^{(L)}_t = \bigcup_{s=t-L+1}^{t} G_s$. At decision turn $t$ with hot window
$K$:

$$\mathcal{H} = \{ G^{(L)}_s : s < t-K \} \qquad
\mathcal{Q} = \bigcup_{s=t-K}^{t-1} G_s$$

History and hot window are **disjoint by construction**. Over $\mathcal{H}$ the pairwise
statistic is the phi coefficient with low-support shrinkage, exactly as in H2:

$$\tilde\phi(f,g) = \frac{ad-bc}{\sqrt{n_f(n-n_f)\,n_g(n-n_g)}}\cdot\frac{a}{a+m}$$

Phi rather than a co-occurrence count because a feature active on *every* turn has a
degenerate margin and scores 0 against everything — the guard against the failure mode this
project has already shipped once.

**The score, for unit $u$ with feature set $F$:**

$$\mathrm{TCOV}(u) \;=\; \operatorname*{agg}_{f \in F\setminus\mathcal{Q},\;\; g \in \mathcal{Q}\setminus F} \tilde\phi(f,g)$$

### 2.1 The exclusion is the experiment

$F \setminus \mathcal{Q}$ and $\mathcal{Q} \setminus F$ — features the unit **shares** with
the hot window are removed from *both* sides. A unit can therefore score only through the
historical association of features it has and the window does not, with features the window
has and it does not. **Present overlap contributes nothing, by construction.**

That is not a nicety. Present overlap *is* relevance-to-recent, which D-EV4 measured as the
**worst** eviction signal available and weights **zero**, for the specific reason that a
dormant unit does not resemble the recent window. If the exclusion were absent, H2b would be
at serious risk of re-running the signal that already lost. `tcov-inclusive` keeps the shared
features and is reported as the sensitivity arm: **if only the inclusive form works, the
working part is relevance.**

---

## 3. Arms

| Arm | Definition | Role |
|---|---|---|
| `tcov` | the score above, shared features excluded | the candidate |
| `tcov-inclusive` | the same with no exclusion | sensitivity: does relevance leak in and help? |
| **`relevance`** | $\mathrm{Jaccard}(F, \mathcal{Q})$ — **no history at all** | **the decisive control** |
| `recency-only` | positional age | incumbent |
| `idle-only` | turns since the unit's files were touched | incumbent |
| `random` | seeded uniform | floor |

Feature spaces swept as the one variable: `files` (the H2 baseline, kept as the expected
floor), `fp` (the exact shipped `extractFingerprints`), `lex` (stopworded content tokens).

---

## 4. Endpoints

| | Metric |
|---|---|
| **Primary** | keep-needed recall on the **non-monotonic subset** at the **single pre-specified budget M=32**, `tcov` − `relevance`, turn-paired, moving-block CI |
| Secondary | the same at M ∈ {16, 64}; `tcov` vs `recency`, `idle`, `random`; overall recall; per-turn AUC; `tcov-inclusive` − `tcov` |
| Relabelling | mean per-turn Spearman between the **policy orderings**, over all turns |

**The endpoint is an EVICTION endpoint.** The same scores read in reverse give an admission
ranking — which is where D-EV4 said relevance belongs — but admission is not measured and no
claim about it follows from these numbers.

**The label is deliberately FILE-based** (the agent issued a tool call naming one of the
unit's files within $H$ turns) while the features sweep to lexical tokens. That is the least
circular pairing available: in the `lex` arm the signal and the label share no vocabulary at
all. The `fp` arm is the most circular of the three, since its features include paths.

---

## 5. Pre-registered falsification

**H2b is REJECTED if either:**

- **(a)** in **every** feature space passing both gates, `tcov` fails to beat `relevance` on
  non-monotonic recall at **M=32** with the paired 95% moving-block interval excluding 0; or
- **(b)** $|\mathrm{Spearman}(\text{tcov}, \text{relevance})| \geq 0.80$ on the policy
  ordering — in which case it is the signal D-EV4 already measured as worst, renamed.

> ⚠️ **A hole in this pre-registration, stated now rather than after the fact.** Condition
> (a) names only the relabelling control. It does **not** require `tcov` to beat the
> **random floor**, and a signal can beat `relevance` merely because relevance is *worse than
> random* on this subset. The floor contrast is computed and reported, and §8 reads the
> result against both. Any future version of this design should make "beats random" co-primary.

---

## 6. Validity gates — both must pass, and they guard opposite failures

1. **SUPPORT ≥ 55%** of candidate rows must have same-turn ($L=1$) co-activation support.
   Evaluated at $L=1$ so dilation cannot inflate it. Guards **starvation** — phi fitted on
   empty tables, the failure that stopped H2.
2. **FLATNESS ≤ 50%** of turns may have a score taking ≤ 2 distinct values. Guards
   **saturation** — the opposite failure, where dense promiscuous features make everything
   co-occur with everything and the arm is inert. Reported alongside: the phi distribution,
   the share of $|\phi| \geq 0.3$, and the share of candidates pinned at the per-turn ceiling.
3. **The cap binds** — `binding_share` per budget; any $M \geq$ `MAX_CAND` is refused.
4. **Not a relabelling** — §5(b).

A feature space can pass the support gate purely because its features are promiscuous. Gate 2
is what distinguishes that from a real signal, which is why both must pass and why the phi
distribution is printed rather than summarised.

---

## 7. Parameters

| Param | Value | Status |
|---|---|---|
| $K$ hot window | 5 API turns | inherited; **owed a rescale** (see caveat) |
| $L$ dilation | 3 | placeholder, sweepable |
| $m$ shrinkage | 2 | placeholder |
| agg | max | sweepable; `mean`/`top3` available |
| $H$ label horizon | 3 | inherited |
| $D$ dormancy | 10 | inherited; **sensitivity run at 25 and 50** |
| `DF_MAX` | 0.5 | drops features on >50% of turns; phi already scores them ~0 |
| `FEAT_CAP` | 24 | rarest-first by document frequency; never binds for `files` |
| block length | 10 turns | from the measured lag-1 autocorrelation |

`DF_MAX` and `FEAT_CAP` exist for tractability and are stated rather than hidden. Dropping a
near-universal feature is close to lossless *because* phi scores it zero — but it is not free,
and the lexical arm keeps 20.15 of 53.44 raw features per turn as a result.

---

## 8. Power

Moving-block bootstrap, block 10, resampled within transcript; Holm across the contrast
family with one pre-specified primary. Observed half-widths on the non-monotonic contrasts
are ±0.02 to ±0.07, so the design can detect a non-monotonic difference of roughly **0.05**
and cannot resolve below ~0.03. The overall-recall contrasts are tighter (±0.02–0.04). The
decision-turn count is unchanged from H2 (1,151 decisions, ~177k candidate rows), so the
resolution is the same; what changed is that the signal is now defined on 84–86% of rows
instead of 7.7%.

**Cost.** `files` ~15 s, `fp` ~3 min, `lex` ~6 min on CPU. No GPU, no model calls.

---

## 9. Caveats this design must carry

- **The turn-denominated parameters are inherited from an experiment measured on a 2.2×
  inflated clock** and have never been rescaled. $D=10$ in particular defines the
  non-monotonic subset, and §8 of the report shows that subset behaving oddly (positional
  recency is its best keeper), which is consistent with it not isolating deep dormancy. The
  sensitivity runs at $D \in \{25, 50\}$ are reported; the full rescale is still owed.
- **The `fp` arm is partly circular** — its features include file paths and the label is a
  file reference. `lex` is the clean arm; where they disagree, prefer `lex`.
- **A feature space can pass the support gate through promiscuity.** Both gates and the phi
  distribution are reported so a reader can check that it did not.
- **C0**: four transcripts, one repository, one author; the largest supplies most decisions.
- **This is an eviction endpoint.** The admission reading is available from the same scores
  and is untested.

---

## 10. Rerun

```bash
node experiments/covariance-eviction/contextual-covariance.mjs
CT_H2B_SPACES=fp CT_H2B_D=25 CT_TAG=D25 node experiments/covariance-eviction/contextual-covariance.mjs
CT_H2B_AGG=mean CT_TAG=mean  node experiments/covariance-eviction/contextual-covariance.mjs
CT_H2B_L=1       CT_TAG=L1    node experiments/covariance-eviction/contextual-covariance.mjs
node --test experiments/covariance-eviction/contextual.test.mjs
node experiments/covariance-eviction/report-contextual-covariance.mjs
```
