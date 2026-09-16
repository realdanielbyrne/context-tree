# SWE-bench Verified solvability pilot

## Abstract

Every live context-management experiment in this project has run on one synthetic task, so its repeats measure one problem's noise and not the variation between problems. SWE-bench Verified would fix that, but only if the model can solve real instances when given unlimited context, and only if solving them fills enough of the context window for a window policy to matter. This pilot tests both conditions with the Qwen3.8-27B model.

A first attempt, one instance run three times in an in-repo agent loop, failed with no file ever edited. That was a harness defect, not a verdict. The loop cut every tool result at 2,000 characters. Across two model endpoints, runs at that limit edited nothing (0/6); runs at 30,000 characters edited in 5/6. Following the project's own rule that evaluation runs in an external agent host (decision D20), the agent was moved to opencode 1.18.31. The problems were then drawn by a seeded, difficulty-stratified rule recorded before any agent ran, verified three ways, and screened against their gold fixes; 10 were accepted from 6 repositories.

With opencode, uncapped, the model solved 7/9 (78%; 95% CI 45%–94%) of the validly run problems. 1 further run (django__django-11138) is invalid: a per-response output cap of 16,384 tokens, set as a placeholder in the pilot's own configuration, cut it off mid-reasoning before it could act. Re-run on the local model with that cap raised, it solved it; that run differs in 2 ways from the others and is reported separately. Among solved problems, 5 of 7 sent a prompt larger than 32,768 tokens; opencode alone adds about 9,898 tokens to every call. Verdict: projected 150.8 usable problems against the 13 a sweep needs (72.4 at the lower end of the interval, still above that bar), so SWE-bench Verified with this model and host is a usable substrate for the window and eviction experiments as run. Main limits: 9 valid problems, one run each, several post-hoc (but pre-agent) amendments to the selection rule, unpinned OpenRouter routing whose serving backend (and so precision) is unknown for every run, and hosted weights that differ from the project's earlier local runs.

## What you need to know to read the rest

| Term | Meaning |
| --- | --- |
| agent | A language model plus a loop that lets it call tools (read, edit, run shell commands) until it stops. |
| agent host / harness | The program that runs that loop. The scored runs use opencode, an external open-source coding agent; the diagnosis used an in-repo ("homegrown") loop. |
| step | One model call inside a run. |
| response | Everything the model generates on one step: visible output plus reasoning tokens. |
| per-response output cap | The most tokens one response may contain. opencode takes it from `limit.output` in its configuration. |
| context / prompt | Everything sent to the model on a step: the host's system prompt and tool definitions, the task, and the whole conversation so far. |
| token | The unit models count text in; roughly four characters of English or code. |
| peak prompt | The largest prompt of any step in a run, as reported by the provider (fresh plus cached input). The measure of context pressure. |
| fixed overhead | The prompt size of a run's first step, dominated by the host's own instructions and tool definitions. |
| window / cap | A limit on prompt size. A window policy decides what to drop when the conversation would exceed it; it can only matter if prompts get that large. |
| eviction | Removing earlier parts of the conversation to fit a window. |
| uncapped | No context window cap, no eviction, no middleware. (Distinct from the per-response output cap.) |
| thinking / reasoning tokens | Output the model generates for its own deliberation before answering; opencode leaves this on by default. |
| SWE-bench Verified | A public benchmark of 500 real GitHub issues from Python projects, each with a human-checked fix. |
| instance / problem | One SWE-bench issue: a repository at a past commit, the issue text, a hidden gold fix and hidden tests. |
| repeat | Running the same problem again. Repeats measure noise within a problem; distinct problems measure variation between problems. |
| F2P (FAIL_TO_PASS) | Tests that fail before the fix and must pass after it. |
| P2P (PASS_TO_PASS) | Tests that pass before the fix and must still pass after it. |
| calibrated P2P | The P2P tests that pass with the gold fix in this environment; the ones used for grading here. |
| pass | Every F2P test passes AND every calibrated P2P test passes. |
| valid run | A run that exited cleanly, was graded, and was not cut off by a harness configuration limit before acting. Only valid runs count toward solve rates. |
| gold patch | The real fix from the project's history. Never shown to the agent. |
| three-way verification | F2P fails on the original code, passes with the gold patch, and P2P passes with the gold patch. |
| tool-output clip | In the homegrown loop, the number of characters of a tool result the agent was shown. |
| development instance | psf__requests-2931, the problem the harness was debugged on; held out of the scored set. |
| stratum | A difficulty band from the dataset's own fix-time estimate. |
| amendment | A change to the pre-registered selection rule, made after it was written but before any scored agent run. |
| Wilson interval | A 95% confidence interval for a proportion that stays sensible at small counts and at 0% or 100%. |
| void / errored run | A run whose grade could not be computed, or whose host run failed or timed out. Excluded from rates, never counted as a failure. |

