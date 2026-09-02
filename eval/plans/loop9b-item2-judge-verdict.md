# Loop-9b item 2 — Panel A judge verdict: "let the model gather what it needs each turn"

**Panel question (repo owner, verbatim):** *"If the context window is going unused, and the
model needs more information, then it should go and gather that info… Would it make sense to
allow the model to traverse down rolled up nodes to their leaves so that they can capture
subsections of the context they need?… Summaries aren't context enough sometimes, and real
context blocks likely win."*

**Designs judged:** `A-surface` (widen the fetch tool's default and addressable unit),
`A-policy` (replace the contract rule that fails to make the model reach), `A-null`
(instrument first, change only what a recorded failure names).

**Winner: `A-surface`, 46/60**, with three grafts from `A-policy` and two from `A-null`, one of
which becomes a second live arm.

Terms used throughout. An **arm** is one context-management configuration replayed against the
frozen `s1` store (`eval/scripts/transplant.mjs:167-175`). A **stratum** is where a question's
answer literal sits in the 754-event trace: `head` (early), `tail` (late), `deep` (literal
absent from every stored summary), `spanning` (crosses branches). **Zone A / B / C** is D5's
fixed prompt layout — frozen system text plus tool schemas / root and branch summaries in
creation order / active-branch detail — with tool results appended *after* Zone C
(`docs/IMPLEMENTATION_PLAN.md:409`, rule 3). **Headroom** is what `capToolResult`
(`transplant.mjs:254-288`) has left for one appended tool result. A **rolled-up node** is a
phase node the prompt shows only as a summary. A **span** is a node's
`[span_start_seq, span_end_seq]` window over the append-only L0 trace log.

---

## 0. Four measurements this judge ran before scoring

The panel disagreed about facts, so I recomputed the load-bearing ones rather than trusting any
designer's paraphrase. All four are zero-token, reproducible from the frozen fixture, and all
four change the ranking.

**(J1) No answer literal occurs in any summary, in any stratum, in any version.** Against
`eval/fixtures/transplant/s1/store/tree.db`, all 1,339 rows of `node_summaries` (text and
`meta_json`), all 12 `answer_literals`: zero hits. Re-run against the 22 *current* summaries
using the frozen `answer_regexes` — the exact patterns `exactMatchJudge` grades with
(`JUDGE-VERDICT.md:56`) — also zero hits, over 45,057 characters of summary text plus metadata.
`01-run-forensics.md` §6 could only call the summary-default a hypothesis it could not confirm;
this measurement settles half of it. **A `context_fetch` that returns a summary cannot score on
this question set, ever, by construction.** Only `A-surface` found this, and it is the single
most consequential fact in the panel.

**(J2) The `file` parameter does not narrow anything on this store, and half the phases have
nothing under them to narrow to.** Of 21 phase nodes, 11 have zero `file` children. In every
parented phase I checked, the first child's span is byte-identical to the parent's — q01/q07's
source `n_1E48X9HAFPEY` spans 55–261 and its first child spans 55–261; q02/q08's spans 554–570
and so does its only child; q05/q06's spans 732–754 and so does its only child. `fileNodes()`
resolves children by path, not by slice (`packages/core/src/retrieve/retriever.ts:342-355`), and
raises `E_RETRIEVE_NO_FILE_NODE` when no file node matches (`:348-353`). So the contract's claim
that `file` is "the common case and the cheap one"
(`packages/core/src/prompts/system-contract.v1.md:32-34`, echoed in
`packages/mcp/src/tools/context-fetch.ts:28-29`) is false on the one real fixture. **The
owner's "traverse down to the leaves" does not exist as a size reduction here — the leaves are
the same bytes. The only sub-branch unit that exists is a sequence range.**

**(J3) Raw span sizes, recomputed from L0 + L2 (`blob`, `args_blob`, `output_blob` byte sums,
converted at chars/4 × 0.8509, the `g7-bpe-ratio` measured on this exact trace).** These
reproduce `A-surface`'s table exactly and contradict `01-run-forensics.md` §4, which appears to
have swapped q01's and q03's sources:

| question(s) | source node | span | chars | ~cl100k tok | fits turn-1 headroom @32k (22.8k)? | @16k (10.25k)? |
|---|---|---|---|---|---|---|
| q01 head / q07 deep | `n_1E48X9HAFPEY` | 55–261 | 170,031 | 36,170 | **no — larger than W** | no |
| q02 head / q08 deep | `n_1C0BDXFHPYAX` | 554–570 | 14,801 | 3,149 | yes | yes |
| q03 head / q09 deep | `n_1JNW5D8CNYSA` | 1–54 | 84,179 | 17,907 | yes | no |
| q04 tail | `n_1A84WKF26NWA` | 639–731 | 83,410 | 17,743 | yes | no |
| q05, q06 tail | `n_1PPHC64K0QTM` | 732–754 | 36,781 | 7,824 | yes | yes |

Two consequences no designer stated. First, **the `head` and `deep` strata target the same three
branches** — deep differs only in that its literal is absent from the summary. That makes
`deep − head` a clean read on the summary-versus-raw variable with retrieval difficulty held
constant. Second, **a raw default fetch alone reaches 6 of 9 primary questions at W=32768 and 4
of 9 at W=16384**; the remaining 3 and 5 need a range. The range is load-bearing, but for a
named minority, not for everything.

**(J4) The `context_search` payload arithmetic, and why two of the three designs would fail
their own gate.** Serializing a 20-hit `ContextSearchData` over the frozen store
(`packages/mcp/src/tools/context-search.ts:150-158`, `retrieval.limit = 20` at
`packages/core/src/config.ts:115`):

| payload variant | chars | ~cl100k tok |
|---|---|---|
| as shipped (full `text` + full `meta` per hit, plus the duplicate 240-char `candidates`) | 45,470 | **9,673** |
| `text` capped to 240, `meta` untouched — `A-null` Change 2, `A-policy` C3 | 38,457 | **8,181** |
| 240-char snippet + **pointer meta only** (`files`, `symbols`, `node_ids`) — `A-surface` B | 23,025 | **4,898** |

`meta_json` is 31,504 of the 45,057 summary characters — **70% of the payload is metadata, not
prose.** Capping the text alone is a 15% reduction. `A-null`'s gate Z1 demands "< 1,500 cl100k
tokens" after its own change and `A-policy`'s G-D demands "p90 ≤ 1,200 tokens and at least 3×
smaller"; both measure 8,181 and roughly 1.18×. **Two of the three designs specify a gate their
own change cannot pass.** Only the winner's variant lands inside its own stated bound (4,898 ≤
its G-A1 threshold of 5,000).

