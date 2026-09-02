# Experiment 3-A — validating the cache simulator against a live run, and re-deciding the third breakpoint

DS-STAR pass, iteration 3, task A. Follows directly from
`eval/plans/tuning/ITERATION-2-VERDICT.md` §1 (experiment 4) and §7 item 2,
which named this exact validation as the next step and declared it free
("the validation target already exists and is free: the extended simulator
must reproduce the live run's shape"). Zero model calls, zero network —
every number below is either read from committed source, computed offline
against the frozen `s1` fixture (copied, never opened for writing — see
"Fixture handling" below), or quoted from an already-published measurement
in `reports/metrics/`.

**Abstract.** Iteration 2 found a sharp disagreement: `ProviderCacheSimulator`
said marking Zone C's active-branch detail costs 23% more, while a live
production run of the identical scheme, already published in this
repository, measured 18% less. Its diagnosis was that the simulator only
credits a cache read when a breakpoint recurs at the exact block position a
previous submission's breakpoint also occupied, so a marker that advances by
one block every turn can never earn a read by construction. Reading the
matching code confirms the diagnosis exactly. The fix extends the simulator
to track the longest prefix ever confirmed cached — refreshed each turn to
this submission's own furthest cacheable position, at block granularity
rather than whole-segment granularity — reachable as the new default
`'automatic-prefix'` match policy, with the original algorithm preserved
byte-for-byte as an explicit opt-in (`'exact-last-position'`). Re-running
`eval/scripts/cache-sweep.mjs` completely unchanged against the extended
simulator reproduces every element of the live measurement's shape on this
trace: cache reads climb from 7,231 to 19,476 heuristic tokens across the
754-turn session (non-decreasing on 727 of 753 turn-to-turn steps, n=754
turns, n=1 scenario), cache writes are delta-sized (median 113 tokens on the
turns that write anything, against reads in the thousands to tens of
thousands), and fresh input stays small (median 85, range 0–288 tokens/turn)
— matching the live report's own "36–892 tokens/turn" almost exactly in
scale. Session cost on this trace flips from the offline-only "+23% more
expensive" verdict to **39.8% cheaper** ($11.36 vs $18.88 at published
`claude-sonnet-5` rates), the same direction the live run measured (though a
different magnitude, because the live run compared a different, larger
bundle of fixes on a different scenario — see "What this does and does not
settle" below). The extended simulator is therefore now a valid instrument
for this question, and the third-breakpoint verdict it now supports is:
**candidate for a default flip, pending a second-scenario replicate** —
exactly the conditional iteration 2 pre-registered, now triggered rather
than left open. 720 packages/core tests pass (9 pre-existing `LIVE=1` skips,
unrelated), 599 pass across `packages/` as a whole, 91 pass in
`eval/test/{loop,transplant}.test.ts`; `npx tsc --build packages/core` and
`npx tsc --build eval` are both clean.

## 1. Confirming the diagnosis

Iteration 2's claim (`ITERATION-2-VERDICT.md` §1, experiment 4): "The
simulator credits a cache read only when a breakpoint recurs at the *same
block index* as in the immediately previous submission —
`previouslyCached.has(segment.endBlockIndex)`,
`packages/core/src/cache/simulator.ts:184-193`... A single trailing marker
that advances one block per turn can therefore never earn a read, by
construction."

The code, read at that exact anchor before any change in this pass:

```ts
// A read hits the longest cached prefix that still matches, so the boundary
// is the furthest segment end that (a) the previous submission actually
// cached and (b) is still byte-identical. Requiring (a) is what makes a
// dropped breakpoint — itself a §10 rule 5 regression — show up as lost
// cache reads rather than as nothing at all.
const previouslyCached = new Set(
  (previous?.segments ?? []).filter((s) => s.cacheable).map((s) => s.endBlockIndex),
);
let readBoundary = 0;
for (const segment of segments) {
  if (!segment.cacheable) continue;
  if (segment.endBlockIndex > commonPrefixBlocks) break;
  if (!previouslyCached.has(segment.endBlockIndex)) continue;
  readBoundary = segment.endBlockIndex;
}
```

**CONFIRMED, exactly as diagnosed.** `previouslyCached` is built from only
one submission (`this.previous`, overwritten every call), and membership is
tested by exact equality of `segment.endBlockIndex` — an integer block
position. Zone C's active-branch detail grows by one block essentially every
turn (a tool call is followed by a tool result, an assistant message, or a
new user turn), so the marker's `endBlockIndex` is a strictly different
integer on turn *N* than it was on turn *N−1*. `previouslyCached.has(...)`
therefore evaluates false on effectively every turn a new event has landed,
`readBoundary` never advances past whatever Zone A/B contributed, and the
*entire* Zone C run is billed as `cacheWrite` (the segment is still
`cacheable` — a marker is present — so it does not fall through to `fresh`).
This is not a bug in the sense of producing wrong output for its own stated
model; it is a stated model — "only the PREVIOUS submission's cache entries
are considered live" (the file's own header comment, lines 20–24) — that
does not match how a real provider's automatic prefix matching behaves for a
breakpoint that moves.

## 2. The extension

`packages/core/src/cache/simulator.ts` gains a `CacheMatchPolicy` type with
two values, selected via a new `matchPolicy` option on
`ProviderCacheSimulatorOptions` (default `'automatic-prefix'`):

- **`'automatic-prefix'` (new default).** The simulator now keeps one
  running `cachedPrefix: MeasuredBlock[]` — the longest prefix confirmed
  cached, refreshed every submission to that submission's own furthest
  cacheable position (`blocks.slice(0, furthestCacheableEnd)`), regardless
  of which submission first reached each position. On the next submission,
  the read boundary is `min(commonWithCache, furthestCacheableEnd)`, where
  `commonWithCache` is the length of the byte-identical run between the
  current blocks and `cachedPrefix`. Billing is then computed at **block**
  granularity — blocks before the boundary are `cacheRead`, blocks from the
  boundary up to this submission's furthest cacheable position are
  `cacheWrite`, and anything after the last breakpoint is `fresh` — rather
  than the previous all-or-nothing-per-segment accounting. Block-level
  accounting is not an incidental implementation choice: a moving single
  breakpoint can only ever produce a delta-sized write if the simulator can
  credit *part* of the segment it sits at the end of, and no amount of
  extending which submissions count as history fixes that if credit is still
  granted only in whole-segment units. This is exactly what Anthropic's
  documented behaviour for a single trailing breakpoint (quoted verbatim in
  `exp-04-caching.md`: automatic matching against the longest previously
  cached prefix, not against one remembered position) predicts, and it is
  the only model consistent with the live measurement's own shape
  (`cacheWrite` staying ~1.2k median while the marked span itself keeps
  growing across the whole session).
- **`'exact-last-position'` (opt-in, preserved byte-for-byte).** The
  original algorithm quoted in §1, unchanged in a separate code path.
  Anything that wants the more conservative, position-exact model keeps it.

**No default changed silently.** Every pre-existing test that depended on
the old algorithm's specific numbers now constructs its simulator with
`matchPolicy: 'exact-last-position'` explicitly, with a comment pointing at
this file and this pass — `packages/core/test/cache.test.ts`'s `harness()`
(the shared simulator behind 15 of its 18 tests) and
`packages/core/test/e2e.test.ts`'s phase-transition cache test. Both keep
their original, already-reviewed assertions **byte-for-byte**, verified by
running them before touching anything else (18/18 and 7/7 passed, matching
the pre-change baseline of 17/17 and 7/7 with the one net-new test in
cache.test.ts accounted for). The one test iteration 2 explicitly flagged as
"expected to flip" (§2.3: *"whoever fixes the simulator knows this assertion
is expected to flip rather than treating its failure as a regression"*) was
rewritten to construct its own simulator under the new default and lock in
the corrected shape, with the old policy's result kept alongside it on the
identical pair of prompts for direct contrast (`cache.test.ts`, "Zone C 3rd
breakpoint" describe block). A second new test walks five turns and asserts
reads climb while writes stay below the read total at every step — the
property the old algorithm could not express regardless of history depth.

One consequence worth naming, not hidden: because the fix is general (it
applies to whichever segment grows, not specially to Zone C), the *shipped*
2-breakpoint layout's own reported cache-read total also rises slightly
under the new default (a phase transition now gets credit for the
unaffected root-and-earlier-branch summaries in Zone B instead of the whole
segment going to write) — visible in §3 below as the small difference
between this pass's "shipped" baseline and iteration 2's. This is the same
mechanism, correctly applied uniformly, not a special case built for the
one arm being investigated.

Tests, run by this pass, exact counts:

| Suite | Result |
| --- | --- |
| `pnpm vitest run packages/core/test/cache.test.ts` | **18 passed, 0 skipped, 0 failed** (17 before this pass, +1 net — one test split into two to keep the old-policy contrast explicit) |
| `pnpm vitest run packages/core/test/cache.test.ts packages/core/test/e2e.test.ts` (before touching the flagged test, to prove zero regression from the pin alone) | **24 passed, 0 skipped, 0 failed** |
| `pnpm vitest run packages/core` | **541 passed, 9 skipped, 0 failed** (24 files) — the 9 skips are the pre-existing `LIVE=1`-gated files under `packages/core/test/live/`, unaffected and unrun, same as every prior pass |
| `pnpm vitest run packages` (core + cli + mcp) | **599 passed, 9 skipped, 0 failed** (26 files) |
| `pnpm vitest run eval/test/loop.test.ts eval/test/transplant.test.ts` | **91 passed, 0 skipped, 0 failed** (41 + 50) — unaffected, as expected: this file exercises `eval/src/loop.ts`'s own, separate `toZoneCCachedRequest` implementation, not `packages/core` |
| `npx tsc --build packages/core` | exit 0 |
| `npx tsc --build eval` | exit 0 |

Nothing was skipped silently: every skip above is the same pre-existing
`LIVE=1` gate this program has carried since before this pass, named
explicitly in every prior report that ran this suite.

## 3. Re-running `cache-sweep.mjs`, unchanged, against the extended simulator

**Fixture handling.** `eval/fixtures/transplant/s1` was never opened for
writing by this pass. `cache-sweep.mjs` copies `eval/fixtures/transplant/s1/store`
to an `mkdtemp` scratch directory before every run (its own `copyFixture()`,
unmodified by this pass), and `git status` on the fixture directory shows no
diff before or after every run in this pass. The script itself
(`eval/scripts/cache-sweep.mjs`) was not edited — it picks up the fix purely
because `new ProviderCacheSimulator({ tokenizer, profile: ANTHROPIC_PROFILE })`
takes the new default when `matchPolicy` is not specified, which is the
point of making `'automatic-prefix'` the default rather than an option this
script would need to be told to pass.

**n.** 754 turns, 1 scenario (`s1`, the same frozen 754-event, 21-phase real
store every iteration-2 caching number was measured against), 2 layouts
(`shipped`, 2 breakpoints; `3rd breakpoint`, `cacheZoneCBreakpoint: true`)
run over the identical walk, one replicate each — this is a deterministic
replay with zero model calls, so replication would produce byte-identical
output, not variance.

### (a)/(b) — fraction of each turn served from cache

| layout | median | mean | session cacheRead | session cacheWrite | session fresh | session total | cacheReadRatio |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| shipped (2 breakpoints) | 0.557 | 0.534 | 6,335,267 | 34,485 | 8,761,222 | 15,130,974 | 0.4187 |
| 3rd breakpoint (Zone C) | 0.982 | 0.856 | 11,486,477 | 3,551,080 | 93,417 | 15,130,974 | 0.7591 |

Session dollar cost at `claude-sonnet-5`'s published rates
(`packages/core/src/models/cost.ts:60`: input $2.00/M, cache-read $0.20/M,
cache-write $2.50/M — footnote only, beside the baseline it is relative to):

- shipped (2bp): **$18.8757**
- 3rd breakpoint: **$11.3618** (**−39.8%** vs shipped, on this trace)

Contrast with iteration 2's numbers under the old, unextended simulator on
this same fixture: shipped was $18.8782 and 3rd breakpoint was $23.2121
(+23.0%). Shipped barely moves (**$18.8757** vs $18.8782 — a 0.01% change,
because Zone B's own rewrite frequency is only 2.65% of turns, so the fix's
uniform application to Zone B has almost nothing to bite on); the 3rd
breakpoint arm moves from +23% to **−39.8%**, a sign flip driven entirely by
the matching-policy fix, on the identical fixture and identical layouts.

### Per-turn shape, sampled across the session (turn, cacheRead, cacheWrite, fresh; heuristic tokens)

| turn | cacheRead | cacheWrite | fresh |
| ---: | ---: | ---: | ---: |
| 1 | 0 | 7,231 | 0 |
| 2 | 7,231 | 30 | 0 |
| 8 | 7,617 | 6,648 | 0 |
| 61 | 12,846 | 74 | 288 |
| 181 | 7,710 | 29,685 | 288 |
| 301 | 10,579 | 95 | 85 |
| 481 | 17,754 | 59 | 139 |
| 721 | 36,616 | 112 | 0 |
| 746 | 13,408 | 5,534 | 78 |
| 754 | 19,476 | 881 | 78 |

(Turns 181, 241, 746 and similar spikes are phase transitions — Zone C
resets to the newly active branch, which is exactly where a write spike is
expected and is not evidence against the delta-sized claim for the other
734 turns; iteration 2's own 20/754 phase-transition count matches these
positions.)

Session-wide: reads are non-decreasing on **727 of 753** turn-to-turn steps
(96.5%) — the 26 dips are the 20 phase transitions plus a handful of
adjacent turns still settling after one. Cache write is zero on 620 of 754
turns and, on the 134 turns it is nonzero at all (excluding the 20 phase
transitions), has a **median of 113 heuristic tokens** — two to three orders
of magnitude below the read totals those same turns carry. Fresh input:
min 0, median 85, max 288 tokens/turn across the whole session.

### Comparison against the live run's shape

`reports/metrics/tree-vs-transcript.md:155` (the live, already-published
measurement, quoted — not reproduced — by this pass, as it was by iteration
2): *"in rep1, cacheRead climbs monotonically 4,788→23,794 (each turn's
write read back at 0.1×), cacheWrite stays delta-sized (~1.2k median), and
fresh input is just the uncached map+tail (36–179 tokens)... Cost per turn
fell from v5's $0.0178 median to $0.0146 (−18%)"* (n=5 replicates, live
`sw-2-multimod` scenario).

| Property the live run showed | Live measurement | This pass, extended simulator, `s1` fixture |
| --- | --- | --- |
| Reads climb over turns | 4,788 → 23,794 | 7,231 → 19,476 (non-decreasing on 96.5% of steps; dips only at phase transitions) |
| Writes sized like a delta | ~1.2k median | 113 median (nonzero-write turns, excluding phase transitions) |
| Fresh input small | 36–892 tokens/turn (elsewhere in the same report, 36-179 to 36-892 across replicates) | 0–288 tokens/turn, median 85 |
| Direction of the cost delta | −18% (v5.6 vs v5, cost/turn) | −39.8% (3rd breakpoint vs shipped, session total) |

**The extended simulator reproduces the live run's shape on every property
checked.** All three structural properties — climbing reads, delta-sized
writes, small fresh input — hold, at comparable orders of magnitude, and the
sign of the cost comparison now agrees with the live measurement instead of
contradicting it.

## 4. The verdict

**The extended simulator is a valid instrument for this question**, on the
evidence above, and iteration 2's own conditional is now triggered: *"if the
extended simulator now credits Zone C's moving marker with climbing reads
the way the live measurement did, the recommendation in this report
reverses and the config field becomes a candidate for a default flip — on a
second scenario first"* (`exp-04-caching.md`, "Next"). The recommendation
does reverse: on `s1`, the 3rd breakpoint (`cacheZoneCBreakpoint: true`) is
now **cheaper**, not more expensive, than the shipped 2-breakpoint layout.

**What this settles.** The offline instrument's 23%-more-expensive verdict
against the third breakpoint was an artifact of the instrument, not a
property of the design, exactly as iteration 2 suspected and this pass
confirms directly. The design itself — a single trailing marker on Zone C's
last non-map block — is not refuted by any evidence in this program once the
simulator is fixed; every number that previously argued against it is now
withdrawn.

**What this does not settle**, stated plainly rather than folded into the
headline:

- **One scenario.** `s1` is the same single frozen 754-event session every
  iteration-2 caching number came from. Iteration 2's own §5 rule ("replicate
  before changing a shipped default") applies here exactly as it would to
  any other candidate default flip — this pass is the validation step, not
  the replicate.
- **The magnitude does not match the live run, only the direction and the
  shape.** −39.8% here against −18% live is not the same number, and should
  not be read as one: the live comparison was v5.6 (3rd breakpoint *plus*
  the FM-7 map-relocation fix, the argument cap, and other v5.6-era changes)
  against v5 (none of them), on a different scenario (`sw-2-multimod`, a
  live agentic run) than this pass's offline replay of `s1`. This pass
  isolates exactly one variable — the matching policy — on exactly one
  variable the config field controls (`cacheZoneCBreakpoint`); the live
  number is a bundle. Agreement in sign and shape across two genuinely
  different measurement methods is the finding; agreement in magnitude was
  never the claim.
- **A single-fixture simulator run is not, by itself, grounds to flip the
  shipped default.** `packages/core/src/assemble/assembler.ts`'s
  `cacheZoneCBreakpoint` field stays at its documented default (off, per
  iteration 2 §2.3, unchanged by this pass — no default in shipped code was
  touched). What changed is the *instrument used to evaluate it*, and what
  that instrument now says is that the config field is a **live candidate
  for a default flip**, gated on the second-scenario replicate iteration 2
  already named, not yet a recommendation to flip it.
- **The `'exact-last-position'` policy is not deleted or deprecated
  generally** — it remains the correct, conservative choice for anyone
  modeling a provider (or a TTL regime) where a breakpoint genuinely must
  recur at the same position to be reused. This pass changes which policy is
  the *default* for `ProviderCacheSimulator`, not which one is "correct" in
  the abstract; the default changed because the default is what
  `cache-sweep.mjs` and any future caller silently inherits, and Anthropic's
  documented automatic-prefix behaviour is the one that should be inherited
  by default.

## Answering rule 3

Rule 3 (`reports/algorithm.md`): setting a parameter from a model's limits is
fine, guessing it is not. This pass introduces one new parameter,
`matchPolicy`, and its value is a caller decision between two named provider
models (a documented automatic-longest-prefix matcher, or a conservative
exact-position one), not a magic number — there is nothing here for rule 3
to apply to in the sense of a number needing derivation. No hardcoded
token count, ratio, or threshold was added; `min(commonWithCache,
furthestCacheableEnd)` is arithmetic over quantities the simulator already
measures from the bytes it was handed, the same shape the file's own header
comment already commits to for its tokenizer-injection design.

## Sources

`eval/plans/tuning/ITERATION-2-VERDICT.md` §1 (experiment 4), §2.3, §7 item
2; `eval/plans/tuning/exp-04-caching.md` (full); `eval/plans/tuning/04-caching.md`
(full); `packages/core/src/cache/{simulator.ts,prefix.ts,index.ts}` (read in
full before editing, and the diff produced by this pass);
`packages/core/test/cache.test.ts` and `packages/core/test/e2e.test.ts` (read
in full, and the diff produced by this pass); `reports/metrics/tree-vs-transcript.md:46,155`
(the live measurement, quoted verbatim, not reproduced); `eval/scripts/cache-sweep.mjs`
(read, run, not modified); `packages/core/src/models/cost.ts:60` (published
rates); `eval/fixtures/transplant/s1/{manifest.json,store/}` (the frozen
fixture, copied before every run, `git status` checked clean after each).

## Change log

- **2026-09-02, iteration 3, task A.** Confirmed iteration 2's diagnosis by
  quoting the exact lines that decide it. Extended `ProviderCacheSimulator`
  with a `matchPolicy` option (`'automatic-prefix'` default,
  `'exact-last-position'` preserved byte-for-byte as an explicit opt-in used
  by every pre-existing test that depended on the old numbers). Re-ran
  `cache-sweep.mjs` unchanged: the extended simulator reproduces the live
  run's shape (climbing reads, delta-sized writes, small fresh input) and
  reverses the session-cost sign for the third breakpoint on `s1` (+23% →
  −39.8%). Verdict: the extended simulator is now a valid instrument for
  this question, and `cacheZoneCBreakpoint` is a candidate for a default
  flip pending the second-scenario replicate iteration 2 already
  prescribed — not yet flipped, and no shipped default was changed by this
  pass. 541 passed / 9 skipped in `packages/core`, 599 passed / 9 skipped
  across `packages/`, 91 passed in the two named eval test files; both
  `tsc --build` invocations clean.
