# DS-STAR dimension 1 — how many branch summaries should the model see

Scope: the visible-branch-count dimension named in `reports/algorithm.md`'s "What
the DS-STAR loop is for" section and its tier-2 `root keep` row. This pass reads
every artifact that has ever run a width comparison, separates the number that
was *configured* from the number that was actually *visible* in the assembled
prompt, and evaluates the three candidate policies the algorithm doc lists
(fit-derived, demand-driven, user-selected) against that evidence. No new runs
were made; every number below is read from a committed file or computed offline
from one (cl100k token counts via `gpt-tokenizer`, exact; SQL against the
frozen store). Two terms used throughout, defined once: **rootKeep** is the
rung on a fold ladder — how many of the most recent branches get an individual
headline in the root index before older ones fold into one summary line.
**branchesSurviving** is the number of branches that end up with their *full*
summary body rendered separately in Zone B, which is a different count from
rootKeep and — as this report shows — moves in the *opposite* direction from it.

## 1. What has actually been run

All width evidence beyond the two abandoned event/branch-level top-k arms
(§2 below) comes from one fixture: `eval/fixtures/transplant/s1/e1b289c32f40/`,
scenario `s1`, a frozen store of 754 L0 events, 46 nodes (1 task, 21 phase/branch
nodes, 24 file nodes), 22 leaf summaries (`manifest.json:8-15`). Twelve questions,
three per stratum (head/tail/deep/spanning), each run 5 reps
(`questions.json`: `"questions"` array, len 12; `REPS=5` per
`eval/plans/portability-audit/03-transplant.md:228`), so each (arm, stratum, window,
model) cell is n=15 rows.

### 1.1 Configured vs. visible, precisely

`transplant.mjs:385` defines one ladder, `ROOT_KEEP_LADDER = [40, 16, 12, 8, 6,
4, 2]`, largest first. `ARM_ROOT_LADDER` (`transplant.mjs:398-410`) assigns it
un-reversed to the `tree` arm and **reversed** (`[2, 4, 6, 8, 12, 16, 40]`) to
`tree-wide`. `deriveRootKeep` (`transplant.mjs:450-458`) walks whichever ladder
it is given and returns the **first** rung whose predicate passes — "does the
real assembled Zone B fit its budget with at least one branch summary
surviving" (the comment at `transplant.mjs:427-448` and R4/R5 in
`eval/fixtures/transplant/JUDGE-VERDICT.md:146-155` name why the predicate has
to assemble the real prompt rather than check a proxy share of the budget).

Because `tree` walks large-to-small, the first passing rung is the **largest**
one that fits — which spends most of the Zone B budget on root headlines and
leaves little room for full branch bodies. Because `tree-wide` walks
small-to-large, the first passing rung is the **smallest** one (2), which
spends almost nothing on headlines and leaves the rest of the budget for full
branch bodies. The two arms are not "narrow" and "wide" settings of one dial;
they are the same ladder walked in opposite directions, and the walk direction
— not a configured count — is what decides whether the budget goes to
headline coverage or to body coverage. `JUDGE-VERDICT.md:157-159` calls this
explicitly: *"the shipped D17 posture is headline-rich"* (i.e. `tree`, the
production default) and names `tree-wide` a **pre-registered ablation**,
triggered only if `tree` underperforms the `truncate-tail` baseline by more
than 0.05 on the tail stratum (`JUDGE-VERDICT.md:163-164`). That trigger did
fire: `tree`'s tail-stratum mean is 0.000 against `truncate-tail`'s 0.200 (§2),
a 0.20 gap — which is why `tree-wide` exists as data at all, not as a
symmetric alternative someone chose to test on equal footing.

At **W=32,768** (`manifest.json`'s `root_by_window`, and `gates.json`'s
per-window table, both keyed identically):

