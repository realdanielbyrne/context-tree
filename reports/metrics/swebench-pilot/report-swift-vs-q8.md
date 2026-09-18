# The same score for half the thinking

*A reasoning-efficient fine-tune against the stock model on the same ten SWE-bench problems: identical solve rate, 50% less thinking, 44% less wall time.*

## Abstract

This project measures context-management policies by running a coding agent on real software issues, so the model underneath the agent is the instrument, not the subject. Choosing it is a measurement decision: a cheaper instrument buys more repeats per GPU-hour, and a noisier one buys fewer usable results. We compared two deployable versions of the same 27B base — a reasoning-efficient fine-tune, ukisai/Swift-Qwen3.8-27b, served here as HuggingJoost/Swift-Qwen3.8-27B-NVFP4-GGUF, and the stock model served as unsloth/Qwen3.8-27B-GGUF — on identical work.

10 SWE-bench Verified problems, 3 repeats each, 30 runs per arm. Same sandbox, same prompt, same host, same 151,040-token context, same grading. The only thing that differs is the weights.

They score the same: **19 of 30** each. They agree on 8 of 10 problems — 5 solved on every repeat by both, 3 solved by neither — and the 2 problems where they differ split 1 to 1, which is no evidence of a difference in either direction. On cost they do not tie. The fine-tune is lower on 9 of 10 problems for peak prompt size, thinking volume, output tokens and wall time alike (sign test p = 0.021 on each): median ratios of 0.70x peak, 0.50x thinking, 0.56x wall time.

The mechanism matters more to this project than the saving. Thinking volume is trajectory length times verbosity per step, and the larger factor is verbosity: a median 0.70x on characters per step against 0.83x on step count. The agent walks roughly the same route through a problem and writes considerably less at each stop. Re-imported under one segmenter, the two arms decompose into 258 and 262 phases from 3,000 and 3,480 trace events — the tree this project builds is essentially unchanged by a 14% reduction in raw trace volume.

The limits are real and they are about attribution, not about the numbers. The two artifacts differ in quantization as well as in fine-tune, so this measures two deployable builds and not the adapter in isolation. The pool leaves only 2 problems able to move, so "no accuracy difference" means none was detectable here, not that none exists. And thinking volume is counted in characters, because the local server reports no reasoning-token count.

## What was compared

Both arms run the same harness: opencode 1.18.31 in a bubblewrap sandbox with no network beyond a relay to the local model server, no access to the dataset, the upstream repositories, or the operator's home directory. The agent gets the issue text and nothing that names the fix. After it exits, the held-out test patch is applied and the problem's own tests decide the outcome.

|  | Swift | base |
| --- | --- | --- |
| Model served | HuggingJoost/Swift-Qwen3.8-27B-NVFP4-GGUF | unsloth/Qwen3.8-27B-GGUF |
| Upstream weights | ukisai/Swift-Qwen3.8-27b (fine-tune of Qwen/Qwen3.8-27B) | Qwen/Qwen3.8-27B (stock) |
| Problems x repeats | 10 x 3 | 10 x 3 |
| Context limit | 151,040 | 151,040 |
| Output cap | 32,000 | 32,000 |
| Median first-step prompt | 8,116 | 8,100 |
| Runs with a clean exit | 30 of 30 | 30 of 30 |
| Runs graded | 30 of 30 | 30 of 30 |
| Sandbox preflight fully green | 30 of 30 | 30 of 30 |
| Runs leaving a real code change | 30 of 30 | 30 of 30 |

The median first-step prompt differs by 16 tokens, which is the system block, the tool schemas and the issue text — identical by construction. Anything that follows is the model's own behaviour, not a difference in what it was asked.

## Accuracy: a tie, on a pool that could barely show otherwise

Both arms solve 19 of 30 runs. Pairing is on pass count per problem rather than on a binary outcome, because 3 repeats of one problem are not 3 independent observations and the same problems are perfectly stable in both arms.

_(chart in the HTML version)_

| Problem | Repo | Swift solved | base solved | Agree |
| --- | --- | --- | --- | --- |
| scikit-learn-14983 | scikit-learn/scikit-learn | 2/3 (FPP) | 1/3 (FFP) | no |
| pytest-7205 | pytest-dev/pytest | 3/3 (PPP) | 3/3 (PPP) | yes |
| requests-1142 | psf/requests | 3/3 (PPP) | 3/3 (PPP) | yes |
| pylint-4970 | pylint-dev/pylint | 0/3 (FFF) | 0/3 (FFF) | yes |
| xarray-6721 | pydata/xarray | 2/3 (FPP) | 3/3 (PPP) | no |
| django-14034 | django/django | 0/3 (FFF) | 0/3 (FFF) | yes |
| scikit-learn-14894 | scikit-learn/scikit-learn | 3/3 (PPP) | 3/3 (PPP) | yes |
| pytest-8399 | pytest-dev/pytest | 3/3 (PPP) | 3/3 (PPP) | yes |
| xarray-6992 | pydata/xarray | 0/3 (FFF) | 0/3 (FFF) | yes |
| django-11138 | django/django | 3/3 (PPP) | 3/3 (PPP) | yes |

