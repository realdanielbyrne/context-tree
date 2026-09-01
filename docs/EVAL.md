# Evaluation harness (plan §15)

**The question this benchmark asks: can a fresh agent resume a task from the tree
alone?**

That question is literature gap 3 in the plan. LOCOMO-style memory benchmarks ask
whether a model can answer questions about a long conversation; none of them ask
whether an agent handed only a summary tree can pick up an unfinished coding task
and finish it. So the harness is not a QA set — it is a *resumption* set: a
scripted session, a fresh agent that never saw it, and a checker that says whether
the resumption was right.

The harness lives in `eval-resumption/harness/` and is not part of the published packages.

---

## The four arms

Same task, same model, same tokenizer, same cost meter. Only the context differs.

| Arm | Name | Context handed to the fresh resuming agent |
|---|---|---|
| A | `full-transcript` | every recorded event, verbatim. The quality ceiling and the worst cost. |
| B | `flat-window` | the last N tokens, event-aligned. What naive agents do. |
| C | `flat-summary` | one whole-transcript summary (Mem0-style flatten). |
| D | `context-tree` | `ZoneAssembler` output plus the four §9 MCP tools. |

Arm C is the arm the tree has to beat. It is deliberately built the way §8
forbids — summarizing raw events at the root rather than summarizing leaf
summaries — because that difference is the thing being measured. If D does not
beat C, the two-level structure is not paying for itself.

Arm D calls the handlers exported from `@context-tree/mcp`, not a copy of them.
An eval that called a different code path would measure a surface the agent never
sees.

**One tokenizer and one cost meter are shared by all four arms** (`ArmRuntime`).
A per-arm tokenizer would make §15's headline token ratio meaningless, so the
tokenizer, the meter and the metered provider are constructed once and handed
around as a single object that cannot be split.

---

## Task format

A task is JSON. One file may hold one task, an array, or `{ "tasks": [...] }`;
`eval-resumption/harness/task-spec.ts` is the schema and the validator, and every rejection
names the field that caused it.

```jsonc
{
  "id": "pricing-rounding-resume",          // unique across the task set
  "kind": "resumed",                        // fresh | resumed | adversarial
  "trap": null,                             // required iff kind === "adversarial"
  "title": "fix pricing rounding",
  "trace": {                                // exactly one of events / fixture
    "events": [
      { "type": "user_message", "text": "the pricing rounding is off by a cent" },
      { "type": "tool_call", "tool": "Read", "path": "src/pricing.ts",
        "args": "{\"path\":\"src/pricing.ts\"}" },
      { "type": "tool_result", "output": "export function price(c) { return c * 1.08; }" },
      { "type": "tool_call", "tool": "Edit", "path": "src/pricing.ts",
        "content": "export function price(c: number) { return Math.round(c * 1.08); }" },
      { "type": "tool_result", "output": "edited src/pricing.ts" },
      { "type": "tool_call", "tool": "run_tests", "args": "{\"suite\":\"pricing\"}" },
      { "type": "tool_result", "output": "2 passing, 0 failing" }
    ]
  },
  "golden": [                               // the correct END STATE of each file
    { "path": "src/pricing.ts",
      "content": "export function price(c: number) { return Math.round(c * 1.08); }" }
  ],
  "prompt": "Finish the task: confirm the rounding fix and say what is left.",
  "expect": {                               // what a correct run looks like
    "answerContains": ["price"],
    "answerOmits": [],
    "requiresTool": [],                     // any of the four §9 tool names
    "forbidsTool": [],
    "maxToolCalls": 3,
    "staleMarkers": []
  },
  "checker": { "module": "builtin:golden-text" },
  "rubric": null,                           // optional per-task rubric path
  "notes": "why this task exists"
}
```

### Events

Task events are **content-bearing**, never blob hashes: the harness writes the
text into L2 and appends the L0 record itself (`materializeTrace`). That keeps
every fixture synthetic and hand-auditable — no private transcript can be
smuggled in as a hash that only resolves on one machine.

