> Markdown equivalent of [tuning-pass-report.html](./tuning-pass-report.html). The HTML version is the canonical rendering; this file exists so the report is readable and diffable in git. Where the HTML carries an inline SVG chart, this file carries the same data as a table.

# Closing report of the four-dimension tuning pass

Context-tree evaluation program · DS-STAR pass, iterations 1–3 · September 2, 2026 · commit `77d5326`

> *Who this is for.* We wrote this for the next agent who picks the work up with no memory of the pass. It says what is settled and with which number, what is dead and must not be re-run, what we learned about our own instruments, where the code stands by path, and what to do next in what order. It is meant to agree with `reports/algorithm.md`, which is the reference description of the algorithm and the document to edit alongside any change. Where this report and that page disagree, that page is authoritative on the algorithm and this one is authoritative on what this pass measured.

## Abstract

Context-tree rewrites an agent's linear conversation into a summary-headed tree. Stretches of completed work become short summaries in the prompt, and the raw events stay on disk behind four retrieval tools. The algorithm leaves four settings open: how many branch summaries the model sees, how coarsely the trace is cut into branches, when summarization starts, and how the prompt is marked for the provider's cache. This pass set out to fix all four by measurement, over three DS-STAR iterations. The first iteration only analysed artifacts that were already on disk, so it produced knowledge rather than improvement; the second and third ran seven experiments between them, and none of the seven called a model.

We closed two of the four settings. Summarization starts one turn late, because the gate compares the previous turn's billed prompt against the threshold instead of the prompt it is about to send; across six live crossings it overshot the threshold by a median 8,306 tokens (n=6, claude-sonnet-5), and replaying those crossings against the prompt about to be sent brings the median overshoot to 0. The cache simulator had reported that adding a third cache breakpoint costs 23% more; when we corrected the rule by which it credits a cache read, the same simulator on the same 754-turn replay reported 39.8% less session cost, which agrees in sign with an already-published live run of the same design that measured 18% less cost per turn (n=5).

We did not close the other two. How many summaries to show and how finely to cut the trace are both blocked by how rarely retrieval succeeds at all: 4 successes in the 120 rows where the model searched. That is a floor in the retrieval behaviour, not a shortage of budget, and more spend does not move it.

The pass refuted more than it confirmed, and three of the refuted claims were ones `reports/algorithm.md` itself carried. Every measurement here comes from a single recorded session of 754 events and from two test scenarios, and no dimension was measured on more than one model family, so nothing in this report has been shown to hold on a different trace, a different task, or a different provider.

## 1 Terms

This section defines the vocabulary the rest of the report uses. A reader who skips it will meet the same terms again, glossed, at their first use in the body.

**Measurement.** A **turn** is one model call. A **run** is one arm attempting one question or one scenario once. A **replicate** is one run inside a cell, and **n** is the number of replicates behind a figure. An **epoch** is a batch of runs made in one sitting against one build of the code, so two arms compared inside an epoch saw the same code, the same task material and the same model snapshot. An **arm** is one configuration under test, and its **baseline** is the arm it is paired against.

**What we measured on.** The **frozen session** is the recorded trace this pass measured on. It is a real Claude Code session on this repository, whose own event log names `claude-fable-5` as the model that produced it, ingested into 754 events; the repository calls it the `s1` fixture and pins its hashes in a manifest. A **store** is the on-disk form of an ingested session: **L0** is the append-only event log, **L2** the content-addressed payload blobs, and **L1** the SQLite database of nodes and summaries derived from both. Twelve questions are asked against the frozen session, and they fall into four **question types**, which the code calls strata: a **head** question asks for a fact from early in the session, a **tail** question for a recent fact, a **deep** question for a verbatim code literal, and a **spanning** question for a fact that needs two places in the trace at once. The harness that asks them is `eval/scripts/transplant.mjs`.

**Structure.** A **branch** (a `phase` node in the code) is context-tree's unit of summarization: a contiguous range of the event log that receives one summary. The prompt is assembled in three fixed sections. **Zone A** holds the frozen contract, meaning the system prompt and the tool schemas. **Zone B** holds the root index plus the branch summaries, in creation order. **Zone C** holds the active branch's raw detail. Retrieved results append after Zone C. **W** is the model's context window, and each zone is allotted a fixed fraction of W, which this report calls that zone's **share**. The **leaf summarizer** is the cheap model call that summarizes one branch; the **root summary** is the index over the whole tree, recomposed whenever the fold level changes.

**Width.** The **fold level** (`rootKeep` in the code) is how many of the most recent branches get their own headline line in the root index before older ones fold into a single line. A **rendered body** (`branchesSurviving`) is a branch whose full summary block renders separately in Zone B. The two counts move in opposite directions, because both are paid out of the one Zone B share. The **fold ladder** is the list of fold levels the assembler will try, in order: 40, 16, 12, 8, 6, 4, 2. Two shipped arms sit at its two ends. The **narrow arm** (`tree`) walks the ladder from 40 downward and stops at 16; the **wider arm** (`tree-wide`) walks it reversed and stops at 2. Where this report says width, it means that choice.

**Switching and caching.** The **switch point** is the prompt size at which the tree stops showing the whole raw trace and starts showing summaries instead, and the **latch** is the rule that once the switch has happened it never reverts. A **cache read** is a prompt token the provider served from a stored prefix; a **cache write** is one it had to store fresh. A **breakpoint** is a `cache_control` marker telling the provider where a cacheable prefix ends. **Exact tokens** means a cl100k BPE count. **Heuristic tokens** means the assembler's own estimator, which over-counts real BPE by about 1.18× on this corpus.

**Reporting conventions.** Metrics throughout are tokens, turns, graded score and success counts. Scores are means; tokens and turns are medians. Every figure pairs a candidate against a baseline at the same model and the same epoch. Dollar figures appear only in the footnote, beside the baseline they are relative to.

## 2 What this pass set out to do, and how the three iterations ran

`reports/algorithm.md` scores the algorithm against four rules: impose no budgets or caps; treat a hardcoded value as a defect unless it has been shown to hold off the host it was fitted on; derive a parameter from a model's limits where you can, but never guess it; and prefer finding a sweet spot to picking a bound. That page then names four dimensions in which a real tradeoff exists and no winning setting has ever been established: visible branch count, which is how many branch summaries the model sees; branch depth, which is how coarsely the trace is cut; summary timing, which is when summarization starts; and caching, which is how the prompt is marked for the provider's cache. Our objective was to establish those four settings by measurement.

We scoped the work against the constant-and-boundary audit in `eval/plans/portability-audit/`, and that audit's headline finding frames everything below: `packages/core` had no representation of the host's window size anywhere. Every value the audit's tier-2 table says should be a fraction of W was therefore a plain integer literal, because there was nothing in the library to divide by.

### 2.1 Iteration 1 — analysis only, and it produced knowledge rather than improvement

The first iteration ran four analyses, one per dimension, at zero model calls: `eval/plans/tuning/0{1,2,3,4}-*.md`, published as four reports under `reports/metrics/tuning-*.md`. No configuration changed and no arm was run. What the iteration bought was a corrected framing, and the corrections were larger than any tuning result in the pass:

- Two different counts had been conflated. The fold level and the number of rendered summary bodies are different numbers moving in opposite directions, and the two shipped arms differ in which of them they maximise.
- The claim that width helps was too broad. The effect holds on one question type of four, and on the tail questions both non-tree baselines beat both widths.
- Depth is not a decision anybody made. It is whatever the tool-name-to-phase map and the neutral-merge rule produce from a trace, which on the one measured store is a 77-fold spread across 21 branches.
- The switch point's target is the Zone C share by the rule's own wording, and the two harnesses had drifted apart on it, one using 0.35 and the other 0.20 for the same quantity.
- A cache write costs 12.5 times a cache read per token, which settles that prefix size is not what decides the caching question.

The four published reports also re-derived every figure a conclusion rests on, directly from the artifacts. Six figures in dimension 1's own analysis, seven in dimension 2's and nine in dimension 3's did not reproduce as written. That habit of publishing the reproduction rather than the note is what made iterations 2 and 3 possible, and it is the single practice most worth carrying forward.

### 2.2 Iteration 2 — four offline experiments plus a judge

The second iteration ran four experiments (`eval/plans/tuning/exp-0{1,2,3,4}-*.md`) behind four new scripts under `eval/scripts/`, again at zero model calls, and then an independent judge pass re-ran every script and re-read every cited artifact at its anchor (`ITERATION-2-VERDICT.md`). Three of the four scripts reproduced to the token. The fourth did not, for a reason that turned out to matter more than the experiment itself (§5.4). The iteration refuted more than it confirmed, including three claims `reports/algorithm.md` was carrying at the time.

### 2.3 Iteration 3 — three follow-ups, each forced by iteration 2's dependency order

The third iteration ran three tasks, still at zero model calls. Task 3-A validated the cache simulator against an already-published live run and re-decided the third breakpoint (`exp3-a-simulator-fidelity.md`). Task 3-B re-measured branch sizes after the double-render fix landed, crossing both segmentations with both renderer states (`exp3-b-branch-sizes.md`). Task 3-C decomposed the run-level token gap between the two width arms bucket by bucket (`exp3-c-width-attribution.md`). Two of the three produced a result. The third produced a demonstration that its question cannot be answered at the n available.

Across all three iterations, no experiment made a live model call. Every live number in this report was already on disk when the pass started.

## 3 Conclusions per dimension

### 3.1 Visible branch count — the mechanism is settled, the default is not, and the score floor is what blocks deciding it

We can rule out building a third allocation mechanism. The number of rendered bodies is monotone non-increasing in the fold level: walking every fold level at every window through the real assembler gives, at W=32,768, bodies `0 / 2 / 5 / 6 / 8 / 10 / 11` at fold levels `40 / 16 / 12 / 8 / 6 / 4 / 2`. A policy that walked toward the most rendered bodies subject to the same fit predicate, which is the test that a candidate rendering fits the Zone B share and still leaves room for the newest branch's body, would therefore always select the ladder's smallest fold level. That is exactly where the wider arm already stops. The two shipped arms are the two ends of one monotone curve rather than two mechanisms. We re-ran `eval/scripts/ladder-curve.mjs` for this report and every cell was identical.

