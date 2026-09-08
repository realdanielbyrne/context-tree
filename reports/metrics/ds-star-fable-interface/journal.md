# DS-STAR pass journal — Fable 5.1 retrieval interface vs context-tree

Started 2026-09-04 08:53 CDT. Mode 1 (improvement loop). Router: main session. All roles on
`claude-opus-4-6[1m]` via the Workflow tool (user directive 08:59; the Agent tool's `model`
override cannot express that id, and a project agent type written mid-session is not loaded
until restart — `.claude/agents/ds-star-role.md` exists for future sessions).

## Iteration 0 — orientation (main loop, zero live tokens)

- Leaked Claude Fable 5.1 system prompt (CL4R1T4S, fetched 08:54): 274,608 characters in the
  markdown body, **60,903 cl100k tokens** (gpt-tokenizer `countTokens`, the harness's exact
  tokenizer; 4.51 chars/token). The user's 270,000-character figure is confirmed. Anthropic's
  own tokenizer is not available here; the cl100k count is the pad size the harness can use.
- The `past_chats_tools` section and the three tool schemas are quoted verbatim in
  `fable-5.1-past-chats-tools.md`. Interface facts: `conversation_search` default 5 hits, max
  10, each a snippet with a `page_token`; `read_conversation` opens AT the hit, `max_turns`
  default 20 / max 50, next/prev tokens; guidance: content-noun queries, open one or two chats
  per question, read once, page only when the answer is visibly cut off.
- These tools are claude.ai server-side. They are not callable from this repository and are
  not open source; the ranking internals are unobservable. The interface (unit, k, hit
  content, addressing, read sizing, guidance) is fully observable and is what this pass ports.
- Prior pass (`ds-star-search-centering-and-payload-report.md`): at W=65,536 the tree's first
  tool turn arrives near 62k tokens with ~7.9k headroom; a 20-hit search cost 6.1-7.3k of it.
  Its proposed next experiment: naive-full + tree-search-coordinates at W ≥ 200,000.

## Workflow run wf_3e5b3179-6c0 (analyze → plan → judge)

Launched 09:03. Four analyzer lenses (a1 interface delta, a2 regime arithmetic, a3 prior-pass
audit, a4 harness feasibility), three planners (published alternative, regime first, null
hypothesis), one judge. Outputs land as sibling files in this directory.

## Iteration 0b — probing Anthropic's tools live in claude.ai (09:14-09:35)

Correction to the 09:08 statement: the tools ARE callable, in claude.ai web/desktop/mobile on
paid plans (support article 11817273), not from Claude Code. Driven through the Claude-in-Chrome
extension against the user's own account and one of the user's own chats (their suggestion;
avoids the seeding question). Full log: `claude-ai-probe-answer-key.md`. Headline: 4/5 literal
questions correct in one turn with one search and zero reads; 5 hits per search, 1-2 summaries +
3-4 chunks of ~200-300 words each; the one miss was a summary-paraphrase answer to a literal the
returned chunks did not cover; the second hop the model reaches for is a scoped re-search, not a
page read. The internal API (`/api/organizations/...`) was blocked by the permission classifier,
so per-hit structure is the model's self-report, not observed bytes.

## Kill gate KG-1 — question-set validity per effective window (exact, main loop, 09:40)

`truncationBoundarySeq` on the real L0/L2 with `deriveBudgets(W, 0.8509).K` (command in this
entry's commit; A2's linear approximation was 31-87 seq high, direction conservative):

| effective W | K (heur) | tail boundary seq | deep valid | overflow valid |
|---|---|---|---|---|
| 65,536 | 61,616 | 523 | 5/5 | 5/5 |
| 98,304 | 92,424 | 376 | 5/5 | 2/5 |
| 130,000 (= 200k host − 70k pad) | 122,224 | 271 | **5/5** | 1/5 |
| 131,072 | 123,232 | 268 | 5/5 | 1/5 |
| 163,840 | 154,040 | 244 | 4/5 (seq 264 decays) | 1/5 |
| 200,000 | 188,037 | 108 | **1/5** | 0/5 |
| 270,000 | 253,850 | 1 | 0/5 | 0/5 |

