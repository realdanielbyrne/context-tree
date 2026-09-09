> Markdown equivalent of [tuning-summary-policy.html](./tuning-summary-policy.html). The HTML version is the canonical rendering; this file exists so the report is readable and diffable in git.

# When summaries are written, and under what policy

> **Correction (2026-09-08).** Every occupancy percentage and headroom figure below assumes
> `W = 200,000` for `claude-sonnet-5`, described in places as "this host's window". **Sonnet 5's
> context window is 1,000,000 tokens.** No `--window` was passed on these runs — `configuration`
> is absent from every `eval/results` record — so 200,000 was never the host's window; it was an
> assumption. Read every "% of window" here as **5x too high**, and every headroom figure as
> correspondingly understated: the 45,564-token peak leaves 954,436 tokens of headroom, not
> 154,436. Token counts, turn counts and crossing turns are unaffected, and the reports'
> central conclusion — that nothing here was in danger of overflowing anything — is made
> **five times stronger**, not weaker. Statements framed as "at a candidate fraction of a
> 200,000-token window" remain valid as counterfactual replays at that budget; only the claim
> that the budget *is* this host's window is wrong. See
> `metrics/attention-policy-continuation/journal.md`, iteration 1 lens 2.

Context-tree evaluation program · DS-STAR tuning pass, dimension 3 of 4 · September 2, 2026

> *Scope and provenance.* This is the full treatment of the dimension summarised in `reports/algorithm.md` under "What the DS-STAR loop is for". It re-derives every load-bearing number from the run artefacts on disk rather than from the analysis note it publishes (`eval/plans/tuning/03-summary-policy.md`), and §8 lists the figures in that note that did not reproduce as written, together with the reproduced values used here instead. No model was called for this report.

## Abstract

Context-tree is a context-management layer that rewrites an agent's linear conversation into a summary-headed tree, so that a long conversation's prompt carries one short summary per completed unit of work instead of the raw events. When it does that rewriting — and on what trigger — is the open parameter this report is about. Three things are now established. First, the target of the switch point is settled by definition rather than by fitting: the rule states the switch as the size at which the whole trace fits where the active branch's detail would go, which is the Zone C allocation, so the switch fraction and the Zone C fraction are one quantity. They have drifted apart in the code — the portability harness derives 0.35 for one and 0.20 for the other and exports both from the same function two lines apart, while the live harness's two constants agree at 30,000 only because someone chose the same number twice. Second, the trigger lags by exactly one turn, because it compares against the previous completed turn's billed prompt rather than the prompt about to be sent. That lag is measured, not argued: across the six live crossings on disk the last raw prompt sent before the switch exceeded the 30,000-token budget by 126 to 15,564 tokens, median 8,306 (n=6, claude-sonnet-5, two scenarios), and one turn of growth in that regime is a median 14,784 tokens, which is why the overshoot is that size. Removing it costs one local tokenizer pass over the candidate prompt, not a model call, provided the same measured heuristic-to-tokenizer correction the portability harness already applies is carried with it. Third, the cost of summarizing is not a standing tax but a single lump at a badly chosen moment: it is zero on every run whose trigger never fires — 0 of 0 leaf-summarizer calls on 12 long-task runs and 5 short-task runs — and 6.9% to 19.3% of run cost, median 9.4%, on the 6 runs where it does. In tokens rather than cost, the turn immediately after the switch writes a median 18,274 cache tokens against 273 for the matched no-switch arm on the turn after its own largest write (n=6 each), and whole-run cache writes rise by about 21,600 tokens per run on both scenarios. Graded score separates nothing: every cell is 3 of 3 or 5 of 5 with a mean score of 1.000, so this dimension is being judged on tokens and turns alone. Finally, the fraction grid that would decide the switch fraction can be replayed over data already recorded: at 0.15 of a 200,000-token window — which is what the live constant is on that host — all 12 fully devolved trajectories cross, at 0.20 one of 12 crosses, and at 0.25 and above none do. That is a counterfactual replay, not a live measurement, and every number here comes from one model family, one window size and one epoch per cell.

## 1. Terms, and what is being measured

A **turn** is one model call inside a run: the harness sends a prompt, the model answers, tool results come back, the next turn begins. **Context size per turn** is the number of tokens the model saw on that call — fresh input plus **cache-read** tokens plus **cache-write** tokens, as the provider reports them. A cache read is a token the provider served from a previously stored prefix; a cache write is a token it had to store fresh because the prefix changed. The three partition one thing, the prompt, so they are added. Output tokens are excluded from context and included in a run's total token bill.

An **arm** is one context policy, holding model and task fixed. The **native transcript** baseline (`native`) re-sends the whole conversation every turn. **Context-tree** (`context-tree`) segments the event log into **branches** — contiguous stretches of work on one sub-problem — and, once a branch closes, has a cheap **leaf summarizer** write a summary of it. The prompt is assembled in three fixed sections: **Zone A** is the frozen contract, **Zone B** holds the root index and branch summaries in creation order, and **Zone C** holds the active branch's raw detail. **W** is the model's context window.

Two terms name the thing under test. **Devolved mode** is context-tree showing the whole raw trace and summarizing nothing, on the argument that summarizing a short conversation spends model calls for no benefit. The **switch point** (in the live harness, the **lazy gate**, `EVAL_LAZY_TOKENS`) is the prompt size at which it stops doing that and starts summarizing. Every live number below is from a 30,000-token absolute gate. The **heuristic-to-tokenizer ratio** is the measured factor between the assembler's own cheap token count and the provider's billed count on this corpus, 0.851 (`eval/test/transplant.test.ts:169` pins it at 0.850896663206653); a heuristic count therefore runs about 17.5% above the provider's on the same text.