## Why we ran this

The project's window and eviction results all come from one synthetic build task. Repeats of one problem measure how much one agent varies on one task; they cannot measure variation across tasks, which is usually the larger source of variation for coding agents. The session handoff records this as constraint C0 and names SWE-bench Verified as the remedy.

Two things could make SWE-bench useless for that purpose. The model might be unable to solve the problems even with unlimited context, so every policy would fail for reasons unrelated to context. Or it might solve them while keeping prompts small: agents with a shell tend to read only what they need (constraint C1), and a problem that never fills a window cannot tell window policies apart. The gate therefore has two parts, and a problem counts toward a usable substrate only if it passes both.

## The experimental setup

**The task.** opencode is started in a scratch copy of a repository at the commit where an issue was reported. Its message is the issue text word for word, with one framing line and a short note naming the project's Python interpreter and test runner. It is not told which file to change and never sees the gold patch or the tests; construction aborts if the prompt contains a graded test id, a failing test's name, or (in harness-written text) a line of either patch. It may edit any file; edits to test files are discarded before grading. After opencode exits, the hidden test patch is applied and F2P and calibrated P2P tests run with the project's own runner (pytest, or Django's runtests.py).

**The host.** opencode 1.18.31, model `openrouter/qwen/qwen3.8-27b` via OpenRouter, started with `--pure` (no plugins), `--auto` (tool permissions approved), its own tools and system prompt, thinking on by default, no tool-output clip, no context cap, no eviction, isolated state per run, and a 3,600-second wall-clock limit. During the tranche the pilot's opencode configuration gave the OpenRouter model a per-response output cap of 16,384 tokens, and routing was not pinned, so OpenRouter chose the serving backend per request; see What we got wrong.

**The substrate.** 380 eligible instances across 10 repositories (sympy and sphinx excluded: unsupported test runners; the development instance held out). With seed 20260915, each difficulty stratum's instances were shuffled per repository and taken round-robin across repositories: 28 candidates. Candidates were walked in drawn order and accepted while the stratum quota (E 4, M 4, H 4) and a cap of 2 per repository (which also caps Django) allowed. 3 amendments to that rule were made before any scored agent run; they are listed under What we got wrong.

**What was varied.** Only the problem. Each accepted problem was run once. One problem whose run was invalidated was re-run once under a different configuration, reported separately.

**What was recorded per run.** Pass, F2P and calibrated P2P separately; steps; tool calls by tool; files edited and read; the agent's diff; per-step tokens (fresh input, cached input, output, reasoning); peak prompt; largest single response; each step's finish reason; fixed overhead; provider-reported cost; wall time; exit status and errors; whether the run and the grade were valid; and the session export.

**Why this substrate, and what it cannot show.** SWE-bench Verified gives many independent, human-checked problems with held-out tests, which a between-problem design needs. Ten problems cannot give a per-repository solve rate, and a non-Docker environment cannot reproduce every test the benchmark lists.

## Results

**1. The first zero-edit result was the homegrown loop (diagnosis).**

