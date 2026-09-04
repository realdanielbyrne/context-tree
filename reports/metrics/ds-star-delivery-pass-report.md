# The oracle was never an oracle: retrieval loss is delivery and display, not extraction

Context-tree retrieval · DS-STAR delivery pass · September 3, 2026

Context-tree reorganizes an agent's linear conversation trace into a summary-headed tree, so
a long-running session sees branch summaries instead of raw history and pulls detail back on
demand through retrieval tools. A previous pass handed the model the correct branch by fiat,
scored 13 of 25 against a 25-of-25 ground truth, and concluded that half the remaining loss
lived *after* retrieval, in the model's ability to extract an answer it had been given. This
pass asked why an oracle is not perfect, and found that it had never been an oracle: the
correct branch is a coordinate, and the payload is a band narrowed to roughly 6,600 tokens of
live headroom out of a branch of 56,973. For one of the five questions no query the model
issued ever centred that band on the answer — 0 of 30 recorded runs delivered — so at least
five of the twelve lost points are content that never arrived. Running the missing
real-search cell splits the live loss at the delivery boundary: of 18 points lost against
ground truth, 13 are payloads that never carried the answer and 5 are payloads that did and
still failed. Within that first group, 9 runs never fetched the correct branch at all —
a sub-diagnosis, not a third bucket, and the least expected part of the result because the
offline ranker is nearly perfect on this set — 5 of 5 in the top three,
3 of 5 at rank one — while the model fetches the correct branch on only 16-18 of 25 runs. The
cause is that a search hit renders without the evidence it was ranked on: the correct branch
displays as the bare word `diagnosis` while a distractor displays as `loop.ts`, and the model
takes the distractor five times out of five. The obvious repair — show the model the matching
fingerprints — was built, pre-registered and refuted: selection was 18 of 25 against the
baseline's own 18 of 25, for 32% more input tokens and twice the stalls. Extra legible leads
are leads the model follows. Two offline gates and a provenance audit were added, a third gate parameterized; the audit
mechanically reproduces the previous pass's hand-found fabrications and drops one baseline
cell from 4/25 to 0/25. The main limitation is unchanged: one 754-event session, one model,
five questions per set.

## 1 Terms

**L0** is the append-only event log; **L1** the tree of nodes that point into L0 by
sequence range. **W** is the model's context window. **truncate-tail** sends the most
recent raw events that fit W and answers in one turn; **naive-full** sends the entire
trace and is the ground truth. **tree-tail-v2** is the full tree arm — keyword-fingerprint
headlines in Zone B, hybrid fingerprint-plus-grep search, relevance-centred fetch
narrowing. **tree-oracle** is byte-identical to it except that `context_search` returns
the question's own source branch and nothing else. The **overflow regime** is the
condition the tree exists for: the trace exceeds W and the answer lies outside the raw
tail. The **frozen store** is one real session on this repository — 754 events, ~196,000
tokens, 21 phase branches, 24 file branches.

A **fingerprint** is a path, identifier or symbol extracted deterministically from raw
events. The retriever ranks on them; Zone B headlines display them.

## 2 How this pass was run

This is a DS-STAR pass (arXiv 2509.21825, as adapted in `~/.claude/skills/ds-star`). The
method matters to the reader because it explains why some sections report a *refutation* as
a result and why the largest findings arrived from measurements nobody set out to make.

The loop is: analyze the system, quantify the gap into buckets that sum, plan candidates,
implement **one measurable change**, verify it against a same-epoch baseline at n≥5, then
**route** on the outcome — land a clean win, ablate a split verdict, revert a regression and
journal why, raise n once on no signal. Two disciplines do most of the work. **Kill gates**
are zero-token checks that run as numbered steps *before* any live spend, and a gate that
fails is allowed to retire queued candidates unspent. **Pre-registration** fixes the win
criterion before the batch, so a near-miss cannot be talked into a success afterwards. A
pass is bounded at three iterations and closes with a committed report.

An honest accounting of what this pass's three parts actually were — the skill warns against
dressing a phase up as an iteration, and only the third is a full turn of the loop:

| | what ran | route taken |
|---|---|---|
| **1 — instrument** | No candidate. Fixed a red suite, built `provenance-audit.mjs`, parameterized `rank-killgate.mjs`. All zero-token, because each changes the denominator of everything after it. | The rank gate's result **retired the queued candidate's premise unspent**: the deep set is 5/5 top-3 and 3/5 rank-1 offline, so `tree-route`'s ranking argument was dead before a dollar was spent (§5). |
| **2 — measure** | One 25-run cell, `tree-tail-v2` on the deep set, $0.152. Pre-registered: ≥11/25 means retrieval is at its ceiling, ≤6/25 means a live selection gap. | Landed at **7/25 — the ambiguous band**, which under the loop's rules is not a verdict. What broke the pass open was not the cell but a question put to it from outside — *why is the oracle not 100%?* — which the pass had not asked because it had inherited the previous pass's answer. That is where the delivery defect was found (§3). |
| **3 — candidate** | `tree-hit-keywords`, one measurable change against `tree-tail-v2`. Two kill gates ran first; the second **failed** and caught the arm as a silent no-op before the batch (§7). Pre-registered: selection ≥21/25 primary, score ≥11/25 secondary. | **No signal on the primary, and the escalation was declined.** See below — an earlier draft called this a regression, which the pre-registration does not support. |

**The route taken in iteration 3, stated against the rule rather than the impression.**
The pre-registered primary was branch selection. The arm scored **18/25 against the
baseline's own 18/25 in the same batch — identical**, which is the loop's *no-signal* row,
not its regression row. No-signal says raise n once, baseline included, and retire if still
flat. That escalation was **declined**, and the reason should be on the record: n here is
5 questions × 5 replicates, outcomes cluster hard by question, so raising replicates buys
almost nothing — the fix would be more questions, which is a different item (14.6). The
score did fall 7/25 → 3/25 and effort rose 32%, but score was the *secondary* and effort was
not pre-registered at all, so neither can carry the verdict: promoting a bucket after the
fact is exactly what pre-registration exists to stop. The defensible statement is **the arm
did not move its primary and cost 32% more to not move it**, which is enough to reject it
and not enough to call it a regression. It is retained in the harness marked rejected so the
negative result stays reproducible.

**Which stopping reason ended it: the three-iteration bound**, not a goal met and not
diminishing returns. The gap that opened in iteration 2 — a mis-centred retrieval band — is
still open and is item 14.1.