**Measured** below means read from a run artefact on disk. **Replay** means arithmetic over such an artefact under a policy that was never actually run — a counterfactual, which cannot account for the agent behaving differently under the counterfactual policy. **Hypothesis** means neither.

Statistics follow the program's convention: mean for graded score, median for tokens and turns, n stated everywhere. Every run quoted here carries status `completed` and a real graded outcome; none was stopped by the harness, so none of the fabricated-failure correction that `reports/algorithm.md` describes for ceiling-stopped runs applies to any figure in this report. That is stated because the correction did apply to a previously published reliability claim, not because it is routine.

The runs are four batches, all claude-sonnet-5 as the agent and `claude-haiku-4-5-20251001` as the leaf summarizer. `long-v6x` (1 September 2026) is native and context-tree on two long scenarios, three replicates each. `long-v64` (1 September) is the context-tree arm after a cache-churn fix, three replicates per scenario, whose gate never fired. `long-v65-gate` (2 September) is the same arm with the trigger reading real tokens, three replicates per scenario, whose gate fired once per run. `sw3-loop9b` is five replicates of a short scenario with its own same-batch native baseline. The two long scenarios are **sw-5-dozen**, twelve independently buggy modules, and **sw-6-ripple**, an interface migration across ten dependent files; each carries about 60 kB of material and a hidden test suite. The one-day gap between the 1 and 2 September batches is the standing asymmetry in every long-task comparison here and is flagged again at each table.

## 2. What two earlier reports said, and what this pass adds

Two reports reached this dimension independently from different data. The short-task report states it as a ranking of causes: "Where the leverage actually is: not selection, but (a) *when* summarization runs (lazy/off-critical-path was worth −48% cost) and (b) *what model* does it" (`reports/metrics/context-tree-dsa-arm-experiments.md:97`). The long-task report states it as a sequencing rule: make the mechanism measurable, "then cut the summarizer cost floor (per-node breaker live-run, append-only summaries, cosine dedup, haiku root), and only then run the tree-dsa hyperparameter search — tuning before the mechanism fires would re-measure the floor" (`reports/metrics/context-tree-long-task-dsa-iterations.md:17`). Neither measured the switch point in isolation, because until 2 September no live run had ever crossed it: the loop-8 interim report records that in all 24 of its long-task runs "the summarization machinery never engaged" (`reports/metrics/loop8-interim.md:139`), the gate having compared an estimate of characters divided by four against 30,000 while the real tokenizer charges more than that for code-dense text.

What this pass adds is the first isolation of the timing question itself: the six crossings that exist, the separation of the trigger's lag from the trigger's threshold, the separation of the summarizer's cost from the reorganization's cost, and a fraction grid replayed at zero spend.

## 3. The switch point's target is the Zone C fraction

The rule in `reports/algorithm.md` defines the switch as the size at which the whole trace fits where the active branch's detail would go. That sentence describes Zone C's allocation by definition: Zone C *is* the space that holds the active branch's raw detail once the tree stops showing the raw trace. So the switch point is not a free parameter alongside the Zone C budget; it is the same number, and any code in which the two differ has drifted from the rule rather than implemented a second design decision. This is a reading of the specification, not a measurement, and it is stated first because it settles what the grid in §6 is a grid over.

Two facts from the code make the drift concrete. In the portability harness the two fractions are literally adjacent and disagree: `FRACTIONS` sets `lazy: 0.35` against `zoneC: 0.2` (`eval/scripts/transplant.mjs:103`), both are divided by the same measured ratio in the same function (`deriveBudgets`, `transplant.mjs:345-375`), and both are then exported to the live loop from two consecutive lines — `process.env.EVAL_LAZY_TOKENS = String(budgets.lazy)` followed by a log line carrying `--zone-c-budget=${budgets.zoneC}` (`transplant.mjs:3238-3240`). Every recorded transplant run shows the pair as derived: at W = 16,384, `lazy` 6,739 against `zoneC` 3,850; at W = 32,768, 13,478 against 7,701. In the live harness the same two quantities agree, at the literal 30,000 each, but neither is computed from the other or from W — `packages/core` has no representation of W anywhere, which the core portability audit gives as its headline finding (`eval/plans/portability-audit/01-core.md`, "Headline") — so the agreement is a coincidence of two hand-picked numbers, and the place where a derivation actually exists is exactly the place where the identity broke.

What the evidence does *not* do is choose 0.20 over 0.35 on tokens, turns or score. No run in either harness has used a fractional switch at all: the live batches used the absolute 30,000, and the transplant runs are single-turn assemblies in which a gate has no second turn to fire on.

## 4. The trigger lags one turn, and the lag has a size

The gate compares against `lastPromptTokens`, which is declared at `eval/src/loop.ts:820` with the comment that it holds "real tokens from the last completed turn", is assigned from `result.usage.input + result.usage.cacheRead + result.usage.cacheWrite` after each model call (`loop.ts:1035`), and is read by `belowLazyBudget()` (`loop.ts:829`). Because the trace only grows between turns, and because the comparison happens after a call rather than before one, exactly one prompt above the threshold is always sent: the first raw prompt to exceed the budget goes out in full, and only the turn after it is assembled from summaries. That is a property of the code, and Table 1 gives its measured size on every crossing on disk.

