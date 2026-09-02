# Loop-9 transplant test — DS-STAR judge verdict (wf_110910be-3d4, 2026-09-01)

Design pass: cross-model context transplant (large-model trace -> tree -> small-window
model answers). Winner: Design C (null-hypothesis stance), 72/80, with grafts 1-7.
This file is the implementation contract; deviations must be recorded here.

## SCORES

| Criterion (weight) | A (reuse-harness) | B (by-construction) | C (null-hypothesis) |
|---|---|---|---|
| Simplicity — core pseudo-code lines / new subsystems | **8** — core 12/12 exactly (no headroom), one new script (~210 ln, −154 from recall-probe); but adds `--window` + `--lazy-frac` on top of the two existing budget flags (net knob count up) | **7** — core 12/12 but **+2 lines inside `packages/core`** and `config.ts +12`; 4 new files (`transplant.mjs`, `-questions`, `-portability`, `budgets.test.ts` ≈ 420 ln) | **9** — core **8 lines, 0 edited**; 20-line harness pseudo-code; removes the `EVAL_LAZY_TOKENS` constant rather than adding a knob |
| Attributability of each arm's verdict | 8 — A3−A2 isolates organization (compaction pinned to tree's leaf model) | 8 — same, plus explicit "one question-independent frozen artifact per arm" rule | **9** — same, plus per-run `fetched` flag splitting summary-resident from search→fetch recall, **pre-registered thresholds** (head ≥ compaction+0.25, tail ≥ truncation−0.05), and a `tree-static` fallback that keeps the organization claim alive if tool-calling fails |
| Spend discipline | 7 — $4.6/scenario, but the killer probe sits in §7 Risks, not as step 0 | 8 — $4.05, cap $6, portability sweep offline | **9** — $4.6, cap $6, and the two kill-gates (P11–P12 BPE ratio, `TRANSPLANT_SMOKE=1`) are **numbered steps before any batch** |
| Question-gen trustworthiness | 8 — once-only literals, cross-family paraphraser, regex grader, 3-gram gate | 9 — adds the four-distinct-families argument (fable/haiku/deepseek/answerer) | **9** — same, plus the correct gate carve-out (**3-gram overlap *minus the answer literal***; A/B's gate as written would reject every question that must contain its own answer token) and the explicit memorization argument (private 2026 trace vs 2021/2024 cutoffs) |
| Window-derivation soundness | 7 — fractions + slack .15 if ratio >1.15, calibration in Risks | 9 — fractions in core + **monotone Zone-B nesting proof** over W∈[8k,200k], re-floor if ratio >1.25 | **9** — fractions **divided by the measured heuristic→BPE ratio**, i.e. it fixes the known chars/4 undercount for this test instead of reserving slack against it; ratio >1.6 is a stated kill condition with mitigation |
| Reviewer-facing baseline coverage | 8 — A0/A1/A2/A3, MemGPT at `ARMS.memgpt`, equal n | 9 — P0/T0/T1/T2 + `t3-memgpt` row, epoch rule, power rule | **10** — compaction is the only arm anywhere that pins **model *and* `maxSummaryTokens=1024` *and* total prompt budget** to the tree's, MemGPT plugs in at a named line (R2), naive-full explicitly n=1/unscored, binomial power rule |
| Doc compliance (D5/D15/D17/D18) | 8 — D19 + §15 arms table | 9 — best diff (§10 fraction table + nesting, §16 M6 acceptance, §19.2 closed) | 9 — §15 row-C replacement, new §15.2 with numeric criterion, D19, §17 assertion |
| Implementation risk | 8 — lowest new code, core untouched | **6** — changes shipped `packages/core` budget semantics to serve an eval, while the v6.5 gate lineage is mid-flight | **8** — core 0, two new eval scripts, named degradation path |
| **Total** | **62 / 80** | **65 / 80** | **72 / 80** |

No design is disqualified: all three keep core ≤12 lines, all reuse `recall-probe.mjs` rather than building a harness, all put offline gates before live tokens, all carry a plain-compaction arm with equal n.

## WINNER — Design C (null-hypothesis), 72/80

C is the only design that argues *against* the prior numbers with numbers. It converts the 9,062-token flat prompt into its real-tokenizer consequence — at a 1.4× BPE ratio that is ~12.7k, which plus four tool schemas plus an 800-token reply does not fit 16k — making "gpt-3.5 may be unrunnable" a pre-batch, zero-token kill gate rather than a post-hoc surprise. It is also the only design whose strata target the *flagged* gap: a `deep` stratum (fact absent from every summary) forces the untested search→fetch hop into raw L0, where A and B's `spanning` stratum can still be answered from two summaries. It buys this with zero core edits and the strongest baseline honesty (compaction pinned to the tree's model, output cap, *and* prompt budget), plus a `tree-static` fallback that preserves the organization-vs-compaction result even if the small models cannot emit parseable tool args. B is the rival worth naming: its Zone-B nesting proof is genuinely free reviewer evidence — grafted below — but it pays for it by editing shipped core budget semantics mid-lineage, which is the wrong risk to take for an eval.