One methodological note that shapes how to read §3 onward. A **ceiling probe** replaces one
pipeline stage with a perfect version by fiat and measures what the rest achieves;
`tree-oracle` is that probe and is never a scored arm. This pass's central finding is that
the previous pass's ceiling probe was a ceiling for a *narrower* stage than anyone realised,
which is a failure mode the skill now records.

## 3 What the previous pass concluded, and why it was wrong

The multi-index pass ran a ceiling probe: hand the model the correct branch on the first
search call and see what the rest of the pipeline achieves. On the deep question set it
scored 13 of 25 against a 25-of-25 ground truth, and the pass read the residual as
**post-retrieval loss** — the model failing to extract an answer it had been given. That
reading is recorded as a boundary condition in `reports/algorithm.md` and it framed the
whole open-items list, which put a retrieval-side routing arm first.

It assumed the answer was delivered. It was not always delivered, and the assumption was
never checked.

A branch is a coordinate, not a payload. `context_fetch` narrows a branch to the live
per-call headroom, growing a band outward from the events the query matches. Three of the
five deep questions live in a single branch of **56,973 heuristic tokens** — larger than
the entire 65,536-token window it is read at — and the live headroom at that window is
about 6,600 tokens. The model receives roughly one ninth of the branch, centred wherever
its query happened to match.

Whether the answer is inside that band is a property of the query, and it is measurable
offline. `eval/scripts/delivery-killgate.mjs` replays every recorded run's own first query
through the real narrowing path, at the headroom that run actually had — derived per result
file from its budgets and its first turn's prompt, never a constant, so the gate cannot
repeat the narrowing gate's mistake of sweeping an axis the live path never occupies. The
median headroom it derives is 6,598–6,631 across the deep cells.

| deep question | branch tokens | answer at | band carries the answer | `tree-oracle` score |
|---|---|---|---|---|
| qo01 | 56,973 | 52% | 30/30 | 5/5 |
| qo02 | 28,946 | 76% | 30/30 | 1/5 |
| qo03 | 3,593 | 89% | 30/30 | 5/5 |
| qo04 | 56,973 | 76% | **0/30** | **0/5** |
| qo05 | 56,973 | 68% | 25/25 | 2/5 |

The delivery column pools every recorded run across all arms and windows for that question
(n=30, or 25 where one arm did not reach it); the score column is `tree-oracle` alone at
W=65,536. A second pass over the same data sweeps the budget from 4,000 to 64,000 tokens and
separates two failure modes that look alike: qo04 is `--` at every budget through 40,000 and
only reaches YES at 64,000, where the band is essentially the whole 56,973-token branch. It
is **mis-centred, not starved** — growing the budget does not reach it, so the fix is where
the band centres. One row of the gate's output needs its own footnote: qo04 shows
`delivered 0/30` beside `scored 1/30`. That one success is the deep oracle at W=131,072, and
it is among the six rows §4's stricter served-band check flags — a run that produced the
literal without any recorded band carrying it.

For qo04 no query the model issued ever centred the band on the answer at any live
headroom. Five of the
oracle's twelve lost points are content that never arrived. The remaining seven are
post-retrieval loss — with one caveat that cuts in a single direction: the gate measures
what the RETRIEVER returned, not what survived the append cap that re-cuts it downstream.
Anything the cap then removed is counted here as delivered when it was not, so five is a
LOWER bound on the delivery bucket and seven an upper bound on extraction. "Roughly half
the loss is after retrieval" becomes "at most three fifths of the oracle's loss is after
retrieval, and at least two fifths is delivery" — and the oracle is a **branch-ranking**
ceiling, not a retrieval ceiling.

One further inversion falls out of the same rows. Perfect selection *increases*
truncation. A one-hit search leaves more headroom, the fetch asks for a wider band, the
band overruns the real BPE count and the append cap fires: on qo02 the oracle sheds
0–4,431 tokens per run, four of the five runs above 3,500, while `tree-tail-v2`, whose
20-hit list leaves less room, sheds 0–280 across the cell. The arm with the better
retrieval has the worse delivery.

## 4 The instrument had to be repaired first

Three zero-token items ran before anything was measured, because each one changes the
denominator of everything after it.

**The suite was red and is now green.** Both failures in
`eval-resumption/harness/harness.test.ts` were advertised-versus-enforced contract drift:
the `context_fetch` schema shown to the model had lost `from`/`to` and the whole `index`
depth, and still named `summary` as the default after R9 made it `full`. The arm-D test
asserted a summary phrase that raw-by-default no longer returns; it now asserts the
replayed source line is present and the paraphrase is absent, so flipping the default back
fails it. A new assertion requires every advertised enum to equal its zod enum, and is
mutation-verified — removing `index` fails it. The suite is **966 passed, 9 skipped, 0
failed**; the nine skips are the `LIVE=1` opt-in cells.

**Every score is now provenance-audited.** `eval/scripts/provenance-audit.mjs` re-scores
all rows in the question-set result files, keying each to its set from the filename
because the two sets reuse question ids for different questions. A success is earned only
if the answer literal is present in the rebuilt prompt or in a branch the run actually
fetched; otherwise its score becomes `null`, never `0` — an unearned success is not a
wrong answer. It reproduces the previous pass's hand-found artifacts mechanically:

| cell | before | after audit |
|---|---|---|
| overflow W=65,536 `truncate-tail` | 4/25 | **0/25** |
| overflow W=32,768 `tree-tail-v2`, in `run-W32768-truncate-tail+tree-tail-v2-…` | 1/25 | **0/25** |
| all cells, before this pass's three deep arm-cells (75 rows) | 183/450 | 178/450 |
| all cells, as the script reports today | 200/525 | 195/525 |

The script prints that second cell pooled across its two batches (2/50 → 1/50); the 1/25 →
0/25 above is the one file named, recovered from `--json rows[]` — the *other* W=32,768 file
keeps its success, which is earned. An earlier draft named the wrong one of the pair. Zero rows were
unverifiable. Two rows cite sequence numbers that do not exist in a
754-event trace, one of them a scored zero — the same fabrication in a wrong answer, which
is why the citation check runs on failures too.

The audit also *measures* what the previous pass could only infer from median turns:
question-set decay. Counting successes that never needed retrieval because the answer was
already in the assembled prompt, `tree-oracle` on the overflow set is 0 of 17 at W=32,768,
0 of 21 at W=65,536, **10 of 23** at W=98,304 and **20 of 22** at W=131,072. The deep set
is 0 at every window: it is clean where it claims to be. And the baseline the routing item
feared was unaudited survives — both `tree-tail-v2` successes at W=65,536 are earned.

