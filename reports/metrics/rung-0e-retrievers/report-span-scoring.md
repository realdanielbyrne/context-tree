# Rung 0e Phase 2d — span-level scoring

**Run:** `span-scoring@v1` · offline · commit `d6a7f2c` · graft CLI 0.8.2 · MiniLM
**Script:** `experiments/rung-0e-retrievers/span-scoring.mjs` · **Raw:** `results-span-scoring.json`
**Set:** 9 questions with a single crisp answer line (structural/literal/fuzzy), lines grep-verified.

## Why

Every prior 0e judge was **file-level**: did the answer's home file appear in top-k. That rewards a
retriever that finds the right file but returns a span *not containing the answer* — the Rung 0a
excerpt-precision failure. This judges at **span level**: a unit counts only if its line range holds
the ground-truth line. `span|file` = span-hit conditioned on file-hit = "when it found the file, did the
returned span contain the answer?"

## Result (@5)

| retriever | fileHit | spanHit | **span \| file** |
| --- | :-: | :-: | :-: |
| **graft** (real CLI) | **78%** | **56%** | **71%** |
| grep | 56% | 33% | 60% |
| fuzzy | 56% | 33% | 60% |
| vector (MiniLM) | 44% | 11% | **25%** |

## Findings

1. **File-level scoring substantially overstates retrieval quality.** fileHit ≫ spanHit for everyone
   (graft 78→56, grep 56→33, vector 44→11). The stricter span judge is the honest one — a file-hit is
   not an answer.

2. **graft dominates span precision (71% span|file).** Because it returns actual symbol *spans*, its
   unit lands on the answer far more often than a char chunk does. On code, structural retrieval
   sidesteps the excerpt-precision problem entirely — it retrieves the right unit, not a window near it.

3. **vector's file-level win is shallow: 25% span|file.** Even when dense retrieval finds the right
   file, the specific chunk it ranks contains the answer only a quarter of the time — it matches the
   file by overall similarity, not the answer-bearing line. This quantifies, at repo scale, the Rung 0a
   lesson: a chunk retriever needs a span-refinement step to turn a file-hit into an answer.

4. **grep/fuzzy sit in between (60% span|file)** — when an exact/trigram match fires, the matching chunk
   is usually near the answer, so the file-hit is more often a real span-hit than vector's.

## Implication (ties 0a and 0e together)

Chunking (0a), retrieval (0e), and span precision (this run) are one pipeline. For **code** retrieval
where the exact span matters:
- **structural (graft) is the strongest unit** — it returns symbol spans, so file-hit ≈ span-hit.
- **chunk retrievers (esp. dense) need a span-refinement stage** to convert a file-hit into an
  answer-bearing span — which is exactly the off-the-shelf chunker work from Rung 0a, now shown to be
  necessary and not just nice-to-have.

## Caveats

- **n=9** — directional; structural/literal/fuzzy only (semantic answers have no single crisp line).
- **bm25 omitted** (needs a chunk-level index; grep is the lexical stand-in).
- Chunk line ranges recovered by forward-search (±1 line); answer lines are span interiors, so the
  tolerance does not affect the judgments.
