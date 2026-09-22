# The context-tree algorithm

A context-management **middleware** for coding agents. An agent's prompt normally carries the entire
linear transcript of everything it has done, so the prompt grows without bound and eventually exceeds
the model's context window. Context-tree keeps a **bounded, cache-stable working set** in the window
and pulls older detail back **on demand**, so a long or resumed session sees compact representations of
past work instead of raw history. It bolts onto a host (opencode, Claude Code, Cline) at the
tool-result and prompt-assembly seams — it never owns the agent loop.

This page is the **implementation specification** and is self-contained: it is enough to build the
system from, except for two subsystems explicitly marked **OPEN** below (the retrieval trigger and the
resource bound), which are unresolved research questions, not omissions. The evidence, boundary
conditions, rejected alternatives, parameter audit, and development history live in
`reports/algorithm-notebook.md` and the per-experiment reports under `reports/metrics/`.

## Design principles

1. **Bound the resource, not the model's freedom.** No caps on turns, wall-clock, or reply length —
   each is a guess about work nobody measured. Bound the actual resource: a cost cap and stall
   detection (see **The resource bound (OPEN)**). Sizing content to the window is arithmetic, not a cap.
2. **A hardcoded value is a defect** unless shown to hold across models and harnesses. Derive every
   parameter from the host's declared limits; a value fitted on one host is a defect until re-derived.
3. **Err toward MORE context.** Eviction is conservative: dropping context that turns out to be needed
   costs the *task*; keeping extra costs *tokens* — not symmetric. This shapes the ejector: **topic
   shift decides *what* is eligible to evict; the soft-target floor decides *when* eviction fires and
   *how much*** — never prune below the floor, and uncertain relevance stays.
4. **Nothing reorders a cached prefix.** Prefix-keyed caches invalidate everything after the first
   changed byte, so the design rewards a *stable layout*, not a minimal payload. The working buffer only
   appends and evicts in place; it never re-mixes (a freely re-mixed buffer is cache-death).
5. **Ingestion is hermetic.** It reads only the event log, the blob store, and a parser — no network,
   no enrichment. Ingestion produces coordinates; retrieval answers questions; the two never cross.

Cumulative token consumption is **quadratic** in turn count (every turn re-sends the whole prefix), so
bounding the working set compounds on long sessions.

## Data model

| Layer | Contents | Mutability |
|---|---|---|
| **L0** | append-only event log, monotonic `seq` | source of truth, never edited |
| **L2** | content-addressed blobs (payloads) | write-once |
| **L1** | tree: nodes (each a `seq` range) + versioned summaries + links | derived, rebuildable from L0+L2 |
| **L3** | embeddings (one per unit) | derived, disposable |

Invariants: **L0 is append-only and the sole source of truth**; L1/L3/views are derived and
rebuildable; **L1 stores coordinates, not content** (a node names a `seq` range; the text lives in L2);
**summaries are versioned, never overwritten**.

## Units and the tree

- **One ladder of units, defined once and used by every stage** (decisions D23, D26):
  `phase ─ turn ─ block ─ chunk`. A **segment** is any range of the transcript that may name a
  parent segment: the tree is a coordinate system over L0, not a second store.
  - A **phase** is the segmenter's (stage 0) contiguous run of events under one tool-phase. It is
    the *grouping*: a closed phase becomes an L1 node with a `seq` range and, once latched, a
    versioned summary.
  - A **turn** is **one host message** — its reasoning (D24: the host replays it, so the unit is
    sized with it), its text, and every tool call it issued with their results. **The turn is the unit** the classifier, the assembler, the ejector and retrieval all
    operate on, because it is the only boundary a host can act on exactly. Importers stamp each L0
    event with its host message id (`turn_id`); a trace without it derives turns by a deterministic
    fallback (a message event plus the calls it issued). Turns are a pure function of L0 — not L1
    nodes, so there is nothing to persist or migrate. `unit = phase` remains selectable and
    reproduces the coarse behaviour (a single phase can reach tens of thousands of tokens, and
    nothing smaller than a phase can then be removed).
  - A **block** is a leaf segment on a natural boundary INSIDE a turn — the model's **reasoning**,
    its **text**, or one **tool call with its result**. Block ordinals are the **stub ids**: the
    universal index into the transcript, a pure function of L0, defined whether or not a block is
    folded. A turn is what a host can edit; a block is what a fold covers (§ Folds).
  - A **chunk** is a splitter piece of a turn's text under the session's one set of chunk options
    — the single sub-unit: the chunk retrieval ranks is the chunk a reduction keeps.
  Two things are **pinned** — never reduced, folded or removed — because losing them breaks the
  request rather than the policy: the **task statement** (a chat template rejects a prompt with no
  user message) and the **newest message**.