**The audit's own weak spot, found by attacking it.** `earned-fetch` asks whether the
literal was in the BRANCH the run fetched — it replays the whole branch. That is not the
same as asking whether the literal was in the band the run was *served*, and the difference
is exactly this pass's subject. Reconstructing the served band from each run's own budgets
(turn 1, the most generous turn) finds **6 of the 195 audited successes scored on a branch
whose served band did not carry the literal**. All six are `tree-oracle`, which is a
diagnostic probe and never a scored arm, so no comparison in this report moves — including
the deep-set decomposition, which has none. The affected cells are the overflow oracle at
W=32,768 (4 of 17) and W=65,536 (1 of 21), and the deep oracle at W=131,072 (1 of 10).
These are reported and not nulled, because the headroom is reconstructed rather than
recorded; the honest reading is that oracle scores are a slight overstatement at the
stricter standard. The lesson generalizes past this harness: **a provenance check is only
as strong as the narrowest thing it asks about**, and "did the run fetch something
containing the answer" is a weaker question than "did the run receive it".

Result headers written from commit `9a44f9d` onward carry `answeringUsd` per model and a
`code` fingerprint (git SHA plus content hashes of `retriever.ts` and `transplant.mjs`), so
two batches run against different working-tree state can be told apart. **Only 2 of the 19
question-set result files have one** — every `tree-oracle` cell and both `naive-full`
ground-truth cells predate it and cannot be epoch-checked at all. And the first thing the
fingerprint did was catch this pass: see §5.

**The rank gate is no longer pinned to one question set.** It hardcoded `questions.json`,
so the offline top-3 rate had never been measured on either new set, and the previous
report compared "10/12 offline" against a live score on five different questions. The bar
is now a fraction of the set — two-thirds, which is the original 8-of-12 — rather than a
count.

## 5 The measurement that redirected the pass

| question set | offline hybrid top-3 | offline rank-1 | `tree-oracle` live | `tree-tail-v2` live |
|---|---|---|---|---|
| `questions.json` (12) | 10/12 | — | — | — |
| `questions-overflow.json` (5) | 3/5 | 2/5 | 21/25 | 2/25 (0/25 in a second batch; 2/50 pooled) |
| `questions-deep.json` (5) | **5/5** | **3/5** | 13/25 | 7/25 |

The two sets dissociate. The ranker is **better** on the deep set and the oracle is
**worse** there. Two deep questions rank first offline and still score 0/5 and 2/5 with
the correct branch handed over. Whatever is failing on the deep set, ranking is not it —
which retired the ranking half of the routing candidate that the previous pass had ranked
first, before a dollar was spent on it.

`tree-tail-v2` on the deep set was one un-run cell that the previous report identified and
did not execute; it cost $0.152 and closes the split permanently. Three checks run over
that cell by `eval/scripts/pipeline-decomposition.mjs`, which exists because an adversarial
recount of an earlier draft could not reproduce the middle number under any of five
reasonable definitions — the definition had never been written down. It now lives in code:

- **SELECTED** — the run fetched the question's own source branch.
- **DELIVERED** — the payload the run actually *received* carried the answer literal.
  Every branch the run fetched is replayed through the same call the handler makes,
  `fetchBranch(id, {depth:'full', maxTokens: liveHeadroom / ratio, query})`. Any fetched
  branch counts: a run that found the literal in some other branch was still served it.
- **SCORED** — as recorded by the grader, provenance-audited.

| check | `tree-tail-v2`, deep, W=65,536 |
|---|---|
| SELECTED | 16/25 |
| DELIVERED | 12/25 |
| SCORED | 7/25 |
| ground truth (`naive-full`, W=200,000) | 25/25 |

**These are three independent checks, not a funnel, and an earlier draft was wrong to
present them as one.** They are not nested: on qo01 the arm selected the correct branch on
3 runs but was delivered the answer on 4, because a different branch it fetched also
contained the literal. Subtracting one from the next therefore does not decompose anything.

What *is* arithmetically exact is a two-way split at the delivery boundary. Of the 18 points
lost against ground truth:

- **13 were lost at or before delivery** — the payload never contained the answer (25 − 12).
- **5 were lost after delivery** — the payload contained the answer and the run still failed
  (12 − 7).

So roughly **72% of the live loss is retrieval reaching the model with the wrong bytes, and
28% is the model failing on the right ones.** Selection is a sub-diagnosis of the first
group rather than a separate bucket: 9 of the 25 runs never fetched the correct branch at
all. The purest case is qo04, which selected 5/5 and delivered 0/5 — the branch was found
every single time and the answer never arrived.

**How much DELIVERED depends on its own definition.** Counting any fetched branch is fair
to the run but generous to the bucket: the literal `tokenizerId` occurs in 6 of the 46
replayable branches, so a run can be credited for finding it somewhere else. Restricted to
the question's own branch the count is 11/25 and the split is **14/4** rather than 13/5.
Both are printed by the script. The looser rule is the one quoted above and it works
*against* the report's own headline, shrinking the retrieval bucket it emphasises. Turn 1's
headroom is used, which is the largest any turn has, so DELIVERED is an upper bound under
either rule; recomputing with the last turn's headroom changes nothing here.

**Two batches, and what the code fingerprint says about them.** The figures above come from
`run-W65536-tree-tail-v2-questions-deep-*.json`. The arm ran again later as the baseline
half of §7's paired batch and scored **7/25 again**, with 18/25 selected. Score is stable
and the retrieval counts carry a spread of about ±2 on a 25-run cell.

They are **not** the same harness code, and this pass's own new instrument is what caught
it: the two headers carry the same git SHA and different `transplant.mjs` hashes
(`4d81e190d7c4` against `663b5a451c69`), because the `tree-hit-keywords` arm was added
between them without a commit in between. The drift is additive and gated on a different
arm, and the identical 7/25 is evidence it did not reach the baseline's path — but that is
an argument, not a guarantee, and an earlier draft of this paragraph called the pair "same
arm, window, store and model, two independent epochs" without checking the field. The
lesson is not that the fingerprint failed; it is that **an instrument only helps if the
sentence it contradicts gets checked against it.**

**A result that does not fit a monotone delivery story — and what the script says about
it.** If the oracle's residual were purely delivery, and delivery is bounded by headroom,
widening the window should help. The deep oracle instead goes **13/25 at W=65,536, 15/25 at
W=98,304, 10/25 at W=131,072**, and the audit confirms none of those successes came from the
prompt rather than retrieval (0 no-retrieval at every deep window). Running the
decomposition across all three windows shows the mechanism:

| deep `tree-oracle` | W=65,536 | W=98,304 | W=131,072 |
|---|---|---|---|
| SELECTED | 25/25 | 23/25 | **17/25** |
| DELIVERED | 20/25 | 18/25 | 12/25 |
| SCORED | 13/25 | 15/25 | 10/25 |

**The oracle's selection collapses as the window widens.** Handed a one-hit search result,
the model fetched that branch every time at W=65,536 and ignored it on 8 of 25 runs at
W=131,072 — the wider prompt gives it more to look at and it stops taking the hint. The dip
is therefore not an unexplained delivery mystery; it is at least partly a selection
failure, and it is the same behaviour §6 documents at the narrower window in a different
guise. What remains genuinely unexplained is why a wider window should make the model less
willing to act on a single hit.

That table also cross-validates §3's split from an independent direction: at W=65,536 the
oracle SELECTED 25/25, DELIVERED 20/25 and SCORED 13/25, so 5 of its 12 lost points are
undelivered and 7 are post-delivery — exactly the 5 and 7 §3 derives from the delivery gate.

The same file also carries `truncate-tail` at **0/25** on the deep set at W=131,072 — the
same-store head-to-head establishing these answers are genuinely out of the baseline's
reach at every window tested.

## 6 Why the model does not use a good ranker

The obvious explanation for 16–18/25 selection against 3/5 offline rank-1 is that the
model's own reformulated query ranks worse than the question text does. It does not: on the
deep set the two agree almost exactly, ranks 1, 2, 7, 1, 1 against 1, 2, 3, 1, 1. The check
took two minutes and the conclusion reverses without it.

The real reason is visible the moment the hit list is rendered. For qo02 — *"When
constructing the `armArgs` object, which property from `options` is used to set
`deadlineMs`?"* — the correct branch is ranked **second**, and the model fetched the hit
at rank 10 or 11 on **five runs of five** in the first deep batch. Here is what it was
shown:

```
# 1 score=0.033 phase/implementation "implementation"     files=…build-multimod-scenario.py  symbols=build_hidden_test,case,…
# 2 score=0.033 phase/diagnosis      "diagnosis"          files=-  symbols=-        <-- CORRECT
# 3 score=0.024 phase/diagnosis      "diagnosis (4)"      files=-  symbols=-
…
# 9 score=0.014 task/-               "task"
#10 score=0.014 file/-               "build-multimod-scenario.py"                   <-- model fetched
#11 score=0.014 file/-               "loop.ts"                                      <-- model fetched
```

The correct hit renders as the word `diagnosis` and nothing else. A phase hit carries its
title, kind, and whatever `meta.files` / `meta.symbols` its summary happened to record —
for a phase node, routinely nothing. Asked where `armArgs` sets `deadlineMs`, and offered
`diagnosis` against `loop.ts`, the model picks `loop.ts`. That is the rational choice on
the evidence displayed. (In the later paired batch three of five qo02 runs fetched the
rank-1 phase hit instead, so five-of-five is a property of the first batch, not a constant.)

The evidence it was **not** shown is the evidence the ranking was computed from. That
branch carries 425 extracted fingerprints, `ArmArgs`, `r.options` and `deadlineMs` among
them. The ranker scored it to rank 2 on exactly those, and none of them reach the model.
This is the same defect that the search-ranking pass fixed on the scoring side — summaries
do not contain the identifiers queries reference, so ranking on fingerprints took offline
top-3 from 2/12 to 10/12 — reappearing untouched on the display side.

## 7 The repair that followed from it, and its refutation

If the model chooses without the ranker's evidence, show it the evidence. `tree-hit-keywords`
changes exactly one thing against `tree-tail-v2`: each search hit carries the fingerprints of
that node which match the query. Ranking, limit, contract, fetch, narrowing and the append cap
are untouched.

Two offline defects had to be fixed before the arm could be tested at all, and both are more
interesting than the arm.

Ranking a hit's fingerprints by **query-token overlap** returns slabs, not keywords: a
4,998-character block of raw source contains more query tokens than any identifier does, so it
sorts above `deadlineMs` and the "keywords" are a page of code. Ranking instead by the fraction
of a fingerprint's own tokens that the query accounts for makes the same hit render as
`ArmArgs | r.options | deadlineMs`. The legibility gate reported 5/5 under both rankings — the
pass bit was right and the artifact was wrong, and only printing the artifact caught it.

Budgeting the keywords to the **search-result headroom share** made the arm byte-identical to
its own baseline. The bare 20-hit list is 5,203 tokens against a 1,649-token quarter-share, so
no keyword count ever fit and the handler returned the baseline list unchanged. Budgeted
against the whole live headroom — the budget the append cap actually enforces, which is rule 5
— the list grows from 5,203 to 5,377 tokens at 16 keywords per hit. A `hitKeywordK` field
records the count per search call, so a null result cannot be confused with a mechanism that
never fired; live it ranged from 0 to 52 with a median of 16 across 38 search calls, 13 of
which attached none because by then the headroom was spent. So the mechanism fired on every
*run* but on 25 of 38 *calls* — a distinction §9's own telemetry lesson demands be stated.

Both arms then ran in one invocation, same epoch, same store, n=5 per question.

| | `tree-hit-keywords` | `tree-tail-v2` |
|---|---|---|
| score (provenance-audited) | 3/25 | 7/25 |
| **correct branch fetched** | **18/25** | **18/25** |
| payload delivered the answer (any fetched branch) | 16/25 | 14/25 |
| payload delivered the answer (own branch only) | **13/25** | **13/25** |
| `context_search` calls | 38 | 63 |
| **`context_fetch` calls** | **68** | **46** |
| model turns | 114 | 106 |
| input tokens, whole cell | 609,073 | 460,389 |
| stalls | 4 | 2 |
| tokens truncated, whole cell | 1,050 | 326 |
| runs where keywords were attached | 25/25 | 0/25 |

**The mechanism fired and moved nothing it was built to move.** Selection is identical, and
so is delivery once it is measured against the question's own branch rather than any branch
the run happened to open — 13/25 against 13/25. The apparent +2 in the looser row is the
arm opening more branches, not retrieving better. The
pre-registered primary bar was selection ≥ 21/25 and the arm delivered the baseline's own
number. On qo02, the question the intervention was designed around, selection moved from 0/5
to 1/5 — which at n=5 is nothing.

