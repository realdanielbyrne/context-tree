# The baseline runs itself twice and gets a different journey

*Ten SWE-bench problems, three identical repeats each: the outcomes repeat, the trajectories do not.*

## Abstract

An AI coding agent solving a real software issue re-sends its whole working transcript to the model on every step, so how much context it accumulates decides whether a context-management policy can help it at all. This project is about that policy, but every live measurement it has produced so far ran a problem exactly once. A single run cannot say whether an outcome is a property of the problem or a draw from a distribution, so the noise floor for every comparison in this repository was unknown.

We measured it. Ten SWE-bench Verified problems, drawn by a seeded rule written before any agent ran, were each run 3 times through opencode under one frozen configuration: openrouter/qwen/qwen3.8-27b pinned to a single serving backend, no context cap, no eviction, no middleware. Nothing varied between repeats. We recorded not only pass or fail but the whole trajectory — largest prompt actually sent, steps, wall time, cost — and checked every run against validity conditions fixed in advance.

Outcomes are stable and trajectories are not. 8 of 10 problems were solved on every valid repeat, 1 was solved on some, and 1 could not be decided; across 28 valid runs, 26 passed. But with nothing varied, the largest prompt a run sent moved by 1.16x to 2.90x within a single problem (median 1.87x), and step counts moved by as much as 57 steps. The quantity this project designates as the outcome variable for every window experiment — the peak context actually reached — is therefore not a property of a problem but a per-run draw.

Two consequences follow, and the second is the more awkward. A window cap set anywhere inside those ranges binds on some repeats of a problem and not on others, so "does this problem reach the cap?" has no single answer and pressure cannot be treated as a per-problem constant. And because 8 of 10 problems already pass every time without any middleware, this pool leaves at most 2 problems for a context-management arm to win, while a paired test needs 5 problems to change in one direction to reach p = 0.031. On this pool, uncapped, no context-management result can reach significance however good the middleware is. The main limits: ten problems, one model, hosted weights that differ from the local model every earlier result in this project used, and one problem (django-11138) left undecided by harness failures rather than by the model.

## What you need to know to read the rest

| Term | Meaning |
| --- | --- |
| agent | A language model plus a loop that lets it call tools — read a file, run a shell command, edit code — until it decides it is finished. |
| agent host | The program running that loop. Here it is opencode, an external open-source coding agent, used because this project requires evaluation to happen in a real host rather than an in-repo harness. |
| transcript / context | Everything the model sees on one step: the host's instructions and tool definitions, the task, and the entire conversation so far. It is re-sent in full on every step. |
| token | The unit models count text in; roughly four characters of English or code. |
| step | One model call inside a run. |
| run / cell | One execution of one problem. Three runs of the same problem are called repeats. |
| repeat vs problem | Repeats measure how much one problem varies with itself. Distinct problems measure variation between problems. They are different quantities and only the second generalises. |
| achieved peak | The largest prompt any step of a run actually sent, as reported by the provider, including cached input. This project treats it — not the configured cap — as the outcome variable for window experiments. |
| spread | For one problem, the largest repeat's achieved peak divided by the smallest. 1.00x would mean the three repeats reached identical context sizes. |
| window cap | A configured limit on prompt size. A context-management policy decides what to drop when the conversation would exceed it, so it can only matter when prompts actually get that large. |
| eviction | Removing earlier parts of the conversation to fit a window. Not used here: this run is uncapped. |
| middleware | The context-management system this project builds. Not used here either — this is the baseline it will eventually be compared against. |
| SWE-bench Verified | A public benchmark of real GitHub issues from Python projects, each with a human-checked fix and hidden tests. |
| F2P (FAIL_TO_PASS) | Tests that fail before the fix and must pass after it. This is what "solved" means. |
| P2P (PASS_TO_PASS) | Tests that passed before the fix and must still pass, so a fix cannot win by breaking something else. |
| calibrated P2P | The subset of P2P tests that actually pass with the official fix in this environment; tests that cannot run here are dropped rather than counted as regressions. |
| valid run | A run that exited cleanly, produced steps, and was graded. A run cut short by a harness limit or a provider error is invalid: it never got to attempt the task, so it is excluded rather than scored as a failure. |
| INSUFFICIENT | A problem with fewer than 2 valid runs. It receives no verdict at all, under a rule fixed before these results existed. |
| liveness | Evidence the agent actually did something: here, whether the run left a non-empty code diff. Used to tell "tried and failed" apart from "never attempted". |
| Wilson interval | A confidence interval for a proportion that stays sensible at small counts and at 0% or 100%. |
| McNemar test | The right test for comparing two arms on the same problems: it looks only at problems where the arms disagree. With all disagreements in one direction, five are needed for p = 0.031. |
| resampling unit | The thing assumed independent when computing an interval. Here it is the PROBLEM, never the run — three repeats of one problem are not three independent observations. |

