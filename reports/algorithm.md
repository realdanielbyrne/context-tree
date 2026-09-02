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

Second, "width helps" was too broad. The effect holds on questions about the
early session — two bodies scored 0.091 against eleven at 0.333, both baselines
zero — and sits flat at zero on the other three question types, with the
baselines beating both widths on recent-fact questions. It also rests on very
little: on that stratum it reduces to a single question, answered three times of
four against once of five. With two points on the width axis and one stratum
above the floor, the data cannot locate a turning point.

Third, **what width costs is unknown, and this page has been wrong about it
twice.** It first said width buys retrieval at the price of a larger prefix
re-read every turn. It then said width is a pure reallocation costing nothing,
because the assembled block is nearly the same size either way, 7,633 tokens
against 7,569. The iteration-2 judge rejected both. Zone B's rendered size
barely moves, which kills the first; but the run-level token gap between the
arms is real and was never decomposed, so the second asserted an absence of cost
that no measurement supports. The honest statement is that the arms differ by a
measured amount at the run level and nobody has attributed it. That attribution
is a next step, not a finding.

The load-bearing finding is that the ladder direction is a human choice hiding
inside a mechanism that looks derived, and the reproduction sharpened it: six of
the seven ladder rungs satisfy the fit predicate at the tested window. So
"largest rung that fits" barely constrains anything, and the direction someone
wrote into the ladder picks the allocation almost unaided.

Walking the whole curve then partially dissolved that finding, which is the
right outcome for an experiment. The number of rendered bodies is monotone
non-increasing in the fold level — 0, 2, 5, 6, 8, 10, 11 across the rungs at the
32,768-token window — so the allocation maximising bodies is always the smallest
rung, which is exactly where the wide arm already stops. There is no
undiscovered third mechanism to build: the two shipped arms are the two ends of
a monotone curve. What remains is whether to flip the default, which is an epoch
shift and needs a second scenario first.

Both alternative policies are now refuted rather than merely unnecessary.
Demand-driven failed first on occurrence — whether the model searches does not
track where the bottleneck is — and then again on confidence: across 120 rows
that searched, retrieval rank carries no signal about score (correlation 0.06),
and the question with the best possible rank scored zero on all six of its
attempts. An effort dial fails because no single width serves a whole session.
So keep the fit-derived ceiling, and the only open decision is whether to flip
the ladder default, gated on replicating the divergence on a second scenario.

*Is the count already dynamic?* Yes, in the portability harness: the fold level
is the largest rung whose assembled Zone B fits, which is dynamic per window and
per store and needs no notion of difficulty. The live suite still uses a
constant. What remains open is not whether to adapt but which allocation to
adapt toward, which is the parameter named above.

**How deep a branch goes before it is summarized.** *Analysed 2026-09-02; full
report at `reports/metrics/tuning-branch-depth.md`.* Exact tokenization found
**two** branches over the larger tested window and **four** over the smaller
one, so seven of the twelve questions source from an over-window branch. The
character-ratio estimate that first measured this undercounted two branches by
43% and 67%, which is why the figures kept moving: a segmentation proposal has to
be priced with a real tokenizer. Depth is not a decision anyone made. It is whatever the tool-name map and the neutral-merge rule produce
from a trace, and on the one frozen store that has been measured, that is a
77-fold spread: 21 branches over 754 events, from 2,214 to 170,031 characters.
The largest spans 207 events and is bigger on its own than the entire window it
was being retrieved into, because the 64 shell calls and 2 skill calls inside it
map to the neutral phase and never close it, while every other call inside it
maps to the same type. Three of the twelve test questions source from that one
branch.