| `type` | Fields |
|---|---|
| `user_message` / `assistant_message` | `text` |
| `tool_call` | `tool` (harness-native name, mapped to a phase by §7's `TOOL_PHASE`), `path?`, `content?` (post-edit file content), `args?` |
| `tool_result` | `output?`, `error?`, `truncated?`, `call?` (1-based index of its `tool_call`; defaults to the previous one) |
| `segment_boundary` | `to`, `from?` — an explicit phase boundary, honoured over the state machine |

All events accept an optional `ts` (ISO-8601). Omit it and every event gets the
same fixed timestamp, which keeps ingestion deterministic.

Instead of `events`, a task may point at a fixture file:
`"trace": { "fixture": "traces/pricing.jsonl" }` — a `.jsonl` of one event per
line, or a `.json` array / `{ "events": [...] }`. The path resolves against the
task file's directory.

**Fixtures must be synthetic.** Generate them programmatically or hand-author
them, and say so in a header comment. A trace log is a verbatim record of
someone's private work and scrubbing is never provably complete.

### Adversarial tasks and their traps

§15 asks for ten adversarial tasks. The validator refuses a trap that nothing can
assert, because a trap nothing asserts is a task that always passes.

| `trap` | What it does | The field that must back it |
|---|---|---|
| `stale-summary` | a branch summary describes a state a later branch already replaced | `expect.staleMarkers` — strings that appear **only** in the stale summary. One of them in the final answer is a stale-summary incident. |
| `contradiction` | two branches disagree; the agent has to pick the later one and say so | `expect.answerContains` or `expect.answerOmits` |
| `fetch-not-needed` | everything needed is already in the summaries; fetching is wasted spend | `expect.maxToolCalls` (often `0`) or `expect.forbidsTool` |

### Checkers

`checker.module` is either `builtin:<name>` or a path to a module (resolved
against the task file's directory) exporting a checker function
(`checker.export`, default `default`).

```ts
type CheckerFn = (input: {
  task: EvalTask;
  finalText: string;                  // the resuming agent's last assistant text
  toolCalls: readonly { name: string; args: Record<string, unknown>; ok: boolean }[];
  steps: number;
  stoppedBy: 'stop' | 'step-cap' | 'no-tools';
}) => { passed: boolean; detail: string; staleSummaryIncident?: boolean }
   | Promise<...>;
```

`builtin:golden-text` evaluates exactly the `expect` block and nothing else, and
reports `staleSummaryIncident` only for a `stale-summary` task. `detail` is
printed verbatim in the results, so it must name what failed.

Leaving `staleSummaryIncident` undefined is meaningful: the metric then reports
*not reported* rather than a false zero.

## How to add a task

1. Write the JSON into the task directory (default `eval-resumption/tasks/`), one file per
   task or one file per group. Ids must be unique; tasks run in id order.
2. Keep the trace synthetic and small enough to read. Aim for a session with
   several phases — the tree has nothing to summarize otherwise.
3. Fill `golden` with the *correct end state* of every file the session touched.
   Checkers and the judge both read it as ground truth.
4. Write `expect` so the task can actually fail. `answerContains: ["price"]` on a
   task whose prompt already contains "price" asserts nothing.
5. Adversarial tasks: pick the trap, then write the field that makes it
   assertable (table above).
6. Validate before running: `validateTask` / `loadTasks` throw with the field
   name. `context-tree eval --dry-run` loads and validates every task without
   spending anything.

## Rubric

The LLM judge grades against a markdown rubric (§15 puts it at `eval-resumption/rubric.md`;
override with `--rubric`). One `### <criterion-id>` heading per criterion, an
optional `(weight: N)`, prose underneath:

```markdown
# Resumption rubric

### correctness (weight: 2)
Does the answer match the golden end state — the right files, the right change?

### grounding
Does it name real files, symbols and test outcomes from the recorded session,
rather than plausible-sounding generalities?

### honesty
If the context was thin, stale or contradictory, does the answer say so instead
of bluffing?
```

Scores are 0..5 per criterion; `overall` is the weighted mean normalized to
0..1, and a verdict passes at 0.6 by default. A verdict missing a criterion, or
scoring one that is not in the rubric, is **rejected** — averaging over whichever
criteria the judge happened to return would silently change the denominator of
every quality number.

**The judge never sets the success rate.** §15's success rate is the script
checker's; the judge is reported beside it. If the rubric file is absent the run
continues with checkers only and says so in the conditions.

## Running it

```bash
context-tree eval --tasks eval-resumption/tasks --seeds 5 --arms A,B,C,D
context-tree eval --dry-run                 # validate + project spend, send nothing
```

| Flag | Default | Meaning |
|---|---|---|
| `--tasks` | `eval-resumption/tasks` | task file or directory |
| `--arms` | `A,B,C,D` | arms to run (ids or names) |
| `--seeds` | `5` | repetitions per task (§15 wants n>=5) |
| `--out` | `eval-resumption/results` | results root; a timestamped directory is created under it |
| `--max-steps` | `6` | model turns per run before the loop stops |
| `--window` | `8000` | arm B's window, in tokens |
| `--cap` | `5` | USD cap; `none` disables it |
| `--rubric` | `eval-resumption/rubric.md` | judge rubric |
| `--model` | config `rootModel` | the one model every arm answers with |
| `--provider` | config `provider` | `anthropic` / `openrouter` / `mock` / `recorded` |
| `--dry-run` | off | project the spend and stop |

Output lands in `eval-resumption/results/<timestamp>/`: `results.json` (every run, verbatim),
`criteria.json`, and `summary.md` (the arm table and the §15 verdict).

### Build caveat — read this before wiring it into CI

`packages/cli/src/commands/eval.ts` imports `eval-resumption/harness/index.js` and calls
`runEval(args)`. This harness exports exactly that. But two things outside this
directory have to change before the shipped CLI can actually load it:

1. `eval/` is not in the `tsc --build` graph (`tsconfig.json` references only the
   three packages), so `eval-resumption/harness/index.js` is never emitted.
2. the repo root has no `node_modules` link for `@context-tree/core` / `/mcp`, so
   even a compiled `eval-resumption/harness/index.js` could not resolve its imports at
   runtime.

Both files are owned elsewhere (`tsconfig.json`, `package.json`). Until they
change, run the harness through vitest, which aliases both packages to source:

```ts
// eval-resumption/harness/benchmark.live.test.ts — create locally, LIVE-gated like §17's
import { describe, it } from 'vitest';
import { runEval } from './index.js';

const enabled = process.env.LIVE === '1';
describe.skipIf(!enabled)('§15 benchmark', () => {
  it('runs the arms', { timeout: 3_600_000 }, async () => {
    await runEval(['--seeds', '5']);
  });
});
```

```bash
LIVE=1 npx vitest run eval-resumption/harness/benchmark.live.test.ts
```

### Offline

`eval-resumption/harness/harness.test.ts` never touches the network: model replies come from
`MockProvider` and `RecordedProvider`. `runEvaluation(args, { provider })` takes
an injected provider, which is how the whole runner is exercised offline.

### No key, no numbers

A run with no usable API key exits cleanly, names every arm it skipped and why,
writes no results directory, and leaves all four §15 criteria `UNKNOWN`. It does
not fabricate a result set and it does not pass silently. `runEval` sets a
non-zero exit code when nothing at all was measured; a run that measured
something and missed the thresholds exits 0 with the verdict in the report,
because that is a result rather than a harness failure.

## Metrics

| Metric | Definition |
|---|---|
| success rate | script checker passes / graded runs. Runs that errored are excluded — an arm is not blamed for the harness's fault. |
| tool calls per run | every tool call the loop recorded, with arguments and latency. |
| input tokens | `usage.input + cacheRead + cacheWrite` — every token the model read as input, however it was billed. |
| cache split | cache-read vs cache-write, from the provider's `TokenUsage` (**measured**) and, for arm D, from core's `ProviderCacheSimulator` (**simulated**). |
| p50 / p95 latency | nearest-rank percentiles of whole-run wall time. No interpolation: with n>=5 an interpolated p95 would invent a latency no request ever had. |
| cost per run | measured `TokenUsage` priced with core's published table. |
| `context_peek` precision | peeks followed by a `context_fetch` of that same node / total peeks. A peek that led nowhere is a look the model paid for and did not use. |
| stale-summary incidents | checker-reported, on `stale-summary` tasks only. Reported as `incidents/reports`, or *not reported*. |
| search path | which mechanism answered `context_search` — `vector` or the lexical `beam` fallback. |

Two rules are enforced in code, not left to the reader:

- **A metric with no inputs is `null`, never `0`.** An arm that did not run has
  no success rate; printing 0% would read as "it failed everything".
- **Measured and simulated numbers never mix.** They are reported side by side
  with the source stamped, and `criteria.ts` refuses a measured-vs-simulated
  comparison outright.

## Success criteria (§15 v1)

| id | Criterion | Threshold |
|---|---|---|
| `success-rate-gap` | D within 5 points of A on success rate | `D - A >= -5` points |
| `input-tokens-vs-a` | D at least 50% cheaper than A in input tokens | `1 - D/A >= 0.5` |
| `input-tokens-vs-c` | D at least 30% cheaper than C in input tokens | `1 - D/C >= 0.3` |
| `tool-call-overhead` | D's tool-call overhead | `< 2.5` per run |

Each returns `pass`, `fail`, or `unknown` with the actual number. **A criterion
whose inputs are missing is `unknown`, never `pass`.** The report's verdict is
`met` (all pass), `not-met` (any fail), or `unproven` (nothing failed but
something could not be evaluated).

## What it costs

The runner projects the spend before it sends anything and **refuses to start**
if the projection exceeds `--cap`. The projection is deliberately pessimistic: it
charges every arm its full prompt on every one of `--max-steps` turns, so a real
run costs less.

A full §15 set — 25 tasks, 5 seeds, 4 arms, ~10k-token transcripts,
`--max-steps 4`, on a Sonnet-class model at $2/M in and $10/M out — projects at
roughly **$50**, and typically lands nearer **$15–25** because most runs stop
after one or two turns. Arm A dominates: it pays the whole transcript on every
turn of every seed.

The default cap is `$5`, which a full 25-task set will exceed — that is
deliberate: a run that large should be an explicit budget decision, not a
default. Raise it with `--cap 60`, or cut `--seeds` / the task set.

Run `--dry-run` for the real number for your task set; it prints the projection
and sends nothing.

Per-task setup (arm D's §8 summarization, arm C's flatten) is reported
separately in `summary.md`, because it is the cost of *building* the context, not
the cost of a resumption. Folding it into arm D's per-run tokens would charge a
one-off against every seed.

## Known limitations, stated rather than hidden

- **Seeds are repetitions, not a random seed.** The harness is deterministic —
  the same tasks produce the same prompts — but model sampling is not
  controllable through these provider APIs. That is exactly why §15 asks for
  n>=5. The seed index is recorded on every run.
- **L3 is unbuildable here.** Neither Anthropic nor OpenRouter has an embedding
  endpoint, so `context_search` runs §9's lexical beam fallback. Every arm-D run
  records that as a condition, and `summary.md` prints it.
- **The simulated cache split is a cold start**, one submission only. A
  resumption *is* a cold cache; priming the simulator first would report a saving
  no resuming agent ever sees.
- **Arm D's tool argument schemas are mirrored by hand** in `arms.ts`, because
  `zod` is not resolvable from `eval/` and the harness adds no dependencies. The
  tool *names and descriptions* are imported from `@context-tree/mcp`, and
  `harness.test.ts` asserts the mirrored properties and required fields against
  the real zod shapes — so drift fails the suite rather than the run.
- **The judge is evidence, not arithmetic.** A model grading a model does not set
  the success rate.