## Why we ran this

This project's central claim is that reorganising an agent's context helps it on long tasks. Testing that claim means comparing an agent with the middleware against the same agent without it, and the "without it" side is this baseline. Before any comparison can mean anything, two things about the baseline have to be known: whether it is stable — does the same problem produce the same outcome when run again — and how much it varies internally, because a difference between two arms is only interesting if it is larger than the difference an arm has with itself.

Neither was known. An earlier solvability pilot on this same substrate established that the problems are solvable and that they generate real context pressure, but it ran each problem exactly once. Every window and eviction result in this repository has the same shape: repeats of a single synthetic task, or one run each of several problems. A single run per problem cannot distinguish "this problem is hard for the model" from "this run happened to go badly", and two of that pilot's ten problems were recorded as failures on exactly that evidence.

This run was therefore designed to answer three narrow questions and nothing else. Does the frozen configuration work end to end, without harness failures? Is each problem's outcome reproducible across repeats? And how much does an identical configuration vary with itself — specifically in achieved peak, the quantity every planned window experiment is going to measure?

## The experimental setup

**The task.** opencode is started in a scratch copy of a repository at the commit where an issue was reported. Its instruction is the issue text verbatim, plus a framing line and a note naming the project's Python interpreter and test runner. It is never told which file to change, and never sees the official fix or the hidden tests; construction aborts if the prompt would leak a graded test name or a line of either patch. It may edit any file, and edits to test files are discarded before grading. After opencode exits, the hidden test patch is applied and the F2P and calibrated P2P tests are run with the project's own runner. "Solved" means every F2P test passes **and** every calibrated P2P test still passes.

**The substrate.** 10 distinct problems from 6 repositories, drawn by a seeded, difficulty-stratified rule recorded before any agent ran and verified three ways (the failing tests must fail on the original code, and both they and the P2P tests must pass with the official fix in this environment). Each problem was run 3 times, giving 33 launched runs.

**What was varied: nothing.** That is the point of the design. Every run used openrouter/qwen/qwen3.8-27b with `limit.context` 262,144 and `limit.output` 235,929, pinned to a single serving backend (["DeepInfra"], ["bf16"], no fallbacks) so that provider routing could not silently change precision between runs. Thinking is on, the host default. No tool-output clip, no context cap, no eviction, no middleware. The only thing that differs between the three repeats of a problem is the model's own non-determinism.

**What was recorded per run.** Pass, F2P and calibrated P2P separately; steps and tool calls by tool; the code diff the agent left behind; per-step tokens; achieved peak; the largest single response; each step's finish reason; wall time; provider-reported cost; exit status; whether the run was killed or timed out; and the session export, re-imported into this project's own store to confirm it is machine-readable. The validity conditions — clean exit, graded, no output-limit stop, complete event stream — were fixed before the run.

**Why this substrate, and what it cannot show.** Real problems with held-out tests are the only way to measure between-problem variation, which is the larger source of variation in agentic coding and the thing repeats of one synthetic task cannot reach. What it cannot show: anything about the middleware, which is absent here by design; anything about behaviour under a window cap, since nothing is capped; and anything about the local quantized model this project used for its earlier results, since these runs use hosted weights at a different precision.

## Results

**1. The instrument is clean.** Every validity condition was checked on every launched run.

