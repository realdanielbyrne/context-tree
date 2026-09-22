# U18 — does a soft limit hold accuracy at ~1/3 of the window?

Pre-registration. Written before any arm ran; the rules here are the ones `lib.mjs` executes.
Source hypothesis: `reports/session-handoff.md` § U18.

**Hypothesis.** At `W_soft = 50,347` tokens (1/3 of the 151,040 Swift-NVFP4 serves) the agent solves
what it solves at the full window, at materially lower achieved peak.

## Terms

The algorithm's own terms — **unit**, **turn**, **phase**, **chunk**, **anchor**, **assemble**,
**evict**, **pinned**, the **heuristic tokenizer** and why the served-per-heuristic ratio is a
measurement and never a constant — are defined once, in [`reports/algorithm.md`](../../reports/algorithm.md).
Only what is specific to this harness is defined here:

- **Sidecar (host adapter)** — `experiments/context-dedup/ct-sidecar.mjs`: one Node process per run,
  inside the sandbox. It follows opencode's session db into L0 (stamping each event with its message
  id, which is what makes a unit a host message) and serves the `@context-tree/mcp` tools. No
  pipeline logic.
- **Plugin** — `oc-plugin/ct-assemble-plugin.mjs`: runs inside opencode at
  `experimental.chat.messages.transform`, the only point where the prompt can be edited. A
  treatment turn calls `assemble`, then `evict` **if its policy fires**, and applies the returned
  per-message decisions in place. **The arm is that call sequence.**
- **Plugin estimate** — the size of the message array after the edit (`kept_tokens`), in the
  **same tokenizer over the same content** as the sidecar's unit sizes (`oc-plugin/size.mjs`;
  core `hostContent`). Replayed on the soft gate cell the two agree exactly on every turn. Until
  2026-09-21 the plugin used `ceil(chars/4)` and the sidecar sized a debug rendering; they differed
  by up to 1.5× on one session.

## Run it

```bash
experiments/u18-soft-limit/run.sh            # preflight → gate → waves → analyze; safe to re-run
experiments/u18-soft-limit/run.sh analyze    # read what is on disk; runs nothing
experiments/u18-soft-limit/run.sh config     # the resolved knobs and each arm's tag; runs nothing
U18_WINDOW=75520 experiments/u18-soft-limit/run.sh   # a sweep point; off/hard waves are re-used
U18_ANCHOR=1 U18_W_DORMANCY=2 experiments/u18-soft-limit/run.sh gate
```

**Every value that still needs a sweep is a `U18_*` knob**, and the list is not restated here:
the pipeline half *is* the package's parameter registry (`packages/mcp/src/params.ts`), so a
parameter added there is a knob here with no edit; the policy half is `POLICY_KNOBS` in `lib.mjs`.
`run.sh config` prints every knob resolved, with each arm's tag. A value that does not parse is
refused before anything runs. U18 departs from the package defaults in exactly one place —
`U18_ANCHOR=3` (package: 4) — and holds the three knobs that define an arm — `CT_CT_FOLD_TRIGGER`, `CT_CT_FOLD_SUMMARIES`,
`CT_CT_FOLD_REASONING_AFTER` — out of the command line (`lib.mjs ARMS` sets them). Each arm's tag
carries a hash of the knobs it depends on, the full set is written to
`reports/metrics/u18-soft-limit/configs/<tag>.json`, and the analysis refuses a cell whose recorded
knobs differ — so settings cannot pool by accident.

The knobs most likely to be swept: `U18_WINDOW`, `U18_UNIT` (`turn` | `phase`), `U18_ANCHOR`,
`U18_PROTECTION` (`soft` | `hard`), `U18_SOFT_TARGET_FRAC` (whether `assemble` reduces at all),
`U18_TOPK` with `U18_W_RELEVANCE`.

Re-running resumes: a wave runs only the cells still owed. A cell is owed again only when the
**instrument** failed — killed from outside, no model step at all, or a provider that never
answered (`lib.mjs instrumentFailure`, standing rule 9). None of those criteria can see the grade.
Every such re-run is listed in the analysis. A timeout or a session error is an *outcome* and stays. Budget ≈ 4.2 GPU-hours per
arm (30 cells) plus ~30 min per gate cell; ≈ 13.5 h for the default three arms, **run one cell at a
time** — that figure is the serial total. Each cell holds all four local *leases*
(`CT_LOCAL_EXCLUSIVE=1`): nothing extra is launched; it only stops another session from sharing the
GPU mid-cell.

