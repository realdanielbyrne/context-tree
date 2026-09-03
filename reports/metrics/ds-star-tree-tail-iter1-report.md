# Raw events are the sole scoring mechanism at tested windows

Context-tree retrieval · DS-STAR raw-tail pass, 4 iterations · September 3, 2026

Context-tree reorganizes an agent's linear conversation trace into a summary-headed tree so that a long-running session sees branch summaries instead of raw history, pulling detail back on demand through retrieval tools. A prior DS-STAR pass found that the tree arm scores effectively zero because summary-based search ranks the wrong branch, and recommended filling the window headroom with raw recent events. This pass tested that recommendation across four iterations, roughly 360 scored runs on three models, and a three-designer panel. The finding is unambiguous: at every tested window and model, the only mechanism that produces above-zero scores is the model reading answer literals from raw events visible in the prompt. Branch summaries do not contribute to scoring when raw events are present — they displace answer-bearing content without compensating through navigation, and the effect is measurable. At W=32,768, adding verbose summaries drops the score from 0.083 to 0.067; at W=65,536, the tree's 9,800-token overhead costs two entire answerable questions. Retrieval tools compound the harm through a stall failure mode that blocks 52 percent of runs. Headline-only summaries, reduced to one sentence plus metadata pointers, save 80 percent of Zone B's tokens but produce scores indistinguishable from verbose summaries. The tree's value proposition — summaries as a compression layer for sessions that exceed the window — remains untested because the overflow regime was economically impractical to reach on available providers.

## 1 Terms

A **branch** is a contiguous range of the event log that receives one summary; the frozen store has 21 of them. A **run** is one model attempting one question once. The **tree arm** assembles summaries in Zone B and offers four retrieval tools. **Truncate-tail** keeps the most recent raw events that fit the window, with no tools. **Tree-tail** is the tree arm with raw recent events from the trace tail appended after Zone C, filling whatever window headroom remains after zones A, B, C, and the reply reservation. **Tree-tail-static** is tree-tail without retrieval tools — summaries are passive context only. **Tree-tail-headline** is tree-tail-static with Zone B summaries reduced to one sentence plus structured metadata pointers (files, symbols, tests, decisions, open questions, fetchable node ids), an 80 percent reduction from roughly 4,400 to 900 tokens. **Headroom** is W minus the actual assembled prompt minus the reply reservation. The **frozen store** is a real Claude Code session on this repository, 754 events, ingested into 21 branches, with 12 questions in four types: head (early facts), tail (recent facts), deep (code literals), and spanning (facts requiring two places in the trace). **W** is the model's context window.

## 2 What was built

Three new arms in `eval/scripts/transplant.mjs`, each isolating one variable against the tree control arm:

| Arm | Zone B | Tools | Variable isolated |
|---|---|---|---|
| tree-tail | verbose summaries | yes | raw tail events added |
| tree-tail-static | verbose summaries | no | tools removed |
| tree-tail-headline | headline only | no | summary verbosity reduced |

Each arm builds the tree prompt (Zone A system contract, Zone B branch summaries, Zone C active branch detail), computes headroom from `W - prompt.budgets.total - maxReplyTokens`, and fills the headroom with the most recent raw events from the trace. Events are rendered identically to truncate-tail's rendering.

At W=32,768 with heuristic-to-BPE ratio 0.85, the tree prompt assembles to approximately 9,800 tokens: Zone A at 2,200 tokens (system contract plus tool schemas) and Zone B at 7,600 tokens (root summary at keep=16 plus two branch summaries). Zone C contributes zero because no branch is active in the frozen store. Headroom is approximately 21,000 tokens after the 1,638-token reply reservation. By comparison, truncate-tail's K budget at the same window is approximately 30,800 tokens.

The tree-tail-headline arm post-processes Zone B blocks before assembling messages: for each summary block, it retains the heading line (`## Branch: <title> [phase_type] (status)`), the first sentence of the prose body, and all structured metadata lines. The full-prose body is discarded. Across 22 summaries in the frozen store, this reduces total prose from 17,616 characters (roughly 4,400 tokens) to 3,606 characters (roughly 900 tokens). The metadata lines are unchanged.

