# Position probe — does retrieval depend on WHERE a fact sits?

## Abstract

This project's eviction rules for an AI coding agent decide which parts of a long transcript to keep, but never
where the kept parts sit: survivors stay in their original order. If a model's ability to use a fact depended on
its position in the context, that would be a design lever the rules cannot express, and it would also offer an
alternative explanation for failures seen when the transcript is capped. Two known mechanisms predict such an
effect: RoPE's attenuation with distance and the "lost in the middle" pattern.

We tested for it directly with a needle-in-a-haystack probe on `unsloth/Qwen3.8-27B-GGUF`: 3 context lengths × 5 depths × 6 distinct needles per cell, graded by exact
match, run in two stages. The first stage had no distractors and was too easy to be informative. The second
placed 7 identically-worded distractors in the context and raised its length to
155,773 real prompt tokens, 59% of the model's window.

**The result is a clean null: 180 of 180 retrievals succeeded, at every depth and every length.**
There is no decay with depth and no U-shape. Zero failures in the 90 hard-stage trials rule out a
position-dependent failure rate above 3.3% on this task (one-sided 95%), which removes
position-aware assembly as a lever for this model at these lengths. The limit is the strength of the claim
at finer grain, and the task itself: a single depth could still hide a 15% deficit,
and single-turn retrieval of a lexically distinct sentence is far easier than an agent using its own history.
The one dose-response present is latency, which grows with prompt length.

## What you need to know to read the rest

| Term | Meaning |
|---|---|
| **Token** | The unit text is measured in — roughly ¾ of a word. Counts in the tables are the provider's real prompt-token counts. |
| **Context window** | The most tokens a model accepts in one request. For the model here, 262,144. |
| **Needle-in-a-haystack** | A retrieval test: hide one specific fact (the needle) in a long body of filler text (the haystack), then ask for it. |
| **Depth** | Where in the context the needle sits, as a fraction of its length: 0% is the very start, 100% the very end, just before the question. |
| **Distractor** | A decoy sentence with the same wording as the needle but about a different subject, so the model must pick the right one rather than the only one. |
| **Hit** | The model's answer exactly matches the needle's 4-digit code. |
| **Unit / eviction** | A unit is one piece of an agent's transcript; eviction deletes units to fit a size limit. This project's eviction rules decide which units stay, never where they sit. |
| **RoPE** | Rotary position embedding, how this model family encodes token position. It is known to weaken attention between distant tokens. |
| **Lost in the middle** | A reported pattern in long-context models: facts at the start or end are found more reliably than facts in the middle. |
| **One-sided 95% upper bound** | With zero failures in n trials, the largest true failure rate still consistent with the data at 95% confidence: 1 − 0.05^(1/n). It is what a clean null can rule out. |
| **Ceiling** | Every condition scoring 100%. A ceiling can refute a claimed deficit but cannot rank conditions against each other. |
| **Prefill** | The model's pass over the whole prompt before it writes anything; its cost grows with prompt length. |

## Why we ran this

Our eviction policies decide only **presence** — which units survive — never **position**. Survivors keep
creation order. If retrieval quality depended on where a fact sat, two policies that keep the same units
and leave them in the same band would be indistinguishable to the metric while differing in reality, and
we would be blind to a whole axis of the design space. The A/B window sweep saw exactly that shape:
idle vs positional recency, pooled `p = 1.000` (backlog item 8).

So the question is prior to any policy: **does the lever exist at all on this model?** Two mechanisms
predict it should — RoPE's long-term decay (attenuation with relative distance) and the "lost in the
middle" U-shape reported for long-context LLMs.

## The experimental setup

### The agent task these results are read against

The probe itself is synthetic, but the question comes from live runs of a fixed programming job called
`longbuild`. There the agent starts in a workspace holding a README, 13 specification documents (~20,000
characters in total) describing a small Python accounting library, five empty Python stubs to fill in
(`money.py`, `parsing.py`, `rules.py`, `report.py`, `cli.py`), and a visible test suite it may run at
any time. It works through six stages — read a stage's specification, implement it, run the tests, fix
failures, move on — and runs take roughly 53 to 61 steps. It is graded by a *held-out* test suite written
into the workspace only after it stops, which it never sees. When its transcript is capped (the "W-sweep"),
success falls; this probe asks whether part of that could be facts that are present but positioned badly.

