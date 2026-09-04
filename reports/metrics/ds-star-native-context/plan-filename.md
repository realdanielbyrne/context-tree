# Mechanism-first candidate plan: filename centring

## Scope and decision boundary

This is a DS-STAR Mode 1 planner artifact. It proposes an experiment queue; it does not authorize implementation or live-token use. The measured diagnostic gap is `18/25`: the W=65,536 `tree-tail-v2` cell scored `7/25`, while the W=200,000 full-transcript ceiling scored `25/25`. The reproducible loose decomposition is `13/25` lost at or before delivery plus `5/25` lost after delivery. The only directly demonstrated candidate opportunity is qo04: correct branch selected `5/5`, answer delivered `0/5`, score `0/5` in the scoped tree cell.

The filename diagnosis is the best first hypothesis, not an established candidate verdict. Bare dotted filenames disappear from query fingerprints; generic `JSONL` then gives an early event at seq 55 duplicate field credit, while the answer is at seq 218. However, the impressive filename replay (`0/30` to `30/30`) pools six cells, several windows, and multiple code epochs, counterfactually fetches the known-correct branch, and was not persisted as a first-class result. Existing rows also cannot prove what survived the append cap. The first experiment must therefore try to kill filename centring on the scoped 25-row cell before spending tokens.

Terminology is deliberately narrow:

- `truncate-tail` is the **same-window native-context proxy**: a flat, one-turn prompt containing the newest raw events that fit W, without retrieval tools.
- `naive-full` at W=200,000 is a **full-transcript ceiling**, not a same-window native baseline.
- `native` in [loop.ts](/Users/danielbyrne/GitHub/rpm/context-tree/eval/src/loop.ts:344) is the **actual end-to-end native arm**: a growing multi-turn transcript, normal harness tools, and optional native prefix caching.

A transplant win may support only “higher provenance-audited exact-match recall than the same-window raw-tail native proxy on the frozen deep-overflow fixture.” It cannot support “context-tree beats native context.” That requires a later same-epoch, equal-n comparison against the actual end-to-end `native` arm on representative tasks and trace sizes.

## Epoch-changing prerequisites for every candidate

These are measurement repairs, not candidate mechanisms. Land them before generating any baseline or candidate row, then freeze the resulting epoch. Do not reuse the historical `7/25` as a scored control.

1. **Freeze the cell.** Record `partial:false`; selected question-file SHA; trace, store, config, and root hashes; Git and compiled-runtime fingerprints; effective configuration; model identifier/revision when available; invocation options; and candidate identity. Give every parameterized arm a collision-free result name.
2. **Repair ordered delivery telemetry.** Persist each tool call in order with turn/call index, input, preceding search query, branch, exact and heuristic headroom, narrowing strategy, true `centerSeq`, spans, before/after bytes and tokens, dropped amount, and answer-literal presence after the append cap. `centerSeq` must be captured, not inferred from a span midpoint.
3. **Repair and execute G7 at zero live tokens.** Use a valid question of at least 20 characters; exercise search, full fetch, and summary fetch; require every expected field; print and inspect one complete record.
4. **Audit the fixture at W=65,536.** Every answer must be absent from the `truncate-tail` payload, the deep rank gate must remain at least `4/5`, and qo04 must be narrowing-eligible in every incumbent replicate. Print the artifact, not only pass bits.
5. **Isolate verdict cells.** Key aggregation by question hash and code epoch in addition to model, window, arm, and stratum. Do not use the current `runVerdict` grouping until this is true.

Failure of any prerequisite stops all three candidates before live spend. Any repair after rows exist starts a new epoch and invalidates those rows for comparison.

## Ranked candidates

### 1. Extract bare-filename fingerprints

**Why first.** This is the smallest change matched to the observed causal chain. It restores the two discriminative terms that the query already contains and adds no window-, tokenizer-, or task-length constant. Its maximum demonstrated opportunity in the scoped cell is five attempts, or `5/18 = 27.8%` of the gap to the ceiling. The expected score gain is lower than five because delivered context need not convert one-for-one to a correct answer.

**One change.** Extend query fingerprint extraction with one syntax-derived bare-filename rule. Do not emit a basename already contained in a recognized slash path. Keep event scoring, late tie-breaking, one-band growth, total retrieval budget, hit ranking, prompts, tools, and reply policy unchanged.

**Target bucket.** The `13/25` at-or-before-delivery bucket, specifically qo04’s five selected-but-undelivered attempts.

