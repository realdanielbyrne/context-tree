# How much is there to win by choosing what to evict?

*A ceiling experiment. We gave one eviction rule the answers; it avoided almost all the damage, and the rules we actually ship do not.*

## Abstract

An AI coding agent re-sends its entire working transcript to the model on every step, so on a long task the
transcript outgrows the model's input limit and some of it must be deleted. Which parts to delete is the
central design question for context-management middleware, and five successive experiments on this substrate
have failed to distinguish one deletion rule from another. Those nulls are ambiguous: either the choice
genuinely does not matter, or the measurement cannot detect it.

We resolve the ambiguity by measuring the ceiling rather than comparing candidates. For each decision point in
a real agent transcript we deleted every unit of history in turn and recorded how much harder the agent's
actual next message became, giving a direct causal importance for each unit. We then built an **oracle** rule
that evicts using those measured values — a rule no real system could implement, because it requires having
already run the counterfactual it is trying to avoid. Because the oracle is forced through the same
volume-matching as every other rule, dropping the same number of tokens and the same number of units, it
cannot win by keeping more. Whatever margin it achieves over random deletion is therefore an upper bound on
what *any* rule that scores units independently — attention, recency, co-occurrence, a learned policy — could
ever achieve on this substrate.

**The ceiling is high, and current rules reach almost none of it.** Across 86
volume-matched cells drawn from 60 analysable decision points in 4 distinct
sessions, the oracle caused 0.081 nats/token less damage than random
deletion and 0.067 less than the incumbent recency rule — respectively
13× and 11×
the measurement's numerical floor of
6.3e-3, which was established by running the identical comparison through two numerically-equivalent
code paths. All four session clusters agree in sign.
Choosing well removes 96% of the damage that random deletion causes; the recency rule
the system actually ships captures 18% of that available prize and an
attention-based rule 25%, leaving roughly 75% unclaimed.

The practical conclusion inverts the natural reading of this project's five previous null results. Those nulls
were not evidence that the choice does not matter. The choice matters a great deal; the candidate rules tested
so far simply do not exploit it. The bottleneck is the signal, not the opportunity.

## What you need to know to read the rest

Nothing below is assumed. Every term used later is defined here.

| Term | Meaning |
|---|---|
| **Agent** | An AI model given tools (read a file, run a command, edit code) and a goal, looping until it decides it is done. |
| **Transcript / context** | Everything the model can see on a given step: the instructions plus the full history of what it has read, written and run. It is re-sent in full every step. |
| **Token** | The unit text is measured in — roughly ¾ of a word. |
| **Unit** | The smallest thing eviction may remove: one assistant message **together with every tool result it produced**. They travel together because deleting a tool call but keeping its result (or vice versa) produces a transcript that could never have occurred. |
| **Eviction** | Deleting older units to stay under the input limit. The subject of this work: *which* units? |
| **Keep-fraction** | How much is deleted in one go, as a share of the evictable tokens. We test 15%, 30%, 50%. |
| **Attention mass** | How much of the model's attention, at the moment it is about to act, lands on a given unit. Read directly out of the model's internals. |
| **Attention sink** | The first few tokens of a prompt absorb a large share of all attention regardless of content. Any "share of attention" that includes them is mostly measuring them, so they are excluded. |
| **Leave-one-unit-out (LOUO)** | Delete exactly one unit, re-run the model, and measure what changed. This is a direct causal measurement of that unit's importance, not a proxy for it. |
| **ΔNLL** | The endpoint. How much *harder the agent's real next message became*, in nats per token, once something was deleted. Larger means more damage. Zero means the deletion cost nothing. |
| **The numerical floor** | The smallest ΔNLL that is a measurement rather than arithmetic noise. Computed by running the identical comparison two numerically-equivalent ways; they disagree by 6.3e-3, so differences smaller than that carry no information. |
| **Volume matching** | Forcing every rule to delete the same amount, so they differ only in *which* units go. Without it a rule can "win" by simply keeping more context, an effect already known to be large. |
| **Splice** | A cut point left in the transcript. Deleting three consecutive units leaves one splice; deleting three scattered units leaves three. Rules that fragment the transcript more may do more damage for reasons unrelated to what they deleted. |
| **Session / cluster** | One complete agent transcript. Decision points within a session are highly similar to each other, so the session, not the decision point, is the independent unit for statistics. |
| **Oracle** | A rule given the LOUO answers and told to delete the least-important units. Not implementable; used only to measure the ceiling. |

