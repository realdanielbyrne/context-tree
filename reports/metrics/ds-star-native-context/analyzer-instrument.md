## Evidence checked

- Read the DS-STAR Mode 1 discipline and the requested report section, especially [ds-star-delivery-pass-report.md](/Users/danielbyrne/GitHub/rpm/context-tree/reports/metrics/ds-star-delivery-pass-report.md:623).
- Inspected:
  - [delivery-killgate.mjs](/Users/danielbyrne/GitHub/rpm/context-tree/eval/scripts/delivery-killgate.mjs:57)
  - [provenance-audit.mjs](/Users/danielbyrne/GitHub/rpm/context-tree/eval/scripts/provenance-audit.mjs:90)
  - [pipeline-decomposition.mjs](/Users/danielbyrne/GitHub/rpm/context-tree/eval/scripts/pipeline-decomposition.mjs:48)
  - `runArms`, result naming, headers, and row writes in [transplant.mjs](/Users/danielbyrne/GitHub/rpm/context-tree/eval/scripts/transplant.mjs:4020)
  - `runOneReplicate` live headroom and row telemetry in [transplant.mjs](/Users/danielbyrne/GitHub/rpm/context-tree/eval/scripts/transplant.mjs:3796)
  - `fetchBranch` narrowing in [retriever.ts](/Users/danielbyrne/GitHub/rpm/context-tree/packages/core/src/retrieve/retriever.ts:273).
- Zero-token reproductions:
  - Provenance: reproduced `200 -> 195`, with six fetched-but-reconstructed-as-not-delivered successes.
  - Pipeline: reproduced `SELECTED 16/25`, `DELIVERED 12/25` loose, `11/25` strict, `SCORED 7/25`.
  - Delivery gate: reproduced `115/145`, `qo04 0/30`, exit 1.
  - Direct scoped replay of the standalone W=65,536 `tree-tail-v2` file gave qo04 spans `55–80` for all five selected runs while the answer is at seq 218.
  - The zero-token `G7-tool-call-logging` check does not run: it aborts because `"g7 question"` is below the current 20-character question minimum.

The three published script outputs reproduce on this machine, but “runnable cold” is not true for a fresh clone: the required store, result files, and compiled `dist` are gitignored, as the report itself concedes at lines 669–672.

## Instrument defects

1. **`delivery-killgate` does not measure one experiment cell.**  
   `loadRecordedRuns` reads every top-level result matching the question-set suffix and discards window, model, arm, code fingerprint, and file identity ([lines 57–79](/Users/danielbyrne/GitHub/rpm/context-tree/eval/scripts/delivery-killgate.mjs:57)). Its denominator is therefore neither same-epoch nor equal-n.

2. **Its “received the answer” label is false.**  
   For every row it counterfactually fetches `question.node_id`, even when that run fetched another branch ([lines 109–123](/Users/danielbyrne/GitHub/rpm/context-tree/eval/scripts/delivery-killgate.mjs:109)). This is a conditional delivery ceiling—“would the correct branch deliver?”—not observed run delivery. For example, it says qo02 is `30/30` although the scoped baseline selected qo02 `0/5` and delivered `0/5`.

3. **It uses the wrong token unit.**  
   It passes model-token headroom directly as `fetchBranch.maxTokens` ([line 122](/Users/danielbyrne/GitHub/rpm/context-tree/eval/scripts/delivery-killgate.mjs:122)). The live path converts it with `Math.floor(live / budgets.ratio)` ([transplant.mjs:3927](/Users/danielbyrne/GitHub/rpm/context-tree/eval/scripts/transplant.mjs:3927)); provenance and pipeline perform that conversion.

4. **Existing rows cannot reconstruct the bytes actually served.**  
   `searchQueries` and `fetchedIds` are flat lists, while the handler uses the last search preceding each fetch. Turn records retain only tool names. Headroom is reconstructed from turn 1 rather than captured per append, and truncation is aggregated across calls. All 16 scoped rows that selected the correct branch have `resultsTruncated > 0`, but the artifacts cannot identify which result was cut or whether the literal survived.

5. **The proposed “centre seq from spans” is overclaimed.**  
   `FetchedBranch.spans` reports the final band, not the `centerSeq` chosen by `findRelevantCenter`. Uneven event sizes make the span midpoint an unreliable proxy.

6. **One proposed candidate is already the baseline.**  
   The current retriever already chooses the last event at the highest weighted score in `findRelevantCenter` ([retriever.ts:532–582](/Users/danielbyrne/GitHub/rpm/context-tree/packages/core/src/retrieve/retriever.ts:532)). “Centre on the highest-scoring event rather than the first match” therefore cannot fire and must not consume a batch.

7. **The guard for the missing telemetry is itself stale.**  
   `checkG7ToolCallLogging` expects `r.toolCalls`, per-call headroom, `literalInToolResult`, and `zoneCTokens` ([transplant.mjs:2153](/Users/danielbyrne/GitHub/rpm/context-tree/eval/scripts/transplant.mjs:2153)), but `runOneReplicate` returns none of them ([transplant.mjs:3994](/Users/danielbyrne/GitHub/rpm/context-tree/eval/scripts/transplant.mjs:3994)). It currently dies even earlier on the short fixture question.

