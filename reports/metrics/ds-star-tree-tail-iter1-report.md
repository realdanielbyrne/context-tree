# Raw tail events do not lift the tree arm at 32k

Context-tree retrieval · DS-STAR tree-tail iteration 1 · September 3, 2026

Context-tree reorganizes an agent's linear conversation trace into a summary-headed tree so that a long-running session sees branch summaries instead of raw history, pulling detail back on demand through retrieval tools. A prior three-iteration DS-STAR pass found that the tree arm scores effectively zero because summary-based search ranks the wrong branch, and recommended filling Zone C with raw recent events — the mechanism that baselines use to score above zero. We built a new arm, tree-tail, that combines the tree prompt (system contract, branch summaries, retrieval tools) with raw recent events filling the remaining window headroom. At W=32,768 on Qwen 3.7 Flash with 60 runs per arm, tree-tail and the truncate-tail baseline produce the same five successes, all on one question whose answer literal sits in the raw tail window. Tree-tail also introduces a stall failure: 31 of 60 runs enter tool-call loops instead of completing. The raw tail mechanism works, but at this window size it adds no successes over the baseline that already uses it, and the retrieval tools hurt completion rate. The decisive measurement is at larger windows where the tree's smaller overhead leaves more room for raw events.

## 1 Terms

A **branch** is a contiguous range of the event log that receives one summary; the frozen store has 21 of them. A **run** is one model attempting one question once. The **tree arm** assembles summaries in Zone B and offers four retrieval tools; the model calls `context_search` to rank branches by summary similarity, then `context_fetch` to read a branch's content. **Tree-tail** is the tree arm with raw recent events from the trace tail appended after Zone C, filling whatever window headroom remains after zones A, B, C, and the reply reservation. **Truncate-tail** keeps the most recent raw events that fit the window, with no tools. The **frozen store** is a real Claude Code session on this repository, 754 events, ingested into 21 branches, with 12 questions in four types: head (early facts), tail (recent facts), deep (code literals), and spanning (facts requiring two places in the trace). **W** is the model's context window. **Headroom** is W minus the assembled prompt minus the reply reservation.

## 2 What was built

The tree-tail arm adds one code path to `buildArm` in `eval/scripts/transplant.mjs`. It builds the tree prompt exactly as the control tree arm does — same system contract (v1), same Zone B branch summaries at the same rootKeep, same legacy tool surface, same handlers — then computes headroom and fills it with the most recent raw events from the trace, rendered identically to how truncate-tail renders them.

At W=32,768 with heuristic-to-BPE ratio 0.85, the tree prompt assembles to approximately 9,800 tokens: Zone A at 2,200 tokens (system contract plus tool schemas) and Zone B at 7,600 tokens (root summary at keep=16 plus two branch summaries). There is no active branch in the frozen store, so Zone C contributes zero. That leaves approximately 21,000 tokens of headroom after the 1,638-token reply reservation. By comparison, truncate-tail's K budget at the same window is approximately 30,800 tokens — 47 percent more raw content.

The implementation is four edits to `transplant.mjs`: ARM_IDS, TREE_ARMS, LEGACY_SURFACE_ARMS, and the `buildArm` switch case. Zero model calls. All 50 existing tests pass.

## 3 Results

### 3.1 Absolute successes are identical

At W=32,768 on Qwen 3.7 Flash with 5 replicates per question (60 runs per arm), tree-tail and truncate-tail produce the same five successes. All five come from one question, s1-q06-tail, which asks for a code comment in the assembler's Zone C method. That literal sits in the most recent events and falls inside both arms' raw tail windows.

| Arm | Successes | Scored | Stalled | Mean score |
|---|---|---|---|---|
| tree-tail | 5 | 28 | 31 of 60 | 0.179 (5/28) |
| truncate-tail (baseline) | 5 | 60 | 0 of 60 | 0.083 (5/60) |
| tree (same epoch) | 1 | 6 | 48 of 60 | 0.167 (1/6) |

The mean-score difference (0.179 versus 0.083) is an artifact of denominator shrinkage: tree-tail's 31 stalled runs are excluded from scoring, inflating the rate. The absolute success count is five in both arms.

### 3.2 Per-question breakdown

| Question | Stratum | tree-tail (5 reps) | truncate-tail (5 reps) |
|---|---|---|---|
| s1-q01-head | head | 0/5 | 0/5 |
| s1-q02-head | head | 0/5 | 0/5 |
| s1-q03-head | head | 0/5 | 0/5 |
| s1-q04-tail | tail | 0/5 | 0/5 |
| s1-q05-tail | tail | 0/5 | 0/5 |
| s1-q06-tail | tail | **5/5** | **5/5** |
| s1-q07-deep | deep | 0/5 | 0/5 |
| s1-q08-deep | deep | 0/5 | 0/5 |
| s1-q09-deep | deep | 0/5 | 0/5 |
| s1-q10-spanning | spanning | 0/5 | 0/5 |
| s1-q11-spanning | spanning | 0/5 | 0/5 |
| s1-q12-spanning | spanning | 0/5 | 0/5 |

The two arms are indistinguishable on every question. The one answerable question scores perfectly in both; the eleven unanswerable questions score zero in both. The question set has exactly one question whose answer literal sits inside the raw tail window at this window size, creating a ceiling effect at 1/12 ≈ 0.083.

