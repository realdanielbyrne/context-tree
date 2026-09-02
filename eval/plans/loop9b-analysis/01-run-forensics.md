# Run Forensics: What Actually Stopped the Model on `transplant/s1`

## Abstract

The user's hypothesis was that the transplant harness's tooling — turn caps, truncation,
or a broken retrieval loop — mechanically prevented small-window models from gathering
the facts they needed, and that this (not model competence) explains why the `tree` arm
scored 0.000 on the `tail` stratum while `truncate-tail`/`compact-rolling` scored
0.200–0.333, and why `tree`/`tree-wide` beat both baselines on `head` (0.091/0.273 vs
0.000). I classified all 135 sampled model-turn transcripts (head+tail+deep strata,
`tree` and `tree-wide` arms, both models) into six mutually exclusive failure mechanisms
using the recorded `fetchedIds`, `searchQueries`, `resultsTruncated`, and `status` fields
cross-referenced against each question's true source node and `g15`'s self-retrieval
ranks. The harness's own instrumentation gap turns out to be central to the answer: it
never records the `depth` or `file` argument a model passed to `context_fetch`, so the
single most likely tail-specific mechanism — the tool's `depth: 'summary'` default
silently handing back a paraphrase instead of the literal — **cannot be confirmed or
ruled out from the recorded data**, only inferred circumstantially. What the data *does*
confirm: (1) truncation of a **correctly targeted** fetch never happened once in the
110-row failure sample — zero cases; (2) the harness's context_search JSON, which embeds
each hit's *entire* untruncated summary text, blew through the available per-turn
headroom repeatedly at W=16384 (8/15 sampled tail+head gpt-3.5 rows), never at W=32768;
(3) 21/135 sampled rows (15.6%) are OpenRouter infrastructure failures unrelated to
context provisioning at all, and one `tree` cell (qwen, `spanning`, W=32768) lost 10 of
15 reps to this, which is a data-quality problem independent of the context-tree design;
(4) the tail vs head split is structurally explained by where each question's source node
sits relative to the window's visible Zone-B branch range, not by any tool malfunction —
tail sources are the ones the window renders directly as a (lossy) summary, so a model
that trusts what's already visible never needs the tool loop at all, while head sources
are invisible unless retrieved, which is exactly the situation `tree` improves on
baselines in. The clearest single-sentence verdict: **the harness limited the model on
tail mainly by never forcing it past the ambient lossy summary** (34.8% of failures never
called `context_fetch` at all after searching, and a further 4.4% fetched the exact
correct branch, got no truncation, and still answered wrong) — a *design* limitation of
what `tree`'s summaries carry and what the tool-use policy asks for, not a hard resource
cap the harness imposed by accident.

## Setup and terms

- **Scenario**: `eval/fixtures/transplant/s1/e1b289c32f40` — one frozen 754-event Claude
  Code trace (`manifest.json`: `l0_events: 754`, `nodes: 46`, `summaries: 22`),
  reorganized once into a `tree` (`packages/core` SQLite store at
  `eval/fixtures/transplant/s1/store/tree.db`), then replayed to two small-window models
  (`qwen/qwen-2.5-72b-instruct` at W=32768, `openai/gpt-3.5-turbo` at W=16384) under
  several context-management **arms**.
- **Arms in scope**: `tree` (root-keep ladder walks largest-keep-first, `ARM_ROOT_LADDER.tree`
  in `eval/scripts/transplant.mjs:358-362`) and `tree-wide` (same ladder reversed —
  smallest-keep-first, so it trades a smaller root block for more visible branch
  summaries; `eval/scripts/transplant.mjs:349-362`).
- **Strata**: `head` (question sourced from early in the 754-event trace), `tail` (sourced
  from near the end), `deep` (an identifier/import buried inside a large diff), `spanning`
  (crosses branches) — assigned in `questions.json`.
