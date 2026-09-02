# Lens 5 — Roadmap item 3: the sw-3-refactor overhead gap

## Abstract

Roadmap item 3 (`reports/metrics/loop8-interim.md:151`) names a 3.4× token gap on
`sw-3-refactor` — 121,012 median tree tokens against the transcript baseline's
35,561 — and proposes shrinking "the fixed instruction section" (Zone A: the
system contract plus the four MCP tool schemas) as the next deletion. This
analysis traces both numbers to their source run files (`eval/results/v60-diverse`
+ `v61-diverse`, n=6, for the tree arm; `eval/results/v57-diverse`, n=3, for the
native arm; both `claude-sonnet-5`), reproduces them exactly from raw usage
records, and decomposes the gap into token buckets that sum to it exactly, not
approximately.

**The headline finding contradicts the roadmap's working hypothesis.** Zone A —
measured directly from the source files that render it (`system-contract.v1.md`,
`TREE_COMPLETION_ADDENDUM`, the eight tool schemas) — is real and reproducible
(≈1,955 tokens/turn for the tree arm vs ≈375 for native) but accounts for only
about a quarter of the gap (≈24%, ≈23,469 of 98,006 mean-gap tokens). The
dominant term (≈69%, ≈68,134 tokens) is **cache-reread cost driven by extra
turns**: the tree arm finishes sw-3 in a mean 13.7 turns against native's 8.7,
not because it does more total work — native actually issues *more* raw tool
calls per run (mean 24 vs tree's 19.5) — but because it batches roughly half as
many tool calls per model turn (1.49/turn vs native's 2.77/turn). Since every
turn re-bills the entire accumulated context as `cacheRead`, spreading the same
(or slightly less) work across more turns multiplies the number of times each
already-written token gets re-read, without adding much content. A second,
smaller finding **directly refutes** a hypothesis the task brief raised: the
four context tools (`context_fetch`, `context_search`, `context_peek`,
`annotate`) were called **0 or 1 times per run** across all six tree replicates —
the "read-before-edit rule firing on files already in context" is not
happening; context-tool traffic is not a measurable contributor to this gap.

One concrete, D5-compliant deletion is identified and priced exactly: the "Two
ways this goes wrong, and what you do about them" section of
`system-contract.v1.md` is 246 of the file's 791 tokens (31%) and is largely a
restatement of guidance already present in each tool's own description. Deleting
it saves 246 tokens/turn × mean 13.7 turns ≈ 3,362 tokens/run — real, free, and
zero-risk, but only ≈3.4% of the mean 98,006-token gap. **It does not get sw-3
within 50% of native's tokens on its own**, and neither would deleting all of
Zone A's tree-specific overhead (≈27% ceiling). The turn-count/batching-density
mechanism is the lever that matters, and no single Zone-A rule was found whose
deletion would be expected to fix it — this is reported as an open finding, not
a proposed deletion, per the instruction to say so plainly when extra turns
dominate.

---

## 1. Confirming what the published numbers are, exactly

`reports/metrics/loop8-interim.md:105,116` reports sw-3 median tokens as
35,561 (transcript) vs 121,012 (tree), and turns as 9 vs 13.5
(`loop8-interim.md:116`). `reports/metrics/tree-vs-transcript.md:523` names the
tree config as `v6.x` — "lazy-tokens, pooled (v6.0+v6.1, behaviorally
identical)" — and line 166 of `loop8-interim.md` gives its exact recipe:
"deterministic root + no schema text + fetch-as-events + lazy threshold 30k."

Searching every `results.json` under `eval/results/` for `scenarioId ==
"sw-3-refactor"` locates the two source populations:

| Arm | Source dirs | n | Model | Tokens (sorted) | Turns (sorted) |
|---|---|---|---|---|---|
| native (transcript) | `eval/results/v57-diverse/{v57-div-rep1,2,3}` | 3 | claude-sonnet-5 | 33,885 · 35,561 · 39,402 | 8 · 9 · 9 |
| context-tree | `eval/results/v60-diverse/{1,2,3}` + `v61-diverse/{1,2,3}` | 6 | claude-sonnet-5 | 62,734 · 81,404 · 120,930 · 121,094 · 202,982 · 216,587 | 8 · 10 · 13 · 14 · 18 · 19 |

Median native tokens = 35,561 (exact match). Median native turns = 9 (exact
match). Median tree tokens = avg(120,930, 121,094) = **121,012** (exact match).
Median tree turns = avg(13, 14) = **13.5** (exact match). Cost medians also
reproduce the leaderboard exactly: native $0.0498 vs the leaderboard's $0.050
(`loop-board.md:53`), tree $0.0868 vs the leaderboard's $0.087
(`tree-vs-transcript.md:523`). **This confirms both the run population and that
the tree side is the pooled v6.0+v6.1 diverse-suite set, while the native side
is the separate v57-diverse run** — a same-model, same-benchmark, but
different-day comparison (a caveat carried into §6's rerun plan).

Every subsequent number in this report is computed directly from these nine
`results.json` files (`eval/scripts` were not modified; no live model calls were
made).

## 2. FINDING: the four-way usage ledger sums to the gap exactly

Each run's `metrics.tokens` records `{input, output, cacheRead, cacheWrite,
total}` with `total = input + output + cacheRead + cacheWrite` (verified by
direct summation on every run below; e.g. the representative tree run
`v60-diverse/v60-div-rep3`: 1,302 + 3,975 + 104,911 + 10,742 = 120,930, matching
`metrics.tokens.total` exactly). Because this identity holds per-run, the *mean*
of each field across the n=6 tree runs minus the mean across the n=3 native runs
sums, by construction, to the mean total-token gap — an exact decomposition, not
an estimate:

| Bucket | Tree mean (n=6) | Native mean (n=3) | Diff | % of mean gap |
|---|---:|---:|---:|---:|
| `cacheRead` | 118,705.0 | 27,102.0 | **91,603.0** | 93.5% |
| `cacheWrite` | 10,168.5 | 6,136.7 | 4,031.8 | 4.1% |
| `input` | 1,418.5 | 11.0 | 1,407.5 | 1.4% |
| `output` | 3,996.5 | 3,033.0 | 963.5 | 1.0% |
| **Total** | **134,288.5** | **36,282.7** | **98,005.8** | **100%** |

(Mean gap, 98,006, is larger than the published *median* gap, 85,451 =
121,012 − 35,561, because the tree distribution is right-skewed by two
19-and-18-turn outlier replicates — see §5. Both numbers describe the same
underlying data; the mean decomposition is used here because it is exact under
summation, and the median is not.)

`cacheRead` — tokens re-read from the provider's prompt cache every turn — is
93.5% of the gap. This is expected structurally: `cacheRead` is charged on
*every* turn for the *entire* accumulated prefix (Zone A + Zone B + Zone C for
the tree; the growing message list for native), so it is where both a larger
fixed prefix and a larger turn count would show up. `cacheWrite` (new content
committed to the cache) is a distant second at 4.1% — this is the bucket D5
work in loops 5–9 already spent down (args-capping, fetch-as-events, dedup'd
schemas; `tree-vs-transcript.md` §07, §10). `input` and `output` are noise by
comparison.

## 3. Splitting `cacheRead`: Zone A (measured from source) vs. Zone B/C

`cacheRead` conflates two things: the **fixed** per-turn cost of Zone A (D5:
"frozen system … Caching rewards *stable layout*, not *minimal payload*" —
`docs/IMPLEMENTATION_PLAN.md:57`) and the **growing** per-turn cost of Zone B
(branch summaries) + Zone C (active-branch detail). Zone A's token count is not
an estimate — it was measured with `gpt-tokenizer`'s cl100k encoder directly
against the source files that render it, matching the harness's actual
construction path (`eval/src/loop.ts:719,887`; `eval/src/tools.ts`):

| Component | Source | Tree | Native |
|---|---|---:|---:|
| System prompt | `packages/core/src/prompts/system-contract.v1.md` (tree) / `NATIVE_SYSTEM_PROMPT` in `eval/src/loop.ts:67` (native) | 791 tok | 75 tok |
| Completion addendum | `TREE_COMPLETION_ADDENDUM`, `eval/src/tools.ts` | 206 tok | — |
| Harness tool schemas (`run_command`,`read_file`,`write_file`,`edit_file`) | `HARNESS_TOOL_SCHEMAS`, `eval/src/tools.ts` | 300 tok | 300 tok |
| Context tool schemas (`context_fetch`,`context_search`,`context_peek`,`annotate`) | `CONTEXT_TOOL_SCHEMAS`, `eval/src/tools.ts` | 660 tok | — |
| **Zone A total / turn** | | **1,957 tok** | **375 tok** |

(Per-tool breakdown of the 660: `context_fetch` 217, `context_search` 140,
`context_peek` 120, `annotate` 181 — `context_fetch`'s description alone is 116
tokens, the single largest schema-description line item.)

`eval/src/loop.ts:929-931` — `EVAL_NO_ATOOLS` — shows the schemas are sent via
the API's native `tools` parameter, not duplicated as inline JSON text in the
system block (that duplication was closed in v5.7's "schema dedup",
`tree-vs-transcript.md:451`, and is already baked into the `v6.x` config these
runs use — confirmed by `loop8-interim.md:166`'s "no schema text" ingredient).
So there is no live duplicate-schema bug to report here; the 1,957-token figure
is the schemas billed once, via the `tools` param, plus the system-text blocks.
**This finding matters because it rules out re-proposing an already-fixed bug.**

Zone A × turns, using each arm's own mean turn count (tree 13.667, native
8.667):

- Tree: 1,957 × 13.667 = 26,741
- Native: 375 × 8.667 = 3,250
- **Zone A × turns diff: 23,491** (≈24% of the mean gap)

Subtracting from the `cacheRead` diff of 91,603 leaves **68,112 tokens (≈69.5%
of the mean gap) attributed to Zone B/C growth** — the summaries-plus-active-
branch content that grows over the run and gets re-read every subsequent turn.

## 4. FINDING: Zone B is empty on sw-3 — the "Zone B/C" bucket is really "the whole raw trace, reread"

`tree-vs-transcript.md:493` states plainly for the `v6.x` config: "zero haiku
(summarizer) calls across all 16 runs… 32 runs, 32 zero-crossings" — sw-3's
trace never reaches the 30k-token lazy-summarization threshold
(`eval/src/loop.ts` `lazyTokens`/`belowLazyBudget`), so no branch is ever
summarized. When `belowLazyK` is true, `activeNodeId` is set to the root
(`eval/src/loop.ts:914-917`), meaning **Zone C is the entire raw trace, not one
branch** — the tree arm is, for this task, running in exactly the mode the code
comment (`eval/src/loop.ts:917-925`) predicts: "economically native until the
k-th branch closes," except the k-th branch never closes.

This reframes the "Zone B/C growth" bucket: it is not tree-specific
summarization overhead (there is none here) — it is the cost of **rendering**
the same underlying tool-call/tool-result history native also carries, through
`renderEvent()` (`packages/core/src/assemble/format.ts:130-166`), which prints a
`### tool_call <name> <path> (seq N)` header before every call and a separate
`### tool_result for seq N (seq M) [...]` header before every result — two
boilerplate header lines per tool call that native's plain
`{role, content}` message list does not carry. Given the tree's mean 19.5 raw
tool calls/run, that is up to 39 header lines (~13 tokens each ⇒ ~507 tokens)
written into Zone C — a real but modest slice (≈0.7%) of the 68,112-token
bucket on its own. **The much larger driver, quantified in §5, is how many
times that content gets re-read, not how large it is once.**

## 5. FINDING: extra turns come from lower tool-call batching density, not from context-tool traffic

Counting every `turns[].toolCalls[]` entry by name, across all nine runs:

| Run (sw-3) | Turns | run_command | read_file | write_file | context_* | Total calls | Calls/turn |
|---|---:|---:|---:|---:|---:|---:|---:|
| tree v60-rep1 | 8 | 4 | 6 | 5 | 1 (search) | 16 | 2.00 |
| tree v60-rep2 | 18 | 13 | 0 | 6 | 0 | 19 | 1.06 |
| tree v60-rep3 | 13 | 7 | 7 | 5 | 1 (fetch) | 20 | 1.54 |
| tree v61-rep1 | 19 | 12 | 8 | 6 | 1 (search) | 27 | 1.42 |
| tree v61-rep2 | 10 | 5 | 7 | 5 | 1 (search) | 18 | 1.80 |
| tree v61-rep3 | 14 | 9 | 7 | 5 | 1 (search) | 22 | 1.57 |
| **tree mean** | **13.67** | | | | **0.83/run** | **19.5** | **1.49** |
| native v57-rep1 | 9 | 5 | 13 | 5 | n/a | 23 | 2.56 |
| native v57-rep2 | 8 | 3 | 18 | 5 | n/a | 26 | 3.25 |
| native v57-rep3 | 9 | 5 | 13 | 5 | n/a | 23 | 2.56 |
| **native mean** | **8.67** | | | | | **24.0** | **2.77** |

Two findings fall directly out of this table:

**(a) Context-tool traffic is not the cause of extra turns — this refutes the
brief's stated hypothesis.** `context_fetch`/`context_search`/`context_peek`/
`annotate` were called **0 or 1 times total per run**, never more, across all
six tree replicates (mean 0.83 calls/run out of a mean 19.5 total calls — 4.3%
of tool traffic). The "read-before-edit rule … firing on files already in
context" (`context_fetch`'s own description: "Reach for it BEFORE EDITING any
file whose current content is not already in your context",
`packages/mcp/src/tools/context-fetch.ts:26`) is not repeatedly triggering; in
the one sampled full transcript (`v60-div-rep3`), it fired exactly once, at
turn 0, before any edits — a single, reasonable orientation call, not a loop.

