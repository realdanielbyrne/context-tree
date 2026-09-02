# DS-STAR iteration 2 — judge's verdict

Scope: the four experiment reports `exp-01-branch-count.md`, `exp-02-branch-depth.md`,
`exp-03-summary-policy.md`, `exp-04-caching.md`, read against the four
iteration-1 analyses in the same directory and against the artifacts each cites.
Every experiment script was re-run by this pass, and the cited fixtures, source
lines and result files were re-read at the anchors given rather than taken from
the reports' own tables. Zero model calls were made.

**Terms used once and then assumed.** A **rung** is one entry on the fold ladder
`ROOT_KEEP_LADDER = [40,16,12,8,6,4,2]`; the rung sets `rootKeep`, how many recent
branches get an individual headline in the root index. A **body** is a branch
whose full summary text renders as its own Zone B block (`branchesSurviving`).
The **share** is the fraction of the window a zone is allotted (Zone B = 0.20).
**W** is the model's context window. **Exact tokens** means the cl100k BPE count;
**heuristic tokens** means `HeuristicTokenizer`'s estimate.

## What this pass reproduced, and one thing it could not

All four scripts run as documented and print their tables. Three reproduce to the
token. The fourth does not, and the reason is a defect in the fixture's freeze
line rather than in the experiment:

| Script | Reproduces? |
| --- | --- |
| `eval/scripts/ladder-curve.mjs` | yes, every cell of both tables, identical |
| `eval/scripts/resegment.mjs` | yes, all six tables, identical |
| `eval/scripts/switch-fraction-sweep.mjs` | yes; part 2 also independently recomputed from the six `results.json` files by this pass, matching to the token |
| `eval/scripts/cache-sweep.mjs` | **no** — see below |

`cache-sweep.mjs` today reports session `cacheRead` 6,209,893 and $19.1641 vs
$23.4980, where `exp-04-caching.md` reports 5,079,261 and $18.8782 vs $23.2121.
The cause is measured: `eval/fixtures/transplant/s1/store/` is **gitignored**
(`.gitignore:87`), so `git status` on the fixture proves nothing about `tree.db`,
and the manifest pins `trace.jsonl` (sha `64293edf…321fe878`, still matching) but
not the database. `composeRootSummary` appends root-summary versions (D3) and six
were appended to the frozen store at 2026-09-02T17:00:55Z — one minute after
`exp-04-caching.md` was written. The assembler reads the *latest* root version, and
that version's text grew from 407 to 1,677 heuristic tokens (1,318 → 5,466 chars),
which lands inside Zone B and therefore inside the cached prefix on all 754 turns.
Predicted session delta 1,270 × 754 ≈ 958k tokens; observed 1,154,537, of which
1,130,632 is `cacheRead` — the right size in the right place.

None of the four iteration-2 scripts caused this: verified by sha256 on `tree.db`
before and after running each one. The write came from elsewhere. Two consequences
that belong to the algorithm document, not to any one experiment:

- **The frozen fixture is only frozen for L0 and L2.** L1's `tree.db` is mutable,
  unhashed and untracked, and its latest root version silently changes the baseline
  of every assembler-driven measurement. Every published Zone B number in this
  program is dated by a root version nobody records.
- One deleted file sits uncommitted inside the fixture directory
  (`results/smoke-W16384-tree-z-ai_glm-flash-latest.json`, last committed in
  `f88d827`). No iteration-2 script deletes fixture files. Restore it or commit the
  deletion deliberately.

Tests, run by this pass, exact counts: `pnpm vitest run packages/core` — **516
passed, 9 skipped, 0 failed** at the point the four experiments were judged (the 9
are the pre-existing `LIVE=1`-gated files under `packages/core/test/live/`, skipped
identically before this iteration). `pnpm vitest run eval/test/loop.test.ts
eval/test/transplant.test.ts` — **91 passed, 0 skipped, 0 failed** (41 + 50).
`npx tsc --build eval` — exit 0.

**A fifth workstream landed while this verdict was being written**, and the counts
above moved with it: a re-run at 12:19 gives **539 passed, 9 skipped, 0 failed**
across 24 files. The new work is `packages/core/src/assemble/budgets.ts` plus
`budgets.test.ts`, with edits to `assemble/index.ts`, `contracts/assemble.ts` and
`assemble.test.ts` — a window-derivation module that replaces the two absolute
budgets with `ZONE_FRACTIONS` of a host-supplied window, divided by the measured
tokenizer ratio, and that records the fractions in one frozen object explicitly
labelled unvalidated. It is not one of the four experiments judged here and it is
not assessed below, but it touches the code every §6 edit points at, and it is
consistent with §4's rejection of any fraction drawn from experiment 3's sweep:
it makes the fractions one derived thing rather than several guesses, and leaves
which fraction wins open. Reconcile §6.8, §6.11 and §6.13 against it before
applying them.

## 1. What each experiment established