The obvious fix is a config change the code already supports: emptying the
neutral-phase list, which the segmenter's own contract calls the literal reading
of its specification, re-segments the same events into 99 branches with a median
of 3 events. **It does not close the boundary condition, and iteration 2 refuted
the claim that it does.** One branch still exceeds the larger window afterwards
and three still exceed the smaller one. It helps where it was measured — questions
missing their source fall from three to none at the larger window and from seven
to two at the smaller — but "eliminates the over-window branch entirely" was
wrong. The cost is also smaller than first stated: 4.7 times the branches but
2.33 times the summarizer spend, because a finer branch carries a smaller
prompt. And the claim that two earlier reports both named leaf-summarizer passes
the dominant residual cost does not hold: one names the *root* summarizer, and
only the summary-timing analysis measures the leaf.

**The better fix turned out to be a defect, not a config change.** The surviving
oversized branch is inflated by content rendered twice — a write's payload
appearing once JSON-escaped in the tool arguments and once raw in the post-state,
inside the same retrieval result. Zone C's renderer had capped that since v5.9b;
the retrieval renderer never did, so `context_fetch` kept returning the duplicate
that the prompt had stopped carrying. Six of the store's 754 events duplicate
byte-for-byte this way. The cap now applies in both places from one exported
constant, so the rule holds wherever an event is rendered.

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

The gate lags by one turn, and both the lag and its fix are measured. It
compares against the previous completed turn's billed size, so all six recorded
crossings sent one prompt between 126 and 15,564 tokens over budget, median
8,306. Replayed against those same crossings, checking the prompt about to be
sent instead drops the median overshoot to zero and the worst case to 916, at a
cost of two to four milliseconds of local tokenizing against multi-second turn
latencies.

The fraction sweep, by contrast, **cannot rank the fractions**, and saying so is
the finding. From 0.15 to 0.35 the post-switch prompt is a constant 9,060
tokens, so total tokens are the trace up to the crossing plus a constant
afterwards — which makes an earlier crossing monotonically cheaper and the
argmin whatever the smallest fraction tested happens to be. The sweep measures
its own lower bound, not a sweet spot. Choosing a fraction needs a criterion
tokens cannot supply, such as what the model can still answer once the raw trace
is gone.

Summary cost is not a standing tax but a single lump at a badly chosen moment:
zero on the seventeen runs that never cross, against a median 9.4% of run cost
on the six that do. The transition's own price shows on the turn *after* the
switch — a median 18,274 cache-write tokens against 273 for the matched
no-switch arm — and costs four to six extra turns. A spike on the crossing turn
itself is not diagnostic, since the no-switch arm spikes on its own growth turns
too. One correction to the mechanism as first stated: only the backlog is
summarized in one batch, and after the latch summarization is incremental.

A measurement gap surfaced here that affects every published figure: the
harness's token total excludes the leaf summarizer, so no total-token number in
this program includes summary cost.

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

The third breakpoint now exists in the library behind a field defaulting to
off, which closes the defect that it lived only in the eval harness. Its value is
another matter, and iteration 2 refuted the optimistic reading instructively.

Through the cache simulator, marking the active-branch detail costs 23% *more*,
because that marker moves every turn — a 100% rewrite frequency against a
computed break-even of 78%. The frequency form of the rule this page carried,
that it breaks even below about one turn in twelve, was a size ratio wearing a
frequency's clothes; the break-even is a formula over the three published rates,
and by it Zone B's marker wins at 2.7% rewrite while Zone C's loses at 100%.
Same rule, opposite sides of the line.

