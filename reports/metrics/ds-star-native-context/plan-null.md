# Null-hypothesis plan: establish the comparison before changing retrieval

## Position

The smallest honest change is no algorithm change yet. The current evidence establishes a diagnostic 18-attempt gap from `tree-tail-v2` at 7/25 to the full-transcript ceiling at 25/25, split into 13 failures at or before delivery and five after delivery. It does not establish a gap to native context: the deep fixture has no clean same-window, same-epoch `tree-tail-v2` versus `truncate-tail` cell, and the only paired real-arm overflow cell audits to a 0/25–0/25 tie. In addition, the persisted rows cannot reconstruct ordered tool calls or final post-cap bytes, so they cannot support an algorithm verdict.

The queue therefore repairs and validates measurement first, measures the unchanged algorithm second, and authorizes one algorithm candidate only if the measured null fails. This costs more attempts than immediately putting a candidate in a three-arm batch, but it answers the decision-controlling question without assuming a defect needs a repair.

The primary outcome throughout is unconditional, provenance-audited exact-match successes divided by all scheduled attempts. Stalls stay in the denominator. Delivery, centring, and selection are mechanism measures, not substitutes for task success. The claim remains limited to the frozen deep-overflow fixture and the same-window raw-tail native proxy; it is not a general claim about the repo's stronger end-to-end `native` arm.

## Queue ranked by information gained per token

| Rank | Queue item | Live cost | Decision bought |
| ---: | --- | ---: | --- |
| 1 | Repair the instrument and replay the unchanged path offline | 0 live tokens | Determines whether any later delivery or score result is attributable; can also kill the filename hypothesis before spend. |
| 2 | Measure the null: unchanged `tree-tail-v2` versus `truncate-tail` | 50 attempts initially; about 8.34M processed tokens from historical 25-attempt arm totals | Establishes whether the existing algorithm already clears the only defensible native-proxy claim. |
| 3 | If and only if the null fails, test bare-filename fingerprints | 75 attempts initially; about 15.26M processed tokens from historical arm totals | Tests one demonstrated five-attempt opportunity within the 13-attempt at/before-delivery bucket. |

The token figures are planning estimates, not evidence: the 6,916,984-token tree total comes from the standalone W=65,536 deep cell, while the 1,421,479-token proxy total comes from the W=65,536 overflow cell in another epoch. “Processed” is fresh input plus cache reads plus output. The repaired rows must replace these estimates with actual same-cell values.

## 1. Repair and validate the instrument; keep retrieval unchanged

This is an epoch-shifting measurement change, not an algorithm candidate. Land it before producing any baseline that a later verdict may use.

1. Freeze and emit the selected question-file SHA, store/trace/config/root hashes, Git and compiled-runtime fingerprints, effective configuration, resolved model identifier/revision when available, invocation options, candidate identity, and `partial:false`.
2. Give every parameterized arm a unique output identity, and key verdict cells by question hash and code epoch as well as model, window, arm, and stratum.
3. Replace the flat `searchQueries`, `fetchedIds`, and aggregate truncation fields as the authoritative record with an ordered per-tool-call trace containing turn/call index, input, exact and heuristic headroom, preceding search query, branch ID, narrowing strategy, true `centerSeq`, returned spans, before/after bytes and tokens, dropped amount, and answer-literal presence after the append cap.
4. Repair G7 with a valid question. It must exercise search, full fetch, and summary fetch, and print one complete record rather than only a pass bit.
5. Revalidate the deep fixture at W=65,536: all five answers are absent from the `truncate-tail` payload, the rank gate is at least 4/5, and qo04 is narrowing-eligible in all five baseline replicates.
6. Replay the 25 scoped historical `tree-tail-v2` rows with the unchanged algorithm and exact ordered query, branch, exact-to-heuristic conversion, and append cap. Print and inspect one full qo04 call, including the served text around the expected literal.

**Kill gate:** no live batch may start if any required hash/field is absent, G7 does not exercise all required tool paths, the fixture property fails at W=65,536, rank is below 4/5, qo04 is not narrowing-eligible 5/5, or the printed artifact cannot prove whether the literal survived the cap. Fixing a failed gate creates a new epoch and invalidates prior baselines.

**Stop condition:** if the instrument cannot produce ordered final-delivery evidence, stop. No retrieval policy is justified because the 13-attempt bucket remains inseparable.

## 2. Measure the null before authorizing an algorithm change

Run one invocation with only the operational native proxy `truncate-tail` and unchanged `tree-tail-v2` at W=65,536, on the frozen five-question deep fixture, using the same resolved model and revision. Run five replicates per question per arm: 2 arms × 5 questions × 5 replicates = 50 scheduled attempts. Arm execution must be interleaved or otherwise shown not to confound the comparison with time/order; all frozen identities must match.

Pre-register these gates and outcomes:

- Both arms emit exactly 25 rows with `partial:false`; provenance audit accepts every counted success.
- The instrument and fixture gates from item 1 still pass in this invocation.
- Report per-question and overall success, completion/stalls, fresh input, cache reads, output, turns, selection, final post-cap delivery, and mechanism samples.
- The null clears the scoped goal only when unchanged `tree-tail-v2` has strictly more unconditional provenance-audited successes than same-cell `truncate-tail`, with no question's apparent success attributable to absent evidence. This supports only the named fixture/proxy claim.
- A tree delivery advantage without a task-success advantage is bucket evidence, not a win.

