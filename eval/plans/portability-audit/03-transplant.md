# Portability audit — the transplant harness (`eval/scripts/transplant.mjs`)

One area pass of a portability audit against `reports/algorithm.md`, scoped to the
cross-model context-transplant harness: `eval/scripts/transplant.mjs`, its gates, and
`eval/fixtures/transplant/JUDGE-VERDICT.md`. This harness is the D19 reference — the
place the fraction-of-W budget derivation actually lives — so most of this pass is
about whether that derivation is as sound as `reports/algorithm.md` credits it with, and
about one accounting bug in the grading path that has nothing to do with D19 but is
already corrupting live results in this repository's own fixtures. Every claim below
cites a `file:line` or a JSON value read from a committed artifact.

## Headline

D19's window-fraction math (`deriveBudgets`, `deriveRootKeep`, `measureRatio`,
`ratioVerdict`) is sound, tested offline (`eval/test/transplant.test.ts:167-279`), and
should move into `packages/core` close to verbatim — it is the one part of this area that
is *not* a defect. But the harness has a second, separate defect that D19 has nothing to
do with and that `reports/algorithm.md`'s seven known items do not cover: **a run that
hits the per-question tool-call ceiling (`MAX_TURNS = 6`, `transplant.mjs:123`) is graded
as a wrong answer, not excluded.** `runOneReplicate` (`transplant.mjs:3095-3216`) returns
`status: 'turn_cap'` with `finalText: ''` when the loop exhausts its six turns without the
model producing a final reply (`transplant.mjs:3128,3132`), and the caller feeds that
empty string straight into `gradeAnswer` with no status check
(`transplant.mjs:3345`) — `gradeAnswer('', question)` always scores `0`
(`transplant.mjs:1104-1112`). `runVerdict`'s MEAN computation then includes that `0`
indistinguishably from an actual wrong answer (`transplant.mjs:3521-3527`, the
`typeof r.score === 'number'` filter at `3522` does not exclude it). This is the exact
failure mode `reports/algorithm.md` documents the live suite fixing on 2026-09-02 — "a
run stopped by the counter was graded, and the grade was a failure the model never
committed" — except the fix landed in `eval/src/loop.ts`'s `HARNESS_STOPPED` path and
never touched this file, three git commits later, in the sibling harness that runs the
*same kind* of bounded tool loop. The one-line asymmetry already inside this file proves
it is an oversight, not a design choice: `cost_cap` is excluded from scoring
(`score: null` at `transplant.mjs:3355`) for the identical "the harness gave up, not the
model" situation; `turn_cap` is not.

This is not hypothetical. The committed fixtures already contain it:

- `eval/fixtures/transplant/s1/e1b289c32f40/results/run-W32768-truncate-tail+compact-rolling+tree-qwen_qwen-2.5-72b-instruct.json` — 2 of 157 completed `tree`-arm rows are `turn_cap`/`score:0`, one of them on the **`tail` stratum** (`s1-q06-tail`, rep 5), the exact stratum the pre-registered §15.2 criterion (`transplant.mjs:3402-3404`, `tree >= truncate − 0.05`) is computed from.
- `results/run-W32768-tree-wide-qwen_qwen-2.5-72b-instruct.json` — **7 of 60 rows (11.7%)** are `turn_cap`/`score:0`, all with `fetched:true, searched:true` (the model was actively using the tools, just needed more than six round trips). This is the R6 ablation arm this session's memory records as "in flight" (`ablation v57b`) — every one of those seven zeros is currently baked into that arm's mean.