**Distinct arm/flag.** Candidate arm `tree-filename-fp-v1`; incumbent `tree-tail-v2`; proxy `truncate-tail`. The result identity must include `centering=filename-fp-v1` so no sweep can overwrite another arm.

**Zero-token mechanism proof.** Replay the incumbent and candidate over only the 25 rows in the standalone W=65,536 deep tree artifact, using each row’s ordered observed search/fetch pair, selected branch, exact-to-heuristic budget conversion, and append cap. This is 25 paired records, or 50 deterministic arm-row evaluations. For each qo04 row, require both filenames to be newly extracted, `centerSeq` to move away from 55 to the answer-bearing neighborhood, seq 218 to be inside the returned span, and the literal to survive the append cap. All other questions must retain delivery. Print one full baseline/candidate qo04 pair and inspect the text surrounding the literal. Add a synthetic duplicate-`JSONL` fixture in which a later event containing both bare filenames must beat the early generic event.

**Mechanism-fired telemetry.** `extractedFingerprints`, `newBareFilenames`, `duplicateBasenamesSuppressed`, `baselineCenterSeq`, `candidateCenterSeq`, `centerChanged`, `returnedSpans`, `answerSeqInSpan`, `literalPresentAfterCap`, and `mechanismFired`. `mechanismFired` is true only when at least one new basename changes the scored terms and the chosen center.

**Kill criteria.**

1. Kill before replay if candidate and incumbent differ anywhere beyond fingerprint extraction or if path basenames receive duplicate query weight.
2. Kill before live spend if either qo04 filename is not extracted in any of the five scoped queries, the center is unchanged in any row, or seq 218/literal-after-cap is not `5/5`.
3. Kill before live spend if any non-qo04 question loses delivery or any returned payload exceeds its recorded headroom.
4. Kill the filename hypothesis, while retaining the miscentring observation, if inspected payloads show the center moved correctly but the append cap still removes the literal. Route that finding to candidate 3; do not describe it as evidence against the original seq-55 diagnosis.
5. Kill after the initial live batch if mechanism firing is below `5/5`, qo04 post-cap delivery is below `5/5`, any other question regresses in delivery, or unconditional score is no better than the incumbent. Do not escalate a mechanism failure.

**Same-epoch equal-n batch.** In one frozen invocation at W=65,536 on `questions-deep.json` and the named GLM 5.3 Flash revision, run `truncate-tail`, `tree-tail-v2`, and `tree-filename-fp-v1`, with five questions × five replicates per arm: 25 attempts/arm, 75 scheduled attempts total. Preserve stalls in the denominator. Report unconditional provenance-audited exact-match mean/success count, per-question success, delivery, completion/stalls, turns, fresh input, output, cache reads, and mechanism fields.

**Win criterion.** First, qo04 literal-after-cap must improve from incumbent `0/5` to candidate `5/5`, with no per-question delivery regression. Second, candidate unconditional provenance-audited success must exceed `tree-tail-v2` by at least `4/25` and must strictly exceed `truncate-tail` in the same invocation. A delivery win without the score thresholds is a bucket win/headline-inert result, not completion of the proxy or native-context goal.

**One capped escalation.** If every mechanism criterion passes and the candidate beats the incumbent by `1–3/25` (positive but below the pre-registered `4/25` target), append exactly five replicates per question to **all three arms** in the same frozen epoch. This yields n=10/question, 50 attempts/arm, 150 cumulative attempts. The scaled win threshold is at least `8/50` over the incumbent plus a strict win over the proxy. No second escalation; a `0/25` or negative initial headline delta retires the candidate without more spend.

**Estimated runs, tokens, and cost.** Offline: 50 deterministic evaluations, zero live tokens, $0. Initial live batch: 75 attempts. Using the historical deep tree cell twice and the W=65,536 proxy usage as a planning proxy gives about 1.86M fresh-input, 0.151M output, and 13.25M cache-read tokens, or 15.26M processed tokens total. The historical 25-run tree cell cost $0.152234; conservatively budgeting that amount for each of three arms gives at most about **$0.46** for the initial batch. The capped cumulative maximum is 150 attempts, about 30.51M processed tokens and **$0.92**. These are budgeting estimates, not comparable evidence; freeze and report the provider price sheet at execution time.

### 2. Credit each fingerprint once per event

**Why second.** This challenges the filename-specific explanation. It targets the other demonstrated part of the seq-55 mechanism: `JSONL` scores twice at the distractor because it appears in two fields. The pooled replay reached `29/30`, but mostly by creating a tie that the existing late-tie rule resolves to seq 235; it still fails the lowercase query and does not identify the answer event. That makes it less portable and less causally convincing than candidate 1.

