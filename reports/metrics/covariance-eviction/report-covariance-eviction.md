# Two covariance hypotheses for context eviction: one answered, one not testable

*A result, a non-result, and five corrections to an earlier version of this analysis.*

> This report supersedes the first version of `experiments/covariance-eviction/`, whose
> headline claims were overturned by adversarial review. The five withdrawn claims are
> listed in **What we got wrong**, not removed.

---

## Abstract

An AI coding agent re-sends its entire working transcript to the model on every step, so on
a long task the transcript outgrows the model's input limit and material must be deleted.
Which material to delete is the central design question for context-management middleware.
The system under study scores each candidate for deletion on four signals, of which the
heaviest is *priority* — a term combining "this unit edited a file" with "this unit's
identifiers recur elsewhere in the buffer". The recurrence half won an earlier offline
sweep and is the reason the term carries the largest weight.

We asked two questions. First, whether the recurrence term that ships is the term that was
tested: the shipped code forms its two halves into a sum *before* any weight is applied, so
no coefficient can move one half relative to the other, and its internal 2:1 ratio is a
constant no experiment had varied. Second, whether a signal that has never been computed
anywhere in the system — the tendency of two units to be *referenced together across
turns* — predicts which dormant material will be needed again. The second question matters
because relevance-to-recent was previously measured as the *worst* available eviction
signal, for the specific reason that it discards the dormant unit that later returns;
temporal covariance is the signal that would keep exactly that unit.

On the first question the answer is largely reassuring and partly surprising. Re-running
the original experiment on its own corpus with its own metric, changing only the definition
of a "turn" — the earlier analysis counted one turn per line of transcript file, inflating
the clock 2.22× — the recurrence advantage replicates
and survives, at +0.1714 → +0.1675
on one session and +0.0999 → +0.0582
on the other. Sweeping the ratio the shipped code cannot express, no value beats the shipped
one: the hardcoded constant is vindicated as a default. But measuring what the shipped term
actually ranks by, rather than the simplification an earlier version of this analysis
measured, produced an unplanned finding: the shipped priority term correlates
0.835 with reference-recency, above the threshold this project uses to
call one signal a relabelling of another. The four-signal scorer may be counting
reference-recency twice under two names.

On the second question we could not obtain an answer, and the reason is structural rather
than a shortage of data. A pairwise statistic needs two units to have been active together;
in these transcripts 19.9% of turns that reference a file
reference two or more, so co-activation is rare by construction. Across every corpus
available — the committed transcripts and every session on the machine — and across episode
windows from 1 to 20 turns, the share of candidates with
any co-activation history peaks at 49.0% against a
pre-registered requirement of 55.0%, and the median candidate pair has never been
co-active at any setting. The hypothesis is therefore recorded as untested, not as refuted.
That distinction is the point: the earlier version of this analysis reported contrasts from
this corpus as though they were evidence, and one of them did not survive a correction to
the resampling scheme.

---

## What you need to know to read the rest

Nothing beyond this table is assumed.

| Term | Meaning |
|---|---|
| **Agent** | An AI model given tools (read a file, write a file, run a command) and a goal, running in a loop until it decides it is done. |
| **Transcript / context** | Everything the model sees on a given step: the instructions plus the full history of what it has read, written and run. It is re-sent in full every step. |
| **Token** | The unit context is measured in — roughly ¾ of a word. |
| **Eviction** | Deleting older material from the transcript to get back under the input limit. The subject of this report is *what* to delete. |
| **Unit** | The thing eviction deletes: one turn of the transcript, kept whole so a tool call is never separated from its result. |
| **Decision** | One moment at which the policy must rank the units currently held. Each decision is scored against what the agent did next. |
| **Fingerprint** | A distinctive token extracted from a unit's text — a file path, a CamelCase name, a back-quoted symbol — used as a cheap proxy for "what this unit is about". |
| **Recurrence** | How many *other* units share at least one fingerprint with this one. The signal whose weight is under test. |
| **Reference-recency ("idle")** | How many turns since this unit's files were last touched. Low idle = touched recently. |
| **Temporal covariance** | The proposed new signal: how strongly this unit's files have *historically been active in the same episodes* as the files the agent is working on right now. |
| **Phi coefficient** | The correlation between two yes/no series — here, "was file A active this turn" against "was file B active this turn". Chosen over a plain co-occurrence count because a file touched on *every* turn scores zero against everything, instead of appearing to co-occur with all of them. |
| **Support** | How many turns two specific files were actually active together. Support of zero means the correlation above is computed from an empty table, i.e. it is noise. |
| **Recall@M** | Of the units the agent turned out to need, the share a policy would have kept if it could keep only M of them. Higher is better. |
| **AUC** | The chance that a needed unit is ranked above an unneeded one, within a single decision. 0.5 is a coin flip, 1.0 is perfect. |
| **The non-monotonic subset** | The hard case: units that had gone quiet for a long time and were then needed again. The case relevance-to-recent fails, and the case temporal covariance was proposed to fix. |
| **Micro- vs macro-averaging** | Two ways to average recall over decisions. *Micro* pools every needed unit, so a busy decision counts for more. *Macro* averages the per-decision rates, so every decision counts once. They disagree here — sometimes on sign — so every number states which it is. |
| **Moving-block bootstrap** | A way of putting error bars on a number when consecutive measurements are related. Chunks of consecutive decisions are resampled rather than individual ones; resampling individually would make the error bars too narrow. |
| **Holm correction** | An adjustment applied when several comparisons are made at once, so that testing five things does not manufacture one apparent success. |

