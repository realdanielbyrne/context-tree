# Dimension 2 — how deep a branch goes before it is summarized

DS-STAR tuning pass · dimension 2 of 4 named in `reports/algorithm.md`'s "What
the DS-STAR loop is for" · zero live model calls, zero spend · every number
below is either a `file:line` citation or computed directly from the frozen
store at `eval/fixtures/transplant/s1/store/` (SQLite `tree.db`, `trace.jsonl`,
`blobs/`) or the compiled segmenter (`packages/core/dist/segment/segment.js`)
run against it in this pass.

## Abstract

A branch's depth is not a decision anyone made; it is whatever the segmenter's
tool-name-to-phase map and Ruling C6's neutral-merge rule happen to produce
from a given trace, and on the one frozen store this repository has actually
measured, that produces a 77-fold spread: 21 branches over 754 events, with
raw sizes from 2,214 to 170,031 characters (roughly 471 to 36,170 measured
BPE tokens). The largest, an `implementation` branch spanning 207 raw events
(55–261), is bigger on its own than the entire 32,768-token window it was
being retrieved into in the transplant experiment — confirmed here down to
the tool level: 64 `Bash` calls and 2 `Skill` calls inside it map to the
neutral `other` phase and never close it, while every non-neutral call inside
it maps to the same `implementation` type, so nothing in the current rule
ever asks it to close across 22 alternating tool-identity runs. Three of the
twelve transplant questions source from exactly this branch, and it is the
only one of 21 that exceeds any tested window on its own. Re-segmenting the
same 754 events under a rule already present in the code — `neutralPhases:
[]`, which the segmenter's own contract calls "the literal §7 rule" — is a
zero-guesswork, config-only change (no new code, no size threshold) that
produces 99 branches instead of 21, a median size of 3 events instead of 17,
and eliminates the over-window branch entirely: every one of the twelve
questions now sources from a branch that fits inside every tested window,
including the previously oversized one. That is a real, measured fix for the
"leaf larger than W" boundary condition `reports/algorithm.md` already lists
as found-but-untested-live. It is not free: a 4.7× increase in branch count
is a comparable increase in leaf-summarizer calls, and two independent
reports already established that leaf-summarizer passes are the dominant
line item in the tree's remaining cost disadvantage against the native
baseline. Section 4 walks the one report that actually forensically
classified retrieval failures on this store and finds that granularity, as a
*measured* cause, explains close to none of the sampled failures — the
oversized branch is a confirmed structural risk that never actually
manifested as a truncated fetch, because models essentially never fetched it
at full depth at all. Section 5 gives the offline procedure — already run
once, here — for ranking further candidate segmentations against tokens and
per-question containment before any of this is worth a live run.

## 1. The segmenter's actual rule, and why depth is a side effect, not a setting

`segment()` (`packages/core/src/segment/segment.ts`) opens a phase node on the
first `tool_call`, and on every subsequent `tool_call` decides whether to
close the open phase and start a new one with one condition:

```
packages/core/src/segment/segment.ts:176-177
} else if (!neutral.has(phaseType) && open.phaseType !== phaseType) {
  // The literal §7 rule, but only for non-neutral phases (Ruling C6):
```

`neutral` is `new Set(config.neutralPhases)` (`segment.ts:63`), and the
shipped default is `neutralPhases: ['other']`
(`packages/core/src/config.ts:112-114`). A phase stays open across any run of
tool calls that either (a) keep mapping to the same non-neutral type, or (b)
map to `other` — which never triggers a close regardless of how many events
accumulate. The tool→phase map itself (`DEFAULT_TOOL_PHASE`,
`packages/core/src/config.ts:17-42`) is a fixed table of 20-odd entries with
`Bash`/`run_command` explicitly pinned to `other`, "explicitly neutral"
(`config.ts:40-41`); this repository's own `context-tree.config.json` (the
config that produced the frozen store, since it comes from ingesting a real
session in this repo) adds `Skill`/`ToolSearch` to `other` on top. So depth is
the joint product of two things nobody tuned against a metric: which types
the host's tools happen to map to, and how long a real task happens to stay
inside one type (or inside `other`) before switching.

`SegmentConfig`'s own doc comment already names the one config-only
alternative that exists today, with no code change required:

```
packages/core/src/contracts/segment.ts:55-58
 * Phases that attach to the open phase instead of opening a new one
 * (Ruling C6). Default `['other']`; `[]` restores the literal §7 rule.
```

