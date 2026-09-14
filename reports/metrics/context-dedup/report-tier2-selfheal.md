# Tier 2 (first attempt) — the grep self-heal null result

**What was run:** the retention task (read 4 catalogs, sum the buried prices = 139) with the **realistic
full toolset** (including `run_bash`), arms `none` / `recency` / `idle-gstar`, in two regimes
(Flash-Next 8.2K budget 6800; Qwen3.8-27B 262K budget 200k). Results: `results-tier2-overflow.json`,
`results-tier2-ample.json`.

**Result — all arms identical, eviction never fired:**

| regime | arm | success | turns | evictions | reads | peak tokens |
|---|---|---|---|---|---|---|
| overflow | none / recency / idle-gstar | PASS | 4 | **0** | 1 | 830 |
| ample | none / recency / idle-gstar | PASS | 7 | **0** | 1 | 928 |

**Why (the confound):** with `run_bash` available, the model **grepped the prices** instead of reading
whole catalogs into context. Peak context stayed ~830–928 tokens — far below any budget — so nothing ever
overflowed and no eviction policy ever engaged. Every arm collapses to the same trace. This reproduces the
documented "realistic tools → grep self-heal" confound (`reports/metrics/coding-harness/report-integration.md`).

**Conclusion:** this design cannot test eviction. Two failed fixes were considered and rejected:
- *Restricting the toolset* (remove `run_bash`) forces reads into context, but is **not ecologically
  realistic** — real harnesses give full tools.
- The catalog task is also **too short** (≤7 turns) for the idle threshold `g*`=12 to ever fire, and
  small enough (~20k full-read) that it either overflows a tiny window (baseline fails) or fits a big one
  trivially (nothing evicts). No local model gives a middle regime.

**Superseded by** the window-cap sweep A/B (`report-ab-window-sweep.md`, in progress): one model
(27B, 262K real window), an **artificial window cap `W` swept** as the only synthetic element, **full
tools kept**, and a hard task — measuring the (window × turns-to-complete) frontier per policy. That
turns truncation into extra re-reads (time/cost) rather than a binary fail, which is the realistic effect.

Signal validation (Tier 1) stands on its own: `report-tier1-idle-predicts-cold.md`.
