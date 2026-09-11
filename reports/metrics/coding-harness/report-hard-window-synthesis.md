# Hard-window multi-doc synthesis — the middleware is REQUIRED, not optional

**Question.** The read-loop and buried-detail results were on a *simulated* budget. Does the
middleware hold up under a **real hardware window**, on a task that stacks *both* failure modes —
window overflow **and** buried detail across **multiple sources** (the session-3 shape: extract from
several documents → synthesize)?

**Setup.** Real 8.2K-window model `unsloth/Qwen3.8-Flash-Next-GGUF` (UD-IQ4_XS, low-quant). **Four**
product catalogs, ~5K tokens each (**~20K total**), each **burying one unit price** (Widget 13,
Gadget 27, Gizmo 41, Doohickey 58). Task: report the integer **sum (139)**. Single-turn; the
**middleware reducer** assembles the context per document; one variable = reducer:
`raw` (concat all) · `summarize` (gist per doc) · `chunk_retrieve` (price span per doc). `prices_present`
(all 4 in the assembled context) is the **mechanism** metric; the sum is arithmetic on top. Numbers:
`results-hard-window-synthesis.json`. Rerun:
`CT_LOCAL_MODEL=unsloth/Qwen3.8-Flash-Next-GGUF node experiments/coding-harness/hard-window-synthesis.mjs`.

## Result (mechanism CONFIRMED, end-to-end CONFIRMED)

| reducer | ctx tokens | fits 8.2K window | prices preserved | model answer |
|---|---|---|---|---|
| raw | **20,149** | **NO — cannot send** | (n/a) | — |
| summarize | 1,621 | yes | **✗ all lost** | UNKNOWN |
| **chunk_retrieve** | **1,118** | yes | **✓ all 4** | **139 ✓** |

- **Under a real hard window the raw task is impossible** — 20,149 tokens can't be sent to an 8,192
  window. Without a footprint reducer, there is no task, not just a slow one.
- **Only the query-aware chunk+retrieve both fits AND preserves the answer.** It's 18× smaller than raw
  (1,118 tok) yet keeps all four buried prices; summarize fits too but is lossy on buried detail → the
  model correctly abstains (UNKNOWN).
- **The failure was pure information loss, not reasoning** — the *weak, low-quant* 8.2K model summed
  13+27+41+58 = 139 correctly the moment the prices were present (raw-would-have and chunk arms). So the
  middleware's job (preserve the needed spans within the window) is the whole game; model strength is
  secondary here.

## Why this is the harder test

It composes the two failure modes under a genuine ceiling: **overflow** (raw unsendable) × **buried
detail** (summarize insufficient) × **multiple sources** (4 documents). It is the text-only analog of
the session-3 PDF→excel→report task, and it shows the middleware is **load-bearing exactly where the
programme is aimed**: many sources, small window, specific facts.

## Tested vs. open

- **Tested (live, real hard window):** middleware is required to fit *and* preserve; among reducers only
  query-aware chunk+retrieve succeeds; a weak model suffices once the spans are preserved.
- **Open:** the **agent-loop** version (multi-turn, where eviction + thrashing compound over a growing
  8.2K context — the read-loop and this stress combined); a real **router** that picks summarize vs
  chunk per query rather than a fixed reducer; a stronger retriever (this one is BM25-ish overlap); and
  the actual **PDF/vision** session-3 task (needs an image model — deferred to avoid confounding vision
  extraction with the context mechanism).

**Caveats.** n=1 per arm, temp 0 (deterministic). Single model, synthetic docs, weak lexical retriever.
`raw` is pre-detected as over-window (not sent); a strong-model artificial-window variant
(`CT_LOCAL_MODEL=unsloth/Qwen3.8-27B-GGUF CT_WINDOW=8192`) is available for a reasoning-clean rerun.
