# Iteration 2 judge: search-result headroom

## Binding verdict

Do **not** implement or run the proposed live-headroom-quarter ranked prefix. The winner is a single replacement of the model-visible search-result representation: preserve all ranked hits, project each to `{node_id, kind, title, phase_type, path, score}`, and omit the duplicate tree `candidates` view. Name the arm `tree-search-coordinates` and its candidate key `search-result-view:all-rank-coordinates@center-bare-filename`.

This arm compares against `tree-center-filename`, not `tree-tail-v2`. Both arms must use bare-filename within-branch centring. The sole iteration-2 delta is the search response projection. Ranking, the configured pool of 20, query parsing, search path, scores, prompts, tool schemas, fetch behavior, centring, budgets, append cap, and reply policy remain identical.

The reason is a corrected load-bearing rank. Directly mapping `questions-deep.json` node IDs into the first `context_search` call's `hitIds` in the 75-row live artifact gives answer ranks `[1, 2, 7, 1, 1]` for qo01–qo05. For qo03, the incumbent is rank 7 in 5/5 first searches; the filename arm is rank 7 in its four nonempty first searches, while rep 3 returned zero hits and supplies no contrary rank. The iteration-2 plan's qo03 rank 3 is false for the live tree-hit surface. Its representative quarter-budget probe emits `k=4`, which would hide rank 7 and endanger the only question that delivered and scored in iteration 1.

An offline probe on the actual representative live queries shows that the all-rank coordinate projection costs 1,198–1,402 exact tokens while preserving ranks `[1,2,7,1,1]`. The candidates-only alternative costs 1,551–1,931 tokens and also preserves all ranks. Both are far below the current 6,094–7,257-token first search, but coordinates retain more fetch headroom without the quarter-share constant, a fallback shape, or a fitted `k`.

## Scores

Scores are 1–5; implementation risk is scored high when risk is low.

| Candidate | Information gain | Mechanism fit | One-change isolation | Rank safety | Resource discipline | Portability | Implementation risk | Total | Verdict |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| All-rank coordinate projection | 5 | 5 | 4 | 5 | 5 | 5 | 4 | **33** | **Winner** |
| Candidates only | 4 | 4 | 5 | 5 | 4 | 4 | 4 | **30** | Runner-up |
| Null: unchanged filename arm | 2 | 1 | 5 | 5 | 1 | 5 | 5 | **24** | Control, not repair |
| Quarter-budget ranked prefix | 4 | 5 | 3 | 1 | 5 | 2 | 3 | **23** | Rejected before implementation |
| Fixed top-k | 2 | 3 | 4 | 1 | 1 | 1 | 4 | **16** | Rejected before implementation |

The all-rank projection is one semantic change: replace two overlapping rich views with one canonical coordinate view. It does not claim whether metadata, snippets, or duplication was individually wasteful; it tests the measured bucket, model-visible search-result bytes. That attribution is sufficient only if the parity and mechanism gates below pass.

## Treatment of losing designs

1. **Quarter-budget prefix: reject.** At initial headroom near 7,900 tokens, the proposed quarter cap is about 1,975 tokens and emitted only four qo03 rows in its own probe. Because the answer is rank 7, it violates protected coverage before a live token. Adding a rank-7 floor would derive a special case from fixture truth and would no longer enforce the proposed cap. The 25% constant is reused from a different experimental arm and has not been validated across windows.
2. **Fixed top-k: reject.** Any `k <= 6` hides qo03. A fixed `k >= 7` preserves this fixture but provides no byte invariant and is fitted to five questions. Changing `retrieval.limit` is additionally invalid because it alters ranker traversal and merge inputs, not only display.
3. **Candidates only: retain as a fallback, not a co-change.** It is a clean one-view projection and preserves all 20 candidates, but its representative payload is up to 529 tokens larger than the coordinate projection and carries 240-character snippets. If coordinates fail because the model cannot choose from pointers, the next iteration may test candidates-only alone; do not combine the views now.
4. **Null: retain inside the batch.** The unchanged `tree-center-filename` arm is the same-epoch control. Null cannot be selected as the repair because iteration 1 recorded 77/88 fetches with non-positive headroom and qo04 delivery 0/5 despite correct centring.

