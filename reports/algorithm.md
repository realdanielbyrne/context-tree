# The context-tree algorithm

This page states the algorithm as it currently runs, and it is the reference the
DS-STAR passes score against. It exists so that a change to the algorithm and a
change to this page happen together, and so that porting the algorithm to a new
model or harness starts here rather than in the code.

The goal is an algorithm that is simple, repeatable, and translatable: the same
steps should work on a model and a harness it has never seen. Four rules follow
from that, and they are what a DS-STAR judge scores. There is no size budget —
a line count is itself a number picked in advance, and an algorithm can sit
under one while still failing to travel.

**1. No budgets or caps.** Not on turns, not on wall-clock time, not on reply
length. Each is a guess about work nobody has measured yet, and each has already
corrupted a measurement here: the turn ceiling fabricated 16 failures the models
never committed, and the reply clamp produced empty answers that were then
graded wrong. Where a real resource must be bounded, bound the resource itself.
Spend is bounded by a spend cap. A run that will not finish is ended by
non-progress, which is a property of the run rather than of the harness.

**2. A hardcoded value is a defect unless that value is predictably helpful
across models and harnesses.** The test is not whether something is a constant.
Some constants genuinely hold everywhere, and those are fine and should say so
with their evidence. The test is whether anyone has shown this number holds off
the host it was fitted on. A value fitted to one window, one tokenizer, or one
task length and never re-checked will be wrong on the next host, silently.

**3. Setting a parameter from a model's limits is fine. Guessing it is not.**
Nothing is wrong with a value that differs per model. What matters is that a
documented procedure produces it, so a new host runs that procedure instead of
inheriting a number from a machine it never saw. The measured
heuristic-to-tokenizer ratio is the shape to copy: it ships with the code, it is
re-measured per corpus, and it refuses to proceed past a threshold.

**4. Prefer finding the sweet spot to picking a bound.** Where a value trades
off against the metrics, the answer is not a ceiling but the setting that wins.
A fraction of the model's context window is usually the right form, because the
window is the one quantity every host reports about itself. But a fraction is
only half an answer: which fraction has to be established by measurement against
tokens, turns and graded score, not chosen because it reads as reasonable. That
measurement is the work.

## What the DS-STAR loop is for

Its job is not to guard a constant. It is to improve the algorithm iteratively
along the dimensions where a real tradeoff exists, and to establish the settings
that win. Four are open. Each is named with what the evidence in this repository
already says, so a pass starts from measurement rather than from intuition.

**How many branch summaries the model should see.** *Analysed 2026-09-02; full
report at `reports/metrics/tuning-branch-count.md`.* This pass corrected the
framing this document previously used, in two ways worth stating plainly.

First, two different counts had been conflated. The fold level names how many
recent branches get an individual headline in the root index before older ones
fold to one line each. The number of branches whose *full* summary body renders
separately is a different count, and it moves in the opposite direction: a
higher fold level spends the Zone B budget on headlines and leaves less room for
bodies. So "how many summaries the model sees" has two answers, and the two
arms that were compared differ in which of them they maximise.

Second, "width helps" was too broad. The measured effect is
stratum-conditional. On questions about the early session, wider was better —
two visible bodies scored 0.091 against eleven at 0.333, with both baselines at
zero. On the other three question types both widths sat flat at zero, and on
recent-fact questions the baselines beat both. With only two points on the width
axis and one stratum above the floor, the data cannot locate a turning point:
there is no evidence width hurts as it grows from two to eleven, and none that
it keeps helping past eleven, because nothing above eleven has been run.

The load-bearing finding is that the ladder direction is a human choice hiding
inside a mechanism that looks derived. Fit-derived correctly makes the *ceiling*
a function of the window and the store with no guessed constant, but more than
one allocation of the same budget satisfies "fits", and which one gets used is
decided by the direction someone wrote into the ladder rather than by
measurement. That is the open parameter, and it is a fit-derived-shaped fix:
replace "walk this hand-picked direction" with "walk toward maximising the
number of rendered bodies subject to the same fits predicate", then measure.

Both alternative policies come out unnecessary on present evidence, for
specific reasons rather than by preference. Demand-driven fails because whether
the model searches does not track where the bottleneck actually is. An effort
dial fails because no single width serves a whole session. Neither fills the
allocation gap, so the recommendation is to keep fit-derived as the ceiling,
treat the headline-versus-body split as its one remaining parameter, and
replicate the cheap experiment on a second scenario before changing the shipped
default.

