# DESIGN — H2: temporal covariance as an eviction signal

> **Status:** designed; harness written; offline arm RUN — and its validity gate **fires**,
> so the offline contrasts are **not a result and not a null**. Live arm written and
> **gated**.
> **REVISION 2** after adversarial review. The single favourable cell revision 1 reported
> did not survive the corrected resampling scheme; see §9 and §10.
> Code: `signals.mjs`, `ranks.mjs`, `transcript.mjs`, `offline-replay.mjs`,
> `ab-covariance.mjs`; 49 unit tests.
> Results: `reports/metrics/covariance-eviction/results-offline-v1.json`
> (under the key `h2_UNINTERPRETABLE_INSUFFICIENT_SUPPORT`).

---

## 1. The question

Nothing in this repository computes whether two units tend to be **referenced together
across turns**. `policies.mjs` exposes recency, random, idle, blend, protect, oracle;
`eviction.ts` scores priority, recency, reference-recency, dormancy. Every one is a
**per-unit scalar**. Not one is **pairwise**.

The motivation is the record's own: relevance-to-recent was measured **worst** as an
eviction signal (D-EV4, weight 0) for exactly one reason — *it drops the dormant unit that
later returns*. Temporal covariance is the signal that **keeps** that unit: dormant now,
but historically co-active with whatever is hot now. It is the principled repair of the
signal that lost.

**Question.** Does pairwise co-reference history predict which dormant units return,
better than positional or reference recency, at matched volume?

---

## 2. The signal, exactly

### 2.1 Reference series

Keyed on **file paths**, not identifier fingerprints. $G_t$ is the set of paths touched on
turn $t$ — an append-only **reference log** holding paths, never content. Dilate by $L$
turns so files used in the same *episode* count as co-active:

$$G^{(L)}_t = \bigcup_{s=t-L+1}^{t} G_s$$

### 2.2 Disjoint history and hot windows

$$\mathcal{H} = \{ G^{(L)}_s : s < t-K \} \qquad \mathcal{Q} = \bigcup_{s=t-K}^{t-1} G_s$$

**Disjoint by construction.** $\phi$ is fitted only on history strictly older than the hot
window; without that separation the score would reward a unit for being *currently*
referenced, which is relevance-to-recent — the signal that lost. Asserted by a unit test.

### 2.3 The pairwise statistic

Over $\mathcal{H}$ ($n$ turns), for files $f, g$ with cell counts $a, b, c, d$:

$$\phi(f,g) = \frac{ad-bc}{\sqrt{n_f (n-n_f)\, n_g (n-n_g)}}, \qquad n_f = a+b,\; n_g = a+c$$

Phi, not a raw co-occurrence count, for one reason: **a file touched on every turn has
$n_f = n$, the denominator vanishes, and it scores exactly 0 against every partner.**
Promiscuity is neutralised in the denominator. `signals.test.mjs` asserts both halves —
the boilerplate file scores 0 while a selective pair scores > 0.5.

> ⚠️ **Provenance correction.** Revision 1 attributed the promiscuity problem to
> `extractFingerprints`. It does not apply there: `lexical.ts` has no snake_case rule and
> matches neither `__init__` nor `parse_line`. The recorded regression belongs to
> `experiments/coding-harness/lib.mjs:82`, whose `fp` admits any token with an underscore
> and length ≥ 5. The design decision (key on paths) is unchanged; the story behind it is
> corrected.

**Shrinkage** for low support: $\tilde\phi = \phi \cdot a/(a+m)$. $m$ is a placeholder.

### 2.4 Unit score

$$\mathrm{TCOV}(u) = \operatorname*{agg}_{f \in F_u,\; g \in \mathcal{Q}\setminus F_u} \tilde\phi(f,g)$$

$g \notin F_u$ — no credit for one's own file being hot (that is residency, which `idle`
measures). $F_u = \emptyset$ ⇒ `null`, filled with the **median** (`signals.mjs →
neutralize`, shared with the policy path so the offline arm scores the policy the live arm
would run — revision 1 had two different medians in two files).

### 2.5 The reference log outlives eviction

`makeRefLogger` keys on tool-call id and appends one entry per turn regardless of what is
resident. Computing covariance from the buffer would be a feedback loop: evicting a unit
deletes the history that would justify keeping it. Asserted by a test that evicts first.
The log holds **paths only** and never enters the model's context — which matters, because
three designs that *added* material to this agent's transcript each stopped it working.

### 2.6 The deployable shape is a rank blend

$$\mathrm{key}(u) = \alpha\,\mathrm{rank}_{\mathrm{TCOV}}(u) + (1-\alpha)\,\mathrm{rank}_{\mathrm{pos}}(u)$$