| Arm | rootKeep (configured rung) | root block (tok) | **branchesSurviving (visible)** | branch seq range | Zone B total |
|---|---:|---:|---:|---|---:|
| `tree` | 16 | 6,095 | **2** | 639–754 | 7,701 |
| `tree-wide` | 2 | 2,587 | **11** | 359–754 | 7,701 |

(`manifest.json:root_by_window.32768`; `gates.json:table.32768.rootLadder`, the
`keep:16` and — from the manifest's separate `tree-wide` entry — `keep:2` rows.)
The higher configured rootKeep (`tree`, 16) produces *fewer* visible summaries
(2); the lower one (`tree-wide`, 2) produces *more* (11). Reading `rootKeep`
off a config file and calling it "the visible branch count" — which is what
`reports/algorithm.md`'s tier-2 table row and `packages/core/src/config.ts:117`'s
flat `rootKeep = 40` both do — names the wrong quantity.

At **W=16,384**, `tree` and `tree-wide` converge to the same rung (keep=2, 1
branch surviving, seq 732–754 — `manifest.json:root_by_window.16384`), because
the smallest rung is also the largest one that fits this window. `gates.json`'s
own rootLadder for 16,384 confirms every rung from 40 down to 4 fails on
`overBudget:["B"]`; only keep=2 passes. `JUDGE-VERDICT.md:166-171` states
plainly what this means for that cell: at 16k, visibility ends at seq 732 out
of 754 (about 3% of L0 excluded), which is inside the truncation baseline's own
boundary (seq 720) — **the 16k cell is a test of retrieval (search → fetch),
not of branch-summary width**, and no separate `tree-wide` run exists there
because there is nothing to walk in the other direction. Width is measured, in
this fixture, at exactly one window (32,768) and two points on the visible-count
axis (2 and 11).

### 1.2 Scores, by stratum, both arms, W=32768, qwen-2.5-72b-instruct (n=15/cell)

Source: `results/run-W32768-truncate-tail+compact-rolling+tree-qwen_qwen-2.5-72b-instruct.json`
(arm `tree`, pooled with the two baselines) and
`results/run-W32768-tree-wide-qwen_qwen-2.5-72b-instruct.json`. Mean is over
completed rows only; `n_completed` excludes `model_call_error` and `turn_cap`
rows per the algorithm doc's own rule that a harness-stopped run is not
evidence of a wrong answer (`reports/algorithm.md`, the 2026-09-02 10:55 entry).
The "all rows" mean scores every non-completed row as 0, which is how the
number in `reports/algorithm.md`'s headline was originally reported.

| Stratum | `tree` (2 visible), mean (n completed / 15) | `tree-wide` (11 visible), mean (n completed / 15) | `truncate-tail`, mean | `compact-rolling`, mean |
|---|---|---|---|---|
| head | 0.091 (11/15) | **0.333** (9/15) | 0.000 (14/15) | 0.000 (15/15) |
| tail | 0.000 (11/15) | 0.000 (13/15) | 0.200 (15/15) | 0.333 (15/15) |
| deep | 0.000 (11/15) | 0.000 (7/15) | 0.000 (15/15) | 0.000 (15/15) |
| spanning | 0.000 (5/15) | 0.000 (9/15) | 0.000 (15/15) | 0.000 (15/15) |

("All rows" head means: `tree` 0.067, `tree-wide` 0.273 — the 0.091/0.333 pair
`reports/algorithm.md` cites is the completed-only figure; both are reproduced
directly from the result files above, independent of the doc's own citation.)

This table is the whole width-comparison dataset. Two things follow directly
from it that `reports/algorithm.md`'s summary does not say:

- **The measured width effect is confined to one of four strata.** Head is the
  only stratum where either tree arm scores above zero at all; tail, deep and
  spanning are 0.000 for *both* `tree` and `tree-wide` regardless of how many
  summaries are visible. Widening from 2 to 11 visible summaries changed
  nothing on 3 of the 4 question types in the one experiment that tested it.
- **On tail, wider is worse than the non-tree baselines, not just no-better.**
  `truncate-tail` (0.200) and `compact-rolling` (0.333) both beat `tree` and
  `tree-wide` (0.000, 0.000) on the tail stratum. This is not a branch-count
  effect — it held before and after the ablation — so it is evidence about
  Zone C / tail rendering, out of this dimension's scope, but it means "width
  helps" cannot be read as "the tree arm gets better as it widens"; the tree
  arm is behind the flat baselines on tail at both widths tested.

The deep/spanning floor has an independent explanation already on record:
`reports/algorithm.md`'s boundary table states *"summaries do not contain the
answer... none of twelve answer literals appears in any summary, which is what
raw fetch is for."* If the literal a deep/spanning question needs is not in any
summary's text, showing more summaries cannot help — only `context_fetch`
against raw L0 can, which is a different mechanism from this dimension. Head
questions are the one stratum where the answer is apparently recoverable from
summary prose at all, which is presumably why width shows an effect there and
nowhere else — this is offered as the likely explanation, not independently
confirmed against the literal set in this pass.

### 1.3 Two abandoned width policies from an earlier loop

`reports/metrics/context-tree-dsa-arm-experiments.md` §4 tried the opposite
question — how few branches the model needs — via `AssembleOptions.selection.keepBranches`,
a top-k **filter**, not a fold-ladder walk. It never engaged on any real run:
the segmenter merges consecutive same-type tool calls into one phase (§7 of
`reports/algorithm.md`), so a 13-tool-call task produced only ~3 branches
against a `k=3` cutoff — the floor property (`branches ≤ k ⇒ undefined ⇒
byte-identical to plain tree`) fired every time, at n=3 runs
(`branch-iter1..3`). `reports/metrics/context-tree-long-task-dsa-iterations.md`
§4 re-tried it on a longer task with a smarter (idf-cosine + farthest-point)
scorer and got the same null result at n=9 (3 iterations × 3 arms): branches
never exceeded k=3. Neither result bears on "does width help" — both only show
that *pruning* below a small natural branch count never had anything to prune,
which is a different claim from the transplant fixture's (where 21 branches
exist and the question is how many of them to show).

## 2. (a) Is width monotonically good, or is there a turning point?

**Neither, cleanly — the data shows a stratum-conditional effect, not a general
trend.** Within the one comparison that isolates branch count from every other
variable (same store, same window, same questions, same model, same epoch;
`ARM_ROOT_LADDER` is the only thing that differs between `tree` and
`tree-wide`, per the comment at `transplant.mjs:395-397`):

- Head stratum: monotonically better wider, 2 visible → 0.091, 11 visible →
  0.333, both baselines 0.000 (n=15/cell, §1.2).
- Tail, deep, spanning: flat at 0.000 across both widths (n=15/cell each);
  wider did not help, and on tail the flat baselines beat both tree widths.

So "does width help" is not a single yes/no across this fixture — it depends
on what kind of fact the question needs, and only one of the four question
types tested shows any measured sensitivity to the branch count at all. This
is consistent with — and narrower than — the algorithm doc's framing ("width
helps... eleven visible summaries scoring 0.333... against two summaries at
0.091"): that sentence is accurate but describes one stratum out of four, at
n=3 distinct questions (×5 reps) per point. It is not evidence that widening
would move the deep, tail or spanning scores, because in the one place both
widths were actually run against those strata, neither moved.

The one datapoint with real width variation (2 vs. 11, one window) cannot show
a turning point (a point beyond which more width stops helping or starts
hurting) because it only has two points on the width axis, and only one
stratum where either point is above the floor. What can be said: there is no
evidence in this repository of width hurting head-stratum recall as it grows
from 2 to 11, and no evidence it keeps helping past 11 either, since nothing
above 11 has been run. A turning point may exist; this fixture does not locate
one.

## 3. (b) What does width cost per turn?

### 3.1 The marginal token cost of one more visible summary, from the store

Each of the 21 phase (branch) nodes has exactly one summary version in the
frozen store (`sqlite3 eval/fixtures/transplant/s1/store/tree.db`, `node_summaries`
joined to `nodes` where `kind='phase'`). Their exact cl100k token counts
(`gpt-tokenizer`, the same tokenizer the ratio measurement in
`reports/algorithm.md`'s tier-2 table uses, computed directly against the
stored text — not estimated):

- n=21, mean 120.7 tokens, median 110, range 75–197.

This is the cost of one branch's own summary *prose*. It is not, by itself,
what widening Zone B costs, because a branch shown in full in Zone B also
carries its rehydration metadata (files, symbols, tests, decisions —
`reports/algorithm.md`'s summarizer section requires every summary to carry
these). The harness's own budget accounting gives the real marginal cost
directly, in the same heuristic-token units the assembler budgets in
(`root-ladder.json`'s `rungs` object, and `manifest.json`'s per-window,
per-arm entries):

- Root-index headline, marginal, averaged over the full ladder (rung 2 → rung
  40, 19 more headlines, 2,587 → 6,917 tokens): **~227 tokens per additional
  headline** (`root-ladder.json`).
- Full branch body in Zone B, marginal, from the one pair of measured points at
  W=32,768 (`tree`: 2 bodies, root 6,095, Zone B 7,701 tokens *unreachable
  further, budget-bound*; `tree-wide`: 11 bodies, root 2,587, Zone B 7,701
  tokens): **(7,701 − 2,587) / 11 ≈ 465 tokens per additional visible
  summary** (`manifest.json:root_by_window.32768`).

### 3.2 Multiplying by observed turns, and cross-checking against measured usage

`tree-wide` shows 9 more visible summaries than `tree` (11 vs. 2) at the same
window. At ~465 tokens/summary, that predicts **~4,185 extra heuristic tokens
per turn**. Median completed turns at W=32,768 are 3 for both arms (`tree`:
n=38 completed rows, median 3.0; `tree-wide`: n=38, median 3.0, mean 3.24 —
computed directly from `modelTurns` across both result files). Multiplying:
~4,185 × 3 ≈ **12,555 extra heuristic tokens over a run**.

This transplant harness reports its own token usage per row
(`usage.input/cacheRead/cacheWrite/output`), which lets the prediction be
checked directly rather than trusted: median `usage.input` is 37,513 for
`tree` and 49,681 for `tree-wide` (both n=38 completed rows) — a measured gap
of **12,168 tokens**, 3% below the 12,555 predicted from the store's own
ladder accounting. The two independent numbers (accounting-table marginal ×
turns, and directly measured usage delta) agree to within rounding, which is
the confirmation that "visible summaries" is in fact where the token
difference between the two arms lives, not turn count or output length (both
arms: median 3 turns; median output 377 vs. 469 tokens, a small fraction of the
12k gap).

### 3.3 This harness pays for width entirely as fresh input — the live suite does not

`usage.cacheRead` and `usage.cacheWrite` are 0 for every row in both result
files (median and — checked separately — every individual row). The transplant
harness, run through OpenRouter against qwen-2.5-72b-instruct, gets no
provider-side prompt-cache credit here, so the full 12,168-token gap above is
billed as fresh input on every turn. This is a different cost regime from the
live Anthropic suite `reports/algorithm.md` cites for its "cache reads are
93.5% of the remaining token gap" figure (`eval/plans/loop9-item3-sw3-overhead.md`,
the sw-3-refactor decomposition: ≈69.5% re-read tax from extra turns, ≈24.0%
Zone A per-turn overhead, ≈6.5% everything else — **not a branch-count
sweep**; sw-3-refactor's `tree` vs. `native` comparison holds branch count
fixed and varies turn count and Zone A wording). Two regimes, not one number:

- **No caching (this fixture, OpenRouter/qwen):** every visible summary is
  repriced at full input cost on every turn. The §3.2 arithmetic is the whole
  story — cost scales linearly with (visible summaries) × (turns).
- **Caching (the live Anthropic suite):** a stable Zone B is cache-*read*
  (~10× cheaper per `reports/metrics/loop8-interim.md`'s own framing of the
  term), so the same 9 extra summaries cost far less per turn *as long as the
  prefix does not change*. `reports/metrics/context-tree-long-task-dsa-iterations.md`
  §5 measured the failure mode directly: **every** re-summarize pass rewrites
  Zone B's text and invalidates the whole cached prefix, producing 7.7k–27.4k
  cache-write tokens per run where native pays 0. So the true cost of width
  under caching is not "N branches × K tokens", it is "N branches × K tokens,
  amortized across turns until the next summarize pass, then re-written once
  at roughly the cache-write rate" — a coupling between this dimension (how
  many summaries) and dimension 3 (when summaries are (re)written), not a
  fact about width alone. Neither loop9-item3 nor the DSA-arm reports isolated
  a caching-regime width sweep the way the transplant fixture isolates a
  no-caching one; that experiment does not exist yet.

**Conclusion for (b):** width has a real, measured, linear-in-visible-count
cost (~465 heuristic tokens/summary/turn, confirmed against directly measured
usage to within 3%). Whether that cost is paid at full price or at
cache-read/cache-write price depends entirely on dimension 3's policy, which
this pass does not re-litigate — but it means a width policy cannot be tuned
in isolation from a summarization-timing policy without risking measuring the
wrong regime.