The fit predicate barely binds. Six of the seven fold levels satisfy it at W=32,768, so it is the hand-picked direction of the ladder, not the mechanism, that picks the allocation. The band in which the choice matters at all is narrow. At W=8,192 no fold level leaves a single body, because the Zone B share is 1,925 heuristic tokens and the smallest root index block alone is 2,587. At W=200,000 every fold level ties at 21 bodies, which is the whole store.

Width is a reallocation of a fixed block rather than an addition to it. Assembled Zone B measures 7,633 heuristic tokens at fold level 16 and 7,569 at fold level 2, a difference of 64 tokens in the wider arm's favour against a Zone B share of 7,701.

What width costs at the level of a whole run is not settled, and we now know it cannot be settled on this session. The two arms differ by a median 12,168 input tokens over completed runs, 37,513 for the narrow arm against 49,681 for the wider one (n=38 per arm, `qwen/qwen-2.5-72b-instruct` through OpenRouter, W=32,768, one epoch; we verified both figures for this report). Iteration 3-C decomposed that gap exactly: the identity `B1·T + echo + retrieval + output` reproduces `usage.input` with a maximum residual of 0 across all 76 completed rows. It then showed that the decomposition cannot be trusted, because a 10,000-resample bootstrap 95% confidence interval crosses zero for every bucket except output length, and output length is 2.9% of the point-estimate gap and is not a width mechanism at all. Run-level token standard deviation is 21,269 for the narrow arm and 20,497 for the wider one, roughly four times the 5,275-token mean gap between them. Resolving the gap would need about 246 completed rows per arm, 6.5 times today's 38.

Whether to make the wider arm the default is also unsettled. Its one measured advantage is a mean score of 0.333 on the head questions, 3 successes out of 9 completed runs, against 0.091 for the narrow arm, 1 out of 11, with both non-tree baselines at 0.000. Reduced to what actually happened, all four of those successes are on one question, `s1-q02-head`. On the other three question types both widths score 0.000, and on the tail questions both baselines beat both widths, at 0.200 and 0.333. Flipping the default is an epoch shift, and deciding it needs a second scenario, which cannot discriminate at any affordable n while the retrieval floor holds.

**Figure 1.** How each fold level spends the Zone B allowance at W=32,768, rebuilt from the frozen store with the assembler's own renderer and tokenizer, no model call. The rising series is the root index block, the falling series the rendered summary bodies, and their sum, the assembled Zone B, moves only between 6,917 and 7,633 across the whole ladder, so the reallocation is nearly size-neutral. The reference line is the Zone B share at this window, 7,701 heuristic tokens. Both paired baselines, truncate-tail and compact-rolling, render zero summaries by construction and so contribute no series; they appear against these arms on graded score in §3.1's text instead. Fold level 40 fails the fit predicate not for exceeding the share but for leaving 784 tokens against a newest body of 1,036. *In this markdown equivalent the chart is the table below.*

| fold level | root index (heuristic tok) | summary bodies (heuristic tok) | assembled Zone B | bodies rendered | note |
|---|---:|---:|---:|---:|---|
| 2 | 2,587 | 4,982 | 7,569 | 11 | `tree-wide` stops here |
| 4 | 3,105 | 4,467 | 7,572 | 10 | |
| 6 | 3,538 | 3,965 | 7,503 | 8 | |
| 8 | 3,967 | 3,091 | 7,058 | 6 | |
| 12 | 4,771 | 2,575 | 7,346 | 5 | |
| 16 | 6,095 | 1,538 | 7,633 | 2 | `tree` stops here |
| 40 | 6,917 | 0 | 6,917 | 0 | fails the predicate: no body survives |

### 3.2 Branch depth — the boundary condition is closed at the larger live window and open at the smaller

The boundary condition in this dimension is a branch whose raw rendered span is larger than the model's whole context window, because a full fetch of such a branch cannot be shown to the model at all. Two independent causes each produce exactly one such branch at W=32,768. Under today's segmentation with the renderer as it was before the cap landed, two branches exceed 32,768 exact tokens. Emptying the neutral-phase list removes one of them, and applying the already-validated 512-byte cap on a tool call's edit arguments in the retrieval renderer removes the other. Together they reach zero. Iteration 3-B crossed both segmentations with both renderer states; we re-ran `eval/scripts/resegment.mjs` for this report and reproduced every cell.

| segmentation · renderer | branches | max exact tok | >8,192 | >16,384 | >32,768 |
|---|---:|---:|---:|---:|---:|
| `['other']` (today) · uncapped | 21 | 51,802 | 8 | 4 | 2 |
| `['other']` (today) · capped (shipped) | 21 | 46,945 | 8 | 4 | 1 |
| `[]` (candidate) · uncapped | 99 | 34,664 | 5 | 3 | 1 |
| `[]` (candidate) · capped (shipped) | 99 | 24,986 | 5 | 3 | 0 |

**Table 1.** Branches whose raw rendered span exceeds each window, in exact cl100k tokens, over the same 754 events of the frozen `s1` store. Today's segmentation keeps the neutral phase list at `['other']`, so tool calls mapped to `other` extend the open branch instead of closing it; the candidate empties that list, which cuts the same events into 99 branches instead of 21. n=21 or 99 branches per cell; four cells, one deterministic replay each, zero model calls. The baseline cell is the first row, today's segmentation with the renderer as it was before the cap landed. Re-run for this report: every cell identical to `exp3-b-branch-sizes.md`.

At the smaller live window the cap contributes nothing to the count, and the segmentation dominates. Four branches exceed 16,384 before the cap and four after. The candidate segmentation takes that to three, and three remain with both fixes applied. The largest survivor is the branch spanning events 642 to 729, at 24,986 exact tokens; it holds none of the six duplicated events and is simply 88 events of ordinary content that add up to more than the window once concatenated. No rendering fix shrinks it. Only a size-aware segmentation rule or the listing-then-range fetch path could, and neither has been measured.

The cap is worth landing on its own terms, whatever happens to the boundary condition. Six of the store's 754 events carry a tool call's arguments and its post-state blob with byte-identical content, which is 70,227 duplicated characters across the trace and 23,937 exact tokens. A full fetch of the worst branch now returns roughly half the bytes for the same information, between 48.5% and 49.9% smaller, and the median branch is untouched, because the cap fires on 5 of 21 branches under today's segmentation and 6 of 99 under the candidate.

Branch granularity explains almost none of the retrieval failures we have measured. In the one forensic classification of 135 sampled rows on this store, the category "fetched the correct branch but it was truncated" holds 0 of the 135 rows, and 0 of the 110 failures. Across all 444 rows of the sweep the oversized branch was fetched once, and that fetch was not truncated. So this is a structural risk worth closing rather than a scoring problem worth chasing, and iteration 3-B confirms it directly: the cap changes zero per-question fit outcomes in either segmentation.

Whether the candidate segmentation is worth its cost is not settled. It makes 4.71 times as many leaf-summarizer calls for 2.43 times the summarizer spend, up from the 2.33 times iteration 2 measured, because the post-cap content is smaller and the fixed per-call overhead is therefore a larger share of it. The entire increase is that fixed overhead on the 78 extra calls: a 724-token system prompt plus a 1,024-token output cap, with branch content held constant. Turns and graded score under the candidate are unmeasured on every task.

**Figure 2.** The 21 largest branches of the frozen store, ranked by size, in exact cl100k tokens, under all four combinations of segmentation and renderer, against the harness's two live windows. Today's segmentation with the pre-fix renderer is the baseline and the only cell with two branches above 32,768. After the cap, the second-largest branch drops from 35,657 to 18,351 and crosses back under 32,768, while the largest, spanning events 55 to 261, falls only 9.4%, because its duplication is 2 events out of 207. The candidate segmentation's largest branch after the cap is 24,986, under 32,768 but still over 16,384. The candidate has 99 branches; only its largest 21 are plotted, so the two segmentations are comparable rank for rank. *In this markdown equivalent the chart is the table below.*

| rank | today, uncapped | today, capped | candidate, uncapped | candidate, capped |
|---:|---:|---:|---:|---:|
| 1 | 51,802 | 46,945 | 34,664 | 24,986 |
| 2 | 35,657 | 27,800 | 24,986 | 17,358 |
| 3 | 27,800 | 23,085 | 16,395 | 16,395 |
| 4 | 23,085 | 18,351 | 10,508 | 10,508 |
| 5 | 10,347 | 9,687 | 8,748 | 8,748 |
| 6 | 9,882 | 9,202 | 8,024 | 8,024 |
| 7 | 9,202 | 9,146 | 7,734 | 7,734 |
| 8 | 8,868 | 8,490 | 7,190 | 7,190 |
| 9 | 7,877 | 7,877 | 6,603 | 5,602 |
| 10 | 7,758 | 7,758 | 5,602 | 4,209 |
| 11 | 6,471 | 6,471 | 4,209 | 3,818 |
| 12 | 3,942 | 3,942 | 3,818 | 3,261 |
| 13 | 3,706 | 3,706 | 3,209 | 3,140 |
| 14 | 2,455 | 2,455 | 3,140 | 3,069 |
| 15 | 2,431 | 2,431 | 3,069 | 2,614 |
| 16 | 2,059 | 2,059 | 2,614 | 2,541 |
| 17 | 1,425 | 1,425 | 2,541 | 2,219 |
| 18 | 1,384 | 1,384 | 2,219 | 2,209 |
| 19 | 1,181 | 1,181 | 2,209 | 2,102 |
| 20 | 988 | 988 | 2,102 | 2,012 |
| 21 | 687 | 687 | 2,012 | 1,890 |

### 3.3 Summary timing — the lag is settled and fixable; the fraction is settled as a target and unmeasured as a value

