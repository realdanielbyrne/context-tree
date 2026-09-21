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
- **Plugin estimate** — the plugin's own `ceil(chars/4)` size of the message array, measured after
  the edit (`kept_tokens`). A third number beside the heuristic W is compared against and the served
  count; on the first gate cell one session read 139,151 by it and 89,545 by the heuristic.

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
`U18_ANCHOR=3` (package: 4) — and holds `CT_CT_SUMMARIES=0` fixed (that is U20). Each arm's tag
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

0. **G0 must be re-run** (`node experiments/context-dedup/g0-mutation-visibility.mjs`, ~20 min):
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
- **W is nominal, in a unit nobody serves.** W is compared against `HeuristicTokenizer` unit
  tokens; the ceiling and `kept_tokens` are the plugin's chars/4; the provider counts neither. See
  Terms for the measured served-per-heuristic range and why no single factor is quoted. The
  ceiling (`151,040 − head − reserve` = 130,848, chars/4) therefore does not provably protect the
  real window, and `hard` may overflow before it ever evicts — which is why `hard` has its own gate
  cell. The gate's `real peak ≤ 1.3 × W` compares served tokens to a heuristic W and is loose by
  that same unknown.
- **At this W, `assemble` reduces nothing.** The per-unit budget is `(f·W − reserve) ÷ (A + 1)`;
  at W = 50,347 with a 20,192 reserve and `f` = 0.375 it is 0. The `soft` arm at the default knobs is
  therefore eviction over raw turns. `U18_SOFT_TARGET_FRAC` turns reduction on; that is a different
  treatment and gets a different tag.
- **In-place output reduction is unproven on the wire** until G0's third case passes.
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