The score difference is not significant either: 3/25 against 7/25 is p=0.289 by Fisher exact,
and the 25 are five questions × five replicates, so the effective sample is nearer five. What
*is* robust is the effort, and the table says precisely where it went. Turns rose only 7.5%
(114 against 106), nowhere near the 32% token growth, and the enriched hit list itself is
worth 174 tokens. **The cost is in fetches.** The arm searched 40% *less* (38 calls against
63) and fetched 48% *more* (68 against 46), and a fetch carries a branch payload where a
search carries a hit list.

That is the mechanism, and it is not the one an earlier draft asserted from turn counts.
Keywords in the hit list gave the model enough apparent evidence to stop searching and start
committing to branches — so it opened more of them, each one expensive, and still did not
select better. Extra legible leads are leads the model follows. The clearest single row is
qo03: both arms fetched the correct branch on 5 of 5 runs, the baseline took 3, 3, 3, 6 and 3
turns and scored 4/5, and the keyword arm took 5, 3, 7, 9 and 4 turns and scored 0/5. Making
the correct hit legible does not make the model choose it; it makes
the model look further. The diagnosis in §6 survives as a description of what the baseline
does — the correct hit really does render as the bare word `diagnosis`, and the model really
does take a rank-10 or rank-11 hit five times out of five in that batch — but the causal
step from that observation to
"therefore show it the keywords" is refuted. The arm is retained in the harness, marked
rejected, so the negative result stays reproducible.

One thing the batch established for free: `tree-tail-v2` on the deep set scored 7/25 in this
batch and 7/25 in an independent earlier one, 14/50 pooled. The baseline is stable across
epochs, which is what makes the comparison above worth anything.

## 8 What was rejected, and the number that rejected it

- **`tree-route` on the ranking argument** — retired unspent for the deep set. Offline
  ranking there is 5/5 top-3 and 3/5 rank-1; there is no ranking gap for routing to close.
  Its *payload* argument survives and is untested.
- **Query reformulation as the cause of poor live selection** — ranks 1,2,7,1,1 under the
  model's own queries against 1,2,3,1,1 under the question text.
- **Reading `tree-oracle`'s 13/25 as post-retrieval loss** — retracted within this pass.
  Five of the twelve points are content the band never delivered.
- **Ranking hit keywords by query-token overlap** — produces slabs, not keywords. One
  branch's 425 fingerprints include 72 with whitespace, the largest 4,998 characters of
  raw source, and a slab that size contains more query tokens than any identifier does.
  Ranking by the fraction of a fingerprint's own tokens the query accounts for fixes it:
  the same hit goes from a page of source to `ArmArgs | r.options | deadlineMs`.
- **Budgeting hit keywords to the search-result headroom share** — made the arm a silent
  no-op. The bare 20-hit list is already 5,203 tokens against a 1,649-token quarter-share,
  so no keyword count ever fit and the handler returned the baseline list unchanged. The
  budget must be the whole live headroom, which is what the append cap actually enforces.
- **Zone B headline slab pollution** — checked and not present. The fingerprint set is
  insertion-ordered with paths first, so only 1 of 21 headlines contains a slab, worth 10
  heuristic tokens (11 in cl100k). The defect bites only where entries are ranked by overlap.

## 9 What was learned, as distinct from what was decided

- **A ceiling probe is only a ceiling for the stage it replaces.** `tree-oracle` makes
  *branch ranking* perfect and leaves *span selection inside the branch* exactly as it
  was. On a store whose largest phase branch is 57,000 tokens read through a 6,600-token
  headroom, that residual stage is most of the pipeline. The generalizable form: when you
  replace a stage by fiat, write down what the replaced stage hands to the next one — a
  coordinate is not a payload — and verify the next stage received what you think you
  gave it.
- **Ranking and display are different subsystems and only one of them was ever fixed.**
  Two passes improved what the ranker scores on. Nothing improved what the model is shown.
  The correct branch ranked second and rendered as the bare word `diagnosis`; the model
  chose a rank-10 hit that at least named a file, five times out of five. A ranker whose
  evidence is invisible to the consumer is a ranker the consumer cannot follow.
- **A one-hit result is obeyed less as the window widens.** Handed the correct branch and
  nothing else, the model fetched it on 25 of 25 runs at W=65,536 and on 17 of 25 at
  W=131,072. More prompt to look at makes it less willing to act on a single instruction —
  which means an oracle's own guarantee decays with window size, and any probe that assumes
  "handed over" equals "used" needs that checked per window.
- **Perfect retrieval can worsen delivery.** Fewer hits leave more headroom, a wider band
  is requested, and the append cap fires. Truncation was anti-correlated with hit-list
  size and correlated with failure. An arm that improves one stage can silently regress
  the next through a shared budget.
- **A budget expressed as a share of a resource is a no-op when the fixed cost already
  exceeds the share.** The first version of the keyword arm was byte-identical to its own
  baseline and would have been reported as "the hypothesis failed". It was caught by
  computing, offline, whether the mechanism could fire at the live headroom at all — a
  check that takes one script and belongs before every batch, not after a null result.
- **Telemetry for the mechanism must be in the row before the batch runs.** `hitKeywordK`
  records how many keywords each search call actually attached. Without it, an all-zero
  outcome and a fired-but-ineffective outcome are the same number.
- **An offline gate can pass on a correct metric and a wrong artifact.** The legibility
  gate reported 5/5 while the "keywords" it produced were multi-line slabs of source. The
  pass bit was right; reading the artifact is what caught it. Print what the gate produces,
  not only whether it passed.
- **The pass inherited a wrong conclusion and would not have questioned it unprompted.**
  The previous pass's oracle residual was recorded as post-retrieval loss, written into
  `algorithm.md` as a boundary condition, and used to order the open-items list. This pass
  read that, believed it, ran the item it implied, and only re-examined it when asked from
  outside why a probe handed the right answer scores 52%. The check that overturned it took
  minutes and needed no new data. The generalizable form: **a conclusion inherited from a
  previous pass is the least-audited thing in the room**, precisely because it arrives
  already written down and already cited. Re-derive the load-bearing one at the start of
  each pass, and treat a ceiling probe that is not at 100% as an open question rather than
  a measured constant.
- **A correction is not done until it has swept every site, and this pass failed that three
  times.** The abstract kept a funnel §5 had retracted; §7 kept a rank vector §6 had fixed;
  and a renumbering updated one sentence of §11 while leaving all seven rows of its own table
  pointing at the old sections. Each was caught by a reviewer, not by the edit. The habit
  that would have caught all three is mechanical: after changing a figure or a heading,
  `grep` the document for the old value and for every reference form before committing.
