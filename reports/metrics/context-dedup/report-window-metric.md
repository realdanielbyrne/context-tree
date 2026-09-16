# The window metric `W` — what it measures, and the dose–response

## Abstract

An AI coding agent re-sends its whole transcript to the model on every step, so a long task eventually outgrows
the space available and older material must be evicted. Every experiment in this line of work studies that by
imposing an artificial cap `W` on the prompt, far below the model's real 262,144-token window, and
reports results "at W". Those results cannot be read without knowing what `W` actually constrains, whether it
was enforced, and how task success responds to it.

We measured this on 31 runs of one fixed, 60-step-bounded Python programming task, using only the incumbent
eviction rule (`truncate-tail`) so that every level is comparable, at caps from 4,700 to 9,500 tokens and
with no cap at all. `W` is enforced exactly (zero cap violations), but a fixed head and reply reserve consume
21% of it at W=4,700 and 11% at W=9,500.

Success responds steeply: 46% of runs passed at W=4,700, and every run passed from
W=7,500 upward, while total prompt tokens rose from 273,290 to 632,225
across the same span. Capping is cheaper and worse; the operating point is a trade. `W` itself is only a proxy:
across all 78 capped runs in this line of work, once the transcript size actually sent is known,
nominal `W` adds nothing (p = 0.6596). The main limits are that this is a single task, and that with
3 runs at interior caps the cliff is located only to between 5,500 and 7,500.

## What you need to know to read the rest

| Term | Meaning |
|---|---|
| **Agent** | An AI model given tools (read a file, write a file, run a command) and a goal, running in a loop until it decides it is done. |
| **Transcript / context** | Everything the model sees on a step: the instructions plus the full history of what it has read, written and run. It is re-sent in full every step. |
| **Token** | The unit context is measured in, roughly ¾ of a word. W and achieved peak use an estimate (characters ÷ 4); total prompt tokens is the provider's real count. |
| **The task** | One fixed programming job, longbuild, described under The experimental setup. Every run in this report is the same task. |
| **Run (cell)** | One complete attempt at the task under one setting. |
| **Pass** | The task was completed correctly, judged by a held-out test suite the agent never sees. |
| **The artificial cap W** | A per-step ceiling on the assembled prompt, enforced before each request. It is not the model's context window, which stays at 262,144 tokens; W simulates a smaller deployment window so that overflow happens within one task. |
| **Frozen head / reply reserve** | The system prompt and task statement (never evicted) and the tokens held back for the model's answer. Both come out of W before any history does. |
| **Eviction** | Deleting older material from the transcript to get back under W. |
| **Arm** | The rule that chooses what to evict. This report uses one arm, truncate-tail (oldest material goes first), plus an uncapped reference that never evicts. |
| **Achieved peak** | The largest transcript actually sent to the model during a run. It is the quantity that predicts success, and it can differ from W. |
| **Cadence** | How often eviction runs: every step, or every N-th step. Every run here is at every step. |
| **Wilson interval** | A 95% confidence interval for a pass rate that stays sensible at very small n. |
| **Odds ratio (per e-fold)** | How much the odds of passing multiply when achieved peak is multiplied by e ≈ 2.7. |
| **Likelihood-ratio test, χ², p-value** | Fit a model with and without a variable; χ² measures how much the fit improves and p is the probability of an improvement that large if the variable carried no information. |

## Why we ran this

Every A/B comparison of eviction rules in this project is run and reported at a nominal `W`. Before a
between-rule difference at some `W` can be interpreted, three things have to be known: what fraction of `W`
is actually available to the history the rules fight over; whether the cap was enforced as labelled; and where
on the success curve that `W` sits — a comparison run at a cap where everything passes, or where nothing
does, cannot separate rules. This report establishes those for the incumbent rule, so that other results can be
placed on the curve.

## The experimental setup

### The task

Every run is the same job, called `longbuild`. The agent starts in a workspace holding a README, 13
specification documents (~20,000 characters in total) describing a small Python accounting library, five
empty Python stubs to fill in (`money.py`, `parsing.py`, `rules.py`, `report.py`, `cli.py`), and a visible
test suite it may run at any time. It works through six stages — read a stage's specification, implement it,
run the tests, fix failures, move on — until it declares itself done or hits a 60-step ceiling.
Runs in this report took 46 to 61 steps.