*Is the count already dynamic?* Yes, in the portability harness: the fold level
is the largest rung whose assembled Zone B fits, which is dynamic per window and
per store and needs no notion of difficulty. The live suite still uses a
constant. What remains open is not whether to adapt but which allocation to
adapt toward, which is the parameter named above.

**How deep a branch goes before it is summarized.** *Analysed 2026-09-02; full
report at `reports/metrics/tuning-branch-depth.md`.* Depth is not a decision
anyone made. It is whatever the tool-name map and the neutral-merge rule produce
from a trace, and on the one frozen store that has been measured, that is a
77-fold spread: 21 branches over 754 events, from 2,214 to 170,031 characters.
The largest spans 207 events and is bigger on its own than the entire window it
was being retrieved into, because the 64 shell calls and 2 skill calls inside it
map to the neutral phase and never close it, while every other call inside it
maps to the same type. Three of the twelve test questions source from that one
branch.

The fix is a config change already supported by the code rather than a new rule:
emptying the neutral-phase list, which the segmenter's own contract calls the
literal reading of its specification, re-segments the same events into 99
branches with a median of 3 events, and the over-window branch disappears — every
question then sources from a branch that fits every tested window. It is not
free: 4.7 times the branches is comparable growth in leaf-summarizer calls, and
two earlier reports both found those passes to be the dominant remaining cost
line against the baseline.

The honest qualifier is that granularity explains almost none of the *measured*
retrieval failures. The oversized branch is a confirmed structural risk that
never actually manifested as a truncated fetch, because models essentially never
fetched it at full depth at all. So this is a boundary condition to close, not a
scoring problem to chase.

**When summaries are written, and under what policy.** *Analysed 2026-09-02;
full report at `reports/metrics/tuning-summary-policy.md`.* Both earlier reports
independently concluded the leverage is here rather than in selection, and this
pass establishes three things.

The switch point's target is now settled: it is the Zone C fraction, because the
rule's own wording — the size at which the whole trace fits where the active
branch's detail would go — describes Zone C's allocation by definition. The two
harnesses had drifted apart on it, one deriving 0.35 and the other 0.20 for what
is the same quantity, and the live harness's matching constants match only
because someone picked the same number twice.

The gate lags by one turn, and the lag is measured rather than argued: it
compares against the previous completed turn's billed size, so the six recorded
crossings landed between 126 and 15,564 tokens past the threshold, median 8,306.
Removing the lag costs one local tokenizer pass over the prompt about to be
sent, not a model call.

Summary cost is not a standing tax but a single lump at a badly chosen moment.
It is zero on every short task that never crosses, and 6.9% to 19.3% of run cost
on long tasks that do, median 9.4%, arriving as one parallel batch that shows a
cache-write spike and two to six extra turns to absorb it.

The experiment that ranks timing policies needs no further spend. The existing
marathon harness already drives the production assembler over a real store with
no model call anywhere, the per-branch summary cost is already recorded in every
result file, and the budget derivation is a pure function of window and ratio, so
a candidate policy can be re-sequenced arithmetically over data already in hand.
One new parameter — when a branch's summary is inserted relative to a candidate
switch fraction — turns today's single curve into a comparable family.

**How caching is handled.** *Analysed 2026-09-02; full report at
`reports/metrics/tuning-caching.md`.* The rate ratio settles the central
question without a model call: a cache write costs 12.5 times a cache read per
token. So a stable prefix read every turn beats the same content rewritten every
turn unless the rewrite happens less than about once in every twelve turns, and
prefix *size* is not what decides it.

That trade has already fired the wrong way in a real run. On one long scenario a
33,000-token prefix was being rewritten roughly five times over the run, and the
cache-write line alone accounted for most of the total; writing it once and
reading it thereafter brought the same work on the same trace and the same model
down by a factor of 2.4.

Two facts change what to do next. The shipped request builder emits two of the
four breakpoints the provider allows and marks nothing on the active-branch
detail, so that section is fresh input on every turn by construction — a third
breakpoint is available and unused. And the cache assertion harness the plan
called for already exists and runs offline, 612 lines of simulator with 575
lines of tests, including one that specifically catches a dropped breakpoint.
The instrument to test this dimension is therefore already in the repository and
was not being used.

