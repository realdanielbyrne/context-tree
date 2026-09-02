# Experiment 3 — switch-fraction × cadence sweep, and the one-turn lag fix

DS-STAR tuning pass, iteration 2 (experiment) · dimension 3 of 4 in
`reports/algorithm.md` · scoped by `eval/plans/tuning/03-summary-policy.md`
§3(d) · zero live model calls, zero network, everything below is either a
pure local computation over a synthetic corpus or a computation over
`usage` fields already recorded in `eval/results/long-v65-gate/*/results.json`.

Script: `eval/scripts/switch-fraction-sweep.mjs` — a sibling to
`eval/scripts/marathon.mjs`, not an edit to it (rationale in the script's own
header, restated in §1 below). Run with `node eval/scripts/switch-fraction-sweep.mjs`.

## Abstract

Part 1 sweeps the switch fraction — {0.15, 0.20, 0.25, 0.30, 0.35} of a
200,000-token window, plus a no-switch baseline — over a 300-branch
deterministic corpus built the same way `marathon.mjs` builds one, extending
it with the one parameter the source analysis named: where a candidate
switch fraction's crossing point falls, stitched from two curves the harness
already computes (raw-trace size, and the real assembler's post-switch
size). **0.20 beats 0.35 on total tokens by 53%** (4,271,440 vs 9,150,408,
summed over 300 branch-checkpoints), and the measured minimum among the
five tested fractions is 0.15, not 0.20 — the curve is monotonic decreasing
in fraction over the whole tested range, with no interior sweet spot. That
is a partial refutation of "0.20 is where the sweet spot is": 0.20 is where
the algorithm's own definition places the switch (§3(a) of the prior
analysis), but on pure token count it is dominated by every smaller fraction
tested, and the data point furthest below the tested grid — where the
raw-trace and post-switch curves actually cross, at branch 9 (≈0.015 of the
window on this corpus) — is smaller still. Section 3 states plainly what
this does and does not license concluding.

Part 2 replays the six real crossings from `reports/metrics/context-growth.md`
directly off `eval/results/long-v65-gate/*/results.json` and confirms the
prior pass's median-8,306-token overshoot figure exactly (8,305.5, n=6), then
quantifies the proposed same-turn fix: **median overshoot falls from 8,306
to 0** across the same six crossings, with a worst case of 916 tokens (down
from a worst case of 15,564 today). The extra local tokenizer pass this
costs is measured directly: 2.6–4.0 ms per pass on prompts the size of the
recorded crossings (120,000–180,000 characters), against turn latencies in
the seconds in the same result files — the model call, not this pass,
dominates wall-clock by roughly three orders of magnitude.

## 1. Method, and why a sibling script

`eval/scripts/marathon.mjs` verifies a specific, already-shipped invariant
(D17/D18: the tree prompt stays flat across 160–200 branches) with fixed
assertions and a docstring that states that claim. It always assembles in
post-switch/summarized mode from branch 1 onward — the script has no
representation of the pre-switch "whole trace" mode at all, because
verifying flatness never needed one. Bolting a switch-fraction and a cadence
parameter onto it would risk changing what its existing assertions actually
check. `eval/scripts/switch-fraction-sweep.mjs` duplicates marathon's
deterministic generator (`addCycle`, copied verbatim — eight fields of trace
fixture, not logic worth sharing through an import) and drives the same real
core pipeline (`JsonlTraceLog`, `FsBlobStore`, `SqliteTreeStore` via
`openInMemoryStore`, `ZoneAssembler`, `composeRootSummary`), so both scripts
measure the same corpus shape and marathon.mjs's own contract is untouched.

At every branch `i` from 1 to 300, the script computes two numbers with no
model call:

- `nativeTokens(i)`: tokens in the full raw transcript through branch `i`.
  This is exactly the production gate's devolved/pre-switch candidate:
  `belowLazyK` sets `zoneCBudget = Infinity` and `activeNodeId = root`
  (`eval/src/loop.ts:1003-1012`), i.e. "show the whole trace."
