# Attention over history — untested hypothesis

This folder holds the **attention-over-history** hypothesis: retain/evict past context by how much
it bears on the current turn. It was lifted out of `packages/core/src/attention/` (see
`snapshot/`, git history preserved) because **the package holds only settled results, and this
hypothesis was never validly tested** — it is not superseded canon, it is unfinished research.

## Why it left the package

- The bespoke eval harness that would have measured attention policies could not represent a tool
  call (its `ChatMessage` had no `tool_calls` field), so it stripped the model's own tool calls and
  replayed results as user text. **Every arm comparison it produced is void.** The harness was
  deleted (D20). `reports/metrics/harness-deletion-and-hypothesis-register-report.md` §2–3.
- `selectAttention` (relevance-mass admission + priority boost), `rederive.ts`/`evictRederivable`
  (the priority channel), and `topic-index.ts` ("Zone B as an index") have **zero production
  callers** and pass only a *mechanism-can-fire* gate — never an *effect* measurement. The priority
  channel's `boost`/`halfLifeTurns` were shown **inert** in the zero-relevance limit (the gate can't
  discriminate them without query fingerprints). Register §6, hypothesis-ladder :873–882.
- `signals.ts` `detectAttentionSignals` is a **void artifact**: four regexes standing in for the
  "small classifier over assistant text" the design specified; it fires on 0.245% of turns. This is
  a mis-implementation, not a result — do not revive the regex approach. Register §4.

The umbrella hypothesis and H1–H6 are on the register's explicit **untested** list.

## What the record already settles about it (design constraints for the test)

- **It is an ADMISSION signal, not an eviction one.** D-EV4 measured relevance-to-recent as the
  *worst* eviction signal (0.06/0.10) — a dormant-but-returning unit by definition doesn't match the
  recent window, so relevance-eviction drops exactly the unit that returns. So attention/relevance
  belongs at the **retriever / assembler-in** (what to pull back), and eviction stays keyed on
  priority + recency + drift-dormancy. `reports/metrics/assembler-weighting/report-assembler-weighting.md`
  conclusion 4 (D-EV4/D-EV5).
- **Per-turn attention-eviction destroys the prefix cache.** `flex-remix` (re-pick each turn) is the
  measured cache-death case (433k vs 341k effCost). Anthropic break-even to invalidate a cached
  prefix is ~12.5 turns at keep=0.5 (`cacheWrite 1.25×` / `cacheRead 0.1×`). So admission must
  **append after the buffer** (never reorder the prefix) and fire at a **multi-turn cadence**, and
  the experiment must report effective cost, not token volume. `reports/metrics/assembler-flex-buffer/report.md`,
  register §7 item 6.

## The test design — NOW WRITTEN: see `DESIGN.md`

`DESIGN.md` is the current design and supersedes the sketch below, which described the *admission*
framing. The reframed hypothesis is about the model's **measured attention mass**, scored on a
continuous endpoint against a **causal** ground truth (leave-one-unit-out), not about
similarity-to-recent and not about task pass/fail.

| file | what |
|---|---|
| `DESIGN.md` | the design: signal maths, arms, endpoints, pre-registered falsification, feasibility, power, caveats |
| `attn_signal.py` | pure half — aggregation, sink handling, rank stats, volume matching, validity gates. No torch. |
| `measure.py` | GPU half — attention capture, LOUO + substitution control, matched ablation arms |
| `floor.py` | the endpoint's numerical floor (determinism is not accuracy) |
| `reanalyse.py` | offline re-analysis of a saved results JSON at either floor |
| `test_attn_signal.py` | 24 tests; 12 mutations verified caught |
| `attn-policy.mjs` | the live eviction seam (`rankAttention` for `evictToBudget`) |
| `attn-policy.test.mjs` | 16 tests; mutations verified caught |
| `snapshot/` | the never-validly-tested code this folder was created to hold |

## Status: stage 1 has run, and stage 2 is BLOCKED

