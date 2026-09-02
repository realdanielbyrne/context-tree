# Experiment 3-C — attributing the run-level token gap between `tree` and `tree-wide`

DS-STAR dimension 1 (visible branch count), iteration 3. Scope: decompose the
run-level token gap between the two width arms at W=32,768, bucket by bucket,
so a third pass does not repeat iteration 1's and iteration 2's mistakes —
iteration 1 attributed the gap to Zone B width alone (~465 tokens/summary,
~4,185 tokens/turn); iteration 2 measured Zone B's rendered size is nearly
identical between arms (7,633 vs 7,569 tokens) and rejected iteration 1's
figure, but then asserted the arms cost the same, which iteration 2's own
judge rejected in turn because the run-level gap (median 12,168 input tokens,
n=38/arm) was never decomposed. This pass decomposes it.

**Zero model calls.** Every number below is read from two already-generated
result files and combined with exact arithmetic (Node, `gpt-tokenizer`-free —
the files already carry per-turn token counts from the provider). No `tree.db`
query was made, so the fixture's mutable-L1 freeze problem (1,546 accumulated
root-summary versions, noted in the constraints for this pass) does not apply
here: nothing in this report depends on which root-summary version is
currently latest in the frozen store. What is read is static: pre-recorded
`usage`/`turns` data written when the rows were originally run.

## 0. Data read

- `eval/fixtures/transplant/s1/e1b289c32f40/results/run-W32768-truncate-tail+compact-rolling+tree-qwen_qwen-2.5-72b-instruct.json`
  — `arm: "tree"` rows only (60 of 180).
- `eval/fixtures/transplant/s1/e1b289c32f40/results/run-W32768-tree-wide-qwen_qwen-2.5-72b-instruct.json`
  — `arm: "tree-wide"` rows (all 60).
- Confirmed read-only: sha256 of both files unchanged after this pass's script
  ran; `git status` shows no new diff under `results/`.

**Row filtering.** Per this pass's instructions and both plan files read
first, `status: "model_call_error"` and `status: "turn_cap"` rows are
harness-stopped and excluded — they are not evidence about token cost, only
about the provider or the (now-removed) turn ceiling. Provider errors take a
large share of both cells, confirmed directly:

| Arm | completed | model_call_error | turn_cap | total attempted |
|---|---:|---:|---:|---:|
| `tree` | 38 | 20 | 2 | 60 |
| `tree-wide` | 38 | 15 | 7 | 60 |

Both cells land at exactly 38/60 (63%) completed. n=38 per arm is the ceiling
this fixture can offer at W=32,768 without new runs — matches the n cited in
`ITERATION-2-VERDICT.md` §4 (median 12,168 input tokens, n=38/arm) exactly.

**Caching regime, verified directly:** `usage.cacheRead` and `usage.cacheWrite`
are `0` on every one of the 76 completed rows, at both the per-row and
per-turn level (checked field-by-field, not sampled). This harness
(OpenRouter → qwen-2.5-72b-instruct) gets no provider-side prompt-cache credit,
so every token in Zone A/B/C and every appended tool result is re-billed as
fresh input on every turn. That is what makes an exact token decomposition
possible here at all — the identity below would not hold under a caching
provider, where a stable prefix is billed at a different (cheaper) rate than a
rewritten one. This decomposition is scoped to the no-cache regime; it says
nothing about what width costs under the live Anthropic suite's caching, which
`reports/algorithm.md`'s dimension-4 section already treats as a separate,
unmeasured coupling.

## 1. The exact per-row identity

Each row carries a `turns[]` array with, per turn, `input` (that turn's full
prompt size — the whole conversation so far, since nothing is cached) and
`output`. Because `cacheRead`/`cacheWrite` are 0, `usage.input` for a row is
exactly `Σ turns[i].input`, verified on every row (not assumed).

Let `T` = turn count, `B1` = `turns[0].input` (the turn-1 prompt: Zone A + the
assembled Zone B/C for this store/window/arm + the user's question — no
retrieval has happened yet at turn 1). For `k = 0..T-2`, define the turn-to-turn
growth `δ_k = turns[k+1].input − turns[k].input`, and split it into the part
attributable to the assistant's own prior turn being echoed back
(`out_k = turns[k].output`) and a remainder attributed to appended tool-call
output (`context_search`/`context_fetch`/`context_peek` results, which land in
the conversation after Zone C and are the only other thing that grows the
prompt turn to turn on a frozen store): `retrieval_k = δ_k − out_k`.