- **A headline figure with no written definition is not a measurement.** The delivery count
  was published as prose; an adversarial recount got 11, 12, 14, 20 or 23 depending on
  reasonable choices nobody had recorded. The fix was not a better number but moving the
  definition into a script the report cites. A figure whose definition lives only in the
  author's head cannot be checked, and will be read as whichever variant flatters it.
- **A bucket whose size depends on its own definition must publish both.** Counting any
  fetched branch gives 13/5; counting only the question's own branch gives 14/4. The looser
  rule happened to work against this report's own headline, which is exactly why quoting one
  silently would have been indefensible.
- **Stages that are not nested must not be drawn as a funnel.** Selection, delivery and
  extraction each answer a different question, and a run can be delivered without having
  selected. Subtracting one from the next decomposed nothing and produced arithmetic that
  looked exact and meant nothing.
- **Attribute a cost delta to the bucket that moved, not the bucket you assumed.** The +32%
  token growth was written up from turn counts, which rose 7.5%. It was fetches: 68 against
  46, while searches fell 63 to 38. Same conclusion, wrong axis — and mechanism attribution
  is the discipline that was supposed to prevent exactly that.
- **A next-steps command that overwrites its own baseline is worse than no command.** Every
  batch in this harness writes `run-W<window>-<arms>-<set>-<model>.json`, so the obvious
  rerun destroys the file the comparison is computed on. Any handoff that includes commands
  owes a copy-aside step and a check that a swept parameter appears in the output name.
- **Pre-registration that lives only in the session is an assertion.** Four bars were
  pre-registered in this pass and none is artifacted; the arm and its result landed in one
  commit. Write the criterion to a file, and commit it, before the batch.
- **A provenance check is only as strong as the narrowest thing it asks about.** This
  pass's own audit shipped asking "did the run fetch a branch containing the answer",
  which a run can pass while never receiving the answer — the very failure the pass exists
  to describe. Tightening it to the served band flagged six more rows. Ask about the
  payload, not the pointer.
- **The instrument audit keeps paying.** The provenance audit reproduced, mechanically and
  independently, artifacts the previous pass found by hand — and then measured
  question-set decay per row, which that pass could only infer from median turns.

## 10 Methodology lessons promoted to the skill

The DS-STAR skill (`~/.claude/skills/ds-star/SKILL.md`) is the only artifact that compounds
across unrelated projects, so a pass that learns something about *how to run a pass* owes it
an edit. Landed this pass:

| lesson | where |
|---|---|
| An oracle bounds only the stage it replaces; its residual is not automatically downstream. Write down what it hands the next stage and verify that stage received it. | Ceiling-probes section |
| An oracle that improves one stage can regress the next through a shared budget. | Ceiling-probes section |
| The previous pass's load-bearing conclusion is the least-audited thing in the room. Recompute the number the queue is ordered on; treat a ceiling probe not at 100% as an open question. | Discipline list |
| Prove the candidate's mechanism can fire at the live budgets before spending, and put a field in the row recording how much it did. | Discipline list |
| Read the gate's artifact, not only its pass bit. | Discipline list |
| A refuted repair does not refute the observation that motivated it. | Discipline list |
| The skill's own ceiling-probe example was teaching the conclusion this pass overturned. | Corrected in place |

Owed and not yet written, because each needs one more instance before it generalizes: *a
correction must sweep every site* (three failures here, §9); *pre-registration that lives
only in the session is an assertion* (four bars, none artifacted); and *publish both
definitions when a bucket's size depends on its own*.

## 11 State of the code

All paths relative to the repository root.

| Path | What it is |
|---|---|
| `eval/scripts/provenance-audit.mjs` | Re-scores every run against what it could have seen; nulls unearned successes; prints per-cell decay (`noRetrv`) and flags successes whose SERVED band lacked the literal |
| `eval/scripts/pipeline-decomposition.mjs` | The selected / delivered / scored counts in §5, computed under a definition that lives in code rather than in prose |
| `eval/scripts/delivery-killgate.mjs` | Replays each run's own queries through the real narrowing path at live headrooms; asks whether the answer is delivered at all |
| `eval/scripts/rank-killgate.mjs` | Parameterized over question sets; bar is a fraction of the set, not a count |
| `eval/scripts/transplant.mjs` | `tree-hit-keywords` arm; `answeringUsd` and `code` fingerprint in every result header; `openScenario`/`budgetsFor`/`buildArm`/`measureRatio` exported for the audit |
| `eval-resumption/harness/arms.ts` | `context_fetch` advertised schema realigned with the zod shape |
| `eval-resumption/harness/harness.test.ts` | Raw-by-default asserted positively and negatively; advertised enums asserted equal to zod enums |
| `reports/algorithm.md` | Five new boundary conditions; corrected oracle row; two new parameter rows |

## 12 Figures not emitted by any script

Everything in the reproduce-first block of §14 runs from committed code. These do not, and
a fresh agent cannot regenerate them without writing something new. They are recorded here
rather than left to be discovered:

| figure | where it lives | § |
|---|---|---|
| hit list 5,203 → 5,377 tokens, 1,649-token quarter-share, 16 keywords/hit offline | `transplant.mjs:1632-1633`, `:270` — comments. **5,377 appears nowhere in the repo at all** | 7 |
| 425 fingerprints, 72 whitespace-bearing, largest 4,998 chars | `transplant.mjs:260, 1481-1482` — comments | 6, 8 |
| Zone B slab: 1 of 21 headlines, 10 heuristic / 11 cl100k tokens | prose only | 8 |
| the 183/450 audit figure | prose only; the script prints today's 200/525 | 4 |
| model-query ranks 1,2,7,1,1 | prose only (`grep-model-queries.mjs` is pinned to `questions.json` and a different result file) | 6 |
| branch-size medians | prose only | 14.3 |
| the legibility gate's 5/5 (no committed script emits it) | prose only | 2, 7 |
| the pre-registered selection ≥ 21/25 bar | **prose only, and asserted rather than artifacted** — the arm and its result landed in one commit, so nothing in the repository proves the bar was set before the batch. The other three pre-registered bars — iteration 2's ≥11/25 / ≤6/25 and iteration 3's secondary ≥11/25 — are equally prose-only | 2, 7 |

The last row is the one that matters for anyone weighing the refutation: the bar was
pre-registered in the working session, and the repository cannot corroborate that. Treat it
as an author's claim. Future arms should write the criterion to a file before the batch.