### 3.3 Stall failure mode

Tree-tail stalls 31 of 60 runs (52 percent). The mechanism: when the model cannot find the answer in the raw tail, it uses the retrieval tools — searching for the answer across branch summaries, fetching branches, searching again with different queries — until the stall detector halts the run after three consecutive turns with identical tool-call signatures. Truncate-tail has no tools, so every run completes in one turn.

The stalls concentrate in head, deep, and spanning strata (31 of 45 non-tail runs). The tail stratum completes all 15 runs because the model either reads the answer from the raw events (s1-q06) or gives a wrong answer without attempting tools (s1-q04, s1-q05).

## 4 Mechanism attribution

The raw tail mechanism works identically in both arms. When the answer literal appears in the raw events, the model reads it directly — in several tree-tail runs on s1-q06, the model does not even call `context_search` before answering. When the answer literal is absent, both arms fail: truncate-tail fails with a wrong answer in one turn, tree-tail fails with a stall in four to nine turns.

Tree-tail adds no absolute successes over truncate-tail because three things compound:

First, the headroom difference does not matter at this window size. Tree-tail's 21,000 tokens of raw events and truncate-tail's 30,800 tokens cover the same portion of the trace tail. The one answerable question (s1-q06) falls inside both windows. The nine unanswerable non-tail questions have answer literals in events far earlier in the trace, beyond either window's reach.

Second, Zone B summaries do not help the model locate answers within the raw events. The summaries describe what each branch is about, not which specific literals appear in them. A model that has already read the raw events and found the answer does not need the summary; a model that has not found the answer cannot be directed to the right location by the summary.

Third, offering retrieval tools alongside raw context creates a stall trap. The model is trained to use tools when provided, so it attempts searches even when the answer is visible in the prompt. For questions whose answers are absent, the tool calls are futile but expensive: each search-then-fetch cycle adds a turn, and the stall detector requires three consecutive identical signatures before halting.

## 5 What was rejected

The tree-tail candidate as a mechanism for improving absolute score at W=32,768: null result. Same mechanism, same five successes, same eleven failures, plus a 52 percent stall rate. The implementation is correct and the raw tail events are present in the prompt — the model reads them for the one answerable question — but the window is too small for the raw tail to reach any question that truncate-tail does not already reach.

The mean-score improvement (0.179 versus 0.083) is an artifact. It was not promoted.

## 6 What was learned

The raw-tail mechanism is the sole contributor to above-zero scores on this question set and model, now confirmed across both tree-tail and truncate-tail. At W=32,768, the tree's overhead (approximately 9,800 tokens for Zone A and Zone B) reduces raw tail headroom from approximately 30,800 to 21,000 tokens, but this does not change which questions are answerable. The one answerable question falls within both windows.

Offering retrieval tools alongside raw context introduces a completion-rate regression. The model uses the tools even when the answer is not reachable through them, producing stalls instead of wrong-but-scored completions. This is a real cost: a stalled run spent more tokens than a one-turn wrong answer and produced no score data. An arm that gives the model raw context without tools (tree-tail-static) would eliminate the stalls and test whether the summaries contribute anything as passive context.

The question set is a bottleneck. Twelve questions with one answerable from the raw tail at W=32,768 cannot distinguish between arms that both answer that one question. The measurement's sensitivity is determined by the question set's coverage of the trace, not by the number of replicates.

## 7 Recommended next steps

These are ordered by expected information gained per unit of effort.

1. **Test at W=65,536 and W=200,000.** At W=65,536, tree-tail headroom is approximately 55,000 tokens, covering roughly 330 of the 754 events. At W=200,000, headroom is approximately 190,000 tokens, covering nearly the entire trace. More questions become answerable as the raw tail grows, and the tree's Zone B overhead becomes negligible as a fraction of the window. Run tree-tail and truncate-tail at both windows on the same model, 5 replicates, same question set. This is the prior report's §7 item 2 and is the decisive measurement for whether the tree's overhead matters.

2. **Expand the question set.** Adding questions whose answer literals sit at various depths in the trace (seq 100, 300, 500, 700) would create a sensitivity curve: at what window size does each question become answerable, and does the tree's smaller overhead (more headroom for raw events) make a measurable difference at one window but not another?

3. **Test tree-tail without tools (tree-tail-static).** If the stall rate is the primary regression, removing tools eliminates it. The model would have Zone B summaries for orientation and raw events for answering, with no tool-call loops. This is the minimal honest version of the hypothesis and isolates whether summaries help or hurt when raw content is also present.

## 8 What this pass did NOT test

Every measurement comes from one window (W=32,768), one model (Qwen 3.7 Flash via OpenRouter), one frozen store (754 events, 21 branches), and one question set (12 questions). No window above 32,768 was scored — the tree's value proposition is on large windows where the overhead is a smaller fraction and the raw tail covers more questions. No model on the Anthropic provider was included. A tree-tail-static arm (raw tail without tools) was not built or tested. The same-epoch tree baseline scored 1 success out of 6 scored runs with 48 of 60 stalled, consistent with the prior report's 0.000 to 0.029 range. The question set tests only literal-finding; questions answerable from summaries alone were not included.

---

DS-STAR tree-tail iteration 1 · 120 scored runs on 1 model · 0 instrument defects · 0 kill gates · $0.25 in answering tokens · September 3, 2026.