| Validity check | Result |
| --- | --- |
| Runs launched | 33 |
| Valid runs (clean exit, graded, no harness cut-off) | 28 of 33 |
| Invalid runs (excluded, never scored as failures) | 5 |
| Steps ending on the output limit | 0 — none |
| Incomplete event streams | 0 — none |
| Runs killed by anything outside the harness | 0 — none |
| Session exports that re-imported cleanly | 33 of 33 |
| Valid runs that left a real code change (liveness) | 28 of 28 |
| Valid runs that "passed" without changing code | 0 — none, so no pass is a grading artefact |

**2. Outcomes are reproducible.** 8 of 10 problems were solved on every valid repeat, 1 on some, 0 on none, and 1 had too few valid runs to judge.

_(chart in the HTML version)_

| Problem | Repository | Difficulty | Valid | Solved | F2P | P2P | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| scikit-learn-14983 | scikit-learn/scikit-learn | <15 min fix | 3/3 | 3/3 | 3/3 | 3/3 | always-pass |
| scikit-learn-14894 | scikit-learn/scikit-learn | 15 min - 1 hour | 3/3 | 3/3 | 3/3 | 3/3 | always-pass |
| requests-1142 | psf/requests | <15 min fix | 3/3 | 3/3 | 3/3 | 3/3 | always-pass |
| pytest-7205 | pytest-dev/pytest | <15 min fix | 3/3 | 3/3 | 3/3 | 3/3 | always-pass |
| pytest-8399 | pytest-dev/pytest | 15 min - 1 hour | 3/3 | 3/3 | 3/3 | 3/3 | always-pass |
| pylint-4970 | pylint-dev/pylint | <15 min fix | 3/3 | 3/3 | 3/3 | 3/3 | always-pass |
| xarray-6721 | pydata/xarray | 15 min - 1 hour | 3/3 | 3/3 | 3/3 | 3/3 | always-pass |
| xarray-6992 | pydata/xarray | >4 hours | 3/3 | 1/3 | 1/3 | 3/3 | mixed |
| django-14034 | django/django | 15 min - 1 hour | 3/3 | 3/3 | 3/3 | 3/3 | always-pass |
| django-11138 | django/django | 1-4 hours | 1/6 | — | — | — | INSUFFICIENT (<2 valid) |

Pooled over valid runs, 26 of 28 passed. That figure is descriptive only: **the resampling unit is the problem, not the run**, because three repeats of one problem are not three independent observations. At the problem level the rate is 9 of 10 problems solved at least once, and a Wilson interval on 8 of 9 decided problems solved every time runs 56%–98%.

**3. Trajectories are not reproducible, and this is the finding.** With nothing varied between repeats, the largest prompt a run actually sent moved substantially within every problem.

_(chart in the HTML version)_

| Problem | Achieved peak: min / median / max | Spread | Steps | Wall seconds | Cost |
| --- | --- | --- | --- | --- | --- |
| django-14034 | 56,874 / 99,018 / 165,084 | 2.90x | 33–90 | 724–3,287 | $0.27–$1.69 |
| pylint-4970 | 37,496 / 52,670 / 82,230 | 2.19x | 29–53 | 267–1,177 | $0.15–$0.52 |
| xarray-6992 | 31,677 / 55,167 / 66,401 | 2.10x | 17–47 | 225–875 | $0.09–$0.41 |
| requests-1142 | 39,737 / 54,143 / 75,850 | 1.91x | 20–38 | 433–1,010 | $0.13–$0.37 |
| scikit-learn-14983 | 59,840 / 62,525 / 111,613 | 1.87x | 30–49 | 648–1,515 | $0.26–$0.73 |
| pytest-7205 | 44,624 / 64,961 / 66,933 | 1.50x | 21–34 | 490–907 | $0.15–$0.38 |
| xarray-6721 | 43,207 / 49,302 / 59,386 | 1.37x | 24–39 | 414–530 | $0.19–$0.27 |
| pytest-8399 | 66,611 / 76,318 / 86,932 | 1.31x | 41–81 | 787–1,144 | $0.38–$0.82 |
| scikit-learn-14894 | 48,722 / 50,550 / 56,487 | 1.16x | 11–20 | 439–500 | $0.11–$0.19 |

