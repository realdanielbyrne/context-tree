> Markdown equivalent of [tuning-branch-count.html](./tuning-branch-count.html). The HTML version is the canonical rendering; this file exists so the report is readable and diffable in git.

# How many branch summaries the model should see

Context-tree evaluation program · DS-STAR dimension 1 (visible branch count) · September 2, 2026

> *Status.* This is the full treatment of the dimension summarised in `reports/algorithm.md`, "What the DS-STAR loop is for". No new model runs were made for it. Every number below is either read from a committed artifact or recomputed offline from one, and the recomputation disagrees with the analysis it publishes in six places, which §7 lists. Where a published figure did not reproduce, the reproduced value is the one used.

## Abstract

Context-tree replaces an agent's raw conversation history with a summary-headed tree: completed stretches of work become **branches**, each branch gets a short summary, and the prompt carries summaries plus tools for fetching detail back. This report asks how many of those summaries the prompt should carry. It makes two corrections to the way the question was previously framed. First, two different counts had been conflated. The **fold level** (`rootKeep`) is how many recent branches get an individual headline in the root index before older ones fold to one line; the number of branches whose *full summary body* is rendered separately is a different count, and the two move in opposite directions, because both are paid out of one budget. Reproducing the whole fold ladder from the frozen store confirms this exactly: at a 32,768-token window, fold level 16 renders 16 headlines and 2 bodies, fold level 2 renders 2 headlines and 11 bodies, and the assembled section is the same size either way — 7,633 against 7,569 heuristic tokens. Width, in this fixture, is a reallocation and not an addition. Second, "width helps" was too broad. Across four question types the wide setting beat the narrow one on one of them: means over completed runs of 0.333 (n=9) against 0.091 (n=11) on early-session questions, with both non-tree baselines at 0.000; on the other three types both widths sat at 0.000, and on recent-fact questions the baselines beat both. Reduced to successes, the entire effect is three of four completed runs against one of five on a *single* question, and no answer literal for any of the twelve questions appears in any of the twenty-one rendered bodies — so width cannot be putting the answer in the prompt, and what it plausibly buys is fetch aim rather than recall. The measured per-turn cost of the reallocation is 349 tokens on the first turn (medians, n=38 each); the 12,168-token gap in median run input between the two arms is real but belongs to later-turn retrieval payloads and a longer turn distribution, not to Zone B. The load-bearing finding is that the ladder's direction is a human choice inside a mechanism that looks derived: six of the seven rungs satisfy the fit predicate at this window, and which one is used is decided by which end of the ladder someone wrote for the arm. Of the three candidate policies, fit-derived is kept as the ceiling but does not determine the allocation beneath it; demand-driven fails because search occurrence does not track the bottleneck; a user-set effort dial fails because no single width serves a whole session. The experiment that settles it is a rung sweep on the one stratum with signal, which needs no new code.

## 1. Terms, and what has actually been run