## GRAFTS

1. **From A — one script, not two.** Collapse C's `transplant-prep.mjs` + `transplant-run.mjs` into a single `eval/scripts/transplant.mjs` with `--phase prep|run|verdict`, forked from `recall-probe.mjs` minus its synthetic builders (lines 107–260). Saves ~80 lines and one duplicated import block.
2. **From A — `--scenario <id>` + manifest.** Every artifact path keyed by `sha256(trace)[0:12]` *and* a human `--scenario` label; manifest records trace sha, store sha, question-set sha, gate list, model string, W verbatim.
3. **From B — the monotone Zone-B nesting assertion.** Add to the offline phase: for W ∈ {8k, 16k, 32k, 64k, 200k}, assert Zone B at W is a prefix-subset of Zone B at the next larger W, and `overBudget == []` at every W. Zero tokens, marathon-style, and it is the single most reviewer-legible portability claim in any of the three designs.
4. **From B — the pooled-σ power form as a cross-check** on C's binomial `16·p̄(1−p̄)/Δ²`; report both, escalate on the larger.
5. **From A/B — keep `spanning` as a fourth stratum, exploratory only** (n=3, 3 questions, not in the primary verdict). It costs ~$0.25 and is the only probe of the ≥2-branch multi-hop; pre-register it as exploratory so it cannot be promoted post-hoc.
6. **Judge's own amendment — do not edit `eval/src/loop.ts`.** C proposed replacing `EVAL_LAZY_TOKENS` with `EVAL_LAZY_FRACTION`+`EVAL_WINDOW` in `loop.ts:761`. Reject: the v6.5 gate lineage is mid-flight and that edit perturbs it. The transplant harness computes `lazy = floor(0.35·W / ratio)` itself and exports `EVAL_LAZY_TOKENS=<derived>`. The hand-tuned constant is removed *as a rule* (D19 records the derivation) with **zero** code change — strictly more rule-removal than any design proposed.
7. **Judge's own amendment — substrate correction.** Use `4bf1e198-…jsonl` (4,663,077 B, verified). Do **not** use `e8bcf788-…jsonl` (8,871,982 B) despite it being the largest: it is this session's live transcript, still being appended, therefore unfreezable.

## IMPLEMENTATION SPEC

### Step 0 — substrate freeze (offline, 0 tokens)
- Copy `/Users/danielbyrne/.claude/projects/-Users-danielbyrne-GitHub-rpm-context-tree/4bf1e198-8af4-47e0-ae99-fa2ca13f1400.jsonl` → `/Users/danielbyrne/GitHub/rpm/context-tree/eval/fixtures/transplant/s1/trace.src.jsonl`. Record `sha256`. **This file is never regenerated for the life of the experiment.**
- `/Users/danielbyrne/GitHub/rpm/context-tree/packages/cli/src/claude-code.ts` — in the per-line walk (`mapClaudeCodeTranscript`, ~lines 50–143, at the `kind !== 'user' && kind !== 'assistant'` skip): **+2 lines**, also skip lines with `isMeta === true`, counting them into the existing `skipped` tally. Verified absent today (`grep isMeta` → no hits).
- `/Users/danielbyrne/GitHub/rpm/context-tree/context-tree.config.json` — **+3 lines**: `"toolPhase": { "Task": "delivery", "WebFetch": "diagnosis" }`. Merged at `packages/core/src/config.ts:165`. Config, not code.
- `context-tree import eval/fixtures/transplant/s1/trace.src.jsonl --from-claude-code --store eval/fixtures/transplant/s1/store` (wired at `packages/cli/src/program.ts:70-83`; ingest at `packages/cli/src/commands/import.ts:87-89`). Confirm the reported `unmapped tools -> "other"` list (`import.ts:246-250`) is now empty.

### Step 1 — one summarization pass, then freeze L1 (live, ~$0.36)
- `Summarizer.summarizeTree` (`packages/core/src/summarize/summarizer.ts:190-196`), `leafModel = claude-haiku-4-5-20251001` (`config.ts:101`), concurrency 8, `maxSummaryTokens = 1024` (`config.ts:114`); root via the `EVAL_DET_ROOT` compose-from-headlines path (`eval/src/loop.ts:765-767`) — 0 tokens, `rootKeep = 40` per D17.
- Freeze: `sha256` of `trace.jsonl`, blob-dir manifest, `nodes`, `node_summaries` → `eval/fixtures/transplant/s1/manifest.json`. **No re-ingest and no re-summarize after this line, for any arm, at any W.**