The switch point's target is the Zone C share of W, and that is settled by definition rather than by fitting. The rule defines the switch as the size at which the whole raw trace still fits where the active branch's detail would go, and that space is exactly Zone C's allocation. The two are now one quantity by construction inside `deriveZoneBudgets`, so the drift that had one harness using 0.35 and the other 0.20 for the same quantity cannot recur.

The gate that performs the switch lags one turn, and we have now measured the size of the lag twice. The gate compares the previous completed turn's billed prompt against the threshold, so exactly one prompt above the threshold is always sent. Across the six recorded crossings the overshoot is a median 8,306 tokens, ranging from 126 to 15,564 (n=6, claude-sonnet-5, two scenarios, one epoch). We recomputed it for this report directly from `eval/results/long-v65-gate/*/results.json` without the script and got a median of 8,305.5 over the identical set. Replayed with the check moved to the prompt about to be sent, the median overshoot falls to 0 and the worst case to 916, with five of the six crossings landing under the threshold. That check costs 2.7 to 4.0 milliseconds of local tokenizing, against turn latencies recorded in seconds.

**Figure 3.** The size of the prompt actually sent on the crossing turn, under today's lagged gate and under the same-turn replay, for the six recorded crossings sorted ascending by overshoot, against the 30,000-token threshold. The lagged gate is the baseline, measured live on claude-sonnet-5 over three replicates each of `sw-5-dozen` and `sw-6-ripple`, n=6 crossings. The two series are sorted independently, so the pairing is by rank rather than by run: the published replay reports five of six at zero overshoot and one at 916 without saying which crossing carries the 916. The same-turn series is a proxy, because the runs' raw event logs were not archived and only per-turn usage was, and its bias runs upward, since one extra turn of trace growth is baked into the stand-in. The true post-fix overshoot is therefore at or below it. *In this markdown equivalent the chart is the table below.*

| run | crossing turn | prior-turn prompt (what the gate compared) | prompt at crossing | overshoot | same-turn replay |
|---|---:|---:|---:|---:|---:|
| sw-6-ripple r2 | 16 | 29,878 | 30,126 | +126 | — |
| sw-5-dozen r2 | 7 | 20,188 | 36,657 | +6,657 | — |
| sw-6-ripple r3 | 11 | 24,733 | 37,812 | +7,812 | — |
| sw-5-dozen r3 | 10 | 22,245 | 38,799 | +8,799 | — |
| sw-6-ripple r1 | 14 | 28,187 | 41,286 | +11,286 | — |
| sw-5-dozen r1 | 10 | 28,936 | 45,564 | +15,564 | — |
| **median (n=6)** | **10.5** | **26,460** | **38,306** | **+8,306** | **0** |
| worst case | — | — | 45,564 | +15,564 | +916 |

A sweep over the switch fraction cannot rank the fractions, and we count that refutation as settled. From 0.15 to 0.35 of a 200,000-token window over a deterministic 300-branch corpus, the prompt after the switch is a constant 9,060 tokens at every fraction. Total tokens are therefore the raw trace up to the crossing plus a constant afterwards, which makes an earlier crossing arithmetically cheaper every time. We re-ran the sweep for this report and the table below is identical to what iteration 2 published. The sweep measures its own lower bound. Ranking a fraction needs turns and graded score, and no offline corpus in this repository represents either.

| switch fraction of W | switch point (tok) | crossing branch | peak prompt (tok) | post-switch prompt (tok) | total tokens over the run |
|---|---:|---:|---:|---:|---:|
| never switch (baseline) | — | never | 85,334 | 85,334 | 12,862,800 |
| 0.15 | 30,000 | 106 | 29,954 | 9,060 | 3,361,230 |
| 0.20 | 40,000 | 141 | 39,894 | 9,060 | 4,271,440 |
| 0.25 | 50,000 | 176 | 49,834 | 9,060 | 5,529,550 |
| 0.30 | 60,000 | 211 | 59,774 | 9,060 | 7,135,560 |
| 0.35 | 70,000 | 247 | 69,998 | 9,060 | 9,150,408 |

**Table 2.** The switch-fraction sweep over a deterministic 300-branch corpus at W=200,000, zero model calls, one replicate per fraction because the replay is byte-identical on repetition. The paired baseline is the first row, the same corpus with no switch at all. The column that decides the conclusion is the fifth: the post-switch prompt is the same 9,060 tokens at every fraction, which makes the sixth column monotone by arithmetic rather than by discovery, and makes the extrapolated optimum "switch immediately", at branch 9, f ≈ 0.015. Re-run for this report: every cell identical.

Summary cost is one lump at a badly chosen moment rather than a standing tax. The 17 runs that never cross the switch make zero leaf-summarizer calls. On the six that do cross, summarization is 6.9% to 19.3% of run cost, median 9.4% (n=6, claude-sonnet-5 as the agent with claude-haiku-4-5 as the summarizer). The transition's own price appears on the turn after the switch, as a median 18,274 cache-write tokens against 273 for the matched no-switch arm on the turn after its own largest write (n=6 each), and it costs between zero and six extra turns depending on which baseline is chosen. A spike on the crossing turn itself is not diagnostic, because the no-switch arm spikes on its own growth turns too.

Which fraction to use is unsettled, and so is whether an early switch buys tokens at the price of turns. Graded score separates nothing here: every cell is 3 of 3 or 5 of 5 at a mean of 1.000, so this dimension is currently unfalsifiable on score and can be ranked only on tokens and turns.

### 3.4 Caching — the instrument was the problem, and fixing it flipped the verdict

A cache write costs 12.5 times a cache read per token. That follows arithmetically from two published rates, and it settles that prefix size is not the lever. The frequency form of the rule that this program used to quote, that marking a block "breaks even below about one turn in twelve", was a size ratio wearing a frequency's clothes, and we have retired it in favour of the derivation the frequency question actually needs. Marking a block beats leaving it unmarked as long as the block's rewrite frequency stays below `f* = (Pinput − Pread) / (Pwrite − Pread)`, which evaluates to 0.7826 at claude-sonnet-5's published rates. That is a formula over three per-model prices, not a constant. Measured against the real trace, Zone B is rewritten on 20 of 754 turns, or 2.65%, far inside the winning side, which is why its single trailing marker is correctly placed.

The simulator's verdict against a third breakpoint was an artifact of the simulator. `ProviderCacheSimulator` credited a cache read only when a breakpoint recurred at the same block index as in the immediately previous submission, so a marker that advances one block per turn could never earn a read by construction. Iteration 3-A confirmed the diagnosis at the exact lines, then extended the simulator to track the longest prefix it has ever confirmed cached and to bill at block granularity rather than whole-segment granularity. The extension is reachable as the new default policy `'automatic-prefix'`, and the original is preserved byte-for-byte as `'exact-last-position'`.

With the corrected instrument the third breakpoint is cheaper, and its shape matches the live run. Re-running `eval/scripts/cache-sweep.mjs` unchanged for this report reproduces iteration 3-A exactly. Session cache reads are 6,335,267 tokens for the shipped two-breakpoint layout against 11,486,477 for the three-breakpoint layout, on an identical session total of 15,130,974 tokens; the median per-turn cache-read fraction is 0.557 against 0.982; session cost falls 39.8% (n=754 turns, one scenario, deterministic replay, zero model calls). Cache reads climb from 7,231 to 19,476 and are non-decreasing on 727 of the 753 turn-to-turn steps. Writes are delta-sized, at a median 113 tokens on the turns that write anything outside a phase transition. Fresh input runs from 0 to 288 tokens per turn, median 85. The already-published live run of the same design measured cache reads climbing from 4,788 to 23,794, writes at about 1.2k median, fresh input from 36 to 892 tokens per turn, and cost per turn down 18% (n=5 replicates, `sw-2-multimod`). The sign and the shape agree. The magnitude does not, and should not be read as agreeing, because the live comparison bundled several v5.6-era changes on a different scenario while the offline one isolates a single configuration field.

Whether to turn `cacheZoneCBreakpoint` on by default is unsettled, and it remains off. One deterministic run of one simulator over one session is the instrument's validation step, not the second-scenario replicate that iteration 2 pre-registered as the gate for a default flip.

**Figure 4.** Per-turn billing under the extended cache simulator for the three-breakpoint layout, sampled across the 754-turn deterministic replay of the frozen store. The reference lines are the endpoints of the cache-read climb recorded in the already-published live run of the same design, 4,788 rising to 23,794 tokens (n=5 replicates on `sw-2-multimod`, claude-sonnet-5). That run used a different scenario and a different measurement method, so it is drawn as the shape the simulator had to reproduce rather than as a paired baseline. The write spikes at turns 181 and 746 are phase transitions, where Zone C resets to a newly active branch; 20 of the 754 turns are transitions, and the shape claim is about the other 734. *In this markdown equivalent the chart is the table below.*

| turn | cache read | cache write | fresh input |
|---:|---:|---:|---:|
| 1 | 0 | 7,231 | 0 |
| 2 | 7,231 | 30 | 0 |
| 8 | 7,617 | 6,648 | 0 |
| 61 | 12,846 | 74 | 288 |
| 181 | 7,710 | 29,685 | 288 |
| 301 | 10,579 | 95 | 85 |
| 481 | 17,754 | 59 | 139 |
| 721 | 36,616 | 112 | 0 |
| 746 | 13,408 | 5,534 | 78 |
| 754 | 19,476 | 881 | 78 |

## 4 What was rejected, and the number that rejected it

This section exists to stop a re-run. Each row below names a candidate we killed, the number that killed it, and what would have to change for it to become live again.