**One capped escalation:** if n=5 yields no signal—a tie or a small overlapping result rather than a clear regression—add exactly five replicates per question to both arms in the same frozen epoch, for cumulative n=10. This adds 50 attempts and approximately 8.34M processed tokens; the null cell is capped at 100 attempts and approximately 16.68M processed tokens total. Do not escalate a provenance failure, gate failure, or clear tree regression.

**The measured failure that makes more than null necessary:** more than the null is justified only if the unchanged tree is clearly below the proxy at n=5, or if it fails to strictly exceed the proxy after the one equal-n escalation to n=10. A failed instrument, invalid fixture, or ambiguous result at the cap does not make an algorithm necessary; it leaves the comparison unresolved. If the unchanged tree strictly wins, stop and report the scoped win rather than building a repair merely because one looked plausible offline.

## 3. Contingent algorithm candidate: bare-filename fingerprints

Run this item only after item 1 passes and item 2 produces the measured failure above.

**Exactly one change.** Add one syntax-derived extractor for bare dotted filenames beside the existing fingerprint forms, without double-counting basenames already contained in recognized paths. Keep selection/ranking, per-field weighting, late-tie behavior, one contiguous band, total retrieval budget, prompt, tools, and reply policy unchanged.

**Target bucket.** Target the at-or-before-delivery bucket, specifically qo04: current scoped evidence selects its branch 5/5 but reconstructs final delivery as 0/5, while the answer is at seq 218 and current centring repeatedly chooses seq 55. This is a five-attempt opportunity within the 13-attempt delivery-side residual, not a promise of five score gains.

**Arm and flag.** Add a new explicit flag `--centering-bare-filenames` and encode it in the result identity as `tree-tail-v2+bare-filename`. Flag off must be byte-identical to `tree-tail-v2`; it must not silently become the default during the pass.

**Required mechanism telemetry.** In addition to the ordered record from item 1, emit `extractedBasenames`, `mechanismFired`, baseline and candidate `centerSeq`, `centerDelta`, returned spans, post-cap literal presence, and any headroom breach. For qo04, the candidate must show both basenames extracted and a changed centre; `q.seq` remains fixture truth for gates only and is never an algorithm input.

**Zero-live-token kill gate.** Before the batch:

1. Replay all 25 scoped deep rows, paired baseline/candidate, with recorded ordered calls and exact budgets.
2. Require qo04 post-cap delivery to move from baseline 0/5 to candidate 5/5.
3. Require both basenames to be extracted and the centre to move away from seq 55 in all five qo04 rows.
4. Require no other question's delivery to regress and no payload to exceed its row's recorded headroom.
5. Print and inspect one complete baseline/candidate qo04 pair and the actual text around the answer literal.
6. Add a synthetic fixture with an early duplicated generic `JSONL` event and a later event containing both filenames; require the later event to win.

Any failure kills the live candidate. In particular, a changed centre without final post-cap delivery means centring alone is not the binding repair and does not authorize spending on this arm.

**Same-epoch, equal-n batch.** In one invocation run `truncate-tail`, unchanged `tree-tail-v2`, and `tree-tail-v2+bare-filename` at W=65,536 on the same frozen deep question set, model/revision, store, config, and instrument epoch. Use five questions × five replicates × three arms = 75 scheduled attempts. Rerun both baselines even if item 2 used the same nominal settings, because adding the flagged algorithm changes the code fingerprint.

**Win criterion.** The candidate must satisfy all of the following:

- qo04 final post-cap delivery is 5/5 and `mechanismFired` is true 5/5;
- no other question loses a delivered attempt relative to unchanged tree;
- unconditional provenance-audited exact-match success is at least 4/25 above unchanged tree, preserving the report's near-term improvement magnitude;
- unconditional provenance-audited success is strictly above same-cell `truncate-tail`;
- every counted success has inspectable delivered provenance.

A delivery win without the four-success headline gain is recorded as a bucket win/headline-inert result, not evidence for the native-context goal.

**One capped escalation and cost.** If all mechanism criteria pass and there is a positive but sub-threshold headline signal consistent with sampling noise, add exactly five replicates per question to all three arms, for cumulative n=10. This adds 75 attempts and approximately 15.26M processed tokens; the candidate experiment is capped at 150 attempts and approximately 30.51M processed tokens total. Do not escalate a kill-gate failure, mechanism failure, task regression, or provenance failure. If the full win criterion still fails at the cap, retire bare-filename extraction as the goal-level candidate while preserving any verified centring/delivery finding.

## What is deliberately not queued

- “Choose the highest-scoring event rather than the first match” cannot fire because current source already selects the last event at the highest weighted score.
- Per-event term credit is not queued: its 29/30 pooled replay is driven by an accidental late tie rather than identification of the answer event.
- Multi-band retrieval is not queued. It introduces band count and allocation choices before trustworthy telemetry shows that a correctly centred single band still loses the answer. Only a measured candidate trace with correct centring and failed post-cap delivery would justify designing that separate, one-change experiment.
- No end-to-end `native` superiority claim is in scope. A proxy win would need a later representative, same-epoch end-to-end comparison before supporting that broader statement.

## Evidence basis

This plan uses the reconciled [gap model](./gap-model.md) and the three independent analyses: [baseline](./analyzer-baseline.md), [delivery](./analyzer-delivery.md), and [instrument](./analyzer-instrument.md). No live-token calls were made for this plan.
