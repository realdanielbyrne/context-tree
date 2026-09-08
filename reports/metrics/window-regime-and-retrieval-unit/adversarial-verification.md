# Adversarial verification of ds-star-fable-interface-report.md

Verifier: subagent, 2026-09-04. No live LLM calls made. Every check command listed.

---

## Numbered findings

### 1. Iteration 1 total token counts (report section 5)

**Claim**: "1,751,898 uncached input tokens plus 17,418,240 cache-read tokens and 114,064 output tokens"

**Recomputed**: `python3` sum over `rows[].usage.{input,cacheRead,output}` in the iteration-1 result file.

```
uncached: 1,751,898   cache-read: 17,418,240   output: 114,064
```

All three match exactly. **PASS**.

---

### 2. Iteration 1 per-arm exact-match scores and per-question breakdown

**Claim**: truncate-tail 0/25 (0,0,0,0,0); tree-tail-v2 5/25 (0,0,5,0,0); tree-search-coordinates 5/25 (1,0,0,4,0).

**Recomputed**: `python3` group-by arm/question over `rows[].score` (None treated as 0).

```
truncate-tail:            0/25 (0,0,0,0,0)
tree-tail-v2:             5/25 (0,0,5,0,0)
tree-search-coordinates:  5/25 (1,0,0,4,0)
```

**PASS**.

---

### 3. Iteration 1 status distributions

**Claim**: truncate-tail 22/0/0 (+3 turn cap); tree-tail-v2 19/6/0; tree-search-coordinates 18/5/2.

**Recomputed**: `Counter(r['status'])` per arm.

```
truncate-tail:            completed=22, turn_cap=3
tree-tail-v2:             completed=19, model_call_error=6
tree-search-coordinates:  completed=18, model_call_error=5, stalled=2
```

**PASS**.

---

### 4. Iteration 1 median uncached input tokens per run

**Claim** (table column header: "median uncached input tokens per run"): truncate-tail 4,188; tree-tail-v2 31,508; tree-search-coordinates 23,430.

**Recomputed**: median of `usage.input` across all 25 rows per arm, and then across only completed rows.

| arm | all rows median | completed-only median |
|---|---|---|
| truncate-tail | 4,188 | 4,188 |
| tree-tail-v2 | 23,541 | **31,508** |
| tree-search-coordinates | 14,577 | **23,430** |

The report's values are the **completed-only** medians (excluding model_call_error rows whose `usage.input` is 0). The column header "median uncached input tokens per run" does not indicate this filtering. A reader computing from all rows gets different values.

**FAIL** (labelling, not arithmetic). **Replacement**: either change the header to "median uncached input (completed runs)" or note below the table that medians exclude model_call_error rows.

---

### 5. Provenance audit: iteration 1 "10/10 earned"

**Claim**: "provenance audit 10/10 successes earned, none answerable without retrieval."

**Recomputed**: `node eval/scripts/provenance-audit.mjs`. The relevant audit rows:

```
deep 131072 tree-tail-v2            25  5/25 -> 5/25   0 nulled, 0 unverif
deep 131072 tree-search-coordinates 25  5/25 -> 5/25   0 nulled, 0 unverif
```

10 successes, 10 earned, 0 nulled, 0 unverifiable. **PASS**.

---

### 6. Provenance audit: iteration 2 "9 raw, 1 nulled, 8 earned"

**Claim**: "Raw 9/25; the provenance audit nulled one success (qo02 rep 5 produced `timeCapMs` although no fetch carried it), leaving 8/25 earned."

**Recomputed**: The iteration-2 result file shows 9 raw successes (qo02 rep5, qo03 reps 1-5, qo04 reps 1,2,5). The audit output for `deep 131072 tree-center-filename` (50 rows across iter2+iter3) shows: `15/50 -> 14/50, 1 nulled, 1 unearned`. The 1 unearned row is `s1-qo02-overflow rep5 score=1 unearned`. The iteration-2 contribution is 9 raw, 1 nulled = 8 earned; the iteration-3 contribution is 6 raw, 0 nulled = 6 earned; 8+6 = 14. **PASS**.

---

### 7. Provenance audit: iteration 3 "15/25 earned-search"

**Claim**: "snippet-hits 15/25 earned ... the arm is 15/25 earned and no other arm's audited score moved."

**Recomputed**: Audit output shows `deep 131072 tree-snippet-hits 25 15/25 -> 15/25, 0 nulled`. The final line says "15 successes were served the literal inside a search result (earned-search)." **PASS**.

