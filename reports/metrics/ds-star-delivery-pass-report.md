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
issued ever centred that band on the answer — 0 of 5 delivered, 0 of 5 scored — so five of the
twelve lost points are content that never arrived. Running the missing real-search cell
decomposes the live pipeline into three buckets that sum: 7-9 points lost selecting the
branch, 4 delivering it, 5 extracting from it. Selection turned out to be the largest and the least
expected, because the offline ranker is nearly perfect on this set — 5 of 5 in the top three,
4 of 5 at rank one — while the model fetches the correct branch on only 16-18 of 25 runs. The
cause is that a search hit renders without the evidence it was ranked on: the correct branch
displays as the bare word `diagnosis` while a distractor displays as `loop.ts`, and the model
takes the distractor five times out of five. The obvious repair — show the model the matching
fingerprints — was built, pre-registered and refuted: selection was 18 of 25 against the
baseline's own 18 of 25, for 32% more input tokens and twice the stalls. Extra legible leads
are leads the model follows. Three offline gates and a provenance audit were added; the audit
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

## 2 What the previous pass concluded, and why it was wrong

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
the band centres.

For qo04 no query the model issued ever centred the band on the answer. Five of the
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
band overruns the real BPE count and the append cap fires: the oracle sheds 3,535–4,431
tokens per run on its failing question, while `tree-tail-v2`, whose 20-hit list leaves
less room, sheds 0–280. The arm with the better retrieval has the worse delivery.

## 3 The instrument had to be repaired first

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
| overflow W=32,768 `tree-tail-v2` | 1/25 | **0/25** |
| all cells | 183/450 | 178/450 |

Zero rows were unverifiable. Two rows cite sequence numbers that do not exist in a
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

Result headers now carry `answeringUsd` per model and a `code` fingerprint (git SHA plus
content hashes of `retriever.ts` and `transplant.mjs`), so two batches run against
different working-tree state can be told apart. That defect could not be repaired
retroactively for the previous pass; it can no longer recur.

**The rank gate is no longer pinned to one question set.** It hardcoded `questions.json`,
so the offline top-3 rate had never been measured on either new set, and the previous
report compared "10/12 offline" against a live score on five different questions. The bar
is now a fraction of the set — two-thirds, which is the original 8-of-12 — rather than a
count.

## 4 The measurement that redirected the pass

| question set | offline hybrid top-3 | offline rank-1 | `tree-oracle` live | `tree-tail-v2` live |
|---|---|---|---|---|
| `questions.json` (12) | 10/12 | — | — | — |
| `questions-overflow.json` (5) | 3/5 | 2/5 | 21/25 | 2/25 |
| `questions-deep.json` (5) | **5/5** | **4/5** | 13/25 | 7/25 |

The two sets dissociate. The ranker is **better** on the deep set and the oracle is
**worse** there. Two deep questions rank first offline and still score 0/5 and 2/5 with
the correct branch handed over. Whatever is failing on the deep set, ranking is not it —
which retired the ranking half of the routing candidate that the previous pass had ranked
first, before a dollar was spent on it.

`tree-tail-v2` on the deep set was one un-run cell that the previous report identified and
did not execute; it costs $0.146 and closes the split permanently. With it, the live
pipeline decomposes into three stages that sum:

| stage | runs reaching it | points lost here |
|---|---|---|
| searched and fetched the **correct branch** | 16/25 | **9 — selection** |
| the delivered band **carried the answer** | 12/25 | **4 — delivery** |
| the run **scored** | 7/25 | **5 — extraction** |
| ground truth (`naive-full`) | 25/25 | — |

Selection is the largest bucket, delivery the smallest, extraction between them. That is
the opposite ordering from the overflow set, where perfect ranking recovered 19 of 21
points.

