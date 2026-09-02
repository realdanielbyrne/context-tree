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

**How many branch summaries the model should see.** The first attempt asked the
question backwards, as how few it could get away with. Limiting what the model
saw made it reason more: the event-level top-k arm came out cost-neutral against
the baseline because the input tokens it saved were spent, in its own report's
words, on "extra output reasoning over a gappy history" — output up 36% — plus
cache invalidation from moving the selection boundary every turn. The
branch-level version never fired at all: the segmenter merges consecutive
same-type tool calls, so real tasks produced about three branches against a
cutoff of three. Meanwhile this loop's transplant experiment measured the
opposite direction and found width helps, with eleven visible summaries scoring
0.333 on early-session questions against two summaries at 0.091 and both
baselines at zero. So pruning is measured to hurt at the event level, untested at
the branch level, and width is measured to help. The question is which number of
visible summaries wins, not how far the count can be cut.

*Should the count be dynamic?* Three policies are on the table and they are not
alternatives to each other. **Fit-derived** is what the portability harness
already does: take the largest fold level whose assembled Zone B actually fits
its budget. That is already dynamic per window and per store, and it needs no
notion of difficulty. **Demand-driven** would widen when the model reveals it
needs breadth, by searching or fetching, rather than from any estimate made
before the run — the same argument that removed the turn ceiling applies, since
nobody can read difficulty off a task in advance. **User-selected**, in the
shape of an effort dial, is a reasonable escape hatch but must not be the
mechanism: a default that only works once the user tunes it is a guess with
extra steps.

What makes this a real tradeoff rather than a free choice is that width is paid
for on every turn. More visible summaries buy retrieval — measured — while
enlarging the cached prefix that is re-read each turn, and cache reads are 93.5%
of the remaining token gap on the refactor scenario. So width helps exactly when
the task needs old facts and costs when it does not, which is why the fit-derived
maximum is the honest starting point and demand-driven adjustment is the
candidate to measure against it.

**How deep a branch goes before it is summarized.** A branch is currently
whatever the segmenter's tool-name mapping produced, and its depth follows from
the model's own batching. Nothing has measured whether a shallower or deeper
unit retrieves better. The transplant work made the stakes concrete: one branch
in the frozen session is larger than the whole window it was being read into, so
depth is not a free parameter.

**When summaries are written, and under what policy.** Both earlier reports
reached the same conclusion independently, that the leverage is here rather than
in selection. This loop measured one instance. The switch from showing the whole
trace to summarizing it now fires, and the per-turn curve flattens after it, but
every measured crossing cost more than it saved — because the switch point is an
absolute number instead of a fraction of the window, and because it reads the
previous turn and therefore lands well past where it aimed.

**How caching is handled.** The prompt layout exists to keep a stable cached
prefix, and cache reads are where the token gap actually lives: on the refactor
scenario they are 93.5% of the difference from the baseline. The measured cause
was not the layout but re-reads across extra turns. This dimension holds the
largest measured share of the remaining gap and has had the least direct
experimentation.

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
| switch point | 30,000, absolute (live suite) | a fraction of W; the portability harness already computes 0.35·W ÷ ratio | **unvalidated** — and measured wrong: on a 200k-window model the derived form is ≈70k, so these traces would never cross, while the absolute 30,000 forced a crossing that cost more than it saved on every replicate |
| Zone B budget | 8,000, absolute (live) | a fraction of W | **unvalidated** live; derived in the portability harness |
| Zone C budget | 30,000, absolute (live); unbounded before the switch | a fraction of W | **unvalidated** live; derived in the portability harness |
| zone fractions | reply .05, A .10, B .20, C .20, switch .35, slack .10 | measurement against tokens, turns and score — rule 4 | **unvalidated as values.** They are a design allocation summing to 1, never swept. Two are also inconsistent: the switch fraction is .35 while Zone C is .20, though the rule says the switch is "the whole trace fits where the active branch's detail would go", which makes them the same quantity |
| heuristic-to-tokenizer ratio | 0.851 on this corpus | measured per corpus, refuses above 1.6 | **derived.** The shape rule 3 asks for: procedure ships, re-runs per host |
| root keep (visible summaries) | 40 (live); per-window ladder (portability) | measurement — this is DS-STAR dimension 1 | **derived** in the portability harness (largest fold level whose assembled Zone B fits); **unvalidated** constant in the live suite. Which value *wins* is unmeasured either way |
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
| a leaf larger than the whole window | fetch a branch whose raw span exceeds W | **found**: one branch is 36k tokens against a 32k window; the listing-then-range path exists but is untested live |
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