Terms. **L0** is the append-only event log. **L2** is the payload store, keyed by
content hash. **L1** is the tree: nodes that point into L0 by sequence range and
carry versioned summaries. **L3** is the embedding index. A **phase** is a run of
events grouped by the tool that produced them; a closed phase becomes a **leaf**;
the leaves hang off a **root**. **Zone A, B and C** are the three sections of
every prompt. **W** is the model's context window. The **switch point** is the
prompt size at which the tree stops showing the whole trace and starts
summarizing.

## Tier 0 — invariants

These hold on every model and every harness. If one of them is false, the thing
running is not this algorithm.

1. L0 is append-only and is the only source of truth. L1, L3 and any rendered
   view are derived and rebuildable.
2. L1 stores coordinates, not content. A node names a sequence range; the text
   lives in L2.
3. Summaries are versioned, never overwritten.
4. The prompt is Zone A then Zone B then Zone C, in that order, with Zone B in
   creation order. Retrieved results are appended after Zone C. Nothing reorders
   a prefix that has already been cached.
5. Ingestion is hermetic: it reads L0, L2 and a parser, and calls nothing over a
   network.

## Tier 1 — the loop

```
ingest
  append each event to L0; store its payload in L2; cap edit-tool arguments once the post-state blob exists
  segment L0 in one deterministic pass: tool name maps to a phase, unknown tool maps to "other"
  a closed phase becomes a leaf holding a sequence range

decide how much to summarize
  while the last prompt was smaller than the switch point, show the whole trace and summarize nothing
  once it is larger, latch: L0 only grows, so the whole trace will not fit again
  after latching, summarize each closed leaf on the cheap model, versioned, with pointers back to files and symbols
  a later edit marks its leaf stale and the mark travels to ancestors only
  compose the root from leaf headlines: the newest are kept whole, older ones fold to one line each

assemble
  Zone A: the contract, frozen; tool schemas travel as the API parameter, not as prompt text
  Zone B: root plus branch summaries, creation order, to its budget
  Zone C: the active branch's raw detail, to its budget

retrieve on demand
  search ranks summaries and returns coordinates
  fetch returns a branch's raw events, a listing of them, or its summary
  peek returns a raw excerpt; annotate records a note
```

## Tier 2 — what must be re-derived per model or harness

Every value that affects behaviour, each with its state under rule 2.
**Derived** means the host tells us and we compute it. **Validated** means a
constant shown to hold across models or harnesses, with the evidence named.
**Host** means it is meant to be supplied per deployment. **Unvalidated** means
a number fitted somewhere else and never re-checked, which rule 2 calls a defect
— those rows are the work queue. Hardcoded values are generally bad unless they prove to be a general pupose default that can be applied across models and harnesses.