---

## Why we ran this

The eviction scorer weights four signals. Three are cheap positional facts; the fourth,
*priority*, is the one with a research result behind it, and it is weighted highest because
of that result. Two things about it had never been checked.

**The shipped term is not obviously the tested term.** The code computes
`((wrote ? 2 : 0) + coOccurrence) * decay` and only then normalizes and weights the
result. Because the sum is formed first, every coefficient in the system scales both halves
together: the 2:1 ratio between "this unit edited something" and "this unit's identifiers
recur" is unreachable, and no experiment had varied it. The project's own rule forbids
undefended constants; this was one that could not even be reached.

**Nothing computes whether two units go together.** Every signal in the system is a
per-unit scalar. None is pairwise. That gap matters because of a specific earlier finding:
relevance-to-recent — keeping what resembles what the agent is doing now — was measured as
the *worst* eviction signal available, and the mechanism was understood. A unit that has
gone dormant does not resemble the recent window, by definition, so a relevance rule deletes
exactly the unit that is about to be needed again. Temporal covariance is the principled
repair: it keeps a dormant unit precisely when that unit has historically been worked on
*alongside* whatever is hot now. Same target case, opposite sign.

---

## The experimental setup

### The corpus

Four real Claude Code transcripts committed to the repository, from one developer working
on this project. They are not synthetic and not scripted; they are a record of ordinary
work.

| transcript | turns | transcript lines | clock inflation | file references | of which from shell commands | decisions scored |
|---|---|---|---|---|---|---|
| `session-2` | 291 | 651 | 2.24× | 253 | 136 | 186 |
| `session-3` | 44 | 98 | 2.23× | 42 | 39 | 10 |
| `session-5` | 1,046 | 2,402 | 2.30× | 1,135 | 710 | 751 |
| `session` | 331 | 645 | 1.95× | 320 | 258 | 204 |

Pooled: **1,712 turns**, 1,750 file references
(1,143 of them named on shell command lines), **1,151 decisions**
and **177,267 (decision × candidate) rows**.

### What a unit, a decision and the label are

A **unit** is one API turn. At each **decision** — every turn after a burn-in, where the
buffer holds at least eight candidates — the policy ranks the units it is holding, capped at
the most recent 200. The **label** is behavioural: a unit counts as *needed* if the agent
issued a tool call naming one of that unit's files within the next three turns. On this
corpus 5.5% of rows are needed, and
2,511 rows fall in the non-monotonic subset.

The cap has to actually bind for a "keep only M" comparison to mean anything; it does, on
99.1%,
94.3% and
86.1% of decisions at
M = 16, 32 and 64.

### The turn clock

A Claude transcript file stores one line per *content block*, not one per model turn: a
single turn that thinks, calls two tools and gets two results occupies five lines. The
earlier analysis counted lines. Across these four transcripts that inflates the clock by
**2.22× on average** (2.24×, 2.23×, 2.30×, 1.95×
per transcript), and every setting measured in turns — how far back "recent" reaches, how
long "dormant" is — rides on it. This analysis advances the clock on a change of message
identifier instead.

### How the error bars are computed

Consecutive decisions share candidates, a working context and an overlapping label window.
Measured here, the correlation between one decision's score and the next is
**+0.42 to +0.72**. Error bars are therefore a moving-block
bootstrap over blocks of 10 consecutive decisions, resampled within a transcript and
never across two. Resampling decisions independently — which an earlier version of this
analysis did, while calling it a block bootstrap — makes every interval about a third too
narrow.

---

## Results — question 1: is the shipped recurrence term the tested one?

### The original result replicates, and survives the clock correction

Re-running the published experiment on its own two transcripts, with its own signals, its
own fingerprints, its own micro-averaged metric and its own budget, changing **only** the
definition of a turn. The line-clock column reproduces the published numbers to two decimal
places, which is the check that the re-implementation is faithful.

| transcript | M | JSONL-line clock (as published) | API-turn clock (corrected) | verdict |
|---|---|---|---|---|
| 1 | 16 | +0.0363 [+0.0243, +0.0482] | +0.0405 [+0.0255, +0.0585] | never cleared +0.03 |
| 1 | 32 | +0.0825 [+0.0661, +0.1018] | +0.0909 [+0.0679, +0.1221] | **survives** |
| 1 | 64 | +0.1714 [+0.1463, +0.2015] | +0.1675 [+0.1403, +0.1952] | **survives** |
| 2 | 16 | +0.0226 [+0.0177, +0.0276] | +0.0168 [+0.0112, +0.0221] | never cleared +0.03 |
| 2 | 32 | +0.0493 [+0.0410, +0.0589] | +0.0342 [+0.0258, +0.0457] | lost to the fix |
| 2 | 64 | +0.0999 [+0.0865, +0.1157] | +0.0582 [+0.0462, +0.0707] | **survives** |

