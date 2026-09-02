# Experiment 1 — the ladder allocation curve, and rank-vs-score correlation

DS-STAR dimension 1 (visible branch count), iteration 2 (experiment). Prior
analysis: `eval/plans/tuning/01-branch-count.md`. That pass found that the
fold-ladder rung (`rootKeep`, how many recent branches get an individual
headline in the root index) and the number of rendered branch-summary
**bodies** (`branchesSurviving`, how many branches get their full summary
text as a separate Zone B block) move in *opposite* directions as the ladder
is walked, and that which allocation the shipped code uses is decided by a
hand-picked **walk direction** (`tree` walks the ladder `[40,16,12,8,6,4,2]`
large-to-small; `tree-wide` walks it reversed) rather than by measurement. It
named two offline, zero-cost next steps. This report runs both.

**Hypothesis under test:** (a) the rung that maximizes `branchesSurviving`
subject to "fits" can be found directly by walking the real assembler at
every rung, and that rung is not reliably the one either shipped arm already
uses; (b) a demand-driven policy refined to trigger on search *confidence*
(the retrieval rank of the answer's branch) would have signal to key on,
where demand-driven-on-*occurrence* was already refuted.

## Method

Script: `eval/scripts/ladder-curve.mjs` (`node eval/scripts/ladder-curve.mjs`).
Zero model calls: the store's summaries were written once, long before this
script runs, and the script never calls an LLM — it only re-assembles
already-written summaries through the real `ZoneAssembler`
(`packages/core/src/assemble/assembler.ts`) and reads JSON already on disk.

- **(a)** copies `eval/fixtures/transplant/s1/store` (31 MB: `trace.jsonl`,
  `blobs/`, `tree.db`) to a temp directory (`mkdtemp` under the OS temp root)
  and works only on the copy, because `composeRootSummary` appends a new root
  summary *version* (D3 — versions are never overwritten) whenever a rung not
  already composed on that exact store object is requested, and this
  experiment recomposes the root at all 7 ladder rungs on all 5 windows (35
  assemblies). For each window in `{8192, 16384, 32768, 65536, 200000}`
  (`NESTING_WINDOWS`, already defined in `transplant.mjs`) and each rung in
  `ROOT_KEEP_LADDER = [40, 16, 12, 8, 6, 4, 2]`, it derives the window's
  budgets (`deriveBudgets`, D19's fixed fractions ÷ the measured heuristic→BPE
  ratio, read from `manifest.json`'s `ratio: 0.850896663206653` — not
  reguessed), composes the root at that rung, assembles the real prompt, and
  records: whether it fits (`overBudget.length === 0 && branchesSurviving >=
  1` — the exact predicate `deriveRootKeep`'s injected `fitsRoot` already
  uses, not a proxy), the rendered root-block token count, how many distinct
  branches got a full Zone B body, the rendered Zone B total, and the L0
  sequence range those visible bodies cover.
- **(b)** reads `questions.json`'s `self_retrieval.rank` per question (a
  static, precomputed lexical-retrieval rank of the branch that contains the
  answer, among ~19 candidates — already on disk, not recomputed here) and
  joins it against `score` (0/1, exact-match judge) for every row in the 5
  full-rep `results/run-*.json` files whose `status` produced a score
  (`model_call_error`/`turn_cap` rows carry `score: null` and are excluded,
  same rule the prior analysis used). The `smoke-*.json` files (n=1–3 sanity
  runs across throwaway models) are excluded — pooling a diagnostic run with
  the measured dataset would misstate n.

**Verified hermetic:** `shasum -a 256` on `store/tree.db` and `store/trace.jsonl`
before and after the run are identical, and `git status` on
`eval/fixtures/transplant/s1` shows no new changes from this run. The frozen
fixture was read, never written.

## (a) The whole allocation curve

n = 35 real assemblies (5 windows × 7 rungs), each a single deterministic
measurement (no repetition needed — the assembler is a pure function of
store + budgets + rung).

