# Dimension 3 — when summaries are written, and under what policy

DS-STAR tuning pass · dimension 3 of 4 named in `reports/algorithm.md`'s "What
the DS-STAR loop is for" · zero live model calls, zero spend · all claims below
cite a `file:line` or a number computed from a file already on disk.

## Abstract

Two independent reports already concluded that the leverage in this algorithm
sits in summary timing rather than in what gets selected for the prompt; this
pass establishes what has actually been measured about that timing and finds
it under-specified in one place and wrong in another. The rule in
`reports/algorithm.md` defines the switch point as the size at which "the
whole trace fits where the active branch's detail would go" — which is, by
that sentence's own content, the Zone C fraction (0.20), not the 0.35 the
portability harness's `FRACTIONS` table actually uses. No run has tested 0.20
directly, but the six measured crossings under the current absolute 30,000
(§2) land 126 to 15,564 tokens past the threshold every time, because the
gate reads the previous completed turn's billed usage rather than the
prompt about to be assembled — a lag that is measured, not estimated, and
that a same-turn check would remove at the cost of one extra local
tokenizer pass, not a model call. At the moment a crossing fires, the code
summarizes every stale branch in one parallel batch; the same six runs show
each such batch billed a cache-write spike above the 30,000-token budget and
between two and six extra turns to absorb it. The summarizer's own share of
run cost is zero on every short task that never crosses (measured, n=5 on
sw-3-refactor) and 6.9–19.3% of run cost on long tasks that do (measured,
n=6, median 9.4%) — so timing is not a fixed tax, it is a cost that appears
exactly once, in one lump, at a point the algorithm chooses badly. Section 4
gives the cheapest experiment that ranks timing policies against each other
without spending anything further: the existing zero-LLM marathon harness
already builds the real store and the real assembler; it needs one more
parameter — when a branch's summary gets inserted relative to a candidate
switch fraction — to turn today's single fixed-cadence curve into a family
of curves comparable on tokens and turns alone.

## 1. What two earlier reports already said, independently

`reports/algorithm.md` itself states the convergence plainly, in the
dimension summary this pass is scoped to:

> "Both earlier reports reached the same conclusion independently, that the
> leverage is here rather than in selection." (`reports/algorithm.md:94-95`)

The first report is `reports/metrics/context-tree-dsa-arm-experiments.md`,
whose own answer to "where the leverage actually is" reads:

> "Where the leverage actually is: not selection, but (a) *when*
> summarization runs (lazy/off-critical-path was worth −48% cost) and (b)
> *what model* does it — once passes are rare and off-path, a haiku root
> summarizer is nearly free savings (iter1 failed only because summarization
> was still on the critical path)." (`reports/metrics/context-tree-dsa-arm-experiments.md:97`)

The second is `reports/metrics/context-tree-long-task-dsa-iterations.md`,
which reaches the same place from long-task data instead of the short-task
data the first report used, and states it as a sequencing rule rather than a
single line:

> "Next experiments are phased by dependency (§9): make the mechanism
> measurable (>k-branch task, seeded repetition), then cut the summarizer
> cost floor (per-node breaker live-run, append-only summaries, cosine dedup,
> haiku root), and only then run the tree-dsa hyperparameter search (~$10,
> OFAT + coordinate descent, with a selector-fire guard metric) — tuning
> before the mechanism fires would re-measure the floor."
> (`reports/metrics/context-tree-long-task-dsa-iterations.md:17`)

Both reports are measuring the same object this pass is scoped to — *when*
the summarizer runs, not which branches it keeps — and both put it ahead of
selection tuning on the grounds that a selection experiment run before the
summarizer's cost is under control is measuring noise from the wrong
mechanism. Neither report measured the switch point itself in isolation;
that measurement is what loop 9 item 1 supplies, below.

## 2. What has been measured about the switch point's behaviour