| Value | Now | Where it should come from | State |
| --- | --- | --- | --- |
| switch point | 30,000, absolute (live suite) | **resolved 2026-09-02: the Zone C fraction of W** (see dimension 3 below) | **unvalidated, and the target is now known.** The rule defines the switch as the size at which the whole trace fits where the active branch's detail would go, which *is* the Zone C allocation. The live harness's switch and Zone C budget are both the literal 30,000, matching by coincidence rather than derivation; the portability harness derives 0.35 for one and 0.20 for the other, so the identity broke where the derivation lives. Measured consequence of the absolute form: on a 200k-window model the derived switch is ≈70k, so these traces would never cross, while 30,000 forced a crossing that cost more than it saved on every replicate |
| Zone B budget | 8,000, absolute (live) | a fraction of W | **unvalidated** live; derived in the portability harness |
| Zone C budget | 30,000, absolute (live); unbounded before the switch | a fraction of W | **unvalidated** live; derived in the portability harness |
| zone fractions | reply .05, A .10, B .20, C .20, switch .35, slack .10 | measurement against tokens, turns and score — rule 4 | **unvalidated as values**, never swept. The switch/Zone C inconsistency is **resolved in favour of .20**: they are the same quantity by the rule's own wording, and the growth report reached the same conclusion from measurement. The remaining fractions are still a design allocation summing to 1, and dimension 3 names the zero-spend sweep that would test .15/.20/.25/.30 |
| heuristic-to-tokenizer ratio | 0.851 on this corpus | measured per corpus, refuses above 1.6 | **derived.** The shape rule 3 asks for: procedure ships, re-runs per host |
| root keep (fold level) | 40 (live); per-window ladder (portability) | measurement — DS-STAR dimension 1 | **derived** in the portability harness as the largest rung whose assembled Zone B fits; **unvalidated** constant in the live suite. Note this is the *fold level*, not the number of summary bodies rendered — the two move in opposite directions, and which allocation wins is decided today by a hand-picked ladder direction rather than by measurement |
| search result limit | 20 | W and the per-hit payload size | **unvalidated.** At a 16k window the search payload alone overflowed the remaining room in 8 of 15 runs |
| peek / snippet / hydrate sizes | five different literals: 800, 2,000, 2,000, 240, 65,536 chars | one shared value sized to the room available | **unvalidated and mutually inconsistent.** The 65,536 default alone exceeds the entire default Zone C budget |
| rendered list cap | 40 values | the Zone B budget it is protecting | **unvalidated** |
| edit-argument cap | 512 bytes when a post-state blob exists | measurement against re-verification cost | **validated.** Both alternatives were run: dropping the arguments cost turns (a scenario went 13 → 25) and capping did not. The number itself has not been swept, but the choice between drop, cap and keep has |
| summary size, retry doublings | 1,024 tokens, up to 3 doublings | the summary model's own limit | **host** |
| leaf summarizer concurrency | 8 | the provider's rate limit | **host** |
| tool-to-phase map | 8 entries | **the harness** — tool names differ per host | **host**, and the one row every port must edit. Unknown tool maps to "other" rather than failing |
| contract version | v1 default, v2 and v3 registered | the model, if a smaller one needs different instruction | **host** |
| leaf summarizer model | haiku today, a cheap flash model next | cost tiering | **host**; never changed inside a scenario, which would re-freeze the epoch |
| reply budget | none | — | **removed** 2026-09-02. The live harness sends no `maxTokens`; the portability harness reserves the window's reply fraction with no ceiling |
| turn ceiling, wall-clock ceiling | none | — | **removed** 2026-09-02, see below |
| gate set | seven environment flags, all on | — | not a parameter: these seven *are* the algorithm. Promote to defaults and delete the flags |

### Not part of the algorithm

These belong to the measurement harness. Verified by grep: `maxTurns` and
`timeCapMs` appear only in `eval/src/loop.ts` and nowhere in `packages/core` or
`packages/mcp`, which is what would ship. The algorithm has no turn limit and no
notion of a run ending; it assembles a prompt for whatever turn it is handed.

**The turn and wall-clock ceilings were removed on 2026-09-02.** They defaulted
to 40 turns and 900 seconds. Two things were wrong with them, and the second is
the one that matters.

A duration limit cannot be derived. You cannot tell how long real work will take
by looking at the task: a single feature can run for hours and hundreds of
turns, and the sessions that produced this repository run longer than that. Any
number chosen in advance is a guess about the work, which makes it the same
category of defect as the hardcoded budgets in the table above, with no
measurable quantity to derive it from.

Worse, a ceiling fabricated data, and it fabricated it in both directions. Of
the 26 runs in this repository stopped by a ceiling, 16 were graded as failures
and 10 as successes. The successes are legitimate: those scenarios are graded by
running hidden tests against the sandbox, so a passing run did the work and only
kept talking past the ceiling. The 16 failures are not. Nothing about a stopping
point the harness picked says the model could not have finished.

One of those 16 sits under a published headline. The `v56-base` baseline, which
every configuration from v5.7 through v6.x was measured against, reported the
long scenario as five successes of five for the tree against three of five for
the transcript, and that reliability gap is the reason the tree was described as
winning where the baseline fails. Two of the baseline's five runs hit the
ceiling and were graded as failures. Measured only on the runs that produced an
outcome, the baseline is three of three with two runs unmeasured, and there is
no measured reliability difference between the arms on that scenario at all.

What replaced them:

| Concern | Instrument | Why it is the right one |
| --- | --- | --- |
| unbounded spend | `--cost-cap-usd`, already present, enforced by the cost meter | money is the actual finite resource, and it is measured directly rather than through a proxy |
| a run that will not finish | stall detection: three consecutive turns in which every tool call repeats one already made (`STALL_TURNS` in `eval/src/loop.ts`) | non-progress is a property of the run. A model that is still issuing new calls is still working, however long it takes |
| honest accounting | a run stopped by the harness is still graded, but only a PASS counts: a failing grade becomes `success: null`, not measured (`HARNESS_STOPPED` in `eval/src/types.ts`) | these scenarios are graded by running hidden tests against the sandbox, so a pass is a fact about the filesystem and means the work was done even though the ceiling cut off the talking. A failure at a stopping point the harness chose is not evidence the model could not have finished. A stall keeps both directions, because ending in a loop is a real task failure |