## Why we ran this

The project's central question is what to delete. Every previous attempt to answer it compared two candidate
rules and found no difference — selection signal p = 0.70; reference-recency versus positional recency
p = 1.000; needle position 180/180 at every depth; eviction cadence null once achieved size is controlled;
and, in this experiment's own first stage, attention versus position.

Five nulls in a row is not five pieces of evidence. It is one unanswered question: **is there anything there
to find?** A between-rule comparison cannot answer that, because it can only ever say "these two are similar".
A ceiling can.

### Why this is not the claim already rejected

An earlier result in this project concluded that relevance belongs at *admission* rather than eviction. That
conclusion was about **relevance computed by embedding similarity to the recent window**, and it failed for a
comprehensible reason: a unit that has gone dormant but will be needed again does not resemble the recent
window, so similarity-based eviction deletes precisely the unit that returns. The present work measures
something different — the model's **actual attention mass**, and behind it the **measured causal effect** of
deletion. A unit can be perfectly retrievable and receive almost no attention; those are different quantities
and only the first had been measured.

### How this reconciles with the position probe

A previous experiment found no retrieval deficit at any depth: 180 out of 180 needles found, out to 155,773
tokens, with competing distractors. If depth does not hurt retrieval, what is left to predict?

The two experiments condition on different things. The position probe asks *can the model find this when
explicitly asked* — a ceiling on what the context could contribute given a pointed query. This experiment asks
*how much does the model's next action actually depend on this*, with no query pointing anywhere. A unit can be
perfectly findable on request and contribute nothing spontaneously. Nothing here predicts retrieval failures,
so nothing here contradicts that null.

## The experimental setup

### The model, and why not the 27B

All measurements use **meta-llama/Llama-3.2-1B-Instruct** in bfloat16 on a single spare GPU. The project's main model is a 27B
served through llama.cpp, which **cannot export attention** — GGUF-style serving does not expose it — and the
server was in use by other work throughout. The 1B is the largest model that fits the 4.9 GiB of spare
VRAM alongside a 12,000-token context without evicting that server. This is a real limitation and it is
restated in the caveats: a signal measured on a 1B may not transfer to a 27B, and that transfer has not been
tested.

### The corpus

Five transcript fixtures are committed to this repository, but they are **four distinct sessions**:
`claude-code-session-4.jsonl` is a strict subset of `claude-code-session-5.jsonl` — same session id, 1,584 of
1,584 shared event identifiers. Treating them as two clusters would let one session vote twice, which biases
in exactly the direction that manufactures a positive result, so they are collapsed.

| | count |
|---|---|
| committed fixtures | 5 files → **4 distinct sessions** |
| decision points measured | 85 |
| decision points analysable (see floor) | **60** |
| volume-matched cells analysed | **86** |
| independent clusters | **4** |

### What a unit is, and why tool results are paired to their calls

A unit is one assistant message plus every tool result it produced. In a real transcript the results do **not**
always arrive immediately after the call — sessions interleave, and a result can land after a later assistant
message — so units are assembled by matching each result to the identifier of the call it answers, not by
arrival order. An automatic check refuses to proceed if any result ends up in a different unit from its call.
This matters because an earlier version of this code split them, so every single-unit deletion produced a
transcript containing an unanswered tool call, and part of what was being measured was the model reacting to
a malformed transcript rather than to lost information.

### How the arms are matched