## Instrument (fixed, not knobs)

| | |
|---|---|
| model | `local/HuggingJoost/Swift-Qwen3.8-27B-NVFP4-GGUF`, served window verified = 151,040 = `opencode.json` `limit.context` |
| host | opencode via `experiments/context-dedup/swebench-opencode.mjs` (D20), prompt unchanged across arms |
| pool | `selection-v2.json`, 10 problems × 3 repeats, `CT_RUN_TIMEOUT_S=7200` |
| sandbox | bubblewrap, always on. No network but the model relay; dataset, `repos/`, `wscache/`, other runs, this repo, the operator's home **and the host's own Python libraries** (`/usr/lib/python3/dist-packages`, `/usr/local/lib`, `/opt`, `/snap` — the host ships a *fixed* `requests`, against psf__requests-1142) hidden. `run.sh` refuses `CT_SANDBOX=0`; the analysis is `INVALID` if any pooled cell lacks an all-true preflight that includes the network, DNS, dataset and repos checks, or if an agent's event stream touches a foreign copy of its task library (pip's vendored copies inside the venv cannot be masked, so they are searched for) |

## Arms

| arm | driver env | what it is |
|---|---|---|
| `off` | `CT_ARM=off` | the handoff's control: host compaction at 119,040, no plugin, no MCP tools |
| `soft` | `CT_ARM=ct CT_CT_TRIGGER=soft CT_CT_WINDOW=W` | the treatment: every turn the plugin calls `assemble` then `evict`, both at `{window_tokens: W, reserve_tokens: 20,192}`. Eviction fires when the assembled units exceed `W − 20,192` heuristic tokens |
| `hard` | `CT_ARM=ct CT_CT_TRIGGER=hard` | plumbing-matched control: same tools, plugin, `--pure` dropped, host compaction off — but both calls are made at the real window (151,040) |
| `think` | `CT_ARM=ct CT_CT_TRIGGER=off CT_CT_FOLD_REASONING_AFTER=3 CT_CONTRACT=v5` | **no eviction at all.** The segmenter folds the reasoning of every turn older than the newest 3 to its conclusion (`[folded thinking · N tokens · recall: fetch {"stub":30}]` + its last 120 tokens; to nothing when the model's own text follows it). Text, calls and outputs stay raw. How much window does thinking alone give back, at what cost? |
| `stub` | `soft` + `CT_CT_FOLD_TRIGGER=pressure CT_CONTRACT=v5` | **folding before deletion.** Once the prompt passes the budget the segmenter folds the lowest-scored blocks — a tool output becomes `[folded · N tokens · began: "…" · recall: fetch {"stub":31}]`, thinking keeps its tail, text its first line — and `evict` deletes only what still does not fit, at the folded size. Every fold is an L0 event. No summaries. |
| `summary` | `stub` + `CT_CT_FOLD_SUMMARIES=1` | `stub`, and `assemble` asks for a summary over any run of ≥ 3 folded blocks outside the anchor that holds > 25% of the budget (the segment containing it when it is all folded); the sidecar fulfils it through `summarize` on the same local model via the relay; it shows as `[summary m91 · <one sentence> · files: … · recall: fetch {"from_seq":…,"to_seq":…}]` and counts only if ≤ 10% of what it summarizes |

The table is `lib.mjs ARMS`; each arm is one step from its neighbour
(`soft` → `think` / `stub` → `summary`). What an arm IS is set by the table, never from the command line.

### Why the fold arms exist (added 2026-09-21, after wave 0, before any cell of them ran)

`soft` evicts **silently**: a dropped message is spliced out, nothing marks the gap, and contract
v1 tells the agent to fetch "the branch a summary mentions" in a prompt that has no summaries and
no ids. Across all 21 ct cells then on record (wave 0 and five gate cells) the agent called a recall
tool **once**. It re-explored with `read`/`grep` instead, and both of `soft`'s wave-0 losses ended
with a step that ran into the 32,000-token output cap (0 control cells ended that way). So `soft`
tests *eviction without recall*, and says nothing about recall.

The two arms apply what earlier experiments here found, and avoid what they found not to work:

| used | evidence |
|---|---|
| a stub naming ids + "call search or fetch to recall" | 15/15 runs recovered every planted fact in one call (`reports/metrics/loop8-interim.md`) |
| a reference that says WHAT it was (path, first line) | beat a length-matched placebo +27.8pp, p=0.006; recall unharmed at 1/10 the tokens (`report-anchor-replay.md`) |
| recall in ONE call | hits that answer without a second call: 15/25 vs 6/25 (`window-regime-and-retrieval-unit-report.md`) |
| the agent's own narrative kept | runs without a ledger of completed steps stalled; with one, 9× re-verify → done in 5 turns (`context-tree-eval-harness-validation.md`) |
| headline-sized summaries | one sentence + pointers vs verbose: 4/59 vs 4/60 at −80% tokens; verbose cost score; a visible paragraph removed the trigger to fetch (`ds-star-tree-tail-iter1-report.md`, `tuning-branch-depth.md`) |

| avoided | evidence |
|---|---|
| behavioural nudges ("you already read this") | fired 33×, ignored 33× (`report-readloop.md`) |
| a "stronger" contract, forced `depth:full` | 0/9, 0/27 (`ds-star-live-verification-report.md`) |
| more summary prose, hit keywords | +32% tokens, no change (`ds-star-delivery-pass-report.md`) |
| ids that may not resolve | retrieval with an unreachable answer stalled 52% of runs vs 0% |

Summary SIZE is not swept here: the prior is null, and an arm costs 30 cells. `headline` is the
registered setting; `U18_SUMMARY_RENDER=full` exists for the follow-up and changes the tag.

**Registered for these arms before they ran.** The verdict ladder below is unchanged and stays
`soft` vs `off`. Secondary outcomes are reported for every ct arm: **recall-tool calls by the
agent** (`fetch`/`search`/`peek` over MCP — the plugin's own HTTP calls are not counted), **cells
that ended on an output-cap step**, and the ledger's account — **blocks folded, reasoning parts
folded, summaries requested / written / rejected**. A recall arm (`stub`, `summary`) in which the
agent recalled in fewer than **3** cells is reported as **RECALL NOT EXERCISED**: its solve rate is
then evidence about visible folding, not about recall. Each fold arm is compared with `off` and with
`soft` by the same paired sign-flip test. `think` asks its own question — solves and peak against
`off` with nothing evicted — and is read on those two numbers.

`soft` vs `off` is the **primary** comparison, as the handoff specifies. **`hard` is an addition
to the handoff's U18 arm list** (it is U19's `hard` arm, so those cells are re-usable there). The
primary comparison is confounded: the two
differ in tool schemas, the plugin, and host compaction as well as in eviction. `hard` exists to
attribute a difference, not to decide the verdict: `soft` vs `hard` isolates eviction, `hard` vs
`off` isolates the plumbing. `U18_ARMS="off soft"` drops it and saves a third of the GPU time, at
the cost of an unattributable result. Every knob is set explicitly on every ct cell; summaries are
off (U20), cadence is unused (U19). In every ct arm the agent can itself call the pipeline tools
over MCP (D22) — an agent-made `evict` in `hard` would make the control evict, so such
calls are counted per arm (`agent_evict_calls`).

Arm order rotates per wave so no arm always runs first.

## Gates (in order; a failure stops the run)

0. **G0 has four cases**: fold, splice, in-place output reduction, and — for `stub` — a message
   with its reasoning parts removed and an output replaced by a tag, each with its own marker.
   **G0 must be re-run** (`node experiments/context-dedup/g0-mutation-visibility.mjs`, ~20 min):
   the seam it vouches for — plugin → sidecar → prompt — was rebuilt on 2026-09-20 (D22).
1. **Preflight** — tools, clean tree (result files excepted; the pool file is *not* excepted),
   server holds this build, variant and window, `opencode.json` agrees, packages built, unit
   tests, G0 PASS on record for this model. The served model is re-checked before **every** driver
   call and each call is logged to `run-log.jsonl` with its commit and dirty flag.
2. **G1 + G2, one cell per ct arm on `django__django-11138`** — it fills the window on all three
   baseline repeats (117,951–118,801, each *capped by a host compaction*, so true demand is higher)
   and is solved 3/3.
   - `soft` PASS: integrity clean, run valid, units evicted > 0, zero rejected tool-bearing
     requests on the relay's wire record, no fail-open turn, slowest turn ≤ 4,000 ms of the
     plugin's 8,000 ms budget, no over-ceiling turn, no ruling the pinned units alone defeated,
     and a **real peak ≤ 1.3 × W**. "Below the control's peak" would be vacuous:
     117K passes it.
   - **Every ct arm: the cell must run ≥ 20 steps.** On 2026-09-21 a `hard` gate cell whose first
     reply ran into the output cap ended after one step and PASSED — nothing had gone wrong,
     because nothing had happened.
   - `stub` PASS: as `soft`, and at least one block was folded. `summary` PASS: as `stub`, and at
     least one summary was written (so the request → relay → `summarize` path closed in time).
     `think` PASS: integrity, ≥ 20 steps, at least one reasoning part folded, and a served peak
     inside the served window (151,040) with host compaction off — no eviction clauses, because it
     evicts nothing but the floor. Offline replay of the stub gate session: 270K raw, 131K folded.
   - `hard` PASS: the same without the eviction and peak clauses. It exists because the arm has
     never run live and its ceiling is denominated in heuristic tokens (see Known limits): with
     host compaction off, a problem that fills the window may be a hard session error.
   Each attempt has its own tag (`-gate-a<N>`) and is **appended** to the gate record; a failed
   attempt's run dir is kept. After a FAIL, another attempt needs `U18_REGATE=1`. A PASS is void
   once a commit touches `experiments/context-dedup`, `packages` or this directory. Gate cells are
   never pooled. Read the attempt's `mcp/ct-mcp.jsonl` by hand before trusting a PASS. The record
   carries `first_edit_turn`, `max_kept_before/after_first_edit`, `max_unit_tokens_after_ruling`
   and the `served_per_heuristic` distribution — what explains a limit that was or was not held.

## Outcomes

- **Primary: solves**, intention-to-treat. An unscored cell (timeout, session error) is a fail: ct
  arms run with host compaction off, so a session the arm broke must stay in its denominator.
  Standing rule 10 still applies on top: uneven unscored counts make the run descriptive only.
- **Primary: achieved peak** — per-problem median over repeats of `peak_prompt_tokens`, as a
  `soft/off` ratio on **binding problems**: those whose *control* median peak exceeds W. Defining
  binding on the control keeps the treatment from choosing its own denominator.
- Secondary: the per-**cell** peak of engaged soft cells against the control's median for that
  problem (peak is a per-run draw, standing rule 3 — four per-problem medians are thin); relay-side peak request bytes (`wire.jsonl`, outside the sandbox and downstream of the
  plugin — cannot be faked by an inert arm), compaction counts, engaged cells, timeouts and fail-open turns per
  arm, exact paired sign-flip p. Not output tokens and not `reasoning_tokens` (both unreliable on this endpoint).

## Verdict ladder (first match wins)

| verdict | rule |
|---|---|
| `INVALID` | any pooled cell fails an integrity check: sandbox, foreign library copy, model, declared window, another opencode run on the device, `ct.arm_agrees`, plugin loaded, trigger/W as requested, host compaction in a ct cell, more than 10% of a cell's turns failing open |
| `INCOMPLETE` | an arm has anything but 30 distinct pool cells, or a cell is owed again |
| `DESCRIPTIVE_ONLY` | this run's `off` differs from the 19/30 baseline by **≥ 3** (the instrument moved); or > 25% of cells unscored; or unscored counts differ across arms by **≥ 2** (standing rule 10 — that asymmetry is a finding about the arm that truncates) |
| `VOID` | `soft` evicted on fewer than **8** of 30 cells; or peak did not fall on a majority of binding problems; or the binding geo-mean ratio ≥ 1. NOT RUNNABLE at this W — never a null |
| `REFUTED_AT_W` | Δ solves (`soft − off`) ≤ **−3** of 30, or a problem `off` solves 3/3 goes 0/3 under `soft` with eviction engaged on it. The sweep moves **up** — unless `hard − off` ≤ −3 too, which implicates the plumbing, not eviction |
| `HELD` | otherwise, with binding geo-mean peak ratio ≤ **0.75** |
| `HELD_NOT_MATERIAL` | accuracy held, peak ratio > 0.75 |

A few fail-open plugin turns are the treatment's own behaviour: counted and reported per arm, not
refused.

Why these numbers:

- **−3.** The clean baseline has 8 of 10 problems at 3/3 or 0/3 and two at 2/3. Two p≈2/3
  problems × 3 repeats give a per-arm sd ≈ 1.15 solves, ≈ 1.6 for a difference of two arms; −3 is
  the first loss outside ±2. Under that model the false-refute rate is **6%**. But three draws
  cannot show a problem is deterministic: if the "3/3" problems are really p = 0.9 and the "0/3"
  ones p = 0.1, it is **17–18%**, and power against a true 15-point loss is only ~60%. The same
  margin is applied to the control against its own history (`DESCRIPTIVE_ONLY`), so a drifting
  instrument cannot be read as a result, and the report prints the measured A/A spread.
- **8 engaged cells.** 13 of 30 baseline runs peaked above 50,347. Whether eviction starts earlier
  than that is unknown (W is nominal, below), so ~13 is the expectation and 8 the floor below which
  a parity result would mean "the treatment barely ran".
- **0.75.** By control median exactly four baseline problems bind at W = 1/3 — django-11138
  (118K), pylint-4970 (106K), xarray-6721 (84K), xarray-6992 (53K) — and only two of them are
  solvable. A held limit implies ~0.45–0.6 on the first three and ~1 on the fourth; 0.75 is the
  geo-mean that separates those from an arm that merely shaves. It is a weak statistic: in an A/A
  bootstrap of the baseline the binding set ranges from 2 to 7 problems, and "peak fell on a
  majority" passes 28% of the time with no treatment at all. The engagement floor is what protects
  the claim; every verdict string states how many problems the ratio rests on.

`HELD` means *no ≥ 3-solve loss found in a 30-cell design*, not demonstrated equivalence. The
three never-solved problems (pylint-4970, django-14034, xarray-6992) are the headroom: any solve
there under `soft` is reported, and is not needed for `HELD`.

**Sweep.** Only after a verdict at 50,347: `REFUTED_AT_W` → 75,520 (1/2); `HELD` → 37,760 (1/4);
`VOID` → lower W or a harder pool, not a claim. A sweep point re-uses the `off` and `hard` cells, so
every sweep verdict shares one control draw, and its soft cells run later and alone — the wave
rotation no longer balances time for them.

## Known limits

- n = 30 per arm cannot show equivalence, only fail to find a ≥ 3-solve loss.
- **W is nominal, in a unit nobody serves.** W, the ceiling and `kept_tokens` are all core
  `HeuristicTokenizer` tokens over what the host sends; the provider counts something else. Over
  the 25 unedited turns of the hard gate cell the provider served **0.92** tokens per heuristic
  token (chars/4 on the same turns: 1.19), so the heuristic over-counts by about a tenth and a
  limit is held slightly early. That is one cell's slope, not a conversion factor — see Terms.
  `hard` keeps its own gate cell because the ceiling is still an estimate of the real window. The gate's `real peak ≤ 1.3 × W` compares served tokens to a heuristic W and is loose by
  that same unknown.
- **At this W, `assemble` reduces nothing.** The per-unit budget is `(f·W − reserve) ÷ (A + 1)`;
  at W = 50,347 with a 20,192 reserve and `f` = 0.375 it is 0. The `soft` arm at the default knobs is
  therefore eviction over raw turns. `U18_SOFT_TARGET_FRAC` turns reduction on; that is a different
  treatment and gets a different tag.
- **Each edit kind is proven on the wire by G0 before an arm may use it**: text replaced, message spliced, tool output replaced, reasoning removed + output tagged, reasoning replaced in place, a summary in a reasoning part with the tool parts gone. Six markers, one gate.
- **The summarizer shares the GPU with the agent.** `summary` cells run slower, summaries arrive late or not at all on short problems, and a phase whose summary fails the output contract never folds (logged as `summary` rows in `ct-mcp.jsonl`). Wall time is therefore not comparable across arms.
- Eviction edits the prompt prefix, which forces a re-prefill on this hybrid (recurrent-state)
  model. `soft` turns may be slower, so under intention-to-treat a timeout at 7,200 s makes
  "accuracy" partly a measure of speed. Timeouts are reported per arm.
- Pool pressure, not the model's window, bounds engagement: median uncapped peak is ~45.6K.
- `peak_prompt_tokens` in a ct arm carries ~1.8K of MCP tool schemas the control lacks (against
  the treatment), and the control's own peaks are capped at ~119K by host compaction (also against
  the treatment: the true ratio is lower than the measured one).
