# Rung 1 live probe — naive QA wire-up

**Question.** Is the local 262K host a usable single-turn instrument, does context
actually carry the answer (no memorization leakage), and does narrowing context to a
retrieval-unit-sized passage cost answerability? This is the **naive, non-taxing** wire-up
that the taxing overflow probes build on — not a hypothesis test of the algorithm.

**Setup.** 22 committed s1 questions (`questions` + `questions-deep` + `questions-overflow`),
graded deterministically by the fixtures' `answer_regexes`/`literals` (no judge). Model:
`unsloth/Qwen3.8-27B-GGUF`, thinking disabled, temp 0, 64 max tokens. One variable — the
context block: **none** (question only) · **source** (narrow gold passage) · **wide** (broader).
Numbers + per-cell rows: `results-qa-naive.json`. Run this: `node experiments/rung-1-live-probe/qa-naive.mjs`.

## Result (all three pre-registered gates PASS)

| arm | accuracy | avg prompt tokens |
| --- | --- | --- |
| none (control) | **0/22 (0%)** | 103 |
| source (narrow) | **14/22 (63.6%)** | 423 |
| wide | **15/22 (68.2%)** | 466 |

- **G1 instrument-usable** (source ≥ .50): **PASS** — 63.6% with the gold passage. The model can do this benchmark; it is a usable instrument.
- **G2 context-matters** (source − none ≥ .20): **PASS**, and emphatically — **0%** with no context. Zero leakage; every correct answer is read from context, not memorized. The benchmark is not parametric/guessable.
- **G3 curation-preserves** (source ≥ wide − .10): **PASS** — 63.6% vs 68.2%, inside the noise band, at ~9% fewer prompt tokens. Single-turn directional evidence **for** the curation premise: narrowing to the retrieval-unit passage costs ~1 question of 22 and saves tokens.

## Mechanics (the 8 source-arm misses)

All 8 are **genuine model misses, not grader artifacts** (verified by reading each output vs
gold): on multi-candidate "needle" questions the model picked a nearby-but-wrong token
(`JsonlTraceLog` instead of the imported path; `6568` instead of `16283`), or, on two overflow
questions, answered `UNKNOWN` — i.e. it **declined rather than hallucinated** when the passage
didn't clearly contain the answer. So 63.6% is a real instrument ceiling for this model on this
extraction task, not scoring noise, and the model's abstention is well-calibrated (useful for the
taxing probes, where a wrong-but-confident answer would be a worse failure than an honest miss).

## Tested vs. open

- **Tested:** the instrument (model + deterministic grade + real token accounting) works end-to-end;
  context is load-bearing (0% without it); narrow ≈ wide on answerability at fewer tokens.
- **Open (what this does NOT touch):** retrieval, eviction/attention-over-history, multi-turn
  dynamics, cache stability. The gold passage is handed in pre-selected and everything fits — nothing
  is evicted. Those are the taxing overflow probes (next), where raw history (~1.16M tok) must be
  compressed to fit 262K and the answer sits in dormant history.

**Caveats.** n=22, directional. Single-turn answerability-given-context only. Regex grader can
over-credit a literal that recurs in prose or under-credit a paraphrase; spot-checked here and clean.