---

## 1. Scores

Six criteria, ten points each. Pseudo-code lines counted by this judge from the designs' own
code blocks, not from their claims.

| Criterion | `A-surface` | `A-policy` | `A-null` |
|---|---|---|---|
| **Fixes the measured mechanism** | **8** — attacks the one mechanism now *proven* deterministic (J1: default-depth fetch is a guaranteed zero) and the one *measured* headroom bug (J4), with the only payload cut that actually reaches its target. Does not touch the dominant "never fetched" mechanism and says so. | 7 — attacks the dominant mechanism head-on (43.7% of rows, 53.6% of failures, 52% on tail — `01-run-forensics.md` §8) and names `depth: "full"` in the replacement rule, so it partly covers J1 too. But its lever is prompt text of unknown effect size, and its payload change misses (J4). | 5 — records the mechanisms rather than changing them; the surface fix is deferred behind a log it must first buy 120 runs to fill. Honest, but a loop late. |
| **One-variable attributability** | 7 — `tree-slice` bundles default-flip + `from`/`to` + `depth:'index'` as one "addressable unit" variable. J3 shows the bundle is separable: the flip alone carries 6/9 questions at 32k. Mitigated by per-call logging that decomposes it after the fact. | **8** — cleanest ladder (`tree` → `tree-verbatim` → `tree-reach` → `tree-pointer`), each step one variable, and `tree-pointer` correctly confined to the window where its mechanism fires. | **8** — every arm isolates exactly one thing, and the re-baselined control is correctly declared a different epoch from the existing rows. |
| **Simplicity budget** (lines counted by the judge) | 7 — **11 lines**, but scoped to `fetchBranch` alone; re-expressed at the same per-turn-loop scope as its rivals it runs 12–13. Adds two parameters and one enum value; removes one hard-coded special case, one false sentence, and four metadata fields. Net: additions and removals both real. | **9** — **11 lines**, loop scope, verified. Zero new parameters. One rule replaced (count 3 → 3), one description reworded, one field narrowed. The purest rule-replacement in the panel. | **9** — **12 lines** (the document claims 11; the block has 12), loop scope. Zero surface change. Removes a vacuous gate criterion rather than adding one. |
| **D-compliance** | 7 — names two deviations (R8 search-hit shape, R9 fetch default) and argues both. Misses that adding `'index'` to a signature §9 states verbatim as `depth?: "summary"\|"full"` is itself a deviation, and that the default lives in three places, only two of which it cites (see §4 step 2). | 8 — genuinely zero deviations; §9's four tools and both signatures untouched. But it proposes creating `system-contract.v2.md`, **which already exists** as the loop9-item3 Zone-A trim candidate (`packages/core/src/prompts/system-contract.v2.md`, `SYSTEM_CONTRACT_VERSIONS` at `prompts/index.ts:107`). A collision with an in-flight lineage. | 8 — zero deviations, and it flags its own §9 reading honestly. Same `v2` collision. |
| **Zero-token verifiability** | **9** — eight gates; I reproduced G-A0 (J1) and G-A1 (J4) exactly. Its partition-identity assertion — concatenating range fetches over any partition of a span must be byte-identical to `depth:'full'` — is the strongest single test proposed by anyone, and it is the test that makes a sliced read trustworthy. | 6 — G-B (rule count), G-F (the instrument can tell the two cases apart) and G-H (the free visibility substitute) are all excellent, but G-D is unsatisfiable by C3 (J4). | 6 — Z4's log round-trip is right and Z6's determinism check is right, but Z1 is unsatisfiable by Change 2 (J4). |
| **Information per token spent** | **8** — $4.04 committed / $5.26 worst case for 256 calls, and what it buys is a mechanism resolved by construction rather than a hypothesis re-tested. | 7 — $3.56 for 186 runs against the dominant mechanism, but its primary claim rests on mechanism counts and it concedes accuracy may be inconclusive at n=5. | 4 — $4.5 for 345 runs, and it pre-registers "0.000, unchanged" for tail, deep and spanning under every arm it actually commits to. The most spend for the least predicted movement, with the fix deferred. |
| **Total** | **46 / 60** | **45 / 60** | **40 / 60** |

No design is disqualified. All three keep the four-tool §9 surface, all three put offline gates
before live tokens, all three correctly drop `tree-active` for the same two reasons, and all
three identify the harness's missing `call.input` log as the highest-leverage free fix.

---

## 2. Winner — `A-surface`, and why

`A-surface` wins by one point, and the point is J1.

The panel's real disagreement is about which link in a two-link chain to repair. The chain is:
*the model must issue a targeted `context_fetch`* (link 1), *and that fetch must return
something a literal-matching grader can score* (link 2). `01-run-forensics.md` §8 measures link
1 failing 53.6% of the time. `A-policy` and `A-null` both read that number and conclude the
surface is not the problem, because 0 of 110 correctly-targeted fetches were ever truncated and
turn-1 headroom at the anchor cell was ~22.8k tokens against a nominal Zone B of 7,703.

That reading is correct about resources and wrong about content. Link 2 is not gated by
headroom; it is gated by *what the tool hands back*, and J1 shows that what it hands back by
default is provably scoreless — not lossy, not degraded, but incapable of containing any of the
twelve strings the grader looks for, in any summary version ever written. `context_fetch`'s
`depth` argument is optional and coalesces to `'summary'` in three separate places
(`packages/mcp/src/tools/context-fetch.ts:37` describes it, `:76` applies it, and
`packages/core/src/retrieve/retriever.ts:190` applies it again), and neither the tool
description nor the shipped contract names a case that requires `'full'`. So every fetch where
the model omits one optional argument is a guaranteed zero, and the six recorded rows that
fetched the correct branch, suffered no truncation, and still scored zero
(`01-run-forensics.md` §8) now have an explanation that costs nothing to believe.

This matters more than the raw failure counts because of what each design can *observe*. Under
`A-policy`, if the contract successfully makes the model reach but it reaches at the default
depth, the arm returns a null and the policy takes the blame for a surface defect. `A-policy`
partly anticipates this — its replacement rule names `depth: "full"` explicitly, which is the
best sentence in that document — but it is asking a 72B model to supply, from prose, a value the
schema should have supplied for free. The panel's own ranking rule settles that:
cheap-and-deterministic beats model-driven wherever equivalent, and a default is the cheapest
determinism there is.

