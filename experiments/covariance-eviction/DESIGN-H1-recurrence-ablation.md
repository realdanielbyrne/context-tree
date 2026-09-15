# DESIGN — H1: is the shipped recurrence term the term that was tested?

> **Status:** designed; harness written; offline arm RUN. Live arm written and **gated**.
> **REVISION 2 — three claims in revision 1 were false and are withdrawn here.** They are
> listed in §10 rather than quietly deleted, because the record of what a measurement
> looked like when it was wrong is the part a later reader most needs.
> Code: `signals.mjs`, `ranks.mjs`, `transcript.mjs`, `offline-replay.mjs`,
> `replicate-assembler-weighting.mjs`, `ab-covariance.mjs`; 49 unit tests.
> Results: `reports/metrics/covariance-eviction/results-offline-v1.json`,
> `results-replicate-assembler-weighting.json`.

---

## 1. The question

`experiments/assembler-weighting/` swept a **pure recurrence** term and found it the
strongest single eviction signal: priority-only keep-needed recall 0.35 / 0.42 against
recency-only 0.25 / 0.24 at M=64, logistic mixing rate 4.12 against recency 2.42. That is
why `priority` carries the largest weight in the shipped D-EV scorer.

**What ships is not, on its face, what was tested.** `packages/core/src/assemble/flex.ts:268`:

```ts
priority: ((u.wrote ? 2 : 0) + coOccurrence(units, i)) * decay
```

1. **The 2:1 internal ratio is unreachable.** The sum is formed before normalization and
   before any weight; `eviction.ts:79` then min-max-normalizes the product and multiplies
   by `weights.priority`. Every coefficient in the codebase scales both halves together.
   The project's rule — no hardcoded constant without a defence or a sweep — is violated
   by a constant nobody can reach.
2. **The function differs.** The tested term (`assembler-weighting/lib.mjs:57,69`) is
   `prio = nBefore`, the count of **later turns that came to overlap this unit** — a
   *history-of-reuse count*. The shipped `coOccurrence` (`flex.ts:167`) counts **all
   co-resident units sharing a fingerprint** — a *degree in the buffer's co-reference
   graph*.
3. **The input differs.** The tested term ran on `assembler-weighting/lib.mjs:14`'s
   regexes; the shipped one on `lexical.ts`'s `extractFingerprints`.

**Question.** Does the recurrence result survive re-measurement of what actually ships,
and if it does, does its ratio against the edit boost matter?

---

## 2. Signals, exactly

Buffer units $u_0 \dots u_{N-1}$ in creation order, fingerprint sets $F_i$, write flags
$w_i \in \{0,1\}$, idle $\iota_i$ = turns since the unit's last reference.

$$R^{\text{und}}_i = |\{ j \neq i : F_i \cap F_j \neq \emptyset \}| \qquad
R^{\text{dir}}_i = |\{ j > i : F_i \cap F_j \neq \emptyset \}|$$

**The shipped term, with its decay and its normalization in the right order**
(`signals.mjs → shippedPriorityNormalized`; scorer `shipped-priority-true`):

$$P^{\text{ship}}_i = \widehat{\bigl[\,(2 w_i + R^{\text{und}}_i)\cdot 2^{-\iota_i/h}\,\bigr]},
\qquad \widehat{x}_i = \frac{x_i - \min_j x_j}{\max_j x_j - \min_j x_j},\; h = 4$$

**The ablatable split form** (`splitPriority`; scorer `split-priority-rho2`), which
normalizes each half *first* so the ratio becomes reachable:

$$P^{\rho}_i = \rho\,\widehat{w}_i + \widehat{R}_i$$

**These are different functions and it matters.** $\widehat{w}$ over a binary vector is
exactly $\{0,1\}$, so for any $\rho > 1$ the split form is **lexicographic in $(w, R)$**
and the induced ordering *cannot change with $\rho$*. Measured ordering identity against
$\rho = 2$: $\rho \in \{0, 0.1, 0.25\} \to 1.1\%$, $0.5 \to 1.7\%$, $0.75 \to 9.2\%$,
$0.9 \to 17.7\%$, $1 \to 46.9\%$, $\{2,4,8\} \to 100.0\%$. **The informative range is
$\rho \in [0,1]$**; $\rho > 1$ are the same arm.

---

## 3. Arms — a three-stage ladder, each stage a gate on the next

### S0 — REPLICATION, one variable (`replicate-assembler-weighting.mjs`)
Reproduce the published contrast on **its own two sessions, its own signals, its own
fingerprints, its own text extraction, its own micro-averaged metric, its own budget**,
varying **only** whether a "turn" is a JSONL parse-line or an API turn (measured
inflation 2.1–2.3×).

**Gate:** if the win does not survive the clock fix, it is partly a finding about JSONL
formatting and the D-EV priority weight should be flagged, not tuned.

