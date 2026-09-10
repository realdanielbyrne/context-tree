# Rung 0b — merged topic-shift signal vs each alone

**Run:** `topic-shift-merged@v1` · offline · model `Xenova/all-MiniLM-L6-v2` · commit `d6a7f2c`
**Script:** `experiments/rung-0b-topic-shift/topic-shift-merged.mjs` · **Raw:** `results-merged.json`
**Companions:** `report.md` (lexical), `report-embedding.md` (semantic). Same 287-turn session.

## What was tested

The lexical (fingerprint-Jaccard) and semantic (embedding-drift) detectors catch different boundaries.
Rather than pick, merge them (`mergedDrop = z(lexicalDrop) + z(semanticDrop)`, equal weight, no tuning)
and test the merged signal against each alone. **Objective (label-free, since we have no shift labels):**
segmentation quality = intra-segment similarity − cross-boundary similarity, scored in **both** a lexical
(Jaccard) and a semantic (cosine) space. Boundary count K is **matched** across detectors so quality is
not a count artifact. Operator's thesis: the merged detector should be robust across both spaces where
each single one is not.

## Result — segmentation quality (higher = crisper); worst-case = min across the two spaces

| K | detector | lexical-space | semantic-space | worst-case |
| --- | --- | --- | --- | --- |
| 20 | lexical | 0.040 | 0.083 | **0.040** |
| | embedding | 0.015 | 0.035 | 0.015 |
| | merged | 0.023 | 0.036 | 0.023 |
| 40 | lexical | 0.075 | 0.033 | 0.033 |
| | embedding | 0.030 | 0.061 | 0.030 |
| | **merged** | 0.054 | 0.057 | **0.054** |
| 60 | lexical | 0.104 | 0.049 | 0.049 |
| | embedding | 0.065 | 0.074 | 0.065 |
| | **merged** | 0.087 | 0.093 | **0.087** |

## Findings

1. **Merged does not strictly dominate — but it is the most ROBUST, which is the correct form of the
   thesis.** At K=40 and K=60 the merged detector has the **best worst-case** across the two spaces
   (0.054, 0.087), because it never collapses on either notion of topic. Each single detector does
   collapse on its off space: lexical tanks in semantic-space (0.033 at K=40), embedding tanks in
   lexical-space (0.030). Merged is the min-max winner at realistic boundary counts.
2. **Lexical is a strong single detector** — it wins its home space at every K and both spaces at K=20.
   File/identifier change is a clean, cheap topic signal; the deterministic detector is not a poor
   cousin of the embedding one.
3. **The strong claim (merged beats both everywhere) is refuted; the robustness claim holds.** Merging
   buys safety across notions of similarity, not domination, on this session.

## Conclusion

Merging is worth it for **robustness**: the merged signal is the one you would trust when you don't know
whether the next shift is lexical (new file) or semantic (same file, new intent) — it is strong on both,
where each single detector is strong on one and weak on the other. Use `z(lexical) + z(semantic)`.

## Conclusion — the classification layer

Scope: this is about the **shift classifier** — the per-turn signal — not about how any consumer uses it.
- **Emit the merged signal, `z(lexical) + z(embedding)`, as the classifier's output.** It is the robust
  choice: best worst-case across both similarity spaces (K≥40), where each single signal collapses on its
  off-space. Equal weight, no tuning.
- **Keep both raw components available alongside the merged score** — they are cheap, and they classify
  *different* boundary kinds (lexical = identifier/file change; embedding = same-file intent change), so a
  downstream consumer can read either. The classifier's job is to expose all three, not to pick.
- **The signal is real and cheap** — the deterministic component alone is ≈9.5σ more clustered than a
  within-session permutation null (`report.md`). No model is required for a usable signal; the embedding
  component adds semantic coverage, not correctness.
- **Out of scope (deliberately):** what a consumer does with the signal — eviction, re-admission, whom it
  is surfaced to — is an assembler/policy concern, tracked with the live rung, not here. This layer only
  classifies.

## Algorithm recommendations (`reports/algorithm.md`) — classifier only

- **A1.** Record as settled that the topic-shift signal exists and is cheap, and name its instrument the
  **merged `z(lexical)+z(embedding)`** score (with both components exposed). This is a *classification*
  fact; it makes no claim about eviction.
- **A2.** Note the validation limit: unsupervised, "which boundaries are correct" is a proxy
  (segmentation quality). The classifier is confirmed to find *structure*; confirming its *boundaries*
  needs labels or a downstream outcome — a property of the signal, not of any consumer.

## Caveats

- **Segmentation quality is a PROXY objective** — no ground-truth shift labels. It measures whether a
  boundary set induces coherent segments, not whether the boundaries are the "true" topic shifts. The
  definitive test still needs labels or a downstream eviction outcome.
- One session, one window (n=3), equal-weight merge. Directional. The robustness ordering (merged best
  worst-case at K≥40) is the durable part.
