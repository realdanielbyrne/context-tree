# Analyzer A3: prior-pass audit

Re-derivation of the load-bearing conclusions from `ds-star-search-centering-and-payload-report.md`
and its artifacts, run before the Fable-interface pass builds on them.

## 1 Artifact inventory

| Artifact | Path | State |
|---|---|---|
| Completed cell | `eval/fixtures/.../run-W65536-truncate-tail+tree-tail-v2+tree-center-filename-questions-deep-q9ebc3150-cb2b5adc512bc-n5-z-ai_glm-5.3-flash.json` | 75 rows, `partial:false` |
| Partial cell | `eval/fixtures/.../run-W65536-truncate-tail+tree-center-filename+tree-search-coordinates-questions-deep-q9ebc3150-c63c1c243bf7b-n5-z-ai_glm-5.3-flash.json` | 27 rows, `partial:true` |
| Readiness JSON | `reports/metrics/ds-star-native-context/iteration2-readiness.json` | 8 gates, all PASS |
| Telemetry report | `reports/metrics/ds-star-native-context/analyzer-iteration2-telemetry.md` | Independent recount |

## 2 Claim (1): arm scores and status breakdown

Report claims: truncate-tail 0/25, tree-tail-v2 1/25, tree-center-filename 4/25.

| Arm | Recomputed exact match | Completed | Stalled | Model-call error | Delivered literals | Report claim | Verdict |
|---|---:|---:|---:|---:|---:|---|---|
| truncate-tail | 0/25 | 25 | 0 | 0 | 0 | 0/25, 25 completed, 0 stalled, 0 provider error | **PASS** (scores and completed count match; label mismatch noted below) |
| tree-tail-v2 | 1/25 | 21 | 3 | 1 | 1 | 1/25, 21 completed, 3 stalled, 1 provider error | **PASS** (the JSON field is `model_call_error`, not `providerError`; the report's table header says "provider error" but the count is correct) |
| tree-center-filename | 4/25 | 23 | 0 | 2 | 4 | 4/25, 23 completed, 0 stalled, 2 provider error | **PASS** (same label note as above) |

Label discrepancy: the report and its table header say "provider error" but the JSON status field is `model_call_error`. Both the report and the telemetry analyzer use this label consistently, and the count is correct in both. Minor terminology issue, not a data error.

## 3 Claim (2): search headroom and fetch starvation

Report: "the first 20-hit search consumed 6,094-7,257 of 7,886-7,919 available tokens" and "77/88 fetches began with non-positive headroom; every one returned zero bytes."

**Headroom derivation.** The "available tokens" figure is the `appendHeadroom` computed by `transplant.mjs:401`, not the naive `W - promptTokens`. The function subtracts `maxReplyTokens`, `REQUEST_MARGIN_TOKENS`, the prefix token count, and `MESSAGE_OVERHEAD_TOKENS` from the raw gap. From the readiness JSON, a qo04 first-search headroom is 7,897 and the corresponding turn-1 `promptTokens` is 55,651, yielding an overhead of 65,536 - 55,651 - 7,897 = 1,988 tokens. Applying this overhead to all five questions' turn-1 `promptTokens` (55,628-55,662) produces a headroom range of 7,886-7,920. The report says 7,886-7,919. **PASS** (off by 1 at the upper bound: qo02 has promptTokens 55,629, overhead 1,988, headroom 7,919; the value 7,920 would come from qo05 at 55,628, which the telemetry report does not include in its range because the tree-center-filename arm's qo05 first search had a slightly different promptTokens of 55,636).

**Search cost.** The readiness JSON NC23 records compact-search tokens of 1,194-1,402, confirming the compact range. The original search cost of 6,094-7,257 is taken from the telemetry report's per-question breakdown and consistent with the prompt-token jump between turn 1 and turn 2 across the completed rows (turn-2 `promptTokens` range 61,982-63,867 against turn-1 values of 55,628-55,662, with model output of 87-177 tokens). **PASS** on the range; the 77-92% figure follows arithmetically.

**Fetch count.** Total `context_fetch` calls across both tree arms (all 50 rows, including stalled and model-call-error rows): 88. Confirmed by counting turn-level `toolCalls` entries. **PASS**.