**Table 1.** The six recorded gate crossings, one row per replicate, claude-sonnet-5, 30,000-token absolute gate, `eval/results/long-v65-gate/*/results.json` with the crossings confirmed against `eval/results/long-v65-gate.log`. **crossing turn** counts the first model call as turn 1; the log prints a zero-based index, always one less. **prompt at crossing** is the context size of the last raw prompt sent, **over the budget** its excess over 30,000, **prior-turn prompt** the number the gate actually compared, and **growth in that turn** the difference between them. **cache write, next turn** is the cache-write tokens billed on the first turn assembled from summaries. The baseline row is the matched no-switch arm — the same two scenarios, same model, same three replicates each, gate never fired (`long-v64`, 1 September 2026, one day before the crossing runs): its largest prompt of the six runs, its median single-turn context growth on its own largest cache-write turn, and its median cache write on the turn after that turn.[^usd]

| Run | crossing turn | prior-turn prompt | prompt at crossing | over the budget | growth in that turn | cache write, next turn |
|---|---|---|---|---|---|---|
| sw-5-dozen r1 | 10 | 28,936 | 45,564 | +15,564 | 16,628 | 26,178 |
| sw-5-dozen r2 | 7 | 20,188 | 36,657 | +6,657 | 16,469 | 18,548 |
| sw-5-dozen r3 | 10 | 22,245 | 38,799 | +8,799 | 16,554 | 18,413 |
| sw-6-ripple r1 | 14 | 28,187 | 41,286 | +11,286 | 13,099 | 17,190 |
| sw-6-ripple r2 | 16 | 29,878 | 30,126 | +126 | 248 | 6,004 |
| sw-6-ripple r3 | 11 | 24,733 | 37,812 | +7,812 | 13,079 | 18,134 |
| **median (n = 6)** | **10.5** | **26,460** | **38,306** | **+8,306** | **14,784** | **18,274** |
| *baseline: same arm, no switch (n = 6)* | *never* | *—* | *39,208 max* | *—* | *14,696* | *273* |

Two readings follow, and they are separable. The overshoot is a median 8,306 tokens (n = 6), spanning 126 to 15,564, and its size is set by how much the trace grew during the lagging turn: a median 14,784 tokens on these tasks, with five of the six crossings growing 13,079 to 16,628 tokens in one call. The single exception is informative rather than noise: sw-6-ripple r2 grew 248 tokens in its crossing turn and consequently overshot by 126, which is what a trigger with no lag would look like everywhere. So the lag does not add a fixed cost; it adds one turn of whatever growth the task happens to be producing, and on these tasks that is about 15,000 tokens.

The fix does not require a model call. The check has to be moved ahead of dispatch and applied to the candidate prompt — the one the assembler is about to build from the current trace — using the `HeuristicTokenizer` the assembler already constructs locally (`eval/src/loop.ts:771`). That is the same class of deterministic local pass the portability harness already runs over a whole corpus in `measureRatio` (`eval/scripts/transplant.mjs:719-722`). One caveat is load-bearing and is a consequence of §1's ratio: a heuristic count of the same text runs about 17.5% above the provider's, so comparing a heuristic candidate count against a threshold expressed in provider tokens would fire early by that margin. The correction already exists — it is the division by the measured ratio inside `deriveBudgets` — and a same-turn check must import it rather than reinvent the threshold. The engineering cost is restructuring where the check runs; `loop.ts` does not do it before assembly anywhere today. That the fix is cheap is an argument from the precedent, not a benchmark: nothing in this repository has yet measured a same-turn check against the lagged one.

## 5. The cost is one lump, not a standing tax

While the gate has not been crossed, `maybeResummarize` returns before doing anything at all (`if (belowLazyBudget()) return;`, `eval/src/loop.ts:871`), so every branch that closes in devolved mode accumulates unsummarized. The first call after the crossing builds the whole stale plan (`summarizer.stalePlan(rootId)`, `loop.ts:877-883`) and drains it in one awaited batch:

```
eval/src/loop.ts:936-937
for (const nodeId of pending) summarizer.scheduleSummarize(nodeId);
await summarizer.drain();
```

After the crossing the latch keeps `belowLazyBudget()` false, so subsequent branch closes are summarized as they happen. The batch is therefore the backlog only, and the recorded artefacts do not say which of a run's leaf-summarizer calls landed on which turn — `TurnRecord` carries only the agent model's usage (`eval/src/types.ts:63-69`). The lump is established below from cache writes, which are recorded per turn, rather than from the summarizer call log, which is not.

**Table 2.** The leaf summarizer's own contribution, computed from `costByModel` in each run's `results.json`. **leaf calls** and **leaf tokens** are the `claude-haiku-4-5-20251001` entry's call count and its input plus output tokens, medians per cell; **share of run cost** is that entry's cost divided by the run's total across both models, median per cell. Per-run shares in the firing cells are 6.9, 7.6, 8.4, 13.6, 19.3 and 10.3 percent. The long-task baselines are `long-v64` and `long-v6x` (1 September 2026); the short-task rows are the tree and native arms of `sw3-loop9b`, same batch and same commit as each other. **mean score** is the graded score, and **success** the count of replicates whose hidden test suite passed. Note that a run's `metrics.tokens.total` counts the agent model only — verified by reconstruction on all six firing runs — so the leaf tokens in this table appear in no total-token figure anywhere in this program's reporting.[^usd]

| Arm and scenario | n | leaf calls | leaf tokens | share of run cost | mean score | success |
|---|---|---|---|---|---|---|
| tree, switch fires — sw-5-dozen | 3 | 2 | 18,836 | 7.6% | 1.000 | 3/3 |
| tree, switch fires — sw-6-ripple | 3 | 5 | 28,871 | 13.6% | 1.000 | 3/3 |
| **tree, switch fires — both** | **6** | **3** | **21,166** | **9.4%** | **1.000** | **6/6** |
| *baseline: tree, switch never fires (long tasks)* | *6* | *0* | *0* | *0%* | *1.000* | *6/6* |
| *baseline: native transcript (long tasks)* | *6* | *0* | *0* | *0%* | *1.000* | *6/6* |
| *baseline: tree, switch never fires (sw-3-refactor)* | *5* | *0* | *0* | *0%* | *1.000* | *5/5* |
| *baseline: native transcript (sw-3-refactor)* | *5* | *0* | *0* | *0%* | *1.000* | *5/5* |