## 4. (c) The three candidate policies

### 4.1 Fit-derived (`deriveRootKeep`, already implemented)

**What it is.** Walk a fixed ladder, return the first rung whose predicate
— "does the real assembled Zone B fit its budget with ≥1 branch surviving" —
passes (`transplant.mjs:450-458`). Already dynamic per window and per store: at
16,384 it converges both arms to keep=2 (1 branch visible); at 32,768 it
diverges to keep=16 (`tree`) or keep=2 (`tree-wide`) depending on walk
direction (§1.1). It needs no notion of task difficulty and is already
unit-tested (`transplant.test.ts:167-279` per
`eval/plans/portability-audit/03-transplant.md:15`).

**What this pass adds: fit-derived answers "how many CAN fit," not "which
allocation of what fits should be shown."** There is more than one way to
spend a fixed Zone B budget that all satisfy "fits, ≥1 branch survives" — more
headlines and fewer full bodies, or fewer headlines and more full bodies — and
`deriveRootKeep` does not choose between them on its own; a human chose two
ladder *directions* (`ARM_ROOT_LADDER`, `transplant.mjs:398-410`) as two
separate arms. The measured data says this choice matters: same store, same
window, same budget, and the body-maximizing direction (`tree-wide`) scores
0.333 against the headline-maximizing direction's (`tree`, the shipped
default) 0.091 on the one stratum where either scores above zero (§2). So
"fit-derived" as currently specified under-determines the outcome — it fixes
the ceiling, not the allocation beneath it — and the allocation is still a
manual arm selection today, which is exactly the kind of choice D19's own
rationale (`reports/algorithm.md` rule 3/4) says should come from measurement
rather than from which ladder direction someone happened to write.