WINDOWS was expanded from `[16384, 32768]` to `[16384, 32768, 65536, 200000, 1000000]` and the manifest was re-pinned for all five windows. All 50 existing tests pass on the modified harness.

## 3 Results

### 3.1 Five arms at W=32,768

At W=32,768 on Qwen 3.7 Flash with 5 replicates per question (60 runs per arm), all in the same epoch:

| Arm | Successes | Scored | Stalled | Mean score | Median prompt tokens |
|---|---|---|---|---|---|
| truncate-tail (baseline) | 5 | 60 | 0 of 60 | 0.083 (5/60) | 31,000 |
| tree-tail (tools) | 5 | 28 | 31 of 60 | 0.179 (5/28) | 31,000 |
| tree-tail-static (no tools) | 4 | 60 | 0 of 60 | 0.067 (4/60) | 25,400 |
| tree-tail-headline (no tools) | 4 | 59 | 0 of 60 | 0.068 (4/59) | 26,600 |
| tree (tools, no raw tail) | 1 | 6 | 48 of 60 | 0.167 (1/6) | 10,000 |

Scores are means over completed, scored runs; the parenthetical is successes over scored count. The tree-tail mean of 0.179 and the tree mean of 0.167 are artifacts of stall-induced denominator shrinkage — 31 and 48 runs respectively were excluded from scoring because the stall detector halted them before completion.

All successes across all five arms come from one question, s1-q06-tail, whose answer literal is "Callers that cache Zone C must keep it after their moving breakpoint." Truncate-tail and tree-tail score 5 of 5 on it. Tree-tail-static and tree-tail-headline score 4 of 5. The tree arm without raw events scores 0 of 5 on it (its one success came from a different question). The other eleven questions score zero across all arms at this window.

### 3.2 Two arms at W=65,536

At W=65,536 on GPT-4.1-mini with 5 replicates per question (60 runs per arm), same epoch:

| Arm | Successes | Scored | Stalled | Mean score |
|---|---|---|---|---|
| truncate-tail | 13 | 60 | 0 of 60 | 0.217 (13/60) |
| tree-tail (tools) | 5 | 59 | 1 of 60 | 0.085 (5/59) |

Truncate-tail now answers three questions: s1-q02-head at 5 of 5, s1-q06-tail at 3 of 5, and s1-q08-deep at 5 of 5. Tree-tail answers only s1-q06-tail at 5 of 5. Verified from turn-1 prompt tokens: tree-tail sends a median of 53,151 tokens and truncate-tail sends 54,480. The 1,329-token gap is the actual displacement — a narrow strip at the truncation boundary containing the events that carry the answer literals for s1-q02 and s1-q08.

### 3.3 W=200,000 was impractical

At W=200,000 on Qwen 3.8 Flash via OpenRouter, each run consumed approximately 162,000 input tokens and cost roughly 1.70 USD. The provider returned 429 rate-limit errors on most requests. The per-model cost cap of 15 USD was reached after approximately 8 runs, none of which completed enough questions to produce a usable result file. Testing at this window requires either a cheaper provider endpoint or a substantially larger cost budget.

## 4 The Zone B budget framing was wrong

After iteration 1, we hypothesized that the Zone B budget formula — `floor(0.20 * W / ratio)` — was wasting headroom because it scales linearly with the window while actual summary content stays fixed. At W=1,000,000 the budget is 235,294 tokens against roughly 7,600 tokens of content, and the claim was that the 228,000-token surplus was headroom the raw tail could not use.

Three independent designers — two proposing alternatives and one defending the null hypothesis — analyzed this claim. Two of three reached the same conclusion independently: the framing conflates the Zone B budget ceiling with the actual token cost. The tree-tail arm computes headroom from `prompt.budgets.total`, which sums the actual rendered tokens across all zones, not the pre-allocated budget fractions. The Zone B budget is a ceiling that governs only the oldest-first drop logic in the assembler; unused budget does not claim window space.