| window | rung (keep) | fits | root block (tok) | branches surviving | Zone B rendered (tok) | seq range visible |
|---:|---:|:--:|---:|---:|---:|---|
| 8192 | 40 | no | 6917 | 0 | 6917 | — |
| 8192 | 16 | no | 6095 | 0 | 6095 | — |
| 8192 | 12 | no | 4771 | 0 | 4771 | — |
| 8192 | 8 | no | 3967 | 0 | 3967 | — |
| 8192 | 6 | no | 3538 | 0 | 3538 | — |
| 8192 | 4 | no | 3105 | 0 | 3105 | — |
| 8192 | 2 | no | 2587 | 0 | 2587 | — |
| 16384 | 40 | no | 6917 | 0 | 6917 | — |
| 16384 | 16 | no | 6095 | 0 | 6095 | — |
| 16384 | 12 | no | 4771 | 0 | 4771 | — |
| 16384 | 8 | no | 3967 | 0 | 3967 | — |
| 16384 | 6 | no | 3538 | 0 | 3538 | — |
| 16384 | 4 | no | 3105 | 0 | 3105 | — |
| 16384 | **2** | **yes** | 2587 | **1** | 3623 | 732–754 |
| 32768 | 40 | no | 6917 | 0 | 6917 | — |
| 32768 | **16** | **yes** | 6095 | **2** | 7633 | 639–754 |
| 32768 | 12 | yes | 4771 | 5 | 7346 | 554–754 |
| 32768 | 8 | yes | 3967 | 6 | 7058 | 489–754 |
| 32768 | 6 | yes | 3538 | 8 | 7503 | 428–754 |
| 32768 | 4 | yes | 3105 | 10 | 7572 | 390–754 |
| 32768 | **2** | **yes** | 2587 | **11** | 7569 | 359–754 |
| 65536 | **40** | **yes** | 6917 | 19 | 15022 | 262–754 |
| 65536 | 16 | yes | 6095 | 19 | 14200 | 262–754 |
| 65536 | 12 | yes | 4771 | **21** | 14775 | 1–754 |
| 65536 | 8 | yes | 3967 | 21 | 13971 | 1–754 |
| 65536 | 6 | yes | 3538 | 21 | 13542 | 1–754 |
| 65536 | 4 | yes | 3105 | 21 | 13109 | 1–754 |
| 65536 | **2** | **yes** | 2587 | **21** | 12591 | 1–754 |
| 200000 | **40** | **yes** | 6917 | **21** | 16921 | 1–754 |
| 200000 | 16 | yes | 6095 | 21 | 16099 | 1–754 |
| 200000 | 12 | yes | 4771 | 21 | 14775 | 1–754 |
| 200000 | 8 | yes | 3967 | 21 | 13971 | 1–754 |
| 200000 | 6 | yes | 3538 | 21 | 13542 | 1–754 |
| 200000 | 4 | yes | 3105 | 21 | 13109 | 1–754 |
| 200000 | 2 | yes | 2587 | 21 | 12591 | 1–754 |

(Bold marks the rung the shipped `tree` arm would land on — `tree` walks
`[40,16,12,8,6,4,2]` and stops at the first "fits" — and, separately, the
rung with the most branches surviving at that window.) 21 is the ceiling: the
frozen store has exactly 21 phase/branch nodes, so 21 is "every branch has a
full body," not a budget-derived number.

### Per-window: which rung maximizes branches-surviving subject to fitting

| window | Zone B budget (tok) | `tree`'s rung (bodies) | `tree-wide`'s rung (bodies) | max-bodies rung (bodies) | matches a shipped arm? |
|---:|---:|---|---|---|---|
| 8192 | 1,925 | dead (no rung fits) | dead | dead | — |
| 16384 | 3,850 | keep=2 (1) | keep=2 (1) | keep=2 (1) | both (they coincide) |
| 32768 | 7,701 | keep=16 (2) | keep=2 (11) | keep=2 (11) | `tree-wide` |
| 65536 | 15,403 | keep=40 (19) | keep=2 (21) | keep=12 (21, tied with 8/6/4/2) | `tree-wide` reaches the tied max (21) too, via a different rung than the one this scan reports first |
| 200000 | 47,009 | keep=40 (21) | keep=2 (21) | keep=40 (21, tied at every rung) | both (every rung ties at 21) |