<svg viewBox="0 0 720 320" role="img" aria-label="Recurrence advantage under both turn clocks with confidence intervals" style="max-width:100%;height:auto"><line x1="64" y1="264.0" x2="696" y2="264.0" stroke="#e3e3ea" stroke-width="1"/><text x="56" y="268.0" font-size="11" fill="#6a6a78" text-anchor="end">0.00</text><line x1="64" y1="209.9" x2="696" y2="209.9" stroke="#e3e3ea" stroke-width="1"/><text x="56" y="213.9" font-size="11" fill="#6a6a78" text-anchor="end">0.05</text><line x1="64" y1="155.8" x2="696" y2="155.8" stroke="#e3e3ea" stroke-width="1"/><text x="56" y="159.8" font-size="11" fill="#6a6a78" text-anchor="end">0.10</text><line x1="64" y1="101.7" x2="696" y2="101.7" stroke="#e3e3ea" stroke-width="1"/><text x="56" y="105.7" font-size="11" fill="#6a6a78" text-anchor="end">0.15</text><line x1="64" y1="47.6" x2="696" y2="47.6" stroke="#e3e3ea" stroke-width="1"/><text x="56" y="51.6" font-size="11" fill="#6a6a78" text-anchor="end">0.20</text><line x1="64" y1="231.5" x2="696" y2="231.5" stroke="#c0392b" stroke-width="2" stroke-dasharray="6 4"/><text x="696" y="224.5" font-size="11" fill="#c0392b" text-anchor="end">+0.03 margin the original pre-registered</text><rect x="94.7" y="224.7" width="18" height="39.3" fill="#9aa0b5"/><line x1="103.7" y1="237.7" x2="103.7" y2="211.9" stroke="#2b2b38" stroke-width="1.4"/><line x1="99.7" y1="211.9" x2="107.7" y2="211.9" stroke="#2b2b38" stroke-width="1.4"/><line x1="99.7" y1="237.7" x2="107.7" y2="237.7" stroke="#2b2b38" stroke-width="1.4"/><rect x="120.7" y="220.2" width="18" height="43.8" fill="#2c6fbb"/><line x1="129.7" y1="236.4" x2="129.7" y2="200.7" stroke="#2b2b38" stroke-width="1.4"/><line x1="125.7" y1="200.7" x2="133.7" y2="200.7" stroke="#2b2b38" stroke-width="1.4"/><line x1="125.7" y1="236.4" x2="133.7" y2="236.4" stroke="#2b2b38" stroke-width="1.4"/><text x="116.7" y="281" font-size="11" fill="#4a4a58" text-anchor="middle">s1 M=16</text><rect x="200.0" y="174.7" width="18" height="89.3" fill="#9aa0b5"/><line x1="209.0" y1="192.5" x2="209.0" y2="153.9" stroke="#2b2b38" stroke-width="1.4"/><line x1="205.0" y1="153.9" x2="213.0" y2="153.9" stroke="#2b2b38" stroke-width="1.4"/><line x1="205.0" y1="192.5" x2="213.0" y2="192.5" stroke="#2b2b38" stroke-width="1.4"/><rect x="226.0" y="165.7" width="18" height="98.3" fill="#2c6fbb"/><line x1="235.0" y1="190.5" x2="235.0" y2="131.9" stroke="#2b2b38" stroke-width="1.4"/><line x1="231.0" y1="131.9" x2="239.0" y2="131.9" stroke="#2b2b38" stroke-width="1.4"/><line x1="231.0" y1="190.5" x2="239.0" y2="190.5" stroke="#2b2b38" stroke-width="1.4"/><text x="222.0" y="281" font-size="11" fill="#4a4a58" text-anchor="middle">s1 M=32</text><rect x="305.3" y="78.6" width="18" height="185.4" fill="#9aa0b5"/><line x1="314.3" y1="105.7" x2="314.3" y2="46.0" stroke="#2b2b38" stroke-width="1.4"/><line x1="310.3" y1="46.0" x2="318.3" y2="46.0" stroke="#2b2b38" stroke-width="1.4"/><line x1="310.3" y1="105.7" x2="318.3" y2="105.7" stroke="#2b2b38" stroke-width="1.4"/><rect x="331.3" y="82.8" width="18" height="181.2" fill="#2c6fbb"/><line x1="340.3" y1="112.2" x2="340.3" y2="52.8" stroke="#2b2b38" stroke-width="1.4"/><line x1="336.3" y1="52.8" x2="344.3" y2="52.8" stroke="#2b2b38" stroke-width="1.4"/><line x1="336.3" y1="112.2" x2="344.3" y2="112.2" stroke="#2b2b38" stroke-width="1.4"/><text x="327.3" y="281" font-size="11" fill="#4a4a58" text-anchor="middle">s1 M=64</text><rect x="410.7" y="239.5" width="18" height="24.5" fill="#9aa0b5"/><line x1="419.7" y1="244.9" x2="419.7" y2="234.1" stroke="#2b2b38" stroke-width="1.4"/><line x1="415.7" y1="234.1" x2="423.7" y2="234.1" stroke="#2b2b38" stroke-width="1.4"/><line x1="415.7" y1="244.9" x2="423.7" y2="244.9" stroke="#2b2b38" stroke-width="1.4"/><rect x="436.7" y="245.8" width="18" height="18.2" fill="#2c6fbb"/><line x1="445.7" y1="251.9" x2="445.7" y2="240.1" stroke="#2b2b38" stroke-width="1.4"/><line x1="441.7" y1="240.1" x2="449.7" y2="240.1" stroke="#2b2b38" stroke-width="1.4"/><line x1="441.7" y1="251.9" x2="449.7" y2="251.9" stroke="#2b2b38" stroke-width="1.4"/><text x="432.7" y="281" font-size="11" fill="#4a4a58" text-anchor="middle">s2 M=16</text><rect x="516.0" y="210.7" width="18" height="53.3" fill="#9aa0b5"/><line x1="525.0" y1="219.6" x2="525.0" y2="200.3" stroke="#2b2b38" stroke-width="1.4"/><line x1="521.0" y1="200.3" x2="529.0" y2="200.3" stroke="#2b2b38" stroke-width="1.4"/><line x1="521.0" y1="219.6" x2="529.0" y2="219.6" stroke="#2b2b38" stroke-width="1.4"/><rect x="542.0" y="227.0" width="18" height="37.0" fill="#2c6fbb"/><line x1="551.0" y1="236.1" x2="551.0" y2="214.6" stroke="#2b2b38" stroke-width="1.4"/><line x1="547.0" y1="214.6" x2="555.0" y2="214.6" stroke="#2b2b38" stroke-width="1.4"/><line x1="547.0" y1="236.1" x2="555.0" y2="236.1" stroke="#2b2b38" stroke-width="1.4"/><text x="538.0" y="281" font-size="11" fill="#4a4a58" text-anchor="middle">s2 M=32</text><rect x="621.3" y="155.9" width="18" height="108.1" fill="#9aa0b5"/><line x1="630.3" y1="170.4" x2="630.3" y2="138.8" stroke="#2b2b38" stroke-width="1.4"/><line x1="626.3" y1="138.8" x2="634.3" y2="138.8" stroke="#2b2b38" stroke-width="1.4"/><line x1="626.3" y1="170.4" x2="634.3" y2="170.4" stroke="#2b2b38" stroke-width="1.4"/><rect x="647.3" y="201.0" width="18" height="63.0" fill="#2c6fbb"/><line x1="656.3" y1="214.0" x2="656.3" y2="187.5" stroke="#2b2b38" stroke-width="1.4"/><line x1="652.3" y1="187.5" x2="660.3" y2="187.5" stroke="#2b2b38" stroke-width="1.4"/><line x1="652.3" y1="214.0" x2="660.3" y2="214.0" stroke="#2b2b38" stroke-width="1.4"/><text x="643.3" y="281" font-size="11" fill="#4a4a58" text-anchor="middle">s2 M=64</text><line x1="64" y1="264.0" x2="696" y2="264.0" stroke="#9a9aa8" stroke-width="1"/><rect x="64" y="298" width="12" height="11" fill="#9aa0b5"/><text x="81" y="308" font-size="11" fill="#4a4a58">JSONL-line clock (as published)</text><rect x="280" y="298" width="12" height="11" fill="#2c6fbb"/><text x="297" y="308" font-size="11" fill="#4a4a58">API-turn clock (corrected)</text><text x="64" y="24" font-size="13.5" font-weight="600" fill="#2b2b38">Recurrence minus recency (micro-averaged recall), before and after the turn-clock fix</text></svg>

