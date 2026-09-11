# Assembler eviction — how to weight the incoming signals

**Question.** The eviction algorithm combines signals (recency, relevance, priority,
dormancy) into a keep/evict decision at a budget. **How should they be weighted?** Isolate
the assembler; one variable = the weights. Offline, deterministic (fingerprints, no model),
so every (turn × past-unit) pair is a datapoint — high power.

**Setup.** Two real Claude Code sessions (`claude-code-session-2.jsonl`: 741 turns / 569
fingerprinted units; `-session.jsonl`: similar). Units = turns. Eviction happens at t−1 using
only 0…t−1, to prepare for the unseen turn t (this breaks the circularity that would make
relevance win trivially). Signals (min-max normalized): `rec` recency, `rel` relevance to the
last K=5 turns, `prio` priority (# recurrences so far), `refrec` reference-recency (inverse
dormancy). **Ground truth:** `needed(u,t)` = fingerprint(u) ∩ fingerprint(t) ≠ ∅ within horizon
H=3. **Metric:** keep-needed recall @ budget M — overall, and on the **non-monotonic** subset
(needed AND dormant >10 turns), the safety-critical case (H1). Numbers:
`results-assembler-weighting.json`. Rerun: `node experiments/assembler-weighting/assembler-weighting.mjs [--session 1|2]`.

## Result (keep-needed recall; non-monotonic in parens; M=64, both sessions)

| weighting | overall (s2 / s1) | non-monotonic (s2 / s1) |
|---|---|---|
| recency-only | 0.25 / 0.24 | **0.23 / 0.21** |
| relevance-only | 0.33 / 0.39 | **0.06 / 0.10** ← worst |
| priority-only | 0.35 / 0.42 | 0.14 / **0.27** |
| rel+prio(+refrec) | 0.36 / 0.42 | 0.10 / 0.25 |

Best grid weighting `[w_rec, w_rel, w_prio, w_refrec]` at the tighter M=32 budget was
**identical across both sessions: `[0.5, 0, 0.5, 1]`** — recency + priority + reference-recency,
**relevance weight = 0**.

## Conclusions — and they refine the earlier "assembler needs the retriever's signal"

1. **Content signals beat naive recency on OVERALL recall** (+0.10 to +0.18 at M=64) — the
   assembler should not evict by recency alone. `prio` earns its weight most (pre-registered
   +0.03 threshold cleared at every M≥16 in both sessions).
2. **Relevance-to-recent is the WORST signal for eviction, and actively harmful on the
   non-monotonic case** (nonmono recall 0.06 / 0.10 — dead last in both sessions). This is
   mechanical and robust: a dormant-but-returning unit *by definition* doesn't match the recent
   window, so relevance-based eviction drops exactly the units H1 is about. The best weightings
   set `w_rel = 0`.
3. **`priority` + `recency`/`reference-recency` protect the non-monotonic returns.** Their
   relative order flips by session (recency best in s2, priority best in s1) but **both dominate
   relevance by 2–4×** on nonmono. Priority is the MVP: best overall lift *and* strong nonmono
   protection (it remembers what mattered even when dormant).
4. **The load-bearing architectural correction:** **relevance is an ADMISSION signal, not an
   EVICTION signal.** The retriever's query-relevance decides what to *pull in* for the current
   turn; the assembler's *eviction* should key on **priority + recency + topic-dormancy
   (classifier)** and NOT on the retriever's relevance. So the earlier hypothesis — "the
   assembler needs the retriever's relevance signal to evict" — is **refuted**: using recent
   relevance to evict costs the non-monotonic case. The cross-boundary coupling the assembler
   actually needs is the **classifier's** dormancy, plus its own intrinsic priority/recency.
5. **Consistent with the operator's asymmetry.** Dropping a needed unit (task cost) is worse
   than keeping an extra (token cost); the non-monotonic recall is the safety-critical number,
   and there recency/priority win — so a conservative, priority-keyed eviction (not a
   relevance-keyed one) is the right default.

## LR refinement (cross-session validated) — `results-lr-refinement.json`

Logistic regression on the 4 signals, trained on one session and tested on the other:

- **Test AUC 0.84–0.90** — the mix predicts `needed` well and **generalizes across sessions**; the
  eviction problem is learnable from these 4 signals with a simple linear mix.
- **Pooled mixing rates: `prio 4.12` ≫ `rec 2.42` ≈ `rel 2.37` > `refrec 1.04`** — priority dominates ~2×.
- **Interactions do not help held-out AUC** (lift ≈ 0; `prio×dormancy` ≈ −0.2). No nonlinearity to
  exploit → a small FFN would add nothing here; LR is the right ceiling on this proxy.
- **Reconciliation with the sweep:** LR gives `rel` a positive coefficient (it predicts `needed`
  *overall*), yet the sweep shows `rel` is *worst* on the *non-monotonic* subset. Both hold — `rel`
  helps the common monotonic case and fails the dormant-return case; the pooled LR is dominated by
  the common case. Under the operator's **asymmetric** loss (dropping a returning unit is the
  task-killer), `rel` stays **down-weighted in eviction** despite its raw-AUC appeal.

## RECORDED DEFAULTS — assembler / eviction algorithm (offline-derived; validate live)

Applied as the working defaults until the live coding test revises them:

- **D-EV1. Eviction score is a LINEAR mix of `priority`, `recency`, `reference-recency`, `relevance`.**
  No nonlinear mixer / FFN — interactions gave no held-out lift (this run) and v1 ships no learned
  components.
- **D-EV2. Priority is the dominant term** (~2× the others; LR `prio 4.12`). It carries both the best
  overall recall and the non-monotonic protection.
- **D-EV3. Recency + reference-recency are protective and kept** — they guard the non-monotonic
  (dormant-return) case that relevance drops.
- **D-EV4. Relevance is an ADMISSION signal, down-weighted in EVICTION** (well below priority; may be
  0). Its errors concentrate on the safety-critical non-monotonic case, and the operator's asymmetric
  loss (err toward more context) penalizes exactly those. The retriever's query-relevance governs what
  to *pull in*, not what to *keep across turns*.
- **D-EV5. The eviction signal set comes from the assembler's own state (`priority`, `recency`,
  `reference-recency`) + the CLASSIFIER's dormancy — NOT the retriever's relevance.** This is the
  corrected cross-boundary wiring.
- **Status:** offline, proxy label (fingerprint overlap), 2 sessions. These are working defaults, not
  settled constants — the live coding test (causal "needed") is what confirms or revises them.

## Tested vs. open

- **Tested (offline, 2 sessions, high-power):** relevance is bad-to-harmful for eviction;
  priority + recency/reference-recency are the eviction signals; the retriever's relevance belongs
  to admission, not eviction.
- **Open:** the live consequence (does priority-keyed eviction preserve task success + save tokens
  in a real coding run); a segment-unit variant (units = topic-segments, not turns); a decayed
  priority; and whether the classifier's *ranked drift* (from the segmentation finding) improves
  the dormancy term.

**Caveats.** Ground truth is identifier-overlap (observational, the standing DSA proxy — not causal
usefulness). Absolute recall is low (many needed units per turn under broad fingerprint overlap) —
the metric **ranks weightings**, it doesn't claim absolute coverage. Units = turns (segmentation not
varied). Non-monotonic subset is smaller-n, but the ordering (relevance worst) is consistent across
both sessions and all four budgets. Fingerprint extraction is heuristic.
