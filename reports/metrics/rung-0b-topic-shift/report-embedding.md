# Rung 0b (non-deterministic) — embedding-drift topic-shift

**Run:** `topic-shift-embedding@v1` · offline · model `Xenova/all-MiniLM-L6-v2` · commit `d6a7f2c`
**Script:** `experiments/rung-0b-topic-shift/topic-shift-embedding.mjs` · **Raw:** `results-embedding.json`
**Companion (deterministic, lexical):** `report.md` / `topic-shift.mjs`. Same session, same 287 tool-turns.

## What was tested

A non-deterministic counterpart to the lexical detector: topic shift measured as **semantic drift** —
cosine similarity between the mean MiniLM embedding of the *n* turns before and after a boundary — instead
of fingerprint-Jaccard. Unsupervised (no labels, no trained head), so it stays inside v1's
"no fine-tuning" constraint. A supervised FFN/probe or a sufficiency classifier would need labels we do
not have (and, for the FFN, a trained head v1 forbids); this is the label-free version.

## Result

| window | baseline μ±σ | flagged | effect (σ) | real<thr | null<thr | permZ |
| --- | --- | --- | --- | --- | --- | --- |
| n=1 | 0.525±0.205 | 61 | 1.16 | 103 | 161 | −8.5 |
| n=3 | 0.695±0.132 | 47 | 1.42 | 76 | 79 | −0.4 |
| n=5 | 0.754±0.096 | 37 | 1.52 | 76 | 37 | +5.1 |

**Semantic vs lexical flagged (n=3): both 34, semantic-only 13, lexical-only 30.**
Semantic-only examples: `Edit loop.ts → Bash loop.test.ts`, `Bash html → Artifact html` (same file,
different action). Lexical-only: file changes between semantically similar TS modules.

## Findings

1. **Larger effect size than lexical** (1.16–1.52σ vs 0.67–0.87σ): semantic drift separates its flagged
   boundaries more sharply from its own (smoother) baseline.
2. **Different signal, not strictly better.** The detectors agree on a core 34 boundaries and disagree
   ~40% of the time: lexical flags *identifier/file* changes (even between similar files); embedding
   flags *content/action* changes (even on the same file). The semantic-only flags look like
   action-modality pivots (edit→test, bash→artifact) rather than topic shifts — i.e. **noisier for the
   eviction use-case**, which wants topic, not action, boundaries.
3. **Permutation structure is regime-dependent** for embeddings (permZ −8.5 → −0.4 → +5.1 across n):
   mean-pooled embeddings occupy a narrow cone, so the strong clustering the lexical run showed (−9.5σ)
   is weaker and window-dependent here.

## Conclusion

- A non-deterministic embedding detector is **cheap, label-free, and finds real structure with a larger
  effect size** — viable.
- It is **complementary to the lexical detector, not superior**; on this session its extra flags are
  action changes, which is the wrong granularity for topic-scoped eviction.
- **Which detector is *correct* cannot be settled unsupervised.** Deciding it needs ground-truth shift
  labels or a downstream eviction outcome — the exact label wall that gates the sufficiency classifier
  and any FFN/probe. The signal is present and detectable; *validating the boundary* is the labelled step.

## Caveats

- One session, directional. Embeds tool-input text (name + JSON args), not full turn text.
- Same turn set as the lexical run (comparability). The falsification remains the corrected clustering
  condition from `report.md`, to be confirmed on a held-out session.
