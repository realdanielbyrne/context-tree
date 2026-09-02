> Markdown equivalent of [tuning-branch-depth.html](./tuning-branch-depth.html). The HTML version is the canonical rendering; this file exists so the report is readable and diffable in git.

# How deep a branch goes before it is summarized

Context-tree evaluation program · DS-STAR tuning pass, dimension 2 of 4 · September 2, 2026 · commit `d1bced9`

> *Status and provenance.* This report is the full treatment of the dimension summarized in `reports/algorithm.md` under "What the DS-STAR loop is for". No language model was called to produce any figure in it. Every number was recomputed for this report from the frozen store at `eval/fixtures/transplant/s1/store/` (SQLite `tree.db`, `trace.jsonl`, `blobs/`), from the compiled segmenter `packages/core/dist/segment/segment.js` run against that store's event log, or from result files already on disk. Section 8 lists the places where the underlying analysis note and this report disagree, and in each case the report uses the value that reproduced.

## Abstract

Context-tree segments an agent's history into **branches** — contiguous stretches of work that each get one summary — and shows the model those summaries instead of raw events. How much work goes into one branch before it is summarized is that unit's **depth**, and it turns out to be nothing anybody chose: it is whatever the segmenter's tool-name-to-phase table and its neutral-merge rule happen to produce from a particular trace. On the one frozen store this repository has measured, that produces a 77-fold spread in branch size: 21 branches over 754 events, from 2,214 to 170,031 raw characters, median 23,515. One branch spans 207 events — 27% of the whole trace in a single node — and at an estimated 36,170 tokens it is larger than the entire 32,768-token window it was being retrieved into. It never closes because all 64 shell calls and 2 skill calls inside it map to the neutral phase, which by rule extends the open branch, while every non-neutral call inside it maps to the same phase type, so the one condition that could close it never fires across 22 alternating runs of tool identity. Three of the twelve evaluation questions source from that branch. The honest qualifier has to be said in the same breath: branch depth explains almost none of the retrieval failures actually measured on this store. In the 110-row failure sample that was forensically classified, "fetched the correct branch but it was truncated" is 0 cases, confirmed zero; and across all 180 tree-arm rows of the transplant sweep the oversized branch was fetched exactly once, with no truncation, at a peak request of 20,893 tokens — the models never went near it at full depth, so the risk never fired. Re-segmenting the same 754 events under a rule the code already accepts — an empty neutral-phase list, which the segmenter's own contract calls the literal reading of its specification — needs no new code and no size threshold, and turns 21 branches into 99 with a median of 3 events. Every one of the twelve questions then sources from a branch that fits both windows the harness actually runs questions at, where the shipped segmentation fails that test for 3 of 12 at 32,768 tokens and 7 of 12 at 16,384. The cost is 4.7 times the branches and therefore 4.7 times the leaf-summarizer calls, whose measured output is pinned near its 1,024-token ceiling on every call regardless of how small the branch is; on six long-task runs the leaf summarizer is already 6.9% to 19.3% of run cost, median 9.4%. What this closes is a boundary condition, not a scoring problem.

## 1. Terms, and what actually sets depth

A **branch** (a `phase` node in the code) is context-tree's unit of summarization: a contiguous range of the append-only event log that receives one summary and appears in the prompt as that summary rather than as its events. Its **span** is a pair of sequence numbers, `span_start_seq`–`span_end_seq`; branches partition the log, so every event belongs to exactly one branch. **Depth**, the subject of this report, is how much of the log one branch covers before it is closed and summarized. A **phase type** is a coarse label — `diagnosis`, `implementation`, `verification`, `delivery`, `review`, or `other` — assigned to a tool call by a lookup table. **W** denotes a model's context window in tokens.

The segmenter opens a branch on the first tool call and, on every later tool call, decides whether to close the open one. There is exactly one condition:

```
packages/core/src/segment/segment.ts:176
} else if (!neutral.has(phaseType) && open.phaseType !== phaseType) {
  // The literal §7 rule, but only for non-neutral phases (Ruling C6):
```

`neutral` is built from `config.neutralPhases` (`segment.ts:63`), whose shipped default is `['other']` (`packages/core/src/config.ts:113`). So an open branch survives any run of tool calls that either keep mapping to the same non-neutral type, or map to `other` — and a call mapping to `other` never closes anything, however many of them accumulate. The tool-to-phase table (`DEFAULT_TOOL_PHASE`, `config.ts:17-43`) has exactly 20 entries, of which `run_command` and `Bash` are commented "explicitly neutral" (`config.ts:41`); this repository's own `context-tree.config.json` — the config the frozen store was ingested under — adds `Skill` and `ToolSearch` to `other` as well.

Depth is therefore the joint product of two things nobody tuned against a metric: which phase types a given harness's tool names happen to map to, and how long a real task happens to stay inside one type, or inside `other`, before switching. Under the project's own rules for the algorithm, that is not a hardcoded value to be defended or replaced — it is an unmeasured consequence. The code already names the one alternative that requires no new code:

```
packages/core/src/contracts/segment.ts:56-57
 * Phases that attach to the open phase instead of opening a new one
 * (Ruling C6). Default `['other']`; `[]` restores the literal §7 rule.
```