_(chart in the HTML version)_

| Arm (3 runs each) | Edited | Ran tests | Stopped on its own | F2P fixed | P2P kept | Passed | Median steps | Median peak prompt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| local GGUF, clip 2,000 | 0/3 | 0/3 | 0/3 | 0/3 | 3/3 | 0/3 | 51 | 28,283 |
| local GGUF, clip 30,000 | 3/3 | 3/3 | 3/3 | 2/3 | 1/3 | 0/3 | 31 | 26,146 |
| OpenRouter, clip 2,000 | 0/3 | 0/3 | 0/3 | 0/3 | 3/3 | 0/3 | 51 | 22,826 |
| OpenRouter, clip 30,000 | 2/3 | 2/3 | 0/3 | 2/3 | 1/3 | 0/3 | 51 | 23,303 |

Replaying the local 2,000-character runs against a fresh copy of the repository reproduces what the agent was shown: 4, 26, 26 of 50 tool results clipped, and runs of 26, 22, 22 consecutive identical visible results. The agent kept widening `grep -A N` on one function; past the clip every answer was the same. The same limit produced no edits on OpenRouter, so the contended local server and the quantized local weights do not explain it. This is a finding about the homegrown loop, not about SWE-bench or the model.

**2. opencode integration check (development instance).** A first check run was ended by `SIGTERM` after 229 seconds, mid-step (8 steps, 14 tool calls, no edit). Cause: another session on the host ran a cleanup that sent SIGTERM to every process named `opencode` between its own test runs (confirmed by that session). The harness marked the run invalid and did not score it. Its export still imported into context-tree with no failures, mapping every tool part. The check was repeated.

Export and import on the repeat: the session export is 430,431 bytes; imported into context-tree it produced 128 trace events and 4 file nodes with 0 failures and 0 unmapped tools, so tool calls and results are mapped. Event stream complete against the export: yes.

The repeat run made 50 tool calls (bash 19, grep 6, read 20, edit 5), edited 1 file(s), and graded validly: F2P yes, P2P yes. Peak prompt 72,384 tokens; first-step prompt 9,619.

**3. Verification and selection are properties of the substrate.**

| Pool | Candidates | Verified three ways | Rejection stages |
| --- | --- | --- | --- |
| v1 draw (superseded) | 16 | 6/16 | gold_fails_f2p: 7; install: 1; gold_fails_p2p: 2 |
| v2 draw (scored) | 28 | 19/28 | install: 4; gold_fails_f2p: 1; tests_did_not_run: 3; gold_fails_p2p: 1 |

Walking the v2 draw: 14 candidates checked, 10 accepted, 4 rejected, 14 never checked because their stratum or repository was already full. The hardest stratum filled 2 of its 4 slots.

| Rejected candidate | Repository | Reason |
| --- | --- | --- |
| matplotlib__matplotlib-21568 | matplotlib/matplotlib | verify: gold_fails_p2p |
| astropy__astropy-8872 | astropy/astropy | verify: install |
| astropy__astropy-14369 | astropy/astropy | verify: install |
| pylint-dev__pylint-8898 | pylint-dev/pylint | verify: tests_did_not_run |

| Accepted problem | Repository | Difficulty | Calibrated P2P |
| --- | --- | --- | --- |
| scikit-learn__scikit-learn-14983 | scikit-learn/scikit-learn | <15 min fix | 104/105 |
| pytest-dev__pytest-7205 | pytest-dev/pytest | <15 min fix | 16/16 |
| psf__requests-1142 | psf/requests | <15 min fix | 5/5 |
| pylint-dev__pylint-4970 | pylint-dev/pylint | <15 min fix | 17/17 |
| pydata__xarray-6721 | pydata/xarray | 15 min - 1 hour | 1,304/1,405 |
| django__django-14034 | django/django | 15 min - 1 hour | 12/12 |
| scikit-learn__scikit-learn-14894 | scikit-learn/scikit-learn | 15 min - 1 hour | 85/85 |
| pytest-dev__pytest-8399 | pytest-dev/pytest | 15 min - 1 hour | 59/59 |
| pydata__xarray-6992 | pydata/xarray | >4 hours | 902/945 |
| django__django-11138 | django/django | 1-4 hours | 73/73 |