### Step 2 — question set (offline extraction + one small paraphrase batch, ~$0.01)
- `eval/scripts/transplant.mjs --phase prep`:
  - Extract candidate literals (numbers, paths, identifiers, quoted decisions) occurring **exactly once** across all of L0; keep `{literal, seq, node_id}` as the answer key. Ambiguous/multi-hit literals dropped.
  - Stratify by seq against `K` (Step 3): `head` (seq < K), `tail` (seq ≥ K), `deep` (literal absent from **every** `node_summaries` body — forces search→fetch into raw L0).
  - Paraphrase each into a vocabulary-free question with `z-ai/glm-5.3-flash` (`cost.ts:69`) — third family; the paraphraser sees **only the raw L0 span**, never `node_id`, `branch_id`, or which retrieval tool would surface it.
  - **Leakage gate:** reject any question sharing a 3-gram with the source phase's stored summary, *after removing the answer literal itself* from the question's n-gram set.
  - Freeze `questions.json` + regex keys, hashed into the manifest. **3 questions per stratum × 3 strata = 9 primary**, plus 3 exploratory `spanning`.
- Grader: `exactMatchJudge` (`eval/src/scoring.ts:21`, dispatched at `:122`). `llm_rubric` (`:135`) is **forbidden** here — the paraphraser and the grader must never be the same mechanism. Grading spends zero live tokens.

### Step 3 — window derivation (offline, 0 tokens) — KILL GATE
- `ratio = ExactTokenizer(cl100k_base | qwen)(L0 sample) / heuristicSingleton(same)` — `packages/core/src/tokens/index.ts:104` and `:115`. **No API call**; a local BPE table only.
- Fractions (D19): response .05 / Zone A .10 / Zone B .20 / Zone C .20 / lazy .35 / slack .10 (.15 if `ratio > 1.15`), each **divided by `ratio`**.
- `K = 0.85·W/ratio − response` for `truncate-tail`. `W ∈ {16384, 32768}`.
- Feed Zone budgets through the **existing** flags `--zone-b-budget` / `--zone-c-budget` (`eval/src/run.ts:61-62`); export the derived `EVAL_LAZY_TOKENS=floor(0.35·W/ratio)` (consumed at `eval/src/loop.ts:761`). No `loop.ts` edit (Graft 6).
- **Gate:** assert `assemble(...).overBudget == []` at both W. If `ratio > 1.6` so that A+B+C+reply+4 schemas cannot fit 16k: set slack .20 with a shrunk Zone C; if still over, **drop the 16k/gpt-3.5 cell and publish qwen-only**, recording the reason. Do not proceed on a failing assertion.
- Nesting sweep (Graft 3): Zone B at W ⊂ Zone B at next-larger W for W ∈ {8k,16k,32k,64k,200k}; D5 creation order preserved at every W.

### Step 4 — compaction artifacts (live, ~$0.53)
- Rolling summary per W: `claude-haiku-4-5-20251001`, `maxSummaryTokens = 1024`, chunk = 0.5·W/ratio, oldest-first, running summary carried forward + verbatim tail. One artifact per `(trace, W)`, frozen, question-independent.

### Step 5 — tool-calling smoke (live, n=3/model, ~$0.10) — KILL GATE
- `TRANSPLANT_SMOKE=1` against `openai/gpt-3.5-turbo` and `qwen/qwen-2.5-72b-instruct` on the 4-tool contract (neither has ever run it; `or-smoke` covered only `deepseek-v4-flash` / `glm-5.3-flash`). Watch for `ModelCallError` on unparseable tool args (`packages/core/src/models/openrouter.ts:173-188`).
- If a model fails: that model's tree arm runs as `--arm tree-static` (A|B|C, no tools) and the `deep` stratum is reported as **untestable for that model**, not as a zero.

### Step 6 — live arms (~$3.7)
`eval/scripts/transplant.mjs --phase run --scenario s1 --window <W> --arm <id> --reps 5`, forked from `recall-probe.mjs:319-467` (`buildPrompt`:319, `TreeRetriever`:341, `MeteredProvider(new OpenRouterProvider(...), new InMemoryCostMeter({capUsd}))` replacing `:362-363`, per-condition `CostCapExceededError` break at `:459`).