- `treeTotal(i)`: the real `ZoneAssembler`'s post-switch prompt size — D17
  root fold in Zone B, bounded active-branch detail in Zone C, at
  `DEFAULT_CONFIG`'s budgets (zoneB 8,000, zoneC 30,000). This is the same
  quantity `marathon.mjs` already reports as `treeTotal`, computed here at
  every branch instead of every tenth one, for crossing-point precision.

A candidate switch fraction `f` defines `switchTokens = floor(f × W)`. The
crossing branch is the first `i` with `nativeTokens(i) ≥ switchTokens` — a
one-way latch, matching `lazyCrossed` in the real loop. The stitched curve
for that fraction is `nativeTokens(i)` before the crossing and `treeTotal(i)`
from the crossing onward. This is "re-sequenced arithmetically over data
already in hand," exactly as the source analysis proposed — no new curve is
computed per fraction, only a different splice point on two curves computed
once.

**W and units.** W = 200,000 (Sonnet's advertised window), because that is
the model the six real crossings in §2 and in `context-growth.md` were
measured on. There is no live billing tokenizer in this synthetic harness to
convert token spaces — the measured heuristic-to-tokenizer ratio (0.851) was
fit on the transplant corpus, not this one, and reusing it here unmeasured
would be exactly the defect rule 2 of `reports/algorithm.md` names. So
`switchTokens` is computed directly against `HeuristicTokenizer` counts
(ratio = 1, this harness's own units throughout). **This keeps the relative
ranking among the five fractions valid** — every threshold scales by the
same unstated ratio, so it cancels out of the comparison — **but the
absolute branch numbers below are not a claim about where a real run against
real billed tokens would cross**; that needs this corpus's own measured
ratio, which was not taken (no model call was permitted for this pass).

**Cadence** (batch-at-crossing vs. incremental-at-close) does not change
either curve above: once the switch has fired, Zone B holds the same set of
branch summaries either way, whether they were built in one lump at the
crossing or one at a time as each branch closed. What cadence changes is
*when* the summarizer is asked to do work — tracked here as a build-count
schedule, not a token count, because this harness inserts summaries directly
with no LLM call and so has no per-call cost to attribute.

## 2. Part 1 — switch fraction × cadence sweep

n = 1 deterministic corpus (300 branches, 8 events each — same generator as
`marathon.mjs`); every number below is exact, not sampled, because the
harness has no randomness.

| fraction | switchTokens | crossing branch | peak (tok) | final (tok) | total tokens, summed over 300 checkpoints | batch-at-crossing lump | incremental total builds |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| no-switch | — | never | 85,334 | 85,334 | 12,862,800 | 0 | 299 |
| 0.15 | 30,000 | 106 | 29,954 | 9,060 | 3,361,230 | 105 | 299 |
| 0.20 | 40,000 | 141 | 39,894 | 9,060 | 4,271,440 | 140 | 299 |
| 0.25 | 50,000 | 176 | 49,834 | 9,060 | 5,529,550 | 175 | 299 |
| 0.30 | 60,000 | 211 | 59,774 | 9,060 | 7,135,560 | 210 | 299 |
| 0.35 (current) | 70,000 | 247 | 69,998 | 9,060 | 9,150,408 | 246 | 299 |

Every fraction eventually crosses within the 300-branch run (the corpus
grows raw tokens by a roughly constant amount per branch, so nothing here is
an artifact of the run being too short to exercise the larger fractions).
Once crossed, the post-switch size is identical across all five fractions
(9,060 tokens, flat) — the switch fraction only controls *when* the
transition happens, not what it transitions to, because Zone B/C budgets are
fixed regardless of the switch point.

**Does 0.20 beat 0.35 on total tokens at equal coverage?** Yes: 4,271,440
vs. 9,150,408 over the identical 300-branch task — a 53% reduction. **Where
is the minimum?** Among the tested grid, at 0.15, the smallest fraction
tested — the curve is monotonic decreasing across the whole tested range, so
this experiment does not locate an interior sweet spot; it only shows that,
within {0.15…0.35}, smaller wins on tokens. The un-truncated minimum is
further out still: the branch at which `treeTotal` first drops below
`nativeTokens` — the point where switching starts being unambiguously
cheaper in both directions rather than merely "cheaper than an arbitrary
threshold" — is **branch 9** on this corpus, corresponding to a fraction of
about 0.015 of the 200k window. That is an order of magnitude below the
smallest fraction this pass was asked to test.

**What this does and does not license concluding.** The measured claim is
narrow and corpus-specific: on this deterministic, linearly-growing
synthetic trace, "switch fraction of W" is not the token-minimizing
formulation at all — the token-minimizing rule visible in this data is
"switch as soon as the tree's own rendering becomes cheaper than showing the
raw trace" (compare the two candidate sizes directly, switch to whichever is
smaller), not "switch once the raw trace exceeds a fixed fraction of W."
This is not a claim that 0.20 is wrong as *the switch's semantic
definition* — `03-summary-policy.md` §3(a) settles that question on the
rule's own wording (switch = the size at which the whole trace fits where
Zone C's detail would go), independent of which value minimizes tokens on
any one corpus. It is a claim that if tokens are the only thing being
optimized, this pass's own data does not support the fraction-of-W
*form* being the tightest available rule, and a fixed-fraction policy will
always be able to be beaten by a rule that compares the two live
candidates directly. Real traces are not linear-growth-then-flat like this
synthetic one (dimension 2's report measured a 77-fold size spread across
21 branches on a real store), so the branch-9 crossover point itself is a
property of this corpus's shape, not a number to port — the general
statement that transfers is the *form* of the rule, not the number 9 or
0.015.

**Cadence.** The batch-at-crossing lump grows with the fraction (105
branches' worth of catch-up at 0.15, 246 at 0.35) — a directly measured
version of the "single lump… concentrated in the single turn" cost the
source analysis described, and confirmation that a smaller switch fraction
also shrinks that lump, not just the token total. Incremental-at-close
eliminates the lump entirely (0 at every crossing, by construction — nothing
is ever backlogged) but **at a real, measured cost the source analysis's
§3(c) proposal did not price**: it pays one summarize-on-close call per
branch *unconditionally*, including on the no-switch baseline, where
batch-at-crossing pays zero. The no-switch row above makes this exact:
incremental cadence spends 299 summarizer calls on a task that structurally
never needed a single one, while today's actual code (batch-at-crossing)
spends zero — matching the measured 0% summarizer-cost share the prior
report found on the five non-crossing `sw-3-refactor` runs. **This is the
tradeoff the source analysis's proposal did not state**: incremental cadence
buys "no lump" by giving up "free on tasks that never cross," and which of
those two properties matters more depends on what fraction of real tasks
ever cross at all — a question this pass's corpus cannot answer, since it is
built to cross by construction.

## 3. Part 2 — the one-turn lag, replayed and quantified

Recomputed directly from `eval/turns[].usage` in the six result files under
`eval/results/long-v65-gate/`, not copied from the prior report — the script
re-derives the crossing turn and overshoot independently and the numbers
match exactly, which is itself a cross-check that the prior pass's table was
read correctly.

| run | scenario | crossing turn | size actually sent (today) | overshoot today | next-turn size (fix proxy) | overshoot under the fix |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| long-v65-gate-rep1 | sw-5-dozen | 9 | 45,564 | +15,564 | 30,916 | 916 |
| long-v65-gate-rep1 | sw-6-ripple | 13 | 41,286 | +11,286 | 20,716 | 0 |
| long-v65-gate-rep2 | sw-5-dozen | 6 | 36,657 | +6,657 | 22,151 | 0 |
| long-v65-gate-rep2 | sw-6-ripple | 15 | 30,126 | +126 | 9,310 | 0 |
| long-v65-gate-rep3 | sw-5-dozen | 9 | 38,799 | +8,799 | 22,016 | 0 |
| long-v65-gate-rep3 | sw-6-ripple | 10 | 37,812 | +7,812 | 21,680 | 0 |

n = 6. Median overshoot today: **8,305.5 tokens** (reported elsewhere,
rounded, as 8,306 — same six numbers). Median overshoot under the fix:
**0 tokens**. Worst case under the fix: 916 tokens (rep1/sw-5-dozen), vs.
15,564 today on the same run.

**Why "next-turn size" is a valid stand-in, and what it does not prove.**
The gate today decides devolved-vs-summarized for turn T using
`lastPromptTokens` set at the *end* of turn T−1 (`eval/src/loop.ts:1035`,
`:829`). Because the run stayed in devolved mode right through the crossing
turn, the size actually billed *at* the crossing turn already is the number
a same-turn check would have computed before sending — there is nothing
hypothetical about the "today" column above, it is what was sent. The
open question is only what a *bounded* prompt would have cost that same
turn instead, once the fix redirects it to summarized mode before
dispatch — and the closest number on disk for that is the size the real run
actually billed one turn later, once summarized mode had already taken
over (these are real production runs; their raw L0 trace was not archived
on disk, only per-turn `usage`, so an exact same-turn replay of the bounded
prompt is not possible without re-running the harness, which is out of
scope for a zero-model-call pass). The proxy overstates the fixed system's
size somewhat, because one extra turn's trace growth had already accrued
between the true crossing turn and the turn used as the stand-in — which
means the true fixed-system overshoot is likely *at or below* the numbers
in the table above, not above them. Five of six proxy values already show
zero overshoot (the fixed prompt would land under the 30,000 threshold);
the one exception (916 tokens over) is a worst case computed on data biased
slightly upward by that same one-turn lag in the proxy itself.

**Cost of the fix.** The same-turn check is one additional local tokenizer
pass over the candidate prompt, using the same `HeuristicTokenizer` the
assembler already runs — not a network call, not a model call. Measured
directly (`switch-fraction-sweep.mjs` §2b, `process.hrtime.bigint()`, mean
of 50 reps):

| prompt size | mean wall-clock per pass |
| ---: | ---: |
| 120,000 chars (~54k heuristic tokens) | 2.6 ms |
| 180,000 chars (~81k heuristic tokens) | 4.0 ms |

The same six result files' own `turns[].latencyMs` put turn latency in the
thousands of milliseconds (p50/p95 columns already recorded there). A single
extra local tokenizer pass costs on the order of 0.1–0.3% of one turn's
wall-clock, i.e. it is not a measurable addition against the model call it
would sit next to.

## Tests

No file under `packages/core` or `eval/src` was modified — only a new,
standalone offline script was added
(`eval/scripts/switch-fraction-sweep.mjs`), so there is no vitest suite
scoped to this change. `npx tsc --build eval` passes with zero errors (the
new script is a plain `.mjs` file, outside `eval/tsconfig.json`'s
`include: ["src/**/*.ts"]`, matching `marathon.mjs` and `gate-ledger.mjs`'s
existing status — none of the three are type-checked, and this pass did not
change that). The script itself was run end-to-end (`node
eval/scripts/switch-fraction-sweep.mjs`, exit 0) and its Part 2 table was
independently cross-checked against a from-scratch Python recomputation
over the same six `results.json` files before being wired into the script;
both computations agree to the token.

## Open items

- The switch-fraction sweep is n=1 on a single synthetic, linear-growth
  corpus. Dimension 2's report already measured a 77-fold branch-size spread
  on a real store — this pass's specific crossover branch (9) and fraction
  (≈0.015) are properties of this corpus's shape and should not be treated
  as a number to ship; only the *form* of the finding (fixed-fraction is
  dominated by direct-comparison switching, on this data) is the claim.
- No run — live or offline — has measured the *incremental-at-close* cadence
  against a task that never crosses on real (not synthetic) data, so the
  "299 unconditional calls on a no-switch task" finding is exact for this
  corpus's branch count and cadence definition but has not been checked
  against how often real tasks actually never cross.
- The lag-fix quantification's "next-turn size" proxy is explicitly not an
  exact replay (§3) — an exact number would need the same-turn check
  implemented in `eval/src/loop.ts` and re-run against a live model, which
  is out of scope for a zero-spend pass.
