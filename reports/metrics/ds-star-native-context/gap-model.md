# Native-context gap model

## Decision

The current evidence does not establish that context-tree beats native context. It does establish a reproducible 18-attempt gap between the current tree arm and a full-transcript ceiling on the deep fixture: `tree-tail-v2` scores 7/25 at W=65,536, while `naive-full` scores 25/25 at W=200,000. That gap splits exactly into 13 attempts lost at or before payload delivery and five attempts lost after delivery. The 13-attempt bucket cannot yet be subdivided honestly because the persisted rows do not record ordered per-tool-call delivery or the final post-cap bytes.

The highest-information next action is therefore an instrument repair plus a zero-token paired replay, not a live candidate batch. The replay should compare unchanged centring with bare-filename fingerprint extraction on the 25 scoped deep rows. It costs zero live tokens and can test a mechanism with a five-attempt opportunity in the current cell—enough to clear the report's four-attempt improvement target if delivery converts to answers—while also showing whether append capping, rather than centring, remains binding.

## Terms and claim boundary

For the transplant benchmark, **native-context proxy** means `truncate-tail`: the newest raw events that fit the same window, presented with a flat prompt and no retrieval tools. `naive-full` is not a same-window native baseline; below 200K it overfills the tested window, and at W=200,000 it is a full-transcript ceiling. The repo's actual end-to-end `native` arm is stronger and different: it runs a growing multi-turn transcript with normal harness tools and optional native prefix caching ([baseline analysis](./analyzer-baseline.md), [end-to-end arm](/Users/danielbyrne/GitHub/rpm/context-tree/eval/src/loop.ts:344)).

Accordingly, a valid paired transplant result can support only this claim:

> On the frozen deep-overflow fixture, at the named window, model, code epoch, and replicate count, context-tree has higher provenance-audited exact-match recall than the same-window raw-tail native proxy.

It cannot support “context-tree beats native context” generally. That broader claim requires a later same-epoch comparison with the real end-to-end native arm across representative tasks and trace sizes. It also cannot currently support even the narrow proxy claim: there is no clean, same-window, same-epoch deep cell containing both `tree-tail-v2` and `truncate-tail`. The only paired real-arm cell is the W=65,536 overflow fixture, whose provenance-audited result is a 0/25–0/25 tie and whose rank gate fails at 3/5 ([provenance audit](/Users/danielbyrne/GitHub/rpm/context-tree/eval/scripts/provenance-audit.mjs), [rank gate](/Users/danielbyrne/GitHub/rpm/context-tree/eval/scripts/rank-killgate.mjs)).

The primary metric is unconditional, provenance-audited exact-match successes divided by all scheduled attempts. Stalls remain in the denominator. Selection and delivery are mechanism metrics; they are not substitutes for task success.

## Baseline-to-goal ledger

The only presently reproducible additive quality ledger uses the full-transcript ceiling as the goal. It is diagnostic, not a native-comparison verdict.

| Bucket | Size | Mechanism represented | Evidence |
| --- | ---: | --- | --- |
| At or before delivery | 13 attempts | Of 25 scheduled attempts, only 12 received an answer-bearing payload under the loose observed-delivery reconstruction. This bucket combines wrong-branch selection, wrong-band centring, and append-cap loss because existing rows cannot order searches/fetches or reconstruct final served bytes. | Reproduced `25 - 12 = 13` with [pipeline-decomposition.mjs](/Users/danielbyrne/GitHub/rpm/context-tree/eval/scripts/pipeline-decomposition.mjs); source cell [W65536 tree result](/Users/danielbyrne/GitHub/rpm/context-tree/eval/fixtures/transplant/s1/e1b289c32f40/results/run-W65536-tree-tail-v2-questions-deep-z-ai_glm-5.3-flash.json). |
| After delivery | 5 attempts | Twelve attempts received an answer-bearing payload but only seven scored. This includes answer extraction/reasoning/formatting failures and any run-level behavior after delivery; current telemetry does not support a narrower attribution. | Reproduced `12 - 7 = 5` from the same decomposition and result file. |
| **Total gap to ceiling** | **18 attempts** | Current tree scores 7/25 versus the 25/25 full-transcript ceiling. | Reproduced `13 + 5 = 18 = 25 - 7`; ceiling source [W200000 naive-full result](/Users/danielbyrne/GitHub/rpm/context-tree/eval/fixtures/transplant/s1/e1b289c32f40/results/run-W200000-naive-full-questions-deep-z-ai_glm-5.3-flash.json). |

