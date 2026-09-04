# Plan: published-alternative arm and ablation ladder

Stance A planner. All numbers offline; zero LLM calls in this plan.

## 1. CANDIDATES

### C1. `tree-fable-composite` — full Fable interface comparison arm

**The change.** Replace the context-tree retrieval surface wholesale with Anthropic's production interface: `conversation_search` (default 5, max 10 hits, prose snippet per hit, `page_token` addressing), `read_conversation` (opens AT the hit, fixed 20-event window, bidirectional paging), and the behavioral contract (content-noun queries, one or two opens per question, page only when the answer is visibly cut off). Four entangled variables in one arm; the ablation ladder below isolates each.

**Bucket and baseline.** Delivery (payload bytes arriving at the model). At W=65,536: tree-tail-v2 delivered 1/25, tree-center-filename 4/25, truncate-tail 0/25. The composite targets the delivery mechanism: fewer, smaller search hits free headroom; the page_token opens the read at the match instead of re-centering; the behavioral cap stops the 5-8 turn thrashing loop. Selection is 4/5 rank-1 on the deep set already — not the binding constraint.

**Arm name.** `tree-fable-composite`. **n = 5** per question, 5 questions (deep set), at effective W = 130,000 (harness `--window 130000`; the 70k pad is modeled by reducing W, not by injecting text — see Mechanism). At W=65,536 this arm is not run: headroom is mechanically insufficient for any tool arm (prior finding, confirmed by A2 §2). **Kill criterion (zero live tokens).** (K1) Offline: `coordinateSearchData` → Fable-format mapper produces valid `{snippet, page_token}` hits for all 5 deep questions; snippet present after the strip bypass. (K2) Offline: page_token round-trip (encode seq → decode → `fetchBranch` from that seq returns events). **Win criterion.** Score > 4/25 on the deep set at effective W=130k; AND mean delivered bytes per fetch > 0 (vs 0 on 77/88 fetches at W=65k). Stratified: per-question score and per-question mean delivered tokens recorded.

### C2. `tree-k5` — hit count reduction (isolates one variable)