`A-surface` also owns the only correct reading of the owner's literal request. The owner asked
for traversal down rolled-up nodes to their leaves. J2 shows that on this store the leaves *are*
the parent — 11 of 21 phases have no children at all, and where children exist the first one's
span is byte-identical to its parent's. A children-listing parameter, an `under:` scope on
search, and a `context_peek` offset — three of the six candidates in `02-retrieval-surface.md`
§5 — are therefore decoration on this fixture, and `A-surface` is the only design that
*measured* that rather than reasoning about it. What remains, once the file-node illusion is
removed, is exactly what it proposes: an index of the events under a rolled-up node, and a
sequence range to pull the part you want. J3 says that range is needed for 3 of 9 questions at
the anchor cell and 5 of 9 at the small window — a named minority, not everything, which is why
the design is right to log per-call arguments and decompose the bundle afterward instead of
buying a fourth arm.

The rival worth naming is `A-policy`, and it is not being dismissed — its central change becomes
a second arm in the same epoch (§3, graft 1). Two facts recommend that. First, its target is the
larger population: 53.6% of failures versus the ~5.5% that fetched correctly and still missed.
Second, and unnoticed by every designer, the shipped contract does not merely fail to make the
model reach — **it actively argues against reaching**. `system-contract.v1.md:57-62` instructs:
*"Fetch narrowly, prefer `file` over a whole branch and `context_peek` over `context_fetch`."*
Given J2, that sentence recommends a parameter that narrows nothing and a tool that returns a
prefix, to a model whose window is 22.8k tokens empty. It is the one instruction in the
repository that directly contradicts the owner's design principle, and removing it is a rule
*removal*, which this panel's own ranking puts above everything else on offer.

`A-null` is right about instrumentation and right about the epoch discipline, and both of those
survive into the spec. It loses because its own predictions concede the point: it pre-registers
"0.000, unchanged" for tail, deep and spanning under all three of its committed changes, and
then spends $4.5 confirming it. A pass whose pre-registered modal outcome is "nothing moved, now
we know what to build" is a defensible loop when the mechanism is genuinely unknown. J1 makes it
known for free.

---

## 3. Grafts from the losers

**Graft 1 — from `A-policy`: the contract rule replacement, promoted to a full second arm
(`tree-verbatim`), extended with the judge's own removal.** `A-policy` C1 replaces rule 2 of
`system-contract.v1.md:17-22` with a rule naming the class of fact a summary cannot carry.
Adopted, with two amendments. It ships as `system-contract.v3.md`, not `v2` — `v2` already
exists and is the loop9-item3 Zone-A trim candidate, and reusing the name would silently
cross two lineages. And it must also delete the "Fetched content accumulates" paragraph's
narrow-fetch instruction (`v1:57-62`), because J2 shows that instruction is factually wrong on
this store and it is the only text in Zone A that argues against the owner's principle. Reason
for the graft: it targets the largest measured failure population, it is a rule replacement plus
a rule removal, and run as a sibling arm in the same epoch it separates "the model would not
reach" from "reaching did not pay" for the first time.

**Graft 2 — from `A-policy`: `literalInToolResult`, the free decisive instrument.** A
locally-computed boolean per run: did any tool result handed back to the model contain the
question's answer literal? Costs no model call and splits *the tool never returned the literal*
(a surface or depth failure) from *the literal was in front of the model and it still missed it*
(an extraction-competence ceiling no context design fixes). That is precisely the distinction
`01-run-forensics.md` §6 could not make, and it is the number that decides whether loop-10
continues on the surface or moves to summarization content.

**Graft 3 — from `A-policy`: G-H, the zero-token substitute for the head escalation.**
`visibleBranchesAt(scenario, budgets, arm).covers(from, to)` already exists at
`transplant.mjs:537` and is already used at `:1650`. Running it for all 9 primary questions under
both the `tree` and `tree-wide` root ladders answers, for free, whether `tree-wide`'s head
advantage (0.273 vs 0.091) is a visibility artifact rather than a retrieval result. Reason: it
may retire a $1.22 escalation before it is bought, and the panel's constraint puts
cheap-and-deterministic first.

**Graft 4 — from `A-null`: the semantic question is answered offline unless the ranks move.**
Spend the $0.0001 to populate L3 in a copy of the store, recompute all 12 self-retrieval ranks
on the vector path, and publish the lexical-versus-vector table as the semantic result. Buy a
live `tree-semantic` arm only if vector puts ≥ 4 of 12 sources in the strict top 5 (lexical is
2/12 at top-3, median rank 11/19 — `03-embeddings.md` §6). Reason: `01-run-forensics.md` §7
shows the binding constraint on `deep` is query formation, not ranking — q07 has the best rank
in the suite (1/19) and zero of 15 reps ever fetched its branch — so a live semantic arm is a
bet against the strongest evidence in the analysis. Fold in `A-null`'s replacement of the
vacuous gate criterion: `SELF_RETRIEVAL_TOP_K` 20 → 5 at `transplant.mjs:152`, replacing the
threshold rather than adding a second one.

**Graft 5 — from `A-null`: per-run costs measured from the 462 existing rows, not estimated**
(qwen `tree` $0.01064/run, qwen `tree-wide` $0.01403/run, gpt-3.5 `tree` $0.00807/run), and its
epoch rule: because the search payload changes bytes, old rows and new rows are different epochs
and must never be pooled (`JUDGE-VERDICT.md:118`). Reason: the budget below is a commitment
against `CAP_USD_TOTAL = 6.0`, and an estimate that drifts 30% turns a cap into a surprise.

**Unanimous, recorded as decided: `tree-active` is dropped.** All three designs reject it for
the same two reasons and I adopt both. Headroom was not the binding constraint (~22.8k free on
turn 1), and pre-filling Zone C with the newest branch's raw detail hands the `tail` stratum its
answer by construction — all three tail sources sit inside the visible range 639–754
(`01-run-forensics.md` §3) — converting `tree` into `truncate-tail` on that stratum and voiding
the null hypothesis the standing verdict was built on. If it is ever run, it is an upper bound,
labelled as such, outside the primary verdict.

**The pre-registered n=20 head escalation is kept but queued third**, behind Graft 3 and behind
the primary contrasts. It is not deregistered — silently dropping a pre-registration is the
failure mode this process exists to prevent — but both cells it would escalate lost 4 of 15 reps
to OpenRouter infrastructure failures and were produced by an instrument that never recorded
`depth` or `file`. It runs only if Graft 3 fails to explain `tree-wide`'s head advantage, the
`tree-slice − tree` bootstrap CI at head still crosses zero, and budget remains under the cap.

---

## 4. Ordered implementation spec

Every step is executable cold. File paths are absolute-from-repo-root; line numbers are as of
this verdict. Steps 1–7 spend zero tokens of any kind.

### Step 1 — harness instrumentation (zero tokens, applies to every arm)

