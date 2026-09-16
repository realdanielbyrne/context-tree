# Deleting context less often did not help — it just kept more context

*A correction. A result this project reported two days ago does not survive re-analysis.*

> **This supersedes the claim recorded in commit `25e3006`**, which read: *"Sawtooth beats a wider flat
> window: W=4700/N=10 matches W=7500/N=1 at 100% pass with 15% fewer tokens and 6× fewer evictions."*
> The task-success half of that claim is withdrawn. The cost half survives, restated.

---

## Abstract

An AI coding agent re-sends its whole working transcript to the model on every step, so on a long task the
transcript outgrows the model's input limit and material must be deleted. One tunable in such a system is
**how often** the deletion routine runs: every step, or every few steps. Running it less often is cheaper,
because each deletion invalidates the provider's cache of the prompt prefix, but it allows the transcript to
overshoot the limit in between.

We swept deletion frequency over 78 runs of a fixed programming task and reported that running
it every 10th step raised task success from 38% to 100% at the same nominal size limit — a large,
apparently free win. **That result was confounded.** The deletion routine was gated behind the frequency
counter, so on steps where it did not run, nothing enforced the limit at all. The less frequently it ran,
the more the transcript was allowed to grow, and the runs labelled with a 4,700-token limit were in fact
sending **7,657 tokens** — more than the runs labelled with a 7,500-token limit
(6,977).

Re-analysing all 78 runs against the transcript size **actually sent** rather than the nominal
limit: deletion frequency contributes nothing once actual size is known (p = 0.5441), the nominal
limit contributes nothing either (p = 0.6596), and actual transcript size is decisive
(p = 0.0002; odds of success multiply by **41.83×** for each e-fold increase). Deletion
frequency predicted success only because it determined transcript size.

**What survives is a cost result, not a quality one.** At comparable transcript size the infrequent-deletion
runs were materially cheaper — 349,308 tokens billed with 5 deletions,
against 409,065 and 32 for the every-step runs. The design implication
changes accordingly: do not tune deletion frequency expecting better task performance. Tune the quantity that
actually predicts it — how much of the transcript is present when the model is called — and then use deletion
frequency to obtain that quantity as cheaply as possible.

---

## What you need to know to read the rest

| Term | Meaning |
|---|---|
| **Agent** | An AI model given tools (read a file, write a file, run a command) and a goal, running in a loop until it decides it is done. |
| **Transcript / context** | Everything the model sees on a given step: the instructions plus the full history of what it has read, written and run. It is re-sent in full every step. |
| **Token** | The unit context is measured in — roughly ¾ of a word. Counts here are estimates (characters ÷ 4) unless stated otherwise. |
| **Size limit (`W`)** | An artificial ceiling we impose on the transcript so that overflow happens quickly enough to study. The model's real limit is 262,144 tokens, far more than this task needs. |
| **Eviction** | Deleting older material from the transcript to get back under the limit. |
| **Deletion frequency (`N`)** | How often the eviction routine runs: N=1 means every step, N=10 means every tenth step. The variable this experiment swept. |
| **Achieved peak** | The largest transcript actually sent to the model during a run. This turns out to be the quantity that matters, and it is **not** the same as the size limit. |
| **Run** | One complete attempt at the task under one combination of settings. |
| **Pass** | The task was completed correctly, judged by a hidden test suite the agent never sees. |
| **Odds ratio** | How much the odds of passing multiply when a variable increases. "41.83× per e-fold" means that multiplying transcript size by 2.7 multiplies the odds of success by about 41.83. |
| **p-value** | The probability of seeing an association this strong if the variable really had no effect. Small means the effect is probably real; large means the data cannot distinguish it from nothing. |

## Why we ran this

Deleting material from the transcript is not free. Providers cache the prompt so that repeated prefixes are
billed at roughly a tenth of the normal rate, but that cache is keyed on the prefix: change any earlier byte
and everything after it must be re-cached at a premium. Deleting from the middle of the transcript therefore
throws away the discount for the rest of the prompt.

That cost is paid **per deletion**, while the discount accrues **per step**. So deleting less often should be
cheaper, and an earlier simulation put the saving at 25–39% versus never deleting at all. The open question
was what infrequent deletion does to *task success*, which the simulation could not measure. This sweep was
the live arm meant to answer it.

## The experimental setup

### The task

