# The instrument was the experiment: a deleted harness, a mis-specified detector, and nothing yet measured about context policy

**Loop of 2026-09-08 → 2026-09-09.** Companion plan: [`reports/hypothesis-test-ladder.md`](../hypothesis-test-ladder.md).

## Abstract

`context-tree` reorganises an agent's linear conversation trace — prompts, replies, tool calls,
file edits — into a summary-headed tree, so a long-running session sees branch summaries instead of
raw history and pulls detail back on demand through four MCP tools. This loop set out to test
whether *attention over history* — evicting context that does not bear on the current turn — saves
tokens without costing task success. It tested none of it. Instead it found that the bespoke
evaluation harness carrying every prior measurement could not represent a tool call at all: its
`ChatMessage` type had no `tool_calls` field and no `'tool'` role, so the harness stripped the
model's own tool calls from its history and replayed results as user text. A 13-message request
carried **0** assistant messages with `tool_calls` and **0** `role: 'tool'` messages. Models shown
that transcript re-announce actions they have already taken; one run emitted 56,966 tokens of
repeated intent against 11 surviving tool calls. **Every arm comparison ever taken with that
harness is void.** The harness (~16,500 lines across two directories) was deleted rather than
repaired, because `context-tree` is an MCP adjunct and should not own an agent loop; evaluation now
means running tasks in an external host with and without the server attached. Three separate
guards — an instrument hash, a derived-ceiling requirement, and an epoch check — each caught the
author mid-error during the same loop. The loop closes with one measured result and a
21-test ladder in which 14 tests need no model calls at all: over **1,073 real agent sessions and
14,695 assistant turns**, the shipped sufficiency-signal detector fires on **3.2% of sessions and
0.245% of turns**, and one of its three patterns fires **zero times**. That measures a
mis-implementation rather than the hypothesis: the design specified "a small classifier over
assistant text" and what shipped was four regexes, which cannot work in principle because an LLM is
probabilistic and every model phrases sufficiency differently. The number's only value is that it
proves nothing downstream of that code could ever have fired. The principal limitation is that this loop still contains no live comparative measurement
of any context policy.

---

## 1. What this loop was supposed to do, and what it did

The queue at the start was explicit (`window-regime-and-retrieval-unit-report.md` §13): iterate on
`prefix-plus-retrieval`, the arm that scored **25/25** on the retrieval question set, by fixing its
two named defects — an excerpt window too narrow to contain one answer literal, and a missing
ledger of completed steps that left it **0/3** on a four-module task. Then the soft occupancy
target of §12, then the six hypotheses of §14.

None of that happened. Six live batches were launched and none produced a comparative result. The
sequence matters more than the count, because each failure was a different class:

| # | Cause | Class |
| --- | --- | --- |
| 1 | Rebuilt `eval/dist` while a batch was live; `readInstrument()` hashes it and aborted the run | self-inflicted; the guard was correct |
| 2 | `Request timed out` read as provider flakiness; retries raised to 3 | misdiagnosis |
| 3 | No request timeout was ever configured, so the SDK default of **10 minutes** applied; three attempts spent 30 minutes discovering a call would never answer. Setting 180s then **killed legitimate long writes** — a regression I introduced | symptom treated twice before the mechanism was measured |
| 4 | The real cause: `AGENT_MAX_TOKENS` is unset by design, so an uncapped reply on a task that asks the agent to write a whole pipeline runs past any timeout. Measured: **64 tokens → 1.6 s; 4,096 → 77.7 s; uncapped → still generating past 200 s** | measurable in one isolated probe |
| 5 | LHTB sets `continue_until_timeout` on 30 of its 46 tasks and this harness ignored it, exactly as the benchmark warns ("those tasks run single-shot there and score lower"). Observed: 6 turns, score 0/11, **15,726 of 1,552,615 tokens spent** | contract not read |
| 6 | The tool-call eviction below | invalidates everything upstream |

Two policy changes were made on inference before the mechanism was measured once, and the second
was a regression. A single isolated latency probe — minutes of work, a few thousand tokens — would
have skipped both.

## 2. The defect that voided the prior measurements

`packages/core/src/contracts/models.ts:9`, before deletion:

```ts
export interface ChatMessage {
  role: 'user' | 'assistant';   // no 'tool' role
  content: string;               // no tool_calls field
  cacheBreakpoint?: boolean;
}
```

The limitation reached the wire: `toMessageParam` emitted only `{role, content}`. So every arm
rendered an agent turn as assistant text with the tool calls **erased**, followed by the result as
a `role: 'user'` text blob:

```
assistant: "Let me check the audit.py file:"       <- its tool_calls, gone
user:      "[tool_result read_file]
            [call] {"name":"read_file","input":{...}}
            [output] <contents>"                    <- result as USER text
```

