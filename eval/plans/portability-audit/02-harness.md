# Portability audit — the live evaluation harness

Area: `eval/src/` (`loop.ts`, `tools.ts`, `metrics.ts`, `run.ts`, `types.ts`,
`scoring.ts`, `sandbox.ts`, `env.ts`). This complements `reports/algorithm.md`
(read as of its 10:51 revision, `fe95c38`) — it does not repeat the seven
hardcoded rows already in that report's tier-2 table, and it takes the
`HARNESS_STOPPED` grading rule as currently written in `loop.ts:1237-1263`
(the 10:49 revision, which already differs from the doc comment on
`RunStatus` at `types.ts:50-56` — see the boundary-conditions section).

Findings are ordered by what breaks first when this harness is pointed at a
model or provider it has never run against.

## 1. The switch point the algorithm describes is off by default in this harness

`reports/algorithm.md`'s tier-1 loop says: *"while the last prompt was smaller
than the switch point, show the whole trace and summarize nothing; once it is
larger, latch."* In `eval/src/loop.ts` that behavior is gated behind two env
vars with no default:

```
eval/src/loop.ts:795  const lazyK = Number.parseInt(process.env.EVAL_LAZY_K ?? '0', 10) || 0;
eval/src/loop.ts:804  const lazyTokens = Number.parseInt(process.env.EVAL_LAZY_TOKENS ?? '0', 10) || 0;
eval/src/loop.ts:819  const belowLazyBudget = () => lazyTokens > 0 && !lazyCrossed && lastPromptTokens < lazyTokens;
eval/src/loop.ts:970  const belowLazyK = (lazyK > 0 && branchCount() < lazyK) || belowLazyBudget();
```

With both env vars unset (`0`), `belowLazyK` is `false` on every turn of every
run: `lazyK > 0` is false, and `belowLazyBudget()` requires `lazyTokens > 0`,
also false. So `activeNodeId` never falls back to "expand the root, show the
whole trace" (`loop.ts:971-973`), and `maybeResummarize` never takes the
below-budget early return (`loop.ts:861`). The tree arm summarizes from the
very first eligible turn, using whichever of the two summarization triggers is
active (see finding 4). `lazyCrossed` — the metric the report calls "item 1's
one-way latch" (`types.ts` / `metrics.ts:99-101`) — stays `false` for the
entire run and is reported as such, indistinguishable from "never needed to
cross."

This is not the same defect as the tier-2 table's "switch point ... hardcoded"
row, which is about the *value* (30,000, not W-derived). This is about the
value's *default*: `run.ts` gives `--zone-b-budget` and `--zone-c-budget`
defaults ('8000', '30000' — `run.ts:66-67`), but there is no `--lazy-tokens`
flag and no fallback default in `loop.ts` at all. Every published run that
exercises the switch point does so by setting `EVAL_LAZY_TOKENS=30000` by hand
on the command line (confirmed in `eval/plans/loop9-item1-lazy-gate.md:116-117`
and `reports/metrics/context-growth.md:142`); a plain
`node dist/run.js --arms context-tree ...` does not.

**Breaks first on:** any invocation that doesn't carry the full flag string
forward — including a first-time run against a new model or provider, which
is exactly the scenario this harness exists to support. **Check today:** none
— no test asserts that omitting `EVAL_LAZY_TOKENS` reproduces "always
summarize" rather than "never summarize" or vice versa; `describe('v6.0 gate
(EVAL_LAZY_TOKENS)')` in `eval/test/loop.test.ts:607` tests the gate's
behavior *when set*, not its default. **Failure mode:** silent — the run
completes, produces a graded result, and nothing in `results.json` says the
switch-point mechanism was never live for it.

## 2. Absent every optional cap, a non-byte-identical loop runs forever

Three ceilings exist and all three are optional with no default:

```
eval/src/run.ts:107-109
  maxTurns:   opts.maxTurns   === undefined ? Infinity : parsePositiveInt(opts.maxTurns)
  timeCapMs:  opts.timeCapMs  === undefined ? Infinity : parsePositiveInt(opts.timeCapMs)
  costCapUsd: opts.costCapUsd === undefined ? null     : Number(opts.costCapUsd)
```

`reports/algorithm.md` documents this as deliberate (turn/time caps were
removed on 2026-09-02 because a duration limit can't be derived from the
task) and names the replacement instrument: `--cost-cap-usd`, "already
present, enforced by the cost meter." But `--cost-cap-usd` is *also*
undefaulted (`costCapUsd: null`), and `InMemoryCostMeter` with a `null` cap
does not enforce anything — it is the explicit "uncapped" state the type
(`number | null`) exists to express. So the actual default configuration of
`node dist/run.js` has **no** externally-imposed ceiling of any kind. The only
thing that can end a non-completing run is the repeat guard:

```
eval/src/loop.ts:174-175
  const signature = `${call.name}:${JSON.stringify(call.input)}`;
  if (seen.has(signature)) { ... }
```

This is a byte-identical check. `STALL_TURNS = 3` (`loop.ts:208`) only fires
when three consecutive turns repeat a call whose name-plus-JSON-stringified-
input matches one already seen exactly — same key order, same whitespace, same
values. A model that varies any byte between retries (a different comment in a
`write_file` call, a shifted `from`/`to` range on repeated `context_fetch`
calls, a changed but semantically-null argument) is invisible to the guard and
keeps `guard.freshThisTurn` above zero every turn, so `stalledTurns` never
accumulates (`loop.ts:192-198`).

**Breaks first on:** a smaller or weaker model transplanted onto this harness
— the population most likely to loop without repeating itself byte-for-byte
(e.g., re-reading a file with a slightly different path normalization each
time, or restating a plan with cosmetic wording changes). This is precisely
the portability scenario the harness exists to support, and it is the one
combination (no cap, non-identical loop) with no instrument at all. **Check
today:** none. `eval/test/loop.test.ts`'s stall tests script byte-identical
repeats (`command: 'true'`, unchanged, per `loop.test.ts` around line 582) —
there is no test for a near-identical, non-detected loop. **Failure mode:**
not a crash, not even a recorded `turn_cap`/`time_cap`/`cost_cap` — it is
unbounded wall-clock and spend with nothing in `RunStatus` to name it, since
`Infinity` turn/time bounds and a `null` cost cap mean the loop in
`runTreeArm`/`runNativeArm`/`runDsaArm` (`for (let turnIndex = 0; turnIndex <
args.options.maxTurns; ...)`) simply never returns.

## 3. The harness-stopped grading rule trusts every judge kind equally, but its own rationale only covers one

`eval/src/loop.ts:1237-1263` (current revision) grades every run except
`status === 'error'`, then applies an asymmetric mask:

```
eval/src/loop.ts:1256-1259
  const stoppedByHarness = (HARNESS_STOPPED as readonly RunStatus[]).includes(status);
  success = stoppedByHarness && judge.success === false ? null : judge.success;
  judgeDetail = judge.detail;
  judgeScore = stoppedByHarness && judge.success === false ? null : judge.score;
```

