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
| Soft floor `f`, recency anchor `A=4` | UNTESTED / default guard | Keep as parameters, marked untested |
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

**Done and verified (all green — core suite 632 passed / 9 skipped, `tsc -b` clean). Commits on
`live-model-retriever-probes`: `5cfdfe3`, `08fa1ab`, `654c029`:**
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
- ✅ `Zone` contract widened (`head|flex` added, `A|B|C` kept + marked SUPERSEDED); `ZoneAssembler`
  marked SUPERSEDED-pending-removal in-code.

**Remaining execution order — the two integration steps now CONVERGE on the store-adapter:**
The assembler swap and the `context_search` rewiring were both blocked on the same missing piece: a
**flex store-adapter** turning store nodes into the `FlexUnit`s / L0-unit corpus the new code consumes.
That is now the single next step; everything else follows it.
1. **Flex store-adapter (the convergence point).** Source units from `nodesInCreationOrder` /
   `currentSummary` / `trace`; run the drift classifier over L3 embeddings (degrade to lexical-only
   drift when an embedding is absent, so it is not hard-blocked on the embedder); expose the same
   unit list as (a) `FlexUnit`s for `assembleFlex` and (b) the `EnsembleUnit` corpus for `ensembleRetrieve`.
2. **Rewire `context_search`** onto `ensembleRetrieve` (using the adapter's corpus); retire the
   `TreeRetriever` rank path; migrate `retrieve.test.ts` / `providers.test.ts` / `mcp.test.ts`.
3. **Reduce-on-overflow router** (chunk vs summarize, default chunk) — reducers settled; router flagged.
   Implement the per-unit budget `b` and wire it into `assembleFlex` (the flagged gap there).
4. **Complete the assembler swap**: generalize `toMessages`/`toCompletionRequest` to `head|flex|tail`;
   migrate `assemble`/`cache`/`budgets`/`e2e` tests onto the flex adapter (preserving their real
   cache/pipeline coverage); delete `ZoneAssembler`; narrow `Zone` to `head|flex|tail`; rename the
   `BudgetReport` zone fields (`head`/`flex`).
5. **Deployment / validation follow-ups** (do not gate the swap): add the local MiniLM `SummaryEmbedder`
   implementation (needs a native dep); run the transcript-corpus RRF validation + sweep `RRF_K`/chunk
   size; refit the eviction coefficients; run the drift classifier's corrected permutation test.

## Untested-hypothesis experiment backlog

Each survivor needs its own `experiments/<name>/` folder + report before any package promotion.

### 1. Attention over history (highest-value survivor) — `experiments/attention-over-history/`
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

### 2. Coefficient tuning for the eviction score
The `2/1/0.5/−1` weights are hand-rounded; the sweep optimum was `[rec .5, rel 0, prio .5, refrec 1]`
and LR rates were `prio 4.12 ≫ rec 2.42 ≈ rel 2.37 > refrec 1.04`. Re-fit on more sessions,
cross-session-validate, before any value is hardcoded as canon. (`assembler-weighting/`.)

### 3. Drift classifier — corrected validation
Re-run the permutation test with the corrected held-out condition (the pre-reg tail was reversed);
the topic-shift half is deterministic and falsifiable on its own terms. (`rung-0b-topic-shift/report.md`.)

### 4. Reduce-on-overflow **router** (auto-select)
The reducers are settled; the query→reducer heuristic that *chooses* chunk-vs-summarize is not. Test
router pick-accuracy vs an oracle over the query set. (`coding-harness/report-buried-detail.md`.)

### 5. RRF ensemble on the **transcript** corpus (confirm-and-tune, post-promotion)
RRF is promoted on its code-corpus win + ensemble robustness; this experiment confirms transfer and
tunes the provisional params. Re-run the rung-0e/rung-2 methodology on chat-history / L0-unit chunks;
sweep `RRF_K` and chunk size; check which component leads on prose. Not a gate on promotion.
(`rung-0e-retrievers/`, `rung-2-retriever-live/`.)

### 6. Priority channel / `evictRederivable`
Re-gate with query fingerprints first (params proven inert without them), then measure *effect*, not
just that the mechanism fires. (`harness-deletion-and-hypothesis-register-report.md` §6.)

### 7. Soft target `f` and structural retrieval unit (HR1)
`f` (25–50% of W) is untested on a genuinely overflowing session; HR1 (retrieval unit wrong for
structural turns) needs the excerpt-vs-whole-structural-payload ablation. Both unrun.

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