### S1 — SATURATION (`offline-replay.mjs`)
Does the term vary across a realistic buffer? Measured on `extractFingerprints`
transcribed exactly from `lexical.ts`, and — separately — on the **product after decay
and normalization**, which is what the shipped code actually ranks by.

**Gate:** near-flat (≤ 2 distinct values) on **more than 50%** of turns.

### S2 — RATIO SWEEP (`offline-replay.mjs`)
$\rho \in \{0, 0.1, 0.25, 0.5, 0.75, 0.9, 1, 2\}$ × direction × label family, with
**paired $\rho$-vs-$\rho{=}2$ contrasts** (which revision 1 pre-registered and never
computed).

### S3 — LIVE CONFIRMATION (gated; `ab-covariance.mjs`)
`prio-shipped` ($\rho=2$) vs `prio-tuned` ($\rho^*$), against `truncate-tail` and
`random`, volume-matched through the same `evictToBudget`.

---

## 4. Endpoints

| | Metric | Why |
|---|---|---|
| **S0 primary** | **MICRO-averaged** keep-needed recall at M=64, moving-block CI | The estimand the published result uses. Micro and macro disagree — on *sign*, at every cell — so a replication must use the original's. |
| **S1** | per-turn distinct values, CV, share of near-flat turns, with Wilson intervals | A term that does not vary cannot be ablated. |
| **S2** | paired $\rho$-vs-$\rho{=}2$ recall at M=32, moving-block CI, plus ordering identity | The identity column says which comparisons are real. |
| **Secondary (offline)** | mean per-turn AUC; per-turn Spearman on the **policy ordering** | Spearman is the relabelling guard. |
| **Primary (live)** | held-out suite **pass fraction** (continuous), Welch's *t*, Holm-corrected | The binary endpoint has returned null four times and once discarded a real 0 → 7 improvement in files written. |

---

## 5. Pre-registered falsification

**H1 is REJECTED if any of:**

- **S0** the published contrast does not clear the original's own **+0.03** margin at
  M=64 under **both** clocks, on **both** sessions.
- **S1** the shipped term is near-flat on **more than 50%** of turns. *Inert, not
  mis-weighted.*
- **S2** no $\rho$ with ordering identity < 1 beats $\rho = 2$ by more than **+0.03** with
  the paired lower bound above 0.03. *The hardcoded ratio is then vindicated as a default
  and the constant stops being a defect.*

---

## 6. Validity conditions

1. **Clock audited** — inflation reported per session (1.95–2.30× measured).
2. **The cap binds** — `binding_share` emitted per budget; any $M \geq$ `MAX_CAND` is
   **refused**, not run (revision 1 would have printed `0 ci [0,0]` as a finding).
3. **Estimand declared** — micro vs macro stated on every number.
4. **Volume-matched, audited on BOTH axes** (live): achieved peaks *and* unit counts
   within 10%. `evictToBudget` packs to a **token** budget, so matched peaks do not imply
   matched unit counts.
5. **Control still attempts the task** (live): ≥ 50% of `random` cells write a file.
6. **Both label families reported**.

---

## 7. Power

Intervals are **moving-block bootstraps** (block 10 turns, resampled within session).
Measured lag-1 autocorrelation of the paired per-turn series is **+0.42 to +0.68**, so an
i.i.d. resample understates the width by 1.3–1.6×. Measured half-widths:

| contrast family | 95% half-width |
|---|---|
| recurrence-vs-recency, identifier label, macro | **±0.010 – ±0.011** |
| S0 micro contrast, per session at M=64 | ±0.013 – ±0.028 |
| recurrence-vs-recurrence | ±0.015 – ±0.024 |
| against `shipped-priority-true` | ±0.046 – ±0.060 |
| **non-monotonic subset** (2,511 rows) | **±0.059 – ±0.090** |

So the design **can** detect ~0.02 on the identifier-label contrast and on S0; **cannot**
resolve non-monotonic differences below ~0.12; and **cannot** separate $\rho$ values whose
orderings are identical — which §2 shows is four of the original eight sweep points.

**Live.** Pass fraction, per-run sd ≈ 0.3, Welch's *t* (not the normal approximation
revision 1 used — at df ≈ 22 that reported *p* = 0.038 where *t* gives 0.050), Holm across
five contrasts with `tcov` vs `truncate-tail` as the single primary:

| n per arm | detectable Δ (before Holm) |
|---|---|
| 12 | 0.34 |
| 20 | 0.27 |
| 40 | 0.19 |

**Cost.** Offline: **12 s** per configuration on CPU, the full grid ≈ 4 min, no GPU. Live:
7 arms × 1 window × 12 repeats = **84 cells ≈ 7.0 h** at ~5 min/cell, plus a 21-cell pilot
≈ **1.75 h**.