Section 5 measures that alternative. Sections 2 to 4 establish what the shipped rule actually produces, and what it does and does not cost.

## 2. The measured size distribution on the frozen store

The store at `eval/fixtures/transplant/s1/store/` holds one task root, 21 branches and 24 file nodes over a 754-event trace (`SELECT kind, count(*) FROM nodes GROUP BY kind`). By phase type the 21 branches are `implementation` ×10, `diagnosis` ×7 and `delivery` ×4; `verification` and `review` never occur in this trace. The 21 spans sum to exactly 754 events, confirming the partition.

Raw size per branch is the sum, over every event in its span, of the byte size of that event's payload blobs (`blob`, `args_blob`, `output_blob`) — the same content `renderSpans` (`packages/core/src/retrieve/detail.ts:114-122`) concatenates, and therefore the same quantity a full-depth fetch of that branch would return, before the small per-event formatting that `renderSpans` adds. Token estimates are raw characters divided by four, times 0.850896663206653, this store's own measured heuristic-to-tokenizer ratio over all 697 payload blobs (`gates.json`, gate `g7-bpe-ratio`). The estimate is not a guess imported from elsewhere: it is re-derived per corpus, and on the one branch where an independent exact tokenizer count exists it agrees to four significant figures (§3).

| statistic | events | raw chars | est. tokens |
|---|---:|---:|---:|
| minimum | 2 | 2,214 | 471 |
| lower hinge | 10 | 5,284.5 | 1,124 |
| median | 17 | 23,515 | 5,002 |
| upper hinge | 52.5 | 34,923 | 7,429 |
| maximum | 207 | 170,031 | 36,170 |
| max ÷ min | 103.5× | 76.8× | 76.8× |

**Table 1.** Branch size on the frozen store under the shipped segmentation, n = 21 branches over 754 events. Medians are reported for size, as they are for tokens and turns throughout this program. Hinges are Tukey hinges (the medians of the lower and upper halves, the median itself excluded); the more common linear-interpolation convention gives a lower hinge of 10 events / 5,426 chars and an upper hinge of 51 events / 33,065 chars on the same data, which is why the convention is stated. The 77-fold spread in raw characters is the finding: nothing in the rule bounds it, in either direction.

**Figure 1.** Branch size distribution, shipped segmentation against the re-segmentation of §5, both computed from the same 754 events with no model call. Each series plots every branch's estimated size in tokens against its rank as a percentile, largest first — an inverse empirical distribution, so a point at percentile *p* reads "this fraction of branches is at least this large". Brown is the baseline, the shipped `neutralPhases: ['other']` rule (n = 21). Green is the candidate, `neutralPhases: []` (n = 99). The dashed lines are the two context windows the transplant harness actually asks questions at (`eval/scripts/transplant.mjs:99`). The baseline's largest branch sits above both; three more sit above the lower one. The candidate's whole distribution collapses toward the floor — its median branch is 648 estimated tokens against the baseline's 5,002 — while its own largest branch, 20,738 tokens over just 5 events, shows that a finer partition by tool identity does not bound branch size in tokens, because one very large tool result can dominate a branch of any event count.

*Figure 1 rendered in words for this markdown equivalent.* The baseline curve starts at 36,170 tokens at the 2.4th percentile, falls through 21,396 (7.1st), 17,907 (11.9th) and 17,743 (16.7th), then drops steeply to 7,824 at the 21.4th percentile and declines smoothly to 471 tokens at the 97.6th. Only the first point is above the 32,768 line; the first four are above the 16,384 line. The candidate curve starts at 20,738 tokens at the 0.5th percentile, 15,648 at the 1.5th and 10,696 at the 2.5th — its only three points above 10,000 — reaches 5,141 by the 7.6th percentile, is below 1,500 by the 20th, below 700 by the 50th, and ends at 49 tokens across its last six percentiles. It never touches the 32,768 line and crosses the 16,384 line only at its first point. The size quantiles behind both curves are Tables 1 and 8; the full baseline series is Table 2.

| branch | phase type | span | events | raw chars | est. tokens |
|---|---|---|---:|---:|---:|
| `n_1E48X9HA…` | implementation | 55–261 | 207 | 170,031 | 36,170 |
| `n_1BGBV85X…` | implementation | 267–276 | 10 | 100,579 | 21,396 |
| `n_1JNW5D8C…` | diagnosis | 1–54 | 54 | 84,179 | 17,907 |
| `n_1A84WKF2…` | delivery | 639–731 | 93 | 83,410 | 17,743 |
| `n_1PPHC64K…` | implementation | 732–754 | 23 | 36,781 | 7,824 |
| `n_15NSXSQ4…` | implementation | 430–488 | 59 | 33,065 | 7,034 |
| `n_11RPJ288…` | implementation | 359–389 | 31 | 30,459 | 6,479 |
| `n_1FJ2VN7B…` | implementation | 320–349 | 30 | 28,853 | 6,138 |
| `n_1KYBBC6P…` | diagnosis | 390–412 | 23 | 24,941 | 5,306 |
| `n_1C6D33C0…` | implementation | 588–638 | 51 | 24,081 | 5,123 |
| `n_1WAD2VDY…` | diagnosis | 489–553 | 65 | 23,515 | 5,002 |
| `n_1C0BDXFH…` | implementation | 554–570 | 17 | 14,801 | 3,149 |
| `n_16BHTPNT…` | diagnosis | 282–297 | 16 | 8,523 | 1,813 |
| `n_1F6E3RF1…` | diagnosis | 262–266 | 5 | 8,301 | 1,766 |
| `n_10MK5T7J…` | implementation | 298–307 | 10 | 8,053 | 1,713 |
| `n_1NH76HCY…` | diagnosis | 571–587 | 17 | 5,426 | 1,154 |
| `n_161P8JTC…` | delivery | 308–319 | 12 | 5,143 | 1,094 |
| `n_18ZHNQYZ…` | implementation | 413–427 | 15 | 4,868 | 1,036 |
| `n_1ZDHE482…` | delivery | 350–358 | 9 | 3,854 | 820 |
| `n_1TVA5EV1…` | diagnosis | 428–429 | 2 | 3,690 | 785 |
| `n_1X4N1KJ4…` | delivery | 277–281 | 5 | 2,214 | 471 |

