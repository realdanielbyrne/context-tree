# Eviction on a live coding task — causal confirmation of the assembler defaults

**Question.** The offline sweep + LR gave eviction weighting *defaults* on a proxy label
(fingerprint overlap). Do they hold up **causally** — does priority-dominant eviction preserve
**task success** while cutting tokens — on a real multi-step coding task against the local model?

**Setup.** A **faithful OpenAI tool-calling loop** (the local server round-trips native
`tool_calls`, so the S4 trap is impossible; Gate 1 passed). Synthetic **non-monotonic** task:
read 6 seeded reference files → build `tsutil.py` (`parse_ts`/`fmt_ts`) → build 6 modules that
**import and use `tsutil`** → build `report.py` that needs `tsutil` again (`fmt_ts(parse_ts('01:02:03')+3600)`
= `02:02:03`). `parallel_tool_calls:false` forces sequential turns so history accumulates into
many units. Three arms, same task/budget/model, one variable = eviction policy applied to history:
`none` (full), `recency` (keep pinned + most-recent to budget), `priority` (recorded defaults
D-EV2–4: priority-dominant + recency + reference-recency, relevance≈0). Budget 3500 tokens; units
keep tool-call validity (assistant `tool_calls` travels with its results). Model
`unsloth/Qwen3.8-27B-GGUF`, thinking off, temp 0. Numbers: `results-eviction.json`. Rerun:
`node experiments/coding-harness/eviction-experiment.mjs`.

## Result (deterministic at temp 0 — a replicate run reproduced every number byte-for-byte)

| arm | success | turns | evictions | peak history tok | total prompt tokens |
|---|---|---|---|---|---|
| none | PASS | 24 | 0 | 4636 | 108,748 |
| recency | PASS | 26 | 5 | 3150 | 94,299 (−13% vs none) |
| **priority** | **PASS** | 23 | 4 | 3107 | **80,823 (−26% vs none, −14% vs recency)** |

- **Eviction preserves the task** — all three arms produce `02:02:03`. At budget 3500 the working
  set survived, so eviction (either policy) did not lose the task.
- **Priority beats recency on tokens at equal success** — ~14% fewer prompt tokens (80,823 vs 94,299)
  and fewer turns (23 vs 26). Both beat `none` (eviction caps the re-send/quadratic term: peak
  history 3100 vs 4636). This is the DSA value proposition — *save tokens without losing the task* —
  confirmed causally, and priority (the recorded defaults) saves more than naive recency.

## Two findings from the failed iterations (kept because they sharpen the defaults)

- **Aggressive eviction destabilizes the agent.** At a tighter budget (2500) the agent lost track of
  completed work and fell into a **re-investigation read-loop**, never finishing (hit maxTurns, both
  policies identically). This is the **D-b "no completed-steps ledger" failure, reproduced live** —
  direct evidence for "err toward more context," and for a completed-steps ledger / a larger recency
  anchor as a guard. (Fix applied: recency anchor of 4 units; gentler budget.)
- **A past-signal policy needs a recurrence signal to protect an early unit.** In a first design the
  filler never used `tsutil`, so it was indistinguishable from filler and priority collapsed to
  recency (identical results). Only once the modules **import `tsutil`** does priority see it as
  high-value and keep it. This is precisely why summaries/ledgers exist: past reference-counts, not raw
  recency, are what let eviction spare a dormant-but-important unit — and priority must score on
  content fingerprints (symbols), not just file paths, to catch it.

## Tested vs. open

- **Tested (live, causal, 1 task):** eviction preserves task success while cutting tokens; priority
  (recorded defaults) < recency < none on total prompt tokens at equal success; the harness is faithful
  (tool-call format survives eviction); the two failure modes above.
- **Open / caveats:** the run is **deterministic at temp 0** — a replicate reproduced every number
  exactly — so the weakness is **single-scenario**, not sampling noise: generalization needs *task/model
  variation*, not re-runs. All arms PASS, so the **success-differentiation** case (recency drops a needed
  unit → *fails* where priority succeeds) was **not** triggered at budget 3500 — a tighter-but-non-
  destabilizing budget, or a non-re-readable dependency, is needed to show a success gap, not just a token
  gap. Single model, single synthetic task, budget-sensitive. The ~14% is one scenario's number, not a
  distribution.