**What would falsify it** (as a *sufficient* policy, not as the ceiling
mechanism, which is not in question): a case where the largest-fits rung
scores worse than a deliberately narrower one at the same window and budget —
already true here (`tree`'s keep=16/2-visible loses to `tree-wide`'s keep=2/
11-visible on head). Fit-derived-as-ceiling is not falsified; fit-derived
*without a stated allocation rule* is.

**Cheapest experiment to resolve the allocation question:** none new is
needed to notice the effect (§1–§2 already show it); what is missing is
replication. The existing `s1` fixture has only one scenario, one window where
both directions differ, and n=3 distinct head questions. The cheapest next
step is not a new mechanism but a second scenario (or a second window past
32,768, if one is added) run through the *same* two ladder directions,
holding everything else fixed — reusing `deriveRootKeep` and `ARM_ROOT_LADDER`
exactly as they exist today, zero new code. If body-maximizing keeps winning
on head-type questions across scenarios, that promotes "walk the ladder to
maximize `branchesSurviving`, not `rootKeep`" from a one-fixture observation to
a default; if it does not replicate, the headline-rich default stands as
argued in `JUDGE-VERDICT.md`.

### 4.2 Demand-driven (widen when the model searches or fetches)

**What it is.** Per `reports/algorithm.md`: widen only when the model reveals
it needs breadth by calling `context_search`/`context_fetch`, rather than
estimating need in advance — the same argument that removed the turn ceiling.