| Candidate, killed | The number that killed it | What would revive it |
|---|---|---|
| A new allocation mechanism for the fold ladder — "walk toward maximising rendered bodies subject to the fits predicate" | Bodies are monotone non-increasing in the fold level: 0/2/5/6/8/10/11 at fold levels 40→2, W=32,768. The body-maximising walk *is* the reversed ladder already shipped as `tree-wide`. | Nothing. There is no third allocation. Only a default flip remains, and it is an epoch shift. |
| Demand-driven widening keyed on search *occurrence* | Head-question search rates are 8 of 11 completed runs for the narrow arm against 8 of 9 for the wider one, and the narrow arm still scored 0.091 against 0.333. Searching does not track where the bottleneck is. | Nothing on this session. |
| Demand-driven widening keyed on retrieval *confidence* — the refinement iteration 1 explicitly left open | 4 successes in 120 searched rows (3.3%), all four on one question; Pearson r between offline retrieval rank and score is 0.062 (n=120); the best-possible-rank question `s1-q07-deep` scores 0.000 across all 6 of its searched attempts. Reproduced for this report. | A retrieval floor above 3.3%. A rank-keyed policy has no headroom while 116 of 120 rows fail at every rank from 1 to 17. |
| A user-set effort dial for width | Widening helped one question type of four and changed nothing on three, while a dial can only be set once per session. n=15 attempted per arm and question type. | Evidence that question mix is knowable in advance and stable within a session. Nothing measures it. |
| The two earlier top-k branch-pruning arms, sometimes read as width evidence | Never fired: the segmenter produced about 3 branches against a cutoff of 3, so the floor property held on every run across six iterations. Honest nulls about pruning a count that was never large. | A store with many branches *and* a selection question, which is not the question this dimension asks. |
| Iteration 1's claim that `neutralPhases: []` "eliminates the over-window branch entirely" and that every question then sources from a branch fitting every tested window | 34,664 exact tokens still over W=32,768 under the candidate with the pre-fix renderer, and 2 of 12 questions still over W=16,384. The chars÷4×0.851 estimator that produced the wrong table undercounts the branch at seq 267–276 by 67% (21,396 estimated against 35,657 exact). | Nothing — superseded by Table 1, which gives the true four-cell counts. |
| Iteration 1's claim that two earlier reports both name leaf-summarizer passes as the dominant residual cost | One names the *root* summarizer at sonnet prices; only the summary-timing analysis measures the leaf, at a median 9.4% of run cost (n=6). | Nothing. It was a citation error. |
| Any switch fraction selected from the sweep, including 0.15 | The post-switch prompt is a constant 9,060 tokens at all five fractions, so the ranking is an identity of the generator and the extrapolated optimum is "switch immediately" (branch 9, f ≈ 0.015). Re-run for this report. | A corpus that represents turns and score. The Zone C share remains the switch's *definition*; only its *value* is open. |
| The +23% figure as evidence against the third cache breakpoint | −39.8% session cost under the corrected match policy on the identical session and layouts, agreeing in sign with −18% cost per turn measured live (n=5). The simulator credited a read only on an exact block-index recurrence, so a moving marker could never earn one. | Nothing. The figure is withdrawn. |
| Turning the third cache breakpoint on by default now | Rejected in the opposite direction by the same evidence: one deterministic replay of one session is the instrument's validation, not the pre-registered second-scenario replicate. | The second-scenario simulator replicate. That is next step 3. |
| `exp-04-caching.md`'s absolute session table as a citable measurement | Does not reproduce: cache read 6,209,893 against its published 5,079,261 on re-run, because the root-summary version the assembler reads grew from 407 to 1,677 heuristic tokens between the measurement and the judge pass. Direction, the identity of the two layouts' read totals, and `f*` all reproduce; the absolute cells do not. | A dated, hashed L1. That is next step 2. |
| Iteration 1's attribution of the width token gap to Zone B width (~465 tokens per summary, ~4,185 per turn, ~12,555 per run) | Zone B's rendered size is 7,633 against 7,569 tokens at the two fold levels, so there is no per-summary addition to multiply. The figure divides a fixed-size block by its contents and then multiplies by 9, counting a budget twice. | Nothing. Withdrawn. |
| Iteration 2's replacement claim that width therefore costs nothing | The arms differ by a median 12,168 input tokens and a median 5,456 peak request tokens at identical median turn counts of 3.0 (n=38 per arm). An absence of cost that no measurement supports. | Nothing. Also withdrawn, and iteration 3-C's exact decomposition then showed the correct answer is "unknown at this n". |
| Any causal attribution of the width gap at n=38, in either direction | Bootstrap 95% CIs cross zero for the total (−3,978 to +14,886), for turn-1 prompt × turn count (−2,062 to +8,446) and for appended retrieval payload (−3,792 to +7,394). Only output length excludes zero (+36 to +278), and it is 2.9% of the gap. | About 246 completed rows per arm, roughly 390 attempted per arm at this session's 63% completion rate. |
| A median-based bucket decomposition of the width gap | Median is not linear: the four median bucket gaps sum to 2,425 tokens against an actual median run gap of 12,225.5. It would not sum to the number it claims to decompose. | Nothing. Exactness requires means; means then fail the significance check. |
| Turn and wall-clock ceilings as instruments (removed earlier the same day, and this pass depends on the removal) | Of 26 runs stopped by a ceiling, 16 were graded as failures the models never committed; one of those 16 sat under a published reliability headline, which measured only on runs that produced an outcome is 3 of 3 with two unmeasured and no measured reliability difference at all. | Nothing. Spend cap and stall detection replaced them; `--max-turns` survives with no default, for a probe that deliberately wants a bound. |
| A reply cap (a ceiling on how much the model may say), as distinct from reply headroom | The portability clamp of 800 tokens won at every window above about 16,000, so a reservation that looked window-derived was a constant; on a model that reasons before answering, the budget could be spent thinking, leaving an empty reply graded as a wrong answer. | Nothing. Headroom stays because prompt plus reply must fit; the ceiling is gone. |

**Table 3.** Everything this pass killed, with the deciding statistic. Seventeen entries, nine of which kill a claim an earlier iteration of this same pass had made. That is the shape a working refutation loop has.

## 5 What was learned, separately from what was decided

The decisions are in §3 and the deaths in §4. What follows is the part that cost the most time and would be invisible in a results table.

### 5.1 Mechanisms now understood

- Two counts are paid out of one allowance. The fold level and the rendered-body count both come out of the same Zone B share, so raising one lowers the other. Every earlier statement in this program about how many summaries the model sees was ambiguous between the two.
- Depth is emergent, not chosen. A branch closes only when a non-neutral tool call's phase type differs from the type of the open branch. The oversized branch spans 207 events because its 64 shell calls and 2 skill calls map to the neutral phase, which extends the open branch instead of closing it, while every non-neutral call inside it maps to the same type, so the closing condition never fires across 22 alternating runs of tool identity.
- A branch can never render smaller than its largest atomic event. That is why a segmentation change alone cannot close the over-window boundary, and why a rendering fix was needed alongside it.
- The switch gate's overshoot is one turn of whatever growth the task happens to be producing, which is a median 14,784 tokens on these tasks and 248 tokens on the one crossing that overshot by only 126. The lag adds no fixed cost. It adds a turn.
- The zone partition is itself a budget, and it manufactured one of our results. Because the zones compete for an invented share of W rather than for W itself, extra rendered bodies necessarily displace headlines even when the real window has room for both. The displacement appears and disappears exactly with whether the share binds: 2 bodies against 11 at W=32,768, where the share is 7,701 tokens; every fold level tied at 21 bodies at W=200,000, where the share is 47,009 against a whole-store Zone B of at most 16,921; and nothing rendered at all at W=8,192, where the share is 1,925 against a 2,587-token root block, though the real window has room for both.
- A provider's automatic prefix matching cannot be modelled at whole-segment granularity. A moving single breakpoint can only produce a delta-sized write if the simulator can credit part of the segment the marker sits at the end of. Extending which submissions count as history does not fix that on its own.

### 5.2 Assumptions that turned out false, and what replaced them

Each row pairs something this pass believed at the start against what the measurement put in its place.

| Was believed | Replaced by |
|---|---|
| Width buys retrieval at the price of a larger prefix re-read every turn | Zone B's rendered size barely moves (7,633 against 7,569 tokens), so there is no larger prefix; but the run-level gap is real and unattributed, so neither "costs" nor "free" survives |
| "Largest fold level that fits" is a derived mechanism | Six of seven fold levels fit, so the hand-picked ladder direction makes the decision almost unaided |
| Re-segmentation closes the over-window branch | It removes one of two at W=32,768 and one of four at W=16,384; the surviving branch needed a rendering fix, and three still exceed the smaller window with both applied |
| A corpus-wide heuristic-to-tokenizer ratio can price a single branch | It undercounts one branch by 67% and another by 43%. A ratio is a fair average and an unsafe per-branch predictor; segmentation proposals get exact tokens |
| A cache-write to cache-read ratio of 12.5 implies a break-even at one rewrite in twelve turns | `f* = (Pinput − Pread)/(Pwrite − Pread)` = 0.7826 at this model's rates, a formula over three published prices, re-evaluated per host |
| The offline cache harness could rank caching designs | It cannot rank any design whose marker moves, until it matches against every previously cached position. That was the finding; the design under test was never the problem |
| A fraction sweep would locate a switch-point sweet spot | The sweep's argmin is its own smallest tested value, because the post-switch prompt is constant. Tokens alone cannot express this tradeoff |
| Summary cost is a standing tax on every run | Zero on the 17 runs that never cross; median 9.4% of run cost on the six that do. One lump at a badly chosen moment |
| The code summarizes every stale branch in one parallel batch | Only the backlog is batched at the crossing; after the latch, summarization is incremental on each branch close |
| Empty completions from reasoning models were a provider quirk putting text in another field | The reply clamp was spending the budget on thinking and leaving nothing to say. The clamp is gone, and an empty completion with no tool call now fails loudly |

**Table 4.** Ten assumptions the pass falsified, with their replacements. Six of the ten were carried by `reports/algorithm.md` itself at some point during the pass, and that page has since been corrected in each case.

### 5.3 An instrument that had to be fixed before it could measure

Iteration 2's fourth experiment was the first thing in the program ever to point the cache assertion harness at the request builder that produced every live caching number. It returned +23% against the third breakpoint, while an already-published live run of the same design had measured −18% cost per turn. Both could not be right, and the disagreement was itself the result. The simulator's read boundary was built from a single previous submission and tested by exact equality of an integer block index, so a marker that advances one block per turn could never earn a read. Iteration 3-A confirmed that at the lines, extended the policy, and the sign flipped.