**Reading the curve:**

- **8192 is a dead cell for every rung.** The root block alone (2,587–6,917
  tokens depending on rung) already exceeds the window's entire 1,925-token
  Zone B budget at every rung on the ladder, so `overBudget` includes `B` even
  at the smallest rung and zero branches ever survive. This is not a
  ladder-direction question at all — no direction produces a usable Zone B at
  this window, on this store. (This matches `transplant.mjs`'s own comment
  that a dead cell should be reported, never forced.)
- **16384 has exactly one rung that fits at all** (keep=2), so `tree` and
  `tree-wide` coincide by construction — confirming what the original
  analysis inferred (§1.1) from `gates.json` without walking every rung.
- **32768 is the one window in this fixture where the two shipped arms
  genuinely diverge**, and here the max-bodies rung (keep=2, 11 bodies) is
  exactly `tree-wide`'s rung — it is not a third, undiscovered allocation.
  `tree`'s rung (keep=16, 2 bodies) is the worst-performing "fits" rung on
  this axis: every smaller rung on the ladder ties or beats it on
  `branchesSurviving` once it fits at all (5, 6, 8, 10, 11 bodies at
  keep=12/8/6/4/2 respectively — the table's middle five rows are new data
  this pass adds; the prior analysis had only the two endpoints, 2 and 16).