**The change.** Set search result limit to 5 (Fable's default) on the existing `tree-search-coordinates` arm. Everything else unchanged: coordinate projection, context-tree contract, token-budget fetch band.

**Bucket and baseline.** Delivery. At W=65,536 the 20-hit coordinate response cost 1,194-1,402 tokens (centering report §4, readiness JSON NC23). At 5 hits the estimate is ~350 tokens — freeing ~1,000 tokens of headroom per search call. At effective W=130k the headroom is ~18k (A2 §2), so the hit-count effect is proportionally smaller but still compounds across multiple search turns.

**Arm name.** `tree-k5`. **n = 5**, 5 questions (deep set), effective W = 130,000. **Kill criterion.** (K3) Offline: 5-hit coordinate response token count < 600 tokens on all 5 deep-set queries (measured by the existing tokenizer on the frozen store). **Win criterion.** Score >= tree-search-coordinates score at the same W and epoch; delivered bytes per fetch strictly greater than tree-search-coordinates. This arm's purpose is to measure the headroom effect of hit count alone, so a tie on score but improvement on delivery bytes is informative.

### C3. `tree-k5-snippet` — snippet in hit (isolates one variable vs C2)

**The change.** Add a 200-character prose excerpt to each of the 5 coordinate hits. The snippet is the raw text around the search match center, already computed by the retriever (`context-search.ts:123` produces `hit.text.slice`), stripped at `transplant.mjs:4045-4052`. This arm skips that strip.

**Bucket and baseline.** Selection (the model's choice of which hit to open). At W=65,536 the correct branch rendered as the bare word "diagnosis" and the model picked a distractor 5/5. tree-hit-keywords (structured fingerprints in hits) was refuted: 18/25 vs 18/25, +32% tokens. Anthropic's snippet differs: natural prose, not keyword lists, and at 5 hits rather than 20. The cost delta is small: 5 hits x 200 chars ~ 250 tokens above the coordinate baseline.

**Arm name.** `tree-k5-snippet`. **n = 5**, 5 questions (deep set), effective W = 130,000. **Kill criterion.** (K4) Offline: snippet text present in the model's prompt for all 5 questions (assert snippet field survives the strip bypass at 4045-4052). Total search response < 1,200 tokens (5 coordinate hits + 5 snippets). **Win criterion.** Selection accuracy (fraction of first fetches targeting the correct branch) > tree-k5's selection accuracy at the same epoch. If selection is unchanged (as with tree-hit-keywords), the snippet hypothesis is refuted for this question set regardless of prose vs keywords.

## 2. ORDER

1. **C2 (`tree-k5`)** first. Lowest implementation effort (one config override), highest expected information gain per token. It directly tests the A2 finding that headroom is the binding constraint. If 5 hits at W=130k still score 0, the problem is not hit count and we save the cost of C3/C1.

2. **C3 (`tree-k5-snippet`)** second. Adds one variable (snippet) to C2's base. Runs only if C2 delivers nonzero bytes on at least 3/5 questions — otherwise the snippet's selection effect cannot be measured because nothing is delivered regardless.

3. **C1 (`tree-fable-composite`)** third. The composite arm is the comparison target; the ablation ladder (C2, C3, and the read-events toggle inside C1 vs C2+C3) isolates what drives the difference. Running it last means every intermediate step has a same-epoch baseline. The remaining variable C1 adds beyond C2+C3 is the fetch unit (fixed 20 events vs token-budget band) plus the behavioral contract. If C2+C3 already match C1's score, the behavioral contract and fixed-event read add nothing measurable.

**Each batch includes `truncate-tail` at the same W and epoch as the equal-n same-epoch baseline.** naive-full at W=200k scores 25/25 on the deep set (verified: `run-W200000-naive-full-questions-deep-z-ai_glm-5.3-flash.json`). At effective W=130k naive-full cannot fit (trace is 196k tokens; A2 §4), so truncate-tail is the comparison baseline. 

## 3. MECHANISM

**C2 (`tree-k5`).** The retriever already accepts a `limit` parameter (`ctx.config.retrieval.limit`, read at `transplant.mjs:1596`). Override it to 5 for this arm. The mechanism fires when the search response contains exactly 5 hits instead of the current 8-20. The row records: `searchHitCount` (must be 5), `searchResponseTokens` (measured), `appendHeadroom` at the fetch turn (must exceed the tree-search-coordinates arm's value by the token difference). The headroom gain translates to a wider centering band in `fetchBranch` (retriever.ts:381-391), which is recorded as `bandWidthTokens` and `answerLiteralPresent`.

**C3 (`tree-k5-snippet`).** The strip at `transplant.mjs:4045-4052` is bypassed for this arm (conditional on arm name threaded into the `built` object). The snippet field on each hit survives into the model's prompt. The mechanism fires when the model's first `context_fetch` call targets the correct branch. The row records: `snippetCharsTotal` (sum of snippet lengths), `firstFetchTargetCorrect` (boolean), `selectionAccuracy` (fraction of fetches targeting the answer branch). Compared against C2 where the snippet is absent.

**C1 (`tree-fable-composite`).** Four mechanisms fire together. (a) Hit count = 5 (same as C2). (b) Snippet present (same as C3). (c) `read_conversation` decodes the `page_token` to a seq and reads 20 events forward from that seq — the read opens AT the match, not at the branch start. This bypasses the re-centering problem (qo04: 0/30 deliveries because no query centered the band on seq 218; with a page_token encoding seq 218 the read starts there). (d) The behavioral contract says "open one or two chats, then answer from what you have" — the model stops after 1-2 reads instead of thrashing. The row records all of C2+C3's fields plus: `readStartSeq` (must equal the page_token's encoded seq), `readEventCount` (must be <= 20), `totalReadCalls` (the behavioral cap's effect; expected 1-2 vs 5-8 on the deep set).

**How page_token works.** The handler encodes the search hit's center seq as an opaque base64 token. `read_conversation` decodes it, calls `fetchBranch(branchId, { depth: 'full', from: decodedSeq })`, reads 20 events forward, and returns `next_page_token` (seq of the 20th event + 1) and `prev_page_token` (decodedSeq - 20). The harness's `capToolResult` (4057) still enforces the window cap, which may truncate a 20-event read. This is recorded as `droppedChars` (existing telemetry field).

## 4. COST

All runs on glm-5.3-flash ($0.075/M in, $0.25/M out). Effective W = 130,000.

From A2 §2: tree prompt at effective W=130k is ~105k cl100k input per turn. Tree arms average 4 turns. truncate-tail is 1 turn at ~104k.

| Batch | Arms | Runs | Input tokens | Output tokens | Cost |
|---|---|---:|---:|---:|---:|
| B1: C2 | tree-k5 + truncate-tail | 50 | 13,112,425 | 25,000 | $0.99 |
| B2: C3 | tree-k5-snippet + truncate-tail | 50 | 13,112,425 | 25,000 | $0.99 |
| B3: C1 | tree-fable-composite + truncate-tail | 50 | 13,112,425 | 25,000 | $0.99 |
| **Total** | | **150** | **39,337,275** | **75,000** | **$2.97** |

Per batch: 25 tree runs (5 questions x 5 reps x 4 turns x 105k = 10,500,000 input) + 25 truncate-tail runs (5 questions x 5 reps x 1 turn x 104k = 2,600,000 input) + output (25 runs x 1,000 tokens). The truncate-tail baseline is the same configuration across all three batches, so if B1's truncate-tail epoch matches B2/B3's, it need not be re-run — reducing total cost to ~$2.00.

## 5. WHAT THIS PLAN DOES NOT TEST

- **Window size as an independent variable.** All three candidates run at one regime (effective W=130k). Whether they also improve scores at W=65k or W=200k is not measured. The A2 analysis shows W=65k is a dead cell with a realistic pad; W=200k P=0 decays 4/5 deep questions into the tail. The valid regime for this trace at P=70k is effective W=130k.

- **The behavioral contract in isolation.** C1 entangles the Fable behavioral guidance with the tool surface change. Isolating the contract alone (Fable guidance + context-tree tools) would require a fourth arm not in this plan. If C1 outperforms C2+C3, the residual is the contract + fixed-event read, still entangled.

- **The fixed-event read unit in isolation.** C1 changes the read from token-budget band to 20 events AND opens at the page_token simultaneously. A `tree-k5-snippet-events20` arm (C2 + C3 + fixed-event read, context-tree contract) would isolate the read unit but is not in this plan's three candidates. It is the natural fourth rung if C1 > C2+C3.

- **The pad's content effect.** A2 §Pad text selection notes that the Fable prompt's content (tool instructions, personality) could interact with model behavior differently per arm. This plan models the pad as a W reduction (`--window 130000`), which is size-equivalent but carries no content. The content interaction is unmeasured.

- **Query construction guidance.** A1 §C4 rates this low-to-medium gain. Offline ranking is already 5/5 top-3 on the deep set; the guidance would matter only on the overflow set (10/12 top-3), which has only 2/5 valid questions at this W.

- **Temporal retrieval (`recent_chats`).** Anthropic's third tool has no context-tree equivalent. The raw tail in tree-tail-v2 arms serves recency passively. Not tested.

- **Longer traces.** The s1 trace (196k cl100k) barely overflows at effective W=130k. A 400k+ token trace would create a more robust overflow regime. No such fixture exists; freezing one costs ~$30-50 live tokens (A2 §7). Not in scope.