| Arm id | Configuration | n / cell |
|---|---|---|
| `naive-full` | full transcript; **precondition, unscored** — expects HTTP 400 `context_length_exceeded` | 1 per model |
| `truncate-tail` | newest messages ≤ `K`; no summarizer anywhere | 5 |
| `compact-rolling` | Step-4 artifact + verbatim tail; **model, `maxSummaryTokens`, and total prompt budget pinned to `tree`** | 5 |
| `tree` | `EVAL_DET_ROOT=1 EVAL_NO_ATOOLS=1 EVAL_FETCH_EVENTS=1 EVAL_ROOT_KEEP=40 EVAL_LAZY_TOKENS=<derived> --zone-b-budget=<0.20W/ratio> --zone-c-budget=<0.20W/ratio>` | 5 |
| `tree-static` | fallback only, gated by Step 5 failure | 5 |
| `memgpt` | **plug point: the `--arm` switch in `--phase run`, over the same frozen manifest + `questions.json`.** Not built now. | — |

**n per cell = 5.** 9 questions × 3 scored arms × 5 reps × 2 models = **270 scored runs**, + 2 naive-full, + 6 smoke, + 90 exploratory `spanning` runs at n=3 → **~368 live calls**.

**Escalation, pre-registered:** per `(arm, stratum, model)` report MEAN of the 0/1 grade. If a stratum's `tree − compact-rolling` bootstrap 95% CI crosses 0 (or medians sit inside IQR overlap), raise per-cell n to `16·p̄(1−p̄)/Δ²` using observed `p̄` and `Δ`, cap 20, one escalation only; cross-check against the pooled-σ form and take the larger. Still overlapping → publish **"no detectable difference"**.

**Cost cap:** `InMemoryCostMeter({ capUsd: 3.00 })` per model, 6.00 total. Prices: `qwen/qwen-2.5-72b-instruct` $0.36/$0.40 and `openai/gpt-3.5-turbo` $0.50/$1.50 per 1M (`packages/core/src/models/cost.ts:72-73`, verified). Primary metrics are provider-independent — tokens, turns, MEAN graded score, duration, `fetched` flag; dollars derived only at those named prices.

### Scenario scale-out (no redesign)
`--traces <glob>`; every artifact path keyed by trace sha. Scenarios 2–3 are `b3553b4b-…jsonl` (3.89 MB) and `64fcdc13-…jsonl` (0.70 MB). Exclude `e8bcf788-…jsonl` — this session's live, still-growing transcript.

### Doc diff
`docs/IMPLEMENTATION_PLAN.md` §15 arms table: replace row C with rolling compaction as specified (arm-D leaf model + output cap + prompt budget; practitioner default, cf. Claude Code compaction); add deferred `C2` MemGPT row. New §15.2 *Cross-model transplant* with the numeric criterion (`tree ≥ compact-rolling + 0.25` mean on head; `tree ≥ truncate-tail − 0.05` on tail; n ≥ 5/arm/model, same epoch, same frozen store + question set). New **D19**: budgets derive from target window W as fractions, divided by the measured heuristic→BPE ratio; the hand-tuned lazy constant is removed as a rule — at W=32k, `EVAL_LAZY_TOKENS=30000` *was the entire window*. §17: add the offline BPE-ratio and Zone-B-nesting assertions. D5/D15/D17/D18 unchanged.

### VERIFICATION CHECKLIST — zero-live-token assertions first

**Phase 0 — ZERO LIVE TOKENS (all must pass before any API key is read):**
1. `sha256(trace.src.jsonl)` recorded; file byte length 4,663,077.
2. Import is hermetic: run Step 0 with network disabled; import + `ingest()` succeed. (D15 — reads only the JSONL + blob store + tree-sitter.)
3. `isMeta:true` lines counted as `skipped`, zero imported as user turns.
4. `unmapped tools -> "other"` list is empty after the `toolPhase` config addition.
5. L1 rebuild determinism: delete `nodes`/`node_summaries`, re-run `ingest()`, assert identical node ids and spans from L0+L2 alone.
6. Native token count of the full transcript, **real BPE not chars/4**, exceeds both 16,384 and 32,768 → the questions provably lie outside both windows. (Precondition; no API call.)
7. `ratio = ExactTokenizer / HeuristicTokenizer` computed and recorded; slack re-floored if `ratio > 1.15`; **hard stop if `ratio > 1.6`** without a passing mitigation.
8. `assemble(...).overBudget == []` at W = 16384 and 32768 with the derived budgets.
9. Zone-B nesting: prefix-subset across W ∈ {8k,16k,32k,64k,200k}; creation order intact (D5); `rootKeep=40` fold line present (D17); render caps respected (D18).
10. Mocked-LLM dry run of all three scored arms' prompt assembly: byte-identical Zone A+B prefix across reps and across questions within an arm; `context_fetch` results append **after** Zone C.
11. Uniqueness grep: every answer literal occurs exactly once in L0.
12. Leakage gate: zero questions share a 3-gram (answer literal excluded) with their source summary; `deep`-stratum literals absent from every summary body.
13. `questions.json`, manifest, and gate list hashed and committed; grader is `exactMatchJudge` and makes no model call.
14. Cost-cap plumbing: force a synthetic overspend, assert `CostCapExceededError` fires and the loop breaks.

