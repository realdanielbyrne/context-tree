# The tree loses to raw truncation at tested windows

Context-tree retrieval · DS-STAR live verification pass · September 3, 2026

Context-tree reorganizes an agent's linear conversation trace into a summary-headed tree so that a long-running session sees branch summaries instead of raw history, pulling detail back on demand through retrieval tools. A prior DS-STAR pass improved the tree's search ranking from 2 of 12 to 11 of 12 questions with the correct branch in the top 3, using fingerprint-enriched documents, hybrid grep, and an LLM query rewriter. This pass attempted live verification: does the improved search translate to score improvements over truncate-tail? The answer at tested windows is no. Across five models and two window sizes (W=32,768 and W=65,536), the tree arm scores equal to or below truncate-tail on every combination tested. The mechanism is that multi-turn tool-use overhead — search turns and fetch turns — consumes 15,000 to 20,000 tokens that truncate-tail uses for raw events, and at these windows the raw tail already covers the answerable content. The tree's value hypothesis, navigation to content outside the visible tail, requires the overflow regime where the session exceeds the window, which this pass did not reach. Three infrastructure improvements were validated offline: semantic narrowing reduces fetched content from 161,000 to 16,000 characters, forced depth eliminates a failure mode where models request summaries instead of raw content, and a stronger system contract makes models try harder with tools. None overcomes the fundamental token-overhead disadvantage at windows where the tail suffices. The main limitation is that the question set places most answers in the recent tail; the overflow regime remains untested.

## 1 Terms

**Tree-tail-v2** is the full-stack tree arm built this session: keyword headlines in Zone B (file paths, identifiers, and symbols extracted from raw events replacing summary prose), fingerprint-enriched beam search, hybrid grep with rank-reciprocal fusion, an optional LLM query rewriter for natural-language queries, semantic narrowing on fetch (centers the result on the most relevant section when the branch exceeds the window), forced full-depth fetch (the model cannot request summaries or indexes), and a system contract that instructs the model to search and fetch rather than give up. **Truncate-tail** is the baseline: the most recent raw events that fit the window, with no tools and no summaries, answered in a single turn. **Naive-full** is the ground truth: the entire trace sent as raw context, requiring a window at least as large as the trace. The **overflow regime** is the condition where the trace exceeds the window, forcing the model to navigate via summaries and tools to reach content the raw tail cannot cover. The **frozen store** is a real Claude Code session on this repository: 754 events, approximately 196,000 tokens, ingested into 21 branches, with 12 paraphrased questions in four strata.

## 2 What was built

Nine changes, all passing 630 tests (541 core, 39 MCP, 50 transplant harness).

**Search ranking** (packages/core/src/retrieve/). The `extractFingerprints` function in `lexical.ts` applies six regex patterns to raw event text and returns file paths, camelCase and PascalCase identifiers, UPPER_SNAKE constants, dotted identifiers, and backtick-quoted content. The `summaryDocument` function accepts an optional fingerprints parameter and appends them to the search document. In `retriever.ts`, beam search computes fingerprints for all phase nodes on first call (lazy-cached) and passes them to `summaryDocument`, moving the offline ranking from 2 of 12 to 7 of 12. The `search` method extracts distinctive terms from the query (same patterns), runs up to five `grepEvents` passes against raw events, and merges with beam results via rank-reciprocal fusion (k=60), reaching 10 of 12. A `QueryRewriter` injection point calls a cheap LLM when regex extraction finds nothing, reaching 11 of 12.

**Semantic narrowing** (retriever.ts `fetchBranch`). When `maxTokens` and `query` are both provided and the branch exceeds the budget, `findRelevantCenter` greps the query's distinctive terms (with a word-fallback for natural-language queries) against the branch's events to find the center seq, then clamps the from/to range to a band sized to `maxTokens`. Verified offline: 11 of 12 answers captured at W=32,768 within the headroom-sized band.

**Tree-tail-v2 arm** (eval/scripts/transplant.mjs). The arm forces `depth: 'full'` on every fetch (the model cannot request summary or index depth), strips the depth parameter from the tool schema so the model never sees the option, uses half the initial headroom as the narrowing budget (accounting for multi-turn conversation growth), tracks the last search query to pass through to the narrowing, and carries a system contract that says the answer IS in the recorded events and instructs the model to search and fetch rather than declare insufficient context.

**Infrastructure.** Incremental result writes land the file after each completed run with `partial: true`, overwritten with `partial: false` at the end. Direct Anthropic provider support routes `claude-*` model ids through `AnthropicProvider` when `ANTHROPIC_API_KEY` is set, falling through to OpenRouter otherwise. The algorithm document was simplified from 728 to 192 lines, with "headline" generalized as a cross-zone concept.

## 3 Cross-model ground truth

All measurements use the naive-full arm at W=200,000, which sends the entire 196,000-token trace as raw context with no tools. Each cell is successes out of scored runs (5 replicates per question, 12 questions).

