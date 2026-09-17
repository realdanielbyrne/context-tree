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

### Harness state (2026-09-17) — read before citing any pass rate

- **The SWE-bench harness is sandboxed.** `swebench-opencode.mjs` runs opencode under bubblewrap: no
  network (the model is reached through a key-injecting relay), and the dataset, `repos/`, `wscache/`,
  other runs and the operator's home are hidden. A per-run preflight is recorded in `cell.sandbox`;
  `CT_SANDBOX=0` turns it off and says so in the manifest. **Pre-sandbox pass rates — T13, T14,
  `baseline-swift` — are contaminated** (agents read gold patches from the host and, in one run, from
  PyPI) and must not be cited as clean. See memory `swebench-harness-leak`.
- **The clean local baseline is 19/30** (Swift NVFP4, 3 repeats,
  `results-swebench-opencode-baseline-swift-sbx-x3.json`): 3/3 on pytest-7205, requests-1142,
  sklearn-14894, pytest-8399, django-11138; 2/3 on sklearn-14983 and xarray-6721; **0/3** on
  pylint-4970, django-14034, xarray-6992. 6 of 30 runs peaked above 100K and 4 compacted.
- **Swift is the baseline model, decided on a like-for-like run.** The non-Swift
  `unsloth/Qwen3.8-27B-GGUF` (UD-Q8_K_XL) scored **the same 19/30** over its own 3 repeats
  (`results-swebench-opencode-baseline-q8-sbx-x3.json`, same sandbox, same 151,040 window, same 4
  slots) and agreed with Swift on 8 of 10 problems — the same 5 always solved and the same 3 never
  solved, differing only on sklearn-14983 (1/3 vs 2/3) and xarray-6721 (3/3 vs 2/3). At equal
  accuracy Swift is the cheaper instrument: median peak 45.6K vs 61.9K tokens, 312 s vs 416 s,
  19.5K vs 31.3K output tokens, 52K vs 95K reasoning characters. **Those three never-solved problems
  are a property of the 27B class here, not of a quantization** — which is what makes them the
  headroom U18's arms have to move.
- **`assembleFlex` has no production caller.** The migration put eviction, drift, the flex assembler
  and the RRF retriever in `packages/core` and rewired `context_search` to `ensembleRetrieve`, but
  nothing calls the assembler on a live turn: the host owns the prompt. The harness sidecar
  (`experiments/context-dedup/ct-sidecar.mjs`) plus the transform plugin are what make the assembler,
  classifier, eviction and retriever run together, and they live in `experiments/` because the
  triggers they exercise are hypotheses, not settled results.
- **opencode 1.18.31 seam facts**, verified against the installed binary: the assembly hook is
  `experimental.chat.messages.transform` and it is **in-place only** (`output.messages = …` silently
  no-ops); the system prompt, skills and MCP instructions are assembled *after* it, so they are out of
  its reach; the same hook fires a second time on a clone of the compaction head with an empty `input`,
  so the two calls are indistinguishable unless compaction is off. `--pure` disables external plugins
  (so an arm-bearing run must not pass it) but **not** MCP servers. `compaction.auto: false` disables
  host compaction and makes a genuine overflow a hard session error. A plugin registering only
  `chat.params` hung opencode at init in this repo's own run — avoid that hook.
- **RRF is BM25-only everywhere** until the local MiniLM embedder lands (still the open deployment
  task): `packages/mcp/src/bin.ts` builds the retriever with no embedder, so `context_search` always
  reports `fallback: "no-embedder"`.
- **D21** (new decision): a shell-shaped tool is phased by its **command**, not its name. `bash` was
  665 of 1,247 tool calls on the baseline and everything shell-shaped mapped to `other`, so 53% of the
  trace sat in the neutral bucket; applying the rules takes segmentation from 144 to 258 phases across
  the same 30 runs.

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
  > ⚠️ **Now partially contested — see §B U2/U16.** The live A/B window sweep found that selection
  > on **reference recency alone** beat positional recency and a volume-matched random control at a tight
  > cap, and the original offline sweep optimum already ranked ref-recency *highest* (1.0) while D-EV
  > ships it *lowest* among the positive terms (0.5). The *relevance≈0* finding is untouched; what is in
  > question is whether the other three terms earn their place over pure LRU-at-`g*`. Do not treat the
  > 4-term score as canon until U2 resolves. `report-ab-longbuild.md`.
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
| Soft floor `f`, recency anchor `A=4` | **`f` now contested** (DV2: evicting to a soft floor below the window converts 0.1× reads into 1.25× writes; measured hot set swings 0.4–35k, so a fixed fraction is the wrong shape) / `A` untested | Keep as parameters, marked untested; **`f` pending §B U8** |
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
  would auto-pick chunk-vs-summarize is deliberately NOT built — it is untested (§B U11). New
  tests: `reduce.test.ts` (13) + reduce-on-overflow cases in `flex-assemble.test.ts` (5). Full suite
  green (32 files, 657 passed / 9 skipped); `tsc -b` clean.

**The package↔spec migration is complete.** `packages/` now reflects only settled experimental results:
retrieval (RRF ensemble), classifier (drift), eviction (D-EV), assembler (flex head + creation-order
buffer + reduce-on-overflow), and the store-adapter that feeds them. What remains is not migration work —
it is the hypothesis register (§A tested, §B untested) and parameter sweeps, below.

## Hypothesis register

Every cross-cutting claim this project has made lives in one of the two sections below.

- **Tested** (§A) — a hypothesis that has been run. It carries a verdict and a report. Do not re-run
  it, and do not re-state it as an open question; if you think a verdict is wrong, attack it with a
  new hypothesis in §B that names the report it contradicts.
- **Untested** (§B) — a hypothesis nobody has run. Every entry states **the hypothesis as a
  falsifiable sentence** and **the experiment that would test it**. An entry that cannot be written
  that way is not a backlog item; it is a note, and it belongs in the standing rules or in a report.

Package-level settled results (eviction shape, flex buffer, drift signal, RRF, reducers) are listed
separately under *Settled results* above; this register covers the research hypotheses behind them.

### Standing rules that govern every entry below

These are not hypotheses. They are constraints derived from results already in §A, and every design
in §B is written to satisfy them.

1. **Sample PROBLEMS, not seeds (C0).** The entire early A/B series (51 runs) ran one synthetic task,
   `longbuild`. That is n repeats of one problem: it measures within-problem nondeterminism and says
   nothing about between-problem variance, which is the larger term in agentic coding. A `p=1.000`
   from that series means "indistinguishable **on this problem**", and more repeats cannot fix it.