Grafts from the losing designs are limited to two ideas: measure the complete serialized MCP envelope with the append tokenizer, from the budgeted-prefix plan; and expose one coherent canonical result view, from candidates-only. Do not graft the quarter cap, a compact-first-hit fallback, model-visible control metadata, or a fixed `k`.

## Exact implementation specification

No production package changes are authorized. Implement the experimental projection only in [transplant.mjs](/Users/danielbyrne/GitHub/rpm/context-tree/eval/scripts/transplant.mjs:1564) and its eval tests.

1. Register `tree-search-coordinates` wherever the incumbent is registered: arm IDs, `TREE_ARMS`, the `tree-center-filename` root/context construction, `LEGACY_SURFACE_ARMS`, `RAW_NARROWED_FETCH_ARMS`, and raw-fetch tool schemas. It must inherit the same tree prompt, root ladder, raw full fetch, budgets, and tool contract as `tree-center-filename`.
2. Construct its `TreeRetriever` with `retrievalCenterFingerprintMode:'bare-filename'`, exactly like `tree-center-filename` at [transplant.mjs:4242](/Users/danielbyrne/GitHub/rpm/context-tree/eval/scripts/transplant.mjs:4242). Record that existing mode separately from the iteration-2 candidate key.
3. In `handlersForArm`, call the unchanged real `CONTEXT_SEARCH` handler once. Before projection, capture its complete result only in out-of-band telemetry. Return the same top-level `query`, `path`, `fallback`, `provenance`, and `unavailable`; set `hits` to all upstream hits in the same order, each with exactly `{node_id, kind, title, phase_type, path, score}`; set `candidates:[]`. Add no model-visible `returned`, `available`, `more_available`, `budget_tokens`, or fallback marker.
4. Preserve `lastSearchQuery` exactly as the incumbent does, so fetch receives the identical query. Do not change the fetch handler or `capToolResult`.
5. Add out-of-band ordered fields to each search tool-call record: `searchResultView`, `availableHitIds`, `visibleHitIds`, `availableCandidateIds`, `visibleCandidateIds`, `answerVisibleRank` for fixture audit only, and exact serialized before/after tokens. Fixture truth must never enter the returned result.
6. Give the new arm collision-proof result/header/row identity. The filename mode is `bare-filename`; only `tree-search-coordinates` carries `candidateKey=search-result-view:all-rank-coordinates@center-bare-filename`. The baseline candidate key remains its iteration-1 value or is represented as an explicit incumbent identity, never as the iteration-2 candidate.
7. Add deterministic tests in `eval/test/transplant.test.ts` for arm membership, inherited root ladder, filename-centre mode, exact projection keys, stable order/scores, empty candidates, unique identity, and unchanged incumbent bytes.

## Numbered zero-live-token gates

A failed, deferred, or missing gate cancels the batch.

