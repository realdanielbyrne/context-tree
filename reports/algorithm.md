# The context-tree algorithm

The reference a DS-STAR pass scores against and a new host ports from.
A change to the algorithm and a change to this page happen together.

The goal: simple, repeatable, translatable to a model and harness it has
never seen. Seven rules follow from that, and two guiding principles set by
the user on 2026-09-05 (8 and 9) that the next loop exists to test.

**1. No budgets or caps on the model's freedom to work** — turns,
wall-clock, or reply length. Each is a guess about work nobody has
measured. Bound the actual resource instead: spend by a cost cap,
non-progress by stall detection. Two caveats the page owes: sizing
content to the WINDOW is not this (Zone budgets and the append cap are
arithmetic, not guesses), and the rule is not yet kept — the summarizer
caps its own reply at 1,024 tokens, two provider timeouts are wall-clock
ceilings, and `costCapUsd` ships as `null`, so the mechanism this rule
substitutes for the ceilings it removed is off by default.

**2. A hardcoded value is a defect** unless shown to hold across models
and harnesses. The test is not whether something is a constant — some
constants genuinely hold everywhere. The test is whether anyone has shown
this number works off the host it was fitted on.

**3. Setting a parameter from the model's limits is fine. Guessing is
not.** A documented procedure produces it; a new host runs that procedure
instead of inheriting a number from a machine it never saw.

**4. Prefer finding the sweet spot to picking a bound.** Where a value
trades off against metrics, the answer is the setting that wins —
established by measurement, not chosen because it reads as reasonable.

**5. Truncate once, where the answer's location is known — and the appender makes room, it
does not cut.** Two cuts in one path means the second one, which does not know what the first
was protecting, discards it. A caller that narrows content must narrow to the budget the
appending caller will actually enforce, and that budget is the space lower-value content can
yield (the raw tail, then already-seen results), not what happens to be left after it. Measured: an append
cap keeps the head and drops the tail, so a relevance-centred band that
arrives over budget loses the very section it was centred on
(`ds-star-multi-index-report.md` §5).

**6. Ask what the retrieval unit costs before tuning the ranking over
it.** A ranker can only reorder what the unit already decided you will
pay for, so the unit is the first thing to size. The measured ratio that
prompted this rule is large but is one store, offline, with the accuracy
half inferred rather than measured — it lives in the multi-index
dimension entry below, not here, because a comparative figure nobody has
reproduced off its own host is not a rule.

**7. A coordinate is not a payload.** A stage that hands the next one a
reference — a branch id, a span, a file path — has delivered nothing
until the bytes arrive, so verify at the payload, never at the handoff.
Measured: an oracle that made branch selection perfect by construction
delivered the answer on 0 of 5 runs of one question, because a
57,000-token branch was read through 6,600 tokens of headroom and no
query the model issued ever centred the band. The corollary for probes:
replacing a stage by fiat bounds that stage only, so write down what it
hands to the next one and check the next one received it.

**8. Attention over history is an experimental selection policy.** Remove only
history with evidence that it is nearly irrelevant to the current turn. Low
lexical overlap alone is insufficient; uncertain relevance stays in context.
An API edit can recur during later tests, so relevance must be reassessed from
the available turn evidence. Task, plan and steering preservation, recency spans,
and a compact action ledger are separately testable hypotheses. The old sw-2
stall does not establish a missing ledger as its cause: its transcript was not
retained. The opt-in `attention` evaluator now records originals, selected bytes,
source sequences and acknowledged sends. Its deterministic primitive is in
`packages/core/src/attention/`; no experimental profile is a product default.

**9. Breadth follows demonstrated task demand.** A question may need a narrow
excerpt; software work may need complete tool responses or coherent structural
sections. Compare these units rather than assuming whole-result preservation
wins. The 25-50% occupancy target is soft, not mandatory: filling unused space to
reach it and pruning early history to hold it are both testable arms, not rules, and
neither they nor the null (grow with demand) has evidence yet.

*Cumulative token consumption is quadratic in turn count, and a linear per-turn
prompt curve is the mechanism, not a refutation of it.* Because every turn
re-sends the whole prefix, `sum_{i<=n} (a + b*i) = O(n^2)`. An earlier version of
this rule cited a linear per-turn fit as evidence against the growth premise;
that conflated two different curves and was wrong. Measured re-send multipliers
in this repo -- 23x on a 49-turn task, 351x on a 645-call session -- ARE the
quadratic term. Prefix caching discounts it (roughly 8x) but does not remove it.

*Occupancy figures measured on this repo's own scenario corpus are not
representative and must not be used to bound either hypothesis.* Real
Claude Code sessions on Opus 5 (1M window) reach **37% occupancy after one user
prompt and 56% after two** (operator `/context`, 2026-09-08). The generated
scenarios peak near 45k tokens, ~10x short of that, because one real user prompt
drives on the order of 270 model turns while the generated tasks median 14.
Model sufficiency statements
can trigger reassessment of exploratory additions. They neither authorize
implementation nor prove existing evidence irrelevant. H1–H6 and deterministic
priority require mechanism gates, paired public multi-turn SWE evaluation and
combined validation before promotion. See
`metrics/attention-policy-continuation/journal.md` for the current experiment epoch.

Terms. **L0**: append-only event log. **L2**: content-addressed payload
store. **L1**: the tree (nodes pointing into L0 by sequence range, with
versioned summaries). **L3**: embedding index. A **phase** is a run of
events grouped by tool; closed phases become **leaves** hanging off a
**root**. **Zones A, B, C**: the three prompt sections. **W**: the
model's context window. **Headline**: a branch's keyword fingerprint —
file paths, identifiers, symbols extracted deterministically from raw
events. Headlines serve both display (the model sees what each branch
contains) and search ranking (TF-IDF matches queries that name those
identifiers). The same idea applies wherever content must be compressed:
tool schemas in Zone A, branch summaries in Zone B, and the active
branch index in Zone C all benefit from keyword headlines over prose.

## Pipeline (TENTATIVE — restructure proposed 2026-09-09)

