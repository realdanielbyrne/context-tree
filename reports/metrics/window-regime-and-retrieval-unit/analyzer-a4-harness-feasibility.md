# A4: Harness feasibility for realistic-host and Fable-interface experiments

Two proposed experiment kinds in `eval/scripts/transplant.mjs` (4,688 lines), with exact file:line anchors, one-variable discipline risks, and effort estimates.

## Kind 1 -- realistic-host regime (W >= 200,000 + Zone-A pad)

### Where system text is assembled per arm

System text enters through two constants and one parameter:

- `FLAT_SYSTEM` (transplant.mjs:1396) -- six-line string used by `naive-full`, `truncate-tail`, and `compact-rolling` in `buildArm` (3724-3741). It carries no tool schemas and no Zone-A sizing concern.
- `TREE_SYSTEM` (transplant.mjs:1423) -- `treeSystemTextFor('tree')` returns `systemContract(contractVersionFor(arm)) + QA_ADDENDUM`. Passed as the default `systemText` parameter into `assembleTreeAt` (1812) via `buildTreePrompt` (1828). Every tree arm reads it.
- `assembleTreeAt` (1812) accepts `systemText = TREE_SYSTEM` and feeds it to `ZoneAssembler({ systemContract: systemText })`.

A Zone-A pad must be prepended to both `FLAT_SYSTEM` and `TREE_SYSTEM` so it is applied identically across arms. The insertion points are the two `const` definitions (1396, 1423) -- or, for cleaner isolation, a `withPad(system)` wrapper called at `buildArm` (3722) and `buildTreePrompt` (1828).

### How budgets derive from W

`deriveBudgets` (transplant.mjs:454) computes every zone budget as `Math.floor((fraction * windowTokens) / ratio)`. The fractions at line 106 sum to 1.00 (reply .05, zoneA .10, zoneB .20, zoneC .20, lazy .35, slack .10). `K` for `truncate-tail` is `K_FRACTION * W / ratio - reply` (475).

A pad that is "real" Zone A content (occupying the system prompt) must reduce the token budget available for the tree's own Zone A. The Zone A fraction (.10 of W=200k = 20k heuristic-equivalent tokens) is already smaller than a ~70k-token pad. The pad therefore cannot fit within the current Zone A allocation at W=200,000 -- it would need `per(0.10) + padTokens` to be reserved from the window, leaving less for B, C, and tail.

**The honest approach is to increase W by the pad size.** If the pad is ~70k tokens, set `--window 270000` with the pad occupying the first 70k of system text. `deriveBudgets` then partitions 270k and the pad naturally consumes a share of Zone A + slack. The fractions still sum to 1.0 and nothing else changes. The alternative -- a separate `--pad-tokens` option that subtracts from `windowTokens` before calling `deriveBudgets` -- is arithmetically equivalent but requires a new derivation path.

### Anchor: where the pad must reduce derived budgets

`deriveBudgets:461` -- `const per = (fraction) => Math.floor((fraction * windowTokens) / ratio)`. If the window parameter already accounts for the pad (W = 270k), no derived-budget change is needed. If instead the pad is injected separately, `windowTokens` at this line must become `windowTokens - padTokens` for every fraction that represents model-usable space. The first approach (absorb into W) is simpler and avoids a special-case branch.

### Result identity and code fingerprint

`codeFingerprint` (329) hashes three files. The pad text changes `transplant.mjs` itself, so `codeFingerprint.transplant` naturally changes. `identity` (4263) records `invocation: { window, arms, ... }`. The pad text or its hash should be added to `identity.invocation` so two runs at the same W with and without a pad are distinguishable. A new key `padSha` in the `invocation` object (4275) suffices. Effort: +2 lines.

`candidateKey` (4258-4262) is arm-specific. A pad experiment does not change any candidate key; it changes the baseline regime. Record the pad as a top-level `identity.pad` field.

### CLI option plumbing