Consequence: on the s1 trace, `questions-deep.json` is a valid overflow instrument only up to an
effective window of about 150k. "W=200,000 with no pad" — the prior report's proposed next
experiment — is NOT an overflow test on this trace (4 of 5 answers sit in truncate-tail's tail).
The realistic-host cell is effective W = 130,000 (a 200k window carrying a 61-70k system
prompt), where the deep set is fully valid and the first tool turn has ~18k tokens of headroom
(A2 §2) instead of ~8-9k at W=65,536.

## Iteration 1 — regime shift, preregistered 09:47 (before the batch started)

All three planners (`plan-*.md`) put the same item first: no code change, effective window
130,000, arms {truncate-tail, tree-tail-v2, tree-search-coordinates}, `questions-deep.json`,
n=5, `z-ai/glm-5.3-flash`. Kill gates: KG-1 validity 5/5 (exact, above); KG-2 headroom at
first tool turn ≈ 18.3k > 1.4k search + a 6k fetch band (A2 §2); KG-3 not a dead cell.

Command:
`node eval/scripts/transplant.mjs --phase run --scenario s1 --window 130000 --arm truncate-tail,tree-tail-v2,tree-search-coordinates --questions-file questions-deep.json --reps 5 --model z-ai/glm-5.3-flash`

Pre-registered, all on the deep stratum (the only stratum; nothing exploratory):
- Precondition: truncate-tail = 0/25 (the set is still overflow at this window; if it scores,
  the instrument decayed and the cell is void).
- H1 starvation: tree-tail-v2 at 130k ≥ 5/25 (its 65k score is 1/25; +4 is the threshold the
  prior pass used). Below that, headroom was not the binding constraint.
- H2 compact search: tree-search-coordinates − tree-tail-v2 ≥ +4/25 in this same batch. Else
  the compact list is bucket-inert at this headroom (report as such, not as a loss).
- Mechanism fields to read before any verdict: per-row `toolCalls[].afterChars > 0` rate,
  `answerLiteralPresentAfterCap`, `resultTokensTruncated`, median turns, input tokens; then
  `provenance-audit.mjs` on the result file.
- Escalation: if H1 or H2 lands within ±2 of its threshold, raise n to 10 for all three arms
  once; no further escalation.

**Amendment 09:52, before any row ran:** the harness rejects windows off the manifest ladder
(`--window must be one of 16384 … 1000000`, transplant.mjs:4159), and `root_by_window` only
carries folds for ladder windows. Cell moved from 130,000 to **131,072** (deep 5/5 valid, boundary
268; models a 200k host with a 69k system prompt). Thresholds unchanged. Command:
`node eval/scripts/transplant.mjs --phase run --scenario s1 --window 131072 --arm truncate-tail,tree-tail-v2,tree-search-coordinates --questions-file questions-deep.json --reps 5 --model z-ai/glm-5.3-flash`

## Iteration 1 — result (batch finished 10:22; $0.458; 75 rows; file
`results/run-W131072-truncate-tail+tree-tail-v2+tree-search-coordinates-questions-deep-q9ebc3150-cbb15b5961243-n5-z-ai_glm-5.3-flash.json`, code 4f141fe)

| arm | exact match | completed / model_call_error / stalled / turn_cap | per question (qo01..qo05) | median turns | median input tok |
|---|---|---|---|---|---|
| truncate-tail | **0/25** | 22 / 0 / 0 / 3 | 0,0,0,0,0 | 1 | 4,188 |
| tree-tail-v2 | **5/25** (was 1/25 at 65k) | 19 / 6 / 0 / 0 | 0,0,**5**,0,0 | 3 | 31,508 |
| tree-search-coordinates | **5/25** (first live rows ever) | 18 / 5 / 2 / 0 | 1,0,0,**4**,0 | 3 | 23,430 |

Provenance audit: 10/10 successes earned, 0 needing no retrieval. Precondition holds (tail 0/25).
H1 (starvation) met exactly at threshold: 5/25 ≥ 5/25. H2 (compact search vs tail-v2) = +0 on the
headline — but the composition differs completely, and the arm carries TWO variables against
tail-v2 (compact hit list AND bare-filename centering), so H2 is unattributable as run.

