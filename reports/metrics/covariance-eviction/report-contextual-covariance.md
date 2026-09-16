# Contextual covariance: a signal that holds where the incumbents collapse

*A positive result, with a pre-registered primary that misses, and a correction to the previous report in this series.*

> This report follows `report-covariance-eviction.md`, which concluded that a pairwise
> co-reference signal is starved on agent transcripts. **That conclusion was over-general**
> and is corrected in **What we got wrong**. The starvation is a property of keying the
> signal on file paths, not of covariance.

---

## Abstract

An AI coding agent re-sends its whole working transcript to the model on every step, so on a
long task the transcript outgrows the model's input limit and material must be deleted. The
hardest case for any deletion rule is the unit that has gone quiet and is then needed again:
a rule that keeps what resembles the agent's current work deletes exactly that unit, which
is why relevance-to-recent was previously measured as the *worst* available eviction signal
and is weighted zero in the shipped system.

This report tests the signal that would keep that unit. For every unit still held, we ask
not whether it resembles what the agent is doing now, but whether its features have
*historically been active alongside* the features the agent is working on now — a phi
coefficient over each session's own co-activation history, with the history window and the
current window kept disjoint and with any feature the unit shares with the current window
removed from both sides, so that present similarity cannot contribute. A previous version of
this work keyed that statistic on file paths, found that 19.9%
of file-referencing turns name more than one file, and concluded the statistic was starved.
Keyed on identifiers instead, the same transcripts support it on
84.3% of decisions rather than 6.1%.

The result is a clear gradient and a qualified primary. As the definition of "dormant" is
made stricter — from 10 turns since a unit's files were touched, out to 50 —
positional recency falls from 0.403 to 0.0138
and reference-recency from 0.2764 to 0, while
covariance is almost flat, 0.365 to 0.3022. It is the best of the
six signals from D=20 onward, and it beats a volume-matched random control at every dormancy
depth up to 35 with intervals excluding zero. That gradient is what the
hypothesis predicted, and it is the mechanism the earlier finding about relevance describes,
observed directly. The decisive control passes too: covariance is not relevance renamed, with
a rank correlation of 0.0231 between the two orderings, and the
advantage survives stripping every path-bearing token from the feature set, which rules out
the signal simply exploiting the file vocabulary its label is written in.

What does not pass is the pre-registered primary as written. It required covariance to beat
*relevance specifically*, at one budget and one dormancy threshold; it misses in the
identifier space by a lower bound of -0.0042 and fires only in the
lexical space, which is the one space where covariance does **not** beat the random floor.
The pre-registration named the relabelling control and omitted the floor control, and on this
evidence the floor contrast is the more informative of the two. The honest verdict is that
contextual covariance is a real signal with a mechanism that behaves as theorised, not yet an
established improvement over the specific incumbent it was pre-registered against.

---

## What you need to know to read the rest

| Term | Meaning |
|---|---|
| **Agent** | An AI model given tools (read a file, write a file, run a command) and a goal, looping until it decides it is done. |
| **Transcript / context** | Everything the model sees on a step: instructions plus the full history of what it read, wrote and ran. Re-sent in full every step. |
| **Token** | The unit context is measured in — roughly ¾ of a word. |
| **Eviction** | Deleting older material to get back under the input limit. The subject here is *what* to delete. |
| **Admission** | The opposite operation: deciding what to pull back in. The scores here could serve it; this report does not measure it. |
| **Unit** | The thing eviction deletes: one API turn, kept whole so a tool call is never split from its result. |
| **Decision** | One moment at which the policy ranks the units it holds. Scored against what the agent did next. |
| **Feature** | Whatever the signal is keyed on. Four spaces are tested: file paths, identifiers, identifiers with paths removed, and content words. |
| **Fingerprint** | A distinctive identifier — camelCase, PascalCase, UPPER_SNAKE, a back-quoted symbol, a file path. Extracted by the function the shipped system uses. |
| **Hot window** | The features of the last few turns — what the agent is working on right now. |
| **Relevance** | Plain overlap (Jaccard) between a unit's features and the hot window's. **No history.** The signal that was previously measured as worst, and the control this experiment lives or dies on. |
| **Contextual covariance ("tcov")** | The candidate signal: how strongly a unit's features have *historically* been active alongside the hot window's, with shared features excluded so present overlap contributes nothing. |
| **Phi coefficient** | The correlation between two yes/no series — "was feature A active this turn" against "was feature B active this turn". A feature active on *every* turn scores zero against everything, which is the guard against a promiscuous feature linking everything to everything. |
| **Support** | How many turns two features were actually active together. Zero support means the correlation is computed from an empty table, i.e. noise. |
| **Saturation** | The opposite failure: so many features co-occur that every unit scores alike and the signal is inert. |
| **Recall@M** | Of the units the agent turned out to need, the share a policy keeps when it can keep only M. |
| **AUC** | The chance a needed unit outranks an unneeded one inside one decision. 0.5 is a coin flip. |
| **The non-monotonic subset** | The hard case: units needed again after going quiet for more than D turns. D is swept here rather than assumed. |
| **Moving-block bootstrap** | Error bars that respect the fact that consecutive decisions are related: blocks of consecutive decisions are resampled, never single ones. |
| **Holm correction** | An adjustment for making several comparisons at once, so testing many things does not manufacture one apparent success. |