> **TENTATIVE. Nothing here is shipped — this is all in development.** It reorganizes the loop
> (Tier 1) into a three-stage pipeline and folds in the 2026-09-09 offline findings. The current
> code still runs the Zone A/B/C loop below, but that loop is being *replaced*, not defended — it is
> not an authoritative baseline. Evidence tags: `[BUILT]` = code exists in `packages/`;
> `[OFFLINE]` = validated on a proxy only; `[DESIGN]` = designed, not built. **Nothing here is
> live-validated** — promote a stage only when a live run clears it.

Two scorers feed one decider; retrieval serves on demand. The classifier scores query-independent
state (has the topic shifted); the retriever scores query-dependent relevance (what matches this
turn); the assembler-ejector decides what to keep, cache-stable, to a soft target.

```
per turn:

0. ingest                                                          [BUILT]
   append→L0, store→L2, segment by tool→phase, extract fingerprints,
   summarise closed phases (a summary is ONE representation option, not a zone)

1. classify — the ENSEMBLE CLASSIFIER (query-independent state)    [OFFLINE]
   topic-shift = z(lexical fingerprint-Jaccard) + z(semantic embedding drift)
   mark units whose topic has moved away as DORMANT; err toward keeping
   (sufficiency signal — a cheap-model judgment — not built; needs labels)
   → reports/metrics/rung-0b-topic-shift/

2. assemble + eject — the CACHE ASSEMBLER / EJECTOR               [DESIGN]
   Zone A (frozen, cached): system + steering + ALL user prompts, append-only
   flex buffer: units in creation order, sticky representation (ref|summary|raw),
     newest raw; a secondary breakpoint after the stable head so it caches
   eject to a SOFT TARGET: drop DORMANT first, oldest-first, never the open topic
   nothing reorders a cached prefix; a freely re-mixed buffer is cache-death
   → reports/metrics/assembler-flex-buffer/, assembler-zone-io/

3. retrieve on demand — the ENSEMBLE RETRIEVER (query relevance)   [OFFLINE]
   fan out BM25 / grep / vector(kNN) over the TRANSCRIPT (L0), fuse by RRF
     overlapping coverage → fuse (RRF is rank-based/scale-free, wins); single-coverage query → route to the coverer
   a tool result the MODEL fetched (its own graft/LSP call) is retained WHOLE, never re-chunked (HR2-INVARIANT)
   the fetched unit appends after the buffer — the cached prefix is untouched
   → reports/metrics/rung-0e-retrievers/, rung-2-retriever-live/, excerpt-window-0a/
```

**What each stage settled (offline; pointers, not numbers — the rule below still holds):**