**What the per-call logging already shows.** Every transplant row records
`searched`/`fetched` booleans. On the head stratum at W=32,768 (the one
stratum with signal), completed rows search at similar rates under both
widths: `tree` (2 visible) searches on 8/11 completed rows (73%); `tree-wide`
(11 visible) searches on 8/9 (89%) (computed from both result files' `searched`
field, filtered to `status=='completed'`, `stratum=='head'`). The narrow arm
is not failing to search — it searches nearly as often as the wide arm — and
still scores 0.091 against 0.333. `questions.json`'s own precomputed
`self_retrieval.rank` field (a static ranking of which branch would surface
first for each question under the harness's lexical scorer) shows why: the
two head questions with the lowest scores have `rank: 15` and `rank: 15`
(`s1-q01-head`, `s1-q03-head`; the third, `s1-q02-head`, ranks 11) out of ~19
candidate branches — inside the default `retrieval.limit=20`
(`packages/core/src/config.ts:119`) but far from the top of it. A model that
searches and gets back a low-ranked hit does not know from that alone that it
should have asked for more width; the signal "I searched" does not distinguish
a search that worked from one that returned something in the tail of the
result list.

**What would falsify demand-driven as specified:** exactly this — narrow-width
runs that search but still miss, at a similar search rate to wide-width runs
that also search and hit. That is what the data above shows, at n=11 (tree)
and n=9 (tree-wide) completed head rows. It does not falsify a *refined*
version keyed on search *confidence* (e.g., trigger a widen when the top hit's
rank/score is weak) rather than search *occurrence* — that refinement is
untested, because nothing in this repository logs a live confidence score
alongside the call, only the precomputed offline `self_retrieval.rank` used to
build the question set in the first place.

**Cheapest experiment to separate this from fit-derived:** a purely offline
one, no live calls. Cross-reference each row's `searchQueries` against its
question's `self_retrieval.rank` (both already on disk, in the results files
and `questions.json` respectively) and check whether score correlates with
rank *among rows that searched* — if it does, a rank/confidence-triggered
widen policy is worth building; if score is uncorrelated with rank even when
the model searched, the miss is in how search results get used, not in
whether width should have grown, and demand-driven would not have helped
either. This pass did not run that correlation; it is the next cheap step, and
it costs nothing but reading files already produced.

### 4.3 User-selected (an effort dial)

**What it is.** A user- or caller-set width parameter, explicitly named in
`reports/algorithm.md` as "a reasonable escape hatch but must not be the
mechanism."

**What the data says against it as a default.** §2's stratum breakdown is a
direct falsifier for *any single fixed width being right for a whole task*:
going from 2 to 11 visible summaries helped head questions (0.091 → 0.333) and
changed nothing for tail, deep or spanning (flat at 0.000, both widths). A
user who set the dial once per session — the only way an effort dial can work,
since nothing about a dial's affordance lets it change per-question inside one
turn sequence — would have to pick a width that is either too narrow for the
head-type questions in the session or (per §3) paying the ~465-token/summary/
turn cost in §3.2 on every turn regardless of whether the current question
needs it. The within-session heterogeneity this dataset already shows is
enough to argue against a session-level dial without any new run.

