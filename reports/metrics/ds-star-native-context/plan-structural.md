# Structural planner: native-context delivery gap

## Recommendation

Run the bare-filename fingerprint candidate first, but only after the measurement epoch is repaired. It is the only candidate whose proposed change directly matches the demonstrated mechanism: qo04's two discriminative dotted basenames are discarded, generic `JSONL` wins at seq 55, and the answer at seq 218 is outside every returned band. A syntax-derived basename rule makes the desired evidence available by construction and introduces no window, tokenizer, or task-length constant.

Keep per-event term credit as a zero-token falsification candidate, not as a presumptive repair. Its pooled replay delivered 29/30 qo04 cases only because an unrelated late event at seq 235 won a tie; it still missed the lowercase query and did not identify the answer event. Keep multi-band allocation third and conditional. It is justified only if ordered telemetry shows that a correctly chosen center still loses the literal during band construction or the append cap.

The current reproducible diagnostic gap is 18 attempts: `tree-tail-v2` scores 7/25 against the 25/25 full-transcript ceiling, split into 13 failures at or before delivery and five after delivery ([gap model](./gap-model.md)). This is not yet a same-window native-context verdict. The live comparison below uses `truncate-tail` as the operational same-window raw-tail proxy and makes only the narrow claim defined in the gap model.

## Common preconditions: establish one trustworthy epoch

These are instrument repairs, not scored candidates. Land them once before implementing or measuring any candidate; every old baseline becomes stale when they land.

1. Freeze and emit the selected question-file SHA, trace/store/config/root hashes, Git SHA, source and compiled-runtime fingerprints, effective configuration, model identifier/revision when available, invocation options, candidate identity, and `partial:false`. Give every parameterized arm a unique output name. Do not use the current `runVerdict` grouping until question hash and code epoch are cell keys.
2. Replace flat `searchQueries`, `fetchedIds`, and aggregate truncation as the authoritative record with one ordered record per tool call in `runOneReplicate` ([transplant.mjs:3796](/Users/danielbyrne/GitHub/rpm/context-tree/eval/scripts/transplant.mjs:3796)). Record turn/call index, input, preceding query, branch, exact and heuristic headroom, narrowing strategy and true `centerSeq`, returned spans, before/after characters and tokens, dropped amount, and answer-literal presence after the append cap. Candidate-specific fields named below extend this record.
3. Repair `G7-tool-call-logging` with valid questions. It must exercise search, full fetch, and summary fetch, and print one complete record. Inspect the record itself, not only its pass bit.
4. Audit `questions-deep.json` at W=65,536: every answer is absent from the exact `truncate-tail` payload; every answer literal exists in the frozen trace at the declared sequence; rank gate is at least 4/5; qo04 is narrowing-eligible in every incumbent replicate. Abort if the local gitignored store cannot be tied to the emitted store hash.
5. Use the live model-token-to-heuristic-token conversion in offline replay. Never pass model-token headroom directly to `fetchBranch.maxTokens`. Require returned text and final appended text to fit the recorded headroom.
6. Build each live cell in one invocation as question × replicate × arm with equal `n`; rotate the three-arm order cyclically by replicate so no arm always runs first or last. The rotation is derived from arm count and replicate index, not a random seed or a new tuning constant.
7. Before accepting a score, run the provenance audit and manually inspect every newly successful qo04 row: the cited event and answer literal must exist in the post-cap payload. Scheduled stalls remain in the denominator.

The common live design is W=65,536, the frozen five-question deep set, one model (`z-ai/glm-5.3-flash` for continuity), and three arms: `truncate-tail`, unchanged `tree-tail-v2`, and exactly one candidate. Initial `n=5` per question per arm is 75 scheduled attempts. Historical usage gives a planning estimate of 15,255,447 provider-reported processed tokens (fresh input + output + cache reads) and $0.375773: two tree-like 25-run arms at 6,916,984 tokens and $0.152234 each, plus one 25-run proxy arm at approximately 1,421,479 tokens and $0.071304. Dollars are derived at the repository's 2026-09-02 configured rates (`$0.075/M` fresh input, `$0.25/M` output, `$0.015/M` cache read); runs and tokens are primary. Candidate behavior can change turns, so budget 15–18 million tokens and $0.38–$0.44.

For every candidate, the only capped escalation is: if its mechanism criteria pass, all protected questions are non-regressed, and its unconditional score is above the incumbent but only by 1–3/25, add five replicates for every question in every arm in the same unchanged epoch. The cumulative design is `n=10`, 150 scheduled attempts, approximately 30.5 million processed tokens and $0.752 (budget ceiling $0.88). At `n=10`, preserve the target effect: candidate must beat incumbent by at least 8/50 and strictly beat `truncate-tail`. Do not escalate a zero/negative headline delta, a mechanism failure, a provenance failure, or a protected-question regression.