- **The tree is shallow — one root over the phase-leaves; there is no deep nesting.** The root is
  composed deterministically from the leaves' **headlines** (keyword fingerprints — file paths,
  identifiers, symbols) in creation order: the newest few phases keep their full representation, older
  ones fold to a one-line headline. `node_links` record `superseded_by` / derived edges. The value comes
  from summary-headed leaves plus on-demand retrieval, not from depth.

## The pipeline (per turn)

Two scorers feed one decider, and retrieval serves on demand: the **classifier** scores
query-independent state (has the topic shifted), the **retriever** scores query-dependent relevance
(what matches this turn). Then three separate rulings, in order: the **assembler** decides how each
unit is *represented* (and asks for summaries), the **segmenter** decides what is *folded* (§ Folds —
written to the ledger), and the **ejector** — optional, taking both as its input, and free to overrule
them — decides what is *removed*. All are sticky until explicitly restored, so a turn on which no ruling
is made leaves the prompt byte-for-byte as it was. **fold → summarize → delete** is the compression
ladder: as a stretch of the session becomes less relevant to what is being discussed now, it is more
likely to be folded, then summarized and referenced, then deleted.

**0 — Ingest.** Append each event to L0; store payloads in L2; cap edit-tool arguments (replace the
argument blob with its L2 hash once the post-state blob exists). Segment L0 deterministically under a
selectable **boundary strategy** (`boundary`, D26): `toolPhase` — **tool name → phase** via a config
`TOOL_PHASE` map (unknown → `other`), a phase closing when the mapped phase changes; `tiling` — TextTiling
between blocks (`boundaryWindow`, `boundaryThreshold` = mean − t·sd); `drift` — causal lexical topic
shift against the previous `boundaryWindow` blocks, Welford z-scored, cut above `boundaryThreshold`;
`boundaryTopK` keeps only the K strongest cuts. A host `segment_boundary` always wins. Embedding and
kNN cuts (rung-0b) are not strategies here: D15 forbids embeddings on the ingest path. The closed run
becomes a node. Extract **fingerprints** by regex over raw event text
and tool arguments: file paths, `snake_case`/`camelCase`/`PascalCase`/`UPPER_SNAKE` identifiers, and
backticked spans. Once the trace exceeds the window, **latch** (L0 only grows, so it never fits again)
and summarize each closed phase on a **cheap model** into a new versioned `node_summaries` row; the
summary **must carry rehydration pointers** — the files+spans it touched, symbols, tests, ticket/PR ids
— so the model knows what it can fetch back. A later edit sets `stale_since_seq` on its node; staleness
travels up the ancestor path only, and a stale node is re-summarized at the next latch.

**1 — Classify (dormancy).** For each unit, compute a **continuous drift** from the recent window (the
last `K` units, default K=5):
```
drift(u) = 0.5·(1 − Jaccard(fingerprints(u), fingerprints(recent))) + 0.5·(1 − cosine(emb(u), centroid(recent)))
```
z-scored against the session's own running mean/std of drift (causal), so a unit's z-drift is measured
in standard deviations above the session's mean drift. **Dormancy is this drift**, min-max normalized to
[0,1] across the current units. A unit is coarsely "dormant" when its z-drift exceeds a conservative
threshold `τ = 1` (one SD above the running mean — err toward keeping), but eviction uses the continuous
magnitude, not the boolean. Embeddings are a small local encoder (MiniLM-class),
one per unit, cached in L3.

**2 — Assemble (representation; removes nothing).** The prompt is a **frozen cached head** (system + steering + all user prompts,
append-only) followed by a **creation-order flex buffer** of units, with a **cache breakpoint** after
the head so the head caches.
- **Representation:** units are **raw** by default, sized at their FOLDED size (§ Folds). A raw unit
  over the per-unit budget is **reduced** (below). A reduction, ruled, is sticky: a unit does not flip
  back to raw on a roomier turn, which would rewrite the prefix. Assembly folds nothing.