- **65536 is the one window where "walk toward the largest keep that fits"
  (`tree`'s literal rule) leaves bodies on the table that a fits-maximizing
  rule would not.** `tree` stops at keep=40 (19 bodies) because keep=40 is
  the *largest* rung that fits — but keep=12 already reaches the ceiling of
  21 bodies (all branches), and keeps doing so all the way down to keep=2.
  `tree-wide` (which stops at the *smallest* fitting rung, keep=2) also
  reaches 21, just via a different keep than a "prefer the largest keep at
  the max body count" tie-break would report first. Either way, `tree`
  specifically is the one arm that leaves 2 branches un-rendered here for no
  benefit — it does not buy extra headline coverage over keep=16 (both show
  19 bodies; the difference between keep=40 and keep=16 is entirely root
  block size, not branch coverage) and it costs 2 fewer branch bodies than
  keep=12 and below.
- **200000 makes the tension disappear entirely.** Every rung ties at 21
  bodies (every branch fits, regardless of how much room the root block
  eats), so `tree` and `tree-wide` render an *identical* branch set — only
  the root headline formatting differs between them. At sufficiently large
  windows, "headline-rich vs. body-rich" is not a real trade-off on this
  store; there just isn't enough content (21 branches) to make root-block
  size compete with branch bodies for budget.

**What this settles from the analysis's open question:** "does fit-derived
under-determine the allocation" — yes, confirmed, but **only inside a narrow
band of window sizes** (here: 32768, and partially 65536) where the root
block's own size is large enough, relative to the Zone B budget, to actually
compete with branch bodies for room. Below that band (8192) nothing fits, so
the allocation question is moot; above it (200000, and to a lesser extent
65536) there is enough budget that every rung converges to the same branch
set, so the allocation question is also moot, just for the opposite reason
(abundance instead of scarcity). This is new information beyond the original
analysis, which had only the two endpoints of the ladder at one window
(32768) and did not know whether the divergence would persist, widen, or
vanish as the window changed — it vanishes at both ends and is real only in
the middle.

## (b) Rank-vs-score correlation among rows that searched

n = 384 completed rows joined across the 5 full-rep result files (`score`
not null); of those, **n = 120 searched**, **n = 264 did not search**. The
"searched" set is not evenly spread across cells — it is composed of three
(arm, window, model) groups: `tree` W=16384 openai/gpt-3.5-turbo (47 rows),
`tree-wide` W=32768 qwen-2.5-72b-instruct (40 rows), `tree` W=32768
qwen-2.5-72b-instruct (33 rows). `naive-full`, `truncate-tail`, and
`compact-rolling` rows show `searched: false`/`null` throughout — only the
tree-family arms expose the MCP tools at all in this harness, so this
correlation is inherently scoped to tree-family behavior, which is exactly
the population a demand-driven *tree* policy would apply to.

**Pearson r (self_retrieval.rank vs. score), rows that searched: 0.062
(n=120).** For contrast, rows that did not search: r = −0.234 (n=264) — a
weak negative slope in the "expected" direction (worse rank → worse score)
that is nonetheless not present at all in the searched group.

Per-question breakdown (searched rows only, sorted by rank — rank 1 is the
best possible lexical match, rank 17 the worst observed):

| question | stratum | rank | n searched | mean score |
|---|---|---:|---:|---:|
| s1-q07-deep | deep | 1 | 6 | 0.000 |
| s1-q11-spanning | spanning | 2 | 11 | 0.000 |
| s1-q06-tail | tail | 5 | 11 | 0.000 |
| s1-q10-spanning | spanning | 6 | 9 | 0.000 |
| s1-q05-tail | tail | 8 | 15 | 0.000 |
| s1-q04-tail | tail | 10 | 10 | 0.000 |
| s1-q02-head | head | 11 | 14 | 0.286 |
| s1-q08-deep | deep | 11 | 6 | 0.000 |
| s1-q12-spanning | spanning | 11 | 10 | 0.000 |
| s1-q01-head | head | 15 | 9 | 0.000 |
| s1-q03-head | head | 15 | 7 | 0.000 |
| s1-q09-deep | deep | 17 | 12 | 0.000 |

**Reading this:** rank has no usable relationship with score among rows that
searched, and the reason is visible directly in the table, not just in the
aggregate r. `s1-q07-deep` has the *best possible* retrieval rank (1 — the
answer's branch would be the very first hit) and still scores 0.000 across
all 6 searched attempts. Three of the four strata (tail, deep, spanning — 9
of the 12 questions) score exactly 0.000 across every rank value from 1
through 17, with no exceptions. The only stratum with any nonzero score at
all is head, and even there the pattern does not track rank cleanly: rank 11
(`s1-q02-head`) scores 0.286 while rank 15 (`s1-q01-head`, `s1-q03-head`,
worse rank) scores 0.000 — consistent with rank mattering *within* head, but
that is one question's worth of signal (n=14 rows) inside a stratum that is
already known (from the original analysis, §1.2) to be the sole stratum
where width or retrieval quality moves the score at all.

**What this says about the demand-driven policy:** the prior analysis
refuted demand-driven-on-*occurrence* — models search about as often whether
narrow or wide, and searching doesn't reliably produce a hit. This pass tests
the natural refinement, demand-driven-on-*confidence* (widen only when the
search result looks weak), and **that is refuted too, by the same
mechanism**: confidence (measured here by retrieval rank, the only
confidence-shaped signal already on disk) is swamped by a floor effect in 3
of 4 strata that no amount of confidence-based widening could fix, because
(per the original analysis's boundary-table finding) the answer literal
simply is not present in any summary's text for those strata — width or
confidence-triggered width cannot surface a fact that summarization already
discarded. A rank-triggered widen policy would correctly identify `rank: 1`
as "confident" and leave Zone B narrow — and would be exactly as wrong as a
policy that treats `rank: 1` as reason to widen, because widening would not
have helped either: 0.000 is 0.000 regardless of triggered width, since the
literal isn't anywhere the extra width could put it.

## Measured vs. inferred

**Measured** (direct, in this pass): the full 35-row allocation curve at 5
windows × 7 rungs, sourced from real `ZoneAssembler` output against the
frozen store; the Pearson correlation and per-question table in (b), sourced
directly from `questions.json` and the 5 `results/run-*.json` files.

**Inferred** (not independently re-verified in this pass, carried from the
original analysis and cited as background): that the deep/tail/spanning
floor is caused by answer literals being absent from summary text — this
pass's per-question table is consistent with that explanation (rank-1 still
scores 0.000) but does not re-run the literal-presence check itself.

## What a third iteration would do

Two things this pass could not settle, both requiring either a second frozen
scenario or new instrumentation, not a re-read of existing files:

1. **Replicate the 32768/65536 divergence on a second scenario.** This
   pass's curve is decisive about *this* store: the max-bodies rung at 32768
   is exactly `tree-wide`'s rung, and at 65536 `tree`'s own rule (largest
   fitting keep) demonstrably leaves bodies on the table. But it is one
   store's branch-size distribution (21 branches, 75–197 tokens each per the
   original analysis §3.1). A second scenario with a different branch count
   or size distribution could shift where the "narrow band" of real
   divergence sits, or make it wider or disappear. The original analysis
   named this as the cheapest way to promote a one-fixture observation to a
   default (§4.1) — this pass narrows what exactly needs replicating: not
   "does width help on head," but "does a fits-maximizing rung walk beat
   `tree`'s largest-fits rule specifically in the window band where the root
   block is large relative to the Zone B budget."
2. **A live confidence signal**, not the precomputed offline
   `self_retrieval.rank` used to build the question set. This pass's null
   result is about a retrieval-quality proxy computed before any run
   happened; it says a *policy keyed on this specific static rank* has
   nothing to key on in this fixture, not that no live signal could ever
   help. That would need a harness that logs a real retrieval score
   alongside each `context_search` call, which nothing in this repository
   does today (per the original analysis, §4.2) — out of "zero model calls"
   scope for a DS-STAR experiment step, in scope for an actual harness
   change.

## Tests run

- `npx tsc --build eval` — clean, no errors (only pre-existing npm config
  warnings, unrelated).
- `npx vitest run eval/test/transplant.test.ts` — **50/50 passed**, 0
  skipped. Run because this experiment imports `deriveBudgets`,
  `deriveRootKeep`-adjacent constants (`ROOT_KEEP_LADDER`, `ARM_ROOT_LADDER`,
  `NESTING_WINDOWS`, `contractVersionFor`) from `transplant.mjs`; no source
  file was modified by this pass, so this run is a regression check, not a
  fix verification.

No other shipped code was touched. This experiment is measurement-only: it
adds one new script (`eval/scripts/ladder-curve.mjs`) and this report; it
does not change `deriveRootKeep`, `ARM_ROOT_LADDER`, or any default. Whether
to change the shipped `tree` arm's ladder-walk rule from "largest fitting
keep" to "keep maximizing branchesSurviving subject to fitting" is a decision
this report hands back per §5 of the original analysis, now with the full
curve instead of two endpoints — it is not made here, since the algorithm
doc's own rule 4 requires holding a change to a second scenario's replication
first (see "What a third iteration would do," item 1), and this pass ran
against only the one frozen scenario (`s1`).

## Sources

- `eval/plans/tuning/01-branch-count.md` — the iteration-1 analysis this
  pass's two experiments were named by (§4.1's "cheapest experiment," §4.2's
  "cheapest experiment to separate this from fit-derived").
- `eval/scripts/ladder-curve.mjs` — this pass's script (new file).
- `eval/scripts/transplant.mjs` — `ROOT_KEEP_LADDER`, `ARM_ROOT_LADDER`,
  `NESTING_WINDOWS`, `deriveBudgets`, `contractVersionFor` (imported, not
  modified); `assembleTreeAt`/`fitsRoot`/`seqRangeOf` (not exported —
  reimplemented locally in `ladder-curve.mjs` against a copied store rather
  than the frozen fixture path those functions are wired to).
- `packages/core/src/assemble/assembler.ts` — `ZoneAssembler`, the real
  Zone B/C assembly this pass's `fits` predicate runs against.
- `packages/core/src/summarize/compose-root.ts` — `composeRootSummary`, the
  D3 versioning behavior that is why this pass copies the store instead of
  assembling against the frozen one directly.
- `eval/fixtures/transplant/s1/e1b289c32f40/{manifest.json,questions.json,
  results/run-*.json}` — the ratio, the `self_retrieval.rank` per question,
  and the scored rows this pass reads (never writes).