A **turn** is one model call. A **branch** is context-tree's unit of organisation: a contiguous stretch of work that gets one summary when it closes. The prompt is assembled in three fixed sections — **Zone A**, the frozen contract; **Zone B**, the root index plus branch summaries in creation order; **Zone C**, the active branch's raw detail — and retrieved results are appended after Zone C. **W** is the model's context window; each zone's budget is a fixed fraction of W divided by a measured heuristic-to-tokenizer ratio, so at W=32,768 with ratio 0.851 the Zone B budget is 7,701 **heuristic tokens** (the assembler's own tokenizer, which over-counts real BPE by about 1.18× on this corpus) and at W=16,384 it is 3,850.

Two counts are the subject of this report and are defined once here. **Fold level** (`rootKeep` in the code) is the rung on a ladder: how many of the most recent branches get an individual headline line in the root index, with everything older folded into a single line saying what was removed and how to retrieve it. **Rendered bodies** (`branchesSurviving` in the harness) is how many branches have their full summary block — prose plus rehydration pointers: files, symbols, tests, decisions, open questions, fetchable node ids — rendered separately in Zone B. A single rung fixes both, and raising the rung lowers the body count, because the root index and the bodies are paid out of the same Zone B budget.

Two arms differ in exactly one thing. `tree` walks the ladder `[40, 16, 12, 8, 6, 4, 2]` largest-first (`eval/scripts/transplant.mjs:385`) and takes the first rung that passes; `tree-wide` walks the same ladder reversed, smallest-first (`transplant.mjs:398-410`). The predicate a rung must pass is not a share constant: it assembles the real prompt at that rung and asks whether Zone B fits its budget *and* at least one branch body survived (`deriveRootKeep`, `transplant.mjs:450`; the rationale is R4 and R5 of `eval/fixtures/transplant/JUDGE-VERDICT.md:145-155`). Two baselines carry no summaries at all and are therefore the paired comparison for every score below: **truncate-tail**, which keeps the most recent slice of the raw trace that fits, and **compact-rolling**, which keeps a model-written rolling summary of the whole trace. Both run one turn and have no Zone B.

All width evidence in this repository beyond two abandoned pruning arms (§5.4) comes from one fixture: `eval/fixtures/transplant/s1/e1b289c32f40/`, scenario `s1`. It is a frozen store of 754 append-only events, 46 nodes (1 task, 21 branch nodes, 24 file nodes) and 21 branch summaries — one version each, verified by SQL against `eval/fixtures/transplant/s1/store/tree.db`. Twelve questions, three in each of four **strata**: **head** (a fact from early in the session), **tail** (a recent fact), **deep** (a verbatim code literal), **spanning** (a fact requiring two places at once). Each question ran five replicates, so each (arm, stratum) cell is 15 attempted runs.

Attempted is not completed, and the difference matters throughout. A run the harness stopped is not evidence of task failure, and neither is a provider fault. Of 60 attempted runs per tree arm at W=32,768, `tree` completed 38, hit the harness's six-turn cap twice, and lost 20 to an OpenRouter response with no choices; `tree-wide` completed 38, hit the cap 7 times, and lost 15 the same way. The two baselines completed 59 and 60 of 60. Every harness-stopped row in the committed files carries `score: 0` with an empty answer — a wrong answer no model gave — so all nine such rows are excluded from every mean below. The harness has since been corrected to write `score: null` for them (the comment at `transplant.mjs:3352-3365` names the same nine rows), but the committed fixture predates the fix.

## 2. The two counts move in opposite directions

The whole fold ladder can be rebuilt from the store with no model call and no assembly: render each branch's summary block with the assembler's own `renderSummaryBlock`, count it with the assembler's own tokenizer, take the root block size for each rung from `root-ladder.json`, and fill the remainder of the Zone B budget with bodies newest-first, which is the assembler's drop-oldest rule. That reconstruction reproduces the two rungs the fixture recorded exactly — 6,095 + 1,538 = 7,633 for fold level 16 at W=32,768, and 2,587 + 1,036 = 3,623 for fold level 2 at W=16,384, both matching `gates.json` to the token — and it reproduces every pass/fail verdict on both ladders. Table 1 is that reconstruction.

| fold level | headlines | root block | left for bodies | bodies | body tokens | Zone B assembled | oldest visible seq | predicate |
|---|---:|---:|---:|---:|---:|---:|---|---|
| 40 | 21 | 6,917 | 784 | 0 | 0 | 6,917 | — | fails: no body |
| 16 ← `tree` | 16 | 6,095 | 1,606 | 2 | 1,538 | 7,633 | 639 | passes |
| 12 | 12 | 4,771 | 2,930 | 5 | 2,575 | 7,346 | 554 | passes |
| 8 | 8 | 3,967 | 3,734 | 6 | 3,091 | 7,058 | 489 | passes |
| 6 | 6 | 3,538 | 4,163 | 8 | 3,965 | 7,503 | 428 | passes |
| 4 | 4 | 3,105 | 4,596 | 10 | 4,467 | 7,572 | 390 | passes |
| 2 ← `tree-wide` | 2 | 2,587 | 5,114 | 11 | 4,982 | 7,569 | 359 | passes |

**Table 1.** The fold ladder at W=32,768, rebuilt from the frozen store; all token columns are heuristic tokens against a Zone B budget of 7,701. **headlines** is min(fold level, 21), since the store holds 21 branches. **left for bodies** is the budget minus the root block; **bodies** is how many summary bodies fit in it newest-first. **oldest visible seq** is where the oldest rendered body starts, out of 754 events. The two marked rows are what the two arms actually ran: they are the two ends of one ladder, not two settings of a dial. The paired baselines have no Zone B at all — truncate-tail and compact-rolling render zero summaries by construction — so within this table the pairing is the two tree arms against each other.

Three things in Table 1 are worth stating separately. Fold level 40 fails the predicate but *not* for being over budget: its root block of 6,917 tokens fits the 7,701 budget with 784 to spare, which is less than the newest body's 1,036, so no body survives and the second clause of the predicate rejects it. So "the largest rung that fits" is imprecise; it is the largest rung that fits *and* leaves room for at least one body. Second, the assembled Zone B is nearly constant across the passing rungs — 7,058 to 7,633, a spread of 8% — which is what "budget-bound" means: the rung decides the composition, not the size. Third, six of the seven rungs pass. The mechanism does not choose between them; the direction of the walk does.

The trade at this window is precise: 3,508 heuristic tokens of root headlines (6,095 − 2,587) buy 14 extra headlines, or the same budget buys 9 extra bodies for 3,444 tokens (4,982 − 1,538). One rendered body costs about 1.5 headlines in this region of the ladder, and about 2.1 headlines at the two means (476 tokens per body against 228 per headline, §4). In coverage terms the two arms differ by a factor of three: `tree`'s two bodies span sequence 639–754, 116 of 754 events (15%), while `tree-wide`'s eleven span 359–754, 396 events (53%).

**Figure 1.** Headlines rendered and bodies rendered against the fold level, at W=32,768, from the reconstruction in Table 1. The horizontal axis is the fold level in ladder order (2 to 40, unequally spaced rungs plotted at equal intervals). The rising brown line is the number of individual root headlines; the falling green line is the number of full summary bodies. The two ringed points are the rungs the two arms actually chose: `tree`, which walks the ladder from the right, stops at 16 with 2 bodies; `tree-wide`, which walks from the left, stops at 2 with 11 bodies. The lines cross between rungs 6 and 8. Six of the seven rungs satisfy the fit predicate; rung 40 is the only one that fails, and it fails for leaving no room for a body rather than for exceeding the budget. Both baselines would be a flat zero on both series and are omitted for that reason. *In this markdown equivalent the chart is Table 1's `headlines` and `bodies` columns read against the `fold level` column: 2→(2 headlines, 11 bodies), 4→(4, 10), 6→(6, 8), 8→(8, 6), 12→(12, 5), 16→(16, 2), 40→(21, 0).*

**Figure 2.** The same ladder in tokens: how each rung spends the Zone B budget at W=32,768. Each bar is one fold level, split into the root index block (lower, brown) and the rendered summary bodies (upper, green), in heuristic tokens. The upper dashed line is the Zone B budget at W=32,768 (7,701 tokens); the lower dashed line is the budget at W=16,384 (3,850), above which every rung but 2 and 4 lies with the root block alone. The total height barely changes across the passing rungs — the reallocation is nearly size-neutral — while the split moves from almost all index at rung 40 to two thirds bodies at rung 2. The paired baselines contribute no bar: their Zone B is zero tokens. *In this markdown equivalent the stack is Table 1's `root block` and `body tokens` columns, whose sum is the `Zone B assembled` column: the total moves only between 6,917 and 7,633 while the body share moves from 0% to 66%.*

At W=16,384 the two directions converge and the dimension is not tested at all. The Zone B budget is 3,850, and the reconstruction agrees with `gates.json` rung for rung: fold levels 40, 16, 12 and 8 exceed the budget on the root block alone (6,917, 6,095, 4,771, 3,967); levels 6 and 4 fit the budget — 3,538 and 3,105 — but leave 312 and 745 tokens against a newest body of 1,036, so no body survives and they fail the second clause with no over-budget flag; level 2 passes with one body. Both ladder directions therefore return the same rung, and no separate `tree-wide` run exists at this window. Its single visible body spans sequence 732–754, 23 of 754 events, so about 3% of the log is visible as a body and 97% is reachable only through retrieval. As R6 of the judge verdict says, that cell scores search-and-fetch, not summary width.

| fold level | root block | Zone B budget | left for bodies | bodies | outcome |
|---|---:|---:|---:|---:|---|
| 40 | 6,917 | 3,850 | — | 0 | over budget |
| 16 | 6,095 | 3,850 | — | 0 | over budget |
| 12 | 4,771 | 3,850 | — | 0 | over budget |
| 8 | 3,967 | 3,850 | — | 0 | over budget |
| 6 | 3,538 | 3,850 | 312 | 0 | fits, no body |
| 4 | 3,105 | 3,850 | 745 | 0 | fits, no body |
| 2 | 2,587 | 3,850 | 1,263 | 1 | passes (both arms) |

**Table 2.** The same ladder at W=16,384, where both walk directions return the same rung and the width dimension collapses. Heuristic tokens, reconstructed from the store and matching `gates.json`'s recorded ladder on every row. The distinction between the last four rows is the correction: the published analysis records every rung from 40 down to 4 as failing on `overBudget:["B"]`, but rungs 6 and 4 fit the budget and fail only for leaving no room for one body.

## 3. What width did to the score

The comparison isolates branch count from everything else: same store, same window, same twelve questions, same model (`qwen/qwen-2.5-72b-instruct` through OpenRouter), and the only difference between the arms is which end of the ladder is walked. The two runs are 99 minutes apart on the same day and the same frozen fixture. The baselines were run in the same batch as `tree`. Table 3 is the whole width dataset.

| stratum / arm | attempted | completed | harness-stopped | provider fault | successes | mean score | median turns | median tokens |
|---|---:|---:|---:|---:|---|---:|---:|---:|
| head — `tree` (2 bodies) | 15 | 11 | 0 | 4 | 1 of 11 | 0.091 | 2 | 31,967 |
| head — `tree-wide` (11 bodies) | 15 | 9 | 2 | 4 | 3 of 9 | 0.333 | 3 | 52,559 |
| head — truncate-tail | 15 | 14 | 0 | 1 | 0 of 14 | 0.000 | 1 | 22,759 |
| head — compact-rolling | 15 | 15 | 0 | 0 | 0 of 15 | 0.000 | 1 | 13,205 |
| tail — `tree` | 15 | 11 | 1 | 3 | 0 of 11 | 0.000 | 3 | 50,885 |
| tail — `tree-wide` | 15 | 13 | 0 | 2 | 0 of 13 | 0.000 | 3 | 32,022 |
| tail — truncate-tail | 15 | 15 | 0 | 0 | 3 of 15 | 0.200 | 1 | 22,815 |
| tail — compact-rolling | 15 | 15 | 0 | 0 | 5 of 15 | 0.333 | 1 | 13,287 |
| deep — `tree` | 15 | 11 | 1 | 3 | 0 of 11 | 0.000 | 4 | 54,365 |
| deep — `tree-wide` | 15 | 7 | 3 | 5 | 0 of 7 | 0.000 | 3 | 33,811 |
| deep — truncate-tail | 15 | 15 | 0 | 0 | 0 of 15 | 0.000 | 1 | 22,754 |
| deep — compact-rolling | 15 | 15 | 0 | 0 | 0 of 15 | 0.000 | 1 | 13,249 |
| spanning — `tree` | 15 | 5 | 0 | 10 | 0 of 5 | 0.000 | 3 | 38,614 |
| spanning — `tree-wide` | 15 | 9 | 2 | 4 | 0 of 9 | 0.000 | 3 | 54,835 |
| spanning — truncate-tail | 15 | 15 | 0 | 0 | 0 of 15 | 0.000 | 1 | 22,738 |
| spanning — compact-rolling | 15 | 15 | 0 | 0 | 0 of 15 | 0.000 | 1 | 13,237 |

**Table 3.** Graded score by stratum and arm, W=32,768, qwen-2.5-72b-instruct, one epoch. **mean score** is the mean over completed runs only, which is the denominator this report uses everywhere; **successes** counts completed runs whose answer matched the question's literal. **harness-stopped** is runs still calling tools at the harness's six-turn cap, **provider fault** is an OpenRouter reply with no choices. Both are excluded from the mean, so a cell's denominator is its completed count, never 15. **median tokens** is input plus output per run over completed runs. Every candidate row is paired with the two baseline rows in its own stratum.

**Figure 3.** Mean graded score by stratum, both widths against both baselines, W=32,768, same model and epoch. Four groups of four bars; within each group the order is `tree` (2 bodies), `tree-wide` (11 bodies), truncate-tail and compact-rolling, and the number beside each bar is the mean followed by the completed-run count it is a mean over. Only three of the sixteen bars are non-zero. Widening from 2 bodies to 11 raises the head bar from 0.091 to 0.333 and leaves the other three strata flat at zero; on the tail stratum both baselines are above both tree widths. *In this markdown equivalent the chart is Table 3's `mean score` column read by stratum: head (0.091 n=11, 0.333 n=9, 0.000 n=14, 0.000 n=15), tail (0.000 n=11, 0.000 n=13, 0.200 n=15, 0.333 n=15), deep (all 0.000), spanning (all 0.000).*

Two readings follow directly, and both are narrower than "width helps".

**Measured: the width effect is confined to one stratum out of four.** Head is the only stratum where either tree arm scores above zero at all. Tail, deep and spanning are 0.000 for both widths, so going from 2 rendered bodies to 11 changed nothing on three of the four question types in the only experiment that has tested it.

**Measured: on tail, wider is not merely no better — both widths are behind the baselines.** truncate-tail scores 0.200 (3 of 15) and compact-rolling 0.333 (5 of 15) against 0.000 for both tree widths. This is not a branch-count effect, since it holds identically at both widths, and it is the pre-registered trigger that caused the wide arm to be run at all: the verdict specified re-running the tree arm with the reversed ladder if `tree` fell more than 0.05 below truncate-tail on the tail stratum, and the observed gap is 0.20. The consequence for this dimension is only that "width helps" cannot be read as "the tree arm improves as it widens": on tail it is behind the flat baselines at both widths tested.

Reduced to what actually happened, the effect is thinner still. Table 4 pairs each question's source location against whether that branch was rendered as a body in each arm.

| question | stratum | source seq | body in `tree` | body in `tree-wide` | `tree` | `tree-wide` | truncate-tail | compact-rolling |
|---|---|---:|---|---|---|---|---|---|
| s1-q01-head | head | 175 | no | no | 0/4 | 0/2 | 0/4 | 0/5 |
| s1-q02-head | head | 558 | no | **yes** | **1/5** | **3/4** | 0/5 | 0/5 |
| s1-q03-head | head | 18 | no | no | 0/2 | 0/3 | 0/5 | 0/5 |
| s1-q04-tail | tail | 728 | yes | yes | 0/2 | 0/4 | 0/5 | 0/5 |
| s1-q05-tail | tail | 744 | yes | yes | 0/5 | 0/5 | 0/5 | 0/5 |
| s1-q06-tail | tail | 746 | yes | yes | 0/4 | 0/4 | **3/5** | **5/5** |
| s1-q07-deep | deep | 55 | no | no | 0/4 | 0/1 | 0/5 | 0/5 |
| s1-q08-deep | deep | 559 | no | yes | 0/4 | 0/3 | 0/5 | 0/5 |
| s1-q09-deep | deep | 41 | no | no | 0/3 | 0/3 | 0/5 | 0/5 |
| s1-q10-spanning | spanning | 173 | no | no | 0/0 | 0/4 | 0/5 | 0/5 |
| s1-q11-spanning | spanning | 467 | no | yes | 0/2 | 0/4 | 0/5 | 0/5 |
| s1-q12-spanning | spanning | 691 | yes | yes | 0/3 | 0/1 | 0/5 | 0/5 |

**Table 4.** Every question, its source event, whether the branch containing that event was rendered as a full body in each tree arm, and successes over completed runs in all four arms. W=32,768, same model and epoch. **body in `tree`** is true when the source event is at or after sequence 639, **body in `tree-wide`** at or after 359. Two cells in the whole matrix are non-zero. Three questions (q02, q08, q11) gain a rendered source branch when the arm widens; one of them changed score.

**Measured, and it is the honest size of the finding: the entire width effect is one question.** All four successes across both tree arms are on `s1-q02-head`: one of five completed runs under `tree`, three of four under `tree-wide`. Both other head questions source from events 175 and 18, outside even the wide arm's visible span, and score zero in every arm. Three questions gain a rendered source branch when the arm widens, and two of them — q08 (deep) and q11 (spanning) — did not move. So the stratum-level 0.091 against 0.333 rests on a single question at five and four replicates, and any statement about strata is a statement about three questions each.

**Measured: no width can put the answer in the prompt.** Rendering all 21 branch blocks with the assembler's own renderer and searching them for each question's answer literals finds none of the 15 literals across the 12 questions in any of the 21 bodies. That reproduces, against rendered bodies rather than summary prose, the boundary condition already on record in `reports/algorithm.md`: summaries do not contain the answer. The tail stratum makes the point sharply — the source branch for all three tail questions is rendered as a full body in *both* arms, and both arms still score 0.000 while the baselines, which show raw text, score 0.200 and 0.333.

**Hypothesis, not measured: what width buys is fetch aim.** Since the answer is in no body, the wide arm's advantage on q02 cannot be recall from the prompt. The recorded tool calls are consistent with aiming instead: the narrow arm's head-stratum fetches went to the task root node and to a file node (`loop.ts`), while the wide arm's went to branch nodes 489–553 and 554–570 and to the file node `summarizer.ts` (554–570) — and q02's source event, 558, lies inside branch 554–570, which is a rendered body only in the wide arm. That is a plausible mechanism supported by the fetch identifiers on disk, not an isolated result; nothing in this repository varies visibility while holding search behaviour fixed.

On whether there is a turning point — a width past which more stops helping or starts hurting — the answer is that this fixture cannot locate one. It has two points on the width axis, at one window, with one stratum above the floor. There is no evidence of width hurting head-stratum recall between 2 and 11 bodies, and none that it keeps helping past 11, because 21 is the most the store could show and nothing between 2 and 11, or above 11, has been run. Search behaviour does not explain the difference either: on completed head runs the narrow arm searched on 8 of 11 and the wide arm on 8 of 9.

## 4. What width costs per turn

### 4.1 The marginal Zone B cost of one more rendered body, from the store

The rendered cost of a branch body is not its prose. Each block carries the prose plus the rehydration pointers the summarizer is required to produce, and on this store the pointers dominate: over the 21 branches the rendered block is 476 heuristic tokens on average (median 417, range 140–1,372) while the prose alone is 195 (median 181, range 126–305). In real BPE the same blocks are 368 tokens on average (median 299, range 113–1,131). The marginal cost of one more root *headline*, from the ladder's own accounting, is 228 heuristic tokens — the root block grows from 2,587 to 6,917 tokens between fold levels 2 and 40, which is 19 more headlines. So a body is worth roughly two headlines at the means, and 1.5 at the specific rungs the two arms picked.

**Figure 4.** The marginal Zone B cost per additional rendered summary, computed from the frozen store. Panel (a): the rendered size of each branch body in heuristic tokens, in the order Zone B fills them, newest first. The horizontal axis is how many bodies are rendered; each point is the cost of that one additional body. The upper dashed line is the mean over all 21 branches (476 tokens) and the lower dashed line is the marginal cost of one root headline (228), the thing a body is traded against. Marginal cost is not a constant: the newest branch alone costs 1,036 tokens and the 8th costs 140. Panel (b): the same series accumulated, against the two body allowances the arms actually had — 1,606 tokens for `tree` (fold level 16) and 5,114 for `tree-wide` (fold level 2). Where each cumulative curve crosses its allowance is where the body count stops: 2 bodies and 11 bodies, the two ringed points, which is how the recorded `branchesSurviving` values are reproduced. Neither baseline appears in either panel: both render zero summaries, so their Zone B cost is zero tokens by construction. *In this markdown equivalent the two panels are the table below.*

**Figure 4 data** (rendered as a table in this markdown equivalent): rendered body cost per branch in heuristic tokens, newest first, from `renderSummaryBlock` and `HeuristicTokenizer` against the frozen store. Mean 476, median 417, range 140–1,372, n=21. For reference the marginal cost of one root headline over the same ladder is 228 tokens. The two allowance rows are what reproduce the recorded body counts of 2 and 11.

| bodies rendered | branch span (seq) | that body's cost | cumulative | crosses an allowance |
|---:|---|---:|---:|---|
| 1 | 732–754 | 1,036 | 1,036 | under both |
| 2 | 639–731 | 502 | 1,538 | last that fits `tree`'s 1,606 |
| 3 | 588–638 | 449 | 1,987 | over `tree`'s allowance |
| 4 | 571–587 | 329 | 2,316 | |
| 5 | 554–570 | 259 | 2,575 | |
| 6 | 489–553 | 516 | 3,091 | |
| 7 | 430–488 | 734 | 3,825 | |
| 8 | 428–429 | 140 | 3,965 | |
| 9 | 413–427 | 234 | 4,199 | |
| 10 | 390–412 | 268 | 4,467 | |
| 11 | 359–389 | 515 | 4,982 | last that fits `tree-wide`'s 5,114 |
| 12 | 350–358 | 374 | 5,356 | over `tree-wide`'s allowance |
| 13 | 320–349 | 539 | 5,895 | |
| 14 | 308–319 | 288 | 6,183 | |
| 15 | 298–307 | 417 | 6,600 | |
| 16 | 282–297 | 577 | 7,177 | |
| 17 | 277–281 | 300 | 7,477 | |
| 18 | 267–276 | 382 | 7,859 | |
| 19 | 262–266 | 246 | 8,105 | |
| 20 | 55–261 | 1,372 | 9,477 | |
| 21 | 1–54 | 527 | 10,004 | all 21 bodies |

### 4.2 Measured per-turn cost: the reallocation is nearly free, and the run-level gap is not Zone B

Because Zone B is budget-bound, showing 9 more bodies did not add 9 bodies' worth of tokens: it swapped 14 headlines for them. The assembled Zone B is 7,633 heuristic tokens under `tree` and 7,569 under `tree-wide` — the wide arm's section is 64 tokens *smaller*. The provider's own count of the first turn's prompt, before any retrieval has happened, is the clean per-turn measurement: median 9,066 tokens under `tree` and 9,415 under `tree-wide` over 38 completed runs each, a difference of 349 tokens or 3.9%. The sign is opposite to the heuristic-unit comparison, which is expected at this magnitude — a dense index of headlines, identifiers and hashes and a page of prose do not tokenize at the same rate, and the heuristic tokenizer is calibrated on neither — but both numbers agree that the reallocation costs a few hundred tokens per turn, not a few thousand.

| arm | turn 1 | turn 2 | turn 3 | turn 4 | turn 5 | turn 6 | median run input | median turns |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `tree` (2 bodies) | 9,066 | 11,642 | 12,133 | 13,312 | 12,458 | 13,857 | 37,513 | 3 |
| `tree-wide` (11 bodies) | 9,415 | 12,338 | 13,006 | 15,153 | 17,301 | 20,321 | 49,681 | 3 |
| runs reaching the turn — `tree` | 38 | 32 | 24 | 12 | 6 | 2 | 38 | 38 |
| runs reaching the turn — `tree-wide` | 38 | 36 | 29 | 12 | 6 | 2 | 38 | 38 |
| truncate-tail (baseline) | 22,642 | — | — | — | — | — | 22,642 | 1 |
| compact-rolling (baseline) | 13,145 | — | — | — | — | — | 13,145 | 1 |

**Table 5.** Median prompt input tokens per turn, both widths against both baselines, W=32,768, same model and epoch, completed runs only. The per-turn medians are taken over the runs that reached that turn, and those counts are given as their own rows because the denominator shrinks with depth; the median run input is over all 38 completed runs and is not the sum of the per-turn medians. Both baselines answer in one turn, so they have a single column. Cache read and cache write are zero on every row of both files, so every token here is billed as fresh input.[^usd]

**Figure 5.** Median prompt input tokens against turn index, both widths against both baselines, from Table 5. The two solid lines are the tree arms — green `tree`, blue `tree-wide` — and the two dashed horizontal lines are the single-turn baselines, truncate-tail at 22,642 tokens and compact-rolling at 13,145. Both tree arms start below both baselines and cross them: the gap between the two widths is 349 tokens on turn 1, where it is a pure Zone B difference, and 6,464 tokens by turn 6, where it is retrieval payload. The point count behind each marker falls from 38 to 2 with depth, so the right-hand end of both lines is two runs per arm. *In this markdown equivalent the chart is Table 5 read across.*

The run-level difference is much larger than the per-turn one: median input over completed runs is 37,513 tokens for `tree` and 49,681 for `tree-wide`, a gap of 12,168. That gap is real and it is not Zone B. Median turns are 3 in both arms, so it is not turn count in the median either, though the wide arm's distribution runs slightly longer (mean 3.24 against 3.00, and 36 against 32 runs reaching a second turn). What Table 5 shows is that the two arms diverge *with depth*: 349 tokens apart on turn 1, 696 on turn 2, 6,464 by turn 6. Since Zone A, Zone B and Zone C are all held fixed by budget, the growing part is what gets appended after Zone C — search and fetch payloads — and the wide arm fetched more often (26 of 38 completed runs against 21 of 38). Median output tokens are 469 against 377, a small fraction of the gap.

This is where the published analysis and the reproduction part company most sharply, and §7 records it: the figure of ~465 tokens per additional visible summary, and the ~4,185-per-turn and ~12,555-per-run predictions built on it, treat the extra bodies as an addition to `tree`'s Zone B rather than a substitution inside a fixed budget, and they use the Zone B *budget* (7,701) where the assembled size (7,569) belongs. The prediction landing within 3% of the measured 12,168-token gap is therefore a coincidence of magnitude, not a confirmation that the gap is where the summaries are.

### 4.3 Two cost regimes, and only one of them has been measured for width

**Measured, this fixture:** `usage.cacheRead` and `usage.cacheWrite` are zero on every row of both result files. This OpenRouter endpoint bills no cache, so every token of Zone B is repriced as fresh input on every turn, and cost scales as (tokens in Zone B) × (turns). In that regime the reallocation is nearly free because Zone B's size barely changes.

**Not measured for width:** the live Anthropic suite, where a stable prefix is cache-read at roughly a tenth of the input rate and a rewrite is charged at the cache-write rate. Two facts from other passes bound what that means without settling it. The decomposition of the live suite's overhead on one scenario attributes about 69.5% of the token gap to re-reading the prompt over extra turns and about 24.0% to Zone A per turn, with everything else at 6.5% — it holds branch count fixed and is not a width finding. And every re-summarize pass rewrites Zone B's text and invalidates the cached prefix, producing 7.7k–27.4k cache-write tokens per run where the native transcript pays none. So under caching the cost of width is not "N bodies × K tokens" but "N bodies × K tokens, amortised until the next summarize pass, then rewritten once at the write rate" — a coupling between this dimension and the summary-timing dimension. No caching-regime width sweep exists.

## 5. The three candidate policies

### 5.1 Fit-derived — keep it, but it does not decide the allocation

The policy is the one already implemented: walk a ladder and return the first rung whose predicate — assemble the real Zone B and ask whether it fits its budget with at least one body surviving — passes. It is genuinely dynamic per window and per store, it needs no notion of task difficulty, it has unit tests, and it contains no guessed constant: the numbers it consumes are W, the measured tokenizer ratio, and the store's own rendered sizes. Nothing in this pass argues against it as the mechanism that sets the *ceiling*.

What this pass adds is that the ceiling is not the decision. Six of seven rungs pass the predicate at W=32,768 (Table 1), and the predicate is indifferent among them; the rung that gets used is whichever end of the ladder the arm's entry in `ARM_ROOT_LADDER` points at. The measured data says that choice matters: same store, same window, same budget, and the body-maximising direction scores 0.333 against the headline-maximising direction's 0.091 on the one stratum where either is above zero — while §3 also says that result is one question at nine and eleven completed runs, so "matters" here means "moved the only non-zero cell", not "is established". Fit-derived as a sufficient policy is falsified by its own data — a deliberately narrower rung than the largest-passing one scored higher — while fit-derived as a ceiling mechanism is untouched. The gap is a missing allocation rule, and the shipped default (`tree`, headline-rich) sits on the side of that gap the data did not favour.

### 5.2 Demand-driven — unnecessary, because search occurrence does not track the bottleneck

The proposal is to widen only when the model reveals it needs breadth by calling `context_search` or `context_fetch`, rather than estimating need in advance — the same argument that removed the turn ceiling. Every run logs whether it searched and fetched, so the proposal can be tested against data already on disk.

It comes out unnecessary as specified. On the head stratum the narrow arm searched on 8 of 11 completed runs (73%) and the wide arm on 8 of 9 (89%), and the narrow arm still scored 0.091 against 0.333. The narrow arm is not failing to search; it searches at nearly the same rate and misses anyway. The reason is visible in the question set's own precomputed retrieval ranks: the two head questions that nobody answered rank 15th and 15th under the harness's lexical scorer, and the one that was answered ranks 11th — all inside the default result limit of 20, none near its top. A model that searches and receives a hit from the tail of the result list has no signal telling it that more width would have helped; "I searched" does not distinguish a search that worked from one that returned something weak. What is *not* falsified is a refinement keyed on search confidence rather than search occurrence — trigger a widen when the best hit is weak — and that refinement is untested because nothing logs a live confidence score beside the call, only the offline rank used to build the question set.

### 5.3 User-selected — unnecessary, because no single width serves a whole session

The proposal is an effort dial set by the user or the caller, described in the algorithm document as a reasonable escape hatch that must not be the mechanism. The stratum breakdown is a direct argument against it as a default, and it needs no new run: going from 2 bodies to 11 helped one question type and changed nothing for the other three, while costing the per-turn reallocation on every turn regardless of which type the current question is. A dial can only be set per session — nothing about its affordance lets it change per question inside one turn sequence — so a user would be choosing a single width for a session whose questions demonstrably want different ones. What would overturn that verdict is evidence that question mix is knowable in advance and stable within a session, and nothing here measures it: `s1`'s four strata are drawn from one frozen trace, not from a live session whose composition could be observed and declared up front.

### 5.4 Two earlier width policies that never engaged

For completeness, because they are sometimes read as width evidence: two earlier loops tried the opposite question — how *few* branches the model needs — through a top-k filter over branches rather than a fold-ladder walk. Neither ever fired. The segmenter merges consecutive same-type tool calls into one phase, so a 13-tool-call task produced only about 3 branches against a cutoff of 3, and the floor property (branches ≤ k means no selection, byte-identical prompt) held on every run: three iterations in the first attempt, and three more with a smarter idf-cosine and farthest-point scorer in the second. Both are honest nulls about pruning a branch count that was never large, which is a different claim from this fixture's, where 21 branches exist and the question is how many to show.

## 6. Does the fit-derived ceiling make the other two unnecessary?

Yes for the two alternatives, no for the question they were meant to answer. Fit-derived makes the maximum a function of the window and the store with no guessed constant, and that part is confirmed at both windows in this fixture. But more than one allocation of the same budget satisfies "fits with at least one body", and which one is used is decided today by a hand-picked ladder direction. Demand-driven does not fill that gap, because search occurrence does not track where the bottleneck is; a user dial does not fill it, because no single width serves a session. What fills it is a fit-derived-shaped fix: replace "walk this one hand-picked direction" with "walk toward maximising the number of rendered bodies subject to the same fits predicate", and then measure whether that direction wins.

On present evidence the recommendation is to keep fit-derived as the ceiling mechanism, treat the headline-versus-body split as its one remaining open parameter, and not change the shipped headline-rich default on the strength of one question in one scenario at one window. The experiment that settles the allocation question is a rung sweep, and it needs no new code: `ARM_ROOT_LADDER` already accepts a per-arm ladder, so a one-element ladder pins a rung. Running fold levels 12, 8, 6 and 4 on the head stratum turns two points on the width axis into six and is the only design that can locate a turning point. Its cost is 4 rungs × 3 questions × 5 replicates = 60 runs; at the head-stratum token rates already measured (340,147 tokens for `tree`'s head cell, 611,556 for `tree-wide`'s) that is roughly 1.9M tokens, against the 4.1M the two existing width arms have already spent across all four strata. Because the fit predicate is deterministic and offline, every rung's assembled Zone B is known before a single call is made; only the grading needs the model.

## 7. Where the reproduction disagrees with the analysis it publishes

Six figures in `eval/plans/tuning/01-branch-count.md` did not reproduce. In every case the reproduced value is the one used above.

1. **The per-summary token statistics are a different tokenizer.** The analysis reports mean 120.7, median 110, range 75–197 as cl100k counts of the 21 branch summaries. cl100k gives mean 120.5, median 109, range 76–196; the published triple is `gpt-tokenizer`'s default export, which is `o200k_base`. The harness itself imports `gpt-tokenizer/encoding/cl100k_base` (`transplant.mjs:85`), so cl100k is the right label and the numbers move by less than a token. Neither figure is the cost of showing a summary, which is the rendered block (mean 476 heuristic, 368 cl100k), not the prose.
2. **~465 heuristic tokens per additional visible summary** is computed as (7,701 − 2,587) / 11, where 7,701 is the Zone B *budget*. The assembled Zone B at that rung is 7,569, and the eleven bodies are 4,982 tokens, so the per-body figure for that set is 453, the mean over all 21 branches is 476, and the marginal cost of the 9 bodies the wide arm adds over the narrow one is 383 each.
3. **~4,185 extra heuristic tokens per turn and ~12,555 per run do not reproduce as a width cost.** They treat the extra bodies as added to `tree`'s Zone B, but the budget is fixed and the bodies replace 14 root headlines: assembled Zone B is 7,633 under `tree` and 7,569 under `tree-wide`. The measured first-turn prompt difference is 349 tokens.
4. **The agreement between prediction and measurement is not a confirmation.** The measured 12,168-token run gap is 3.1% below the 12,555 predicted, and the analysis reads that as confirming the gap lives in visible summaries. Per-turn accounting says otherwise: the gap is 349 tokens on turn 1, where Zone B is the only difference, and 6,464 by turn 6, where retrieval payload is.
5. **The 16k ladder does not fail the way it is described.** "Every rung from 40 down to 4 fails on `overBudget:["B"]`" holds for 40, 16, 12 and 8; rungs 6 and 4 fit the budget (3,538 and 3,105 against 3,850) and fail only for leaving no room for one body. The same distinction applies at 32,768 to rung 40, which fits and still fails.
6. **The 16k coverage figure is inverted.** "Visibility ends at seq 732 out of 754 (about 3% of L0 excluded)" describes the opposite of what the verdict says and what the store shows: the single visible body *covers* about 3% of the log (23 of 754 events); the other 97% is outside Zone B.

Two smaller descriptive slips, corrected above without affecting a conclusion: the store holds 21 leaf summaries and one root summary, not "22 leaf summaries" (the manifest's `summaries: 22` counts both, and the root carries 1,538 appended versions from repeated ladder walks); and the head-stratum "all rows" mean of 0.273 for `tree-wide` is the mean over the 11 rows carrying a score, which includes two fabricated zeros from harness-stopped runs — scoring all 15 attempted rows as zero gives 0.200, and the completed-only figure is 0.333.

Everything else reproduced exactly: the per-window `rootKeep`, root-block and `branchesSurviving` table; the ladder's recorded pass/fail rows at both windows; 0.091 against 0.333 on head with both baselines at 0.000; 0.200 and 0.333 for the baselines on tail; ~228 heuristic tokens per root headline; median run input 37,513 against 49,681 and its 12,168 gap; median turns 3 and 3 with means 3.00 and 3.24; median output 377 against 469; zero cache read and write on every row; head-stratum search rates of 8 of 11 and 8 of 9; the retrieval ranks 15, 11 and 15; and 21 branch nodes each with exactly one summary version.

## 8. Open items and recommendations

Ordered by expected information gained per unit of effort, measured in tokens and runs spent. The first three cost nothing but reading files already on disk.

1. **Correlate retrieval rank with score among runs that searched (zero runs, zero tokens).** Every row records its search queries; every question records its offline retrieval rank. If score tracks rank among rows that searched, a confidence-triggered widen is worth building and §5.2's verdict is refined rather than final. If score is uncorrelated with rank even when the model searched, the miss is in how results are used and no width policy addresses it. This is the cheapest remaining discriminator between the fit-derived and demand-driven policies.
2. **Re-derive every stratum mean in the committed fixtures with harness-stopped rows excluded (zero runs, zero tokens).** The nine rows identified here carry `score: 0` with an empty answer, and the harness has since been fixed to write `null`. Any figure quoted from these files before that fix understates the tree arms; the one that matters most is `tree-wide`'s head cell, published as 0.273 and actually 0.333 over completed runs. Re-emitting the fixtures' summary tables under the corrected rule removes a standing source of fabricated zeros from every later report.
3. **Publish the ladder reconstruction as a test (zero runs, zero tokens).** The reconstruction in Tables 1 and 2 — render each body, fill the Zone B remainder newest-first — reproduces every recorded `branchesSurviving` and every pass/fail row at both windows from the store alone. As an assertion it would catch a change in the fold or drop-oldest rules offline, and it is the instrument the rung sweep in item 4 needs anyway.
4. **Sweep the middle rungs on the head stratum (60 runs, ≈1.9M tokens).** Fold levels 12, 8, 6 and 4 pass the predicate at W=32,768 and render 5, 6, 8 and 10 bodies. Pinning each as a one-element ladder needs no new code and turns two points on the width axis into six, which is the only design in reach that can locate a turning point or show the effect is monotone in body count. Run it on the head stratum first, because it is the only stratum with any signal, and hold the two baselines from the same batch.
5. **Replicate the two existing endpoints on a second scenario (120 runs, ≈4M tokens).** The current effect is one question in one scenario at one window. A second frozen store run through the same two ladder directions, everything else fixed, is what promotes "walk toward maximising rendered bodies" from an observation to a default — or leaves the shipped headline-rich default standing. Lower priority than item 4 only because it costs twice as much and cannot find a turning point.
6. **Give the live suite a derived fold level (implementation, no new runs to decide it).** The portability harness derives the rung per window and per store; the live suite still uses the constant 40 (`packages/core/src/config.ts:117`). On this store, fold level 40 renders no body at all at W=32,768 and exceeds the whole Zone B budget at W=16,384, so the constant is not merely unvalidated, it is known to fail on the one store that has been measured. Porting the derivation is a defect fix, not an experiment.
7. **Measure width once under caching (6 runs per arm on one live scenario).** Everything above is from an endpoint that bills no cache. Under a cache the same reallocation is nearly free while the prefix is stable and expensive at each rewrite, so a width policy chosen here may be the wrong one there. This is last because it cannot be interpreted until the summary-timing dimension settles when Zone B is rewritten; running it before that measures the interaction, not the dimension.

## References

[1] `eval/plans/tuning/01-branch-count.md` — the analysis this report publishes, with its own citation trail.

[2] `reports/algorithm.md` — the four rules, the tier-2 `root keep` row, and the boundary condition that summaries do not contain the answer.

[3] `eval/scripts/transplant.mjs` — `ROOT_KEEP_LADDER` (line 385), `ARM_ROOT_LADDER` (398–410), `ladderFor` (423), `deriveRootKeep` (450), the fit predicate (564–581), the cl100k import (85), and the harness-stopped grading rule (3352–3366).

[4] `eval/fixtures/transplant/s1/e1b289c32f40/` — `manifest.json` (store hashes, windows, fractions, ratio 0.851, `root_by_window`), `gates.json` (the recorded ladder per window), `root-ladder.json` (root block size per rung), `questions.json` (twelve questions, strata, answer literals, offline retrieval ranks), and `results/run-W32768-truncate-tail+compact-rolling+tree-qwen_qwen-2.5-72b-instruct.json` and `results/run-W32768-tree-wide-qwen_qwen-2.5-72b-instruct.json`.

[5] `eval/fixtures/transplant/s1/store/tree.db` — 21 branch nodes with one summary version each; the rendered-body sizes in §4 were produced by `packages/core/dist/assemble/format.js`'s `renderSummaryBlock` and `HeuristicTokenizer` against a read-only query of this store.

[6] `eval/fixtures/transplant/JUDGE-VERDICT.md:145-171` — R4 and R5 (why the predicate assembles the real prompt), R6 (the pre-registered ablation trigger and the headline-rich posture), and the 16k retrieval-only caveat.

[7] `eval/plans/loop9-item3-sw3-overhead.md` — the live suite's overhead decomposition (69.5% re-read, 24.0% Zone A, 6.5% other), cited only to show it holds branch count fixed.

[8] `reports/metrics/context-tree-dsa-arm-experiments.md` §4 and `reports/metrics/context-tree-long-task-dsa-iterations.md` §4–§5 — the two branch-pruning arms that never fired, and the 7.7k–27.4k cache-write-on-rewrite measurement.

---

[^usd]: In United States dollars, at OpenRouter's `qwen/qwen-2.5-72b-instruct` rates of $0.36 per million input tokens and $0.40 per million output, with cache read and cache write billed at zero by this endpoint (`packages/core/src/models/cost.ts:83`), the median completed run costs $0.0082 under the truncate-tail baseline and $0.0048 under compact-rolling, against $0.0137 under `tree` and $0.0181 under `tree-wide`. Dollars appear here once, beside the baselines they are relative to; every claim in this report is made in tokens, turns, graded score and success counts.

DS-STAR dimension 1 · no new model runs · scores from the `s1` transplant fixture at W=32,768, qwen-2.5-72b-instruct, five replicates per question, completed runs only · Zone B token figures reconstructed offline from the frozen store with the assembler's own renderer and tokenizer · September 2, 2026.