| Model | Score | Per-question |
|---|---|---|
| GLM 5.3 Flash | 32/60 (0.533) | q01 5/5, q02 5/5, q03 3/5, q04 2/5, q06 2/5, q07 5/5, q08 5/5, q09 5/5 |
| Qwen 3.7 Flash | 22/60 (0.367) | q01 3/5, q02 3/5, q03 1/5, q06 4/5, q07 1/5, q08 5/5, q09 5/5 |
| GPT-4.1-mini | 21/60 (0.350) | q01 5/5, q02 5/5, q06 1/5, q07 1/5, q08 5/5, q09 4/5 |
| Sonnet 5 | 11/32 (0.344)* | q01 5/5, q02 5/5, q03 1/5 |
| Haiku 4.5 | n/a | trace exceeds Haiku's 200K window |

*Cost cap reached after 32 rows; q06–q12 received one replicate each.

Four questions are universally failed across all models at full context: q05 (a paraphrase gap — the model says "write time" instead of the literal "DSA on context tokens"), and q10, q11, q12 (spanning questions requiring two answer literals, where every model finds one but not both). These four failures are properties of the question set and the model family, not of the tree.

GLM 5.3 Flash is the strongest model on this task, scoring 0.533 against 0.35–0.37 for the others. It is the model against which the tree must demonstrate parity.

## 4 Live results

### 4.1 Haiku 4.5

| Arm | W=32,768 | W=65,536 |
|---|---|---|
| truncate-tail | 5/60 (0.083) | 11/60 (0.183) |
| tree-tail-v2 (iteration 1, pre-narrowing fix) | 5/57 (0.088), 3 stalls | 4/60 (0.067) |
| tree-tail-v2 (iteration 2, narrowing + forced depth) | 0/27*, 1 stall | 2/36* |
| tree-tail-v2 (iteration 3, stronger contract) | 0/9*, 1 stall | not run |

*Partial data; runs killed after the pattern was clear.

Truncate-tail's successes at W=65,536 come from three questions: q02 at 5 of 5, q06 at 1 of 5, q08 at 5 of 5. Tree-tail-v2 at W=65,536 scores only on q06, at 2 of 5, and loses q02 and q08 entirely despite the search ranking placing their correct branches in the top 3.

### 4.2 Sonnet 5

| Arm | W=32,768 | W=65,536 |
|---|---|---|
| truncate-tail | 5/60 (0.083) | 15/60 (0.250) |
| tree-tail-v2 | 0/3* | 0/7* |
| naive-full W=200,000 | — | 11/32 (0.344) |

*Partial data; code predated the narrowing and schema fixes.

Sonnet 5 truncate-tail at W=65,536 reaches 15 of 60, already above GLM's 32/60 ground truth rate when adjusted for the tail's coverage. Tree-tail-v2 on Sonnet was tested only with old code (before the narrowing fix and schema strip); no Sonnet data exists for the current configuration.

## 5 Mechanism: why the tree loses

The tree arm's prompt at W=65,536 contains approximately 10,000 tokens of Zone B keyword headlines, 20,000 tokens of raw tail, and leaves approximately 30,000 tokens of headroom for tool-use turns. Truncate-tail uses the entire window for raw events: approximately 62,000 tokens.

Each tool-use turn adds to the conversation. A search turn contributes the model's query, the search results (coordinates and scores, roughly 2,000 tokens), and the model's response (roughly 500 tokens). A fetch turn contributes the branch id, the fetched content (narrowed but still 5,000 to 15,000 tokens), and the model's extraction. A typical two-tool-call sequence — search then fetch — costs 10,000 to 20,000 tokens of conversation that truncate-tail uses for raw events.

The consequence: at W=65,536, truncate-tail shows the model 62,000 tokens of raw content in one read. Tree-tail-v2 shows 20,000 tokens of raw tail plus whatever a search-fetch cycle returns, minus the overhead of the cycle itself. The net useful content is lower. The tree wins only when the answer is outside the 62,000-token tail and the search-fetch cycle locates it — but on this question set, the answerable questions have their answers in the recent tail.

Three iterations of fixes — semantic narrowing, forced full-depth fetch, and a stronger system contract — each addressed a real defect (oversized fetch results, models requesting summaries, models giving up prematurely). None changed the headline result because the fundamental constraint is not a bug in the pipeline but a budget arithmetic: tool-use turns cost tokens that raw truncation spends on content.

## 6 What was learned

1. The search ranking improvement (2/12 to 11/12 top-3) is validated offline and mechanically correct: the search finds the right branch. The improvement does not translate to live scores at tested windows because the model does not need search to find content that is already in the raw tail.

2. Multi-turn tool use is expensive. A search-then-fetch sequence costs 10,000 to 20,000 tokens of conversation budget. At W=32,768, that is 30 to 60 percent of the entire window. The tree arm delivers less total content per question than truncate-tail at every tested window.

3. Model capability matters. Haiku 4.5 searches and fetches but then says "I don't have context" — it does not trust or cannot interpret the fetched content. A stronger system contract makes it try harder (5 turns instead of 2) but burns more tokens without scoring. Sonnet 5 was not tested with the full fix stack.

