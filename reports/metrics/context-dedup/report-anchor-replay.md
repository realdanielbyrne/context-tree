# Anchor replay — F2 and F3: does a model attend to resident content when you reference it?

*Live, paired, 36 seeded events over 4 real Claude Code sessions. Qwen3-27B, temp 0, thinking off.*
Artifact: `results-anchor-replay-v2.json` · Code: `experiments/context-dedup/anchor-replay.mjs`
Rerun: `set -a; . ./.env; set +a; CT_TAG=v2 CT_REPLAY_MAX_EVENTS=40 CT_REPLAY_MAX_PREFIX=240000 node experiments/context-dedup/anchor-replay.mjs`

## Abstract

DV4 rejected F1: replacing already-resident tool-result bytes with a referential anchor saves
~0.2–1.6%, far under the 10% threshold, so it is not a deployable cost lever. F2 and F3 are
independent of that and test the *behavioural* claim — the one the idea was actually about.
**F2** asks whether a model, handed `Remember our earlier conversation about X` instead of a file
it already has, proceeds rather than re-fetching. **F3** asks whether the *reference* is what does
the work, or whether any withholding would do as well, by comparing against a **length-matched
non-referential** placebo.

**F2 is rejected: anchor acceptance is 41.7%, below the 70% threshold.** But that threshold was
miscalibrated — serving the full content achieves only 58.3%, so 70% was never reachable, and the
informative quantity is the paired contrast, where anchor and baseline are **not significantly
different** (−16.7pp, p=0.109).

**F3 is not rejected, and this is the substantive result.** The referential anchor beats the
length-matched placebo by **+27.8pp on acceptance (p=0.0063)**. The two strings are identical in
length to the character, so the difference cannot be a volume effect: **what the anchor says is
doing the work, not the fact that content was withheld.**

**Recall is unharmed.** On a needle question answerable only from the distant resident copy, the
anchor scores 86.1% against the baseline's 83.3% (p=1.0) — statistically identical, while supplying
**10.9× fewer tokens**. The model *can* reach back and use the content it already has; what the
anchor does not reliably do is stop it from re-fetching anyway.

## Definitions

**F2** — *the model accepts the anchor.* Falsified if arm `anchor` proceeds-without-re-requesting
< **70%**. Rationale: below that, the anchor costs a wasted turn *plus* the content anyway.

**F3** — *anchoring, not withholding, is the mechanism.* Falsified if `anchor` does not beat
`placebo` by ≥ **15pp** on acceptance or on needle correctness. If falsified, the summary machinery
is unnecessary and the attention-anchoring framing is retired.

**Arms**, all length-matched where it matters:
- `baseline` — the real file content (median 2,694 chars).
- `anchor` — `[Remember our earlier conversation about {path} — "{first line}" — which you read at turn {k}. It is above in this conversation, unchanged; use it rather than re-reading.]` (median 247 chars).
- `placebo` — neutral filler padded to the **identical** length (median 247 chars; **max per-event difference 0 chars**), carrying no path, no topic and no reference to earlier context.

## Method

Only 8 natural anchorable re-reads exist in the entire corpus (DV4 §3), which cannot support a
percentage. So the **trigger is synthesised while the context stays real**: take a real transcript
prefix in which file F was genuinely read, append a synthetic `read_file(F)` call, substitute the
arm's output for the result, and let the model take one turn. The prefix, the resident copy and the
file are real; only the re-read is manufactured.

**Paired design.** All three arms see the identical prefix and the identical needle, so event
difficulty cancels. Analysis is exact two-sided McNemar on discordant pairs.

**Two probes per event.** *Action* — no user turn; does it re-fetch F? *Needle* — quote the line of
F containing a given cue, where the answer token occurs **exactly once in the whole prefix**, so it
can only come from the resident copy.

36 events, 17 distinct files, 4 fixtures, prefixes 1.2k–189k tokens (median 81k), capped at 3 events
per file so no single heavily-re-read file dominates.

**D20 guard.** `assertToolCallIntegrity` throws rather than warns. It earned its place: during the
smoke run it caught a real defect — slicing a prefix at one tool result orphaned sibling
`tool_calls` from the same assistant message — which would have produced a structurally invalid
conversation that still looked fine in aggregate.

## Results

| arm | proceeded | re-requested | searched | errored | **acceptance** | needle ✓ | wrong | declined | **needle %** |
|---|---|---|---|---|---|---|---|---|---|
| `baseline` | 21 | 9 | 0 | 2 | **58.3%** | 30 | 3 | 3 | **83.3%** |
| `anchor` | 15 | 21 | 0 | 0 | **41.7%** | 31 | 4 | 1 | **86.1%** |
| `placebo` | 5 | 30 | 0 | 1 | **13.9%** | 28 | 1 | 7 | **77.8%** |

