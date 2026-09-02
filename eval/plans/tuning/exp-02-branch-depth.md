# Experiment 2 — re-segmenting the frozen store, end to end

DS-STAR tuning pass, dimension 2 (branch depth), iteration 2 (experiment) ·
zero live model calls, zero network · every number below comes from re-running
`segment()` and `applySegmentation()` — both pure, hermetic functions (D1,
D15) — against a **copy** of the frozen `eval/fixtures/transplant/s1/store`
(the fixture itself was never opened for writing; its manifest hash was
verified to match before this pass touched anything, and matches after) · the
script is `eval/scripts/resegment.mjs`, runnable as
`node eval/scripts/resegment.mjs`.

**Terms used below.** A **branch** (also called a **phase** node or a
**leaf**) is one closed segment of the trace — a contiguous run of L0 events
the segmenter grouped under one tool-activity type. Its **raw span** is the
exact text `context_fetch depth:"full"` would return for it: every event's
header line plus its blob content, concatenated in sequence order
(`renderSpans`, `packages/core/src/retrieve/detail.ts`). **W** is the model
context window a candidate raw span is measured against. **Exact tokens**
means the real cl100k BPE count (`gpt-tokenizer`, the same tokenizer the
transplant harness's own gates use for `exact`) — a deterministic, local,
zero-cost computation, not a live tokenizer call. **Heuristic tokens** means
`HeuristicTokenizer`'s count (`packages/core/src/tokens/index.ts`), the
provider-agnostic estimator the assembler budgets against at runtime.

## Abstract

The first-iteration analysis (`02-branch-depth.md`) found a 77-fold branch-size
spread under today's segmentation and proposed a config-only fix —
`neutralPhases: []`, the segmenter's own documented "literal §7 rule" — that
it estimated would eliminate the one branch exceeding the transplant harness's
tested windows, at a measured 4.7× increase in branch count. This pass
re-derives L1 from the frozen store's L0 under both configurations using the
real tokenizer instead of the chars÷4×ratio estimate the first pass used, and
finds three things.

First, the headline claim about the twelve test questions holds up exactly:
under `neutralPhases: []`, every one of the twelve questions' answer literals
now falls inside a branch that fits inside W=32,768, including the three that
do not fit under today's segmentation. That part of the analysis is confirmed,
not just estimated.

Second, a broader claim in the same analysis — "eliminates the over-window
branch entirely" and its own table's "branches > W=32768: current=1,
`neutralPhases:[]`=0" — is **wrong**, and it is wrong because the chars÷4×ratio
estimator the first pass used to build that table undercounts a specific,
identifiable branch by 67%. Exact tokenization finds a **second** branch in
today's segmentation exceeding W=32,768 (35,657 real tokens against an
estimate of 21,396), and finds that even under `neutralPhases: []` **one
branch still exceeds W=32,768** (34,664 tokens) and **three branches still
exceed W=16,384**. Re-segmentation reduces the frequency of over-window
branches — it does not remove the boundary condition. This is the finding to
report plainly, per the instructions this pass was given: the stronger claim
in the first-iteration report does not survive exact measurement.

Third, the root cause of the branch that survives even the fix is not a
segmentation problem at all: it is one `Write` tool-call event (seq 267) whose
raw rendering embeds the same 47KB file's content **twice** — once as a
JSON-escaped string inside the tool's own arguments, once again as the raw
post-edit blob — a duplication confirmed byte-for-byte equal on six such
events across the trace. No segmentation rule can shrink a branch below the
size of its own largest atomic event, so this branch exceeds W=32,768 under
*every* segmentation that keeps that one event whole, current and candidate
alike. That is a rendering-format question (`renderEvent` in
`retrieve/detail.ts`), not a branch-depth one, and it is named here as a new,
measured finding for a future pass — not fixed in this one, since fixing it is
outside this experiment's scope and outside what `02-branch-depth.md`
identified as the defect to address.

Priced at the leaf model's named rate, `neutralPhases: []`'s 4.7× more leaf-
summarizer calls (99 vs. 21) cost 2.33× more, not 4.7× more — because branch
content is a partition of the same L0 (summed content tokens across branches
is 219,007 vs. 218,997, effectively identical), so the entire measured dollar
delta between the two configurations is attributable to the *fixed* per-call
cost (a 724-token system prompt plus a 1,024-token output cap) multiplied by
the 78 additional calls, not to any change in the amount of content
summarized.