**Phase 1 — live, in this order:**
15. Smoke: `TRANSPLANT_SMOKE=1`, n=3 per model on the 4-tool contract. Any `ModelCallError` → that model routes to `tree-static`.
16. `naive-full`, n=1 per model → expect 400 `context_length_exceeded`, logged as precondition evidence.
17. Batch, one `(model, W)` cell at a time, arms interleaved within a cell so all arms share one epoch: `truncate-tail`, `compact-rolling`, `tree` × 9 questions × n=5.
18. Exploratory `spanning`, n=3, reported separately and flagged exploratory.
19. Verdict: MEAN score / tokens / turns / duration per `(arm, stratum, model)`; `fetched` split for the tree arm; bootstrap CI on `tree − compact-rolling`; escalate per the pre-registered rule. **Report a tail-stratum tree loss as a regression, not a tradeoff.**
---

## Router deviation log (2026-09-01, post-implementation)

The spec requires deviations be recorded here. Each entry states what changed and why.

**R1 — Step 1 actual spend $0.689, not ~$0.36.** 21 leaves on claude-haiku-4-5; the real
branches carry heavier detail prompts than the estimate assumed. Under the $1 step cap;
root composed deterministically (`deterministic-rollup-v1`), zero root tokens.

**R2 — rootKeep is window-derived (D19 extension).** With 21 real summarized branches the
RENDERED deterministic root block is 6,917 heuristic tokens at rootKeep=40 (text 1,682 +
merged-meta lists) — alone above the 16k cell's Zone B budget of 3,850, so g8 failed with
every branch summary already dropped (the assembler's drop floor is the root, by design).
D17's fold shrinks the merged meta with the keep window (3,967 @keep8, 2,587 @keep2), so
the harness now derives rootKeep per window: the largest keep whose rendered root block
fits 0.5 × the Zone B budget. This extends the judge's own D19 rule — budgets derive from
W — to the one knob the spec had pinned at 40. The manifest freeze records a per-window
{rootKeep, root summary sha}; leaf summaries remain the frozen invariant.

**R3 — g9 redefined from prefix-subset to newest-aligned suffix-subset (root excluded).**
Under rule-4 drop-oldest, a smaller window's branch list is a contiguous SUFFIX of a larger
window's list, not a prefix; the root block legitimately differs per window under R2. The
monotone-nesting claim survives in the corrected form.

**R4 — g8 additionally asserts ≥1 newest branch summary survives in Zone B per window.**
A root-only Zone B would pass overBudget==[] while silently gutting the tail stratum.

**R5 — the 0.5 × zoneB root-share ceiling (R2) is replaced by the assembly-grounded rule.**
The share was a proxy constant with no basis; at 16k it declared the cell dead while the
real assembly fits (keep-2 root 2,587 + newest branches ≤ 3,850 with overBudget empty).
rootKeep is now the largest rung whose ASSEMBLED Zone B satisfies g8's own invariant —
fits its budget with ≥1 branch summary surviving. One rule serves derivation and gate.
The 8k window's death is real under either rule and stands. Decided by the router after
the implementing agent correctly refused to tune the share constant to rescue the cell.

**R6 — ladder order stays largest-passing; the visibility tradeoff is pre-registered, not
decided.** At 32k the rule picks keep=16 (2 branch summaries + 14 extra root headlines)
where smaller keeps yield up to 11 summaries (diagnostic numbers in gates.json). Headlines
are search pointers, summaries are content; the shipped D17 posture is headline-rich, and
swapping policies inside this experiment would bundle a second change. Pre-registered
ablation trigger: tree below truncate-tail − 0.05 on the tail stratum → rerun the tree arm
with smallest-passing ladder order, nothing else changed. Also pre-registered
interpretation (agent's honesty line): at 16k visibility ends at seq 732 (1 branch, ~3% of
L0) and the truncation boundary is seq 720, so the 16k tree cell scores context_search→
context_fetch retrieval almost exclusively — it is a test of the recall claim, not of
summaries-in-prompt.