But a live measurement of the same scheme, already published here, shows it 18%
*cheaper*. Both cannot be right, and the disagreement is the real result: the
simulator matches only against the last submission's exact breakpoint set, where
providers match any previously cached prefix. The instrument that was finally
pointed at the builder needs validating against the live run before its verdicts
count — and that validation is free, with the target already on disk.

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
| zone fractions | A .10, B .20, C .20, switch = C, slack .10 | measurement against tokens, turns and score — rule 4 | **unvalidated as values**, never swept, but now **derived from the window in one place** (`deriveZoneBudgets`, 2026-09-02) instead of living as independent constants. The switch point is the Zone C share *by construction*, so the .35-versus-.20 drift cannot recur. Dimension 3's zero-spend sweep of .15/.20/.25/.30 is what would validate the value |
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
| reply allowance (per turn) | `window − assembled prompt`, reported on every prompt and passed as the provider's `max_tokens` | the window and this turn's prompt — pure arithmetic | **derived** 2026-09-02 (`replyAllowance`). Adapts per turn: nearly the whole window early, small late, and the session continues on short replies where a fixed ceiling would have made the request invalid. **Not yet tested live — needs its own DS-STAR round** |
| reply headroom (pre-assembly reservation) | the model's reported maximum, or a measured observation; window share only as fallback | the model — rule 3 | **derived** 2026-09-02 (`replyHeadroom`). Used when deciding what to *include*; the per-turn allowance above is what actually reaches the provider. Both are distinct from a reply *cap*, removed the same day: headroom is required so prompt plus reply fits, while a ceiling on what the model may say is a guess about the work |
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
| window too small to hold Zone A plus one branch summary | assemble at 8k, 16k, 32k, 64k, 200k and assert each Zone B is a subset of the next larger | **FOUND at 8,192**, and it is the partition's doing rather than the window's: no fold level leaves a single summary body inside the 20% share, though the whole prompt would fit the window. The nesting assertion still passes because a dead cell is reported as dead rather than forced |
| a leaf larger than the whole window | fetch a branch whose raw span exceeds W | **found, still open**, and now decomposed into two independent causes. Segmentation: two branches exceed 32,768 tokens and four exceed 16,384; the neutral-phase change reduces but does not eliminate them (one and three remain). Rendering: a write's content was emitted twice in retrieval results, six events byte-identical — that cap is now applied, and re-measuring the branch sizes after it is a next step. The listing-then-range path exists and is still untested live |
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
| 2026-09-02, iteration 2 | the frequency form of the cache rule (replaced by a formula over three published rates); the claim that the fit predicate under-determines the allocation (replaced by the monotone curve, which shows the two shipped arms are its two ends) | none | the missing edit-argument cap now shared from one exported constant instead of existing in one renderer only |

Open defects: seven hardcoded values in the table above, four of them budgets
that already have a derivation in the other harness.

## The zone partition is itself a budget

Found 2026-09-02 by the owner reading this page: the branch-count dimension talks
about fitting a budget, which contradicts rule 1. It does, and the contradiction
is load-bearing rather than cosmetic.

The real constraint is the window: a prompt fits or the request fails. What the
fit test actually compares against is an invented share of that window — twenty
percent, assigned to Zone B — so "the largest fold level that fits" is fitting to
a number nobody validated. Under rule 2 that share is an unvalidated constant;
under rule 1 it is a budget.

Three measurements make it worse than a harmless approximation.

It barely binds. Six of the seven ladder rungs pass the test at the tested
window, so the budget is not protecting anything and the hand-picked ladder
direction makes the real decision.

It cannot be checked against the truth. The word "window" appears nowhere in
`packages/core/src/assemble/assembler.ts`. It sums the zones into a total and
never compares that total to anything, because it has nothing to compare it to —
the portability audit found the same absence structurally, that the shipped
library has no representation of the host's window size at all. The partition
exists as a substitute for the one number the library lacks.

And it manufactured the reallocation result recorded above. Because the zones
compete for an invented share rather than for the actual window, extra summary
bodies necessarily displace root headlines even when the real window has room.
"Width is a reallocation" is a fact about this implementation, not necessarily
about the algorithm.

**Fixed, 2026-09-02.** The library now has the window and checks the real
constraint, in `packages/core`:

- `ZoneAssemblerDeps.window` and `AssembleOptions.window` take the host's
  context window. Host-supplied on purpose, with no default — a default window
  would be a guess about the deployment, which is the defect being removed.