The advantage is real, is concentrated at the larger budgets the original quoted, and is not
an artefact of the inflated clock. It *shrinks* on the second transcript — roughly halving —
which is worth carrying as a caveat rather than treating as a refutation.

### The term is not saturated, and its real form is not what an earlier analysis measured

A term that takes the same value for every candidate cannot be tuned, only removed. So: how
much does it vary?

| term measured | decisions sampled | distinct values per decision | coefficient of variation | never varies | ≤ 2 distinct values |
|---|---|---|---|---|---|
| recurrence over file paths | 1,151 | 15.36 | 0.9381 | 0.0% | 0.1% [0.0%, 0.5%] |
| recurrence over the shipped fingerprints | 60 | 8.08 | 0.2503 | 28.3% | 30.0% [19.9%, 42.5%] |
| **the shipped term, after decay and normalization** | 1,151 | 54.46 | 2.7102 | 0.0% | 0.0% [0.0%, 0.3%] |

The pre-registered threshold was "≤ 2 distinct values on more than 50% of
decisions". The measurement is 30.0%, so **the threshold is
not met** — the term is not saturated.

The last row is the one that settles the mechanism. The shipped scorer ranks by the
*product* `(edit boost + recurrence) × decay`, normalized afterwards — and that quantity
takes **54.46 distinct values per decision** and is never
flat. Even on the 28.3% of decisions where recurrence itself
is constant, the term does not switch off: it becomes *constant × decay*, which for units
that edited nothing is a live ranking signal that would be **absent** if recurrence were
zero.

