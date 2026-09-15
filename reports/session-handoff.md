# Session handoff — pick up here

This is a **research project**, not a shipped product. The substance lives in `experiments/` and
`reports/`; the end goal is a paper. Read this file, then `reports/algorithm.md`, then the specific
experiment reports named below.

**Governing rule for `packages/` (established this session):** *the package holds only settled
experimental results.* An untested hypothesis — even one already coded — belongs in `experiments/`
with a test design, not in the package where a future agent reads it as canon. "Not in the current
spec" is **not** "tested and rejected"; before retiring or promoting any code, derive its provenance
from the experiment record (see the disposition table). See memory `untested-not-rejected`.

## Where things stand

- **`reports/algorithm.md`** — the clean, self-contained implementation spec. Two fresh spec-only
  audits; zero BLOCKERs beyond the two subsystems it marks **OPEN** (retrieval trigger, resource bound).
  This session also fixed the `τ`/z-score contradiction (`τ = z-drift > 1`) and defined the per-unit
  budget `b = (f − reply reserve) ÷ (A + 1)`.
- **`reports/algorithm-notebook.md`** — the archive: boundary conditions, rejected alternatives,
  parameter audit, change log. Detritus lives here so the spec stays clean.
- **`reports/metrics/`** — per-experiment reports (cited throughout below).

### Settled results (what the package is allowed to reflect as canon)
- **Eviction policy *shape*:** priority-dominant, recency+ref-recency protective, **relevance≈0**
  (relevance-eviction is *worst* on the dormant-return case, 0.06/0.10). Offline-won across budgets +
  one live causal confirmation (−26% vs none / −14% vs recency at equal PASS).
  `assembler-weighting/report-assembler-weighting.md`, `coding-harness/report-eviction.md`.
  > ⚠️ **Now partially contested — see backlog item 2.** The live A/B window sweep found that selection
  > on **reference recency alone** beat positional recency and a volume-matched random control at a tight
  > cap, and the original offline sweep optimum already ranked ref-recency *highest* (1.0) while D-EV
  > ships it *lowest* among the positive terms (0.5). The *relevance≈0* finding is untouched; what is in
  > question is whether the other three terms earn their place over pure LRU-at-`g*`. Do not treat the
  > 4-term score as canon until item 2 resolves. `report-ab-longbuild.md`.
- **Flex-buffer assembler** (frozen head + creation-order buffer, second breakpoint): ~14% cheaper than
  the shipped Zone A/B/C on cache economics; free re-mixing is cache-death. `assembler-flex-buffer/report.md`.
  *Evidence is offline cache-economics only — task-quality parity vs zones is an owed live check (weaker
  basis than the retriever/eviction wins, which have live arms).*
- **Drift topic-shift classifier** (`z(lexJaccard)+z(semCos)`, K=5): signal real and strong (~9.5σ vs
  permutation null; 3.75× coarse precision vs tool-phase). *Owes a corrected held-out permutation
  re-run* — the pre-registered test was mis-specified (tail reversed). `rung-0b-topic-shift/report.md`,
  `online-segmentation/`.
- **Reduce-on-overflow *reducers*** (default chunk+retrieve): summarize FAILS on a buried detail, chunk
  PASSES at lowest tokens; only chunk fits an 8.2K window and preserves all four prices.
  `coding-harness/report-{buried-detail,hard-window-synthesis}.md`.
- **The middleware is *required* under a hard window** (raw reads crash the 8.2K model without it).
- **Retrieval combinator rule (code corpus only):** plain RRF over a shared, overlapping-coverage corpus
  beats best-single / feature-router / gated-fusion, offline and live. `rung-0e-retrievers/`, `rung-2-retriever-live/`.

> ⚠️ **Retrieval caveat (narrow):** every RRF result was on a **code** corpus (`packages/**/src`),
> never on chat-history / L0 transcript chunks. This does **not** block promoting RRF — an RRF
> ensemble is corpus-robust by construction (it tracks its best component, so it doesn't bet on which
> single retriever wins on prose), and the design it replaces was *measured to lose*. What stays
> provisional is the *tuning*, not the choice: `RRF_K=60` (borrowed, never swept), chunk `~800/100`
> (borrowed), and which single component leads on transcripts. Promote RRF; run the transcript-corpus
> experiment to confirm-and-tune as a follow-up, not a gate.

## Package ↔ spec reconciliation: provenance & disposition

Two subagent surveys mapped `packages/` against the spec; two more derived each cluster's provenance
from the experiment record. **Promotion lens (applied uniformly):** promote the tested *choice / shape /
mechanism* — especially where it replaces a design that was *measured to lose* — and ship its fitted
*constants* (`RRF_K`, chunk size, eviction coefficients, floor `f`, anchor `A`, router pick-rule) as
flagged provisional defaults refined by a follow-up experiment; send only genuinely-never-measured
*mechanisms* to `experiments/`. A thinner evidence base (offline-only, n=1, an owed validation) is a
flag to carry, not a reason to withhold promotion over a tested-loser incumbent. Result:

| Cluster (`packages/`) | Provenance | Disposition |
|---|---|---|
| `store/` (L0/L2/L1/L3), `segment/`, `summarize/`, `mcp/` 4-tool surface | ALIGNED / settled | **Keep** (summarizer's strong-model root roll-up is richer than the spec's headline fold — revisit with the root-fold) |
| `cache/simulator.ts`, `cache/prefix.ts` (§17 harness), tokenizer, `assemble/budgets.ts` reply-reserve arithmetic, `assemble/format.ts` renderers, `attention/payload.ts` | SCAFFOLDING | **Keep**; re-key prefix harness from "zone-unchanged" → "frozen-head-unchanged" |
| `assemble/` `ZoneAssembler` (`zoneA/B/C`), `contracts/assemble.ts` `Zone`, `ZONE_FRACTIONS` | Zone B TESTED-AND-LOST (cache) + dissolved by flex-buffer | **Rewrite** to frozen-head + creation-order flex-buffer. Promotion basis is offline-cache only — flag **task-quality parity vs zones as an owed live check** |
| Eviction policy shape | SETTLED-WIN | **Build** (absent today) |
| — exact `2/1/0.5/−1` coefficients | UNTESTED (hand-rounded; sweep optimum differed) | Build the shape; coefficients are tunable defaults, **not** canon |
| Drift classifier | SETTLED-WIN (signal) | **Build** (absent); owes the corrected permutation re-run |
| — sufficiency half | NOT-CARRIED-FORWARD (dissolved by on-demand design) | Don't build |
| — regex `detectAttentionSignals` | ARTIFACT (0.245%/turn, void) | **Delete** |
| Reduce-on-overflow reducers | SETTLED-WIN | **Build**; the auto-select **router** stays a flagged heuristic |
| Soft floor `f`, recency anchor `A=4` | **`f` now contested** (DV2: evicting to a soft floor below the window converts 0.1× reads into 1.25× writes; measured hot set swings 0.4–35k, so a fixed fraction is the wrong shape) / `A` untested | Keep as parameters, marked untested; **`f` pending backlog item 7** |
| `attention/` `selectAttention`, `signals.ts`, `topic-index.ts`, `rederive.ts`/`evictRederivable` (priority channel) | **UNTESTED-HYPOTHESIS** (zero prod callers; priority params proven *inert* without query fingerprints) | **Move → `experiments/attention-over-history/`** with a test design (below) |
| `retrieve/retriever.ts` summary-ranking (`searchSummaries`, `beamSearch`, `mergeWithGrep`), `retrieve/lexical.ts` IDF | **TESTED-AND-LOST** — and this is the code the package *ships* as live `context_search` | **Retire** the rank path; keep `fetchBranch`/`peek`/L0-replay + `extractFingerprints` scaffolding |
| `providers/` fixed-order stack (structural→fuzzy→grep) | **NEVER-COMPARED** (design decision, never A/B'd) | Not settled → out of the canonical path; preserve as the structural-retrieval hypothesis |
| RRF ensemble (BM25+vector/MiniLM) | SETTLED-WIN **on code** (offline + live); corpus-robust by construction | **Promote** as the package retriever (replaces the tested-and-lost path); flag params (`RRF_K`, chunk size, component mix) provisional; transcript validation is a follow-up, not a gate |
| `models/embeddings.ts` remote `text-embedding-3-small` | NOT-CARRIED-FORWARD (deployment; early remote gate failed) | Switch to local MiniLM |
| `RRF_K=60`, chunk `~800/100` | Borrowed, unswept defaults | Mark; sweepable |

**Net effect on the retrieval subsystem:** retire the tested-and-lost live path and **promote RRF**
as the package retriever (it won offline + live and replaces a design that was measured to lose; the
ensemble is corpus-robust by construction). Flag the *tuning* as provisional (`RRF_K`, chunk size,
which component leads on transcripts) and run the transcript-corpus experiment to confirm-and-tune —
a follow-up, not a precondition for promotion.

### Execution status (as of this session)

Environment note: the DB-backed tests need Node ≥ 22 (`better-sqlite3` native ABI); on an older
runtime they segfault/`ERR_IPC_CHANNEL_CLOSED`. Run the suite single-fork in a sandboxed shell:
`vitest run packages/core --pool=forks --poolOptions.forks.singleFork=true` (a worker-teardown quirk).

**Done and verified (all green — core suite 645 passed / 9 skipped, `tsc -b` clean). Commits on
`live-model-retriever-probes`: `5cfdfe3`, `08fa1ab`, `654c029`, `51c03c9`, `b3766f5`:**
- ✅ `attention/` → `experiments/attention-over-history/snapshot/` (+ README); `attention.test.ts` removed. `5cfdfe3`
- ✅ **Eviction scorer** `assemble/eviction.ts` — D-EV shape, coefficients flagged provisional (12 tests).
- ✅ **Drift classifier** `classify/drift.ts` — settled drift signal; z-score/τ flagged provisional,
  owes the corrected permutation re-run (11 tests).
- ✅ **Flex assembler** `assemble/flex.ts` — `assembleFlex` (frozen head + creation-order buffer +
  eviction + dormancy + two breakpoints). Code-review fixes applied (`08fa1ab`): the secondary
  breakpoint sits after only the **leading contiguous summary run** (a raw hole — un-latched old unit or
  anchor — closes the stable run, so an async summary latch can't rewrite the cached prefix);
  stable-run cache invariant tested via the cached-prefix assertion; `overWindow` = `total > window`
  (contract-consistent). **reduce-on-overflow / per-unit budget `b` is NOT implemented** — marked
  in-code, phased (see order below) (12 tests).
- ✅ **RRF ensemble retriever** `654c029` — `retrieve/{chunk,bm25,rrf,ensemble}.ts`: recursive splitter +
  Okapi BM25 + RRF fusion over L0-unit chunks → whole units, embedder-agnostic (13 tests). Tested-and-lost
  / never-compared code FENCED in-code: `retriever.ts` summary-rank path (partly superseded, fetch/peek
  kept), `lexical.ts` IDF, `models/embeddings.ts` (remote → NOT-CARRIED-FORWARD), `providers/` (never-compared).
- ✅ **Assembler swap complete** — `Zone` contract narrowed to `head|flex|tail`; `ZoneAssembler` and its
  1160-line test DELETED; `toMessages`/`toCompletionRequest` generalized to the flex vocabulary; zone
  budgets (`ZONE_FRACTIONS`/`deriveZoneBudgets`/`zoneBRemainder`) and `config.budgets` retired;
  `BudgetReport` renamed (`head`/`flex`/`evicted`); `buildFlexSource` renders summaries WITH their §8
  rehydration pointers; the `assemble`/`cache`/`budgets`/`e2e`/`resume.live` tests migrated to the flex
  model. Net −2,780 lines. `ocr` review: 1 non-actionable finding (the intended source break, moot on a
  private pre-1.0 repo). Full suite green (31 files, 639 passed / 9 skipped); `tsc -b` clean.
- ✅ **Flex store-adapter** `assemble/flex-store.ts` (`b3766f5`) — the convergence point.
  `mapFlexUnits` (pure): store entries → `FlexUnit[]` (fingerprints, dormancy via the classifier,
  priority signals) + the `EnsembleUnit` corpus; `buildFlexSource` (glue): store/trace/blobs → frozen
  head (system + steering + all L0 `user_message` prompts) + phase-node units in creation order (same
  `trace.read`+`renderEvent` span `ZoneAssembler` used). Classifier degrades to lexical-only when no
  embedder is supplied (`ClassifyUnit.embedding` optional). Shared `embedInBatches` (validated + bounded)
  used by both the adapter and `ensembleRetrieve` (`51c03c9`/`b3766f5` fold in the two `ocr` reviews).
  *Note:* `buildFlexSource`'s store-reading glue is typechecked + reuses the proven read pattern but is
  not yet covered by a populated-DB integration test — that arrives with the `context_search` rewiring.
  *Also noted:* `extractFingerprints` matches camelCase/PascalCase/paths but NOT snake_case (a spec-vs-impl
  gap worth reconciling).

**Remaining execution order** (settled-result builds only — untested hypotheses live in the backlog below):
- ✅ **`context_search` rewired** onto `ensembleRetrieve` (`8c5b595`) — whole-unit hits, provider
  fan-out + summary-rank path retired, mcp suite green (39/39). This also gave `buildFlexSource` its
  populated-DB coverage.

- ✅ **Assembler swap complete** (see above).

- ✅ **Reduce-on-overflow — the *reducers* + per-unit budget `b`** (the LAST migration build).
  `assemble/reduce.ts`: the SETTLED chunk (detail-preserving) + summarize (gist) reducers, `chunk` the
  default. Built on the package's own settled primitives (recursive `splitText` + Okapi `BM25` + `RRF`
  fusion + tokenizer-aware budgeting), an improvement over the experiment's crude fixed-slice reducer;
  it is intra-unit retrieval (the ensemble machinery scoped to one oversized unit's chunks). Wired into
  `assembleFlex`: the per-unit budget `b = (f − reply reserve) ÷ (A + 1)` shrinks any RAW unit over `b`
  in place (anchors included — never evicted, but reducible); `BudgetReport.reduced` reports which. The
  query defaults to the last user prompt; the vector arm is optional (BM25-only in the sync assembler,
  the same degradation `ensembleRetrieve` uses without an embedder). The query→reducer **router** that
  would auto-pick chunk-vs-summarize is deliberately NOT built — it is untested (backlog item 4). New
  tests: `reduce.test.ts` (13) + reduce-on-overflow cases in `flex-assemble.test.ts` (5). Full suite
  green (32 files, 657 passed / 9 skipped); `tsc -b` clean.

**The package↔spec migration is complete.** `packages/` now reflects only settled experimental results:
retrieval (RRF ensemble), classifier (drift), eviction (D-EV), assembler (flex head + creation-order
buffer + reduce-on-overflow), and the store-adapter that feeds them. What remains is not migration work —
it is the experiment backlog (new hypotheses to test) and parameter sweeps, below.

## Untested-hypothesis experiment backlog

Each survivor needs its own `experiments/<name>/` folder + report before any package promotion.

> **REFRESHED after the context-dedup series (DV1/DV2, Tier 1, the A/B window-cap sweep).** Three
> cross-cutting items below. **They are NOT equally established — read the provenance tag on each.**
> C1 is live-measured; **C2 and C3 are DERIVED/SIMULATED and have never been validated live.** Do not
> cite C2/C3 as settled facts; they are the current best model, and two open questions (items 11–12)
> attack them directly.

**C1 — Full-tool agents self-heal, so window pressure is intrinsically LONG-HORIZON.** *(LIVE-MEASURED;
local models only.)* Measured three
independent times: with `run_bash` available the model `cat`/`grep`s exactly what it needs and never
loads whole files (peak context stayed ~830–1,035 tokens; `evict=0`; every arm collapsed to an identical
trace). Anything persisted to disk is re-fetchable; the ONLY context a tool call cannot recover is the
**conversation history itself**, which grows past a window only over many turns. Consequence: **no short
synthetic task can test a window policy with full tools**, and removing tools to force the issue is not
ecological. A substrate that *does* work now exists — `experiments/context-dedup/ab-tasks/longbuild.mjs`
(6-stage stdlib build, held-out `unittest` grader, 45–61 turns, peak ~19–21k, 18–40 evictions/cell).
Reuse it rather than inventing another short task. (`report-ab-rule-chain.md`, `report-tier2-selfheal.md`.)

**C2 — Mutating the prefix costs ~12.5× a read, so per-turn mutation loses to append-only.**
*(SIMULATED + DERIVED — never live-validated. Scope is narrower than the earlier wording claimed.)*
⚠️ **Correction:** an earlier version of this line said "append-only is cache-optimal BELOW the window",
full stop. That overreaches. DV2's single-version arm mutated the prefix on **every** version swap, i.e.
cadence `N=1` — the worst case. Mutation cost is **per-mutation** while read savings are **per-turn**, so
evicting every `N` turns wins whenever `N·r·(C_large − C_small) > w·S`. A **small window with infrequent
eviction** may therefore beat a large fully-cached one; DV2 does not test that and cannot answer it
(item 11). ⚠️ DV2 also **models no cache TTL** (review finding M7) — the single mechanism most likely to
invert its headline (item 12). Simulation details: `report-dv2-cache-cost.md` via `ProviderCacheSimulator`:
append-only runs at a ~100% cache-read ratio (0.1×) and writes only the per-turn delta; any policy that
rewrites the prefix pays 1.25×. Single-version/dedup is therefore **not a cost optimization — it is a
window-fitter**. Verified against official docs that GitHub Copilot, Claude Code and Augment all discount
cache *even on subscription allowances* (Codex meters messages, not tokens), so cache-adjusted cost is the
right metric for those plans too. **Any backlog item premised on "this saves tokens" must be re-stated as
"this fits more of the right content in a bounded window."**

**C4 — POSITION IS NOT A LEVER on this model at these lengths.** *(LIVE-MEASURED, clean null.)*
Needle-in-a-haystack, 180/180 across both stages — every depth (0/25/50/75/100%), out to **155,773 real
prompt tokens** (59% of the 27B's window) with 7 competing distractors sharing the needle's exact framing.
No RoPE-style decay with depth and no lost-in-the-middle U-shape. With zero failures the 95% one-sided
bound excludes any position-dependent failure rate above **3.3%** pooled (but only 15.3% at a single
depth — it excludes a large effect, not a small one). Two consequences: (i) our policies' inability to
express position costs nothing here, so the presence-only policy class is not leaving a known effect on
the table; (ii) it removes an alternative explanation for the window-cap failures — content was not
"present but buried too deep to retrieve", it was evicted outright. Limits: single-turn retrieval of a
lexically distinct sentence (a copy target, not something to reason over), one model, and a ceiling can
refute a deficit but cannot rank policies. `report-position-probe.{md,html}`.

**C0 — EVERY live result so far is SINGLE-PROBLEM.** The entire A/B series (51 runs, n=3 + n=10, all
arms) ran one task, `longbuild`. That is n repeats of one problem, **not n problems**: it measures
within-problem nondeterminism and says nothing about between-problem variance, which is the larger term in
agentic coding. Item 8's `p=1.000` means "indistinguishable **on this problem**", not "never different" —
and more repeats cannot fix it. **Design rule for every live item below: sample PROBLEMS, not just seeds.**
Item 9's SWE-bench substrate (500 instances / 12 repos, 156 runnable here) is the instrument for that, and
this is now the strongest argument for prioritising it.

**C3 — The eviction threshold is DERIVED, not guessed: `g* = w/r` turns.** *(ANALYTIC — pure algebra on
published price multipliers; the 12.5 operating point has NEVER been validated in a live run, and no
experiment has shown it is the right place to stand.)* **It is also not one number:** the multiplier
depends on the cache tier — Anthropic prices the 1-hour cache-write tier above the 5-minute tier, so
`g*` moves with the TTL you are on (and Claude Code subscriptions use the 1-hour lifetime, dropping to
5 minutes once on usage credits). Re-derive `g*` from current published multipliers per tier rather than
hardcoding 12.5.
Keeping a unit costs `r·B` per turn; re-fetching one costs `w·B` once. Break-even: keep iff the next use
is within `w/r` turns (size-independent). Backward **idle** (turns since a unit's file was last touched)
is the trivially-countable proxy — Tier 1 puts per-decision precision ≈ **85%**, only **+1–2pp over a
no-skill constant predictor** (MCC 0.235); the earlier "98% precision" was an artifact of scoring every
resident turn. ⚠️ **The live A/B (item 8) then found idle does NOT beat positional recency as an
eviction signal** (pooled p=1.000), so treat `g*`-on-idle as an unproven policy, not a validated one. **Caution:** Tier 1 also found the transcript turn-clock counts JSONL *content-block lines*,
not API turns (2–2.4× inflation) — check any transcript analysis for the same defect.

### 0. INSTRUMENT SENSITIVITY — a gate on items 1, 2, 6 and 7 *(RUN; VOID; still open)*

> **OUTCOME: the control did not control.** `oracle` 0/10 vs `random` 0/10 (p=1.000) — but **do not read
> that as a null**: the control arm wrote **zero files in 10 of 10 runs**, i.e. it stopped attempting the
> task rather than performing it badly. The two pre-registered validity conditions both passed on a
> worthless run; a third (*the control must still be attempting the task*) has been added and now fires
> automatically. Review separately established that the design could not have answered its question anyway —
> the oracle's advantage flows purely through useful-token VOLUME (~1 e-fold), the effect already known,
> while the four nulls it was meant to adjudicate were measured at MATCHED volume.
> **A redesign needs arms that hold equal useful volume and differ only in composition** — see item 1's
> attention ablation, which satisfies that by construction and uses a continuous endpoint.
> `report-sensitivity-control.{md,html}`.
**Why this now outranks everything below it.** Every live result that varies WHICH context is kept has
come back null on this substrate: selection signal p=0.70; reference vs positional recency p=1.000
(item 8); needle position 180/180 (`report-position-probe.md`); eviction cadence p=0.54 once achieved
peak is controlled (item 11). Items 1, 2, 6 and 7 are all of the form *"does signal X beat signal Y"* —
none is worth running until we know the harness can detect such a difference at all.

- **Design:** a positive control. Ballast = a byte-identical **duplicate re-read** of a file the agent
  already read, so it is provably zero-information. Arms: `oracle` (drops superseded duplicates),
  `truncate-tail`, `idle`, `random`, plus `clean` (no ballast) as the validity check.
  `experiments/context-dedup/{ballast,sensitivity-control,stats}.mjs`, 20 unit tests.
- **Pre-registered:** oracle > random, one-sided Fisher, α=0.05 — interpretable only if `clean` is not at
  the floor and `random` ≤ 0.4n, else it is an operating-point miss and must be re-run, not interpreted.
- **If it fires:** the instrument is sensitive, the four nulls above stand as real findings for this task,
  **and dedup is a live candidate policy** — the label is exact and computable, so `oracle` is shippable,
  not just a ceiling.
- **If it does not fire while validity holds:** state all four nulls as UNINFORMATIVE and redesign
  items 1/2/6/7 before running them.
- **Method finding already banked:** two earlier ballast designs — fabricated tool calls on unrelated
  files, then the same material as user-role pastes — **derailed the agent** rather than merely taxing it
  (60 distractor reads in 61 turns and zero writes; then 51 tool calls and zero writes, where a passing
  trace writes by call ~9). *Injecting foreign material into an agent's context changes what the agent
  does.* Any middleware that synthesises context — summaries written as agent actions, retrieved passages
  spliced into history — should expect this.

### 0b. WIDTH IS NOT SUFFICIENT — our own data falsifies the monotone reading *(settled, from the dedup run)*
The window sweep's "more context is better" law (OR 42× per e-fold) was fitted entirely on runs whose context
was the agent's **own organic content**. The sensitivity control broke that regime and the law with it:

| run | context sent | outcome |
|---|---|---|
| `uncapped-clean` (no cap, no duplicates) | 18,650 | **PASS**, 17 files written |
| `uncapped-ballast` (no cap, duplicates) | **51,141** — the largest context in the whole dataset | **FAIL**, 0 files written |

**More context, worse outcome.** So composition matters, and the honest statement of the width law is *more
organic context is better*, not *more context is better*. Two consequences:
- The open question is narrower than "can selection ever matter" — it is **can our binary pass/fail endpoint
  detect it**. Composition is now demonstrated to matter; only our ability to measure it is in doubt.
- The dedup arm halved the damage (0 → 7 files written) without ever reaching a pass. That is a real,
  continuous improvement the binary metric discarded. **Prefer continuous endpoints in every follow-up.**

### 0c. COVARIANCE as an eviction signal — one half never ablated, the other never conceived
Derived from the experiment record (survey, this session). Two distinct quantities, routinely conflated:

- **Static co-occurrence (recurrence) — TESTED OFFLINE AND WON, but the shipped form is UNABLATED.**
  `experiments/assembler-weighting/` swept a *pure* recurrence term (`'priority-only': [0,0,1,0]` plus a full
  `{0,0.5,1}⁴` grid) and it was the strongest single signal: priority-only recall 0.35/0.42 vs recency-only
  0.25/0.24, LR mixing rate 4.12 (≫ recency 2.42, ref-recency 1.04).
  ⚠️ **What ships is not what was tested.** `flex.ts:268` computes
  `priority: ((u.wrote ? 2 : 0) + coOccurrence(units, i)) * decay` — the sum is formed *before* any weight,
  so **no coefficient in the codebase can move the co-occurrence half relative to the edit-boost half**. That
  2:1 internal ratio is a hardcoded constant no experiment has varied, which violates the project's own rule
  on undefended constants. The two functions also differ: the tested one counted *later turns that came to
  overlap this unit* (directional); the shipped one counts *all resident units sharing a fingerprint*
  (undirected). The offline win transfers by analogy only.
  **Owed:** split `priority` into two weighted terms and sweep the ratio; re-check that the undirected form
  carries the directional form's win.
- **Temporal covariance (pairwise co-reference over turns) — NEVER TESTED, never proposed.** Nothing in the
  repo computes whether two units tend to be *referenced together across turns*. `policies.mjs` exposes only
  recency / random / idle / blend / protect / oracle.
  **Why it is the principled repair of the signal that lost:** relevance-to-recent was measured *worst*
  (D-EV4, weight 0) for exactly one reason — it drops the dormant unit that later returns. Temporal
  covariance is the signal that **keeps** that unit: dormant now, but historically co-active with what is hot,
  so likely needed when the hot set is next touched. Design: per unit a binary reference series over turns;
  score = covariance with the current hot set's series; keep high-covariance units even when idle is large.

### 1. Attention over history (highest-value survivor) — `experiments/attention-over-history/`

> **REFRAMED — MEASURED attention, not similarity-to-recent, and scored on a CONTINUOUS endpoint.**
> The existing item concluded attention belongs at *admission* rather than eviction, but that conclusion was
> about **relevance computed by embedding similarity**, not about the model's **actual attention mass**. A
> unit can be perfectly retrievable and still be attended to hardly at all — those are different quantities
> and only the first has been measured. The cheap proxy for "the model stopped attending to this" is
> reference-recency (`idle`), which was tested and returned p=1.000, so the proxy is exhausted; the real
> measurement is not.
> **Design:** the OpenAI-compatible endpoint does not expose attention, so load the model directly with
> `output_attentions=True` (GPUs available). Replay a real transcript; for each turn compute the attention
> mass each unit receives from the final position; then ablate at **matched volume** — drop lowest-attention
> units vs oldest vs random — and measure the shift in the model's own **next-token distribution** (KL).
> **Why this design beats the ones that failed:** the endpoint is continuous, so it does not depend on the
> binary pass/fail metric that item 0 showed may be insensitive; and the arms are volume-matched by
> construction, which is the flaw that voided the ballast control.
> **Caveat to carry:** the position probe found no retrieval deficit at any depth out to 155,773 tokens, so
> attention mass is not the bottleneck for *retrieving a fact when asked*. That does not settle whether it
> predicts what is safe to discard.

The umbrella hypothesis (evict/retain context by bearing-on-the-current-turn) was **never validly
tested** — the harness that would have measured it couldn't represent a tool call and was deleted;
`selectAttention` has zero production callers. The record already answers the design questions:

- **Where does it belong? → Admission, not eviction.** D-EV4 measured relevance-to-recent as the
  *worst* eviction signal (drops the dormant unit that later returns). So attention/relevance keys the
  **retriever / assembler-*in*** (what to pull back), while **eviction** stays on
  priority + recency + drift-dormancy. Encode it as the admission channel, not a new eviction term.
  (`assembler-weighting/report-assembler-weighting.md` conclusion 4 / D-EV4–5.)
- **Does it work? → Test in the overflow regime, on retention-required tasks.** It can only help where
  the buffer actually overflows; the corpus that reaches that regime exists (109 sessions ≥100 tool
  calls, 55 > 131K tokens). Arm: relevance-admission (push query-relevant dormant units back up-front)
  vs the on-demand baseline. This *is* the spec's OPEN "retrieval trigger" A/B. Falsification: the
  admission arm must beat on-demand on task-success in the overflow regime by a pre-set margin, else
  attention-as-admission is retired. Use a task with **no re-read escape** (ties to item 4 below).
- **Does it destroy the cache, and can that be avoided? → Yes if done per-turn; avoidable.**
  Per-turn re-mixing is measured cache-death (`flex-remix` 433k vs 341k effCost); Anthropic break-even
  is ~12.5 turns at keep=0.5 (`cacheWrite 1.25×`/`cacheRead 0.1×`). **Avoidance:** admitted units must
  **append after the buffer** (never reorder the cached prefix — same discipline the spec already uses
  for retrieval results) and admission must fire at a **multi-turn cadence**, not every turn. The
  experiment must record `cacheWrite`/`cacheRead` and report effective cost, not just token volume.

- **STATUS after this series → now RUNNABLE; design constraints tightened.** Per C1 the "no re-read
  escape" framing was the wrong lever: you do not need to remove the escape, you need a **long-horizon**
  task so non-recoverable conversation history accumulates. Use `longbuild` (C1) rather than building a
  new task. Per C3 the admission decision now has a derived cost model: re-admitting a dropped unit costs
  one cache write (`w·B`), so admission pays only when the unit's expected next use is within `w/r` turns
  — the same threshold eviction uses, applied in the opposite direction. **Corpus caveat:** the "109
  sessions ≥100 tool calls" overflow corpus is NOT in this checkout (it was the author's other machine);
  either regenerate it from `~/.claude/projects` or use `longbuild` under a forced cap.

### 2. Coefficient tuning for the eviction score — **REFRAMED: first ask whether the score is needed at all**
The `2/1/0.5/−1` weights are hand-rounded; the offline sweep optimum was `[rec .5, rel 0, prio .5,
**refrec 1**]`. **Note what that optimum already said: reference-recency was the highest-weighted term,
while D-EV ships it at the *lowest* positive weight (0.5).** The A/B window sweep now corroborates that
from the live side: a policy selecting on **reference recency alone** (keep the units whose files were
touched most recently — LRU on `idleOf`) beat positional recency and a volume-matched random control at a
tight cap (n=3: 3/3 vs 1/3 vs 1/3, ~half the re-reads at matched eviction volume; n=10 confirmation in
flight). `report-ab-longbuild.md`.

⚠️ **Updated by item 8's n=10 outcome.** Pure reference-recency did **NOT** beat positional recency
live (pooled 7/13 vs 6/13, **p=1.000**), so **the case for retiring the other terms in favour of idle is
NOT made** — an earlier version of this item leaned that way on n=3 evidence that turned out to be noise.
The sharpened question stands, but with **no presumed winner**: does the 4-term D-EV score beat *either*
single-signal baseline (idle, or plain positional recency)? Run both single-signal policies as baselines
and make each extra term earn its place. The live evidence so far says the two single signals are
**indistinguishable from each other**, and both beat no-signal — consistent with "some ordering matters,
which one matters less". Only if the multi-term score wins does a coefficient re-fit
matter — and then it must be cross-session-validated before any value is canon. (`assembler-weighting/`,
`experiments/context-dedup/policies.mjs` for the tested LRU implementation.)

### 3. Drift classifier — corrected validation
Re-run the permutation test with the corrected held-out condition (the pre-reg tail was reversed);
the topic-shift half is deterministic and falsifiable on its own terms. (`rung-0b-topic-shift/report.md`.)

**Prerequisite added by C3:** Tier 1 found the transcript turn-clock counted JSONL assistant
*content-block lines* rather than API turns (645 lines → 331 real turns; 2–2.4× inflation). The drift
classifier's `K=5` recent-window and its causal z-scoring are both measured in "units/turns", so **audit
its clock for the same defect before re-running the permutation test** — otherwise the corrected test
inherits an uncorrected window.

### 4. Reduce-on-overflow **router** (auto-select)
The reducers are settled and built (`assemble/reduce.ts`); the query→reducer heuristic that *chooses*
chunk-vs-summarize is not. The seam is ready: pass a `reducer` function to `assembleFlex` (or name
`'chunk'`/`'summarize'`) — the router is exactly such a function. Test router pick-accuracy vs an oracle
over the query set. (`coding-harness/report-buried-detail.md`.)

**Reframed by C1/C2.** (i) Reduction *rewrites a unit in place*, which invalidates the cached suffix — so
the router's choice carries a cache cost (1.25× on everything after it), not just a quality effect; score
arms on cache-adjusted cost, and prefer reducing units that sit late in the prefix. (ii) Full-tool agents
already shrink their own tool output (measured: piping test runs through `tail -20`, so 11 `run_bash`
calls contributed 1,983 of 10,120 peak tokens), so reduce-on-overflow may rarely fire in realistic
settings — establish how often it triggers at all before tuning which reducer it picks.

### 5. RRF ensemble on the **transcript** corpus (confirm-and-tune, post-promotion)
RRF is promoted on its code-corpus win + ensemble robustness; this experiment confirms transfer and
tunes the provisional params. Re-run the rung-0e/rung-2 methodology on chat-history / L0-unit chunks;
sweep `RRF_K` and chunk size; check which component leads on prose. Not a gate on promotion.
(`rung-0e-retrievers/`, `rung-2-retriever-live/`.)

### 6. Priority channel / `evictRederivable`
Re-gate with query fingerprints first (params proven inert without them), then measure *effect*, not
just that the mechanism fires. (`harness-deletion-and-hypothesis-register-report.md` §6.)

**Add the item-2 baseline:** measure any priority-channel effect *against pure LRU-at-`g*`*, not against
no-eviction. If reference-recency alone already captures the benefit, a separate priority channel is
redundant.

### 7. Soft target `f` — **LARGELY OBSOLETED AS FRAMED; replace the question**
The original item ("sweep `f` as a fraction of W, 25–50%") rests on an assumption C2 contradicts.
**Under caching, evicting down to a soft floor while the context still fits the window makes things
worse, not better** — it converts cheap cache reads (0.1×) into cache writes (1.25×) for no benefit.
Below the hard window, append-only is cost-optimal; eviction earns its keep only when the content
genuinely will not fit.

`f` is also the wrong *shape*. Deriving the target from C3 (`f* =` the content reused within `w/r`
turns) and measuring that hot set on the real transcripts gives **peak 16–35k tokens but an average of
only 0.4–2.4k** — a ~32× swing. A fixed fraction of W cannot track that; the target is inherently
**dynamic**.

Replacement question: **should eviction fire below the hard window at all, and if so against a floating
hot-set target rather than a fixed fraction?** Arms: (a) no eviction until `window − replyReserve` binds
(the C2-implied default), (b) fixed `f = 0.375·W` (today's canon), (c) floating hot-set target from
`g* = w/r`. Metric: task success + cache-adjusted cost, on the `longbuild` substrate (C1). Retire the
`25–50%` sweep unless (b) wins.

*(HR1 — structural retrieval unit, excerpt-vs-whole-payload ablation — is untouched by these results and
still unrun; it is now tracked on its own as item 10.)*

### 8. A/B window-cap sweep — **RESOLVED: the LRU effect did NOT replicate at n=10**
**OUTCOME: the pre-registered falsification is MET.** Reference recency adds nothing over positional
recency on this task.

| arm | n=3 | n=10 | pooled n=13 | pooled re-reads (med) |
|---|---|---|---|---|
| idle (reference recency) | 3/3 | **4/10** | 7/13 (54%) | 7 |
| truncate-tail (positional) | 1/3 | **5/10** | 6/13 (46%) | 4 |
| random (control) | 1/3 | 1/10 | 2/13 (15%) | 9 |

- **idle vs truncate-tail, pooled: Fisher p = 1.000.** No evidence of any difference — at n=10
  truncate-tail was in fact slightly *ahead*. The n=3 split was noise, **and so was the mechanism**: the
  "halved re-reads" that made the n=3 story look coherent **inverted** (pooled idle 7 vs truncate-tail 4).
- **What survives, and it is weaker and different:** a selection signal beats no signal —
  **both signal arms vs random, 13/26 vs 2/13, p = 0.045**. Individually neither clears 0.05
  (idle vs random p=0.097; truncate-tail vs random p=0.202). So *some* ordering matters; *which* one
  matters less than expected.
- **Consequence:** do **not** drive the assembler/evictor from the idle signal on the strength of this.
  Authoritative writeup: `report-ab-combined.{md,html}`; the n=3-only report is bannered as superseded.
- **Methodological note worth keeping:** n=3 produced a clean 3/3-vs-1/3 story *with* a coherent
  mechanism and it was entirely noise. Pre-registering the falsification and paying for n=10 is what
  caught it — the cheap version of this experiment would have shipped a false finding.

### 9. Port the window experiments onto SWE-bench Verified *(substrate now available)*
`experiments/context-dedup/swebench_provision.py` is a validated **non-Docker** SWE-bench harness
(Docker is unusable on this host): per-instance clone at `base_commit`, a venv on the
period-appropriate interpreter via `uv` standalone CPythons, install from the official spec map
(recovered from the v2.1.0 tag — `swebench` 5.x dropped it), then grade on the instance's own
FAIL_TO_PASS/PASS_TO_PASS. `--verify` proves each instance three ways before use (pre-fix FAIL, gold-patch
PASS, no regressions); validated on `psf__requests-2931`. **156 of 500 instances are runnable** (269 are
in light-dependency repos; 3.5/3.6 predate standalone builds, excluding 113 django). Everything lives on
`/mnt/data/ctx-swebench` (symlinked, gitignored). **Open gate before spending real compute:** a
solvability pilot — one *uncapped* attempt on a verified instance. If a local 27B cannot solve it with
unlimited context, a sweep there measures task difficulty, not context policy; fall back to relative
metrics (turns, re-reads) or a stronger model.

### 10. Structural retrieval unit (HR1) — *unchanged, still unrun*
Split out of the old item 7. HR1 (the retrieval unit is wrong for structural turns) needs the
excerpt-vs-whole-structural-payload ablation. Untouched by this series.

### 11. Eviction CADENCE — does a small window amortise its own re-caching? *(attacks C2)* — **SIMULATED YES; LIVE QUALITY CLAIM RETRACTED**

> ⚠️ **CORRECTION (live arm).** A live cadence sweep appeared to show N=10 reaching 100% at W=4,700 where
> N=1 reached 38%, and that was reported as "sawtooth beats a wider flat window". **That claim is
> withdrawn.** `ab-window-sweep.mjs:75` fires eviction only every N turns, so at N>1 nothing enforces the
> cap between events: the nominal `W` is an eviction *trigger*, not a window, and the N=10 cells actually
> sent **7,657-token** prompts — larger than the flat W=7,500 arm's 6,977. Regressing 78 capped cells:
> given achieved peak, cadence adds nothing (LR χ²(1)=0.37, **p=0.54**) and nominal W adds nothing
> (p=0.66), while achieved peak given cadence is decisive (p=0.0002, **OR 42× per e-fold**). All models
> adjust for `arm`: the signal-free `random` control appears only at cadence 1, and omitting it inflated
> the odds ratio by 25% (52×) — the conclusion is unchanged, the effect size was not.
> **What survives: cadence is a COST lever, not a quality lever** — at matched peak the sawtooth spent
> 360k tokens with 5 evictions vs 409k with 32. Full analysis: `report-cadence-confound.{md,html}`.
> **Design rule this establishes: the outcome variable is ACHIEVED PEAK — tokens actually present at call
> time — not the nominal cap. Any future sweep must report and control for it.**
**DV3 result** (`dv3-cadence-ttl.mjs`, `results-dv3-cadence-ttl.json`; CPU-only): there is an **interior
optimum cadence**, and at it a capped window is **25–39% CHEAPER** than append-only.

| cadence (evict every N turns) | eff cost | vs append-only |
|---|---|---|
| append-only (uncapped) | 0.46M | — |
| N=1 (**the only cadence DV2 tested**) | 1.30M | **−183%** |
| N=5 | 0.43M | +5.2% |
| N=10 | 0.34M | +26.3% |
| **N=25** | **0.30M** | **+33.5%** |
| N=50 | 0.32M | +29.8% |

So **C2's strong form is falsified in simulation**: "append-only is cache-optimal" held only because DV2
mutated on every turn, the worst case. Three further findings:
- **Resumption amplifies the advantage.** With 3 TTL cold starts, append-only's cost rises 0.46M→0.57M
  (its cache-write nearly triples, 0.06M→0.16M, because it has the largest prefix to re-cache) while
  capped arms are unchanged — best capped arm improves from **+26.3% to +39.4%**. The regime long sessions
  actually live in favours the small window *more*, not less.
- **`g*` is tier-dependent, not 12.5.** At the 1-hour write tier (2.0×) cadence-5 flips from +5.2% cheaper
  to **−23.5% more expensive**; the optimum stays ~25. Re-derive per tier.
- **Cadence is a new tunable the assembler should expose** (it is not in the spec today).

**Still owed:** this is SIMULATED on a synthetic uniform session, eviction drops the OLDEST units (the
maximally cache-destructive choice — dropping late-position units is cheaper but they are the most
relevant), and **cost says nothing about task success** — a cadence that is cheapest may evict content the
task needs. Pair with the live arm before promoting; the live run also gives the first empirical check of
`g*`, which remains pure algebra.

*(original framing follows)*
**Hypothesis:** a deliberately small window with **infrequent** eviction beats a large fully-cached one,
because mutation is charged **per-mutation** while the read discount accrues **per-turn**. Evicting every
`N` turns wins when `N·r·(C_large − C_small) > w·S` (S = invalidated suffix). DV2 only ever tested `N=1`,
the worst possible cadence, so its "append-only wins" headline does **not** generalise.

- **One variable: eviction cadence `N`** ∈ {1, 5, 10, 25, never}, at a fixed small window, against an
  uncapped fully-cached baseline. Also vary *where* the cut lands, since `S` (the invalidated suffix) is
  what you actually pay for — cutting late is cheap, cutting early is not.
- **Metric: cache-adjusted effective cost** (cacheWrite·w + cacheRead·r + fresh) **plus task success** —
  both, because C2 established they can point in opposite directions.
- **Falsification:** if no cadence beats append-only on effective cost at equal task success, C2's
  strong form stands and small windows are purely a capability lever, not a cost one.
- **Do it with real cache accounting, not only the simulator** — providers return
  `cache_creation_input_tokens` / `cache_read_input_tokens` per response, so a live arm is cheap and would
  give the first empirical check of `g*` (C3), which is currently pure algebra.

### 12. Cache-state-aware assembly — a RE-CACHE PENALTY signal for the assembler *(attacks C2/D5)*
**Observation that motivates it:** the spec's rule "nothing reorders the cached prefix" is stated
unconditionally, but its *cost* is conditional. When a session resumes after the cache TTL has expired
(1 hour on subscription, 5 minutes on usage credits) **the entire prompt re-caches at write rate anyway**
— so at that instant prefix-preservation buys nothing, and the assembler is free to reorganise at zero
incremental cache cost. Today it obeys the constraint blindly and forfeits that opportunity.

- **Mechanism:** feed the assembler a cache-state signal — warm/cold, TTL remaining, and the observed
  hit ratio from the previous response's `cache_read_input_tokens` vs `cache_creation_input_tokens`
  (Claude Code already surfaces exactly this: "*N requests · X% of input tokens from cache · M misses*").
- **Policy under test:** *warm* → strict append-only, preserve the prefix religiously (C2's regime).
  *Cold / miss detected / TTL about to expire* → do a **full re-optimisation**: re-rank by reference
  recency, drop everything past `g*`, compact, re-order, re-emit breakpoints. One write is paid either
  way, so take the best possible layout for it.
- **Arms:** (a) always append-only (today), (b) always re-optimise, (c) **cache-state-gated** (the
  proposal). **Metric:** effective cost across a session that includes at least one resumption gap, plus
  task success after the gap.
- **Falsification:** if (c) does not beat (a) on effective cost across a resume boundary, the signal is
  not worth the plumbing.
- **Why this is likely the highest-value item here:** it converts a hard architectural constraint into a
  conditional one, and resumption-after-a-gap is the *normal* way long sessions are used — the regime the
  project is ultimately about. It also subsumes the "admission must fire at a multi-turn cadence" note in
  item 1: cadence and cache state are the same lever.

### 13. Which units are ALWAYS worth keeping? — head composition and the anchor *(cheap, high-leverage)*
The assembler already encodes an "always keep" set: the **frozen head** (system + steering/CLAUDE.md +
**every** user prompt, append-only, never evicted) plus the **recency anchor** `A` (last A units). Neither
half has been tested.

- **Economics first:** the head *is* the cached prefix, so holding it costs `r` per turn while changing it
  invalidates everything after it. Keeping it is cheap; the pressure only appears once the head alone
  approaches the budget — which a long session guarantees, since user prompts accumulate forever.
- **Q1 (head overflow):** must the head keep *all* user prompts verbatim, or can older ones be folded /
  summarised once `head > f` without losing task success? This is the spec's open "head-overflow fallback"
  gap. Arms: keep-all (today) / fold-oldest / summarise-oldest / drop-oldest.
- **Q2 (anchor size):** `A=4` was introduced as a read-loop guard and **never swept**. Arms: A ∈ {1,2,4,8}.
  Interacts with item 2 — a larger anchor is partly redundant with reference-recency selection, since the
  most-recent units also have the lowest idle.
- **Q3 (steering):** is CLAUDE.md-class steering needed every turn, or only at phase boundaries?
- **Metric:** task success + cache-adjusted cost on the `longbuild` substrate (C1). Cheap because arms
  differ only in head construction; no new task needed.
- **Falsification:** if folding old user prompts costs task success, the unbounded head is justified and
  the guarantee must instead be bounded (`head < f`) by construction.

## Deployment task (not an experiment, but needed for the vector arm to run)
The vector/embedding arm — of both `ensembleRetrieve` and the `chunk` reducer's optional RRF fusion —
is embedder-agnostic and currently BM25-only in the synchronous paths. Implement the local MiniLM-class
`SummaryEmbedder` (needs a native dep) so the vector arm is available; the remote `text-embedding-3-small`
was NOT-CARRIED-FORWARD (early remote gate failed). Until then every retrieval path degrades to BM25,
which is the intended, tested fallback — this unblocks the ensemble, it does not fix a regression.

## Open research questions (bigger than any single subsystem)

1. **Read-loop B / the resource bound (biggest unsolved thing).** `report-integration.md` found two
   read-loops: A (working-set thrashing) is fixed by the footprint reducer; **B (behavioral indecision
   under a restricted toolset) reproduced on both the 8.2K and 27B models and is NOT fixed by the
   middleware.** The honest limitation. The paper needs a progress mechanism (completed-steps ledger /
   a "stop reading and act" signal) — the `resource bound (OPEN)` section. First probe: inject a
   completed-steps ledger into `experiments/coding-harness/integration-full.mjs` and re-run on both models.
2. **A clean `integration-full` number.** The loop is confounded (restricted tools → loop B; realistic
   tools → grep self-heal). Design a loop task where cross-turn retention is genuinely required with no
   re-read escape — this doubles as the substrate for attention-over-history (item 1 above).

## Remaining spec-doc gaps (cheap doc edits, not research)

From the last audit — write a defensible default into `algorithm.md` for each: priority decay law
(suggest exponential, half-life ≈ `A`); unit-embedding reduction (mean-pool of the unit's chunk
embeddings); head-overflow fallback (fold oldest user prompts, or bound the guarantee to head < f);
root-node role at assembly (emitted band vs bookkeeping); pinning mechanism (head-only, or specify it).

## Key file map

| Path | What |
|---|---|
| `reports/algorithm.md` | the spec (start here) |
| `reports/algorithm-notebook.md` | archive / rationale / rejected paths |
| `reports/metrics/harness-deletion-and-hypothesis-register-report.md` | the hypothesis register + the deleted-harness story (why so much is "untested") |
| `reports/metrics/coding-harness/report-integration.md` | the two-read-loops finding |
| `reports/metrics/{assembler-weighting,assembler-flex-buffer,rung-0b-topic-shift,online-segmentation}/` | eviction / assembler / classifier provenance |
| `reports/metrics/{rung-0e-retrievers,rung-2-retriever-live,ds-star-*}` | retrieval provenance |
| `experiments/coding-harness/middleware.mjs` | best-of-breed middleware (RRF reducer + drift classifier + D-EV assembler) |
| `experiments/coding-harness/integration-full.mjs` | end-to-end loop harness |
| `experiments/{assembler-weighting,online-segmentation,rung-0-assembler,rung-0e-retrievers}/` | the settled-result experiment code to port |
| `packages/core/src/attention/` | untested attention-over-history code to MOVE to experiments |
| `packages/cli/test/fixtures/claude-code-session-4.jsonl` | saved session transcript (test corpus) |

**Local models** (`http://127.0.0.1:8888/v1`, "switch model by request" on): Qwen3.8-27B (thinking via
`chat_template_kwargs.enable_thinking`), Qwen3.8-Flash-Next (8.2K hard window — the overflow stressor),
Muse-Glimmer-30B (131K). Set with `CT_LOCAL_MODEL=...`.