## 13 What this pass did not test

One store, one scenario, one model. `tree-hit-keywords` was measured at a single window
(65,536) on a single five-question set; it has never run on the overflow set, at another
window, or against another model. The facet indexes remain offline measurements that have
never been placed in front of an answering model, so `tree-route`'s surviving payload
argument is still untested. The fingerprint extractor's slab pollution is filtered at the
display boundary and left unfixed at the source. The delivery gate measures whether the
retriever's band carries the answer; it does not simulate the append cap that re-cuts that
band, so its numbers are an upper bound on what the model receives. And every question set
here has five questions, which is an effective sample nearer five than twenty-five.

## 14 Next steps, runnable cold

Everything below assumes a fresh agent with no memory of this pass. Run from the repository
root. Live batches need `set -a && . ./.env && set +a` first (the harness reads
`OPENROUTER_API_KEY`); every gate below is zero-token and needs no key.

**Result files are overwritten in place, and nothing warns you.** The output name is
`run-W<window>-<arms joined by +><questions tag>-<model>.json` (`transplant.mjs:4105`);
there is no output-name flag for `--phase run` — `--out` is honoured only by
`--phase prep-overflow`. So re-running an arm at the same window on the same question set
**destroys the baseline this report is computed on**, and a sweep over a parameter that is
not in the filename writes the same path once per cell. Before any live batch:

```bash
mkdir -p eval/fixtures/transplant/s1/e1b289c32f40/results/_baseline-2026-09-03
cp eval/fixtures/transplant/s1/e1b289c32f40/results/run-W*-questions-deep-*.json \
   eval/fixtures/transplant/s1/e1b289c32f40/results/_baseline-2026-09-03/
```
(The gates read `run-W*` at the top level, so a subdirectory is ignored by them.)

**Every item below that edits the harness shifts the epoch, and the baselines in the table
above go stale the moment it does.** §5 makes that argument about a `transplant.mjs`
fingerprint changing between two batches; it applies to the next agent with more force,
because 14.1 and 14.2 both begin by changing code the baseline arm runs. Two consequences,
neither optional: **give the candidate its own arm id or flag so baseline and candidate can
run in ONE invocation**, and re-run the baseline in that invocation rather than quoting 7/25
from here. And note what 14.1 in particular invalidates: band centring lives on the shared
`CONTEXT_FETCH` path for every arm in `RAW_NARROWED_FETCH_ARMS` (`transplant.mjs:1450`), so
it moves `tree-oracle` too — the 13/25, the three-window oracle table in §5, and §3's whole
delivery derivation all need re-running, not just the arm under test.

**Standing constraints.** Invoke the `ds-star` skill before starting an item — these are
all Mode 1, each has a metric and a same-epoch baseline here. One measurable change per
arm. Pre-register the win criterion before the batch and do not soften it after. Judge a
candidate on its own bucket first and the headline second. Run
`node eval/scripts/provenance-audit.mjs` before any score enters a comparison. A pass is
three iterations, then a report in `reports/metrics/`, committed.

**Reproduce this pass's numbers first (~55 seconds, no tokens).** Two of these **exit 1 by
design** — the gates signal their own verdict — so do not chain them with `&&` or run them
under `set -e`. And read `rank-killgate --all` carefully: it **FAILS on
`questions-overflow.json` at 3/5 against a bar of 4/5**. That is a real failing gate on a
real stratum, disclosed here rather than buried: every overflow figure in this report is a
measurement on a set whose ranking gate does not pass, which is part of why §5 treats the
deep set as the cleaner instrument.

Preconditions this machine has and a fresh clone does not: the frozen store
(`eval/fixtures/transplant/*/store/`) and `packages/*/dist/` are both gitignored, so run
`pnpm install && pnpm build` first, and note that **none of this pass's artifacts are
reproducible without that store** — it is not in the repository.

```bash
npx vitest run                                          # expect 966 passed, 9 skipped, 0 failed
node eval/scripts/provenance-audit.mjs                  # expect 200 -> 195; 6 fetched-not-delivered
node eval/scripts/delivery-killgate.mjs questions-deep.json   # expect DELIVERED 115/145, qo04 0/30
node eval/scripts/rank-killgate.mjs --all               # expect 10/12, 3/5, 5/5 top-3
node eval/scripts/pipeline-decomposition.mjs           # expect 16 / 12 / 7 for tree-tail-v2
```

**Same-store baselines** — not same-epoch: they come from four separate invocations, and
two of them disagree on the `transplant.mjs` fingerprint (§5). All at W=65,536 on
`questions-deep.json` unless noted (the oracle's parenthetical draws on a fifth file at
W=131,072), GLM 5.3 Flash, n=5 per question, provenance-audited. Do
not re-run these unless the store or question set changes.

| arm | score | correct branch fetched | input tokens |
|---|---|---|---|
| `naive-full` (W=200,000, ground truth) | 25/25 | — | — |
| `tree-oracle` | 13/25 | 25/25 at this window (the oracle guarantees the hit, not the fetch — 17/25 at W=131,072) | — |
| `tree-tail-v2` | 7/25 in each of two batches (14/50 pooled) | 18/25 (paired batch; 16/25 standalone) | 460,389 (paired batch) |
| `tree-hit-keywords` (rejected) | 3/25 | 18/25 | 609,073 |

### 14.1 Diagnose the mis-centred band — zero tokens, do this first

The largest fixable bucket and the one no ranking change can reach. qo04 is 0/30 runs
delivered, and `--` at every swept budget through 40,000 tokens, so the band is not too
small — it is centred in the wrong place. Do not design a fix before measuring where it
centres.

Extend `eval/scripts/delivery-killgate.mjs` with a column reporting the seq `fetchBranch`
centred on against the question's own seq (`q.seq`). **Do this without touching core:**
`fetchBranch` already returns `spans: SeqSpan[]` (`packages/core/src/retrieve/types.ts:113`)
— the L0 ranges the band covers — so the centre is derivable in the gate alone. Only if that
is not enough, `fetchBranch` is at `packages/core/src/retrieve/retriever.ts:273`, and the
centring input is the `query` argument threaded from `transplant.mjs`'s `CONTEXT_FETCH`
handler as `lastSearchQuery` (`:1713`). **If you do edit the TypeScript, run `pnpm build`** —
`@context-tree/core` resolves to `./dist`, so the `.mjs` gates keep running the old code
until you do, and the gate will appear not to have changed.