- **Retriever.** Ours searches the TRANSCRIPT (L0) — off-the-shelf chunker + BM25 + vector(kNN), not
  bespoke `excerptAround`. RRF (rank-based, scale-free) over a shared corpus beats best-single and
  routing on mixed traffic; a single-coverage stratum demotes the sole covering hit, so route those
  (coverage overlap sets fusion's sign — refines the disjoint-index result in Boundary conditions);
  general-web cross-encoder rerank hurt on code. **Corpus caveat: the mechanism tests ran on a CODE
  corpus (`rung-0e-retrievers/`, and live `rung-2-retriever-live/`: RRF ensemble 13/20 > best single
  9/20, yet demoted grep's literal monopoly 4/4→1/4); transfer to the transcript corpus is untested.**
- **Classifier.** The topic-shift signal is real and cheap; `z(lexical)+z(semantic)` is the robust
  merge (kNN-drift is interchangeable with the semantic term, not additive).
- **Assembler.** Zone B as a fixed band is capped and inert-to-harmful; the flex buffer *subsumes* it
  (summary becomes one representation), and its cache economics beat the current zones **only** when
  the buffer is append-mostly with a secondary breakpoint. Free re-mixing is cache-death.
  **Eviction weighting (offline-derived defaults, `assembler-weighting/`; validate live):** the eviction
  score is a *linear* mix (no FFN — interactions gave no held-out lift; LR cross-session AUC 0.84–0.90)
  of **priority (dominant, ~2×) + recency + reference-recency**, with **relevance down-weighted**.
  Relevance is an *admission* signal (the retriever's query-relevance), **not** an eviction signal: on
  the non-monotonic/dormant-return case (H1) it is the *worst* signal (drops exactly the returning
  unit), so eviction keys on priority/recency + the **classifier's dormancy**, not the retriever's
  relevance. This corrects the earlier "assembler needs the retriever's signal to evict."

**Open, and live-only:** does eviction save tokens without losing the task; the soft target on an
*overflowing* session (the cache sim peaked at ~44% occupancy, so the floor barely bound); the
sufficiency signal. Until a live run clears them, the shipped Tier 1 loop stands.

## Tier 0 — invariants

If one of these is false, the thing running is not this algorithm.

1. L0 is append-only and the sole source of truth. L1, L3, and views are
   derived and rebuildable.
2. L1 stores coordinates, not content. A node names a sequence range; the
   text lives in L2.
3. Summaries are versioned, never overwritten.
4. The prompt is Zone A → Zone B → Zone C, creation order within B.
   Retrieved results append after C. Nothing reorders a cached prefix.
   *(The TENTATIVE pipeline above reorganizes Zone B/C into one flex buffer — a summary
   becomes one representation option — but keeps the load-bearing clause intact: **nothing
   reorders a cached prefix.** That clause survives the restructure; the zone layout does not.)*
5. Ingestion is hermetic: L0, L2, and a parser. No network.

## Tier 1 — the loop

```
ingest
  append each event to L0; store payload in L2
  cap edit-tool arguments once the post-state blob exists
  segment L0 deterministically: tool name → phase; unknown → "other"
  a closed phase becomes a leaf with a sequence range
  extract fingerprints (file paths, identifiers, symbols) from raw events

decide how much to summarize
  while the prompt fits the window, show the whole trace — summarize nothing
  once it exceeds the window, latch: L0 only grows, so it will not fit again
  after latching, summarize each closed leaf (cheap model, versioned)
  a later edit marks its leaf stale; staleness travels to ancestors only
  compose the root from leaf headlines; newest kept whole, older fold to one line

assemble (every turn)
  Zone A: the contract, frozen; tool schemas as the API parameter
  Zone B: root + branch headlines + summaries, creation order, to budget
  Zone C: the active branch's raw detail, to budget
  fill remaining headroom with raw recent events from the trace tail — recomputed each turn
    from what A + B + appended results + reply leave; the boundary is latched (never regrows)
    and moves one reply share ahead of need, so the tail block is rewritten once per exhaustion

retrieve on demand
  search: rank branches by fingerprint-enriched summaries (the pool)
    grep raw events for the query's literals; a grep hit REORDERS a branch the
      lexical pass already found — it cannot introduce one (see note)
    when regex finds nothing distinctive, a cheap LLM rewrites the query (optional fallback)
    return the k best-matching EVENTS across the ranked branches, each attributed to the most
      specific branch holding it, with its seq and an excerpt of its own text — a hit is a
      payload; fetch only when the excerpt is not enough
  fetch: raw events narrowed ONCE, by the caller that knows where the answer sits
    centers on the query's matching events; band grown outward under a real
    token count until the next event would not fit the live headroom
  peek: a raw excerpt
  annotate: record a note

append a result
  results land in the transcript tail, never in the cached prefix
  the appender makes room, it does not cut: when A + B + C + tail + reply exceed W,
    the raw tail yields first, then the OLDEST already-seen results (D6 — consumed),
    then Zone C events oldest-first; a result appended since the last send never leaves
  only a result larger than the whole remaining window is cut, and the cut KEEPS THE HEAD
    [cap is harness-only; eviction ships in `ZoneAssembler.assemble`, see note]
```

**Two notes a porting host needs before implementing the block above.**

*What is shipped and what is not.* Everything under `ingest`, `decide`, `assemble` and
`retrieve` is in `packages/`. The `append a result` stanza is **not**: `appendHeadroom` and
`capToolResult` live only in `eval/scripts/transplant.mjs`, so a host gets no library support
for them and must implement the cap itself. It is written here because rule 5 depends on it
and because a host that omits it will silently re-cut its own narrowed payloads. Multi-index
routing is **not shipped either** — facet indexes exist only as offline gates, and the
`tree-route` arm is specified and unbuilt; it lives under Candidates, not here.

*The event-hit search shipped 2026-09-04 (afternoon).* `TreeRetriever.searchEvents` and
`excerptAround` are in `packages/core/src/retrieve/`; `packages/mcp`'s `context_search` returns
event hits (`seq`, `excerpt`, `branch_rank`, pointer meta). The branch-coordinate handler survives
only in the harness (`branchSearch` in `eval/scripts/transplant.mjs`) so historical arms replay the
surface they were measured on. Evidence: at W=131,072 on GLM 5.3 Flash, n=5, one store, 15/25
against 6/25 for the same stack with coordinate hits, in one batch, every success answered with
zero fetches, −54% uncached input over completed runs (−59% over all rows)
(`window-regime-and-retrieval-unit-report.md` §7). One store, one model, one window: see that report's §9.

*Window enforcement is in the library; the append cap is not.* `ZoneAssembler.assemble` proposes eviction of
oldest acknowledged ephemeral tail entries, then Zone C events, when `A+B+C+tail+reply > window`, and
reports both (`evictedFromTail`, `droppedFromZoneC`). The host commits delivery with
`acknowledgeDelivery(prompt.deliveryReceipt)` after a successful send; assembly itself
does not mark selected payloads seen or mutate the tail. Window enforcement acts when the host supplies a
window (`HarnessOptions.window` in the live loop). The elastic raw tail, the evict-ahead quantum
and the append cap live in `eval/scripts/transplant.mjs` (`tree-snippet-hits-elastic`, `wire()`).
Replayed offline over 118 recorded runs at W=131,072 (`elastic-tail-killgate.mjs`): overflows 0;
truncated appends 9/435 against 198 recorded, the 9 being results larger than the whole remaining
window; 76/186 previously cut literals arrive whole; the tail moved on 63 turns at ~52k fresh
tokens each. Live measurement pending (journal 00:45).

*The grep merge is not RRF.* `mergeWithGrep` adds `count / maxGrepScore / (RRF_K + 1)` to
nodes the lexical pass already returned and skips any node it did not
(`retriever.ts:653-670`). So the grep pass is a re-ranker over the lexical candidate set, not
a fusion of two retrievers, and its constant carries none of RRF's justification. Naming it
RRF overstated what it does; the behaviour is unchanged and the name in Tier 2 is now
qualified.

## Tier 2 — parameters

Every value that affects behaviour in the SHIPPED library, classified by rule 2, plus the
harness values Tier 1 depends on (marked *harness*). It is not yet complete — the summarizer
and provider timeouts below were absent until 2026-09-03 and more may be — so treat a value
found in code and missing here as a defect in this table, not a licence.

| Value | State | Derives from |
|---|---|---|
| switch point | **unvalidated** live (absolute 30k); target: Zone C fraction of W | W × zone fraction |
| zone fractions (A .10, B .20, C .20, reply .05, slack .10, lazy .35) | **unvalidated** as values; **derived** from W in one place. The sweep that would rank them measures its own lower bound, so rule 4 is owed here and unpaid | measurement — rule 4, unpaid |
| heuristic-to-tokenizer ratio | **derived** (0.851 on this corpus) | measured per corpus, refuses above 1.6 |
| root keep (fold level) | **derived** in portability harness; **unvalidated** constant in live | largest rung whose Zone B fits |
| search result limit | **unvalidated**, and there are TWO defaults: config `limit: 20`, retriever `DEFAULT_LIMIT = 8`. Measured 2026-09-04: the all-rank COMPACT list (coordinates only) is **retired as a display** — it freed ~5k tokens per search and cost the one question the model could otherwise select (qo03 5/5 → 0/5 at W=131,072) | W and per-hit payload size |
| event hits per search (`retrieval.eventHits`) | **host** (5, config default) — taken from the published claude.ai interface (default 5, max 10), per rule 3; unvalidated here (never swept) | the published interface; should derive from headroom ÷ excerpt cost |
| excerpt size (`retrieval.excerptChars`) | **host** (1,000 chars, config default) — the observed ~200-360-word chunk of the published interface; unvalidated here. Known miss: a literal outside the window (qo02); a dotted identifier is not a usable fallback term (`Math.round` → `Mathround`) | the published interface; should derive from the event's matched span |
| grep re-rank constant | **unvalidated** (60). Named `RRF_K`, but the pass is a re-ranker over the lexical candidate set, not a fusion, so the RRF literature does not justify it | never swept on any store |
| query fingerprint minimum length | **unvalidated**, and it is three literals not one: `add()` enforces 3, `QUOTED_Q` hardcodes `{3,}`, `UPPER_SNAKE_Q` is effectively 4 | below it a token matches everything |
| fetch narrowing budget | **derived** on the primary path (live headroom at the moment of append, per call). TWO `?? 20000` fallbacks survive and are still defects — the halved one that computes the budget, and the one that feeds it | the request as it stands that turn — rule 5 |
| narrowing band size | **derived** (grown outward from the relevance centre under a real token count), but converts heuristic→BPE by the measured ratio and so over-budgets ~17% on code-dense content — fix identified, unshipped | measurement, not an average |
| peek / snippet sizes | **unvalidated** (6 literals: peek 800, two snippets at 240, hydrate-peek 2,000, and two summarizer INPUT byte caps at 4,096 / 1,024 that answer a different question and should not share a value) | sized to available room |
| summarizer reply cap | **unvalidated** (`maxSummaryTokens` 1,024) — a cap on reply length, which rule 1 forbids | the model — rule 3 |
| summarizer concurrency | **host** (8) — never measured | rate limit |
| search / provider timeout | **unvalidated** (20,000 ms, twice) — a wall-clock ceiling, which the last row of this table calls "removed" | the provider |
| search-result headroom share | **unvalidated** (0.25, *harness*) — restored: the constant still runs in `tree-escalate` even though that arm is retired | share of live headroom a result list may take |
| keyword minimum token length | **unvalidated** (3, *harness*) — restored on the same grounds | below it a token matches everything |
| edit-argument cap | **derived on one store** (512 bytes when post-state exists); cross-host unvalidated | both alternatives measured |
| reply allowance | **derived** (`window − prompt`, per turn) | arithmetic, untested live |
| window below the host's own system prompt | **boundary** — a 60,903-token production system prompt (Fable 5.1, measured) makes W ≤ 65,536 a cell no real host occupies; the eval's small windows were starving the model, not measuring the algorithm | the host's prompt size, measured, subtracted from W |
| tail eviction quantum (evict-ahead) | **derived** (one reply share of W, *harness*) — the boundary moves one reply reserve further than needed so the tail block is rewritten once per exhaustion, not per turn | `maxReplyTokens`, itself derived from W |
| reply headroom | **derived** when the host reports a max or one is measured; the fallback is `ZONE_FRACTIONS.reply` = 0.05, which the code's own comment calls "a guess in exactly the way rule 2 forbids" — so **unvalidated** whenever the fallback fires | the model — rule 3 |
| tool-to-phase map | **host**. The library default `DEFAULT_TOOL_PHASE` has **20** entries; the 8 is this repository's own override. Unknown → "other" | the harness |
| contract version | **host** (v1 default, v2/v3 registered) | the model |
| turn / wall-clock ceiling | **removed** from the loop; two 20,000 ms provider timeouts remain (row above) | — |

The window (W) is host-supplied and user-configurable. A host that wants lower
cost and latency sets a smaller W; the tree compensates through search and
fetch. A host that wants maximum coverage uses the model's full window. The
optimal W for a given session — the smallest window that achieves parity with
full-context performance — is the measurement the live verification step exists
to produce.

Open defects: every row marked **unvalidated** — nine of them, six with a
"Derives from" that describes what the value *should* come from rather than what
produces it today. Three (switch point, zone fractions, root keep) have carried
that label since 2026-09-02 and have a derivation in the portability harness but
not in the live suite.

**The count has only ever gone up.** Four passes have added defect labels to this
table and retired none, which makes it a backlog rather than an audit. Rule 4 —
prefer the sweet spot to a bound — currently has **zero instances** anywhere on
this page: no value here was set by finding one. Retiring one row per pass, by
measurement, would be worth more than another boundary condition.

## Boundary conditions

| Condition | State |
|---|---|
| Window < Zone A + one summary (8k) | Dead cell; reported, not forced |
| Window < iterative tool use (16k) | Dead cell; search payload exceeds headroom |
| A leaf larger than W | Two causes: segmentation, and render duplication. Duplication is capped; SIZE is not — see "A branch larger than W". |
| Unknown tool name | Maps to "other" — tested |
| Tokenizer heuristic drifts | Measured; refuses above 1.6 |
| Trace with 0 or 1 branches | Fold and assembly no-op — tested |
| Summaries don't contain the answer | Confirmed (0/12 answer literals in any summary); raw fetch is for this |
| No embedder | Beam search fallback — tested |
| Search ranks wrong branch | Fingerprints + grep raised offline top-3 sharply, but the rate is set-dependent (10/12, 3/5, 5/5 on the three sets) and the live score did not move. Not "fixed". Ranking was never the deep set's constraint: with the same ranks, selection went 5/5 → 0/5 on a display change alone (see "label vs payload"). |
| Tail covers the answerable content (W ≥ answer depth) | **Found 2026-09-03.** The tree adds no value when the raw tail already contains the answer — tool-use overhead (15-20K tokens per question) is a net loss. The tree earns its keep only in the overflow regime: sessions where the trace exceeds the window and answers lie outside the tail. Measured 2026-09-04 on this store: the deep set is overflow up to an effective W ≈ 150k (5/5 at 131,072; 1/5 at 200,000; 0/5 at 270,000). |
| Headroom at the first tool turn | ~8-9k tokens at W=65,536 versus ~18k at W=131,072 (A2) — and neither was a reservation: the tail was sized to fill `W − prompt − reply`, so the headroom was the heuristic-vs-exact tokenizer gap (ratio 0.851). With the elastic tail what binds is the tail's remaining length, not the list's cost: 198 → 9 truncated appends in replay. |
| A search hit as a label vs as a payload | **Measured both ways 2026-09-04 at W=131,072.** Full-surface hits select the rank-7 branch first 5/5 and spend ~6.5k tokens per search; compact coordinates spend ~1.3k and select a distractor 5/5; event excerpts (~1.7k, content included) answered 15/25 with zero fetches. The unit the model is shown decides selection AND delivery. |
| Overflow regime, ranking made perfect | Recovers most of the loss on one question set and under half on another. Set-dependent; no single figure ports. |
| A branch larger than W | Fetch returns a band, not the branch. Whether the band holds the answer depends on the query, not the rank — a branch can be ranked first, fetched, and still deliver nothing. Gate: `delivery-killgate.mjs`. |
| Perfect selection, large headroom | Fewer hits leave more headroom, so the fetch requests a wider band, overruns, and the append cap re-cuts it. Truncation was anti-correlated with hit-list size under the static tail; under the elastic tail a band is cut only when it exceeds the whole remaining window (9/435 in replay). |
| A search hit rendered without its ranking evidence | Hits render on title plus `meta.files`/`meta.symbols`, routinely empty for a phase node, so the fingerprints the hit was ranked on never reach the model. Attaching the matched fingerprints does **not** repair selection and costs input tokens. Open. |
| Fingerprint set used as a keyword list | Not one — entries may be whole slabs of source. Rank by the query's share of a fingerprint's own tokens. Bites overlap-ranked consumers only; Zone B headlines checked clean. |
| Facet index with high-cardinality key | Cheap-unit economics fail. 66 file / 311 command entries cost 2.7K / 7.5K tokens; 3,969 line entries cost 77K — as much as the content, so "return more candidates" is unavailable and ranking binds again. |
| Fusing indexes with disjoint coverage | **Harmful.** RRF across four indexes scores 6/17 where routing to the best single index scores 9/17; answers already found are demoted (rank 3→12, 7→25). Fuse rankers over one index, route across indexes. **Refined 2026-09-09 (offline, `rung-0e-retrievers/`): coverage OVERLAP sets fusion's sign.** Multiple retrievers over ONE shared corpus with overlapping coverage → RRF *wins* (beats best-single and routing on mixed traffic); a single-coverage query (only one retriever can answer) → RRF *demotes* the sole hit and loses to routing. So "fusion refuted" is scoped to disjoint coverage only; on a shared corpus RRF is the default combinator. Confidence-gated fusion (margin gate) was refuted here. **Mechanism, stated precisely (do not mis-describe it as a scaling problem): RRF is _reciprocal-rank_ fusion — it sums `1/(k+rank)` over ranks alone, so it is scale-free and never normalizes disjoint scores onto a common axis.** The disjoint-coverage loss is a _coverage/voting_ effect: a document ranked mediocre by several non-covering retrievers can outvote the one retriever's genuine top hit. **Live confirmation 2026-09-09 (`rung-2-retriever-live/`, real model, one shared code corpus): the RRF ensemble beat every single retriever overall (13/20 vs 9/20 best single) yet _demoted_ grep's literal monopoly (grep 4/4 → ensemble 1/4) — the sole-coverer outvoted, reproduced at stratum granularity.** |
| Fact needing two literals from two places | No single-entry index can serve it. Three of 17 questions; needs a join or an explicit second hop. Open. |
| Zone B on a literal-recall task | **Inert, measured 2026-09-05.** `flat-events` (Zone A + elastic raw tail, events scored over the whole trace, no summaries, no branch ranking) 15/25 against 16/25 for the same stack with Zone B, one batch, n=5. Zone B's remaining candidate roles — a ledger of completed steps on multi-step tasks, and cache shape on long sessions — are unmeasured. |
| Operating point of the window | The tail-filling arms run at 80-95% of W by construction; the design that scored 25/25 (`prefix-plus-retrieval`: cached prefix + recency slice + retrieval fill) runs at 15-30% and grows only when a turn needs it, and was the only arm with zero provider empty-turn failures. The 25–50% soft target is **not withdrawn and not rejected** — it is an open hypothesis alongside ejection-saves-tokens; neither has been measured. **Its mechanism demonstrably fires in real use** (37%/56% of a 1M window after one/two operator prompts); the reason no run in this repo's corpus reaches it is that the corpus is ~10x too short, which is an instrument defect, not evidence. |
| A design with no memory of completed steps | **Measured 2026-09-05 (Sonnet 5, n=3):** `prefix-retrieval` 0/3 on sw-2 (four modules, fix in order) against 3/3 for `context-tree` and `native`; every stalled run ended in 4-6 consecutive `run_command` turns with 90-100k tokens of headroom — the investigate-1 loop. On single-step sw-1 it was 3/3, a peer. Window size does not fix it; a compact ledger of completed steps inside the target does (candidate role for Zone B). |

## Measurement hazards

Properties of the evaluation, not of the algorithm. A host porting this can skip
them; a DS-STAR pass cannot. Full analysis lives in the reports.

| Hazard | State |
|---|---|
| An overflow question set at a wider W than it was cut for | Invalid above W₁. The truncation boundary is non-increasing in W, so answers fall into the tail. Re-cut per claim window. Exact boundaries for this store: seq 523 / 268 / 108 / 1 at W = 65,536 / 131,072 / 200,000 / 270,000. |
| Distractor decay | **Found 2026-09-04.** A question whose REFERENT is not unique (qo05: "the bash command that ran pnpm build then vitest") acquires a competing answer inside the tail as W widens (seq 329 enters the tail at 131,072); the model answers it in 1 turn without searching, 14/15 tree runs across three arms. The literal-uniqueness gate checks the answer string, not the referent. Gate the referent per claim window. |
| A provenance audit that knows only some payload channels | A new arm that delivers the literal through a channel the audit does not read (search excerpts) is scored `unverifiable` en bloc — 15/15 here — and looks like fabrication. Extend the audit before reading the number; use recorded per-call fields, never reconstruction. |
| A provider that ends a turn with reasoning and no message | 11/50, 4/25, 4/25 rows across three batches on GLM 5.3 Flash at 105-125k-token prompts: `finish_reason=stop`, reasoning tokens spent, empty content, no tool call. Kept in the denominator; report completed-conditional alongside. Unfixed (a retry would shift the epoch). |
| Exact-match grading against a fluent model | Gameable — fabricated citations, answer strings inside refusals. Audit provenance before quoting a score. |
| A ranker measured on the question text | Not the query the model sends. Measure the rank under the model's own query. |
| A stratum's claimed invariant, read from its comment | Not an invariant. Re-test the property at every parameter value it is used at. |
| An offline gate whose axis misses the live range | Passes and predicts nothing. Measure gates over the budgets the live path produces. |
| Instrumentation that records a request, not an outcome | Reads as a behavioural finding. Record what was SERVED, not what was asked for. |

## DS-STAR dimensions

Four dimensions the loop iterates on. Each has a report with full analysis;
only the current conclusion is stated here.

**Branch count.** The fold level and the number of rendered bodies move in
opposite directions. Width helps on head-stratum questions only, and the
width cost cannot be attributed at current sample sizes. The fit-derived
ceiling barely binds. Open: whether to flip the ladder default, gated on a
second scenario. *(Report: `reports/metrics/tuning-branch-count.md`)*

**Branch depth.** A 77-fold size spread on the measured store. The oversized
branch was inflated by content rendered twice (a write's payload appearing in
both tool arguments and post-state). Cap now applied in both renderers from
one constant. Granularity explains almost none of the measured retrieval
failures. *(Report: `reports/metrics/tuning-branch-depth.md`)*

**Summary timing.** Switch point = Zone C fraction of W. The gate lags by one
turn (median 8,306 token overshoot); checking the prompt-to-be-sent drops
overshoot to zero. Summary cost: 0% on non-crossing runs, median 9.4% on
crossing runs. The fraction sweep cannot rank fractions — it measures its own
lower bound. *(Report: `reports/metrics/tuning-summary-policy.md`)*

**Caching.** A cache write costs 12.5× a read. A stable prefix read every turn
beats rewriting unless rewrites happen less than once in twelve turns. The
third breakpoint (Zone C marker) measures −39.8% offline after correcting the
simulator, which had been contradicting the live measurement. Candidate for
default flip, gated on second scenario. *(Report: `reports/metrics/tuning-caching.md`)*

**Search ranking.** Summaries don't contain the identifiers queries reference.
Fingerprints (extracted from raw events) + hybrid grep fix this: 2/12 → 10/12
top-3. Offline only — the live score did not move, because the unit being ranked
was the binding constraint, not the rank.
*(Report: `reports/metrics/ds-star-search-ranking-report.md`)*

**Index granularity and routing.** The figure rule 6 used to carry lives here: the unit
dominates the ranking by tens to one in offline token cost (38:1-78:1) — one store,
offline, accuracy half inferred, never reproduced on another host. A
branch replay is 26KB with the answer on one line; a command-facet entry is 40
tokens, and a top-10 slice costs 272-440 tokens against 8-16K for a narrowed
replay. Several indexes raise coverage (5-6/17 → 9/17) but only under routing;
fusion drops it to 6/17. Ranking within a cheap index is near-optimal already
(C1' places 5 of the 6 retrievable questions in the top 10). The ceiling is
coverage: 6/17 answers exist in no index, which retires every ranker-side
candidate — embeddings, KNN, autoencoder latents, learned ranking — at the same
6/17. *(Report: `reports/metrics/ds-star-multi-index-report.md`)*

## Candidates with a verdict

Three states are listed together below and the labels distinguish them: **landed in code**
(shipped, running now), unmarked (measured, not yet default), and **Retired** (refuted, kept
so the negative result is not rebuilt).

- **Fingerprint-enriched search + hybrid grep**: 2/12 → 10/12 top-3 for the shipped
  deterministic ranker (11/12 required a MOCKED query rewriter, never a live one).
  Landed in code; live-verified 2026-09-03 and the live score did not move.
- **Raw by default**: fetch returns raw events, not summaries. None of 12
  answer literals is in any summary.
- **Search hits as coordinates**: payload 9,673 → 4,898 tokens. **Retired as a display
  2026-09-04**: at W=131,072 the all-rank compact list scored 5/25 against 8/25 for full-surface
  hits with the same centring, losing qo03 5/5 → 0/5 by selecting a distractor first 5/5.
- **Bare-filename centring** (`retrievalCenterFingerprintMode: 'bare-filename'`): confirmed live
  2026-09-04 at W=131,072 — qo04 0/5 → 3-5/5 across three arms, band centred at seq 218 in 12/12
  scoring fetches; the prior pass could not credit it because its bands were capped away at 65k.
- **Elastic tail / per-turn window management** (`tree-snippet-hits-elastic`; eviction shipped in
  `ZoneAssembler`): 16/25 vs 16/25 same batch, **0 truncated appends** (2 for the static tail; 198/435
  recorded before), −44.51% arm-total uncached input (−29.91% per completed run), tail moved once. Landed: core eviction;
  harness arm. Non-inferior on score, strictly better on effort.
- **flat-events** (no Zone B): 15/25 vs 16/25 — the null hypothesis for Zone B on this task class holds.
- **prefix-plus-retrieval** (cached prefix + recency slice + retrieval-filled window): **25/25**, median 1
  turn, 20/25 with no tool call, 0 provider failures, lowest cache-weighted input. The Q&A leader.
  Task completion (Sonnet 5, n=3): sw-1 3/3 but not cheaper (fresh retrieval every turn); **sw-2 0/3**,
  stalled in run-command loops — no ledger of completed steps. Not a task arm as built.
- **Attention over history** (design, unmeasured — report §15): per turn, per unit, relevance
  (query-dependent, the fingerprint match `context_search` already scores) + priority
  (query-independent state derived from L0: fetch/edit boosts, decay, `superseded_by` → 0, topic-shift
  reset), categories {pinned, active, dormant, unrelated} as the prior, admission by relevance MASS
  (nucleus p) inside an explicit demand budget, an appended per-turn attention log for audit. First step is an
  offline replay: does relevance + priority predict the recorded fetches better than relevance alone?
- **Event-snippet hits** (`tree-snippet-hits`, the published-alternative port): **15/25 vs 6/25**
  in one batch (n=5, GLM 5.3 Flash, W=131,072, deep set), 15/15 successes with zero fetches,
  median 2 turns, −54% uncached input over completed runs. Measured, not default; library port pending. Two host
  constants (5 hits, 1,000 chars) from the published interface, unvalidated here.
- **Contract v3**: one rule replaced, one removed.
- **One budget derivation**: delete the live suite's absolute switch point.
- **Delete Zone C fallback chain**: first branch never fires.
- **Third cache breakpoint as default**: −39.8% offline, gated on second scenario.
- **Route, don't fuse, across indexes**: 9/17 vs 6/17 top-10. Measured offline;
  the `tree-route` arm is specified but unbuilt. Its ranking argument is retired for
  the deep set (offline ranking there is 5/5 top-3); only its payload argument survives.
- **One-cut narrowing**: band grown under a real token count to the live
  headroom. Offline 20/20 fits (was 19/20), 19/20 carries the answer (was 17/20),
  bands 2-5x wider. Landed in code; live score unchanged — a different bucket binds.
- **Retired**: hit keywords (`tree-hit-keywords`: selection unchanged against its own
  same-batch baseline, +32% input tokens; mechanism verified to have fired on every run),
  Zone C pre-fill, completion nudge, contract section trim,
  escalating search (4/25 vs 2/25, ~1 SE), embeddings/KNN/autoencoder over lines
  (retired unspent — 11/17 absent caps every ranker at 6/17), learned ranking
  (17 labels; breaks the rebuild invariant).

## Simplification ledger

| When | Change |
|---|---|
| Loops 5–7 | Branch-count threshold → size threshold; root model call → deterministic composition; Zone A schema text deleted; ephemeral tail deleted |
| Loop 9 | Transplant harness derives budgets from W |
| 2026-09-02 | Character estimate → model's reported count; latch added; frequency cache rule → formula; monotone curve closes the allocation question; edit-argument cap shared from one constant; zone budgets derived from window in one place; reply allowance per turn; turn/wall-clock ceilings removed |
| 2026-09-03 | Fingerprint extraction + hybrid grep in search; algorithm pseudocode updated |
| 2026-09-03 pm | Two cuts in the fetch path collapsed to one; a chars-vs-tokens magic number (×0.85) replaced by an injected tokenizer; the halved build-time narrowing budget replaced by the live per-call headroom |
| 2026-09-04 | Compact coordinate display retired; the search UNIT changed from branch to event in the measured arm, which removes the second stage for most questions (fetches 1.42 → 0.05 per run) — one stanza does the work two did |
| 2026-09-04 pm | Event-hit search shipped in `packages/`; harness-local copy deleted; the two sizes moved from constants to `retrieval.eventHits` / `retrieval.excerptChars` (config, still host values); §19 Q2 decided in `docs/IMPLEMENTATION_PLAN.md` |
| 2026-09-05 | The append cap stops being the mechanism: the window is enforced by eviction (tail, then seen results, then Zone C events) in one place per turn; the tail-fill line in `assemble` becomes per-turn and latched instead of build-once |

## Change log

- **2026-09-09 20:20** — TENTATIVE pipeline section added (operator request): the loop restructured as
  three stages — ensemble classifier (query-independent state) + ensemble retriever (query relevance)
  → cache assembler/ejector — with per-stage evidence tags (`[BUILT]`/`[OFFLINE]`/`[DESIGN]`).
  Folds in the 2026-09-09 offline findings: retrieval unit is off-the-shelf (retire `excerptAround`);
  RRF over a shared corpus wins, coverage overlap sets fusion's sign (refines the disjoint-index
  result); topic-shift classifier `z(lexical)+z(semantic)`; flex-buffer assembler subsumes Zone B and
  its cache economics beat the current zones; the HR2-invariant (a fetched tool result is retained
  whole, never re-retrieved). **Nothing here is live-validated**; the shipped Tier 1 loop stands until
  a live run promotes a stage. Invariant 4 annotated (flex buffer reorganizes Zone B/C; the
  "nothing reorders a cached prefix" clause survives). Reports: `reports/metrics/{excerpt-window-0a,
  rung-0e-retrievers,rung-0b-topic-shift,assembler-zone-io,assembler-flex-buffer}/`.

- **2026-09-05 08:20** — Rules 8 and 9 added as user-set guiding principles for the next loop:
  attend only to what bears on the turn (context-level DSA; history categorised and prioritised
  per turn; task, plan and steering always present); breadth follows the horizon inside a soft
  target, driven by the model's own sufficiency and topic-shift signals and by the last n turns.
  Report §14 turns them into pre-registrable hypotheses; §15 proposes the encoding (two-channel
  attention over history units, priority derived from L0, admission by relevance mass).

- **2026-09-05 00:50** — Live results for the per-turn window plan (report §7b-§7c, §12-§13). Q&A at
  W=131,072, n=5: elastic 16/25 with 0 truncations and −44% uncached input; flat-events 15/25 (Zone B
  inert); prefix-plus-retrieval 25/25 in one turn. Boundary table +3 rows (Zone B inert; operating
  point of the window; no memory of completed steps). Candidates +3. Next design recorded from the
  user: a soft target window of 25-50% of W_max with overruns allowed per turn and eviction back to
  target once results are seen; f to be measured, not set. Task completion (Sonnet 5, n=3): the tree
  and native 3/3 on both tasks; prefix-retrieval 3/3 on sw-1, **0/3 on sw-2** (stalls) — the tree's
  task advantage stands and Zone B's candidate role is a ledger of completed steps.

- **2026-09-05 00:50** — Per-turn window management (plan `squishy-inventing-cloud`). Library:
  `ZoneAssembler` enforces a supplied window by eviction (seen ephemeral tail entries, then Zone C
  events), reported, cache-neutral (simulator: A and B survive, cacheWrite 0). Harness: elastic raw
  tail, latched, evict-ahead by one reply share; seen appended results evicted as the last valve;
  null arms `flat-events` and `prefix-plus-retrieval`. Rule 5 extended ("the appender makes room, it
  does not cut"); Tier 1 `assemble`/`append` stanzas rewritten; Tier 2 +1 derived row; two boundary
  rows corrected (the small-window "headroom" was the tokenizer gap, not a reservation). Replay
  gate numbers above; live results pending.

- **2026-09-04 14:40** — Library port. `context_search` now returns event hits (Tier 1 `search`
  stanza rewritten to what ships; the "MEASURED" line is gone). Events are attributed to the most
  specific branch that holds them — a defect the port surfaced: the harness arm let the first-ranked
  branch claim a shared event, which on a fixture with a task root swallowed the phase that did the
  work. Second defect: pointer `meta` on an event hit re-inflated the payload (three recorded
  queries reached 4,666-6,136 tokens; the gate's NS2 caught it) — removed, the excerpt is the
  legibility signal; gate back to 48/56 literal-in-excerpt, 53/56 event visible, median 1,750
  tokens. Contract v1-v3 `context_search` bullet rewritten; §19 Q2 decided. Core +5 tests, mcp +2,
  two mcp tests restated for the event unit; harness tests −3 (moved to core). Suite 977/9.

- **2026-09-04 11:20** — Fable-interface pass (3 iterations, `window-regime-and-retrieval-unit-report.md`).
  **No change under `packages/`;** the measured arm is harness-only. Regime: the production Fable 5.1
  system prompt is 60,903 tokens, so W ≤ 65,536 was a starvation cell; the valid cell on this store
  is W=131,072, where truncate-tail stays 0/25 and the shipped stack goes 1/25 → 5/25. Ablation:
  bare-filename centring confirmed (qo04), compact coordinate display retired (qo03). Published
  alternative ported as event-snippet hits: 15/25 vs 6/25 same batch, zero fetches, −54% uncached input (completed runs).
  Tier 1 gains a MEASURED variant line; Tier 2 gains three rows (two host constants from the
  published interface, one boundary); boundary table +2 rows, hazards +4 rows (distractor decay,
  audit channel blindness, provider empty turns, exact boundaries). Provenance audit extended with
  `earned-search`. Prior report corrected in five places.

- **2026-09-03 21:10** — Delivery pass (3 iterations). **No algorithm change: `git diff`
  over `packages/` for this entire pass is empty.** The candidate was refuted and nothing
  was defaulted, so every edit below is a learned fact, a correction, or behaviour that
  already ran and had never been written down.
  - **Rule added.** 7, a coordinate is not a payload — earned by an oracle that made
    branch selection perfect and delivered the answer 0 of 5 times on one question.
  - **Rule corrected.** 6 keeps its imperative and loses its n=1 ratio to the dimension
    entry. 5 said "cut front-first", which parses backwards — the cap keeps the head.
    1 now states what it means and admits it is not yet kept.
  - **Previously-undocumented behaviour written down.** The append/re-cut stanza (and
    marked harness-only, because it is not in `packages/`); the grep pass re-ranks the
    lexical candidate set rather than fusing with it, so it is not RRF; multi-index
    routing marked unbuilt rather than described as the loop.
  - **Tier 2 corrections.** Six previously-unlisted constants added, two restored that a
    mid-pass edit had wrongly deleted while their code still ran, `DEFAULT_TOOL_PHASE`
    corrected from 8 to 20, peek literals from 5 to 6, `edit-argument cap` downgraded
    from validated to one-store.
  - Measurement hazards split out of the boundary table.
  `reports/metrics/ds-star-delivery-pass-report.md`.
- **2026-09-03 20:00** — Multi-index pass (4 iterations). Rules 5 and 6 added.
  Oracle probe: perfect ranking recovers 19 of 21 lost points on the set with all
  three arms (2/25 → 21/25 vs 23/25 ground truth), so ranking-to-selection
  dominates there; on a deeper set it reaches 13/25 vs 25/25 with no real-search
  arm run, so that split is unknown. The indexed unit beats the ranking by tens to
  one (offline token cost). Routing across indexes beats fusing them, 9/17 vs
  6/17. Grading found gameable by fabrication — provenance check owed before any
  further tuning. `prep-overflow` phase and two new question sets; the prior `head`
  stratum did not test the overflow regime, and the code comment asserting that it
  did has been corrected. Adversarially reviewed: 9 numeric corrections, 4 missing
  lessons added, 2 unreproducible measurements regenerated from a committed script.
  Suite is 964/975 with 2 pre-existing failures in `eval-resumption`.
  `reports/metrics/ds-star-multi-index-report.md`.
- **2026-09-03 15:10** — Live verification: tree loses to truncate-tail at W=32K-65K.
  Tool overhead > navigation benefit when the tail covers the answers. Overflow
  regime untested. Semantic narrowing, forced depth:full, stronger contract
  validated as infrastructure. `reports/metrics/ds-star-live-verification-report.md`.
- **2026-09-03 11:30** — Search ranking: fingerprints + hybrid grep (**10/12** top-3
  shipped; the 11/12 in that report used a MOCKED rewriter, not a live model — corrected
  2026-09-03 pm). `reports/metrics/ds-star-search-ranking-report.md`.
- **2026-09-02 13:20** — DS-STAR tuning pass closed (3 iterations, 17 rejected
  candidates). `reports/metrics/tuning-pass-report.md`.
- **2026-09-02 12:25** — Per-turn reply allowance implemented (untested live).
- **2026-09-02 12:20** — Library now takes window; `deriveZoneBudgets`,
  `zoneBRemainder`, `replyHeadroom` added. Zone partition no longer invents a
  constraint — it fits against the actual window.
- **2026-09-02 12:05** — Four dimension reports published. Width is a
  reallocation, not an addition. Six of seven ladder rungs satisfy the fit
  predicate.
- **2026-09-02 11:25** — Rewritten around the four rules. Parameter table
  classifies every value. Two rows validated; seven unvalidated defects.
- **2026-09-02 10:55** — Turn and wall-clock ceilings removed. Stall detection
  and cost cap replace them. 16 fabricated failures removed from the record.
- **2026-09-02 09:15** — Page created.