5 problems are solved on every repeat by both arms and 3 by neither, so 8 of 10 problems cannot distinguish the models at all. The 2 that move split one each way: scikit-learn-14983 2/3 vs 1/3, xarray-6721 2/3 vs 3/3. A design with 2 discordant units has no power to speak of — the honest statement is that no accuracy difference was detectable on this pool, not that the two models are equivalent.

That three problems fail on every repeat of **both** quantizations — pylint-4970, django-14034, xarray-6992, 18 runs in total — is worth recording separately. These are not one model's blind spot; they are the headroom this pool offers to anything that changes how the agent manages its context.

## Cost: lower on nine problems out of ten, on every axis

_(chart in the HTML version)_

| Measure | Swift median run | base median run | Median per-problem ratio | Swift lower on | Sign test p |
| --- | --- | --- | --- | --- | --- |
| Peak prompt tokens | 45,593 | 61,932 | 0.70x | 9/10 | 0.021 |
| Thinking characters | 51,997 | 95,420 | 0.50x | 9/10 | 0.021 |
| Output tokens | 19,497 | 31,330 | 0.54x | 9/10 | 0.021 |
| Wall seconds | 312 | 416 | 0.56x | 9/10 | 0.021 |
| Tool calls | 33 | 35 | 0.77x | 8/9 | 0.039 |
| Steps | 32 | 34 | 0.83x | 6/9 | 0.508 |

The sign test counts only the problems where the two arms differ, so a measure on which one problem ties is tested over 9 rather than 10. Across the whole batch the difference is 4.2 against 4.8 GPU-hours, 811,715 against 1,139,716 output tokens, and 2,296,332 against 3,411,071 characters of thinking. At equal wall time that is room for 15% more runs, for no measured loss.

One problem runs the other way, and it is a variance story rather than a weights story. On xarray-6721 the fine-tune's 3 repeats peaked at 105,339, 84,429, 31,502 tokens and the stock model's at 26,046, 80,670, 35,757 — both models have a cheap route and an expensive one through it, and each drew differently. Within a single problem, with nothing varied, peak prompt size moves by as much as 3.34x in the Swift arm and 4.17x in the base arm. That is why the sign test across problems is the statistic here and no individual ratio is.

## Where the saving comes from

Thinking volume per run is trajectory length times verbosity per step, and the two factors can be read separately. The trajectory shortens a little — median 0.83x on steps (6 of 9 problems, p = 0.51) and 0.77x on tool calls (8 of 9, p = 0.04). Verbosity falls further: median 0.70x on thinking characters per step (8 of 10, p = 0.11). Neither the step count nor the per-step volume separates the arms on its own; multiplied together they give the 0.50x that does (p = 0.021). The agent walks a similar route to the fix and writes less at each stop, and the accumulated transcript is smaller as a result.

|  | Swift | base |
| --- | --- | --- |
| Median thinking characters per step | 1,738 | 2,541 |
| Median largest single response (tokens) | 3,586 | 5,346 |
| Largest single response anywhere (tokens) | 8,004 | 32,000 |
| Steps ending on the 32,000-token output cap | 0 | 1 |
| Tool calls that errored | 8 of 1,247 | 14 of 1,445 |
| Runs the host had to compact (threshold 119,040) | 4 of 30 | 5 of 30 |
| Compaction events in total | 4 | 7 |

The output cap is an instrument hazard rather than a cost line. The stock model hit it once, on a run that still passed; the fine-tune's largest single response anywhere was 8,004 tokens, a quarter of the cap. A step truncated at the cap is a run whose validity has to be argued rather than assumed, and this harness excludes such runs by a rule fixed in advance.

## What it means for context-tree

Segmentation is the project's own view of a trace, so the two arms were re-imported under a single segmenter for this comparison — the counts stored in each results file were taken on opposite sides of a segmenter change (D21) and would report that change as a model difference.

| Re-imported under one segmenter | Swift | base |
| --- | --- | --- |
| Trace events | 3,000 | 3,480 |
| Phases | 258 | 262 |
| Nodes | 364 | 359 |
| File nodes | 76 | 67 |