Every run is the same job, called `longbuild`. The agent starts in a workspace holding a README, 13
specification documents (~20,000 characters in total) describing a small Python accounting library, five
empty Python stubs to fill in (`money.py`, `parsing.py`, `rules.py`, `report.py`, `cli.py`), and a visible
test suite it may run at any time. It works through six stages — read a stage's specification, implement it,
run the tests, fix failures, move on — until it declares itself done or hits a 60-step ceiling. Runs take
roughly 53 to 61 steps.

**Passing** is decided by a *held-out* test suite written into the workspace only after the agent stops,
exercising the same specified behaviour on different data. The agent never sees it, so it cannot pass by
special-casing the tests it can read.

The task is this long deliberately. An agent with a shell recovers almost anything it loses — if a file falls
out of its transcript it simply reads the file again. The one thing no tool call can recover is the
transcript itself: its own earlier reasoning, tool calls and test output. Pressure on the transcript is
therefore inherently long-horizon and has to be built up over many steps of real work.

### What was varied

Two settings, crossed:

- **Size limit `W`** — 4,700, 5,500, 6,500, 7,500, 8,500, 9,500 tokens.
- **Deletion frequency `N`** — 1, 2, 5, 10 (delete every N-th step).

78 runs in total, across 7 batches.

### The eviction signal, and why it is a third variable

When the limit binds, something has to choose *which* material goes. **Each run used exactly one of three
rules**, and the runs in this dataset are pooled across all three — no run mixes them, but the dataset does.

| Rule | What it keeps | Role |
|---|---|---|
| `truncate-tail` | the most recent material that fits — oldest goes first | The incumbent: what ordinary agent harnesses do. |
| `idle` | the material whose files were referenced most recently, regardless of position | The candidate: a least-recently-used rule keyed on file references rather than position. |
| `random` | a random subset that fits | The control: no signal at all, but the same volume kept, so any difference from the other two is attributable to the *choice* rather than the amount. |

All three fit the same budget and protect the same most-recent items; they differ only in the order they
sacrifice the rest. A separate experiment (13 runs per rule) found **no measurable difference** between
`truncate-tail` and `idle` (p = 1.000), and a weak advantage for having *any* signal over `random`
(p = 0.045).

The rules are **not evenly spread across the settings** — the `random` control appears only at the every-step
frequency — so it is entangled with the variable under test. Every statistical model below therefore adjusts
for which rule a run used; the "Rules present" column in the results table shows the mix in each cell.

### What was recorded

For each run: whether it passed, the **achieved peak** (the largest transcript actually sent), how many
deletions occurred, and the total tokens billed across the whole run.

### The bug: the limit was not enforced between deletions

Eviction was gated behind the frequency counter:

```js
const fire = (turnNo++ % CADENCE) === 0;   // deletion-frequency gate
const r = fire ? evict(m) : NOOP;
```

On steps where the gate does not fire, **nothing checks the size limit**. The transcript simply grows. So at
N > 1 the nominal `W` is not a size limit at all — it is a *trigger threshold*: the point at which the next
scheduled deletion will cut back. The transcript actually sent is the peak of the resulting sawtooth.

The instrumentation was never wrong about this. `peak_history_tokens` was already being sampled *after* the
(possibly skipped) deletion, so it recorded the true size all along. The error was in the interpretation:
comparing runs by the label `W` rather than by what they actually sent.

Concretely, the runs labelled `W=4,700` with N=10 sent **7,657 tokens** — larger than
the 6,977 sent by the runs labelled `W=7,500` with N=1. The infrequent-deletion
configuration was never fitting into a smaller window. It was fitting into a slightly larger one.

### How we tested it

We fit a logistic regression — a standard model for a yes/no outcome — predicting whether a run passed, and
asked whether each variable adds anything once the others are known. The comparison is a **likelihood-ratio
test**: fit the model with the variable, fit it without, and ask how much better the fit got. A large
improvement with a small p-value means the variable carries information the others do not.

**Every model adjusts for the deletion rule.** That is not cosmetic: the signal-free random rule contributes
16 of the 78 runs and appears **only** at N=1, so
it is entangled with deletion frequency. Leaving it out inflates the headline odds ratio from 41.83×
to 52.24× — a 25% overstatement. The conclusion is
the same either way; the effect size was not.

| Question | Improvement in fit (χ², 1 df) | p | Answer |
|---|---|---|---|
| Does **deletion frequency** add anything once actual transcript size is known? | 0.368 | **0.5441** | No |
| Does the **nominal size limit** add anything once actual transcript size is known? | 0.194 | **0.6596** | No |
| Does **actual transcript size** add anything once deletion frequency is known? | 14.15 | **0.0002** | **Yes** |