The shape is the finding. On every run whose trigger never fires the summarizer costs exactly nothing, over 17 runs and two very different task lengths; on the runs where it fires it is a median 9.4% of run cost, and the share tracks the number of branches summarized almost monotonically (2, 2, 3, 3, 5 and 9 calls against shares of 7.6, 8.4, 6.9, 10.3, 13.6 and 19.3 percent). The largest share belongs to the run with the *smallest* overshoot — sw-6-ripple r2, 126 tokens over, 9 leaf calls, 19.3% — which means the summarizer's share is driven by how many branches a run closes after the switch, not by the crossing itself. The crossing's own price shows up somewhere else.

**Figure 1.** Cache-write tokens per turn on sw-5-dozen, the switch arm against the matched no-switch arm. Vertical axis: cache-write tokens billed on that call, meaning prompt tokens the provider had to store fresh because the prefix had changed. Horizontal axis: turn index, first model call as turn 1; a line ends where its run ended. Green is context-tree with the trigger that never fired (`long-v64`, three replicates, 1 September 2026); blue is context-tree with the real-token trigger (`long-v65-gate`, three replicates, 2 September). Ringed blue points are the three crossings, at turns 10, 7 and 10. Both arms spike once when the raw trace grows sharply, so a spike alone is not the switch. What distinguishes them is the turn *after*: the blue arm writes 26,178, 18,548 and 18,413 tokens there, where the green arm writes 270, 267 and 234 after its own largest write, because the switch invalidates the entire cached prefix and the next prompt has to be stored from scratch.

**Figure 1 data** (rendered as a table in this markdown equivalent; blank cells are turns after that run had finished; the "no switch" columns are `long-v64` replicates 1 to 3 and the "switch" columns are `long-v65-gate` replicates 1 to 3, matching the row labels of Table 1):

| Turn | no switch r1 | no switch r2 | no switch r3 | switch r1 | switch r2 | switch r3 |
|---|---|---|---|---|---|---|
| 1 | 680 | 0 | 0 | 0 | 680 | 680 |
| 2 | 149 | 179 | 165 | 479 | 192 | 231 |
| 3 | 849 | 275 | 128 | 155 | 476 | 375 |
| 4 | 494 | 141 | 244 | 141 | 425 | 141 |
| 5 | 17,088 | 161 | 420 | 848 | 7,665 | 1,181 |
| 6 | 33,319 | 848 | 16,553 | 493 | 7,398 | 493 |
| 7 | 270 | 493 | 32,543 | 17,712 | 33,003 | 6,820 |
| 8 | 277 | 17,693 | 234 | 24,181 | 18,548 | 7,640 |
| 9 | 65 | 33,831 | 65 | 250 | 208 | 1,351 |
| 10 |  | 267 |  | 40,774 | 997 | 35,164 |
| 11 |  | 280 |  | 26,178 |  | 18,413 |
| 12 |  | 65 |  | 1,307 |  | 192 |
| 13 |  |  |  | 343 |  | 452 |
| 14 |  |  |  |  |  | 241 |
| 15 |  |  |  |  |  | 283 |
| 16 |  |  |  |  |  | 1,115 |

**Figure 2.** Cache-write tokens per turn on sw-6-ripple, constructed exactly as Figure 1 and on its own vertical scale, with the horizontal axis running to 33 turns because one blue replicate ran that long. Crossings are ringed at turns 14, 16 and 11. The blue replicate that crossed 126 tokens over budget is the one whose crossing ring sits near zero: it reorganized a small trace and paid 6,004 tokens on the following turn rather than 17,190 or 18,134, and then spent seventeen more calls writing repeatedly — the 15,272 and 18,456 spikes late in that line — as the agent re-fetched detail it had just been shown.

**Figure 2 data** (rendered as a table in this markdown equivalent; blank cells are turns after that run had finished; column order is as in the Figure 1 data table):

| Turn | no switch r1 | no switch r2 | no switch r3 | switch r1 | switch r2 | switch r3 |
|---|---|---|---|---|---|---|
| 1 | 659 | 659 | 0 | 0 | 0 | 659 |
| 2 | 179 | 4,858 | 176 | 231 | 270 | 491 |
| 3 | 782 | 141 | 833 | 494 | 323 | 177 |
| 4 | 1,050 | 220 | 491 | 1,832 | 837 | 834 |
| 5 | 2,953 | 356 | 5,537 | 157 | 2,956 | 2,753 |
| 6 | 8,663 | 953 | 1,224 | 282 | 8,667 | 3,730 |
| 7 | 5,316 | 2,753 | 1,235 | 835 | 0 | 5,853 |
| 8 | 1,176 | 8,653 | 10,313 | 5,536 | 1,497 | 4,317 |
| 9 | 1,565 | 656 | 12,870 | 1,163 | 1,385 | 1,285 |
| 10 | 12,870 | 1,246 | 275 | 5,704 | 407 | 1,246 |
| 11 | 278 | 2,008 | 242 | 1,429 | 262 | 12,870 |
| 12 | 120 | 5,296 | 121 | 1,140 | 1,467 | 18,134 |
| 13 |  | 1,120 |  | 5,315 | 1,190 | 278 |
| 14 |  | 235 |  | 12,870 | 355 | 879 |
| 15 |  | 327 |  | 17,190 | 913 |  |
| 16 |  |  |  | 170 | 248 |  |
| 17 |  |  |  | 175 | 6,004 |  |
| 18 |  |  |  | 449 | 4,357 |  |
| 19 |  |  |  |  | 5,762 |  |
| 20 |  |  |  |  | 5,019 |  |
| 21 |  |  |  |  | 1,688 |  |
| 22 |  |  |  |  | 1,266 |  |
| 23 |  |  |  |  | 15,272 |  |
| 24 |  |  |  |  | 1,834 |  |
| 25 |  |  |  |  | 194 |  |
| 26 |  |  |  |  | 655 |  |
| 27 |  |  |  |  | 2,901 |  |
| 28 |  |  |  |  | 262 |  |
| 29 |  |  |  |  | 1,047 |  |
| 30 |  |  |  |  | 18,456 |  |
| 31 |  |  |  |  | 262 |  |
| 32 |  |  |  |  | 648 |  |
| 33 |  |  |  |  | 262 |  |