2. **The substrate is SWE-bench Verified through opencode — not `longbuild`.** Per D20 evaluation runs
   in an external host. The solvability gate has passed (§A, T13), so between-problem live work now
   runs through `experiments/context-dedup/swebench-opencode.mjs` (per-run isolated XDG, `--auto`,
   `< /dev/null`, export to a file) against the pre-registered pool in
   `reports/metrics/swebench-pilot/selection-v2.json`, graded by `ab-tasks/swebench.mjs gradeDetail`.
   For hypotheses that need **multi-turn conversation pressure** rather than one task statement, use
   `experiments/scenarios/` driven by `oc-runner.mjs`, which delivers real mid-run user turns
   (`opencode run --session <id>`) and attaches arms as an opencode plugin at `tool.execute.after`.
   `longbuild` is retired as a default substrate: it was built to work around the deleted in-repo
   harness, and it is one problem. Cite it only when reproducing an old result.
   ⚠️ `--pure` disables plugins, so any arm-bearing run must not pass it; and opencode adds
   ~9,898 tokens of fixed overhead per call, so a window cap must sit well above that (the old
   `W=4,700` design is not reproducible on this host).
   ⚠️ **opencode titles every session with a small model taken from the SESSION's provider.**
   Verified 2026-09-16: runs pinned to `openrouter/...` logged `google/gemini-3.8-flash` titling
   calls although the config lists `local` first, while another session's `local/...` runs titled
   locally. Provider ORDER in the config does not decide it — the session's own model does. So a
   run is not free because a local provider is configured, every remote run carries one extra
   billed call that belongs in its cost attribution, and a local run cannot be starved by a remote
   provider's balance.
   ⚠️ **The local host does not parallelise — run local cells SEQUENTIALLY.** Measured 2026-09-16
   under four concurrent arms on the one GPU, solo → 4-way per turn: 89 → 252–419 s,
   315 → 720–2,392 s, 762 → 2,133–4,531 s, >1,200 → 7,034 s — the last at 98% of its 7,200 s
   ceiling, one step from silently truncating its cell. Effective throughput was
   ~1.4 h/cell against ~1.07 h/cell sequential, so concurrency on this endpoint buys latency, not
   throughput, *and* manufactures a rule-9 failure mode: a turn that times out truncates the cell
   mid-experiment and presents as a weak arm rather than an instrument failure. Take one slot and
   leave the rest free. Parallel sharding belongs on OpenRouter, whose backends are not shared.
3. **The outcome variable is ACHIEVED PEAK, not the nominal cap — and peak is a PER-RUN DRAW, not a
   property of the problem.** Tokens actually present at call time decide outcomes (OR 41.83× per
   e-fold, arm-adjusted); the nominal cap and the eviction cadence add nothing once it is
   controlled (T5). Measured on the 2026-09-16 baseline — 10 SWE-bench problems, 3 repeats each,
   nothing varied between repeats — achieved peak spread **1.16×–2.90× within a problem**
   (median 1.87×): pylint-4970 solved the same issue in 29 steps at 37,496 tokens and in 53 steps
   at 82,230; django-14034 ranged 56,874–165,084 over 33–90 steps. **Outcomes were stable while
   trajectories were not**, so "does a cap bind on this problem?" has no single answer — a cap in
   that band binds on some repeats and not others, and an arm that draws a long trajectory is
   capped harder for reasons unrelated to the arm. Consequences: pair within problem, size repeats
   to cover the spread, and never treat pressure as a per-problem constant.
4. **Match volume, unit count and splice count.** Volume matching alone is not enough: the incumbent
   evictor matches kept tokens to 0.4% while diverging up to 2× in unit count and 13× in splice
   count (T8). An arm can win by fragmenting the transcript less.
5. **Prefer continuous endpoints.** Binary pass/fail discarded a real, continuous improvement in the
   ballast run (0 → 7 files written, still no pass) (T6/T7). Offline, screen candidates against
   leave-one-unit-out ΔNLL (`experiments/attention-over-history/measure.py`) before spending a live
   token; the instrument costs ~0.11 s per unit.
6. **State micro- vs macro-averaging.** The two disagree on the *sign* of the recurrence contrast at
   11 of 16 cells, and at every cell under the clock the published result used (T9).
7. **Audit the turn clock.** The transcript clock counted JSONL content-block lines, not API turns
   (2.2× inflation). Any turn-denominated parameter (`K=5`, `H=3`, `A=4`, `D`, `g*`) inherited from an
   earlier experiment is measured on the wrong clock until re-checked.
8. **Compare within an endpoint.** The local quantized GGUF and OpenRouter bf16 are different weights.
   Record `provider.order`, `quantizations` and `limit.output` per run; the local host reports
   `reasoning_tokens: 0` while reasoning, so measure reasoning from transcript reasoning parts.
   **And on the local endpoint `tokens.output` BUNDLES reasoning** — the tokens are not missing, they
   are reattributed, which is harder to catch than a zero because nothing looks wrong. Measured on the
   django-11138 local rerun: `tokens.output` sums to **53,059** across 86 assistant messages while all
   non-reasoning text in the export is **6,442 chars** (~1.6–2.8k tokens) and `tokens.reasoning` is 0
   on every message; only the 114,067 chars of reasoning can account for the rest. The same problem run
   through OpenRouter reports reasoning **separately** (16,705) and excludes it from `output` (274).
   So never read local `output_tokens` as content — a token-savings claim resting on it overstates
   content by about an order of magnitude — and do not estimate reasoning tokens as chars÷4: the
   implied ratio on this corpus is ~2.3 chars/token, so chars÷4 *understates* the reasoning share.
9. **Assume failures present as CLEAN RESULTS.** The expensive defects on this project do not raise
   errors — they return a plausible-looking run, and every one of them cost real runs before it was
   found. Measured instances: a step spends its entire output budget on reasoning, emits no tool call,
   and **opencode exits 0** (django-11138, scored as a model failure until the cap was found); local
   slot exhaustion presents as a silent hang at init with no session, no error and no log line; a
   piped `opencode export` truncates mid-string (222KB → 146KB) so every token count reads 0; a
   missing API key yields a 3-second, 0-token cell indistinguishable from task failure; and the
   in-repo harness clipped tool output at 2,000 chars, producing a 0/6 edit rate that was 5/6 at
   30,000; a **wall-clock timeout killed a run that had already solved its problem** (django-11138,
   77 steps, F2P and P2P both passing, 7 files edited, cut at the harness's own 3,600 s ceiling —
   the same class of defect as the 16,384-token output cap that invalidated that same problem in
   the pilot, and django-14034 reached 91% of the ceiling); and a provider error reading
   **"would exceed your available credits"** arrived while `/api/v1/key` reported $135.50
   remaining — that endpoint reports the KEY's spending cap, not the account balance, which was
   **$0.15** (`/api/v1/credits`: 100 purchased, 99.85 used). Read `/api/v1/credits`, never
   `/api/v1/key`, before concluding funds are available. **Therefore:** every runner records
   per-step finish reason, largest response, export bytes
   checked against the event stream, and wall-clock; and **any cell whose outcome is "the agent did
   nothing" is an instrument failure until proven otherwise.** T7 is the canonical case of getting
   this backwards — two validity conditions passed on a run where the control never attempted the task.
   **Retrospective check, and it costs nothing:** an opencode export carries a per-message `finish`
   alongside `tokens.{input,output,reasoning,cache}`, so any past run can be audited for a ceiling it
   actually hit without extra instrumentation. Audited across all 16 pilot exports, the event-stream
   counts and the export agree everywhere, and the one invalid cell reads
   `finish: "length"`, `output: 0`, `reasoning: 16,384` — the entire budget went to reasoning and **not
   one output token was emitted**. Note also that the local endpoint reports `reasoning: 0` in the
   export too, not merely in `usage`, so on that endpoint reasoning must be measured from the
   reasoning parts' text. The *requested* limit is recorded nowhere; only the ceiling that was hit is
   recoverable.

10. **Pre-register the EXCLUSION policy before any cell finishes, and then check exclusions for
   asymmetry.** Dropping a broken cell feels like discarding noise; it is usually discarding
   evidence. Failures are rarely arm-independent — an arm whose turns run longer times out more
   often, so excluding its truncated cells keeps only its fastest survivors and biases the
   comparison **in that arm's favour**. The gates, fixed in advance (adopted from a peer session
   that committed them with zero cells finished, so the record shows they preceded any result):
   an arm with fewer than 2 usable cells gets **no verdict** (insufficient); more than 25% of all
   cells excluded → **descriptive only**, no keep/drop decision; exclusions uneven across arms
   (max − min ≥ 2) → **descriptive only, do not pool**, because that asymmetry is itself a finding
   about the arm that truncates rather than noise to be removed. Choose the thresholds before
   seeing which arm the failures landed in. Deciding afterwards is the defect this project has
   already paid for twice — T4's n=3 story that inverted, and T7's control that passed two validity
   conditions on a worthless run.