Two candidates, whichever the diagnosis supports — centre on the highest-scoring event
rather than the first match, or return several disjoint bands rather than one contiguous
one. **Pre-registered gate, per question so the denominator cannot drift** (the 145-run total
moves the moment you add a batch): **qo04 goes from 0/N runs delivered to ≥ 5/6 of N, and
no other question regresses**, both read off `delivery-killgate.mjs`'s per-question column.
Zero tokens; clear it before any live spend.

Then one 25-run confirmation cell against the 7/25 baseline — **copy the baseline aside
first, this command overwrites it**:
```bash
node eval/scripts/transplant.mjs --phase run --scenario s1 --window 65536 \
  --arm tree-tail-v2 --model z-ai/glm-5.3-flash --reps 5 --questions-file questions-deep.json
```
Roughly $0.15. Win: score ≥ 11/25 against the 7/25 baseline. Report the gate's delivered
count alongside — this is a delivery fix, so delivery is the bucket it must move first.

### 14.2 Shrink the hit list — three cells, ~$0.45

The refuted arm makes the opposite experiment the interesting one: `retrieval.limit` is 20,
is unvalidated in `reports/algorithm.md`, and the one-hit oracle selects perfectly.

**`--retrieval-limit` does not exist yet — you must add it, and the harness will not tell
you if you get it wrong.** `parseArgs` (`transplant.mjs:4426`) accepts any unknown flag
silently: `--retrieval-limit 5` parses into `options.retrievalLimit`, nothing reads it, and
the sweep returns identical numbers at every setting. That reads as "hit-list size does not
matter", which would be a false negative produced by a command that appears to work. Wire
it in three places. Thread the option to `ctx.config.retrieval.limit` — and note **where
`tree-tail-v2` actually reads it**: that arm takes the `RAW_NARROWED_FETCH_ARMS` branch and
delegates to the shared `HANDLERS[CONTEXT_SEARCH]`, so the read is in
`packages/mcp/src/tools/context-search.ts:151`, not in `transplant.mjs`. (The two
arm-specific handlers that read it there, `transplant.mjs:1563` and `:1669`, belong to
`tree-grep` and `tree-escalate` and are not on the swept path.) The config object reaching the handler is built at
`transplant.mjs:773` and `:843-844` for the tool contexts and `:4069-4070` for the run loop —
thread it at all of them or the arm silently keeps the default. Note there are **two**
defaults to reconcile: `DEFAULT_CONFIG.retrieval.limit = 20` (`packages/core/src/config.ts:119`)
and `DEFAULT_LIMIT = 8` (`retriever.ts:280`); this repo's `context-tree.config.json` sets
neither. Record the value on the row next to `hitKeywordK`; and **add it to the output
filename at `transplant.mjs:4105`, or every cell of the sweep overwrites the last.**

Verify the wiring with zero tokens rather than a smoke run — `--phase run` prints no hit
count, so there is nothing to read there. Assert it directly instead: call the arm's
`CONTEXT_SEARCH` handler through `handlersForArm('tree-tail-v2')` with a stub `ctx` whose
`config.retrieval.limit` you vary, and check `data.hits.length` changes. Then:
```bash
node eval/scripts/transplant.mjs --phase run --scenario s1 --window 65536 \
  --arm tree-tail-v2 --model z-ai/glm-5.3-flash --reps 5 \
  --questions-file questions-deep.json --retrieval-limit 5
```
Sweep 3, 5, 10 against the 20-hit baseline, ~$0.15 per cell — and **put the 20-hit baseline
in each invocation** rather than quoting a figure from here. The two batches of this pass
give 18/25 and 16/25 for the same arm, a spread as large as the effect being chased, so a
reused number decides the verdict by which batch you happened to pick. **Primary is the
mechanism, not the score:** correct-branch-fetched ≥ 21/25 against the baseline measured
alongside it. Report input tokens
alongside — the refuted arm's real damage was effort, not accuracy. This is rule 4: find
the sweet spot, do not pick a bound.

### 14.3 Cap the oversized branch — zero tokens to gate

Three of five deep questions live in one 56,973-token phase branch — **6.7× the median over
the 21 phase branches** (8,497 tokens), which is the comparison that matters since phases are
what search ranks and fetch returns. (Over all 46 replayable nodes the median is ~8,900 and
the ratio ~6.4×; the task root is larger still at 232,392 tokens, but nothing fetches it as a
unit.)
`reports/metrics/tuning-branch-depth.md` records a cap that does not bind here. A branch
that cannot be read at the window it is served at is a segmentation defect, and fixing it
helps every arm at once instead of one query at a time.

`eval/scripts/resegment.mjs` **reports** candidate segmentations and takes no arguments — it
runs against a COPY and never writes the fixture, so running it and then re-running
`delivery-killgate.mjs` returns byte-identical numbers and proves nothing. Use it to choose
a segmentation; then the actual work is a step that does not exist yet: re-derive the
fixture's L1 from L0 under the new rule and rebuild the store. That is legitimate — L1 is
rebuildable by design — but it changes the epoch, so every live baseline in this report must
be re-run afterwards. Schedule it before 14.1 and 14.2, or after both, never between.

### 14.4 `tree-route`, on its payload argument only — deferred behind 14.1

Specified in `ds-star-multi-index-report.md` §12.1 with a seven-point wiring table that is
still accurate. Its ranking argument is retired by §5 above (offline ranking on the deep
set is already 5/5 top-3); only the payload claim survives — a facet line is ~24 tokens
where a branch replay is 26 KB. That is a delivery fix in different clothing, so judge it
against 14.1 rather than ahead of it, and re-measure whether it still buys anything once
14.1 lands.

### 14.5 Fix the fingerprint extractor — zero tokens

72 of one branch's 425 fingerprints carry whitespace, the largest 4,998 characters of raw
source. This pass filters them at the display boundary only. Zone B is unaffected today
solely because the set happens to be insertion-ordered with paths first — an accident, not
a guarantee, and it will break silently the first time extraction order changes.

### 14.6 Second scenario — the item that turns "true on s1" into "true"

Unchanged from the previous report and still the highest-value item for any outward-facing
claim. `eval/scripts/build-*-scenario.py` are six parameterized builders. Target s1's shape
(~750 events, ~196,000 BPE tokens) so the overflow regime exists at the windows already
measured. Two things a cold agent will otherwise hit: the artifact directory is named from
the first 12 hex characters of the trace file's sha256, and `--phase prep-overflow` will
not write a question set without `--allow-live` because the paraphrase step calls
`deepseek/deepseek-v4-flash` (budget well under a dollar).