The model is shown a conversation in which assistants announce actions and never take them, and it
imitates the pattern. From the transcript, turns 5–7 of one run:

```
TURN 5  stop=stop        tools=[]           "Let me check the audit.py file:"
TURN 6  stop=tool_calls  tools=[]           (finish says tool_calls; array empty)
TURN 7  stop=tool_calls  tools=[read_file]  "Let me check what's in the audit.py file:"
```

Its turn-0 plan was correct and well structured. The 56,966 output tokens are **re-announcements of
an intent that never executed**, not verbosity, and 11 tool calls across 37 turns is the surviving
fraction rather than the model's rate.

**A claim of mine, corrected by measurement.** A 3-trial replay showing one response with
`finish_reason: tool_calls` and no payload was reported as "OpenRouter drops ~1 in 3 tool calls."
Twelve trials of the identical request:

| model | tool_calls delivered | dropped by provider | text-only reply |
| --- | ---: | ---: | ---: |
| `qwen/qwen3-coder-flash` | 5/12 | 1/12 (8%) | **6/12** |
| `z-ai/glm-5.3-flash` | **11/12** | 0 | 1/12 |
| `qwen/qwen3.8-flash` | 10/12 | 0 | 2/12 |

Provider dropping is real but minor. The dominant column is the last one: on identical input GLM
emits a tool call 11 times in 12 where coder-flash manages 5. The broken transcript degrades every
model and coder-flash is the most sensitive — which also retires a second claim of mine, that
coder-flash "does not drive an agent loop." It drives the same loop on the same malformed input.

**Why the earlier repair missed it.** An earlier pilot was disqualified for a transcript that
"omitted call IDs and arguments." The fix embedded that metadata **as JSON inside the user text**
(`tool-result-call-v1`). It made the text more faithful and left the structural eviction untouched
— symptom, not cause.

## 3. Deleting the harness

The operator's judgement, and it is the correct one: *"This product isn't trying to recreate a
coding harness anyway, it is supposed to be an adjunct add-on… This product is simple in its
design, and you are trying to make it more complicated."*

So the eviction is not a bug to fix. `ChatMessage` lacks a `tool_calls` field because the eval tree
was a half-built reimplementation of something mature harnesses already do correctly; fixing the
type would deepen the wrong thing. Recorded as **D20**, superseding D19.

Deleted: `eval/` (254 tracked files; 5,779 source + 4,374 test lines, 46 scripts) and
`eval-resumption/` (68 files, ~6,362 lines) — about **16,500 lines**, 340 files, 581k lines removed
in one commit.

Two couplings made naive deletion unsafe, and both were found before it:
- `packages/core/test/live/record.ts:58` reached into `eval-resumption/recorded/` for replay
  cassettes, so four product tests would have broken. Those moved into `packages/core/test/`.
- `packages/cli/src/commands/eval.ts` **shipped in the published CLI tarball** and dynamically
  imported `<cwd>/eval-resumption/harness/index.js`. It was a command that could only ever error,
  and it was the one place a published package referenced the harness. Removed.

A third exposure was live and unrelated to imports: `eval/package.json` had **no `private` field**,
a `bin` entry, and `files: ["dist"]`, so `pnpm publish -r` would have published
`@context-tree/eval` containing the harness. The deletion removes it; the verification gate is
`npm pack --dry-run --json` on each package, which reads what npm would actually publish rather
than trusting the declared `files`.

## 4. The one thing measured, and what it does not show

The one hypothesis this loop tested is **H4/HR3** — that the model's own statements pace its
discovery, so *"I have enough information to implement X"* and *"now let's look at Y"* can gate
retention. It had been recorded as firing **0 times in 19 real agent responses**, and that was read
as a null for the hypothesis.

It is a null for the **detector**. `detectAttentionSignals` is four literal regexes. Run — the
shipped function, which masks code fences, block quotes and quoted strings and filters negated
clauses, not hand-copied patterns — over **1,073 real Claude Code sessions, 14,695 assistant text
turns**:

| metric | value | baseline / comparison |
| --- | ---: | --- |
| sessions with any signal | **34 / 1,073 = 3.2%** | pre-registered retirement threshold: <10% |
| signals per assistant text turn | **0.245%** | — |
| `sufficiency` hits | 17 | — |
| `topic_shift` hits | 19 | — |
| `research_done` hits | **0** | in 14,695 turns; a dead pattern |
| broadened `Now let me` | **318 sessions = 29.6%**, 711 hits | **≈9× session coverage, ≈20× hits** |
| `Now I (understand\|have\|need to\|can)` | 117 sessions = 10.9%, 163 hits | — |

**Verdict: this measures a mis-implementation, not the hypothesis — and the remedy is not a bigger
lexicon.** At 0.245% of turns the shipped code cannot gate anything, so nothing downstream of it
could ever have worked. That is the whole value of the number. It is *not* evidence about H4/HR3.