11. **Verify the intervention actually FIRES before running arms. A null by construction is the
   dangerous kind.** An arm that never triggers is *identical* to its control, so any difference
   between them is pure nondeterminism — and against this substrate's 1.16–2.90× trajectory spread
   (rule 3) that noise can present as a large, clean effect. Measured 2026-09-16 by a peer session: a
   re-reference intervention fired **0 times in 41 turns** (19 reads over 18 distinct files; exactly
   one file read twice), so all four of its arms were the same experiment and were stopped rather than
   reported. **The cause was a fix, which is why nobody saw it coming:** splitting the task into six
   focused turns is what finally made the agent *complete* the work (29/40, core 12/12, trace 8/8),
   but a focused turn gives the agent no reason to re-consult anything. **Completability and
   re-reference pull against each other on this substrate** — the single-message version re-read
   constantly and built nothing; the six-turn version builds correctly and never re-reads. Before
   committing to arms, measure the trigger rate on ONE cell and report it; near zero means the
   experiment is not ready, whatever the arms would have shown. This bears directly on §B U4
   (admission has nothing to admit if nothing is needed twice) and U5 (MCP tools that are never
   called make the arm null), and it is the §1 check-5 gate of the experiment-report skill.

---

## §A. Tested hypotheses

| # | Hypothesis (as tested) | Verdict | Evidence |
|---|---|---|---|
| T1 | With a full tool set an agent re-fetches rather than retains, so window pressure is long-horizon and comes from conversation history, not from file content | **supported** (live, 3×) | `context-dedup/report-{ab-rule-chain,tier2-selfheal}.md` |
| T2 | Position in the window degrades retrieval (lost-in-the-middle / RoPE decay) | **rejected** on this model to 155,773 tokens | `context-dedup/report-position-probe.{md,html}` |
| T3 | Prefix mutation costs ~12.5× a read, so append-only is cost-optimal below the hard window | **rejected in its strong form** — true only at cadence N=1 | `context-dedup/report-{dv2-cache-cost,dv3-cadence-ttl}.md` |
| T4 | Reference recency (idle) beats positional recency as an eviction signal | **rejected** (pooled p=1.000) | `context-dedup/report-ab-combined.{md,html}` |
| T5 | A small window with infrequent eviction beats a wider flat window on task success | **retracted → null** once achieved peak is controlled (p=0.54) | `context-dedup/report-{cadence-confound,window-metric}.{md,html}` |
| T5a | The eviction trigger belongs at the HARD limit, not a soft floor (the 2026-09-14 change to `assemble/flex.ts`) | **contested — C0 evidence**; the spec block recording it ends "Single-problem evidence". Re-opened as U18 (soft limit) and U19 (cadence) on the 10-problem harness | `assemble/flex.ts:59,87`; `reports/algorithm-notebook.md` |
| T6 | More context is monotonically better | **rejected as stated**; more *organic* context is better | `context-dedup/report-{sensitivity-control,window-metric}.{md,html}` |
| T7 | A ballast positive control can show whether the pass/fail harness detects composition | **void** (the control stopped attempting the task); superseded by T8 | `context-dedup/report-sensitivity-control.{md,html}` |
| T8 | Choosing *which* units to evict has a large ceiling under volume matching | **supported** — 96% of random's damage is avoidable; incumbents claim ~18–25% | `attention-over-history/report-attention-over-history.{md,html}` |
| T8b | Measured attention beats position as the selection signal by ≥0.10 | **not met** (pooled +0.105, per-decision median +0.037) | same |
| T9 | The shipped priority term's hardcoded 2:1 edit:recurrence ratio is wrong and unablatable | **rejected** — no ratio in the informative range beats 2:1 | `covariance-eviction/report-covariance-eviction.{md,html}` |
| T10 | File-keyed temporal covariance predicts dormant returns | **not testable** on agent transcripts (support 49.0% vs a 55% gate) — recorded untested, not refuted | same |
| T11 | Identifier-keyed contextual covariance keeps dormant units better than the incumbents | **mixed** — beats the volume-matched random floor and holds across the dormancy gradient; pre-registered primary vs relevance not met | `covariance-eviction/report-contextual-covariance.{md,html}` |
| T12 | Replacing resident tool-result bytes with a referential anchor is a deployable cost lever | **rejected** (0.22% of real spend vs a 10% bar) | `context-dedup/report-{dv4-anchor-dedup,anchor-investigation}.md` |
| T12b | The *reference*, not the withholding, is what changes behaviour | **supported** (+27.8pp over a character-identical placebo, p=0.0063) | `context-dedup/report-anchor-replay.md` |
| T13 | SWE-bench Verified through opencode is a usable substrate — solvable, and it reaches window pressure | **supported** — 7/9, 5/7 above 32,768 tokens | `swebench-pilot/report-swebench-pilot.{md,html}` |
| T14 | The baseline configuration is stable and repeatable across identical repeats | **outcomes yes, trajectories NO** — 8/10 problems unanimous over 3 repeats, but achieved peak varies 1.16–2.90× *within* a problem | `swebench-pilot/report-baseline.{md,html}` |

**T1 — pressure is long-horizon.** Measured three independent times: with `run_bash` available the
model `cat`/`grep`s exactly what it needs, peak context stays ~830–1,035 tokens, `evict=0`, and every
arm collapses to an identical trace. Anything on disk is re-fetchable; the only context a tool call
cannot recover is the conversation history itself. **Consequence:** no short synthetic task can test a
window policy with full tools, and removing tools to force the issue is not ecological. This is why
rule 2 exists — the fix is a long-horizon *real* substrate, not a longer synthetic one.

**T2 — position is not a lever.** Needle-in-a-haystack, 180/180 across both stages, every depth
(0/25/50/75/100%), out to 155,773 real prompt tokens with 7 competing distractors sharing the needle's
framing. With zero failures the 95% one-sided bound excludes a position-dependent failure rate above
3.3% pooled (15.3% at a single depth — it excludes a large effect, not a small one). Two consequences:
the policies' inability to express position costs nothing here, and "present but buried too deep"
is eliminated as an alternative explanation for window-cap failures — that content was evicted.
*Limits:* single-turn retrieval of a lexically distinct sentence, one model.

**T3 — append-only is not cost-optimal; cadence is the free variable.** DV2 mutated the prefix on
every version swap, i.e. cadence N=1, the worst case. Mutation is charged per-mutation while read
savings accrue per-turn, so evicting every N turns wins when `N·r·(C_large − C_small) > w·S`. DV3
finds an interior optimum: N=25 is 33.5% cheaper than append-only (N=1 is 183% worse). Resumption
amplifies it — with 3 TTL cold starts append-only's cost rises 0.46M→0.57M while capped arms are
unchanged, improving the best capped arm from +26.3% to +39.4%. The multiplier is tier-dependent: at
the 1-hour write tier cadence-5 flips from +5.2% cheaper to 23.5% more expensive. **Still simulated**
on a synthetic uniform session, with eviction dropping the oldest (most cache-destructive) units, and
cost says nothing about task success — the live arm is U1.

**T4 — which ordering signal you use matters less than having one.** At n=3 reference recency looked
like a 3/3-vs-1/3 win with a coherent mechanism (halved re-reads); at n=10 the effect vanished and the
mechanism inverted (pooled re-reads 7 vs 4). Pooled: idle 7/13, truncate-tail 6/13, **p=1.000**. What
survives is weaker and different: both signal arms vs random, 13/26 vs 2/13, **p=0.045**; individually
neither clears 0.05. **Methodological note worth keeping:** the cheap version of this experiment would
have shipped a false finding; the pre-registered falsification and paying for n=10 is what caught it.