**Two batches, and the error bar they give.** This decomposition is computed on
`run-W65536-tree-tail-v2-questions-deep-*.json`. The arm ran again later as the baseline
half of §6's paired batch, and scored **7/25 again** — but with **18/25** selection rather
than 16/25. Same arm, same window, same store, same model, two independent epochs. So the
selection figure carries a run-to-run spread of about ±2 on a 25-run cell and the selection
bucket is properly "7 to 9 points", not a hard 9; the score is the more stable of the two.
Where this report compares selection between arms it uses the paired batch, in which both
arms ran in one invocation and the comparison is within-epoch. Both figures are correct for
the batch they come from, and neither should be quoted without it.

## 5 Why the model does not use a good ranker

The obvious explanation for 16–18/25 selection against 4/5 offline rank-1 is that the
model's own reformulated query ranks worse than the question text does. It does not: on the
deep set the two agree almost exactly, ranks 1, 2, 6, 1, 1 against 1, 2, 3, 1, 1. The check
took two minutes and the conclusion reverses without it.

The real reason is visible the moment the hit list is rendered. For qo02 — *"When
constructing the `armArgs` object, which property from `options` is used to set
`deadlineMs`?"* — the correct branch is ranked **second**, and the model fetched the hit
at rank 9 or 10 on **five runs of five**. Here is what it was shown:

```
# 1 score=0.033 phase/implementation "implementation"     files=…build-multimod-scenario.py  symbols=build_hidden_test,case,…
# 2 score=0.033 phase/diagnosis      "diagnosis"          files=-  symbols=-        <-- CORRECT
# 3 score=0.024 phase/diagnosis      "diagnosis (4)"      files=-  symbols=-
…
# 9 score=0.014 file/-               "build-multimod-scenario.py"                   <-- model picked
#10 score=0.014 file/-               "loop.ts"                                      <-- model picked
```

The correct hit renders as the word `diagnosis` and nothing else. A phase hit carries its
title, kind, and whatever `meta.files` / `meta.symbols` its summary happened to record —
for a phase node, routinely nothing. Asked where `armArgs` sets `deadlineMs`, and offered
`diagnosis` against `loop.ts`, the model picks `loop.ts`. That is the rational choice on
the evidence displayed.

The evidence it was **not** shown is the evidence the ranking was computed from. That
branch carries 425 extracted fingerprints, `ArmArgs`, `r.options` and `deadlineMs` among
them. The ranker scored it to rank 2 on exactly those, and none of them reach the model.
This is the same defect that the search-ranking pass fixed on the scoring side — summaries
do not contain the identifiers queries reference, so ranking on fingerprints took offline
top-3 from 2/12 to 10/12 — reappearing untouched on the display side.

## 6 The repair that followed from it, and its refutation

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
— the binary search settles on 16 keywords per hit and the list grows from 5,203 to 5,377
tokens. A `hitKeywordK` field records the count per search call, so a null result cannot be
confused with a mechanism that never fired.

Both arms then ran in one invocation, same epoch, same store, n=5 per question.

| | `tree-hit-keywords` | `tree-tail-v2` |
|---|---|---|
| score (provenance-audited) | 3/25 | 7/25 |
| **correct branch fetched** | **18/25** | **18/25** |
| input tokens, whole cell | 609,073 | 460,389 |
| stalls | 4 | 2 |
| tokens truncated, whole cell | 1,050 | 326 |
| runs where keywords were attached | 25/25 | 0/25 |

**The mechanism fired and moved nothing it was built to move.** Selection is identical. The
pre-registered primary bar was selection ≥ 21/25 and the arm delivered the baseline's own
number. On qo02, the question the intervention was designed around, selection moved from 0/5
to 1/5 — which at n=5 is nothing.

The score difference is not significant either: 3/25 against 7/25 is p≈0.30 by Fisher exact,
and the 25 are five questions × five replicates, so the effective sample is nearer five. What
*is* robust is the effort. The arm spent **32% more input tokens** and doubled the stalls, and
the clearest single row is qo03: both arms fetched the correct branch on 5 of 5 runs, the
baseline answered in 3 turns and scored 4/5, and the keyword arm took 5, 3, 7, 9 and 4 turns
and scored 0/5.