Section 3 measures that alternative directly.

## 2. The frozen store's branch distribution, measured

`eval/fixtures/transplant/s1/store/tree.db` holds one task root, 21 `phase`
nodes and 24 `file` nodes over a 754-event trace (`SELECT kind, count(*) FROM
nodes GROUP BY kind`). By type: `implementation` ×10, `diagnosis` ×7,
`delivery` ×4 — `verification` and `review` never appear in this trace at all
(`SELECT phase_type, count(*) ... WHERE kind='phase' GROUP BY phase_type`).

Raw size per branch was computed by summing the byte size of every event's
blob(s) (`blob`/`args_blob`/`output_blob`) across its `span_start_seq..
span_end_seq` range — the same content `renderSpans`
(`packages/core/src/retrieve/detail.ts:114-122`) concatenates, so this is the
same quantity a `context_fetch depth:'full'` call would return, modulo
per-event formatting overhead `renderSpans` adds on top. Cross-checked
against the one branch where an independent, exact figure already exists in
the record (below): the estimate matches within 0.02%.

| Statistic | Events | Raw chars | Est. tokens (chars÷4) | Est. exact tokens (×0.851 ratio) |
| --- | ---: | ---: | ---: | ---: |
| min | 2 | 2,214 | 553 | 471 |
| Q1 | 10 | 5,284.5 | 1,321 | 1,124 |
| median | 17 | 23,515 | 5,879 | 5,002 |
| Q3 | 52.5 | 34,923 | 8,731 | 7,429 |
| max | 207 | 170,031 | 42,508 | 36,170 |