---

## Why we ran this

The shipped eviction scorer weights four signals, and it weights query-relevance at **zero**.
That is not an oversight; it is a finding. A unit that has gone dormant does not, by
definition, resemble the recent window, so a relevance rule deletes precisely the unit that is
about to be needed again. The dormant-return case is the one that costs the agent work, and
relevance is worst on it.

That leaves a gap. Nothing in the system computes whether a unit *goes with* what is happening
now — only whether it *looks like* it. Those are different questions, and only the second had
been measured. Contextual covariance asks the first: a unit whose features have historically
been active alongside the features now in play is a good bet even if it shares nothing with
them today, which is exactly the unit relevance throws away.

A previous report tried this and could not test it, because it keyed the statistic on file
paths and 80.1% of file-referencing turns name only one
file. That measurement was right; the conclusion drawn from it — that covariance in general is
starved — was not.

---

## The experimental setup

### The corpus and what a decision is

Four real Claude Code transcripts committed to the repository, 1,712
turns in total. A **unit** is one API turn. At each **decision** the policy ranks the units it
holds, capped at the most recent 200. Candidates are past turns that referenced at
least one file, so the label is defined for every candidate in every arm.

The **label is behavioural and file-based**: a unit counts as *needed* if the agent issued a
tool call naming one of that unit's files within the next 3 turns. Keeping a file-based
label while sweeping the signal to content words is deliberate — in the `lex` arm the signal
and the label share no vocabulary at all, which makes it the least circular of the four.

### The signal

For unit features `F` and hot-window features `Q`, over history strictly older than the
hot window:

> score(u) = max over f in F\Q, g in Q\F of phi(f, g), shrunk toward zero when the pair has
> little co-activation history

The set subtraction is the experiment. Features the unit **shares** with the hot window are
removed from both sides, so a unit scores only through the historical association of features
it has and the window does not, with features the window has and it does not. Present overlap —
which *is* relevance — cannot contribute. A sensitivity arm, `tcov-inclusive`, puts the
shared features back; if only that version worked, the working part would be relevance.

### Feature spaces, and the two gates

Every space must clear **support** (enough candidates have any co-activation history at all —
the starvation guard) and **flatness** (the score is not near-constant across units — the
saturation guard). Both are reported before any contrast.

| feature space | features/turn | support (same-turn) | gate | distinct scores/turn | at ceiling | near-flat turns | gate | verdict |
|---|---|---|---|---|---|---|---|---|
| `files` | 1.02 | 6.1% | **fail** | 8.09 | 2.9% | 24.0% | pass | not interpretable |
| `fp` | 9.07 | 84.3% | pass | 68.05 | 2.0% | 0.5% | pass | **interpretable** |
| `fp-nopath` | 5.76 | 64.0% | pass | 56.29 | 1.7% | 1.9% | pass | **interpretable** |
| `lex` | 20.15 | 86.1% | pass | 71.23 | 1.7% | 0.0% | pass | **interpretable** |

