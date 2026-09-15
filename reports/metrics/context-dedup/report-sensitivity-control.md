# Does duplicated context hurt an AI coding agent?

*An experiment that failed at its intended purpose and found something else.*

---

## Abstract

An AI coding agent accumulates a transcript of everything it reads, writes and runs, and re-sends that
transcript to the model on every step. On a long task the transcript outgrows the model's input limit, so
some of it must be discarded. Which parts to discard is the central design question for context-management
middleware, and four successive experiments on this substrate have found **no difference** between candidate
discard rules. That is ambiguous: either the choice genuinely does not matter on this task, or the
measurement cannot detect it — in which case all four results are uninformative rather than negative.

We attempted to distinguish these with a positive control. Into the transcript of an agent building a small
Python accounting library from a written specification, we injected **byte-identical duplicates** of files
the agent had already read. A duplicate carries no information the transcript does not already hold, so a
discard rule that removes duplicates first should measurably outperform one that discards at random — if the
measurement can detect discard quality at all.

**The control failed, and informatively.** Rather than merely consuming space, the duplicates stopped the
agent working: in the random-discard condition it produced **zero source files in all 10 runs**,
never beginning the implementation. A comparison against a baseline that never attempts the task cannot
measure anything, so the planned test (0/10 versus 0/10,
p = 1.000) is void.

The failure identifies a different effect. **Duplicated transcript content degrades agent behaviour far
beyond the space it occupies.** Removing the size limit entirely — so nothing is ever discarded and space is
never scarce — does not rescue it: with no limit and no duplicates the agent passed, writing 16.5
files from 18,868 tokens of transcript; with no limit and duplicates present it failed,
writing **zero** files from 51,141 tokens — 2.7×
**more** transcript than the run that succeeded. Displacement is therefore excluded as the mechanism.

This is the third injection design to halt this agent, after unrelated files presented as its own reads and
the same files presented as user messages. The common factor is not the content but its provenance:
**transcript material the agent did not itself produce changes what the agent does.** Middleware that adds to
an agent's context — summaries, retrieved passages, file references — must be evaluated for behavioural
effect, not only for token cost. The original question, whether the measurement can detect discard quality,
remains open and requires a design in which arms hold equal quantities of non-duplicate content.

## What you need to know to read the rest

These terms are used throughout. Nothing else is assumed.

| Term | Meaning |
|---|---|
| **Agent** | An AI model given tools (read a file, write a file, run a command) and a goal, running in a loop until it decides it is done. |
| **Context** | Everything the model can see on a given step: the instructions, plus the full history of what it has read, written and run so far. It is re-sent in full on every step. |
| **Token** | The unit context is measured in — roughly ¾ of a word. All token counts here are estimates (characters ÷ 4) unless stated otherwise. |
| **Context limit** | The maximum context a model will accept. Real limits are large; here we impose a small artificial one so that overflow happens quickly and can be studied. |
| **Eviction** | Deleting older material from the context to stay under the limit. The subject of this whole line of work: *what* should be deleted? |
| **The task** | One fixed programming job, called `longbuild`: build a small accounting program in six stages. It is marked pass/fail by a hidden test suite the agent never sees, so it cannot game it. Every run in this report is the same task. |
| **Run** (a "cell") | One complete attempt at the task by the agent under one set of conditions. |
| **Arm** | One experimental condition. Every arm runs the same task; arms differ only in the rule being tested. |
| **Duplicate / "ballast"** | Material we deliberately inserted: a second, byte-identical copy of a file the agent had already read. It adds no information, so deleting it loses nothing. |
| **Useful tokens** | Context that is *not* a duplicate — the real, non-redundant material the agent had available. |
| **Duplicate share** | What fraction of the agent's context was duplicated material. |
| **Files written** | How many files the agent created or edited during a run. A run with zero is a run where the agent never began the actual work — the clearest sign it has gone off the rails. |

## Why we ran this

This project builds middleware that manages an AI agent's context: deciding what to keep, what to
summarise, and what to delete when the context gets too big. The central design question is **what to
delete**.

We have tested four different answers, and all four came back with no measurable difference:

| What we varied | Result |
|---|---|
| Which signal picks what to delete | no difference (p = 0.70) |
| Deleting by "last time this file was touched" vs "oldest first" | no difference (p = 1.000) |
| Where in the context a needed fact sits | no difference (180 out of 180 correct at every position) |
| How often deletion runs | no difference once you account for how much context was present |

The one thing that consistently predicts success is simply **how much context the agent has** — more is
better, strongly.

Four straight no-differences has two possible explanations, and they look identical from the outside:

1. On this task, it genuinely does not matter what you delete.
2. **Our measurement cannot detect the difference** — in which case all four results are meaningless
   rather than informative.

Explanation 2 would invalidate a substantial amount of work, so it has to be ruled out before we build
anything further on those results. This experiment was designed to rule it out.