## Method

`resegmentAndMeasure()` in `eval/scripts/resegment.mjs`:

1. Copies `eval/fixtures/transplant/s1/store` to a scratch directory (`mkdtempSync`
   under the OS temp dir). The fixture's `trace.jsonl` sha256 was checked
   against `manifest.json` before and after this pass (`64293ed...321fe878`,
   matches) — the freeze line was never crossed.
2. Loads `context-tree.config.json` via the real `loadConfig()` (merges the
   repo's `toolPhase` overrides over `DEFAULT_TOOL_PHASE`) — the exact config
   that built the frozen store; its own sha256 (`67f8f9a0...50ef01769`) was
   independently confirmed unchanged.
3. Runs `segment()` on all 754 L0 events under two `neutralPhases` values —
   `['other']` (current default) and `[]` (the candidate) — then
   `applySegmentation()` into a fresh in-memory `SqliteTreeStore` and reads
   back every `kind: 'phase'` node's `span_start_seq`/`span_end_seq`. This
   reuses the same two functions `g5-rebuild-determinism` already established
   reproduce the frozen tree exactly; it skips only the tree-sitter file-span
   extraction step of the full `ingest()` path, which is irrelevant to branch
   size.
4. For every branch, renders its raw span with a function inlined from
   `renderEvent`/`renderSpans` (`retrieve/detail.ts` is not re-exported from
   the package root, so this reproduces it verbatim rather than reaching past
   the public API) and counts chars, exact cl100k tokens, and heuristic
   tokens.
5. Cross-references `eval/fixtures/transplant/s1/e1b289c32f40/questions.json`'s
   twelve `seq` values against both branch sets, and prices leaf-summarizer
   calls using `priceFor`/`usdFor`/`DEFAULT_PRICES` from
   `packages/core/src/models/cost.ts` (the real price table, not a
   transcribed number) plus the real leaf-summary system prompt's token count.

No source file under `packages/core` or `packages/mcp` was modified. `npx tsc
--build` was run inside `packages/core` to make sure `dist/` reflected the
current (uncommitted-but-unchanged-in-diff) `src/segment/segment.ts` before
importing it; the build produced no diff (`git status` before and after is
identical for tracked files — `dist/` is gitignored). `npx tsc --build eval`
was run after adding the script and passes clean. No `packages/core` source
changed, so no `pnpm vitest run` was required per this pass's own scoping rule
("targeted tests for anything you touch"); none were skipped silently — none
applied.

**A note on a shared working tree.** `git status` at the end of this pass
shows uncommitted changes to `packages/core/src/assemble/assembler.ts` and
`packages/core/test/cache.test.ts` that this pass did not make — they belong
to a concurrent dimension-4 (caching) experiment running in the same working
tree. This report and its script touch neither file.

## 1. Branch count and size distribution (exact tokenization)

n = 21 branches (current) and n = 99 branches (`neutralPhases: []`), both over
the same 754 L0 events.

| config | branches | events per branch (min/median/p90/max) | chars (min/median/p90/max) |
| --- | ---: | --- | --- |
| current (`neutralPhases: ['other']`) | 21 | 2 / 17 / 65 / 207 | 2,503 / 25,618 / 85,732 / 177,891 |
| `neutralPhases: []` | 99 | 2 / 3 / 16 / 88 | 313 / 3,165 / 16,467 / 97,882 |

| config | exact cl100k tokens (min/median/p90/max) | heuristic tokens (min/median/p90/max) |
| --- | --- | --- |
| current | 687 / 6,471 / 27,800 / 51,802 | 823 / 8,497 / 31,393 / 62,267 |
| `neutralPhases: []` | 100 / 858 / 4,488 / 34,664 | 112 / 976 / 5,694 / 38,988 |

This reproduces the first-iteration analysis's headline shape: median branch
size drops roughly 7.5× in events (17 → 3) and 7.5× in exact tokens (6,471 →
858), and branch count rises 4.7× (21 → 99), matching that pass's own ratio
exactly.

**Where the first pass's per-branch numbers drift from exact measurement.**
`02-branch-depth.md` §5(c) states its size estimate is "raw chars ÷ 4 × the
store's own measured ratio" (0.850896663206653, from `gates.json`'s
`g7-bpe-ratio`, itself computed over every raw L2 blob with no rendering
overhead). Applying that same formula per branch and comparing to the exact
count measured here:

| branch (current segmentation) | chars | first-pass estimate (chars÷4×0.851) | exact cl100k measured here | error |
| --- | ---: | ---: | ---: | ---: |
| `n_1BGBV85XX4QT…` (267–276, `implementation`) | 101,119 | 21,396 (analysis's own reported figure, on 100,579 chars) | 35,657 | **+67%** |
| `n_1E48X9HA…` (55–261, the branch the analysis names) | 177,891 | 36,170 | 51,802 | +43% |

Both branches are undercounted by the chars÷4×ratio estimator, not just the
one the first pass flagged. §2 below explains why: the ratio was measured
over raw blob text; a branch's *rendered* detail also carries the branch's
own header/label overhead and, for a handful of events, doubled content
(§4). The corpus-wide ratio is a reasonable *average* predictor (Table 1b
below) but an unsafe one for any *specific* branch, which is exactly the
class of number rule 3 in `reports/algorithm.md` asks to be derived rather
than estimated once and reused.

### Table 1b — per-branch (exact ÷ heuristic) ratio, the apples-to-apples version of g7

| config | ratio (min/median/p90/max) | branches with ratio > 1.6 (the harness's own kill condition, `RATIO_KILL`) |
| --- | --- | ---: |
| current | 0.743 / 0.828 / 0.889 / 1.255 | 0 |
| `neutralPhases: []` | 0.656 / 0.823 / 0.958 / **1.663** | 1 |

Comparing exact tokens to the *heuristic tokenizer's* count (not raw
chars÷4 — the heuristic tokenizer already accounts for punctuation/newline
runs the way real code and JSON produce them) tracks the corpus-wide 0.851
ratio much more closely (median 0.823–0.828 across both configs) than the
naive chars÷4 comparison does. One branch under `neutralPhases: []` — the
same 267–271 branch discussed in §4 — exceeds the harness's own 1.6 kill
threshold at the per-branch level, even though the corpus-wide average never
approaches it.

## 2. Branches exceeding each tested window — the full sweep

The first-iteration analysis ran this check at W=32,768 only and named the
fuller sweep as unrun (`02-branch-depth.md` §5(c) step 2). This pass runs it
across the two windows the transplant harness's `manifest.json` actually
tests live (16,384 and 32,768) plus the three additional windows
`NESTING_WINDOWS` sweeps for the structural `g9` gate (8,192 / 65,536 /
200,000):

| config | > 8,192 | > 16,384 | > 32,768 | > 65,536 | > 200,000 |
| --- | ---: | ---: | ---: | ---: | ---: |
| current | 8 | 4 | **2** | 0 | 0 |
| `neutralPhases: []` | 5 | 3 | **1** | 0 | 0 |

The first-iteration analysis's own table (§3(a)) reported "branches > W=32768:
current=1, `neutralPhases:[]`=0." Both numbers are wrong by exact measurement:
it is 2 and 1, not 1 and 0. Re-segmentation still roughly halves the count at
every window tested — that part of the direction is confirmed — but it does
not zero it at any window this pass checked.

## 3. Per-question containment

n = 12 questions (`questions.json`). Every question's answer-literal `seq`
lands inside exactly one branch under both configurations — segmentation
partitions L0 by construction, so this is a regression guard, not new
information, and it holds in both cases.

**Current segmentation** — 3 of 12 questions source from a branch that does
not fit W=16,384; the same 3 do not fit W=32,768 either (all three are the
55–261 branch):

| question | seq | branch span | exact tok | fits 16,384 | fits 32,768 |
| --- | ---: | --- | ---: | :---: | :---: |
| head@175 | 175 | 55–261 | 51,802 | NO | **NO** |
| head@558 | 558 | 554–570 | 3,942 | yes | yes |
| head@18 | 18 | 1–54 | 23,085 | NO | yes |
| tail@728 | 728 | 639–731 | 27,800 | NO | yes |
| tail@744 | 744 | 732–754 | 9,882 | yes | yes |
| tail@746 | 746 | 732–754 | 9,882 | yes | yes |
| deep@55 | 55 | 55–261 | 51,802 | NO | **NO** |
| deep@559 | 559 | 554–570 | 3,942 | yes | yes |
| deep@41 | 41 | 1–54 | 23,085 | NO | yes |
| spanning@173 | 173 | 55–261 | 51,802 | NO | **NO** |
| spanning@467 | 467 | 430–488 | 10,347 | yes | yes |
| spanning@691 | 691 | 639–731 | 27,800 | NO | yes |

**`neutralPhases: []`** — every question fits W=32,768 (confirms the
first-pass claim exactly); 2 of 12 still miss the smaller W=16,384:

| question | seq | branch span | exact tok | fits 16,384 | fits 32,768 |
| --- | ---: | --- | ---: | :---: | :---: |
| head@175 | 175 | 169–179 | 1,792 | yes | yes |
| head@558 | 558 | 556–570 | 3,140 | yes | yes |
| head@18 | 18 | 17–18 | 8,748 | yes | yes |
| tail@728 | 728 | 642–729 | 24,986 | **NO** | yes |
| tail@744 | 744 | 734–754 | 8,024 | yes | yes |
| tail@746 | 746 | 734–754 | 8,024 | yes | yes |
| deep@55 | 55 | 55–57 | 6,603 | yes | yes |
| deep@559 | 559 | 556–570 | 3,140 | yes | yes |
| deep@41 | 41 | 19–41 | 3,818 | yes | yes |
| spanning@173 | 173 | 169–179 | 1,792 | yes | yes |
| spanning@467 | 467 | 465–484 | 2,614 | yes | yes |
| spanning@691 | 691 | 642–729 | 24,986 | **NO** | yes |

So the analysis's headline claim ("every question now sources from a branch
that fits inside every tested window") is true **only** at W=32,768. At the
smaller live window, W=16,384, it is false for both configurations — 7 of 12
under current, 2 of 12 under `neutralPhases: []`. The first-iteration report
never checked W=16,384 against per-question containment; this pass does, and
the "every tested window" phrasing does not hold once that window is
included.

## 4. The boundary condition, settled

The question this pass was asked to settle: under each segmentation, is
there still any branch whose raw span exceeds the smallest tested window
(W=16,384)?

**Yes, under both.**

| config | branches exceeding W=16,384 | detail |
| --- | ---: | --- |
| current | 4 | 1–54 (23,085 tok), 55–261 (51,802 tok), 267–276 (35,657 tok), 639–731 (27,800 tok) |
| `neutralPhases: []` | 3 | 193–261 (16,395 tok), 267–271 (34,664 tok), 642–729 (24,986 tok) |

And at the larger live window, W=32,768: current has 2, `neutralPhases: []`
has 1 — the 267–271 branch, 34,664 tokens.

**Why that one branch survives regardless of segmentation.** Its 5 events
(267–271) are a `Write` tool call, its result, an `Edit`, and its result. The
`Write` call alone (seq 267) accounts for essentially the whole branch: its
`args_blob` (the tool's JSON-encoded arguments) contains a `content` field
that is **byte-identical** to the event's separate post-edit `blob` — both a
47,018-character HTML file, once JSON-escaped inside the arguments and once
raw. `renderEvent` (`retrieve/detail.ts`) renders both sections for a tool
call that carries both blobs (an `--- args` block and a `--- content`
block), so this one event's raw rendering is roughly double what the file's
actual content requires: 17,519 exact tokens for the escaped-JSON copy plus
16,699 for the raw copy, before any header overhead — already 34,218 tokens
on a single event, which by itself exceeds W=32,768, with no Zone A/B/C
overhead counted yet and **before segmentation is even involved**.

Checked across the whole trace: 6 of 754 events carry both an `args_blob` and
a `blob`, and all 6 have this exact duplication (measured directly:
`args_blob`'s parsed `content` field `===` the `blob`'s text, for every one),
totaling 70,227 duplicated characters trace-wide. This one happens to be large
enough on its own to matter for the boundary condition; the other five are
small enough not to.

**This is a rendering-format finding, not a branch-depth one**, and it is new
to this pass — `02-branch-depth.md` did not identify it, so per this pass's
own scope it is reported here, not fixed here. No segmentation rule — emptying
`neutralPhases`, a size threshold, file-node promotion, or anything else in
`02-branch-depth.md` §3(a)'s list of candidates — can bring this specific
branch under W=32,768, because a branch can never render smaller than its
single largest atomic event, and that event's double-rendering is what makes
it large. The candidate fix (rendering a `Write` call's content once, from
whichever blob is present, instead of once per blob) is a `retrieve/detail.ts`
change with its own test surface and is named here as an open item for
whichever pass owns retrieval rendering, not implemented in this one.

## 5. Price: leaf-summarizer calls, at the named rate

Leaf model on this store: `claude-haiku-4-5-20251001` → price-table prefix
`claude-haiku` (`packages/core/src/models/cost.ts` `DEFAULT_PRICES`): **$1/M
input, $5/M output.** Fixed per-call overhead: the leaf-summary system prompt
(`packages/core/src/prompts/leaf-summary.v1.md`) is 724 exact tokens,
charged once per call regardless of branch size. Output is priced at the
configured cap, `maxSummaryTokens=1,024` (`config.ts`) — an upper bound; a
real completion is usually shorter, so this prices the worst case, not a
measured one (zero model calls were made).

| config | leaf-summarizer calls | sum of branch content, exact tok | est. cost at $1/$5 per M | footnote |
| --- | ---: | ---: | ---: | --- |
| current | 21 | 219,007 | $0.34 | at `claude-haiku-4-5` named rates, 2026-09-02 pricing snapshot in `cost.ts` |
| `neutralPhases: []` | 99 | 218,997 | $0.80 | same |

Call count rises 4.7×. Dollar cost rises **2.33×**, not 4.7× — because the two
"sum of branch content" figures are effectively identical (they are two
partitions of the same 754-event L0; the 10-token difference is boundary
rounding in the tokenizer, not real content growth). Isolating the fixed
per-call terms (724-token prompt + 1,024-token output cap, content held
constant) against the 78 additional calls accounts for **all** of the $0.46
delta ($0.4558 of $0.4558, to four decimal places): every additional dollar
`neutralPhases: []` costs here is the fixed cost of making 78 more calls, not
the cost of summarizing more content. `03-summary-policy.md` §3(c) separately
measured the leaf summarizer's share of total run cost at a median 9.4% on
tasks that cross the summarization threshold at all (n=6) — this pass does
not re-measure that share (it would require a live run), but a >2× per-run
increase in one cost line item that already runs to double digits of run
cost on the tasks where it fires is not a free change, which is the same
conclusion `02-branch-depth.md` reached, now with a number instead of a
qualifier.

## Tests

No `packages/core` or `packages/mcp` source was modified by this pass, so no
targeted `pnpm vitest run` applied under this pass's own scoping rule ("run
tests for anything you touch") — none were run, and none were silently
skipped; there was nothing to test. `npx tsc --build eval` was run after
adding `eval/scripts/resegment.mjs` and passed clean (no errors; two
unrelated `npm warn` lines about `.npmrc` config keys). `npx tsc --build`
inside `packages/core` was run once, before measurement, to make sure the
compiled `dist/segment/segment.js` matched the current (already-committed,
unmodified) `src/segment/segment.ts`; it produced no diff to any tracked
file (`dist/` is gitignored).

## Open items

- The `Write`-event double-render (§4) is a real, measured contributor to the
  boundary condition surviving re-segmentation, but is unfixed here — it
  belongs to whoever owns `retrieve/detail.ts`, with its own test coverage
  (six events trace-wide are affected on this one store; the fix needs to
  confirm it does not silently drop information for a tool that legitimately
  needs both its arguments and its result rendered differently, e.g. an
  `Edit` whose args are a diff and whose content is the post-edit file).
- Steps 3 and 4 of `02-branch-depth.md` §5's own procedure — translating
  branch count into the *leaf-summarizer's* measured share of total run cost
  (rather than the flat per-call price this pass computed), and re-running
  `g8-over-budget`/`g9-zone-b-nesting` against the `neutralPhases: []`
  candidate's re-derived tree — still require live leaf summaries and were
  not run here, consistent with this pass's zero-model-call constraint.
- This remains n=1 store, one trace, one host's tool-name map, as the first
  pass already noted; nothing here changes that.