- **A "branch"** = one `phase`-kind SQLite node (21 of them cover the whole trace; see the
  node table below). `context_search` ranks branch summaries; `context_fetch(branch_id,
  depth)` returns either the branch's **LLM-written summary** (`depth: 'summary'`,
  the *default* when the argument is omitted) or a **full byte-for-byte replay** of the
  branch's raw event span (`depth: 'full'`) — `packages/core/src/retrieve/retriever.ts:188-239`.

## Files and tools read

- Run records: `eval/fixtures/transplant/s1/e1b289c32f40/results/run-W32768-truncate-tail+compact-rolling+tree-qwen_qwen-2.5-72b-instruct.json`, `run-W32768-tree-wide-qwen_qwen-2.5-72b-instruct.json`, `run-W16384-truncate-tail+compact-rolling+tree-openai_gpt-3.5-turbo.json`
- `questions.json`, `literals.json`, `gates.json`, `manifest.json`
- Store: `eval/fixtures/transplant/s1/store/tree.db` (`nodes` table), `eval/fixtures/transplant/s1/store/trace.jsonl` + `blobs/` (rendered raw spans by hand, replicating `renderSpans`)
- Harness: `eval/scripts/transplant.mjs` (`runOneReplicate` ~L2430-2540, `capToolResult` L254-288, `deriveRootKeep`/`ARM_ROOT_LADDER` L344-395, arm dispatch `buildFor` L2380-2424, `MAX_TURNS=6` at L114)
- Tool semantics: `packages/mcp/src/tools/context-fetch.ts`, `packages/mcp/src/tools/context-search.ts`, `packages/core/src/retrieve/retriever.ts` (`fetchBranch` L188-239, `peek` L246-269)

---

## 1. FINDING: the harness never records `depth` or `file` — this is the single biggest gap in this dataset

`eval/scripts/transplant.mjs:2498-2499`:

```js
if (call.name === CONTEXT_SEARCH && typeof call.input.query === 'string') searchQueries.push(call.input.query);
if (call.name === CONTEXT_FETCH && typeof call.input.branch_id === 'string') fetchedIds.push(call.input.branch_id);
```

Only `query` and `branch_id` are captured. `call.input.depth` and `call.input.file` —
both real, documented arguments on `context_fetch`
(`packages/mcp/src/tools/context-fetch.ts:32-40`, `depth` defaulting to `'summary'` when
omitted) — are read by the handler but never logged anywhere in the row JSON. Every run
row confirms this: the full key set on a completed row is `['annotateRefused', 'arm',
'durationMs', 'fetched', 'fetchedIds', 'finalText', 'model', 'modelTurns',
'peakRequestTokens', 'perLiteral', 'question', 'rep', 'resultCharsTruncated',
'resultTokensTruncated', 'resultTruncationEstimated', 'resultsTruncated', 'scenario',
'score', 'searchQueries', 'searched', 'status', 'stratum', 'success', 'turns', 'usage',
'window']` — no `fetchDepth`, no `fetchFile`, no raw tool-result text.

**Consequence**: for every row where the model fetched the *correct* branch and still
answered wrong (6 of 110 non-infra failures in the sampled set, concentrated in `tail`
and `head`), it is impossible to mechanically tell "the tool handed back only the lossy
LLM summary" from "the model had the verbatim full-replay text in front of it and still
couldn't extract one field of a JSON blob." This is exactly the ambiguity that decides
whether the user's hypothesis (tooling limited it) or the rival hypothesis (competence
limited it) is correct for that slice — and the dataset cannot settle it. **This is
itself the most important run-forensics finding**: before re-running anything, the
harness should log `call.input` verbatim for every tool call.

## 2. FINDING: OpenRouter infra failures eat a large, uneven share of the sample

Counting `status: "model_call_error"` (`"openrouter returned no choices"` or `"...400
Provider returned error"`) rows in the 135-row head+tail+deep sample:

| model / window / arm | errors | of | note |
|---|---|---|---|
| qwen / W32768 / tree | 20 | 60 (all 4 strata) | `('tree','spanning')` alone lost **10/15** reps |
| qwen / W32768 / tree-wide | 15 | 60 | `('tree-wide','deep')` lost 5/15 |
| gpt-3.5 / W16384 / tree | 0 | 60 | clean |

Full-sample score aggregation (recomputed directly from the row files, matching the
numbers in the task prompt exactly):

| model/W | arm | stratum | n valid | errors | mean score |
|---|---|---|---|---|---|
| qwen/32768 | tree | tail | 12 | 3 | **0.000** |
| qwen/32768 | truncate-tail | tail | 15 | 0 | 0.200 |
| qwen/32768 | compact-rolling | tail | 15 | 0 | 0.333 |
| qwen/32768 | tree | head | 11 | 4 | **0.091** |
| qwen/32768 | tree-wide | head | 11 | 4 | **0.273** |
| qwen/32768 | truncate-tail | head | 14 | 1 | 0.000 |
| gpt-3.5/16384 | tree | tail | 15 | 0 | **0.000** |
| gpt-3.5/16384 | truncate-tail | tail | 15 | 0 | 0.333 |

The `tree`/tail = 0.000 result is **not** a small-sample artifact of dropped reps: on
gpt-3.5 (zero infra errors) it is a clean 0/15. On qwen it is 0/12 valid. Both are
genuine zeroes, not errors misclassified as failures. But the `('tree','spanning')`
10/15-error cell means any spanning-stratum conclusion from this run would be resting on
n=5 — that is a data-quality problem worth fixing (re-run) before trusting spanning
numbers, and it is unrelated to context-tree design.

## 3. FINDING: tail and head differ mechanically in *where the source sits relative to what's already visible* — not in tool malfunction