The design already specified the right instrument
(`window-regime-and-retrieval-unit-report.md:655-659`):

> "Detect them (**a small classifier over assistant text is enough to start**; log the phrases
> first, zero live tokens, from the recorded runs) … detect topic shift the same way (**a turn whose
> content words share little with the previous n turns**)"

"Log the phrases first" was a preliminary look at the corpus. What shipped was four regexes — the
preliminary step mistaken for the detector. **A lexical matcher cannot work here in principle:** an
LLM is probabilistic, every model phrases sufficiency differently, and "I have what I need" is a
semantic state rather than a string. A regex list is a sample of one author's guesses at phrasing.

**My first reading of this result was wrong in the same direction.** I concluded "the lexicon is
too narrow — broaden it," and cited a candidate phrase reaching ≈9× the coverage. That is more of
the wrong approach; coverage of a wider guess-list is not detection. The operator's correction is
the right one: sufficiency needs **a model query or a small adjacent classifier** judging the
assistant's turn; topic shift needs the **content-word overlap** measure §14 already named, which
is deterministic and needs no model at all. The two sub-signals have different right instruments
and only one of them costs anything.

*Provenance.* A first pass reported 4.8% and 37.8% using hand-copied regexes over a slightly
different text extraction. The figures above come from the shipped function and are the ones to
quote; the two disagree by ≈1.4× while agreeing on the conclusion, which is precisely why the
shipped function is authoritative and why the standing rule is to re-read every number from its
artifact.

**What this does not show, and what replaces it.** Fire rate is not detection. The next test is
not a wider phrase list; it is the instrument the design named, split by sub-signal:
**topic shift** is deterministic — fingerprint overlap between turn *t* and turns *t−n…t−1*,
validated against a within-session permutation null, zero model calls; **sufficiency** needs
semantic judgment, so a small adjacent classifier or a cheap-model call per turn, with ground truth
from hand-labelled real turns rather than from phrases. Falsification for each is fixed in the
companion plan. `sufficiencyGate` and `topicShiftReset` are switches on a detector that does not
work; they should be **rewired to the new detector or deleted**, not tuned.

## 5. What else was learned, separately from what was decided

**The small-window failures were starvation, not tree failures.** Claude Fable 5.1's production
system prompt is **274,608 characters = 60,903 cl100k tokens**. At W=65,536 there is effectively no
room for anything else. Every prior batch at W=32k–65k measured starvation, and what was being
evicted was the system prompt, steering files, plan files and skills — the always-pinned category.
So two recorded negatives are artifacts: "tree loses to truncate-tail, 11/60 vs 2–4/60 at
W=32–65K", and the "16k dead cell, 57/60 stalls". **The valid realistic-host cell is W = 131,072.**
I was about to re-run a sweep across the starved range and treat those as real negatives to
confront.

**The recorded blockers conflated two questions.** Every one of H1–H6 and the priority channel was
marked `eligible: false, status: missing_labels`, needing e.g. "current-turn grounded irrelevance
labels" or "labeled true/false sufficiency and topic-shift examples". But labels are needed to
validate *whether a policy's judgment is correct* — not to measure *whether the policy helps*. The
hypotheses are the second question. The prior pass blocked itself validating an intermediate signal
before ever measuring an outcome.

**A corpus for the overflow regime existed and was never used.** The record listed "the overflow
regime itself — no trace in the repo has ever reached it" as an open item. Of 1,073 real local
sessions: **109 have ≥100 tool calls**, 55 exceed 131,072 estimated content tokens, 18 exceed
262,144, and 2 exceed 1,048,576 (max ≈4.38M estimated tokens across 788 tool calls). The shipped
`mapClaudeCodeTranscript` importer reads exactly that format. That open item is retired.

**Guards beat judgement, three times in one loop.** The instrument hash caught a concurrent
rebuild. A derived-ceiling requirement refused an invented token cap and forced one derived from a
measured run. An epoch check refused to reuse an output directory after scientific inputs changed.
Each was correct and each caught me. A harness that refuses to run is cheaper than a batch that
runs and cannot be believed.

**Measure the mechanism before changing the policy.** The recurring failure of this loop was
inference: a 180-second timeout derived from a single latency sample that was 2× optimistic
(GLM sustains 24.5 tok/s, not the 52.7 one probe showed, so a full reply needs 335 s and the
timeout killed it); an 8,192-token reply cap chosen as a round number when the reference solution's
largest file needs ~6,240 with the JSON envelope; a "malformed JSON" diagnosis that the probe
showed was a truncation at the end. Each isolated probe cost minutes.

**And the model I blamed was innocent.** I characterised a model as unable to drive an agent loop.
The transcript shows it planning correctly and re-issuing the same read three times because the
calls were vanishing. That characterisation was an inference about a model built to do exactly that
task, and the operator was right to reject it.

