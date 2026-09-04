# Iteration 1 judge: native-context delivery

## Verdict

The winner is **`plan-structural.md`, with the mandatory isolation and naming corrections below**. It has the best executable path from the demonstrated qo04 failure to a zero-token mechanism proof, avoids a premature live matrix, and gives the most portable conditional fallback. Its first candidate remains the only algorithm change authorized in iteration 1: add bare-filename fingerprints to **within-branch centring only**.

That qualification is load-bearing. The current `extractQueryFingerprints` is called by both `TreeRetriever.search` and `findRelevantCenter` ([retriever.ts:135](/Users/danielbyrne/GitHub/rpm/context-tree/packages/core/src/retrieve/retriever.ts:135), [retriever.ts:532](/Users/danielbyrne/GitHub/rpm/context-tree/packages/core/src/retrieve/retriever.ts:532), [retriever.ts:637](/Users/danielbyrne/GitHub/rpm/context-tree/packages/core/src/retrieve/retriever.ts:637)). Adding a basename rule to that shared function would change branch selection and band centring together, contradicting every plan's claim that ranking stays fixed. The implementation must instead add a centring-only extractor and leave `search()` byte-for-byte on the legacy extractor.

The winning queue is:

1. Land and verify the non-candidate measurement prerequisites.
2. Implement only the centring-specific bare-filename flag and run the scoped paired offline replay.
3. If every zero-live-token kill gate passes, run one same-epoch three-arm batch.
4. If and only if the pre-registered small-positive case occurs, escalate once at equal n.
5. Stop and report. A proxy win queues a later end-to-end native experiment; it does not establish that broader claim.

## Scores

Scores are 1–5, higher is better. For implementation risk, 5 means lower risk.

| Plan | Information gain | Mechanism fit | Simplicity | Provability | Resource discipline | Safety | Portability | Implementation risk | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `plan-structural.md` | 5 | 5 | 4 | 5 | 5 | 5 | 5 | 4 | **38** |
| `plan-filename.md` | 5 | 5 | 4 | 5 | 5 | 5 | 4 | 4 | **37** |
| `plan-null.md` | 4 | 4 | 3 | 4 | 3 | 5 | 5 | 5 | **33** |

`plan-structural.md` wins narrowly because it turns the candidate mechanism into an observable chain, derives the possible disjoint-band fallback from measured budget rather than a fixed band count, and gives the clearest boundary inventory. `plan-filename.md` is nearly equivalent on the first candidate but its third candidate hard-codes two bands. `plan-null.md` is safest locally, but its separate 50-attempt null batch buys no decision that the later same-epoch three-arm batch cannot buy while also testing the candidate.

## Named grafts from the losing plans

1. **Collision-proof identity graft — from `plan-filename.md`.** Preserve its explicit candidate identity concept as `candidateKey=retrieval-center-fingerprint-mode:bare-filename` in the header and filename. The structural plan names the arm but does not fully specify collision-proof parameter identity; without this graft, a sweep can overwrite a result.
2. **Scaled-threshold graft — from `plan-filename.md`.** Preserve the exact `+4/25` initial and `+8/50` escalated incumbent thresholds. This makes the one escalation a continuation of the same effect-size claim rather than a post-hoc relaxation.
3. **Instrument-failure stop graft — from `plan-null.md`.** If ordered final-delivery evidence cannot be produced, stop the pass. An invalid instrument leaves the comparison unresolved; it does not authorize an algorithm change.
4. **Null-within-the-batch graft — adapted from `plan-null.md`.** Retain the unchanged `tree-tail-v2` and `truncate-tail` comparison, but measure it inside the authorized three-arm invocation rather than in a separate 50-attempt pre-batch. This preserves the null check at the same epoch while avoiding redundant live spend.