The strict-own-branch alternative is 14 at/before delivery plus four after delivery (`25 - 11`, `11 - 7`). It is a valid alternate cut, not an extra loss. This model uses the loose 13+5 cut because “answer-bearing payload arrived” is the relevant boundary for the model's opportunity to answer.

The report's near-term target is 11/25, four successes above the 7/25 incumbent ([delivery report](/Users/danielbyrne/GitHub/rpm/context-tree/reports/metrics/ds-star-delivery-pass-report.md:695)). That target is not a second observed goal ledger: no evidence assigns four specific failures to a candidate or shows that recovered delivery converts one-for-one into score. qo04 is a five-attempt opportunity in the scoped cell—selected 5/5, delivered 0/5, scored 0/5—but it is potential bucket capacity, not five promised successes.

There is no numeric baseline-to-native-goal gap yet. A same-cell native score is missing for the deep fixture, so that gap is `null`, not zero. The separately run deep figures—tree 7/25 at W=65,536 and raw tail 0/25 at W=131,072—must not be subtracted because both window and epoch differ.

## Reconciliation of the analyzer disagreements

1. **`115/145` is reproducible but not an experiment-cell delivery rate.** The delivery script pools six file/arm cells across three windows and multiple epochs, counterfactually fetches each question's known correct branch, and passes model-token headroom directly into a heuristic-token API. It therefore measures a pooled conditional centring ceiling. It does not measure observed end-to-end delivery and cannot enter the 18-attempt ledger. The scoped persisted tree cell reconstructs as 12/25 loose delivery, 11/25 strict delivery, and 7/25 scored ([instrument analysis](./analyzer-instrument.md)).

2. **The qo04 centring diagnosis survives; the claimed magnitude does not.** Across the pooled replay, qo04 is 0/30 and centres on seq 55 while the answer is at seq 218. Current fingerprint extraction recognizes paths and identifier forms but not bare dotted filenames, so most qo04 queries retain only generic `JSONL`; duplicate field matches make the early event win ([delivery analysis](./analyzer-delivery.md), [retriever](/Users/danielbyrne/GitHub/rpm/context-tree/packages/core/src/retrieve/retriever.ts:532)). This is strong causal evidence for miscentring. The analyzer's 30/30 candidate replay is promising offline evidence, but because its rows and budgets are pooled and its replay is not persisted as a first-class artifact, it is not a 30-attempt candidate verdict.

3. **“Highest-scoring rather than first match” is retired.** Current source already chooses the last event at the highest weighted score. This proposal cannot fire and must not consume a batch ([retriever](/Users/danielbyrne/GitHub/rpm/context-tree/packages/core/src/retrieve/retriever.ts:571)).

4. **Bare-filename extraction precedes multi-band as the candidate hypothesis, but neither runs live yet.** Filename extraction directly repairs the demonstrated loss of the two discriminative query terms and introduces no window/token constant. Multi-band adds band-count and allocation choices before ordered telemetry has shown that one correctly centred band still fails. The instrument analyzer is right that telemetry must land first; it is too early to privilege multi-band over the more direct fingerprint repair.

5. **The overflow paired cell is a baseline sanity check, not candidate evidence.** Its raw scores are tree 0/25 and proxy 4/25, but provenance auditing removes all four proxy successes, yielding 0/25 each. Direct sums reproduce 7,566,581 processed tokens for tree and 1,421,479 for the proxy, a 5.323× ratio. The failed 3/5 ranking gate and decayed validity above W=65,536 prevent using this fixture to isolate a delivery change ([baseline analysis](./analyzer-baseline.md)).

## Prerequisite instrument fixes

These changes shift the measurement epoch and must land before any baseline or candidate batch:

1. Freeze and emit the selected question-file SHA, store/trace/config/root hashes, Git and compiled-runtime fingerprints, effective configuration, model identifier/revision when available, invocation options, candidate identity, and `partial:false`. Current HEAD is `4e5d22296573`; the deep question SHA independently reproduces as `9ebc3150d54dadf0c31bdbce1990cb66d4653a6688d0bccf1befd6662ef85abc`, but the manifest freezes only the older base question file.
2. Give every parameterized arm a unique output identity. Current names omit candidate parameters and overwrite sweeps ([transplant harness](/Users/danielbyrne/GitHub/rpm/context-tree/eval/scripts/transplant.mjs:4100)).
3. Replace flat `searchQueries`, `fetchedIds`, and aggregate truncation with an ordered per-tool-call record containing: turn/call index, input, exact and heuristic headroom, preceding search query, branch, narrowing strategy and true `centerSeq`, returned spans, before/after bytes and tokens, dropped amount, and answer-literal presence after the append cap. Capture `centerSeq` directly; it is not derivable reliably from a span midpoint.
4. Repair and execute the zero-token G7 logging gate with a valid question. Require it to exercise search plus full and summary fetch and print one complete record.
5. Key verdict cells by question hash and code epoch as well as model/window/arm/stratum; until then, do not use `runVerdict`, which silently pools incompatible files ([verdict code](/Users/danielbyrne/GitHub/rpm/context-tree/eval/scripts/transplant.mjs:4339)).
6. Validate the deep fixture at the exact claim window: every answer must be absent from the proxy tail; rank gate must remain at least 4/5; qo04 must be narrowing-eligible in every baseline replicate.

## Candidate changes after the gates

1. **First candidate: bare-filename fingerprints.** Add one syntax-derived basename extractor without double-counting basenames already inside recognized paths. Keep ranking, one-band selection, total retrieval budget, prompts, tools, and reply policy unchanged. Required mechanism field: extracted basenames and changed `centerSeq` in every qo04 row.
2. **Second candidate only if the first is correctly centred but post-cap delivery still fails: multi-band retrieval.** Keep total `maxTokens` fixed and vary only contiguous versus disjoint allocation. Required mechanism field: `bandsReturned > 1` and literal presence after cap.
3. **Do not run:** highest-scoring-event centring, because it is current behavior; per-event term credit, because its 29/30 pooled result is driven by an accidental tie at seq 235 and still fails the lowercase query; hit-list tuning on the deep delivery diagnosis, because it targets selection rather than the demonstrated within-branch loss.

## Highest-information next step

Implement the prerequisite ordered telemetry and the bare-filename extractor behind distinct baseline/candidate identities, then run one zero-token paired replay over only the 25 rows in the standalone W=65,536 deep `tree-tail-v2` file using each row's exact ordered query, branch, exact-to-heuristic budget conversion, and append cap.

Pre-register the offline gate:

- qo04 post-cap delivery: baseline 0/5; candidate must reach 5/5;
- all other questions: no delivery regression;
- candidate must extract both bare filenames and move the centre away from seq 55 in 5/5 qo04 rows;
- no returned payload may exceed that row's recorded headroom;
- print one full baseline/candidate qo04 call pair and inspect the actual text around the answer literal.

This probe uses **0 live tokens**, covers **25 paired rows**, directly tests a **five-attempt** opportunity within the **13-attempt** at/before-delivery bucket, and could explain **5/18 = 27.8%** of the current ceiling gap. It is higher-information than a 75-run live three-arm batch because it can kill the candidate or expose append-cap loss before spend. Passing it authorizes—but does not replace—a fresh same-invocation live cell at W=65,536 with `truncate-tail`, unchanged `tree-tail-v2`, and the one-change filename candidate, five questions × five replicates per arm (**75 scheduled attempts**). The live win criteria are: candidate qo04 delivery 5/5, no per-question delivery regression, and unconditional provenance-audited success strictly above both same-invocation baselines. A delivery win without a score gain is a bucket win and headline-inert, not completion of the native-context goal.

## Independently reproduced checks

- Provenance audit: 200 raw successes became 195; five were unearned, and six earned-fetch successes scored although the served band lacked the literal.
- Scoped deep tree cell: 7/25 success, 24/25 completed, 111 turns, 561,937 fresh-input tokens, 62,823 output tokens, and 6,292,224 cache-read tokens.
- Second deep tree epoch: 7/25 success, 23/25 completed, 106 turns, and 460,389 fresh-input tokens; its differing fingerprint confirms that pooling the two batches is not same-epoch evidence.
- Full-transcript ceiling: 25/25 success and 25/25 completed.
- Deep raw-tail proxy at W=131,072: 0/25 success and 21/25 completed; this is not paired with the W=65,536 tree cell.
- Fixture manifest: 754 L0 events. Deep question answer sequences are 151, 18, 264, 218, and 193.
- No live-token calls were made for this synthesis.
