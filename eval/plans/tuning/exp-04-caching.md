# Experiment 4 — using the cache assertion harness on the caching dimension

DS-STAR pass 2 (experiment stage) for dimension 4, following
`eval/plans/tuning/04-caching.md`'s analysis. That analysis named its
cheapest-and-decisive next step explicitly: the §17 cache assertion harness
(`packages/core/src/cache/{simulator,prefix}.ts`) already exists, runs
offline, and was never invoked anywhere in `eval/`. This pass invokes it.

**Abstract.** Running the shipped `ProviderCacheSimulator` over a 754-turn,
zero-model-call replay of the frozen `s1` fixture shows that the "3rd
breakpoint" the prior analysis described as "available and unused" — a single
marker placed on the last non-map Zone C block, exactly as
`eval/src/loop.ts`'s `toZoneCCachedRequest` already does it — produces **no
measured cache-read benefit** on this trace and costs **23% more** than the
shipped 2-breakpoint layout ($23.21 vs $18.88 at published `claude-sonnet-5`
rates). The mechanism is arithmetic, not a bug: the harness only credits a
read when a breakpoint lands on the *same block position* two turns running,
Zone C's active-branch detail grows on effectively every turn (754/754 = 100%
in this replay), and a rate-derived crossover computed from the published
prices puts the break-even at 78.3% of turns — so a marker that moves on
(nearly) every turn sits on the losing side by a wide margin. This directly
contradicts the framing in the prior analysis's §(a), which is corrected
below. It does **not** contradict that Zone B's own single trailing marker is
correctly designed: Zone B's real rewrite frequency on this trace is 2.65%,
comfortably under the same 78.3% line. The pass also surfaces a genuine
disagreement with an **already-published, real, live measurement**
(`reports/metrics/tree-vs-transcript.md`) that ran the identical
one-marker-per-zone-C scheme in production and recorded climbing cache reads
— a fidelity gap in the offline harness that is named as follow-up work, not
resolved here. The Zone C breakpoint mechanism is still landed, behind a new
config field defaulting to off, with tests — the infrastructure is real and
useful even though this experiment does not recommend turning it on.

## What was measured, and how

**Instrument.** `packages/core/src/cache/simulator.ts`'s `ProviderCacheSimulator`
under `ANTHROPIC_PROFILE` (`maxBreakpoints: 4`, `minCacheableTokens: 1024`,
both respected, neither relaxed for this experiment).

**Substrate.** `eval/fixtures/transplant/s1/store` — the frozen 754-event,
21-phase, 46-node real store — copied to a scratch directory
(`mkdtempSync`/`cpSync`) before every run; the frozen fixture itself is never
opened for writing. `git status` on `eval/fixtures/transplant/s1` after every
run in this pass shows no diff against the frozen tree.

