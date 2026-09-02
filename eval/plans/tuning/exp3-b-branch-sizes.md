# Task B — re-measuring the over-window branches after the double-render fix

DS-STAR tuning, iteration 3, task B · zero live model calls, zero network ·
every number below comes from re-running `segment()` and `applySegmentation()`
— both pure, hermetic functions (D1, D15) — against a **copy** of the frozen
`eval/fixtures/transplant/s1/store`. The script is
`eval/scripts/resegment.mjs`, iteration 2's own script, extended in place
rather than rewritten (see Method) — runnable as `node
eval/scripts/resegment.mjs`.

**Fixture integrity, checked before and after this pass.** `trace.jsonl`
sha256 `64293edf…321fe878` matches `manifest.json`'s `store.trace_jsonl_sha256`
both before and after this run. `context-tree.config.json` sha256
`67f8f9a0…50ef01769` matches `manifest.json`'s `config.sha256`, unchanged. The
fixture directory itself was never opened for writing — the script's own
first step is `cpSync` into an `mkdtempSync` scratch directory, which is
`rmSync`'d in a `finally` block.

**On summary versions.** This measurement never reads `store/tree.db` and
therefore never reads a `node_summaries` row at all: `segment()` and
`applySegmentation()` operate on L0 (`trace.jsonl`) and L2 (`blobs/`) only,
writing into a fresh **in-memory** store created for this run and discarded
at the end. The frozen fixture's mutable, unhashed `tree.db` — the file whose
accumulating root-summary versions caused iteration 2's one irreproducible
table — is irrelevant to every number in this report. There is no summary
version to disclose because none was read.

## What changed since iteration 2

Iteration 2 found that `packages/core/src/retrieve/detail.ts`'s `renderEvent`
— the renderer behind `context_fetch depth:"full"` and `context_peek` — was
missing the `ARGS_CAP_WITH_BLOB` cap that `assemble/format.ts`'s Zone C
renderer has applied since v5.9b. A `Write`/`Edit` event whose arguments
carry the same content as its post-state blob was therefore rendered twice:
once JSON-escaped inside `--- args`, once raw inside `--- content`. That fix
has since landed (verified read at `packages/core/src/retrieve/detail.ts:87‑105`
and `packages/core/src/assemble/format.ts:128‑161`): both renderers now import
the same exported `ARGS_CAP_WITH_BLOB = 512` constant from `assemble/format.ts`
and apply the identical elision rule. This task re-measures branch sizes
against that fixed renderer, crossed with both tested segmentations.

## Method