## The experimental setup

### The task the agent performs

Every run is the same job, called `longbuild`. The agent is dropped into a workspace that already contains:

- **`README.md`** and **13 specification documents** under `spec/` (about 1,000–2,000 characters each,
  ~20,000 characters in total) describing a `ledger` toolkit: money arithmetic, parsing of transaction
  lines, business rules, reporting, a tagging extension, and a command-line interface.
- **Five empty Python stubs** the agent must fill in: `money.py`, `parsing.py`, `rules.py`, `report.py`,
  `cli.py`.
- **`test_ledger.py`**, a visible test suite (~12,000 characters) the agent can run at any time.

It is instructed to work through six stages in order — read a stage's specification, implement that stage's
module, run `python3 -m unittest test_ledger`, fix failures, then move on. It must also append a decision
note to `NOTES.md` after each stage and finally write `SUMMARY.md`. It has five tools: read a file, write a
file, edit a file, list files, and run a shell command. It runs until it declares itself done or hits a
60-step ceiling.

**"Files written" therefore means the Python modules and notes the agent produces.** It is the measure of
whether the agent is doing its job at all. A healthy run writes its first file at around step 9 and produces
14–17 files in total. A run with **zero** files written has read specifications and run commands but never
implemented anything.

**Passing** is decided by a *held-out* test suite, written into the workspace only after the agent stops and
exercising the same specified behaviour on different data. The agent never sees it, so it cannot pass by
special-casing the visible tests.

### Why this task and not something shorter

An agent with a shell can recover almost anything it loses — if a file's contents fall out of its
transcript, it simply reads the file again. The one thing no tool call can recover is **the transcript
itself**: its own earlier reasoning, tool calls and test output. Pressure on the transcript is therefore
inherently long-horizon, and has to be built up over many steps of real iterative work. That is what this
six-stage task manufactures; runs take 53–61 steps.

### The size limit

The model's real input limit is 262,144 tokens, far more than this task needs, so overflow would never occur
naturally. We impose an **artificial limit of 7,000 tokens** on the transcript. When it is exceeded, the
discard rule under test removes material until it fits. Two conditions (`uncapped-clean`, `uncapped-ballast`)
have **no** limit at all and never discard anything; they exist to separate "ran out of room" from other
explanations.

### How duplicates were injected

Every second step, two units of the transcript were duplicated: an existing file-read and its result were
copied verbatim, with a fresh identifier, and spliced back into the transcript just before the agent's most
recent step. The copy is byte-identical, so the *earlier* copy becomes redundant — its content is fully
present later in the transcript. That redundancy is what the `oracle` rule detects and removes.

Two properties were enforced deliberately: the source to duplicate is chosen **uniformly at random** among
resident reads, so redundant material is not concentrated at one end of the transcript where a simple
oldest-first rule would remove it for free; and copies are spliced **before** the newest step, so they never
displace the agent's own latest work from the protected recent window.

## The conditions compared

Five conditions were run. Every one is the same task, the same model and the same settings; they differ only
in the size limit and in which rule decides what to discard. A rule that discards duplicates first keeps more
real material inside the same limit, so it should do better — *if* the measurement can see such things.

| Arm | What it does | Runs | Passed | Never wrote a file | Useful tokens | Duplicate share | Files written |
|---|---|---|---|---|---|---|---|
| `uncapped-clean` | no size limit, no duplicates — the easiest possible condition | 2 | 2/2 | 0/2 | 10,227 | 0% | 16.5 |
| `clean` | size limit, no duplicates — what the limit alone costs | 10 | 7/10 | 0/10 | 5,453.5 | 0% | 14.5 |
| `oracle` | size limit + duplicates, deletes duplicates first | 10 | 0/10 | 0/10 | 4,245 | 27% | 7 |
| `random` | size limit + duplicates, deletes at random | 10 | 0/10 | 10/10 | 1,444.5 | 75% | 0 |
| `uncapped-ballast` | no size limit, duplicates — unlimited room, junk present | 1 | 0/1 | 1/1 | 2,235 | 92% | 0 |

`clean` and `uncapped-clean` contain no duplicates at all; they show what the agent does normally, with
and without a size limit.

## Why the planned comparison is void

The intended test was `oracle` versus `random`. Both scored 0 out of 10
(statistically: p = 1.000, meaning no detectable difference).

Read literally, that is the "our measurement is blind" outcome. **It should not be read that way**, for one
reason: in the `random` condition the agent wrote **zero files in 10 of 10 runs**.
Only 0 of 10 runs involved the agent attempting the task at all.

A comparison needs a baseline that is *doing the thing badly*, not one that has stopped doing the thing. If
the agent never starts, its failure tells you nothing about whether a better deletion rule would have
helped.

