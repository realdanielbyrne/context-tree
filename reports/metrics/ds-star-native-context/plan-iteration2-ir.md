# Iteration 2 IR plan: headroom-budgeted ranked prefix

## Decision

Test one change: keep the incumbent ranker byte-for-byte, but serialize only the longest prefix of its ranked search results whose complete rendered response fits 25% of the live headroom at that tool call. The experimental arm should be named `tree-search-budgeted`; its candidate key should be `search-result-budget:live-headroom-quarter`.

This is a classical top-k cutoff with a dynamically derived `k`. It does not change query parsing, beam traversal, hybrid grep, reciprocal-rank fusion, scores, branch centring, fetch band construction, prompts, tools, or reply policy. The 25% share already exists as `SEARCH_RESULT_HEADROOM_SHARE` in the experimental harness ([transplant.mjs:1454](/Users/danielbyrne/GitHub/rpm/context-tree/eval/scripts/transplant.mjs:1454)); iteration 2 tests whether enforcing that policy on the ordinary search result fixes the newly observed delivery failure.

Do not implement MMR, transcript replacement, a ranking change, or a new summary format in this iteration.

## Observed defect

The clean iteration-1 live artifact is [run-W65536-truncate-tail+tree-tail-v2+tree-center-filename-questions-deep-q9ebc3150-cb2b5adc512bc-n5-z-ai_glm-5.3-flash.json](/Users/danielbyrne/GitHub/rpm/context-tree/eval/fixtures/transplant/s1/e1b289c32f40/results/run-W65536-truncate-tail+tree-tail-v2+tree-center-filename-questions-deep-q9ebc3150-cb2b5adc512bc-n5-z-ai_glm-5.3-flash.json). It records 25 scheduled attempts per arm. `truncate-tail` scored 0/25, `tree-tail-v2` 1/25, and `tree-center-filename` 4/25. The filename candidate therefore improved the headline by 3/25 but missed the preregistered +4/25 threshold. More importantly, the live trace exposes a different binding mechanism from the offline replay.

Across the two tree arms:

- 82 nonempty searches returned 20 tree hits each. Three empty-kind searches returned no hits.
- The first nonempty result consumed 6,095–7,257 exact cl100k tokens, averaging 6,759 tokens, from only about 7,886–7,919 tokens of live headroom.
- Of 88 fetch calls, only 11 began with positive headroom; 77 began at zero or negative headroom. Only five fetches delivered an answer literal.
- The 50 tree attempts made 142 search calls and 88 fetch calls. Appended search results persist in the transcript, so a second search commonly consumed the residue left by the first and made the later, correctly aimed fetch empty.
- On the target question `qo04`, the filename mechanism did fire. Four completed candidate attempts selected centre sequence 218, the answer event. Nevertheless, the first search used 7,255–7,257 tokens. Three attempts searched again before fetching and reached negative headroom. The one attempt that fetched after one search had only 623 tokens left; its correctly centred 1,393-token result was truncated and omitted the answer literal. Thus `qo04` remained 0/5 despite correct centring.

This is a payload-allocation defect, not evidence that the ranker needs another relevance feature. `context_search` currently derives a fixed `retrieval.limit` from configuration and emits both tree `hits` and merged `candidates` ([context-search.ts:147](/Users/danielbyrne/GitHub/rpm/context-tree/packages/mcp/src/tools/context-search.ts:147), [context-search.ts:169](/Users/danielbyrne/GitHub/rpm/context-tree/packages/mcp/src/tools/context-search.ts:169)). Tree candidates also carry a 240-character summary snippet ([context-search.ts:113](/Users/danielbyrne/GitHub/rpm/context-tree/packages/mcp/src/tools/context-search.ts:113)). The merge deduplicates within `candidates` ([merge.ts:82](/Users/danielbyrne/GitHub/rpm/context-tree/packages/core/src/providers/merge.ts:82)), but the response still presents overlapping tree evidence in both `hits` and `candidates`. The harness strips duplicate hit text before append ([transplant.mjs:3996](/Users/danielbyrne/GitHub/rpm/context-tree/eval/scripts/transplant.mjs:3996)); the remaining pointer metadata, candidate snippets, and duplication are still large enough to exhaust the turn.

## Candidate designs considered