`parseArgs` (4638) is a simple `--key value` parser. Add `--pad <path>` read at `runArms` (4156). Load the file, measure its token count with the same `exact` tokenizer used elsewhere, prepend it to both `FLAT_SYSTEM` and `TREE_SYSTEM` (or pass it to `buildArm` and `assembleTreeAt`). Effort: ~15 lines in `runArms`, ~5 lines in `buildArm`.

### naive-full at W=200,000

The guard is at transplant.mjs:4323: `const nativeFitsWindow = arm === 'naive-full' && options.window >= 200000`. At W=200,000 it runs all questions at all reps. At W=270,000 (or higher) the same guard passes. This is correct behavior -- at these windows the trace (s1 is ~196k tokens) fits, so `naive-full` is the ground-truth reference.

### compact-rolling artifact at W=200,000

The fixture directory (`eval/fixtures/transplant/s1/e1b289c32f40/`) contains only `compact-16384.json` and `compact-32768.json`. There is no `compact-200000.json`. `buildCompactionArtifact` (3548) builds one per `budgets.window` and caches it on disk at `compact-${budgets.window}.json` (3553). A first run at W=200,000 (or W=270,000) will trigger a live compaction build costing real tokens (capped at `CAP_USD_COMPACTION = $1.00`, line 137). This is a one-time LLM cost for the baseline; subsequent runs load the cached artifact.

### Pad text selection and behavioral risk

Candidate sources:

1. **The leaked Fable 5.1 prompt** (275,723 chars, ~65-70k tokens). Realistic but its content -- instructions about tool use, personality, safety -- could change model behavior differently per arm. A Fable-aware model reading Fable instructions in its system prompt may alter its tool-calling pattern.
2. **Generic coding-agent instructions** (e.g., a synthetic document matching the size but containing no behavioral directives). Neutral but unrealistic.
3. **Repository documentation** (e.g., a large CLAUDE.md padded to size). Realistic for the domain but introduces answerable content that could confound the question set.

Option 1 is the most realistic but entangles pad content with model behavior -- a second variable. The mitigation is that the pad is IDENTICAL across arms, so any behavioral change is a constant offset in every score. The risk is an interaction effect: a model reading Fable tool instructions alongside context-tree tool schemas may confuse the two. This is worth measuring, not avoiding.

**Recommendation:** Use option 1 (Fable prompt) for the primary run, option 2 (inert pad) as a control arm to isolate the size effect from the content effect. That is two experiments, not one, and the ablation is clean: size-only vs size+content.

### questions-deep.json validity at W=200,000

`questions-deep.json` has metadata: `ref_window: 131072`, `boundary_seq: 268`, `K: 123232`. The 5 questions were cut for overflow at W=131,072. At W=200,000 (or 270,000), the truncation boundary shifts: `truncationBoundarySeq` computes the newest events fitting K tokens, and K grows linearly with W. The answer-bearing events (at seqs near `boundary_seq: 268`) may fall inside the tail at W=200k, making these questions non-overflow. This must be computed offline before running.

The computation: for each question, check whether its `seq` falls above the truncation boundary at the target W. If it does, the question tests the tail regime, not the overflow regime. A new question set cut at W=200k (via `--phase prep-overflow --window 200000`) may be needed. This is a zero-live-token operation (prep-overflow uses only the frozen store and offline tokenizer).

### Effort estimate

| File | Change | Lines |
|---|---|---|
| `transplant.mjs:4156-4175` (runArms) | Read `--pad`, prepend to system text | ~20 |
| `transplant.mjs:1396,1423` | Make FLAT_SYSTEM/TREE_SYSTEM accept pad prefix | ~8 |
| `transplant.mjs:4263-4276` (identity) | Record `padSha`, `padTokens` | ~5 |
| `transplant.mjs:3722` (buildArm) | Thread pad through to system text | ~10 |
| Total | | ~43 |

## Kind 2 -- tree-fable-interface arm

### The interface to port