---

### 8. qo04 centering sequences (report section 5)

**Claim**: "tree-tail-v2 centered its band at seq 55, 93 or 115 ... The bare-filename extractor centered at 218 in 4 of 4 fetches."

**Recomputed**: `toolCalls[].centerSeq` from the iteration-1 result file.

tree-tail-v2 qo04 fetch centerSeqs: 55, 93, 115, 55, 55, **121**, 55, 115. The report says "55, 93 or 115" but rep 4 also centered at **121**. tree-search-coordinates qo04 fetches: 218 in all 4 (reps 2-5; rep 1 had no fetch). 4/4 at 218. Scores: 4/5 (rep 1 had 0 fetches, 0 score).

**FAIL** (minor). tree-tail-v2 centered at 55, 93, 115, and **121**, not only 55, 93, 115. **Replacement**: "tree-tail-v2 centered its band at seq 55, 93, 115 or 121".

---

### 9. qo04 afterChars and branch size

**Claim**: "the band arrived at about 49,700 characters (roughly 12,000 tokens)" on a "57,891-character branch".

**Recomputed**: afterChars for tree-search-coordinates qo04 scoring fetches: 49,581, 49,714, 49,707, 49,734 (mean 49,684). droppedChars: 8,310, 8,177, 8,184, 8,325. afterChars+droppedChars = 57,891 consistently. 49,700 is a fair approximation. 57,891 exact. **PASS**.

---

### 10. qo03 first-fetch afterChars and 10,515-character claim

**Claim**: "the model fetched the correct branch first in 5 of 5 runs and scored 5 of 5 from a 10,515-character result."

**Recomputed**: tree-tail-v2 qo03 reps 1-5: each had exactly 1 fetch, afterChars = 10,515 in all 5, score 1 in all 5. **PASS**.

---

### 11. qo03 distractor first for coordinates arm

**Claim**: "a distractor was fetched first in 5 of 5 runs, the headroom was spent on it, and later fetches of the correct branch returned zero bytes; two runs stalled."

**Recomputed**: tree-search-coordinates qo03 reps 1-5: first fetch afterChars = 43,051 / 50,216 / 50,229 / 50,221 / 50,216 (all distractor branches). All subsequent fetches had afterChars=0. 2 runs stalled (reps 1 and 2 based on status). Score 0/5. **PASS**.

---

### 12. qo05 "never searched 9/10 (iteration 1)"

**Claim**: "In 9 of 10 tree runs the model never called a tool."

**Recomputed**: qo05 tree rows in iteration 1 (5 tree-tail-v2 + 5 tree-search-coordinates): 9 had 0 searches, 1 (tree-tail-v2 rep 4) had 2 searches. **PASS**.

---

### 13. qo05 "never searched 5/5" for snippet-hits (iteration 3) and center-filename (iteration 2)

**Claim**: "qo05 0/5 with 0 tool calls in 5/5 runs" (both arms, both iterations).

**Recomputed**: iteration 2 center-filename qo05: 5/5 had 0 searches. iteration 3 snippet-hits qo05: 5/5 had 0 searches. iteration 3 center-filename qo05 (rerun): 5/5 had 0 searches. **PASS**.

---

### 14. "14/15 tree runs" across three arms for distractor decay (algorithm.md)

**Claim** (algorithm.md measurement hazards, "Distractor decay"): "the model answers it in 1 turn without searching, 14/15 tree runs across three arms."

**Recomputed**: iteration 1: 9/10 never searched. iteration 2: 5/5 never searched. Total: 14/15 across tree-tail-v2, tree-search-coordinates, tree-center-filename. **PASS**.

---

### 15. Provider-failure counts and question distribution (report section 5)

**Claim**: "11 of 50 tree rows ended in model_call_error ... all on qo01 and qo02."

**Recomputed**: tree-tail-v2: 6 errors (qo01: 3, qo02: 3). tree-search-coordinates: 5 errors (qo01: 1, qo02: 4). Total: 11 errors. All on qo01/qo02. **PASS**.

---

### 16. Kill-gate figures (report section 7)

**Claim**: "the excerpt list carried the answer literal on 48 of 56 queries, showed the answer event on 53 of 56, and cost a median 1,693 tokens (maximum 1,926)."

**Recomputed**: `node eval/scripts/snippet-hits-killgate.mjs` output:

```
literal in an excerpt: 48/56 | answer EVENT visible: 53/56 | tokens median 1693
```