The mechanism of the regression is legible in that row. Extra keywords are extra leads, and the
model follows them. Making the correct hit legible does not make the model choose it; it makes
the model look further. The diagnosis in §5 survives as a description of what the baseline
does — the correct hit really does render as the bare word `diagnosis`, and the model really
does take rank 9 or 10 five times out of five — but the causal step from that observation to
"therefore show it the keywords" is refuted. The arm is retained in the harness, marked
rejected, so the negative result stays reproducible.

One thing the batch established for free: `tree-tail-v2` on the deep set scored 7/25 in this
batch and 7/25 in an independent earlier one, 14/50 pooled. The baseline is stable across
epochs, which is what makes the comparison above worth anything.

## 7 What was rejected, and the number that rejected it

- **`tree-route` on the ranking argument** — retired unspent for the deep set. Offline
  ranking there is 5/5 top-3 and 4/5 rank-1; there is no ranking gap for routing to close.
  Its *payload* argument survives and is untested.
- **Query reformulation as the cause of poor live selection** — ranks 1,2,6,1,1 under the
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
  insertion-ordered with paths first, so only 1 of 21 headlines contains a slab, worth 9
  tokens. The defect bites only where entries are ranked by overlap.

## 8 What was learned, as distinct from what was decided

- **A ceiling probe is only a ceiling for the stage it replaces.** `tree-oracle` makes
  *branch ranking* perfect and leaves *span selection inside the branch* exactly as it
  was. On a store whose largest branch is 57,000 tokens read through a 6,600-token
  headroom, that residual stage is most of the pipeline. The generalizable form: when you
  replace a stage by fiat, write down what the replaced stage hands to the next one — a
  coordinate is not a payload — and verify the next stage received what you think you
  gave it.
- **Ranking and display are different subsystems and only one of them was ever fixed.**
  Two passes improved what the ranker scores on. Nothing improved what the model is shown.
  The correct branch ranked second and rendered as the bare word `diagnosis`; the model
  chose a rank-10 hit that at least named a file, five times out of five. A ranker whose
  evidence is invisible to the consumer is a ranker the consumer cannot follow.
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
- **A provenance check is only as strong as the narrowest thing it asks about.** This
  pass's own audit shipped asking "did the run fetch a branch containing the answer",
  which a run can pass while never receiving the answer — the very failure the pass exists
  to describe. Tightening it to the served band flagged six more rows. Ask about the
  payload, not the pointer.
- **The instrument audit keeps paying.** The provenance audit reproduced, mechanically and
  independently, artifacts the previous pass found by hand — and then measured
  question-set decay per row, which that pass could only infer from median turns.

## 9 State of the code

All paths relative to the repository root.

| Path | What it is |
|---|---|
| `eval/scripts/provenance-audit.mjs` | Re-scores every run against what it could have seen; nulls unearned successes; reports per-cell decay |
| `eval/scripts/delivery-killgate.mjs` | Replays each run's own queries through the real narrowing path at live headrooms; asks whether the answer is delivered at all |
| `eval/scripts/rank-killgate.mjs` | Parameterized over question sets; bar is a fraction of the set, not a count |
| `eval/scripts/transplant.mjs` | `tree-hit-keywords` arm; `answeringUsd` and `code` fingerprint in every result header; `openScenario`/`budgetsFor`/`buildArm`/`measureRatio` exported for the audit |
| `eval-resumption/harness/arms.ts` | `context_fetch` advertised schema realigned with the zod shape |
| `eval-resumption/harness/harness.test.ts` | Raw-by-default asserted positively and negatively; advertised enums asserted equal to zod enums |
| `reports/algorithm.md` | Five new boundary conditions; corrected oracle row; two new parameter rows |

## 10 What this pass did not test