Rejected loser elements are the standalone live null batch, per-event credit in iteration 1, and fixed-two-band retrieval. Per-event credit's pooled success depends on an unrelated seq-235 tie; fixed two-band adds a fitted constant before allocation has been shown to bind; and the standalone null batch would shift the next candidate's code epoch and force both controls to be rerun anyway.

## Claim boundary

`truncate-tail` is the **native-context proxy** for this transplant experiment: the newest raw events fitting the same W, in one flat turn, without retrieval tools. `naive-full` at W=200,000 is a full-transcript ceiling, not a same-window native baseline.

The actual **end-to-end native** arm is `native` in [loop.ts:344](/Users/danielbyrne/GitHub/rpm/context-tree/eval/src/loop.ts:344): a growing multi-turn transcript with the normal harness tools and optional native prefix caching. Even a clean transplant win permits only the claim that context-tree beat the same-window raw-tail proxy on the frozen deep fixture. It cannot support “context-tree beats native context.” That requires a later same-epoch, equal-n experiment against the end-to-end `native` arm over representative tasks and trace sizes.

## Exact experiment names

- Internal algorithm flag: `retrievalCenterFingerprintMode`
- Allowed flag values: `legacy` and `bare-filename`
- CLI spelling for zero-token/single-arm checks: `--retrieval-center-fingerprint-mode=legacy|bare-filename`
- Native proxy arm: `truncate-tail`
- Incumbent arm: `tree-tail-v2`
- Candidate arm: `tree-center-filename`
- Candidate result key: `candidateKey=retrieval-center-fingerprint-mode:bare-filename`
- Existing logging gate to repair: `G7-tool-call-logging`
- New epoch gate: `NC0-epoch-freeze`
- New fixture gate: `NC1-deep-fixture-validity`
- New mechanism gate: `NC2-bare-filename-centering`
- New offline delivery gate: `NC3-paired-offline-delivery`
- New live-readiness gate: `NC4-live-cell-readiness`

Do not use the structural plan's proposed name `G8-bare-filename-centering`: `G8-freeze-holds` already exists at [transplant.mjs:2199](/Users/danielbyrne/GitHub/rpm/context-tree/eval/scripts/transplant.mjs:2199).

## Ordered implementation specification

### 1. Land measurement prerequisites as a non-candidate epoch

These changes are instrumentation. They must affect all arms identically, must not alter prompts, tool schemas, tool-result bytes, retrieval scores, budgets, or reply policy, and are explicitly **not** candidate evidence.