**T5 — the sawtooth win was a measurement artifact.** `ab-window-sweep.mjs:75` fires eviction only
every N turns, so at N>1 nothing enforces the cap between events: the nominal W is an eviction
*trigger*, not a window, and the N=10 cells actually sent 7,657-token prompts — larger than the flat
W=7,500 arm's 6,977. Regressing 78 capped cells: given achieved peak, cadence adds nothing (p=0.54)
and nominal W adds nothing (p=0.66), while achieved peak given cadence is decisive (p=0.0002, OR
41.83× per e-fold, arm-adjusted). What survives is that **cadence is a cost lever, not a quality
lever**: at matched peak the sawtooth spent 360k tokens with 5 evictions vs 409k with 32.

**T6 — width is not sufficient.** The window sweep's "more context is better" law was fitted entirely
on runs whose context was the agent's *own organic content*. Breaking that regime broke the law:

| run | context sent | outcome |
|---|---|---|
| `uncapped-clean` (no cap, no duplicates) | 18,650 | **PASS**, 17 files written |
| `uncapped-ballast` (no cap, duplicates) | **51,141** — the largest context in the dataset | **FAIL**, 0 files written |

Composition matters; the honest statement of the width law is *more organic context is better*.

**T7 — the sensitivity gate is closed, but not the way it was designed to be.** The ballast control
was void: `oracle` 0/10 vs `random` 0/10 is not a null, because the control wrote zero files in 10 of
10 runs — it stopped attempting the task rather than performing it badly. Two pre-registered validity
conditions passed on a worthless run; a third (*the control must still be attempting the task*) has
been added and now fires automatically. Review separately established the design could not have
answered its question anyway: the oracle's advantage flowed through useful-token *volume*, the effect
already known, while the nulls it was meant to adjudicate were measured at matched volume. **The
question it was gating — can selection matter at all — was then answered by T8, which is
volume-matched by construction and continuous.** Do not redesign the ballast control; cite T8.
*Method finding banked:* two earlier ballast designs (fabricated tool calls, then user-role pastes)
**derailed** the agent rather than taxing it. Injecting foreign material into an agent's context
changes what the agent does — a warning for any middleware that synthesises context.

**T8 — the prize is large and mostly unclaimed.** Rather than compare two candidate rules again, this
measured the ceiling: for each decision point, delete every unit in turn and record how much harder
the agent's actual next message became (leave-one-unit-out ΔNLL), then build an oracle that evicts on
those measured values. Because the oracle is volume-matched, its margin is an upper bound on what
*any* rule scoring units independently could achieve. Across 86 volume-matched cells from 60 decision
points in 4 sessions, the oracle caused 0.081 nats/token less damage than random and 0.067 less than
recency — 13× and 11× the numerical floor of 6.3e-3 — with all 4 session clusters agreeing in sign.
Choosing well removes **96%** of random deletion's damage; the shipped recency rule captures **18%**
of that and attention **25%**, leaving ~75% unclaimed. At the 30% keep-fraction the oracle's ΔNLL is
*negative*: deleting low-value history is better than deleting nothing, making eviction a quality
mechanism and not only a way to fit a window. **This inverts the reading of the five prior nulls: the
bottleneck is the signal, not the opportunity.** The attention hypothesis itself: F0 passes (signal
not inert, not relabelled recency), F1 passes (deleting high-attention units is worse), **F2 does not
pass** (margin ≥+0.10 required; pooled +0.105 but per-decision median +0.037, 33/60 points), F3 right
direction. *Limits:* one 1B model, 4 clusters, teacher-forced replay; the transfer to the 27B is
untested (U7), and the oracle bounds unit-independent ranking only (U6).