The `tree` arm's root-ladder derivation (`deriveRootKeep`, `eval/scripts/transplant.mjs:388-395`)
picks the **largest** `rootKeep` that still fits Zone B. At W=32768 that is `rootKeep=16`,
`rootBlockTokens=6095`, leaving room for only **2 branch summaries** in the visible
Zone B, covering `branchSeqRange: {from: 639, to: 754}` (`manifest.json`, confirmed in
every run row's `budgets` block). Everything with `span_end_seq < 639` is **not** rendered
as its own branch summary in the prompt at all — it exists only inside the compressed
root "headline" ladder.

Querying `nodes` (`eval/fixtures/transplant/s1/store/tree.db`) for the source node of
every sampled question:

| question | stratum | seq | source node (`kind`, span) | inside visible Zone B range (639–754)? |
|---|---|---|---|---|
| q01 | head | 175 | `n_1E48X9HAFPEYNQHHSF609KHMEE` phase `implementation`, 55–261 | **No** |
| q02 | head | 558 | `n_1C0BDXFHPYAX7N4B5AGK8KB4Q5` phase `implementation`, 554–570 | **No** |
| q03 | head | 18 | `n_1JNW5D8CNYSATE4X6NV3Z39R81` phase `diagnosis`, 1–54 | **No** |
| q04 | tail | 728 | `n_1A84WKF26NWA90DDR9ENP8BMSD` phase `delivery`, 639–731 | **Yes** |
| q05 | tail | 744 | `n_1PPHC64K0QTM0N8JD3RPST4GZ8` phase `implementation`, 732–754 | **Yes** |
| q06 | tail | 746 | `n_1PPHC64K0QTM0N8JD3RPST4GZ8` (same) | **Yes** |

All three `head` sources are **outside** the window the assembler renders inline — a
model literally cannot answer without a tool call (search+fetch) reaching further back
than the prompt shows. All three `tail` sources are **inside** it — their branch summary
is already sitting in Zone B, un-asked-for, when the model reads the prompt. This
explains the asymmetry cleanly:

- On `head`, the tool loop is the *only* path to any signal, so `tree`/`tree-wide` (which
  at least offer a fetchable, targeted branch) beat baselines that evicted the content
  outright (`truncate-tail`/`head` = 0.000 — confirmed above; the raw tail window simply
  doesn't reach back to seq 18/175/558).
- On `tail`, the model already "has" a compressed one-paragraph summary of the right
  branch without lifting a finger, and both `truncate-tail` and `compact-rolling` still
  hold the **raw, uncompressed** verbatim text for that same range (`truncate-tail`'s
  keep window `K = floor(0.85×32768/0.8509) − reply ≈ 30,807` heuristic tokens covers
  roughly the trace's last ~140 events out of 754 — comfortably including seq 728/744/746)
  — so the literal is sitn in the baseline's context whether or not the model calls a
  tool, while `tree`'s Zone B only ever offers the **lossy** summary of that same branch
  unless the model explicitly re-fetches it at `depth: 'full'`.

## 4. FINDING: zero truncation of a correctly-targeted fetch, anywhere in the sample

Rendering each source branch's raw span by hand (trace.jsonl + blobs, replicating
`renderSpans`) and locating each `answer_literals[0]` inside it:

| question | branch raw span (chars) | literal char-offset | % through the branch |
|---|---|---|---|
| q01 (head) | 85,003 | 32,464 | 38.2% |
| q02 (head) | 14,374 | 4,183 | 29.1% |
| q03 (head) | 158,327 | 97,241 | 61.4% |
| q04 (tail) | 84,516 | 82,491 | **97.6%** |
| q05 (tail) | 34,019 | 12,308 | 36.2% |
| q06 (tail) | 34,019 | 19,043 | 56.0% |
| q07 (deep) | 158,327 | 7,516 | 4.7% |

`truncateToTokens` (`packages/core/src/assemble/format.ts:199-220`) keeps the **head** of
any text it must cut and elides the tail — so q04's literal, sitting at 97.6% through an
84K-char branch, would be the very first thing lost under any truncation. But **no row in
the sample that fetched the correct branch was ever truncated** (`resultsTruncated == 0`
in every one of the 6 `fetched_correct_no_trunc_still_wrong` rows, plus the single
`fetched_correct_then_turn_capped` row). Cross-checked against measured per-turn headroom
(§5 below): at W=32768, turn-1 headroom (~22.8K tokens) exceeds even q04's ~18K-cl100k-token
full branch, so a first-turn full fetch of q04's branch would plausibly fit whole. The
truncation-cutoff mechanism the task asked me to test for (d) **did not fire once** in
this sample — it is a live risk given the architecture (see the min-headroom rows in §5),
but it was not what actually broke these 6 rows.

## 5. FINDING: measured per-turn headroom — generous at W=32768, nearly gone by turn 2 at W=16384

`capToolResult` (`eval/scripts/transplant.mjs:254-288`) computes headroom dynamically —
`window − tokens(system+messages+tools so far) − maxReplyTokens(800) − margin(64) −
prefix − overhead(4)` — every time a tool result is about to be appended, not from a
fixed Zone budget. Computed directly from the recorded `turns[].promptTokens` across all
non-error sampled rows:

| model/window | arm | turn | mean promptTokens (n) | mean headroom for next append | **worst-case headroom seen** |
|---|---|---|---|---|---|
| qwen/32768 | tree | 1 | 9,070 (n=40) | ~22,825 | 22,811 |
| qwen/32768 | tree | 2 | 14,938 (n=34) | ~16,957 | **4,503** |
| qwen/32768 | tree | 3 | 16,971 (n=26) | ~14,924 | **372** |
| qwen/32768 | tree-wide | 1 | 9,414 (n=45) | ~22,481 | 22,467 |
| qwen/32768 | tree-wide | 2 | 14,608 (n=43) | ~17,287 | 8,265 |
| qwen/32768 | tree-wide | 3 | 16,095 (n=36) | ~15,800 | **5** |
| gpt-3.5/16384 | tree | 1 | 5,260 (n=60) | ~10,251 | 10,236 |
| gpt-3.5/16384 | tree | 2 | 10,119 (n=57) | ~5,392 | **86** |
| gpt-3.5/16384 | tree | 3 | 15,439 (n=4) | ~72 | **67** |

At **W=32768** turn 1 has more headroom (~22.8K tokens) than the entire nominal Zone B
budget (`zoneB=7701` from `manifest.json`/`budgets`), because Zone C is still nearly
empty on turn 1 — but by turn 2–3 a handful of rows are down to a few hundred tokens or
less. At **W=16384**, turn 2 headroom has a mean of only ~5.4K tokens and a measured floor
of **86 tokens** — for the rows that reach turn 3 at all, headroom is essentially zero
(67–86 tokens, room for nothing but an elision marker). This is a genuinely
harness/window-shaped constraint, and it is model- and window-dependent, not something
`tree` uniquely inflicts (`capToolResult` is "arm-neutral by construction," per its own
docstring at `eval/scripts/transplant.mjs:249-252`).

**Directly attributable truncation event, confirmed**: 8 of 15 sampled gpt-3.5/W=16384
`tree` rows on `head`+`tail` show the **search result itself** truncated by 2,700–16,000
characters (700–4,000 cl100k tokens) — e.g. `s1-q06-tail rep2`: `resultCharsTruncated:
15965`, `resultTokensTruncated: 4008`. This happens because `context_search`'s
`SearchHitPayload.text` field (`packages/mcp/src/tools/context-search.ts:83-95`) returns
each candidate's **entire, untruncated** branch-summary text — not the 240-char
`snippet` used for the merged `candidates` list (`toCandidate`, same file, line 108) —
so a single `context_search` call at `retrieval.limit=20` (the harness's configured
limit, confirmed by the comment at `eval/scripts/transplant.mjs:144`) can itself run to
several thousand tokens of JSON, and at W=16384 that alone can exceed what's left. **This
never happened at W=32768** in the sample (zero qwen rows show a truncated, non-fetch
search result) — it is a small-window-specific effect. Whether the correct node's hit
was among the characters *dropped* by this truncation could not be determined without
also logging the raw search-tool output (another instrumentation gap), so I report this
as a confirmed truncation event with an **unconfirmed** effect on retrievability.

## 6. HYPOTHESIS (not confirmed): `context_fetch`'s `depth: 'summary'` default explains most of the "fetched the right branch, still wrong" cases

`context_fetch`'s `depth` argument defaults to `'summary'` when the model omits it
(`packages/mcp/src/tools/context-fetch.ts:32-35`, `retriever.ts:190`). A `'summary'` fetch
returns the LLM-generated paraphrase of the branch — never a verbatim quote, number, or
identifier unless the summarizer happened to reproduce it. The circumstantial evidence:

- `q06` (tail, `tree` arm, qwen): **3 of 5 reps fetched the exact correct branch**
  (`n_1PPHC64K0QTM0N8JD3RPST4GZ8`) with `resultsTruncated: 0` — and every one still
  scored 0. The branch's raw text is only 34,019 chars (well inside the measured turn-1/2
  headroom of 15–22K tokens), and the literal sits at 56% through it — not a "past the
  cut" case per §4. The behavioral signature — right branch, no truncation, still
  wrong — is exactly what a `'summary'`-depth fetch would produce for a verbatim-quote
  question, and is much less consistent with a full-replay fetch (which should contain
  the literal in this size regime).
- Both other `fetched_correct_no_trunc_still_wrong` rows (`q04` tail rep... and one
  `head` case) show the same signature.

I cannot promote this to a FINDING because §1 established that `depth` is never
recorded — there is no way to confirm from this dataset whether these 6 rows passed
`depth: 'full'` and still failed to extract the string (a genuine model-competence
limit — plausible for `q04`, whose literal sits 97.6% into an 84K-character raw JSON
dump, a real needle-in-haystack case even at full depth) or never specified `depth` and
got the default summary (a harness/tool-design limit). **Both are live explanations and
the evidence does not adjudicate between them for `q04`**; for `q06` the small branch
size makes the summary-default explanation the more likely of the two, but "more likely"
is as far as the data goes.

## 7. FINDING: the model's own search queries diverge sharply from what `g15`'s self-retrieval gate tested — the gate is a poor proxy for live search success

`gates.json`'s `g15-self-retrieval` reports every question's source node ranks within
the top 20 of 19 total ranked branches (`"ok": true` for all 12), and is explicitly
flagged in its own `detail` string as **vacuous**: *"WARNING: topK=20 >= 19 results
returned, so this threshold accepts every result the search returns and proves nothing
about referent uniqueness."* `gates.json` also reports `"vacuous": true` at the top
level. Per-question ranks (root excluded, out of 19 ranked candidates):

| question | g15 rank | note |
|---|---|---|
| q01 head | 15/19 | |
| q02 head | 11/19 | |
| q03 head | 15/19 | |
| q04 tail | 10/19 | |
| q05 tail | 8/19 per `questions.json`'s embedded `self_retrieval.rank`; `gates.json`'s own `selfRetrieval` array lists **7/19** for the same question — a minor off-by-one inconsistency between the two gate artifacts, noted but not chased further | |
| q06 tail | 5/19 | |
| q07 deep | **1/19** | best rank of all 12 |
| q08 deep | 11/19 | |
| q09 deep | 17/19 | worst rank of all 12 |

But `g15` almost certainly queries with something close to the answer literal itself
(a best-case query), while the **model's own** query is a paraphrase of the *question*.
For `q07` (best possible rank, 1/19), the model's actual queries across all 15
tree/tree-wide/gpt-3.5 reps were things like `'loop.test.ts'`, `'eval/test/loop.test.ts'`,
`'numparse test cases'` — none related to the true literal (`from dedent import
dedent_text`, an import in a different file). **Zero of 15 reps fetched the correct
branch for q07**, despite it having the single best self-retrieval rank in the gate
suite. This is the clearest evidence that `g15` measures retrievability-in-principle
(if you already know roughly what to search for) and says nothing about whether an
unassisted small model will *form* that query — which is the actual bottleneck for
`deep`-stratum and several `head`-stratum questions.

## 8. Mechanism aggregation (the requested breakdown)

Classifying all 135 sampled rows (head+tail+deep × {tree, tree-wide} × {qwen@32768,
gpt-3.5@16384}, tree-wide only exists for qwen) by first matching `fetchedIds` against
each question's true `node_ids`:

| category | count | % of all 135 | % of the 110 non-infra, non-success failures |
|---|---|---|---|
| infra_error (OpenRouter) | 21 | 15.6% | — (excluded) |
| success | 4 | 3.0% | — (excluded) |
| **searched, never called `context_fetch`** | 47 | 34.8% | **42.7%** |
| **fetched a wrong branch** | 44 | 32.6% | **40.0%** |
| **never searched, never fetched** (answered from ambient Zone A–C alone) | 12 | 8.9% | **10.9%** |
| **fetched the correct branch, no truncation, still wrong** | 6 | 4.4% | **5.5%** |
| **fetched the correct branch, then hit the turn cap** | 1 | 0.7% | **0.9%** |
| **fetched the correct branch but it was truncated** | 0 | 0.0% | **0.0%** |

Mapped onto the task's six requested buckets:

- **(a) search never surfaced the source** — not separately observable from this data
  (the row JSON never stores the search tool's raw hit list, only the query text and
  whatever got fetched afterward — another instrumentation gap); folded into "wrong
  branch fetched" / "never fetched" above, since a query that never returns the right
  hit and a query that returns it but gets ignored look identical in the row log.
- **(b) model never fetched** — 34.8% (searched but stopped) + 8.9% (never even
  searched) = **43.7% of all sampled rows, ~53.6% of failures**. This is the dominant
  mechanism.
- **(c) fetched at summary depth only** — cannot be confirmed (§1, §6); circumstantially
  implicated in most of the 4.4% "fetched correct, no truncation, still wrong" bucket.
- **(d) fetched full but literal past the cut** — **0 confirmed cases** in the sample
  (§4); a measured architectural risk (§5) that did not materialize here.
- **(e) turn cap (`MAX_TURNS=6`)** — 7/135 rows (5.2%) hit `status: 'turn_cap'`; only 1
  of those had also reached the correct branch first. A minor contributor.
- **(f) fetched correctly, answered wrong regardless** — the 4.4%/0.7% rows above; real,
  but small relative to (b).

By stratum, the qualitative pattern is consistent: `tail` failures skew even more toward
"searched, never fetched" (23/44 tail-stratum failures, 52%) than `head` (17/41, 41%) or
`deep` (7/37, 19%) — matching the §3 explanation that a visible-but-lossy tail summary
gives the model less reason to reach for the tool at all. `deep`-stratum failures skew
overwhelmingly toward "wrong branch fetched" (23/37, 62%) — consistent with §7's finding
that deep identifiers/imports are hardest to phrase a matching query for.

## Verdict on the user's hypothesis

**Partially confirmed, with the locus of "limitation" different from what "harness
bug" usually implies.** The harness did not silently drop or corrupt data the model
asked for correctly — zero cases of a correctly-targeted, untruncated fetch being cut
off were observed, and turn-cap exhaustion is a minor (5.2%) contributor. What actually
limited the model, in order of evidenced weight:

1. **The tool-use *policy* the model followed, not the tool's capacity** — over half of
   sampled failures never got as far as a targeted `context_fetch` of the true source at
   all (§8), and this is worst on exactly the stratum (`tail`) where a compressed
   summary was already sitting unrequested in the visible prompt (§3) — a model that
   trusts what it can already see has no trigger to call the tool.
2. **An architecture choice with a plausible but unconfirmed failure mode** — `depth:
   'summary'` as `context_fetch`'s default, combined with the harness never logging which
   depth was actually requested (§1, §6), which is a genuine data gap this experiment
   should close before its `tail` result is treated as settled.
3. **A real, window-dependent resource constraint** — at W=16384 (not W=32768),
   `context_search`'s own untruncated-summary payload can eat most of a turn's headroom
   (§5), which is squarely a harness/tool-design interaction, confirmed in 8/15 sampled
   gpt-3.5 rows.
4. **A retrieval-gate/reality gap** — `g15`'s self-retrieval numbers, cited as evidence
   the tree is "searchable," are vacuous by the gate's own admission and use a query the
   model never actually forms (§7); this doesn't limit the model directly but it does
   mean the design's own confidence signal for retrievability is not informative.
5. **Meaningful non-context noise** — 15.6% of the sampled rows are OpenRouter
   infrastructure failures, and one full arm×stratum cell lost two-thirds of its reps to
   this (§2); any interpretation of `spanning`-stratum numbers in this run should be
   suspended until it is re-run clean.

None of this rules out plain model-competence limits coexisting in the same rows (§6,
`q04`'s 97.6%-deep literal in an 84K-character dump is a legitimately hard extraction
task for a 72B model even with full context) — the report separates what is evidenced
from what remains a live, unresolved hypothesis rather than picking a side the data
cannot settle.

## Open items for the next pass

- Re-run with `call.input` logged verbatim for every tool call (resolves §1/§6
  definitively — this is the highest-leverage single instrumentation fix).
- Log the raw `context_search` hit list per call (resolves whether truncated search
  responses at W=16384 actually dropped the correct node, §5).
- Re-run the `('tree','spanning')` and `('tree-wide','deep')` cells at qwen/W=32768 to
  replace the infra-error-depleted samples (§2).
- Consider whether `context_fetch`'s Zone-A tool description should more strongly nudge
  `depth: 'full'` for quoted/ident/number-kind questions, or whether the default should
  be reconsidered — but only after §1's logging fix confirms this is actually happening.
