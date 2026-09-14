# A/B window-sweep — machinery check on rule-chain (a NULL, by design)

**Purpose:** validate the window-cap sweep harness (`ab-window-sweep.mjs`) end-to-end before
investing in a published benchmark — one tight window, three arms, on a short synthetic task.

**Run:** `CT_LOCAL_MODEL=unsloth/Qwen3.8-27B-GGUF CT_TASK=rule-chain CT_RULES=8 CT_WINDOWS=4000
CT_ARMS=uncapped,truncate-tail,idle-gstar CT_MAX_TURNS=15 node experiments/context-dedup/ab-window-sweep.mjs`

**Result — all three cells byte-identical:**

| cell | pass | turns | evict | reads | peak tok | total tok |
|---|---|---|---|---|---|---|
| uncapped | PASS | 5 | 0 | 0 | 1,035 | 6,238 |
| truncate-tail @4000 | PASS | 5 | 0 | 0 | 1,035 | 6,238 |
| idle-gstar @4000 | PASS | 5 | 0 | 0 | 1,035 | 6,238 |

**Why (the decisive finding, now reproduced 3×):** with the full toolset the 27B used `run_bash`
(`cat`/`grep`) to pull the `RULE:` lines directly and never loaded a whole file (`reads=0`), so peak
context stayed ~1k tokens and the 4000 cap never bound. No eviction fired; every arm collapses to the same
trace. This is the same grep self-heal seen in `report-tier2-selfheal.md` and
`reports/metrics/coding-harness/report-integration.md`.

**Conclusion — window pressure is intrinsically long-horizon:**
- Anything persisted to disk is re-fetchable, so a full-tools agent self-heals on any *short* task. The
  only context that cannot be recovered by a tool call is the **conversation history** (prior reasoning,
  tool-call/result chains), and that grows past a window only over **many turns**.
- Therefore **no short synthetic task can exercise a window cap with full tools** — proven here. A
  meaningful sweep requires a **long-horizon** task (real repo exploration + iterative edits + large test
  outputs), i.e. the **SWE-bench family**. SWE-bench is thus *required*, not merely more credible.
- **Correction (adversarial review):** an earlier version of this report claimed "the harness itself is
  validated (caps, arms, control, and metrics all run correctly)". That claim was **unsupported** — this
  run had `evict=0` in all three cells, the cap never bound, and the `random` control was not in
  `CT_ARMS` at all, so **zero eviction code paths executed**. It validates only that the agent loop runs.
  The eviction machinery was in fact broken at the time (see `report-ab-longbuild.md` § provenance:
  `idleOf` was pinned near 0 by promiscuous fingerprints, and the backstop deleted what the idle rule
  saved). Both are fixed and unit-tested in `policies.mjs` / `policies.test.mjs`.

**Next:** either (a) invest in a SWE-bench Verified subset run (harness needs `git`/`pip`; scoped N;
relative degradation across the window is the metric, not absolute solve), or (b) rest the ecological
case on the offline analysis of real long sessions (DV1/DV2/Tier1, which already run on real full-tool
Claude Code transcripts) and treat live SWE-bench as future work.