Every rule deletes from the same pool and must hit the same token target. Matching on tokens alone is not
enough: because attention mass correlates with unit length, "delete the lowest-attention units" naturally
means "delete many small units" while "delete the oldest" means "delete a few large contiguous ones". Measured
on the real eviction code, arms matched to 0.4% on tokens still differed up to 2× in unit count and 13× in
splice count.

So units are grouped into size strata, a single per-stratum quota is drawn once and applied to every arm, and
a bounded within-stratum repair brings the token totals together. Every arm then deletes the same number of
small units and the same number of large ones; only *which* unit inside each stratum differs. Achieved:

| arm | mean tokens deleted | mean units deleted | mean splices |
|---|---|---|---|
| oracle (ceiling) | 3,174 | 8.9 | 4.9 |
| low-attention | 3,168 | 8.9 | 4.6 |
| residual-attention | 3,168 | 8.9 | 4.7 |
| recency (incumbent) | 3,169 | 8.9 | 4.3 |
| random (control) | 3,170 | 8.9 | 5.3 |
| high-attention | 3,179 | 8.9 | 5.1 |

Within-cell ratios across arms: tokens **1.036× mean, 1.071× max**;
units **1.000× mean**; splices 1.62× mean. The oracle
fragments the transcript by −0.333 splices relative to random — stated because a rule that
wins by cutting more tidily has not proven anything about *what* it cut.

### What ΔNLL measures, and the floor

After each deletion the model is re-run and scored on the agent's **real** next message, teacher-forced.
ΔNLL is how much harder that message became, in nats per token. It is continuous, so it does not depend on
the binary pass/fail metric that has returned null four times.

Its resolution was measured, not assumed. Re-running an identical computation gives bit-identical results —
but that measures determinism, not accuracy. Running the *same* deletion through two numerically-equivalent
code paths (different attention kernel, same device and precision) gives an RMS disagreement of
**6.3e-3**; across different device and precision, 2.5e-2. The first governs internal
comparisons, which is what this report makes. A decision point is analysable only if at least
50% of its units produce an effect above that floor; 60 of 85
qualify. Within those, 26% of individual measurements still sit below it.

For scale: the typical per-unit deletion effect is 1.2e-2 nats/token, about
2.0× the floor, and the spread between units within one decision point averages
5.0e-2, about 7.9× the floor. The endpoint has real dynamic range; it is
not comfortable.

## Results

### The ceiling

*(chart: damage by arm — see the HTML version)*

| keep-fraction | cells | oracle (ceiling) | low-attention | residual-attention | recency (incumbent) | random (control) | high-attention |
|---|---|---|---|---|---|---|---|
| 15% | 20 | −0.0016 | +0.0245 | +0.0265 | +0.0206 | +0.0308 | +0.0623 |
| 30% | 33 | −0.0231 | +0.0340 | +0.0300 | +0.0470 | +0.0412 | +0.0666 |
| 50% | 33 | +0.0338 | +0.1186 | +0.1169 | +0.1238 | +0.1608 | +0.2025 |

Mean ΔNLL, lower is better. Every row is volume-matched.

*(chart: gaps against the floor — see the HTML version)*

The headline contrasts, each against the floor:

| contrast | mean ΔNLL difference | Cohen's d | cells favouring | vs floor |
|---|---|---|---|---|
| **oracle − random** | **−0.08096** | −0.627 | 72/86 | outside |
| **oracle − recency** | **−0.06661** | −0.503 | 70/86 | outside |
| recency − random | −0.01435 | −0.109 | 45/86 | outside |
| low-attention − random | −0.02042 | −0.134 | 53/86 | outside |
| low-attention − high-attention | −0.05351 | −0.227 | 58/86 | outside |

**The oracle's advantage over random is −0.08096 nats/token against a floor of
6.3e-3 — 13× the resolution limit.** Random
deletion costs +0.0847; perfect selection costs +0.0037. So
**96% of the damage is avoidable**, and the question becomes how much of that any
real rule captures:

| rule | mean ΔNLL (lower is better) | share of the available prize captured |
|---|---|---|
| oracle (ceiling) | +0.0037 | 100% |
| low-attention | +0.0642 | 25% |
| residual-attention | +0.0625 | 27% |
| recency (incumbent) | +0.0703 | 18% |
| high-attention | +0.1178 | -41% |