Max tokens from extracted column: 1,926. All four figures match. **PASS**.

---

### 17. "All 15 snippet successes had zero fetches"

**Claim**: "Every one of the 15 successes was answered without a single fetch."

**Recomputed**: All 15 scoring rows of tree-snippet-hits had `context_fetch` call count = 0. **PASS**.

---

### 18. "12 had the literal on the first search"

**Claim**: "on 12 the first search's excerpts contained the literal (answerLiteralInExcerpts = true)."

**Recomputed**: Of the 15 successes, the first `context_search` call's `answerLiteralInExcerpts` was `true` for 12 and `false` for 3 (qo04 reps 1, 3, 4). **PASS**.

---

### 19. "the other 3 (all qo04) the first query matched no event and a reformulated second search did"

**Claim**: The 3 remaining successes found the literal on a reformulated second search.

**Recomputed**: `answerLiteralInExcerpts` per search call:
- qo04 rep 1: [False, **True**] -- second search. OK.
- qo04 rep 3: [False, False, **True**] -- **third** search, not second.
- qo04 rep 4: [False, **True**, True] -- second search. OK.

**FAIL** (minor). One of the three (rep 3) required a third search, not a second. **Replacement**: "on the other 3 (all qo04) the first query matched no event and a later reformulated search did" (drop "second").

---

### 20. "-54% input tokens" (report section 7, abstract, algorithm.md)

**Claim**: "input tokens -54%", stated in the prose of section 7, the abstract ("54% fewer input tokens"), and algorithm.md.

**Recomputed**: The report's own table (section 7) shows total uncached input for all 25 rows: center-filename 768,123, snippet-hits 318,449. The reduction from the table's numbers is 318,449 / 768,123 = 0.4146 = **-58.5%**.

The -54% matches only when computed over **completed rows only**: center-filename completed-only uncached = 698,680; snippet-hits completed-only = 318,449. 318,449 / 698,680 = 0.4558 = **-54.4%**.

The table and the prose use different denominators (all-rows totals in the table, completed-only in the prose). A reader who divides the two numbers in the table gets -58.5%, not -54%.