`eval/scripts/transplant.mjs:2497-2499` currently pushes two strings. Replace the two
field-specific pushes with one verbatim record per tool call, and derive the existing
`searchQueries` / `fetchedIds` arrays from it at return time (`:2537-2540`) so every downstream
verdict script and gate keeps working unchanged:

```js
toolCalls.push({
  turn,
  name: call.name,
  input: structuredClone(call.input),        // depth, file, from, to, query, kind, node_id, max_chars
  ok: outcome?.ok ?? false,
  resultChars: text.length,
  headroom: capped.headroom,                 // already computed at :2515-2523, currently discarded
  droppedChars: capped.droppedChars,
  hitIds: call.name === CONTEXT_SEARCH && outcome.ok
    ? outcome.data.hits.map((h) => h.node_id)
    : null,
});
literalInToolResult ||= question.answer_literals.some((lit) => text.includes(lit));  // Graft 2
```

Note the ordering constraint: `capped` is computed at `:2515`, after the current push site at
`:2497`, so the record must be pushed *inside* the per-call loop after `:2523`, with `call.name`
captured at the top. Add `toolCalls`, `literalInToolResult` and `zoneCTokens`
(from `prompt.budgets.zoneC`) to the returned row object at `:2533-2552`.

This is the fix `01-run-forensics.md` §1 names as highest-leverage, it costs zero prompt bytes,
and it is a hard precondition for every arm below.

### Step 2 — `context_fetch` reads raw L0 by default, aimed by a sequence range (arm `tree-slice`)

The default lives in three places; changing two of them leaves the behavior unchanged.

| # | File : line | Change |
|---|---|---|
| 2a | `packages/mcp/src/tools/context-fetch.ts:34-37` | `depth` enum `['summary','full']` → `['summary','index','full']`; description rewritten to state the new default and point at `index` → `from`/`to` |
| 2b | `packages/mcp/src/tools/context-fetch.ts:76` | `{ depth: args.depth ?? 'summary', file: args.file }` → `{ depth: args.depth ?? 'full', file: args.file, from: args.from, to: args.to }` — **this is the line that actually applies the default; neither design cited it** |
| 2c | `packages/mcp/src/tools/context-fetch.ts:38-43` | add `from?: z.number().int().optional()`, `to?: z.number().int().optional()` — inclusive L0 `seq` bounds, clamped to the node's own span |
| 2d | `packages/mcp/src/tools/context-fetch.ts:24-30` | delete the sentence "Pass `file` to narrow to one file node instead of a whole branch; that is the cheap common case" — J2 proves it false on this store — and replace it with the `index` → range idiom |
| 2e | `packages/core/src/retrieve/types.ts:57-64` | `FetchBranchOptions` += `depth?: 'summary'\|'index'\|'full'`, `from?: number`, `to?: number` |
| 2f | `packages/core/src/retrieve/retriever.ts:190` | `const depth = options.depth ?? 'full'` |
| 2g | `packages/core/src/retrieve/retriever.ts:224-238` | intersect `mergeSpans(...)` with `[from ?? -∞, to ?? +∞]` before `renderSpans`; add the `depth === 'index'` branch |
| 2h | `packages/core/src/retrieve/retriever.ts:235` | **removal** — `meta: null` becomes the same `this.store.currentSummary(single?.id)?.meta ?? null` lookup the summary path already performs at `:218`. Applied to the control arm too: it is substrate, and it cannot change a score without a second tool call |
| 2i | `eval/src/tools.ts:103` | the Zone-A-native schema mirror: same enum and same two integer properties. **The harness imports `../dist/tools.js` (`transplant.mjs:81`), so `eval/` must be rebuilt before any run** |
| 2j | `packages/core/src/prompts/system-contract.v1.md:32-34` | tool line updated to the new signature and default (Zone A bytes change; gate G5 measures the cost) |

`depth: 'index'` emits one row per event in the (possibly range-narrowed) span —
`seq · type · tool · path · bytes` — read from the L0 trace log plus L2 file *stat* only, never
blob text. Rows cap at 120 with a `+M more` elision line, reusing D18's existing idiom rather
than inventing a second cap. Cost on the largest node in the store (`n_1E48X9HAFPEY`, 207
events) is ~120 rows ≈ 1.5k cl100k tokens against a turn-1 headroom of 22.8k.

**Known shipped-behavior consequence, to be recorded and tested, not hidden.** With the default
flipped, a `context_fetch` against a `TreeRetriever` constructed without a `trace` now raises
`E_RETRIEVE_NO_TRACE` (`retriever.ts:327-335`) where it previously returned a summary. Every
path in this repository constructs one with `trace` (`packages/mcp/src/bin.ts:24-27`,
`transplant.mjs:590`, `:2602`), and the tool layer converts the throw into a graceful
`failFrom(error)` outcome rather than a crash (`context-fetch.ts:93-95`), so this degrades to a
typed tool error in a configuration that does not currently exist. Gate G4b asserts that.

### Step 3 — a `context_search` hit is coordinates, not content (arm `tree-thin`)

| # | File : line | Change |
|---|---|---|
| 3a | `packages/mcp/src/tools/context-search.ts:55-66` | `SearchHitPayload`: drop `text`, add `snippet: string` |
| 3b | `packages/mcp/src/tools/context-search.ts:83-95` | `toHitPayload` returns `snippet: hit.text.slice(0, 240)` — the same 240 the file already computes at `:108` — and `meta` reduced to its **pointer** fields (`files`, `symbols`, `node_ids`), dropping the prose fields (`decisions`, `open_questions`, `tests`, `artifacts`) |
| 3c | `packages/mcp/src/tools/context-search.ts:38-42` | description: "returns node ids and pointers; the content is one `context_fetch` away" |

Measured effect (J4): 9,673 → 4,898 cl100k tokens per call at `limit = 20`, a 49% cut and the
only variant that reaches its own gate. `packages/mcp/test/mcp.test.ts:311` asserts
`hit.meta.files[0].path` survives to the model — it does, because `files` is a pointer field and
is retained; that test is the reason `meta` is narrowed rather than dropped, and the reason §9's
unknown-unknowns mitigation (`docs/IMPLEMENTATION_PLAN.md:324-326`) is not violated. Zone B is
untouched, so `decisions` and `open_questions` remain always-visible for every rendered branch,
which is where that mitigation actually lives.

### Step 4 — contract v3 (arm `tree-verbatim`, Graft 1)