**Passing** is decided by a *held-out* test suite written into the workspace only after the agent stops,
exercising the same specified behaviour on different data. The agent never sees it, so it cannot pass by
special-casing the tests it can read. Model: `unsloth/Qwen3.8-27B-GGUF`.

### What `W` is and how it is enforced

`W` is an **artificial per-turn cap on the assembled prompt**, enforced by the assembler *before* the
request is sent. It is deliberately **not** the model's context window — that stays fixed at
**262,144 tokens** in every arm, so the provider never rejects anything and no result is an artifact
of a model limit. `W` simulates a *deployment* window.

**How it is enforced** (`policies.mjs → evictToBudget`):

```
avail = W − head(498) − reserve(512)
keep  = anchors (last A=4 units, never evicted)
        + units in rank order while they still fit avail
```

So three things come out of the same budget, and only the third is negotiable:

| component | size | evictable? |
|---|---|---|
| frozen head (system 132 + task 366) | **498 tok** | never |
| reply reserve | **512 tok** | never (held back for the answer) |
| context units | W − 1010 | yes — this is what eviction fights over |

That fixed tax is why the cap bites harder than it looks: at W=4,700 the head+reserve consume
**21%** of the budget, leaving 3,690 tokens for actual context; at W=9,500 the same
tax is only **11%**, leaving 8,490.

**Units:** `W` is counted with the harness's `estTokens` = **characters ÷ 4** heuristic, not the
provider's tokenizer. So `W` and the `peak` column are in estimated tokens, while
`total_prompt_tokens` is the provider's real count. They are consistent within an experiment but not
interchangeable.

### What was varied

- **`W`** — 4,700, 5,500, 6,500, 7,500, 8,500, 9,500 tokens, plus an uncapped reference.
- **Arm** — `truncate-tail` only, at every cap. Other arms present in the same batches are excluded (see
  **What we got wrong**).
- **Cadence** — eviction runs every step in every run here. Batches run at other cadences are excluded, because
  there the transcript overshoots `W` between evictions.

31 runs from 4 batches.

### What was recorded

For each run: pass or fail, the achieved peak, total prompt tokens billed over the run, steps taken, number of
evictions, and cap violations (steps on which the sent prompt exceeded `W`).

## Results

### Enforcement check

Cap violations across every run in these batches: **0**. Achieved peak lands
517–529 tokens under `W` at the capped levels — the reply reserve of
512 being held back, the small remainder being unit sizes that cannot fill the budget exactly. The cap
does what it says.

### Measurements

| W | runs | pass | 95% CI (Wilson) | achieved peak | total prompt tok (med) | turns (med) | evictions (med) |
|---|---|---|---|---|---|---|---|
| 4,700 | 13 | 6/13 (46%) | 23%–71% | 4,181 | 273,290 | 61 | 40 |
| 5,500 | 3 | 2/3 (67%) | 21%–94% | 4,983 | 308,144 | 58 | 34 |
| 6,500 | 3 | 1/3 (33%) | 6%–79% | 5,972 | 374,228 | 61 | 32 |
| 7,500 | 3 | 3/3 (100%) | 44%–100% | 6,977 | 409,065 | 58 | 32 |
| 8,500 | 3 | 3/3 (100%) | 44%–100% | 7,972 | 426,197 | 56 | 25 |
| 9,500 | 3 | 3/3 (100%) | 44%–100% | 8,971 | 499,612 | 61 | 25 |
| ∞ (uncapped) | 3 | 3/3 (100%) | 44%–100% | 20,993 | 632,225 | 53 | 0 |

### Reading the curve

- **Dose–response is steep.** Pass rate by cap, `truncate-tail` only: 4,700 → 46% (6/13) · 5,500 → 67% (2/3) · 6,500 → 33% (1/3) · 7,500 → 100% (3/3) · 8,500 → 100% (3/3) · 9,500 → 100% (3/3) · ∞ → 100% (3/3).
- **Cost moves the opposite way.** 273,290 → 632,225 median prompt tokens across
  the same span; across the 28 capped runs, `W` explains 95% of the variance in total prompt
  tokens (linear R²).
- **The curve is not monotone point-to-point.** W=6,500 (1/3) sits below W=5,500 (2/3). With n=3 at the interior
  levels this is within noise, so the data locate the cliff no better than **5,500–7,500**.