**The reply budget went the same day, for the same reason.** The live harness
sent a fixed 8,192-token `maxTokens` on every call and the portability harness
clamped its reply reservation to 800. Both are guesses about how much a model
needs to say. The clamp was worse than a guess: it won at every window above
about 16,000 tokens, so the reservation looked derived from the window while
being a constant, and on a model that reasons before it answers the budget could
be spent thinking, leaving an empty reply that a grader scores as a wrong
answer. That is the actual cause of a batch previously written off as a provider
quirk.

The live harness now sends no `maxTokens` at all, so each provider applies its
own maximum, which is the only number that knows the model. The portability
harness keeps a reservation, because prompt plus reply has to fit the window it
simulates, but it is purely the window's reply fraction with no ceiling: ten
times the window reserves ten times the reply. A host that genuinely needs a
bound passes one; nothing imposes it.

`--max-turns` and `--time-cap-ms` still exist with no default, for a probe that
deliberately wants a bound. The three tests in `eval/test/loop.test.ts` under
"a run the harness stopped is not a task failure" encode all of this.

## Boundary conditions

Portability is tested by finding where the algorithm stops working, not by
counting its steps. Each row is a condition, how it is checked, and what is known.

| Condition | Check | State |
| --- | --- | --- |
| window too small to hold Zone A plus one branch summary | assemble at 8k, 16k, 32k, 64k, 200k and assert each Zone B is a subset of the next larger | tested offline, passes |
| a leaf larger than the whole window | fetch a branch whose raw span exceeds W | **found, and a fix is measured offline**: one branch is 36k tokens against a 32k window because neutral-phase merging never closes it. Emptying the neutral-phase list re-segments to 99 branches and no question's source exceeds any tested window. Costs 4.7× the summarizer calls; the listing-then-range path also exists and is still untested live |
| host model cannot drive tools | one throwaway search-and-answer call before any scored run | rule adopted after a model scored zero everywhere |
| unknown tool name | segmenter maps it to "other" | tested |
| tokenizer heuristic drifts from the real count | measure the ratio, refuse above 1.6 | tested in the transplant harness only |
| a trace with one branch, or none | fold and assembly must be no-ops | tested |
| the switch point is reached late in a long run | measured on two scenarios | **found**: a late switch costs more than it saves, and before the latch it oscillated |
| summaries do not contain the answer | search and fetch must still reach it | **found**: none of twelve answer literals appears in any summary, which is what raw fetch is for |
| no embedder configured | search falls back to keyword ranking | supported, and until this week it was the only path anyone ran |

## Simplification ledger

The signal to watch is rules going away and hardcoded values becoming derived,
not any particular count.

| When | Rules removed | Rules added | Hardcoded values retired |
| --- | --- | --- | --- |
| Loops 5–7 | branch-count threshold replaced by a size threshold; root model call replaced by deterministic composition; Zone A schema text deleted; ephemeral tail deleted | none | none |
| Loop 9 kickoff | the transplant harness derives its budgets from W | none | the harness's own switch constant |
| 2026-09-02, item 1 | character estimate replaced by the model's own reported count | the latch, which replaced a property the character estimate had by accident | none |
| 2026-09-02, item 3 | none: both candidates measured null and were retired | none | none |

Open defects: seven hardcoded values in the table above, four of them budgets
that already have a derivation in the other harness.

## Candidates with a verdict, not yet in force

- **Raw by default**: fetch returns raw events by default, aimed by a sequence
  range, with a listing mode. Replaces "summary or raw" with "raw, sized to fit".
  None of the twelve answer literals is in any summary, so the current default
  cannot answer a verbatim question.
- **Search hits are coordinates**: a hit carries a short excerpt and pointers
  instead of the whole summary. Measured payload falls from 9,673 to 4,898
  tokens.
- **Contract v3**: the rule about stale summaries is replaced by one about what a
  summary cannot carry, and the sentence preferring a narrow fetch is deleted.
  One rule replaced, one removed.
- **Semantic ranking**: an embeddings client so the vector path runs. Offline it
  moved the median rank from 10.5 to 10.5 and gained one question in the top
  five, which says summaries cannot rank what they do not contain.
