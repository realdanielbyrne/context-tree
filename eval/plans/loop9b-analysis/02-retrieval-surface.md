# Lens 2 — Retrieval Surface: What the Shipped Tools Cap Per Turn

## Abstract

The user's design principle is that when the context window has headroom and
the model needs more information, it should be able to go get it — including
drilling from a rolled-up branch summary down into its individual leaves, and
finding a node by searching for content that may only exist in raw event
text, not in a summary. This report traces that principle against the actual
`@context-tree/mcp` code (four tools: `context_fetch`, `context_search`,
`context_peek`, `annotate`), the retrieval-provider layer in
`packages/core/src/{retrieve,providers}/`, the prompt assembler
(`packages/core/src/assemble/assembler.ts`), and the eval harness that
produces this project's own numbers (`eval/scripts/transplant.mjs`).

The single largest finding is a **PLAN-GAP**, not a DESIGN-GAP: §9.1 of
`docs/IMPLEMENTATION_PLAN.md` specifies five retrieval providers
(`GraftProvider`, `SerenaProvider`, `AugmentProvider`, `VectorProvider`,
`GrepProvider`) merged deterministically, and all five exist as real,
non-stub implementations (1,123 lines total under
`packages/core/src/providers/`). But **nothing in the shipped code ever
constructs a `ProviderRegistry` and passes it in** — not the real MCP stdio
server (`packages/mcp/src/bin.ts`), not the CLI (`packages/cli/src/`), and
not the eval harness that produced every result currently under
`eval/fixtures/transplant/s1/e1b289c32f40/results/`. `ctx.registry` is
`undefined` everywhere the tools actually run. `context_search`'s own code
degrades gracefully to `ctx.registry === undefined ? null : ...`
(`packages/mcp/src/tools/context-search.ts:145`), so nothing crashes — the
search silently runs the tree-only path in 100% of measured and shipped
usage. Compounding this, `bin.ts` also wires no embedder
(`retriever = new TreeRetriever({ store, blobs, trace })`, no `embed`), so
even the one provider that IS wired (`VectorProvider`/the tree itself) never
reaches its L3 vector path — every real `context_search` call runs pure IDF
lexical **beam search over summary text** (`packages/core/src/retrieve/retriever.ts`
`beamSearch()`), which is the weakest of the two tree-native paths the plan
describes and none of the five §9.1 providers. This is the direct, evidenced
answer to "the search tool needs to be able to find the right nodes when the
model is looking for them" — right now it can only find nodes whose
*generated summary prose* happens to share vocabulary with the query; it
cannot use structural (graft), fuzzy-semantic (embeddings, Augment), or
full-text (grep) matching at all, in any deployed or measured configuration.