- **Summary requests (D26).** When `foldSummaries` is on and a run of at least `foldMinRun`
  consecutive folded blocks outside the anchor stands for more than `foldSummarizeAt` of the budget
  in raw tokens (what the summary would cover — not what the stubs take, which for an empty tool
  output is more than the output), assembly asks for ONE summary over that run — widened to the segment that contains it when every
  block of that segment is folded — and reports the request. It does not wait: a summary takes a model
  call, and the caller (a host adapter, the agent) fulfils it through `summarize`; the next view shows
  it. A range already under a summary is not asked for again.

**2b — Fold (the segmenter; D26).** Folding is what the segmenter does to the segments it cut:
show a block in a shorter form, written to the **ledger** — `fold` / `unfold` events in L0, so what
the model was shown on any turn is replayable, a rebuild loses nothing, and a fold's text never
changes once written (D5).
- **A stub** is a summary-free fold of ONE block, like a collapsed region in an editor. A tool
  block keeps its call and its input; the output becomes
  `[folded · N tokens · began: "<first line>" · recall: fetch {"stub":31}]`. A reasoning block
  **followed by the model's own text folds to nothing** — that text is its summary, at a measured
  median 4.4% of the thinking it follows — and that text stays as its own block; a reasoning block
  with no text after it keeps its **tail** under `[folded thinking · N tokens · recall: fetch
  {"stub":30}]` (`foldReasoning: tail | drop | keep`, `foldReasoningTail`: the conclusion sits at
  the end of a thinking block, the deliberation at the start). A text block folds to its first line.
- **A summary** is a fold over 1..n stubs — an epoch of the session — written ONLY by `summarize`,
  on request (§ Assemble): `[summary m91 · <one sentence> · files: … · recall: fetch
  {"from_seq":12,"to_seq":40}]`, carried by the first text block in its range (else its first
  reasoning block, else its first block), the rest of the range hidden. Ranges may **overlap**
  (`1:65` and `40:85`); both show. A summary whose range is a segment's span IS that segment's
  summary (`node_summaries` is derived from the ledger). A summary counts only if
  `summary_tokens ≤ summaryRatio × tokens_summarized`; otherwise the stubs stand. A phase summary,
  the root roll-up (the range over all blocks) and an ad hoc range are one thing.