**FAIL**. **Replacement**: either (a) change the prose to "-59% input tokens" (consistent with the table's numbers), or (b) change the table to show completed-only totals (698,680 and 318,449) and label them "(completed runs)", or (c) add a parenthetical: "input tokens -54% on completed runs (-59% including provider-error rows at zero)".

---

### 21. Fetches per run (report section 7 table)

**Claim**: center-filename 1.42 fetches per run, snippet-hits 0.05 fetches per run.

**Recomputed**: center-filename: 27 fetches across 19 completed rows = 1.42. snippet-hits: 1 fetch across 21 completed rows = 0.048 ~ 0.05. These are per-completed-run averages. The table column says "fetches per run" without specifying "completed". This is consistent with finding 4 (medians also use completed-only) but inconsistent with the token columns, which use all rows.

**PASS** (the values are arithmetically correct for completed runs), but the table mixes denominators: token totals include all 25 rows; medians and per-run averages exclude model_call_error rows. This should be stated.

---

### 22. Fable prompt token count: "60,903 cl100k tokens, 274,608 characters"

**Claim**: The leaked Claude Fable 5.1 system prompt is 274,608 characters and 60,903 cl100k tokens.

**Recomputed**: `wc -m` on the scratchpad file shows 274,608 characters. The tokenizer (`gpt-tokenizer`) is not installed as a standalone package, and `tiktoken` is also unavailable, so the 60,903-token count could not be independently reproduced. The journal states it was computed with `gpt-tokenizer countTokens`, the harness's own tokenizer.

**UNVERIFIABLE** (character count PASS; token count cannot be reproduced without the tokenizer).

---

### 23. Tail boundary seq at W = 131,072

**Claim** (report section 4 table and journal kill gate KG-1): boundary seq 268 at W = 131,072.

**Recomputed**: The result file's `budgets.K` = 123,232. The questions-deep.json file records `boundary_seq: 268` and `ref_window: 131072`. The journal table also says `K = 123,232` and `tail boundary seq = 268`. **PASS** (consistent across all artifacts).

---

### 24. Iteration 2 qo04 misses: centering details (report section 6)

**Claim**: "One run's query carried no filename and centered at seq 55. The other centered at 218 but had spent its headroom on a second search: the band arrived at 8,688 characters with 4,444 cut and the literal gone."

**Recomputed**: qo04 misses in iteration 2 (center-filename). Rep 3: centered at 55 (2 fetches, 6 searches). Rep 4: centered at 218, afterChars=8,688, droppedChars=4,444. Both PASS.

**PASS**.

---

### 25. Iteration 3 baseline drop from 8/25 to 6/25

**Claim**: "The baseline's own drop from 8/25 in iteration 2 to 6/25 here (qo04 3/5 -> 1/5, two stalls) on an unchanged code path."

**Recomputed**: Iteration 2 center-filename: 8/25 earned (after nulling 1). Iteration 3 center-filename rerun: 6/25 raw; qo04 1/5, 2 stalls. From the data: qo04 reps in iter3 had: rep1=0 (completed), rep2=0 (completed), rep3=1 (completed), rep4=0 (stalled), rep5=0 (completed). So qo04 = 1/5, with 1 stall in qo04. But the report says "two stalls" for the whole arm. Total stalls: 2 (qo01 rep5 + qo04 rep4). The decomposition is qo04 3->1, not specifically "two stalls in qo04". **PASS** (the claim says "two stalls" for the arm, not for qo04).

---

### 26. Abstract-body number consistency

Every number in the abstract was checked against the body:

| abstract number | body location | match? |
|---|---|---|
| 60,903 tokens | section 1 (line 38) | yes |
| W = 131,072 | section 4-7 | yes |
| 1/25 to 5/25 | section 5 table | yes |
| 0/25 raw-tail | section 5 table | yes |
| qo04 0 -> 3-5 of 5 | section 6 table (0,3,4,5 across arms) | yes |
| qo03 5 -> 0 of 5 | section 6 table | yes |
| 15/25 vs 6/25 | section 7 table | yes |
| zero fetches | section 7 prose | yes |
| median 2 turns | section 7 table | yes |
| 54% fewer input tokens | section 7 prose | yes (same number, same issue as finding 20) |

**PASS** (all abstract numbers appear in the body with the same value). The 54% carries forward the denominator issue from finding 20.

---

### 27. algorithm.md new rows match the report (section 8)

**Claim**: Tier 1 gains a MEASURED variant line. Tier 2 gains three rows (snippet hit count, snippet excerpt size, window boundary). Boundary table +2 rows (label-vs-payload, headroom). Hazards +4 rows (distractor decay, audit channel blindness, provider empty turns, exact boundaries).

**Recomputed** by grep:
- Tier 1 MEASURED line: present (line 112, `tree-snippet-hits`). PASS.
- Tier 2 `snippet hit count`: present (line 166). PASS.
- Tier 2 `snippet excerpt size`: present (line 167). PASS.
- Tier 2 `window below the host's own system prompt`: present (line 180). PASS.
- Boundary: `A search hit as a label vs as a payload`: present (line 220). PASS.
- Boundary: `Headroom at the first tool turn`: present (line 219). PASS.
- Hazard: `Distractor decay`: present (line 238). PASS.
- Hazard: `A provenance audit that knows only some payload channels`: present (line 239). PASS.
- Hazard: `A provider that ends a turn with reasoning and no message`: present (line 240). PASS.
- Hazard: `An overflow question set at a wider W than it was cut for` (exact boundaries): present (line 236). PASS.

Candidates section lists "coordinates retired" and "bare-filename centering confirmed" and "event-snippet hits measured". All present (lines 306-313). **PASS** (all algorithm.md changes match the report's claims).

---

### 28. Prior report corrections

**Claim**: "five wording corrections were applied to [the prior] report and are listed at its foot."

**Recomputed**: The foot of `ds-star-search-centering-and-payload-report.md` reads: "Corrected 2026-09-04 by the Fable-interface pass ... status label, success concentration, stall cross-reference, partial-cell row count, and the naive-full budget note. All numeric claims reproduced."

That lists five corrections. **PASS**.

---

### 29. Vitest suite

**Recomputed**: `pnpm vitest run eval/test/transplant.test.ts` -- 55 tests passed, 0 failed. **PASS**.

---

### 30. claude.ai probe log internal consistency

The probe log (`claude-ai-probe-answer-key.md`) was checked for:
- Self-reported vs observed labels are explicitly distinguished ("self-reported, not observed bytes").
- Probe p3 is scored as an exact-match fail, consistent with the report table.
- r2 self-report is flagged as "internally inconsistent (turns 2-7 of 8 yet 'ran to the end'); treat the turn numbers as approximate."
- The answer key is ground-truth from the chat, stated as read before probes.

**PASS** (the log is internally consistent and honest about its limitations).

---

### 31. Open item 1 executability: "Re-run snippet-hits-killgate.mjs over k in {3, 5, 8} and excerpt in {500, 1000, 2000}"

The kill-gate script imports `SNIPPET_HIT_COUNT` and `SNIPPET_CHARS` as named constants from `transplant.mjs` (line 24). It does not accept k or chars as command-line arguments. Executing this sweep requires editing the constants in `transplant.mjs` before each run (or adding CLI argument parsing to the gate). The command and parameter values are fully specified but the script is not parameterized for a sweep.

**PASS** (executable cold with a trivial edit per cell, not a blocking gap).

---

### 32. Open item 2 executability: "Add a gate that greps the tail ... drop or rewrite qo05"

The item names the mechanism (grep the tail for the referent's tool name + n-grams) and the result (`--phase prep-overflow --window 131072`). The harness already has `--phase prep-overflow`. Cold-executable. **PASS**.

---

### 33. Open item 3 executability: retry on provider empty turn

**Claim**: "Retry once on the provider's empty turn and persist the raw choice (packages/core/src/models/openrouter.ts:187)."

The file path and line are named. The 50-row re-run command and cost are stated. **PASS**.

---

### 34. Open items 4-7

All name the command, arms, n, and approximate cost. Item 6 specifies "~43 lines in the harness per analyzer A4." Item 7 names the cost to freeze a longer trace. All are cold-executable as written. **PASS**.

---

## Omitted lessons and challenged next steps

### Omitted lessons a fresh reader needs

1. **The denominator convention is unstated.** Throughout the report, medians and per-run averages silently exclude model_call_error rows (which have `usage.input = 0` and `modelTurns = null`), while token totals include them. The iteration 1 and iteration 3 tables each mix both conventions in the same row. A reader cannot replicate the -54% figure, the 31,508 median, or the 1.42 fetches/run from the table's own numbers without knowing to filter by status. This should be stated once, clearly, before the first table.

2. **qo01 rep 1 in snippet-hits is an outlier.** Its uncached input (115,238 tokens) is 12x the arm's median (9,253). The report does not note it. At n=5, one outlier moves the mean (and total) substantially. If the reader computes a mean from the table's total, they get 12,738 per run; without this one row, the mean is 8,251. This matters for the cost comparison.

3. **The kill-gate reports a figure the report does not quote**: "answer branch visible: 49/56." The report quotes 48/56 (literal) and 53/56 (event) but not 49/56 (branch). This is not an error, but a reader who runs the gate will see a figure the report never explains.

### Challenged next steps

1. **Open item 1 (constant sweep) is nearly zero-cost but the script needs parameterization.** The current gate hardcodes the constants from `transplant.mjs`. The sweep would be faster with a `--k` and `--chars` CLI flag. This is a 5-line edit, not a research gap, but as written the "~1 hour" estimate assumes a developer loops over `sed` edits and re-runs.

2. **Open item 4 (second model) cost estimate "$1-3" should be verified.** At 25 rows per arm * 2 arms * 5 reps = 50 rows, and the iteration-3 batch cost $0.299 for 50 rows on GLM 5.3 Flash, a model 3-10x more expensive would cost $0.9-3.0. The range is plausible but depends on the model's pricing, which is not cited.

3. **The report does not mention that snippet-hits qo01 rep 1 scored despite using 115k uncached tokens** -- one of the highest uncached-input rows in the entire pass. If the snippet arm's advantage is "fewer tokens," this outlier deserves a sentence explaining why it happened (the row's `cacheRead` was only 106k vs the ~175k typical for center-filename completed rows, so total input was still lower, but the uncached component was anomalous).

---

## Summary

| verdict | count |
|---|---|
| PASS | 29 |
| FAIL | 3 (findings 4, 8, 19, 20 -- finding 20 is the most consequential) |
| UNVERIFIABLE | 1 (finding 22, token count only) |

The three FAILs are:
- **Finding 4**: Median uncached input is completed-only, not labelled as such.
- **Finding 8**: tree-tail-v2 qo04 centering seqs omit 121.
- **Finding 19**: One of three qo04 successes used the third search, not the second.
- **Finding 20**: "-54%" is computed from completed-only uncached input but the table shows all-rows totals; a reader who divides the table's numbers gets -59%.

Of these, finding 20 is the one a skeptical reviewer would flag hardest: the headline statistic in the abstract, repeated in algorithm.md, does not match a straightforward division of the numbers in the report's own table.