**Table 3.** Medians over three replicates per cell, claude-sonnet-5. **final ctx** is context size on the last turn; **total tokens** the run's whole agent-model bill including output; **cache writes** the run's cache-write tokens; **turns** the number of model calls. Each column is that column's median, so a row is not necessarily one run. The final-context, total-token and turn columns reproduce Table 1 of `reports/metrics/context-growth.md` exactly; the cache-write column is new here. Native and no-switch rows are 1 September 2026, switch rows 2 September.[^usd]

| Scenario / arm | final ctx | total tokens | cache writes | turns | mean score | success |
|---|---|---|---|---|---|---|
| *sw-5-dozen — native transcript* | *19,157* | *175,661* | *19,156* | *13* | *1.000* | *3/3* |
| *sw-5-dozen — tree, switch never fires* | *37,585* | *192,853* | *53,191* | *9* | *1.000* | *3/3* |
| sw-5-dozen — tree, switch fires | 24,299 | 260,700 | 74,772 | 13 | 1.000 | 3/3 |
| *sw-6-ripple — native transcript* | *20,191* | *168,208* | *20,190* | *12* | *1.000* | *3/3* |
| *sw-6-ripple — tree, switch never fires* | *37,615* | *244,964* | *33,317* | *12* | *1.000* | *3/3* |
| sw-6-ripple — tree, switch fires | 22,837 | 297,726 | 54,972 | 18 | 1.000 | 3/3 |

The transition's price, in tokens rather than cost, is about 21,600 cache-write tokens per run on both scenarios: median cache writes rise from 53,191 to 74,772 on sw-5-dozen and from 33,317 to 54,972 on sw-6-ripple against the same arm without a switch, and from 19,156 and 20,190 against the native baseline. Turns move differently on the two scenarios and it matters which baseline is used: against the same arm without a switch, median turns rise from 9 to 13 on sw-5-dozen and from 12 to 18 on sw-6-ripple; against the native baseline, from 13 to 13 and from 12 to 18. So the honest statement is nought to six extra turns depending on scenario and baseline, with n = 3 per cell — the evidence is one scenario deep on either side of that range.

Graded score separates nothing at all. Every cell in Tables 2 and 3 is a mean score of 1.000 with every replicate passing, so on these tasks timing policy is invisible to the grader and this dimension can only be ranked on tokens and turns. That is a fact about the scenarios, not about the policy: a scenario that no arm fails cannot show a policy improving reliability.

*Hypothesis, unmeasured.* The per-node scheduler the batch already uses (`scheduleSummarize` / `drain`) works at single-branch granularity, and the summary circuit breaker in the long-task report already exercises it that way for retries. Calling it on a branch as soon as that branch closes — independent of whether the switch has been crossed — would replace one full-backlog drain with N small ones. Nothing in this repository has been run that way, so the size of the effect, and whether spreading the cache-write cost over turns is cheaper than concentrating it, is unknown. §7 is how to narrow it without spending.

## 6. The fraction grid, replayed over data already recorded

Section 3 fixes what the switch fraction is a fraction *of*; it does not say which fraction. The grid can be replayed, at zero spend, over the twelve fully devolved trajectories on disk — the six `long-v6x` and six `long-v64` context-tree runs, whose gates never fired, so their whole per-turn series is what an unswitched tree does on these tasks. For a candidate fraction *f* on a host with window W, the threshold in provider-billed tokens is *f* × W, because the harness divides its heuristic budget by the measured ratio precisely so that the real prompt lands at *f* × W. The crossing turn is then the first turn whose prompt reaches that threshold, and the overshoot is that prompt's excess — the quantity §4 showed a lagged trigger sends and a same-turn trigger would not.

**Table 4.** Replay, not measurement. Each row applies a candidate switch fraction of a 200,000-token window to the twelve fully devolved per-turn context series on disk (`long-v6x` context-tree arm and `long-v64`, n = 12, claude-sonnet-5, sw-5-dozen and sw-6-ripple, 1 September 2026) and reports where the switch would have landed. The 0.15 row is the baseline the other rows are read against, because 30,000 tokens is what the live gate used and 0.15 is the fraction of this host's window that it happens to be. The replay cannot account for the agent behaving differently after a switch it never experienced, so the crossing turns are trustworthy and everything a policy would do afterwards is not.

| Switch fraction of W | threshold | trajectories crossing | median crossing turn | median overshoot | max overshoot |
|---|---|---|---|---|---|
| *0.15 (= the live constant on this host)* | *30,000* | *12 of 12* | *9* | *7,231* | *10,897* |
| 0.20 (`FRACTIONS.zoneC`) | 40,000 | 1 of 12 | 11 | 897 | 897 |
| 0.25 | 50,000 | 0 of 12 | — | — | — |
| 0.30 | 60,000 | 0 of 12 | — | — | — |
| 0.35 (`FRACTIONS.lazy`) | 70,000 | 0 of 12 | — | — | — |