- `BudgetReport` gained `window`, `windowRemaining` and `overWindow`. The
  assembler had been summing a total and comparing it to nothing; now it names
  the one constraint that is not a matter of allocation. It reports rather than
  enforces: a caller that ignores `overWindow` gets a provider error, which is
  the loud failure, and trimming here would hide which zone lost content.
- `deriveZoneBudgets(window, ratio)` in `assemble/budgets.ts` derives every
  allowance from that one number, replacing two independently chosen constants.
  Ten times the window gives ten times each allowance, which a constant cannot
  do and a test now enforces. The switch point is the same quantity as the Zone
  C share by construction, so the two cannot drift apart again.
- `zoneBRemainder(...)` is the answer to "fit against what?" that invents
  nothing: what the window has left once the fixed contract, the active
  branch's detail, the tail and the reply headroom are accounted for. A summary
  block that fits the remainder is one the prompt can carry; one that fits a
  fifth of the window may still overflow, and one rejected for exceeding that
  fifth may have had room all along. A test shows the remainder exceeding the
  share on the measured store's own numbers.

The fractions are still unvalidated as values — rule 4 says which allocation
wins has to be measured — but they are now one thing derived from a real
quantity in one place, which is what a sweep needs to vary.

**Reply headroom is required by the algorithm; a reply cap is not.** This
distinction was blurred earlier in the day and is now explicit in
`replyHeadroom(...)`. Prompt plus reply must fit the window, so the reservation
stays: crowd the reply out and the provider truncates the answer. What was
removed is the *ceiling* on how much the model may say, which is a guess about
the work, and on a model that reasons before answering can be spent thinking —
leaving an empty reply a grader scores as wrong. The size of the reservation
comes from the model: every provider reports the largest completion it will
emit, and asking is what rule 3 permits. A caller that has measured its own
replies may reserve the largest it has actually seen instead, bounded by what
the model could emit; exceeding that costs a truncated answer that is reported,
not a silent degradation. The window fraction survives only as the fallback for
a host that cannot say, and the function returns which of the three sources
produced the number so a caller is never left assuming.

**The per-turn reply allowance dissolves the tension I said was open.** Rather
than reserving room before assembly for a reply whose size cannot be known, set
the provider's reply limit *after* assembly from what the window has left:
`replyAllowance(...)`, reported on every prompt as `BudgetReport.replyAllowance`
and passed straight through as the provider's `max_tokens`.

That is arithmetic per turn rather than a number anyone picked, so it is not the
thing rule 1 forbids. And it buys behaviour a fixed ceiling cannot have. Early
in a session the prompt is small and the allowance is nearly the whole window,
so the model may answer at length. Late in a long session the prompt is large
and the allowance is small, so the model answers briefly — and the session
continues, where a fixed ceiling would have made the request invalid and ended
it. A small-window model can iterate through a long session on short replies
instead of failing at the point its prompt outgrew its ceiling. Sending the
number also tells the model its own allowance, which a sentence in the prompt
cannot do reliably: the provider stops at it, so the model shortens its answer
rather than being cut mid-sentence.

The allowance reaching zero is a signal, and it is the same quantity the switch
point is about: when the room left for an answer stops being enough for a
useful one, the prompt is what has to give, not the answer. The function
deliberately does not pick a floor for "useful", because that is task-shaped and
choosing one would smuggle back the constant this work removed. It reports which
side bound the allowance — the window, so a smaller prompt buys a longer answer,
or the model, so nothing does.

**Untested.** All of the above is offline reasoning plus unit tests; no live run
has used a per-turn allowance. It needs a DS-STAR round of its own, recorded as
the first item in the closing report's next steps
(`eval/plans/tuning/NEXT-STEPS-QUEUE.md`).