| Candidate | Predicted effect | Principal risk | Verdict |
| --- | --- | --- | --- |
| Fixed top-3 after ranking | The correct branch ranks 1, 2, 3, 1, and 1 on the five deep questions, so top-3 retains 5/5 offline. On representative first queries, compact top-3 responses cost 1,482–3,300 tokens instead of 6,120–7,281 for the current production-shaped 20-hit response. | A fixed `k` does not control bytes: top-3 is over twice as large on two questions because metadata sizes differ. Repeated searches can still accumulate without a hard payload invariant. | Useful null comparator, not the recommended candidate. |
| Remove duplicate `hits`/`candidates`, or replace an earlier search result in the transcript | Returning only the merged candidate view measured about 1,533–1,914 tokens on the representative queries. Replacement would bound cumulative search history. | Removing a response view changes the MCP contract and can discard tree metadata; transcript replacement belongs to the host loop, changes conversation semantics, and is not a pure IR cutoff. Existing candidate dedupe does not dedupe across the two public arrays. | Defer. Consider only if budgeted top-k wins but payload remains needlessly duplicated. |
| Maximal marginal relevance (MMR) | Could diversify a small result set when near-duplicate branches occupy the top ranks. | It cannot bound bytes without a separate cutoff, adds a similarity representation and a relevance/diversity weight, and may demote the already-correct top ranks. The lexical arm has no stable document-vector dependency to reuse. | Reject for iteration 2. There is no measured diversity failure. |
| Live-headroom-budgeted ranked prefix | Produces a variable `k` that obeys a hard byte/token cap and preserves fetch space on every call. Reapplying the cap to current headroom makes repeated search consumption geometric rather than allowing the first two calls to exhaust the window. | The quarter-share is a policy constant validated only on this window/fixture. A very large first hit may not fit, and independently slicing `hits` and `candidates` could create inconsistent views. | **Recommended.** |

## Recommended algorithm

1. Run the incumbent `context_search` handler unchanged, with the configured limit of 20. This preserves the ranked pool and all current ranking diagnostics.
2. Compute `searchBudget = floor(max(0, ctx._liveHeadroom) * SEARCH_RESULT_HEADROOM_SHARE)` using the exact live headroom already installed before each handler call ([transplant.mjs:3980](/Users/danielbyrne/GitHub/rpm/context-tree/eval/scripts/transplant.mjs:3980)). The append path remains the authority and still applies `capToolResult` ([transplant.mjs:401](/Users/danielbyrne/GitHub/rpm/context-tree/eval/scripts/transplant.mjs:401)).
3. Treat one rank position as an atomic display row: the tree hit at that rank plus any corresponding tree candidate. Preserve non-tree provider candidates only when their complete serialized addition fits and their rank precedes the next tree row. Build one coherent selected set; do not slice the two arrays independently and accidentally expose different rankings.
4. Starting at rank one, add complete rows while the full serialized response remains within `searchBudget`. Stop at the first row that would exceed it. Do not skip an oversized earlier row to admit a later one; that would cease to be top-k.
5. If even rank one cannot fit, return its irreducible coordinate fields (`node_id`, `kind`, `title`, `score`, and `path`) and set `budget_exhausted:true`; omit optional meta/snippet fields until it fits. If the fixed envelope itself cannot fit, return an explicit empty result with `more_available:true`. Never exceed the cap merely to floor at one hit.
6. Include compact control metadata: `returned`, `available`, `more_available`, and `budget_tokens`. These let the model distinguish a deliberately narrow result from an exhausted index and let the verifier prove the mechanism fired.

The experimental arm must keep `tree-center-filename` centring, because iteration 1 established that it moves `qo04` to the correct centre. The sole iteration-2 delta against that incumbent is the search-result selection budget.

On one representative first query from each live question, an offline serialization probe using a 1,975-token cap (one quarter of the observed initial headroom) chose `k = [1, 4, 4, 3, 2]` and responses of `[1,129, 1,713, 1,754, 1,578, 1,303]` exact cl100k tokens. The known correct ranks `[1, 2, 3, 1, 1]` all remain visible. For `qo04`, two such searches would consume at most about 3,156 tokens instead of the observed 7,886 tokens and leave roughly 4,700 tokens before small message overheads—well above the 1,393-token correctly centred fetch observed in the live artifact. These are mechanism predictions, not scored evidence.

## Risks and boundaries