One store, one scenario, one model. `tree-hit-keywords` was measured at a single window
(65,536) on a single five-question set; it has never run on the overflow set, at another
window, or against another model. The facet indexes remain offline measurements that have
never been placed in front of an answering model, so `tree-route`'s surviving payload
argument is still untested. The fingerprint extractor's slab pollution is filtered at the
display boundary and left unfixed at the source. The delivery gate measures whether the
retriever's band carries the answer; it does not simulate the append cap that re-cuts that
band, so its numbers are an upper bound on what the model receives. And every question set
here has five questions, which is an effective sample nearer five than twenty-five.

## 11 Next steps, runnable cold

Everything below assumes a fresh agent with no memory of this pass. Run from the repository
root. Live batches need `set -a && . ./.env && set +a` first (the harness reads
`OPENROUTER_API_KEY`); every gate below is zero-token and needs no key.

**Standing constraints.** Invoke the `ds-star` skill before starting an item — these are
all Mode 1, each has a metric and a same-epoch baseline here. One measurable change per
arm. Pre-register the win criterion before the batch and do not soften it after. Judge a
candidate on its own bucket first and the headline second. Run
`node eval/scripts/provenance-audit.mjs` before any score enters a comparison. A pass is
three iterations, then a report in `reports/metrics/`, committed.

**Reproduce this pass's numbers first (about 90 seconds, no tokens):**
```bash
npx vitest run                                          # expect 966 passed, 9 skipped, 0 failed
node eval/scripts/provenance-audit.mjs                  # expect 200 -> 195; 6 fetched-not-delivered
node eval/scripts/delivery-killgate.mjs questions-deep.json   # expect DELIVERED 115/145, qo04 0/30
node eval/scripts/rank-killgate.mjs --all               # expect 10/12, 3/5, 5/5 top-3
```

**Same-epoch baselines.** All at W=65,536 on `questions-deep.json`, GLM 5.3 Flash, n=5 per
question, provenance-audited. Do not re-run these unless the store or question set changes.

| arm | score | correct branch fetched | input tokens |
|---|---|---|---|
| `naive-full` (W=200,000, ground truth) | 25/25 | — | — |
| `tree-oracle` | 13/25 | 25/25 by construction | — |
| `tree-tail-v2` | 7/25 (14/50 over two epochs) | 18/25 | 460,389 |
| `tree-hit-keywords` (rejected) | 3/25 | 18/25 | 609,073 |

### 11.1 Diagnose the mis-centred band — zero tokens, do this first

The largest fixable bucket and the one no ranking change can reach. qo04 is 0/30 runs
delivered, and `--` at every swept budget through 40,000 tokens, so the band is not too
small — it is centred in the wrong place. Do not design a fix before measuring where it
centres.

Extend `eval/scripts/delivery-killgate.mjs` with a column reporting the seq `fetchBranch`
centred on against the question's own seq (`q.seq`), for all five deep questions × every
recorded query. The band-growth code is `packages/core/src/retrieve/retriever.ts`; the
centring input is the `query` argument threaded from `transplant.mjs`'s `CONTEXT_FETCH`
handler as `lastSearchQuery`.

Two candidates, whichever the diagnosis supports — centre on the highest-scoring event
rather than the first match, or return several disjoint bands rather than one contiguous
one. **Pre-registered gate, in the units `delivery-killgate.mjs` already prints: qo04 goes
from 0/30 runs delivered to ≥ 25/30, and the total from 115/145 to ≥ 140/145, with no
question regressing.** Zero tokens; clear it before any live spend. Then one 25-run confirmation cell against the 7/25 baseline:
```bash
node eval/scripts/transplant.mjs --phase run --scenario s1 --window 65536 \
  --arm tree-tail-v2 --model z-ai/glm-5.3-flash --reps 5 --questions-file questions-deep.json
```
Roughly $0.15. Win: score ≥ 11/25 against the 7/25 baseline. Report the gate's delivered
count alongside — this is a delivery fix, so delivery is the bucket it must move first.