---

## 8. Results

### S0 — the recurrence win REPLICATES and SURVIVES the clock fix

`results-replicate-assembler-weighting.json`. Micro-averaged, the original's estimand.
The line-clock column reproduces the published numbers (s1 M=64: recency 0.245 / priority
0.417 against published 0.24 / 0.42; s2: 0.247 / 0.347 against 0.25 / 0.35).

| session | M | line clock (published) | API clock (corrected) | verdict |
|---|---|---|---|---|
| 1 | 32 | +0.083 [0.066, 0.102] | +0.091 [0.068, 0.122] | **survives** |
| 1 | 64 | +0.171 [0.146, 0.202] | +0.168 [0.140, 0.195] | **survives** |
| 2 | 32 | +0.049 [0.041, 0.059] | +0.034 [0.026, 0.046] | lost (lower bound 0.026 < 0.03) |
| 2 | 64 | +0.100 [0.087, 0.116] | +0.058 [0.046, 0.071] | **survives**, roughly halved |
| both | 8, 16 | +0.008 … +0.036 | +0.007 … +0.041 | never cleared +0.03 under either clock |

**S0 passes.** The premise of this hypothesis is intact: recurrence really does beat
recency on these transcripts, the effect is not an artefact of the inflated clock, and it
is concentrated at the larger budgets the original quoted. The clock fix *shrinks* it on
session 2 (roughly halving it) and leaves session 1 unchanged — worth carrying, not
disqualifying.

**A methodological finding that came out of doing this properly:** micro- and
macro-averaging **disagree on the sign of this contrast at every one of the 16 cells**.
Weighting each turn equally makes priority-only *lose* to recency-only; weighting each
needed unit equally makes it win. Turns with many needed units are exactly where a
recurrence signal does well. Neither average is wrong, but only one is the published
estimand, and no report in this repository had said which it was using.

### S1 — the term is NOT saturated; the gate does not fire

| term measured | n turns | distinct/turn | CV | fully flat | near-flat (≤2) |
|---|---|---|---|---|---|
| recurrence on file paths (full pool) | 1151 | 15.36 | 0.94 | 0.0% | 0.1% |
| recurrence on file paths (matched pool) | 60 | 8.53 | 0.86 | 0.0% | 1.7% |
| **recurrence on `extractFingerprints`** | 60 | 8.08 | 0.25 | **28.3%** [18.5, 40.8] | **30.0%** [19.9, 42.5] |
| **the shipped term after decay + normalization** | 1151 | **54.46** | **2.71** | **0.0%** | **0.0%** |

**S1 DID NOT FIRE: 30.0% against a 50% gate.** And the last row is the one that decides
the mechanism. The shipped scorer ranks by
$\widehat{(2w + R)\cdot\text{decay}}$, and *that* quantity takes ~54 distinct values per
turn and is never flat. Even on the ~28% of turns where $R$ itself is constant, the term
does not vanish — it becomes $c \cdot \text{decay}$, which for non-writing units is a live
ranking signal that would be **absent** if $R$ were zero. A saturated $R$ changes *what the
term ranks by*; it does not switch it off.

And the shipped term is a *strong* signal, not a weak one: mean per-turn AUC **0.814**
[0.791, 0.839] and recall@32 **0.729**, second only to `idle-only` (0.887) and far ahead of
the split form revision 1 mistook for it (0.536 / 0.287). Its Spearman against `idle-only`
is **0.835** — above the 0.8 relabelling threshold this project uses, which is a genuinely
new observation: **the shipped "priority" term is largely reference-recency in disguise**,
because the decay factor dominates the sum it multiplies.

### S2 — no $\rho$ beats $\rho = 2$; the falsification condition is MET

Paired $\rho$-vs-$\rho{=}2$ recall at M=32, moving-block intervals. Under the
file-reference label every interval contains zero (best: $\rho=0$, $+0.016$
[$-0.021$, $+0.054$]). Under the identifier-overlap label every $\rho < 1$ is **worse**
than $\rho = 2$, with intervals excluding zero ($\rho = 0$: $-0.014$ [$-0.019$, $-0.009$]
undirected, $-0.020$ [$-0.024$, $-0.016$] directed).

**S2's pre-registered falsification is met.** No $\rho$ clears the +0.03 margin anywhere.
On this evidence the hardcoded 2:1 ratio is **vindicated as a default** — it is still an
undefended constant in the sense that nothing derived it, but it is no longer an
unmeasured one, and the informative range around it has been swept.

---

## 9. Sensitivity that is not yet resolved