<svg viewBox="0 0 720 260" role="img" aria-label="Support share by feature space against the gate" style="max-width:100%;height:auto"><line x1="356.7" y1="38" x2="356.7" y2="214" stroke="#c0392b" stroke-width="2" stroke-dasharray="6 4"/><text x="356.7" y="34" font-size="11" fill="#c0392b" text-anchor="middle">support gate 55%</text><rect x="96" y="58.0" width="28.8" height="18" fill="#b9525a"/><text x="86" y="71.0" font-size="11.5" fill="#3a3a48" text-anchor="end">files</text><text x="132.8" y="71.0" font-size="11" fill="#4a4a58">6.1% · 1.02 feat/turn · FAIL</text><rect x="96" y="100.0" width="399.7" height="18" fill="#2c6fbb"/><text x="86" y="113.0" font-size="11.5" fill="#3a3a48" text-anchor="end">fp</text><text x="503.7" y="113.0" font-size="11" fill="#4a4a58">84.3% · 9.07 feat/turn · PASS</text><rect x="96" y="142.0" width="303.4" height="18" fill="#2c6fbb"/><text x="86" y="155.0" font-size="11.5" fill="#3a3a48" text-anchor="end">fp-nopath</text><text x="407.4" y="155.0" font-size="11" fill="#4a4a58">64.0% · 5.76 feat/turn · PASS</text><rect x="96" y="184.0" width="408.3" height="18" fill="#2c6fbb"/><text x="86" y="197.0" font-size="11.5" fill="#3a3a48" text-anchor="end">lex</text><text x="512.3" y="197.0" font-size="11" fill="#4a4a58">86.1% · 20.15 feat/turn · PASS</text><text x="96" y="24" font-size="13.5" font-weight="600" fill="#2b2b38">Support: share of candidates whose pairing with the current turn has co-activation history</text></svg>

`files` fails exactly as the previous report found, which is the check that this experiment
has not quietly changed the thing that failed. The other three pass both gates comfortably:
they are dense enough to have history and varied enough not to be inert.

### How the error bars are computed

Moving-block bootstrap over blocks of 10 consecutive decisions, resampled within a
transcript and never across two, because consecutive decisions share candidates and a label
window. Contrast families are Holm-corrected with one pre-specified primary.

---

## Results

### The dormancy gradient — the main finding

`D` is the threshold that defines "dormant": a unit counts only if its files have not been
touched for more than D turns. It re-labels rows without touching any score, so the whole
sweep comes from one pass. Identifier space:

| D | needed rows | tcov | relevance | recency | idle | random | best signal | tcov − random |
|---|---|---|---|---|---|---|---|---|
| 10 | 2,553 | **0.365** | 0.3134 | 0.403 | 0.2764 | 0.2636 | recency-only | +0.1015 [+0.0595, +0.1390] ★ |
| 15 | 2,155 | **0.3394** | 0.2826 | 0.3467 | 0.1974 | 0.2489 | recency-only | +0.0905 [+0.0507, +0.1333] ★ |
| 20 | 1,780 | **0.3184** | 0.2804 | 0.2649 | 0.12 | 0.2383 | tcov | +0.0801 [+0.0364, +0.1309] ★ |
| 25 | 1,534 | **0.3128** | 0.2655 | 0.2118 | 0.0898 | 0.234 | tcov | +0.0788 [+0.0230, +0.1293] ★ |
| 35 | 1,261 | **0.3133** | 0.2549 | 0.111 | 0.0094 | 0.2071 | tcov | +0.1063 [+0.0337, +0.1656] ★ |
| 50 | 871 | **0.3022** | 0.2264 | 0.0138 | 0 | 0.1858 | tcov | +0.1164 [+0.0265, +0.2021] ★ |