The comment directly above it (`loop.ts:1228-1243`) justifies keeping a PASS
through a harness-imposed stop this way: *"These scenarios are judged by
running their hidden tests against the sandbox, so the grade is a fact about
the FILESYSTEM, not about whether the model announced it was finished."* That
is a description of the `command` judge kind specifically
(`scoring.ts:51-55`, `commandJudge` — exit code from a hidden test script).
But `judge.kind` is never checked at this call site. `eval/src/scoring.ts`'s
own docblock (lines 1-6) names two other kinds this exact code path also
covers: `exact_match` for HLE (a deterministic string comparison — the
"fact" framing still roughly holds) and, more to the point, **`llm_rubric`
for GDPval-AA and Automation Bench** (`scoring.ts:79-112`,
`judgeScenario`'s `llm_rubric` branch, `scoring.ts:135-146`) — a judge model
reading the agent's truncated final text against a rubric and guessing
whether the task looks done. A rubric judge has no access to "the
filesystem"; it grades whatever text a run stopped mid-flight happened to
have produced, and an LLM grader asked "did the agent complete the task" is a
well-known target for being satisfied by a confident-sounding partial answer.

**Breaks first on:** any `llm_rubric`-judged benchmark run with a turn, time,
or cost cap in force (the `--max-turns`/`--time-cap-ms` "deliberate probe"
case `run.ts:59,65` explicitly still supports, or any run that exceeds
`--cost-cap-usd`). **Check today:** none for this specific combination — both
tests under `describe('runScenario — a run the harness stopped is not a task
failure')` (`loop.test.ts:512-580`) use `exact_match` (the implicit default
`scenario` fixture) and an explicit `kind: 'command'` respectively; neither
exercises `kind: 'llm_rubric'`. **Failure mode:** silent wrong answer — a
capped, incomplete `llm_rubric` run can be recorded as `success: true` on the
strength of the judge's read of unfinished output, entering an arm's
`successRate` (`metrics.ts:151-153`) as a real success rather than the
`null`/unmeasured outcome the rest of the rule intends for anything the
harness cut short. This is the same shape of problem the report's own change
log names as the reason the rule was written in the first place (`algorithm.md`
2026-09-02 10:55 entry, the `v56-base` reliability-gap correction) — it just
was not re-checked against the judge kind the fix's own rationale doesn't
cover.

One documentation note in the same area: the doc comment on `RunStatus`
(`types.ts:50-56`) still reads *"`success` stays null rather than false"* for
every harness-stopped run — that was true before the 10:49 revision of
`loop.ts` and is no longer true for a PASS. Low stakes (nothing reads the
comment at runtime), but worth fixing alongside the judge-kind check so the
two don't drift further.

## 4. Two different, uncoordinated summarization triggers, and the older one is the default

`maybeResummarize` (`loop.ts:850-939`) has two mutually exclusive branches:

```
eval/src/loop.ts:788   const summarizeOnClose = process.env.EVAL_SUMMARIZE_ON_CLOSE === '1';
...
eval/src/loop.ts:853-865
  if (summarizeOnClose) {
    ... branches.length <= summarizedBranchCount) return; ...
  } else if (newEventsSinceSummary < SUMMARIZE_MIN_NEW_EVENTS) {
    return;
  }
```

`SUMMARIZE_MIN_NEW_EVENTS = 8` (`loop.ts:512`) is the *default* trigger — an
absolute count of raw events (tool calls count double, `loop.ts:1099`;
assistant messages count once, `loop.ts:1143`) accumulated since the last
summarize pass, unrelated to window size, token count, or branch structure.
The code's own comment on `EVAL_SUMMARIZE_ON_CLOSE` (`loop.ts:779-786`) states
plainly why this default is a known defect and not merely an older variant:
*"The threshold made summarizer cost a function of turn-count noise (a run
ending one event shy of a crossing paid zero; its twin paid a full pass);
on-close makes it a deterministic function of tree structure."* `reports/
algorithm.md`'s tier-2 table lists `EVAL_SUMMARIZE_ON_CLOSE` as one of the
"seven environment flags, all on" that constitute the shipping algorithm — but
"all on" describes the intended state of a run's environment, not the code's
default, which is `false`. Any invocation that doesn't pass
`EVAL_SUMMARIZE_ON_CLOSE=1` silently reverts to the nondeterministic,
already-diagnosed-as-broken event-count trigger, with no warning at start-up
that this happened.

**Derived-from:** neither trigger derives from anything host-measurable.
`SUMMARIZE_MIN_NEW_EVENTS=8` has no stated fitting procedure even for the
corpus it was presumably tuned on. **Fix cost:** small in isolation (delete
the `else` branch and the flag, matching the report's stated intent to
"promote to defaults and delete the flags") but blocked on the same seven-flag
promotion the report already tracks as an open defect — I'm not duplicating
that row, only pointing at the specific code path that is live when it is
skipped.

## 5. `AGENT_MAX_TOKENS = 8192` — an output cap with no derivation anywhere in the repo

```
eval/src/loop.ts:77   const AGENT_MAX_TOKENS = 8192;
```

used unconditionally as `maxTokens` for every agent-loop request in all three
arms (`loop.ts:307, 358, 1008, 1013`). D19 in `docs/IMPLEMENTATION_PLAN.md:71`
names six window fractions that every budget should derive from — "response
.05, A .10, B .20, C .20, switch .35, slack .10" — and the tier-2 table in
`reports/algorithm.md` tracks derivations for the B/C/switch fractions
(`Zone B budget`, `Zone C budget`, `switch point` rows) with the transplant
harness (`eval/scripts/transplant.mjs`) as the harness that gets them right.
The **response** fraction — the one `AGENT_MAX_TOKENS` should be an instance
of — has no implementation anywhere: `transplant.mjs` never references
`maxTokens`, `response`, `reply`, or any fraction-of-W computation for an
output cap (confirmed by grep across the file), and no `FRACTIONS` constant
exists anywhere in the repository. Unlike the other five budgets, this one
was never even partially fixed in the sibling harness — it's a flat literal on
both paths.

**Should derive from:** the model's actual max-output-token limit, or
`0.05·W/ratio` per D19 if that's meant to be the standing rule. **Breaks
when:** a host model or provider whose maximum completion length is below
8,192 receives this request. This is squarely in the class of host the audit
is about — smaller open-weight and older-generation models commonly cap
output well below 8k (the transplant fixtures already exercise
`openai/gpt-3.5-turbo`, whose completion cap is 4,096, though those runs go
through `transplant.mjs`, not `eval/src/loop.ts`, so this exact literal isn't
exercised by them). Whether the failure is a loud 400 from the provider or a
silent clamp depends on the provider adapter (`packages/core/src/models/`),
which is out of this area's scope — but the constant that would trigger it
lives here, unconditionally, with no per-model override. **Fix cost:** small
— thread a per-model or window-derived value through `HarnessOptions`, the
same shape `--zone-b-budget`/`--zone-c-budget` already use.

## 6. `DSA_V6_FOCUS_TAIL_CHARS = 2_000` — an absolute char count in a token-budgeted system

```
eval/src/loop.ts:679-680
  const DSA_V6_FOCUS_TAIL_CHARS = 2_000;
  const DSA_V6_KEEP_FRACTION = 0.5;
