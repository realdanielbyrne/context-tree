## Evidence checked

- The frozen fixture pins the trace/store hashes and contains 754 L0 events ([manifest.json:4](/Users/danielbyrne/GitHub/rpm/context-tree/eval/fixtures/transplant/s1/e1b289c32f40/manifest.json:4), [manifest.json:8](/Users/danielbyrne/GitHub/rpm/context-tree/eval/fixtures/transplant/s1/e1b289c32f40/manifest.json:8)).
- qo04’s source branch is fixed, its answer event is `seq=218`, and the literal is `Build two-task suite file and validate rows` ([questions-deep.json:156](/Users/danielbyrne/GitHub/rpm/context-tree/eval/fixtures/transplant/s1/e1b289c32f40/questions-deep.json:156)).
- The delivery gate derives each run’s headroom from its recorded window, first-turn prompt, and reply reserve, then replays that run’s first search query ([delivery-killgate.mjs:57](/Users/danielbyrne/GitHub/rpm/context-tree/eval/scripts/delivery-killgate.mjs:57), [delivery-killgate.mjs:95](/Users/danielbyrne/GitHub/rpm/context-tree/eval/scripts/delivery-killgate.mjs:95), [delivery-killgate.mjs:119](/Users/danielbyrne/GitHub/rpm/context-tree/eval/scripts/delivery-killgate.mjs:119)).
- The production path narrows only when the whole branch exceeds `maxTokens`, chooses one center, then grows one contiguous band under measured token counts ([retriever.ts:320](/Users/danielbyrne/GitHub/rpm/context-tree/packages/core/src/retrieve/retriever.ts:320), [retriever.ts:333](/Users/danielbyrne/GitHub/rpm/context-tree/packages/core/src/retrieve/retriever.ts:333), [retriever.ts:345](/Users/danielbyrne/GitHub/rpm/context-tree/packages/core/src/retrieve/retriever.ts:345)).
- Contrary to the report’s proposed “highest-scoring rather than first match” candidate ([report:712](/Users/danielbyrne/GitHub/rpm/context-tree/reports/metrics/ds-star-delivery-pass-report.md:712)), current source already selects the highest weighted score and the latest sequence on a tie ([retriever.ts:553](/Users/danielbyrne/GitHub/rpm/context-tree/packages/core/src/retrieve/retriever.ts:553), [retriever.ts:571](/Users/danielbyrne/GitHub/rpm/context-tree/packages/core/src/retrieve/retriever.ts:571)).
- Recorded examples preserve both filenames in the model query at W=65,536 and W=131,072 ([W655 tree-tail-v2 result:2778](/Users/danielbyrne/GitHub/rpm/context-tree/eval/fixtures/transplant/s1/e1b289c32f40/results/run-W65536-tree-tail-v2-questions-deep-z-ai_glm-5.3-flash.json:2778), [W131 oracle result:2820](/Users/danielbyrne/GitHub/rpm/context-tree/eval/fixtures/transplant/s1/e1b289c32f40/results/run-W131072-tree-oracle+truncate-tail-questions-deep-z-ai_glm-5.3-flash.json:2820)).
- The one scored qo04 success is not delivery evidence: it fabricated the exact literal and `seq 218` although the replayed payload omitted the answer ([W131 oracle result:3524](/Users/danielbyrne/GitHub/rpm/context-tree/eval/fixtures/transplant/s1/e1b289c32f40/results/run-W131072-tree-oracle+truncate-tail-questions-deep-z-ai_glm-5.3-flash.json:3524), [W131 oracle result:3655](/Users/danielbyrne/GitHub/rpm/context-tree/eval/fixtures/transplant/s1/e1b289c32f40/results/run-W131072-tree-oracle+truncate-tail-questions-deep-z-ai_glm-5.3-flash.json:3655)).

## Quantified failure model

Offline reproduction matched the report: total delivery is 115/145 and qo04 is 0/30. The 30 qo04 records comprise 20 runs at 6,609 tokens headroom, five at 9,466, and five at 14,365. Every query selects `seq=55`, 163 events before the answer at `seq=218`; resulting bands are respectively `55–70`, `55–86`, and `55–106`. Thus no live band can contain the answer.

The deterministic cause is fingerprint loss, not first-match behavior:

1. Query fingerprinting recognizes slash-containing paths, quoted strings, camel/Pascal identifiers, and uppercase identifiers, but not bare filenames containing dots ([retriever.ts:625](/Users/danielbyrne/GitHub/rpm/context-tree/packages/core/src/retrieve/retriever.ts:625), [retriever.ts:637](/Users/danielbyrne/GitHub/rpm/context-tree/packages/core/src/retrieve/retriever.ts:637)).
2. Most qo04 queries therefore reduce to the sole fingerprint `JSONL`; the two discriminative basenames are discarded.
3. `seq=55` contains `JSONL` in both `blob` and `args_blob`, while answer event 218 contains it only in `args_blob`. Scoring adds once per matching field ([retriever.ts:553](/Users/danielbyrne/GitHub/rpm/context-tree/packages/core/src/retrieve/retriever.ts:553)), so the early distractor wins 2–1.
4. One lowercase-`jsonl` query enters fallback, but fallback strips periods, turning the filenames into strings absent from the trace ([retriever.ts:534](/Users/danielbyrne/GitHub/rpm/context-tree/packages/core/src/retrieve/retriever.ts:534)).