**Replay.** `eval/scripts/cache-sweep.mjs`, runnable as
`node eval/scripts/cache-sweep.mjs [maxTurns]`. It walks the store's 21 real
phases in creation order; within each phase it grows the (copied) node's
`span_end_seq` **one real L0 event at a time**, so Zone C accretes exactly as
it would turn-by-turn in a live session, using `ZoneBSelection.keepBranches`
to restrict Zone B to phases already closed at that point in the walk (a
resumed session cannot see its own future). 754 events become 754 turns —
the finest, most conservative unit available; a coarser "one turn per tool
round-trip" choice would only dilute the same event mix, not change its
direction. Two `ZoneAssembler`s read this walk in lockstep — `shipped`
(today's default, 2 breakpoints) and a new opt-in `cacheZoneCBreakpoint: true`
instance (3 breakpoints) — each feeding its own persistent
`ProviderCacheSimulator` so within-session state (the "previous submission")
accumulates correctly for both. Zero model calls anywhere in this path; the
only non-deterministic-looking output (block ids) is content-addressed and
therefore reproducible.

**n.** 754 turns (1 scenario, 1 trace, 2 layouts run over the identical
walk). This is a single frozen fixture, not a multi-scenario sweep — the
qualifiers on that below are in "What this pass does not show."

## (a) / (b) — fraction of each turn served from cache

| layout | median cache-read fraction | mean | session cacheRead (tok) | session cacheWrite (tok) | session fresh (tok) | session total (tok) | session cacheReadRatio |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| shipped (2 breakpoints) | 0.520 | 0.477 | 5,079,261 | 135,954 | 8,761,222 | 13,976,437 | 0.3634 |
| 3rd breakpoint (Zone C) | 0.520 | 0.477 | 5,079,261 | 8,803,759 | 93,417 | 13,976,437 | 0.3634 |

**MEASURED.** The cache-read fraction is *identical* between the two layouts,
turn for turn — median 0.520, mean 0.477, session ratio 0.3634, all three
figures matching to the token. `session cacheRead` is the same number
(5,079,261) in both rows. This is not a coincidence of rounding: under this
harness, Zone C is **never** read from cache in either layout (confirmed
directly — every read comes from the Zone A/B segments, which are identical
between the two assemblers since neither layout changes how Zone A or B is
built). The only difference is what happens to the tokens Zone C would
otherwise have cost: under the shipped layout they are `fresh` (billed at the
plain input rate); under the 3rd-breakpoint layout they are `cacheWrite`
(billed at 1.25x input) because a marker is present but never matches a prior
position. Session dollar cost at `claude-sonnet-5`'s published rates
(`packages/core/src/models/cost.ts:60`: input $2.00/M, output $10.00/M,
cache-read $0.20/M, cache-write $2.50/M — cache-read is 0.1x input,
cache-write is 1.25x):

- shipped (2bp): **$18.8782**
- 3rd breakpoint: **$23.2121** (+23.0%)

This refutes the framing in `04-caching.md`'s §(a): a 3rd breakpoint being
"available" (within the provider's 4-breakpoint limit) is not the same as it
being "unused" in the sense of leaving money on the table. Measured through
the harness the plan itself named as authoritative for this dimension, using
it here makes the session **more** expensive, not less.

## (c) — invalidation ranking by event type and layout

| layout | event type | n turns | cacheWrite (tok) | fresh (tok) | cacheRead (tok) | $ (write+fresh+read) |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| shipped | tool_result append | 311 | 0 | 3,636,707 | 2,178,548 | $7.7091 |
| shipped | tool_call append | 291 | 0 | 3,504,848 | 2,023,673 | $7.4144 |
| shipped | assistant_message append | 100 | 0 | 1,272,738 | 651,671 | $2.6758 |
| shipped | user_message append | 32 | 3,719 | 310,330 | 202,729 | $0.6705 |
| shipped | phase transition | 20 | 132,235 | 36,599 | 22,640 | $0.4083 |
| 3rd breakpoint | tool_result append | 311 | 3,599,553 | 37,154 | 2,178,548 | $9.5089 |
| 3rd breakpoint | tool_call append | 291 | 3,468,975 | 35,873 | 2,023,673 | $9.1489 |
| 3rd breakpoint | assistant_message append | 100 | 1,257,334 | 15,404 | 651,671 | $3.3045 |
| 3rd breakpoint | user_message append | 32 | 310,350 | 3,699 | 202,729 | $0.8238 |
| 3rd breakpoint | phase transition | 20 | 167,547 | 1,287 | 22,640 | $0.4260 |

**MEASURED.** The ranking, by dollar cost, is the same under both layouts
(tool_result append > tool_call append > assistant_message append > user_message
append > phase transition) because turn *counts* per event type are
layout-independent — this is a real trace, and events arrive in the order
they arrived. What changes is which *rate* each bucket is billed at:

- Every "event append" bucket (an L0 event landing inside an already-open
  phase — 734 of 754 turns, 97.3%) moves almost entirely from `fresh` (shipped)
  to `cacheWrite` (3rd breakpoint), at 1.25x the fresh rate, with no
  compensating read. This is the mechanism, not noise: `tool_result`'s bucket
  alone costs $1.80 more under the 3rd breakpoint (from $7.71 to $9.51) purely
  from this rate swap on the same token count.
- The one bucket where the 3rd breakpoint's cost delta is small in relative
  terms is **phase transition** (20 turns, 2.65% of the session): $0.4083 vs
  $0.4260, a 4.3% increase — far smaller than the ~24% increase on every
  event-append bucket, because a phase transition already rewrites Zone B (and
  therefore forces a Zone C reset for the new active branch) in both layouts,
  so the marginal 1.25x-vs-1x delta only applies to the smaller residual.

The one type this table does **not** contain, because it never occurred in
754 turns of a real trace, is "two consecutive turns with byte-identical Zone
C content" — the one case in which this harness's exact-position matching
*would* credit the 3rd breakpoint with a read (see the packages/core test
`packages/core/test/cache.test.ts`, describe block "Zone C 3rd breakpoint").
That case is rare enough in a real agent loop that it never appeared once
across this whole trace.

## The crossover, computed

`04-caching.md`'s §(c) states informally that a stable, read-every-turn
prefix "breaks even against a same-content prefix that is rewritten every
turn... once the rewrite frequency drops below roughly 1-in-12.5 turns," and
flags that claim itself, honestly, as "a derivation from the two published
rate constants, not a swept result." Redoing that derivation rigorously
surfaces that the informal "1-in-12.5" phrasing does not survive the algebra
for the frequency question it is posed against (Rule 5: pick one, flag the
other for cleanup — the size-ratio reading of "12.5x" quoted elsewhere in that
report, "a re-read prefix up to ~12.5x larger... still costs the same per
turn," is correct and simply `Pwrite / Pread = 12.5`; the frequency-threshold
phrasing is the one that needed re-deriving).

The well-posed frequency question is: for one turn's worth of a stable
content block, is it cheaper to **never mark it** (plain input rate every
turn, regardless of whether it changed) or to **mark it** (paying the
cache-write rate on the turns it changes, the cache-read rate on the turns it
doesn't)? At rewrite frequency `f`:

```
cost(unmarked)      = Pinput
cost(marked, freq f) = f · Pwrite + (1 − f) · Pread
```

Solving `Pinput = f* · Pwrite + (1 − f*) · Pread` for the crossover:

```
f* = (Pinput − Pread) / (Pwrite − Pread)
```

At `claude-sonnet-5`'s published rates (`Pinput = $2.00/M`, `Pwrite =
$2.50/M`, `Pread = $0.20/M`):

```
f* = (2.00 − 0.20) / (2.50 − 0.20) = 1.80 / 2.30 = 0.7826  (78.3%)
```

**Below** 78.3% of turns changing, marking wins — the discount on the
majority-read turns (10x cheaper than plain input) outweighs the 1.25x
premium on the minority-write turns. **Above** it, leaving the content
unmarked is cheaper. This is a general result (it only depends on the three
published rates, not on this trace, this layout, or a prefix size), and it
is a genuinely different quantity from the earlier "1-in-12.5" phrasing,
which conflated a size ratio with a frequency threshold.

Measured against this trace:

- **Zone C** (the layout this experiment adds a marker to): rewrites on
  **754/754 turns = 100%** — every single turn, because Zone C's active-branch
  detail grows by construction whenever the open phase receives a new event.
  100% ≫ 78.3%: the 3rd breakpoint sits on the losing side of its own
  crossover by a wide margin, and the $18.88-vs-$23.21 session totals above
  are exactly what that predicts.
- **Zone B** (the shipped design's own single trailing marker, unchanged by
  this experiment): rewrites on **20/754 turns = 2.65%** — one rewrite per
  phase transition, nothing in between. 2.65% ≪ 78.3%: Zone B's marker is
  correctly designed by this same test, which is why its cache-read fraction
  climbs steadily across the session (visible in the (a)/(b) table's high
  `cacheReadRatio` — Zone A+B contribute all 5,079,261 read tokens in both
  layouts) rather than costing anything.

The two zones are not a contradiction; they are the same rule applied to two
measured frequencies that happen to sit on opposite sides of the same line.

## A discrepancy with an already-published live measurement

`reports/metrics/tree-vs-transcript.md` already contains a **real, live**
production run (no new spend by this pass; the numbers below are quoted, not
reproduced) of a scheme identical in intent to this experiment's Zone C
marker: `toZoneCCachedRequest` (v5.5/v5.6), one message per Zone C block with
a single moving `cache_control` on the last non-`C:map:` one. That report's
own measurement (`tree-vs-transcript.md:155`): *"in rep1, cacheRead climbs
monotonically 4,788→23,794 (each turn's write read back at 0.1x), cacheWrite
stays delta-sized (~1.2k median)."* That is the opposite qualitative shape
from what this pass's offline harness predicts for the same design (zero Zone
C reads, ever, once content is growing).

**This is a real disagreement, not an error in either report.** The two
measurements are of different things: `tree-vs-transcript.md` is a live
Anthropic API run; this pass is the offline `ProviderCacheSimulator`. Reading
the simulator's own matching rule again explains the gap precisely: a read is
only credited when the *current* submission's breakpoint lands at the exact
same `endBlockIndex` a *previous* submission's breakpoint also landed at
(`simulator.ts:184-193`). A single marker that moves forward by one block
every turn never satisfies that condition against itself. Anthropic's own
documentation of prompt caching describes a single trailing breakpoint being
sufficient for the system to automatically match the longest previously
cached prefix — which, if accurate, would explain why the live run reads
successfully where this exact-position-matching model does not. The
simulator's own header comment already flags a version of this risk directly:
*"under-crediting cache reads cannot hide a D5 regression; over-crediting
could"* (`simulator.ts:20-24`) — but that comment is about a different
simplification (only one prior submission considered "live," not several
under a TTL); it does not cover the exact-position-recurrence requirement
this pass found, which looks like a second, separate instance of the same
conservative bias, large enough here to flip the sign of the conclusion for
this specific pattern.

**Consequence for what to trust.** For Zone B's marker (rewrite frequency
2.65%, deep in "wins either way" territory) the two models agree in direction
regardless. For Zone C's single moving marker, they disagree in direction,
and the stakes are exactly whether to recommend turning the config field on.
This pass does not resolve that disagreement — resolving it needs either a
live measurement (out of scope: "ZERO model calls" is a hard constraint here)
or extending the simulator to model automatic-lookback-from-a-trailing-marker
against every historically cached position, not only the immediately
previous submission. That extension is named as the next step below, not
attempted in this pass, because building and validating a new cache-matching
algorithm is not the "cheapest and decisive" experiment this pass was scoped
to — it is a different, larger piece of work that this finding motivates.

## What this pass does not show

- **One scenario, one trace.** `s1` is a single 754-event, 21-phase session.
  The 100%-vs-2.65% rewrite-frequency contrast is unambiguous on this trace,
  but "Zone C always grows every turn" is a property of how an agent loop
  actually behaves (a tool result almost always follows a tool call), not an
  artifact of this particular fixture — reproducing it on a second scenario
  is cheap (same script, different `--scenario` fixture) and would strengthen
  the generalization, but was not run here to stay within the scope of "the
  cheapest and decisive experiment."
- **The harness's own fidelity gap is now characterized, not fixed.** See
  above.
- **Zone A's marker is unaffected and untested here** — it is unchanged by
  this experiment and already covered by the existing dropped-breakpoint test.

## What was landed

The evidence does not support turning the 3rd breakpoint on by default — it
made this trace 23% more expensive under the very harness used to evaluate
it, and the live-vs-offline disagreement above means even the optimistic
case is not confirmed by this pass. What *is* supported is closing the
"landlocked in eval" defect the prior analysis named: `packages/core` had no
way to emit this marker at all, so nothing outside `eval/src/loop.ts` could
even try it, and the general-purpose §17 harness could not check it (no code
routed through it). Both of those are now fixed, gated behind a new field
that defaults to off:

- **`ZoneAssemblerDeps.cacheZoneCBreakpoint?: boolean`**
  (`packages/core/src/assemble/assembler.ts:81`, default `undefined` = off).
  When `true`, `ZoneAssembler.assemble()` marks the last Zone C block that is
  not the descendant map (`C:map:*`) as a 3rd cache breakpoint
  (`assembler.ts:167-174`), mirroring `eval/src/loop.ts`'s
  `toZoneCCachedRequest` placement exactly.
- **`toMessages` generalized, not special-cased**
  (`assembler.ts:400-447`): a zone's blocks now split into a cached message
  (everything through the last internally-marked block) and an uncached
  remainder, instead of only ever checking the zone's own final block. This
  is what makes the flag a **real** request-shape change — reachable all the
  way to `toCompletionRequest` and a live `cache_control` on the wire — not
  only a simulator-visible flag with no effect on an actual request. Default
  behavior is unchanged and verified byte-identical: Zone B (which has always
  marked its own last block) produces the same single message as before, and
  Zone C with the flag off produces the same single, unmarked message as
  before — both proven by the full existing `assemble.test.ts`/`cache.test.ts`
  suites passing unmodified for every pre-existing test.
- **Four new tests in `packages/core/test/cache.test.ts`**, describe block
  "Zone C 3rd breakpoint — opt-in only": (1) off by default, byte-identical
  request shape; (2) the marker lands on the correct block and survives all
  the way through `toMessages` into a real 3-message split; (3) **the test
  that fails if the marker is dropped**, i.e. the requested regression test —
  it also encodes the finding above: it asserts the growing Zone C run is
  billed as `cacheWrite`, not `cacheRead`, since that is the actual, correct,
  verified behavior of this design under the shipped harness, and a
  regression that turned it into a silent `fresh` charge (dropping the
  marker) is exactly the case Anthropic-side would look like "nothing
  changed" while quietly losing the ability to ever benefit from the pattern
  even in the live-corroborated case above; (4) a companion drop test proving
  the config field genuinely gates behavior rather than being dead code.

No default changed. `git diff --stat`: `packages/core/src/assemble/assembler.ts`
(+64/−10), `packages/core/test/cache.test.ts` (+104/−2, four new tests).

## Tests

`pnpm vitest run packages/core` (full targeted package, since `assembler.ts`
is imported by every eval script per graft's blast-radius check, so a scoped
sub-path would under-cover it): **516 passed, 9 skipped, 0 failed** — the 9
skips are the pre-existing `LIVE=1`-gated opt-in tests
(`packages/core/test/live/*.test.ts`), unrelated to this change and skipped
identically before it. `pnpm vitest run eval/test/loop.test.ts` (the
independent `toZoneCCachedRequest` test file this pass's analysis flagged as
not routed through the §17 harness): **41 passed, 0 failed** — unaffected, as
expected, since that file exercises `eval/src/loop.ts`'s own, separate
implementation, not `packages/core`. `npx tsc --build eval`: clean, no
errors (the new `.mjs` script is not part of the TS project graph, matching
`eval/scripts/marathon.mjs` and `eval/scripts/recall-probe.mjs`, the two
existing precedents for this file type in this directory).

## Answering rule 3

The new field's *value* is a caller decision (on/off), not a magic number —
there is nothing here for rule 3 ("setting a parameter from a model's limits
is fine, guessing is not") to apply to beyond what the prior analysis already
settled: the breakpoint *count* is `min(available stable zone boundaries,
provider's maxBreakpoints)`, already host-derived. This pass adds no new
hardcoded constant; the crossover fraction `f* = (Pinput − Pread) / (Pwrite −
Pread)` is itself a formula over three published, per-model rates, not a
number chosen in advance — evaluating it on a different model's price table
(a different `Pinput`/`Pwrite`/`Pread` triple) would move `f*`, and the
formula, not a re-guessed constant, is what a new host should re-run.

## Next

A third DS-STAR iteration on this dimension should extend
`ProviderCacheSimulator` to model automatic lookback from a single trailing
breakpoint against **every** historically cached position (not only the
immediately previous submission's exact breakpoint set), matching Anthropic's
documented single-trailing-breakpoint caching behavior and the
already-published live measurement this pass could not reconcile with its
own offline number. That is a bigger, separate piece of work (a new matching
algorithm needs its own validation against `cache.test.ts`'s existing
regression suite before anything built on it can be trusted), which is why
it is named here rather than attempted inside this pass's "cheapest and
decisive" scope. Once it exists, this exact experiment (`cache-sweep.mjs`,
unchanged) should be re-run: if the extended simulator now credits Zone C's
moving marker with climbing reads the way the live measurement did, the
recommendation in this report reverses and the config field becomes a
candidate for a default flip — on a second scenario first, per the
"replicate before changing a shipped default" pattern the other three
dimensions in this loop already used.