### No ratio beats the shipped one

Sweeping the edit-to-recurrence ratio the shipped code cannot express. The second column is
the share of decisions on which a given ratio produces *literally the same ordering* as the
shipped one — because the edit indicator is binary, any ratio above 1 is mathematically
identical to the shipped setting and is not an independent arm at all.

| ratio ρ | identical ordering to shipped | recall@32 | paired difference vs shipped | clears +0.03? |
|---|---|---|---|---|
| 0 | 1.1% | 0.3035 | +0.0163 [-0.0212, +0.0541] | no |
| 0.25 | 1.1% | 0.296 | +0.0088 [-0.0179, +0.0352] | no |
| 0.5 | 1.7% | 0.2997 | +0.0125 [-0.0041, +0.0298] | no |
| 0.75 | 9.2% | 0.2909 | +0.0037 [-0.0028, +0.0103] | no |
| 1 | 46.9% | 0.2873 | +0.0001 [0.0000, +0.0003] | no |

No ratio clears the margin anywhere, and under the identifier-overlap label every ratio
below 1 is *worse*. **The hardcoded 2:1 constant is vindicated as a default.** It remains
underived, but it is no longer unmeasured.

---

## Results — question 2: does temporal covariance predict dormant returns?

### The corpus cannot answer, and we can say exactly why

The statistic needs two files to have been active together. They rarely are:

| files referenced in one turn | 1 | 2 | 3–4 | 5+ |
|---|---|---|---|---|
| turns | 985 | 129 | 89 | 27 |

Only **19.9%** of file-referencing turns name two or more
files, so most turns cannot produce a co-activation pair at all. Widening the episode window
raises the number mechanically; it never reaches the bar.

| episode window L (turns) | candidates with any co-activation history | verdict |
|---|---|---|
| 1 | 7.7% | below gate |
| 2 | 18.2% | below gate |
| 3 | 22.1% | below gate |
| 5 | 29.2% | below gate |
| 10 | 38.9% | below gate |
| 20 | 49.0% | below gate |

<svg viewBox="0 0 720 300" role="img" aria-label="Support share against dilation window, never reaching the gate" style="max-width:100%;height:auto"><line x1="64" y1="248.0" x2="696" y2="248.0" stroke="#e3e3ea" stroke-width="1"/><text x="56" y="252.0" font-size="11" fill="#6a6a78" text-anchor="end">0%</text><line x1="64" y1="197.0" x2="696" y2="197.0" stroke="#e3e3ea" stroke-width="1"/><text x="56" y="201.0" font-size="11" fill="#6a6a78" text-anchor="end">25%</text><line x1="64" y1="146.0" x2="696" y2="146.0" stroke="#e3e3ea" stroke-width="1"/><text x="56" y="150.0" font-size="11" fill="#6a6a78" text-anchor="end">50%</text><line x1="64" y1="95.0" x2="696" y2="95.0" stroke="#e3e3ea" stroke-width="1"/><text x="56" y="99.0" font-size="11" fill="#6a6a78" text-anchor="end">75%</text><line x1="64" y1="44.0" x2="696" y2="44.0" stroke="#e3e3ea" stroke-width="1"/><text x="56" y="48.0" font-size="11" fill="#6a6a78" text-anchor="end">100%</text><line x1="64" y1="135.8" x2="696" y2="135.8" stroke="#c0392b" stroke-width="2" stroke-dasharray="6 4"/><text x="696" y="127.8" font-size="11" fill="#c0392b" text-anchor="end">support gate 55% — never reached</text><polyline points="64.0,232.3 210.2,210.9 295.8,202.8 403.5,188.4 549.8,168.7 696.0,148.1" fill="none" stroke="#2c6fbb" stroke-width="2.5"/><circle cx="64.0" cy="232.3" r="4.5" fill="#2c6fbb"/><text x="64.0" y="221.3" font-size="10.5" fill="#2c6fbb" text-anchor="middle">7.7</text><text x="64.0" y="264" font-size="11" fill="#6a6a78" text-anchor="middle">1</text><circle cx="210.2" cy="210.9" r="4.5" fill="#2c6fbb"/><text x="210.2" y="199.9" font-size="10.5" fill="#2c6fbb" text-anchor="middle">18.2</text><text x="210.2" y="264" font-size="11" fill="#6a6a78" text-anchor="middle">2</text><circle cx="295.8" cy="202.8" r="4.5" fill="#2c6fbb"/><text x="295.8" y="191.8" font-size="10.5" fill="#2c6fbb" text-anchor="middle">22.1</text><text x="295.8" y="264" font-size="11" fill="#6a6a78" text-anchor="middle">3</text><circle cx="403.5" cy="188.4" r="4.5" fill="#2c6fbb"/><text x="403.5" y="177.4" font-size="10.5" fill="#2c6fbb" text-anchor="middle">29.2</text><text x="403.5" y="264" font-size="11" fill="#6a6a78" text-anchor="middle">5</text><circle cx="549.8" cy="168.7" r="4.5" fill="#2c6fbb"/><text x="549.8" y="157.7" font-size="10.5" fill="#2c6fbb" text-anchor="middle">38.9</text><text x="549.8" y="264" font-size="11" fill="#6a6a78" text-anchor="middle">10</text><circle cx="696.0" cy="148.1" r="4.5" fill="#2c6fbb"/><text x="696.0" y="137.1" font-size="10.5" fill="#2c6fbb" text-anchor="middle">49.0</text><text x="696.0" y="264" font-size="11" fill="#6a6a78" text-anchor="middle">20</text><text x="380" y="290" font-size="11.5" fill="#4a4a58" text-anchor="middle">episode window L (turns, log scale)</text><text x="64" y="24" font-size="13.5" font-weight="600" fill="#2b2b38">Share of candidates whose pair with a hot file has ANY co-activation history</text></svg>