An adversarial review found five blockers in the first draft, two of which invalidated the
measurement: the attention row was read at the end of the **continuation** rather than the context,
and "units" were not paired with their tool results (so every deletion orphaned a tool_call). Both
are fixed and guarded by assertions. **Every number in the first draft has been discarded.**

Corrected stage 1 — 85 turns, 4 distinct sessions, 60 analysable
(`reports/metrics/attention-over-history/results-primary-all-mean-20260915-105436.json`):

- F0 (signal varies, is not positional recency): **passes**
- F1 (direction: dropping high-attention units is worse): **passes**
- F2 (attention beats position by >= 0.10): **does not pass** — pooled margin +0.105 but per-turn
  wins 33/60, one of four session clusters negative, largest cluster +0.004
- F3 (policy arm): `lowattn - random` d = **-0.157** (the first draft's d = -1.24 was an artefact)

**Stage 2 must not be entered on this corpus**: the five fixtures are four distinct sessions
(session-4 is a strict subset of session-5, 1584/1584 shared uuids), and 4 clusters cannot support
the cluster-level inference F2 requires. See `DESIGN.md` §8.

## The oracle ceiling — RUN, and it reframes the whole line

`reports/metrics/attention-over-history/report-attention-over-history.{md,html}`

Instead of comparing two candidate signals at n=4 clusters, we measured the **ceiling**: an oracle
that evicts using the measured leave-one-out values, forced through the same volume matching as every
other arm.

| contrast | mean dNLL | vs floor | cells favouring |
|---|---|---|---|
| oracle - random | **-0.0810** | **13x** | 72/86 |
| oracle - recency | **-0.0666** | **11x** | 70/86 |
| low-attention - random | -0.0204 | 3x | 53/86 |

All four clusters agree in sign. Arms matched to 0.3% on tokens and exactly on unit count, and the
oracle fragments *more* than recency, so it is not winning on structure.

**96% of the damage random deletion causes is avoidable; recency captures 18% of that, attention 25%,
leaving ~75% unclaimed.** At the 30% keep-fraction the oracle's dNLL is negative — deleting the right
material beat keeping everything.

This inverts the reading of this project's five previous nulls: they were not evidence that the
choice does not matter, but that the candidates tested capture little of what is available. **The
bottleneck is the signal, not the opportunity.**

### Findings that survive regardless of the hypothesis

- Attention can be read at `O(L*H*T)` rather than `O(L*H*T^2)` — 19.5 MiB vs 204 GB — but **only from
  a forward over the context alone**; capturing during the scoring forward leaks the answer.
- **Token-volume matching is necessary but not sufficient.** Measured on the real `evictToBudget`:
  kept tokens match to ~0.4% while kept units diverge up to 2x and drop splices up to 13x.
- **Determinism is not accuracy.** Re-scoring an identical tensor gives bit-identical results and a
  floor of exactly zero; the real floor, from a shape-changing edit, is 6.3e-3 (same device) to
  2.5e-2 (cross device). The per-unit *ranking* survives at rho = +0.95, which is the ceiling on how
  well any predictor could correlate with this ground truth.
- **dKL is not measurable here**: computed in float32 from a bf16 forward it lands below its own ulp,
  producing negative "KL" values. All dKL claims are withdrawn.

### The earlier sketch, for the record

See `reports/session-handoff.md` → "Untested-hypothesis experiment backlog" item 1. In short:
- **Arm:** relevance-admission (push query-relevant dormant units back up-front, append-only) vs the
  on-demand baseline. This is also the spec's OPEN "retrieval trigger" A/B.
- **Regime:** the overflow regime — the corpus that reaches it exists (109 sessions ≥100 tool calls,
  55 > 131K tokens). Use a task with cross-turn retention required and **no re-read escape**.
- **Falsification (fixed in advance):** the admission arm must beat on-demand on task-success in the
  overflow regime by a pre-set margin, or attention-as-admission is retired. Report cacheWrite/cacheRead.

Only a settled result from that experiment earns a return to `packages/`.