Two lessons generalise. First, a conservative instrument is safe for detecting regressions and unsafe for ranking designs: under-crediting cannot hide a regression, but it can invert a comparison. Second, the validation target was free and already on disk. The cheapest experiment in the pass was the one that checked an instrument against a measurement we had already paid for.

A live residue of this remains in the tree, and the next agent will hit it. `eval/scripts/cache-sweep.mjs` still prints its pre-iteration-3 conclusion, that "the 3rd breakpoint, as coded, sits on the LOSING side of its own crossover", underneath a table whose own numbers now say the opposite. We verified that by re-running it for this report. The narrative line is stale; the arithmetic is not.

### 5.4 A frozen fixture that was being written to, and a metric that was fabricating data

The frozen session was frozen only for its event log and its payload blobs, not for its database. `eval/fixtures/transplant/s1/store/` is gitignored, so `git status` proves nothing about it, and the manifest pins `trace.jsonl` and the config file but not `tree.db`. `composeRootSummary` appends a root-summary version every time a fold level is composed that the store has not already seen, the assembler reads the latest version, and that version's text grew from 407 to 1,677 heuristic tokens between one experiment being written and the judge re-running it one minute later. The predicted session delta of 1,270 tokens × 754 turns ≈ 958k matched an observed 1,154,537, of which 1,130,632 was cache read, which is the right size in the right place. The store today holds 1,546 root-summary versions against 21 branch summaries, which we verified by SQL for this report. The consequence is retroactive: every published Zone B number in this program is dated by a root version nobody recorded. The scripts now copy the store to a scratch directory before touching it, which stops new writes but does not date the old numbers.

A metric was also fabricating failures. Two harnesses ran the same kind of bounded tool loop and only one of them had been fixed. In `eval/scripts/transplant.mjs`, a run that exhausted its six-turn ceiling returned an empty final answer that was fed straight to the grader and scored 0, indistinguishable from a wrong answer. That happened on 2 of 60 rows in the primary narrow arm and on 7 of 60 rows, or 11.7%, in the wider ablation, and every one of the seven carried `fetched:true, searched:true`, meaning the model was actively using its tools and simply needed more than six round trips. The same file already excluded `cost_cap` rows from scoring for the identical reason, which is what proves this was an oversight rather than a design choice. It is now fixed, and the correction moves a published cell: the wider arm's mean score on the head questions is 0.333 over 9 completed runs, not the 0.273 over 11 that earlier reports quote.

### 5.5 Causes misattributed and later corrected

Three misattributions are worth carrying forward, because each was believed long enough to shape a decision.

- Sixteen failures were fabricated by the harness. A run the harness stopped was being graded as a task failure. We corrected that twice: first by making harness-stopped runs ungradable, then by narrowing the rule, because a capped run whose hidden tests pass keeps its success, the grade being a filesystem fact. The narrowed rule recovers 10 legitimate successes and still removes the 16 fabricated failures.
- Empty replies were blamed on the provider. We wrote them off as reasoning models putting their text in a field we did not read. The cause was the reply clamp being spent on thinking. It was in our harness, not the provider.
- The zeros on the tail questions were blamed on the newest branch starting too late. All three tail sources are inside the visible summary range in both arms, and the source branch renders as a full body in both. The cause is behavioural: 34.8% of sampled rows searched and never fetched, and 8.9% never searched at all. Nothing about branch granularity or width would move it.

### 5.6 Numbers checked for this report, and the three that did not reproduce

We recomputed every figure a §3 or §4 conclusion rests on from the artifacts rather than quoting it. These reproduced exactly: the whole ladder curve at all five windows, including the 0/2/5/6/8/10/11 body counts and the dead cell at 8,192; Pearson r = 0.062 (n=120), with 4 successes all on `s1-q02-head` and rank-1 `s1-q07-deep` at 0.000 over 6 attempts; all four cells of the re-segmentation table and every branch size in Figure 2; the switch-fraction sweep's constant 9,060 and its range from 3,361,230 to 9,150,408; the cache sweep's 6,335,267 against 11,486,477 cache reads and its −39.8%; `f*` = 0.7826 and the 12.5× write-to-read ratio; the six gate crossings, with median overshoot 8,305.5 and a median 265,428 billed tokens per run; the width arms' 37,513 against 49,681 median input at 38 completed rows each, with mean turns 3.00 against 3.24; every per-question-type score cell in §3.1; the manifest ratio 0.850896663206653; and the test counts, 541 passed with 9 skipped in `packages/core`, 599 with 9 skipped across `packages/`, and 91 in `eval/test/{loop,transplant}.test.ts`.

Three figures did not reproduce, and a next agent should use the corrected value in each case.

1. The pre-registered turn guard's baseline for `sw-6-ripple` is 18 turns, not 16. `ITERATION-2-VERDICT.md` §5 states that "baseline medians are 13 and 16 turns". Recomputed from the same three replicates, `sw-5-dozen` is 10/13/16 turns, median **13**, which matches; `sw-6-ripple` is 14/18/33, median **18**. The guard in next step 4 is restated against 18.
2. The capped branch sizes are 13 exact tokens larger than the judge measured. The verdict's table gives 17,345 for the span at 267–271 and 18,338 for the span at 267–276 with the cap applied; re-running `resegment.mjs` gives **17,358** and **18,351**. Every count, threshold crossing and conclusion is unchanged. The discrepancy is a 0.08% difference in where the elision lands.
3. The "max-bodies fold level" column reports a fold level matching neither shipped arm at W=65,536. `ladder-curve.mjs` prints `keep=12 (21 bodies) → NEITHER shipped arm` there, which reads as contradicting the monotonicity conclusion. It does not contradict it: five fold levels (12, 8, 6, 4 and 2) all tie at 21 bodies at that window, and the script's tie-break reports the largest. Monotone non-increasing still holds, at 19/19/21/21/21/21/21. Do not read that cell as a counterexample.

One further non-reproduction is already on record, and we restate it because a conclusion elsewhere rests on it: `exp-04-caching.md`'s absolute session table cannot be reproduced at all, for the reason given in §5.4. Its shipped-layout baseline today is a session cache read of 6,335,267 tokens, not the 5,079,261 it published.

## 6 State of the code

The state below is at commit `77d5326`. We ran the test suites for this report: `packages/core` gives 541 passed and 9 skipped over 24 files; `packages/` as a whole gives 599 passed and 9 skipped over 26 files; `eval/test/loop.test.ts` plus `eval/test/transplant.test.ts` gives 91 passed and 0 skipped. The 9 skips are the pre-existing `LIVE=1`-gated files under `packages/core/test/live/`, which were skipped identically before this pass. Nothing else was skipped.

> *Uncommitted at `77d5326`.* Iteration 3's own code changes are in the working tree and not yet committed: `packages/core/src/cache/{simulator.ts,index.ts}`, `packages/core/test/{cache.test.ts,e2e.test.ts}` and `eval/scripts/resegment.mjs`, plus the three `exp3-*.md` reports and this report's two files. Everything else described below is committed. Commit or discard deliberately before starting a new epoch, and re-run the three test suites afterwards, because the counts above were taken with these changes present.

### 6.1 Landed and on by default

- `packages/core/src/assemble/budgets.ts` is new. It exports `ZONE_FRACTIONS` (frozen, and explicitly labelled unvalidated), `deriveZoneBudgets(window, ratio)`, `zoneBRemainder(...)`, `replyHeadroom(...)` and `replyAllowance(...)`. Every zone allowance now derives from one host-supplied number in one place, and the switch point is the Zone C share by construction. It is tested in `packages/core/test/budgets.test.ts`. The change is additive: a window changes nothing about what gets built, and a test asserts that.
- `packages/core/src/assemble/assembler.ts` gained `ZoneAssemblerDeps.window` and `AssembleOptions.window`, which take the host's context window and have no default. `BudgetReport` gained `window`, `windowRemaining`, `overWindow` and `replyAllowance`. The assembler reports rather than enforces: a caller that ignores `overWindow` gets a provider error, which is the loud failure.
- `packages/core/src/retrieve/detail.ts:9,103-104` applies the edit-argument cap. It imports `ARGS_CAP_WITH_BLOB`, `elision` and `safeCut` from `assemble/format.ts`, so the same 512-byte rule now applies in both renderers from one exported constant, and no new constant was introduced. It is guarded by `packages/core/test/retrieve.test.ts` (33 passed) and `packages/mcp/test/mcp.test.ts` (39 passed).
- `packages/core/src/cache/simulator.ts` gained `CacheMatchPolicy`, whose default is `'automatic-prefix'`, with `'exact-last-position'` preserved byte-for-byte on a separate code path. Every pre-existing test that depended on the old numbers now constructs its simulator with the old policy explicitly and keeps its original assertions. `packages/core/test/cache.test.ts` is 18 tests.
- `eval/scripts/transplant.mjs:3384-3401` makes a run stopped at `MAX_TURNS` or at the time cap ungradable (`score: null, success: null`) rather than graded 0, mirroring the treatment `cost_cap` already had.
- `eval/scripts/transplant.mjs:775-777` and the four tuning scripts each copy the frozen store to an `mkdtemp` scratch directory before running, so the fixture stops being written to.
- Five experiment scripts run with no network and no model calls: `eval/scripts/ladder-curve.mjs`, `resegment.mjs` (extended in place to cross both segmentations with both renderer states), `switch-fraction-sweep.mjs`, `cache-sweep.mjs`, and the pre-existing `marathon.mjs`.

### 6.2 Landed behind a flag, default off