Both affected files are at `W=32768`; none of the `W=16384` result files contain a
single `turn_cap` row. The plausible mechanism: at 32k more of the tree survives into
Zone B (`tree-wide`'s ladder walk keeps up to 11 branch summaries there versus 1 at 16k,
per `root_by_window` in the committed manifest), so there is more to search across before
landing on the right branch — meaning the defect gets *worse*, not better, as the window
grows and the tree becomes more visible, which is backwards from what a reviewer would
expect from "more context should help." `MAX_TURNS` is not derived from window size,
branch count, or anything else that varies with the host; it is a flat literal with no
CLI override (`grep -n 'maxTurns\|max-turns' transplant.mjs` → no hits) and no test
exercises `runOneReplicate`'s status/score interaction at all (the full `describe`/`it`
list in `transplant.test.ts` covers `deriveBudgets`, `deriveRootKeep`, `capToolResult`,
`gradeAnswer`'s literal matching, the R6 ladder, self-retrieval, error classification,
and the verdict arithmetic — never the turn cap). Fix cost is small: give `turn_cap` the
same `score: null` treatment `cost_cap` already gets at line 3355, and exclude it from
`runVerdict`'s `scored` filter the same way. It does not require deciding whether six
turns is the right number, only that a run the harness cut off is not evidence the model
was wrong.

## Where the D19 derivation is sound and should be lifted

`deriveBudgets` (`transplant.mjs:338-372`) takes `(windowTokens, ratio, options)` and
returns every zone budget as `Math.floor(fraction * windowTokens / ratio)` — pure,
already unit-tested for linearity in W, the ratio-1 identity case, and rejection of
non-positive inputs (`transplant.test.ts:168-219`). `deriveRootKeep`
(`transplant.mjs:443-458`) walks a ladder and asks a caller-supplied predicate whether
the *actual assembled* Zone B fits — "wherever this returns a keep, gate 8 provably
passes" (comment at `transplant.mjs:430-441`) is a real property, not marketing: the
predicate calls `assembleTreeAt` and reads the real `overBudget` output
(`transplant.mjs:762-764`), so there is no separate share-of-Zone-B constant that could
drift from what the assembler actually does. `measureRatio`
(`transplant.mjs:711-714`) is defined over "every L2 blob, in sha order" — the whole
corpus, not a sample someone chose — which is what makes it re-runnable on a new host
without an argument about representativeness. All three are already exported and already
covered by offline tests. None of this exists in `packages/core` today (confirmed:
`deriveBudgets` and `ratioVerdict` do not appear anywhere under `packages/core/src` or
`packages/mcp/src` — only in this script and its test), which is exactly what
`reports/algorithm.md`'s tier-2 table means by "derived in transplant" for four budget
rows and "root keep... derived in transplant; the live suite uses the constant." This
pass confirms that description is accurate and specific: `packages/core/src/config.ts:116-117`
still hardcodes `budgets: { zoneB: 8_000, zoneC: 30_000 }, rootKeep: 40` with no
W-relative counterpart anywhere in the library.

`capToolResult` (`transplant.mjs:286-321`) is a second piece worth lifting: it budgets
an appended tool result against real headroom (`W − spent − maxReplyTokens − margin −
prefix`, `transplant.mjs:288-289`) rather than against a fixed size, which is precisely
the fix for the "search result limit... hardcoded; at a 16k window the search payload
alone overflowed headroom in 8 of 15 runs" defect `reports/algorithm.md` already lists.
This pass adds fresh, independent confirmation from a different fixture: in
`results/run-W16384-truncate-tail+compact-rolling+tree-openai_gpt-3.5-turbo.json`, 17 of
180 rows needed this truncation, some dropping 13,000+ characters (~3,500 tokens) of a
single tool result — real headroom exhaustion at 16k, reproduced independent of the
figure already on record. `capToolResult` mitigates the symptom (the model sees a marked
elision instead of an HTTP 400) but the root cause — `retrieval.limit: 20` at
`config.ts:119` not scaling with W — lives in `packages/core` and is out of this area's
scope; the headroom-aware truncation function itself, however, is portable and belongs in
`packages/core`'s append path rather than duplicated per-harness.

## Where the derivation is incomplete