Restricting to the units for which covariance is even plausibly defined does not rescue it
either — even candidates whose file has already been referenced ten or more times reach only
11.8%
support at L=1:

| prior references to the candidate's file | rows | with co-activation history |
|---|---|---|
| 1 | 19,263 (10.9%) | 0.0% |
| 2 | 20,908 (11.8%) | 1.4% |
| 3-4 | 23,441 (13.2%) | 4.6% |
| 5-9 | 42,310 (23.9%) | 9.2% |
| 10+ | 71,345 (40.3%) | 11.8% |

Across every other corpus on the machine — 3 further
projects' Claude Code sessions, surveyed in aggregate only — none is materially denser:
references per distinct file run
3.898, 2.248, 1 against
3.114 for the committed transcripts. NO corpus and NO dilation setting available on this machine clears the support gate. H2 is NOT evaluable here, and the reason is structural rather than a matter of data volume: 19.9% of referencing turns name two or more files, so same-turn co-reference of two specific files is rare by construction.

### What that means for the numbers we did compute

Because the gate is not met, the contrasts below are **not a null result about temporal covariance**. They are mostly a correlation computed from an empty table. The results file records this on the payload itself — the key is `h2_UNINTERPRETABLE_INSUFFICIENT_SUPPORT` and every row carries `interpretable: false` — so a later reader cannot quote them as a finding.

They are reported for one reason only: to show what the corrected error bars do to the one
cell an earlier version of this analysis presented as supportive. At the pre-specified
primary budget the signal is behind; the favourable cell was at a different budget and no
longer excludes zero.

| contrast (non-monotonic recall) | difference | interval |
|---|---|---|
| vs reference-recency, M=16 | +0.2054 | [+0.1379, +0.2565] |
| vs positional recency, M=16 | +0.0817 | [-0.0030, +0.1444] |
| **vs positional recency, M=32 (pre-specified primary)** | -0.0570 | [-0.1495, +0.0310] |
| vs positional recency, M=64 | -0.1576 | [-0.2647, -0.0784] |

The decisive endpoint — whether the signal adds anything on top of the four the system
already has, trained on one transcript and tested on the others — is flat:

| held out | decisions tested | AUC without | AUC with | difference |
|---|---|---|---|---|
| `session-2` | 186 | 0.8713 | 0.8719 | +0.0005 [-0.0015, +0.0030] |
| `session-5` | 751 | 0.8588 | 0.8589 | +0.0001 [-0.0004, +0.0008] |
| `session` | 204 | 0.7745 | 0.7742 | -0.0004 [-0.0009, +0.0001] |

### It is, at least, a different signal

Whatever else is true, temporal covariance is not a rename of something already present. The
correlation between the ordering it produces and the ordering positional recency produces is
**-0.534**, and against reference-recency **-0.294** —
far from the 0.8 this project treats as a relabelling, and negative, meaning it orders the
buffer close to opposite to recency.

---

## What we got wrong

Five claims in the first version of this analysis were false or unsupported. They are listed
because the pattern in them is the useful artefact: four of the five read in the direction
that made the work look more conclusive.

**1. "The saturation gate fires."** The pre-registered threshold was "≤ 2 distinct values on
more than 50% of decisions". The measurement was
30.0%. The first version nonetheless opened its results with
"S1 fires", made it the headline, and escalated it into a recommendation about the shipped
weight. **A null was read as a win on the one finding it said was worth acting on.**