Before loop 9, the switch never engaged on any live long-task run: `2.
Cost on long tasks` in `reports/metrics/loop8-interim.md` records "the
summarization machinery never engaged" on all 24 long-task runs of that
loop (`reports/metrics/loop8-interim.md:139`), because the gate compared
`traceChars / 4` against 30,000 and code-dense traces undercount under that
heuristic. `eval/plans/loop9-item1-lazy-gate.md` replaced the character
estimate with the provider's own billed count of the previous turn
(`lastPromptTokens`, `eval/src/loop.ts:817-820`) and added a one-way latch
after the first live run oscillated — crossed at turn 8 (40,158 tokens),
fell under 30,000 once Zone C held only the active branch, and re-expanded
the whole trace before crossing again at turn 10 (43,331 tokens), finishing
at $0.42 and roughly twice the loop-8 cost
(`eval/plans/loop9-item1-lazy-gate.md:79-95`).

With the latch, `reports/metrics/context-growth.md` §4 reports six live
replicates (sw-5-dozen and sw-6-ripple, n=3 each, claude-sonnet-5) where the
gate fires exactly once per run. The curve does flatten: per-turn growth
falls from 2,046–4,928 tokens/turn before the crossing to 256–915 tokens/turn
after it, below the native transcript's own 812–2,094 tokens/turn on the same
two tasks (`reports/metrics/context-growth.md` Table 2 and §"The verdict").
But every measured crossing cost more than it saved: final-turn context under
the real-token gate (medians 24,299 and 22,837 tokens) still sits 1.13–1.27×
the native baseline's, and total tokens rise 48% and 77% over native (§4,
"Total tokens rise rather than fall"). The report's own verdict is that "the
mechanism works and the criterion was wrong" — on a 200,000-token window the
largest prompt any of the eighteen runs in that batch ever assembled was
45,564 tokens, comfortably inside the window, so an absolute 30,000-token
switch forced a transition none of these tasks needed.

## 3(a). The switch-fraction contradiction, resolved

`reports/algorithm.md`'s tier-2 table already flags the numbers as
inconsistent: the live harness's switch is an absolute 30,000; the
portability harness's `FRACTIONS.lazy` is 0.35 of the window while
`FRACTIONS.zoneC` is 0.20, "though the rule says the switch is 'the whole
trace fits where the active branch's detail would go,' which makes them the
same quantity" (`reports/algorithm.md:173`). `eval/plans/portability-audit/03-transplant.md`
confirms the same two numbers at their exact lines (`transplant.mjs:102`)
and calls it "the same switch/Zone-C mismatch." The question is which
reading — 0.35 or 0.20 — the evidence actually supports.

**The rule's own text settles the semantic question, and the evidence
supports that reading over the alternative.** "The whole trace fits where the
active branch's detail would go" describes Zone C's allocation by
definition: Zone C is the space that, once the tree stops showing the raw
trace, holds the active branch's raw detail. The switch point is the size at
which the raw trace and the Zone C budget are the same number — that is not
a matter of fitting a curve, it is what the sentence says. So the switch
point is defined as equal to the Zone C fraction, currently 0.20 of W, and
0.35 is a second, independent number that has drifted from it.

Two additional facts from the record make this more than a textual
argument:

- **The live harness's absolute numbers already satisfy this identity, by
  coincidence rather than derivation.** `switch point = 30,000` and
  `Zone C budget = 30,000` are the same literal (`reports/algorithm.md:171-172`).
  Neither is computed from the other or from W — `packages/core` has no
  representation of W at all (`eval/plans/portability-audit/01-core.md`
  Headline) — so the two constants match only because whoever picked them
  picked the same number twice. The portability harness's `FRACTIONS` table
  is where the derivation actually happens, and that is exactly where the
  identity breaks (0.35 vs 0.20): a second author changed one occurrence
  without the other.
- **`reports/metrics/context-growth.md` §5 item 2 independently reaches the
  same conclusion, from measurement rather than definition:** "the switch
  belongs at the Zone C fraction — `FRACTIONS.zoneC`, currently 0.2 — of the
  same window-derived budget, in one derivation both harnesses import. Until
  that lands, no comparison of the two arms is measuring the policy we would
  ship." (`reports/metrics/context-growth.md:354`)