New file `packages/core/src/prompts/system-contract.v3.md`: a byte-for-byte copy of v1 with two
edits and nothing else. Extend `SYSTEM_CONTRACT_VERSIONS` at
`packages/core/src/prompts/index.ts:107` to `['v1','v2','v3']`. **Do not touch `v2`** — it is the
loop9-item3 Zone-A trim candidate and is mid-flight.

Replace `v1:17-22` (rule 2) with:

> 2. A summary can tell you that something happened. It can never tell you what it said. If your
>    answer must reproduce a number, an identifier, a path, an error string, or someone's exact
>    words, the summary that mentions it is not the source — call
>    `context_fetch { branch_id, depth: "full" }` on the branch it names and read the literal
>    there.
>
>    This is true of the summaries already printed above. Seeing a summary is not having read the
>    branch: these paragraphs were written by a model that was compressing, and the detail you
>    are being asked for is exactly the kind of detail compression drops.

Replace the second paragraph of `v1:57-62` — *"Fetch narrowly, prefer `file` over a whole branch
and `context_peek` over `context_fetch`, and do not re-fetch what is already in the tail"* — with:

> Fetch what the question needs and no more, and do not re-fetch what is already in the tail. If
> something you fetched matters beyond this phase, `annotate` it — that is what persists.

Rule accounting: three numbered rules before, three after; two unnumbered failure-mode
paragraphs before, two after. One rule replaced, one instruction removed, nothing added.

Harness wiring: `transplant.mjs:1089` hardcodes `systemContract()` (v1) and does not read
`EVAL_CONTRACT_VERSION` the way `eval/src/loop.ts:721` does. Add the same environment-variable
selection there, defaulting to `v1`, so the control arm's Zone A is byte-identical to the
existing epoch's.

### Step 5 — the embedder, offline only until it earns a live arm (Graft 4)

New `packages/core/src/models/embeddings.ts` — `createEmbeddingClient()` returning a
`SummaryEmbedder` (`packages/core/src/retrieve/types.ts:17`), using the `openai` package already
depended on (`packages/core/package.json:34`) with the same injectable-`client` seam as
`OpenRouterProvider` (`packages/core/src/models/openrouter.ts:63-64`) so every test stays
offline. Add `openai` to `ApiKeys` (`packages/core/src/config.ts:218`) and to
`API_KEY_ENV_NAMES` (`:232`); model `text-embedding-3-small`. **No value from `.env` is printed
anywhere.** Run `retriever.embedSummaries()` (`retriever.ts:276-319`) once **against a copy of
the store**, so the freeze assertion stays trivially true rather than argued, then recompute all
12 self-retrieval ranks. Also set `SELF_RETRIEVAL_TOP_K` 20 → 5 at `transplant.mjs:152`.

### Step 6 — arm registration

Add to `ARM_IDS` (`transplant.mjs:167-175`): `tree-slice`, `tree-thin`, `tree-verbatim`, and
(conditionally) `tree-semantic`. Each arm's single isolated variable, against the same frozen
store, same 9 primary questions, same budgets, interleaved within one `(model, W)` cell so all
arms share one epoch (`JUDGE-VERDICT.md:118`):

| Arm | Single variable vs `tree` | Steps active |
|---|---|---|
| `tree` | — control, **re-run** so it carries the new logging and the substrate fix | 1, 2h |
| `tree-slice` | *the fetch tool's default and addressable unit is raw L0 sized to fit, rather than summary prose* | + 2a–2j |
| `tree-thin` | *a search hit is coordinates, not content* | + 3a–3c |
| `tree-verbatim` | *Zone A policy text: what a summary cannot carry, and no instruction to fetch narrowly* | + 4 |
| `tree-semantic` | *search ranks by meaning, not lexical overlap* | + 5, **only if G6 passes** |

No two arms are combined this loop. If `tree-slice` and `tree-verbatim` both win separately,
their combination is loop-10's first arm — and that combination is the design this panel
actually believes in, deferred only because running it now would confound the two links of the
chain.

### Step 7 — zero-token gates (all must pass before any answerer token is bought)

| Gate | Assertion | Why it exists |
|---|---|---|
| **G0** | For all 12 questions, no `answer_literal` and no `answer_regex` matches any `node_summaries.text` or `meta_json`, over **every** version row, not only current. Standing gate, recomputed each loop. | J1 — the premise of the winner. If a future question set violates it, Step 3's justification ("thinning removes no scoring path") lapses and must be re-argued. |
| **G1** | Serialize `context_search` over the frozen store at `limit = 20`, before and after Step 3. Assert post-change ≤ **5,000** cl100k tokens and that no hit field exceeds 240 chars except pointer lists. Record both numbers. | J4 — turns the arithmetic into a measurement, and would have caught two designs' unsatisfiable gates. |
| **G2** | `fetchBranch(depth:'index')` over all 46 nodes: byte-identical across two runs; every row's `seq` inside the node span; ≤ 120 rows plus one elision line; **zero** calls to any `blobs.getText*` method (spy assertion). | `index` must stay an L0-plus-stat read — hermetic per D15, deterministic per the L1-rebuildability invariant. |
| **G3** | `from`/`to` clamping: an over-wide range equals no range; a disjoint range yields `text: ''`, `spans: []`, no throw; and **the concatenation of range fetches over any partition of a node's span is byte-identical to `depth:'full'`**. | The partition identity is what makes a sliced read trustworthy. Without it a slice can silently drop boundary events, and nothing downstream would notice. |
| **G4** | `fetch(depth:'full').meta` deep-equals `fetch(depth:'summary').meta` for every summarized node. **G4b:** a `TreeRetriever` built without `trace` returns a typed `E_RETRIEVE_NO_TRACE` tool failure on a default fetch, not an uncaught throw. | Step 2h's removal, and the one shipped-behavior consequence of the default flip. |
| **G5** | Re-measure Zone A at `transplant.mjs:1711-1712` (heuristic and exact) before and after Steps 2, 3 and 4. Assert `overBudget == []` and an unchanged `rootKeep` at W ∈ {16384, 32768}; re-run g8, g9 (suffix-nesting, R3) and g10 (prefix stability). Contract v3 has exactly three numbered rules. **Never raise the Zone A budget to fit the prose.** | Zone A is paid on every turn forever (D5). A widening that quietly eats Zone A is a regression even if it wins on score. |
| **G6** | Populate L3 in a **copy** of the store (~$0.0001, no completions); recompute all 12 ranks at `topK = 5`. **Kill condition:** vector strict-top-5 < 4/12, or vector median rank ≥ lexical's 11/19 → `tree-semantic` is not run and the offline rank table is published as the semantic result. | `03-embeddings.md` §6's primary metric, made a gate instead of a purchase. |
| **G7** | A mocked six-turn loop with a scripted tool-caller asserts every `call.input` key reaches the row JSON verbatim, `hitIds` is populated per search, `headroom` is recorded per append, derived `searchQueries`/`fetchedIds` are unchanged on a replayed fixture, and `literalInToolResult` returns **true** for a synthetic `depth:'full'` fetch of each question's source and **false** for the same branch at `depth:'summary'`. | Without the last clause the whole mechanism analysis is unfalsifiable — it is the test that the instrument can tell the two hypotheses apart. |
| **G8** | Freeze holds: g1 (trace sha), g5 (L1 rebuild determinism), g13 (manifest hash). L3 lives in a copy; `nodes` and `node_summaries` untouched. | The same-epoch requirement (`JUDGE-VERDICT.md:47`). |
| **G9** | `visibleBranchesAt(scenario, budgets, arm).covers(from, to)` (`transplant.mjs:537`) for all 9 primary questions × {`tree`, `tree-wide`} ladders. Produces a table, not a pass/fail. | Graft 3 — the free substitute for the head escalation. |