**2. "A flat recurrence term is deleted by normalization."** False. Normalization is applied
to the product of the sum and the decay factor, not to the recurrence term. With recurrence
constant the term does not vanish — it becomes *constant × decay*, a live ranking signal. The
corrected measurement is in the results above, and a unit test now fails if the decay factor
is dropped.

**3. "The original result does not replicate."** Withdrawn. That claim came from a
re-measurement that differed from the original in six ways at once — the definition of a
unit, the size of the candidate pool, the fingerprint patterns, the text fed to them, the
transcripts used, and the budget quoted — and was read at the budget where the effect is
smallest, on a corpus mostly composed of a transcript the original never used. Holding all
six fixed and varying only the clock, **it replicates and survives**.

**4. "The ratio dial saturates above 1."** It does not saturate; it is an algebraic
identity. The edit indicator is binary after normalization, so any ratio above 1 orders the
buffer identically — four of the original eight sweep points were provably the same arm. The
first version presented their identical scores as an empirical finding about diminishing
returns.

**5. "Turn-level block bootstrap."** The function drew decisions independently, with no
block, while three source files and both design documents named it a block bootstrap.
Correcting it widened every interval by roughly a third and overturned two of the three
non-monotonic cells that had excluded zero — covariance against positional recency at M=16
became [-0.0030, +0.1444] and against reference-recency at M=32 became
[-0.0033, +0.1650], where the uncorrected version reported both as excluding zero.
Only [+0.1379, +0.2565], at M=16 against reference-recency, survived. The favourable cell
the first version led with is among those that did not.

Two further corrections carried no headline: the scorer labelled "shipped-priority" was a
simplified form the shipped code cannot express and has been renamed, with the real one
added alongside; and a fingerprint story was attributed to the shipped extractor, which does
not in fact match the token class it was blamed for.

---

## What survives

**The recurrence result is sound and the clock fix does not break it.** It replicates on its
own corpus under its own estimand, survives the corrected clock, and is concentrated at the
budgets the original quoted.

**The hardcoded 2:1 ratio is vindicated as a default.** No setting in the informative range
beats it, and the range above it is mathematically identical to it. The constant is still
underived, but it is no longer unmeasured, and this particular objection to it is closed.

**A new finding that nobody was looking for: the scorer may be counting reference-recency
twice.** Measuring the shipped priority term as the code actually computes it — rather than
the simplification the first version of this analysis used — it is a *strong* signal, AUC
0.814 [+0.7914, +0.8393], second only to reference-recency
at 0.886. But its ordering correlates **0.835** with
reference-recency, above the 0.8 this project uses to call one signal a relabelling of
another. The decay factor dominates the sum it multiplies, so much of what "priority"
contributes may be reference-recency arriving under a second name — in a four-signal scorer
that also carries reference-recency explicitly. That is a cheap, purely offline experiment
and it is the most valuable thing this work turned up.