- **`W` is a stand-in for achieved peak.** In a logistic regression over all 78 capped runs
  of this task (every arm and cadence, adjusted for arm), the odds of passing multiply by **41.83× per
  e-fold** of achieved peak (p = 0.0002 given cadence). Given achieved peak, nominal `W` adds nothing
  (χ²(1) = 0.194, p = 0.6596) and neither does eviction cadence (χ²(1) = 0.368,
  p = 0.5441). Full analysis: `report-cadence-confound.md`.

## What we got wrong

**1. The first dose–response curve pooled every eviction rule.** Levels were not balanced by rule: W=4,700
and W=9,500 carried idle, random, truncate-tail, while every interior level was `truncate-tail` alone. The pooled curve
therefore showed W=4,700 at 15/39 (38%) and W=9,500 at
8/9 (89%), with the endpoints dragged down by the deliberately
signal-free `random` control relative to the middle. Restricted to the one rule present at every level, those
levels are 6/13 (46%) and 3/3 (100%).

**2. Cadence cells were once read at their labelled `W`.** At cadence above 1 nothing enforced the cap between
evictions, so those runs sent more than their label. They are excluded from this curve; the correction is
`report-cadence-confound.md`.

**3. The two versions of this report quoted different test statistics.** The HTML version stated that, given
achieved peak, nominal `W` adds nothing with "LR χ²(1)=0.010, p=0.92" and cadence with "p=0.97", while the
Markdown version stated χ²(1)=0.19, p=0.66 and χ²(1)=0.37, p=0.54. Both were typed by hand. The HTML figures
did not match the arm-adjusted fit. Both versions now compute the statistics from the data: nominal `W`
χ²(1) = 0.194, p = 0.6596; cadence χ²(1) = 0.368, p = 0.5441. The conclusion —
neither adds anything — is unchanged.

**4. An unsourced variance figure.** The cost chart was captioned "window explains 88% of the variance", with
no computation behind it. Computed on the runs the chart shows, the linear R² of total prompt tokens on `W`
is 0.95.

## Conclusions

**Established, for this task and model.** `W` is enforced as labelled when eviction runs every step. A fixed
1010-token tax comes out of it first, so usable history shrinks faster than `W`. Under the
incumbent rule, success rises steeply with `W` and reaches 100% by W=7,500, while cost rises
throughout. What predicts success is the transcript size actually sent, not the label.

**Licensed.** Between-rule comparisons should be run at a cap where the incumbent neither always passes nor
always fails — on this task, below 7,500 — and should report achieved peak alongside `W`. Budget
targets should be expressed in what is actually sent, net of the fixed head and reserve.

**Not licensed.**

| claim | status |
|---|---|
| success on this task rises with the size of the transcript sent | **tested, supported** |
| nominal `W` matters beyond the size actually sent | **tested and rejected** (p = 0.6596) |
| the exact location of the cliff within 5,500–7,500 | **not resolved** — 3 runs per interior level |
| the curve has the same shape for other eviction rules | **untested** in this report — only `truncate-tail` is plotted |
| the threshold is a fixed token count rather than a share of the task's demand | **untested** — one task cannot separate them |
| any of this transfers to another task, model, or a real deployment window | **untested** |

## Caveats

- **One task.** All 31 runs are `longbuild`; this is variation within one problem, not across problems.
- **One model**, `unsloth/Qwen3.8-27B-GGUF`, on one host.
- **Small numbers at interior caps** — 3 runs per level, so individual percentages are
  noisy and the intervals are wide.
- **The regression is observational and pooled.** Achieved peak is a consequence of the settings rather than
  something set directly, and the fit draws on 78 runs across every arm and cadence, not only the
  31 plotted here.
- **Token counts for `W` and achieved peak are estimates** (characters ÷ 4); only total prompt tokens is the
  provider's count, so `W` is not directly a provider-token budget.
- **`W` is a simulated deployment window**, not the model's real limit; effects of a genuinely binding model
  limit are not measured.

---
*Generated by `experiments/context-dedup/report-window-metric.mjs` from `results-ab-longbuild-v2-n3.json`, `results-ab-longbuild-v2.json`, `results-ab-longbuild-winwA.json`, `results-ab-longbuild-winwB.json`
(curve) and `results-ab-longbuild-cadence10.json`, `results-ab-longbuild-cadence2.json`, `results-ab-longbuild-cadence5.json`, `results-ab-longbuild-v2-n3.json`, `results-ab-longbuild-v2.json`, `results-ab-longbuild-winwA.json`, `results-ab-longbuild-winwB.json` (regression). Charts in the HTML version.*