**Experiment 1 (a) — the ladder allocation curve: supported, and it collapses the
proposal into an existing arm.** Deciding number: at W=32,768 the rung that
maximises bodies subject to the fit predicate is keep=2 with **11** bodies, and the
shipped `tree` arm lands on keep=16 with **2**. The five interior rungs this pass
adds (keep 12/8/6/4 → 5/6/8/10 bodies) show `branchesSurviving` is monotone
non-increasing in the rung at every window, so the argmax is always the ladder's
smallest rung — which is exactly where `tree-wide` already stops. "Walk toward
maximising rendered bodies subject to the same fits predicate" is therefore not a
new mechanism; on this store it is bit-identical to reversing the ladder, i.e. to
the `tree-wide` arm that already exists and already has data. Two of the report's
three headline cells were already recorded in the frozen `gates.json`: g8's
`survivors` block carries `32768/tree → 2` and `32768/tree-wide → 11`, g9's
`nesting` array carries `tree@65536 → 19` against `tree-wide@65536 → 21`, and g9's
own detail string already names the 8,192 dead cell verbatim ("DEAD, no Zone B
renders: tree@W=8192 … no keep leaves a branch"). The genuinely new content is the
interior rungs and the resulting monotonicity.

**Experiment 1 (b) — demand-driven on retrieval confidence: refuted, on an outcome
with almost no variance to explain.** The report's deciding statistic is Pearson
r = 0.062 (n=120 searched rows). The number that actually decides it is the one
underneath: **4 successes in 120 searched rows** (3.3%) — all four on one question,
`s1-q02-head` — while the best-possible-rank question `s1-q07-deep` scores 0.000
across all 6 of its searched attempts. A policy keyed on rank has no headroom
because 116 of 120 rows fail at every rank from 1 to 17. Reported as a correlation
this is weak evidence (a Pearson r against a near-constant y is not a test of
anything); reported as a floor it is decisive. Either way the conclusion stands:
do not build rank-triggered widening.

**Experiment 2 — re-segmentation: iteration 1's strong claims refuted, its narrow
claim confirmed.** Deciding number: **34,664 exact tokens**, the branch that still
exceeds W=32,768 under `neutralPhases: []`. Iteration 1's own table said
"branches > W=32768: current=1, `neutralPhases:[]`=0"; exact tokenisation gives
**2 and 1**. Iteration 1 also said "every question then sources from a branch that
fits every tested window"; that holds only at W=32,768 — at W=16,384, 7 of 12
questions miss under the current segmentation and **2 of 12 still miss** under the
candidate. The chars÷4×0.851 estimator that produced the wrong table undercounts
the branch at seq 267–276 by **67%** (21,396 estimated against 35,657 exact). Cost:
4.71× the leaf-summarizer calls, **2.33×** the dollars, and the entire delta is the
78 extra calls' fixed per-call overhead (724-token system prompt + 1,024-token
output cap) with branch content held constant — the two configurations summarise
219,007 and 218,997 content tokens, two partitions of the same L0.

The report's new root cause is verified independently by this pass: **6 of 754
events carry both an `args_blob` and a `blob`, and all 6 duplicate their content
byte-for-byte** (70,227 duplicated characters trace-wide). At seq 267 the args copy
is 17,519 exact tokens and the raw copy 16,699.

**Experiment 3 part 1 — the switch-fraction sweep: refuted as a sweet-spot
search, and the refutation is structural.** Deciding number: the post-switch prompt
is **9,060 tokens at every one of the five fractions**. Total tokens are therefore
`Σ native(i) up to the crossing + 9,060 × (300 − crossing + 1)`, and since
`native(i) > 9,060` for every branch past about 31 on this corpus, an earlier
crossing is arithmetically always cheaper. The monotone decrease from 9,150,408
(0.35) to 3,361,230 (0.15) is a property of the generator, not a discovered
optimum, which is why the extrapolated minimum lands at branch 9 (f ≈ 0.015). The
report says this plainly and does not propose a fraction. What survives is a claim
about the *form* of the rule: a fixed fraction of W will always be beaten on tokens
by "switch when the tree's own rendering is smaller than the raw trace", because
that rule compares the two live candidates instead of one candidate against a
threshold. What the sweep cannot do — and this is the reason it is inconclusive
rather than supportive — is express the tradeoff at all: it measures tokens and has
no representation of turns or score, and it is turns and score that an early
switch is suspected of costing.

**Experiment 3 part 2 — the one-turn lag: supported, and independently
reproduced.** This pass recomputed the six crossings straight out of
`eval/results/long-v65-gate/*/results.json` without using the script, and got the
same six pairs. Deciding numbers: median overshoot **8,305.5 → 0** tokens, worst
case **15,564 → 916**, n=6, and 5 of the 6 crossings would have landed under the
threshold. The fix's cost is one local `HeuristicTokenizer` pass, measured at
2.7 ms on a 120,000-character prompt and 4.0 ms on 180,000, against turn latencies
recorded in the seconds. The "next-turn size" stand-in is a proxy and the report
labels it one; its bias is upward (one extra turn of trace growth is baked in), so
the true post-fix overshoot is at or below the table.