G0–G5 and G7–G9 spend nothing. G6 spends ~$0.0002 on embeddings and buys no completion.

### Step 8 — live batch

Anchor cell is the true-small-window cell fixed by the brief: `qwen/qwen-2.5-72b-instruct` at
W = 32768. Nine primary questions (`head`/`tail`/`deep` × 3), n = 5, arms interleaved within each
cell. `spanning` is not run. `naive-full` is not re-run — its precondition evidence is on disk.
Per-run costs are `A-null`'s measured figures from the existing 462 rows (Graft 5), with
`tree-slice` budgeted higher because it appends raw blocks.

| Order | Cell | Arm | runs | $/run | USD |
|---|---|---|---|---|---|
| 1 | smoke, `TRANSPLANT_SMOKE=1`, n=3 × 2 models, on the changed schemas | 6 | 0.017 | 0.10 |
| 2 | qwen @ 32768 | `tree` (instrumented control) | 45 | 0.0106 | 0.48 |
| 3 | gpt-3.5 @ 16384 | `tree` (instrumented control) | 45 | 0.0081 | 0.36 |
| 4 | gpt-3.5 @ 16384 | `tree-thin` | 45 | 0.0081 | 0.36 |
| 5 | qwen @ 32768 | `tree-verbatim` | 45 | 0.0106 | 0.48 |
| 6 | qwen @ 32768 | `tree-slice` | 45 | 0.0220 | 0.99 |
| 7 | gpt-3.5 @ 16384 | `tree-slice` | 45 | 0.0180 | 0.81 |
| — | embeddings (G6, store copy + 12 queries) | — | — | 0.0002 |
| | **Committed subtotal** | | **276** | | **$3.58** |
| | Infrastructure reserve at the observed 15.6% OpenRouter failure rate (`01-run-forensics.md` §2) | ~43 | | **$0.56** |
| | **Committed total** | | | | **≈ $4.14** |
| *cond.* | qwen @ 32768 `tree-semantic`, `deep` + `head` only, gated on G6 | 30 | 0.0106 | 0.32 |
| *cond.* | head escalation `tree` vs `tree-wide`, n 5→20, gated on G9 + a CI crossing zero | 90 | 0.0123 | 1.11 |
| | **Worst case** | | | | **≈ $5.57** |

Cap compliance at the verified prices (`packages/core/src/models/cost.ts:72-73`; qwen
$0.36/$0.40 per 1M, gpt-3.5 $0.50/$1.50 per 1M): qwen worst case ≈ $2.87 and gpt-3.5 worst case
≈ $1.72, both under `CAP_USD_PER_MODEL = 3.0` (`transplant.mjs:116`); total $5.57 under
`CAP_USD_TOTAL = 6.0` (`:121`). Arms are ordered controls-first then cheapest-decisive-first, so
a meter trip degrades the least informative cell. Any `(arm, stratum, model)` cell with more than
20% `status: model_call_error` rows is re-run to n=5 **valid** before entering the verdict.

### Step 9 — deviation log entries to append to `eval/fixtures/transplant/JUDGE-VERDICT.md`

- **R8 — `context_search` hits carry pointers, not summary bodies.** §9's table describes
  `context_search` as returning "ranked summaries + node IDs"
  (`docs/IMPLEMENTATION_PLAN.md:306`). After Step 3 it returns ranked node ids, paths, pointer
  metadata and a 240-character snippet. Justification: the bodies are already in Zone B for every
  rendered branch, the tool's own description already directs the model to expand a hit with
  `context_peek` then `context_fetch` (`context-search.ts:42`), and the duplicated copy costs
  4,775 cl100k tokens per call (J4) while carrying zero scoring path on this question set (J1).
- **R9 — `context_fetch`'s `depth` defaults to `'full'`.** §9's table states the signature but
  not the default; `'summary'` is a code and contract choice
  (`context-fetch.ts:37`, `:76`, `retriever.ts:190`, `system-contract.v1.md:32`). Justification:
  zero of twelve answer literals occur in any summary, so the current default returns a response
  that cannot score.
- **R10 — `depth` gains a third value, `'index'`, and `context_fetch` gains `from`/`to`.** §9
  states `depth?: "summary"|"full"` verbatim, so widening the enum is a signature deviation and
  not merely a parameter addition. Justification: J2 — on the one real fixture the file-node
  "leaf" is byte-identical to its parent in every parented phase and absent entirely in 11 of 21,
  so a sequence range is the only sub-branch unit that exists, and J3 — three of nine primary
  sources exceed turn-1 headroom at the anchor cell, one of them exceeding the entire window.
  The four-tool surface is unchanged; no fifth tool is proposed.
- **R11 — the contract ships a `v3` variant for one arm.** `v2` is the loop9-item3 trim
  candidate and is untouched; `v1` remains the default and the control arm's Zone A stays
  byte-identical to the frozen epoch's.

---

## 5. Pre-registered predictions

Baselines, qwen @ W=32768 unless noted (`01-run-forensics.md` §2): `tree` head 0.091 (n=11),
`tree` tail 0.000 (n=12), `tree` deep ≈ 0.000, `tree-wide` head 0.273 (n=11), `truncate-tail`
tail 0.200, `compact-rolling` tail 0.333; gpt-3.5 @ W=16384 `tree` tail 0.000 (n=15). Every score
prediction is a mean of the 0/1 `exactMatchJudge` grade over n=5 per (arm, stratum, model),
reported with the bootstrap CI the verdict already computes. Mechanism predictions are measured
per tool call, where 45 runs per cell yields well over a hundred observations.

### `tree-slice` − `tree`