## Ranked candidates

| Rank | One measurable change | Target within the 13-attempt bucket | Information per run/token | Route |
| ---: | --- | --- | --- | --- |
| 1 | Extract bare dotted filenames as query fingerprints | Fingerprint loss → wrong center → missing payload | A 25-row paired replay costs zero live tokens and tests a scoped 5/25 opportunity; prior pooled replay moved qo04 0/30 → 30/30 | Implement after common gates; live only if all offline gates pass |
| 2 | Credit a query term at most once per event | Duplicate physical fields distort event score | Zero-token replay decisively separates a schema-layout bias from real relevance; likely to die before live spend | Falsification arm; no live run unless it centers on the actual evidence, not a nearby tie |
| 3 | Replace one contiguous band with budget-derived ranked disjoint bands | Correct candidates present but one-band allocation omits evidence | Can test the allocation ceiling offline under exactly the same total budget, but no current scoped artifact proves this bucket exists | Conditional fallback only after ordered telemetry establishes eligibility |

## Candidate 1: syntax-derived bare-filename fingerprints

**One change and arm.** Add a bare-filename recognizer beside `FILE_PATH_Q` in `extractQueryFingerprints` ([retriever.ts:625](/Users/danielbyrne/GitHub/rpm/context-tree/packages/core/src/retrieve/retriever.ts:625)). It recognizes a basename containing a dot and a nonempty name and extension. Do not emit a basename already contained in a recognized slash path or quoted/backticked fingerprint. Preserve term weights, per-field credit, late-sequence tie-breaking, one-band growth, total retrieval budget, prompts, tools, and reply policy. Expose only this policy as `retrievalFingerprintMode: 'legacy' | 'bare-filename'`; the scored arm is `tree-center-filename`, and the zero-token gate is `G8-bare-filename-centering`.

**Target bucket and mechanism.** This targets the fingerprint-loss part of the 13 at/before-delivery failures. The expected chain is observable at every edge: both qo04 basenames extracted → seq 218 receives their weighted matches → `centerSeq` changes from 55 to 218 → the returned band contains the answer → the final post-cap payload still contains it. The existing pooled replay's 0/30 → 30/30 is supporting evidence, not a verdict, because it pools windows and epochs.

**Offline mechanism proof and telemetry.** Replay baseline and candidate over only the 25 rows of the standalone W=65,536 deep cell, using each row's recorded query, selected branch, exact-to-heuristic conversion, and append cap. If the ordered query/branch pair cannot be reconstructed unambiguously from an old row, stop rather than substitute the pooled 145-row ceiling. Persist `extractedFingerprints` with source kind (`quoted`, `path`, `basename`, or identifier), `mechanismFired`, per-term event score contributions, baseline/candidate `centerSeq`, spans, rendered tokens, post-cap tokens, dropped tokens, and literal presence. Print one full qo04 pair and the answer-bearing text around seq 218.

**Numbered kill criteria.** No live tokens if any item fails:

1. The common epoch, telemetry, fixture, token-unit, and provenance gates pass and emit inspectable artifacts.
2. Both bare filenames are extracted in all 5/5 scoped qo04 rows, while a path such as `dir/name.ext` contributes only its existing path fingerprint and not a second basename weight.
3. `mechanismFired=true` and `centerSeq=218` in all 5/5 qo04 candidate rows; the incumbent remains at its independently reproduced center.
4. The candidate's qo04 answer literal is present after the append cap in 5/5 versus incumbent 0/5; each of qo01, qo02, qo03, and qo05 has no delivered-count regression.
5. Every returned and appended payload fits that row's recorded headroom, and manual inspection confirms the literal comes from the frozen event rather than fixture metadata.
6. Synthetic tests cover punctuation-adjacent basenames, a basename nested in a slash path, lowercase extensions, and two distinct dotted basenames against an earlier duplicate `JSONL` distractor. Any duplicate weighting or false extraction that changes an unrelated center kills the live batch.

**Same-epoch live win.** Run `truncate-tail,tree-tail-v2,tree-center-filename` together at `n=5` as defined above: 75 attempts, estimated 15–18 million processed tokens and $0.38–$0.44. The bucket win requires qo04 post-cap delivery 5/5 and no per-question delivery regression. The headline win additionally requires unconditional provenance-audited exact-match success at least 4/25 above same-invocation `tree-tail-v2` and strictly above `truncate-tail`. A delivery win without the score threshold is recorded as bucket-win/headline-inert. Apply the single common capped escalation only for a +1–3/25 headline delta.

