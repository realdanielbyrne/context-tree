# Scenarios — reusable multi-turn experiment setups

A **scenario** is a task expressed as data, not code: a system prompt, an ordered
sequence of user turns, the conditions that release each turn, and the files the
workspace starts with. Nothing in it is specific to any one hypothesis.

It exists so that one carefully-built agent workload can drive *several*
experiments. The same `flapsim` scenario can be run by the anchor-dedup arms, by a
context-covariance probe, by an eviction-policy sweep, or by anything else, with
only the instrumentation changing. The workload stays fixed, so results across
those experiments are comparable — which they are not when each experiment invents
its own task.

## Layout

```
experiments/scenarios/<name>/
  scenario.json        manifest: system prompt, turn order, release gates, seed list
  system.md            the system prompt
  turns/NN-<id>.md     one file per user turn, in order
  seed/**              files copied into the workspace by seed()
```

## The turn sequence is the point

`turns/01-*.md` is the opening instruction. Every later turn is a **follow-up the
user sends mid-run** — a feature request, a review demand, a docs request. Each
declares a `gate` saying when it is released, so every arm of an experiment
receives it at the same *logical* stage rather than the same turn number:

```jsonc
{ "id": "feature-and-docs", "file": "turns/02-feature-and-docs.md",
  "gate": { "allOf": [ {"fileMinBytes": ["replay.txt", 200]}, {"exists": "REVIEW.md"} ] },
  "fallbackTurn": 70 }
```

Gate predicates are evaluated against the **workspace**, not the transcript, so
they cannot be gamed by an agent that merely talks about finishing. `fallbackTurn`
is a safety net; which path fired is recorded per run as `injected_via`, and a
between-arm difference in that distribution is a confound, not a result.

## Using one

```js
import { loadScenario, scenarioTask } from '../scenarios/load.mjs';

const task = scenarioTask('flapsim', { grade, score });   // -> a task module
// or drive it yourself:
const sc = loadScenario('flapsim');
sc.system; sc.turns[0].text; sc.seed(ws); sc.makeHook(ws);
```

`scenarioTask` returns the `{name, system, task, seed, grade, score, makeHook}`
shape the coding-harness task modules use, so any existing runner accepts it.

## Rules

- **Prompts are data.** Edit the markdown, not a JS string literal. A prompt change
  is a reviewable diff.
- **Seed files stay under 1900 characters** where the agent is expected to re-read
  them. The harness clips tool output at 2000 (`coding-harness/lib.mjs`), and a
  clipped read leaves only a FRAGMENT resident — which makes any claim that the
  file "is above in this conversation" false.
- **Never edit a scenario mid-experiment.** Version it (`flapsim-v2/`) so old
  results stay attributable to the prompts that produced them.