**Experiment 4 — the third breakpoint: refuted, but the refutation lands on the
instrument, not on the design.** The simulator credits a cache read only when a
breakpoint recurs at the *same block index* as in the immediately previous
submission — `previouslyCached.has(segment.endBlockIndex)`,
`packages/core/src/cache/simulator.ts:184-193`, read at the anchor. A single
trailing marker that advances one block per turn can therefore never earn a read,
by construction, and the "Zone C rewrites on 754/754 turns = 100%" figure is that
construction restated rather than a fact about the trace. The already-published
live run of the identical scheme says the opposite, and this pass read it verbatim:
`reports/metrics/tree-vs-transcript.md:155` — "in rep1, cacheRead climbs
monotonically 4,788→23,794 (each turn's write read back at 0.1×), cacheWrite stays
delta-sized (~1.2k median), and fresh input is just the uncached map+tail (36–179
tokens)… Cost per turn fell from v5's $0.0178 median to **$0.0146 (−18%)**", n=5.
Deciding number: **−18% cost per turn live against +23% simulated**, on the same
design. The live measurement is ground truth and it is already paid for.

Two things from experiment 4 do survive, and both are rule-3 clean because they are
formulas over published rates rather than chosen numbers. The crossover
`f* = (Pinput − Pread) / (Pwrite − Pread)` = **0.7826** at claude-sonnet-5's rates,
and Zone B's measured rewrite frequency of **20/754 = 2.65%**, which puts Zone B's
existing single trailing marker far on the winning side of that line under any
model of the cache.

## 2. Land now

**2.1 Apply the existing `ARGS_CAP_WITH_BLOB` rule in `retrieve/detail.ts`.**

- `packages/core/src/assemble/format.ts:128` defines
  `const ARGS_CAP_WITH_BLOB = 512` and applies it in `renderEvent` for the Zone C
  path, with a comment naming the exact problem experiment 2 rediscovered: "a
  write_file's args carry the whole file a second time, and that duplicate rode
  through every cache write (1.25×) and read (0.1×/turn) of the zone."
- `packages/core/src/retrieve/detail.ts:87-89` — the `renderEvent` that serves
  `context_fetch depth:"full"` and `context_peek` — pushes `--- args` and
  `--- content` unconditionally, with no cap.

This is a defect fix, not a behaviour change, and needs no flag: the algorithm
document's own tier-1 loop already states the rule ("cap edit-tool arguments once
the post-state blob exists") and its tier-2 table already marks the value
**validated** against a run pair. Two renderers of the same events disagree, and
one of them is not implementing the stated algorithm. No new constant is
introduced — the same 512 is reused.

Measured by this pass, exact cl100k tokens over the frozen store's rendered spans:

| branch span | uncapped | with the existing cap | delta | fits 16,384 | fits 32,768 |
| --- | ---: | ---: | ---: | :--: | :--: |
| 267–271 (`neutralPhases: []`) | 34,664 | **17,345** | −17,319 | no | **yes** |
| 267–276 (current) | 35,657 | **18,338** | −17,319 | no | **yes** |
| 55–261 (current) | 51,802 | 46,919 | −4,883 | no | no |
| 732–754 (current) | 9,882 | 9,134 | −748 | yes | yes |

The fix changes the bytes `context_fetch` returns, so any recorded-completion
fixture keyed on fetch text shifts. That is a derived-layer rebuild, not a
parameter change. Run `pnpm vitest run packages/core/test/retrieve.test.ts` and the
`context_fetch`/`context_peek` MCP tool tests with it.

**2.2 Move the switch check to the prompt about to be sent
(`eval/src/loop.ts`).** The gate sets `lastPromptTokens` from
`result.usage.input + cacheRead + cacheWrite` after the call returns
(`eval/src/loop.ts:1035`) and `belowLazyBudget()` reads it before the next one
(`:829`), so the turn that contains the crossing is judged against a prompt that no
longer exists. The rule asks whether *the whole trace still fits*; answering it
from last turn's bill answers a different question. Median 8,306 tokens of
overshoot is the measured consequence; the fix is one local tokenizer pass. No
flag: it restores the stated rule, and it lives in the measurement harness, not in
`packages/core`, so no shipped default moves.

It does change which turn crosses on a live run, so **declare an epoch boundary at
the commit**: no total-token, turn-count or cost figure from `long-v65-gate` or
earlier may be compared to a run made after it.

**2.3 Keep `cacheZoneCBreakpoint` exactly as landed, and re-label its third
test.** `packages/core/src/assemble/assembler.ts:81` (the field, default off) and
`:167-174` (the marker), plus the `toMessages` generalisation at `:400-447`, are
correct and close the "landlocked in eval" defect that analysis 4 named — the
default is verified byte-identical by the 516-test run, and `splitAtLastMark`
reduces to the old `zoneEndsAtBreakpoint` behaviour whenever the mark sits on a
zone's final block, which is the only place anything marks today. One edit is
needed: the third new test in `packages/core/test/cache.test.ts` asserts that a
growing Zone C is billed as `cacheWrite` and calls that "the actual, correct,
verified behavior of this design under the shipped harness". It is the shipped
harness's behaviour; it is not the design's, and the live run says so. Retitle it as
a characterisation of the simulator's exact-position matching and add the
`tree-vs-transcript.md:155` pointer, so that whoever fixes the simulator knows this
assertion is expected to flip rather than treating its failure as a regression.

**2.4 Documentation-only corrections.** Retire the "breaks even once the rewrite
frequency drops below roughly 1-in-12.5 turns" phrasing in favour of `f*`, and keep
the size-ratio reading (`Pwrite / Pread` = 12.5×, which is correct for the question
it answers). Record the tree.db freeze gap from the section above. Exact edits in §6.

## 3. Land behind a flag

**3.1 `neutralPhases: []` — flag: the existing `SegmentConfig.neutralPhases`
field (`packages/core/src/contracts/segment.ts:55-58`), default unchanged at
`['other']`. Arm name: `tree-fine`. Isolated variable: whether a tool call mapped
to a neutral phase extends the open phase or closes it.** No new code is required —
the field already exists and iteration 2 has now measured both settings on the same
754 events. Changing the default is an **epoch shift** of the most expensive kind:
it re-segments L1, so every node id, every span and every stored summary changes,
all derived layers must be deleted and rebuilt (never migrated, per the L0/L2
invariant), and no measurement crosses the boundary in either direction.

**3.2 The fits-maximising ladder walk — no new flag needed; the flag is the
existing `ARM_ROOT_LADDER` entry, and the arm is `tree-wide`
(`eval/scripts/transplant.mjs:398-410`). Isolated variable: which of two
equally-fitting allocations of the same Zone B share is rendered.** Experiment 1
establishes that the proposed rule and the existing reversed ladder select the same
rung at every window in this fixture, so there is nothing to build. Making
`tree-wide` the default is an epoch shift: it changes the assembled Zone B on every
run at any window where the share binds.

Nothing else in either iteration has earned a flag. In particular no switch
fraction should be flagged, because experiment 3 cannot rank them (§4).

## 4. Reject

- **A new allocation mechanism for the fold ladder.** Refuted by the monotonicity
  the curve exposes: bodies at keep 40/16/12/8/6/4/2 are 0/2/5/6/8/10/**11** at
  W=32,768, so the argmax is always the smallest rung. There is no third,
  undiscovered allocation to build a mechanism for — only a default to flip.
- **Demand-driven widening keyed on retrieval confidence.** Refuted by 4 successes
  in 120 searched rows, and by rank 1 scoring 0/6. This kills the refinement that
  iteration 1 explicitly left open when it refuted demand-driven-on-occurrence.
- **Iteration 1's claim that `neutralPhases: []` "eliminates the over-window branch
  entirely" and that "every question then sources from a branch that fits every
  tested window".** Refuted by 34,664 exact tokens still over W=32,768, and by 2 of
  12 questions still over W=16,384. Iteration 2 killed both.
- **Any switch fraction selected from experiment 3's sweep, including 0.15.**
  Refuted by the constant 9,060-token post-switch size across all five fractions,
  which makes the ranking an identity of the generator. The Zone C fraction stays
  the switch's *definition* (settled on the rule's own wording, not on this sweep),
  and its *value* remains unmeasured.
- **The +23% figure as evidence against the Zone C breakpoint, and equally the
  proposal to turn it on by default.** Both refuted, in opposite directions, by the
  same pair of numbers: −18% cost per turn measured live over n=5 with cacheRead
  climbing 4,788→23,794, against a simulator whose matching rule cannot credit a
  moving marker with any read at all. The design is not refuted; it is unmeasured
  offline. The default stays off until an instrument that agrees with the live run
  says otherwise.
- **`exp-04-caching.md`'s absolute session table as a citable measurement.**
  Refuted by re-running it: cacheRead 6,209,893 against 5,079,261, $19.1641 against
  $18.8782, because the root summary the assembler reads grew 407 → 1,677 heuristic
  tokens between the measurement and today. The direction, the identity of the two
  layouts' read totals, and `f*` all reproduce; the dollar and read-fraction cells
  do not.
- **Iteration 1's attribution of the tree/tree-wide token gap to Zone B width, and
  iteration 2's replacement claim that width costs no tokens.** Both are wrong, and
  the correct answer is not yet known. Zone B's rendered size is essentially
  identical at the two rungs — 7,633 tokens at keep=16 against 7,569 at keep=2 —
  which confirms "reallocation, not addition" for Zone B and refutes iteration 1's
  ~465-tokens-per-summary marginal cost (that figure divides a fixed-size block by
  its contents; multiplying it by 9 counts a budget twice). But the arms still
  differ by a **median 12,168 input tokens** and a **median 5,456 peak request
  tokens** at identical median turn counts of 3.0 (n=38 completed rows each,
  recomputed by this pass). Measured: the wide arm fetched on 26 of 38 rows against
  21 of 38, and searched on 33 against 31. Inferred, not established: the gap lives
  in retrieval results, which append after Zone C and outside the share. Until
  someone decomposes `peakRequestTokens` by zone, "width is free" is as unsupported
  as "width costs 465 tokens a summary".

## 5. The one live batch worth paying for

**One, and it is not any of the three the dimension reports point at.**

Run the same-turn switch check (§2.2) against today's lagged gate.

- **Scenarios:** `sw-5-dozen` and `sw-6-ripple` — the only two scenarios on record
  that cross the switch, and the two the six recorded crossings come from.
- **Arms:** `lagged` (today, `lastPromptTokens` from the previous call) and
  `same-turn` (tokenise the candidate prompt before dispatch). One variable.
- **n:** 3 replicates per scenario per arm = 12 runs, interleaved same-day, one
  epoch. This matches the design that produced the six crossings, so the `lagged`
  arm doubles as a within-epoch reproduction of them.
- **Model:** `claude-sonnet-5` for the agent, `claude-haiku-4-5-20251001` for the
  leaf summarizer. Not a choice — it is the only model the six recorded crossings
  exist on, and changing it forfeits the comparison.
- **Pre-registered win criterion, per stratum.** The strata here are the two
  scenarios, and the criterion is declared per scenario because they behave
  differently (`sw-6-ripple` produced the 33-turn oscillating replicate):
  1. *Primary, per scenario:* the crossing turn's prompt is within 1,000 tokens of
     the threshold in at least 5 of the 6 `same-turn` runs. The offline proxy
     predicts 5 of 6 at 0 and one at 916; anything worse than 5 of 6 says the
     candidate prompt is not what the gate should be measuring.
  2. *Primary, per scenario:* median total billed tokens for `same-turn` is at or
     below `lagged`'s. The baseline is on disk: median 265,428 billed tokens per run
     (n=6). A rise means removing the overshoot cost more elsewhere than it saved,
     which is the one outcome that would retire the fix.
  3. *Guard, per scenario:* median turns for `same-turn` no worse than `lagged` + 2.
     Baseline medians are 13 and 16 turns. An earlier, smaller crossing that buys
     token savings with turns is not a win — that is the failure mode v5.7 recorded.
  4. *Guard, pooled:* no run graded `success: false` on a scenario where `lagged`
     graded true. These are graded by hidden tests against the sandbox, so a
     regression here is a filesystem fact, not a judge's opinion.
- **Estimated tokens:** 12 runs × 265,428 median billed tokens ≈ **3.2M billed
  tokens**, of which roughly 60% is cache reads at 0.1× on the recorded mix.
  *Footnote, USD only:* at claude-sonnet-5's and claude-haiku-4-5's published rates
  in `packages/core/src/models/cost.ts`, the six baseline runs cost $0.279–$0.650,
  median $0.335, total $2.378; twelve comparable runs price at roughly $4.

**Why nothing else is worth paying for yet, stated as the reason rather than as a
preference.**

- *Width (`tree` vs `tree-wide` on a second scenario)*, which both iteration-1 and
  iteration-2 name as the next step, **cannot discriminate at any affordable n.**
  The outcome variable is at the floor: 4 successes in 120 searched rows, and 9 of
  12 questions at exactly 0.000 across every rank and both widths. A second
  scenario at n=15 per cell would be comparing two arms whose expected successes are
  about 4 and 4. Buy the floor-lifting change first (raw-by-default fetch, already
  on the candidates list with the reason that none of the twelve answer literals is
  in any summary), then this batch becomes a real experiment.
- *Depth (`neutralPhases: []` live)* is floor-limited the same way, and the one
  report that forensically classified failures on this store found "fetched the
  correct branch but it was truncated" at **0 of 110**. The condition the fix
  addresses has never fired.
- *Caching* needs no spend because **the live measurement already exists**:
  n=5 at v5.6/iter9, −18% cost per turn, cacheRead climbing. What is broken is the
  offline instrument, and fixing it is offline work.

## 6. Algorithm document updates

`reports/algorithm.md` is being edited concurrently — it carries uncommitted changes
and gained a whole section ("The zone partition is itself a budget") at 12:10 today,
after these experiments were written. The quotes below are the text as of this
verdict; anchor each edit on its section heading and its distinctive phrase rather
than on a line number, and re-read before applying.

### 6.1 Dimension 1 — the ladder direction paragraph

Current:

> The load-bearing finding is that the ladder direction is a human choice hiding
> inside a mechanism that looks derived, and the reproduction sharpened it: six of
> the seven ladder rungs satisfy the fit predicate at the tested window. So
> "largest rung that fits" barely constrains anything, and the direction someone
> wrote into the ladder picks the allocation almost unaided. That is the open
> parameter, and it is a fit-derived-shaped fix: replace "walk this hand-picked
> direction" with "walk toward maximising the number of rendered bodies subject to
> the same fits predicate", then measure.

Replacement:

> The load-bearing finding is that the ladder direction is a human choice hiding
> inside a mechanism that looks derived: six of the seven rungs satisfy the fit
> predicate at the tested window, so "largest rung that fits" barely constrains
> anything and the direction picks the allocation almost unaided. Iteration 2 walked
> every rung at every window and closed the follow-up question this paragraph used
> to leave open. Rendered bodies are monotone non-increasing in the rung — at
> W=32,768 the rungs 40/16/12/8/6/4/2 yield 0/2/5/6/8/10/11 bodies — so "walk
> toward maximising rendered bodies subject to the same fits predicate" always
> selects the ladder's smallest rung, which is exactly where the reversed ladder
> already stops. There is no third allocation to build: the fix is not a new
> mechanism but a default flip to the existing `tree-wide` arm, and it is an epoch
> shift. The band where the choice matters at all is narrow. At W=8,192 no rung
> leaves a single body. At W=200,000 every rung ties at 21, the whole store. Only in
> between do the two directions render different branch sets.

### 6.2 Dimension 1 — the alternative-policies paragraph

Current (first two sentences):

> Both alternative policies come out unnecessary on present evidence, for specific
> reasons rather than by preference. Demand-driven fails because whether the model
> searches does not track where the bottleneck actually is.

Replacement:

> Both alternative policies come out unnecessary on present evidence, for specific
> reasons rather than by preference. Demand-driven fails twice over: whether the
> model searches does not track where the bottleneck is, and iteration 2 killed the
> refinement that was left open — widening on retrieval *confidence* rather than
> occurrence. Among the 120 rows that searched there are 4 successes, all on one
> question, and the question whose answer branch ranks first scores zero on all six
> of its attempts. No confidence signal can widen its way past a floor that deep.

### 6.3 Dimension 2 — the opening claim

Current:

> One branch exceeds the larger tested window, and **four exceed the smaller one**,
> so seven of the twelve questions source from an over-window branch rather than the
> three first reported.

Replacement:

> **Two** branches exceed the larger tested window and **four** exceed the smaller
> one, so seven of the twelve questions source from an over-window branch rather
> than the three first reported. The correction to "one" is a measurement
> correction: the chars÷4×0.851 estimate that produced it undercounts the branch at
> seq 267–276 by 67%, 21,396 against 35,657 exact tokens. A corpus-wide ratio is a
> fair average and an unsafe per-branch predictor.

### 6.4 Dimension 2 — the fix paragraph

Current:

> The fix is a config change already supported by the code rather than a new rule:
> emptying the neutral-phase list, which the segmenter's own contract calls the
> literal reading of its specification, re-segments the same events into 99 branches
> with a median of 3 events. Every question's source then fits both live windows —
> but not every window: at 8,192 tokens two questions still overflow, and one branch
> stays above the smaller live window. The claim is "fits the windows we run", not
> "fits everywhere".

Replacement:

> The fix is a config change already supported by the code rather than a new rule:
> emptying the neutral-phase list, which the segmenter's own contract calls the
> literal reading of its specification, re-segments the same events into 99 branches
> with a median of 3 events. It does not close the boundary. Every question's source
> then fits the larger live window, W=32,768; at the smaller live window, W=16,384,
> two of twelve still overflow and three branches remain above it. One branch
> survives every segmentation at 34,664 tokens, and the reason is not segmentation
> at all: six of the trace's 754 events carry a tool call's arguments *and* its
> post-state blob, and all six duplicate the same content byte-for-byte — 70,227
> characters trace-wide, 17,519 tokens on the single worst event. A branch can never
> render smaller than its largest atomic event. The already-validated 512-byte
> argument cap that `assemble/format.ts` applies for exactly this reason is missing
> from `retrieve/detail.ts`, which is what serves a full fetch; applying it there
> brings that branch to 17,345 tokens and, with re-segmentation, leaves nothing over
> the larger window. Neither change alone closes it, and even together they leave
> three branches over W=16,384.

### 6.5 Dimension 3 — after the lag paragraph, add a result

Current (last sentence of that paragraph):

> Removing the lag costs one local tokenizer pass over the prompt about to be sent,
> not a model call.

Replacement:

> Removing the lag costs one local tokenizer pass over the prompt about to be sent,
> not a model call — measured at 2.7 milliseconds on a 120,000-character prompt and
> 4.0 on 180,000, against turn latencies recorded in the seconds. Replayed against
> the same six crossings, the median overshoot falls from 8,306 tokens to zero and
> the worst case from 15,564 to 916, with five of six landing under the threshold.
> The replacement figure is a proxy — the runs' raw L0 was not archived, only
> per-turn usage — and its bias is upward, so the fixed system's overshoot is at or
> below those numbers.
>
> The fraction itself is still unmeasured, and iteration 2 established why the
> cheap route cannot measure it. Sweeping {0.15 … 0.35} over the deterministic
> 300-branch corpus makes total tokens fall monotonically as the fraction shrinks,
> from 9,150,408 to 3,361,230, but the post-switch prompt is a constant 9,060 tokens
> at every fraction, so on a linear-growth corpus an earlier crossing is
> arithmetically always cheaper and the ranking is an identity of the generator. The
> transferable finding is about the rule's form rather than its value: a fixed
> fraction of W will always be beaten on tokens by a rule that compares the two live
> candidate prompts and switches to the smaller. Whether an early switch buys those
> tokens with turns is the question, and this corpus has no representation of a turn.

### 6.6 Dimension 4 — the rate-ratio paragraph

Current:

> The rate ratio settles the central question without a model call: a cache write
> costs 12.5 times a cache read per token. So a stable prefix read every turn beats
> the same content rewritten every turn unless the rewrite happens less than about
> once in every twelve turns, and prefix *size* is not what decides it.

Replacement:

> The rate ratio settles one question without a model call: a cache write costs 12.5
> times a cache read per token, so a prefix that is re-read every turn can be up to
> 12.5 times larger than a constantly-rewritten one and still cost the same. Size is
> not the lever. The "once in every twelve turns" phrasing that used to follow was a
> size ratio wearing a frequency's clothes, and iteration 2 replaced it with the
> derivation the frequency question actually needs: marking a block beats leaving it
> unmarked while its rewrite frequency stays below
> `f* = (Pinput − Pread) / (Pwrite − Pread)`, which is 0.7826 at this model's
> published rates. That is a formula over three per-model prices, not a constant — a
> new host re-evaluates it rather than inheriting 78.3%. Measured against a real
> trace, Zone B rewrites on 20 of 754 turns, 2.65%, far inside the winning side of
> that line, which is why its single trailing marker is correctly placed.

### 6.7 Dimension 4 — the "two facts" paragraph

Current:

> Two facts change what to do next. The shipped request builder emits two of the
> four breakpoints the provider allows and marks nothing on the active-branch detail,
> so that section is fresh input on every turn by construction — a third breakpoint
> is available and unused. And the cache assertion harness the plan called for
> already exists and runs offline: 612 lines of simulator, 13 tests, 101
> milliseconds, including one that catches a dropped breakpoint. The instrument was
> already in the repository — and had never been pointed at the request builder that
> produced every live number in this program.

Replacement:

> Two facts changed what to do next, and pointing the instrument at the question
> corrected one of them. The shipped request builder emitted two of the four
> breakpoints the provider allows and marked nothing on the active-branch detail;
> that third marker now exists in the library behind a field defaulting to off,
> which closes a defect where the only implementation lived in an eval script. And
> the cache assertion harness the plan called for already existed, ran offline, and
> had never been pointed at the request builder that produced every live number in
> this program — 612 lines of simulator, now 17 tests.
>
> Using it produced a result that must be read as a finding about the instrument.
> The simulator credits a read only when a breakpoint recurs at the same block index
> as in the immediately previous submission, so a single trailing marker that
> advances one block per turn can never earn a read at all. Under that model the
> third marker made a 754-turn replay 23% more expensive. The live run of the same
> design says the opposite and is already paid for: cache reads climbing 4,788 to
> 23,794, cache writes delta-sized at about 1.2k, fresh input falling from
> 2,400–7,600 to 36–892 tokens a turn, and cost per turn down 18% over five
> replicates. The live number is the ground truth; the offline number is the
> simulator's documented conservatism firing hard enough to flip a sign. Until the
> simulator models a provider's automatic match against every previously cached
> position rather than only the last submission's exact breakpoints, it cannot rank
> any design whose marker moves — which is every design that appends.

### 6.8 Tier 2 — `zone fractions`

Current tail of that row:

> The remaining fractions are still a design allocation summing to 1, and dimension
> 3 names the zero-spend sweep that would test .15/.20/.25/.30 |

Replacement:

> The remaining fractions are still a design allocation summing to 1. The zero-spend
> sweep of .15/.20/.25/.30/.35 was run and **cannot rank them**: the post-switch
> prompt is a constant 9,060 tokens at every fraction, so total tokens fall
> monotonically as the fraction shrinks and the extrapolated optimum is "switch
> immediately". Ranking these fractions needs turns and score, which no offline
> corpus in this repository represents |

### 6.9 Tier 2 — `root keep (fold level)`

Current tail of that row:

> Note this is the *fold level*, not the number of summary bodies rendered — the two
> move in opposite directions, and which allocation wins is decided today by a
> hand-picked ladder direction rather than by measurement |

Replacement:

> Note this is the *fold level*, not the number of summary bodies rendered. Bodies
> are monotone non-increasing in the rung (0/2/5/6/8/10/11 at rungs 40→2, W=32,768),
> so a body-maximising walk always lands on the smallest rung and is identical to
> the reversed ladder already shipped as an ablation arm. The open question is not
> which mechanism but whether to flip that default, which is an epoch shift and
> needs live evidence the score floor currently prevents |

### 6.10 Tier 2 — `edit-argument cap`, state changes

Current:

> | edit-argument cap | 512 bytes when a post-state blob exists | measurement
> against re-verification cost | **validated.** Both alternatives were run: dropping
> the arguments cost turns (a scenario went 13 → 25) and capping did not. The number
> itself has not been swept, but the choice between drop, cap and keep has |

Replacement:

> | edit-argument cap | 512 bytes when a post-state blob exists — **applied in the
> Zone C renderer only** | measurement against re-verification cost | **validated as
> a choice, and applied in one of two places — a defect.** Both alternatives were
> run: dropping the arguments cost turns (a scenario went 13 → 25) and capping did
> not. But `assemble/format.ts` caps and `retrieve/detail.ts` does not, so a full
> fetch still renders a written file's content twice. Measured on the frozen store:
> six of 754 events duplicate content byte-for-byte, 70,227 characters trace-wide,
> and applying the same constant in the fetch renderer takes the worst branch from
> 34,664 to 17,345 exact tokens |

### 6.11 Boundary conditions — two rows

Current:

> | window too small to hold Zone A plus one branch summary | assemble at 8k, 16k,
> 32k, 64k, 200k and assert each Zone B is a subset of the next larger | tested
> offline, passes |

Replacement:

> | window too small to hold Zone A plus one branch summary | assemble at 8k, 16k,
> 32k, 64k, 200k and assert each Zone B is a subset of the next larger | **found at
> 8,192, and it is the partition's doing rather than the window's.** The nesting
> assertion passes because a dead cell is reported and never forced, and the frozen
> `gates.json` g9 detail already records both arms dead at 8,192. But no rung leaves
> a single body there: the Zone B *share* is 1,925 tokens while the smallest root
> block is 2,587. Against the real 8,192-token window it would fit: Zone A's
> contract measures 1,037 heuristic tokens (2,370 if the tool schemas travel as
> prompt text rather than as the API parameter), the smallest root block 2,587, one
> branch body about 465 — 4,100 to 5,400 against 8,192. This cell is the clearest
> evidence for the "delete the partition" candidate, and no scored run has ever been
> made at this window |

Current:

> | a leaf larger than the whole window | fetch a branch whose raw span exceeds W |
> **found, and a fix is measured offline**: one branch is 36k tokens against a 32k
> window because neutral-phase merging never closes it. Emptying the neutral-phase
> list re-segments to 99 branches and no question's source exceeds any tested window.
> Costs 4.7× the summarizer calls; the listing-then-range path also exists and is
> still untested live |

Replacement:

> | a leaf larger than the whole window | fetch a branch whose raw span exceeds W,
> at every tested window, in exact tokens | **found, still open, and now decomposed
> into two independent causes.** Exactly: two branches exceed W=32,768 and four
> exceed W=16,384 today. Emptying the neutral-phase list re-segments to 99 branches
> and takes those to one and three — not to zero, as first reported — at 4.71× the
> summarizer calls for 2.33× the dollars, all of it fixed per-call overhead.
> Independently, the missing argument cap in `retrieve/detail.ts` doubles a written
> file's content inside a single event; applying the existing cap takes the surviving
> 34,664-token branch to 17,345. The two together close the condition at W=32,768
> and leave three branches over W=16,384. The listing-then-range path also exists and
> is still untested live |

### 6.12 Simplification ledger — one new row

Append after `| 2026-09-02, item 3 | none: both candidates measured null and were
retired | none | none |`:

> | 2026-09-02, iteration 2 | the frequency form of the 12.5× cache rule, replaced
> by a formula over three published rates; the claim that the fit predicate
> under-determines the allocation, replaced by a monotonicity that makes the
> body-maximising walk identical to an existing arm | none | none yet — the
> argument cap becomes *applied* rather than retired, and the switch fraction's
> sweep came back unable to rank |

And amend the sentence under the ledger. Current:

> Open defects: seven hardcoded values in the table above, four of them budgets that
> already have a derivation in the other harness.

Replacement:

> Open defects: seven hardcoded values in the table above, four of them budgets that
> already have a derivation in the other harness; one validated value applied in
> only one of the two renderers that need it; and one measurement defect that is not
> a value at all — the frozen fixture's `tree.db` is gitignored and unhashed, so the
> root-summary version the assembler reads can change between two passes with no
> signal in `git status` or the manifest, which is what makes one iteration-2 table
> irreproducible.

### 6.13 The zone-partition section gains its measurement

Current:

> And it manufactured the reallocation result recorded above. Because the zones
> compete for an invented share rather than for the actual window, extra summary
> bodies necessarily displace root headlines even when the real window has room.
> "Width is a reallocation" is a fact about this implementation, not necessarily
> about the algorithm.

Replacement:

> And it manufactured the reallocation result recorded above. Iteration 2's rung
> sweep shows the displacement appearing and disappearing exactly with whether the
> share binds. At W=32,768 the share is 7,701 tokens and the two ladder directions
> render 2 bodies against 11. At W=200,000 the share is 47,009 while the entire
> store's Zone B is at most 16,921, and every rung ties at 21 bodies — the
> displacement is simply gone, and the two directions render an identical branch
> set. At W=8,192 the share is 1,925 against a 2,587-token root block and nothing
> renders at all, though the real window has room for both. "Width is a
> reallocation" is a fact about this implementation, and the curve now says at which
> window sizes it is a fact at all.
>
> One number that used to support the opposite reading needs withdrawing, and its
> replacement is not yet known. Zone B's rendered size is 7,633 tokens at keep=16
> and 7,569 at keep=2, so width really is a reallocation of a fixed block. Yet the
> two arms differ by a median 12,168 input tokens and a median 5,456 peak request
> tokens at identical median turn counts. Neither "width costs 465 tokens a summary"
> nor "width costs nothing" survives that pair. The wide arm fetched on 26 of 38
> completed rows against 21 of 38, and fetch results append after Zone C outside
> every share, which is where the gap probably lives — but nothing records
> `peakRequestTokens` by zone, so this is a hypothesis with a measured antecedent,
> not a finding.

### 6.14 Change log

Prepend:

> - **2026-09-02, iteration 2 judged** — four experiments, zero model calls; three
>   reproduce to the token and one does not. Landing now: the validated 512-byte
>   argument cap is missing from the fetch renderer (17,319 tokens on one branch,
>   70,227 duplicated characters trace-wide), and the switch gate reads last turn's
>   bill instead of the prompt about to be sent (median 8,306 tokens of overshoot →
>   0). Killed: iteration 1's "re-segmentation eliminates the over-window branch"
>   (34,664 tokens still over), rank-triggered widening (4 successes in 120 searched
>   rows), a new allocation mechanism for the ladder (bodies are monotone in the
>   rung, so the body-maximising walk *is* the reversed ladder), and any switch
>   fraction drawn from the sweep (post-switch size is constant, so the ranking is
>   the generator's). Reversed: the offline harness's verdict against the third
>   cache breakpoint, which contradicts an already-paid live run showing −18% cost
>   per turn — the simulator only credits a read when a marker recurs at the same
>   block index, so it cannot rank any design whose marker moves. And a measurement
>   defect worth more than any of them: the frozen fixture's `tree.db` is gitignored
>   and unhashed, and the root-summary version the assembler reads changed
>   mid-iteration, which is why one table cannot be reproduced.

## 7. What a third iteration would do

Mostly offline, and the ordering is forced by dependencies rather than chosen.

1. **Hash the fixture's L1, or stop reading its latest summary version.** Nothing
   else in this list is trustworthy until a pass can prove the store it measured is
   the store the previous pass measured. Either add `tree.db`'s node-dump and
   summary hashes to the manifest as a pre-flight check every script runs, or have
   assembler-driven scripts pin an explicit summary version instead of taking the
   newest. This is a day's work and it retroactively dates every Zone B number in
   the repository.
2. **Extend `ProviderCacheSimulator` to match against every previously cached
   position, not only the last submission's exact breakpoint set,** then re-run
   `cache-sweep.mjs` unchanged. The validation target already exists and is free: the
   extended simulator must reproduce the live run's shape — reads climbing, writes
   delta-sized, fresh input in the tens of tokens. If it does, the Zone C breakpoint
   becomes a default-flip candidate; if it cannot, the harness is not fit to rank
   caching designs and the dimension is live-only. Either answer is worth having, and
   the existing `cache.test.ts` regression suite is the guard.
3. **Land the argument cap and re-measure the depth boundary.** With the cap in
   `retrieve/detail.ts`, re-run `resegment.mjs`: the interesting question becomes
   whether `neutralPhases: []` is still worth 2.33× the summarizer dollars once the
   duplication is gone, because the cap alone already takes both over-W=32,768
   branches under that window in the candidate segmentation.
4. **Instrument `peakRequestTokens` by zone in the transplant harness.** It is the
   only way to settle where the 12,168-token width gap lives, it costs nothing per
   run, and until it exists neither of the two competing claims about width's cost
   can be defended.
5. **Then, and only then, the live batch in §5** — and *only* that one. The width and
   depth questions are blocked behind the score floor, not behind spend: with 9 of 12
   questions at exactly zero across both widths and every rank, no affordable n
   discriminates. The change that unblocks them is already on the candidates list
   with its reason stated ("raw by default", because none of the twelve answer
   literals is in any summary), and it should be measured before another width or
   depth arm is bought.

The honest summary of where the four dimensions now stand: two of them
(summary timing, caching) have a clear next action that is a defect fix rather than
a tuning decision, and two (branch count, branch depth) are blocked on a retrieval
problem that neither dimension owns.

## Sources re-read at their anchors

- `eval/plans/tuning/{01,02,03,04}-*.md` and `exp-0{1,2,3,4}-*.md`.
- `eval/scripts/{ladder-curve,resegment,switch-fraction-sweep,cache-sweep}.mjs` — all
  four re-run; all four verified to write only into `mkdtemp` scratch directories,
  by sha256 on `tree.db` before and after each.
- `packages/core/src/cache/simulator.ts:184-193` — the exact-position matching rule
  that decides experiment 4.
- `packages/core/src/assemble/format.ts:128-155` and
  `packages/core/src/retrieve/detail.ts:80-105` — the argument cap present in one
  renderer and absent from the other.
- `packages/core/src/assemble/assembler.ts` and `packages/core/test/cache.test.ts` —
  the landed diff, +74/−10 and +106/−2, read in full.
- `eval/src/loop.ts:805-830, 1003-1040` — the lagged gate and the devolved-mode
  branch; `AGENT_MAX_TOKENS` confirmed `undefined` at `:87`.
- `reports/metrics/tree-vs-transcript.md:46, 155` — the live cache measurement,
  quoted verbatim.
- `eval/fixtures/transplant/s1/e1b289c32f40/{manifest.json,gates.json,questions.json,
  results/run-*.json}` — the ratio, the g8/g9 details that already carried three of
  experiment 1's cells, and the per-arm usage recomputed independently.
- `eval/results/long-v65-gate/*/results.json` — the six crossings and the per-run
  costs, both recomputed without the script.
- `reports/algorithm.md` — read twice, because it changed between readings.