1. **`NC20-epoch-input`:** require the exact iteration-1 artifact, `partial:false`, 75 scheduled rows, five questions, three equal-n arms, question SHA `9ebc3150...`, and non-null matching trace/store/config/root/source/runtime identities. Print the header.
2. **`NC21-live-rank-audit`:** derive ranks from `questions-deep.json` and first-search `hitIds`; require `[1,2,7,1,1]` on every nonempty applicable query. Print every qo03 query, target node ID, returned count, and rank. A zero-hit result is `rank:null`, never rank 3.
3. **`NC22-one-change-parity`:** on every recorded query, compare the full pre-projection incumbent and candidate outcomes. Require byte-identical query, path, fallback, hit IDs/order/scores, candidate IDs/order/scores/snippets, provenance, unavailable providers, search state, centre mode, prompts, schemas, budgets, fetch allocator, and reply policy. After projection, the only allowed model-visible diff is the declared coordinate mapping and `candidates:[]`.
4. **`NC23-coordinate-serialization`:** replay every recorded first-search query and every available frozen-question query. Require all upstream 20 hits remain visible in order, answer ranks remain `[1,2,7,1,1]`, and each complete JSON response fits that call's positive exact headroom without append truncation. Report min/median/max tokens and print a complete qo03 response. The representative expectation is 1,198–1,402 tokens, not a hard-coded acceptance range.
5. **`NC24-ordered-headroom-replay`:** use a scripted zero-model-token provider to replay the recorded search/fetch order from each completed iteration-1 filename row while regenerating real tool responses from the frozen store. Recompute headroom after every append. For the four observable qo04 rows, require positive headroom at the first relevant fetch, `centerSeq=218`, and answer-literal delivery after cap in 4/4. Preserve all five previously delivered qo03 literals across the two tree arms. Print one full two-search qo04 trace and its answer-bearing fetch bytes.
6. **`NC25-boundaries`:** test an empty upstream result, null path/phase fields, duplicate node IDs across the two upstream views, fewer than 20 hits, exactly 20 hits, an individual coordinate row near the remaining headroom, and zero/negative append headroom. Projection may be capped only by the unchanged append guard; it must not silently drop or reorder coordinates before that guard.
7. **`NC26-instrument-provenance`:** assert fixture-only `answerVisibleRank` is absent from model-visible JSON. Inspect each replay delivery in actual post-cap event text. Require underlying and visible rank telemetry to agree.
8. **`NC27-live-readiness`:** dry-run collision-proof names for `truncate-tail`, `tree-center-filename`, and `tree-search-coordinates`; require gates 1–7 PASS in one machine-readable artifact and show the exact future command. No historical row is a live control after implementation changes the harness fingerprint.

## Pre-registered live verification

Only `NC27-live-readiness=PASS` authorizes live tokens. Run W=65,536 on frozen `questions-deep.json`, resolved `z-ai/glm-5.3-flash`, with `truncate-tail`, `tree-center-filename`, and `tree-search-coordinates` in one invocation at five replicates per question per arm: 75 scheduled attempts. Preserve the existing scheduler for all arms, record arm order, and do not reuse iteration-1 scores. Stalls and model-call errors remain in the denominator.

The candidate wins only if all conditions hold:

1. **Target mechanism:** on qo04, all nonempty first searches expose the answer coordinate at rank 1; all five attempts fetch with positive headroom, retain `centerSeq=218`, and deliver the literal after cap in 5/5. Every nonempty candidate search response is untruncated and reports all upstream coordinates.
2. **Headline:** unconditional provenance-audited exact-match success is at least `tree-center-filename +4/25` and strictly greater than same-invocation `truncate-tail`.
3. **Protected questions:** qo01, qo02, qo03, and qo05 each have delivery count no lower than the incumbent. Qo03's answer coordinate must remain visible at rank 7 whenever its upstream result is nonempty. Any protected loss is a regression, not a tradeoff.
4. **Attribution:** underlying rank/order/scores, centring terms/sequence, fetch spans, prompts, tools, budgets, and reply policy match the incumbent. Report search calls, positive-headroom fetches, result tokens, delivery, successes, completion/errors/stalls, turns, fresh input, cache read/write, and output per question and arm.

Iteration 1 spent $0.355082 and processed about 14.8 million input/output/cache-read tokens across the same three-arm shape. Budget 15–18 million processed tokens and $0.36–$0.44 for the initial iteration-2 batch; dollars are derived, not primary.

### One capped escalation

Escalate exactly once only if every mechanism, parity, provenance, and protected-question condition passes and the candidate's headline delta is positive but only +1, +2, or +3/25. Add five replicates per question to all three arms in the unchanged epoch, yielding 150 cumulative attempts, approximately 30–36 million processed tokens, and a $0.72–$0.88 budget. At the cap require candidate at least incumbent +8/50, strict superiority to the proxy, qo04 delivery 10/10, and no protected delivery regression. No second escalation is permitted.

If coordinates preserve delivery but the headline misses, record a delivery-bucket win without promotion. If coordinate projection causes selection or protected-delivery loss, retire it and queue candidates-only as a new, separately judged iteration. If qo04 remains centered at 218 but still lacks fetch headroom, reject search-result representation as the complete repair and route to the fetch envelope. A win establishes only the frozen same-window raw-tail-proxy claim, not superiority to the repository's end-to-end native arm.

No production code change or live-token call is authorized by this verdict itself.