The instrument for it already exists, and it is the transplant substrate rather
than a new long-running scenario: a frozen 754-event session of roughly 196,000
tokens, already used for the cross-model work. Walking forward through that trace
and asking a live question at intervals produces the whole allowance curve
against a real long horizon on a small-window model, repeatably, with every arm
seeing byte-identical inputs. What a frozen replay cannot show is trajectory —
the allowance changes what the model says, which changes the trace, which changes
the next prompt, and a replay holds the trace fixed. So the replay settles answer
quality at each allowance level, and only if that is worth confirming does a
genuinely long live run become worth its cost.

What remains open beyond that is the ordering. Giving Zone B the true remainder
needs Zone C's size first, and the zones are assembled in layout order, so the
remainder is available to a caller but not yet used by the assembler itself.
That is a behaviour change and belongs to a judged candidate, not to a defect
fix.

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

- **2026-09-02 12:35** — DS-STAR iteration 2 closed (four offline experiments plus
  a judge; `eval/plans/tuning/ITERATION-2-VERDICT.md`). It refuted more than it
  confirmed, including three claims this page was carrying. Re-segmentation does
  NOT close the over-window boundary condition. The width-cost question is
  reopened as unknown, both my claim and its correction having been rejected.
  The third cache breakpoint measures 23% worse offline while a live run of the
  same scheme measured 18% better, which indicts the simulator rather than the
  scheme. Confirmed instead: the lag fix drops median overshoot from 8,306 to
  zero for two to four milliseconds of tokenizing, and the ladder curve is
  monotone so there is no new allocation mechanism to build. Landed as defect
  fixes: the missing edit-argument cap in the retrieval renderer, and the
  harness now working on a copy so the frozen fixture stops being written — it
  had accumulated 1,546 root-summary versions, which is why one experiment's
  numbers could not be reproduced hours later.
- **2026-09-02 12:25** — the owner proposed the per-turn reply allowance, which is
  strictly better than both of my positions and dissolves the tension I had just
  recorded as open: set the provider's reply limit after assembly from what the
  window has left, rather than reserving for an unknowable reply beforehand.
  Implemented as `replyAllowance` and reported on every prompt. Untested live;
  queued as the first next step in the closing report. 721 tests pass.
- **2026-09-02 12:20** — fixed rather than filed. `packages/core` now takes the
  host's window, reports `window`/`windowRemaining`/`overWindow` so the real
  constraint is checked instead of a share, derives every zone allowance from
  that one number through `deriveZoneBudgets`, and offers `zoneBRemainder` as the
  fit test that invents nothing. `replyHeadroom` makes the reply distinction
  explicit: headroom is an algorithm requirement sized from the model's reported
  maximum (or a measured observation), while a reply ceiling is not. All
  additive — a window changes nothing about what gets built, which a test
  asserts. 714 tests pass.
- **2026-09-02 12:10** — the owner read this page and caught rule 1 being broken by
  it: the branch-count fit test compares against an invented twenty-percent share
  of the window, not against the window. Added a section on it. The partition
  barely binds (six of seven rungs pass), cannot be checked against the truth (the
  assembler has no representation of the window and never compares its own total
  to anything), and manufactured the reallocation result recorded above. Candidate
  recorded: delete the partition and fit against the window instead, which depends
  on the audit's top recommendation of giving the library a window to fit against.
- **2026-09-02 12:05** — all four dimension reports published under
  `reports/metrics/` as HTML with markdown twins, and every writer's number-check
  corrected this page. The largest: **width is a reallocation, not an addition** —
  Zone B is budget-bound, the assembled block is the same size either way, so the
  claim here that width costs tokens every turn was wrong. Also: four branches
  exceed the smaller window rather than one, so seven questions are affected; six
  of seven ladder rungs satisfy the fit predicate, so "largest that fits" barely
  constrains; the devolved-mode cache fix trades writes for turns rather than
  winning outright; and the harness's token total excludes the leaf summarizer,
  so no published total includes summary cost.
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