From `fable-5.1-past-chats-tools.md`: `conversation_search` returns max 10 hits each carrying a text snippet plus an opaque `page_token`; `read_conversation` opens AT that token, returns `max_turns` events (default 20, max 50) with `next_page_token`/`prev_page_token`; behavioral guidance says read once per chat, page only when the answer is visibly cut off.

### How existing raw-fetch arms center and size their band

`retriever.ts:293-419` (`fetchBranch`): when `options.maxTokens` is set and `options.query` is provided and the full branch exceeds the budget, `findRelevantCenter` (574) finds the highest-scoring event seq, then a grow-outward loop (381-391) expands `startIdx`/`endIdx` under a real token count until the next event would not fit. The band is measured, not estimated (algorithmic rule 5).

The headroom feeding this is set per tool call in the turn loop at transplant.mjs:4032: `built.toolCtx._liveHeadroomHeuristic = Math.floor(live / budgets.ratio)`. The fetch handler (1756) reads it: `const headroom = ctx._liveHeadroomHeuristic ?? Math.floor((ctx._headroom ?? 20000) / 2)`. The centering mode is `retrievalCenterFingerprintMode` (retriever.ts:69,117), controlled per arm at transplant.mjs:4310.

### How a handler reads events by seq range

`context-fetch.ts:85-119`: the MCP handler calls `ctx.retriever.fetchBranch(branchId, { depth, file, from, to })`. The `from`/`to` parameters are inclusive L0 seq numbers (context-fetch.ts:51-60) that clamp to the branch's own span. The retriever reads via `this.trace.read({ from, to })` (retriever.ts:368) which iterates `JsonlTraceLog`. Rendering is `renderSpans` (411) for `depth: 'full'` or `renderIndex` (401) for `'index'`.

The Fable interface's `read_conversation` returns a fixed number of **turns** (not tokens), anchored at a `page_token` (an opaque pointer to a seq). To port this: the handler receives a seq (decoded from the page token), reads N events forward from that seq, and returns them with `next_page_token` (seq of the last event + 1) and `prev_page_token` (seq of the first event - N). This is a fundamentally different unit than the token-budget band.

### The search-result strip defeats a snippet arm

transplant.mjs:4045-4052: after a `CONTEXT_SEARCH` call succeeds, the harness destructures each hit: `outcome.data.hits.map(({ snippet, text: _text, ...rest }) => rest)`. This explicitly removes `snippet` and `text` from every hit before the result enters the conversation. A Fable-interface arm whose search returns snippets would have them stripped here.

**What must change:** The strip at 4045-4052 must be conditional. Either: (a) skip it entirely for the fable-interface arm by checking the arm name before stripping, or (b) restructure so that the arm's handler returns a field the strip does not target (e.g., `excerpt` instead of `snippet`). Option (a) is simpler; option (b) is fragile. Effort: ~5 lines (wrap the strip in `if (arm !== 'tree-fable-interface')`). But the arm name is not available at 4045 -- it is known in the outer loop at 4284 and must be threaded into the `built` object or checked via a flag.

### The append cap interaction with a fixed-turn read

Algorithm rule 5: truncate once. The current flow: the retriever narrows by token budget (one cut), then `capToolResult` (4057) enforces the window cap (a second cut, but rule 5 says the first cut should be sized so the second finds nothing left). A fixed-turn read (20 events) does NOT size itself to headroom -- it returns a fixed amount of content regardless. If that content exceeds headroom, `capToolResult` re-cuts it, and the re-cut drops the tail (which may be the answer). This is a rule-5 violation by design in the Fable interface.

Fable's mitigation is behavioral: the prompt says "read once, page only when the answer is visibly cut off." The model is expected to stop, not to receive unlimited content. The question is whether the harness should cap or let the model see an over-budget read. In the harness, `capToolResult` is mandatory (it prevents the window from being exceeded), so the Fable arm must accept that a 20-event read can be truncated. The telemetry already records `droppedChars` and `answerLiteralPresentAfterCap` (4097-4104), which is exactly the data needed to measure how often the cap damages the answer.