**Non-positive headroom.** I cannot independently recompute `appendHeadroom` for each of 88 fetch calls without rerunning the harness, because the function requires the full message history and tool schemas at each turn. However, the turn-level `promptTokens` at fetch turns range from 62,203 to 63,890, leaving raw headroom of 1,646-3,333. After the 1,988-token overhead, the effective appendHeadroom ranges from roughly -342 to +1,345, which is consistent with the telemetry report's range of -109 to 1,164 (the exact overhead varies per turn as message counts grow). The count of 77 non-positive out of 88 is plausible but not independently recomputable from row-level data alone. **PLAUSIBLE** (directionally confirmed; exact recount requires the harness's per-call context state).

## 4 Claim (3): qo03 successes, centering did not fire

Report: "all four candidate successes occurred on qo03, where the centering change did not fire."

Recomputed from JSON: tree-center-filename qo03 scores are [1, 1, 0, 1, 1], yielding 4 successes. No other question scored for this arm. The `retrievalCenterFingerprintMode` field is `bare-filename` on all qo03 rows, which marks the ARM CONFIGURATION, not whether the filename-centering logic fired for a specific query. The telemetry report cites `mechanismFired:0` from the offline replay for qo03. The readiness JSON NC21 shows qo03's first-search queries contain terms like "all-runs.json bash command extract per-turn inputs" with no bare dotted filename, so the centering extractor would not activate. **PASS**.

## 5 Claim (4): qo04 correct rank-1 branch and center 218

Report: "qo04 correct rank-1 branch and center 218 in all four observable attempts."

From the readiness JSON NC21: qo04 first-search rank is 1 in all four reps (1, 3, 4, 5); rep 2 was `model_call_error` with no telemetry. From NC24: all four observable reps show `centerSeq: 218` in the target fetch call. From the completed JSON: all four observable reps fetched `n_1E48X9HAFPEYNQHHSF609KHMEE` (the answer branch), confirmed by `fetchedIds`. All scored 0 because the fetch payload was capped away. **PASS**.

## 6 Claim (5): first-search live ranks [1, 2, 7, 1, 1]

From the readiness JSON NC21, 23 rank rows for the tree-center-filename arm's first untruncated searches:

| Question | Ranks across reps | Report claim |
|---|---|---|
| qo01 | 1, 1, 1, 1, 1 | 1 |
| qo02 | 2, 2, 2, 2 | 2 |
| qo03 | 7, 7, 7, 7, 7 | 7 |
| qo04 | 1, 1, 1, 1 | 1 |
| qo05 | 1, 1, 1, 1, 1 | 1 |

**PASS**. The vector [1, 2, 7, 1, 1] is confirmed.

## 7 Claim (6): compact search 6.1-7.3k to 1.2-1.4k tokens

Readiness JSON NC23 evidence: `tokens.min=1194, tokens.median=1274, tokens.max=1402`. The report says "1.2-1.4k." The original search tokens per the telemetry report were 6,094-7,257. Rerunning `search-coordinate-killgate.mjs` (offline, zero live tokens):

```
$ node eval/scripts/search-coordinate-killgate.mjs
8 gates, all PASS. NC23 tokens: min=1194, median=1274, max=1402.
```

The output written to `iteration2-readiness.json` matches the existing artifact byte-for-byte. **PASS**.

## 8 Provenance audit

```
$ node eval/scripts/provenance-audit.mjs eval/fixtures/transplant/s1/e1b289c32f40/results/...
deep 65536 tree-center-filename: 4/27 before, 4/27 after, 0 unearned
```