**One change.** For a given event and query fingerprint, award the fingerprint’s weight at most once across `blob`, `args_blob`, and `output_blob`. Keep extracted terms, term weights, event tie-breaking, band allocation, budgets, prompts, and tools unchanged.

**Target bucket.** The same `13/25` at-or-before-delivery bucket, with a scoped maximum opportunity of five qo04 attempts.

**Distinct arm/flag.** Candidate arm `tree-event-credit-v1`, result identity `centering=event-credit-v1`.

**Zero-token mechanism proof.** On the scoped 25-row replay and a synthetic early-duplicate fixture, compare per-event score ledgers. Require seq 55’s duplicate `JSONL` contribution to fall from two field credits to one, `centerSeq` to change in all five qo04 rows, seq 218 to fall inside the returned spans, and the literal to survive the append cap `5/5`. Explicitly include the lowercase-`jsonl` query. Print the score ledger and payload for that row. A move to seq 235 counts as mechanism firing but not as a robust proof unless the resulting payload contains the literal under every recorded scoped headroom.

**Mechanism-fired telemetry.** `matchedTermsByField`, `creditsBeforeDedup`, `creditsAfterDedup`, `duplicateCreditsSuppressed`, per-event score ledger, `centerSeq`, `centerChanged`, `answerSeqInSpan`, and `literalPresentAfterCap`.

**Kill criteria.**

1. Kill if the change alters query extraction, weights, late tie-breaking, or budgets in addition to per-event credit.
2. Kill before live spend if no duplicate credit is suppressed in any qo04 row or if the lowercase row remains unchanged.
3. Kill before live spend unless qo04 literal-after-cap reaches `5/5` on the scoped replay with no delivery regression elsewhere; `29/30` on the pooled artifact is insufficient.
4. Kill as nonportable if success depends on a late unrelated tie at seq 235 and fails at any scoped recorded headroom.
5. Kill after the initial live batch on mechanism firing below `5/5`, qo04 delivery below `5/5`, any other delivery regression, or a non-positive score delta versus incumbent. Do not escalate a mechanism failure.

**Same-epoch equal-n batch.** Only if candidate 1 is killed offline or fails its mechanism gate, run `truncate-tail`, `tree-tail-v2`, and `tree-event-credit-v1` together at W=65,536, five questions × five replicates per arm: 75 attempts. A new implementation or telemetry edit creates a new epoch, so rerun both controls rather than borrowing candidate 1’s baseline.

**Win criterion.** Identical to candidate 1: qo04 post-cap delivery `5/5`, no delivery regression, candidate score at least `4/25` above the same-cell incumbent, and a strict score win over the same-cell proxy.

**One capped escalation.** Identical and independent: only a mechanism-clean positive `1–3/25` initial delta permits five additional replicates/question for every arm, reaching 150 cumulative attempts and requiring at least `8/50` over incumbent plus a proxy win. No second escalation.

**Estimated runs, tokens, and cost.** Offline: 50 deterministic evaluations, zero live tokens, $0. Initial live: 75 attempts, approximately 15.26M processed tokens and at most about $0.46. Capped cumulative: 150 attempts, approximately 30.51M processed tokens and $0.92, repriced at the frozen execution-time rates.

### 3. Return two disjoint bands under the existing fetch budget

**Why third and conditional.** This is a hedge against uncertain centring, not the direct repair. It introduces a band-count and allocation policy, and current evidence says the true qo04 event ranks well below the early generic match; a second band may therefore omit it. Run it only if ordered telemetry confirms that append-safe disjoint coverage—not missing fingerprints—is binding. Otherwise retire it unspent.

**One change.** Replace one contiguous narrowed band with the top two non-overlapping score-centered bands, splitting the existing `maxTokens` budget between them. Total retrieval budget, query fingerprints, event scores, hit ranking, prompts, tools, and reply policy remain fixed. The fixed `2` is an explicit candidate constant to retire if the proof shows the second band cannot cover the answer-bearing region.

**Target bucket.** The `13/25` at-or-before-delivery bucket, specifically wrong-band or append-cap loss after the correct branch is selected. Its scoped ceiling is five qo04 attempts; there is no evidence yet that all five are reachable by the second-ranked band.

**Distinct arm/flag.** Candidate arm `tree-two-band-v1`, result identity `band-policy=top2-fixed-budget-v1`.

