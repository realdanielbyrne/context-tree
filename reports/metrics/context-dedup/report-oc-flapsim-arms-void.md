# Anchor arms on opencode/flapsim — VOID (the intervention never fired)

*Aborted mid-run. Reported as void rather than as a null, because the treatment arm was a
silent no-op and the arms were identical by construction.*

Artifact: `results-oc-flapsim-arms-void.json` · Commit `5df9440bd367`
Host: opencode · Model: `local/unsloth/Qwen3.8-27B-GGUF` · Scenario: flapsim six-turn split (core/engine/tests/review/artifact/feature+docs)

## Abstract

An agent that needs a file it has already read will often read it again, appending a duplicate
that is then re-transmitted on every subsequent turn. The intervention under test intercepts such
a request and returns a short referential anchor instead of the bytes, on the hypothesis that this
cuts cumulative tokens and wall-clock to completion without harming task success. This run was to
compare four arms — no intervention, a bare anchor, an anchor plus retrieved chunks of the resident
copy, and a length-matched non-referential placebo — on a six-phase software build task executed in
a real agent host.

The run is **void**. Across 44 turns of real agent work in
10 started cells, the trigger produced 1 would-fire event
and **0 actual substitutions**. With nothing ever substituted, all four arms
executed identically, so any measured difference between them would have been nondeterminism alone.
The cause is a property of the substrate rather than a defect in the instrument, and it is the
finding worth keeping: an earlier version of this task asked for all six phases in one message, and
the agent re-read constantly but never completed the work; splitting it into six focused turns made
the agent complete the work correctly but removed its reason to re-consult anything. **Completability
and re-reference pull against each other on this substrate.** The experiment cannot measure an
intervention that never triggers, and no number from this run should be read as evidence about
anchoring in either direction.

## What you need to know to read the rest

| Term | Meaning |
| --- | --- |
| agent | An LLM driven in a loop by a host that gives it tools (read a file, write a file, run a shell command) and feeds tool results back into its context. |
| host | The program running that loop. Here: opencode, a third-party coding agent, used rather than an in-repo harness per decision D20. |
| context | Everything sent to the model on a turn: the system prompt, the whole prior conversation, and every tool result so far. It is re-sent in full every turn. |
| turn | One user message and the model's work in response to it, possibly many tool calls. |
| cell | One complete run of the task under one arm. Here 4 arms × 3 repeats = 12 cells planned. |
| arm | One experimental condition. The four are defined in the setup below. |
| the trigger | The rule deciding when the intervention applies: a tool is about to return content whose bytes are already present earlier in the context. |
| fire | The trigger applying and the tool result actually being replaced. A *would-fire* event is a detected opportunity that was then suppressed for a stated reason. |
| resident | Present in the context the model is being sent. Nothing is evicted in this experiment, so anything once appended stays. |
| prompt tokens | Cumulative count of input tokens across every turn. The hypothesis's primary cost measure, since a token not appended is never re-sent. |
| silent no-op | An arm whose treatment never actually applies, making it indistinguishable from the control while still appearing to be a distinct condition. |

## Why we ran this

An offline study (DV4) established that replacing resident bytes with an anchor is the one context
reduction operator that never rewrites the cached prefix, and therefore does not repay its savings
as cache writes. It also established that the opportunity is small — around 1.6% of cache-adjusted
cost on real transcripts — and rejected the cost claim on that evidence.

Two questions survived that rejection, both behavioural rather than economic: does an agent
*accept* an anchor instead of re-fetching, and is it the *reference* doing the work rather than the
mere withholding? Those need a model in the loop. This run was to answer them on a real host, on a
task long enough for re-reference to occur naturally.

## The experimental setup

**The task.** `flapsim`: build a headless, deterministic side-scroller engine from a written
specification. The agent is given ten specification documents and must write six Python modules
(`units`, `physics`, `world`, `collide`, `engine`, `flapsim`), a `unittest` suite, a
`REVIEW.md` citing real `file:line` findings in its own code, a deterministic output artifact
`replay.txt`, and `GETTING_STARTED.md` quoting real function signatures. It is graded out of 40
by a **held-out** reference implementation on `(seed, ticks, flaps)` cases the agent never sees,
sharing no case with the worked examples in its own specification.

**The substrate.** One problem, run 4 arms x 3 repeats, ONE problem — stopped early by the user. All cells on one local model through one
host; nothing crosses a provider or routing change.

**The arms.** `none` — no intervention. `anchor` — the tool result is replaced by a short
sentence naming the earlier copy. `anchor-topk` — replaced by that sentence plus the most relevant
chunks of the resident copy, ranked by BM25. `placebo` — replaced by neutral filler padded to the
anchor's exact length, carrying no reference, which isolates *referring* from *withholding*.