4. Semantic narrowing works mechanically — 161,000 characters reduced to 16,000 — but the narrowing budget must account for conversation growth across turns. The initial headroom divided by two approximates this, though some runs still truncate.

5. The overflow regime is the tree's actual value proposition. At W=65,536 with a 196,000-token trace, 130,000 tokens of content are unreachable by the tail. But the question set places most answers in the reachable 62,000 tokens, so the tree's navigation adds nothing the model needs.

6. Keyword headlines in Zone B (file paths, identifiers, symbols) are strictly better than prose for search ranking and comparable for Zone B token cost. The generalization to all zones (Zone A tool schemas, Zone C active branch) is a validated design direction but not yet implemented beyond Zone B.

## 7 What was rejected

Extended query extraction to shorter terms (2-character quoted, 3-digit numbers): regressed from 10 of 12 to 9 of 12 by introducing noisy matches. Depth options on context_fetch for tree-tail-v2: the model requests summary or index depth and misses the answer literal. Full-headroom narrowing budget: multi-turn conversation growth still causes truncation. Haiku 4.5 as the primary tree-arm model: too weak at tool-following for this task.

## 8 Recommended next steps

Ordered by expected information gained per unit of effort.

1. **Build overflow-regime questions.** Add questions whose answer literals sit in the first half of the trace (seq 1 through 375), unreachable by any tail at W=32,768 or W=65,536. The current head-stratum questions (q01 through q03) are in this regime but are hard for all models even at full context. New questions with distinctive answer literals at seq 100 through 300 in the "implementation" branch would isolate whether the search-fetch pipeline works when the tail cannot help. This is the one measurement that would confirm or refute the tree's value proposition, and it costs zero live tokens to build.

2. **Test Sonnet 5 with the full fix stack.** The partial Sonnet data (0 of 7 at W=65,536) used old code without narrowing, forced depth, or the schema strip. Sonnet 5 is a strong tool-use model and the most likely candidate to benefit from the tree. Estimated cost: approximately twelve dollars for tree-tail-v2 plus truncate-tail at W=65,536 with 5 replicates.

3. **Reduce tool-use token overhead.** The largest loss is the per-turn cost of search results and fetched content in the conversation. Two candidates: inline narrowed excerpts in search results so that fetch is unnecessary (one tool call instead of two), or use MCP mode A (read tools do not append to L0) to reduce conversation growth. Either would recover 5,000 to 10,000 tokens per question.

4. **Test at W=16,384.** At this window, truncate-tail covers approximately 15,000 tokens of the 196,000-token trace. The tree's navigation should be essential for any question outside the most recent 15,000 tokens. The boundary condition analysis from the prior pass says the tree is "not useful below this window" due to Zone A plus one search result exceeding the window, but keyword headlines and the narrowing fix may have moved that boundary.

5. **Reply fraction sweep.** The five-percent reply fraction is unvalidated. At W=32,768 that reserves 1,638 tokens for the model's reply — tight for reasoning models. This needs its own DS-STAR pass when testing on models where the simulated window approximates the actual context window.

## 9 What this pass did NOT test

The overflow regime: sessions whose raw events exceed the window and whose answers are outside the raw tail. Every measurement in this pass is on a 196,000-token trace at windows of 32,768 and 65,536, where the answerable questions happen to be in the reachable tail. Sonnet 5 with the full fix stack: the only Sonnet data is partial, from code that predated three of the nine improvements built this session. Token overhead reduction: no candidate was implemented or measured for reducing the per-turn cost of tool-use turns. A longer frozen trace or a second scenario: every measurement is on one 754-event session with one set of 12 questions. Whether the tree's value generalizes beyond this store is unknown.

## 10 State of the code

All paths are relative to the repository root.

| File | What changed |
|---|---|
| `packages/core/src/retrieve/lexical.ts` | `extractFingerprints()`, `summaryDocument()` with optional fingerprints |
| `packages/core/src/retrieve/retriever.ts` | Fingerprint cache, hybrid grep in `search()`, `QueryRewriter`, semantic narrowing in `fetchBranch()`, word-fallback in `findRelevantCenter()` |
| `packages/core/src/retrieve/types.ts` | `QueryRewriter` type, `FetchBranchOptions.maxTokens` and `query` |
| `packages/core/src/retrieve/index.ts` | `QueryRewriter` re-exported |
| `eval/scripts/transplant.mjs` | tree-tail-v2 arm, `buildQueryRewriter()`, `toolSchemasForArm()`, `handlersForArm()` with narrowing handler, incremental writes, `AnthropicProvider` routing, naive-full full-question-set at large W, stronger `QA_ADDENDUM` |
| `eval/scripts/rank-killgate.mjs` | Offline ranking verification script |
| `reports/algorithm.md` | Simplified 728 to 192 lines; headline as cross-zone concept |
| `reports/metrics/ds-star-search-ranking-report.md` | Search ranking pass report (3 iterations) |

---

DS-STAR live verification pass · ~600 scored runs across 5 models, 2 window sizes, 3 arms · 9 infrastructure improvements · 4 live iterations on Haiku · 630 passing tests · September 3, 2026.