A negative share means the rule did **worse than deleting at random** — which is what the direction check
predicts for deliberately deleting the highest-attention units, and is the evidence that the attention signal
carries a real, if weak, direction.

At the largest keep-fraction the oracle's ΔNLL is +0.0338,
and at 30% it is **negative** — deleting the right half of the history made the agent's next message *easier*
to predict than keeping all of it. Low-value history is not merely inert; carrying it costs something.

### Per session, and per keep-fraction

Four clusters is four clusters. All of them:

*(chart: per-session gaps — see the HTML version)*

| session | cells | oracle − random | favouring | oracle − recency | favouring |
|---|---|---|---|---|---|
| `claude-code-session-2.jsonl` | 24 | −0.06449 | 20/24 | −0.07108 | 20/24 |
| `claude-code-session-3.jsonl` | 5 | −0.06745 | 4/5 | −0.01152 | 3/5 |
| `claude-code-session-5.jsonl` | 25 | −0.14436 | 23/25 | −0.09399 | 23/25 |
| `claude-code-session.jsonl` | 32 | −0.04589 | 25/32 | −0.05047 | 24/32 |

4 of 4 clusters favour the oracle over random, and they agree in sign — unlike the attention result in the same data, where one cluster runs the other way. Every keep-fraction, not the
most favourable one:

| keep-fraction | cells | oracle − random | favouring | oracle − recency | favouring |
|---|---|---|---|---|---|
| 15% | 20 | −0.03237 | 15/20 | −0.02214 | 14/20 |
| 30% | 33 | −0.06434 | 28/33 | −0.07013 | 27/33 |
| 50% | 33 | −0.12702 | 29/33 | −0.09004 | 29/33 |

### The attention hypothesis itself (F0–F3)

| test | requirement | result |
|---|---|---|
| **F0** signal is not inert | varies across units | **passes** — 60/60 decision points |
| **F0** signal is not relabelled recency | \|ρ(mass, position)\| ≤ 0.5 | **passes** — 57/60 |
| **F1** direction | deleting high-attention units is worse than deleting low-attention ones | **passes** — −0.05351 |
| **F2** attention beats position | margin ≥ +0.10 | **does not pass** — pooled +0.105, per-turn median +0.037, 33/60 decision points |
| **F3** policy value | low-attention ≤ random | right direction, −0.02042, outside the floor |

Pooled over 1304 (decision point × unit) measurements, attention's partial correlation with the
causal effect, controlling for unit length, is +0.065 against position's −0.040.

## What we got wrong

An adversarial review of the first version of this experiment found five defects. Two of them invalidated the
measurement outright. They are listed because the corrected result differs from the first one by more than the
effect being studied.

1. **The attention row was read after the continuation it was supposed to predict.** Attention was captured
   during the same forward pass that scored the agent's next message, so the "current position" was the last
   token of that message. The predictor was conditioned on the answer, and the signal was not computable at
   eviction time at all — the live policy code could never have reproduced it. *Invalidated: every attention
   number in the first version.* Fixed by capturing on a separate pass over the context alone, with an
   assertion that the captured width equals the context length.
2. **Units did not include their tool results.** Assistant messages and tool results were separate units, so
   every single-unit deletion orphaned a tool call. *Invalidated: the ground truth itself*, which was partly
   measuring reactions to malformed transcripts. Fixed by pairing on the call identifier, with an automatic
   well-formedness check.
3. **"The measurement floor is exactly zero."** This came from re-scoring an identical tensor, which measures
   determinism rather than accuracy. *Invalidated: the claim that the endpoint had three orders of magnitude
   of dynamic range* — the bottom decade was arithmetic noise. Fixed by measuring with a shape-changing edit.