**Portability, constants, and boundaries.** The rule derives from filename syntax and adds no model-, window-, tokenizer-, or task-fitted number. The minimum nonempty name/extension is grammar, not a tuned length. Existing nonportable behavior remains visible rather than being changed in this arm: the 8,192-character field prefix, English stop list, fallback length four, term ordering/weights, and three scanned blob fields. Untested boundaries are extensionless names, dotfiles, multi-dot names, Unicode filenames, punctuation and URL contexts, and a filename occurring beyond the scanned prefix. The implementation must define each case in tests or mark it unsupported; it must never use question `seq` or the answer literal as an algorithm input.

## Candidate 2: Boolean term credit per event

**One change and arm.** In `findRelevantCenter` ([retriever.ts:532](/Users/danielbyrne/GitHub/rpm/context-tree/packages/core/src/retrieve/retriever.ts:532)), replace per-field accumulation with one Boolean credit per `(event, query term)`: if a term appears in any of `blob`, `args_blob`, or `output_blob`, add its weight once to that event. Preserve fingerprint extraction, term weights, the scanned fields and prefix, late-sequence tie-breaking, one-band growth, and all budgets. Expose `retrievalTermCredit: 'per-field' | 'per-event'`; arm `tree-center-event-credit`; gate `G9-event-credit-centering`.

**Target bucket and mechanism.** This targets score distortion inside the at/before-delivery bucket. Its structural invariant is that copying the same text between storage fields cannot make an event more relevant. It does not solve missing filenames. The analyzer's 29/30 delivery replay is therefore a warning: it mostly selected seq 235 on a late tie and still failed the lowercase case. This candidate earns a live run only if the scoped evidence shows the invariant locates the actual answer event rather than benefiting from proximity.

**Offline mechanism proof and telemetry.** Use a synthetic pair whose semantic text is identical but whose generic term is stored in one field versus all three; both events must receive the same score in the candidate and different scores in the incumbent. Then replay the scoped 25 rows with identical query, branch, budget, and cap. Record, for each event considered, each term's weight, `matchedFields`, credited weight, ranked position, `centerSeq`, `mechanismFired`, spans, and post-cap literal presence. Print the seq 55, 218, and 235 score records so the gate artifact exposes whether success is causal or accidental.

**Numbered kill criteria.** No live tokens if any item fails:

1. All common gates pass.
2. Synthetic field duplication changes incumbent scores but cannot change candidate scores; a genuinely different term in another field still contributes normally.
3. `mechanismFired=true` in all scoped qo04 rows and the candidate selects `centerSeq=218` in 5/5. Selecting seq 235 and merely covering seq 218 fails this mechanism gate.
4. qo04 post-cap delivery is 5/5, including every lowercase-query variant present in the scoped cell; qo01, qo02, qo03, and qo05 have no delivery regression.
5. The candidate never exceeds recorded headroom, and the printed payload proves the answer came from seq 218.
6. If the exact replay reproduces the known pooled 29/30 pattern, retire the candidate as an accidental-proximity repair and journal both findings separately: field duplication is real, but per-event credit does not repair filename loss.

**Same-epoch live win.** Only after all six gates, run `truncate-tail,tree-tail-v2,tree-center-event-credit` at equal `n=5`: 75 attempts, estimated 15–18 million processed tokens and $0.38–$0.44. Require qo04 delivery 5/5 with no other delivery regression, candidate success at least +4/25 over incumbent, and candidate strictly above the proxy. Use the one common capped escalation only for +1–3/25; otherwise retire or declare the full win.

**Portability, constants, and boundaries.** This removes dependence on physical field duplication and adds no numeric constant. It still depends on the existing field list, 8,192-character scan prefix, query extractor, weights, English fallback, and late-event tie rule. It can under-credit independent corroboration repeated across fields, and it cannot help when no extracted term names the evidence. Test absent blob fields, the same blob reference reused across fields, one term across multiple fields, multiple different terms across fields, and events larger than the scan prefix. Unknown future event fields receive no credit until deliberately added; silently iterating every string field would change the semantic surface and is out of scope.

## Candidate 3: budget-derived ranked disjoint bands

**Eligibility condition.** Do not implement this candidate merely because multi-band retrieval is plausible. It becomes eligible only if ordered telemetry shows either (a) the correct answer event is a scored center candidate but one contiguous band omits it, or (b) candidate 1 selects seq 218 yet the post-cap payload loses the literal in at least 1/5 scoped qo04 rows. If neither occurs, record the allocator bucket as unobserved and stop.