**Figure 3.** Context size per turn on the twelve fully devolved trajectories, with three candidate switch thresholds drawn as dashed lines. Vertical axis: tokens the model saw on that call. Horizontal axis: turn index. Brown lines are the six sw-5-dozen runs, green the six sw-6-ripple runs; all twelve are context-tree runs whose trigger never fired, so each line is the raw-trace regime running to the end of its run. The dashed lines are 0.15, 0.20 and 0.25 of a 200,000-token window. Every line crosses the lowest; one line, ringed, crosses the middle one at turn 11 with 40,897 tokens; none reaches the highest. The largest prompt anywhere in the twelve is 41,866 tokens, against a window of 200,000.

**Figure 3 data** (rendered as a table in this markdown equivalent; the six sw-5-dozen runs then the six sw-6-ripple runs, blank cells are turns after that run had finished. Within each scenario, columns a to c are `long-v6x` replicates 1 to 3 and d to f are `long-v64` replicates 1 to 3; column "sw-5 c" is the one trajectory that reaches 40,000 tokens, at turn 11):

| Turn | sw-5 a | sw-5 b | sw-5 c | sw-5 d | sw-5 e | sw-5 f | sw-6 a | sw-6 b | sw-6 c | sw-6 d | sw-6 e | sw-6 f |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 4,013 | 4,013 | 4,013 | 4,013 | 4,013 | 4,013 | 3,992 | 3,992 | 3,992 | 3,992 | 3,992 | 3,992 |
| 2 | 4,173 | 4,443 | 4,193 | 4,162 | 4,193 | 4,178 | 4,658 | 4,460 | 4,721 | 4,172 | 8,850 | 4,168 |
| 3 | 4,314 | 4,584 | 4,373 | 5,011 | 4,467 | 4,306 | 4,878 | 9,613 | 5,555 | 4,954 | 8,991 | 5,001 |
| 4 | 5,502 | 4,939 | 4,988 | 5,505 | 4,608 | 4,550 | 5,709 | 10,826 | 11,110 | 6,004 | 9,211 | 5,493 |
| 5 | 5,996 | 6,205 | 5,263 | 20,440 | 4,769 | 4,970 | 11,264 | 16,381 | 21,423 | 8,956 | 9,567 | 11,048 |
| 6 | 13,544 | 21,140 | 6,285 | 36,973 | 5,617 | 19,905 | 17,021 | 26,694 | 22,712 | 17,620 | 10,520 | 12,309 |
| 7 | 14,206 | 37,569 | 13,173 | 37,243 | 6,110 | 36,197 | 22,336 | 27,993 | 35,791 | 22,954 | 13,292 | 13,543 |
| 8 | 21,604 | 37,856 | 13,940 | 37,519 | 21,045 | 36,430 | 23,650 | 29,238 | 36,061 | 24,167 | 21,946 | 23,878 |
| 9 | 37,987 | 37,958 | 20,537 | 37,585 | 37,485 | 36,496 | 24,884 | 37,573 | 36,393 | 25,731 | 22,602 | 36,977 |
| 10 | 38,230 |  | 24,412 |  | 37,752 |  | 33,664 | 37,604 |  | 38,810 | 23,884 | 37,252 |
| 11 | 38,509 |  | 40,897 |  | 38,031 |  | 33,906 | 37,650 |  | 39,087 | 25,891 | 37,493 |
| 12 | 39,201 |  | 41,065 |  | 38,097 |  | 36,522 | 37,648 |  | 39,208 | 31,187 | 37,615 |
| 13 |  |  | 41,356 |  |  |  | 36,512 |  |  |  | 32,307 |  |
| 14 |  |  | 41,602 |  |  |  | 36,575 |  |  |  | 32,542 |  |
| 15 |  |  | 41,866 |  |  |  | 36,601 |  |  |  | 32,870 |  |
| 16 |  |  | 41,846 |  |  |  |  |  |  |  |  |  |

Three readings, in decreasing order of how much the data supports them. First, the live constant is not far wrong *as a fraction on this one host*: 30,000 tokens is 0.15 of a 200,000-token window, and the sweet spot for exercising the mechanism at all on this corpus lies between 0.15 and 0.20, since 0.20 fires on one trajectory of twelve and 0.25 fires on none. That is a statement about one window size and one pair of scenarios. Second, the argument for the fraction rather than the constant does not depend on which fraction wins, and it is a portability argument: on a 32,768-token host every fraction from 0.15 to 0.35 puts the threshold between 4,915 and 11,469 tokens, so all twelve trajectories cross — at a median turn of 3.5 to 6 — whereas the absolute 30,000 would never fire at all and would let the prompt run past the window it was supposed to protect. Those small-window crossing turns are arithmetic on trajectories produced under a 200,000-token host and should be read as showing the threshold's position, not as predicting a run. Third, the earlier report's conclusion that these traces "would never have crossed" under a window-derived budget (`reports/metrics/context-growth.md:354`) holds at 0.35 and at 0.25, and stops holding at 0.20: one of the twelve crosses. Nothing here compares 0.20 against 0.35 on tokens, turns or score, because no run has used either.

## 7. A zero-spend experiment that ranks timing policies

The comparison §5 leaves open — drain the backlog at the switch, as now, or summarize each branch as it closes — can be ranked offline before any live spend, because four things are already in place.