n = 21 branches. The 0.851 ratio is this store's own measured
heuristic-to-BPE ratio (`gates.json`: `"ratio": 0.850896663206653`, "over all
697 L2 blobs" — the same value `reports/algorithm.md`'s tier-2 table cites as
"derived," not a number picked for this pass. The full ranked list:

| id | phase_type | span | events | chars | est. exact tok |
| --- | --- | --- | ---: | ---: | ---: |
| `n_1E48X9HA…` | implementation | 55–261 | 207 | 170,031 | **36,170** |
| `n_1BGBV85X…` | implementation | 267–276 | 10 | 100,579 | 21,396 |
| `n_1JNW5D8C…` | diagnosis | 1–54 | 54 | 84,179 | 17,907 |
| `n_1A84WKF2…` | delivery | 639–731 | 93 | 83,410 | 17,743 |
| `n_1PPHC64K…` | implementation | 732–754 | 23 | 36,781 | 7,824 |
| `n_15NSXSQ4…` | implementation | 430–488 | 59 | 33,065 | 7,034 |
| `n_11RPJ288…` | implementation | 359–389 | 31 | 30,459 | 6,479 |
| `n_1FJ2VN7B…` | implementation | 320–349 | 30 | 28,853 | 6,138 |
| `n_1KYBBC6P…` | diagnosis | 390–412 | 23 | 24,941 | 5,306 |
| `n_1C6D33C0…` | implementation | 588–638 | 51 | 24,081 | 5,123 |
| `n_1WAD2VDY…` | diagnosis | 489–553 | 65 | 23,515 | 5,002 |
| `n_1C0BDXFH…` | implementation | 554–570 | 17 | 14,801 | 3,149 |
| `n_16BHTPNT…` | diagnosis | 282–297 | 16 | 8,523 | 1,813 |
| `n_1F6E3RF1…` | diagnosis | 262–266 | 5 | 8,301 | 1,766 |
| `n_10MK5T7J…` | implementation | 298–307 | 10 | 8,053 | 1,713 |
| `n_1NH76HCY…` | diagnosis | 571–587 | 17 | 5,426 | 1,154 |
| `n_161P8JTC…` | delivery | 308–319 | 12 | 5,143 | 1,094 |
| `n_18ZHNQYZ…` | implementation | 413–427 | 15 | 4,868 | 1,036 |
| `n_1ZDHE482…` | delivery | 350–358 | 9 | 3,854 | 820 |
| `n_1TVA5EV1…` | diagnosis | 428–429 | 2 | 3,690 | 785 |
| `n_1X4N1KJ4…` | delivery | 277–281 | 5 | 2,214 | 471 |

**The oversized branch, exactly.** `n_1E48X9HAFPEYNQHHSF609KHMEE` (seq
55–261, `implementation`) is 27.4% of the trace's 754 events in one node and
the only branch of 21 that exceeds any tested window (W=32768) on its own.
This is the branch `eval/plans/loop9b-item2-judge-verdict.md:65` already
measured with the exact tokenizer, not an estimate: `170,031` chars,
`36,170` cl100k tokens, "no — larger than W" — matching this pass's
independently-computed estimate (36,174) to four significant figures, which
is the cross-check cited above. Three of the twelve transplant questions
source from this one branch: `s1-q01-head` (seq 175), `s1-q07-deep` (seq 55,
the same node's opening event), and `s1-q10-spanning` (seq 173) —
`questions.json`. `reports/algorithm.md:90-91` and its boundary table
(`:260`) already name "one branch larger than the whole window" as found;
this is that branch, with its full context.

**Why it never closes.** Every `tool_call` inside seq 55–261 was one of:

| tool | count | mapped phase | neutral? |
| --- | ---: | --- | --- |
| `Bash` | 64 | `other` | yes |
| `Edit` | 12 | `implementation` | no |
| `Write` | 2 | `implementation` | no |
| `Skill` | 2 | `other` | yes |

(counted directly from `trace.jsonl`, `55 <= seq <= 261`, `type='tool_call'`).
Every non-neutral call maps to the *same* type (`implementation`), so
`open.phaseType !== phaseType` never fires; every `Bash`/`Skill` call maps to
the neutral `other`, so the close condition's other clause never fires
either. The 80 tool calls inside this span form 22 runs of alternating tool
*identity* (`Bash`→`Edit`→`Bash`→`Bash`→`Edit`… — counted by walking
consecutive-`tool` runs), which is exactly the shape a long edit-then-test
loop produces: this branch is a real, extended debugging/build cycle, and
under the current rule that entire cycle is one leaf regardless of how many
times it alternates between editing and running something.

**Deeper node kinds.** `NodeKind` includes `'turn'`
(`packages/core/src/contracts/tree.ts:11`), but nothing in
`packages/core/src` ever emits a node of that kind — `apply.ts:134` is the
only other reference, and it only excludes `'turn'` nodes from a filter,
confirming the kind is declared but not produced. The only kind deeper than
`phase` that is actually produced is `file`: 24 nodes, one per distinct
`path` touched by a file-shaped tool inside a phase
(`packages/core/src/config.ts:47-53` for `fileTools`). The deepest file node
inside the oversized branch, `build-multimod-scenario.py` (seq 55–261),
spans the *entire* phase; five siblings inside the same phase
(`loop.ts`, `loop.test.ts`, `ct-stats.mjs`, `format.ts`, `assemble.test.ts`)
start at 93, 103, 115, 159 and 180 respectively, all ending at 261 —
interleaved, not sequential, editing across six files within one 207-event
stretch. File nodes carry no summary of their own: `SELECT n.kind, count(*)
FROM node_summaries s JOIN nodes n ON n.id=s.node_id GROUP BY n.kind` returns
only `phase` (21) and `task` (1538, from repeated root recomposition across
the transplant sweep's many window/arm combinations) — zero rows for `file`.
So the finer-grained structure the store already tracks, keyed by nothing but
the tool's own `path` argument, is invisible to Zone B today; nothing deeper
than a phase is ever summarized.

## 3(a). Alternative units without a cap — one measured, others assessed

Splitting a phase once its rendered size crosses a threshold is a cap under
rule 1 the same way a turn or reply-length ceiling is: a guess about how much
work "should" fit in one unit, imposed regardless of what the unit actually
is. The question this section answers is whether a *structural* alternative
— one derived from the trace's own shape, not from a size picked in
advance — exists and what it costs.

**Measured: `neutralPhases: []`, the code's own "literal §7 rule."** This
requires no source change — `SegmentOptions` already accepts it
(`contracts/segment.ts:57`) — so it was run directly against the frozen
store's 754 events through the compiled segmenter
(`packages/core/dist/segment/segment.js`), with the same `toolPhase` map the
store was built from:

| Config | Branches | Events per branch (min/median/max) | Max branch, est. exact tok | Branches > W=32768 |
| --- | ---: | --- | ---: | ---: |
| current (`neutralPhases: ['other']`) | 21 | 2 / 17 / 207 | 36,170 | **1** |
| `neutralPhases: []` | 99 | 2 / 3 / 88 | 20,738 | **0** |

Every one of the twelve questions' source sequences was then located in the
re-segmented tree and its containing branch's estimated size checked against
W=32768:

| question | seq | current branch | fits W=32768? | `neutralPhases:[]` branch | fits W=32768? |
| --- | ---: | --- | --- | --- | --- |
| q01-head | 175 | 55–261 (36,170 tok) | **no** | 169–179 (1,358 tok) | yes |
| q02-head | 558 | 554–570 (3,150 tok) | yes | 556–570 (2,506 tok) | yes |
| q03-head | 18 | 1–54 (17,907 tok) | yes | 17–18 (7,499 tok) | yes |
| q04-tail | 728 | 639–731 (17,743 tok) | yes | 642–729 (15,648 tok) | yes |
| q05/q06-tail | 744/746 | 732–754 (7,824 tok) | yes | 734–754 (6,469 tok) | yes |
| q07-deep | 55 | 55–261 (36,170 tok) | **no** | 55–57 (5,141 tok) | yes |
| q08-deep | 559 | 554–570 (3,150 tok) | yes | 556–570 (2,506 tok) | yes |
| q09-deep | 41 | 1–54 (17,907 tok) | yes | 19–41 (2,605 tok) | yes |
| q10-spanning | 173 | 55–261 (36,170 tok) | **no** | 169–179 (1,358 tok) | yes |
| q11-spanning | 467 | 430–488 (7,034 tok) | yes | 465–484 (1,520 tok) | yes |
| q12-spanning | 691 | 639–731 (17,743 tok) | yes | 642–729 (15,648 tok) | yes |

Under the current segmentation, every question's answer literal falls inside
exactly one branch (segmentation partitions L0 by construction — this is not
new information), but 3 of 12 (q01, q07, q10) fall inside a branch that
cannot fit the transplant experiment's own W=32768 window even alone. Under
`neutralPhases: []`, all twelve fall inside a branch that fits comfortably —
including the ones that previously didn't. This is a real, structural,
zero-size-threshold fix for the specific boundary condition
`reports/algorithm.md` lists as found: it works because it stops treating
`other`-mapped tool calls as free glue that can extend a phase indefinitely,
which is exactly the mechanism §2 identified as why the oversized branch
never closed.

**It is not free, and the cost side is unmeasured.** 99 branches against 21
is a 4.7× increase in what the leaf summarizer would be asked to summarize
(median branch size falls from 17 events to 3, which is close to the size a
single tool-call-plus-result pair produces — summaries this granular may
also simply be less useful per token spent on them, an effect this pass has
not measured). Two independent reports already identify leaf-summarizer
calls as the largest lever on the tree's cost disadvantage:
`reports/metrics/context-tree-long-task-dsa-iterations.md` §5 attributes
"why more money" on long tasks to, first among three causes, "root
summarizer passes at sonnet prices on every lazy-threshold crossing" plus
per-node retry billing; `eval/plans/tuning/03-summary-policy.md` §3(c)
measures the leaf summarizer's own share of run cost directly at a median of
9.4% of total run cost when it fires at all (n=6), rising as high as 19.3% on
one replicate, entirely from batching branches that closed during devolved
mode into one pass. A 4.7× increase in branch count is not a 4.7× increase in
that share by itself (summary size is capped independent of branch count,
`maxSummaryTokens=1,024`, `config.ts:118`), but it is a 4.7× increase in the
*number* of calls, each carrying its own request/response overhead and its
own chance of a §8 contract failure (the "same node re-billed 3× in one run"
defect logged in the same long-task report, §5/§6). Whether the retrieval
gain (§4 below) is worth that is exactly the "which fraction/setting wins"
measurement rule 4 asks for, and it has not been run.

**Other candidates, not measured here.**

- *Promote `file` nodes to a second, summarized unit.* The store already
  tracks per-path sub-spans at zero guessing cost (§2), but this pass's own
  data shows the giant branch's six file nodes are heavily interleaved
  (overlapping start seqs, all sharing the same end seq), so a naive
  "one file = one unit" split would not cleanly partition that branch's 80
  tool calls into six clean pieces — it would need to interleave the same
  way the events do, which is closer to re-deriving `neutralPhases: []`'s
  result from a different axis than it is to a genuinely new mechanism.
  Unexplored.
- *Reclassify `other`-mapped tools by command content, not tool name.* The
  giant branch's 64 `Bash` calls are plausibly a mix of test runs (which
  `DEFAULT_TOOL_PHASE` already has a category for — `verification`, unused
  in this trace) and everything else Bash is used for. `toolPhase` is
  already host-remappable config (rule 3's own recommended shape), but
  today's segmenter classifies purely by `event.tool`, never by
  `event.args`/the command string — teaching it to recognize
  `npm test`/`pytest`/`vitest run`-shaped commands as `verification` instead
  of `other` is a plausible, non-guessed, per-host-derivable lever (the
  detection procedure would ship and be re-run per host, the same shape as
  the heuristic-to-tokenizer ratio), but it is a segmenter change, not a
  config toggle, and is unexplored here.
- *A fraction of W.* Ruled out by this pass's own framing: a phase that
  closes once its rendered size crosses any threshold, fixed or
  window-derived, is a cap on the unit itself, the class rule 1 targets.
  Rule 4's endorsement of window-fractions is for *budgets that trade off
  against a metric* (Zone B/C size, root keep) where the tradeoff is
  measured — nothing here has measured whether a size-triggered close wins
  against `neutralPhases: []`'s structural trigger, so even if this were
  reconsidered as a rule-4-style budget rather than a rule-1-style cap, it
  would need the same offline ranking §5 describes before being proposed.

## 4(b). Which retrieval failures are attributable to branch granularity

`eval/plans/loop9b-analysis/01-run-forensics.md` classified all 135 sampled
model-turn transcripts on this exact store into six mechanisms (§8 of that
report). None of its six categories is "the answer straddled a branch
boundary" or "the branch was too big to retrieve" — the closest is "fetched
the correct branch but it was truncated," which is **0 of 110 non-infra
failures, confirmed zero** (`01-run-forensics.md` §4, §8). Restated against
this pass's distribution: the one branch structurally capable of causing that
failure — the 36,170-token branch behind q01/q07/q10 — never actually
produced a truncated fetch, because (per §6/§7 of that report) models almost
never reached it at full depth at all. For `q07` specifically, the branch has
the single *best* self-retrieval rank in the whole gate suite (1 of 19,
`gates.json`/`questions.json`), yet zero of 15 sampled reps ever fetched it —
the confirmed proximate cause is query formation (62% of `deep`-stratum
failures fetch a *wrong* branch entirely, `01-run-forensics.md` §7–§8), not
the branch's size. So the oversized branch is a real, now-quantified
structural risk (§2–§3 above), but it is not the measured cause of any
sampled failure in the one report that actually checked — it is a risk that
has not yet fired, because the failures upstream of it (the model never
forming a query that reaches it) happen first.

**Tail-stratum correction.** This pass was asked to check a specific claim —
that the report attributes tail-stratum failures to "the newest branch
starting too late, at sequence 732, when the questions needed 720–731." That
claim does not match what `01-run-forensics.md` or
`eval/plans/loop9b-item2-judge-verdict.md` actually say, and should not carry
into further work unexamined (rule 5: surface the conflict, don't average
it). `01-run-forensics.md` §3 states the opposite directly: all three
tail-stratum source nodes — `q04` (seq 728, branch 639–731) and `q05`/`q06`
(seq 744/746, branch 732–754) — "are **inside**" the visible Zone-B branch
range (639–754), which is confirmed independently in this pass's own node
table (§2 above: those are exactly the two most recent branches, and both
are rendered as individual summaries at every root-keep level this store's
`gates.json` records). `eval/plans/loop9b-item2-judge-verdict.md:232-234`
states the same thing about the range as its stated reason for *rejecting* a
different design (`tree-active`, pre-filling Zone C with the newest branch's
raw detail) — specifically because doing so "hands the tail stratum its
answer by construction," which is only a problem *because* the range already
covers it. The report's actual, sourced explanation for `tree`/tail scoring
0.000 while baselines score 0.200–0.333 is behavioral, not structural: "the
harness limited the model on tail mainly by never forcing it past the
ambient lossy summary" — 34.8% of sampled failures searched and never called
`context_fetch` at all, and a further 8.9% never even searched
(`01-run-forensics.md` §8, verdict). A model that can already see a
one-paragraph summary of the right branch has no behavioral trigger to
re-fetch it at full depth, which is a tool-use-policy and summary-content
question (dimensions 1 and 3 in `reports/algorithm.md`'s framing), not a
branch-depth one. Nothing in branch granularity would change this outcome —
the branch containing the answer is already visible and already correctly
sized; the model simply trusts it.

**Net attribution.** Of `01-run-forensics.md`'s six mechanisms (§8), branch
granularity as measured here bears on exactly one — "fetched the correct
branch but it was truncated" (0.0%, 0 of 110) — and is a *contributing risk
factor, unconfirmed as a cause* for a second — the circumstantial "fetched
correct, no truncation, still wrong" bucket (4.4%), where §6 of that report
explicitly declines to attribute cause because the harness never logged
which `depth` argument was used. The other four mechanisms, covering the
overwhelming majority of sampled failures (34.8% + 32.6% + 8.9% + 5.2% turn
cap), are about whether and where the model looked, not about how big what
it would have found is.

## 5(c). The offline experiment that ranks candidate segmentations — run once, here

The procedure this pass used, stated as a repeatable offline recipe with
zero model calls:

1. **Re-segment the frozen store's L0 under each candidate `SegmentConfig`.**
   `segment()` is pure (§7.1/D15) and already accepts `neutralPhases` as a
   parameter — no source change needed for that axis; other candidates (§3a)
   would need a segmenter change but the harness below still applies once
   they exist. `eval/fixtures/transplant/s1/store/trace.jsonl` is the exact
   input; `eval/fixtures/transplant/s1/gates.json`'s `g5-rebuild-determinism`
   already establishes that re-deriving L1 from L0 alone reproduces the
   current tree exactly, so this re-derivation is provably faithful to the
   same invariant the store's own gate suite already checks.
2. **For every question in `questions.json`, locate its `seq` inside the new
   segmentation and record two booleans**: does it land inside exactly one
   branch (true by construction — segmentation partitions the trace; this
   check is a regression guard, not a discovery), and does that branch's
   estimated size fit each tested window. Size is estimated as raw chars ÷ 4
   × the store's own measured ratio (`gates.json`'s `g7-bpe-ratio`, 0.851 on
   this corpus) — the same "derived, not guessed" procedure
   `reports/algorithm.md`'s tier-2 table already credits for the ratio row,
   applied per-branch instead of once over the whole corpus. This pass ran
   that check at W=32768 only (§3a's table); the full version sweeps every
   window the transplant harness already tests (8k/16k/32k/65k/200k,
   `gates.json`'s own `NESTING_WINDOWS`).
3. **Count branches and their size distribution** (§2's table, recomputed
   per candidate) as the zero-token proxy for summarizer-call cost — not a
   substitute for a live cost measurement, but enough to rank candidates
   before spending anything, the same relationship `03-summary-policy.md`
   §3(d) establishes between `marathon.mjs`'s offline token curves and a
   live run's turns.
4. **Re-run the transplant harness's own zero-token gates against each
   candidate's re-derived tree**: `g8-over-budget`
   (`transplant.mjs:1926-1959`, does Zone B still fit with "at least one
   branch survives") and `g9-zone-b-nesting`
   (`transplant.mjs:1961-2020`, does the newest-aligned contiguous-suffix
   property still hold) are exactly the invariants a segmentation change
   could break, and both are already pure functions of a store plus a
   window — no candidate should be considered further if it fails either.
   Not run in this pass; the two tables above stand in for a first pass at
   step 2, which any candidate must clear before step 4 is worth running.

**What step 1–2 already found**, reported in full in §3(a): the one
structural candidate available today without any new code
(`neutralPhases: []`) clears the containment/fits-window check on all twelve
questions where the current segmentation fails it on three, at a measured
4.7× cost in branch count. That is a ranking on one axis (retrieval
coverage) against one candidate. It is not a recommendation to ship it —
step 3's cost side and step 4's gate re-check are the two pieces of this
recipe this pass did not run, and per rule 4, "which [setting] wins" is
still an open, measured question, not a conclusion this pass reaches.

## Open items

- Steps 3 and 4 of §5 were not run: no branch-count-to-summarizer-cost
  translation, and no re-check of `g8`/`g9` against the `neutralPhases: []`
  candidate's re-derived tree.
- The two unmeasured structural candidates in §3(a) — file-node promotion
  and content-sensed `other` reclassification — are assessed, not
  implemented or tested against the containment/fits-window check.
- Everything in this pass is n=1 store (`transplant/s1`), one trace, one
  host's tool-name map. Per `reports/algorithm.md`'s own cross-host standard,
  none of this is shown to hold on a different harness's tool surface, where
  the mix of neutral versus non-neutral tool calls — and therefore the
  size at which a branch stops closing — could differ substantially.
- No live run has compared turns or graded score between the current
  segmentation and `neutralPhases: []` (or any other candidate) on any task,
  long or short; §3(a)'s table is retrieval-containment and branch-count
  only, the offline half of the ranking §5 describes.