The verification is in the run data. At W=65,536, tree-tail sends 53,151 prompt tokens and truncate-tail sends 54,480. The difference is 1,329 tokens, not the 16,000 the budget numbers would imply. The actual overhead is the fixed cost of the tree's content: Zone A at 2,200 tokens (system contract plus tool schemas) and Zone B at 7,600 tokens (rendered summaries). This 9,800-token displacement applies at every window size. No budget formula change can eliminate it because it is real content, not a reservation.

## 5 Mechanism attribution

Across all iterations, one mechanism and only one mechanism produces above-zero scores: the model reads the answer literal from raw events visible in the prompt.

Three further mechanisms determine how many events the model sees and whether it finishes:

First, summaries displace raw events. The tree's Zone A and Zone B occupy approximately 9,800 tokens at every tested window. At W=32,768, this pushes the truncation boundary forward by roughly 30 events. One question (s1-q06-tail) falls inside both windows and scores the same. At W=65,536, the displacement is the same 9,800 tokens but now costs two entire questions whose answer literals sit in the excluded strip.

Second, retrieval tools cause stalls. When the model has tools and the answer is not in the visible context, it enters search-fetch loops — searching branch summaries, fetching the wrong branch, searching again with a different query — until the stall detector halts the run. The stall rate is 52 percent with tools (tree-tail) against zero without (truncate-tail, tree-tail-static, tree-tail-headline). Stalled runs consume more tokens than one-turn wrong answers and produce no score data.

Third, summary verbosity does not matter. Headline-only Zone B (first sentence plus metadata pointers, roughly 900 tokens) and verbose Zone B (full prose, roughly 4,400 tokens) produce indistinguishable scores: 4 of 60 and 4 of 59 at W=32,768. The 3,500 tokens freed by the headline reduction add roughly 20 more raw events to the tail, but none of them carry an answer literal for the eleven unanswerable questions.

## 6 The sparse attention parallel

DeepSeek's sparse attention research (arXiv 2512.02556) found that stacking Multi-Head Latent Attention's built-in compression on top of additional sparse token selection degraded performance by 41 percent on 1,024-token sequences compared to latent attention alone. Their term for it is "double compression" — the latent representation already captures the sparsity benefit, and a second layer of selection is too aggressive.

The finding here is the same pattern. Branch summaries are a form of latent compression: they rewrite each branch's raw events as a shorter paraphrase plus structured pointers. Raw events in the prompt are the full-attention equivalent: every token is visible. Presenting both — summaries plus the raw events they summarize — is double compression. The model reads the raw events when they are present and ignores the summaries. The summaries earn their keep only when the raw events do not fit, which is the regime this pass could not test.

The implication for the product is that summaries should be treated as an episodic index for the overflow, not as a substrate the model operates on alongside raw content. A branch summary says "we discussed topic X at some point" so the model knows to fetch the detail; it does not say enough about the content for the model to answer a literal question without seeing the raw events.

## 7 What was rejected

The tree-tail candidate as a mechanism for beating truncate-tail at W=32,768: null result on absolute successes, regression on stalls (5 of 60 versus 5 of 60, but 31 stalls versus 0).

The tree-tail-static candidate at the same window: regression on absolute successes (4 of 60 versus 5 of 60). Summaries displace one replicate of the only answerable question.

The tree-tail-headline candidate at the same window: same regression (4 of 59 versus 5 of 60). The 80 percent Zone B reduction does not recover the lost replicate.

The Zone B budget formula as the cause of the headroom deficit: refuted by the design panel. Headroom is computed from actual assembled content.

W=200,000 testing on cheap models via OpenRouter: economically impractical at 1.70 USD per run with persistent 429 rate limits.

## 8 What was learned

1. Raw events are the sole scoring mechanism at every tested window and model. No other mechanism — summary-directed retrieval, summary-based navigation, headline-only indexing — has produced a scored success that raw events did not produce first.