Actual transcript size, adjusted for the deletion rule: **odds ratio 41.83× per e-fold**.

## Results

Ordered by the variable that actually predicts the outcome — not by the label the runs were filed under.

| Deletion frequency N | Nominal limit W | Runs | Passed | **Achieved peak** | Deletions | Tokens billed | Rules present |
|---|---|---|---|---|---|---|---|
| 1 | 4,700 | 39 | 15/39 (38%) | **4,182** | 40 | 275,246 | idle×13, random×13, truncate-tail×13 |
| 2 | 4,700 | 6 | 3/6 (50%) | **4,909** | 24 | 288,660 | idle×3, truncate-tail×3 |
| 1 | 5,500 | 3 | 2/3 (67%) | **4,983** | 34 | 308,144 | truncate-tail×3 |
| 1 | 6,500 | 3 | 1/3 (33%) | **5,972** | 32 | 374,228 | truncate-tail×3 |
| 5 | 4,700 | 6 | 3/6 (50%) | **6,005** | 10 | 320,908 | idle×3, truncate-tail×3 |
| 1 | 7,500 | 3 | 3/3 (100%) | **6,977** | 32 | 409,065 | truncate-tail×3 |
| 10 | 4,700 | 6 | 6/6 (100%) | **7,657** | 5 | 349,308 | idle×3, truncate-tail×3 |
| 1 | 8,500 | 3 | 3/3 (100%) | **7,972** | 25 | 426,197 | truncate-tail×3 |
| 1 | 9,500 | 9 | 8/9 (89%) | **8,971** | 25 | 477,501 | idle×3, random×3, truncate-tail×3 |

Reading down the achieved-peak column, the pass rate rises as transcript size rises, and the
infrequent-deletion rows sit **on the same curve** as the every-step rows rather than above it. The direct
comparisons:

- **N=2, peak 4,909 → 50%** (6 runs) versus the nearest every-step configuration, **N=1, peak 4,983 → 67%** (3 runs).
- **N=5, peak 6,005 → 50%** (6 runs) versus the nearest every-step configuration, **N=1, peak 5,972 → 33%** (3 runs).
- **N=10, peak 7,657 → 100%** (6 runs) versus the nearest every-step configuration, **N=1, peak 7,972 → 100%** (3 runs).

## What we got wrong

**1. "Deleting less often raises task success at the same size limit."** Commit `25e3006` recorded:
*"Sawtooth beats a wider flat window: W=4700/N=10 matches W=7500/N=1 at 100% pass with 15% fewer tokens and
6× fewer evictions."* The task-success half of that is **withdrawn**. The N=10 runs labelled W=4,700 were not
held to 4,700 tokens; they sent 7,657, more than the 6,977 sent
by the W=7,500 every-step runs they were compared against. Once achieved peak is in the model, deletion
frequency adds nothing (p = 0.5441) and neither does the nominal limit (p = 0.6596). The corrected
reading: the infrequent-deletion runs passed because they kept more transcript, not because they deleted less
often. The cost half of the claim survives and is restated in Conclusions.

**2. The effect size of transcript size was overstated by leaving the deletion rule out of the model.** An
earlier fit of pass against achieved peak did not adjust for which rule each run used. Because the signal-free
`random` rule contributes 16 runs, all at N=1, that omission
confounds rule with deletion frequency and gave an odds ratio of **52.24× per e-fold**. Adjusted
for rule it is **41.83×**, a 25% overstatement. The
direction and the significance were unaffected; the magnitude was not.

## Conclusions

### What survives

**Deleting less often is a cost lever, not a quality lever.** At comparable transcript size the
infrequent-deletion configuration was materially cheaper:

| | Tokens billed | Deletions | Achieved peak | Passed |
|---|---|---|---|---|
| Delete every 10th step (N=10, W=4,700) | **349,308** | **5** | 7,657 | 6/6 |
| Delete every step (N=1, W=7,500) | 409,065 | 32 | 6,977 | 3/3 |

Fewer tokens and a sixth of the deletions, at a *higher* peak — matching the direction the earlier cost
simulation predicted. That is the half of the original claim worth keeping.

**The design implication changes.** Do not tune deletion frequency expecting better task performance. Tune
the thing that predicts performance — how much of the transcript is present when the model is called — and
use deletion frequency to buy that as cheaply as possible.

### What this licenses, and what it does not