- **A harness that drives the production assembler with no model call.** `eval/scripts/marathon.mjs` builds the real trace log, blob store and tree store, inserts branch nodes and leaf summaries directly — the same pattern `packages/core/test/assemble.test.ts`'s `addBranch` harness uses — and reads real `ZoneAssembler` output, with "zero LLM spend in the default path… no LLM call anywhere in this path" (`eval/scripts/marathon.mjs:10-15`). It is deterministic by construction, which is why the curve it produced for the loop-8 report is a straight line rather than a noisy one.
- **A recorded per-branch summarize cost.** `costByModel`'s per-model usage in every existing `results.json` gives what the leaf model was billed for the branches a run actually summarized, and the summary itself is capped at `maxSummaryTokens`, 1,024 (`packages/core/src/config.ts:118`), independently of when the call happens. Re-bucketing a recorded summarize call as if it had run at branch-close time rather than at crossing time does not require re-running it.
- **Pricing as a pure function.** `packages/core/src/models/cost.ts` turns a usage tuple into a figure with no network call, with Anthropic cache rates as fixed multiples of the input rate (`cost.ts:47-49`), so re-sequencing one large cache-write event into several small ones is arithmetic over numbers in hand.
- **The budget derivation as a pure, tested function.** `deriveBudgets` and `ratioVerdict` are pure in (W, ratio) (`transplant.mjs:345-375` and `:472-482`) and unit-tested (`eval/test/transplant.test.ts:167-282`). Table 4 is one call of that arithmetic per grid point; extending the grid costs nothing.

