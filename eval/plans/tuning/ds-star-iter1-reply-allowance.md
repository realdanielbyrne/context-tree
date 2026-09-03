# DS-STAR Iteration 1 — Reply Allowance Experiment

Context-tree evaluation · Mode 1 improvement loop · September 2, 2026

## Verdict

**Null result.** The reply-allowance candidate cannot be evaluated because the
retrieval floor prevents any reply mode from mattering. All three reply modes
score effectively zero across three models, two windows, and ~960 runs. The
baselines score 0.083–0.138 without using tools at all.

Route: **journal the finding, do not land any reply-mode change, move to
iteration 2 targeting the fetch mechanism** — specifically, summaries should
locate the branch, then raw events should provide the answer.

## What we set out to test

Whether `replyAllowance` — a per-turn reply limit computed from the window
minus the assembled prompt — produces equal-or-better graded scores at
equal-or-fewer tokens than a fixed ceiling derived from the window, across
models and windows. The three arms were `no-limit` (no `max_tokens` sent),
`fixed-ceiling` (window-derived `maxReplyTokens`), and `allowance`
(`BudgetReport.replyAllowance` passed as `max_tokens`).

## What we actually measured

963 runs across the following grid, all same-epoch, same code, same frozen
store (s1, 754 events, 12 questions, 5 replicates per cell):

| Model | Gen | $/M in | W | Arms |
|---|---|---:|---:|---|
| qwen/qwen3.7-flash | 2025 | $0.03 | 16,384 | tree ×3 modes + baselines |
| z-ai/glm-5.3-flash | 2025 | $0.075 | 16,384 | tree ×3 modes + baselines |
| openai/gpt-4o-mini | 2024 | $0.15 | 32,768 | tree ×3 modes + baselines |
| openai/gpt-4.1-mini | 2025 | $0.40 | 32,768 | tree ×3 modes + baselines |
| openai/gpt-5-mini | 2025 | $0.25 | 32,768 | tree ×3 modes + baselines |
| qwen/qwen-2.5-72b-instruct | 2024 | $0.36 | 32,768 | tree ×3 modes + baselines |

Naive-full precondition runs confirmed context death on all three W=32,768
models (HTTP 400 or empty response when the full 196k trace is sent).

## Results at W=32,768 (the cell where the tree arm can operate)

| Arm | GPT-4.1-mini | GPT-5 mini | Qwen 72B |
|---|---|---|---|
| truncate-tail | 0.083 (5/60) | 0.088 (5/57) | 0.083 (5/60) |
| compact-rolling | 0.138 (4/29) | — | 0.100 (6/60) |
| tree (no-limit) | 0.000 (0/39) | 0.000 (0/6) | 0.000 (0/36) |
| tree (fixed-ceiling) | 0.029 (1/34) | 0.000 (0/1) | 0.029 (1/34) |
| tree (allowance) | 0.000 (0/36) | 0.000 (0/5) | 0.027 (1/37) |

Scores are means over completed, scored runs. Parenthetical is successes
over scored count. Baselines complete in 1 turn with no tool calls. Tree
arms use 2–3 turns median. The 3 tree successes across ~300 runs are
indistinguishable from noise.

## Results at W=16,384 (dead cell — boundary condition)

At W=16,384 on both Qwen 3.7 Flash and GLM 5.3 Flash, 57 of 60 tree-arm
runs stalled regardless of reply mode. The mechanism: Zone A + Zone B is
~5,500 tokens, and a single search result (even with snippets stripped) adds
~10,500 tokens, reaching 16,000 — negative headroom. The model has no room
to act on search results. This is a boundary condition: the tree is not
useful below approximately 32,768 tokens of context window.

## Three instrument defects found and fixed

1. **MAX_TURNS = 6 fabricated 97% of "failures."** The transplant harness's
   6-turn ceiling stopped runs that were actively using tools. Raised to 40
   with a stall detector (3 consecutive turns with identical tool-call
   signatures → status `stalled`).

2. **`maxReplyTokens` crashed reasoning models.** At W=16,384, `maxReplyTokens`
   is 819 tokens. Reasoning models (Qwen 3.7 Flash, GLM 5.3 Flash) spent
   their entire budget on chain-of-thought and returned empty completions
   (`finish_reason=length`, `reasoning_tokens=819`). Fix: baselines now use
   `no-limit` (no `max_tokens` sent).

3. **Three reply-mode files overwrote each other.** The result filename did
   not encode the reply mode. The last batch to finish won; the other two
   were lost. Fix: `--reply-mode` value is now part of the filename.