Mechanisms read from `toolCalls[]`:
- **qo04 (57.9k-char branch): centering, enabled by headroom.** tail-v2 centred at seq 55/93/115
  (legacy extractor) and the literal was absent after the cap in every fetch; coordinates centred
  at **218** in 4/4 fetches, delivered ~49.7k chars (band ≈ 12k tokens), literal present, 4/5
  scored. At 65k the same centring delivered nothing (prior pass). Attribution: centring × headroom.
- **qo03 (rank 7): display regression.** Full-surface hits → correct branch fetched FIRST 5/5.
  Compact coordinates (no `meta.files/symbols`) → a distractor fetched first 5/5; the correct
  branch was reached only after the headroom was spent (later fetches 0 chars). Stripping the
  metadata made the rank-7 hit illegible. This is `search-hit-display-not-ranking` in reverse.
- **qo05: instrument defect — distractor decay.** 9/10 tree rows never called a tool and answered
  "Build, test, and check suite status" from seq 329, a near-duplicate pnpm-build-then-vitest
  command that sits INSIDE the tail at this window (boundary 268) but outside it at 65k (523).
  The literal-uniqueness gate checks the answer string, not the question's referent. New hazard.
- **qo02: wrong branch** (2 completed rows fetched a distractor, 34k/27k chars delivered).
- **qo01: mostly provider failure**; one coordinates row fetched correctly and scored.
- **Provider hazard:** 11/50 tree rows `model_call_error` ("openrouter returned no content and no
  tool calls, finish_reason=stop, completion_tokens≈3") at ~105-125k-token prompts on GLM 5.3
  Flash, all on qo01/qo02. Unconditional scores keep them in the denominator; conditional on
  completed: tail-v2 5/19, coordinates 5/18.

Route: split verdict → **ablation** (10:31): `tree-center-filename` at W=131,072, n=5, same code
epoch (full-surface hits + bare-filename centring). Isolates display against coordinates and
centring against tail-v2. Pre-registered: if center-filename ≥ 8/25 with qo03 ≥ 4/5 and qo04 ≥
3/5, the compact display is refuted for selection and centring is confirmed as the qo04 mechanism.

## Iteration 3 — candidate built and gated (10:55), preregistered before its batch

Candidate `tree-snippet-hits` (eval/scripts/transplant.mjs: `snippetHitsFor`, `excerptAround`,
`SNIPPET_HIT_COUNT = 5`, `SNIPPET_CHARS = 1000`; handler branch in `handlersForArm`; tool
description addendum in `toolSchemasForArm`; telemetry `excerptChars`, `excerptHits`,
`answerLiteralInExcerpts`). ONE variable against `tree-center-filename`: the search UNIT. The
ranker still ranks the same 20 branches; the model is shown the 5 best-matching EVENTS across
them (scored by the retriever's own `findRelevantCenter`), each with its `seq` and a 1,000-char
excerpt of its own text. Both constants are taken from the observed claude.ai interface
(5 hits; ~200-360-word chunks), per algorithm.md rule 3, and are unvalidated on this host.

Kill gate `eval/scripts/snippet-hits-killgate.mjs` (zero live tokens; replays the 56 distinct
queries the model issued in the iteration-1 cell): NS1 excerpt survives the strip — PASS on 56/56;
NS2 payload < ¼ of the 18.3k headroom — PASS (median 1,693 tokens, max 1,926); NS3 mechanism fires
on every query — PASS. Report-only: **answer literal inside an excerpt on 48/56 queries; answer
branch visible 49/56; answer EVENT visible 53/56.** qo02's literal (`timeCapMs`) is in none of its
excerpts (event visible at rank 2, literal outside the 1,000-char window); qo05's top hit is seq
193 with the exact description. Sample excerpts printed by the gate.

Batch (after iteration 2 finishes, so the provider is not hit by two batches):
`node eval/scripts/transplant.mjs --phase run --scenario s1 --window 131072 --arm tree-center-filename,tree-snippet-hits --questions-file questions-deep.json --reps 5 --model z-ai/glm-5.3-flash`
`tree-center-filename` re-runs in the same batch because the code fingerprint changed (new epoch).
Pre-registered: primary — snippet-hits − center-filename ≥ +4/25 exact match. Mechanism —
`answerLiteralInExcerpts` true on the first search for the questions the gate predicts (qo01, qo03,
qo04, qo05), fewer median turns and fewer fetches than center-filename. Exploratory — qo05 (the
never-searched defect is upstream of search; a snippet cannot help a run that never searches) and
qo02 (literal not in excerpts offline). Escalation: if within ±2 of threshold, raise n to 10 for
both arms once.
- 11:00 iteration-3 batch launched concurrently with the still-running iteration-2 batch (both single-request sequential loops; separate result files by code fingerprint).

**Provider-failure signature (11:05).** Every `model_call_error` in iterations 1-3 so far reads
`finish_reason=stop, completion_tokens=N, reasoning_tokens=R` with N − R ≈ 40-60 tokens, empty
`content`, no `tool_calls` (`packages/core/src/models/openrouter.ts:187`). Not a budget cut
(finish_reason is `stop`, no maxTokens set). GLM 5.3 Flash appears to emit a tool call that
OpenRouter does not surface in `tool_calls` at 105-125k-token prompts; the raw body is not logged
so this cannot be confirmed. Harness open item, deliberately NOT fixed mid-pass (it would shift the
epoch): retry once on this signature and persist the raw choice for diagnosis. Rows stay in the
denominator; completed-conditional scores are reported alongside.

## Iteration 2 — ablation result (batch finished 10:55; $0.211; 25 rows; file
`results/run-W131072-tree-center-filename-questions-deep-q9ebc3150-cbb15b5961243-n5-z-ai_glm-5.3-flash.json`, code 4f141fe — same epoch as iteration 1)

| arm (W=131,072, deep, n=5) | raw | after provenance audit | qo01 qo02 qo03 qo04 qo05 | completed / provider error | median turns | median input |
|---|---|---|---|---|---|---|
| tree-tail-v2 (iter 1) | 5/25 | 5/25 | 0 0 5 0 0 | 19 / 6 | 3 | 31,508 |
| tree-search-coordinates (iter 1) | 5/25 | 5/25 | 1 0 0 4 0 | 18 / 5 (+2 stalled) | 3 | 23,430 |
| **tree-center-filename** | 9/25 | **8/25** | 0 1→0 5 3 0 | 21 / 4 | 3 | 26,835 |

Nulled: qo02 rep 5 scored `timeCapMs` with no fetch carrying the literal (first fetch wrong
branch, 11,122 chars; later fetches 757 and 0 chars) — a guess, not a retrieval; the audit's
"earned" rule removed it. Pre-registered criterion (≥ 8/25 with qo03 ≥ 4/5 and qo04 ≥ 3/5): **met,
at the threshold**.

Attribution now closes: full-surface hits + bare-filename centring holds qo03 (5/5, first fetch
correct 5/5, 10,515 chars, no cut) AND takes qo04 (3/5; the two misses were one run whose query
centred at 55 and one that centred at 218 but had spent its headroom on a second search — 8,688
chars arrived, literal cut). The compact coordinate list cost qo03 outright (iteration 1) and is
**retired as the default display** for the shipped arm; the bare-filename centring is confirmed
and stays. qo05 remains 0/5 with 0 tool calls in 5/5 runs (distractor decay, instrument).
qo01: correct branch fetched in one run but every fetch returned ≤149 chars before the cap —
the branch's rendered events are tiny (tool_result excerpts) and the model kept re-searching;
open. Provider failures 4/25.

## Iteration 3 — result (batch finished 11:06; $0.299; 50 rows; file
`results/run-W131072-tree-center-filename+tree-snippet-hits-questions-deep-q9ebc3150-cd956c49f5ef4-n5-z-ai_glm-5.3-flash.json`, code 4f141fe + uncommitted harness edit → new codeKey cd956c49f5ef4)

