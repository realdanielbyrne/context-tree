# Why the tree arm cannot answer questions yet

Context-tree retrieval evaluation · DS-STAR pass, 3 iterations · September 2–3, 2026

## Abstract

Context-tree reorganizes an agent's linear conversation trace into a summary-headed tree so that a long-running session sees branch summaries instead of raw history, pulling detail back on demand through four retrieval tools. We ran three DS-STAR iterations to establish whether the tree arm could answer factual questions about a frozen 754-event session as well as two non-tree baselines that simply truncate the trace to fit the window. It could not. Across roughly 1,200 runs on six models, the tree arm scored effectively zero while the baselines scored 0.083 to 0.138. The mechanism has three links: the summary-based search ranks the correct branch at position 11 to 17 out of 19, so the model always fetches the wrong branch; changing the fetch from summary to raw events does not help because the branch is still wrong; and event-level embeddings cannot reliably find the answer within the correct branch either, passing an offline kill gate on only 4 of 12 questions. The baselines score by brute force — they put raw events in the prompt and the model pattern-matches the answer from what it can see. The path forward is the same mechanism: fill Zone C with raw recent events at large windows, so the tree arm has both summaries for navigation and raw content for answering.

## 1 Terms

A **branch** is a contiguous range of the event log that receives one summary; the frozen store has 21 of them. A **run** is one model attempting one question once. The **tree arm** assembles summaries in Zone B and offers four retrieval tools; the model calls `context_search` to rank branches by summary similarity, then `context_fetch` to read a branch's content. **Truncate-tail** keeps the most recent raw events that fit the window, with no tools. **Compact-rolling** prepends a model-generated summary of the older portion. A **reply mode** controls whether the model receives a `max_tokens` limit: `no-limit` sends none, `fixed-ceiling` uses a window-derived value, and `allowance` computes it from the remaining headroom each turn. The **frozen store** is a real Claude Code session on this repository, 754 events, ingested into 21 branches, with 12 questions in four types: head (early facts), tail (recent facts), deep (code literals), and spanning (facts requiring two places in the trace). **W** is the model's context window.

## 2 What we measured

We ran roughly 1,200 scored runs across three iterations, all against the same frozen store and question set.

**Iteration 1** tested three reply modes (no-limit, fixed-ceiling, allowance) on the tree arm at two windows. The grid covered six models: Qwen 3.7 Flash and GLM 5.3 Flash at W=16,384; GPT-4o-mini, GPT-4.1-mini, GPT-5-mini, and Qwen 2.5 72B at W=32,768. Same-epoch baselines (truncate-tail and compact-rolling) ran alongside each cell. Naive-full precondition runs confirmed context death on every model — the full 196,000-token trace does not fit any tested window.

**Iteration 2** tested three search-and-fetch mechanisms: `tree` (summary search, summary fetch — the legacy behavior), `tree-slice` (summary search, raw-event fetch), and `tree-grep` (raw-content grep, raw-event fetch). These ran on GPT-4.1-mini and GPT-5-mini at W=32,768.

**Iteration 2 kill gate** tested event-level embeddings (`text-embedding-3-small`) offline: for each question, we embedded all raw events within the correct branch and checked whether the answer-bearing event ranked in the top 5 by cosine similarity to the question text.

## 3 Results

### 3.1 Reply mode has no effect (iteration 1)

All three reply modes score effectively zero on the tree arm across all models at W=32,768. The three successes across roughly 300 tree-arm runs are indistinguishable from noise.

| Arm | GPT-4.1-mini | GPT-5 mini | Qwen 72B |
|---|---|---|---|
| truncate-tail (baseline) | 0.083 (5/60) | 0.088 (5/57) | 0.083 (5/60) |
| compact-rolling (baseline) | 0.138 (4/29) | — | 0.100 (6/60) |
| tree (no-limit) | 0.000 (0/39) | 0.000 (0/6) | 0.000 (0/36) |
| tree (fixed-ceiling) | 0.029 (1/34) | 0.000 (0/1) | 0.029 (1/34) |
| tree (allowance) | 0.000 (0/36) | 0.000 (0/5) | 0.027 (1/37) |

Scores are means over completed, scored runs; the parenthetical is successes over scored count. Baselines complete in 1 turn with no tool calls; tree arms use a median of 2 to 3 turns. The reply mode cannot be evaluated because the retrieval floor prevents any reply mode from mattering.