4. **A second endpoint, KL divergence, was below its own representable precision.** Computed in float32 from a
   bfloat16 forward, it produced values below the floating-point spacing — including a **negative KL**, which
   is impossible by construction — and its apparent correlation with attention was explained by unit length
   alone. *Invalidated: all KL-based claims*, which are withdrawn rather than re-stated.
5. **The corpus was four sessions, not five.** Two fixtures are the same session. *Invalidated: the planned
   clustered analysis*, which would have counted one session twice.

The size of the correction is the point. Before the fixes, the low-attention rule appeared to beat random with
an effect size of d = −1.24; measured correctly it is −0.134.

## What survives

- **A cheap instrument for causal importance.** Per-unit leave-one-out costs ~0.11 s per unit here, and
  reading attention costs 19.5 MiB rather than the 204 GB a naive full-attention export would need. Any future
  eviction signal can be validated offline against measured ground truth before a live token is spent.
- **The prize is large and mostly unclaimed.** Perfect unit-independent selection avoids
  96% of the damage random deletion causes. Recency captures 18%
  of that and attention 25%, so about 75% is still on the table.
  This is the number the rest of the project needs: it says keep looking for a better signal, and it says the
  previous nulls were about the candidates, not about the opportunity.
- **Deleting the right material can be better than deleting nothing.** At the 30% keep-fraction the oracle's
  ΔNLL is negative. Low-value history actively costs the model something, which is an argument for eviction
  as a quality mechanism and not only as a way to fit inside a window.
- **Volume matching is necessary but not sufficient.** The incumbent eviction code matches kept tokens to
  0.4% while diverging up to 2× in unit count and 13× in splice count. Any future arm comparison must
  match or covary those too.
- **Determinism is not accuracy**, and the distinction is worth 6e+9 orders of
  magnitude here. Every offline measurement in this repository should establish its floor with a
  shape-changing edit.

## Caveats

- **One model, and a small one.** Everything is measured on a 1B. The project's own vehicle is a 27B, and
  attention structure is known to be depth- and scale-dependent. The transfer has **not** been tested. The
  planned test is a size ladder (0.6B / 1B / 1.7B) checking whether the per-unit ranking is stable across
  scale; if it reshuffles between 0.6B and 1.7B it will not survive to 27B.
- **Four clusters.** This is the binding limit and no number of additional decision points from the same four
  sessions fixes it. Every figure here is descriptive; no confidence interval is quoted, because a clustered
  bootstrap on four clusters covers roughly 50–60% at a nominal 95%.
- **The two aggregations disagree in sign** depending on the inclusion floor and on whether measurements are
  pooled or averaged per decision point. Pooled, attention's margin over position is +0.105; as a
  median of per-decision-point values it is +0.037. A result that flips with the aggregation
  choice is not stable at this sample size, and both are reported for that reason.
- **The oracle is a ceiling for unit-independent ranking only.** Single-unit effects are not additive, so the
  best *set* of units to delete need not be the units with the smallest individual effects. The oracle bounds
  every signal this project has proposed, all of which score units independently; it does not bound a
  set-aware policy.
- **Teacher-forced, not rollout.** ΔNLL scores the agent's recorded next message. It cannot see a
  counterfactual where losing a unit sends the agent down a different but equally good path.
- **26% of surviving measurements are below the floor**, which attenuates every rank statistic
  toward zero. A null here is partly a null about resolution.
- **Replayed transcripts, not live agents.** The transcript is fixed; the agent never reacts to the eviction.
  This is the immediate information cost of a deletion, not its trajectory cost.

---
*Data: `results-primary-all-mean-20260915-111951.json` (+ `.npz` tensor sidecar).
Code: `experiments/attention-over-history/{attn_signal,measure,floor,reanalyse}.py`,
`attn-policy.mjs`. Design and pre-registration: `experiments/attention-over-history/DESIGN.md`.
Model `meta-llama/Llama-3.2-1B-Instruct`, bfloat16, git `c5b12e8d7553`,
torch 2.11.0+cu130, transformers 5.5.0.
Regenerate: `node experiments/attention-over-history/report-attention-over-history.mjs`*