We had written two conditions in advance for deciding whether a result was trustworthy — that the
no-duplicates arm should not be at zero, and that the random arm should have room to improve. **Both were
satisfied.** The run was still worthless. A third condition has been added and is now checked
automatically: *the baseline must still be attempting the task.* The measurement that catches it — files
written — was already being recorded; we simply were not looking at it.

## The finding that replaced it

**Duplicated context damages the agent out of all proportion to the space it takes up.**

The clearest single comparison is `oracle` against `clean`:

- `oracle` had **4,245** useful tokens — 78% of what
  `clean` had (5,453.5).
- `clean` passed **7 of 10** times. `oracle` passed **0 of
  10**.
- `clean` wrote **14.5** files per run. `oracle` wrote **7**.

From everything else we have measured, an agent with that much real context should succeed roughly 40–50%
of the time. It succeeded 0% of the time. The difference is the
27% of its context that was duplicated material — and `oracle` was the arm actively
deleting duplicates, so it had the *least* of it among the duplicate conditions.

**The cause is behavioural, not a shortage of room.** The last two rows remove the size limit
entirely, so nothing is ever deleted and space is never scarce:

- `uncapped-clean`: no duplicates → **passed**, 16.5 files written, 18,868 tokens of context.
- `uncapped-ballast`: duplicates present → **failed**, 0 files written, 51,141 tokens of
  context — **2.7× more context than the run that passed.**

An agent with more room than it needs, which still never writes a file, has not run out of anything. The
duplicates changed what it did.

### Why this generalises beyond duplicates

This is the **third** attempt to add material to this agent's context, and the third to stop it working:

1. **Unrelated files, presented as reads the agent had performed.** The agent copied the pattern and spent
   60 of 61 steps reading those files. It wrote nothing.
2. **The same files, presented as a message from the user**, clearly labelled as irrelevant. The agent made
   51 tool calls and wrote nothing. (A successful run writes its first file at around step 9.)
3. **Byte-identical copies of the agent's own reading** — this experiment.

Three different kinds of content, three different ways of presenting it, same outcome. The common factor is
not what the material said. It is that **material the agent did not itself produce appeared in its
history**.

That matters directly for what this project builds. The middleware does not only delete context — it also
*adds* to it: summaries of earlier work, retrieved passages, references to files. Those additions are
content the agent did not put there. The safe assumption, on this evidence, is that such additions change
the agent's behaviour and must be tested for that, not just costed in tokens.

It also changes how deduplication should be viewed. An earlier analysis concluded that removing duplicate
content is not a way to save money — it is a way to fit more into a limited space. These results suggest a
third possibility: if duplicates actively degrade behaviour, removing them improves **capability**. That is
a hypothesis this run raises; it does not prove it, because no arm here held duplicates without also being
the arm meant to remove them.

## What this experiment could never have shown

Independent review of the design, carried out while the experiment was running, identified a flaw that
holds regardless of the outcome.

The `oracle` arm's advantage over `random` comes entirely through one channel: it ends up with **more
useful tokens** (4,245 against 1,444.5). But "more context is better" is exactly
the effect we already knew about and measured. So `oracle` beating `random` was guaranteed by an
established effect, and would not have demonstrated anything new about the measurement's sensitivity.

Meanwhile the four no-difference results we set out to check were all measured with *equal* amounts of
useful context in every arm. A control that only changes the amount cannot speak to them.

**So the original question remains open.** Answering it needs a design where the arms hold the *same
amount* of useful context but *different* content — a harder thing to build, and the reason this stays on
the open list rather than being marked resolved.

## Caveats

- **One task.** Every run is `longbuild`. This measures variation within one problem, not across
  problems, and between-problem variation is the larger effect in agentic coding.
- **One model**, one machine, one configuration.
- **We do not know the mechanism.** That duplicates change behaviour is what the data show. *Why* — whether
  the agent imitates the repeated reading, loses track of instructions, or something else — is untested.
- **The unlimited-room arm got a heavier dose of duplicates** than the limited arms
  (92% of its context versus 75%), because copies can themselves be
  copied and nothing was deleting them. This strengthens "extra room did not help" but prevents a precise
  dose comparison.
- **Pass/fail is all-or-nothing.** A run that nearly finished scores the same as one that never started;
  the "files written" column is included precisely because it distinguishes them.
- **Small numbers.** 10 runs per main arm, and only 1 for the unlimited-room duplicate arm — that one is a single decisive observation, not an estimate of a rate.
- **The unlimited-room duplicate run was interrupted** by the machine running out of memory before its
  results file was written. Its completed run was recovered from the run log by
  `recover-run-log.mjs`, which copies only the values the log actually printed and marks the file as
  recovered; nothing was reconstructed or estimated.

---
*Data: `results-sens-primary.json`, `results-sens-uncapped.json`, `results-sens-uncapped-clean.json`.
Code: `experiments/context-dedup/{sensitivity-control,ballast,stats}.mjs`, with 20 unit tests.
Charts in the HTML version of this report.*
