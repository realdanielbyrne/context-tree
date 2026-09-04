# The context-tree algorithm

The reference a DS-STAR pass scores against and a new host ports from.
A change to the algorithm and a change to this page happen together.

The goal: simple, repeatable, translatable to a model and harness it has
never seen. Six rules follow from that.

**1. No budgets or caps** on turns, wall-clock, or reply length. Each is
a guess about work nobody has measured. Bound the actual resource: spend
is bounded by a cost cap; non-progress (stall detection) ends a stuck run.

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

**5. Truncate once, where the answer's location is known.** Two cuts in
one path means the second one, which does not know what the first was
protecting, discards it. A caller that narrows content must narrow to the
budget the appending caller will actually enforce. Measured: a
relevance-centred band re-cut front-first by an append cap loses the
section it was centred on (`ds-star-multi-index-report.md` §5).

**6. The indexed unit is worth more than the ranking over it.** Shrinking
a retrieval unit from a branch replay to a line saved 7,600–15,600 tokens
per question on the measured store; perfecting the rank inside a cheap
index was worth ~200. Before tuning relevance, ask what the unit costs.
This is a token-cost ratio measured offline — no facet index has yet been
put in front of an answering model, so the accuracy gain is inferred.

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

## Tier 0 — invariants

If one of these is false, the thing running is not this algorithm.

1. L0 is append-only and the sole source of truth. L1, L3, and views are
   derived and rebuildable.
2. L1 stores coordinates, not content. A node names a sequence range; the
   text lives in L2.
3. Summaries are versioned, never overwritten.
4. The prompt is Zone A → Zone B → Zone C, creation order within B.
   Retrieved results append after C. Nothing reorders a cached prefix.
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

assemble
  Zone A: the contract, frozen; tool schemas as the API parameter
  Zone B: root + branch headlines + summaries, creation order, to budget
  Zone C: the active branch's raw detail, to budget
  fill remaining headroom with raw recent events from the trace tail

retrieve on demand
  search: route to ONE index, then rank within it, return coordinates
    indexes are axes over the same L0, keyed on fields events already carry:
      branch (phase), file, command (tool + head), symbol, output line
    rank fingerprint-enriched documents; grep raw events and merge via RRF
    when regex finds nothing distinctive, a cheap LLM rewrites the query (optional fallback)
  fetch: raw events narrowed ONCE, by the caller that knows where the answer sits
    centers on the query's matching events; band grown outward under a real
    token count until the next event would not fit the live headroom
  peek: a raw excerpt
  annotate: record a note
