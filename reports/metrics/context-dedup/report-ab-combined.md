# A/B window-cap sweep — combined report (n=3 and n=10)

**Question (one variable — the SELECTION signal):** with a coding agent's context capped, does keeping
units by **reference recency** (time since that file was last touched) complete the task better than
keeping by **positional recency** (the tail), and does either beat a **random control**? All capped arms
fit the same budget with the same anchor and differ ONLY in the order they sacrifice units, so they are
**volume-matched by construction**.

**Setup.** One model (`unsloth/Qwen3.8-27B-GGUF`, 262K real window) so the provider never rejects a
prompt; the only synthetic element is the artificial cap. **Full tools kept.** Task: `longbuild`, a
six-stage pure-stdlib Python build graded by a **held-out** unittest suite. Two batches of identical
configuration (same post-fix code, model, task, caps, 60-turn budget): **n=3** (uncapped, W=9,500,
W=4,700) and **n=10** (W=4,700 only). The W=4,700 cells pool to **n=13**.

Rerun: `node experiments/context-dedup/ab-window-sweep.mjs` then `node experiments/context-dedup/report-ab-combined.mjs`

## Decisive cells — W=4,700 (tight cap)

### n=3 batch
| arm | n | pass | turns med (min–max) | re-reads med (min–max) | evictions | self-terminated | tokens |
|---|---|---|---|---|---|---|---|
| truncate-tail (positional) | 3 | 1/3 (33%) | 61 (57–61) | 8 (4–11) | 39 | 1/3 | 269,995 |
| random (control) | 3 | 1/3 (33%) | 61 (61–61) | 9 (8–9) | 40 | 0/3 | 275,546 |
| idle (reference recency) | 3 | 3/3 (100%) | 59 (57–61) | 4 (1–4) | 37 | 2/3 | 265,174 |

_n=10 batch not present yet._

## Significance (Fisher exact, two-tailed)

| batch | n/cell | idle vs truncate-tail | idle vs random | idle vs both pooled |
|---|---|---|---|---|
| n=3 | 3 | 0.400 | 0.400 | 0.167 |

**Even pooled the difference does NOT reach significance (Fisher p=0.167 vs the other two arms combined); it remains an effect size, not an established claim.**

## Charts
See the HTML twin (`report-ab-combined.html`) for the rendered SVG charts: pass rate by batch,
re-reads with min–max whiskers, turns to completion, the eviction-volume check, and context-vs-tokens.

## Context cells (n=3 batch)

| cell | pass | turns med (min–max) | re-reads | peak context | tokens | self-terminated |
|---|---|---|---|---|---|---|
| uncapped (reference) | 3/3 | 53 (52–53) | 0 | 20,993 | 632,225 | 3/3 |
| truncate-tail (positional) @9,500 | 3/3 | 61 (61–61) | 3 | 8,971 | 499,612 | 0/3 |
| random (control) @9,500 | 2/3 | 52 (46–61) | 2 | 8,970 | 421,218 | 2/3 |
| idle (reference recency) @9,500 | 3/3 | 54 (53–58) | 2 | 8,977 | 436,860 | 3/3 |

## Caveats
- Single local model, single synthetic task — **not a published benchmark**. A non-Docker SWE-bench
  harness is validated (`swebench_provision.py`) and is the proper next substrate.
- `turns = 61` means the 60-turn budget was exhausted ("did not finish in 60"), not "cannot finish".
- Grading is all-or-nothing, so FAIL cells are not distinguished by how close they came.
- `total_prompt_tokens` is raw; the local server's caching behaviour is unknown, so this measures
  context volume, not cached cost.
- temp 0 but not bit-identical on this host — read all differences against the min–max spreads.
- Pooling assumes the two batches are exchangeable: same code, model, task, cap and turn budget. They
  are, but they were run as separate batches; per-batch numbers are shown above so this is auditable.