**What the evidence does not yet do is discriminate 0.20 from 0.35 head to
head** — no run has been made at either fractional setting; every number
above is either the absolute 30,000 (measured) or a counterfactual replay of
already-collected data against a fraction that was never actually applied
live. The counterfactual in `context-growth.md` §4 computes 0.35×W/ratio ≈
70,000 tokens on Sonnet's window and finds that none of the eighteen runs in
that batch would have crossed at that level — the report calls that "the
right answer" for those specific runs, because nothing was near overflowing.
Redoing the same arithmetic at 0.20 gives 0.20×200,000/0.851 ≈ 47,000 tokens
— close enough to the batch's own observed peak (45,564 tokens, sw-5-dozen
replicate 1, `context-growth.md` Table 2) that a 0.20 switch would have sat
right at the edge of firing on the one run that came closest to needing it,
while 0.35 would have made the mechanism nearly unreachable at this window
size in this test suite. That proximity is suggestive of 0.20 being the more
useful setting to actually exercise the mechanism, not proof that 0.20 wins
on tokens, turns or score — that comparison has not been run. The recommendation
is therefore: fix the definitional inconsistency by deriving the switch from
`FRACTIONS.zoneC` (a one-line change per `eval/plans/portability-audit/03-transplant.md`'s
own top-three item 2), and treat "does 0.20 outperform 0.35 measured against
tokens/turns/score" as still open, not settled by this pass.

## 3(b). The one-turn lag, quantified

The gate compares against `lastPromptTokens`, set immediately after each
model call from `result.usage.input + result.usage.cacheRead +
result.usage.cacheWrite` (`eval/src/loop.ts:817-820`) — the *previous*
completed turn's billed size, not the size of the prompt about to be sent.
Because the trace only grows between turns, this is a lagging indicator by
construction: the turn that actually contains the crossing is judged one
turn late, against a smaller number than the one that will actually be sent.

`reports/metrics/context-growth.md` Table 2 (the six real-token-gate
replicates) reports the exact size of each crossing prompt against the
30,000-token budget:

| Run | prompt at crossing | over budget |
| --- | ---: | ---: |
| sw-5-dozen r1 | 45,564 | +15,564 |
| sw-5-dozen r2 | 36,657 | +6,657 |
| sw-5-dozen r3 | 38,799 | +8,799 |
| sw-6-ripple r1 | 41,286 | +11,286 |
| sw-6-ripple r2 | 30,126 | +126 |
| sw-6-ripple r3 | 37,812 | +7,812 |

