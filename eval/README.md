# eval — the §15 benchmark harness

Run the same task under two context regimes on the same frontier model and
compare what it costs to be smart:

| Arm | Context given to the agent |
|---|---|
| `native` | the full transcript — system prompt + every message and tool result so far (§15 arm A) |
| `context-tree` | the tree IS the context: Zone A contract + tool schemas, Zone B branch summaries, Zone C active-branch detail, plus the four §9 tools (`context_fetch` / `context_search` / `context_peek` / `annotate`) dispatched through the same handlers the MCP server registers (§15 arm D) |

Every model call in a run — agent, §8 summarizer, judge — is metered, so the
A/B pays for what it actually spends.

## Benchmarks

| `--benchmarks` id | Dataset layout expected under `eval/scenarios/<id>/` | Judge |
|---|---|---|
| `terminal-bench` | one directory per task, each with `task.yaml` (`instruction`, …) and task files. `solution*` is excluded; `run-tests.sh` is hidden from the agent and only written into the sandbox at scoring time | `command` — `bash run-tests.sh`, exit 0 |
| `deepswe-agents-last-exam` | `agents-last-exam.jsonl` — `{id, task, answer?/rubric?}` | `exact_match` / `llm_rubric` |
| `automation-bench` | `automation-bench.jsonl` — `{id, task, judge_command?/rubric?}` | `command` / `llm_rubric` |
| `hle-tools` | `hle.jsonl` — `{id, question, answer, category?}` (text-only: image rows load but are flagged in meta) | `exact_match` |
| `gdpval-aa-v2` | `gdpval-aa.jsonl` — `{task_id, prompt, rubric?, occupation?}` | `llm_rubric` (judge model) |

Every adapter also accepts a normalized `scenarios.jsonl`
(`{id, task, files?, answer?/rubric?/judge_command?}`), and every adapter fails
loud on a missing directory, missing file, or malformed row — a benchmark that
loaded zero scenarios silently would report an A/B on nothing. Key aliases
(`task|prompt|instruction|question`, `id|task_id|instance_id`, …) absorb dataset
revision drift; check the adapter source under `src/adapters/` for the exact
contract, and `test/fixtures/` for a working example of each layout.

## Usage

```bash
pnpm install && pnpm build            # from the repo root

# Put datasets in place (local-only; gitignored), then:
node eval/dist/run.js --benchmarks all --limit 2          # smoke run, 2 scenarios per benchmark
node eval/dist/run.js --benchmarks terminal-bench,hle-tools \
  --arms native,context-tree --model claude-sonnet-5 \
  --cost-cap-usd 2.0 --keep-sandbox
```

Keys come from the environment; the workspace-root `.env` is loaded
automatically (existing shell env wins): `ANTHROPIC_API_KEY` or
`OPENROUTER_API_KEY`, plus the Langfuse keys below. Costs are real — use
`--limit`, `--cost-cap-usd`, and single benchmarks first. Runs are sequential by
design: benchmarks are wall-clock bound, and parallel arms would contend for
the same rate limits the numbers are meant to measure.

## Metrics

Per run (`results.json`): token totals with the provider's honest cache split
(`input` / `output` / `cacheRead` / `cacheWrite` / `total`), model turns and
tool calls, wall time with p50/p95 per-turn latency, output tokens/sec, and USD
cost. The report (`report.md`) aggregates per benchmark × arm and prints the
context-tree vs native delta rows — success rate in percentage points, every
cost/speed metric as a relative percent where lower is better.

## Langfuse A/B export

One trace per scenario × arm, exported when `LANGFUSE_PUBLIC_KEY` and
`LANGFUSE_SECRET_KEY` are set (`LANGFUSE_BASE_URL` for non-cloud; set
`LANGFUSE_TRACING_DISABLED=1` to opt out):

- `sessionId` = `<benchmark>:<scenarioId>` — the two arms of a scenario pair up
  in the Sessions view for a side-by-side read.
- tags: `[benchmark, arm:<arm>, model:<model>, run:<runId>]`.
- one generation per model call with model, token usage, computed cost, and the
  cache split in metadata.
- numeric scores on completion: `success`, `total_tokens`, `input_tokens`,
  `output_tokens`, `turns`, `tool_calls`, `wall_ms`, `cost_usd`.

Without keys the export is a no-op: the run works, it just isn't exported.

## What the tree arm actually runs

`src/loop.ts` implements the minimal tool-use loop the `@context-tree/mcp`
contract describes: each turn's events are appended to L0 via `appendEvent`,
`Summarizer.resummarizeStale()` refreshes the §8 summaries incrementally, the
request is assembled by `ZoneAssembler` (`toCompletionRequest` emits both cache
breakpoints), and context-tool results land in the ephemeral tail — dropped at
phase boundaries, exactly as §10 rule 3 requires. Summarization cost lands in
the same meter as the agent's: the tree arm is charged for its own scaffolding.

## Known limitations

- Text-only: HLE image rows are loaded but flagged (`meta.image`), never shown.
- Harness tools are `run_command` / `read_file` / `write_file` / `edit_file`
  over a temp sandbox (names already map to `toolPhase` defaults). No Docker;
  a terminal-bench task that needs its containerized environment is out of
  scope for v1.
- terminal-bench test scripts are visible in the sandbox only during judging,
  which keeps them hidden from the agent but means the judge could in principle
  collide with agent-written files of the same name.
- `appendEvent` is O(n) per append (the documented v1 tradeoff); long traces
  pay a deterministic, zero-LLM re-segmentation cost per turn.