**Established, on this one task.** Task success tracks the transcript size actually sent to the model
(odds ratio 41.83× per e-fold, p = 0.0002, adjusted for deletion rule). Given that size,
deletion frequency and the nominal limit carry no further information.

**Licensed for the design.** Configure and enforce eviction against the transcript actually sent, not against a
threshold that may be overshot between deletions. Treat deletion frequency purely as a cost setting, chosen
after the target size is fixed.

**Not licensed.**

| claim | status |
|---|---|
| deleting less often improves task success | **tested and rejected** — no effect once achieved peak is known (p = 0.5441) |
| the nominal size limit matters beyond the size actually sent | **tested and rejected** (p = 0.6596) |
| deleting less often is cheaper at matched transcript size | **observed**, in one comparison of 6 against 3 runs, with no interval |
| the success threshold is an absolute token count rather than a share of task demand | **untested** — indistinguishable on a single task |
| the *content* of the retained transcript matters, not only its size | **untested** — see the deeper question below |
| any of this holds beyond `longbuild` or this model | **untested** |

### What this does not answer: how wide should the window be?

The results identify a threshold — success reaches 100% once about **6,977 tokens**
of transcript are present — but they cannot say what that number *is*.

Three readings are consistent with everything here:

| Reading | The threshold would be | On this run |
|---|---|---|
| An absolute token count | ~6,977 tokens, for this task | 6,977 |
| A fraction of the **model's** context limit | a constant % of 262,144 | 2.7% |
| A fraction of what **the task itself** demands | a constant % of the uncapped transcript | 33% of 20,993 |

**The middle reading is already implausible.** The threshold sits at 2.7% of the model's
hard limit — the model's own capacity is nowhere near binding, so it cannot be what sets the threshold. What
binds is whether the transcript still holds what the task needs.

**The first and third readings cannot be separated here, and the reason is structural.** Every run in this
dataset is the same task, so the uncapped demand is a constant 20,993
tokens. "6,977 tokens" and "33% of demand" are the same number
wearing two hats. No amount of extra runs on this task can tell them apart.

#### The experiment that would

Sweep the size limit across **tasks with materially different uncapped demand** — one that needs ~8k, one
~20k (this task), one ~40k — on the same model. Then:

- if the success threshold lands at the **same token count** across all three, the target is absolute and
  should be configured as a token budget;
- if it lands at the **same fraction of each task's uncapped demand**, the target is relative, and a fixed
  token budget will be wrong for every task but one — the assembler would need to estimate demand.

A second, cheaper arm settles the model-capacity question directly: run the same task on a model with a much
smaller hard limit (a 131k-token model is already available) and check that the threshold does not move. The
prediction is that it does not, so long as the limit stays well above the threshold.

#### The deeper question underneath it

This all assumes the only thing that matters is *how much* transcript is present. Everything measured so far
is consistent with that — and with nothing else mattering. But a companion experiment established that the
measurement may be **unable to detect** whether the *content* of the retained transcript matters, so "width
is all that matters" is not yet a finding, only an unrefuted possibility. If relatedness turns out to matter,
the target is not a width at all: it is whatever width happens to be needed to retain the related material,
and the right lever is selection, not size.

## Caveats

- **This is observational, not a randomised comparison.** Achieved peak is a consequence of the settings, not
  something we set directly, so the regression separates cause from consequence only as well as the design
  allows. The stronger evidence is the direct one: infrequent-deletion runs land on the same curve as
  every-step runs at matched size, which agrees with the regression.
- **One task.** All 78 runs are `longbuild`. This measures variation within one problem, not
  across problems, and between-problem variation is the larger effect in agentic coding.
- **Small numbers at the interior settings** — as few as three runs per cell, so individual percentages are
  noisy. The overall trend rests on all 78 runs.
- **Token counts are estimates** (characters ÷ 4) for the limit and the peak; the billed-token column is the
  provider's real count. Real counts ran about 30% above the estimate, so comparisons hold but absolute
  figures do not transfer.
- **The regression is computed inside this report** by Newton–Raphson, and reproduces the reference
  `statsmodels` fit to three decimal places on the same data.

---
*Generated by `experiments/context-dedup/report-cadence-confound.mjs` from
`results-ab-longbuild-cadence10.json`, `results-ab-longbuild-cadence2.json`, `results-ab-longbuild-cadence5.json`, `results-ab-longbuild-v2-n3.json`, `results-ab-longbuild-v2.json`, `results-ab-longbuild-winwA.json`, `results-ab-longbuild-winwB.json`. Charts in the HTML version of this report.*
