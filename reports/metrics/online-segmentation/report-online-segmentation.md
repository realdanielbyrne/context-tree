# Online segmentation — tool-phase vs topic-shift (D1), scored by a local-model oracle

**Question.** D1 (asserted, never tested): does deterministic **tool-phase** segmentation
group history as well as **content-based topic-shift** segmentation? Both online/real-time
(each boundary decided causally as the trace streams, committed once — cache-safe). One
variable = the boundary rule.

**Setup.** Corpus = `claude-code-session-2.jsonl`, a real sustained Claude Code session. Arms:
`tool-phase@v1` (boundary on tool-type change), `topic-shift@v1` (top-K causal drift
`0.5·(1−lexical Jaccard) + 0.5·(1−embedding cosine)` vs previous W=3 turns, K matched to
tool-phase's count), `random@v1` (floor). **Reference:** the local model (Qwen3.8-27B, *not*
Claude) as a topic-boundary oracle (SAME/DIFFERENT), blind to arm, tool names stripped.
Numbers: `results-online-segmentation.json`, `results-strength-ranked.json`. Rerun:
`node experiments/online-segmentation/online-segmentation.mjs --cap 80` (oracle self-check: `--diagnose`);
`node experiments/online-segmentation/strength-ranked-segmentation.mjs`.

**Confound controls:** C1 matched boundary count · C2 blind pooled+shuffled positions · C3 tool
names stripped from the oracle · C4 one shared labeled sample · C5 random floor + base rate ·
C6 fixed oracle (prompt/temp0/thinking-off) · C7 seeded RNG · C8 causal (online) drift.

## A confound found and removed mid-run (why an early version was wrong)

The raw parse yielded **214 of 955 turns (22%) that were empty** — assistant messages carrying
only a `thinking` block whose text is **redacted to empty** when Claude persists it (Opus 4.8,
`display: "omitted"`; signature kept, reasoning gone). An empty turn has zero content words, so
`jaccard(∅, window)=0` forced **maximum drift** — the drift ranking was surfacing *wrappers*, not
topic shifts. Fix: drop content-less turns (739 turns remain, 0 empty). This is essential; the
pre-fix strength-ranked numbers (P@K=0) measured the artifact, not the signal.

## Instrument validation (`--diagnose`)

Oracle shift-rate at user-prompt positions (candidate boundaries) vs interior:

| oracle | @ user-prompt | @ interior | separation |
|---|---|---|---|
| thinking OFF | 0.25 | **0.00** | 0.25 |
| thinking ON | 0.08 | 0.00 | 0.08 |

Never false-fires on interior; separates with **thinking-off** (thinking-on over-conservative).
Topic shifts are genuinely **sparse** — this is one coherent task.

## Result 1 — matched fine granularity (cap 80, 288 labeled, base-rate shift 2.8%)

| arm | precision | recall | F1 |
|---|---|---|---|
| tool-phase@v1 | 0.058 | 0.75 | 0.108 |
| topic-shift@v1 | 0.071 | 0.875 | **0.131** |
| random@v1 (floor) | 0.030 | 0.375 | 0.056 |

- Instrument valid (both > floor+0.05). **D1 HOLDS at this granularity** (ΔF1 = 0.023 ≤ 0.10) —
  topic-shift is *nominally* ahead on P, R and F1, but within the band. Both over-cut (180
  boundaries → low precision); topic-shift catches 7/8 real shifts vs tool-phase's 6/8.

## Result 2 — coarse granularity, ranking allowed (strength-ranked)

topic-shift ranks boundaries by drift strength; tool-phase cannot (every tool transition is equal).
So compare topic-shift's TOP-K vs tool-phase's (unranked) precision:

| | P@8 | P@16 | P@32 | tool-phase (K-invariant) |
|---|---|---|---|---|
| precision | 0.125 | **0.1875** | 0.1875 | **0.05** |

- **RANKING HELPS (pre-registered): topic-shift P@16 = 0.19 ≥ tool-phase 0.05 + 0.10.** Its top-16
  drift boundaries are **~3.75× more precise** than tool-phase's cuts. This is topic-shift's real
  edge, invisible at the matched-180 granularity of Result 1.

## Conclusions

- **D1 is granularity-dependent.** At *fine* matched granularity (180 cuts), tool-phase ≈
  topic-shift (D1 holds) — both over-cut a coherent session and tie, topic-shift barely ahead.
  At the *coarse* granularity that topic segmentation actually wants (a few boundaries), **content
  drift's ranking wins clearly** (3.75× precision). So the shipped deterministic tool-phase
  segmenter is fine when you keep every transition, but it has **no way to pick its best few
  boundaries** — that is exactly what the content signal adds.
- **The content signal's value is its RANKING, not a different boundary set.** This is the
  actionable design takeaway: use tool-phase (or any cheap boundary set) for fine units, but rank
  with drift when you must be selective (coarse summaries, eviction to a soft target).
- **Corpus limit stands:** base-rate shift ≈ 2.8% (~8 real boundaries), so absolute precision is
  low and power is limited — direction is consistent and the pre-registered thresholds fired, but a
  **multi-task session** would test this with real power.

## Tested vs. open

- **Tested (live oracle, one session):** D1 holds at fine granularity; topic-shift's drift *ranking*
  beats tool-phase at coarse K (pre-registered "ranking helps" = true); oracle validated.
- **Open:** a **multi-task** corpus (more shifts → power); whether the ranking edge changes a
  **downstream** metric (summary/retrieval/eviction quality), which this boundary-agreement test
  doesn't touch; robustifying drift against residual volume spikes (big tool_results).

**Caveats.** Local Qwen3 oracle (not Claude), coarse binary judgment, small n (~8 positives; P@16=3/16,
tool=2/40). Segmenter modeling choices (phase carry-forward, W=3, 50/50 lexical/semantic) fixed. One
session, directional.