- `CT_CT_TOPK` is gone: the retrieval tail never entered the eviction trigger, so it never
  affected an arm. Agent calls to the context-tree tools are counted per cell (`mcp`).
- The speculative drafter is not recorded per run; wall time is not an outcome here.

Output: raw cells in `reports/metrics/swebench-pilot/results-swebench-opencode-u18-*.json` (the
driver's convention), verdicts in `reports/metrics/u18-soft-limit/`. Write the report with the
`experiment-report` skill.

## Record

- **2026-09-18, gate `soft` attempt 1 — FAIL** (W=50,347, A=4, pre-D22 harness, commit `2eec2cf`;
  `gate-soft-W50347.json`). Served peak 107,440 against a 65,451 bound. 119 units evicted, no
  rejected requests, slowest assembly 30 ms. Cause: one unit for turns 2–31 (read/grep →
  `diagnosis`, bash neutral) reached ~80K before a fifth unit existed; with A=4 nothing was
  evictable until turn 39, when 30 messages dropped at once (87,478 → 9,003). Replayed offline
  through the D22 tools the same session ends at 23 units, the first of 45,535 tokens; A=3 moves
  the first eviction two turns earlier and does not change the peak. No wave ran.
- **2026-09-20, offline replay of that same session, turn by turn, after D23** (no GPU; assemble →
  evict at W=50,347, A=3). `unit=turn`: 103 units, largest 12,442; live tokens inside the 30,155
  budget on **102/102** turns; first eviction at turn 9; slowest turn 15 ms. `unit=phase`: 23
  units, largest 45,535; over budget on **94/102** turns, peak 64,343. The granularity, not the
  anchor, was the defect. A replay is not a gate: the live gate still has to be run.
- **2026-09-20/21, gates after D23 and D24.** Attempt 1 at `1ed9c90` FAILED (served peak 67,855 >
  65,451): L0 omitted reasoning, a third of what the host sends, so the sidecar budgeted a prompt
  a third smaller than the real one (D24). Attempt 2 at `0406d2b` PASSED (peak 52,455, solved).
  At `29795af` both sides moved to one sizing metric; `soft` PASSED (46,606) and `hard` PASSED
  **vacuously** — one step, output cap — which is why the 20-step clause exists.
- **2026-09-21, wave 0 (commit `29795af`), then stopped.** `off` 6/10, `soft` 5/10, `hard` 6/9
  (its last cell was in flight when the runner was stopped). `soft` evicted on 5 of 10 cells.
  Recall-tool calls by the agent: `soft` 0, `hard` 1. Cells ending on an output-cap step: `off` 0,
  `soft` 2 — and those two are exactly the problems `soft` lost against `off`
  (pytest-8399, django-11138). Waves 1–2 were not run: the arms were evicting silently.
- **2026-09-21, offline replay of `soft` wave-0 django-11138 under `stub`** (no GPU): 27 units
  stubbed, every tag's `fetch {unit}` resolves, no stub text changes after it is first written,
  the first outright drop moves from turn 5 to turn 19, plugin and sidecar sizes agree exactly.
- **2026-09-21, redesign (D26) before any further GPU.** Two tools owned two versions of compression
  and neither told the agent anything: the stub gate cell folded 129 units and deleted 125 of them;
  the summary gate cell could never fold (no text-only carrier on opencode); reasoning — a third of
  the prompt — was deleted with no tag and could not be searched. The segmenter now owns folding
  (blocks on natural boundaries, stubs, summaries, one L0 ledger, selectable boundary / score / fold
  policies), the pipeline is `assemble → fold → evict`, and the arms are `think` / `stub` /
  `summary` as tabled. The `stub` and `summary` tags changed with their definitions; `soft` and
  `hard` did not, and their wave-0 cells stand. G0 and the three fold-arm gates are owed.
- **2026-09-21, offline replay of the `stub` gate session (156 turns) through the D26 pipeline**
  (no GPU; fake summarizer). `soft`: 130 units evicted, peak 30,145 of a 30,155 budget, 0 turns
  over. `think`: 6,189 reasoning parts folded over 87 blocks, nothing evicted by policy, raw peak
  270,177 → 130,767 (the floor evicted 18 units from turn 102); thinking alone reclaims about half.
  `stub`: 256 blocks folded from turn 12, first eviction moved from turn 12 to turn 112, 49 units
  evicted (soft: 130), peak 30,151, 0 turns over, every fold resolves by its id. `summary`: 11
  summaries requested by `assemble` and written (81 blocks carried or covered), 24 units evicted,
  first eviction turn 125. Slowest turn 283 ms. `foldSummarizeAt` was lowered from 0.25 to 0.02
  after this replay showed a run of stubs never reaches a quarter of the budget (the largest run
  was 1,685 tokens of 30,155) — and then re-based on the run's RAW tokens at 0.1 after the live
  summary gate (below) asked for summaries of 700-token runs whose stubs were larger than the raw.
- **2026-09-22, G0 and the fold-arm gates at `62633f9`.** G0 took four attempts to ask its
  question: one VOID (no key in the runner's environment — 401 on every request), one false FAIL
  (the think case was dated from the stub turn, whose removed reasoning part also raised
  `reasoning_edited`; the counters are now `reasoning_replaced` / `tools_removed`), and two VOID
  because the agent called `fetch` on the task node — the gate had folded the task statement AWAY
  to a marker line, and the recalled text put the original marker back on the wire inside a tool
  output. The gate now folds the task to the statement with the marker line swapped; a recall
  through a tool is graded VOID. **PASS**: 24 of 24 post-edit requests, original gone, replacement
  present, all six edit kinds. Then, on django-11138:
  - **`think` attempt 1 — FAIL, ran as the control.** The sidecar had `fold_reasoning_after=3`; the
    plugin, which decides whether `fold` is called at all, never received it: the driver forwarded
    only the five policy keys to opencode's process env. `arm_agrees` was true because it compared
    the sidecar's boot alone. Fixed (`policy.mjs FOLD_KEYS`; the cell now compares the plugin's
    `foldsAlone` too).
  - **`think` attempt 2 — FAIL on the step floor, mechanism fired.** 10 fold calls, reasoning parts
    replaced from turn 8. At step 10 the model produced **29,614 output tokens of reasoning, no text,
    no tool call**, finish `stop`, and the session ended with an empty diff (the control solved this
    task 3/3 in 99–128 steps). One cell; whether folding older reasoning to a 120-token tail
    provokes the overthinking the earlier experiments saw is the arm's first open question.
  - **`stub` attempt 1 — PASS.** 117 steps, peak 52,939, 4 messages edited on the last turn; not solved.
  - **`summary` attempt 1 — FAIL.** 226 blocks folded, 1,324 summary requests reported, 24 model
    calls, **0 summaries written**: 17 calls returned no content at the 2,048-token cap (the Swift
    thinking model spends a small cap on reasoning — the provider's own comment records this and the
    harnesses had stopped setting caps; `summaryMaxTokens` is now 0 = none), and 7 were rejected by
    the ratio (158 tokens for 700 summarized) because the request threshold was measured on the
    stubs' size, not the raw tokens they stand for, and a stub of an empty tool output is larger
    than the output (`foldSummarizeAt` is now on raw tokens, default 0.1). The cell also **looped**:
    from about step 550 to the 7,200 s timeout the agent ran the identical `grep` command (empty
    output) on every step, ~1,300 times, at a steady peak of 49,781 — under a soft limit the repeated
    turns fold and evict as they age, so the prompt becomes a fixed point and a near-deterministic
    model repeats itself. No earlier cell of any arm exceeded 156 steps. Both defects are fixed
    offline; the `think` and `summary` gates are owed again, and the loop is now a thing to watch
    for in every evicting arm (`steps` and the last tool call's repetition are in the cell).