### The probe

Classic needle-in-a-haystack, single-turn, `temperature = 0`, deterministic PRNG, so the whole probe
reruns identically.

- **Haystack** — non-repetitive synthetic records (each line distinct, so no pattern-match escape).
- **Needle** — `IMPORTANT RECORD: the access code for sector <NAME> is <NNNN>.` inserted at depth *d*.
- **Question** — appended at the very end; graded by exact match on the 4-digit code.
- **Grid** — 3 context lengths × 5 depths × 6 distinct needles per cell.

### What was varied

**Stage 1 (easy)** ran with **0 distractors**. It hit 90/90 — but that result is
weak by construction: the needle was the only 4-digit number near the question's wording, so the model could
pattern-match rather than discriminate. A ceiling reached that way proves little.

**Stage 2 (hard)** is the one that counts. It adds **7 distractors** — competing `IMPORTANT RECORD: the
access code for sector X is NNNN` lines for *other* sectors, scattered at deterministic positions through
the haystack. Every distractor carries the identical framing, so neither the marker phrase nor "the only
4-digit number here" is a usable shortcut: the model must discriminate on the sector name among 8
candidates. Stage 2 also pushes the lengths up ~6×, to **155,773 real prompt tokens** —
59% of the model's 262,144-token window.

### What was recorded, and how to rerun

Per trial: the answer, whether it was a hit, the real prompt-token count from the provider, and wall-clock
seconds.

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

### What this null does and does not cover

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

### The one real dose-response

Accuracy is flat; **latency is not**. Median call time scales ~linearly with prompt length
(9s @ 26k, 34s @ 78k, 92s @ 156k). That is prefill
compute, not retrieval degradation — the model is doing more work per call, not doing it worse. Worth
noting because it means "just use a bigger window" is not free even when quality says it is: on this host
a 156k-token turn costs ~10× the wall-clock of a 26k-token turn.

## What we got wrong

**The detection floor for a single depth was overstated.** An earlier revision of this report hardcoded the
number of trials in the "one depth, both stages" slice as 30. It is 36
(18 per depth in the hard stage plus 18 in the easy stage), so the largest
failure rate that slice can hide was quoted as 9.5% when it is 8.0%
— 1.5 percentage points too weak. The error ran against the null rather than for it and
changed no conclusion; every slice size is now derived from the data. Nothing else was withdrawn.

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

**What this does not license.** A large positional deficit in explicit, single-turn retrieval has been
**tested and rejected** for this model up to 155,773 tokens. Three things remain
**untested**: whether position affects how much an agent *spontaneously* uses its own history in a multi-turn
loop; whether a smaller effect (below ~3% pooled, or ~15% at one depth) exists; and whether any
of this holds for another model or beyond 59% of the window. Because every cell is at ceiling, the
probe also cannot say which ordering is better, only that none is detectably worse.

## Caveats

- **Single-turn retrieval of a lexically distinct sentence.** The needle is a copy target, not something
  the model must reason over. Real agent context is heterogeneous and the needed fact is rarely this
  distinct. A null here does not prove position is irrelevant inside a multi-turn agent loop.
- **A ceiling cannot rank policies.** 100% can only refute a claimed deficit. It cannot tell us which
  ordering is better, because every ordering is perfect.
- **One model** (`unsloth/Qwen3.8-27B-GGUF`), one host, one quantization. Positional effects are known to be
  architecture- and length-dependent; this says nothing about a different model or about longer contexts.
- **One synthetic problem.** Every trial is the same haystack design with different needles; the 180
  trials are repeats of one retrieval problem, not 180 problems.
- **Lengths are estimated (chars/4) for construction**; real `prompt_tokens` from the provider ran ~30%
  above the estimate and is what is reported in every table here.
- Stage 1's 90/90 is a weak ceiling (no distractors) and is reported only as the pre-registered stage that
  motivated the hard variant.

---
*Data: `results-position-probe.json` (hard), `results-position-probe-easy.json` (easy).
Charts in the HTML twin: `report-position-probe.html`.*