4. **Search results duplicated Zone B content.** Each search hit carried a
   240-character `snippet` of the summary text that was already visible in
   the prompt's Zone B. At 20 hits, this was ~4,800 characters of pure
   duplication — enough to overflow the window at 16k. Fix: removed `snippet`
   from `SearchHitPayload` in the library (`packages/mcp/src/tools/
   context-search.ts`). Search now returns coordinates only (node id, title,
   score, meta pointers). The algorithm document records this as a rule:
   search never returns summary text, because it is already in the prompt.

## Why the tree arm scores zero — the mechanism

The twelve questions ask for specific facts from the frozen session: a
function name, a commit hash, an error message, a configuration value. None
of these answer literals appears in any of the twenty-one branch summaries.
The summarizer paraphrases; the question asks for a literal.

The model's behavior follows from this: it calls `context_search`, gets
back coordinates pointing to branches whose summaries it can already read in
Zone B, sees nothing useful, searches again with a different query, and
stalls. On the runs that do fetch, the fetch returns the summary (the
default depth), which also lacks the literal. The model never reaches the
raw events where the answer lives.

The baselines score 0.083 because truncate-tail keeps the most recent raw
events in the prompt. Five of the twelve questions ask about recent facts,
and those five sometimes land inside the truncated window. No search, no
fetch, no tools — just raw context that happens to contain the literal.

## The candidate for iteration 2

Summaries should locate the branch. Raw events should provide the answer.

The current `context_fetch` defaults to `depth: 'summary'`, which returns
the same paraphrase the model already has. The candidate changes the default
to `depth: 'full'`, which replays the branch's raw L0 events through L2.
That is where the literals live.

A stronger version of this idea: use the summary to identify which branch
is relevant (which `context_search` already does), then use vector
similarity over the raw events within that branch to return the specific
events containing the answer. This is a two-stage retrieval — the summary
is the coarse filter, the embedding is the fine filter — and it means the
model never needs to read an entire branch, only the events most similar
to its query.

The pieces for this exist:
- `context_fetch` already supports `depth: 'full'` and `depth: 'index'`
- `from`/`to` sequence ranges narrow a full fetch to a slice
- The embeddings client is implemented (`packages/core/src/models/embeddings.ts`)
- `TreeRetriever.searchSummaries` already does collapsed-tree knn over summaries
- The same knn machinery could rank raw events within a branch

What does not exist: an event-level embedding index (L3 indexes summaries,
not raw events), or a fetch mode that returns "the k events most similar to
this query within this branch."

## Pre-registered criteria and their outcomes

| Criterion | Outcome |
|---|---|
| Allowance mean score ≥ fixed-ceiling at every decile | **Cannot evaluate** — both arms score ~0 |
| Allowance completes ≥ fixed-ceiling runs | Allowance: 36–37 completed vs fixed-ceiling: 1–34. Allowance completes MORE (fixed-ceiling crashes reasoning models). But scores are 0 either way. |
| Median run tokens for allowance ≤ fixed-ceiling baseline | Allowance: 21,614–52,368 vs fixed-ceiling: 19,472–63,623. Mixed, and neither meaningful at score 0. |
| stopReason 'length' share rises while score falls → retire | Cannot evaluate — score is 0 everywhere. |

## Files modified this iteration

| File | Change |
|---|---|
| `eval/scripts/transplant.mjs` | MAX_TURNS 6→40; stall detector; reply-mode filename tag; search-coordinate stripping; baseline no-limit; G1 gate updated |
| `packages/mcp/src/tools/context-search.ts` | Removed `snippet` from `SearchHitPayload`; updated tool description |
| `packages/mcp/test/mcp.test.ts` | Updated R8 test to assert no snippet |
| `packages/core/src/models/cost.ts` | Added gpt-4o-mini, gpt-4.1-mini, gpt-5-mini, claude-sonnet-4 pricing |
| `reports/algorithm.md` | Added search-as-coordinates rule; 16k boundary condition |

## What this iteration did NOT test