**One change and arm.** Replace the single contiguous-band allocator inside `fetchBranch` ([retriever.ts:333](/Users/danielbyrne/GitHub/rpm/context-tree/packages/core/src/retrieve/retriever.ts:333)) with a ranked-disjoint allocator under the same total `maxTokens`. Seed exact singleton-event spans in existing score/sequence order while the next rendered union fits; merge adjacent spans; then spend remaining capacity by measured round-robin one-event expansion around accepted spans, always testing the rendered union. The number of bands is whatever the recorded budget and measured event sizes admit: there is no fixed `k`, percentage split, minimum band size, or second budget. Scoring, query extraction, prompts, search, tools, and reply policy are unchanged. Expose `retrievalBandPolicy: 'contiguous' | 'ranked-disjoint'`; arm `tree-disjoint-ranked`; gate `G10-ranked-disjoint-delivery`.

**Target bucket and mechanism.** This targets band allocation inside the at/before-delivery bucket, after selection and scoring. Its structural guarantees are: accepted evidence is never evicted to grow another band, all spans together fit the unchanged budget, adjacent bands merge, and band count derives from content and budget. It cannot repair an answer event that is not scored highly enough to be seeded before the budget fills.

**Offline mechanism proof and telemetry.** On a synthetic trace with two distant high-score events and one distractor, show that the incumbent returns one contiguous band while the candidate returns both distant singleton seeds within the exact same `maxTokens`; show that a nearby event is added only when the re-rendered union still fits. Then replay the scoped cell using recorded headrooms and final cap. Record the full ranked center list with scores, `seedAccepted`/`seedRejected` and reason, per-band and union tokens after every mutation, `bandsReturned`, merged spans, `singletonOversize`, and literal presence per band and after append.

**Numbered kill criteria.** No live tokens if any item fails:

1. The eligibility condition and every common gate pass; the artifact names the exact rows that establish an allocation rather than scoring failure.
2. Candidate and incumbent ranked event scores are byte-for-byte identical; only allocation differs.
3. `bandsReturned > 1` in every targeted row and the answer-bearing event is an accepted seed, not incidentally swept into a neighbor band.
4. The rendered union and final append fit the same recorded headroom as the incumbent; a singleton event larger than the whole budget sets `singletonOversize=true` and kills this experiment rather than silently overrunning.
5. Targeted post-cap delivery becomes 5/5 and no other question's delivery count regresses.
6. Printed spans are disjoint or properly merged, appear in chronological order in the final text, and contain the literal in actual event content. Any duplication, reordering, or metadata-only match kills the batch.

**Same-epoch live win.** Only after eligibility and all gates, run `truncate-tail,tree-tail-v2,tree-disjoint-ranked` at equal `n=5`: 75 attempts, estimated 15–18 million processed tokens and $0.38–$0.44. Require `bandsReturned > 1` on targeted rows, targeted delivery 5/5, no per-question delivery regression, at least +4/25 unconditional success over incumbent, and strict superiority to the proxy. Use the single common capped escalation only for +1–3/25.

**Portability, constants, and boundaries.** This design deliberately retires proposed constants `k`, fixed band shares, and minimum band width. Its only bounds are the caller's existing `maxTokens`, measured rendered size, available scored events, and trace boundaries. The existing scorer constants remain. Boundaries are a single event larger than budget, no scored events, one scored event (candidate becomes behaviorally identical and must report `mechanismFired=false`), many tiny scored events, adjacent spans, answer evidence below the affordable seed frontier, absent trace, `depth:'summary'`, `depth:'index'`, and explicit `from`/`to` clamps. The zero-token gate must exercise each; untested tokenizer/model pairs remain an explicit limitation.

## Routing and stop rule

1. Repair the instrument and run candidate 1's offline proof.
2. If candidate 1 fails a mechanism gate, journal the exact edge that failed. Run candidate 2's zero-token falsification only to determine whether storage-field duplication is independently causal; do not spend live tokens on a nearby-tie success.
3. If candidate 1 is correctly centered but delivery still fails, inspect the ordered post-cap artifact. Candidate 3 becomes eligible only when that artifact assigns the loss to allocation.
4. Run at most one live candidate at a time with fresh same-epoch baselines. A bucket win without a headline win is a finding, not evidence that context-tree beats the proxy. A transplant win supports only the narrow raw-tail-proxy claim; a later end-to-end `native` comparison is still required for the broader product claim.
5. Stop after the first clean headline win, after all three candidates are killed or ineligible, or at the DS-STAR three-iteration limit. Persist candidate, flags, hashes, `n`, means for bounded scores, medians/IQR for effort, raw token buckets, derived dollars, mechanism attribution, rejected candidates, and route taken.

No code or harness changes and no live-token calls were made for this planning artifact.