**The fraction table itself carries forward a known inconsistency, not a new one.**
`FRACTIONS` (`transplant.mjs:102`) sets `lazy: 0.35` against `zoneC: 0.2` — the same
switch/Zone-C mismatch `reports/algorithm.md`'s tier-2 table already flags generically
("the switch fraction and the Zone C fraction disagree while the rule says they are the
same thing"). Worth stating precisely here because this file is the one being held up as
"the model the live harness should follow": lifting `FRACTIONS` verbatim into
`packages/core` propagates the inconsistency into shipped code rather than fixing it in
transit. `docs/IMPLEMENTATION_PLAN.md`'s own D19 row and the "One budget derivation"
candidate in `reports/algorithm.md` both already say the switch should equal the Zone C
fraction — the fix is one line in `FRACTIONS`, but it has to happen before this table is
copied anywhere, not after.

**The ratio measurement is derived; the thresholds applied to it are not.** `ratio =
exact.count(sample) / heuristic.count(sample)` (`transplant.mjs:713`) is a genuine
per-host measurement with a shippable procedure. But `RATIO_KILL = 1.6`,
`SLACK_REFLOOR_ABOVE = 1.15`, `SLACK_REFLOORED = 0.15`, and `SLACK_MITIGATION = 0.2`
(`transplant.mjs:106-109`) are calibration points fixed once by the DS-STAR judge's
verdict (`JUDGE-VERDICT.md:15,63`: "ratio > 1.6 is a stated kill condition," "slack .15
if ratio > 1.15") against a single measured value on a single corpus (0.851, this
repository's own trace). Nothing in the harness re-derives *where* 1.15 or 1.6 should sit
for a different tokenizer family (e.g., a non-BPE tokenizer, or a model whose vocabulary
undercounts differently) — they are portable in the sense that the comparison is a
formula, not in the sense that the cut points were fitted to more than one sample. This
matters because the entire 16k/gpt-3.5 cell already lives right at the edge of this
judgment: `JUDGE-VERDICT.md:25` states the 9,062-token flat prompt "at a 1.4× BPE ratio…
does not fit 16k," and the measured ratio in the committed fixture is 0.851 (well under
1.15 — no re-floor triggered on this corpus at all, so the re-floor and kill branches are
themselves untested against real data in this repository; see "Dead or near-dead
branches" below).

**`MAX_SUMMARY_TOKENS` is a duplicated literal, not a read of the config it claims to
match.** The module doc comment states the compaction baseline is "pinned to the tree's
leaf model, output cap, AND total prompt budget" (`transplant.mjs:9-11`), and
`MAX_SUMMARY_TOKENS = 1_024` (`transplant.mjs:119`) does equal
`DEFAULT_CONFIG.summarize.maxSummaryTokens` at `packages/core/src/config.ts:118` today —
but it equals it by coincidence of two independently-maintained literals, not by
importing `scenario.config.summarize.maxSummaryTokens` (which is already loaded and
already in scope at every one of the six use sites, `transplant.mjs:829,2916,2942,2987,3001`
and the manifest). If a host's `context-tree.config.json` ever overrides `summarize`
(the config loader supports it — `loadConfig`/merge machinery exists precisely so a
per-project override is possible), the compaction baseline silently stops being "pinned"
to what the tree arm actually used, and the pinning claim the whole experiment's honesty
rests on (`JUDGE-VERDICT.md:16`: "the only arm anywhere that pins model *and*
`maxSummaryTokens=1024` *and* total prompt budget") quietly becomes false with no error,
no gate, and no log line — a silent wrong answer at the level of the whole scenario, not
one row. Fix cost: read the value off `scenario.config.summarize.maxSummaryTokens` at each
use site instead of the module constant; trivial, no behavior change on the current
config.

**The compaction chunk size is derived from W, but the fraction that sizes it is its own
unexplained constant.** `chunkBudget = Math.floor((0.5 * budgets.window) / budgets.ratio)`
(`transplant.mjs:2871`) scales with the window, which is the right shape, but `0.5` has
no comment, no entry in `FRACTIONS`, and no stated relationship to the D19 allocation
table the rest of the budgets come from — it is a second, parallel fraction system with
one member. On a smaller window this chunk size interacts with
`MAX_SKIPPED_CHUNK_FRACTION = 0.25` (`transplant.mjs:129`, "above this share of skipped
chunks the baseline is degraded") to decide how easily the compaction baseline gets
flagged degraded; neither constant is derived from anything host-specific, and R7 in
`JUDGE-VERDICT.md:169-177` records a real incident (a 169-character conversational reply
poisoning the whole rolling summary) that this pair of constants is the only defense
against on a new model whose failure style differs from the one that produced R7.

**`MAX_REPLY_TOKENS = 800`** (`transplant.mjs:124`) is folded into `maxReplyTokens =
Math.min(MAX_REPLY_TOKENS, Math.floor(FRACTIONS.reply * windowTokens))`
(`transplant.mjs:361-364`) — correctly window-scaled on the small side, but flat at 800
regardless of W once the window is large enough that 5% of it exceeds 800 (any W ≥
16,000). The 800 itself is stated as "the design's 800-token reply"
(`transplant.mjs:107`) with no derivation from a model's actual output-length needs. The
committed fixtures show this already firing: 4 of 673 recorded turns across all result
files stopped with `stopReason: 'length'` rather than `'stop'` or `'tool_calls'` — a small
but real rate of mid-answer truncation on this run, and the harness has no signal that
distinguishes "the model finished" from "the model was cut off at 800 tokens," which
matters more for a reasoning-style model (the module's own comment at `transplant.mjs:99-101`
already documents one, `glm-5.3-flash`, whose text arrives in an unexpected field).

## The ratio measurement and its kill threshold, precisely

- **Sample**: every L2 blob under `scenario.paths.blobs`, sha-ordered, newline-joined
  (`l0Sample`, `transplant.mjs:494-497`) — "not 'a representative sample' chosen by
  taste... the whole payload," per its own comment. Deterministic, re-runnable offline,
  no network.
- **Measurement**: `ratio = ExactTokenizer.count(sample) / HeuristicTokenizer.count(sample)`
  (`transplant.mjs:713`), where `ExactTokenizer` wraps a local `cl100k_base` table via
  `gpt-tokenizer` (`transplant.mjs:88`, `packages/core/src/tokens/index.ts:104,115`) — no
  API call, confirmed by the module's own hermeticity framing (`transplant.mjs:25-29`).
- **Current value**: 0.850896663206653 on scenario `s1`
  (`eval/fixtures/transplant/s1/e1b289c32f40/gates.json:"ratio"`).
- **Kill threshold**: `ratio > 1.6` throws in `deriveBudgets` only indirectly — the actual
  hard stop is procedural, at `JUDGE-VERDICT.md:63`: mitigate with slack .20, and "if
  still over, drop the 16k/gpt-3.5 cell and publish qwen-only." In code,
  `ratioVerdict` (`transplant.mjs:465-473`) returns `ok:false` above 1.6 and the caller
  (`transplant.mjs:2505-2508`) throws `KILL GATE: heuristic->BPE ratio ... exceeds 1.6`.
  This branch has never fired against real data in this repository (measured ratio 0.851
  is well under even the 1.15 re-floor point) — see below.

## The ladder that picks the fold level

`ROOT_KEEP_LADDER = [40, 16, 12, 8, 6, 4, 2]` (`transplant.mjs:378`), walked
largest-first for `tree`/`tree-static` and the loop-9b single-variable arms, reversed
(smallest-first) for `tree-wide` (`ARM_ROOT_LADDER`, `transplant.mjs:392-402`).
`deriveRootKeep` (`transplant.mjs:443-458`) returns the first rung whose predicate
passes; the predicate (`fitsRoot`, `transplant.mjs:761-767`) assembles the real prompt at
that keep and checks `overBudget == []` **and** at least one branch summary survived —
R4 in `JUDGE-VERDICT.md:146-147` records why the second half is load-bearing (the root is
exempt from the assembler's drop valve, so a root that eats all of Zone B would otherwise
report a false pass). If no rung passes, the window is reported dead, never forced
(`transplant.mjs:457-458`) — confirmed live in the committed fixture: at W=16384 keep=40
down through keep=4 all fail with `overBudget:["B"]` or a root alone consuming the
budget, and only keep=2 passes (`gates.json`, `rootLadder` array, `s1/e1b289c32f40`). This
is the mechanism, not a proxy for it — the R5 entry in `JUDGE-VERDICT.md:149-155`
explicitly records that an earlier version used a proxy constant (0.5 × Zone B as a root
ceiling) and the implementing agent was overruled for trying to tune it to rescue a
failing cell, in favor of asking the real assembler. This is the single most portable
piece of this file and is a template for how `packages/core` should expose `rootKeep`:
as a function of an injected "does this fit" predicate, not a number.

## Every remaining magic number that would change a result on a new model or window

| Constant | Location | Changes what, on a new host |
|---|---|---|
| `MAX_TURNS = 6` | `transplant.mjs:123` | Per-question tool-loop ceiling; see Headline — a model needing more hops (weaker tool use, a wider Zone B, a deeper `deep`-stratum search) is scored 0 instead of excluded. Confirmed firing today at W=32768. |
| `MAX_REPLY_TOKENS = 800` | `transplant.mjs:124` | Flat above W≈16k; a verbose or reasoning-style model's answer can be cut mid-thought (`stopReason:'length'`, observed 4/673 turns) with no distinction from a normal stop. |
| `FRACTIONS.lazy = 0.35` vs `FRACTIONS.zoneC = 0.2` | `transplant.mjs:102` | Inherited inconsistency (already generically flagged in `reports/algorithm.md`); concretely present in the exact table this pass recommends lifting into `packages/core`. |
| `RATIO_KILL=1.6`, `SLACK_REFLOOR_ABOVE=1.15` | `transplant.mjs:105-106` | Judgment calls calibrated against one corpus (ratio 0.851); untested against a second tokenizer family or a model whose heuristic undercounts in the opposite direction. |
| `MAX_SUMMARY_TOKENS = 1_024` | `transplant.mjs:119` | Duplicated literal, not read from `scenario.config.summarize.maxSummaryTokens`; a config override on a new host silently un-pins the compaction baseline from the tree's actual cap. |
| chunk-size fraction `0.5` | `transplant.mjs:2871` | Unexplained, not in `FRACTIONS`; sizes the compact-rolling baseline's per-call chunk and, with `MAX_SKIPPED_CHUNK_FRACTION`, how often that baseline gets flagged degraded. |
| `MAX_SKIPPED_CHUNK_FRACTION = 0.25` | `transplant.mjs:129` | Threshold for the baseline-quality warning; low reach (log line only) but untied to anything about the new model's failure style. |
| `Q_PER_STRATUM=3`, `POOL_DEPTH=12`, `REPS=5`, `SPANNING_REPS=3` | `transplant.mjs:144-150,121-122` | Starting sample sizes, not portability hazards per se — the pre-registered escalation rule (`escalationN`, `transplant.mjs:1151-1159`) already re-derives `n` from observed `p̄`/`Δ` when a CI crosses zero, so these are defaults with a measured override, not fixed answers. Listed for completeness, not flagged as defects. |

`CHARS_PER_TOKEN_CEILING = 8` (`transplant.mjs:134`) is *not* listed above: it is a
one-directional safety bound (a pre-cut that can only leave more tokens available than
`headroom`, never fewer that get counted as more) proven correct in its own comment
(`transplant.mjs:296-304`) independent of tokenizer or window — a performance guard, not
a portability hazard.

## Zero-token gates that are genuine boundary-condition tests and belong in the shipped suite

Of the 15 gates in `runGates` (`transplant.mjs:1805-2253`), these test a property of the
*algorithm* (would hold on any store, not just this fixture) and currently exist only
against one frozen scenario:

- **g4-unmapped-tools** (`transplant.mjs:1828-1831`) — asserts the segmenter's "unknown
  tool → `other`" invariant. `reports/algorithm.md`'s boundary table already marks this
  "tested," but only via `packages/core/test/segment.test.ts`'s synthetic cases; g4 is the
  same property against a real 754-event trace and would catch a tool name that is
  *reachable* but happens to map correctly only by the config's current entries.
- **g5-rebuild-determinism** (`transplant.mjs:1832-1836`) — re-derives L1 from L0+L2 alone
  and diffs the node dump. This is tier-0 invariant #1 verbatim ("L1... derived and
  rebuildable") exercised against real data; belongs in `packages/core/test/ingest.test.ts`
  as a property test over a generated trace, not only a fixture-specific gate.
- **g8-over-budget** (`transplant.mjs:1926-1959`) — asserts the assembler's own
  `overBudget` invariant plus "at least one branch survives" (R4). This is the exact
  invariant that catches the root-eats-Zone-B bug R2/R5 describe; it is currently provable
  only by assembling a real store at a real window, which argues for a
  `packages/core/test/assemble.test.ts` case built the same way (inject a store whose
  rendered root exceeds its Zone B budget, assert the same two conditions) rather than
  leaving this as the only place the bug class is caught.
- **g9-zone-b-nesting** (`transplant.mjs:1961-2020`) — the newest-aligned
  contiguous-suffix property across `NESTING_WINDOWS = [8k,16k,32k,65k,200k]`. Note for
  the record: `reports/algorithm.md`'s boundary table still describes this as "assert each
  Zone B is a **subset** of the next larger," but R3 in `JUDGE-VERDICT.md:141-144` and the
  code comment at `transplant.mjs:1980-1988` explain why that was replaced with the
  stronger contiguous-suffix property (rule-4 drops oldest-first, so nesting is directional,
  not just set-inclusion) — a real drift between the reference doc and the implementation
  worth reconciling in `reports/algorithm.md`, not a code defect.
- **g10-prefix-stability** (`transplant.mjs:2170-2198`) — byte-identical Zone A+B prefix
  across three assemblies plus "tail appends after Zone C." This is D5's cache invariant,
  zero live tokens, and it is exactly what `reports/algorithm.md` calls "the test that will
  catch the subtlest regressions" (the cache assertion harness at §17) — but as written it
  only runs against this one fixture's store. It should be a `packages/core` property test
  (assemble N times from a synthetic store, assert the sha is stable) so it runs on every
  PR, not only when someone runs this script by hand.
- **g14-cost-cap** (`transplant.mjs:2199-2211`) — forces a synthetic $0.000001 cap and
  asserts `CostCapExceededError` fires. This is already almost certainly duplicated by a
  `packages/core` unit test on `InMemoryCostMeter` directly (not verified in this pass —
  out of scope — but worth a follow-up check before promoting, to avoid a duplicate).

The remaining gates are experiment-specific and do not generalize: g1/g2/g3/g6/g13 test
*this fixture's* freeze/import correctness; g7 measures a value rather than testing a
fixed property; g11/g12/g15 test properties of the generated question set (literal
uniqueness, leakage, self-retrieval), which is data about this experiment's own
methodology, not about the algorithm a new host would run.

## Dead or near-dead branches

- **`manifest.caps.root_keep = 40` never reflects reality and nothing reads it back.**
  `buildManifest` (`transplant.mjs:829`) writes `root_keep: ROOT_KEEP` where
  `ROOT_KEEP = 40` (`transplant.mjs:120`) is a module constant distinct from the derived
  `rootKeep` computed per window. The committed manifest confirms the mismatch directly:
  `eval/fixtures/transplant/s1/e1b289c32f40/manifest.json` has `"caps":{"root_keep":40}`
  sitting beside `"root_by_window":{"16384":{"tree":{"rootKeep":2,...}},"32768":{"tree":{"rootKeep":16,...}}}`
  — the field that answers "what keep did this run actually use" is `root_by_window`, and
  `caps.root_keep` is stale the moment any window derives a different keep, which is every
  window in this fixture. `grep`-confirmed nothing in `transplant.mjs` or
  `transplant.test.ts` ever reads `caps.root_keep` or `.root_keep` off a loaded manifest
  — it is write-only. Low severity (it doesn't drive any behavior) but worth deleting
  rather than leaving a number in the freeze-line artifact that a future reader could
  reasonably mistake for the truth.
- **The ratio re-floor and kill branches are unexercised against real data.** `ratioVerdict`
  (`transplant.mjs:465-473`) has three branches — kill above 1.6, re-floor above 1.15,
  default otherwise — but the only ratio ever measured in this repository's fixtures is
  0.851, which takes the default branch every time. This is not provably dead (the logic
  is simple enough to trust by inspection, and it is unit-tested with synthetic ratios at
  `transplant.test.ts:198-206,273-279`), but it has never been exercised end-to-end
  through `runGates`/`runArms` against a store whose corpus actually pushes the ratio past
  either threshold — worth a fixture (or a synthetic-ratio integration test) before
  trusting the kill gate's *procedural* half (the "drop the 16k cell, publish qwen-only"
  step in `runArms`) rather than just its arithmetic half.

## Boundary conditions

| Condition | Checked by | What happens when violated |
|---|---|---|
| per-question tool loop exceeds `MAX_TURNS` | nothing — no test, no gate | **Silent wrong answer**: `status:'turn_cap'`, `finalText:''`, graded `score:0` indistinguishable from a genuine miss, entering the arm's MEAN and the pre-registered §15.2 criteria. Confirmed firing in committed results (9 rows across two files, one on the `tail` stratum). Ranks above every other finding in this report per the instructions' own ordering rule. |
| window too small for any `rootKeep` rung to fit | g8-over-budget, procedural fallback in `runArms`/verdict comments | Loud, not silent: `deriveRootKeep` returns `rootKeep:null` and the window is reported dead (`transplant.mjs:457-458`); `runVerdict` simply has no rows for that cell. Correct behavior, already the model other gates should follow. |
| measured ratio exceeds 1.6 | `ratioVerdict` + the `KILL GATE` throw in `runArms` (`transplant.mjs:2505-2508`) | Loud: hard stop before any live call. Never exercised against real data in this repo (see Dead branches). |
| a config override changes `summarize.maxSummaryTokens` | nothing | **Silent wrong claim**: the compaction baseline's "pinned to the tree's cap" property (the experiment's core honesty guarantee per `JUDGE-VERDICT.md:16`) quietly stops being true; no gate reads `scenario.config.summarize.maxSummaryTokens` against the module's own `MAX_SUMMARY_TOKENS`. |
| a model's replies are systematically longer than 800 tokens on a large W | nothing | Silent: `stopReason:'length'` is recorded per-turn but nothing in grading or the gate suite flags a truncated final answer differently from a complete one. Observed at low rate (4/673 turns) in current fixtures. |
| a leaf/branch larger than W (row already in `reports/algorithm.md`'s boundary table, "untested live") | not checked by any transplant gate | Out of this pass's fixture (`s1`'s largest surviving branch at the tested windows is well under W per `gates.json`'s `rootBlockTokens`/`branchSeqRange`); the row stands as `reports/algorithm.md` already states it, not newly confirmed or refuted here. |

## Top three, ordered by what breaks first on a new host

1. **`turn_cap` runs are scored as wrong answers instead of excluded** — already
   corrupting the R6 `tree-wide` ablation (7/60 rows) and the primary `tree` arm's `tail`
   stratum (which the pre-registered regression check reads directly) in committed
   results at W=32768. Silent, currently active, and the exact bug class the project
   already spent a changelog entry fixing one file over. Fix: mirror the `cost_cap`
   treatment already in the same file (`score: null`, excluded from `runVerdict`'s mean).
2. **The D19 derivation functions are sound but landlocked in an eval script.** Nothing in
   `packages/core` can compute a zone budget, a root-keep ladder, or a heuristic/BPE ratio
   from a window size — the exact gap `reports/algorithm.md`'s tier-2 table names for four
   budget rows. Lifting `deriveBudgets`/`deriveRootKeep`/`measureRatio`/`ratioVerdict`
   (fixing the `lazy` vs `zoneC` fraction mismatch in transit) closes those four rows at
   once and gives the live suite the same portability the transplant harness already has.
3. **Two duplicated-literal drift risks that are currently silent by coincidence**:
   `MAX_SUMMARY_TOKENS` not reading `scenario.config.summarize.maxSummaryTokens`, and
   `manifest.caps.root_keep` recording a constant the derivation has already superseded.
   Neither has fired yet only because no one has changed the config or looked closely at
   the manifest field; both are one-line fixes now, and both become "why doesn't this
   match" debugging sessions later if left.