### 11.2 Shrink the hit list — one batch, ~$0.30

The refuted arm makes the opposite experiment the interesting one: `retrieval.limit` is 20,
is unvalidated in `reports/algorithm.md`, and the one-hit oracle selects perfectly.

**`--retrieval-limit` does not exist yet — you must add it, and the harness will not tell
you if you get it wrong.** `parseArgs` (`transplant.mjs:4426`) accepts any unknown flag
silently: `--retrieval-limit 5` parses into `options.retrievalLimit`, nothing reads it, and
the sweep returns identical numbers at every setting. That reads as "hit-list size does not
matter", which would be a false negative produced by a command that appears to work. Wire
it in two places — thread the option to `ctx.config.retrieval.limit`, which the
`CONTEXT_SEARCH` handler reads at `transplant.mjs:1443`, and record the value on the row
next to `hitKeywordK` so the sweep is reconstructable. Verify before the batch:

```bash
# must print a DIFFERENT hit count per limit; if identical, the flag is not wired
TRANSPLANT_SMOKE=1 node eval/scripts/transplant.mjs --phase run --scenario s1 \
  --window 65536 --arm tree-tail-v2 --model z-ai/glm-5.3-flash --retrieval-limit 3
```
(That smoke command does spend a few cents — it makes real model calls.) Then:
```bash
node eval/scripts/transplant.mjs --phase run --scenario s1 --window 65536 \
  --arm tree-tail-v2 --model z-ai/glm-5.3-flash --reps 5 \
  --questions-file questions-deep.json --retrieval-limit 5
```
Sweep 3, 5, 10 against the 20-hit baseline, ~$0.15 per cell. **Primary is the mechanism,
not the score:** correct-branch-fetched ≥ 21/25 against 18/25. Report input tokens
alongside — the refuted arm's real damage was effort, not accuracy. This is rule 4: find
the sweet spot, do not pick a bound.

### 11.3 Cap the oversized branch — zero tokens to gate

Three of five deep questions live in one 56,973-token branch, 77× the median.
`reports/metrics/tuning-branch-depth.md` records a cap that does not bind here. A branch
that cannot be read at the window it is served at is a segmentation defect, and fixing it
helps every arm at once instead of one query at a time. Re-segment with
`eval/scripts/resegment.mjs`, then report the new size distribution and re-run
`delivery-killgate.mjs`. Note this changes L1 and therefore the epoch: every live baseline
above must be re-run afterwards, so schedule it before 11.1 and 11.2 or after both, never
between.

### 11.4 `tree-route`, on its payload argument only — deferred behind 11.1

Specified in `ds-star-multi-index-report.md` §12.1 with a seven-point wiring table that is
still accurate. Its ranking argument is retired by §4 above (offline ranking on the deep
set is already 5/5 top-3); only the payload claim survives — a facet line is ~24 tokens
where a branch replay is 26 KB. That is a delivery fix in different clothing, so judge it
against 11.1 rather than ahead of it, and re-measure whether it still buys anything once
11.1 lands.

### 11.5 Fix the fingerprint extractor — zero tokens

72 of one branch's 425 fingerprints carry whitespace, the largest 4,998 characters of raw
source. This pass filters them at the display boundary only. Zone B is unaffected today
solely because the set happens to be insertion-ordered with paths first — an accident, not
a guarantee, and it will break silently the first time extraction order changes.

### 11.6 Second scenario — the item that turns "true on s1" into "true"

Unchanged from the previous report and still the highest-value item for any outward-facing
claim. `eval/scripts/build-*-scenario.py` are six parameterized builders. Target s1's shape
(~750 events, ~196,000 BPE tokens) so the overflow regime exists at the windows already
measured. Two things a cold agent will otherwise hit: the artifact directory is named from
the first 12 hex characters of the trace file's sha256, and `--phase prep-overflow` will
not write a question set without `--allow-live` because the paraphrase step calls
`deepseek/deepseek-v4-flash` (budget well under a dollar).