Telescoping `Σ_{t=0}^{T-1} turns[t].input` gives an exact identity with no
approximation and no free parameter:

```
Σ turns[t].input  =  B1·T  +  Σ_{k=0}^{T-2} out_k·(T−1−k)  +  Σ_{k=0}^{T-2} retrieval_k·(T−1−k)
                     \_____/     \_____________________/       \_______________________________/
                     bucket 1         bucket "echo"                    bucket "retrieval"
```

The `(T−1−k)` weight is not a modeling choice — it is a fact about a
no-caching conversation: whatever is added to the prompt at turn `k+1` is
re-sent, and re-billed, in every later turn's prompt too, so content added
early in a run is repeated more times than content added late. This is
already visible in the raw data (turn 1 of the sample `tree` row above costs
9,072 input tokens; turn 4 of the same row costs 14,272 — the growth from
turns 1–3 is carried into every later turn).

Adding total output (`Σ out_t` for all `T` turns, generated once each,
regardless of whether later echoed) gives total run tokens:

```
run_total  =  B1·T  +  echo  +  retrieval  +  output
```

**Verified on every one of the 76 completed rows**: `B1·T + echo + retrieval`
reproduces `usage.input` exactly — max absolute residual across all 76 rows is
**0**. This is arithmetic, not a fit; it is the correct decomposition to sum
bucket-by-bucket, which is what the task requires.

## 2. Point-estimate decomposition (means — the only way this sums exactly)

Means, not medians, are used for the bucket table, and this is not a stylistic
choice: mean is linear, so `mean(bucket)` summed across buckets equals
`mean(run_total)` exactly, which is what "sums to the measured run-level
difference, bucket by bucket" requires. Medians are not linear — §4 below
shows concretely that summing median-bucket-gaps recovers less than 20% of the
actual median run-level gap, so a median-based bucket table would not sum and
would misstate the attribution on its face. The metrics convention this pass
otherwise follows (median for tokens) is kept for headline run-level numbers;
it cannot be kept for an additive decomposition of those numbers, and that
tension is itself part of the finding (§4).

n=38 completed rows per arm.

| Bucket | `tree` mean | `tree-wide` mean | gap (`tree-wide` − `tree`) | % of gap |
|---|---:|---:|---:|---:|
| 1. Turn-1 assembled prompt, **size effect only** (Zone A+B+C+question, holding turn count at the pooled average) | — | — | **+1,073.4** | 20.3% |
| 4. Turn count, **count effect only** (holding turn-1 prompt size at the pooled average) | mean T=3.00 | mean T=3.24 | **+2,188.9** | 41.5% |
| — interaction (turn-1 size × turn count, the part not separable into either effect alone) | — | — | +4.3 | 0.1% |
| 2. Growth per turn — echoed prior output re-billed as input | 421.4 | 537.0 | **+115.6** | 2.2% |
| 3. Appended retrieval payload — `context_search`/`fetch`/`peek` results re-billed as input on every later turn | 13,228.9 | 14,967.3 | **+1,738.4** | 33.0% |
| 5. Output — generation cost, once per turn | 372.4 | 526.9 | **+154.4** | 2.9% |
| **Total (`B1·T` + echo + retrieval + output)** | 41,231.4 | 46,506.4 | **+5,275.0** | **100%** |

(Bucket 1 + bucket 4 + interaction = 1,073.4 + 2,188.9 + 4.3 = 3,266.6, which
is exactly the raw `B1·T` bucket gap before the turn-1-size/turn-count split;
the split itself is the standard exact two-factor decomposition
`ΔB1·T = ΔB1·(T̄) + ΔT·(B1̄) `, evaluated at each arm's pooled average so it has
no order-dependence, plus the small residual covariance term shown separately
rather than folded silently into either effect.)

Cross-checks against numbers already on record: mean `usage.input`
(`B1·T`+echo+retrieval) is 40,858.9 (`tree`) vs 45,979.6 (`tree-wide`), and the
**median** of the same field is 37,513 vs 49,681 — the exact 12,168-token
median gap `ITERATION-2-VERDICT.md` §4 already cites. `searched`/`fetched`
rates reproduce too: `tree` searches 31/38, fetches 21/38; `tree-wide`
searches 33/38, fetches 26/38 — matching §4's "26 of 38 rows against 21 of
38" and "33 against 31" exactly.