**Recorded per cell.** Task score and its five components, milestones reached, per-turn duration,
transcript, every would-fire event with its suppression reason, and whether any model response
stopped on a length limit.

**What this substrate cannot show.** It is one problem, so it cannot separate an effect from
between-problem variance. And as this run demonstrates, it cannot show anything at all unless the
trigger fires.

## Results

**Headline:** 1 would-fire event and **0 fires** across
44 turns in 10 cells.
0 of 10 cells saw any substitution.

| arm | cells started | cells reaching all 6 turns | turns | would-fire | **fires** | turns hitting the 7,200s ceiling | longest turn |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `none` | 3 | 2 | 13 | 0 | **0** | 0 | 5,168s |
| `anchor` | 2 | 1 | 11 | 0 | **0** | 0 | 6,213s |
| `anchor-topk` | 3 | 0 | 9 | 1 | **0** | 2 | 7,200s |
| `placebo` | 2 | 1 | 11 | 0 | **0** | 1 | 7,200s |

The single would-fire event was a re-read of `units.py` (878 characters) classified
`duplicate-unchanged` and judged truthful, then suppressed because the top-k substitution would
have been **larger than the content it replaced** — the degeneracy guard working as intended.

**Read behaviour in a completed cell:** 19 reads across 18 *distinct* files; exactly one file read
twice. The agent reads each file once and moves on.

**Turn timeouts:** 3 turns hit the 7,200-second
per-turn ceiling exactly, and they landed unevenly across arms (see table). Under the exclusion
policy pre-registered before any cell completed, uneven truncation forbids pooling, because an arm
whose turns run longer truncates more and dropping its truncated cells would leave only its faster
survivors.

**Length stops:** no model response in any cell with a readable transcript stopped on a length
limit, so the 32,000-token output ceiling seen in earlier work did not bind here.

## What we got wrong

- **"The model cannot do this task."** Withdrawn. An earlier single-message version of the task
  produced 141,497 characters of reasoning and zero files, and I concluded the task exceeded the
  model. It did not: the prompt asked for six phases at once. Split into six turns, the same model
  scored 29/40 with a perfect 12/12 on held-out correctness cases and 8/8 on byte-exact output.
- **"opencode hangs because of stale servers."** Withdrawn. The hangs were local-model slot
  exhaustion: the host serves four concurrent connections and opencode makes a model call during
  session init, so with every slot busy it blocks with no error. My "fix" of killing processes
  worked only because it was taking slots back — and it killed a parallel session's runs three
  times.
- **"My arms are safe from the shared account because my config lists the local provider first."**
  Withdrawn. Provider order is not the mechanism; titling follows the session's own provider. The
  conclusion was right and the reasoning was wrong.
- **Per-arm status reports.** Withdrawn. A glob of `…-anchor-*` also matched `anchor-topk`, so
  two status reports attributed the topk arm's figures to the anchor arm, including a ceiling-length
  turn.
- **Transcript token counts of zero.** Withdrawn. A captured-buffer export truncated a
  222,750-byte transcript to 146,176 bytes mid-string; the parse failed and every token count read
  zero, which looked like a run that used no tokens.

## Conclusions

**Established.** On this substrate, with the task split into six focused turns, the trigger does not
fire: 0 substitutions in 44 turns. The agent reads each
file once. An intervention that never applies cannot be measured, and the four arms are identical by
construction.

**The substrate finding, which is the useful part.** Completability and re-reference are in tension
here. The single-message version of this task re-read constantly and never finished; the six-turn
version finishes correctly and never re-reads. Any future attempt to measure a re-reference
intervention on this harness must show that its substrate produces re-reads *while* remaining
completable — and must demonstrate that before spending live compute, not after.

**Not established, and specifically not rejected.** Whether an agent accepts an anchor in place of
resident content, and whether the reference rather than the withholding does the work. These remain
untested. This run produced no evidence about them in either direction, and reporting it as a null
would be a category error.

## Caveats

- **One problem, not many.** Every cell ran the same scenario from identical seed files, so repeats
  vary only by model nondeterminism. The project's standing design rule is to sample problems, not
  seeds; this run does not.
- **One model**, one host, one endpoint.
- **Stopped early by choice.** 10 of 12 planned cells were started and
  4 reached all six turns. The decision to stop was made on the fire count,
  which was already zero, not on any outcome measure.
- **Underpowered even had it fired.** A parallel study measured within-problem trajectory spread of
  1.16×–2.90× with nothing varied. Against that noise, detecting the 5–14% token effect predicted
  offline would need roughly 73 repeats per arm, not 3.
- **Wall-clock is not comparable to a solo run.** Cells ran four-way concurrent on one GPU, which
  inflated per-turn latency several-fold.