14% fewer trace events produce 2% fewer phases. The work decomposes into the same structure either way, which is the useful result: the tree's shape is a property of the problems, and a policy tuned against one of these models is not being tuned against its verbosity.

One consequence to carry into the window experiments. At a soft limit of one third of the context (50,346 tokens), 13 of 30 runs in the Swift arm ever exceed it, across 7 of 10 problems; under base it is 19 of 30 across 8. Picking the cheaper instrument also shrinks the set of runs on which a soft-limit arm can bind at all, so an arm that never fires on the Swift baseline is a statement about this pool's pressure and not about the policy.

## Against the publisher's own numbers

These are claims from the model card, quoted for comparison, not measurements of ours. The card reports 58.3% fewer thinking tokens with under 1% performance loss and a 1.95x speed-up. The headline reduction is the **median** figure on GPQA-Diamond specifically; the mean reduction on that benchmark is 41.0%, and the closest published row to the work measured here is Terminal-Bench 2.1.

|  | Accuracy | Thinking reduction | Basis |
| --- | --- | --- | --- |
| Card: Terminal-Bench 2.1 | 66.74% -> 65.84% (-0.90 pp) | 26.5% mean, 38.7% median | BF16 base vs base + adapter; BF16, vLLM, thinking xhigh, temperature 1.0 / top_p 0.95 / top_k 20 |
| Card: GPQA-Diamond | 88.38% -> 88.28% (-0.10 pp) | 41.0% mean, 58.3% median | BF16 base vs base + adapter |
| Here: SWE-bench, 10 problems x 3 | 19/30 vs 19/30 (0.00 pp) | 49.5% median per problem | two quantized GGUF builds, agent harness, host defaults |

The direction agrees and the magnitude is larger than the card's agentic row, on a different substrate at different precisions with different sampling settings. Nothing here replicates the card and nothing here contradicts it; the useful reading is that the published efficiency claim survives contact with a real agent loop on this pool.

## Limits

- **This does not isolate the fine-tune.** The two artifacts differ in quantization as well as in weights: HuggingJoost/Swift-Qwen3.8-27B-NVFP4-GGUF against unsloth/Qwen3.8-27B-GGUF, from different publishers at different precisions. The publisher's own evaluations compare a BF16 base with the same BF16 base plus the adapter; this compares two deployable builds. Every result here is about those builds.
- **The pool cannot support an equivalence claim.** 8 of 10 problems are pinned at 3/3 or 0/3 in both arms, leaving 2 that can move. "No accuracy difference" means none was detectable at this sample size.
- **Thinking volume is characters, not tokens.** The local server reports no reasoning-token count (every cell records 0), so the reasoning text exported by the host is measured directly. The two models share a tokenizer family, so the ratio is a fair proxy for the token ratio, but it is a proxy.
- **One instrument, one pool, 30 runs per arm.** Ten problems from six repositories, chosen by a seeded rule before any agent ran. Nothing here generalises to other benchmarks or other agent hosts.
- **Per-problem medians are noisy.** 3 repeats per problem, against a within-problem spread in peak prompt size of up to 3.34x (Swift) and 4.17x (base) with nothing varied. The sign test across problems is the load-bearing statistic; individual ratios are illustration.
- **Wall time carries an unrecorded covariate.** The local server auto-selects a speculative-decoding drafter at load, and it differs by build (the Swift build was observed running n-gram speculation; the MTP head each GGUF carries is the alternative). No results file records which was active. Rejection sampling makes speculative decoding output-distribution-preserving, so solve rate, token counts and thinking volume are unaffected — but the 0.56x wall-time ratio may be partly the drafter rather than the fine-tune. The thinking-volume result does not depend on it.
- **Sampling is the host's default, not the publisher's recipe.** Thinking is on; no reasoning-effort level was set; temperature and top-p are whatever opencode sends. The card's numbers come from BF16, vLLM, thinking xhigh, temperature 1.0 / top_p 0.95 / top_k 20.
- **Grading uses calibrated pass-to-pass tests** — tests that cannot pass with the official fix in this non-Docker environment are dropped, so a regression in one of them would go unseen. Both arms are graded identically, so this cannot favour either.

## Conclusion

For this project's purposes the choice is settled. The fine-tune scores what the stock model scores and costs less on every axis that separates them, so it becomes the baseline instrument — and the 4.8 GPU-hours spent on the stock arm are what make that a measured choice rather than an assumed one. The 3 problems neither model solves stay on the register as headroom for the context-management arms that follow.