n = 6, median overshoot 8,306 tokens, one replicate (sw-6-ripple r2) landing
126 tokens past the threshold and the other five landing 6,657 to 15,564
tokens past it. This overshoot is not free: `context-growth.md` §4 identifies
it as one of the two mechanisms behind the total-token increase ("five of
the six crossings landed 6,657 to 15,564 tokens above the 30,000-token
budget... billed at cache-write rates because the whole prefix is rewritten
when the tree reorganizes," `context-growth.md:347`).

**What a within-turn estimate would cost.** The fix is not a live-model
cost — it is tokenizing the *candidate* prompt (the one about to be sent,
built from the current trace) before dispatch, with the same
`HeuristicTokenizer` the assembler already uses locally
(`eval/src/loop.ts:771`), rather than reading back a number the provider
already billed for the previous call. That is a deterministic, local
computation — the same class of work `measureRatio` already does offline
over an entire corpus in `transplant.mjs:711-714` — not an API call, so its
marginal cost is negligible compared with the 126–15,564-token overshoot it
would remove. The engineering cost is restructuring the check to run before
`runTreeArm` decides how to render the turn rather than after the previous
one returns, which the code does not currently do anywhere in `loop.ts`.

## 3(c). All leaves at once, versus incrementally

At the moment the gate crosses, the current code does not summarize one
branch — it drains the whole backlog in a single parallel pass. While
`belowLazyBudget()` is true, `maybeResummarize` returns immediately
regardless of how many branches have closed (`eval/src/loop.ts:871`), so
every branch that closed during devolved mode accumulates unsummarized. The
first call after the crossing builds the full stale plan
(`summarizer.stalePlan(rootId)`, `eval/src/loop.ts:877-883`), schedules every
pending node, and drains them together:

```
eval/src/loop.ts:936-937
for (const nodeId of pending) summarizer.scheduleSummarize(nodeId);
await summarizer.drain();
```

This is "all leaves at once, as now" in the terms of the question. The
transition costs recorded above are the direct, measured consequence of that
choice, not of the switch point's value alone: the crossing turn's cache
write covers the entire backlog's leaf summaries plus one root recomposition
in one shot, which is why every crossing overshoots the budget (§3(b))
*and* why the transition costs turns — median turns rise from 9 to 13 on
sw-5-dozen and from 12 to 18 on sw-6-ripple (`context-growth.md` Table 1),
with one replicate (sw-6-ripple r2) running 33 turns and oscillating between
8,357 and 25,471 tokens per turn for seventeen calls after its crossing
while the agent re-fetched detail it had just had in front of it
(`context-growth.md:190,347`).

The summarizer's own share of run cost, measured directly from
`costByModel` in the six real-token-gate result files
(`eval/results/long-v65-gate/*/results.json`) against the same six runs'
total cost, is:

| Run | total (usd) | leaf-summarizer (haiku, usd) | share |
| --- | ---: | ---: | ---: |
| sw-5-dozen r1 | 0.4673 | 0.0323 | 6.9% |
| sw-5-dozen r2 | 0.2790 | 0.0212 | 7.6% |
| sw-5-dozen r3 | 0.3338 | 0.0282 | 8.4% |
| sw-6-ripple r1 | 0.3357 | 0.0455 | 13.6% |
| sw-6-ripple r2 | 0.6497 | 0.1255 | 19.3% |
| sw-6-ripple r3 | 0.3125 | 0.0322 | 10.3% |

n = 6, median 9.4%. (Root composition costs nothing here — `EVAL_DET_ROOT=1`
makes it a pure function over leaf headlines, `eval/src/loop.ts:837-849`, so
this is entirely the leaf summarizer's share.) On the five sw-3-refactor
`context-tree` runs in `eval/results/sw3-loop9b/*B-tree*/results.json` — a
short task whose gate never crosses — the same computation gives 0% on every
run (n=5): the summarizer costs nothing until the moment it costs
everything at once.

That shape — zero, then one lump equal to roughly a tenth of the run's total
cost, concentrated in the single turn that pays for both the overshoot
(§3(b)) and the batch — is what an incremental policy would spread out
instead. The mechanism to do it already exists and is already exercised for
a different purpose: the per-node scheduler (`summarizer.scheduleSummarize`
/ `summarizer.drain`, D11) that the circuit breaker in
`reports/metrics/context-tree-long-task-dsa-iterations.md` §3 uses to retry
failed nodes individually already proves that summarizing "fewer distinct
things, more reliably, more cheaply" (that report's own words, §5) is
tractable at per-node granularity. The same granularity applied to *timing*
— call `scheduleSummarize` on a branch as soon as it closes, independent of
whether `belowLazyBudget()` is still true, rather than gating all
summarization on the crossing — would turn one full-backlog drain into N
small drains, each paying for one branch's leaf pass instead of the whole
accumulated backlog's cache rewrite in a single turn. This is a prediction,
not a measurement: no run in this repository has been made with
summarization decoupled from the devolved/summarized switch, so the
comparison in the next section is the way to test it before spending
anything live.

## 3(d). The cheapest offline experiment that ranks timing policies

Everything the comparison needs is already on disk and none of it requires
a model call:

- **The real assembler and store, already wired for zero-spend replay.**
  `eval/scripts/marathon.mjs` builds `JsonlTraceLog` + `FsBlobStore` +
  `SqliteTreeStore` and inserts branch nodes and leaf summaries directly,
  through the same pattern `packages/core/test/assemble.test.ts`'s
  `addBranch` harness uses, then reads real `ZoneAssembler` output — "zero
  LLM spend in the default path... no LLM call anywhere in this path"
  (`eval/scripts/marathon.mjs:11-19`). This is exactly the harness that
  produced Figure 1 of `reports/metrics/loop8-interim.md`, and it already
  proves the pattern: synthetic-but-real summaries, inserted at controlled
  points, through the production assembler, at zero cost.
- **The per-node cost of summarizing any given branch is already paid for
  and recorded.** `costByModel`'s per-model `usage` in every existing
  `results.json` (§3(c)'s table) tells you exactly what the leaf model was
  billed for the branches that were summarized in that run; the summary size
  itself is capped at `maxSummaryTokens` (1,024, `config.ts:118`) regardless
  of when the call happens, so re-bucketing an already-recorded summarize
  call into "as if it had run at branch-close time T1" instead of "at
  crossing time T2" does not require re-running it.
- **The pricing arithmetic is a pure, already-exported function.**
  `packages/core/src/models/cost.ts` turns a token usage tuple into a dollar
  figure with no network call; re-applying it to a resequenced set of
  cache-write events (one small write per branch-close instead of one large
  write at the crossing) is arithmetic over numbers already in hand.
- **`deriveBudgets`/`ratioVerdict` are already pure functions of `(W,
  ratio)`** (`transplant.mjs:338-372,465-473`), unit-tested
  (`eval/test/transplant.test.ts:167-279`), and already used in
  `context-growth.md` §4's own counterfactual to show what 0.35 would have
  done to the six real-token-gate runs. The same call, at 0.20 and at a
  small grid around it (0.15, 0.20, 0.25, 0.30), against the *already
  recorded* `lastPromptTokens` series in the six existing
  `long-v65-gate` and three `long-v64` result files, ranks candidate switch
  fractions by crossing turn and post-crossing slope without a single new
  API call — it is the same arithmetic §3(a) already did once, extended to a
  grid instead of one point.

**The experiment, concretely:** extend `marathon.mjs` with two new
parameters — a switch fraction (of the harness's configured W) and a
summarization cadence (`batch-at-crossing`, matching today's code, versus
`incremental-at-close`, inserting each branch's synthetic summary the moment
it closes regardless of the switch) — and run the existing deterministic
200-branch replay once per combination. Because the harness already builds
the real store and calls the real `ZoneAssembler`, each combination yields an
exact, reproducible token-per-branch curve (the same shape as Figure 1) with
zero LLM spend; comparing the curves' area (cumulative tokens, the same
statistic `context-growth.md` Figures 6–7 already compute) and the presence
or absence of a single-branch spike ranks the four cadence/fraction
combinations against each other on tokens alone. Turns cannot be measured
this way, since no model is called — that half of the ranking still needs
the six-run design item 1 already used (n=3 per scenario, sw-5-dozen and
sw-6-ripple, interleaved same-day) once a candidate policy is worth spending
on live. But the offline pass is what should decide which one or two
candidates earn that live spend, at zero cost, before any of it is
committed.

## Open items

- No run has tested `FRACTIONS.zoneC` (0.20) as the live switch fraction
  directly — §3(a)'s support for it is definitional plus a proximity
  argument, not a head-to-head measurement against 0.35 or against the
  current absolute 30,000.
- No run has decoupled summarization timing from the devolved/summarized
  switch — §3(c)'s incremental-cadence prediction is unmeasured; §3(d) is
  the proposed zero-cost way to narrow it before spending live tokens on it.
- The within-turn estimate proposed in §3(b) has not been implemented or
  measured; its cost is argued from the existing `measureRatio` precedent
  (a local, deterministic pass), not benchmarked directly against the
  current one-turn-lagged check.
- All summarizer-cost-share numbers in §3(c) are n=5 (sw-3-refactor) and n=6
  (sw-5-dozen/sw-6-ripple combined), on one model (claude-sonnet-5 agent,
  claude-haiku-4-5-20251001 leaf) and one epoch each; per algorithm.md's own
  cross-host standard, none of this is yet shown to hold on a different
  model family or a different window size.