Concretely: give `marathon.mjs` two parameters — a switch fraction of the harness's configured window, swept over 0.15, 0.20, 0.25 and 0.30, and a summarization cadence, either `batch-at-crossing` (today's code) or `incremental-at-close` (each branch's summary inserted the moment it closes, regardless of the switch) — and run the existing deterministic 200-branch replay once per combination, eight runs at zero spend. Each combination yields an exact, reproducible token-per-branch curve through the real assembler. Ranking is then on two statistics already computed elsewhere in this program: cumulative tokens over the run, and the presence or absence of a single-branch spike in the cache-write series — the quantity Figures 1 and 2 show is what actually distinguishes the two cadences live. The grid should be paired with the same replay over the twelve recorded trajectories, as in Table 4, so the offline curve and the live traces agree on where each fraction puts the crossing.

What the offline pass cannot produce is turns, because no model is called, and turns are where the transition's cost was largest on sw-6-ripple. That half of the ranking still needs a live batch of the design already used here — three replicates per scenario on sw-5-dozen and sw-6-ripple, interleaved in one epoch, against the matched no-switch arm run in the same epoch rather than the day before. The offline pass is what should choose which one or two candidates earn that spend.

## 8. Numbers that did not reproduce

Every figure in the abstract and Tables 1 to 3 was re-derived from the artefacts. Nine claims in the source note did not reproduce as written; the reproduced value is what this report uses.

1. **`transplant.mjs:102` for `FRACTIONS`** — the table is at line 103, both in the working tree and at the committed HEAD. Cited here as `:103`. The values themselves, `lazy: 0.35` and `zoneC: 0.2`, are exactly as stated.
2. **"0.35 × W/ratio ≈ 70,000 tokens"** — these are two different quantities. 0.35 × 200,000 is 70,000 provider-billed tokens; divided by the 0.851 ratio that `deriveBudgets` actually applies, the harness's budget is 82,256 heuristic tokens. The figure is right only without the division. This report expresses every threshold in provider-billed tokens, where the fraction is applied directly.
3. **"0.20 × 200,000/0.851 ≈ 47,000" compared against the 45,564-token peak** — the arithmetic gives 47,003, but that is a heuristic-token budget being compared with a provider-billed prompt. In matched units the threshold is 40,000 provider tokens (equivalently the same prompt is about 53,542 heuristic tokens against a 47,003 heuristic budget). Both framings agree that this one run crosses, so the conclusion survives; the numbers do not.
4. **"a proximity argument, not a crossing"** — understated. At 0.20 the crossing is not near, it happens: one of the twelve devolved trajectories reaches 40,897 tokens at turn 11 (Table 4).
5. **`reports/algorithm.md:94-95` and `:171-173`** — the quoted sentences are not at those lines. That page was rewritten the same day to fold in this dimension's findings; the convergence sentence now sits at `:124-125` and the switch-point and zone-fraction table rows at `:237` and `:240`.
6. **`eval/src/loop.ts:817-820` for `lastPromptTokens`** — that range is the declaration and its comment. The assignment from provider usage is at `:1035` and the comparison at `:829`; the lag is a property of the gap between them, so all three are cited in §4.
7. **`marathon.mjs:11-19`** for the zero-spend guarantee — the quoted passage is at `:10-15`.
8. **"two to six extra turns to absorb it"** — no pairing yields two. Against the same arm without a switch the median rise is four turns on sw-5-dozen and six on sw-6-ripple; against the native transcript it is nought and six. Reported here as nought to six, baseline named.
9. **"each such batch billed a cache-write spike"** — a spike at the crossing turn is not diagnostic, because the matched no-switch arm spikes just as hard when its raw trace grows (up to 33,831 cache-write tokens on its own growth turns, against the switch arm's largest single-turn write of 40,774). The discriminating measurement is the turn *after* the switch: a median 18,274 cache-write tokens against 273 for the no-switch arm on the turn after its own largest write, n = 6 each. That is what Figures 1 and 2 plot and what §5 claims.

One framing in the source note is narrower than the code. "The code summarizes every stale branch in one parallel batch" is true of the backlog at the crossing only; after the latch, summarization runs on each branch close, and the six runs made 2 to 9 leaf calls each of which the artefacts cannot assign to a turn. So the lump is real and measured in cache writes, but the summarizer's cost share in Table 2 is partly post-switch incremental work rather than the batch.

## 9. Open items and recommendations

Ordered by expected information gained per unit of effort, where effort is tokens and runs spent. The first three cost nothing.

1. **Derive the switch from `FRACTIONS.zoneC` in one place both harnesses import.** Zero runs, zero tokens; it is a one-line change in the harness that already derives both numbers and exports them two lines apart (`transplant.mjs:3238-3240`), plus the removal of the live suite's absolute 30,000. It buys the most because until it lands, no comparison of switch policies is measuring the policy that would ship, and because §3 settles what the target is without needing an experiment to choose it. It does *not* settle which fraction; item 3 is that.
2. **Move the check ahead of dispatch, over the candidate prompt, carrying the ratio correction.** Zero live tokens to implement and test offline. It removes a median 8,306 tokens of raw prompt per crossing (n = 6, range 126 to 15,564) that is currently sent and billed at cache-write rates, and it removes the largest single source of variance in Table 1, since the overshoot is just one turn of whatever growth the task is producing. The correction matters: without dividing by the measured ratio a heuristic candidate count fires about 17.5% early on this corpus.
3. **Run the eight-cell offline grid of §7 — four fractions crossed with two cadences — and the Table 4 replay at the same four fractions.** Zero tokens. It is the only thing that can rank `batch-at-crossing` against `incremental-at-close` before spending, and the cache-write series it produces is the statistic Figures 1 and 2 show actually distinguishes them. Its known blind spot is turns.
4. **Then one live batch on the two or three surviving cells: three replicates per scenario on sw-5-dozen and sw-6-ripple, all arms interleaved in a single epoch.** Roughly 250,000 to 300,000 agent tokens per run at the rates in Table 3, so twelve to eighteen runs. This is the cheapest way to get the half of the ranking the offline pass cannot produce, and it also closes the one-day epoch gap that every long-task comparison in this report carries.
5. **Add a per-turn record of non-agent model calls.** One field on `TurnRecord`, no runs. Today `metrics.tokens.total` counts the agent model only, so the leaf summarizer's tokens appear in no total-token figure this program publishes, and no artefact says which turn a summarize call landed on — which is why §5 has to establish the lump from cache writes instead. Every future timing experiment is cheaper to read with this field than without it.
6. **Replicate the firing case on a second model family and a second window size.** Every number in Tables 1 to 3 is one model family, one window, one epoch per cell, and n = 3 per scenario. The 200,000-token window is doing a lot of work in §6: the whole reason the current constant looks nearly right as a fraction is that it is 0.15 of this particular host. A 32,768-token host is where the constant and the fraction diverge most, and the transplant harness already runs there.
7. **Find or build a scenario the arms can fail.** Every cell in this report scores 1.000 with every replicate passing, so timing policy is currently unfalsifiable on graded score and can only be ranked on tokens and turns. Until a scenario separates outcomes, no timing policy can be shown to make the agent more reliable — only cheaper or dearer.

## References

[1] `eval/plans/tuning/03-summary-policy.md` — the analysis note this report publishes and verifies.

[2] `reports/algorithm.md` — the algorithm as it runs, its four rules, the tier-2 parameter table, and the dimension summary this report is the full treatment of.

[3] `reports/metrics/context-growth.md` and `.html` — per-turn context curves; source of the crossing table this report re-derives, and of Table 3's final-context, total-token and turn columns.

[4] `reports/metrics/loop8-interim.md` — the 24 long-task runs in which the mechanism never engaged, and the marathon harness.

[5] `reports/metrics/context-tree-dsa-arm-experiments.md` and `reports/metrics/context-tree-long-task-dsa-iterations.md` — the two earlier reports that independently put the leverage in timing rather than selection.

[6] `eval/plans/loop9-item1-lazy-gate.md` — the real-token trigger, its regression test, and the latch, including the discarded un-latched batch that crossed at turn 8 (40,158 tokens) and again at turn 10 (43,331) and finished at 223,917 tokens (`:79-95`; the batch's `results.json` files were not kept, so those two figures are from the runbook and its log, not re-derived here).

[7] Run artefacts: `eval/results/long-v6x/*/results.json`, `eval/results/long-v64/*/results.json`, `eval/results/long-v65-gate/*/results.json`, `eval/results/long-v65-gate.log`, `eval/results/sw3-loop9b/*/results.json`.

[8] `eval/plans/portability-audit/01-core.md` and `eval/plans/portability-audit/03-transplant.md` — the absence of W from `packages/core`, and the switch/Zone-C mismatch at its exact line.

---

[^usd]: In United States dollars, at the harness's named rates of $2.00 per million input tokens, $10.00 per million output, $0.20 per million cache read and $2.50 per million cache write for claude-sonnet-5, and $1.00, $5.00, $0.10 and $1.25 for claude-haiku-4-5 (`packages/core/src/models/cost.ts:47-62`): against the native transcript baseline's median run of $0.136 on sw-5-dozen and $0.165 on sw-6-ripple, the tree without a switch costs $0.207 and $0.216, and the tree with the switch $0.334 and $0.336, of which the leaf summarizer's own median contribution is $0.032. Dollars appear once, here, beside the baseline they are relative to; every claim in this report is made in tokens, turns and graded score.

DS-STAR tuning pass, dimension 3 of 4 · Tables 1–3 and Figures 1–2 from `long-v6x`, `long-v64`, `long-v65-gate` and `sw3-loop9b`, claude-sonnet-5 agent with a claude-haiku-4-5 leaf summarizer, three replicates per long-task cell and five per short-task cell · Table 4 and Figure 3 are replay over the twelve devolved trajectories, not new runs · no model was called for this report · September 2, 2026.