`eval/scripts/resegment.mjs` was extended, not replaced, per instructions.
The only source change: `renderEvent`/`renderSpans` (inlined verbatim from
`retrieve/detail.ts` because that module isn't re-exported from the package
root) now take a `capArgs` boolean and, when true, apply the real
`ARGS_CAP_WITH_BLOB`/`elision`/`safeCut` imported straight from
`@context-tree/core` — not re-typed constants — so a drift between the
script's cap and the shipped one cannot occur silently. `CANDIDATES` became
the cross product of the two `neutralPhases` settings (`['other']` — today's
default — and `[]`, the segmenter's literal §7 reading) with the two cap
states (uncapped — the pre-fix renderer iteration 2 measured — and capped —
the shipped fix), four cells total. No other table or code path changed
except Table 4 (leaf-summarizer pricing), which is a segmentation-only
property (branch *count* doesn't depend on rendering) and is restricted to
the two segmentations under the capped (shipped) renderer to avoid a
meaningless cap×cap comparison. It is not part of this task's ask and is
included only as a continuity check: the call counts reproduce iteration 2
exactly (21 vs. 99, 4.71×), and so does the fixed-per-call-overhead delta
($0.4558, because that figure is a pure function of call count and is
independent of content size either way) — but the **absolute** dollar
figures do not reproduce ($0.3178/$0.7736 here vs. iteration 2's
$0.34/$0.80), because iteration 2 priced the pre-fix, duplicated content and
this run prices the post-fix content, which is smaller by the same 23,937
tokens in both configs (§1). That pushes the cost ratio from iteration 2's
2.33× to 2.43×: the fixed per-call overhead is unchanged, but it is now a
slightly larger fraction of a slightly smaller total.

No `packages/core` or `packages/mcp` source was touched by this task — the
cap fix was already landed before this pass started, and iteration 2's whole
batch (including `resegment.mjs` itself) was committed mid-task at
`77d5326` while this measurement was running. **A note on a shared working
tree**, same caveat exp-02-branch-depth.md carried: `git status` at the end
of this task shows an uncommitted change to `packages/core/src/cache/simulator.ts`
and a new file `eval/plans/tuning/exp3-c-width-attribution.md`, neither of
which this task made — they belong to a concurrent iteration-3 task (task C)
running in the same working tree. This report and its edits to
`resegment.mjs` touch neither. `npx tsc --build eval`
passed clean after the edit (exit 0, two pre-existing unrelated `npm warn`
lines about `.npmrc` keys). Because the fix under measurement lives in
`packages/core`, the targeted tests for it were run anyway, not skipped:

```
pnpm vitest run packages/core/test/retrieve.test.ts   → 33 passed, 0 skipped, 0 failed
pnpm vitest run packages/mcp/test/mcp.test.ts          → 39 passed, 0 skipped, 0 failed
```

Both suites include the cap-specific coverage (`retrieve.test.ts`'s `describe('the
edit-argument cap holds in the retrieval renderer too (2026-09-02)')` block and
`mcp.test.ts`'s `context_fetch`/`context_peek` describe blocks, the latter
including `'every search hit is a valid context_fetch target'`). Nothing was
skipped in either file.

## 1. Branch sizes, all four cells (exact cl100k tokens)

n = 21 branches (current segmentation) or 99 branches (`neutralPhases: []`),
both over the same 754 L0 events, in every cell.

| segmentation | rendering | branches | exact tok (min/median/p90/max) |
| --- | --- | ---: | --- |
| current (`['other']`) | uncapped (pre-fix) | 21 | 687 / 6,471 / 27,800 / **51,802** |
| current (`['other']`) | **capped (shipped)** | 21 | 687 / 6,471 / 23,085 / **46,945** |
| `neutralPhases: []` | uncapped (pre-fix) | 99 | 100 / 858 / 4,488 / **34,664** |
| `neutralPhases: []` | **capped (shipped)** | 99 | 100 / 857 / 3,896 / **24,986** |

The median is untouched in both segmentations (6,471 and ~858 tok) — the cap
only ever fires on an event that carries both an args blob and a post-state
blob with identical content, which iteration 2 measured at 6 of 754 events
trace-wide, so most branches render byte-identical before and after the fix.
The maximum moves because those 6 events happen to sit inside the store's
largest branches.

**Every branch the fix actually touches**, checked exhaustively (diffed all
21 and all 99 branches' exact-token counts, not just the largest): the cap
touches **5** branches under current segmentation and **6** under
`neutralPhases: []`, and no others — every other branch (16 of 21, 93 of 99)
is byte-identical before and after:

| current segmentation: span | uncapped | capped | Δ | Δ% |
| --- | ---: | ---: | ---: | ---: |
| 267–276 | 35,657 | **18,351** | −17,306 | −48.5% |
| 55–261 | 51,802 | **46,945** | −4,857 | −9.4% |
| 430–488 | 10,347 | 9,687 | −660 | −6.4% |
| 732–754 | 9,882 | 9,146 | −736 | −7.4% |
| 359–389 | 8,868 | 8,490 | −378 | −4.3% |
| **sum of Δ** | | | **−23,937** | |

| `neutralPhases: []`: span | uncapped | capped | Δ | Δ% |
| --- | ---: | ---: | ---: | ---: |
| 267–271 | 34,664 | **17,358** | −17,306 | −49.9% |
| 55–57 | 6,603 | 3,261 | −3,342 | −50.6% |
| 115–116 | 3,209 | 1,694 | −1,515 | −47.2% |
| 732–733 | 1,858 | 1,122 | −736 | −39.6% |
| 485–486 | 1,608 | 948 | −660 | −41.0% |
| 359–360 | 1,133 | 755 | −378 | −33.4% |
| **sum of Δ** | | | **−23,937** | |

The two sums match to the token — both segmentations are partitions of the
same 754 events, so the fix removes exactly the same 23,937 duplicated
tokens either way; only how those tokens are grouped into branches differs.
Under `neutralPhases: []` each duplicated event mostly lands in its own tiny
2-event branch (hence 6 branches, one per event); under current segmentation
two of the six duplicated events (at spans 55–57 and 115–116) both fall
inside the single 207-event branch 55–261, so its Δ (4,857) is those two
events' deltas summed (3,342 + 1,515), and the other four duplicated events
map one-to-one onto 267–276, 430–488, 732–754 and 359–389. The 267–27x branch
— the one both iteration-1 and iteration-2 reports identified as holding the
duplicated 47KB HTML write — loses essentially half its size under either
segmentation, because that one event is nearly its entire content; 55–261
loses only 9.4% of its much larger total because the duplication there is 2
events out of 207. Table 1b's per-branch ratio distribution moves only
slightly (median 0.828→0.827 current, 0.823→0.822 candidate), consistent
with a handful of small, localized fixes rather than a store-wide change.

## 2. Branches exceeding each tested window, all four cells

| config | >8,192 | >16,384 | >32,768 | >65,536 | >200,000 |
| --- | ---: | ---: | ---: | ---: | ---: |
| current, uncapped | 8 | 4 | **2** | 0 | 0 |
| current, **capped** | 8 | **4** | **1** | 0 | 0 |
| `neutralPhases: []`, uncapped | 5 | 3 | **1** | 0 | 0 |
| `neutralPhases: []`, **capped** | 5 | **3** | **0** | 0 | 0 |

At **W=32,768**, the cap fix removes exactly one branch from the over-window
count in each segmentation (current: 2→1; candidate: 1→0) — closing the
condition only when combined with re-segmentation. At **W=16,384**, the cap
fix removes zero branches from the count in either segmentation (current
stays at 4, candidate stays at 3): the affected branches shrink, but not
below 16,384 (267–276/271 lands at 18,351/17,358 — still 1,967 / 974 tokens
over) and the branches that don't contain the duplicated event (1–54,
639–731, 193–261, 642–729) are untouched by rendering at all.

## 3. Per-question containment, all four cells

n = 12 (`questions.json`). Every question's answer-literal `seq` lands in
exactly one branch under all four configurations, in every cell (a
regression guard, not new information — segmentation partitions L0 by
construction).

**Current segmentation** — capping touches 3 of the 6 distinct branches the
twelve questions source from (55–261, 732–754, 430–488 all shrink; 1–54,
639–731, 554–570 don't, holding none of the 6 duplicated events), but
changes *zero* per-question fit outcomes: the same 7 of 12 miss W=16,384 and
the same 3 of 12 miss W=32,768, before and after the fix:

| question | seq | branch span | exact tok (uncapped → capped) | fits 16,384 | fits 32,768 |
| --- | ---: | --- | --- | :---: | :---: |
| head@175, deep@55, spanning@173 | 175, 55, 173 | 55–261 | 51,802 → 46,945 (touched, −9.4%) | NO / NO | **NO / NO** |
| head@18, deep@41 | 18, 41 | 1–54 | 23,085 → 23,085 (untouched) | NO | yes |
| tail@728, spanning@691 | 728, 691 | 639–731 | 27,800 → 27,800 (untouched) | NO | yes |
| tail@744, tail@746 | 744, 746 | 732–754 | 9,882 → 9,146 (touched, −7.4%) | yes | yes |
| head@558, deep@559 | 558, 559 | 554–570 | 3,942 → 3,942 (untouched) | yes | yes |
| spanning@467 | 467 | 430–488 | 10,347 → 9,687 (touched, −6.4%) | yes | yes |

`55–261` shrinks 9.4% but stays over **both** windows, so the three
questions sourcing from it are unmoved at either window. `732–754` and
`430–488` do shrink (7.4% and 6.4%) but were already well inside both
windows before the fix, so their three questions' fit outcome cannot move
either — there was no threshold left to cross. `1–54`, `639–731` and
`554–570` hold none of the six duplicated events and are numerically
identical before and after.

**`neutralPhases: []`** — capping touches only 1 of the 8 distinct branches
the twelve questions source from under this segmentation (55–57, via
deep@55), and again changes *zero* per-question fit outcomes. The same 2 of
12 miss W=16,384 (both already fit W=32,768 in both cap states):

| question | seq | branch span | exact tok (uncapped → capped) | fits 16,384 | fits 32,768 |
| --- | ---: | --- | --- | :---: | :---: |
| tail@728, spanning@691 | 728, 691 | 642–729 | 24,986 → 24,986 (untouched) | NO | yes |
| deep@55 | 55 | 55–57 | 6,603 → 3,261 (touched, −50.6%) | yes | yes |
| other 9 questions | — | (various, all untouched) | ≤16,395 both ways | yes | yes |

`55–57` already fit both windows comfortably before the fix (6,603 tokens),
so halving it changes nothing observable. The single branch this
segmentation still has over W=32,768 pre-cap (267–271, 34,664 tok) contains
none of the twelve questions' answer literals, so the cap fix taking it to
17,358 and under 32,768 (§2) produces **no question-level change** — it
closes a structural boundary-condition cell without touching a measured
retrieval outcome, exactly the pattern iteration 2 flagged for granularity
generally ("explains almost none of the *measured* retrieval failures").

## 4. The question that matters

**Does the cap fix alone close the boundary condition at either live window,
without touching segmentation? No, at neither window, and the shortfall is
different in kind at each.**

- **At W=32,768:** cap alone (current segmentation, capped) leaves **one**
  branch over — `55–261` at 46,945 tokens, **14,177 tokens over budget**.
  Re-segmentation alone (uncapped candidate) also leaves **one** branch over
  — a *different* branch, `267–271` at 34,664 tokens, 1,896 over. Each fix
  independently removes exactly one of the two over-window branches present
  at baseline (current, uncapped = 2); it takes **both together** to reach
  zero. Neither cause dominates here — they are complementary, one branch
  apiece.
- **At W=16,384:** cap alone changes the count **not at all** — 4 branches
  over before and after, under current segmentation; 3 before and after,
  under the candidate. The two branches the cap fix shrinks (267–276/271)
  still exceed 16,384 by 1,967 and 974 tokens respectively — halving a
  35–37K-token branch is not enough headroom at the tighter window.
  Re-segmentation is the only lever that moves the count at all (4→3), and
  even with **both** fixes applied, **three branches remain over W=16,384**
  (193–261 at 16,395 — 11 tokens over; 267–271 at 17,358 — 974 over; 642–729
  at 24,986 — 8,602 over, unaffected by either fix since it holds no
  duplicated event). **Segmentation dominates at the tighter window; the cap
  fix contributes zero count reduction there**, though it does reduce the
  size of the branches that remain over.

Restated as the single honest sentence: the cap fix and re-segmentation are
each responsible for exactly one of the two over-32,768 branches and
together close that window, but at 16,384 — the harness's other live
window — three branches still exceed it after applying both fixes, and the
cap fix's contribution to that count is zero.

## 5. What the cap fix does to the retrieval payload a model actually receives

This is the reason the fix exists, independent of whether it closes the
boundary condition. For the 6 of 754 events (measured by iteration 2, and
structurally unchanged here since the fixture's L0 hash is unchanged) that
carry a `Write`/`Edit` call whose arguments JSON-escape the same content as
the post-state blob, `context_fetch depth:"full"` and `context_peek` now
return that content **once** instead of twice — 23,937 fewer tokens
trace-wide, identically whether the events sit in 5 coarse branches or 6
fine ones (§1). Concretely, on this store: a full fetch of the branch
holding seq 267 (current or candidate segmentation) now returns roughly
half the bytes it did before — 48.5–49.9% smaller — with no information
loss: the args block is elided only past 512 bytes and only when the
identical content is also present in the post-state blob, so a tool call
that legitimately needs both rendered differently (e.g. an `Edit`, whose
args are a diff rather than a full-file duplicate) is untouched, which
Table 1's essentially unmoved median and Table 1b's essentially unmoved
ratio distribution both confirm. The fix reaches 5 of the store's 21
branches under current segmentation and 6 of 99 under the candidate; every
other branch (16 of 21, 93 of 99) is byte-identical before and after. Of the
branches this store's twelve test questions source from, 3 of 6 (current
segmentation) and 1 of 8 (candidate) are among the touched branches — but in
every one of those cases the branch was either already inside both windows
before the fix, or stayed outside both windows after it, so §3 measures zero
change in which questions a model could retrieve, even though the bytes it
would read did shrink. The model-visible effect on an affected branch is
strictly less input tokens billed and read back on every fetch, for the
same information; it does not change what the model can learn from a fetch
it already made, and it does not, by itself, move any question from "cannot
fetch its answer inside the window" to "can."

## Tests

`packages/core` and `packages/mcp` were not modified by this task — only
`eval/scripts/resegment.mjs` was extended, and `eval` scripts carry no
targeted vitest suite of their own (their check is `tsc --build`, run above,
exit 0). Because the code under measurement (`retrieve/detail.ts`,
`assemble/format.ts`) is `packages/core` source, its targeted suites were run
anyway rather than skipped:

- `pnpm vitest run packages/core/test/retrieve.test.ts` — **33 passed, 0
  skipped, 0 failed**.
- `pnpm vitest run packages/mcp/test/mcp.test.ts` — **39 passed, 0 skipped, 0
  failed**.

No test in either file was skipped, and no full-suite run was substituted for
these — this task did not touch code broad enough (a shared util, a DTO
shape, `dbUtils`-equivalent) to require CI's full run as the gate.

## Open items

- The remaining W=16,384 shortfall (3 branches even with both fixes applied)
  is not addressed by anything in this task's scope. The largest of the
  three, `642–729` at 24,986 tokens, holds no duplicated event and is
  unrelated to either fix measured here — it is 88 events of ordinary
  (non-duplicated) content that is simply larger than 16,384 tokens once
  concatenated, which no rendering fix can shrink; only a size-aware
  segmentation rule (not measured here) or a windowed/partial fetch path
  ("the listing-then-range path", named as untested-live in
  `reports/algorithm.md`'s boundary-conditions table) closes that kind of
  branch.
- This remains n=1 store, one trace, one host's tool-name map — the same
  caveat both prior passes on this dimension carried forward.