1. In [transplant.mjs:976](/Users/danielbyrne/GitHub/rpm/context-tree/eval/scripts/transplant.mjs:976), [transplant.mjs:1050](/Users/danielbyrne/GitHub/rpm/context-tree/eval/scripts/transplant.mjs:1050), and [transplant.mjs:321](/Users/danielbyrne/GitHub/rpm/context-tree/eval/scripts/transplant.mjs:321), extend the frozen/result identity to emit `questionSha`, `traceSha`, `storeSha`, `configSha`, `rootSha`, `gitSha`, source fingerprints, the resolved compiled-runtime fingerprint, `effectiveConfig`, `modelResolved`, `invocation`, `candidateKey`, and `partial`. Hash the selected question file, not only the historical default.
2. In [transplant.mjs:4020](/Users/danielbyrne/GitHub/rpm/context-tree/eval/scripts/transplant.mjs:4020), make output names include question SHA, code epoch, reps, stratum, and `candidateKey`. In [transplant.mjs:4339](/Users/danielbyrne/GitHub/rpm/context-tree/eval/scripts/transplant.mjs:4339), key verdict cells by those fields in addition to model, W, arm, and stratum. Old files lacking them are ineligible, not zero-valued.
3. In [types.ts:65](/Users/danielbyrne/GitHub/rpm/context-tree/packages/core/src/retrieve/types.ts:65) and [retriever.ts:38](/Users/danielbyrne/GitHub/rpm/context-tree/packages/core/src/retrieve/retriever.ts:38), add an optional, harness-only observation callback for fetch diagnostics. It records the true centring decision without adding fields to `FetchedBranch`; returning diagnostics in the tool payload would change model-visible bytes and contaminate both baselines.
4. In [retriever.ts:273](/Users/danielbyrne/GitHub/rpm/context-tree/packages/core/src/retrieve/retriever.ts:273), emit through that callback: `narrowingStrategy`, `centerSeq`, extracted centring terms with source kind, per-term score contributions, input spans, returned spans, `maxTokens`, and rendered tokens. An un-narrowed, summary, or index fetch emits an explicit reason and `centerSeq:null`.
5. In [transplant.mjs:3796](/Users/danielbyrne/GitHub/rpm/context-tree/eval/scripts/transplant.mjs:3796), replace flat fields as the authoritative evidence with ordered `toolCalls[]`. Each record must contain `turn`, `callIndex`, `name`, `input`, `exactHeadroom`, `heuristicHeadroom`, `searchQueryAtFetch`, `branchId`, `narrowingStrategy`, `centerSeq`, `returnedSpans`, `beforeChars`, `beforeTokens`, `afterChars`, `afterTokens`, `droppedChars`, `droppedTokens`, and `answerLiteralPresentAfterCap`. The existing `searchQueries`, `fetchedIds`, and aggregate truncation fields may remain as derived compatibility fields only.
6. Pass the current question's answer literals into the instrumentation path solely for the post-cap audit field. They must never enter search, centring, band construction, prompts, or tool output.
7. Repair [transplant.mjs:2108](/Users/danielbyrne/GitHub/rpm/context-tree/eval/scripts/transplant.mjs:2108) so `G7-tool-call-logging` uses valid questions of at least 20 characters, exercises search, full fetch, and summary fetch, asserts every ordered field, and prints one complete record. It remains zero-live-token and mocked.

Any instrumentation edit after baseline rows exist starts a new epoch. No historical score is a control after step 1.

### 2. Implement exactly one measurable algorithm change

1. In [retriever.ts:38](/Users/danielbyrne/GitHub/rpm/context-tree/packages/core/src/retrieve/retriever.ts:38), add `retrievalCenterFingerprintMode?: 'legacy' | 'bare-filename'` to `TreeRetrieverDeps`; default it to `legacy` in [retriever.ts:92](/Users/danielbyrne/GitHub/rpm/context-tree/packages/core/src/retrieve/retriever.ts:92).
2. Leave the shared `extractQueryFingerprints` call in `TreeRetriever.search` unchanged at [retriever.ts:135](/Users/danielbyrne/GitHub/rpm/context-tree/packages/core/src/retrieve/retriever.ts:135). This freezes branch ranking.
3. Beside [retriever.ts:637](/Users/danielbyrne/GitHub/rpm/context-tree/packages/core/src/retrieve/retriever.ts:637), add a centring-only helper used by `findRelevantCenter`. In `legacy` mode it returns exactly the current terms. In `bare-filename` mode it additionally recognizes dotted basenames with a nonempty name and extension, but suppresses a basename already covered by a recognized slash path or identical quoted/backticked term.
4. Change only the term source used by `findRelevantCenter` at [retriever.ts:532](/Users/danielbyrne/GitHub/rpm/context-tree/packages/core/src/retrieve/retriever.ts:532). Do not change weights, per-field credit, late-sequence tie-breaking, the 8,192-character scan, contiguous band growth, total `maxTokens`, prompt, tools, or reply policy.
5. In [transplant.mjs:203](/Users/danielbyrne/GitHub/rpm/context-tree/eval/scripts/transplant.mjs:203), [transplant.mjs:495](/Users/danielbyrne/GitHub/rpm/context-tree/eval/scripts/transplant.mjs:495), [transplant.mjs:514](/Users/danielbyrne/GitHub/rpm/context-tree/eval/scripts/transplant.mjs:514), and [transplant.mjs:3650](/Users/danielbyrne/GitHub/rpm/context-tree/eval/scripts/transplant.mjs:3650), register `tree-center-filename`, give it the exact `tree-tail-v2` root ladder/context/tools/budgets, and construct only its retriever with `retrievalCenterFingerprintMode:'bare-filename'`. `tree-tail-v2` stays `legacy`.
6. In [transplant.test.ts:494](/Users/danielbyrne/GitHub/rpm/context-tree/eval/test/transplant.test.ts:494), assert the candidate is a tree arm, inherits the incumbent ladder, has a unique identity, and rejects a mismatched CLI mode/arm combination.
7. In [retrieve.test.ts:668](/Users/danielbyrne/GitHub/rpm/context-tree/packages/core/test/retrieve.test.ts:668), add deterministic fixtures for: the early duplicated `JSONL` distractor versus the later two-filename event; punctuation-adjacent filenames; lowercase extensions; multi-dot names; a basename inside a slash path; identical quoted filenames; dotfiles and extensionless names as explicitly supported or unsupported; and legacy parity. Also assert search hit order is identical between modes so the candidate cannot silently change selection.