- The W=16,384 cell with the snippet-removal fix (v4 batches still running)
- Any model on the Anthropic provider (all runs went through OpenRouter)
- The `depth: 'full'` fetch default change (iteration 2's candidate)
- Event-level embeddings for within-branch retrieval
- Any scenario other than s1 (one trace, 754 events, 12 questions)
- Any window above 32,768

---

## DS-STAR Iteration 2 Addendum — Search Ranking and Fetch Depth

### Verdict

**The retrieval floor is caused by search ranking, not fetch depth.** The correct
branch ranks 11–17 out of 19 in the beam search. The model fetches from the top
of the ranking, which is the wrong branch. Whether the fetch returns raw events
(tree-slice, tree-grep) or summaries (tree), the wrong branch doesn't contain
the answer. Zero scores across all three search mechanisms:

| Arm | Mechanism | Score | Completion |
|---|---|---|---|
| tree | summary search → summary fetch | 0.000 (0/38) | 38/44 |
| tree-slice | summary search → raw fetch | 0.000 (0/31) | 31/38 |
| tree-grep | raw content grep → raw fetch | 0.000 (0/58) | 58/60 |
| truncate-tail (baseline) | no search, raw context | 0.083 (5/60) | 60/60 |

### Root cause chain

1. Summary-based search (beam or vector) ranks branches by how well their
   summary matches the query. The summaries are paraphrases; the questions ask
   for literals. The correct branch ranks 11–17 out of 19 for most questions.

2. The model fetches from the top-ranked results — always the wrong branch.

3. The grep arm (tree-grep) doesn't help because the model's search query
   contains paraphrased descriptions ("testing block ids and token counts"),
   not the literal it's looking for ("../src/trace/index.js"). You can't
   grep for what you don't know.

4. The baselines score 0.083 by brute force: put raw content in the prompt,
   let the model pattern-match the answer from what it can see.

### What this means for the product

The tree needs to put raw content where the model can see it, not hide it
behind a search→fetch indirection that ranks poorly. Two paths:

1. **Larger Zone C with raw recent events** — at larger windows, fill Zone C
   with as many recent raw events as the headroom allows. This is what the
   baselines do, and it's why they score.

2. **Event-level vector search within a branch** — after the summary locates a
   candidate branch, embed the raw events within it and knn to find the events
   most similar to the query. This is the user's two-stage idea and would work
   even when the model's query is a paraphrase, because embedding similarity
   handles paraphrase-to-literal matching better than substring grep.

Option 2 is the real fix. Option 1 is the fallback that works today.

---

## DS-STAR Iteration 2 Kill Gate 2 — Event-Level Embedding Ranking

### Result: GATE FAILS (4/12, threshold was 6/12)

Ran `text-embedding-3-small` over the raw events in each question's target
branch, searched with the question text, and checked whether the answer-bearing
event ranked in top-5. Cost: ~142k embedding tokens (~$0.003).

| Question | Answer literal | Rank in branch | Branch size | Verdict |
|---|---|---:|---:|---|
| s1-q03-head | "implements its own minimal tool-use loop" | 5/53 | 53 events | PASS |
| s1-q05-tail | "DSA on context tokens" | 4/22 | 22 events | PASS |
| s1-q09-deep | "PHASE_TYPES" | 3/53 | 53 events | PASS |
| s1-q12-spanning | "12529" | 3/87 | 87 events | PASS |
| s1-q01-head | "../src/trace/index.js" | 7/207 | 207 events | FAIL |
| s1-q02-head | "Read StubProvider and retry..." | 8/17 | 17 events | FAIL |
| s1-q08-deep | "parseThing" | 10/17 | 17 events | FAIL |
| s1-q04-tail | "Sync report to artifact publish path" | 65/87 | 87 events | FAIL |
| s1-q10-spanning | "../src/render/index.js" | 112/207 | 207 events | FAIL |
| s1-q11-spanning | "packages/core/package.json" | 54/59 | 59 events | FAIL |
| s1-q06-tail | "Callers that cache Zone C..." | MISS/22 | 22 events | FAIL |
| s1-q07-deep | "from dedent import dedent_text" | MISS/207 | 207 events | FAIL |

### What passes and what doesn't

Short, distinctive tokens (PHASE_TYPES, 12529, "DSA on context tokens") rank
well because the embedding model can match the query's semantics to the event
containing the term. File paths and long natural-language strings rank poorly
because many events mention similar paths or similar phrases. Two events are
MISS — the answer literal is in a different event than the `answerSeqs` map
predicted, likely across a branch boundary.

### Consequence

**Design A (event-level vector search within a branch) is dead at this
embedding model.** Building `depth: 'semantic'` on `context_fetch` would not
lift the score. A stronger embedding model might change this, but the gate
says not to build until that is proven offline.

The remaining path is larger Zone C with raw recent events — the brute-force
approach the baselines already use. At large windows (128k+) the tree arm
should carry both: summaries in Zone B for navigation, raw events in Zone C
for answering. That is what the algorithm's Zone C was always supposed to be.