<svg viewBox="0 0 720 330" role="img" aria-label="Recall against dormancy threshold by signal" style="max-width:100%;height:auto"><line x1="62" y1="278.0" x2="602" y2="278.0" stroke="#e3e3ea" stroke-width="1"/><text x="54" y="282.0" font-size="11" fill="#6a6a78" text-anchor="end">0.0</text><line x1="62" y1="226.4" x2="602" y2="226.4" stroke="#e3e3ea" stroke-width="1"/><text x="54" y="230.4" font-size="11" fill="#6a6a78" text-anchor="end">0.1</text><line x1="62" y1="174.9" x2="602" y2="174.9" stroke="#e3e3ea" stroke-width="1"/><text x="54" y="178.9" font-size="11" fill="#6a6a78" text-anchor="end">0.2</text><line x1="62" y1="123.3" x2="602" y2="123.3" stroke="#e3e3ea" stroke-width="1"/><text x="54" y="127.3" font-size="11" fill="#6a6a78" text-anchor="end">0.3</text><line x1="62" y1="71.8" x2="602" y2="71.8" stroke="#e3e3ea" stroke-width="1"/><text x="54" y="75.8" font-size="11" fill="#6a6a78" text-anchor="end">0.4</text><polyline points="62.0,89.8 129.5,103.0 197.0,113.8 264.5,116.7 399.5,116.5 602.0,122.2" fill="none" stroke="#2c6fbb" stroke-width="3"/><circle cx="62.0" cy="89.8" r="3" fill="#2c6fbb"/><circle cx="129.5" cy="103.0" r="3" fill="#2c6fbb"/><circle cx="197.0" cy="113.8" r="3" fill="#2c6fbb"/><circle cx="264.5" cy="116.7" r="3" fill="#2c6fbb"/><circle cx="399.5" cy="116.5" r="3" fill="#2c6fbb"/><circle cx="602.0" cy="122.2" r="3" fill="#2c6fbb"/><text x="608.0" y="126.2" font-size="10.5" fill="#2c6fbb">tcov</text><polyline points="62.0,116.4 129.5,132.3 197.0,133.4 264.5,141.1 399.5,146.6 602.0,161.3" fill="none" stroke="#e08a1e" stroke-width="2"/><circle cx="62.0" cy="116.4" r="3" fill="#e08a1e"/><circle cx="129.5" cy="132.3" r="3" fill="#e08a1e"/><circle cx="197.0" cy="133.4" r="3" fill="#e08a1e"/><circle cx="264.5" cy="141.1" r="3" fill="#e08a1e"/><circle cx="399.5" cy="146.6" r="3" fill="#e08a1e"/><circle cx="602.0" cy="161.3" r="3" fill="#e08a1e"/><text x="608.0" y="165.3" font-size="10.5" fill="#e08a1e">relevance</text><polyline points="62.0,70.2 129.5,99.3 197.0,141.4 264.5,168.8 399.5,220.8 602.0,270.9" fill="none" stroke="#c0392b" stroke-width="2"/><circle cx="62.0" cy="70.2" r="3" fill="#c0392b"/><circle cx="129.5" cy="99.3" r="3" fill="#c0392b"/><circle cx="197.0" cy="141.4" r="3" fill="#c0392b"/><circle cx="264.5" cy="168.8" r="3" fill="#c0392b"/><circle cx="399.5" cy="220.8" r="3" fill="#c0392b"/><circle cx="602.0" cy="270.9" r="3" fill="#c0392b"/><text x="608.0" y="274.9" font-size="10.5" fill="#c0392b">recency-only</text><polyline points="62.0,135.5 129.5,176.2 197.0,216.1 264.5,231.7 399.5,273.2 602.0,278.0" fill="none" stroke="#8e44ad" stroke-width="2"/><circle cx="62.0" cy="135.5" r="3" fill="#8e44ad"/><circle cx="129.5" cy="176.2" r="3" fill="#8e44ad"/><circle cx="197.0" cy="216.1" r="3" fill="#8e44ad"/><circle cx="264.5" cy="231.7" r="3" fill="#8e44ad"/><circle cx="399.5" cy="273.2" r="3" fill="#8e44ad"/><circle cx="602.0" cy="278.0" r="3" fill="#8e44ad"/><text x="608.0" y="282.0" font-size="10.5" fill="#8e44ad">idle-only</text><polyline points="62.0,142.1 129.5,149.7 197.0,155.1 264.5,157.4 399.5,171.2 602.0,182.2" fill="none" stroke="#8a8a98" stroke-width="1.5" stroke-dasharray="5 3"/><circle cx="62.0" cy="142.1" r="3" fill="#8a8a98"/><circle cx="129.5" cy="149.7" r="3" fill="#8a8a98"/><circle cx="197.0" cy="155.1" r="3" fill="#8a8a98"/><circle cx="264.5" cy="157.4" r="3" fill="#8a8a98"/><circle cx="399.5" cy="171.2" r="3" fill="#8a8a98"/><circle cx="602.0" cy="182.2" r="3" fill="#8a8a98"/><text x="608.0" y="186.2" font-size="10.5" fill="#8a8a98">random</text><text x="62.0" y="294" font-size="11" fill="#6a6a78" text-anchor="middle">10</text><text x="129.5" y="294" font-size="11" fill="#6a6a78" text-anchor="middle">15</text><text x="197.0" y="294" font-size="11" fill="#6a6a78" text-anchor="middle">20</text><text x="264.5" y="294" font-size="11" fill="#6a6a78" text-anchor="middle">25</text><text x="399.5" y="294" font-size="11" fill="#6a6a78" text-anchor="middle">35</text><text x="602.0" y="294" font-size="11" fill="#6a6a78" text-anchor="middle">50</text><text x="332.0" y="318" font-size="11.5" fill="#4a4a58" text-anchor="middle">dormancy threshold D (turns since the unit's files were last touched)</text><text x="62" y="24" font-size="13.5" font-weight="600" fill="#2b2b38">Keep-needed recall on dormant units, as "dormant" is made stricter (fp, M=32)</text></svg>

Read across the table rather than down a column. At D=10 — barely dormant — positional
recency is the best keeper, at 0.403. By D=50 it has fallen to
0.0138 and reference-recency to 0: the two
incumbent signals are near-useless on units that have genuinely gone quiet, which is precisely
what the earlier finding about relevance describes and what the shipped scorer's protective
terms are supposed to cover. **Covariance barely moves**, 0.365 to
0.3022, and takes the lead from D=20 onward.

That the D=10 subset is *won by positional recency* is itself informative: at that
threshold the subset is not isolating deep dormancy at all. D=10 was inherited from an
experiment whose "turn" was a different and shorter unit, and this is the first time it has
been swept.

### Against the random floor

The floor control is volume-matched — same budget, same candidates, random order.

| feature space | tcov − random at D=10, M=32 | interval | |
|---|---|---|---|
| `fp` | +0.1015 | [+0.0568, +0.1407] | **excludes 0** |
| `fp-nopath` | +0.0844 | [+0.0474, +0.1293] | **excludes 0** |
| `lex` | +0.0354 | [-0.0163, +0.0737] | contains 0 |

<svg viewBox="0 0 720 300" role="img" aria-label="Covariance advantage over random by dormancy and feature space" style="max-width:100%;height:auto"><line x1="62" y1="174.2" x2="610" y2="174.2" stroke="#2b2b38" stroke-width="1.5"/><text x="616.0" y="178.2" font-size="10.5" fill="#2b2b38">no better than random</text><line x1="55.0" y1="136.5" x2="55.0" y2="86.0" stroke="#2c6fbb" stroke-width="1.6"/><circle cx="55.0" cy="109.8" r="3.6" fill="#2c6fbb" stroke="#2c6fbb" stroke-width="1.6"/><line x1="123.5" y1="142.1" x2="123.5" y2="89.6" stroke="#2c6fbb" stroke-width="1.6"/><circle cx="123.5" cy="116.8" r="3.6" fill="#2c6fbb" stroke="#2c6fbb" stroke-width="1.6"/><line x1="192.0" y1="151.1" x2="192.0" y2="91.2" stroke="#2c6fbb" stroke-width="1.6"/><circle cx="192.0" cy="123.4" r="3.6" fill="#2c6fbb" stroke="#2c6fbb" stroke-width="1.6"/><line x1="260.5" y1="159.6" x2="260.5" y2="92.2" stroke="#2c6fbb" stroke-width="1.6"/><circle cx="260.5" cy="124.2" r="3.6" fill="#2c6fbb" stroke="#2c6fbb" stroke-width="1.6"/><line x1="397.5" y1="152.8" x2="397.5" y2="69.2" stroke="#2c6fbb" stroke-width="1.6"/><circle cx="397.5" cy="106.8" r="3.6" fill="#2c6fbb" stroke="#2c6fbb" stroke-width="1.6"/><line x1="603.0" y1="157.4" x2="603.0" y2="46.0" stroke="#2c6fbb" stroke-width="1.6"/><circle cx="603.0" cy="100.4" r="3.6" fill="#2c6fbb" stroke="#2c6fbb" stroke-width="1.6"/><text x="616.0" y="60.0" font-size="11" fill="#2c6fbb">fp</text><line x1="62.0" y1="142.8" x2="62.0" y2="91.2" stroke="#1a8f6a" stroke-width="1.6"/><circle cx="62.0" cy="120.7" r="3.6" fill="#1a8f6a" stroke="#1a8f6a" stroke-width="1.6"/><line x1="130.5" y1="149.0" x2="130.5" y2="90.0" stroke="#1a8f6a" stroke-width="1.6"/><circle cx="130.5" cy="124.1" r="3.6" fill="#1a8f6a" stroke="#1a8f6a" stroke-width="1.6"/><line x1="199.0" y1="168.8" x2="199.0" y2="98.5" stroke="#1a8f6a" stroke-width="1.6"/><circle cx="199.0" cy="138.4" r="3.6" fill="#1a8f6a" stroke="#1a8f6a" stroke-width="1.6"/><line x1="267.5" y1="167.9" x2="267.5" y2="99.0" stroke="#1a8f6a" stroke-width="1.6"/><circle cx="267.5" cy="136.2" r="3.6" fill="#1a8f6a" stroke="#1a8f6a" stroke-width="1.6"/><line x1="404.5" y1="163.7" x2="404.5" y2="85.1" stroke="#1a8f6a" stroke-width="1.6"/><circle cx="404.5" cy="126.1" r="3.6" fill="#1a8f6a" stroke="#1a8f6a" stroke-width="1.6"/><line x1="610.0" y1="211.7" x2="610.0" y2="134.3" stroke="#1a8f6a" stroke-width="1.6"/><circle cx="610.0" cy="170.9" r="3.6" fill="#fff" stroke="#1a8f6a" stroke-width="1.6"/><text x="616.0" y="75.0" font-size="11" fill="#1a8f6a">fp-nopath</text><line x1="69.0" y1="182.5" x2="69.0" y2="131.1" stroke="#e08a1e" stroke-width="1.6"/><circle cx="69.0" cy="151.8" r="3.6" fill="#fff" stroke="#e08a1e" stroke-width="1.6"/><line x1="137.5" y1="184.2" x2="137.5" y2="130.3" stroke="#e08a1e" stroke-width="1.6"/><circle cx="137.5" cy="154.7" r="3.6" fill="#fff" stroke="#e08a1e" stroke-width="1.6"/><line x1="206.0" y1="191.3" x2="206.0" y2="128.0" stroke="#e08a1e" stroke-width="1.6"/><circle cx="206.0" cy="160.3" r="3.6" fill="#fff" stroke="#e08a1e" stroke-width="1.6"/><line x1="274.5" y1="199.5" x2="274.5" y2="137.0" stroke="#e08a1e" stroke-width="1.6"/><circle cx="274.5" cy="165.4" r="3.6" fill="#fff" stroke="#e08a1e" stroke-width="1.6"/><line x1="411.5" y1="205.1" x2="411.5" y2="138.0" stroke="#e08a1e" stroke-width="1.6"/><circle cx="411.5" cy="166.7" r="3.6" fill="#fff" stroke="#e08a1e" stroke-width="1.6"/><line x1="617.0" y1="248.0" x2="617.0" y2="162.4" stroke="#e08a1e" stroke-width="1.6"/><circle cx="617.0" cy="176.1" r="3.6" fill="#fff" stroke="#e08a1e" stroke-width="1.6"/><text x="616.0" y="90.0" font-size="11" fill="#e08a1e">lex</text><text x="62.0" y="264" font-size="11" fill="#6a6a78" text-anchor="middle">10</text><text x="130.5" y="264" font-size="11" fill="#6a6a78" text-anchor="middle">15</text><text x="199.0" y="264" font-size="11" fill="#6a6a78" text-anchor="middle">20</text><text x="267.5" y="264" font-size="11" fill="#6a6a78" text-anchor="middle">25</text><text x="404.5" y="264" font-size="11" fill="#6a6a78" text-anchor="middle">35</text><text x="610.0" y="264" font-size="11" fill="#6a6a78" text-anchor="middle">50</text><text x="336.0" y="288" font-size="11.5" fill="#4a4a58" text-anchor="middle">dormancy threshold D  ·  filled = interval excludes zero</text><text x="62" y="24" font-size="13.5" font-weight="600" fill="#2b2b38">Covariance minus the random floor (recall on dormant units, M=32)</text></svg>

In both identifier spaces covariance is clear of the floor at every dormancy depth up to
35. In the lexical space it never separates from it.

### The pre-registered primary — and why it is the weaker test

The primary was: covariance beats **relevance** on the dormant subset at M=32,
D=10, interval excluding zero.

| feature space | tcov − relevance | interval | | Holm p | Spearman(tcov, relevance) |
|---|---|---|---|---|---|
| `fp` | +0.0517 | [-0.0042, +0.1085] | contains 0 | 0.63 | 0.0231 |
| `fp-nopath` | +0.0357 | [-0.0105, +0.0825] | contains 0 | 0.58 | -0.001 |
| `lex` | +0.0638 | [+0.0133, +0.1001] | **excludes 0** | 0.05 | 0.1184 |

It fires in `lex` and misses in `fp` by a lower bound of -0.0042.
But `lex` is the space where covariance does not beat random, so its win over relevance there
reflects relevance being *worse than random* on dormant units rather than covariance being
good. **The pre-registration named the relabelling control and omitted the floor control**, and
the floor contrast turns out to be the more informative of the two. That hole was written into
the design document before the run and is restated here rather than discovered afterwards.

### The relabelling control, and the path-token control

Two ways this result could be an illusion, both tested.

**Is it relevance renamed?** No. The rank correlation between the two policy orderings is
0.0231 in `fp`, -0.001 in
`fp-nopath` and 0.1184 in `lex` — against a pre-registered
relabelling threshold of 0.8. They are close to orthogonal. The sensitivity
arm agrees: putting the shared features back makes the signal **worse**, not better.

| feature space | tcov-inclusive − tcov | interval | |
|---|---|---|---|
| `fp` | -0.0417 | [-0.1041, +0.0042] | contains 0 |
| `fp-nopath` | -0.0036 | [-0.0522, +0.0314] | contains 0 |
| `lex` | -0.0485 | [-0.0820, -0.0063] | **excludes 0** |

**Is it just file paths predicting file references?** The label is a file reference and the
`fp` feature set contains paths, so the signal could be exploiting the label's own
vocabulary. Stripping every path-bearing token leaves `fp-nopath` — camelCase, PascalCase,
UPPER_SNAKE and back-quoted symbols only, 5.76 features per turn —
and the advantage over random survives at
+0.0844 [+0.0495, +0.1309].
Whatever is carrying the signal, it is not path-to-path matching.

### Overall ranking, for context

Covariance is a *specialist*. On the full label it is far behind the incumbents; its value is
concentrated where they fail.

| signal | AUC | recall@32 (all) | recall@32 (dormant, D=10) |
|---|---|---|---|
| `tcov` | 0.6041 [+0.5871, +0.6218] | 0.3283 | 0.365 |
| `tcov-inclusive` | 0.7479 [+0.7270, +0.7722] | 0.5641 | 0.3234 |
| `relevance` | 0.8219 [+0.7957, +0.8422] | 0.722 | 0.3134 |
| `recency-only` | 0.7942 [+0.7633, +0.8159] | 0.6826 | 0.403 |
| `idle-only` | 0.8859 [+0.8683, +0.9030] | 0.8039 | 0.2764 |
| `random` | 0.4934 [+0.4862, +0.5035] | 0.2797 | 0.2636 |

---

## What we got wrong

**"A pairwise co-reference signal is starved on agent transcripts."** That was the conclusion
of the previous report in this series, and it was over-general. What was measured — that
80.1% of file-referencing turns name exactly one file,
so two specific *files* are rarely active together — is correct and retires file-keyed pairwise
signals cheaply. But the inference from "files are sparse" to "covariance is starved" skipped
the step where the feature space is a free choice. On the same four transcripts, keyed on
identifiers, support goes from 6.1% to
84.3% and both gates pass.

The failure mode is worth naming because it is the same shape as two of the five errors the
previous report already lists: a measurement was correct and the conclusion drawn from it was
broader than the measurement licensed. The corrective is structural rather than a matter of
care — the feature space should have been a swept variable from the start, as it is here.

---

## Conclusions

### What survives

**Covariance holds where the incumbents collapse.** Across a 5× widening of the dormancy
threshold, positional recency loses
97%
of its recall and reference-recency essentially all of it, while covariance loses
17%. The
mechanism the shipped scorer's relevance weight encodes — that similarity-based rules fail on
dormant units — is visible directly in this table, and covariance is the first signal tested
here that does not share the failure.

**It is not the signal that already lost.** Rank correlation with relevance is near zero in
every space; removing the shared-feature exclusion makes it worse; and it survives deleting
the token class that shares vocabulary with the label.

**It is a specialist, not a replacement.** On the full label covariance is well behind recency
and reference-recency. Any deployment would be as an additional protective term for dormant
units, not as a primary ordering — which is also the only role the evidence supports.

**And a methodological point.** The dormancy threshold that defines the "hard case" had been
inherited unexamined across three experiments. Sweeping it changed which signal wins at four
of the six values tested. A parameter that reorders the conclusion is not a detail.

### What this licenses, and what it does not

**Established.** Keyed on identifiers rather than file paths, a history-based co-activation
signal is computable on these transcripts (support 84.3% against a
55% gate), is not relevance under another name (rank correlation
0.0231 against a 0.8 bar), and keeps dormant units
better than a volume-matched random ordering in both identifier spaces — at D=10
+0.1015 in `fp` and survives the removal of every
path-bearing token.

**Licensed for the design.** Contextual covariance is worth carrying forward as a candidate
*protective term for dormant units*, alongside the existing four signals, and worth a direct
offline test in that role. The dormancy threshold D must be treated as a swept parameter in
every future eviction analysis rather than inherited at 10.

**Not licensed.** This does not license shipping covariance, re-weighting relevance, or
replacing any incumbent signal. The claims have different standing:

| claim | status |
|---|---|
| file-keyed covariance is computable on these transcripts | **tested and rejected** (support 6.1%, gate failed) |
| identifier-keyed covariance beats the random floor on dormant units | **tested, supported** in `fp` and `fp-nopath`; not in `lex` |
| covariance beats relevance at M=32, D=10 (pre-registered primary) | **tested, not met** in `fp` (+0.0517 [-0.0042, +0.1085]); met only in `lex`, where the floor contrast fails |
| covariance is a better keeper than recency on deep dormancy | **observed post hoc** from the D sweep, not pre-registered |
| covariance improves the four-signal scorer as an added term | **untested** |
| covariance helps admission (pulling material back in) | **untested** |
| any of this changes task success for a live agent | **untested** — no live arm was run |

---

## Caveats

- **The pre-registered primary does not cleanly fire.** It fires only in the feature space
  where the signal does not beat random. The result rests on the floor contrast and the
  dormancy gradient, both of which were secondary as written.
- **One corpus, one repository, one author**, four transcripts, and the largest supplies most
  decisions. Nothing here is between-problem evidence.
- **The label is observational.** A unit can be *used* without being named again; the model
  reasons from what it already read. Every signal is biased the same way, which protects the
  comparisons but not the absolute rates.
- **Turn-denominated parameters remain unrescaled** — the hot window K=5, the horizon
  H=3 — inherited from an experiment measured on a ~2.2× different clock. D was swept
  here precisely because it was the one doing the most damage; K and H have not been.
- **Feature selection is capped** at 24 features per turn, rarest-first, with
  features on more than 50% of turns dropped. Phi already scores near-universal
  features zero, so the drop is close to lossless, but the lexical arm is capped hardest — it
  retains 20.15 features per turn and
  1,128 of its turns hit the cap, against
  76 for `fp` — and its null result should be read with
  that in mind: the cap may be removing exactly the reusable tokens.
- **This is an eviction endpoint.** The same scores read in reverse give an admission ranking,
  which is where relevance was said to belong. Admission is not measured and no claim about it
  follows.
- **No live arm.** The instrument-sensitivity gate that would say whether a live comparison on
  this substrate can detect any selection effect is itself unresolved.

---
*Generated by `experiments/covariance-eviction/report-contextual-covariance.mjs` from
`results-contextual-covariance-v1.json`, `results-contextual-covariance-nopath.json`, `results-h2-corpus-survey.json`. Charts are inline SVG; the HTML version is self-contained.*
