# Interface delta: Anthropic's production retrieval vs context-tree

Analyzer lens A1 · September 4, 2026

## A. Side-by-side interface variables

The left column is Anthropic's production past-conversation tools (Fable 5.1 system prompt, `fable-5.1-past-chats-tools.md`). The right is context-tree's shipped MCP surface. Anchors cite file:line in this repo.

| Variable | Anthropic (production) | Context-tree (shipped) | Anchor |
|---|---|---|---|
| **Retrieval unit** | A conversation (one chat session). Search returns whole-conversation pointers; read opens one conversation at a time. | A branch (one phase or file node inside a single session). Search returns branch-level pointers. | `context-search.ts:67-77` (SearchHitPayload) |
| **Search default / max hit count** | Default 5, max 10. | Config `retrieval.limit` (default 20 in config, `DEFAULT_LIMIT = 8` in retriever — two competing defaults). 20 hits are rendered in the live arms. | `algorithm.md` Tier 2 row "search result limit"; `context-search.ts:152` |
| **What a search hit carries** | A `<chat>` tag with: URL, `updated_at`, `kind` (conversation\|summary), `page_token`, and a prose snippet of the matching region. Size unspecified but implied to be a paragraph or less. | **Full surface**: `node_id`, `kind`, `title`, `phase_type`, `path`, `summary_version`, `score`, `meta` (files array with line spans, symbols array, node_ids). **Coordinate surface** (tree-search-coordinates): `node_id`, `kind`, `title`, `phase_type`, `path`, `score` — no meta. | Full: `context-search.ts:67-77`; Coordinate: `transplant.mjs:1547-1559` |
| **Hit size** | Snippet per hit, estimated <200 tokens (prose excerpt). 5 hits ~1k tokens. | Full 20-hit response: 6,094–7,257 exact tokens (measured, `ds-star-search-centering-and-payload-report.md` §3). Coordinate 20-hit response: 1,200–1,400 exact tokens (same report §4). | Centering report §3–§4 |
| **Follow-up addressing** | `page_token` returned per hit; passed to `read_conversation` to open at that exact match. Also `within_conversation_id` for search-inside-one-chat. | `node_id` returned per hit; passed to `context_fetch` as `branch_id`. Optional `from`/`to` sequence range to narrow within a branch. No search-within-branch tool. | `context-fetch.ts:37-61` |
| **Read sizing** | `max_turns` (default 20, max 50). The unit is turns (human+assistant pairs), not tokens. | `depth` enum: `summary` (L1 paraphrase), `index` (event list without content), `full` (raw L0 replay — the default since R9). Narrowing is by live headroom in tokens, not by a turn count. `file` param narrows to one path. | `context-fetch.ts:39-46` |
| **Where the read opens** | At the `page_token` (the search hit's location). Omit `page_token` to read from the beginning. The model gets the match with its lead-in question. | At the start of the branch's L0 span, then narrowed by the semantic centering band (in transplant.mjs: grown outward from the query's matching events). No server-side concept of "open at the match." | `algorithm.md` Tier 1 "fetch" stanza; centering in transplant.mjs `handlersForArm` RAW_NARROWED_FETCH_ARMS path |
| **Paging affordance** | `next_page_token` and `prev_page_token` in the read result. Bidirectional. The model can walk forward or backward from the hit. | `from`/`to` L0 sequence range. The model can request any sub-range of a branch, but must know the sequence numbers. `context_fetch` with `depth: 'index'` lists the events with their seqs to enable this. No opaque continuation token. | `context-fetch.ts:53-60` |
| **Behavioral guidance (query construction)** | Explicit: content nouns, not meta-words ("discussed", "yesterday"). A few distinctive terms. Never paste a whole passage. If too vague, ask the person. | Implicit: tool description says "what you are looking for, in words." No explicit guidance on query construction in the contract (v1 or v3). | `context-search.ts:47` |
| **Behavioral guidance (opens per question)** | Explicit: "Open one or two chats per question; if they don't settle it, answer from what you have or ask the person." | No guidance on how many fetches to attempt. The contract says "fetch narrowly" and "do not re-fetch what is already in the tail" but does not cap the count. Observed: 5–8 reformulated searches on the deep set before stalling. | `system-contract.v1.md:57-61`; `ds-star-delivery-pass-report.md` §3 ¶1 |
| **Behavioral guidance (when to page / stop)** | Explicit: "read once per chat by default. A second page only when the answer is visibly cut off at the page edge, never a third." | No explicit stop-after-N-reads guidance. The contract says fetched content accumulates and is dropped at the next phase boundary, but does not say when to stop fetching. | `system-contract.v1.md:57-61` |
| **Provenance / kind labelling** | Two `kind` values: `conversation` (raw transcript with Human/Assistant labels) and `summary` (model-written digest). The guidance says prefer transcript wording when both are present. | `kind` on a hit: `task`, `phase`, `file`, `turn`. `depth` on fetch: `summary` vs `full` (raw). The contract says "a summary can tell you something happened, never what it said" (v3 rule 2) but the model must choose which to request. | `context-search.ts:48-51`; `system-contract.v3.md:17-25` |
| **Temporal retrieval** | `recent_chats` tool: returns N most recent chats, filterable by `before`/`after` datetime. | No temporal retrieval tool. Branches are in creation order in Zone B, but there is no search-by-time tool. The raw tail in `tree-tail-v2` arms serves the recency function passively. | (absent) |


## B. Per-row bearing on recorded findings

| Variable | Finding it bears on | Would Anthropic's choice plausibly move it? |
|---|---|---|
| **Hit count (5 vs 20)** | 20-hit search consumed 77–92% of available headroom at W=65,536, leaving zero bytes for fetches on 77/88 attempts (centering report §3). | **Yes, strongly.** At 5 hits with the coordinate projection (est. ~350 tokens), the remaining headroom would be ~7,500 tokens instead of ~600–1,800. This is the single largest contributor to the delivery failure. The finding "a coordinate is not a payload" (algorithm.md rule 7) was partly caused by the coordinate response itself being too large. |
| **Hit payload size** | Same finding. Full-surface hits carried dozens of file-span metadata records per hit (centering report §3). | **Yes, by the same mechanism.** Anthropic's snippet is prose, estimated <200 tokens per hit — smaller than even the coordinate projection per hit. But the coordinate projection (tree-search-coordinates) already addresses this and is untested live. The remaining delta is hit count. |
| **Read sizing (turns vs tokens)** | The 57k-token branch was read through ~6.6k of headroom and delivered nothing useful on qo04 (delivery report §3, algorithm.md rule 7). Oracle scored 0/5 on that question. | **Partially.** A turn-based cap (20 turns) would be larger or smaller than the headroom-derived band depending on turn size. For a 57k branch with ~754 events, 20 turns is a fraction that may or may not center on the answer. The key difference is that Anthropic's read opens AT the hit location, so 20 turns around the match may be exactly what is needed — the centering is implicit in the `page_token`. |
| **Where the read opens** | qo04: no query the model issued ever centered the band on the answer across 30 recorded runs (delivery report §3). The band centered on seq 55 instead of seq 218. | **Yes, directly.** Anthropic's `page_token` opens the read AT the search hit. Context-tree's fetch opens at the branch start and centers via query re-matching. The page_token design avoids the re-centering problem entirely — the search server already found the match location and encodes it in the token. |
| **Behavioral guidance (opens per question)** | 5–8 reformulated searches observed before stalling on the deep set; identical lists returned each time (delivery report §3; tree-escalate comment in transplant.mjs:253-260). | **Yes, by bounding wasted effort.** "Open one or two chats, then answer from what you have" would prevent the thrashing loop. The tree-escalate arm partially addressed this (next unseen group on each call) but was a different mechanism — Anthropic's is a behavioral constraint in the prompt, not an algorithmic change. |
| **Behavioral guidance (query construction)** | Not directly measured, but the offline ranker depends on content-noun queries. The mocked query rewriter (11/12 vs 10/12 top-3) suggests query quality matters (search ranking report). | **Plausible.** Explicit "content nouns, not meta-words" guidance might improve the queries the model issues. The effect is bounded by offline ranking already being 5/5 top-3 on the deep set — query quality is not the binding constraint there. On the overflow set (10/12 top-3) it might help the remaining 2. |
| **Behavioral guidance (when to stop paging)** | Not directly measured. But the contract's silence on stopping contributed to the thrashing pattern. | **Plausible.** The guidance "read once, take a second page only when the answer is visibly cut off" is a behavioral cap that the context-tree contract lacks. It would reduce wasted tool turns. |
| **Search hit renders without ranking evidence** | The correct branch displays as the bare word "diagnosis" while a distractor displays as "loop.ts" — model picks the distractor 5/5 (delivery report abstract). Attaching matched fingerprints (tree-hit-keywords) did NOT fix this: 18/25 vs 18/25, +32% tokens. | **No.** Anthropic's snippet is prose, not ranking evidence. Their snippets make hits legible by showing the *matched content* rather than the ranking features. But tree-hit-keywords already tested showing ranking evidence and it did not help. Anthropic's snippet differs in that it is natural text, not keyword lists — a different hypothesis, testable. |
| **Paging (page_token vs from/to)** | Not directly measured as a variable. The from/to mechanism requires the model to know sequence numbers, which it gets from `depth: 'index'` — an extra tool call. | **Plausible.** Opaque page_tokens remove a decision (which seq range) and a prerequisite tool call (index). But the main fetch path uses semantic narrowing, not from/to, so the paging affordance is not the active path. |


## C. Candidates ordered by expected information gain per implementation effort

Each candidate changes ONE interface variable against the current best arm (tree-search-coordinates, untested live). Entangled pairs are noted.

**1. Hit count reduction (5 default, 10 max)**
*Expected gain*: High. The 20-hit response is the dominant headroom consumer at W=65,536 (77–92% of space). At 5 coordinate hits (~350 tokens est.) the model retains ~7,500 tokens for fetch — a 4–10x increase in delivery budget. At W=200k the pressure is less acute but the savings still compound.
*Effort*: Low. One config change in the harness; the retriever already accepts `limit`.
*Entangled with*: Hit payload size (both shrink the search response). To isolate, run hit-count-5 with the current coordinate projection, not with the full surface. Also entangled with window size — at W=200k the headroom constraint may not bind, making the hit-count effect invisible. Test at both W=65,536 (where it binds) and W=200,000.
*Algorithm impact*: Changes Tier 2 "search result limit" from unvalidated-20 to measured-5. Does not add a rule or a line to Tier 1.

**2. Window size increase (W=200,000)**
*Expected gain*: High. The Fable 5.1 system prompt alone is ~65k tokens. At W=65,536 the tree's first tool turn arrives at ~62k, leaving ~3.5k for actual work. This is below the dead-cell boundary. W=200k gives ~135k of headroom after Zone A+B, making delivery mechanically possible. Historical naive-full at W=200k scored 25/25.
*Effort*: Zero new code — W is a harness parameter. Cost per run increases linearly.
*Entangled with*: Every other variable. Must run as the baseline epoch for all subsequent experiments. Question validity: `questions-deep.json` was cut for the overflow regime; compute whether answers still overflow at W=200k before running.
*Algorithm impact*: None — W is host-supplied. But it determines whether ANY tree variable can be measured.

**3. Behavioral guidance: opens-per-question cap**
*Expected gain*: Medium. The thrashing loop (5–8 reformulated identical searches) is observed and directly wastes turns. Anthropic's "one or two chats, then answer from what you have" is a single sentence in the contract. The mechanism is already partially tested by tree-escalate (which changed the algorithmic response to repeat searches rather than the behavioral guidance).
*Effort*: Low. One sentence added to `system-contract.v1.md` or v3. New arm in the harness.
*Entangled with*: Hit count reduction (fewer, better hits may eliminate the thrashing independently). Run this after hit-count-5, or in a composite arm with the ablation ladder: (a) hit-count-5 alone, (b) opens-cap alone, (c) both.
*Algorithm impact*: Adds one behavioral line to the contract. Does not change Tier 1 pseudo-code.

**4. Query construction guidance**
*Expected gain*: Low-to-medium. Offline ranking is 5/5 top-3 on the deep set, so the model's queries already work for ranking. The effect would be on the overflow set (10/12) or on centering quality. Not directly measured.
*Effort*: Low. One paragraph in the contract.
*Entangled with*: Opens-per-question (better first queries reduce the need for retries). Sequence: measure after opens-cap, since opens-cap is higher gain.
*Algorithm impact*: Adds behavioral guidance to the contract. No Tier 1 change.

**5. Page-token addressing (vs re-centering)**
*Expected gain*: Medium. Directly addresses the qo04 failure (0/30 delivery — no query ever centered the band). A server-side page_token that encodes the match location would bypass the re-centering problem entirely. But this is a substantial architectural change.
*Effort*: High. Requires the search tool to return a match-location token and the fetch tool to accept it. The current architecture does not record match locations during search — only branch-level coordinates. Tree-sitter spans partially serve this role for file nodes.
*Entangled with*: Hit count reduction (if 5 hits leave enough headroom, a wider centering band may reach the answer without page_token precision). Test hit-count-5 first; if qo04 still fails, page_token is the next candidate.
*Algorithm impact*: Would change both the search hit schema and the fetch addressing model. Adds complexity to Tier 1. Only justified if hit-count + opens-cap leave a measurable residual.

**6. Snippet-in-hit (natural text excerpt vs structured metadata)**
*Expected gain*: Low. tree-hit-keywords (structured ranking evidence in hits) was refuted: 18/25 vs 18/25, +32% tokens. Anthropic's snippet differs in being natural prose, not keyword lists. But the mechanism is similar — make the hit legible to the model. The negative result from keywords is weak evidence against prose snippets but not conclusive.
*Effort*: Medium. Requires extracting a prose excerpt during search. The retriever already produces `hit.text.slice(0, 240)` as a snippet in the candidate (context-search.ts:123) — it is stripped at transplant.mjs:4050 before the model sees it. Restoring it is a one-line change. The 240-char snippet is smaller than Anthropic's but testable.
*Entangled with*: Hit count (fewer hits means snippets cost less). Hit payload size (snippets add to it). Test only after hit-count-5 has been measured.
*Algorithm impact*: None (the snippet is already computed and stripped). Retiring the strip is a one-line harness change.


## D. What is NOT observable from the leak

Three categories of production internals that the leaked system prompt does not reveal:

1. **Search ranking internals.** The `conversation_search` tool is a black box. We cannot observe: the embedding model, the indexing strategy, whether it uses BM25/TF-IDF/vector/hybrid, the chunk size for indexing, whether summaries or raw turns are indexed, the re-ranking pipeline, or how `page_token` encodes the match location. The schema says "text match" in the query-construction guidance, which hints at lexical matching, but that could be guidance for the model (use content words) rather than a description of the implementation.

2. **Read windowing and truncation.** `read_conversation` returns "a few turns around" the hit, with `max_turns` up to 50. We cannot observe: how many tokens a "turn" typically is, whether the server truncates long turns, whether there is a token budget alongside the turn count, or how the server handles a turn that exceeds some internal limit. The 20-turn default might deliver 500 tokens or 50,000 depending on conversation density.

3. **Summary generation.** Hits with `kind='summary'` are "model-written digests." We cannot observe: when summaries are generated (per conversation? per day?), the summarization prompt, the summary length or structure, whether summaries carry structured metadata (files, symbols, decisions) like context-tree's, or how summary search ranking compares to transcript search ranking.

**What 2–3 pasted raw tool results from claude.ai would reveal:**

1. **A `conversation_search` result with 5+ hits on a technical query.** This would reveal: the actual snippet size per hit in tokens, whether snippets are contiguous transcript excerpts or model-generated summaries, the `kind` distribution (conversation vs summary), and the `page_token` format (opaque string? offset? hash?). It would calibrate the "5 hits at ~1k tokens" estimate that candidate 1 depends on.

2. **A `read_conversation` result at a `page_token` with `max_turns=20`.** This would reveal: how many tokens 20 turns typically produces, whether the response includes both Human and Assistant turns in the count or just one side, how the "opens at the match with its lead-in question" actually renders, and whether there is visible truncation or a hard token cap. It would calibrate whether turn-based sizing is tighter or looser than token-based sizing for code-heavy sessions.

3. **A `read_conversation` result that returns `next_page_token`.** This would reveal: the overlap (if any) between pages, the relationship between the page_token's encoded position and the next_page_token's, and whether the server chunks by turn count or by some internal budget. Combined with result 2, this would reveal the effective token budget per read call, which is the direct comparator for context-tree's headroom-derived band.