**What would falsify the "must not be the mechanism" verdict:** evidence that
task type is knowable in advance and stable within a session, so a user or
caller genuinely could set the right dial once. Nothing in this repository
measures that; it would require labeling scenarios by question-mix ahead of
time and showing the mix doesn't change mid-session, which none of the current
scenarios are built to test (`s1`'s 4-stratum question set is drawn from one
frozen trace, not a live session where composition could be observed and
declared up front).

**Cheapest experiment:** none is proposed, because the falsifier above is not
a width experiment — it is a claim about session composition that has to be
checked before an effort dial is worth building at all, and no scenario here
carries the metadata (a per-turn label of "what kind of question is coming")
that would let it be checked.

## 5. Does the fit-derived maximum make the other two unnecessary?

**No, not as it stands, and the reason is narrower than either alternative
policy.** Fit-derived correctly makes the *ceiling* — how many summaries could
possibly be shown — a function of the window and the store, with no guessed
constant (§4.1, confirmed at both windows in this fixture). But the measured
data in §1–§2 shows that "fits" is satisfied by more than one allocation of
the same budget, and which allocation wins is not decided by fit-derived
itself; today it is decided by which ladder direction a human wrote into
`ARM_ROOT_LADDER`. That gap is not filled by demand-driven (§4.2's evidence
says search *occurrence* does not track the actual bottleneck) or by
user-selected (§4.3's evidence says no single width serves a whole session).
It is filled, if anything, by measuring the allocation question directly and
promoting the winner — which is a fit-derived-shaped fix (replace "walk this
one hand-picked ladder direction" with "walk toward maximizing
`branchesSurviving` subject to the same fits-predicate"), not a reason to add
either alternative policy. On present evidence: keep fit-derived as the
ceiling mechanism, treat the headline-vs-body allocation as its one remaining
open parameter, and replicate §4.1's cheap experiment on a second scenario
before changing the shipped (`tree`, headline-rich) default.

## Sources

- `reports/algorithm.md` — the four rules, the dimension's framing, the tier-2
  `root keep` row.
- `eval/plans/portability-audit/01-core.md`, `03-transplant.md` — no window
  representation in `packages/core`; the D19 derivation functions and where
  they are sound.
- `eval/scripts/transplant.mjs:120,385-469` — `ROOT_KEEP_LADDER`,
  `ARM_ROOT_LADDER`, `deriveRootKeep`.
- `eval/fixtures/transplant/s1/e1b289c32f40/{manifest.json,gates.json,
  root-ladder.json,questions.json}` and `results/run-W{16384,32768}-*.json`.
- `eval/fixtures/transplant/s1/store/tree.db` (`node_summaries`, `nodes`) — 21
  branch summaries, exact cl100k counts computed with `gpt-tokenizer` for this
  pass.
- `eval/fixtures/transplant/JUDGE-VERDICT.md:146-171` (R3–R6) — why the
  predicate assembles the real prompt, why `tree-wide` is a pre-registered
  ablation and not a symmetric alternative, and the 16k cell's retrieval-only
  caveat.
- `reports/metrics/context-tree-dsa-arm-experiments.md` §4,
  `context-tree-long-task-dsa-iterations.md` §4 — the two branch-pruning
  arms that never fired (different question: how few, not how many).
- `eval/plans/loop9-item3-sw3-overhead.md` — the 93.5%-cache-read
  decomposition, cited here only to show it is a turn-count/Zone-A finding,
  not a width finding.
- `reports/metrics/context-tree-long-task-dsa-iterations.md` §5 — the
  cache-write-on-rewrite mechanism coupling this dimension to dimension 3.
- `packages/core/src/assemble/assembler.ts:241-256` — rule-4 drop-oldest and
  the root's exemption from it, confirming the R4/R5 rationale in
  `JUDGE-VERDICT.md`.