### 3.2 Fetch depth and search mechanism have no effect (iteration 2)

Changing the fetch from summary to raw events (tree-slice) and changing the search from summary-based beam ranking to raw-content grep (tree-grep) both fail to lift the score. The grep arm completes more runs (58 of 60 versus 31 of 38) because its search results are smaller, but it scores the same zero.

| Arm | Mechanism | Score (GPT-4.1-mini) | Completed |
|---|---|---|---|
| tree | summary search → summary fetch | 0.000 (0/38) | 38/44 |
| tree-slice | summary search → raw fetch | 0.000 (0/31) | 31/38 |
| tree-grep | raw content grep → raw fetch | 0.000 (0/58) | 58/60 |
| truncate-tail | no search, raw context | 0.083 (5/60) | 60/60 |

### 3.3 Event-level embeddings fail the kill gate (iteration 2)

We embedded all raw events within each question's correct branch using `text-embedding-3-small` and ranked them by cosine similarity to the question text. The answer-bearing event ranked in the top 5 for only 4 of 12 questions, below the pre-registered threshold of 6. Short, distinctive tokens like `PHASE_TYPES` and `12529` rank well; file paths and natural-language strings rank poorly because many events mention similar text.

| Question | Answer literal | Rank within branch | Verdict |
|---|---|---:|---|
| s1-q09-deep | PHASE_TYPES | 3/53 | pass |
| s1-q12-spanning | 12529 | 3/87 | pass |
| s1-q05-tail | DSA on context tokens | 4/22 | pass |
| s1-q03-head | implements its own minimal tool-use loop | 5/53 | pass |
| s1-q01-head | ../src/trace/index.js | 7/207 | fail |
| s1-q02-head | Read StubProvider and retry... | 8/17 | fail |
| s1-q08-deep | parseThing | 10/17 | fail |
| s1-q04-tail | Sync report to artifact publish path | 65/87 | fail |
| s1-q11-spanning | packages/core/package.json | 54/59 | fail |
| s1-q10-spanning | ../src/render/index.js | 112/207 | fail |
| s1-q06-tail | Callers that cache Zone C... | miss | fail |
| s1-q07-deep | from dedent import dedent\_text | miss | fail |

The kill gate says: do not build event-level vector search (`depth: 'semantic'` on `context_fetch`) at this embedding model. The mechanism cannot discriminate.

### 3.4 The 16k window is a dead cell

At W=16,384 on both Qwen 3.7 Flash and GLM 5.3 Flash, 57 of 60 tree-arm runs stalled regardless of reply mode. The mechanism: Zone A plus Zone B is approximately 5,500 tokens. A single search result, even with summary snippets stripped, adds roughly 10,500 tokens of metadata for 20 hits, reaching 16,000 tokens — negative headroom. The model has no room to act on what the search found. This is a boundary condition: the tree is not useful below approximately 32,000 tokens of context window. Above that threshold, the savings compound quadratically with session length because the tree's prompt stays flat while a baseline's grows with every turn.

## 4 Root cause

The tree arm scores zero because three failures compound.

First, the summary-based search ranks the correct branch poorly. The beam search scores branches by how well their summary matches the query, but the summaries are paraphrases and the questions ask for literals. The self-retrieval gate, which tests whether each question's correct branch appears anywhere in the search results, passes — but only because the retrieval limit of 20 returns nearly all 19 ranked branches. The correct branch sits at rank 11 to 17 for most questions, near the bottom.

Second, the model fetches from the top of the ranking. Across all completed tree-slice runs on GPT-4.1-mini, every single fetch retrieved the wrong branch. The answer literals live in specific events within specific branches, and the model never reaches those branches because the search sent it elsewhere.

Third, the model's search queries cannot compensate. The grep arm demonstrates this: the model queries with paraphrased descriptions like "testing block ids and token counts" when the answer literal is `../src/trace/index.js`. Substring search over raw event content fails for the same reason embedding search fails — the query and the answer live in different semantic neighborhoods.

The baselines score because they avoid the search-and-fetch indirection entirely. Truncate-tail puts the most recent raw events directly in the prompt, and 5 of the 12 answer literals happen to land inside the truncated window. The model reads the answer from what it can see, with no tools.

## 5 Instrument defects found and fixed

This pass discovered four defects in the transplant harness that had contaminated prior measurements.