Paired, exact two-sided McNemar (n=36):

| contrast | metric | b | c | Δ | p |
|---|---|---|---|---|---|
| anchor vs **placebo** | acceptance | 11 | 1 | **+27.8pp** | **0.0063** |
| anchor vs **placebo** | needle | 5 | 2 | +8.3pp | 0.453 |
| anchor vs baseline | acceptance | 2 | 8 | −16.7pp | 0.109 |
| anchor vs baseline | needle | 3 | 2 | +2.8pp | 1.000 |

**Verdict: F2 rejected (41.7% < 70%). F3 not rejected (+27.8pp ≥ 15pp).**

The F3 effect is stable: an earlier run with a looser action classifier gave the *same* +27.8pp at
the same p=0.0063, while the absolute rates moved. That is what a paired design is for.

## Conclusions

1. **The referential content of the anchor does real work.** +27.8pp over a placebo that is
   identical in length to the character, p=0.0063. This is the hypothesis's core claim and it
   survives its pre-registered test. The alternative explanation — that any withholding forces the
   model to look back — is refuted: the placebo collapses to 13.9%.

2. **But the anchor does not reliably stop re-fetching.** 41.7% acceptance. It is not significantly
   worse than serving the content (p=0.109), but it is not good enough to deploy as a
   token-reduction policy — which, with F1 already rejected, leaves no cost case.

3. **The model can reach back; it just prefers not to.** Needle recall is statistically identical
   to having the content served (86.1% vs 83.3%, p=1.0) at 10.9× fewer tokens. So the failure is
   **not** an attention failure — the resident copy is reachable and correctly used when the model
   is asked a question about it. It is a *behavioural preference* for re-fetching when free to act.
   This is consistent with the position probe (90/90; 6/6 at 60k) showing no distal-recall deficit
   on this model, and with acceptance being flat across context distance (38% under 20k vs 39% over
   20k) — distance does not modulate the effect.

4. **The re-fetches are targeted, not wholesale.** Every re-request is a ranged `sed -n 'A,Bp'` of
   the file, never a full re-read. The model is not failing to remember that it has the file; it is
   choosing to re-verify a specific region. That is a different, and more defensible, behaviour than
   the read-loop thrash in `report-readloop.md`.

5. **F2's threshold was miscalibrated, and I set it the same way I criticised.** 70% was chosen
   without knowing that serving the content achieves 58.3%; the threshold was above the achievable
   ceiling. DV4's own conclusion 6 warned against exactly this and the warning was not applied here.
   The paired anchor-vs-baseline contrast is the quantity that should have been pre-registered.

## Tested vs open

**Tested:** that a referential anchor beats a length-matched non-referential withhold on acceptance
(p=0.0063), and that it costs nothing in content recall (p=1.0), on one model, on a synthesised
trigger over real context.
**Open:** whether any of this holds on a frontier model; whether a stronger anchor (naming the
specific region, or the turn) raises acceptance past the baseline; whether acceptance matters at all
given F1 already removed the cost case.

## Caveats

- **Seeded trigger.** The model did not itself ask to re-read; the call was inserted. Prefix,
  resident copy and file are real, the re-read is not.
- **Off-policy.** Transcripts were produced by a frontier Claude model and continued by Qwen3-27B.
  Between-arm contrasts are paired and interpretable; **absolute rates are not** an estimate of the
  original model's behaviour.
- **One model**, and one with no measured distal-recall deficit. A model that *does* lose distant
  content might benefit more from an anchor — or might not be able to use it at all.
- **n=36 paired events**, 17 distinct files, 4 sessions. The p=0.0063 contrast rests on 12
  discordant pairs. The needle contrasts (p=0.45, p=1.0) are underpowered and support no claim.
- **Needle is verbatim line-quoting**, which is harder and more brittle than the task-relevant use
  of content. The 4 anchor-arm wrong answers are confident near-misses — a real but different line —
  not wild confabulation, but they are stated without hedging.
- **Thinking blocks in the fixtures are redacted** (empty), so the replayed prefix shows the prior
  model acting with no visible reasoning.
- **Corpus is self-referential**: this project's agent reading this project's own source and planning
  documents.
- The action classifier was tightened between runs (word-boundaried, non-pipe-crossing match, and
  `grep` split out as `searched`); this moved 7 baseline events from re-requested to proceeded and
  left the F3 contrast unchanged. `searched` was 0 in every arm — no run issued a grep of the target.