- `cacheZoneCBreakpoint` is the third cache breakpoint, moved into the library from an eval script. The field is at `packages/core/src/assemble/assembler.ts:90` and the marker at `:176-180`. It defaults to off, verified byte-identical by the 541-test run. Its verdict is now that it is a candidate for a default flip, pending a second-scenario replicate (§3.4).
- `SegmentConfig.neutralPhases` is at `packages/core/src/contracts/segment.ts:55-58`, with its default unchanged at `['other']` (`packages/core/src/config.ts:113`). Setting it to `[]` is the `tree-fine` arm. Changing the default re-segments L1, so every node id, span and stored summary changes and all derived layers must be deleted and rebuilt rather than migrated. No measurement crosses that boundary in either direction.
- `ARM_ROOT_LADDER` is at `eval/scripts/transplant.mjs:398-410`. The wider arm is the reversed ladder, and making it the default is an epoch shift at any window where the Zone B share binds.
- `EVAL_LAZY_TOKENS` and `EVAL_LAZY_K` are the switch and latch gate, off by default at `eval/src/loop.ts:795,804`. Every published run that exercises the switch point set `EVAL_LAZY_TOKENS=30000` by hand on the command line. A plain invocation does not set it.

### 6.3 Written but unrun

- `replyAllowance` has never been used live. It has offline reasoning and unit tests only. It is next step 1, and its whole point is a behavioural claim no offline check can settle: that a small-window model iterates through a long session on progressively shorter replies rather than failing when its prompt outgrows a fixed ceiling.
- `zoneBRemainder` is available to callers but not used by the assembler. Giving Zone B the true remainder needs Zone C's size first, and the zones assemble in layout order. That is a behaviour change and belongs to a judged candidate, not to a defect fix.
- The same-turn switch check did not land. `eval/src/loop.ts:820,829,1035` still sets `lastPromptTokens` from the previous call's billed usage and reads it before the next one, so the median 8,306-token overshoot is still live. Iteration 2 recommended landing it and it has not been landed. It is part of next step 4, and landing it declares an epoch boundary.
- The listing-then-range fetch path exists and is untested live. It is the only remaining lever on the three branches still over W=16,384.

### 6.4 Still open in the shipped library, by path

- `packages/core/src/config.ts:116-119` holds `zoneB: 8_000`, `zoneC: 30_000`, `rootKeep: 40` and `retrieval.limit: 20`, all flat integers. On the one measured store, `rootKeep: 40` renders no body at all at W=32,768 and exceeds the whole Zone B share at W=16,384, so it is not merely unvalidated but known to fail there.
- Five mutually inconsistent excerpt sizes (800 / 2,000 / 2,000 / 240 ×3 / 65,536 chars) live across `retrieve/retriever.ts:49`, `mcp/src/tools/context-peek.ts:15`, `retrieve/vector-provider.ts:19`, `providers/hydrate.ts:15` and three separate definitions of `SNIPPET_CHARS`. The 65,536-char default alone exceeds the entire default Zone C allowance.
- `renderSpans` (`retrieve/detail.ts`) and `renderBranchDetail` (`summarize/detail.ts`) have per-event caps but no aggregate cap. Those two functions are the mechanism behind the "leaf larger than the window" boundary condition.
- `ZoneAssembler` is never constructed inside `packages/mcp`. We verified that again for this report: the only non-test constructions are in `packages/core/test/`. A host attaching the shipped MCP server today gets four retrieval tools and no prompt assembly, so the whole `assemble/` subsystem, including every budget above, has no live effect on any such deployment. Fixing the budgets changes eval scores, and does not yet change any running system.
- The switch and latch step has no code in `packages/core` or `packages/mcp` at all. It lives only in `eval/src/loop.ts`, which is explicitly out of scope for what ships.
- `MAX_TURNS = 6` sits at `eval/scripts/transplant.mjs:123`. The turn ceiling was removed from `eval/src/loop.ts` and not from this harness. Capped rows are now excluded rather than graded, but the ceiling still truncates runs, and 9 rows in the committed W=32,768 fixtures hit it.

### 6.5 Where the data and scripts are

| What | Path |
|---|---|
| The reference description and the four rules | `reports/algorithm.md` |
| Iteration-1 analyses, iteration-2 experiments, the judge's verdict, iteration-3 experiments, the queue | `eval/plans/tuning/` |
| The four published dimension reports (HTML canonical, markdown twin) | `reports/metrics/tuning-{branch-count,branch-depth,summary-policy,caching}.{html,md}` |
| The constant-and-boundary audit this pass was scoped against | `eval/plans/portability-audit/{01-core,02-harness,03-transplant}.md` |
| The frozen store: 754 events, 21 branches, 46 nodes, and every structural number in this report | `eval/fixtures/transplant/s1/store/` (gitignored; `trace.jsonl` sha256 pinned in the manifest, `tree.db` not) |
| The twelve questions, four question types, gates, ladder, manifest, and the result files behind every width figure | `eval/fixtures/transplant/s1/e1b289c32f40/` |
| The six live switch crossings and their per-turn usage | `eval/results/long-v65-gate/*/results.json` and `long-v65-gate.log` |
| The matched no-switch baseline arm, one day earlier | `eval/results/long-v64/` |
| The live cache measurement the simulator was validated against | `reports/metrics/tree-vs-transcript.md:155`, from the `long-v6x` batch |
| The forensic six-mechanism classification of 135 sampled rows | `eval/plans/loop9b-analysis/01-run-forensics.md` |

**Table 5.** Where everything lives. The `e1b289c32f40` directory name is the fixture's content hash and is stable; the `results/` subdirectory inside it holds the committed run files, and the working tree currently carries several uncommitted additions there.

## 7 Recommended next steps

The steps are ordered by how much information each buys per unit of effort, where effort is counted in tokens and runs spent. Steps 2, 3 and 5 cost no model tokens at all. Each is specified so that it can be executed cold.

### Step 1 — The per-turn reply allowance needs its own round, and the replay comes first

This goes first because `replyAllowance` is the only shipped-library behaviour in this pass that is implemented, unit-tested and never run, and everything an offline check can show is that its arithmetic is right. What we do not know is behavioural: whether a model given a small allowance produces a usefully short answer or a uselessly truncated one, whether quality degrades gracefully as the allowance shrinks, and where the allowance becomes too small for the task. That floor is exactly what `replyAllowance` refuses to guess.

We would run this against the frozen session already in the repository rather than building a new long-running scenario for it. That session is already long: 754 events, roughly 196,000 tokens, stored with its hashes pinned. Instead of the twelve isolated question runs it drives today, the harness should walk forward through the trace, assembling the prompt as it stood at each point, computing the allowance there, and asking a live question at intervals. Every arm then sees byte-identical inputs, so the comparison is same-epoch by construction. This needs one harness change first: `transplant.mjs` asks its questions at a single fixed store state today, so an interval-walk mode has to be added before any run.

The three arms vary one thing, the reply limit. `no-limit` sends no `max_tokens` at all, which is today's live default. `fixed-ceiling` restores the removed behaviour and is the control the existing corpus was measured under; the live harness used 8,192 and the portability harness 800, and this run should use 800, because that is the clamp the frozen session's own numbers were produced with. `allowance` passes `BudgetReport.replyAllowance` straight through as `max_tokens`. The rest of the configuration is a list of values, so it is a table.

| Setting | Value |
|---|---|
| Arms | `no-limit`, `fixed-ceiling` (800), `allowance` |
| Model | `openai/gpt-3.5-turbo` (OpenRouter) |
| Window | W=16,384 |
| n | 12 questions × 3 arms × 5 replicates = 180 attempted, one epoch |
| Switch threshold | `EVAL_LAZY_TOKENS` derived from W, not 30,000 |
| Gate flags | all seven on |
| Cache breakpoints | `cacheZoneCBreakpoint` off |
| Segmentation | `neutralPhases: ['other']` |
| Fold ladder | narrow arm (`tree`) |
| Bounds | `--cost-cap-usd` only; no `--max-turns`, no `--time-cap-ms` |
| Estimated tokens | ≈ 2.4M (180 runs × median 13,107) |

The model and window are not a preference. The mechanism only engages once the prompt approaches the window, and W=16,384 is the smallest window the frozen session is scored at and the only cell where the tree arm completed 60 of 60 runs. Run the same design at W=32,768 on `qwen/qwen-2.5-72b-instruct` only if the small-window cell shows a curve worth confirming. The token estimate assumes a median 13,107 tokens per completed run at this cell, essentially all of it fresh input, since this endpoint bills no cache. Bound spend with the spend cap and let stall detection end a run that will not finish.

Four criteria are pre-registered. Primary: the `allowance` arm's mean graded score is at or above `fixed-ceiling`'s at every allowance decile, with the baseline on disk being the tree arm's existing W=16,384 cell. Primary: the `allowance` arm completes at least as many runs as `fixed-ceiling`, because the claim is that a session continues where a fixed ceiling would have made the request invalid. Guard: median run tokens for `allowance` are no worse than `fixed-ceiling`'s baseline of 13,107 (n=60 completed, verified for this report). Guard: the fraction of replies that stop at the allowance rather than at the model's own stopping point is recorded per arm, as a diagnostic rather than a criterion.

The refutation is carried verbatim from the queue. The failure that would refute the change is a run where shrinking allowances produce truncated-but-scored answers, because that trades a loud failure for a silent one, which is the opposite of what the change is for. Operationally: if the `allowance` arm's share of replies ending at `stopReason: 'length'` rises while its graded score holds or falls, the mechanism is hiding truncation and must be retired.

One limit of this design matters enough to state before anyone runs it. A frozen replay breaks the feedback loop. The allowance changes what the model says, what it says changes the trace, and the trace changes the next prompt. The replay settles answer quality at each allowance level and the shape of the curve; it cannot show whether shrinking allowances change the session's trajectory. A genuinely long live run is the confirmation, and it is worth paying for only after the replay says there is something to confirm, scoped to whichever allowance regime the replay says is interesting. Do not run the two in the other order.

```bash
node eval/scripts/transplant.mjs --scenario s1 --window 16384 \
  --model openai/gpt-3.5-turbo --arms tree \
  --reply-mode no-limit,fixed-ceiling,allowance --walk-intervals 12 --reps 5 \
  --cost-cap-usd <cap>
# --reply-mode and --walk-intervals do not exist yet; adding them is the prerequisite.
```