The first was a turn ceiling of 6, set at `eval/scripts/transplant.mjs:123`. The tree arm typically needs 2 to 5 turns to search and fetch; at 6 turns, 97 percent of runs were stopped by the ceiling rather than by the model finishing. We raised it to 40 and added a stall detector that ends a run after 3 consecutive turns with identical tool-call signatures.

The second was a window-derived reply limit of 819 tokens at W=16,384. Reasoning models (Qwen 3.7 Flash, GLM 5.3 Flash) spent their entire budget on chain-of-thought reasoning and returned empty completions, which were graded as wrong answers. We changed baselines to send no `max_tokens` at all.

The third was a filename collision: all three reply-mode batches wrote to the same output file, so the last to finish overwrote the other two. We added the reply mode to the filename.

The fourth was that each search hit carried a 240-character snippet of the summary text that was already visible in Zone B. At 20 hits this was roughly 4,800 characters of duplicated content, enough to overflow the window at 16,384. We removed the `snippet` field from `SearchHitPayload` in the library. Search now returns coordinates only — node id, title, score, and meta pointers. The summary text is already in the prompt; sending it again is pure waste at any window size.

## 6 What this means for the product

The tree's retrieval architecture assumes the model can navigate from summaries to detail: read a summary, identify which branch is relevant, fetch its content. The evidence says this assumption fails on the current question set because the summaries do not describe the content precisely enough to direct the model to the right branch. The summaries are navigation aids — they say what a branch is about — but they are not precise enough for the model to identify which branch contains a specific literal.

The baselines work because they skip the navigation step. They put raw content where the model can see it and let it find the answer by reading. The tree should do the same. At large windows, Zone C should carry raw recent events alongside the active branch's detail, so the model has both summaries for navigation and raw content for answering. The amount of raw content should scale with available headroom: at W=32,768 that might be 13,000 tokens of the most recent events; at W=200,000 it could be 180,000.

This is not a failure of the tree architecture. The summaries in Zone B still serve their purpose — they compress completed work into a fraction of the original size, which is what makes sessions longer than the window possible at all. The finding is that Zone C needs to carry raw content in addition to the active branch, not instead of it.

## 7 Recommended next steps

These are ordered by expected information gained per unit of effort.

1. **Fill Zone C with raw recent events.** The assembler currently gives Zone C only the active branch's detail. Add a tail window of the most recent raw events, sized to whatever headroom remains after Zone A, Zone B, and the reply reservation. This is the mechanism the baselines use, and it is the only mechanism that has scored above zero on this question set. Zero model calls to implement; 120 runs on a cheap model to measure.

2. **Test at W=128,000 and above.** The tree's value proposition is on large windows where the savings compound. Every measurement in this pass was made at W=32,768 or below, where the overhead is a large fraction of the window. At W=128,000 the same overhead is negligible and the raw-tail mechanism has room for most of the trace. The boundary condition at 16k is documented; the scaling behavior above 32k is not.

3. **Re-run the reply-allowance experiment after the raw tail lands.** The reply-mode comparison was blocked by the retrieval floor. Once the tree arm scores above zero, the three reply modes may produce different scores, especially at the smaller windows where the allowance shrinks and the model must answer concisely.

4. **Investigate a stronger embedding model for within-branch search.** The kill gate failed at `text-embedding-3-small`. A model with better code-awareness (such as one trained on code retrieval) might rank the answer events higher. Run the same offline gate before building anything.

5. **Design a second question set.** The current 12 questions all ask for specific literals. A set that includes questions answerable from summaries (e.g., "what was the purpose of the implementation phase?") would test the navigation mechanism that the tree is designed for, rather than the literal-finding mechanism that it is not.

## 8 What this pass did NOT test

Every measurement here comes from one frozen store (754 events, 21 branches) and one question set (12 questions in four types). No window above 32,768 was scored. No model on the Anthropic provider was included — all runs went through OpenRouter. No scenario other than `s1` was used. The 16k boundary condition was found but not retested after the snippet-removal fix. The raw-tail mechanism described in the recommendations does not exist yet and has not been measured. A stronger embedding model was not tested for the kill gate. The question set tests only literal-finding; questions answerable from summaries alone were not included.

---

DS-STAR pass, 3 iterations · ~1,200 scored runs across 6 models · 4 instrument defects found and fixed · 1 kill gate run (~$0.003 in embedding tokens) · September 2–3, 2026.
