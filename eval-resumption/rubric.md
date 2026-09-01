# Resumption rubric (plan §15)

The judge grades one run: a fresh agent, a recorded session it never saw, and
the answer it produced. Score each criterion **0–5** using the anchors below and
nothing else.

**Read this before scoring.**

- **The judge does not set the success rate.** §15's success rate is the script
  checker's number. You are the second opinion on the things an assertion cannot
  see, and your scores are reported beside the checker's, never instead of it.
- **Grade the answer against the recorded session and the golden file states you
  were given** — not against what you would have done. An answer that is right
  about this session is right even when it is terser than you would like.
- **Do not reward style.** Length, headings, confidence, apologies and hedging
  are all invisible here. Two answers stating the same facts score the same.
- **Missing context is not the agent's fault, but bluffing about it is.** An
  answer that says "the summary does not say which table, and I did not retrieve
  it" is more accurate than one that guesses and sounds certain, and scores
  higher on `state-recovery` even though it names less.

Anchors are written so two judges land on the same number: score the highest
anchor the answer fully satisfies, and never average across anchors.

---

### task-success (weight: 2)

Did the answer do what the prompt asked?

- **5** — Does everything the prompt asked, with the specific values, names and
  next steps it called for. Nothing asked for is missing.
- **4** — Does what was asked; one secondary part is thin (e.g. states the fix
  but not what is left to do).
- **3** — Addresses the right problem and gets the main answer right, but leaves
  out a part the prompt explicitly asked for.
- **2** — Engages the right area of the session but does not answer the question
  asked (describes the bug when asked for the fix, or vice versa).
- **1** — Answers a different question, or restates the prompt back with no new
  content.
- **0** — Refuses, is empty, or is about a different task entirely.

### state-recovery (weight: 2)

Did the agent reconstruct what the earlier session had already established?

This is the criterion §15's benchmark exists for, so it grades the *decisions
and facts* the recorded session produced — the constant that was chosen, the
table the migration created, the flag that was registered — not general
knowledge about the domain.

- **5** — Names every piece of prior state the task turns on, correctly, and
  attributes it to the session (a branch, a test run, a file that was read)
  rather than presenting it as an assumption.
- **4** — Names the state the task turns on, correctly, without saying where it
  came from.
- **3** — Recovers most of the state; one recovered fact is wrong or garbled, or
  one is silently reconstructed from convention rather than from the session.
- **2** — Recovers only what the active branch already said; everything earlier
  is missing or invented.
- **1** — States prior decisions that the session never made, presented as fact.
- **0** — No engagement with the prior session at all.

**Special case — a contradiction task.** Full marks require the answer to say
*which* of the two disagreeing branches it is acting on **and why the other one
is superseded**. An answer that picks the right side by luck, without naming the
disagreement, scores at most 3. This is the part the script checker deliberately
does not grade, because it is a judgement rather than a string.

**Special case — a stale summary.** An answer that notices a summary is out of
date and says so scores 5 even if it then has to say what it could not resolve.
An answer that acts on the superseded state scores at most 1, whatever else it
gets right.

### retrieval-discipline

Did it fetch what it needed, and nothing more?

§18 names over-fetching and under-fetching as one risk with two directions, so
they are graded on one scale and a run cannot trade one for the other.

- **5** — Every retrieval call was necessary and its result is used in the
  answer; nothing the answer needed was left unretrieved.
- **4** — One call that turned out to be unnecessary, or one small fact that a
  cheap call would have supplied and the answer had to hedge about.
- **3** — Retrieved roughly the right region of the tree with obvious waste
  (repeat fetches of the same branch, a `context_peek` that led nowhere), or
  guessed once where a call was clearly available.
- **2** — Fetched broadly with little relation to what the prompt asked, or
  guessed at something central that was one call away.
- **1** — Retrieval bore no relation to the question: everything fetched, or
  nothing fetched while the answer was plainly missing the branch it needed.
- **0** — Retrieved in a loop, or the answer contradicts what it retrieved.

**Arms with no tools.** Arms A, B and C are given no retrieval tools, so
"retrieval" is what the answer *did with the context it was handed*: score
whether it used the parts of the transcript or summary the question needed.
Never penalize an arm for not calling a tool it does not have.

### golden-state-fidelity

Does the answer match the golden file states you were given?

- **5** — Every file it names is a file the task had to end at, every symbol it
  names exists in that end state, and the behaviour it describes is the golden
  behaviour.
- **4** — Right files and symbols; one described detail of the behaviour is
  imprecise but not wrong.
- **3** — Right file, and the direction of the change is right, but a named
  symbol, value or path does not match the golden state.
- **2** — Names a file the session touched but not the one the task had to end
  at, or describes a change that would not produce the golden behaviour.
- **1** — Names files or symbols that do not exist in this session.
- **0** — No concrete file or symbol at all.

**A file that was deleted or replaced during the session is not part of the
golden state.** Naming it as the place to work is a 1, even when the answer is
otherwise fluent — that is the stale-summary failure this benchmark is built to
catch.