<svg viewBox="0 0 720 300" role="img" aria-label="AUC by eviction signal with confidence intervals" style="max-width:100%;height:auto"><line x1="224.4" y1="38" x2="224.4" y2="260" stroke="#e3e3ea" stroke-width="1"/><text x="224.4" y="275" font-size="11" fill="#6a6a78" text-anchor="middle">0.5</text><line x1="321.2" y1="38" x2="321.2" y2="260" stroke="#e3e3ea" stroke-width="1"/><text x="321.2" y="275" font-size="11" fill="#6a6a78" text-anchor="middle">0.6</text><line x1="418.0" y1="38" x2="418.0" y2="260" stroke="#e3e3ea" stroke-width="1"/><text x="418.0" y="275" font-size="11" fill="#6a6a78" text-anchor="middle">0.7</text><line x1="514.8" y1="38" x2="514.8" y2="260" stroke="#e3e3ea" stroke-width="1"/><text x="514.8" y="275" font-size="11" fill="#6a6a78" text-anchor="middle">0.8</text><line x1="611.6" y1="38" x2="611.6" y2="260" stroke="#e3e3ea" stroke-width="1"/><text x="611.6" y="275" font-size="11" fill="#6a6a78" text-anchor="middle">0.9</text><line x1="224.4" y1="38" x2="224.4" y2="260" stroke="#c0392b" stroke-width="1.5" stroke-dasharray="5 3"/><rect x="224.4" y="51.4" width="374.1" height="16" fill="#7a8196"/><line x1="580.8" y1="59.4" x2="616.0" y2="59.4" stroke="#2b2b38" stroke-width="1.4"/><text x="166" y="63.4" font-size="11.5" fill="#3a3a48" text-anchor="end">idle-only</text><text x="623.0" y="63.4" font-size="11" fill="#4a4a58">0.886</text><rect x="224.4" y="82.3" width="303.8" height="16" fill="#e08a1e"/><line x1="506.5" y1="90.3" x2="552.8" y2="90.3" stroke="#2b2b38" stroke-width="1.4"/><text x="166" y="94.3" font-size="11.5" fill="#3a3a48" text-anchor="end">shipped-priority-true</text><text x="559.8" y="94.3" font-size="11" fill="#4a4a58">0.814</text><rect x="224.4" y="113.1" width="285.9" height="16" fill="#7a8196"/><line x1="482.5" y1="121.1" x2="532.5" y2="121.1" stroke="#2b2b38" stroke-width="1.4"/><text x="166" y="125.1" font-size="11.5" fill="#3a3a48" text-anchor="end">recency-only</text><text x="539.5" y="125.1" font-size="11" fill="#4a4a58">0.795</text><rect x="224.4" y="144.0" width="62.5" height="16" fill="#2c6fbb"/><line x1="264.6" y1="152.0" x2="311.6" y2="152.0" stroke="#2b2b38" stroke-width="1.4"/><text x="166" y="156.0" font-size="11.5" fill="#3a3a48" text-anchor="end">tcov</text><text x="318.6" y="156.0" font-size="11" fill="#4a4a58">0.565</text><rect x="224.4" y="174.9" width="34.8" height="16" fill="#7a8196"/><line x1="232.6" y1="182.9" x2="283.9" y2="182.9" stroke="#2b2b38" stroke-width="1.4"/><text x="166" y="186.9" font-size="11.5" fill="#3a3a48" text-anchor="end">split-priority-rho2</text><text x="290.9" y="186.9" font-size="11" fill="#4a4a58">0.536</text><rect x="224.4" y="205.7" width="10.2" height="16" fill="#7a8196"/><line x1="195.7" y1="213.7" x2="278.0" y2="213.7" stroke="#2b2b38" stroke-width="1.4"/><text x="166" y="217.7" font-size="11.5" fill="#3a3a48" text-anchor="end">recurrence-undirected</text><text x="285.0" y="217.7" font-size="11" fill="#4a4a58">0.510</text><rect x="224.4" y="236.6" width="0.0" height="16" fill="#7a8196"/><line x1="184.4" y1="244.6" x2="250.0" y2="244.6" stroke="#2b2b38" stroke-width="1.4"/><text x="166" y="248.6" font-size="11.5" fill="#3a3a48" text-anchor="end">recurrence-directed</text><text x="257.0" y="248.6" font-size="11" fill="#4a4a58">0.490</text><text x="176" y="24" font-size="13.5" font-weight="600" fill="#2b2b38">How well each signal orders one turn's buffer (AUC; 0.5 = chance, dashed)</text></svg>

**A methodological finding worth more than either hypothesis.** Micro- and macro-averaging
of recall disagree on the *sign* of the recurrence contrast at
**11 of the 16 cells** measured — including
**8 of 8** under the clock the published
result used, i.e. every one of them. Weighting each decision equally makes recurrence lose
to recency; weighting each needed unit equally makes it win, because the decisions with many
needed units are exactly where recurrence does well. Neither is wrong; only one is the
estimand the published result refers to. No report in this project had previously stated
which it used.

**And a structural one.** A pairwise co-reference signal may be undeployable on agent
transcripts in general, not merely on this corpus: agents name files one at a time, so two
specific files are rarely active together, and no volume of additional transcripts changes
that. Any future pairwise signal should be checked against this property before it is built.

---

## Caveats

- **One corpus, one developer, one repository.** Four transcripts, and the largest of them
  supplies 65.2%
  of all decisions — which is why every headline is also reported per transcript.
- **Micro- and macro-averaging disagree on sign** at 11 of
  16 cells, and at every cell under the published clock. Numbers in this
  report state which averaging they use; numbers in other reports in this project mostly do
  not.
- **The turn-denominated settings are owed a rescale.** They are numerically the original
  experiment's, but that experiment's "turn" is 2.22×
  shorter, so copying the numerals across halves every window rather than preserving intent.
  The contrast is known to be sensitive to this, and the sweep has not been run.
- **Question 2's verdict is corpus-dependent in one direction only.** A denser corpus could
  make temporal covariance testable; no corpus can make the present numbers into evidence.
- **The label is observational.** A unit can be *used* without being named again — the model
  reasons from what it already read. Every signal is biased the same way, which protects the
  comparisons but not the absolute rates.
- **Shell-command file extraction is a regex** over a command string, and shell commands
  supply 65.3% of all references here. It is the least trustworthy
  input in the pipeline, and excluding it is not neutral either.
- **No live arm was run.** The harness exists and is gated shut: the instrument-sensitivity
  check that would say whether a live comparison on this substrate can detect *any*
  selection effect is itself unresolved, and five previous live comparisons returned null or
  void.

---
*Generated by `experiments/covariance-eviction/report-covariance-eviction.mjs` from
`results-offline-v1.json`, `results-replicate-assembler-weighting.json`, `results-h2-corpus-survey.json`. Charts are inline SVG; the HTML version is self-contained.*