**(b) Native actually issues *more* raw tool calls per run (mean 24.0) than
tree (mean 19.5), yet finishes in fewer turns**, because native batches nearly
twice as many tool calls into each model turn (2.77/turn vs tree's 1.49/turn —
e.g. native's `v57-div-rep1` turn 3 alone issues 8 parallel `read_file` calls;
tree's most similar run, `v60-div-rep3`, tops out at 7). The extra turns are
not "extra work" in the tool-call-count sense; the same (or slightly less)
total work is spread across more, thinner turns.

**Why thinner turns cost more tokens even without more content:** because
`cacheRead` bills the *entire* accumulated context on *every* turn, a fixed
amount of eventual content `C` reached over `T` turns costs roughly `ZoneA×T +
C×(T+1)/2` in cumulative `cacheRead` (each unit of content written early gets
re-read on every one of the remaining turns). For fixed `C`, this is increasing
in `T`. Concretely, on the sampled `v60-div-rep3` transcript, `cacheRead` rows
by turn were `3305, 3873, 4104, 4265, 4923, 7480, 8130, 9173, 10321, 11682,
11926, 12186, 13543` — a content base of ~10,238 tokens (turn-12 minus turn-0,
consistent with that run's `cacheWrite` total of 10,742) gets re-billed 13
times as it accumulates. Running the identical final content through native's
8.7-turn cadence instead of the tree's mean 13.7 would, on this model, shrink
the re-read multiplier by roughly (8.7+1)/(13.7+1) ≈ 0.66 — i.e. **most of the
68,112-token Zone B/C bucket is a turn-count tax, not a content-size tax.**

## 6. FINDING: the sw-3 gap is bimodal — half the tree replicates are close to native, half are far worse

The tree token distribution (62,734 · 81,404 · 120,930 · 121,094 · 202,982 ·
216,587) is not a tight cluster around 3.4×: the best tree replicate
(`v60-div-rep1`, 8 turns, 62,734 tokens) is only **1.76×** native's median and
matches native's own best turn count exactly; the worst (`v60-div-rep2`, 18
turns, 216,587 tokens) is **6.09×**. The published 3.4× figure is the *median*
of a right-skewed n=6 sample, not a stable per-run multiplier. This means the
turn-count/batching mechanism in §5 is doing most of the differentiating work
between "tree pays a modest premium" and "tree pays a large premium" — a rerun
with tighter turn-count control (or more replicates) would sharpen this
considerably (see §7).

## 7. Ranked buckets and the one deletion candidate

Ranked by share of the mean 98,006-token gap:

| Rank | Bucket | Tokens | % of gap | Nature |
|---|---|---:|---:|---|
| 1 | Zone B/C re-read tax from extra turns | ≈68,112 | 69.5% | mechanism, not a rule — see §5/§8 |
| 2 | Zone A × turns (fixed contract + 8 tool schemas, reread every turn) | 23,491 | 24.0% | deletable, D5-compliant |
| 3 | `cacheWrite` excess | 4,032 | 4.1% | already mostly closed by prior loops |
| 4 | `output` excess | 964 | 1.0% | noise |
| 5 | `input` excess | 1,408 | 1.4% | noise (native's `input` is a near-constant 11 tok/run; tree's task-length-dependent) |

**Per the instruction to say so plainly when extra turns dominate rather than
Zone A: they do.** Bucket 1 is 2.9× the size of bucket 2. Zone A is real,
reproducible, and worth trimming regardless — it is free, zero-risk, and
D5-compliant since D5 fixes Zone A's *position and stability*, not its byte
count (`docs/IMPLEMENTATION_PLAN.md:57`: "Caching rewards *stable layout*, not
*minimal payload*") — but it is not the lever that closes this gap.

### The deletion candidate (bucket 2)

`packages/core/src/prompts/system-contract.v1.md`, the final section:

```
## Two ways this goes wrong, and what you do about them

**You cannot ask for what you do not know exists.** ...
[to end of file]
```

This section is 246 of the file's 791 tokens (31%). It restates, in prose,
guidance already present verbatim in each tool's own description (e.g. its
second paragraph — "Fetched content accumulates until it drowns the task…
Fetch narrowly… If something you fetched matters beyond this phase, `annotate`
it" — duplicates `context_fetch`'s own description's closing sentence: "The
result lands in the transcript tail only… never invalidates the cached prompt
prefix," `packages/mcp/src/tools/context-fetch.ts:29-30`). Deleting it leaves
the three numbered rules and the tool list intact — `TOOL_CONTRACT_RULES`
(`packages/core/src/prompts/index.ts:38-43`), which the golden test in
`test/prompts.test.ts` asserts against, is untouched, since it only pins the
three short rules, not this section.

**Predicted saving:** 246 tokens/turn × mean tree turns (13.667) = **3,362
tokens/run** (≈3.4% of the mean 98,006-token gap; using the published median
turn count of 13.5 instead: 246 × 13.5 = 3,321 tokens/run). This is a real,
guaranteed saving with no plausible reliability cost (the deleted prose adds no
new *rule*, only elaboration of existing ones) — but stated honestly, it is far
short of what's needed: closing the full gap to within 50% of native
(loop8-interim's success criterion) requires cutting the 85,451-token *median*
gap by ~79% (target ≈53,342 total tokens, vs the current 121,012). Even
deleting all 23,491 tokens of the tree-specific Zone A overhead (bucket 2 in
full) only reaches ≈27% of that requirement.

A secondary, smaller candidate in the same file: the "## Rules" section's
elaboration paragraphs (the sentence following each of the 3 numbered rules)
tokenize at 152 tokens beyond the bare numbered rules (67 tokens) — total
Rules-section trim potential ≈152 tokens/turn on top of the 246 above, for a
combined ≈398 tokens/turn (≈5,441 tokens/run at mean turns). Not pursued as the
primary candidate here because the "Two ways" section is more cleanly
self-contained (a single heading-to-EOF deletion) and already 31% of the file
on its own.

## 8. What "removes the trigger" for extra turns — an open finding, not a proposed deletion

No line of Zone A text was found that plausibly *instructs* the model to batch
fewer tool calls per turn in the tree condition. The three numbered rules
(read-before-edit, follow summary metadata, peek when in doubt) and the
completion addendum (`eval/src/tools.ts`'s `TREE_COMPLETION_ADDENDUM`) are, if
anything, aimed at *reducing* redundant verification ("If the Active branch
already shows your command succeeding… the step is DONE — do not re-run it").
Two live hypotheses remain untested by this analysis (flagged as HYPOTHESES,
not findings):

- **HYPOTHESIS:** the cautious framing of Zone A generally ("Detail you cannot
  see has not been lost… Assuming you already have it is not") shifts the
  model toward a more incremental, check-one-thing-at-a-time working style even
  when it never calls a context tool, versus native's flatter, more
  transactional framing.
- **HYPOTHESIS:** this is sampling variance from an uncontrolled-temperature
  model (`tree-vs-transcript.md`'s methodology note: "the Claude 5 API rejects
  the `temperature` parameter outright") rather than a systematic framing
  effect — consistent with §6's bimodal distribution (one tree replicate
  matches native's turn count exactly).

Per the brief's instruction to say so plainly rather than force a rule-removal
candidate that isn't evidenced: **this report does not propose a Zone A
deletion for the turn-count mechanism**, because none was found to be its
cause. §9's rerun plan is designed to distinguish the two hypotheses above.

## 9. Rerun plan

**Design:** sw-3-refactor, tree vs native, n=5 per arm (up from the existing
n=3/n=6), model `claude-sonnet-5` (the model every number in this report and
in `loop8-interim.md`/`tree-vs-transcript.md` uses), run same-epoch (same day,
interleaved) rather than reusing `v57-diverse`/`v60/v61-diverse` — the existing
comparison already spans two different collection dates (v57-diverse vs
v60/v61-diverse), and `tree-vs-transcript.md`'s own methodology insists on
same-epoch pairs ("Fresh baselines, same epoch… so drift in the underlying
model isn't mistaken for a code change," §10) precisely to avoid this
confound.

**Arms to run:**
1. `native`, current config (baseline, unchanged).
2. `context-tree`, current `v6.x` config (baseline, unchanged) — re-establishes
   the 121,012/13.5 numbers same-epoch with native, replacing the cross-epoch
   comparison this report had to reconstruct.
3. `context-tree` + the §7 Zone A deletion only (the "Two ways this goes
   wrong" section removed from `system-contract.v1.md`) — isolates bucket 2's
   real-world saving and confirms it doesn't change turn count or success.
4. *(Optional, if arm 3's turns match arm 2's)*: `context-tree` with a batching
   nudge in `TREE_COMPLETION_ADDENDUM` (e.g. "batch independent read/write/
   run_command calls into one turn when they don't depend on each other's
   output") to directly test the §8 framing hypothesis — this is a rule
   *addition*, so only worth running once arm 3 shows the deletion alone isn't
   sufficient, and should be reported as a separate, explicitly-flagged
   exception to "rule-removal beats rule-addition," not folded into the
   headline deletion.

**Expected tokens/USD** (extrapolating this report's measured rates; not a live
projection):
- Native, n=5: ≈35,000–40,000 tokens/run, ≈$0.048–0.055/run ⇒ ≈$0.25 total.
- Tree (arm 2, baseline), n=5: ≈85,000–130,000 tokens/run (wide, per §6's
  bimodality), ≈$0.065–0.115/run ⇒ ≈$0.45 total.
- Tree (arm 3, Zone A trimmed), n=5: ≈3,300 tokens/run less than arm 2, cost
  delta negligible (<$0.01/run) ⇒ ≈$0.43 total.
- Total for arms 1–3, n=5 each: **≈$1.10–1.30**, comparable to a single
  loop-7-style probe (loop 7 metered $20.76 across 121 runs, so this is a
  small fraction of a full loop's budget).

**Exact success check**, matching `loop8-interim.md:151`'s stated criterion:
tree median tokens ≤ 1.5 × native median tokens (i.e. tree median ≤ ~1.5 ×
whatever the fresh same-epoch native n=5 median turns out to be — using this
report's existing native median of 35,561 as a placeholder, target ≤53,342),
**with success rate unchanged** (currently 3/3 native and 6/6 tree — the rerun
must stay 5/5 on both arms; any new failure is a hard stop on the change,
independent of the token result, per loop 7's own gating discipline). If arm 3
alone does not meet the ≤1.5× bar (expected, given §7's ≈3.4%-of-gap estimate),
the turn-count mechanism in §5/§8 is confirmed as the blocking factor and
becomes the next loop's primary target — arm 4's batching-nudge experiment (or
a comparable turn-reduction change) rather than any further Zone A trimming.

## Open questions

- Why does native batch ~2.77 tool calls/turn against tree's ~1.49? No textual
  trigger was found in Zone A; §8's two hypotheses (framing effect vs.
  temperature-free sampling variance) are untested.
- Is the `renderEvent()` per-call header overhead (`### tool_call …`/`###
  tool_result …`, ≈13 tokens × 2 per call) worth trimming independently of the
  turn-count fix? It is a real, separable ≈0.7%-of-gap saving not covered by
  either candidate above.
- The native/tree comparison in this report is cross-epoch (v57-diverse vs
  v60/v61-diverse, different collection dates). §9's rerun plan is designed to
  close this gap; until it runs, treat the exact 3.4×/85,451-token headline as
  slightly confounded by date, even though every other number in this report
  reproduces the published figures exactly from the existing files.
- This report's bucket table uses **means** (exact under summation) while
  `loop8-interim.md` reports **medians**; §6 shows the tree distribution is
  right-skewed enough that this matters for interpretation, though not for the
  qualitative ranking (Zone B/C re-read tax > Zone A > cacheWrite > noise held
  under both a mean-based and a spot-check median-pair computation during this
  analysis).