### How to add the arm: toolSchemasForArm and handlersForArm

`toolSchemasForArm` (1575): add a case for `'tree-fable-interface'` that returns two tools: `conversation_search` (replacing `context_search`) and `read_conversation` (replacing `context_fetch`), with the Fable schemas from the reference doc. `context_peek` and `annotate` are dropped (Fable has no equivalent). Effort: ~40 lines for schema definitions.

`handlersForArm` (1591): add a branch for the new arm. The search handler calls the existing `HANDLERS[CONTEXT_SEARCH]`, maps hits to Fable's format (adding a snippet from the first N chars of the branch's raw text, and a `page_token` encoding the hit's center seq), and caps at `max_results` (default 5, max 10). The read handler decodes `page_token` to a seq, reads `max_turns` events forward via `ctx.retriever.fetchBranch(branchId, { depth: 'full', from: seq, to: seq + max_turns })` (using event count, not seq arithmetic -- seq may not be contiguous), and returns `next_page_token`/`prev_page_token`. Effort: ~80 lines.

`ARM_IDS` (203): add `'tree-fable-interface'`. `TREE_ARMS` (522): add it. `buildArm` (3722): add a case that assembles the tree prompt with the Fable contract text (adapted from the `<past_chats_tools>` section). `LEGACY_SURFACE_ARMS` (1452): add it. `RAW_NARROWED_FETCH_ARMS` (1461): do NOT add it (its fetch is turn-based, not narrowed). Effort: ~25 lines.

### Telemetry

`_searchObservations` (1699) and `_fetchObservations` (4007/4067) are recorded per tool call. The new arm's telemetry must record: snippet chars per hit, k (number of hits returned), events returned per read, and whether the answer literal was in the payload. The existing `toolCalls` array (4075-4105) already captures `beforeChars`, `afterChars`, `beforeTokens`, `afterTokens`, `droppedChars`, and `answerLiteralPresentAfterCap`. New fields needed: `snippetChars` (sum of snippet lengths in search results), `readEvents` (events returned by read_conversation), `pageToken` (whether the read was paged). Effort: ~10 lines in the `toolCalls.push` block.

### Differences vs tree-search-coordinates entangled in one arm

A composite `tree-fable-interface` arm changes at least four variables vs `tree-tail-v2`:

1. **Search result format**: snippets instead of coordinates-only (tree-search-coordinates removes snippet at `coordinateSearchData`, 1547-1559; Fable adds it back with a char cap).
2. **Search result count**: max 10 instead of the current `limit` (config default 20, retriever default 8).
3. **Fetch unit**: fixed event count instead of token-budget band.
4. **Contract text**: Fable's behavioral guidance replaces the context-tree system contract.

### Minimal ablation ladder

The first three can be isolated as flags on the existing `tree-tail-v2` arm:

| Toggle | Implementation | Isolates |
|---|---|---|
| `--search-k N` | Override `limit` in the search handler (1596, 1722). Already partially wired: `ctx.config.retrieval.limit` is read at 1596. | Hit count |
| `--hit-snippet-chars N` | In the search handler, attach `snippet: rawText.slice(centerIdx - N/2, centerIdx + N/2)` to each hit, and skip the strip at 4045-4052 for this arm. | Snippet presence and size |
| `--read-events N` | In the fetch handler, replace the token-budget band with a fixed event count around the center seq. | Fetch unit |

The fourth (contract text) requires a separate arm because it changes the system prompt prefix, which all other toggles share.

**Proposed ablation ladder (5 arms, each adding one variable):**

1. `tree-tail-v2` -- baseline (current).
2. `tree-tail-v2 --search-k 5` -- Fable's default hit count.
3. `tree-tail-v2 --search-k 5 --hit-snippet-chars 200` -- add snippets.
4. `tree-tail-v2 --search-k 5 --hit-snippet-chars 200 --read-events 20` -- Fable's fetch unit.
5. `tree-fable-interface` -- full composite with Fable contract text.

