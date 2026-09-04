# Iteration 2 analyzer: live tool-call telemetry

## Verdict

The live cell is complete and same-epoch: it contains 75 scheduled rows, five
replicates for each of five questions and three arms, with `partial:false`.
The question SHA and all three preregistered source/runtime fingerprints match
`iteration1-preregistration.md`; the resolved model is
`z-ai/glm-5.3-flash`. The live result is:

| Arm | Provenance-audited successes | Completed | Stalled | Model-call error |
| --- | ---: | ---: | ---: | ---: |
| `truncate-tail` | 0/25 | 25 | 0 | 0 |
| `tree-tail-v2` | 1/25 | 21 | 3 | 1 |
| `tree-center-filename` | 4/25 | 23 | 0 | 2 |

`tree-center-filename` does **not** meet the preregistered win condition and
must not escalate. Its headline delta is only +3/25 over `tree-tail-v2`, below
the required +4/25, although it strictly beats the 0/25 raw-tail proxy. More
importantly, the qo04 target mechanism delivered the answer in 0/5 scheduled
attempts, not 5/5. The candidate did select the correct branch and center on
sequence 218 in every non-error qo04 attempt, but the payload did not survive
the shared append budget. This is a centering bucket win offline and a live
delivery failure, not evidence that the candidate improves answering.

The +3 headline delta is unrelated to bare-filename centering. All four
candidate successes are qo03, for which the offline replay recorded
`mechanismFired:0`; live candidate and incumbent fetches both center at
sequence 264. The candidate happened to retain positive fetch headroom in
four qo03 replicates versus one for the incumbent. Those are exactly the five
answer deliveries and five successes in the entire pair of tree arms.

## Search and fetch budget

The initial exact tool-result headroom was only 7,886--7,919 tokens. Of the 47
tree rows that reached a first search, 46 returned the full 20-hit list without
truncation; the remaining call was an empty-result qo03 query. A full first
list occupied 6,094--7,257 tokens (median 7,015), or approximately 77--92% of
the available headroom before any branch content was fetched.

Across all tree attempts there were 142 searches. The ranker produced 20 hits
for 135 calls and zero for seven. Once prior results had consumed the budget,
92 search results were truncated and 57 were reduced to zero bytes. `hitIds`
records pre-cap ranker output, so later hit positions do not prove that the
model saw the hit; the first 20-hit result is the clean visible-rank reading.

There were 88 fetch calls. Only 11 had positive exact headroom; 77 had
non-positive headroom and every one of those 77 returned zero bytes. Fetch
headroom ranged from -109 to 1,164 tokens with a median of -36, and the median
delivered fetch size was therefore zero. Only five fetches contained an answer
literal after the cap, all on qo03. Each of those five rows scored, and no row
scored without a delivered literal.

The harness behavior is consistent with `capToolResult` in
`eval/scripts/transplant.mjs:401-433`: a tool result with non-positive append
headroom is replaced by the empty string. The live configuration's retrieval
limit is 20, and `legacySearchHits` passes that configured limit to the
retriever at `eval/scripts/transplant.mjs:1519-1533`.

## Per-question telemetry

Ranks below are the answer branch's position in the first untruncated search.
“Selected” counts scheduled runs in which the model fetched the answer branch
at least once. Positive counts are fetch calls, not necessarily answer-bearing
fetches.

| Question | First-search answer rank, incumbent / candidate | Median first-search tokens, incumbent / candidate | Answer branch selected, incumbent / candidate | Positive fetch calls, incumbent / candidate | Delivered and scored, incumbent / candidate |
| --- | --- | ---: | ---: | ---: | ---: |
| qo01 | 1 / 1 | 6,095 / 6,095 | 2/5 / 4/5 | 0 / 0 | 0/5 / 0/5 |
| qo02 | 2 / 2 | 7,016 / 7,016 | 1/5 / 0/5 | 0 / 0 | 0/5 / 0/5 |
| qo03 | 7 / 7 (one candidate first search returned zero hits) | 7,147 / 7,147 | 5/5 / 5/5 | 1 / 4 | 1/5 / 4/5 |
| qo04 | 1 / 1 | 7,256 / 7,256 | 3/5 / 4/5 | 1 / 1 | 0/5 / 0/5 |
| qo05 | 1 / 1 | 6,731 / 6,909 | 5/5 / 5/5 | 1 / 3 | 0/5 / 0/5 |