### Step 2 — Date the fixture's L1, or stop reading its latest summary version (zero tokens, zero runs)

This goes second because nothing assembler-driven is trustworthy until a pass can prove that the store it measured is the store the previous pass measured. That gap is what makes one iteration-2 table irreproducible, and it retroactively dates every Zone B number in the repository. It is about one day's work.

There are two ways to fix it. Either add `tree.db`'s node-dump and summary hashes to `manifest.json` as a pre-flight check that every script runs, or have assembler-driven scripts pin an explicit summary version rather than taking the newest. We prefer the second, because it is strictly local to the scripts and does not require the fixture to stop growing. Three smaller things are worth doing in the same visit: correct the stale verdict paragraph `cache-sweep.mjs` still prints (§5.3); resolve the one deleted result file sitting uncommitted inside the fixture directory, by restoring it or by committing the deletion deliberately; and record which of the 1,546 root-summary versions each published Zone B figure was measured against, as far as the dates allow.

The criterion is that re-running all four tuning scripts twice, hours apart, produces byte-identical output, and that a deliberate mutation of `tree.db` makes the pre-flight check fail loudly.

```bash
node eval/scripts/cache-sweep.mjs   # must be byte-identical across two runs hours apart
node eval/scripts/ladder-curve.mjs
node eval/scripts/resegment.mjs
node eval/scripts/switch-fraction-sweep.mjs
```

### Step 3 — The second-scenario simulator replicate that decides the cache default (zero tokens, zero runs)

This goes third because it is free, because it is the gate iteration 2 pre-registered for a shipped default flip, and because iteration 3-A has already done the instrument validation it depends on. What it buys is a default, not another measurement.

The two arms are `shipped`, with two breakpoints, against `3rd-breakpoint`, with `cacheZoneCBreakpoint: true`, both under `matchPolicy: 'automatic-prefix'`, run over a second frozen store: a different trace from a different session, ingested through the same pipeline. The frozen session's result is the baseline, at −39.8% session cost, with cache reads of 6,335,267 against 11,486,477 on a 15,130,974-token session total, n=754 turns.

The criterion is pre-registered and has four parts. The second store must reproduce all three structural properties: cache reads non-decreasing on at least 90% of turn-to-turn steps outside phase transitions, median write on writing turns at least an order of magnitude below the read total on those turns, and median fresh input under 500 tokens per turn. The session cost delta must also be negative. If any one of the three properties fails, the design is store-shaped and the default stays off. Both arms must also still pass `packages/core/test/cache.test.ts` unchanged.

The step costs zero model tokens. Ingesting a second store costs leaf-summarizer calls once, about 210k input tokens on the cheap model for 21 branches at the frozen session's scale, and that cost is shared with step 8.

```bash
node eval/scripts/cache-sweep.mjs --store eval/fixtures/transplant/s2/store
# --store does not exist yet; today the fixture path is hardcoded.
```

### Step 4 — Land the same-turn switch check, then buy the one live batch worth paying for

This goes fourth because it is the pass's one confirmed win with a live experiment attached, and it is the only live batch anything in three iterations recommends buying. The implementation is one local tokenizer pass. The batch is what confirms that removing the overshoot does not cost more elsewhere than it saves.

Implement it first. Move the check ahead of dispatch and apply it to the candidate prompt, using the `HeuristicTokenizer` the assembler already constructs locally (`eval/src/loop.ts:771`), and carry the ratio correction while doing so: a heuristic count runs about 17.5% above the provider's on this corpus, so an uncorrected candidate count fires early by that margin. The correction already exists as the division inside the budget derivation, so import it rather than reinventing the threshold. No flag is needed, because the change restores the stated rule and lives in the measurement harness, so no shipped default moves. Declare an epoch boundary at the commit: it changes which turn crosses, so no total-token, turn-count or cost figure from `long-v65-gate` or earlier may be compared against a run made after it.

The two arms vary one thing, when the gate looks: `lagged`, which is today's behaviour of reading `lastPromptTokens` from the previous call, against `same-turn`.

| Setting | Value |
|---|---|
| Arms | `lagged` (today) against `same-turn` |
| Scenarios | `sw-5-dozen`, `sw-6-ripple` |
| Agent model | `claude-sonnet-5` |
| Summarizer model | `claude-haiku-4-5-20251001` |
| Switch threshold | `EVAL_LAZY_TOKENS=30000` |
| n | 3 replicates per scenario per arm = 12 runs, interleaved same-day, one epoch |
| Estimated tokens | ≈ 3.2M billed (12 runs × median 265,428), roughly 60% cache reads on the recorded mix |

Those two scenarios are the only ones on record that cross the switch, and they are the source of all six recorded crossings, which is why they are the pair. Running the `lagged` arm alongside makes it a within-epoch reproduction of those six crossings. The models are not a choice either: the crossings exist only on this pair of models, and changing either forfeits the comparison.

Four criteria are pre-registered, per scenario. First, the crossing turn's prompt lands within 1,000 tokens of the threshold in at least 5 of the 6 `same-turn` runs; the offline proxy predicts five of six at zero overshoot and one at 916, so anything worse says the candidate prompt is not what the gate should be measuring. Second, median total billed tokens for `same-turn` are at or below `lagged`'s, whose baseline is on disk at a median 265,428 billed tokens per run (n=6, verified for this report); a rise means removing the overshoot cost more elsewhere than it saved, which is the one outcome that retires the fix. Third, as a guard, median turns for `same-turn` are no worse than the baseline plus 2, where the baselines are 13 turns on `sw-5-dozen` and 18 on `sw-6-ripple`, both recomputed for this report, since the verdict's "13 and 16" is wrong on the second (§5.6); an earlier, smaller crossing bought with turns is not a win. Fourth, as a pooled guard, no run is graded `success: false` on a scenario where `lagged` graded true. These are graded by hidden tests against the sandbox, so a regression there is a filesystem fact.

```bash
EVAL_LAZY_TOKENS=30000 node eval/dist/run.js \
  --scenarios sw-5-dozen,sw-6-ripple --arms context-tree \
  --reps 3 --cost-cap-usd <cap>      # once per arm, interleaved same-day
```

### Step 5 — The instrumentation bundle (zero tokens, zero runs)

This goes fifth because it is three one-field changes, none of which needs a model call, and each of which retires an interpretive gap that currently forces a hypothesis where a measurement belongs. They are bundled because each is smaller than the overhead of scheduling it alone, and because every later step reads more cheaply with them in place.

1. Decompose `peakRequestTokens` by zone in the transplant harness. It is the only way to settle where the width gap lives, and until it exists neither competing claim about width's cost can be defended. The honest limit is worth stating with it: iteration 3-C shows that even a perfect decomposition does not reach significance at n=38, so this buys attribution, not resolution.
2. Record the `depth` argument on every `context_fetch`. This retires the largest interpretive gap in the depth dimension, because the 4.4% of rows that fetched the correct branch, suffered no truncation and still answered wrongly cannot be attributed today, and neither can the single fetch of the oversized branch. Every future run then discriminates a tool-design limit from a model-competence limit for free.
3. Record non-agent model calls per turn. `metrics.tokens.total` counts the agent model only, so the leaf summarizer's tokens appear in no total-token figure this program publishes, and no artifact says which turn a summarize call landed on. This is one field on `TurnRecord`. Until it exists, no total-token number in this program includes summary cost, and that caveat belongs wherever a total is quoted.

The criterion is that re-reading one existing result file plus one new run reproduces the run's `peakRequestTokens` as the exact sum of its zone parts, and that the leaf summarizer's tokens appear in a run total for the first time.

### Step 6 — Raw-by-default fetch, the floor-lifting change that unblocks two dimensions

This goes sixth, and nothing about width or depth should be bought before it, because both blocked dimensions are blocked behind the same retrieval floor rather than behind spend. None of the twelve answer literals appears in any of the twenty-one rendered summary bodies, so the current fetch default cannot answer a verbatim question at all, and 9 of the 12 questions sit at exactly 0.000 across both widths and every retrieval rank. A second scenario at n=15 per cell would compare two arms whose expected successes are about 4 and 4.

The two arms are `summary-default`, which is today's behaviour, against `raw-default`, in which fetch returns raw events by default, aimed by a sequence range, with a listing mode available; "raw, sized to fit" replaces "summary or raw". Pair it with the already-verdicted `search-hits-are-coordinates` change if the two can be isolated, and do not bundle them if they cannot, since that change measured search payload falling from 9,673 to 4,898 tokens on its own.