**T9 — the 2:1 priority constant is vindicated, and a redundancy appeared.** The recurrence advantage
replicates on its own corpus under the corrected clock (the earlier analysis counted one turn per
transcript line, 2.22× inflation): +0.1714→+0.1675 and +0.0999→+0.0582 at M=64. Sweeping the ratio the
shipped code cannot express, **no value beats the shipped one**, so the hardcoded constant is a
defensible default and this objection to it is closed. The unplanned finding: measuring what the
shipped term actually ranks by, the priority term is strong (AUC 0.814, second only to
reference-recency's 0.886) but its ordering correlates **0.835** with reference-recency — above the
0.8 this project uses to call one signal a relabelling of another. The four-signal scorer may be
counting reference-recency twice (→ U2).

**T10 — file-keyed temporal covariance is not testable here, and probably not anywhere.** A pairwise
statistic needs two units active together, but agents name files one at a time: 19.9% of
file-referencing turns name two or more. Across every corpus available and episode windows from 1 to
20 turns, support peaks at **49.0%** against a pre-registered 55.0% gate, and the median candidate
pair has never been co-active at any setting. Recorded **untested, not refuted** — and the structural
reading is that *any* pairwise co-reference signal should be checked against this property before it
is built. (Superseded in practice by T11, which re-keys the statistic.)

**T11 — contextual covariance holds where the incumbents collapse.** Re-keyed from file paths onto
identifiers, support rises from 6.1% to **84.3%**. As "dormant" is made stricter (10 → 50 turns since
a unit's files were touched) positional recency falls 0.403→0.0138 and reference-recency 0.2764→0,
while covariance is nearly flat, 0.365→0.3022 — it is the best of six signals from D=20 onward and
beats a volume-matched random control at every depth to D=35. The decisive controls pass: it is not
relevance renamed (rank correlation 0.0231), and the advantage survives stripping every path-bearing
token. **What does not pass is the pre-registered primary as written** — beat *relevance specifically*
at M=32, D=10: it misses in the identifier space (+0.0517, [−0.0042, +0.1085]) and fires only in the
lexical space, which is the one space where covariance does not beat the random floor. Verdict: a real
signal with a mechanism that behaves as theorised, not an established improvement over the incumbent
it was pre-registered against. It is a **specialist** — well behind recency on the full label — so any
deployment is as an added protective term for dormant units (→ U3), never as a primary ordering.
*Also established:* the dormancy threshold D had been inherited unexamined across three experiments,
and sweeping it changed which signal wins at four of six values. D must be swept, never inherited.

**T12 — the anchor idea: no cost case, but the mechanism is real.** F1 (cost) is rejected: block-level
referential substitution saves **0.22%** of real token spend against a 10% bar, because duplicated file
*content* is only 5.8% of reads and read results are only 18.4% of context. The motivating "59.2% of
reads are re-reads" statistic is **path** repetition; the content equivalent is 5.8%, and any future
proposal resting on re-read frequency must say which it means. F2 (acceptance ≥70%) is rejected at
41.7% — but that threshold was unreachable: serving the full content achieves only 58.3%, and the
informative paired contrast is not significant (−16.7pp, p=0.109). **F3 is the substantive result:** the
referential anchor beats a character-identical non-referential placebo by +27.8pp on acceptance
(p=0.0063), so *what the anchor says* does the work, not the fact that content was withheld. Recall is
unharmed (86.1% vs 83.3%, p=1.0) at 10.9× fewer tokens: the resident copy is reachable and used
correctly; the model simply prefers to re-fetch when free to. What is rejected is block-level
substitution — a line-level matcher reaches 19.0% on the same corpus and is untested (→ U12).
*Threshold lesson:* both bars were set before computing what was achievable, twice. Measure the
ceiling before drawing the line.

**T13 — the substrate gate.** Uncapped, opencode 1.18.31, `openrouter/qwen/qwen3.8-27b`, thinking on,
n=1 per problem: **7 of 9** validly run distinct problems from 6 repos solved, drawn by a seeded,
difficulty-stratified rule written before any agent ran; **5 of 7** solved problems exceeded 32,768
prompt tokens (95% CI 45–94%; ~151 usable instances projected against the 13 a sweep needs). A 10th,
django-11138, was **invalid, not a failure** — our own `limit.output: 16384` placeholder cut its
reasoning off; re-run with the limit raised it solved (reported separately, not pooled). Spend ≈ $2.
**Uncontrolled variable:** the tranche used unpinned OpenRouter routing (16 backends, fp4–bf16) and
exports do not record the backend, so it is unknown per run; the entry is now pinned (DeepInfra bf16,
no fallback). **Carry forward:** do not reuse `coding-harness/lib.mjs` for SWE-bench (its 2,000-char
tool-output clip caused the v1 zero-edit result: 0/6 edits vs 5/6 at 30,000, on two endpoints);
capture stdout/exports to files, never pipes; grading uses calibrated P2P (≥90% of dataset P2P ids
passing on gold here). **Still open:** n=1 per problem, 10 problems, and hosted weights ≠ the local
GGUF every earlier live result used, so nothing here is comparable to them.

**T14 — the baseline is stable in OUTCOME and unstable in TRAJECTORY.** 10 problems × 3 repeats under
one frozen configuration (pinned DeepInfra bf16, `limit.output` 235,929, uncapped, no middleware):
33 runs launched, 28 valid, 26 passed. **8 of 10 problems solved on every valid repeat**, 1 mixed
(xarray-6992, 1/3), 1 **INSUFFICIENT** (django-11138, 1 valid run — the others lost to this harness's
own 3,600 s ceiling *after* the run had already solved the problem, and to the provider account running
out of funds; untested, not failed). The instrument was clean: 0 output-limit stops, 0 truncated event
streams, 0 external kills, 33/33 exports re-imported, and **no pass unbacked by a real code diff**.
The finding is the variance: with *nothing* varied between repeats, achieved peak moved
**1.16×–2.90× within a problem** (median 1.87×) and step counts by up to 57. Two consequences —
pressure is a **per-run draw**, so a cap inside a problem's range binds on some repeats and not others
(rule 3); and with 8/10 already passing uncapped there are at most **2** problems available to win
against a paired test needing **5**, so *no uncapped middleware comparison on this pool can reach
significance*. Also: two of T13's single-run verdicts did not survive repetition (django-14034
fail→3/3, xarray-6992 fail→1/3) — confounded with the routing and output-limit changes, so it does not
show repeats alone flipped them, but single-run verdicts on this substrate are provisional in **both**
directions. Two instrument defects found and recorded: `files_edited` counts edit-tool calls only, so
a shell-based edit reads as zero (use the diff for liveness), and diff records truncate at 6,000 chars.

---

## §B. Untested hypotheses

Each entry is a hypothesis and the experiment that would test it. Ordered by value, not by number.

> ⚠️ **U1, U8 and U9 need a PRICED endpoint (added 2026-09-17).** All three are cache-cost claims,
> and the local endpoint reports `cost=0` with no cache accounting, so `g*` has nothing to bind to.
> Do not schedule them against the local SWE-bench baseline; they need OpenRouter. The *capability*
> half of the same territory — does a soft limit hold accuracy — is U18, which the local harness can
> answer.

### U1 — Is `g* = w/r` the right place to evict, live?
**Hypothesis.** Keeping a unit costs `r·B` per turn and re-fetching it costs `w·B` once, so a policy
that evicts a unit exactly when its expected next use is beyond `w/r` turns achieves lower
cache-adjusted cost than append-only, at equal task success — and the optimum cadence is interior, as
DV3 found in simulation (T3).
**Why it is untested.** `g*` is pure algebra on published price multipliers. The 12.5 operating point
has never been validated in a live run, and it is not one number: it moves with the cache tier
(Anthropic prices the 1-hour write tier above the 5-minute one). Re-derive per tier, never hardcode.
**Experiment.** SWE-bench problems through `swebench-opencode.mjs`, paired within problem. Arms:
(a) append-only, (b) fixed cadence N ∈ {5, 25}, (c) evict-at-`g*` on measured idle. Providers return
`cache_creation_input_tokens` / `cache_read_input_tokens` per response, so cache accounting is real,
not simulated. Report achieved peak (rule 3) and solve rate alongside effective cost.
**Falsification.** If no cadence beats append-only on effective cost at equal solve rate, T3's
simulated optimum does not transfer and small windows are a capability lever only, not a cost one.

### U2 — Is `priority` just reference-recency under a second name?
**Hypothesis.** Removing the priority term from the four-signal eviction score, holding
reference-recency, does not degrade selection quality — i.e. priority contributes nothing independent.
**Why it is untested.** T9 measured a 0.835 rank correlation between the two orderings, above this
project's 0.8 relabelling bar, but no ablation has been run. The decay factor dominates the sum it
multiplies, which is the suspected mechanism.
**Experiment.** Purely offline and cheap. Score each decision's buffer with the full scorer and with
priority ablated, and rank both against leave-one-unit-out ΔNLL ground truth (rule 5). Report ΔAUC on
the transcript corpus and Δ(damage avoided) on the LOUO instrument, micro- and macro-averaged (rule 6).
**Falsification.** If ablating priority costs less than the numerical floor, drop the term — a
four-signal scorer that is really three signals is a liability, not a tuning opportunity.
**Blocks:** any coefficient re-fit. Do not tune weights in a scorer whose terms may be collinear.
⚠️ **Blocked by a wiring defect, not by cost (found 2026-09-17).** `assemble/flex-store.ts:156` sets
`lastReferencedTurn = order`, so **reference-recency IS positional recency** today, and both the
`refRecency` weight and `priorityHalfLife` decay measure what `recency` already measures. Run on a
store built that way, this ablation compares a term against itself. The harness sidecar
(`experiments/context-dedup/ct-sidecar.mjs`) supplies a real `lastReferencedTurn` — set when the agent
returns to material a unit produced — and U2 is only meaningful on runs it produced. Same defect
gates **U16**, whose whole question is whether the priority channel adds anything over
reference-recency.

### U3 — Does contextual covariance earn a place as a protective term?
**Hypothesis.** Adding identifier-keyed contextual covariance to the scorer as a *protective term for
dormant units* reduces ΔNLL damage at matched volume relative to the scorer alone, with the margin
growing as the dormancy threshold D widens.
**Why it is untested.** T11 established the signal is computable, is not relevance renamed, and holds
where the incumbents collapse — but only as a standalone ranker on a replayed corpus. Its value *as an
added term* is unmeasured, and its pre-registered contrast against relevance was not met.
**Experiment.** Offline first, against the LOUO instrument: scorer vs scorer+covariance, volume-,
unit- and splice-matched (rule 4), sweeping D ∈ {10, 20, 35, 50} (never inherited — T11). If it clears
the floor, a live paired arm on SWE-bench problems under a cap that actually binds.
**Falsification.** If the added term does not reduce damage beyond the floor at any D, covariance is
retired as an eviction signal and survives only as an admission candidate (U4).

### U4 — Does admission beat on-demand re-fetching?
**Hypothesis.** Pulling dormant-but-high-covariance units back into context at a multi-turn cadence
beats letting the agent re-fetch on demand, on task success at equal achieved peak.
**Why it is untested.** The record says relevance belongs at *admission*, not eviction (it was measured
the worst eviction signal precisely because it drops the dormant unit that later returns), but no
admission arm has ever been run. T1 says the escape to re-fetch is always available, so the arm is
only meaningful where re-fetching is expensive in turns, not impossible.
**Experiment.** `experiments/scenarios/` through `oc-runner.mjs` (real mid-run user turns), plus a
SWE-bench arm. Admitted units must **append after the buffer** — never reorder the cached prefix — and
admission must fire at a multi-turn cadence, since per-turn re-mixing is measured cache-death
(`flex-remix` 433k vs 341k effective cost). Record `cacheWrite`/`cacheRead` and report effective cost.
**Falsification.** If admission does not beat on-demand by a pre-set margin in the regime where the
buffer actually overflows, attention-as-admission is retired.
⚠️ **Measure the re-reference rate before building this (rule 11).** A peer session's re-reference
intervention fired 0 times in 41 turns on the focused multi-turn scenario: 19 reads over 18 distinct
files, one file read twice. An agent given a focused turn does not re-consult earlier material, so
admission would have nothing to admit and the arm would be null by construction. The prerequisite
measurement is cheap — count, on one cell of the intended substrate, how often the agent returns to
material it already has. If that rate is near zero, this item is not runnable there no matter how
good the policy is, and the substrate must change before the experiment does.

### U5 — Does the context-tree MCP server actually help? *(the project's headline claim, never run)*
**Hypothesis.** An agent in opencode with the context-tree MCP server attached solves more SWE-bench
problems, or solves them at lower achieved peak, than the same agent with the host's native context
handling — and the margin grows with context pressure.
**Why it is untested.** This is the D20 comparison the whole project is built to make, and **nothing
in `experiments/` wires the MCP server into opencode today**: there is no `mcp` block in
`experiments/context-dedup/opencode.json` and no MCP arm in the runner. Every result in §A is about a
*signal* or a *substrate*; none of them is about the deliverable.
**Experiment.** Wire `@context-tree/mcp` (`context-tree-mcp` → `packages/mcp/dist/bin.js`) into the
experiment-local `opencode.json` as an MCP server, add an `mcp: on|off` arm to `swebench-opencode.mjs`
(note `--pure` disables plugins, so the arm-bearing configuration must not pass it), and run the pool
paired within problem, n≥2 per cell. Primary: solve rate at matched problem set. Secondary: achieved
peak, effective cost, and MCP tool-call counts (`context_fetch`/`context_search`/`context_peek`).
**Falsification.** If MCP-on does not beat MCP-off on solve rate or achieved peak in the pressured
subset, the middleware's value claim is unsupported on this substrate and the paper says so.
**Note.** This should probably run before any further signal work: it is the only entry whose outcome
changes what the other entries are for.
⚠️ **It cannot be run uncapped — T14 settles that.** The baseline solves 8 of 10 problems on every
repeat with no middleware at all, leaving at most **2** problems where an arm could show a gain, while
a paired McNemar test needs **5** discordant problems for p = 0.031. An uncapped MCP-on/MCP-off
comparison on this pool therefore cannot reach significance however good the middleware is. The arm
must run under a cap that binds — and because achieved peak is a per-run draw (1.16–2.90× within a
problem), the cap must be chosen against the *distribution* of peaks rather than a problem's median,
with repeats sized to cover that spread. Budget for it: the baseline alone cost $13.20 for 33 runs.

> ✅ **That blocker is VOID — the 8/10 baseline was contaminated (corrected 2026-09-17).** T14's
> agents read the gold patch from the host and the network; the sandboxed re-run of the same 10
> problems (local Swift, 3 repeats, `results-swebench-opencode-baseline-swift-sbx-x3.json`) solves
> **19 of 30**: 5 problems 3/3, 2 at 2/3 (sklearn-14983, xarray-6721), 3 at 0/3 (pylint-4970,
> django-14034, xarray-6992). Headroom is 11 failures of 30 and **5 problems can move**, so the
> comparison is runnable at the native window. Two caveats survive: the 5 problems at 3/3 are ceiling
> and can only lose, so pair on **pass counts (0–3)** rather than a binary McNemar; and if that is
> still underpowered, take more problems from the pre-registered reserve rather than more repeats.
> There is also natural pressure to work with — 6 of 30 runs peaked above 100K and 4 compacted.
> **U5's first two arms are U18's first two arms**: `off` vs `soft` answers both on the same runs.

### U6 — Is there value above the unit-independent ceiling?
**Hypothesis.** A set-aware eviction policy (scoring *combinations*, not units) achieves lower damage
than the oracle's unit-independent ceiling, because single-unit effects are not additive.
**Why it is untested.** T8's oracle bounds every signal this project has proposed, all of which score
units independently — but it does not bound a set-aware policy, and nothing has measured whether the
gap is real.
**Experiment.** Extend the LOUO instrument to leave-k-out on the same 60 decision points: measure
whether the damage of deleting a set differs from the sum of its members' individual damages, and by
how much. Purely offline, same cost profile as T8.
**Falsification.** If leave-k-out damage is additive within the floor, the unit-independent ceiling is
the real ceiling and set-aware policies are not worth building.

### U7 — Does any of the eviction evidence transfer to the deployment model?
**Hypothesis.** The per-unit importance ranking measured on a 1B is stable across model scale, and
therefore transfers to the 27B the project actually deploys.
**Why it is untested.** T8's entire ceiling is measured on a 1B; attention structure is known to be
depth- and scale-dependent. Everything §A licenses about *which* units matter rests on this transfer.
**Experiment.** A size ladder — 0.6B / 1B / 1.7B — computing the per-unit LOUO ranking on the same
decision points and reporting rank correlation between scales.
**Falsification.** If the ranking reshuffles between 0.6B and 1.7B it will not survive to 27B, and T8's
ceiling becomes a claim about small models only.

### U8 — Should eviction fire below the hard window at all?
**Hypothesis.** Evicting to a soft floor `f` while the context still fits the window makes things
worse, not better: it converts cheap cache reads (0.1×) into cache writes (1.25×) for no benefit. The
replacement is a *floating* target derived from the hot set, not a fixed fraction of W.
**Why it is untested, and why the old framing is dead.** The original item swept `f` as 25–50% of W.
T3 contradicts its premise, and measuring the hot set on real transcripts gives peak 16–35k tokens but
an average of 0.4–2.4k — a ~32× swing a fixed fraction cannot track. The package currently ships the
seam for this decision, not an answer: `DEFAULT_EVICT_HEADROOM_TOKENS = 0` in `assemble/flex.ts`, i.e.
evict only when the hard limit binds, with headroom left as a parameter rather than an invented
fraction (headroom for N turns is `N ×` growth-per-turn, ~57% of a 7k window but ~2% of 200k — a fixed
fraction is the wrong *shape*).
**Experiment.** Arms: (a) no eviction until `window − replyReserve` binds (today's default),
(b) fixed `f = 0.375·W`, (c) floating hot-set target from `g*`. Substrate: SWE-bench through opencode,
with the cap set well above the ~9,898-token host overhead. Metric: solve rate + cache-adjusted cost.
**Falsification.** Retire the 25–50% sweep permanently unless (b) wins.

> ⚠️ **This is a COST claim, and it does not settle the capability question (added 2026-09-17).**
> Everything above is cache economics on a *priced* endpoint, so it cannot be run on the local
> harness at all (`cost=0`, no cache accounting — see the note above U1). The operator's counter-claim
> is about capability and about production shape: with a 1M host window the hard limit **never
> binds**, so a soft limit is the only trigger that ever fires, and the question is whether ~1/3 of
> the window still solves what the full window solves. That is **U18**, and it can be answered on the
> local harness. Both can be true: a soft limit can cost more in cache writes and still be the only
> mechanism that exists in production.

### U9 — Is prefix-preservation conditional on cache state?
**Hypothesis.** The assembler should preserve the cached prefix only while the cache is *warm*: when a
session resumes after the TTL has expired the whole prompt re-caches at write rate anyway, so at that
instant re-organisation is free, and a cache-state-gated policy beats unconditional append-only across
a resume boundary.
**Why it is untested.** The spec states "nothing reorders the cached prefix" unconditionally, but its
cost is conditional, and the assembler obeys it blindly. Resumption-after-a-gap is the normal way long
sessions are used — the regime this project is ultimately about — and T3 shows resumption *amplifies*
the advantage of capped arms (best arm +26.3% → +39.4% with 3 cold starts).
**Experiment.** Feed the assembler a cache-state signal (warm/cold, TTL remaining, observed hit ratio
from the previous response's `cache_read_input_tokens` vs `cache_creation_input_tokens`). Arms:
(a) always append-only, (b) always re-optimise, (c) cache-state-gated. Metric: effective cost across a
session containing at least one resumption gap, plus task success after the gap.
**Falsification.** If (c) does not beat (a) across a resume boundary, the signal is not worth the
plumbing. **Note:** this subsumes U4's cadence requirement — cadence and cache state are the same lever.

### U10 — Must the frozen head keep every user prompt, and is `A=4` right?
**Hypothesis (three, testable separately).** (Q1) Folding or summarising the oldest user prompts once
`head > f` does not cost task success — so the head need not grow forever. (Q2) The recency anchor `A`
has an interior optimum and `A=4` is not it. (Q3) CLAUDE.md-class steering is needed only at phase
boundaries, not every turn.
**Why it is untested.** The assembler already encodes an "always keep" set — the frozen head (system +
steering + *every* user prompt) plus the last `A` units — and neither half has ever been tested. `A=4`
was introduced as a read-loop guard and never swept. The head *is* the cached prefix, so holding it
costs `r` per turn while changing it invalidates everything after it; the pressure appears only once
the head alone approaches the budget, which a long session guarantees.
**Experiment.** Cheap: arms differ only in head construction, no new task needed. Q1 arms: keep-all /
fold-oldest / summarise-oldest / drop-oldest. Q2: A ∈ {1, 2, 4, 8} — and note A interacts with U2/U3,
since the most recent units also have the lowest idle. Substrate: scenarios through `oc-runner.mjs`
(multi-turn, so user prompts actually accumulate) plus a SWE-bench arm. Metric: task success +
cache-adjusted cost. Re-check `A` against the corrected turn clock (rule 7) before sweeping.
**Falsification.** If folding old user prompts costs task success, the unbounded head is justified and
the guarantee must instead be bounded (`head < f`) by construction.

### U11 — How often does reduce-on-overflow even fire, and does a router beat a fixed reducer?
**Hypothesis.** A query→reducer router that auto-selects chunk-vs-summarize beats always-chunk on
task success at equal cache-adjusted cost.
**Why it is untested.** The reducers are settled and built (`assemble/reduce.ts`); the heuristic that
*chooses* between them is not, and the seam is ready (`assembleFlex` takes a `reducer` function or a
name). But two prior findings change the question: reduction rewrites a unit **in place**, invalidating
the cached suffix (1.25× on everything after it), so the router's choice carries a cache cost and not
just a quality effect; and full-tool agents already shrink their own tool output (measured: piping test
runs through `tail -20`, so 11 `run_bash` calls contributed 1,983 of 10,120 peak tokens).
**Experiment.** **Establish the trigger rate first** — instrument how often reduce-on-overflow fires at
all across the SWE-bench pool. Only if it fires materially, test router pick-accuracy against an oracle
over the query set, scoring arms on cache-adjusted cost and preferring to reduce units late in the
prefix.
**Falsification.** If reduction almost never fires on a realistic host, the router is not worth
building and the item closes as answered.

### U12 — Is line-level deduplication large enough to matter?
**Hypothesis.** Line-level duplicate elimination — not block-level referential substitution — removes
enough real token spend to be worth shipping.
**Why it is untested.** T12 rejected the block-level form at 0.22%, but noted a line-level matcher
reaches **19.0%** on the same corpus. What was rejected is narrower than "deduplication".
**Experiment.** Offline first, on the same four sessions, cache-priced: measure real spend removed by
line-level elimination, and separately whether the resulting transcript is still well-formed (a clipped
or spliced read makes any "it is above in this conversation" claim false — the failure mode T12 hit).
Then, if the saving holds, a live arm through `oc-runner.mjs` with the substitution at
`tool.execute.after`.
**Falsification.** If the real saving is under 10% of spend after cache pricing, close the dedup line
of work entirely; T12 already closed the block-level half.

### U17 — Does an agent use resident content when told it is there, instead of re-fetching it?
**Hypothesis.** When a tool is about to return content whose bytes are ALREADY in the model's
context, returning a short referential anchor instead ("you read X at turn k; it is above,
unchanged") leaves the agent able to complete the task, and the *reference* is what does the work —
not the mere withholding. If so, the same substitution reduces cumulative prompt tokens and
wall-clock to completion, because a token never appended is never re-sent on any later turn.

**What is already settled, and what is not.** T12 rejected the COST half offline: the substitution
removes **0.22%** of what four real sessions actually sent (1.61% against a simulated stream), well
under its 10% bar, because the motivating "59.2% of reads are re-reads" is a PATH statistic — at the
CONTENT level only **5.8%** of reads carry bytes an honest anchor could replace. The BEHAVIOURAL
half was never tested. A live four-arm attempt on a bespoke `flapsim` scenario came back **VOID, not
null**: across 44 turns in 10 cells the trigger produced 1 would-fire event and **0 substitutions**,
so all arms were identical by construction (`report-oc-flapsim-arms-void.md`).

**Why the flapsim construct is abandoned.** Its single-message form made the agent re-read
constantly and complete nothing; splitting it into six focused turns made it complete the work
correctly (29/40, 12/12 held-out) and removed its reason to re-consult anything — 19 reads across 18
DISTINCT files. **Completability and re-reference pull against each other**, and a substrate built to
manufacture re-reads cannot be trusted to produce them without also destroying the task.

**Experiment.** Use the repo's established **SWE-bench 10-problem × 3-repeat baseline** as the
substrate rather than a bespoke task — real problems, a held-out grader, and a measured noise floor
(8/10 problems pass 3/3; within-problem peak spread 1.16–2.90×, median 1.87×).
1. **Trigger-rate gate FIRST, on ONE cell, reported before any arm is run** (standing rule): how
   often does a tool return bytes already resident? Near-zero means the experiment is not ready,
   whatever the arms would show. This is the step whose absence voided the flapsim run.
2. Only if it fires: arms `none` / `anchor` / `anchor-topk` / `placebo` (length-matched,
   non-referential) at `tool.execute.after` through `oc-runner.mjs`, one endpoint throughout.
3. **Pair within problem.** Against a 1.87× median trajectory spread, detecting the 5–14% token
   effect predicted offline would need n≈73 per arm unpaired; pairing is the only affordable route.
4. Primary outcomes: task success (low variance — outcomes were stable while trajectories were not)
   and prompt tokens. NOT output tokens: on the local endpoint they bundle reasoning while
   `tokens.reasoning` reads 0.

**Falsification.** If the trigger fires on fewer than ~4 opportunities per cell, report NOT RUNNABLE
and close the line — an intervention with nothing to intervene on is not a null. If it fires and
`anchor` does not beat the length-matched `placebo` on task success, the effect is withholding
rather than referring, and the anchoring framing is retired. If `anchor` degrades task success at
all, it is retired regardless of any token saving.

### U18 — Does a soft limit context-tree imposes hold accuracy at ~1/3 of the window?
**Hypothesis.** With a large host window the hard limit never binds, so a soft limit is the only
eviction trigger that ever fires in production. At `W_soft ≈ W/3` the agent solves what it solves at
the full window, at materially lower achieved peak.
**Why it is untested.** The package evicts only when `window − replyReserve` binds
(`assemble/flex.ts:295-301`), a trigger changed on 2026-09-14 whose own spec block ends "Single-problem
evidence (C0)" — `longbuild`, one problem repeated. `DEFAULT_SOFT_TARGET_FRAC = 0.375` survives but no
longer triggers anything; it only sizes the reduce-on-overflow budget. And until the harness sidecar
existed, nothing called `assembleFlex` on a live turn at all, so no soft limit could fire.
**Experiment.** SWE-bench through opencode, sandboxed, paired within problem. The soft limit is
expressed by passing `window = W_soft` to `assembleFlex` — no package change. Arms `off` (host
compaction, no plugin) vs `soft` at `W_soft = 50,347` (1/3 of 151,040), 10 problems × 3 repeats.
Primary: solve rate and **achieved peak** (the one measure that moves task success, OR ~52× per
e-fold). Then sweep `W_soft` ∈ {1/2, 1/3, 1/4} once the trigger question is settled; a dynamic limit
for thrashing problems is a later arm.
**Falsification.** If solve rate drops at 1/3, the claim is refuted **at that window** and the sweep
moves up, not down. If peak does not fall, the trigger is not firing — the cell is VOID, not a null.

### U19 — Does an eviction cadence beat evicting whenever the limit binds, across problems?
**Hypothesis.** Firing eviction every N turns beats firing it whenever the limit binds, on achieved
peak at equal solve rate.
**Why it is untested.** DV3 found an interior optimum **25–39% cheaper than append-only while N=1 is
183% worse**, and `DEFAULT_EVICT_HEADROOM_TOKENS = 0` ships as a seam precisely because the right
headroom is not a constant. But that evidence is C0 — one problem repeated, which measures
within-problem nondeterminism and says nothing about between-problem variance (standing rule 1).
**Experiment.** Same substrate and pairing as U18. `cadence N=5` — `window = W_soft` on every fifth
turn, `Infinity` otherwise — against `soft` (every turn) and `hard` (the shipped default), 3 repeats.
**Falsification.** If cadence does not beat `soft` on peak-at-equal-solve-rate, cadence is not a
separate lever on this substrate and DV3's cost optimum does not transfer to capability.

### U20 — Does the assembler need summaries, or is dropping enough?
**Hypothesis.** Folding dormant units to summaries beats dropping them outright at the same soft limit.
**Why it is untested.** Nothing generates summaries during a live session — the summarizer runs only
from the CLI — so a live flex buffer is all-raw, `repr()` renders every unit raw, and the stable
summary run that carries the second cache breakpoint never forms (`assemble/flex.ts:231,334`).
**Experiment.** The winning trigger from U18/U19 re-run with the sidecar summarizing closed phases
through the relay, 3 repeats, against its summaries-off twin. Summarizer calls, tokens and latency
are counted separately — they share the same GPU slots as the agent.
**Falsification.** If summaries do not improve solve rate at equal achieved peak, the summary-headed
tree is not earning its model calls on this substrate, and dropping is the cheaper mechanism.

### U13 — Does the drift classifier survive a corrected test on a corrected clock?
**Hypothesis.** The topic-shift signal (`z(lexJaccard) + z(semCos)`, K=5) beats its permutation null
under the *corrected* held-out condition.
**Why it is untested.** The pre-registered test was mis-specified — the tail was reversed — so the
existing ~9.5σ result is not a valid held-out test. And the classifier's `K=5` window and causal
z-scoring are both measured in "turns", so they inherit the 2.2× clock defect (rule 7).
**Experiment.** Audit the clock first, then re-run the permutation test with the corrected tail on
held-out sessions. Deterministic and falsifiable on its own terms.
**Falsification.** If the corrected test does not clear its null, the drift-dormancy term loses its
evidential basis and `classify/drift.ts` reverts to an untested hypothesis.

### U14 — Does RRF transfer from code to transcripts?
**Hypothesis.** The RRF ensemble's win transfers to a chat-history / L0-transcript corpus, and its
borrowed parameters (`RRF_K=60`, chunk ~800/100) are not the right ones there.
**Why it is untested.** Every RRF result was measured on a **code** corpus (`packages/**/src`), never
on transcript chunks. This does not block promotion — an ensemble tracks its best component by
construction, and it replaced a design that was *measured to lose* — but the tuning is provisional.
**Experiment.** Re-run the rung-0e/rung-2 methodology on L0-unit chunks; sweep `RRF_K` and chunk size;
report which component leads on prose.
**Falsification.** If a single component beats the ensemble on transcripts, the corpus-robustness
argument fails there and the retriever needs a corpus-aware configuration.

### U15 — Is the retrieval unit wrong for structural turns? *(HR1)*
**Hypothesis.** For structural turns, returning a whole structural payload beats returning the few
best-matching events — the retrieval *unit*, not the ranking, is what fails.
**Why it is untested.** Named in the hypothesis register, never run; untouched by everything in §A.
**Experiment.** The excerpt-vs-whole-structural-payload ablation on the retrieval corpus, scored on
answer presence and on tokens delivered.
**Falsification.** If whole payloads do not improve answer presence per token, the unit is not the
problem and ranking work resumes.

### U16 — Does the priority channel (`evictRederivable`) do anything once gated?
**Hypothesis.** Re-deriving evictable units from a priority channel improves outcomes over pure
reference-recency selection, once the channel is gated on query fingerprints.
**Why it is untested.** The parameters were proven **inert** without query fingerprints, so the
mechanism has never had a fair test; and the baseline matters — measure against LRU-at-`g*`, not
against no-eviction, because if reference-recency alone captures the benefit the channel is redundant.
This entry is partly conditional on U2: if priority is reference-recency renamed, the channel has
nothing independent to contribute.
**Experiment.** Gate on query fingerprints, then measure *effect* (not merely that the mechanism
fires) against a pure LRU-at-`g*` baseline on the LOUO instrument, then live.
**Falsification.** If the gated channel does not beat LRU-at-`g*`, retire
`experiments/attention-over-history/snapshot/rederive.ts` rather than promoting it.

### Two open research questions, larger than any single entry

1. **Read-loop B — the resource bound.** Two read-loops were found: A (working-set thrashing) is fixed
   by the footprint reducer; **B (behavioral indecision under a restricted toolset) reproduced on both
   the 8.2K and 27B models and is NOT fixed by the middleware.** This is the honest limitation, and the
   paper needs a progress mechanism (a completed-steps ledger, or a "stop reading and act" signal) for
   the spec's `resource bound (OPEN)` section. First probe: inject a completed-steps ledger and re-run
   on both models. *(Substrate: per rule 2, do this on opencode, not on the in-repo integration loop.)*
2. **A clean end-to-end number.** The old integration loop is confounded in both directions —
   restricted tools produce loop B, realistic tools produce grep self-heal (T1). U5 is the replacement:
   a real host, real problems, and the middleware as the only variable.

## Deployment task (not an experiment, but needed for the vector arm to run)
The vector/embedding arm — of both `ensembleRetrieve` and the `chunk` reducer's optional RRF fusion —
is embedder-agnostic and currently BM25-only in the synchronous paths. Implement the local MiniLM-class
`SummaryEmbedder` (needs a native dep) so the vector arm is available; the remote `text-embedding-3-small`
was NOT-CARRIED-FORWARD (early remote gate failed). Until then every retrieval path degrades to BM25,
which is the intended, tested fallback — this unblocks the ensemble, it does not fix a regression.

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
| `experiments/attention-over-history/` | the LOUO ceiling instrument (`measure.py`) + the moved `attention/` snapshot |
| `packages/cli/test/fixtures/claude-code-session-4.jsonl` | saved session transcript (test corpus) |

**Local models** (`http://127.0.0.1:8888/v1`, "switch model by request" on): Qwen3.8-27B (thinking via
`chat_template_kwargs.enable_thinking`), Qwen3.8-Flash-Next (8.2K hard window — the overflow stressor),
Muse-Glimmer-30B (131K). Set with `CT_LOCAL_MODEL=...`.