The second-largest finding is that most of the mechanism the user describes
— "a tool call to get summaries, followed by another tool call that zeros in
on the sub-branches it is most interested in" — **already exists in the
code** via `meta.node_ids` (self + direct children) returned uncapped on
every `depth: 'summary'` `context_fetch`/`context_search` hit, and
`context_fetch` accepts *any* node id, not just top-level branches. In the
one real fixture measured (`s1/e1b289c32f40`), the tree is exactly two levels
deep under the task root (`task → phase → file`, 21 phases, 24 files; see
§4), so one `context_fetch(phase_id, depth:'summary')` call already returns
every file leaf's id in `meta.node_ids`, and a second `context_fetch(file_id,
depth:'full')` gets that leaf's raw content — no new tool is needed for that
shape of tree. What is missing is (a) any way to get *just* the child list
without paying for the whole summary body, (b) any way to keep discovering
further descendants once you've gone to `depth:'full'` (its `meta` is
hard-coded `null`), (c) any way to scope `context_search` to one branch's
subtree, and (d) any way to read a middle or tail slice of a large span
rather than always the prefix from `peek`. These are enumerated as concrete,
file:line-anchored caps below.

## 1. Method

- Read `docs/IMPLEMENTATION_PLAN.md` §9, §9.1, §10, and decision rows D5,
  D17–D19 (the plan lives at `docs/IMPLEMENTATION_PLAN.md`, not the path in
  the task brief — `IMPLEMENTATION_PLAN.md` does not exist at the repo root).
- Read every file in `packages/mcp/src/tools/`, `packages/mcp/src/index.ts`,
  `packages/mcp/src/server.ts`, `packages/mcp/src/bin.ts`,
  `packages/mcp/src/types.ts`.
- Read `packages/core/src/retrieve/{retriever,vector-provider,types,detail}.ts`,
  `packages/core/src/providers/{registry,merge,grep,graft,serena,augment,hydrate}.ts`,
  `packages/core/src/contracts/providers.ts`.
- Read `packages/core/src/assemble/assembler.ts` and `format.ts` for Zone
  B/C construction, `renderActiveMap`, and the D17/D18 caps.
- Read `packages/core/src/summarize/{summarizer,compose-root,contract}.ts`
  to establish where `meta.node_ids` comes from and what it contains.
- Read `eval/scripts/transplant.mjs` (`MAX_TURNS`, `capToolResult`,
  `runOneReplicate`, `toolCtx` construction) to see what the harness that
  produced this project's own numbers actually exercises.
- Rebuilt the L1 SQLite tree from the fixture's L0 trace log to measure real
  node-kind/depth/span-size distributions, since no `.sqlite`/`store/` tree
  file ships in the fixture directory named in the brief (only
  `eval/fixtures/transplant/s1/store/{trace.jsonl,blobs/}` exists; I copied
  that pair — L0 and L2 only, nothing else — into
  `/private/tmp/.../scratchpad/loop9b/analyze/store-copy/` and ran
  `@context-tree/core`'s own `rebuild()` against the copy, so the repo itself
  was never written to). Script:
  `/private/tmp/claude-501/-Users-danielbyrne-GitHub-rpm-context-tree/e8bcf788-a9f0-45d4-98c1-aed0edbfce2b/scratchpad/loop9b/analyze/stats.mjs`.

All node-shape numbers below are FINDINGS (measured from the rebuilt store).
Everything about code behavior is a FINDING (file:line cited). Anything
about how a hosted model would actually behave under a fixed set of tools is
labeled HYPOTHESIS.

## 2. The four tools, as shipped (§9 vs. code — no drift here)

`packages/mcp/src/tools/index.ts:57` — `TOOL_NAMES = [CONTEXT_FETCH,
CONTEXT_SEARCH, CONTEXT_PEEK, ANNOTATE]`, exactly matching plan §9's "three
tools... plus one write-side tool." No drift between plan and code on the
tool *count* or *names*. The caps below are all about tool *parameters* and
*what backs them*, not about a missing tool.

| Tool | Params (code) | Matches plan §9? |
|---|---|---|
| `context_fetch` | `branch_id`, `depth?: 'summary'\|'full'`, `file?: string` (`packages/mcp/src/tools/context-fetch.ts:34-45`) | Yes, verbatim |
| `context_search` | `query`, `kind?: NodeKind` (`packages/mcp/src/tools/context-search.ts:45-51`) | Yes, verbatim |
| `context_peek` | `node_id`, `max_chars?: number` (`packages/mcp/src/tools/context-peek.ts:27-34`) | Yes, verbatim |
| `annotate` | `node_id`, `text`, `link_to?`, `link_kind?` (`packages/mcp/src/tools/annotate.ts:34-40`) | Yes, verbatim |

## 3. Numbered caps

Each cap names the file:line, what a model literally cannot do because of
it, and whether the plan promised otherwise.

1. **No retrieval provider is ever wired in the shipped server or the eval
   harness — `context_search` always runs tree-only, and always on the
   lexical beam path, never the vector path.**
   `packages/mcp/src/bin.ts:24-27` constructs `new TreeRetriever({ store,
   blobs, trace })` with no `embed` and calls `createServer({ config, handle,
   retriever, mode })` with no `registry`. `packages/core/src/retrieve/retriever.ts:80-82`:
   `if (this.embed === undefined) return { ...this.beamSearch(...), fallback:
   'no-embedder' }` — so every real deployment falls straight to
   `beamSearch()`, an IDF lexical scorer over `summaryDocument(node,
   summary)` text (`packages/core/src/retrieve/lexical.ts`), not even the
   tree's own vector index. `packages/core/src/providers/registry.ts` (the
   §9.1 fan-out class) and all five provider files
   (`graft.ts`, `serena.ts`, `augment.ts`, `grep.ts`, plus `vector-provider.ts`)
   exist and are real implementations, but a repo-wide search for `new
   ProviderRegistry(` outside test files returns zero hits — nothing
   constructs one. **What a model cannot do**: use structural (graft/Serena),
   fuzzy-semantic (Augment/vector-embedding), or full-text-grep matching
   through `context_search`, in any way, ever, in the current build — only
   lexical overlap against generated summary prose. **PLAN-GAP** — §9.1 states
   "`VectorProvider` and `GrepProvider` are always available" and describes a
   fixed five-tier merge; the code that would make that true exists but is
   never invoked.

2. **`context_search` finds text that exists in a *summary*, never text that
   exists only in the raw trace (L0).** `packages/core/src/retrieve/retriever.ts:9-11`
   states this as a design decision ("§19 Q2 is decided: search covers
   SUMMARIES ONLY, never raw turns") and `context-search.ts:38-41`'s tool
   description says so too. `GrepProvider` (`packages/core/src/providers/grep.ts:130-186`)
   — the one provider that could reach arbitrary text — searches the
   **checked-out repo's working-tree files on disk** (`rg`/directory walk
   over `this.cwd`), not the trace log; it cannot see a tool_call's stdout, an
   assistant's reasoning, or a user prompt that was never written to a repo
   file. Combined with finding 1, **nothing currently indexes raw L0 for
   full-text search at all**. **What a model cannot do**: find a node by
   searching for content that lives only in conversation/tool-output text and
   was paraphrased or dropped by the summarizer. **DESIGN-GAP for the grep
   part** (the plan's own §9.1 table describes `GrepProvider` as "ripgrep over
   the repo," matching the code — the plan never promised raw-trace grep) but
   a **PLAN-GAP compounding with finding 1** for the overall claim "the search
   tool needs to be able to find the right nodes" — the plan's fallback for
   this (structural/fuzzy providers) is unwired.

3. **No "list this branch's children" call exists — discovering child node
   ids costs a full summary fetch.** `FetchBranchOptions`
   (`packages/core/src/retrieve/types.ts:59-66`) has only `depth` and `file`;
   there is no lightweight "just the children" mode. The only way to learn a
   branch's `meta.node_ids` (self + direct children —
   `packages/core/src/summarize/summarizer.ts:126-130`: `const nodeIds =
   [nodeId, ...childIds]`) is to call `context_fetch(id, depth:'summary')`
   and receive the **entire summary body** (up to `maxSummaryTokens: 1024`,
   `packages/core/src/config.js:80`) along with it. **What a model cannot
   do**: cheaply enumerate a branch's children (count, kinds, titles, ids)
   without paying for and reading ~1k tokens of prose it may not need.
   **DESIGN-GAP** — the plan's §9 table never describes a lighter listing
   call.

4. **Once a branch is fetched at `depth:'full'`, its `meta` — including the
   `node_ids` needed to discover ITS children — is discarded from that same
   response.** `packages/core/src/retrieve/retriever.ts` `fetchBranch()`,
   full-depth branch: `return { ...base, text: rendered.text,
   summaryVersion: 0, meta: null, spans, events: rendered.events }` (the
   `depth === 'full'` return path, immediately after the `mergeSpans`/`renderSpans`
   call). **What a model cannot do**: drill from a raw-content fetch straight
   into that content's own children in one hop — it must go back and issue a
   separate `depth:'summary'` call on the same id first. Two round trips
   where the data (the node's own `meta.node_ids`) was already sitting in L1
   and could have been attached for free. **DESIGN-GAP** — never promised
   either way by the plan, but directly undercuts the user's "drill down"
   request by taxing exactly that path with an extra tool round trip.

5. **`context_search` cannot be scoped to one branch's subtree.**
   `contextSearchSchema` (`packages/mcp/src/tools/context-search.ts:45-51`)
   accepts only `query` and `kind` (a NodeKind filter, global across the
   whole tree) — there is no `under`/`scope`/`parent_id` parameter, and
   `beamSearch()` (`packages/core/src/retrieve/retriever.ts` — the frontier
   walk always starts from `childrenOf.get(null)`, i.e. the root's own
   children) always ranks over the **entire tree**, not a chosen branch.
   **What a model cannot do**: "zero in on the sub-branches [of a branch I
   already picked] that I'm most interested in" via search — the literal
   mechanism the user describes. It can only re-run a global search and hope
   the right descendant surfaces, or fall back to `meta.node_ids` from a
   `depth:'summary'` fetch (one level only — see #3/#4). **DESIGN-GAP** —
   plan §9's `context_search` signature (`{query, kind?}`) matches the code
   exactly; the gap is in the plan itself, not a code deviation from it.

6. **`context_peek` always returns a PREFIX of the node's span, from the
   start — never an offset, never the tail, never the middle.**
   `packages/core/src/retrieve/retriever.ts` `peek()`: `for (const event of
   trace.read({ from: span.start, to: span.end })) { if (budget <= 0) break;
   ... }` — the loop always begins at `span.start`. `contextPeekSchema`
   (`packages/mcp/src/tools/context-peek.ts:27-34`) has no offset/from/tail
   parameter. **What a model cannot do**: peek at the END of a long tool
   output (e.g., where a test failure or final answer usually is) or at a
   middle slice — only ever the first `max_chars` (capped at
   `MAX_PEEK_CHARS = 8_000`, `context-peek.ts:16`). **DESIGN-GAP** — the plan
   describes `context_peek` only as "cheap excerpt," with no offset concept
   either.

7. **`context_fetch` has no seq/turn sub-range narrowing — only whole-branch
   or one-file-path narrowing.** `FetchBranchOptions`
   (`packages/core/src/retrieve/types.ts:59-66`) is `{ depth?, file? }` only;
   there is no `from`/`to` seq range or turn-count limit. A "give me just
   turns 12–15 of this 40-turn phase" request is impossible without a `file`
   node existing at exactly that boundary. **What a model cannot do**: fetch
   a partial slice of a large branch's raw detail that isn't already
   partitioned by file edits. **DESIGN-GAP**.

8. **A model cannot discard a previously fetched tail entry to reclaim
   window mid-conversation — eviction is assembler-controlled, at phase
   boundaries only, and the harness that measures this doesn't even model
   phase boundaries.** In the real assembler, `onPhaseTransition()`
   (`packages/core/src/assemble/assembler.ts:110-119`) is the only eviction
   path ("D6: fetched branches die at phase boundaries... this drops the
   ephemeral tail entries"), and it fires on a phase-close event the
   assembler observes — not on any tool call the model can invoke. In
   `eval/scripts/transplant.mjs`'s `runOneReplicate` (~L2429-2530), the
   `messages` array is **strictly append-only** for the whole run — every
   assistant turn and every tool result is pushed and never removed
   (`messages.push({ role: 'assistant', ... })` then `messages.push({ role:
   'user', content: prefix + capped.text })` inside the per-tool-call loop,
   with no corresponding pop/filter anywhere in the function). There is no
   phase-boundary concept in this harness at all — a run is one flat
   6-turn loop. **What a model cannot do**: un-fetch a large branch it
   pulled speculatively and turned out not to need, to make room for a
   second, more useful fetch later in the SAME run. **PLAN-GAP relative to
   D6 as exercised**: D6's soft-offloading exists in the assembler class but
   is not what the harness measuring retrieval behavior actually runs
   through.

9. **A tool result that doesn't fit remaining headroom is truncated from a
   fixed prefix cut, or dropped to `''` outright — never re-tried narrower,
   never chunked, never resumed.** `eval/scripts/transplant.mjs`
   `capToolResult` (~L254-288): `if (headroom <= 0) return { text: '',
   before: null, after: 0, truncated: null, beforeExact: false, droppedChars:
   text.length, headroom }`; otherwise it pre-cuts by characters then
   `truncateToTokens(preCut, headroom, tokenizer)` — a straight head-cut, not
   a resumable/paginated read. **What a model cannot do**: request "the rest
   of that result" or "the same fetch but smaller" after a truncation — it
   only sees an elided marker (per the code's own comment: "a truncated
   result is visibly marked... so a model that lost detail can see that it
   did and search again") and must reformulate a whole new, smaller request
   from scratch, still against a shrinking `headroom`. **DESIGN-GAP** at the
   harness level (this is eval-script behavior, not `@context-tree/mcp` code) —
   worth separating from the tool-level caps above, but it directly shapes
   what the eval numbers say about "drilling down."

10. **At most 6 model turns per question, full stop — after that, whatever
    was gathered is final regardless of unused window.**
    `eval/scripts/transplant.mjs:114` `const MAX_TURNS = 6;` and the loop
    guard `for (let turn = 1; turn <= (built.tools.length > 0 ? MAX_TURNS :
    1); turn += 1)` in `runOneReplicate`. **What a model cannot do**: keep
    searching/fetching/peeking past 6 back-and-forths even if `headroom` (per
    finding 9) is still positive. This is the harness's own knob, not an
    MCP-server limit, but it is the reason "drill down repeatedly" is
    structurally under-exercised in every result file currently on disk.
    **DESIGN-GAP (harness-only)**.

11. **`annotate` is refused unconditionally inside the eval harness.**
    `eval/scripts/transplant.mjs` `runOneReplicate`: `if (call.name ===
    ANNOTATE) { annotateRefused += 1; outcome = FROZEN_ANNOTATE_REFUSAL; }` —
    every `annotate` call the model makes during a scored run is intercepted
    and refused before it reaches the real handler. This doesn't cap
    *retrieval* (annotate is the write tool) but it does mean the eval can
    never show a model using annotate to leave itself a pointer for later
    retrieval in the same run. **DESIGN-GAP (harness-only, noted for
    completeness since it's an MCP-surface restriction the eval imposes)**.

12. **Zone B (the always-resident prefix) shows branch summaries with their
    `meta.node_ids` capped at 40 entries with a `+M more` elision — but the
    ROOT block's own `node_ids` is hard-coded empty, so the newest-40
    headline list a resumed session reads first carries zero fetchable ids
    for those headlines.** `packages/core/src/assemble/format.ts:78`:
    `listLine('fetchable nodes', summary.meta.node_ids)` is rendered on
    every Zone B block including the root's, but
    `packages/core/src/summarize/compose-root.ts:61` (`mergedMeta`) sets
    `node_ids: []` unconditionally for the composed root summary. **What a
    model cannot do**: cite a node id directly from the root's own headline
    list — it must run `context_search` for the matching branch, or find it
    among the (also 40-capped) per-branch node_ids further down Zone B.
    **DESIGN-GAP** — this is an interaction between D17 (headline-only root)
    and D18 (40-value cap) that neither decision row states explicitly;
    flagged here because it directly narrows the "traverse from the always-
    visible summary layer" path the user describes.

## 4. Store shape measured on the one real fixture (s1 / e1b289c32f40)

Rebuilt L1 from the fixture's own L0 (`trace.jsonl`, 754 events) + L2
(`blobs/`, matches the manifest's declared `nodes: 46`, `l0_events: 754`,
`blobs: 697`, confirming the rebuild used the right inputs). Script and full
output: `stats.mjs` in this report's directory.

**Node kinds and depth** (task=depth 0, phase=depth 1, file=depth 2 — no
`turn` kind appears in this fixture at all, so the four-kind `task/phase/
file/turn` model from D10 is only 3/4 exercised here):

| kind | count | depth |
|---|---|---|
| task | 1 | 0 |
| phase | 21 | 1 |
| file | 24 | 2 |

**Children per node** (direct children only):

| parent kind | n parents | min | median | p90 | max |
|---|---|---|---|---|---|
| task | 1 | 21 | 21 | 21 | 21 |
| phase | 10 (of 21; the other 11 phases have 0 file children) | 1 | 2 | 6 | 6 |

**Raw span size** (characters of raw L0 payload text a `depth:'full'` fetch
or the active-branch Zone C render would actually pull in; est. tokens =
chars/4, the same heuristic-tokenizer approximation the codebase itself uses
per D19's "heuristic→BPE ratio" framing):

| kind | n | min chars | median chars | p90 chars | max chars | median tok (est) | p90 tok (est) | max tok (est) |
|---|---|---|---|---|---|---|---|---|
| task (whole trace) | 1 | 392,062 | 392,062 | 392,062 | 392,062 | 98,016 | 98,016 | 98,016 |
| phase | 21 | 99 | 6,796 | 38,674 | 99,823 | 1,699 | 9,669 | 24,956 |
| file | 24 | 256 | 17,998 | 60,886 | 99,823 | 4,500 | 15,222 | 24,956 |

The single largest file/phase node in the fixture is `tree-vs-transcript.html`
(`n_2WKHMBCXPKYN0V4JHSY3BG3DFQ`, 99,823 chars / ~24,956 est. tokens over 10
events) — a phase with exactly one file child spans the same bytes as that
child, which is why the phase and file maxima coincide.

**Would a leaf's raw content fit after Zone A+B, per the fixture's own
manifest budgets?** `manifest.json`'s `fractions` (`reply .05, zoneA .10,
zoneB .20, zoneC .20, lazy .35, slack .10`) are each divided by the measured
`ratio: 0.850896663206653` (D19). Computed per window:

| Budget bucket | W=16,384 (est. tok) | W=32,768 (est. tok) |
|---|---|---|
| reply | 963 | 1,926 |
| zoneA | 1,926 | 3,852 |
| zoneB | 3,852 (manifest's own recorded value: 3,850) | 7,703 |
| zoneC | 3,852 | 7,703 |
| lazy | 6,740 | 13,481 |
| slack | 1,926 | 3,852 |

`zoneC` is the budget an *active* branch's raw detail is water-filled against
(`packages/core/src/assemble/assembler.ts` `fitZoneC`); `lazy`+`slack`
(~10.6k tok at W=16,384, ~17.3k tok at W=32,768) is the realistic combined
headroom `capToolResult` has left for **all** `context_fetch`/`context_peek`
tail results across a whole run, since `capToolResult` budgets against the
full window `W` minus everything already spent, not against a
tree-specific zone.

- At **W=16,384**: the *median* file leaf (4,500 est. tok) alone consumes
  ~42% of the entire lazy+slack allowance; the *p90* file leaf (15,222 est.
  tok) **exceeds the entire lazy+slack allowance by ~43%** even before any
  other tool call in the run; the max leaf (24,956 tok) is more than double
  it.
- At **W=32,768**: the median leaf fits comfortably (~33% of lazy+slack);
  the p90 leaf (15,222 tok) still consumes ~88% of it; the max leaf (24,956
  tok) still **exceeds** it (144%).

So: for a small-to-median branch, drilling to one leaf's raw content is
comfortably affordable at either window studied — this is the case the
existing `node_ids`-based one-hop mechanism (§9, finding 3/4's caveats
aside) already serves well. For the top ~10% of branches by size (p90) and
above, a single raw-leaf fetch alone is tight-to-impossible inside the
window's own lazy/slack allowance, independent of any tool-parameter gap —
this is a **budget-shape** finding, not a tool-surface cap: even a perfect
"drill to the exact leaf I want" tool would still get truncated by
`capToolResult` (finding 9) on the fixture's largest branches at both
studied window sizes. This is a FINDING for the fixture measured; whether it
generalizes to other scenarios is a HYPOTHESIS (this repo only ships one
scenario, `s1`, with a store to rebuild).

## 5. Candidate changes

Ranked so the ones matching the report's stated ranking rule sort first:
keeping the four-tool §9 surface and favoring parameter-widening over new
tools, rule-removal over rule-addition.

1. **Wire a `ProviderRegistry` with `GrepProvider` (at minimum) into
   `bin.ts`'s `createServer` call.** Zero new tools, zero new parameters —
   purely fills in an `options.registry` argument the server and
   `context_search` handler already accept and already branch on
   (`registry?: ProviderRegistry`, `packages/mcp/src/server.ts:41`;
   `ctx.registry === undefined ? null : ...`,
   `packages/mcp/src/tools/context-search.ts:145`). This is the highest-
   leverage, lowest-risk fix: it turns on code that already exists and is
   already tested in isolation, closing findings 1 and 2's "nothing indexes
   raw/repo text" gap without touching the tool surface at all. Does not
   widen a tool's parameters or add a tool — it activates dead wiring.

2. **Add an `under?: node_id` parameter to `context_search`.** One new
   optional field on an existing tool's schema (widens `contextSearchSchema`
   in `packages/mcp/src/tools/context-search.ts:45-51`); `beamSearch()`'s
   frontier seed changes from `childrenOf.get(null)` to `childrenOf.get(
   under)` when given. Directly implements the user's literal ask ("a tool
   call to get summaries followed by another tool call that zeros in on the
   sub-branches") without adding a fifth tool. Ranks above a new
   "list-children" tool for the same reason it ranks above candidate 3.

3. **Add a `children_only?: boolean` (or reuse `depth: 'children'`) mode on
   `context_fetch`** that returns `meta.node_ids` (+ titles/kinds) without
   the summary prose body, closing finding 3 cheaply. This is a parameter
   addition to an existing tool (widens `contextFetchSchema`,
   `packages/mcp/src/tools/context-fetch.ts:34-45`), not a new tool — ranks
   above a dedicated "list children" tool by the same rule.

4. **Populate `meta` (specifically `node_ids`) on `depth:'full'` fetches
   too**, instead of hard-coding it `null`
   (`packages/core/src/retrieve/retriever.ts`, the full-depth `fetchBranch`
   return). One-line rule removal (drop the `meta: null` special case, reuse
   the same `store.currentSummary(single.id)?.meta` lookup the `'summary'`
   branch already does) — closes finding 4 without adding anything. Ranks
   highest by the "rule-removal beats rule-addition" tie-break, though its
   overall impact is narrower than candidates 1–3.

5. **Add an `offset?: number` parameter to `context_peek`** so a model can
   request a non-prefix slice of a span. Widens an existing tool's
   parameters (`contextPeekSchema`,
   `packages/mcp/src/tools/context-peek.ts:27-34`); closes finding 6.

6. **Populate the composed root summary's `node_ids`** with the ids of its
   kept (unfolded) headline members, instead of the hard-coded `[]` in
   `packages/core/src/summarize/compose-root.ts:61`. One-line change to an
   existing deterministic function — no tool surface change at all — closes
   finding 12.

None of candidates 1–6 add a fifth MCP tool or change the ≤12-line core
segmentation/assembly algorithms; all either activate existing unused code
(1), widen an existing tool's parameter list (2, 3, 5), or remove/correct a
hard-coded special case inside an existing pure function (4, 6).

## 6. Open questions

- Does the *real* deployed usage of this project (outside the eval harness)
  ever construct a `ProviderRegistry`? I found none in `packages/cli` or
  `packages/mcp` either, but I did not exhaustively check for a downstream
  consumer repo that might construct one itself when embedding
  `@context-tree/mcp`'s `createServer` — the plan does allow "a host with an
  embedder builds its own `TreeRetriever`" (comment in `bin.ts:20-23`), so
  it's possible the intended integration point is deliberately left to
  downstream hosts. If so, finding 1 is better read as "the default/reference
  binary ships with retrieval fan-out permanently off" rather than "the
  feature is unreachable" — but as of this repo's own `bin.ts`, the two are
  currently the same thing.
- Whether the p90/max leaf-size vs. lazy/slack-budget tightness in §4
  generalizes beyond the one `s1` scenario is unverified — this repo has no
  second scenario with a persisted, rebuildable store to check against.
- Whether `turn`-kind nodes (in D10's four-kind model) ever appear in any
  scenario, and if so whether they sit *under* `file` nodes (adding a third
  level the one-hop `node_ids` mechanism wouldn't reach) — not observed in
  the one fixture rebuilt for this report.