**Zero-token mechanism proof.** Replay the scoped 25 rows with exactly the recorded total heuristic budget and append cap. Require `bandsReturned=2` for all narrowing-eligible qo04 rows, non-overlap, combined tokens no greater than incumbent `maxTokens`, seq 218 in one band, and literal-after-cap `5/5`, with no delivery regression elsewhere. Print both bands before and after the append cap. Also report the answer event’s score rank; if it is not reachable as a top-two center, the candidate cannot fire and must die offline.

**Mechanism-fired telemetry.** `bandPolicy`, ranked candidate centers and scores, `bandsReturned`, tokens per band, combined tokens, overlap removed, returned spans, `answerBandIndex`, `answerSeqInSpan`, `literalPresentBeforeCap`, and `literalPresentAfterCap`.

**Kill criteria.**

1. Kill if the answer-bearing neighborhood is not among the top two eligible centers on every scoped qo04 row.
2. Kill if `bandsReturned` is not two, bands overlap, or combined usage exceeds the incumbent row’s retrieval budget.
3. Kill before live spend unless qo04 literal-after-cap is `5/5` and no other question loses delivery; presence before but not after the cap specifically refutes this allocation.
4. Kill if the policy requires changing fingerprint extraction, ranking, prompt, append cap, or total budget to pass—the result would no longer isolate multi-band allocation.
5. Kill after the initial live batch on mechanism firing below `5/5`, qo04 delivery below `5/5`, any other delivery regression, or non-positive score delta. Do not escalate a mechanism failure.

**Same-epoch equal-n batch.** Only after candidates 1 and 2 are retired and the ordered artifact supports this mechanism, run `truncate-tail`, `tree-tail-v2`, and `tree-two-band-v1` together at W=65,536, five questions × five replicates per arm: 75 attempts in a fresh frozen epoch.

**Win criterion.** qo04 post-cap delivery `5/5`, no delivery regression, candidate provenance-audited score at least `4/25` above the same-cell incumbent, and a strict score win over the same-cell proxy. A score win without `bandsReturned=2` and answer-band delivery is unattributed and cannot land.

**One capped escalation.** Only a mechanism-clean positive `1–3/25` delta permits five additional replicates/question for all arms, to 150 cumulative attempts. Require at least `8/50` over incumbent and a strict proxy win. No second escalation.

**Estimated runs, tokens, and cost.** Offline: 50 deterministic evaluations, zero live tokens, $0. Initial live: 75 attempts, approximately 15.26M processed tokens and at most about $0.46. Capped cumulative: 150 attempts, approximately 30.51M processed tokens and $0.92. Multi-band is expected to redistribute, not increase, retrieval tokens; any material token increase violates the isolated mechanism.

## Queue and routing recommendation

1. Land the epoch/instrument prerequisites and run only candidate 1’s scoped zero-token replay.
2. If candidate 1 clears every offline gate, run its 75-attempt same-epoch batch. Do not run candidates 2 or 3 merely to complete a matrix.
3. If candidate 1 fails because filenames do not move the center, try candidate 2 offline. If it moves the center only through the seq-235 tie, retire it rather than spending live tokens.
4. If candidate 1 centers correctly but the inspected final payload still loses the literal, use ordered telemetry to decide whether candidate 3 can cover seq 218 under the unchanged budget; otherwise re-decompose the at-or-before-delivery bucket.
5. If any candidate wins delivery but not score, record a `5/25` bucket recovery and a headline-inert result. The next pass should then target the `5/25` after-delivery bucket instead of tuning centring a third time.

No candidate here, even a clean win, validates actual end-to-end native superiority. The follow-on experiment for that broader claim must use [the real `native` loop arm](/Users/danielbyrne/GitHub/rpm/context-tree/eval/src/loop.ts:344), a frozen task set spanning trace sizes, identical model/window/tool availability where meaningful, same epoch, equal n, unconditional provenance-audited success, and token/turn/cache reporting.

## Evidence basis

- [Gap model](./gap-model.md)
- [Baseline analyzer](./analyzer-baseline.md)
- [Delivery analyzer](./analyzer-delivery.md)
- [Instrument analyzer](./analyzer-instrument.md)
- Current centring scorer: [retriever.ts](/Users/danielbyrne/GitHub/rpm/context-tree/packages/core/src/retrieve/retriever.ts:532)
- Transplant arms: [transplant.mjs](/Users/danielbyrne/GitHub/rpm/context-tree/eval/scripts/transplant.mjs:3650)

No live-token calls were made for this plan.