| Stratum | Prediction | Mechanism | Falsified by |
|---|---|---|---|
| **head** | **≥ +0.20** (i.e. ≥ 0.29) at qwen/32k | J1: today a correct-branch fetch at the default depth returns a summary containing none of the twelve literals — a guaranteed zero. Under Steps 2a/2b/2f the same call returns raw L0, and J3 says q02's source (3.1k cl100k) and q03's (17.9k) both fit turn-1 headroom (22.8k) whole. Two of three head questions become one-fetch scoring paths. | The per-call log shows the correct branch fetched at raw depth, `literalInToolResult = true`, and the score is still 0 → the ceiling is extraction competence, not surface, and this design is wrong at head. |
| **tail** | **≥ +0.15**, conditional on ≥ 1 `context_fetch` per rep | J3: q04's source (17.7k) and q05/q06's (7.8k) all fit turn-1 headroom whole at 32k, so the **default flip alone** is predicted to carry tail here; the range is not load-bearing at this window. | Fetch rate on tail does not rise above the control's → the binding constraint is the trigger (`tree-verbatim`'s mechanism), not the surface, and tail belongs to the other arm. |
| **deep** | **≥ +0.10** | Deep targets the same three branches as head (J3), so retrieval difficulty is held constant and only the summary-versus-raw variable differs. q08 (3.1k) and q09 (17.9k) fit whole; q07's source is 36.2k cl100k — larger than the entire window — so it needs `index` → range. Capped at +0.10 because 62% of deep failures fetched the *wrong* branch (`01-run-forensics.md` §8), which no fetch parameter repairs. | No `from`/`to` call ever appears in the log → the range is unused, only the default flip is working, and R10 must be re-argued on the strength of the flip alone. |
| **tail @ gpt-3.5/16k** | **≥ +0.10**, with q04's component conditional on a `from`/`to` call in the log | Turn-1 headroom at W=16384 is 10.25k against q04's 17.7k, and `truncateToTokens` keeps the head (`packages/core/src/assemble/format.ts:199-220`), so q04's literal at 97.6% of its span is destroyed by any un-aimed fetch. A `from`-anchored slice near `to = 731` is the only mechanism that reaches it in this window. | q04 fetched raw, `droppedChars > 0`, `literalInToolResult = false`, and no range call in the log → the model will not aim, and the parameter is unreachable without a policy that teaches it. |

### `tree-verbatim` − `tree` (qwen @ 32768)

| Stratum | Prediction | Mechanism | Falsified by |
|---|---|---|---|
| **tail** | **Largest gain: ≥ 0.20**, reaching parity with `truncate-tail` (the §15.2 criterion `tree ≥ truncate-tail − 0.05`). Fetch-after-search on tail ≥ 0.75; `depth:'full'` share of tail fetches ≥ 0.60 | 52% of tail failures searched and then stopped while the correct branch's lossy summary sat in Zone B (`01-run-forensics.md` §3, §8). The replaced rule addresses that exact state, names `depth: "full"`, and the removed sentence is the only Zone A text that argued against fetching. | Fetch-after-search on tail does not move → Zone A prose does not change this model's policy, and the remedy is not in the contract. Report it as such rather than as a tree regression. |
| **head** | Small: 0.09–0.20 | Head sources are outside the rendered Zone B range (`01-run-forensics.md` §3), so the model already knows it must retrieve. The binding constraint is query formation and rank, not trigger. | A large head gain → the trigger was binding even where retrieval was already mandatory, which would mean the contract, not the store, is the head ceiling. |
| **deep** | ≈ 0.00, ±0.07 | 62% of deep failures fetched the wrong branch; q07 had the best rank in the suite (1/19) and zero of 15 reps fetched it. A trigger does not choose a target. | Any deep gain > 0.15 → the trigger does influence target selection, contradicting `01-run-forensics.md` §7. |
| **harm metric** | Share of `context_fetch` calls with `droppedChars > 0` stays ≤ 25% at W=32768 | Today that share is effectively 0 (`01-run-forensics.md` §4, §5). | Exceeding 25% → the policy arm needs the range parameter before it can ship, which is a result in itself: it would say the two arms must be combined, and would promote loop-10's combination arm to first. |

### `tree-thin` − `tree` (gpt-3.5 @ 16384; not run at 32k, where its mechanism provably does not fire)

| Metric | Prediction | Mechanism | Falsified by |
|---|---|---|---|
| Truncated **search** results | 8/15 sampled → **0/45** | J4: the payload falls from 9,673 to 4,898 cl100k tokens, below the measured turn-2 mean headroom of ~5.4k. Deterministic, and certified by G1 before a token is spent. This is the highest-confidence prediction in the document. | Any truncated search result at all → the payload measurement or the headroom model is wrong; stop and re-measure. |
| Fetch-after-search | **≥ +0.15** | Removing the paraphrase from the search result removes the satisficing signal: a hit that no longer carries a paragraph of plausible prose offers nothing to answer from. 34.8% of all rows searched and then stopped. | Fetch-after-search flat while payload size demonstrably falls → the "search-result-as-answer" mechanism is refuted and only the headroom mechanism survives. Report that; it narrows loop-10. |
| tail accuracy | 0.000 → 0.00–0.13 | Thinning gives no new trigger; it frees headroom and removes a distractor. A large gain would mean truncation was doing more damage than §4 could see. | — |
| head / deep accuracy | Null, ±0.07 | No change to ranking or policy. | A gain → the payload was displacing something load-bearing, not just duplicating Zone B. |

### `tree-semantic` (offline unless G6 passes)

Predicted **flat on tail** (`03-embeddings.md` §6 prediction 3 — tail sources are visible without
search) and **capped on deep**: deep literals are absent from every summary by the stratum's
definition, so semantic search over summaries can match the *episode* the literal sits in, never
the literal. `A-null` predicts zero on deep and `03-embeddings.md` predicts deep benefits most;
that disagreement is pre-registered here so the offline rank table adjudicates it for $0.0001
rather than for $0.32.

---

## 6. Verification checklist

**Phase 0 — zero live tokens, in order. No API key is read until every line passes.**

1. G8: `sha256(trace.jsonl)`, manifest hash and L1 rebuild determinism unchanged; `nodes` and
   `node_summaries` untouched by any step.
2. G0: no answer literal and no answer regex in any summary version — the standing premise.
3. G7: mocked six-turn loop round-trips `toolCalls[].input` verbatim, `hitIds`, `headroom`,
   `droppedChars`, and `literalInToolResult` splits full-depth from summary-depth fetches.
