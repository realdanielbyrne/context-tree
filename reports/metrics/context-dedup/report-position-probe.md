# Position probe — does retrieval depend on WHERE a fact sits?

**Finding: no. 180/180 across both stages, at every depth, out to 155,773 real prompt
tokens with 7 competing distractors. The null is clean, and it kills position-aware assembly as a lever
for this model at these lengths.**

## Why this was run

Our eviction policies decide only **presence** — which units survive — never **position**. Survivors keep
creation order. If retrieval quality depended on where a fact sat, two policies that keep the same units
and leave them in the same band would be indistinguishable to the metric while differing in reality, and
we would be blind to a whole axis of the design space. The A/B window sweep saw exactly that shape:
idle vs positional recency, pooled `p = 1.000` (backlog item 8).

So the question is prior to any policy: **does the lever exist at all on this model?** Two mechanisms
predict it should — RoPE's long-term decay (attenuation with relative distance) and the "lost in the
middle" U-shape reported for long-context LLMs.

## Method

Classic needle-in-a-haystack, single-turn, `temperature = 0`, deterministic PRNG, so the whole probe
reruns identically.

- **Haystack** — non-repetitive synthetic records (each line distinct, so no pattern-match escape).
- **Needle** — `IMPORTANT RECORD: the access code for sector <NAME> is <NNNN>.` inserted at depth *d*.
- **Question** — appended at the very end; graded by exact match on the 4-digit code.
- **Grid** — 3 context lengths × 5 depths × 6 distinct needles per cell.

**Stage 1 (easy)** ran with **0 distractors**. It hit 90/90 — but that result is weak by construction: the
needle was the only 4-digit number near the question's wording, so the model could pattern-match rather
than discriminate. A ceiling reached that way proves little.

**Stage 2 (hard)** is the one that counts. It adds **7 distractors** — competing `IMPORTANT RECORD: the
access code for sector X is NNNN` lines for *other* sectors, scattered at deterministic positions through
the haystack. Every distractor carries the identical framing, so neither the marker phrase nor "the only
4-digit number here" is a usable shortcut: the model must discriminate on the sector name among 8
candidates. Stage 2 also pushes the lengths up ~6×, to **155,773 real prompt tokens** — 59% of the 27B's
262,144-token window.

- Model: `unsloth/Qwen3.8-27B-GGUF`, local, `temp 0`, `max_tokens 32`.
- Rerun: `CT_PROBE_LENGTHS=20000,60000,120000 CT_PROBE_DISTRACTORS=7 node experiments/context-dedup/position-probe.mjs`
- Commit: `25e3006469682a653fbc6b7c62153028214d809e`, 2026-09-15.

## Results

### Stage 2 — hard (7 distractors)

| real prompt tok | depth 0% | depth 25% | depth 50% | depth 75% | depth 100% |
|---|---|---|---|---|---|
| 26,123 | 6/6 | 6/6 | 6/6 | 6/6 | 6/6 |
| 77,970 | 6/6 | 6/6 | 6/6 | 6/6 | 6/6 |
| 155,773 | 6/6 | 6/6 | 6/6 | 6/6 | 6/6 |

### Stage 1 — easy (0 distractors)

| real prompt tok | depth 0% | depth 25% | depth 50% | depth 75% | depth 100% |
|---|---|---|---|---|---|
| 6,572 | 6/6 | 6/6 | 6/6 | 6/6 | 6/6 |
| 13,054 | 6/6 | 6/6 | 6/6 | 6/6 | 6/6 |
| 25,989 | 6/6 | 6/6 | 6/6 | 6/6 | 6/6 |

### Pooled

| stage | distractors | max real tok | trials | hits | accuracy |
|---|---|---|---|---|---|
| easy | 0 | 25,989 | 90 | 90 | 100% |
| hard | 7 | 155,773 | 90 | 90 | 100% |
| **both** | | | **180** | **180** | **100%** |

Zero errors, zero refusals, zero off-format answers across all 180 calls.

## What this null does and does not cover

A null is only as strong as its detection floor. With zero observed failures, the 95% one-sided upper
bound on the true failure rate is:

| slice | n | largest deficit still consistent with the data |
|---|---|---|
| one cell | 6 | 39.3% |
| one depth, hard stage | 18 | 15.3% |
| one depth, both stages | 36 | 8.0% |
| hard probe pooled | 90 | 3.3% |
| both stages pooled | 180 | 1.7% |

So the honest claim is: **no position-dependent failure rate above ~3%
exists on this task at these lengths.** A claim about one *depth* is much weaker — a single depth could
carry a 15% deficit and this design would likely miss it, and a single
*cell* weaker still (39%). What is ruled out is a *large* effect,
which is what the design space cared about.

## The one real dose-response

Accuracy is flat; **latency is not**. Median call time scales ~linearly with prompt length
(9s @ 26k, 34s @ 78k, 92s @ 156k). That is prefill
compute, not retrieval degradation — the model is doing more work per call, not doing it worse. Worth
noting because it means "just use a bigger window" is not free even when quality says it is: on this host
a 156k-token turn costs ~10× the wall-clock of a 26k-token turn.

## Conclusions

1. **The RoPE-attenuation hypothesis is not supported at these lengths on this model.** No decay with
   depth, and no U-shape: depth 50% is identical to depth 0% and depth 100%. Whatever MRoPE's long-term
   decay does to attention weights, it does not produce measurable retrieval loss out to 59% of the window.
2. **Position-aware assembly is dead as a lever here.** Our policies' inability to express position costs
   us nothing on this model at these sizes. That is a *relief* for the design, not a loss — it means the
   presence-only policy class is not leaving a known effect on the table.
3. **It removes an alternative explanation for the window-cap results.** The failures in the W-sweep were
   not "the fact was present but buried too deep to retrieve." Presence is sufficient. The failures were
   eviction removing content outright, which makes the eviction-cadence finding load-bearing rather than
   possibly-confounded by a positional artifact.

## Caveats

- **Single-turn retrieval of a lexically distinct sentence.** The needle is a copy target, not something
  the model must reason over. Real agent context is heterogeneous and the needed fact is rarely this
  distinct. A null here does not prove position is irrelevant inside a multi-turn agent loop.
- **A ceiling cannot rank policies.** 100% can only refute a claimed deficit. It cannot tell us which
  ordering is better, because every ordering is perfect.
- **One model** (`unsloth/Qwen3.8-27B-GGUF`), one host, one quantization. Positional effects are known to be
  architecture- and length-dependent; this says nothing about a different model or about 250k+ contexts.
- **Lengths are estimated (chars/4) for construction**; real `prompt_tokens` from the provider ran ~30%
  above the estimate and is what is reported in every table here.
- Stage 1's 90/90 is a weak ceiling (no distractors) and is reported only as the pre-registered stage that
  motivated the hard variant.

---
*Data: `results-position-probe.json` (hard), `results-position-probe-easy.json` (easy).
Charts in the HTML twin: `report-position-probe.html`.*