| Setting | Value |
|---|---|
| Arms | `summary-default` (today) against `raw-default` |
| Models and windows | `qwen/qwen-2.5-72b-instruct` at W=32,768; `openai/gpt-3.5-turbo` at W=16,384 |
| n | 12 questions × 5 replicates × 2 arms per window = 240 attempted |
| Estimated tokens | ≈ 6.1M (240 runs at the two cells' medians, 13,107 and 37,513) |

Those are the frozen session's own cells, which is why the baselines are already on disk. The criterion is pre-registered: successes across the 120 searched-row population rise from 4 to at least 12, a threefold lift chosen because below that no affordable width or depth experiment discriminates, with no question type falling below its current mean and no median run-token rise above 1.5× the paired baseline cell. If successes stay under 12, the retrieval problem is not the fetch default, and the width and depth dimensions should be recorded as closed by blockage rather than pursued.

### Step 7 — Port the derived budgets into the live suite (zero runs to decide it)

This goes seventh because it is a defect fix rather than an experiment, and it is the audit's top recommendation. Until it lands, no comparison of switch policies measures the policy that would actually ship: the live suite's switch point, Zone B allowance and Zone C allowance are the absolute literals 30,000, 8,000 and 30,000, and its fold level is the constant 40, while the derivation already exists in `packages/core/src/assemble/budgets.ts`. Delete the absolutes, derive them from W with the switch equal to the Zone C share, and port the fold-ladder derivation, so that the live suite stops using a constant known to render no body at all at W=32,768 on the one store that has been measured. We rank it below the experiments because it changes no measurement on its own, and above nothing, because it is a prerequisite for any future switch-fraction work.

The criterion is that a run at ten times the window produces ten times each allowance (a test already asserts this for the library function), that the live suite's `results.json` records a derived switch equal to its Zone C share, and that the existing 91 eval tests and 599 package tests stay green.

### Step 8 — A second store, and only then the width-cost replicate

This goes last because every limitation in every dimension is the same limitation: one store, one trace, one host's tool-name map. The offline recipe is already written and runs at zero model tokens. Re-segment a second store's event log under both configurations, locate each question's sequence in the new segmentation, count branches and sizes, and re-run the harness's own zero-token structural gates against each candidate's re-derived tree. That last part is the step still missing even on the frozen session: a candidate that multiplies branch count by 4.71 changes how many branch summaries fit a given allowance, which is exactly what the over-budget gate asserts, and its interaction with the fold level is unexamined.

The width-cost replicate is dominated and should not be bought yet. Resolving the 5,275-token mean gap needs about 246 completed rows per arm, which is roughly 390 attempted per arm at the frozen session's 63% completion rate, about 780 runs and 29M tokens at the W=32,768 cell's median. Step 6 may also change the arms' behaviour enough to invalidate the whole batch. Buy it only after step 6 lands, and only if the retrieval floor lifted.

## 8 Standing constraints the next agent must respect

1. Impose no budgets or caps: not on turns, not on wall-clock, not on reply length. Bound the resource itself instead, capping spend with a spend cap and ending a run that will not finish by detecting non-progress. Two such caps have already corrupted measurements here, since a turn ceiling fabricated 16 failures and a reply clamp produced empty answers that were then graded wrong.
2. Never delete a rule in order to satisfy a constraint that is itself a guess. Reply headroom is required by the algorithm, because prompt plus reply must fit the window; a reply ceiling is not required by anything. That distinction is explicit in the code and must stay explicit in any change.
3. Do not silently deviate from a D-numbered decision. If implementation shows that one is wrong, say so, propose the change, and update the decision row.
4. L1, L3 and L4 are derived layers, so never write a migration for them. Changing the segmenter or a summary prompt means deleting the derived layers and rebuilding them. Summaries are versioned, never overwritten.
5. The prompt layout is fixed and only content migrates: Zone A, then Zone B in creation order, then Zone C. Zone B is never relevance-ordered, because reordering a cached prefix is the cache killer. Retrieved results append after Zone C.
6. Ingestion is hermetic. It reads the event log, the payload store and a parser, and it calls nothing over a network.
7. An epoch shift forfeits every comparison across it. Re-segmenting, flipping the ladder default and moving the switch check all change what gets built or when it gets built. Declare the boundary at the commit, and never compare a total-token, turn-count or cost figure across it.
8. Never grade a run the harness stopped as a task failure. A failing grade becomes `success: null`. The one exception is narrow and deliberate: a capped run whose hidden tests pass keeps its success, because the grade is a filesystem fact. A stall keeps both directions, because ending in a loop is a real task failure.
9. Report metrics as tokens, turns, graded score and success counts, using means for scores and medians for tokens and turns, and state n everywhere. Dollar figures appear once, in a footnote, beside the baseline they are relative to, and never as a bare figure inside a claim.
10. Pair every comparison against a baseline at the same model and the same epoch. Where a same-epoch baseline does not exist, say so in the same breath as the number; three of the six recorded cache-invalidation mechanisms have no valid baseline and are reported as within-run or before-and-after observations only.
11. Price a segmentation or rendering proposal with a real tokenizer, never with the corpus-wide ratio. That ratio undercounted two branches by 43% and 67%.
12. Copy the frozen fixture before touching it, and check `git status` afterwards. Its store directory is gitignored, so `git status` alone proves nothing; the copy is what protects it.
13. An unknown tool maps to `other` and never crashes. The tool-to-phase map is the one row every port must edit.
14. A conservative instrument can invert a comparison. Under-crediting cannot hide a regression but it can flip a sign, so validate an instrument against a measurement you have already paid for before letting it rank designs.
15. No total-token figure in this program includes leaf-summarizer cost, because the harness's total counts the agent model only. Quote totals with that caveat until step 5 lands.
16. Do not run a live width or depth arm before the retrieval floor lifts. With 9 of 12 questions at exactly zero across both widths and every rank, no affordable n discriminates.

## 9 What this pass did not test

This section states scope, so that a next agent does not read an untested condition as a settled one.

Every number in this report rests on a narrow base, and it is worth saying plainly what that base is. The structural measurements all come from one recorded session: a single Claude Code session on this repository, whose event log names `claude-fable-5` as the model that produced it, ingested into 754 events. The live timing numbers come from two scenarios, `sw-5-dozen` and `sw-6-ripple`, which are here because they are the only two in the suite that ever cross the summarization threshold. The live token and cost numbers come from two vendors' endpoints and no others: Anthropic for `claude-sonnet-5` and `claude-haiku-4-5`, and OpenRouter for `qwen/qwen-2.5-72b-instruct` and `openai/gpt-3.5-turbo`. Nothing here has therefore been shown to hold on a second trace, a second task, or a second provider. The list below says which of those gaps matters where.

- No experiment in any of the three iterations called a model. Every live number in this report was already on disk when the pass started, from batches run on 1 and 2 September.
- One store. Every structural number, including the 77-fold branch spread, the 21-against-99 re-segmentation, the ladder curve, all four cells of Table 1, the cache replay and the width decomposition, comes from `transplant/s1`: one trace, one task, one host's tool-name map, 754 events. Whether the neutral-merge mechanism or the size spread is a property of the rule or of this one session is the single largest unknown in the pass.
- Five windows assembled, two scored. The structural gates run at 8,192, 16,384, 32,768, 65,536 and 200,000, but no scored run has ever been made at 8,192 (a dead cell for both tree arms), at 65,536, or at 200,000. The 8,192 cell is the clearest evidence for deleting the zone partition, and it has never carried a model call.
- Four models, and not interchangeably. The width and depth numbers are `qwen/qwen-2.5-72b-instruct` and `openai/gpt-3.5-turbo` through OpenRouter, which bills no cache at all, so every rewrite claim in this pass is Anthropic-specific and the OpenRouter path reports `cacheWrite: 0` by design. The timing and caching numbers are `claude-sonnet-5` with `claude-haiku-4-5` summaries. No dimension has been measured on more than one model family.
- Caching against width, not measured. The width dimension was measured entirely on an endpoint that bills no cache. Under a cache the same reallocation is nearly free while the prefix is stable and expensive at each rewrite, so a width policy chosen there may be the wrong one here. That coupling runs between dimensions 1 and 3, and nothing has measured it.
- One provider, for every cache claim. No non-Anthropic provider in this repository reports a cache-write count, so nothing at all has measured a breakpoint scheme on a second provider.
- Summary quality at either granularity, not measured. The candidate segmentation puts many branches at roughly one tool call plus its result, and 47 of its 99 branches carry no phase identity beyond `other`. Whether a summary of that little work is worth its own leaf pass is untouched.
- Turns and score under the candidate segmentation, unmeasured on every task, short or long. Only containment and branch count have been measured, so the question the fourth rule asks, which setting wins, is open.
- The reply allowance live, never run. That is step 1, and the trajectory question cannot be answered by the replay step 1 buys.
- The listing-then-range fetch path, which exists and is untested live. It is the only lever left on the three branches over W=16,384.
- Contract v2 and v3, registered and unreachable. The shipped server always installs v1 and has no configuration field to choose otherwise, so the tier-2 table's "host, if a smaller model needs different instruction" overstates what is configurable.
- Populations the scenarios never exercised. Twelve questions in four question types from one frozen trace is not a live session whose composition could be observed. Every graded scenario in the timing dimension scores 1.000 with every replicate passing, so no timing policy can currently be shown to make an agent more reliable, only cheaper or dearer. And no scenario in the program separates the arms on reliability at all once harness-stopped rows are excluded.
- A multi-entry or TTL-bounded cache, not modelled. The simulator's `automatic-prefix` policy tracks one running prefix. A real cache holding several entries under a time-to-live could do better than these numbers, never worse.

---

<sup>†</sup> Dollar figures are in United States dollars, at the rates in `packages/core/src/models/cost.ts`: `claude-sonnet-5` at $2.00 per million input tokens, $10.00 output, $0.20 cache read and $2.50 cache write; `claude-haiku-4-5` at $1.00 input and $5.00 output; and `qwen/qwen-2.5-72b-instruct` at $0.36 input and $0.40 output, with cache billed at zero. At those rates, the six baseline switch-crossing runs cost $0.279 to $0.650, median $0.335, and twelve comparable runs for step 4 price at roughly $4. The median completed width run costs $0.0137 under the narrow arm and $0.0181 under the wider one, against $0.0082 under the truncate-tail baseline and $0.0048 under compact-rolling. The 754-turn cache replay prices at $18.88 for the shipped layout against $11.36 for the third breakpoint. Dollars appear here once, beside the baselines they are relative to; every claim in this report is made in tokens, turns, graded score and success counts.

DS-STAR pass, iterations 1–3, four dimensions · zero live model calls in any iteration · Figures 1, 2 and the switch-fraction table reproduced for this report by re-running `eval/scripts/{ladder-curve,resegment,switch-fraction-sweep}.mjs` against a copy of the frozen `s1` store · Figure 3 recomputed from `eval/results/long-v65-gate/*/results.json`, `claude-sonnet-5`, three replicates on each of two scenarios, one epoch · Figure 4 from `eval/plans/tuning/exp3-a-simulator-fidelity.md`'s published per-turn sample of a re-run of `eval/scripts/cache-sweep.mjs`, whose session totals were reproduced for this report · width scores and tokens from `eval/fixtures/transplant/s1/e1b289c32f40/results/`, `qwen/qwen-2.5-72b-instruct` at W=32,768, five replicates per question, completed runs only · September 2, 2026 · commit `77d5326`.