| arm (W=131,072, deep, n=5, same batch) | earned | qo01 qo02 qo03 qo04 qo05 | completed / provider error / stalled | median turns | median input tok | total input tok | mean fetches | mean searches |
|---|---|---|---|---|---|---|---|---|
| tree-center-filename (baseline, rerun) | **6/25** | 0 0 5 1 0 | 19 / 4 / 2 | 3 | 24,596 | 698,680 | 1.42 | 1.63 |
| **tree-snippet-hits** | **15/25** | **5** 0 **5** **5** 0 | 21 / 4 / 0 | **2** | **10,214** | **318,449** | **0.05** | 1.14 |

Pre-registered primary (≥ +4/25): **+9, met.** Mechanism: `answerLiteralInExcerpts` true on the
first search in 12/15 scoring runs and on a second search in the other 3 (qo04 reps 1, 3, 4, whose
first query matched no event); **all 15 successes were answered with zero fetches** — the hit list
was the payload. Turns 2 vs 3; fetches 0.05 vs 1.42 per run; input tokens −54%. qo02 0/5 (4 provider
errors; the one completed run's excerpts lacked `timeCapMs`, as the offline gate predicted). qo05
0/5 with 0 tool calls in 5/5 runs (instrument, unchanged). Baseline variance: center-filename fell
from 8/25 (iteration 2) to 6/25 here (qo04 3/5 → 1/5, two stalls), same code path; n=5 noise on a
question whose delivery sits at the cap edge.

**Instrument fix, made and re-run before believing the number (11:12):** `provenance-audit.mjs`
only credited literals served by the prompt or by a FETCHED branch, so it marked all 15 as
"unverifiable". Added `earned-search` — the literal present in an appended, capped search result,
read from the recorded `answerLiteralPresentAfterCap` on `context_search` calls (recorded, not
reconstructed). Re-audit: snippet-hits 15/25 → 15/25, 0 unverifiable; no other arm's number moved;
corpus total 245 → 239 (6 unearned, none in this arm).

Route: clean win on its bucket (delivery via the hit) and on the headline; the pass's three
iterations are spent. Stop, report. Promotion to the library default is a decision for the
checkpoint, not the loop; the arm is harness-only (`transplant.mjs`) and `packages/` is unchanged.


## Library port (14:12-14:35, user request "update the library")

TDD: 7 RED tests (core `excerptAround` ×2, `searchEvents` ×3; mcp event-hit ×2) → GREEN. Shipped:
`TreeRetriever.searchEvents` + `excerptAround` in `packages/core/src/retrieve/`; `context_search`
in `packages/mcp` returns event hits (`seq`, `excerpt`, `branch_rank`); `retrieval.eventHits` (5) and
`retrieval.excerptChars` (1,000) in config; contract v1-v3 bullet rewritten; §19 Q2 decided in
`docs/IMPLEMENTATION_PLAN.md`. Harness: historical arms now call `branchSearch` (the pre-port
handler, kept byte-compatible); `tree-snippet-hits` is the library as shipped; harness-local
`snippetHitsFor` deleted.

Two defects the port surfaced, both caught by tests/gates before commit:
1. **Shared events need a most-specific owner.** Branches nest (task ⊃ phase ⊃ file); the harness
   arm let the first-ranked branch claim a shared event, so on the mcp fixture the task root
   swallowed the implementation phase's events. Fixed: attribute to the smallest span; ORDER by the
   best rank of any containing branch (ordering by the specific branch's rank regressed the gate
   48→41/56 literal-in-excerpt).
2. **Pointer meta on an event hit re-inflates the payload.** The first port carried the branch's
   `meta.files` on each hit; three recorded queries hit 4,666-6,136 tokens (NS2 fail). Removed —
   the excerpt is the legibility signal; gate back to 48/56 literal, 53/56 event, median 1,750
   tokens (was 1,693 in the harness arm; `summary_version`/`branch_rank` account for the rest).

Full suite after port: 977 passed, 9 skipped. `pnpm build` emits core/mcp/cli; the pre-existing
`eval/src/run.ts:104` error is unchanged. Not re-measured live: the port is behaviourally identical
to the arm on the offline gate, but a same-batch live confirmation (`tree-center-filename` vs
`tree-snippet-hits`, W=131,072, n=5, ~$0.30) is the honest next step before any claim that the
shipped library scores 15/25.

## Live confirmation of the shipped library (launched 16:15, user: "run it")

Same cell as iteration 3, new code epoch (543e679): `tree-center-filename` (branchSearch, the
pre-port surface) vs `tree-snippet-hits` (= the library's `context_search` as shipped), W=131,072,
deep set, n=5, GLM 5.3 Flash. Pre-registered: the library arm reproduces iteration 3 within noise —
snippet-hits − center-filename ≥ +4/25; all successes with zero fetches; qo01/qo03/qo04 ≥ 4/5 each.
A shortfall would point at the two port changes (most-specific attribution; meta removed).
Command: `node eval/scripts/transplant.mjs --phase run --scenario s1 --window 131072 --arm tree-center-filename,tree-snippet-hits --questions-file questions-deep.json --reps 5 --model z-ai/glm-5.3-flash`

**Result (16:48; $0.347; file `results/run-W131072-tree-center-filename+tree-snippet-hits-questions-deep-q9ebc3150-cefc5ddcbf54b-n5-z-ai_glm-5.3-flash.json`, code 543e679):**
center-filename 6/25 (0,0,5,1,0), snippet-hits (library) **15/25** (5,0,5,5,0); 25/25 completed in both
arms (no provider failures this batch); median turns 3 vs 2; wins with zero fetches 0 vs 15; uncached
input 448,828 vs 209,419; cache-read 10,147,776 vs 8,524,928. Provenance audit: 30/30 snippet-hits
successes earned across the two batches. Pre-registered criterion (≥ +4, all wins fetch-free,
qo01/qo03/qo04 ≥ 4/5): met; exact reproduction of iteration 3. The shipped library scores what the
harness arm scored.

**Design gap raised by the user (16:51):** the harness builds the prompt once and appends every
tool result; nothing re-evaluates the window per turn, so headroom is spent by the second or third
result and the append cap truncates the newest one (qo02: third search cut to 95 tokens). The
shipped assembler only rewrites Zone C at phase boundaries. Open item: an elastic tail — recompute
the raw-tail boundary each turn as W − (A + B + appended results + reply), so retrieved detail
displaces passive recency; measure the cache cost of rewriting the tail block.

## Plan approved 23:31 — per-turn window management + null arms (`~/.claude/plans/squishy-inventing-cloud.md`)

Historical read (Explore, 17:13) recorded in the plan §1: no design ever cached CLAUDE.md/skills;
thrashing had three causes (window stalls at 32k; large-W loops from losing the agent's last action;
threshold-transition artefacts); tree beat transcript on TASK success at large W (62/62 vs 20/22),
so the null arms are primary for the Q&A regime and the user's hypothesis is tested on tasks in step 8.

## Plan execution (23:31 → 00:40) — steps 2-6 done, zero live tokens

- Core (21a3e14): `ZoneAssembler` enforces the window when one is known — oldest SEEN ephemeral
  tail entries evicted first, Zone C events as the last valve, both reported
  (`evictedFromTail`, `droppedFromZoneC`); reply reserve from `replyHeadroom(window)`; simulator
  test: eviction leaves A and B cached, divergence in the tail, cacheWrite 0. `HarnessOptions.window`
  plumbed into the live loop (opt-in). Core 62/62.
- Harness (33c0d58, cfdd5f2, + this commit): `tree-snippet-hits-elastic` (per-turn tail rebuild,
  latched, evict-ahead one reply share, exhausted tail sends no header, seen appended results
  evicted last); null arms `flat-events` and `prefix-plus-retrieval`; `renderTailWithin` measures
  the rendered tail whole (per-event sums under-count across seams). Transplant tests 56/56.
- Kill gate `eval/scripts/elastic-tail-killgate.mjs` on the 118 recorded W=131,072 runs (435 calls):
  EG1 overflows **0** (was 2 before seen-result eviction; both the same run, tail empty, the
  model's reply text tipping the next request). EG2 truncations **9/435 vs 198 recorded**; the 9 are
  results larger than the whole remaining window (5 with the tail already exhausted). EG1b 3
  seen results evicted. EG3 tail moved on 63 turns, mean **52,418 fresh tokens re-sent per move**
  (the predicted ~2× uncached bill on moving turns). EG4 **76/186** recorded cut-without-literal
  calls now arrive with the literal. EG5 both null arms fit for all 5 questions; prefill hits
  8/4/68/23/434 for qo01-qo05 (qo05 fills 101k tokens), literal in the prefill for 4/5 (qo02 ✗, the
  excerpt-window miss).
- Provenance audit extended: elastic arms' turn-1 tail included in the prompt view; a row whose
  prefill carried the literal is `earned-prompt`. Existing cells unchanged (30/50 snippet-hits).

## Live batch, pre-registered (00:45) — plan §2c

Cell: W=131,072, `questions-deep.json`, n=5, `z-ai/glm-5.3-flash`, one batch, code epoch = the
commit above. Arms: `tree-snippet-hits` (static tail, the baseline), `tree-snippet-hits-elastic`,
`flat-events`, `prefix-plus-retrieval`. Command:
`node eval/scripts/transplant.mjs --phase run --scenario s1 --window 131072 --arm tree-snippet-hits,tree-snippet-hits-elastic,flat-events,prefix-plus-retrieval --questions-file questions-deep.json --reps 5 --model z-ai/glm-5.3-flash`
Pre-registered (deep only, nothing exploratory):
- Hard: elastic arm has 0 appended-result truncations while its tail had events (`turns[].tailEvents`
  > 0 at the previous send) — the gate's EG2 property, live.
- Elastic ≥ snippet-hits − 1/25 (non-inferiority; the mechanism is about effort, not selection).
  Report uncached and cache-read input per arm: expect ≈ 2× uncached on runs where the tail moved.
- flat-events within ±2/25 of elastic ⇒ Zone B and branch ranking are inert for this task class.
- prefix-plus-retrieval ≥ elastic ⇒ proactive fill leads; also record `prefill.answerLiteralInPrefill`
  and how often the model still called a tool.
- Escalation: if any decisive pair lands within ±2, raise n to 10 for all four arms once.
- Mechanism fields read before any verdict: `tailMoved`, `evictedResults`, `resultsTruncated`,
  `prefill.*`, fetches per run, provenance audit.

## Step 8 built (00:55-01:10) — `prefix-retrieval` arm in the live task loop (7713029)

`eval/src/loop.ts` `runPrefixRetrievalArm`: cached prefix = native system prompt + tool schemas
+ `CLAUDE.md` (1,751 tokens); per turn: task, a `[retrieved from this session]` block of event
excerpts scored over the run's own L0 root span for the model's current focus and filled to
`W − prefix − slice − reply`, then a recency slice of its latest exchanges within the derived
`slack` share (13,107 tokens at W=131,072; the last exchange always kept). Exchanges appended to
L0 as in the tree arm; no summaries. Refuses without `options.window`. `run.ts` passes `--window`
and sets `timeCapMs`, which cleared the old build error — `pnpm build` is clean for the first
time this week. Zero-token gate: turn-1 request ≈ 2.4k tokens for sw-1 and sw-2, fits.
Smoke (GLM 5.3 Flash, sw-1, cap $0.30, run id `step8-smoke-glm`) launched to prove the arm
end-to-end before the Sonnet 5 batch.

**Smoke result (00:03):** `prefix-retrieval` on sw-1-jsonc, GLM 5.3 Flash: completed, hidden tests
pass (success=true), 12 turns, 17 tool calls, 108,409 tokens (89,262 in / 19,147 out), $0.0115.
The arm runs end to end (`eval/results/step8-smoke-glm/`).

## Step 8 live batch, pre-registered (00:05) — task completion, Sonnet 5

Arms `native` (EVAL_NATIVE_CACHE=1, the fair transcript baseline), `context-tree` (current default,
with `--window` so the assembler enforces it), `prefix-retrieval`; scenarios sw-1-jsonc and
sw-2-multimod (`--benchmarks deepswe-agents-last-exam --limit 2`); W=131,072; model `claude-sonnet-5`
for agent and summarizers; judge `claude-sonnet-5` too (command judges do not call the model);
`--cost-cap-usd 1.0` per run. n=3 first (`step8-sonnet-r1..r3`, 18 runs, est. $5-8), escalating to
n=5 only if the decisive pair lands within one success per scenario. Pre-registered: success rate
per scenario (primary), then turns, total tokens, cache-read/write per arm. If prefix-retrieval
matches the tree's success at fewer tokens, Zone B is retired to a caching-only role; if it loses,
the record's boundedness advantage stands and steps 2a/2b are the fix.
Command per rep: `EVAL_NATIVE_CACHE=1 node eval/dist/run.js --benchmarks deepswe-agents-last-exam --arms native,context-tree,prefix-retrieval --limit 2 --window 131072 --model claude-sonnet-5 --leaf-model claude-haiku-4-5-20251001 --root-model claude-sonnet-5 --judge-model claude-sonnet-5 --cost-cap-usd 1.0 --run-id step8-sonnet-rN --no-langfuse`

## Four-arm Q&A batch — result (00:12; $0.368; 100 rows; file
`results/run-W131072-tree-snippet-hits+tree-snippet-hits-elastic+flat-events+prefix-plus-retrieval-questions-deep-q9ebc3150-c1165171b8a30-n5-z-ai_glm-5.3-flash.json`, code d5a9f4f)

| arm | earned | qo01 qo02 qo03 qo04 qo05 | completed / provider error | median turns | no-tool runs | wins w/o fetch | uncached input | cache-read | truncated appends |
|---|---|---|---|---|---|---|---|---|---|
| tree-snippet-hits (static tail) | 16/25 | 5 1 5 5 0 | 24 / 1 | 2 | 5 | 15 | 405,170 | 5,559,552 | 2 |
| tree-snippet-hits-elastic | 16/25 | 3 1 5 5 2 | 19 / 6 | 2 | 3 | 15 | 224,814 | 4,239,360 | **0** |
| flat-events (no Zone B) | 15/25 | 3 1 5 5 1 | 20 / 5 | 2 | 4 | 14 | 469,196 | 4,126,464 | 0 |
| **prefix-plus-retrieval** | **25/25** | 5 5 5 5 5 | **25 / 0** | **1** | **20** | 20 | 488,826 | 1,428,480 | 0 |

Provenance audit: every success earned; prefix-plus-retrieval 20/25 `earned-prompt` (the prefill
carried the literal: hits median 23, 6,879 tokens) and 5/25 via the model's own search/fetch.
Pre-registered verdicts: elastic hard gate PASS (0 truncations); elastic ≥ snippet − 1 → 16 vs 16
PASS at 44% less uncached input per completed run; flat-events within ±2 of elastic → 15 vs 16 →
**Zone B and branch ranking are inert for this task class**; prefix-plus-retrieval ≥ elastic →
**25 vs 16, proactive fill leads**, with no provider empty-turn failures (its requests are ~20-40k
tokens, not 105-125k) and a 1-turn median.
Pre-mortem: qo05 favours the prefix arm because its 13k recency slice excludes the seq-329
distractor the tail arms carry (instrument, plan §1); excluding qo05 it is still 20/20 vs 14/20
(elastic) and 16/20 (static). The elastic arm's 6 provider errors (vs 1 for static) are GLM's
empty-turn failure at ~110-125k prompts, not a mechanism difference; completed-conditional it is
16/19 vs 16/24.


## Step 8 result (01:12; Sonnet 5, W=131,072, n=3, 18 runs, $7.5 total; files copied to
`reports/metrics/ds-star-fable-interface/step8-sonnet/`)

sw-1: native 3/3 (median 22 turns, $0.118), context-tree 3/3 (8 turns, $0.208), prefix-retrieval 3/3
(11 turns, $0.435; one run hit the $1 cap at 34 turns with 431,942 uncached input tokens — the
retrieval fill is fresh input every turn). sw-2: native 3/3 (30 turns, $0.255), context-tree 3/3 (24
turns, $0.943; one cap hit during root summarization), **prefix-retrieval 0/3 — stalled every
replicate**, the last 4-6 turns of each being repeated `run_command` calls with 90-100k tokens of
headroom left: the investigate-1 loop (an agent that cannot see what it has done re-verifies).
Pre-registered verdict: prefix-retrieval does NOT match the tree on task completion; the record's
boundedness advantage stands; the design needs a ledger of completed steps (candidate role for Zone
B) before it can be a task arm. No escalation to n=5: 0/3 vs 3/3 is not within noise.