```

## Tier 2 — parameters

Every value that affects behaviour, classified by rule 2.

| Value | State | Derives from |
|---|---|---|
| switch point | **unvalidated** live (absolute 30k); target: Zone C fraction of W | W × zone fraction |
| zone fractions (A .10, B .20, C .20, slack .10) | **unvalidated** as values; **derived** from W in one place | measurement — rule 4 |
| heuristic-to-tokenizer ratio | **derived** (0.851 on this corpus) | measured per corpus, refuses above 1.6 |
| root keep (fold level) | **derived** in portability harness; **unvalidated** constant in live | largest rung whose Zone B fits |
| search result limit | **unvalidated** (20) | W and per-hit payload size |
| fetch narrowing budget | **derived** on the primary path (live headroom at the moment of append, per call); the fallback `(_headroom ?? 20000)/2` **survives and is still a defect** | the request as it stands that turn — rule 5 |
| search-result headroom share | **unvalidated** (0.25) | share of live headroom a result list may take before it starves the fetch |
| narrowing band size | **derived** (grown outward from the relevance centre under a real token count) | measurement, not an average — replaced a chars×0.85 estimate |
| peek / snippet sizes | **unvalidated** (5 different literals, mutually inconsistent) | one shared value sized to available room |
| edit-argument cap | **validated** (512 bytes when post-state exists) | both alternatives measured |
| reply allowance | **derived** (`window − prompt`, per turn) | arithmetic, untested live |
| reply headroom | **derived** (model's reported max, or measured; fraction as fallback) | the model — rule 3 |
| tool-to-phase map | **host** (8 entries; unknown → "other") | the harness |
| leaf summarizer model / concurrency | **host** | cost tiering / rate limit |
| contract version | **host** (v1 default, v2/v3 registered) | the model |
| turn / wall-clock ceiling | **removed** | — |

The window (W) is host-supplied and user-configurable. A host that wants lower
cost and latency sets a smaller W; the tree compensates through search and
fetch. A host that wants maximum coverage uses the model's full window. The
optimal W for a given session — the smallest window that achieves parity with
full-context performance — is the measurement the live verification step exists
to produce.

Open defects: 6 unvalidated values, four of which already have derivations
in the portability harness but not the live suite. The two added this pass
(search-result headroom share, and the band-growth policy's reliance on the
measured ratio) are both from the multi-index pass and both have a stated
derivation owed.

## Boundary conditions

| Condition | State |
|---|---|
| Window < Zone A + one summary (8k) | Dead cell; reported, not forced |
| Window < iterative tool use (16k) | Dead cell; search payload exceeds headroom |
| A leaf larger than W | Found; two independent causes (segmentation + rendering duplication), both capped |
| Unknown tool name | Maps to "other" — tested |
| Tokenizer heuristic drifts | Measured; refuses above 1.6 |
| Trace with 0 or 1 branches | Fold and assembly no-op — tested |
| Summaries don't contain the answer | Confirmed (0/12 answer literals in any summary); raw fetch is for this |
| No embedder | Beam search fallback — tested |
| Search ranks wrong branch | Fixed 2026-09-03: fingerprints + grep → 10/12 top-3 (was 2/12) |
| Tail covers the answerable content (W ≥ answer depth) | **Found 2026-09-03.** The tree adds no value when the raw tail already contains the answer — tool-use overhead (15-20K tokens per question) is a net loss. The tree earns its keep only in the overflow regime: sessions where the trace exceeds the window and answers lie outside the tail. |
| Overflow regime, ranking made perfect | **Measured 2026-09-03, and the split depends on the question set.** On the set with all three arms at one epoch, perfect ranking recovers 19 of the 21 points the real-search arm loses (2/25 → 21/25 against 23/25 ground truth), so ranking-to-selection dominates and ~8% of the gap is post-retrieval. On a deeper set, perfect ranking reaches only 13/25 against 25/25 — but no real-search arm was run there, so that gap cannot be split. Do not quote a single figure. |
| An overflow question set at a wider W than it was cut for | **Invalid.** The truncation boundary is non-increasing in W, so a set cut at W₁ stops testing overflow above W₁ — answers fall into the tail and median turns drop to 1 (the model stops calling tools). Re-cut per claim window. |
| Exact-match grading against a fluent model | **Gameable.** Observed: a fabricated transcript citing seq 755-757 in a 754-event trace, and a correct refusal that named the answer string in a suggested command. Scores need a provenance check. |
| Facet index with high-cardinality key | Cheap-unit economics fail. 66 file / 311 command entries cost 2.7K / 7.5K tokens; 3,969 line entries cost 77K — as much as the content, so "return more candidates" is unavailable and ranking binds again. |
| Fusing indexes with disjoint coverage | **Harmful.** RRF across four indexes scores 6/17 where routing to the best single index scores 9/17; answers already found are demoted (rank 3→12, 7→25). Fuse rankers over one index, route across indexes. |
| A stratum's claimed invariant, read from its comment | **Not an invariant.** `head` was documented as "provably outside the baseline's view"; it is only outside the tail at the K it was cut for. Re-test the property at every parameter value it is used at. Comment corrected 2026-09-03. |
| An offline gate whose axis misses the live range | Passes and predicts nothing. The narrowing gate swept 2k-16k token budgets and went 20/20 while the live per-call headroom rarely entered that range; delivered payload p90 moved <1%. Measure gates over the budgets the live path produces. |
| Instrumentation that records a request, not an outcome | Reads as a behavioural finding. `fetchedDepths` logs the depth the model ASKED for while the served depth is forced; the field is empty by construction for raw-fetch arms and misdirected one diagnosis. |
| Fact needing two literals from two places | No single-entry index can serve it. Three of 17 questions; needs a join or an explicit second hop. Open. |

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

**Index granularity and routing.** The unit dominates the ranking by tens to one
in offline token cost (38:1-78:1). A
branch replay is 26KB with the answer on one line; a command-facet entry is 40
tokens, and a top-10 slice costs 272-440 tokens against 8-16K for a narrowed
replay. Several indexes raise coverage (5-6/17 → 9/17) but only under routing;
fusion drops it to 6/17. Ranking within a cheap index is near-optimal already
(C1' places 5 of the 6 retrievable questions in the top 10). The ceiling is
coverage: 6/17 answers exist in no index, which retires every ranker-side
candidate — embeddings, KNN, autoencoder latents, learned ranking — at the same
6/17. *(Report: `reports/metrics/ds-star-multi-index-report.md`)*

## Candidates with a verdict, not yet in force

- **Fingerprint-enriched search + hybrid grep**: 2/12 → 10/12 top-3 for the shipped
  deterministic ranker (11/12 required a MOCKED query rewriter, never a live one).
  Landed in code; live-verified 2026-09-03 and the live score did not move.
- **Raw by default**: fetch returns raw events, not summaries. None of 12
  answer literals is in any summary.
- **Search hits as coordinates**: payload 9,673 → 4,898 tokens.
- **Contract v3**: one rule replaced, one removed.
- **One budget derivation**: delete the live suite's absolute switch point.
- **Delete Zone C fallback chain**: first branch never fires.
- **Third cache breakpoint as default**: −39.8% offline, gated on second scenario.
- **Route, don't fuse, across indexes**: 9/17 vs 6/17 top-10. Measured offline;
  the `tree-route` arm is specified but unbuilt.
- **One-cut narrowing**: band grown under a real token count to the live
  headroom. Offline 20/20 fits (was 19/20), 19/20 carries the answer (was 17/20),
  bands 2-5x wider. Landed in code; live score unchanged — a different bucket binds.
- **Retired**: Zone C pre-fill, completion nudge, contract section trim,
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

## Change log

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