- **qo01:** Ranking was already sufficient. Candidate selection improved, but
  all 16 fetch calls across the two arms had non-positive headroom and returned
  no branch bytes. This is a delivery failure after rank and selection.
- **qo02:** The answer branch was visible at rank 2 in every first search, but
  the candidate selected other hits (observed selected ranks 7, 11, 15, and
  16) and never fetched the target. All eight candidate fetches were empty
  anyway. Both model selection and delivery fail here.
- **qo03:** Both arms selected the lower-ranked answer branch in all five runs.
  The answer-bearing full branch was only 813 tokens before capping; positive
  headroom of 740--745 tokens retained the literal. Candidate delivery 4/5
  versus incumbent 1/5 tracks tool-call behavior, not the filename change.
  The three incumbent stalls repeatedly requested the correctly centered
  branch after headroom was already negative and received empty results.
- **qo04:** Candidate ranking and centering worked. In the four non-error runs,
  the answer branch was rank 1, was fetched, and the first relevant fetch
  centered at sequence 218 with bare-filename terms. Three runs issued two
  searches before fetching and reached -17 or -18 exact headroom; the only
  one-search run retained 623 tokens but requested `depth:index`, which did
  not contain the answer. The offline replay had needed 6,609 exact tokens to
  serve an answer-bearing prefix of the 7,707-token centered payload, so the
  live one-search case was short by 5,986 tokens. A later retry in rep 5
  removed the dotted filename syntax, reverted the center to 55, and still had
  -75 headroom. Rep 2 failed before any model/tool telemetry. Thus the
  mechanism fired in 4/5 scheduled attempts (4/4 observable attempts), but
  delivery was 0/5.
- **qo05:** The target was rank 1 and selected in every run, but candidate
  positive headrooms of 919, 985, and 1,164 tokens were too small or attached
  to index fetches; none retained the answer. This again fails after ranking.

`truncate-tail` made no tool calls and scored 0/5 on every question, as the
fixture intended.

## Failure accounting and route

Three scheduled attempts ended as `model_call_error`: incumbent qo01 rep 4,
candidate qo02 rep 1, and candidate qo04 rep 2. Their rows have null
`turns`, `toolCalls`, `usage`, candidate mode/key, and no recorded error
message, so the artifact cannot diagnose the provider failure. Three more
attempts, all incumbent qo03, stalled after repeated zero-byte fetches. These
six attempts correctly remain in the denominator.

Against the preregistration: qo04 mechanism/delivery fails; the +4/25 headline
threshold fails; strict superiority to `truncate-tail` passes; protected-slice
delivery is not lower than the incumbent; and all counted successes have
payload provenance. Because the escalation rule requires **every** mechanism
and protected-slice gate to pass, the +3/25 score delta does not authorize the
n=10 escalation.

Route the next iteration to the shared search/fetch budget, not to another
centering or ranking rule. The cheapest next evidence is an offline replay that
varies only the model-visible search-result representation or its derived
budget reservation, then checks whether the already top-ranked qo01/qo04/qo05
branches can deliver at the exact live headrooms while preserving visibility
of qo02 at rank 2 and qo03 at rank 7. A fixed top-1 cut is not an adequate
candidate because it would hide those latter targets. Preserve the finding
that bare filenames correctly move qo04's center from the legacy distractor to
sequence 218; reject only the claim that centering alone repairs live delivery.

## Evidence

- Live result:
  `eval/fixtures/transplant/s1/e1b289c32f40/results/run-W65536-truncate-tail+tree-tail-v2+tree-center-filename-questions-deep-q9ebc3150-cb2b5adc512bc-n5-z-ai_glm-5.3-flash.json`
- Live preregistration:
  `reports/metrics/ds-star-native-context/iteration1-preregistration.md`
- Authorized design and thresholds:
  `reports/metrics/ds-star-native-context/judge-iteration1.md`
- Offline centering/delivery replay:
  `reports/metrics/ds-star-native-context/iteration1-offline.json`

All counts above were recomputed directly from `rows[].toolCalls[]`, using
`questions-deep.json` to map each question to its answer branch. No historical
result file was pooled into the live counts.