- **What makes a block fold is the research variable** (`foldTrigger`): `none` — nothing folds;
  `pressure` — once the prompt exceeds `foldStubAt` × budget, the lowest-scored blocks fold until it
  fits, reasoning before tool outputs before text within a turn, never inside the anchor or a
  pinned turn; `cadence` — the pressure rule every `cadenceN` turns (DV3's cost lever). Independently,
  `foldReasoningAfter = K` folds the reasoning of every turn older than the newest K — the cheapest
  loss there is and a third of the prompt, so it is tested on its own (U18's `think` arm).
- **Score** (shared with eviction): priority, recency, reference recency, dormancy, and — at weight
  0 until U3 tests it — **contextual covariance** (`wCovariance`, `covarianceK`, `covarianceM`), the one
  offline signal that survived deep dormancy. Every tag describes and never instructs: a reference
  that names its content beat a placebo (T12b); nudges were ignored 33 of 33 times; stronger
  contracts scored 0/9. Why folds exist at all: silent eviction was never followed by a recall (U18
  wave 0: one recall call in 21 cells), and a third of the prompt — the reasoning — was being
  counted, then deleted with no tag and no way to search it.

**3 — Evict (removal; optional; input = the assembly and the folds).** Units are sized **as shown**
— folded, reduced — so a folded unit is cheap to keep, and any unit can still be removed here. The
ejector never chooses a representation and writes no fold.
- **Eviction — what / when / how much.** *When:* eviction fires only when the buffer exceeds the
  **hard limit** `window − replyReserve`; never below it. *What:* above the limit, evict the
  **lowest-scoring** units first (the dormant, low-priority, old ones). *How much:* just enough to fit,
  plus an optional `evictHeadroomTokens` (default 0) so eviction need not fire again next turn.
  Score each non-pinned,
  > **Resolved 2026-09-14 (was OPEN).** The trigger was a soft-target floor `f = 0.375·W`. Live evidence
  > retired it: task success tracks **achieved peak** — the tokens actually present at call time — at
  > **OR 42× per e-fold** across 78 capped cells (arm-adjusted), and nothing else measured moves it
  > (selection signal p=0.70; reference-vs-positional recency p=1.000; needle position 180/180;
  > cadence p=0.54 given peak).
  > Evicting to a floor *below* the window discards the only quantity shown to matter, and DV2 adds that
  > it converts 0.1× cache reads into 1.25× cache writes to do so. `f` now sizes only the per-unit
  > reduce budget `b`. The headroom seam is deliberately 0 rather than a fitted fraction: headroom for
  > `N` turns is `N × growth-per-turn`, which as a fraction of the window is not constant across window
  > sizes — a fixed fraction is the wrong *shape*, the same defect `f` had. Single-problem evidence (C0).
  > `reports/metrics/context-dedup/report-{cadence-confound,window-metric}.md`.
  non-anchor unit, **min-max normalizing each signal across the current candidate units this turn**:
  ```
  score = 2·priorityN + 1·recencyN + 0.5·refRecencyN − 1·dormancyN        (relevance weight = 0)
  ```
  - **priority** = edit/fetch boost (a unit whose phase wrote a file, or that the model fetched, = +2)
    + recurrence (# other units whose fingerprints overlap this unit's), decayed by turns since last
    reference.
  - **recency** = 1 − normalized age (turns since the unit was created).
  - **reference-recency** = 1 − normalized turns since the unit's fingerprints were last referenced.
  - **dormancy** = the classifier's normalized drift (continuous), subtracted. *(The 2/1/0.5 weights are
    the offline-derived D-EV defaults; the dormancy term is the classifier's contribution and least
    tuned.)*

  Relevance (the retriever's query-match) is weighted **0** by default — it is an *admission* signal,
  not an eviction one (on non-monotonic history it drops exactly the unit that returns). It is a
  parameter, not a constant: at weight > 0 a unit's rank among the top-`k` hits for the current query
  enters the score.
  - **Protection is a score, not a wall.** The recency anchor is a **bonus** added to a unit's
    score — full for the newest unit, halving with distance. It is on the **same scale as the
    weights** (default: equal to the priority weight), so it is one signal among the others and a
    stale anchored unit can be outscored by valuable older work; set above the weights' sum, the
    anchor yields only after everything else has. `protection = hard` restores the absolute anchor (under which
    this is the original packing exactly). Only the two pinned units are absolute.
- **Reduce-on-overflow (part of stage 2, stated here with its budget).** A **raw** unit larger than the **per-unit budget** `b` — the floor's raw space
  shared across the raw slots, `b = (f − reply reserve) ÷ (A + 1)` (the active phase plus the `A`
  anchor units are the units kept raw, so no single raw unit may claim more than its share of the floor)
  — is shrunk by a **query-aware
  router**, decided by a heuristic on the current task/query: seeks a localized value/detail (a name,
  number, specific fact) → `chunk+retrieve`; a gist/overview suffices → `summarize`; **default
  `chunk+retrieve`** (err toward preserving detail). `ref` when a pointer suffices and the content is
  re-fetchable; `drop` only for a unit both dormant and low-priority. Applies to **raw content only**; a
  **curated retriever result is retained whole**, never re-chunked. Nothing reorders the cached prefix.

**4 — Retrieve on demand.** The corpus is the L0 units chunked by a recursive character splitter
(~800/100 overlap). Fan out **BM25 + vector (kNN over the same chunks, MiniLM-class embeddings)** and
fuse by **RRF**: `rrf(u) = Σ_r 1/(RRF_K + rank_r(u))`, `RRF_K = 60` — overlapping coverage fuses; a
single-coverage query routes to the sole coverer. Return the best-matching **whole units**; the fetched
unit **appends after the buffer** so the cached prefix is untouched, and is **retained whole**. A tool
result the model fetched itself (e.g. its own graft/LSP call) is likewise captured verbatim and retained
whole — never re-retrieved or re-chunked (that would only lose signal).

## The retrieval trigger (OPEN)

How a "need for older detail" is expressed is **not settled**. Current design: the model calls a
retrieval **tool** (an MCP `context_search` / `context_fetch` surface) — model-gated, on demand. Whether
to *additionally* push relevant units up-front (retrieve-first) is an open A/B (prior evidence: on-demand
loses below the overflow regime and wins in it). Implement the model-gated tool path; the up-front path
is intentionally unspecified.

## The resource bound (OPEN)

Principle 1 bounds cost and non-progress rather than turns. The **cost-cap** value and the **stall /
progress detector** — needed to break the agent-indecision loop where the model re-reads without acting
— are **not specified**; they are an open research gap, not part of the validated core. Treat them as
host-provided hooks (a `costCapUsd`, a stall predicate) with values TBD.

## The middleware seam

The pipeline runs as host hooks and never owns the agent loop:

- **tool result** (`tool.execute.after` / PostToolUse): capture the result to L0; if it is raw and would
  overflow the per-unit budget, apply the reduce-on-overflow router. A curated retriever result is kept whole.
- **prompt assembly** (`chat.messages.transform`): run classify → assemble → fold → (optionally)
  evict, then apply the rulings to the host's message array **in place** as **part edits**. The host
  is never re-rendered: a decision names a message and its parts — a reasoning or text part replaced
  or removed, a tool part's **output** replaced or the part removed (the call and its result travel
  together, so nothing is orphaned) — and a whole message is dropped only when it is evicted or
  nothing is left of it. Because a turn *is* a host message and a block *is* a part, the mapping is
  exact. When to call evict — every turn, never — is the host's policy; when a block folds is the
  segmenter's (`foldTrigger`).
- **frozen head** (system / tool-schema transform): the head is assembled after the message transform, so
  it is out of the eviction path by construction. Cache breakpoints are Anthropic-explicit; on a host
  without them the *layout stability* (principle 4) still yields prefix reuse.

## Parameters

Derived from the host's limits, not guessed. **The list, defaults, bounds and environment names are
not restated here**: they are one registry in code — `packages/mcp/src/params.ts` `PIPELINE_PARAMS`,
served at `GET /v1/params` — from which the tool arguments, validation and the experiment harness's
knobs all derive. Every default there is PROVISIONAL (hand-set or borrowed, never swept). What the
registry cannot say is what each quantity *means*:

| Parameter | Meaning / derivation |
|---|---|
| Window `W` | host-supplied, per call. Compared against **heuristic** tokens (below), never served tokens |
| Unit | a turn (one host message), or a whole phase |
| Recency anchor `A` | the last `A` units carry a protection bonus; also sizes `b` |
| Soft target `f` | a fraction of `W`. **Not an eviction trigger** (resolved 2026-09-14); it only sizes `b` |
| Per-unit budget `b` | `(f·W − reserve) ÷ (A + 1)`; a raw unit over `b` is reduced to it. **Degenerate when `f·W ≤ reserve`** — at W = 50,347 with a 20,192 reserve and `f` = 0.375, `b` = 0 and reduce-on-overflow never fires |
| Drift `K`, `τ` | recent window in units; z-drift above which a unit is coarsely dormant |
| Signal normalization | per-turn min-max across candidate units, before weighting |
| Eviction weights | a *linear* mix of priority, recency, reference-recency, −dormancy, and relevance (default 0) |
| Reducer | chunk (keep the spans matching the query, mark the gaps) or summarize; default chunk |
| Chunker, `RRF_K` | recursive character splitter; rank-fusion constant |
| Reply reserve | the host-declared `Model.limit.output`, plus whatever the caller cannot see (system block, tool schemas) |
| Tokenizer | **heuristic, and one of them**: `HeuristicTokenizer` over what the host sends for a unit (`hostContent`: reasoning, text, tool input, tool output — not the rendering's headers). A host plugin sizes its message array the same way, so a window is ruled and checked in one unit. It is not the served tokenizer: measured 0.92 served tokens per heuristic token over one cell's unedited turns (`chars/4`, which the plugin used until 2026-09-21: 1.19). That ratio is a per-turn *measurement* that differs by problem and drifts within a run — never a conversion constant |
| Embedding model, summarizer | small local encoder (MiniLM-class); cheap model, output versioned, must include rehydration pointers |

## Status

Validated live: eviction saves tokens without losing the task; the reduce-on-overflow router
(summarization is insufficient for a buried detail, chunk+retrieve wins); the middleware is *required*
under a hard window; RRF ensemble retrieval and drift-based classification; **the eviction trigger is the
hard limit, not a soft floor** (resolved 2026-09-14 — see the eviction rule above). Also settled as a
*negative*: **position within the context is not a lever** on this model at these lengths (180/180 across
depths to 155,773 real tokens — `report-position-probe.md`), so the creation-order buffer forfeits
nothing by ignoring position. **Open** (see the OPEN
sections): how much headroom eviction should free when it fires (the cadence/cost question); whether the
selection *signal* matters at all, which is gated on the instrument-sensitivity control; the retrieval trigger
(on-demand-vs-up-front); and the resource bound (cost cap + stall/progress detector for the
agent-indecision loop the footprint middleware does not fix). Evidence and the full development record:
`reports/algorithm-notebook.md` and `reports/metrics/`.
