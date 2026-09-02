# Next steps queued for the closing report

The closing report of this DS-STAR pass must carry these. Recorded here as they
arise so the report is assembled from a list rather than from recollection.

## 1. The per-turn reply allowance needs its own DS-STAR round

**Status: implemented, unit-tested, never run live.** `replyAllowance` in
`packages/core/src/assemble/budgets.ts`, reported as
`BudgetReport.replyAllowance` on every assembled prompt.

**What it does.** Sets the provider's reply limit after assembly from what the
window has left, instead of reserving beforehand for a reply whose size cannot be
known. Arithmetic per turn, so no constant is chosen.

**The claim to test.** A small-window model iterates through a long session on
progressively shorter replies rather than failing at the point its prompt
outgrows a fixed ceiling. Corollary: sending the allowance makes the model
shorten its own answer instead of being truncated mid-sentence.

**Why it needs live measurement rather than more offline work.** Everything
offline can show is that the arithmetic is right. What is unknown is behavioural:
whether a model given a small allowance produces a usefully short answer or a
uselessly truncated one, whether answer quality degrades gracefully as the
allowance shrinks, and where the allowance becomes too small for the task — the
floor the function deliberately refuses to guess.

**Design sketch for the round.** Arms differing in one variable: no reply limit
(today's live default), a fixed ceiling (the removed behaviour, and the control
the existing corpus was measured under), and the per-turn allowance. Measure:
turns completed before failure, graded score, tokens, the allowance series per
turn, and how often a reply stops at the allowance rather than at the model's own
stopping point.

The mechanism only engages once the prompt approaches the window, and the
existing suite finishes in eight to eighteen turns, so it would never engage at
all. Two ways to get a long horizon, and they answer different questions:

*Seed from a frozen large-model transcript (do this first).* The transplant
substrate already is a long session: 754 events and roughly 196,000 tokens of a
real one, frozen with its hashes, already used for the cross-model work. Instead
of the twelve isolated question runs it drives today, walk forward through the
trace — assemble the prompt as it stood at each point, compute the allowance, and
ask a live question at intervals. That produces the whole allowance curve against
a genuinely long horizon on a small-window model, repeatably, at a small fraction
of a live long run, and every arm sees byte-identical inputs so the comparison is
same-epoch by construction rather than by scheduling.

*Its limitation, which matters.* A frozen replay breaks the feedback loop. The
allowance changes what the model says, what it says changes the trace, and the
trace changes the next prompt. A replay holds the trace fixed, so it can measure
answer quality at each allowance level and the shape of the curve, but it cannot
show whether shrinking allowances change the session's trajectory — whether a
model answering briefly takes more turns, or takes different actions, or fails to
finish work it would otherwise have finished.

*A genuinely long live run (the confirmation).* Real trajectory, at the price of
being slow, expensive, and unrepeatable, since each run diverges. Worth paying
for only once the replay has shown the curve is worth confirming, and scoped to
whichever allowance regime the replay says is interesting rather than sweeping
blind.

**Pre-register:** the failure that would refute it is a run where shrinking
allowances produce truncated-but-scored answers, because that trades a loud
failure for a silent one — the opposite of what the change is for.

**Sequencing:** replay first, because it is cheap and repeatable and settles the
quality-versus-allowance question; live long run second and only if the replay
says there is something to confirm. Do not run them in the other order.
