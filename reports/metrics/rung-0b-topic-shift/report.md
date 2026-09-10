# Rung 0b — topic-shift detector (deterministic, zero model calls)

**Run:** `topic-shift-detector@v1` · offline · commit `d6a7f2c` · session
`packages/cli/test/fixtures/claude-code-session.jsonl` (287 tool-turns with fingerprints)
**Script:** `experiments/rung-0b-topic-shift/topic-shift.mjs` · **Raw:** `results.json`

## What was tested

The topic-shift half of HR3/H4: a topic shift is a turn whose tool-input fingerprints share little with
the previous *n* turns, detectable with no model. Per boundary *t*, cross-overlap =
Jaccard(∪fp[t−n..t−1], ∪fp[t..t+n−1]); the detector flags local-minimum boundaries ≤ μ − 0.5σ.
Pre-registered falsification: PASS iff flagged boundaries are ≥0.5σ below baseline **and** the
permutation null gives p<0.05 for the real sequence having **more** below-threshold boundaries.

## Result

| window | boundaries | baseline μ±σ | flagged | effect (σ) | real<thr | null<thr | permZ | permP | pre-reg verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| n=1 | 286 | 0.182±0.270 | 124 | 0.67 | 135 | 225 | −16.5 | 1.000 | **FAIL** |
| n=3 | 282 | 0.125±0.128 | 64 | 0.81 | 101 | 192 | −9.5 | 1.000 | **FAIL** |
| n=5 | 278 | 0.117±0.100 | 51 | 0.87 | 105 | 177 | −6.2 | 1.000 | **FAIL** |

Example flagged boundaries (n=3), before → after (tool + files):
- t=6 (overlap 0): `Bash loop.ts,run.js | Read loop.ts` → `Bash report.md,results.json` — *coding → writing a report*
- t=13 (overlap 0): `Bash run.js,iter4.log` → `Bash segmenter.ts,config.ts` — *running iterations → editing the segmenter*
- t=16 (overlap 0): `Bash segment.ts` → `Read build-jsonc-scenario.py` — *segmenter work → building a scenario*
- t=32 (overlap 0): `Bash iter5-rep2.log` → `Bash summarizer.ts` — *eval logs → the summarizer*

## Honest reading — the detector works; the pre-registered metric was mis-specified

**Report the FAIL as written (Rule 8), and do not silently flip it.** But the FAIL is not evidence the
signal is absent — it is evidence my permutation test checked the **wrong tail**:

1. **The effect-size half PASSES** — flagged boundaries sit 0.67–0.87σ below baseline at every window.
2. **The flagged boundaries are qualitatively real task transitions** (examples above: coding→report,
   iterations→segmenter, segmenter→scenario). The detector's *output* is meaningful.
3. **The permutation direction was backwards.** Real sessions have topic **runs** — consecutive turns
   touch the same files, so real overlap is *higher* within a topic. Shuffling destroys the runs and
   **scatters overlap downward**, so the null produces *more* low-overlap boundaries (192) than the real
   sequence (101), not fewer — hence permZ ≈ −9.5, permP = 1.0. I pre-registered "real has MORE
   below-threshold boundaries than the null," which is the opposite of what topic structure predicts.
4. **Correctly read (post-hoc, labelled as such): the real sequence is ~9.5σ MORE topically clustered
   than the permutation null** — overwhelming evidence that topic structure *exists* and is
   deterministically detectable. The pre-registered condition tested clustering with the sign reversed.

## Verdict and next step

- **Pre-registered condition: FAILED as written** (permutation tail mis-specified). I am not renegotiating
  it on this data.
- **Substantive finding: topic structure is real, strong (≈9.5σ), and the fingerprint-Jaccard detector
  flags genuine task transitions.** The signal HR3/H4's eviction trigger needs is present.
- **Corrected pre-registered condition for a held-out re-run** (a *different* session, so it is not fit
  to this one): PASS iff (a) flagged boundaries ≥0.5σ below baseline, and (b) the real sequence is
  significantly **more clustered** than the permutation null (real below-threshold count **lower**,
  one-sided p<0.05). Both hold here descriptively; confirming them on a held-out session is the clean test.

## Caveats

- One session, directional. Fingerprints from tool INPUTS only (file paths, identifiers).
- The detector flags boundaries; it does not yet act on them. Using a flag to *evict* dormant history is
  the live experiment (Rung 2/3), for which this establishes the signal is real and cheap.