Within-problem spread runs 1.16x to 2.90x, median 1.87x. The extreme case is django-14034 at 2.90x. django-14034 solved the same issue in as few as 33 steps and as many as 90. Because a run's achieved peak is a draw rather than a constant, a cap placed inside a problem's range binds on some repeats and not others.

**4. Invalid runs, and why each was excluded.** All 5 belong to one problem, and none is a model failure.

| Problem | Outcome | Steps | Achieved peak | Would have graded | Cause |
| --- | --- | --- | --- | --- | --- |
| django-11138 | timeout | 77 | 174,460 | solved | timeout after 3600s |
| django-11138 | nonzero_exit | 21 | 103,218 | not solved | This request would exceed your available credits given your current in-f |
| django-11138 | nonzero_exit | 0 | 0 | not solved | This request would exceed your available credits given your current in-f |
| django-11138 | nonzero_exit | 57 | 107,747 | solved | This request would exceed your available credits given your current in-f |
| django-11138 | nonzero_exit | 2 | 10,582 | not solved | This request would exceed your available credits given your current in-f |

One of them had already solved the problem when the harness stopped it: it was cut off by this harness's own 3,600-second wall-clock ceiling after 77 steps with its F2P and calibrated P2P tests passing. The rest ended when the provider account ran out of funds mid-run. Under the pre-registered rule, a problem with fewer than 2 valid runs gets no verdict, so django-11138 is reported as INSUFFICIENT rather than as a failure. That rule was committed to version control before these runs produced their results.

**5. Comparison with the earlier single-run pilot (post-hoc, and confounded).** The same ten problems were run once each in an earlier pilot. Two verdicts differ.

| Problem | Pilot (1 run) | Baseline (3 runs) |
| --- | --- | --- |
| scikit-learn-14983 | pass | always-pass (3/3) |
| scikit-learn-14894 | pass | always-pass (3/3) |
| requests-1142 | pass | always-pass (3/3) |
| pytest-7205 | pass | always-pass (3/3) |
| pytest-8399 | pass | always-pass (3/3) |
| pylint-4970 | pass | always-pass (3/3) |
| xarray-6721 | pass | always-pass (3/3) |
| xarray-6992 | fail | mixed (1/3) |
| django-14034 | fail | always-pass (3/3) |
| django-11138 | invalid (output cap) | INSUFFICIENT |

**xarray-6992** was recorded as fail and is now mixed (1/3); **django-14034** was recorded as fail and is now always-pass (3/3). **This is not evidence that repeats alone flipped them.** The pilot differed in three ways at once: its provider routing was unpinned, so the serving backend and numerical precision are unknown per run and may have changed between steps; its per-response output limit was 16,384 rather than 235,929; and it ran each problem once rather than 3 times. The honest statement is that both problems are solvable by this model and neither was a stable failure — not that a particular one of those three changes is responsible.

**6. Headroom for a future comparison (post-hoc).** 8 of 10 problems are solved on every repeat with no middleware at all, leaving at most 2 problems where any context-management arm could show an improvement. A paired McNemar test over the same problems needs 5 problems to change in one direction to reach p = 0.031. 2 < 5, so on this pool, uncapped, no middleware result can reach significance — not because the middleware is ineffective but because there is nothing left to win.

**7. Cost and scale.** 33 launched runs cost $13.20 and 8.1 hours of wall time. Valid runs reported 188,627 output tokens and 660,086 reasoning tokens; on this provider reasoning is reported separately and is **not** included in the output figure.

## What we got wrong