Arms 2-4 are flag variations of `tree-tail-v2`; arm 5 is the composite. The ladder isolates each variable against its predecessor.

**Risk to one-variable discipline:** Arms 2-4 preserve the context-tree contract text, so their behavioral guidance still says "use context_fetch with a branch_id" rather than "use read_conversation with a page_token." If the model follows the contract literally, changing the fetch unit has no effect because the model still requests a branch_id. The contract text is not separable from the tool surface -- they are one interface. This means arms 2-4 may measure nothing, and only arm 5 (full composite) has ecological validity. The ablation ladder is correct as experimental design but may produce null results on the intermediate steps.

## Kill gates

### Existing gates

Eight killgate scripts exist in `eval/scripts/`: `rank-killgate.mjs`, `centering-killgate.mjs`, `narrowing-killgate.mjs`, `delivery-killgate.mjs`, `search-coordinate-killgate.mjs`, `facet-killgate.mjs`, `killgate2-event-embeddings.mjs`, `line-index-killgate.mjs`. Plus `gate-ledger.mjs` (167 lines) which is a corpus replay of the completion gate, and `provenance-audit.mjs`.

The `--phase gates` path at transplant.mjs:4667 runs the built-in gates (g1-g14 based on the `GATE_IDS` array at line 293).

### New gates needed

**Kind 1 (pad regime):**
- **Gate: pad-token-budget.** Verify that `deriveBudgets(W_effective, ratio)` produces zone budgets where Zone A >= pad tokens + tree contract tokens + tool schema tokens. Offline computation; zero live tokens.
- **Gate: question-validity-at-window.** For each question in the target set, compute `truncationBoundarySeq` at the target W and verify the question's answer seq falls BELOW the boundary (i.e., in the overflow regime). If it does not, flag it. This is the "re-cut per claim window" hazard from algorithm.md. Offline; zero live tokens.

**Kind 2 (Fable interface):**
- **Gate: snippet-survival.** Verify that the search handler returns snippets AND that the strip at 4045-4052 does not remove them for this arm. Run one search call offline, assert `snippet` field is present in the result after the strip point. Zero live tokens.
- **Gate: page-token-roundtrip.** Encode a seq as a page_token, decode it, verify the read handler returns events starting at that seq. Zero live tokens.

### Test files

`eval/test/transplant.test.ts` (704 lines) covers the exported functions. New tests for pad injection, Fable handler behavior, and snippet survival should be added there.

## Effort summary

| File | Kind 1 (pad) | Kind 2 (Fable) |
|---|---|---|
| `transplant.mjs` | ~43 lines | ~160 lines |
| `eval/test/transplant.test.ts` | ~20 lines | ~40 lines |
| New killgate script(s) | ~30 lines | ~30 lines |
| Total | ~93 lines | ~230 lines |

## Harness defects found

1. **transplant.mjs:1756** -- `ctx._liveHeadroomHeuristic ?? Math.floor((ctx._headroom ?? 20000) / 2)`: the `20000` fallback is an unvalidated constant (documented in algorithm.md Tier 2 as a defect). The halved version persists here even though the Tier 2 table says "the halved one that computes the budget" was identified as a defect. Not fixed by this analysis; documented.

2. **transplant.mjs:4045-4052** -- The search-result snippet strip is unconditional. Any future arm relying on snippets in search results will have them silently removed. This is not a bug in the current design (no arm uses snippets post-strip) but blocks Kind 2 without modification.

3. **No compact artifact exists for W >= 200,000.** The first `compact-rolling` run at any new W requires live LLM tokens for the compaction build ($0.38-1.00). This is by design but means the first Kind 1 batch cannot be fully zero-live-token in its prep phase if it includes `compact-rolling`.