- The quarter share is reused, not derived from a cross-window study. Treat W=65,536 as the only claim point. Before promotion, rederive fixtures and repeat the budget gate at other windows; do not generalize from this cell.
- The cap must be measured on the complete MCP JSON envelope with the same exact tokenizer as the append path. Summing per-hit costs misses commas, duplicated fields, and control metadata.
- Search ranking must be computed over the original 20-result pool before display selection. Setting configuration `retrieval.limit=3` is not equivalent because it also changes beam width, traversal, grep collection, and merge inputs.
- Correct top-3 recall is established only for five deep questions. The rank gate must be rerun on every available frozen question set; a coverage failure retires this cutoff candidate for that set.
- Smaller lists may change model behaviour even when the answer branch remains visible. Fewer distractors should reduce repeat searches, but only ordered tool-call telemetry can establish that mechanism.
- The one-hit compact fallback is a projection rule that fires only at a boundary. Record whether it fired; if it fires on the target fixture, the ordinary budgeted-prefix mechanism was not tested cleanly.

## Preregistration and zero-live-token gates

Run all gates before any live token. A failed gate cancels the batch.

1. **Epoch identity:** require the same frozen question, trace, store, config, root, model, and compiled-runtime identities for `truncate-tail`, `tree-center-filename`, and `tree-search-budgeted`. Result names must be collision-free and carry the candidate key. Historical rows are diagnostic only.
2. **One-change parity:** on every frozen query, require identical incumbent/candidate ranked node IDs, order, scores, search path, fallback, branch selected for fetch, centring terms, centre sequence, fetch allocator, prompts, schemas, and reply policy. The only model-visible delta is which ranked response rows fit the search budget plus its control metadata.
3. **Mechanism firing:** replay every nonempty search call from the iteration-1 artifact at its recorded `exactHeadroom`. Require candidate serialized tokens `<= floor(max(0, exactHeadroom) * 0.25)`, `returned < available` for at least one positive-headroom call, and no append-path truncation. Print one full `qo04` result, not only counts.
4. **Rank coverage:** for all five deep questions, require the answer branch inside the emitted prefix on the first recorded query. Specifically require `qo04` rank-one visibility in 5/5 eligible rows. Report emitted `k` and bytes per row.
5. **Repeated-search delivery replay:** preserve the recorded ordering of search and fetch calls. Require all four completed `qo04` candidate attempts to reach a fetch with positive headroom, centre 218 to remain selected, the post-cap payload to contain the answer literal in 4/4, and no protected question to lose a previously delivered literal. No payload may exceed its per-call headroom.
6. **Boundary fixtures:** assert exact-cap inclusion, one-token-over exclusion, zero/negative headroom, an oversized first row using the compact fallback, duplicate tree hit/candidate pairing, absent provider candidates, and a pool smaller than the emitted `k`.
7. **Provenance:** inspect the actual post-cap bytes for every replay success. A sequence number or literal present only in metadata is not delivery.

## Live verification and routing

Only a machine-readable PASS of gates 1–7 authorizes a live batch. At W=65,536, run the unchanged `truncate-tail` proxy, the iteration-1 incumbent `tree-center-filename`, and `tree-search-budgeted` together on frozen `questions-deep.json`, five replicates per question per arm: 75 scheduled attempts. Rotate arm order by replicate. Stalls and model-call errors remain in the denominator.

The candidate wins only if all conditions hold:

1. `qo04` emits the correct branch, centres at 218, and delivers the answer literal after cap in 5/5 attempts.
2. Candidate unconditional provenance-audited exact-match success is at least incumbent +4/25 and strictly greater than same-invocation `truncate-tail`.
3. No protected question (`qo01`, `qo02`, `qo03`, `qo05`) has lower delivery count than the incumbent.
4. Every nonempty search response obeys its recorded budget; no search result is truncated by the append cap.
5. Report per-question success, completion/stalls, search calls, emitted `k`, search-result tokens, positive-headroom fetch rate, literal delivery, fresh input, cache read/write, output, and turns.

If delivery wins but the headline misses, record a bucket win and do not promote. If ranks change, the mechanism is unattributed and the arm is invalid. If `qo04` still reaches centre 218 but fails after cap, retire search sizing as the complete repair and use the ordered payload to design a separate fetch-envelope reduction. If a protected question loses coverage because its answer falls outside the prefix, retire the quarter-share candidate rather than adding MMR in the same iteration.