This is one algorithm change: the set of syntax-derived terms used to choose a center inside an already selected branch. Everything else is either prerequisite observation or held fixed.

### 3. Add the scoped zero-token replay

In [delivery-killgate.mjs:82](/Users/danielbyrne/GitHub/rpm/context-tree/eval/scripts/delivery-killgate.mjs:82), stop pooling result files. Accept one explicit eligible W=65,536 deep result cell and replay its 25 rows as paired `legacy`/`bare-filename` evaluations using the ordered observed query/fetch pair, selected branch, exact-to-heuristic conversion, and append cap. Persist the paired artifact under its question/code/candidate identity and print one complete qo04 baseline/candidate pair plus the actual answer-bearing text.

The replay is diagnostic and uses fixture truth only for auditing. `q.seq` and answer literals must not be algorithm inputs.

## Numbered zero-live-token assertions and kill gates

All steps run before the first live token. A failure stops the batch.

1. **`NC0-epoch-freeze`:** require `partial:false`, exactly five rows per question per arm for any eligible historical input, and non-null matching question/trace/store/config/root/Git/source/runtime identities. Print the complete resolved header. Kill on a missing or mixed identity.
2. **`G7-tool-call-logging`:** mocked search, full fetch, and summary fetch must emit complete ordered records; the full payload alone contains the sentinel after cap. Print the records. Kill on an absent field, invalid question, or model-visible instrumentation change.
3. **`NC1-deep-fixture-validity`:** at exactly W=65,536, print for every question the proxy boundary, answer sequence and literal presence, branch size, live heuristic budget, narrowing eligibility, and rank. Require all five answers absent from `truncate-tail`, present in frozen L0 at their declared sequences, rank gate at least 4/5, and qo04 narrowing eligibility 5/5.
4. **Legacy parity assertion:** with the flag absent and with `legacy` explicitly set, require identical fingerprints, search hits/order, center, spans, rendered bytes, and tokens on unit and scoped fixtures. Kill if default behavior moves.
5. **One-change assertion:** compare candidate and incumbent configuration snapshots. The sole algorithmic delta must be `retrievalCenterFingerprintMode`. Require identical question, branch selection, budgets, event scores for legacy terms, band allocator, prompts, tool schemas, and reply mode.
6. **`NC2-bare-filename-centering`:** in all 5/5 scoped qo04 rows, require both basenames newly extracted, no duplicate path/quote weight, `mechanismFired:true`, and `centerSeq=218`; the incumbent center must be independently reproduced. Kill if any row is inert or if search hit order changes.
7. **`NC3-paired-offline-delivery`:** require qo04 post-cap literal delivery candidate 5/5 versus incumbent 0/5, seq 218 inside a returned span 5/5, no delivered-count loss for qo01, qo02, qo03, or qo05, and no returned/appended payload above recorded headroom. Inspect the literal in actual event text, not metadata.
8. **Provenance assertion:** every apparent replay success must point to bytes present in the post-cap payload. Kill on fabricated sequence/literal evidence.
9. **Identity assertion:** dry-run name generation for `truncate-tail`, `tree-tail-v2`, and `tree-center-filename`; require three collision-free identities carrying the same epoch and the exact candidate key only on the candidate.
10. **`NC4-live-cell-readiness`:** require gates 1–9 PASS in one machine-readable artifact. DEFER, MISSING, or mixed-epoch is a kill, not permission to “run and see.”