**Reading the point estimate:** the single largest bucket is turn count
(41.5%), not branch-summary content. Appended retrieval payload is second
(33.0%). The turn-1 prompt's own size — the thing "width" most directly
means, i.e. a bigger Zone B rendered once — is fifth largest and one-fifth of
the total (20.3%). Echoed conversation and output length are both small
(2–3% each). If this point estimate is taken at face value, width's *direct*
cost (a bigger Zone B, paid once per turn, `T` times) is real but is not what
dominates the gap; what dominates is that the wide arm runs more turns on
average (3.24 vs 3.00) and, independently, appends more retrieval payload once
it is in a turn — i.e., wider Zone B correlates with the model reaching for
`context_fetch` slightly more (matching the fetch-rate numbers above), and
each such fetch, once made, is re-billed on every subsequent turn under this
harness's no-caching regime.

## 3. Whether this point estimate can be trusted at n=38

It cannot, and this is not a stylistic caveat — a direct significance check
kills every bucket except one.

**Turn-level variance is enormous relative to any of these gaps.** Turn count
alone ranges 1–6 across both arms (`tree`: six 1-turn rows, two 6-turn rows;
`tree-wide`: two 1-turn rows, two 6-turn rows), and because of the `(T−1−k)`
compounding in §1, a row's total token cost swings from ~9,000 to ~117,000
tokens depending almost entirely on how many turns that *particular question*
took — not on which arm ran it. Standard deviation of run-level total tokens
is **21,269 (`tree`) and 20,497 (`tree-wide`)** — roughly 4× the 5,275-token
point-estimate gap itself.

Welch's t and a 10,000-resample bootstrap 95% CI (resampling rows within each
arm, tree-wide mean minus tree mean) on each bucket:

| Bucket | point estimate | Welch t | bootstrap 95% CI |
|---|---:|---:|---|
| Total (`run_total`) | +5,275.0 | 1.10 | **[−3,978, +14,886]** — crosses zero |
| `B1·T` (turn-1 × turn count, combined) | +3,266.6 | 1.20 | **[−2,062, +8,446]** — crosses zero |
| Appended retrieval payload | +1,738.4 | 0.61 | **[−3,792, +7,394]** — crosses zero |
| Echoed conversation | +115.6 | 0.87 | [−141, +378] — crosses zero |
| Output | +154.4 | **2.46** | **[+36, +278]** — excludes zero |
| Turn count alone (turns) | +0.24 | 0.81 | — |

Every bucket that looks large in §2 — turn count, retrieval payload, and their
combination with turn-1 prompt size — has a confidence interval that comfortably
contains zero. The **only** bucket whose interval excludes zero is the
smallest one by token weight: **output**, i.e. the wide arm's answers run
about 154 tokens longer on average, a real but marginal effect (2.9% of the
point-estimate gap) that says nothing about the branch-count question this
dimension is about.

A **paired check** (matching rows by identical `question`+`rep` where *both*
arms completed, n=24 of the possible 38+38) does not rescue this: pairing
removes only some of the question-level variance, and the paired total's
standard deviation (28,573) is *larger* than either arm's unpaired SD, giving
`t=0.77` on the paired total gap — still not significant. Paired `output`
remains the one bucket that holds up (`t=2.25`).

**Required n.** Using the pooled SD (20,887) and the observed point-estimate
gap (5,275 tokens) in a standard two-sample power calculation (α=0.05,
80% power, two-sided): **n ≈ 246 completed rows per arm** — about **6.5×**
the 38 this fixture currently has. At this fixture's observed 63% completion
rate, reaching 246 completed rows would need roughly 390 attempted runs per
arm (≈780 total), against the 120 attempted (60/arm) that produced today's
data.

## 4. Why the median-based headline number cannot be attributed either

The run-level gap most often quoted in this program is the **median**
`usage.input` gap, 12,168 tokens (`ITERATION-2-VERDICT.md` §4) — more than
double the mean-based total gap this pass computed (5,275). This is not a
contradiction; it is the signature of two distributions with different skew.
`tree`'s totals are right-skewed (its mean, 41,231, sits above its median,
37,889 — a handful of long, expensive `tree` rows pull the mean up). `tree-wide`'s
totals are left-skewed (its mean, 46,506, sits *below* its median, 50,115 — a
handful of short, cheap `tree-wide` rows pull the mean down; the maximum
single row is a 116,832-token outlier). Because median is not linear, medians
of the four buckets do **not** sum to the median of the total:

| Bucket | median gap |
|---|---:|
| `B1·T` | +1,063.5 |
| Echoed conversation | +124.0 |
| Retrieval payload | +1,145.5 |
| Output | +92.0 |
| **Sum of median-bucket-gaps** | **2,425.0** |
| **Actual median `run_total` gap** | **12,225.5** |

The sum of median-bucket-gaps recovers less than a fifth of the actual median
gap. A median-based bucket table would not sum to the number it claims to
decompose — exactly the kind of unsupported arithmetic this pass exists to
avoid. There is no version of "attribute the median run-level gap bucket by
bucket" that is both exact and median-based; exactness requires the mean-based
table in §2, and §3 already shows that table's confidence intervals swallow
every bucket but one.

## 5. Verdict

**Cannot attribute the run-level token gap at n=38, honestly.** The exact
arithmetic decomposition in §2 is real and sums correctly — that identity
holds by construction and is not in question — but as a *causal* attribution
of why `tree-wide` costs more than `tree`, it is statistical noise dressed as
precision: none of the buckets that plausibly relate to branch-summary width
(turn-1 prompt size, turn count, appended retrieval payload — 98% of the
point-estimate gap between them) survive a bootstrap check at this n. The one
bucket that does survive (output length, 2.9% of the point estimate) is not a
width effect in any mechanism this algorithm implements.

This is the third time this dimension's cost question has been asked, and the
honest answer this time is different in kind from the first two: iteration 1
overstated a mechanism (Zone B rewrite cost) that iteration 2 showed doesn't
apply; iteration 2 then overstated an absence of cost that iteration 2's own
judge rejected because the run-level gap was real and undecomposed. This pass
decomposes it exactly and finds the decomposition cannot be trusted at the
n available — which is a different, narrower failure than either prior claim,
and is the one this dataset actually supports.

**What would resolve it:** roughly 246 completed rows per arm (≈6.5× today's
38), reached by running more reps of the existing 12 questions at W=32,768
under both arms — no new scenario or mechanism needed, purely more replicates
of what already exists. Until that exists, the width question (`reports/algorithm.md`'s
open dimension 1) remains blocked on two independent grounds, not one: exp-01's
finding that width's *benefit* is a floor effect confined to 4 successes in
120 searched rows (already blocking a live width experiment per
`ITERATION-2-VERDICT.md` §5), and now this pass's finding that width's *cost*
cannot be distinguished from run-to-run turn-count noise at the n this fixture
offers. Rule 4 asks for the sweet spot on measured tokens, turns and score —
at n=38 the tokens side of that measurement is not yet a measurement.

## Tests

No shipped code was touched — this pass reads two already-committed result
files and combines already-recorded per-turn `usage` fields with exact
arithmetic; there is no `packages/core` or `eval/src` change to test. The
correctness gate for this pass's own arithmetic is the identity check in §1
(residual 0 across all 76 completed rows, not sampled), which is a stronger
guarantee for this kind of offline computation than a unit test would add.
No test suite was run because none applies; this is stated rather than
silently skipped, per the instruction to never report green while something
is skipped without saying so — nothing was skipped here because nothing
required running.

## Sources

- `eval/fixtures/transplant/s1/e1b289c32f40/results/run-W32768-truncate-tail+compact-rolling+tree-qwen_qwen-2.5-72b-instruct.json`
  — `tree` arm rows.
- `eval/fixtures/transplant/s1/e1b289c32f40/results/run-W32768-tree-wide-qwen_qwen-2.5-72b-instruct.json`
  — `tree-wide` arm rows.
- `eval/plans/tuning/01-branch-count.md` §3 — the marginal-cost figure this
  pass supersedes, and the searched/fetched rates this pass's row filter
  reproduces exactly.
- `eval/plans/tuning/exp-01-branch-count.md` — the ladder-curve reproduction
  and the demand-driven refutation this pass's cost finding sits alongside
  (both now block the width question, on separate grounds).
- `eval/plans/tuning/ITERATION-2-VERDICT.md` §1 and §4.8 — the judge's
  rejection of both prior width-cost claims and the un-decomposed
  12,168/5,456-token gaps this pass decomposes.
- `reports/algorithm.md` — the four rules (this report's method follows rule
  4: measurement against tokens/turns/score, not a chosen bound) and the
  "zone partition is itself a budget" section's own withdrawal of both prior
  width-cost claims.