4. G2: `depth:'index'` is deterministic, in-span, capped at 120 rows, and reads zero blob text.
5. G3: range clamping, empty-range safety, and the partition identity against `depth:'full'`.
6. G4 and G4b: `meta` present at every depth; a trace-less retriever returns a typed tool failure.
7. G1: search payload before and after, at `limit = 20`, ≤ 5,000 cl100k tokens after.
8. G5: Zone A refits at both windows with the new schemas and contract v3; `overBudget == []`,
   `rootKeep` unchanged, g8/g9/g10 green, contract rule count 3.
9. `pnpm vitest run packages/mcp packages/core/test/retrieve.test.ts`, plus a rebuild of `eval/`
   so `dist/tools.js` carries the new schema (`transplant.mjs:81` imports the build, not source).
10. G9: the visibility table for all 9 questions under both ladders — Graft 3, and the gate that
    may retire the head escalation before it is bought.
11. G6: L3 built in a store copy, 12 ranks recomputed at `topK = 5`, lexical-versus-vector table
    published. `tree-semantic` runs live only if strict top-5 ≥ 4/12.

**Phase 1 — live, in the order of the Step 8 table.**

12. Smoke n=3 per model against the changed schemas; any `ModelCallError` on unparseable tool
    arguments routes that model to `tree-static` and the affected strata are reported untestable,
    not zero.
13. Controls first (`tree` at both cells), then `tree-thin`, then `tree-verbatim`, then
    `tree-slice`, arms interleaved within each `(model, W)` cell so all share one epoch.
14. Any cell above 20% `model_call_error` is re-run to n=5 valid before entering the verdict.
15. Verdict reports, per (arm, stratum, model): mean score with bootstrap CI, plus the mechanism
    series the old dataset could not produce — fetch rate, fetch-after-search, `depthOmittedRate`,
    range-call rate, `literalInToolResult`, truncated-fetch share, and `zoneCTokens`.
16. A tail-stratum tree loss is reported as a regression, not a tradeoff
    (`JUDGE-VERDICT.md:120`). A tail result of 0.000 with `fetched = false` on most reps is
    reported as *"the surface was adequate and unused"*, attributed to policy, and not
    re-charged to the surface.

---

## 7. The core algorithm after the change (12 lines)

```
 1  A ← systemContract(v1|v3) ++ toolSchemas                      # Zone A, frozen (D5)
 2  B ← rootSummary ++ branchSummaries in CREATION ORDER          # never relevance-ordered
 3  C ← rawSpan(activeBranch) fitted to zoneC                     # empty on a closed trace
 4  tail ← ""
 5  repeat up to MAX_TURNS, until the reply carries no tool call:
 6    reply ← model(A ++ B ++ C ++ tail)
 7    for call in reply.toolCalls:
 8      if search(q):  out ← rank(q)[:limit] → {node_id, title, snippet≤240, pointerMeta}
 9      if fetch(id, depth='full', file?, from?, to?):            # default was 'summary'
10        spans ← mergeSpans(targets(id, file)) ∩ [from ?? -∞, to ?? +∞]
11        out ← depth=='index' ? indexRows(spans)[:120] : renderSpans(spans);  meta ← summary(id).meta
12      tail ← tail ++ cap(out, headroom)                         # appends AFTER Zone C (D5 rule 3)
```

Twelve lines, at the budget. Lines 1–3 and 12 are unchanged in structure — D5's layout, creation
order, and the after-Zone-C append point are all untouched. Line 8 is Step 3 (one field narrowed,
four dropped). Line 9's default and line 10's intersection are Step 2. Line 11's `meta ←` is the
removal of the hard-coded `meta: null` special case. Contract v3 changes the *text* line 1
carries, not the algorithm.

---

## 8. What this pass does NOT test

**The failure this design cannot fix, stated plainly: a model that answers `tail` from the
summary already sitting in Zone B and never issues a tool call.** All three tail sources lie
inside `branchSeqRange 639–754`, the range the assembler renders inline at W=32768, and 52% of
tail failures searched and then stopped. Every change in Step 2 and Step 3 lives *behind* a tool
call and is unreachable by a model that does not make one. `tree-verbatim` is the arm that
addresses it, and it addresses it with prose, which is the weakest instrument in the panel. If
both arms reproduce `tail = 0.000` with `fetched = false` on most reps, the correct reading is
neither "the surface is inadequate" nor "the policy is inadequate" but that the *prompt is too
convincing* — the branch summary reads like an answer, and the grader then scores it zero because
no summary contains any literal (G0). The remedies for that are content changes outside this
stance: a summarizer that carries verbatim identifiers into `meta.symbols` so the prefix can
score, or a Zone B render that marks summarized branches as non-quotable. Neither is attempted
here, and Graft 2's `literalInToolResult` exists so that outcome is attributed rather than
absorbed.

Also untested, and not to be mistaken for results:

- **The interaction between the two winning levers.** `tree-slice` and `tree-verbatim` run
  separately by design. If both win, their combination is unmeasured, and the combination is what
  the panel actually believes in.
- **Query formation.** q07 has the best self-retrieval rank in the suite (1/19) and zero of 15
  reps ever fetched its branch, because the model queried `'loop.test.ts'` for a question whose
  answer is an import line. Nothing here makes a model ask about a thing it has no reason to
  suspect exists, and `tree-semantic` reorders a candidate list rather than forming the query.
- **The wrong-branch fetch population** — 40% of failures overall, 62% on `deep`. Only ranking
  touches it, and ranking is gated offline.
- **§9.1's provider fan-out.** No `ProviderRegistry` is constructed anywhere in this repository
  (`02-retrieval-surface.md` §3 cap 1), so `GrepProvider`, `GraftProvider`, `SerenaProvider` and
  `AugmentProvider` remain unwired, the fixed structural → fuzzy → grep merge order is never
  exercised, and nothing indexes raw L0 for full-text search. That is the largest standing
  plan-gap in the retrieval surface and this pass does not close it.
- **The `spanning` stratum**, whose `tree` cell lost 10 of 15 reps to OpenRouter infrastructure
  failures; no conclusion from it survives, and it is not re-run here.
- **Generality beyond one fixture.** J2 and J3 are measured on `s1/e1b289c32f40` only. The claim
  that file "leaves" are byte-identical to their parents, and the whole case for a sequence range
  over a children listing, is a property of this store and must be re-measured on scenario 2.
- **Real session resumption (§15.1)**, D6's phase-boundary eviction (the harness has no phase
  boundaries at all — `02-retrieval-surface.md` §3 cap 8), and provider-side cache-prefix survival
  under the widened Zone A. G5 measures Zone A's *size*, not whether a provider's cache actually
  holds across the change.