$\alpha = 0$ reproduces `rankRecency` **exactly** — the sweep's checkable floor, asserted
as an identity.

---

## 3. Arms

All capped arms go through the same `evictToBudget` with the same $W$, anchor and reserve,
differing **only** in `rank`.

| Arm | Rank | Role |
|---|---|---|
| `truncate-tail` | `rankRecency` | incumbent |
| `idle` | `rankIdle` | strongest measured single signal offline (AUC 0.887) |
| `tcov` | `makeRankTcovBlend(α*)` | the candidate |
| `random` | `rankRandom` | floor |
| `uncapped` | none | reference |

> ⚠️ `idle`'s 0.887 is not as impressive as it looks and the design should not lean on it:
> the label (`needed` = the unit's files are touched in the next $H$ turns) is the
> **forward continuation of the very series `idle` measures backward**. Much of that AUC is
> the label's construction, not a property of the signal.

---

## 4. Endpoints

| | Metric | Why |
|---|---|---|
| **Primary (offline)** | keep-needed recall on the **non-monotonic** subset at the **single pre-specified budget M=32**, turn-paired against both `recency-only` and `idle-only`, moving-block CI | The case H2 exists for. One budget, pre-specified — see §5 on why. |
| **Primary (offline), decisive** | **held-out cross-session ΔAUC** over {recency, idle, recurrence, edit} | Recall on a subset can move structurally; ΔAUC over the incumbent set is the honest "does it add anything", and cross-session training stops memorising one session's file graph. |
| **Secondary** | overall recall at M ∈ {16,32,64}; per-turn AUC; **policy-ordering** Spearman vs incumbents; the $\alpha$ sweep with paired intervals | |
| **Primary (live)** | held-out suite **pass fraction**, Welch's *t*, Holm-corrected | |

---

## 5. Pre-registered falsification

**H2 is REJECTED if either:**

- **(a)** TCOV does not beat **both** `recency-only` and `idle-only` on non-monotonic
  recall **at M=32**, with the paired 95% moving-block interval excluding 0 *and* clearing
  **+0.03**.
  > ⚠️ **M=32 is now pre-specified as the single primary budget.** Revision 1 rejected only
  > if TCOV failed at *any* of M ∈ {16, 32, 64} against *both* controls — six chances to
  > win with no multiplicity control — and then quoted the one favourable cell. Given the
  > measured non-monotonic half-width of ±0.06 to ±0.09, clearing +0.03 on the lower bound
  > requires a point estimate near **+0.12**; the margin is far below the design's
  > resolution and that is stated here rather than discovered afterwards. M ∈ {16, 64} are
  > secondary and Holm-corrected.
- **(b)** the held-out ΔAUC interval contains 0 on **every** held-out session.

**Also rejected as a relabelling** if the mean per-turn Spearman between the TCOV
**policy ordering** and `rankRecency`'s or `rankIdle`'s is ≥ 0.8 in absolute value.

---

## 6. Validity conditions

1. **SUPPORT GATE.** At least **55%** of candidate rows must have same-turn ($L=1$)
   co-activation support $a > 0$: threshold 0.50 (the *median* candidate has a non-empty
   contingency table) plus a 0.05 margin.
   > ⚠️ Two changes from revision 1, both because its 30% gate was unprincipled and its
   > 22.1% was a parameter artefact. **Derivation:** the threshold is now tied to the
   > median candidate rather than being a round number. **Un-gameable measurement:** it is
   > evaluated at $L=1$, because dilation manufactures co-activation mechanically —
   > measured support by $L$ is 7.7% / 18.2% / 22.1% / 29.2% for $L = 1/2/3/5$, so the
   > headline tripled purely from the dilation setting, and $L=5$ (a sweep point) would
   > have landed 0.8 pp short of the old gate. The margin refuses a point that only just
   > clears — the "gamed by parameters" case §11 warns about and nothing else prevented.
2. **The signal varies** and **is not a relabelling** (Spearman < 0.8 on the ordering).
3. **The cap binds**: `binding_share` emitted per budget; $M \geq$ `MAX_CAND` is refused.
4. **Volume-matched on BOTH axes** (live): achieved peaks *and* unit counts within 10%.
   `evictToBudget` packs to a **token** budget; matched peaks do **not** imply matched unit
   counts, and on a buffer where a signal's preferred units are larger they diverge.
5. **Control still attempts the task** (live); **room to move** (live).

---

## 7. Parameters — all swept, none defaulted

| Param | Sweep | Status |
|---|---|---|
| $K$ hot window | 3, 5, 10 | in **API turns** — see the warning below |
| $L$ dilation | 1, 2, 3, 5 | placeholder; also moves the support gate, hence the $L=1$ rule |
| $m$ shrinkage | 0, 1, 2, 5 | placeholder |
| agg | max, mean, top3 | max is optimistic by construction |
| $\alpha$ blend | 0 … 1 | $\alpha=0$ is the checked floor |
| MAX_CAND | 64, 200 | placeholder for live buffer depth |

> ⚠️ These are **not** "the same as `assembler-weighting`" even where the numerals match.
> Its "turn" is a JSONL parse-line; this file's is an API turn, and the measured inflation
> is 2.1–2.3×. Copying the numerals silently halves every window. Intent-preserving values
> are roughly `K=2, H=1, D=4, START=9`; the rescale sweep is **owed and not run**, and the
> H1 contrast is known to change sign across the plausible range.

---

## 8. Power

Moving-block bootstrap, block 10 turns, within session. Measured lag-1 autocorrelation of
the paired per-turn series: **+0.42 to +0.68** — which is why the scheme matters.

| contrast | 95% half-width |
|---|---|
| overall recall, tcov vs incumbent | ±0.056 – ±0.063 |
| **non-monotonic recall, tcov vs incumbent** | **±0.059 – ±0.090** |
| held-out ΔAUC | ±0.0005 – ±0.0023 |

So the design **can** detect a non-monotonic difference of ~**0.12** or larger; **cannot**
resolve below that (halving it needs ~4× the 2,511 non-monotonic rows, i.e. more
overflow-regime sessions); and **can** resolve ΔAUC to ~0.003, which makes ΔAUC the
discriminating endpoint — a null there is a real null, not a power failure.

**Live.** Pass fraction, per-run sd ≈ 0.3, Welch's *t*, Holm over five contrasts:
detectable Δ = 0.34 / 0.27 / 0.19 at n = 12 / 20 / 40 per arm — large effects only.

**Cost.** Offline: **12 s** per configuration, CPU only; the full $K\times L\times m\times$agg
grid ≈ 7 min. Live: 7 arms × 12 repeats = **84 cells ≈ 7.0 h**, plus a 21-cell pilot
≈ **1.75 h**.

---

## 9. Results — the gate fires, and the one favourable cell did not survive

**The support gate fires decisively.** Same-turn support **7.7%** against the 55% gate;
median support 0; 138,007 of 177,267 rows have support exactly zero. And the honest
activity figure is not the "scorable 98.5%" revision 1 led with — *scorable* only means
"had at least one eligible pair", which a score of exactly 0 satisfies. **The non-zero
share is 20.6%.** Four rows in five carry no signal at all.

So the contrasts below are **not a null about temporal covariance**; they are mostly $\phi$
fitted on empty tables. The results file now stamps this on the payload itself (the key is
`h2_UNINTERPRETABLE_INSUFFICIENT_SUPPORT` and every row carries `interpretable: false`) —
revision 1 wrote the flag into a sibling block, leaving `h2.contrasts[0]` readable as a
clean finding.

**With the corrected resampling, the single favourable cell is gone.**

| contrast | revision 1 (i.i.d.) | revision 2 (moving block) |
|---|---|---|
| nonmono@16 tcov − recency | +0.082 **[+0.032, +0.131]** excl. 0 | +0.082 **[−0.003, +0.144]** contains 0 |
| nonmono@32 tcov − idle | +0.075 **[+0.023, +0.129]** excl. 0 | +0.075 **[−0.003, +0.165]** contains 0 |
| nonmono@**32** (the pre-specified primary) vs recency | −0.057 | −0.057 [−0.150, +0.031] |
| nonmono@64 vs recency | −0.158 | −0.158 [−0.265, −0.078] excl. 0, **against** |

Only `nonmono@16 tcov − idle` still excludes zero (+0.205 [+0.138, +0.257]). **And the sign
flips across the budget set** — positive at M=16, negative at M=32 and M=64 against
recency. Revision 1 quoted the favourable end and did not mention the flip. At the
pre-specified primary budget the contrast is negative.

**The blend sweep is noise.** Every paired delta against $\alpha = 0$ contains zero:
$\alpha = 1$ gives +0.026 [−0.047, +0.082] on non-monotonic recall@32 while *costing*
0.684 → 0.588 on overall recall. Revision 1 reported these as differences of two rounded
point estimates with no interval and called +0.026 "shown cleanly"; it sits well inside its
own ±0.07 half-width.

**The decisive endpoint remains a clean null.** Held-out ΔAUC over the incumbent four:
+0.0005 [−0.0015, +0.0030], +0.0001 [−0.0004, +0.0008], −0.0004 [−0.0009, +0.0001] across
the three held-out sessions — at a resolution of ±0.002. On this corpus, at this support
level, TCOV adds nothing on top of the incumbents.

**What does survive: it is genuinely a different signal.** Mean per-turn Spearman on the
**policy ordering** is **−0.534** against recency and **−0.295** against idle — far from
the 0.8 threshold, and *negative*, i.e. it orders the buffer close to opposite to recency.
(Revision 1 reported +0.215, computed on the score vector, which silently dropped the
175/1151 turns where TCOV is flat — exactly the turns where the rank function falls back to
the recency tie-break and the correlation is +1. Excluding them biased the number toward
zero.)

---

## 10. Is this worth testing? — revised judgement

**The honest position is weaker than revision 1's.**

- **H2 has not been tested.** The gate fires; the contrasts are uninterpretable; the one
  cell that looked supportive did not survive the resampling correction and sits at a
  budget that is no longer the pre-specified primary. Nothing here is evidence for the
  hypothesis, and — because the gate fires — nothing is evidence against it either.
- **What *is* established** is narrow and methodological: the signal is computable, it
  degrades safely to the incumbent, it is not a relabelling of recency or idle, and the
  harness that would test it has a gate that correctly refuses to report a result.
- **The binding constraint is the corpus, not the design.** Same-turn support of 7.7% on
  transcripts averaging ~1 file reference per turn cannot support a pairwise statistic.
  Three routes, in cost order: (i) `longbuild` traces — ~50 turns over ~20 spec files with
  dense repeated reads, and the substrate the live arm uses anyway; (ii) regenerate the
  overflow corpus from `~/.claude/projects`; (iii) raise $L$ / lower $m$ — but that buys
  support by weakening the statistic and is a sensitivity check, not a fix.
- **The live arm is not worth running.** Backlog item 0 is *void*, five live runs varying
  which context is kept have returned null or void, and the live design detects only
  Δ ≈ 0.34 in pass fraction at n=12. Running a 7-hour sweep to test a signal whose offline
  arm could not be evaluated would buy a sixth uninterpretable null. The gate in
  `ab-covariance.mjs` enforces this.

**Recommendation:** do not run any H2 arm until a corpus with adequate same-turn support
exists. That is ~1 hour of CPU to build from `longbuild` traces, and it is the only step
that changes what any of this can conclude.

---

## 11. Caveats

- **The support gate can still be gamed by parameters** — raising $L$ or lowering $m$
  increases measured support without adding information. Evaluating the gate at $L=1$
  closes the main route; support must always be reported next to the parameters, and a
  point that only just clears is treated as failing.
- **`max` over pairs is optimistic** by construction; hence shrinkage and the `mean`/`top3`
  sweep.
- **The label is observational**: a unit can be *used* without being re-named. All signals
  are biased the same way, which protects contrasts but not absolute numbers.
- **Recall here is MACRO-averaged** (mean of per-turn recall). `assembler-weighting`
  micro-averages, and the two disagree on *sign* on this corpus. Numbers here are not
  comparable with that report.
- **Off-policy**: fixtures from a frontier Claude model with a different toolset; the live
  arm would be a local 27B on a different task.
- **Bash path extraction** is a regex over a command string; `Bash` is 875 of 1,528 tool
  calls here, so excluding it is not neutral either.
- **C0**: four sessions, one repository, one author; session-5 is 65% of the pooled turns.
- **TCOV degrades to positional recency** when the log is empty or unsupported, so a null
  is weaker evidence against the signal than a win would be for it.

---

## 12. Rerun

```bash
node experiments/covariance-eviction/offline-replay.mjs
for L in 1 2 3 5;    do CT_COV_L=$L   CT_TAG=L$L    node experiments/covariance-eviction/offline-replay.mjs; done
for M in 0 1 2 5;    do CT_COV_M=$M   CT_TAG=m$M    node experiments/covariance-eviction/offline-replay.mjs; done
for A in max mean top3; do CT_COV_AGG=$A CT_TAG=agg-$A node experiments/covariance-eviction/offline-replay.mjs; done
CT_COV_BLOCK=1 CT_TAG=iid node experiments/covariance-eviction/offline-replay.mjs   # resampling sensitivity

node experiments/covariance-eviction/transcript.mjs                 # clock + reference density
node --test experiments/covariance-eviction/signals.test.mjs experiments/covariance-eviction/ranks.test.mjs

# live — GATED, and per §10 it should stay gated
set -a; . ./.env; set +a
CT_COV_LIVE=1 CT_WINDOWS=7000 CT_REPEATS=12 CT_COV_ALPHA=1 \
  node experiments/covariance-eviction/ab-covariance.mjs
```