## 6. What the loop did NOT test

No live comparative measurement of any context policy. Specifically untested: the umbrella
attention-over-history hypothesis; all six of H1–H6; the 25–50% soft occupancy target; Zone B as an
index; `evictRederivable` and the priority channel (both have passing mechanism-fire gates and
**zero production callers**); whether the retrieval unit is wrong for structural turns; whether
keeping full retrieval payloads helps; and the score hypothesis — that a shorter, better-curated
context makes the model *reason* better, which no analysis in this loop could refute and none
tested. Every measurement here argued cost, latency or instrument integrity.

Also untested: anything on a model other than the cheap OpenRouter tier, anything at a window other
than 1M-class hosts, and Anthropic cache economics — where `cacheWrite` is billed at 1.25× input
and `cacheRead` at 0.1×, so a token-side result measured on a provider publishing `cacheWrite: 0`
is an upper bound, not a transferable number.

## 7. Open items and recommendations

Ordered by information gained per unit of cost. The full 21-test ladder, with a numeric
falsification condition fixed in advance for each, is in
[`reports/hypothesis-test-ladder.md`](../hypothesis-test-ladder.md) — **that document is the
executable next step and is written to be run cold.** Reiterating its head:

1. **Run Rung 0 — fourteen tests, zero model calls, no provider budget.** Everything they need
   survived: the 1,073-session corpus, the 56-query set (which carries its payload text inline, so
   it needs no store rebuild), and every offline primitive in `packages/core`. Highest first:
   **0a**, the excerpt-window sweep (`excerptChars` × anchor over the surviving queries) — this is
   hand-off item 1's first named defect and it produces a number in about an hour. It must report
   the count of queries with non-empty fingerprint terms, because the prior version of this sweep
   returned a degenerate null on 15 payloads that all had `terms: []`.
2. **Replace the H4/HR3 detector rather than widening it.** Build the two instruments the design
   named: deterministic content-word overlap for topic shift (no model calls), and a small
   classifier or cheap-model judgment for sufficiency, ground-truthed on hand-labelled real turns.
   §4's number licenses no live work — it only proves the shipped code cannot fire.
3. **Build the opencode plugin for Rungs 1–3, and gate it first.** Two facts read from the shipped
   1.18.27 binary decide whether it works at all: the `experimental.chat.messages.transform`
   trigger's **return value is discarded**, so only in-place array mutation is observable and
   `output.messages = [...]` silently no-ops — the S4 failure class through a new seam, and gate 0
   is a unit test proving a mutation reaches the provider call. Conversely, Zone A is assembled
   *after* the transform, so the system prompt, steering and skills are structurally **out of
   reach** — S2's failure mode cannot recur there. opencode's own compaction defaults to preserving
   `floor(context × 0.25)` and must be disabled and recorded, or a live arm measures opencode
   rather than the policy — and that 0.25 is a direct confound for the soft-target hypothesis.
4. **One variable per test.** Twelve mechanisms at once yields one number and no attribution. The
   combination is the destination, reached by knowing which parts carried an effect.
5. **Never at W = 32k–65k.** That range is a starvation cell; W = 131,072.
6. **Spend the long live runs last.** The score hypothesis needs ~4,000–6,000 model calls across
   ≥2 tasks at n≥5 and is the endpoint that can vindicate the programme. Its parameters come from
   the tests above, so running it early wastes it — and a null from a badly-set arm is weak
   evidence, not a refutation.

## 8. Methodology lessons worth carrying to other work

- **When a symptom recurs, measure the mechanism before changing the policy.** Two policy changes
  on inference, the second a regression, where one isolated probe would have found the cause.
- **A mechanism-can-fire gate must be fed the inputs the live path builds.** One gate reported an
  arm inert because the gate itself supplied no reference edges. An "inert" verdict is a claim
  about the gate until that is checked.
- **Read the gate's artifact, not only its pass bit**, and re-read every number from its raw source
  before quoting it. Two figures in this loop were wrong in the direction that flattered the
  conclusion.
- **A metric that cannot be true is worse than a missing one.** `gateRescued` was `false` in 0 of
  48 runs and structurally unreachable, because every arm returned at the very turn whose successor
  the metric inspects.
- **Distinguish "the instrument fired" from "the hypothesis is false."** The single result in this
  loop exists only because that distinction was drawn.
- **Do not detect a semantic state with a lexical matcher, and check the design before measuring
  the code.** The instrument here was four regexes where the design said "a small classifier"; the
  measurement therefore reported on a mis-implementation. Worse, the first reading of that
  measurement proposed *widening the regex list* — the same error one step larger. When an
  instrument fails, ask what it was specified to be before asking how to extend it.