8. **Headers cannot establish a portable epoch.**  
   Result names omit reps, stratum, candidate parameters, and epoch ([transplant.mjs:4100](/Users/danielbyrne/GitHub/rpm/context-tree/eval/scripts/transplant.mjs:4100)). Headers record only budgets, two source hashes, Git HEAD, and costs; they omit question/store hashes, effective config, resolved compiled-code hash, provider/model revision, and invocation options. Several historical files have no `code` field at all.

## Numbered kill gates

1. **Artifact/epoch gate:** require an explicit result file, `partial:false`, exactly five rows per question per arm, one model/window/question set, matching code/config/store/question hashes, and runtime `dist` fingerprint. Print the resolved header.
2. **Ordered telemetry gate:** repair and run `G7-tool-call-logging`. It must exercise search then full fetch and summary fetch, and print one complete tool-call record. No live batch while it throws or any expected field is absent.
3. **Fixture gate:** for each question, print branch size, answer seq, answer presence, live heuristic budget, whether narrowing is eligible, and whether the candidate mechanism can fire. qo04 must be eligible in all five scoped baseline replicates.
4. **Delivery-artifact gate:** print, for one qo04 call, the exact preceding query, branch ID, exact and heuristic headroom, narrowing strategy/center, returned spans, post-cap bytes/tokens, dropped bytes, and literal-present-after-cap. A Boolean without this sample is insufficient.
5. **Mechanism gate:** baseline and candidate must differ on the intended field only; candidate telemetry must show a non-zero action in all qo04 rows. The already-shipped highest-score policy fails this gate as a candidate.
6. **Paired-cell gate:** baseline and candidate must be emitted by one invocation, with equal `n >= 5`, unique output identity, and identical frozen substrate. Any instrument or harness edit invalidates all old baselines.
7. **Native-comparison gate:** define an operational native arm. Small-window `naive-full` is hard-coded to one question/one replicate ([transplant.mjs:4131](/Users/danielbyrne/GitHub/rpm/context-tree/eval/scripts/transplant.mjs:4131)), so it cannot support the requested equal-n “beats native context” claim. Use same-window `truncate-tail` as native window management or change this precondition behavior before claiming superiority.

## Mechanism telemetry

The smallest trustworthy instrumentation change is one ordered per-tool-call trace captured in `runOneReplicate`, replacing flat lists and aggregate truncation as the authoritative source. Each record should contain:

```text
turn, callIndex, name, input
exactHeadroom, heuristicHeadroom
searchQueryAtFetch, branchId
narrowingStrategy, centerSeq, returnedSpans
beforeChars/tokens, afterChars/tokens, droppedChars/tokens
answerLiteralPresentAfterCap
```

Rows should additionally record the effective retrieval limit and a candidate-specific `mechanismFired`/`bandsReturned`. The gate must print a sample record, not merely a pass bit. This is the minimum needed to distinguish “candidate had no effect,” “correct branch selected but wrong band,” and “right band returned but append cap removed the answer.”

## Candidate verification design

Do not run either report candidate yet.

After the telemetry gate passes, use the diagnosis to define exactly one centring change behind a distinct arm. The “highest-scoring event” option is dead because it is already shipped. If the ordered artifact confirms that one contiguous band is the binding mechanism, the viable isolated candidate is a multi-band policy with the same total `maxTokens`; ranking, search limit, prompt, tools, and reply policy remain byte-identical.

Run one invocation at W=65,536 with:

- operational native baseline: `truncate-tail`
- current algorithm: `tree-tail-v2`
- candidate arm: distinct ID encoding the policy
- GLM 5.3 Flash
- five questions × five replicates per arm
- same frozen store/question set/code epoch

Primary mechanism criterion: qo04 literal-after-cap changes from `0/5` to `5/5`, `bandsReturned > 1` proves the mechanism fired, and no other question’s delivery count regresses. Headline uses mean bounded score and must strictly beat both same-invocation baselines; input tokens are reported alongside it. Pre-register one equal-n escalation before running if the headline difference is too small for the chosen minimum detectable effect.

## One quantified claim

The published `115/145` is not a valid cell: its 145 rows are pooled from six file/arm cells across three windows and at least three epoch states:

- 20 W=131,072 oracle rows
- 25 W=98,304 oracle rows
- 25 W=65,536 oracle rows
- 25 W=65,536 hit-keyword rows
- two separate 25-row W=65,536 `tree-tail-v2` batches with different `transplant.mjs` fingerprints

The scoped standalone W=65,536 baseline instead replays as `12/25` delivered loose, `11/25` delivered strict, and `7/25` scored—and even those delivery counts remain approximate until ordered post-cap telemetry lands.

No files were edited and no live tokens were used.