**4. Solvability on distinct problems (pre-registered).**

| Problem | Repo | Difficulty | Valid | Pass | F2P | P2P | Steps | Tool calls | Files edited | Files read | Peak prompt | Largest response | Total prompt | Reasoning | Cost | Wall s | Last step ended | Error |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| scikit-learn__scikit-learn-14983 | scikit-learn/scikit-learn | <15 min fix | yes | yes | yes | yes | 27 | 28 | 1 | 2 | 48,844 | 10,739 | 931,182 | 23,749 | $0.21 | 522 | stop |  |
| scikit-learn__scikit-learn-14894 | scikit-learn/scikit-learn | 15 min - 1 hour | yes | yes | yes | yes | 11 | 10 | 1 | 1 | 30,714 | 1,639 | 289,093 | 3,857 | $0.06 | 166 | stop |  |
| psf__requests-1142 | psf/requests | <15 min fix | yes | yes | yes | yes | 31 | 36 | 1 | 3 | 49,573 | 9,688 | 984,736 | 21,855 | $0.23 | 515 | stop |  |
| pytest-dev__pytest-7205 | pytest-dev/pytest | <15 min fix | yes | yes | yes | yes | 20 | 25 | 2 | 7 | 35,883 | 4,387 | 539,010 | 11,446 | $0.12 | 344 | stop |  |
| pytest-dev__pytest-8399 | pytest-dev/pytest | 15 min - 1 hour | yes | yes | yes | yes | 42 | 46 | 3 | 2 | 51,369 | 2,426 | 1,546,359 | 10,883 | $0.28 | 417 | stop |  |
| pylint-dev__pylint-4970 | pylint-dev/pylint | <15 min fix | yes | yes | yes | yes | 55 | 59 | 1 | 5 | 77,363 | 3,083 | 2,860,338 | 21,938 | $0.51 | 657 | stop |  |
| pydata__xarray-6721 | pydata/xarray | 15 min - 1 hour | yes | yes | yes | yes | 16 | 21 | 1 | 3 | 25,929 | 1,931 | 332,155 | 4,804 | $0.07 | 226 | stop |  |
| pydata__xarray-6992 | pydata/xarray | >4 hours | yes | no | no | yes | 41 | 45 | 1 | 4 | 53,689 | 2,410 | 1,453,624 | 15,653 | $0.28 | 512 | stop |  |
| django__django-14034 | django/django | 15 min - 1 hour | yes | no | no | yes | 19 | 22 | 1 | 4 | 56,018 | 15,052 | 691,688 | 29,102 | $0.19 | 610 | stop |  |
| django__django-11138 | django/django | 1-4 hours | no — output cap | no | no | yes | 4 | 5 | 0 | 0 | 15,362 | 16,384 | 50,816 | 16,705 | $0.05 | 300 | length |  |

Pooled over validly run problems: solved 7/9 (78%; 95% CI 45%–94%). Resampling unit: the problem. 0 valid run(s) edited no file; 0 fixed the reported bug but broke an existing test.

**Invalid run: per-response output cap.** django__django-11138 made 4 steps; its last step reasoned for 16,384 tokens, produced no visible output, and ended with finish reason `length`. opencode then exited normally with no edit. The limit was the `limit.output` placeholder in the pilot's own opencode configuration, not a property of the model or the task. It was first scored as a failure; that was wrong, and it is now excluded. The largest single response in any valid run was 15,052 tokens (django__django-14034), which finished normally, and no valid run ended on `length`.