If centring moves correctly but the literal is absent after the append cap, preserve the seq-55 miscentring finding, kill this repair, and route to a separately designed allocation experiment. Do not implement multi-band during iteration 1.

## Pre-registered live verification

Only `NC4-live-cell-readiness=PASS` authorizes the batch. Run W=65,536, the frozen `questions-deep.json`, the same resolved model/revision, and the three arms `truncate-tail,tree-tail-v2,tree-center-filename` in one invocation. Use five questions × five replicates × three arms = 75 scheduled attempts. Rotate arm order by replicate; stalls remain in the denominator. Means aggregate bounded scores; medians and IQR summarize effort; report fresh input, cache reads, cache writes, output, turns, completion, and delivery separately.

The fixture contains one declared scored stratum, `overflow`; no post-hoc stratum may become primary.

| Pre-registered stratum/slice | Required initial result at n=5/question |
| --- | --- |
| `overflow` primary stratum, 25 attempts/arm | Candidate unconditional provenance-audited success is at least `tree-tail-v2 + 4/25` and strictly greater than `truncate-tail`. |
| qo04 target slice | `mechanismFired=5/5`, post-cap literal delivery `5/5`, and every counted success has payload provenance. |
| qo01, qo02, qo03, qo05 protected slices | Candidate delivery count is not below incumbent for any question. Any loss is reported as a regression, never a tradeoff. |
| Resource secondary outcomes | Report token buckets and turns; no resource result can rescue a failed quality or mechanism criterion. A material retrieval-token increase violates isolation because the candidate changes only centring terms. |

A qo04 delivery win without the `+4/25` headline threshold is a bucket win/headline-inert finding. A headline win without `NC2` mechanism evidence is unattributed and cannot land. Strictly beating `truncate-tail` completes only the native-proxy criterion.

### One capped escalation

Escalate exactly once only when all gates and protected-slice criteria pass and the candidate's initial headline delta over `tree-tail-v2` is positive but only `+1/25`, `+2/25`, or `+3/25`. Add exactly five replicates per question to **all three arms** in the unchanged epoch, yielding n=10/question, 50 attempts/arm, 150 cumulative attempts.

At the cap, require candidate success at least `tree-tail-v2 + 8/50`, strict superiority to `truncate-tail`, qo04 `mechanismFired=10/10` and post-cap delivery `10/10`, and no protected-question delivery regression. There is no second escalation. A zero/negative initial delta, provenance failure, mechanism failure, gate failure, or protected regression retires the candidate immediately.

## Routing after the batch

1. Clean mechanism and headline win: land `bare-filename` as the centring default only for the proven proxy/fixture regime, journal exact flags/hashes/n/token buckets, and queue a separate end-to-end `native` comparison.
2. Delivery win, headline miss: retain the measurement improvement as a finding, do not claim the goal, and target the five-attempt after-delivery bucket next.
3. Correct centre, post-cap failure: retire filename centring as the complete repair and design an isolated allocation candidate from the ordered artifact.
4. Mechanism inert or protected regression: revert/disable the candidate and preserve the causal observation separately.
5. All gates fail or the capped criterion misses: stop iteration 1 and report; do not spend on per-event credit or multi-band merely to complete a matrix.

No code change or live-token call is authorized by this judge artifact itself.