- **A passing run was described as having "edited 0 files".** The per-run `files_edited` field is built from edit-tool calls, so an agent that edits through the shell records none. One valid run (xarray-6992) shows 1 edited file(s) by that measure while leaving a real 6,000-character diff, having used 37 shell calls. It solved the problem legitimately. Liveness in this report is therefore measured from the diff, not from `files_edited`, and the earlier description was withdrawn before publication.
- **The provider error was diagnosed twice, wrongly both times.** Runs failed with "would exceed your available credits". The account-key endpoint reported ample headroom, so it was first reported that funds were available; that endpoint reports the key's spending cap, not the account balance, which was nearly zero. It was then reported that concurrent shards were exceeding an in-flight reservation, and that running alone would fix it — a re-run alone failed identically, falsifying that explanation. The account had simply run out of money.
- **A harness ceiling was mistaken for a hard limit.** The 3,600-second wall-clock ceiling was set without checking the longest observed run; it then killed a run that had already solved its problem, and another problem reached 91% of it. This is the same class of defect as the output cap that invalidated this same problem in the earlier pilot: a configured limit, chosen without evidence, presenting as a model failure.
- **Diff records are truncated.** The runner stores at most 6,000 characters of each diff, and 4 of 33 records hit that cap. The diffs were used only to answer "did the agent change code", which truncation does not affect, but a record at exactly 6,000 characters is not a complete diff and must not be read as one.

## Conclusions

**Established.** The frozen configuration runs end to end without instrument failure: 28 of 33 runs valid, no output-limit stops, no truncated event streams, every export machine-readable, and no pass unbacked by a real code change. Outcomes are reproducible at the problem level — 8 of 10 problems solved on every valid repeat, 1 mixed, 1 undecided. Trajectories are not reproducible: achieved peak varies 1.16x–2.90x within a problem under an identical configuration.

**What this licenses.** Using these 9 decided problems as a control arm, provided any comparison is **paired within problem** and the arms are run under this same frozen configuration. Treating achieved peak as a per-run draw rather than a per-problem property, and sizing repeats to cover a spread of roughly 1.87x at the median. Reporting a single run's outcome on this substrate as provisional: two of the earlier pilot's single-run verdicts did not survive repetition.

**What this does not license.** It says nothing about the middleware, which was absent. It says nothing about behaviour under a window cap, because nothing was capped — and the spread measured here means a capped run cannot be assumed to reach the same context size twice. It is not comparable with this project's earlier local-model results, which used different weights at a different precision. It does not establish that repeats alone flipped the two changed verdicts, because three things changed at once. And it does not show that this model cannot solve django-11138: that problem is **untested**, not failed — a distinction this project treats as a defect to blur.

| Claim | Status |
| --- | --- |
| The frozen configuration runs without instrument failure | tested, supported |
| Problem outcomes are reproducible across repeats | tested, supported (8/9 decided problems unanimous) |
| Achieved peak is stable within a problem | tested and REJECTED (1.16x–2.90x) |
| The two pilot failures were caused by single-run noise | untested — confounded with routing and output-limit changes |
| django-11138 is unsolvable for this model | untested — fewer than the required valid runs |
| A context-management arm would beat this baseline | untested — and unreachable on this pool uncapped |

## Caveats

- 10 problems from 6 repositories, 3 repeats each. Per-repository and per-difficulty rates rest on one or two problems and are not reported.
- The resampling unit is the problem. Any interval computed over the 28 runs as though they were independent would be too narrow, because repeats within a problem are correlated by construction.
- One model, hosted at one precision. The measurement vehicle is **not** the deployment vehicle for this project's earlier results, which used a locally quantized model; nothing here transfers to those numbers.
- Temperature is the host default and the provider is pinned but not deterministic, so "identical configuration" means identical inputs and settings, not a reproducible sequence of tokens.
- django-11138 is unresolved: 1 valid run of 6, blocked on provider funds rather than on anything about the problem. Completing it needs 1 more valid runs.
- Grading uses calibrated P2P: tests that cannot pass with the official fix in this non-Docker environment are dropped, so a regression in one of them would go undetected.
- The Wilson interval is this repository's shared implementation, previously cross-checked against `statsmodels.proportion_confint(method="wilson")` on six (successes, n) pairs including 0/n and n/n, agreeing to better than 1e-5. The McNemar threshold quoted is the exact one-sided binomial 0.5^5 = 0.03125, not an approximation.
- Cost figures are provider-reported per run and include the host's own overhead calls; they are not a benchmark of the model's price-performance.