**Sensitivity (post hoc).** Counting the invalid run as a failure, as first scored: solved 7/10 (70%; 95% CI 40%–89%); solved and above 32,768 tokens 5/10 (50%; 95% CI 24%–76%). Valid runs: scikit-learn__scikit-learn-14983, scikit-learn__scikit-learn-14894, psf__requests-1142, pytest-dev__pytest-7205, pytest-dev__pytest-8399, pylint-dev__pylint-4970, pydata__xarray-6721, pydata__xarray-6992, django__django-14034. Invalid: django__django-11138.

| Repository (valid runs) | Problems | Solved |
| --- | --- | --- |
| django/django | 1 | 0/1 (0%; 95% CI 0%–79%) |
| psf/requests | 1 | 1/1 (100%; 95% CI 21%–100%) |
| pydata/xarray | 2 | 1/2 (50%; 95% CI 9%–91%) |
| pylint-dev/pylint | 1 | 1/1 (100%; 95% CI 21%–100%) |
| pytest-dev/pytest | 2 | 2/2 (100%; 95% CI 34%–100%) |
| scikit-learn/scikit-learn | 2 | 2/2 (100%; 95% CI 34%–100%) |

| Difficulty (valid runs) | Problems | Solved |
| --- | --- | --- |
| <15 min fix | 4 | 4/4 (100%; 95% CI 51%–100%) |
| 15 min - 1 hour | 4 | 3/4 (75%; 95% CI 30%–95%) |
| >4 hours | 1 | 0/1 (0%; 95% CI 0%–79%) |

No run errored and no grade was void.

Every accepted problem was run.

**5. Re-run of the invalidated problem (separate; not pooled).**

django__django-11138 was run once more with the cap out of the way. It is **not comparable** to the other runs and is not included in any rate above, because it differs on 2 variables at once: (1) endpoint and weights — the local quantized GGUF (`local/unsloth/Qwen3.8-27B-GGUF`) instead of the hosted OpenRouter model; (2) per-response limit — 128,320 tokens instead of 16,384. Thinking in the re-run was on: no thinking option was set, and the transcript contains 86 reasoning parts (114,067 characters of reasoning text), as in the scored runs. It answers only whether this problem is solvable once the cap is not in the way.

3 earlier re-run attempts were killed before finishing, and are invalid, not failures: rerun a after 283 s (38 steps, 39 tool calls, no edit); rerun b after 106 s (7 steps, 9 tool calls, no edit); rerun c after 117 s (10 steps, 12 tool calls, no edit). Cause: another session on the host ran a cleanup that sent SIGTERM to every process named `opencode` between its own test runs (confirmed by that session). The table below is attempt d.

| Killed run | Signal | Ended (UTC) | Wall s | Steps | Other opencode runs live at start / peak | Cause |
| --- | --- | --- | --- | --- | --- | --- |
| probe | SIGTERM | not recorded (runner predates this field) | 229 | 8 | not recorded | confirmed |
| rerun a | SIGTERM | 2026-09-15T20:55:09.009Z | 283 | 38 | 0 / 1 | confirmed |
| rerun b | SIGTERM | 2026-09-15T20:57:40.944Z | 106 | 7 | 1 / 1 | confirmed |
| rerun c | SIGTERM | 2026-09-15T21:04:29.475Z | 117 | 10 | 1 / 2 | confirmed |

Each kill came within seconds of that session launching its next opencode step, which is what identified the cause before it was confirmed. From the final attempt on, the "other opencode runs" counts include a decoy process placed on the host to identify the sender of any further kill; it is not a model client.

| Quantity | Value |
| --- | --- |
| Valid run | yes |
| Other opencode runs live at start / peak | 1 / 1 |
| Pass | yes |
| F2P fixed | yes |
| P2P kept | yes |
| Steps / tool calls | 86 / 96 |
| Files edited | django/db/backends/mysql/operations.py, django/db/backends/oracle/operations.py, django/db/backends/sqlite3/base.py, django/db/backends/sqlite3/operations.py |
| Peak prompt | 121,020 |
| Largest single response | 3,421 |
| Steps ending on `length` | 0 |
| Reasoning parts / characters (from the transcript) | 86 / 114,067 |
| Reasoning tokens as reported by the local host | 0 (not comparable; see caveats) |
| Wall seconds | 1,709 |
| Last step ended | stop |