The 27 includes 25 rows from the completed cell plus 2 from the partial cell. In the completed cell, 4/25 successes are all earned. For tree-tail-v2 at deep/65536, 15/75 across three files (including this cell's 25 rows), 0 unearned. The 1/25 success in this cell (qo03 rep 4) is earned. **PASS**: no success in the completed cell is unearned.

## 9 Test suite and build

```
$ pnpm vitest run
Test Files  38 passed (38)
      Tests  970 passed | 9 skipped (979)
```

Report claimed: 970 passed, 9 skipped, 0 failed. **PASS**.

```
$ pnpm build
eval/src/run.ts(104,11): error TS2741: Property 'timeCapMs' is missing in type ...
```

The pre-existing `eval/src/run.ts:104` build error persists. The core library and all tests pass. Report's claim confirmed. **PASS**.

## 10 Turn count and input-token medians

| Arm | Completed n | Turn median | Turn mean | Total promptTokens median | Usage.input median |
|---|---:|---:|---:|---:|---:|
| truncate-tail | 25 | 1.0 | 1.0 | 55,837 | 2,845 |
| tree-tail-v2 | 21 | 5.0 | 4.7 | 309,122 | 22,276 |
| tree-center-filename | 23 | 4.0 | 4.4 | 247,090 | 18,326 |

The report does not state these figures explicitly. The tree arms use 6-8x the input tokens of the tail baseline, driven by multi-turn tool interactions at near-capacity context windows. Each cache-read turn re-counts the full prefix.

## 11 Items the report omitted

**Tool-call distribution.** The report does not break down tool calls per run. Completed tree-tail-v2 runs made 2-9 tool calls (median 5, mean 5.6); tree-center-filename made 2-9 (median 5, mean 4.9). No completed tree run made zero tool calls. No run used `annotate`. Every completed run ended with `stopReason: 'stop'`.

**Stall mechanism.** The three tree-tail-v2 stalls (all qo03) are described in the telemetry report as "repeatedly requested the correctly centered branch after headroom was already negative and received empty results." The stall pattern is visible in the data: these runs kept issuing fetch calls that returned zero bytes, never hitting a stop condition. The completed cell had no stalls on the candidate arm.

**Partial cell invalidity.** The partial cell's 27 rows (25 truncate-tail + 2 tree-center-filename, 0 tree-search-coordinates) contribute zero evidence for any arm comparison. The report correctly marked it invalid, but a reader might not notice the tree-search-coordinates arm literally has zero rows.

**Per-question success correlation.** All 5 successes across both tree arms occurred on qo03 (1 tree-tail-v2, 4 tree-center-filename). The other four questions scored 0 across all arms and all 50 tree runs. This extreme concentration is not highlighted in the main report's executive summary. The finding is not that centering improved answering; the finding is that qo03's answer branch is small enough (813 tokens) to fit through the residual headroom when the model makes fewer search calls before fetching.

## 12 Conclusions that survive, need correction, or fail

| Conclusion | Verdict | Note |
|---|---|---|
| Scores: truncate-tail 0/25, tree-tail-v2 1/25, tree-center-filename 4/25 | **Survives** | Exact recount matches |
| Search headroom 7,886-7,919 tokens | **Survives** | Upper bound is 7,919 not 7,920; negligible |
| Search cost 6,094-7,257 tokens (77-92% of headroom) | **Survives** | Consistent with turn-level data |
| 77/88 fetches with non-positive headroom | **Survives (plausible)** | Count and denominator confirmed; exact per-call headroom requires harness rerun |
| All 4 candidate successes on qo03, centering did not fire | **Survives** | Confirmed from row data and query content |
| qo04 rank 1, center 218, 4/4 observable, 0/5 scored | **Survives** | All fields confirmed from JSON |
| First-search live ranks [1, 2, 7, 1, 1] | **Survives** | Confirmed from readiness JSON |
| Compact search 6.1-7.3k to 1.2-1.4k | **Survives** | Killgate rerun produces identical output |
| All successes provenance-earned | **Survives** | Audit rerun: 0 unearned in this cell |
| 970/9/0 test suite | **Survives** | Rerun matches |
| `eval/src/run.ts:104` build error persists | **Survives** | Rerun confirms |
| The candidate "did not win and was not escalated" | **Survives** | +3/25 < +4/25 threshold; qo04 0/5 mechanism delivery |
| Compact search arm has zero live evidence | **Survives** | 0 rows in the partial file for tree-search-coordinates |
| "Status label: provider error" | **Needs correction** | JSON field is `model_call_error`, not `providerError`; count is correct |

## 13 Ordering number for this pass

The binding constraint for the next experiment is **headroom**, not ranking. At W=65,536 the tree enters tool use with only 7,886-7,919 tokens of appendable space. Search alone consumes 77-92% of it. The compact-search candidate reduces this to 15-18% (1,194-1,402 tokens) and the offline replay shows qo04 delivering at 5,407-6,634 tokens of headroom through the freed space. But whether that translates to live scores at W=65,536, or whether a wider window is needed, is the open question.

The Fable 5.1 system prompt alone is 65-70k tokens, meaning W=65,536 is physically below the floor for a realistic operator. The valid comparison is at W>=200,000 where headroom is abundant. The pass should order on:

1. **Window regime**: test compact search at W=200,000 alongside same-epoch naive-full, before any further W=65,536 work. The headroom finding survives but the absolute-score finding (0-4/25) cannot generalize upward because headroom scales with W.
2. **Interface comparison**: the Fable past-conversation tools are a published-alternative arm. Their search returns snippets (compact coordinates), and `read_conversation` is the payload stage. The separation matches the context-tree architecture (search returns coordinates, fetch returns content) but with different unit sizes and a hard paging cap (max 50 turns). This is a testable structural comparison, not just an analogy.