```

`makeTreeDsaV6Selector` (`loop.ts:681-713`, the `EVAL_DSA_V6=1` branch-
selection candidate) builds its relevance query from `task + detail.slice(-
DSA_V6_FOCUS_TAIL_CHARS)` (`loop.ts:700-701`) — the last 2,000 *characters* of
the active branch's rendered detail, regardless of window size or the
tokenizer's chars-per-token ratio. This is exactly the shape the task brief
calls out: an absolute number standing in where a fraction of the window (or
at minimum a token count, using the same `HeuristicTokenizer` the rest of the
tree arm already imports) would be correct. `DSA_V6_KEEP_FRACTION = 0.5` on
the same lines is at least expressed as a fraction, but of branch *count*, not
of window size — a reasonable choice for that particular knob, included here
only for contrast with its sibling constant on the same two lines.

**Breaks when:** ported to a tokenizer whose chars-per-token ratio differs
enough that 2,000 chars represents a meaningfully different fraction of the
model's actual window (the tier-2 table's own "heuristic-to-tokenizer ratio"
row puts the measured drift at 0.851 on this corpus with a kill threshold at
1.6 — i.e., the repo already treats a ~2x char/token drift as plausible and
disqualifying elsewhere). **Scope note:** this is the `tree-dsa` arm's v6
selector, a candidate branch-filtering strategy, not the shipped
context-tree algorithm (`ARMS` in `types.ts:11-14` lists it as a fourth,
separate arm) — lower stakes than findings 1-5, but it's the clearest single
instance of the exact anti-pattern the audit asked to be watched for, so it's
worth fixing on the same pass as the response-token budget above rather than
separately.

## 7. `SUMMARY_DEDUP_COSINE = 0.9` — a threshold with no measurement procedure, unlike its sibling

```
eval/src/loop.ts:542   export const SUMMARY_DEDUP_COSINE = 0.9;
```

Gated behind `EVAL_SUMMARY_DEDUP=1` (`loop.ts:879`), this cosine-similarity
threshold decides whether a stale branch is similar enough to an already-
summarized sibling to skip its own summarize pass (`dedupSummarizePlan`,
`loop.ts:543-565`). The tier-2 table's "heuristic-to-tokenizer ratio" row sets
the standard for what "derived" looks like in this codebase: 0.851 on a
named corpus, a stated kill threshold, and (per that row) a measurement
procedure that ships with the harness so it can be re-run on a new host.
`SUMMARY_DEDUP_COSINE` has none of that — no comment states what corpus 0.9
was chosen against, no script recomputes it, and no test asserts a value
range it must stay inside. It shares its idf/cosine machinery
(`idfVectors`, `cosineSimilarity`, `loop.ts:410-457`) with the tree-dsa
selector's relevance scoring, so a re-measurement procedure could reuse that
machinery directly if one were written.

**Breaks when:** a host with different summary lengths or vocabulary produces
either false merges (distinct branches deduped into one, silently losing
detail — the D6/§8 "usable degradation" the code comments elsewhere
accept as the trade-off) or no merges at all (the flag becomes a no-op,
silently paying for the feature's bookkeeping with none of its savings).
Neither direction fails loud.

## Dead code

**`onPhaseTransition()` never fires in this harness — confirmed by the
segmenter, not inferred.** `loop.ts:1031` and `loop.ts:1146-1147`:

```
const openBefore = handle.store.openPhase()?.id ?? null;
...
const openAfter = handle.store.openPhase()?.id ?? null;
if (openAfter !== openBefore) assembler.onPhaseTransition();
```

`store.openPhase()` (`packages/core/src/store/sqlite.ts:366-373`) queries for
a node with `kind = 'phase' AND status = 'open'`. `appendEvent`'s comment at
`loop.ts:986-991` states — and `packages/core/src/segment/segment.ts:239-240`
confirms in code (`if (open !== null) closePhase(open, prevSeq); ops.push({
op: 'close', key: TASK_KEY, ... })`) — that re-ingesting the whole log on
every turn closes every open phase and the task node before segmentation
finishes. So `openPhase()` returns `null` both before and after every tool
dispatch in `runTreeArm`, `openBefore === openAfter` always, and
`onPhaseTransition()` is called on zero runs, regardless of any `EVAL_*` flag.

This is not a new observation in isolation — the codebase's own comment at
`loop.ts:1109-1110` names the same fact as the reason `EVAL_FETCH_EVENTS` was
built ("the 'ephemeral tail' they used to land in never actually dropped
(openPhase() is always null here, so onPhaseTransition() is dead code)") —
but that comment only explains the fix for the tool-result path
(`tailCounter`/`assembler.appendTail`, `loop.ts:1131-1133`). It does not
mention that the identically-shaped completion-nudge fallback four lines
above (`loop.ts:1062-1064`, the `assembler.appendTail({ id:
'completion-check-...', ..., ephemeral: true })` branch taken when
`EVAL_FETCH_EVENTS` is unset) has the exact same dead cleanup behind it, nor
that the `openBefore`/`openAfter`/`onPhaseTransition()` call itself
(`loop.ts:1031,1146-1147`) is dead **unconditionally** — it runs every turn of
every tree-arm run today, flag or no flag, and never once calls the method it
exists to call. Concretely: with `EVAL_FETCH_EVENTS` unset (its default —
finding 4's pattern repeats here), every `context_fetch`/`context_search`/
`context_peek` result and every completion-gate nudge appended to the
ephemeral tail is re-billed as fresh prompt content on every subsequent turn
for the rest of the run, which is the specific cost regression
(`loop.ts:1113`, "7.6k tokens pinned for 12 turns, $0.19 of one run") the flag
was built to fix — silently reintroduced by omitting a flag with no default.

**Fix cost:** deleting `openBefore`/`openAfter`/the `onPhaseTransition()` call
is a pure removal (dead code, no behavior change) once `EVAL_FETCH_EVENTS` is
promoted to a default per finding 4 / the report's existing "promote to
defaults and delete the flags" item; until then, removing it now would be
premature since the ephemeral-tail path it (uselessly) guards is still the
default.

## Boundary conditions summary

| Condition | Checked today | What happens when violated |
|---|---|---|
| `EVAL_LAZY_TOKENS`/`EVAL_LAZY_K` unset (the harness's actual default) | not tested | silent: the tree arm never devolves to whole-trace mode; `lazyCrossed` reports `false` throughout, indistinguishable from "not needed" |
| no `--max-turns`, `--time-cap-ms`, or `--cost-cap-usd` passed, and the model loops with non-byte-identical calls | not tested (existing stall tests use byte-identical repeats) | silent, unbounded: no `RunStatus` value exists for "the repeat guard's signature scheme missed a real loop" |
| `judge.kind === 'llm_rubric'` on a run the harness stopped | not tested for this kind (only `exact_match`/`command` are) | silent wrong answer: a PASS from a subjective judge on unfinished output can enter `successRate` as a genuine success |
| `EVAL_SUMMARIZE_ON_CLOSE` unset (default) | tested only in its "on" state | silent: falls back to `SUMMARIZE_MIN_NEW_EVENTS`, the trigger already documented in-repo as cost-nondeterministic |
| a provider/model whose max completion tokens < 8,192 | not tested anywhere in `eval/src` | provider-dependent — likely a loud rejection, but nothing in this harness clamps or derives around it |
| `EVAL_FETCH_EVENTS` unset (default) combined with any run long enough to fetch/nudge more than once | not tested for cost growth | silent cost regression: ephemeral tail entries never drop (see Dead code) |

## What this area gets right

- `lastPromptTokens` (`loop.ts:1024`) is genuinely derived — the provider's
  own billed usage (`input + cacheRead + cacheWrite`) from the previous turn,
  replacing an earlier `traceChars / 4` heuristic. This is the fixed half of
  the lazy gate (`reports/metrics/context-growth.md:138-140`); only the
  right-hand side it's compared against (`EVAL_LAZY_TOKENS`) is still a bare
  constant, per finding 1.
- `parseCommandScore` (`scoring.ts:41-49`) degrades gracefully — a hidden
  test's own `SCORE: p/t` line wins when present, exit status is the fallback
  — and both are exercised by the judge test suite.
- The repeat guard's *concept* (non-progress ends a run, not a counter) is the
  right instrument for the problem the report says it replaces; finding 2 is
  about its detection method's blind spot, not the design.
- `HeuristicTokenizer` is imported and available to `ZoneAssembler`
  (`loop.ts:760`) — the machinery finding 6 needs already exists in this file,
  it's just not used for that one constant.