The turn-denominated parameters (`K=5, H=3, D_DORMANT=10, START=20`) are numerically the
original's, but its "turn" is 2.1–2.3× shorter than this file's. Copying the numerals
across does **not** preserve the original's intent — it halves every window. The
intent-preserving values are roughly `K=2, H=1, D=4, START=9`. The recurrence-vs-recency
contrast is sensitive to this choice and **changes sign across the plausible range**
(reported by the reviewer: −0.037 at `H=1,D=4,K=2`; −0.006 at the shipped default; +0.007
at `H=6,D=20,K=10`, excluding zero). The environment variables exist
(`CT_COV_K/H/D/START`); the sweep is **owed and not run**. Until it is, no statement of
the form "recurrence beats/loses to recency by X" from `offline-replay.mjs` should be
quoted without its parameter row — S0's like-for-like replication is the number to use.

---

## 10. Withdrawn from revision 1

Recorded rather than deleted, because each was a *motivated read* and the pattern is the
useful artefact.

1. **"S1 fires."** The pre-registered gate was ">50% near-flat"; the measurement was
   31.7%. Revision 1 opened its results section with "S1 fires", made it the actionable
   headline, and escalated it to a disposition claim about
   `DEFAULT_EVICTION_WEIGHTS.priority`. **A null was read as a win on the one finding it
   said was worth acting on.** Withdrawn entirely; §8 now states the gate and the verdict
   together so the two cannot drift apart again.
2. **"A flat $R$ is deleted by `minMaxNormalize`, so three turns in ten the shipped
   priority is exactly $2w\cdot\text{decay}$."** False. Normalization is applied to the
   *product*, not to $R$. Withdrawn; the true mechanism is in §8 and is now pinned by a
   unit test that fails if decay is dropped.
3. **"S0 does not replicate."** Drawn from a re-measurement that differed from the
   original in six ways at once (unit, candidate pool, fingerprint family, text source,
   corpus, budget) and was read at M=16 on a corpus 65% composed of a session the original
   never used. On the original's own corpus and budget the same contrast contains zero;
   under the original's own estimand it **replicates and survives the clock fix**.
   Withdrawn and replaced by the one-variable experiment §3/S0 names.

Two further corrections with no headline attached: the scorer called `shipped-priority`
was `splitPriority(ρ=2)` and is renamed `split-priority-rho2` (the real one is
`shipped-priority-true`), and the `__init__` story was attributed to
`extractFingerprints`, which matches neither `__init__` nor `parse_line` — it belongs to
`experiments/coding-harness/lib.mjs:82`.

---

## 11. Caveats

- **The identifier-overlap label is circular**: the recurrence signal is built from the
  same fingerprint-overlap relation the label is, on a different time window. That is the
  original's design, reproduced deliberately in S0 so the clock is the only variable — but
  it means S0 confirms *internal consistency*, not external validity.
- **S0 is a re-analysis of the same two transcripts**, not an independent replication.
- **The API clock concatenates** the lines it merges, so a merged unit has a larger
  fingerprint set. Intrinsic to the fix, not a removable confound.
- **Input fidelity**: the shipped path feeds `extractFingerprints` full `rawText` +
  `summaryText` including tool results; this replay feeds assistant text + 1200 chars of
  each `tool_use` input, capped at 400 fingerprints. Fewer inputs mean fewer
  co-occurrences, so the saturation figure is if anything conservative — but it is not the
  shipped input.
- **The S1 fingerprint row rests on 60 sampled turns** (Wilson intervals given).
- **Bash path extraction** is a regex over a command string and is the least trustworthy
  input; `Bash` is 875 of 1,528 tool calls here, so excluding it is not neutral either.
  `CT_COV_BASH=0` runs the sensitivity arm.
- **C0**: four sessions, one repository, one author; session-5 alone is 65% of the pooled
  decision turns, hence the per-session and original-corpus-only breakdowns.

---

## 12. Rerun

```bash
# the S0 disambiguator — the number to quote against the published result
node experiments/covariance-eviction/replicate-assembler-weighting.mjs

# S1 + S2
node experiments/covariance-eviction/offline-replay.mjs
CT_COV_BASH=0  CT_TAG=nobash  node experiments/covariance-eviction/offline-replay.mjs
CT_COV_BLOCK=1 CT_TAG=iid     node experiments/covariance-eviction/offline-replay.mjs   # scheme sensitivity
# the OWED parameter rescale (§9)
CT_COV_K=2 CT_COV_H=1 CT_COV_D=4 CT_COV_START=9 CT_TAG=rescaled \
  node experiments/covariance-eviction/offline-replay.mjs

node --test experiments/covariance-eviction/signals.test.mjs experiments/covariance-eviction/ranks.test.mjs

# live — GATED; see ab-covariance.mjs, and backlog item 0 for when
set -a; . ./.env; set +a
CT_COV_LIVE=1 CT_WINDOWS=7000 CT_REPEATS=12 CT_COV_RHO=0 \
  node experiments/covariance-eviction/ab-covariance.mjs
```