The report’s mis-centering diagnosis at lines 695–700 is verified, but its first proposed repair is already implemented. Also, its live confirmation command runs only the old `tree-tail-v2` arm and then compares against stale 7/25 ([report:719](/Users/danielbyrne/GitHub/rpm/context-tree/reports/metrics/ds-star-delivery-pass-report.md:719)), contradicting its own same-epoch requirement ([report:643](/Users/danielbyrne/GitHub/rpm/context-tree/reports/metrics/ds-star-delivery-pass-report.md:643)).

## Plausible single-change candidates

1. **Preferred: recognize bare filenames as distinctive fingerprints.** Add one basename pattern beside `FILE_PATH_Q`; preserve the existing ranking and band logic. My paired in-memory replay over the same 145 recorded query/headroom pairs moved qo04 from 0/30 to 30/30, kept qo01–qo03 at 30/30 and qo05 at 25/25, and moved the center to 218. At headrooms 6,609/9,466/14,365, candidate spans were `205–232`, `195–240`, and `176–249`.
2. **Per-event rather than per-field term credit.** This removes duplicated `blob`/`args_blob` influence without query syntax assumptions. Offline qo04 replay delivered 29/30, but mainly because all `JSONL` matches tied and the existing late-tie rule selected `seq=235`; it still failed the lowercase query and did not identify the answer event. This is an accidental proximity repair, not the strongest mechanism match.
3. **Several disjoint bands.** This could hedge uncertain centers using the existing `SeqSpan[]` output contract ([types.ts:97](/Users/danielbyrne/GitHub/rpm/context-tree/packages/core/src/retrieve/types.ts:97)), but current generic-term scoring places the true event well below the early duplicated match. It also introduces `k`, budget allocation, and ordering choices. Defer until filename recognition fails on broader fixtures.

## Portability/constants/boundaries

- Bare-filename recognition derives from syntax, not a model window or tokenizer, and introduces no token-budget constant.
- Avoid matching basenames again inside already-recognized slash paths; otherwise one path receives duplicate query weight.
- Untested boundaries include extensionless filenames, Unicode filenames, punctuation adjacent to names, and identifiers appearing beyond the fixed 8,192-character per-field scan ([retriever.ts:559](/Users/danielbyrne/GitHub/rpm/context-tree/packages/core/src/retrieve/retriever.ts:559)).
- Existing nonportable constants remain: English stop words, fallback minimum length 4, positional term weights, the three-field list, and the 8,192-character prefix ([retriever.ts:538](/Users/danielbyrne/GitHub/rpm/context-tree/packages/core/src/retrieve/retriever.ts:538), [retriever.ts:548](/Users/danielbyrne/GitHub/rpm/context-tree/packages/core/src/retrieve/retriever.ts:548)).
- `q.seq` is fixture-only truth. Use it for instrumentation and gates, never as an algorithm input.
- The gate’s fixed sweep is diagnostic only; actual verdicts must use recorded headrooms, as its live replay does ([delivery-killgate.mjs:41](/Users/danielbyrne/GitHub/rpm/context-tree/eval/scripts/delivery-killgate.mjs:41)).
- The pooled 145 records span arms/windows and are valid for deterministic paired replay, not a headline live verdict. Any score comparison requires same-epoch, equal-n arms.

## Highest-information next experiment

Implement exactly one flagged change: add bare-filename extraction, with a distinct candidate arm so baseline and candidate run in one invocation.

Numbered zero-live-token gates:

1. Extend the delivery gate to print extracted terms, chosen center, `center-q.seq`, and returned spans; inspect samples, not only pass bits.
2. Assert the mechanism fires: both qo04 filenames are extracted in all 30 recorded queries, and candidate center differs from baseline.
3. Paired replay all 145 frozen query/headroom records. Pre-register: qo04 ≥25/30, every other question no regression, and no payload exceeds its recorded headroom. The current simulation clears this at 30/30 and 145/145 overall.
4. Add a synthetic unit fixture with an early duplicated generic `JSONL` event and a later event containing both bare filenames; require the later event to win.
5. Only after those gates, run baseline plus candidate together at W=65,536, GLM 5.3 Flash, n=5 per question per arm. Primary win: candidate qo04 delivery 5/5 and no per-question delivery regression. Headline scores remain secondary and must be compared to the fresh same-invocation baseline; do not use the report’s stale 7/25. Delivery alone is not yet evidence that the system beats native context.

The preferred single-change replay increased frozen-set delivery from 115/145 (79.3%) to 145/145 (100%), a gain of 30 runs or 20.7 percentage points.