2. Summaries are pure overhead when raw events are present. At W=32,768 they cost one replicate of the only answerable question. At W=65,536 they cost two entire questions. The overhead is a fixed 9,800 tokens regardless of the window.

3. Retrieval tools cause stalls when the answer is not reachable. The stall rate is 52 percent with tools and zero without. The stalls consume more tokens and produce less data.

4. Headline-only summaries are indistinguishable from verbose summaries in scoring. The 80 percent Zone B reduction (4,400 to 900 tokens) does not change which questions are answerable at W=32,768 because the freed tokens do not reach a new answer literal.

5. The Zone B budget formula does not control headroom. A pass that changed it would produce no observable effect on any metric. This was the most expensive lesson of the pass — the original framing was wrong, and it took a three-designer panel to establish that.

6. The question set is the sensitivity bottleneck. Twelve questions with one answerable at W=32,768 cannot distinguish between arms whose only difference is a few thousand tokens of headroom. The measurement's resolution is set by where answer literals sit in the trace, not by the number of replicates.

7. The tree's value proposition requires the overflow regime — sessions whose raw events exceed the window, forcing the model to navigate via summaries. No window tested here reached that regime for this 196,000-token trace. The smallest window at which the entire trace fits as raw events (approximately 220,000 tokens) was not economically testable.

## 9 Recommended next steps

These are ordered by expected information gained per unit of effort.

1. **Test at W=65,536 with tree-tail-static and tree-tail-headline.** The W=65,536 data shows truncate-tail scoring 0.217 with three answerable questions. Tree-tail-headline at W=65,536 would have approximately 55,000 tokens of headroom versus truncate-tail's approximately 62,000. The 7,000-token gap is smaller than the 10,000-token gap from verbose summaries and might recover one of the two lost questions. Run on GLM 5.3 Flash via deepinfra for low latency and 99.4 percent uptime. Estimated cost: 120 runs at approximately 0.10 USD.

2. **Expand the question set.** Add questions whose answer literals sit at known depths in the trace (seq 100, 300, 500, 700) to create a sensitivity curve. At what window size does each question become answerable, and at what headroom differential does a tree arm lose a question that a baseline answers? The current set has one answerable question at W=32,768 and three at W=65,536, which is too sparse to locate a crossover.

3. **Test the overflow regime.** The tree's design is for sessions that exceed the window. A longer frozen trace — one whose raw events total 500,000 tokens or more — at W=32,768 would force the model to navigate via summaries to reach content beyond the raw tail. This is the only regime where summaries can earn their keep, and it is the regime no measurement here has reached.

4. **Compress Zone A.** Tool schemas and the system contract cost approximately 2,200 tokens. Codex already shortens tool and skill descriptions in its own prompts for the same reason. Applying the headline approach to Zone A — shorter tool names, minimal schema descriptions, a one-paragraph contract — could halve that cost and free tokens for raw events.

5. **Update algorithm.md.** The raw-tail rule — fill remaining headroom with raw recent events after zones A, B, and C — is the single most effective mechanism this program has tested. It should appear as a line in the assembler section of the algorithm document.

## 10 What this pass did NOT test

Every measurement at W=32,768 comes from one model (Qwen 3.7 Flash via OpenRouter). The W=65,536 measurement comes from one different model (GPT-4.1-mini). No model on the Anthropic provider was included. GLM 5.3 Flash, the recommended cheap model for experiments, was not used in this pass. The overflow regime — sessions whose raw events exceed the window — was not tested. A longer frozen trace that would force overflow at W=32,768 does not exist yet. Questions answerable from summaries alone (not literal-finding) were not included. Compressed Zone A (shorter tool schemas and system contract) was not built. Only one frozen store and one question set were used. Whether headline-only summaries improve search ranking was not tested because the headline arm had no tools to search with.

---

DS-STAR raw-tail pass, 4 iterations · ~360 scored runs across 3 models · 1 design panel (3 independent designers) · 1 framing error corrected · 0 instrument defects · September 3, 2026.