**Table 2.** All 21 branches of the frozen store under the shipped segmentation, largest first; the baseline against which §5's candidate is measured. Every row was recomputed for this report from `tree.db` plus the payload blobs and reproduces the underlying analysis note exactly. Four branches exceed the harness's lower question window of 16,384 tokens on their own; one exceeds 32,768.

### 2.1. Nothing below a branch is ever summarized

The node-kind enumeration includes `'turn'` (`packages/core/src/contracts/tree.ts:11`), but nothing in `packages/core/src` ever emits a node of that kind; the only other reference, `ingest/apply.ts:134`, merely excludes such nodes from a filter. The one kind deeper than a branch that is actually produced is `file`: 24 nodes, one per distinct path touched by a file-shaped tool inside a branch (`config.ts:46-53`). Those nodes carry no summary of their own — joining `node_summaries` to `nodes` and grouping by kind returns rows only for `phase` (21) and `task` (1,538, from repeated root recomposition across the transplant sweep's window and arm combinations), and zero rows for `file`. So the finer structure the store already tracks is invisible to the prompt's summary section, and the branch is the deepest unit that is ever summarized at all.

## 3. The branch that exceeds the window it was read into

`n_1E48X9HAFPEYNQHHSF609KHMEE`, span 55–261, phase type `implementation`, is 207 of the trace's 754 events — 27.4% of the whole history in one node — and at 170,031 raw characters it is the only branch of 21 that exceeds 32,768 tokens on its own. This is the branch for which an exact tokenizer count already exists in the record: `eval/plans/loop9b-item2-judge-verdict.md:65` measures 170,031 characters as 36,170 cl100k tokens and annotates it "no — larger than W". The independent estimate recomputed here is 36,170, which is the cross-check quoted in §2 for the ratio method. Three of the twelve evaluation questions source from inside this one branch: `s1-q01-head` at seq 175, `s1-q07-deep` at seq 55 — the branch's own opening event — and `s1-q10-spanning` at seq 173.

| tool | calls | mapped phase | neutral? | can close the branch? |
|---|---:|---|---|---|
| `Bash` | 64 | `other` | yes | no |
| `Edit` | 12 | `implementation` | no | only on a type change |
| `Skill` | 2 | `other` | yes | no |
| `Write` | 2 | `implementation` | no | only on a type change |
| total | 80 | — | — | — |

**Table 3.** Every tool call inside span 55–261, counted directly from `trace.jsonl` for events of type `tool_call` with 55 ≤ seq ≤ 261. This is the mechanism, and it is complete: both neutral tools extend the open branch by rule and can never close it, and both non-neutral tools map to `implementation`, the type already open, so `open.phaseType !== phaseType` is false every time. The 80 calls form 22 runs of consecutive same-tool identity — the alternating edit-then-run shape of a long build-and-debug cycle — and not one of those 22 transitions is a phase-type transition. Under the shipped rule the entire cycle is one leaf however long it runs.

| file node | span | starts at | ends at |
|---|---|---:|---:|
| `build-multimod-scenario.py` | 55–261 | 55 | 261 |
| `loop.ts` | 93–261 | 93 | 261 |
| `loop.test.ts` | 103–261 | 103 | 261 |
| `ct-stats.mjs` | 115–261 | 115 | 261 |
| `format.ts` | 159–261 | 159 | 261 |
| `assemble.test.ts` | 180–261 | 180 | 261 |

**Table 4.** The six file nodes the store already tracks inside the oversized branch, from `tree.db`. They are interleaved, not sequential: six distinct start points, one shared end point, because editing moved back and forth across all six files for the branch's whole 207-event length. This matters for §7's assessment of promoting file nodes to a summarized unit — the sub-structure exists, but it does not partition the branch.

**What this establishes, and what it does not.** Measured: one branch on this store is larger, alone, than the window the harness reads it into, and the rule that produced it contains nothing that could have prevented that. Not measured, and the subject of the next section: whether that ever cost a retrieval.

## 4. What branch depth does not explain

This section is placed before the fix rather than after it because it changes what the fix is for. `eval/plans/loop9b-analysis/01-run-forensics.md` is the one analysis that forensically classified retrieval outcomes on this exact store: 135 sampled model-turn transcripts, across the `head`, `tail` and `deep` question strata, the `tree` and `tree-wide` arms and both models, sorted into six mutually exclusive mechanisms by matching each row's recorded `fetchedIds` against the question's true source node.

| mechanism | rows | % of 135 | % of 110 failures |
|---|---:|---:|---:|
| searched, never called `context_fetch` | 47 | 34.8% | 42.7% |
| fetched a wrong branch | 44 | 32.6% | 40.0% |
| never searched, never fetched | 12 | 8.9% | 10.9% |
| fetched the correct branch, no truncation, still wrong | 6 | 4.4% | 5.5% |
| fetched the correct branch, then stopped by the turn ceiling | 1 | 0.7% | 0.9% |
| **fetched the correct branch but it was truncated** | **0** | **0.0%** | **0.0%** |
| infrastructure error (excluded) | 21 | 15.6% | — |
| success (excluded) | 4 | 3.0% | — |

**Table 5.** Mechanism aggregation from `01-run-forensics.md` §8, n = 135 sampled rows, 110 of them scored failures. The last mechanism is the only one branch depth could cause, and it is zero. Two cautions belong with this table. First, the two dominant rows are about whether the model looked at all, not about what it would have found. Second, a separate 5.2% of the 135 rows (7 rows) were stopped by the harness's own turn ceiling of six turns (`transplant.mjs:123`); a run the harness stopped is not evidence that the task was failed, and those rows sit inside the 110-row failure denominator, so every percentage in the right-hand column is very slightly pessimistic against the tree.

Restated against this report's own distribution: the single branch structurally capable of causing a truncated fetch — the 36,170-token branch behind q01, q07 and q10 — never caused one. The census below is new to this report and is stronger than the sampled evidence, because it covers every row of the sweep rather than a sample.

| population | rows | fetched the oversized branch |
|---|---:|---:|
| all rows, all arms | 444 | 1 |
| `tree` and `tree-wide` rows | 180 | 1 |
| tree-arm rows on the three questions it sources | 45 | 1 |
| — of those, searched at all | 24 | — |
| — of those, fetched anything at all | 21 | — |
| — of those, any fetch truncated | 3 | 0 |

**Table 6.** How often the oversized branch was actually retrieved, counted over every row in the five `run-*.json` files of the transplant sweep. The one row that fetched it (`tree-wide`, qwen-2.5-72b-instruct, W = 32,768, `s1-q10-spanning`, replicate 3) recorded `resultsTruncated: 0` and a peak request of 20,893 tokens — far below both the branch's own 36,170 and the window — and its answer text discusses the content of one file inside the branch, so it did not receive the branch at full depth either. The three truncation events among those 45 rows all struck a different, incorrectly targeted branch and elided 110 to 208 tokens. The tree-arm rows show 18 truncation events in total, none of them on this branch.

Table 7 gives the graded outcome those rows produce, paired arm against baseline at a fixed model, window and epoch. It is included because the metric that matters is score and turns, not the mechanism count, and because it carries a correction.

| arm · stratum | scored n | mean score | successes | median turns | median context tok |
|---|---:|---:|---:|---:|---:|
| `truncate-tail` · head | 14 | 0.000 | 0 | 1 | 22,638 |
| `compact-rolling` · head | 15 | 0.000 | 0 | 1 | 13,143 |
| `tree` · head | 11 | 0.091 | 1 | 2 | 31,584 |
| `tree-wide` · head | 9 | 0.333 | 3 | 3 | 51,373 |
| `truncate-tail` · deep | 15 | 0.000 | 0 | 1 | 22,642 |
| `compact-rolling` · deep | 15 | 0.000 | 0 | 1 | 13,147 |
| `tree` · deep | 11 | 0.000 | 0 | 4 | 54,100 |
| `tree-wide` · deep | 7 | 0.000 | 0 | 3 | 33,531 |
| `truncate-tail` · tail | 15 | 0.200 | 3 | 1 | 22,632 |
| `compact-rolling` · tail | 15 | 0.333 | 5 | 1 | 13,137 |
| `tree` · tail | 11 | 0.000 | 0 | 3 | 50,709 |
| `tree-wide` · tail | 13 | 0.000 | 0 | 3 | 31,477 |

**Table 7.** Graded outcome by arm and stratum, all cells at qwen-2.5-72b-instruct, W = 32,768, one epoch, 15 attempted replicates each. Scores are means, turns and context tokens are medians, per this program's convention. Context tokens are fresh input plus cache reads plus cache writes, summed over a row's turns. **Correction applied.** The stored result files score every turn-capped row 0, but the harness's own grader now refuses to do that — `transplant.mjs:3366` makes a harness-stopped run ungradable, on the recorded reasoning that "`null` is the only honest value, never `0`" — and the files on disk predate that change. All 9 turn-capped rows in the sweep are therefore excluded here, along with the 60 rows the harness already excluded as provider infrastructure errors, which is why scored n falls below 15 in six cells. Only one cell's mean moves: `tree-wide` · head is 0.333 (3 of 9) corrected, against 0.273 (3 of 11) if the two fabricated zeros are left in. The uncorrected 0.273 is the figure the source analysis quotes; the corrected 0.333 is the figure `reports/algorithm.md` carries.

**The qualifier, stated plainly.** Branch depth bears on exactly one of the six measured mechanisms, and that mechanism is zero. It is a contributing but unconfirmed factor in a second — the 4.4% "fetched correct, no truncation, still wrong" bucket — where `01-run-forensics.md` §6 explicitly declines to attribute cause, because the harness never recorded which `depth` argument a fetch used. The remaining four mechanisms, covering the overwhelming majority of failures, are about whether and where the model looked. The proximate cause upstream of the oversized branch is query formation: `deep`-stratum failures are 62% wrong-branch fetches, and for q07 the branch has the best self-retrieval rank in the whole gate suite — 1 of 19 ranked candidates, `gates.json` gate `g15` — yet zero of 15 sampled replicates ever fetched it. A risk that never fires because a different failure happens first is still a risk worth closing, but closing it should not be expected to move a score.

### 4.1. A claim about the tail stratum that does not hold

One explanation in circulation attributes the `tree` arm's 0.000 on the `tail` stratum to the newest branch starting too late — at seq 732, when the questions need 720–731. Neither source supports it, and this report's own node table contradicts it. `01-run-forensics.md` §3 states the opposite directly: all three tail sources — q04 at seq 728, inside branch 639–731, and q05/q06 at seq 744 and 746, inside branch 732–754 — are *inside* the visible summary range 639–754. Table 2 above confirms independently that those are exactly the two most recent branches. `loop9b-item2-judge-verdict.md:231-234` relies on the same fact as its stated reason for rejecting a different design, on the grounds that pre-filling the active zone with the newest branch's raw detail "hands the tail stratum its answer by construction" — which is a problem only because the range already covers it. The sourced explanation is behavioural, not structural: 34.8% of sampled rows searched and never fetched, and a further 8.9% never searched, so a model that can already see a one-paragraph summary of the right branch has no trigger to re-fetch it at full depth. That is a question about tool-use policy and summary content, and nothing about branch granularity would change it — the branch holding the answer is already visible and already correctly sized.

## 5. The config-only re-segmentation, and what it produces

Splitting a branch once its rendered size crosses a threshold is a cap: a number picked in advance about how much work should fit in one unit, imposed regardless of what the unit is. The alternative measured here is structural instead — derived from the trace's own shape — and needs no source change at all, because `segment()` already accepts `neutralPhases` as a parameter and is pure by construction. It was run directly against the frozen store's 754 events through the compiled segmenter, with the same tool-to-phase map the store was built from; running it with the shipped `['other']` reproduces the store's 21 branches and their exact spans, which is what makes the comparison a controlled one.

| quantity | baseline `['other']` | candidate `[]` |
|---|---:|---:|
| branches | 21 | 99 |
| events per branch, min / median / max | 2 / 17 / 207 | 2 / 3 / 88 |
| est. tokens per branch, median | 5,002 | 648 |
| est. tokens per branch, max | 36,170 | 20,738 |
| branches over W = 8,192 | 4 | 3 |
| branches over W = 16,384 | 4 | 1 |
| branches over W = 32,768 | 1 | 0 |
| branches over W = 65,536 | 0 | 0 |
| file nodes | 24 | 30 |
| branches typed `other` | 0 | 47 |

**Table 8.** The two segmentations over the same 754 events, zero model calls, same store, same tool map. Windows are the five the harness's nesting sweep covers (`transplant.mjs:101`); questions are only ever asked at 16,384 and 32,768 (`:99`). Two entries deserve care. The candidate still leaves one branch above 16,384 tokens — 20,738 tokens over 5 events — so "the over-window branch disappears" is true at 32,768 and false at 16,384; no question sources from that branch. And 47 of the candidate's 99 branches are typed `other`, meaning nearly half of the new units are runs of shell commands with no phase identity of their own, which is a summary-quality question this pass did not measure.

**Figure 2.** For each of the twelve evaluation questions, the estimated size of the single branch its answer literal sits inside — baseline against candidate, same trace, same store, no model call. Brown is the shipped segmentation, green is `neutralPhases: []`. The dashed lines are the two windows the harness asks questions at, 16,384 and 32,768 tokens. Under the baseline, q01, q07 and q10 (all sourced from the 207-event branch) sit above both lines, and q03, q04, q09 and q12 sit above the lower one: 3 of 12 questions cannot fit their own source branch into W = 32,768, and 7 of 12 cannot fit it into W = 16,384. Under the candidate every one of the twelve sits below both lines, with the largest at 15,648 tokens. Fitting the window is necessary, not sufficient — §4 shows the models mostly never reached these branches at all.

*Figure 2's data is Table 9.* The brown series is the "est. tok" column under the baseline branch; the green series is the "est. tok" column under the candidate branch; the two horizontal reference lines are at 16,384 and 32,768 tokens.

| question | seq | baseline branch | est. tok | candidate branch | est. tok |
|---|---:|---|---:|---|---:|
| q01 · head | 175 | 55–261 | 36,170 | 169–179 | 1,358 |
| q02 · head | 558 | 554–570 | 3,149 | 556–570 | 2,506 |
| q03 · head | 18 | 1–54 | 17,907 | 17–18 | 7,499 |
| q04 · tail | 728 | 639–731 | 17,743 | 642–729 | 15,648 |
| q05 · tail | 744 | 732–754 | 7,824 | 734–754 | 6,469 |
| q06 · tail | 746 | 732–754 | 7,824 | 734–754 | 6,469 |
| q07 · deep | 55 | 55–261 | 36,170 | 55–57 | 5,141 |
| q08 · deep | 559 | 554–570 | 3,149 | 556–570 | 2,506 |
| q09 · deep | 41 | 1–54 | 17,907 | 19–41 | 2,605 |
| q10 · spanning | 173 | 55–261 | 36,170 | 169–179 | 1,358 |
| q11 · spanning | 467 | 430–488 | 7,034 | 465–484 | 1,520 |
| q12 · spanning | 691 | 639–731 | 17,743 | 642–729 | 15,648 |

**Table 9.** Per-question containment, n = 12 questions, both segmentations over the same events. Sequence numbers are from `questions.json`. Every question falls inside exactly one branch under both rules, which is true by construction and checked here only as a regression guard. At W = 32,768 the baseline fails containment for 3 of 12 and the candidate for 0 of 12; at W = 16,384 the baseline fails for 7 of 12 and the candidate for 0 of 12. At W = 8,192 the candidate fails for 2 of 12 (q04 and q12, at 15,648 tokens), but that window is already a dead cell for the tree arms — gate `g9` records that no fold level at 8,192 leaves room for a single branch summary — so it is not a window at which any question is asked. A stricter and more operational criterion than "fits W" is the measured turn-one headroom the same store's judge verdict reports, 22.8k tokens at W = 32,768 and 10.25k at W = 16,384: against that, the baseline contains 9 of 12 and 5 of 12 respectively, and the candidate 12 of 12 and 10 of 12.

## 6. What the finer partition costs

99 branches against 21 is 4.71 times the units, and therefore 4.71 times the number of leaf-summarizer calls, since exactly one leaf pass is made per branch. The measured shape of that cost, from the six long-task runs whose result files record cost by model, is below. These are the only runs in the repository where the summarizer fired at all: on five short-task runs whose size gate never crossed, its share is 0% on every run.

| run | leaf calls | input tok / call | output tok / call | leaf share of run cost |
|---|---:|---:|---:|---:|
| sw-5-dozen r1 | 3 | 6,174 | 919 | 6.9% |
| sw-5-dozen r2 | 2 | 7,402 | 640 | 7.6% |
| sw-5-dozen r3 | 2 | 8,248 | 1,170 | 8.4% |
| sw-6-ripple r1 | 3 | 6,085 | 932 | 10.3% |
| sw-6-ripple r2 | 5 | 4,940 | 834 | 13.6% |
| sw-6-ripple r3 | 9 | 8,918 | 1,005 | 19.3% |
| median | 3 | 6,788 | 926 | 9.4% |

**Table 10.** Leaf-summarizer cost, n = 6 runs, all context-tree arm, claude-sonnet-5 as the agent and claude-haiku-4-5 as the leaf summarizer, one batch (`eval/results/long-v65-gate/*/results.json`). Share is the haiku line divided by the run's total across all models; root composition contributes nothing in these runs because the harness made it a pure function over leaf headlines. Recomputed here from the stored `costByModel` blocks: n = 6, median 9.35%, range 6.9% to 19.3%. The load-bearing column is output per call. Every one of the six runs sits between 640 and 1,170 tokens, against a configured ceiling of 1,024 (`config.ts:118`) — so leaf output is essentially saturated at the ceiling regardless of how large the branch was, and 4.71 times the calls is 4.71 times the leaf output tokens. Input per call, by contrast, is dominated by the branch's own detail, so a finer partition of the same trace roughly conserves total leaf input and adds one fixed prompt per extra call; that decomposition is a hypothesis from these six runs, not a measurement, because the stored usage does not separate the summarizer's own prompt from the branch content it carries.

The relationship between that share and the tree's overall cost position is worth stating precisely, because it is often compressed. Two reports bear on it and they name different passes. `reports/metrics/context-tree-long-task-dsa-iterations.md` §5 lists three add-backs that make long tasks cost more even while fresh input falls, and the first is the *root* summarizer at sonnet prices re-running on every threshold crossing, with a second entry for a contract failure that re-billed the same node three times in one run. `eval/plans/tuning/03-summary-policy.md` §3(c) is the one that measures the *leaf* summarizer, and gives the numbers in Table 10. So the accurate statement is that summarization is the dominant residual cost line, that its measured leaf component is a median 9.4% of run cost arriving as a single batch, and that only one of the two reports attributes cost specifically to leaf passes.

## 7. The offline procedure that ranks candidate segmentations

Everything in §5 was produced by the following recipe, which costs nothing and is stated so that a second candidate or a second store can be run through it unchanged.

1. **Re-segment the frozen store's event log under each candidate configuration.** `segment()` is pure and already parameterised on `neutralPhases`. Gate `g5-rebuild-determinism` already establishes that re-deriving the tree from the log alone reproduces the current node identifiers and spans exactly, so the re-derivation is faithful to the same invariant the store's gate suite checks.
2. **Locate every question's sequence number in the new segmentation and record two facts** — whether it lands inside exactly one branch (true by construction; a regression guard, not a discovery), and whether that branch's estimated size fits each window. Size is estimated as characters ÷ 4 × the store's own measured ratio, the same re-derived-per-corpus procedure used for the ratio itself, applied per branch instead of once over the corpus. Run here over all five nesting windows, not only 32,768.
3. **Count branches and their size distribution** as the zero-token proxy for summarizer-call cost. Table 8 is that count; Table 10 gives the per-call constants it must be multiplied by, which is the part that makes the proxy interpretable rather than merely comparable.
4. **Re-run the harness's own zero-token structural gates against each candidate's re-derived tree.** `g8-over-budget` (`transplant.mjs:1934-1969`: does the summary section still fit, with at least one branch summary surviving) and `g9-zone-b-nesting` (`:1972-2034`: does the newest-aligned contiguous-suffix property still hold) are exactly the invariants a segmentation change could break, and both are already pure functions of a store and a window. Not run in this pass. It is the missing step: a candidate that multiplies branch count by 4.71 changes how many branch summaries fit a given budget, which is precisely what `g8` asserts, and the interaction with the fold level is unexamined.

## 8. Departures from the source analysis

Every load-bearing figure in the underlying note was checked against the artifacts it cites. The following did not reproduce as stated; in each case the value used above is the reproduced one.

- "The only branch of 21 that exceeds any tested window" holds only at W = 32,768. At W = 16,384, also a window the harness asks questions at, four branches exceed the window: 36,170, 21,396, 17,907 and 17,743 estimated tokens. The consequence runs the same direction as the note's argument but is larger than the note claims: 7 of 12 questions, not 3, source from a branch too big for W = 16,384.
- "Every one of the twelve questions now sources from a branch that fits inside every tested window" holds at 16,384, 32,768, 65,536 and 200,000, and fails at 8,192, where q04 and q12's 15,648-token branch does not fit. That window is already recorded as a dead cell for the tree arms, so nothing depends on it, but the unqualified claim is wrong. At the branch level the candidate also still leaves one branch (20,738 tokens) above 16,384.
- The note's per-question table gives q02's and q08's baseline branch as 3,150 tokens; every other computation of the same branch, including the note's own distribution table, gives 3,149. A rounding slip, corrected here.
- "Two independent reports already identify leaf-summarizer calls as the largest lever" overstates one of the two. The long-task report names the *root* summarizer at sonnet prices as its first add-back; only the summary-policy note measures the leaf summarizer's share. §6 states it as measured.
- Two line anchors have drifted since the note was written, because `eval/scripts/transplant.mjs` has been edited: `g8` is at `:1934-1969`, not `:1926-1959`, and `g9` at `:1972-2034`, not `:1961-2020`. In `config.ts` the shipped `neutralPhases` default is at `:113`, the tool table at `:17-43` with its "explicitly neutral" comment at `:41`, and the file-tool list at `:46-53`. Every anchor's content is as described.
- The distribution note reports the branch range as "roughly 471 to 36,170 measured BPE tokens". Only the upper figure is a tokenizer measurement (from the judge verdict's exact count); the rest are estimates from the character-ratio method. Labelled as estimates throughout above.
- The note's quartiles (52.5 events, 34,923 characters) reproduce under Tukey hinges but not under the linear-interpolation convention, which gives 51 and 33,065. Both are stated in Table 1 with the method named.

Everything else reproduced exactly, including all 21 rows of Table 2, the 64/12/2/2 tool census and its 22 runs, the six interleaved file nodes and their start sequences, the 0.850896663206653 ratio over 697 blobs, the 99-branch re-segmentation with its 2/3/88 event range and 20,738-token maximum, all twelve candidate branch spans and sizes, the zero-truncation finding, q07's rank of 1 of 19, and the leaf-summarizer shares of Table 10 to the nearest tenth of a percent.

## 9. Limitations

The evidence base is one store. Everything above rests on `transplant/s1`: one trace, one task, one host's tool-name map, 754 events. The mechanism in §3 is a statement about that trace's tool mix, and the mix of neutral to non-neutral calls — and therefore the size at which a branch stops closing — could differ substantially on another harness's tool surface. Nothing here has been shown to hold off the host it was measured on, which is the standard the project's own rules set for any value carried forward.

No live run has compared the two segmentations. Tables 8 and 9 are containment and branch count; Table 10 is the cost side of the shipped configuration, not of the candidate. Turns and graded score under `neutralPhases: []` are unmeasured on every task, short or long, so the question the fourth rule asks — which setting wins — remains open, and §5 is not a recommendation to ship.

Two structural alternatives were assessed and not tested. Promoting file nodes to a second summarized unit is attractive because the store already tracks them at no guessing cost, but Table 4 shows the oversized branch's six file nodes are interleaved rather than sequential, so a one-file-per-unit split would not partition that branch cleanly; it would have to interleave the way the events do, which re-derives §5's result from a different axis rather than adding a mechanism. Reclassifying neutral tools by command content rather than tool name is the more interesting of the two — the 64 shell calls in the oversized branch plausibly include test runs, and `verification` is a phase type the table already has and this trace never used — but today's segmenter classifies only on the tool name, never on the arguments, so that is a segmenter change rather than a configuration change, and it was not implemented or measured.

Finally, one thing this dimension cannot settle. Median branch size falling from 17 events to 3 puts many branches at roughly one tool call plus its result. Whether a summary of that little work is worth its own leaf pass — whether summaries this granular are less useful per token spent on them — is a summary-quality question, and 47 of the candidate's 99 branches carrying no phase identity beyond `other` sharpens it. Nothing in this pass measured summary quality at either granularity.

## 10. Open items and recommendations

Ordered by expected information gained per unit of effort, where effort is counted in tokens and runs spent. The first three cost nothing.

1. **Run step 4 of §7 against the candidate: re-check `g8` and `g9` on the re-derived 99-branch tree.** Zero tokens, zero runs, and it is the one result that could invalidate §5 outright — 4.71 times the branches changes how many branch summaries fit the summary budget, which is exactly what `g8` asserts, and the fold level interacts with it. No further work on this dimension should be sequenced ahead of this check.
2. **Extend the containment sweep to a second store.** Zero tokens. Every limitation in §9 is the same limitation — n = 1 store — and the recipe in §7 is already written and runs offline. A second trace from a different harness's tool surface would establish whether the 77-fold spread and the neutral-merge mechanism are properties of the rule or of this one session, which is the single largest unknown here.
3. **Translate branch count into summarizer cost arithmetically before spending anything live.** Zero tokens. Table 10 supplies the per-call constants and Table 8 the count; the missing piece is whether total leaf input is really conserved under a finer partition, which can be answered by summing the candidate's 99 branch spans and comparing against the baseline's 21 rather than by running anything.
4. **Record the `depth` argument on every `context_fetch`.** One instrumentation change, no model calls to add it, and it retires the largest interpretive gap in §4: the 4.4% "fetched correct, still wrong" bucket cannot be attributed today, and neither can the single fetch of the oversized branch in Table 6. Every future run then discriminates a tool-design limit from a model-competence limit for free.
5. **Only then, one live comparison of the two segmentations on the questions that change.** The three questions whose source branch shrinks by more than an order of magnitude — q01, q07, q10 — are where any effect must appear, and §4 predicts no effect, because the models never reached that branch. That prediction is worth one small paired run precisely because it is falsifiable and cheap, and because a confirmed null is what licenses treating this dimension as closed. Do not run the whole twelve-question sweep to learn it.
6. **Content-sensing for neutral tools, last.** Recognising test-shaped shell commands as `verification` is the most promising remaining lever on depth and the only one that would give this trace a phase type it currently never produces, but it is a segmenter change, it needs a per-host derivation procedure to avoid becoming a guessed constant, and it should not be built before items 1 and 2 have shown that depth is worth changing at all.

## References

[1] *The context-tree algorithm*, `reports/algorithm.md` in this repository — the four rules this pass is scored against, and the summary of this dimension that this report is the full treatment of.

[2] *Run forensics on the transplant sweep*, `eval/plans/loop9b-analysis/01-run-forensics.md` — the six-mechanism classification of 135 sampled rows used in §4.

[3] *Judge verdict, loop 9b item 2*, `eval/plans/loop9b-item2-judge-verdict.md` — the exact-tokenizer branch sizes and turn-one headroom figures used in §3 and §5.

[4] *When summaries are written, and under what policy*, `eval/plans/tuning/03-summary-policy.md` §3(c) — the leaf-summarizer cost measurement reproduced in Table 10.

[5] *Why more money while reducing tokens*, `reports/metrics/context-tree-long-task-dsa-iterations.md` §5–§6 — the add-back attribution and defect ledger discussed in §6.

[6] DS-STAR, the iteration methodology these tuning passes adapt: arXiv:2509.21825.

---

<sup>†</sup> In United States dollars, at the harness's rates of $1.00 per million input and $5.00 per million output tokens for claude-haiku-4-5, and $2.00 input / $10.00 output / $0.20 cache read / $2.50 cache write per million for claude-sonnet-5 (`packages/core/src/models/cost.ts`), the median context-tree run on sw-6-ripple costs $0.336, of which the leaf summarizer is $0.046, against the native transcript baseline's median $0.165 on the same scenario, model and epoch. Dollars appear here once, beside the baseline they are relative to; every claim in this report is made in tokens, turns, graded score and success counts.

DS-STAR tuning pass, dimension 2 of 4 · zero live model calls · Tables 1–4 and 8–9 and both figures recomputed from `eval/fixtures/transplant/s1/store/` and `packages/core/dist/segment/segment.js` · Tables 5–7 from `eval/plans/loop9b-analysis/01-run-forensics.md` and the five `run-*.json` files of the transplant sweep, qwen-2.5-72b-instruct and gpt-3.5-turbo, one epoch · Table 10 from `eval/results/long-v65-gate/`, claude-sonnet-5 with claude-haiku-4-5 summaries, three replicates per scenario, one epoch · September 2, 2026 · commit `d1bced9`.