**6. Context pressure among solved problems (pre-registered).**

_(chart in the HTML version)_

Of 7 solved problem(s), 5 exceeded 32,768 prompt tokens and 7 exceeded 9,500. Across all 9 validly run problems, 7 exceeded 32,768; median peak 49,573. The primary threshold is the smallest context length commonly deployed for local models of this class; the secondary is the largest artificial cap the project's window sweeps used, and it now sits close to opencode's own fixed overhead of about 9,898 tokens per call.

**7. The joint gate (pre-registered; computed over valid runs).**

| Quantity | Value |
| --- | --- |
| Problems both solved and above the primary threshold | 5/9 (56%; 95% CI 27%–81%) |
| Admission rate (accepted / checked candidates) | 10/14 (71%) |
| Eligible pool | 380 |
| Projected usable problems (pool × admission × joint rate) | 150.8 (95% interval on the joint rate: 72.4–220.2; admission rate taken as a point estimate) |
| Needed for a between-problem sweep | 13 |
| Verdict | usable |

Spend: $2.01 on the 10 tranche runs and $0.52 on the OpenRouter homegrown-loop diagnosis (provider-reported). Output tokens 45,603, of which reasoning 159,992.

## What we got wrong

- The pilot as first specified ran one instance three times. Three repeats of one problem is one problem: the same weakness (C0) SWE-bench was brought in to fix. It was replaced by a seeded draw of distinct problems.
- The first result, 0/3 with no edits, was drafted as a negative solvability verdict. It was a harness defect: the homegrown loop showed the agent at most 2,000 characters of any tool result, a size tuned to the synthetic task's small files. Across two endpoints, edits went from 0/6 at that limit to 5/6 at 30,000 characters.
- The pilot measured with an in-repo agent loop, against the project's own decision D20 that evaluation runs in an external host. The scored runs were moved to opencode. The homegrown-loop results remain on disk, labelled by vehicle, and are used only for the diagnosis above.
- A per-response output cap of 16,384 tokens invalidated django__django-11138. The value was an undefended placeholder in `limit.output` of the pilot's own opencode configuration, copied from the local model entry into the OpenRouter entry. With thinking on, the model spent the whole budget reasoning in one step and opencode exited normally with no edit. This report first described that run as an ordinary failure and scored it; that classification was wrong. It is now invalid, the headline counts only valid runs (7/9), and a separate re-run is reported with its differences stated.
- The tranche ran with unpinned OpenRouter routing. OpenRouter serves `qwen/qwen3.8-27b` from 16 backends that differ in maximum response (32,768–235,929 tokens), precision (fp4 to bf16) and context (65,536–1,000,000) (OpenRouter /api/v1/models/qwen/qwen3.8-27b/endpoints, queried 2026-09-15). opencode's export records only `providerID: openrouter`, so **the serving backend, and therefore the precision, is unknown for every scored run**, and may have changed between steps. The homegrown-loop diagnosis, which did record the backend per call, saw DekaLLM, Reka serve calls, with 5 of 6 runs switching backend mid-run. Because every backend allows at least 32,768 response tokens, the pilot's own 16,384 cap was the binding response limit in every run. The OpenRouter entry is now pinned to one backend and precision with no fallback.
- The first draw (v1) was superseded before any agent ran on it. Most of its rejections were provisioner defects (unpinned current pytest and NumPy against period code, a pytest option older pytest rejects, an editable install without a modern build backend), not properties of the instances.
- Grader defects found during admission, each fixed before any scored run: Django writes test results to stderr, so a passing run looked empty; pytest aborts a whole run on one unresolvable test id, so grading now runs test files; SWE-bench records some pytest ids truncated at a space, so the grader matches that form; the period pytest prints its version to stderr; and scikit-learn's compiled extensions were not built because the check read the shared clone rather than the commit. The first tranche launch was stopped during admission because of these.
- Selection amendment (2026-09-15, after v2 verification began, before any tranche agent run): exclude a candidate whose FAIL_TO_PASS test files are disjoint from every file the test patch or gold patch touches (f2pOverlapsPatch). Reason: django__django-10097 verified-looking but its 438 F2P ids live in modules the fix never reaches: they pass with or without the gold patch, so they cannot detect a fix.
- Selection amendment (2026-09-15, after the first selection-only admission, before any scored agent run): the patch-line leak check applies only to harness-authored text (system prompt + framing); test ids and failing-test names remain forbidden in the verbatim issue too. Reason: 6 of 28 candidates were rejected because their issue quotes the buggy line or a reproducer that the test patch copies; that is benchmark content, and rejecting it biases the sample toward code-free issues.
- Selection amendment (2026-09-15, after the first selection-only admission, before any scored agent run): P2P is calibrated to this environment: grade on the dataset P2P ids that PASS on the gold patch here; admit only if every F2P passes on gold and at least 0.9 of dataset P2P is kept; every dropped id is recorded. Reason: official ids were produced in Docker images; here some P2P tests are skipped for missing optional packages (xarray sparse/bottleneck/cftime) or carry absolute-path parameter ids (requests-6028). A test that does not pass on gold in this environment cannot grade an agent. The 0.90 floor was set after seeing one instance's ratio (requests-6028, 175/185) but before any agent result existed.
- The ≥90% calibrated-P2P floor is a post-hoc amendment to the gate. It was set after seeing one instance's ratio (requests-6028), mid-selection, before any agent result existed. It admitted 3 problem(s) that would otherwise have been rejected: scikit-learn__scikit-learn-14983 (104/105), pydata__xarray-6721 (1,304/1,405), pydata__xarray-6992 (902/945).
- The first opencode runner captured `opencode export` and the event stream through pipes. opencode exits before flushing a large final write into a pipe, so the development-instance export arrived cut off at 146,176 of 430,431 bytes. The runner now writes to files. The scored runs had already started with pipe capture, so every session was re-exported to a file afterwards from its preserved session store, and each event stream was checked against its export: 10 of 10 streams were complete.
- An arm with thinking enabled in the homegrown loop was started on the contended local server with the network timeout removed; one call hung for over 25 minutes and the arm was killed with no data. No conclusion about thinking mode is drawn from it.
- The first grader split pytest summary lines on whitespace, so a parametrised test id containing a space would have been scored missing and a correct fix failed; a unit test caught it before any scored run.