- **One budget derivation**: delete the live suite's absolute switch point and
  derive it from W, with the switch equal to the Zone C fraction as the rule
  already says.
- **Delete the Zone C fallback chain**: "open phase, else newest branch, else
  root" has three branches and the first never fires, because the segmenter
  closes every phase when it re-ingests.
- **Retired after measurement**: pre-filling Zone C with the newest branch;
  removing the harness's completion nudge; trimming a section from the contract.

## Change log

- **2026-09-02 11:45** — dimension 1 (visible branch count) analysed, and it
  corrected this document twice: the fold level and the count of rendered summary
  bodies are different numbers that move in opposite directions, and "width
  helps" holds on one question type out of four rather than generally. The
  load-bearing finding is that the fold ladder's direction is a human choice
  inside a mechanism that looks derived. Both dynamic-k alternatives come out
  unnecessary on present evidence, for stated reasons.
- **2026-09-02 11:40** — dimensions 2 (branch depth) and 4 (caching) analysed and
  folded in. Depth: a 77-fold size spread on the measured store, one branch larger
  than the window, and a config-only re-segmentation that removes it at 4.7× the
  summarizer calls — while granularity explains almost none of the measured
  failures. Caching: a write costs 12.5× a read, one scenario was rewriting its
  prefix five times per run at 2.4× the cost of reading it, a third provider
  breakpoint is available and unused, and the cache assertion harness the plan
  asked for already exists and was not being used.
- **2026-09-02 11:35** — dimension 3 (summary timing) analysed; its findings folded
  into the switch-point and zone-fraction rows and into its own section. The
  switch/Zone C contradiction is resolved in favour of the Zone C fraction. Two
  new measured numbers: the gate's one-turn lag overshoots by a median 8,306
  tokens across six crossings, and summary cost is 0% on tasks that never cross
  against a median 9.4% on those that do.
- **2026-09-02 11:30** — added the three candidate policies for the visible-branch count (fit-derived, demand-driven, user-selected) and the reason it is a real tradeoff: width buys retrieval but is re-read every turn.
- **2026-09-02 11:25** — rewritten around the four rules the owner stated: no
  budgets or caps; a hardcoded value is a defect unless that value is
  predictably helpful across models and harnesses; setting a parameter from a
  model's limits is fine but guessing is not; prefer finding the sweet spot to
  picking a bound. The parameter table now classifies every value as derived,
  validated, host, unvalidated or removed, and a new section names the four
  dimensions the DS-STAR loop is meant to improve — visible branch count, branch
  depth, summary timing, and caching — each with what the evidence already says.
  Only two rows come out validated; one of them, the edit-argument cap, only
  because both alternatives were actually run.
- **2026-09-02 11:15** — the reply budgets went too, after the owner asked why a
  general-purpose harness sets one at all. Related: an empty completion with no
  tool call now fails loudly in the OpenRouter client instead of returning an
  empty string that grades as a wrong answer, which corrected a root cause
  previously misattributed to reasoning models putting text in another field.
  694 tests pass.
- **2026-09-02 10:55** — the turn and wall-clock ceilings were REMOVED, not
  re-derived, after the owner rejected the idea of sizing them from the task:
  "There shouldn't be caps. You dont know how long something will take just by
  looking at the task." Spend is now the only ceiling, non-progress ends a run
  that will not finish, and a run the harness stopped is no longer graded. Three
  tests encode it; 143 eval tests pass. A follow-up the same hour corrected the
  rule itself: a capped run whose hidden tests PASS keeps its success, because
  the grade is a filesystem fact; only a failing grade becomes unmeasured. That
  distinction recovers 10 legitimate successes and still removes the 16
  fabricated failures, one of which carried a published reliability claim.
- **2026-09-02 10:30** — reorganised into tiers after the owner rejected the
  fixed line count: "I just asked for simple, repeatable, translatable across
  models and harnesses. Setting an arbitrary cap is restrictive." The line budget
  is gone. In its place: the tier-2 table now says what each value derives from,
  seven values are marked hardcoded, boundary conditions are listed with their
  test status, and the ledger tracks rules removed and constants retired.
- **2026-09-02 10:20** — item 3 measured: the sw-3 gap is 1.71× the baseline
  same-day, not 3.4×; both candidates null and retired.
- **2026-09-02 09:35** — item 1 measured: the switch fires and the curve
  flattens; final context does not fall below the baseline; total tokens rise.
- **2026-09-02 09:15** — page created.