## Conclusions

**Established.** The zero-edit result on the development instance was caused by the homegrown loop's output clip, reproduced on two endpoints; it says nothing about SWE-bench or the model. With opencode, uncapped, the model solved 78% of 9 validly run, distinct, verified problems (95% CI 45%–94%), and 5 solved problem(s) exceeded 32,768 prompt tokens. One further problem's run was invalidated by the pilot's own output-cap placeholder; its separate re-run solved it, under a configuration not comparable to the rest.

**What it licenses.** Planning a between-problem window/eviction sweep on SWE-bench Verified with opencode, drawn from the same pool. Any future window experiment on opencode must set caps well above its ~9,898-token fixed overhead, and must set the per-response output limit deliberately; the synthetic-task design with a 4,700-token cap cannot be reproduced on this host.

**What it does not license.** It does not show the model cannot solve SWE-bench in general: the set is small and each problem ran once. It does not rank window policies. It is not comparable with the project's earlier local results, which used different weights and a different agent loop. Repositories that failed verification are untested, not rejected.

## Caveats

- 9 validly run distinct problems from 6 repositories, one run each; per-repository and per-difficulty rates rest on one or two problems.
- Scored runs used `openrouter/qwen/qwen3.8-27b` through OpenRouter; provider precision differs from the project's local quantized model, providers can change between calls, and temperature is the host default, so runs are not reproducible bit for bit.
- **Serving backend unknown.** All 10 tranche runs used unpinned OpenRouter routing and their exports do not record the backend, so each run (possibly each step) may have been served at a different precision (fp4 to bf16) with a different backend response cap; the data cannot tell which, and no per-run backend is estimated here.
- The OpenRouter entry in experiments/context-dedup/opencode.json has since been pinned (`provider.order: ["DeepInfra"]`, `quantizations: ["bf16"]`, `allow_fallbacks: false`) with `limit.output: 235,929` taken from that backend's published maximum. Every future OpenRouter run must use the pinned entry and record `provider.order`, `quantizations` and `limit.output` in its manifest; none of the scored runs here did.
- The re-run of django__django-11138 used a per-response limit of 128,320. When the local host's limit was raised, it also accepted a request one token above the configured maximum, so it likely clamps silently rather than rejecting; the effective limit there is the host's, not the configuration's.
- The local host does not report reasoning tokens: its usage shows `reasoning_tokens: 0` while its responses carry reasoning text, which it counts as output. Reasoning-token totals are therefore not comparable between the local endpoint and OpenRouter (which reports them separately). Whether a run reasoned is measured from its transcript's reasoning parts.
- The re-run of django__django-11138 changed endpoint and weights, and per-response limit at once; its outcome cannot be attributed to any one of them and is not pooled with the other runs. It shared the local host with other sessions (up to 4 concurrent connections are served).
- Process note: the finalize step (re-export, event check, context-tree import) was executed once more by accident at 15:54 when another session imported the script to inspect it. It is idempotent: it rebuilds from the untouched worker result files and run directories and clears each context-tree store before importing, so only timestamps changed; the tranche file was re-checked afterwards (10 cells, 10 complete event streams, 10 clean imports). The script now has a main guard.
- 4 opencode runs in this pilot (the first development-instance check and 3 re-run attempts) were killed by an external SIGTERM; for all 4 the cause is confirmed: another session on the host ran a cleanup that sent SIGTERM to every process named `opencode` between its own test runs (confirmed by that session). The last of these came after that session believed it had stopped: a background batch it thought was gone was still running and executed its kill loops. All were voided and repeated, never scored.
- opencode makes a model call during start-up (session titling) before a session exists. If all 4 connection slots on the local host are in use, a run hangs silently at start-up with no error; local-slot exhaustion is invisible through opencode.
- opencode also calls a separate small model (`openrouter/google/gemini-3.8-flash`) to title each session; it does not act in the workspace, but it is an extra model call in every run.
- The vehicle is opencode 1.18.31, which is a deployment host, but with isolated state, `--auto` permissions, and a scratch copy of the repository with the project interpreter placed first on PATH.
- Grading uses calibrated P2P: tests that do not pass with the gold patch in this non-Docker environment are dropped, so a regression in one of them would go undetected.
- The selection rule was amended three times before any scored run, and one run was reclassified as invalid after the tranche; each change is listed above with its reason.
- With thinking on, a single step can spend a whole per-response budget on reasoning and opencode then ends the session with a normal exit. The runner now records each step's finish reason and the largest response, so such stops are detectable.
- The host is shared: one opencode run was killed by a signal from outside the harness. Runs record whether a kill was external and how many other opencode runs were active; an externally killed run is never scored.
- Pressure is the largest provider-reported prompt, including cached input. It says whether a window would bind, not which content a policy would need to keep.
- The pressure thresholds and the 13-problem sweep size are pre-registered judgments; the verdict is stated against them explicitly.
- The Wilson interval is the shared implementation in experiments/context-dedup/stats.mjs, cross-checked against statsmodels `proportion_confint(method="wilson")` on six (successes, n) pairs including 0/n and n/n; the largest difference was below 1e-5.

