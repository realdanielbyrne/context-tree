# Running the harness

Every command assumes the repo root and a loaded environment:

```bash
cd /home/realdanielbyrne/GitHub/context-tree
set -a; . ./.env; set +a          # UNSLOTH_API_KEY / OPENROUTER_API_KEY
```

The relay resolves `{env:...}` host-side and injects the credential into the upstream request, so
the key never enters the sandbox and never lands in a config file.

Output is `reports/metrics/swebench-pilot/results-swebench-opencode-<CT_TAG>.json`, written
incrementally. Run dirs are `/mnt/data/ctx-swebench/opencode-runs/<CT_TAG>/<instance>__r<n>/`,
each holding `export.json`, `events.jsonl`, `prompt.txt`, `workspace/` and the per-run `xdg/`.

## Baseline — 10 problems, 1 repeat, local, sandboxed

```bash
CT_OPENCODE_MODEL=local/HuggingJoost/Swift-Qwen3.8-27B-NVFP4-GGUF \
CT_LOCAL_EXCLUSIVE=1 \
CT_RUN_TIMEOUT_S=7200 \
CT_REPEATS=1 CT_REPEAT_START=0 \
CT_TAG=baseline-w0 \
node experiments/context-dedup/swebench-opencode.mjs
```

Swift is the baseline instrument (it scores what the stock model scores and costs less — see
`reports/metrics/swebench-pilot/report-swift-vs-q8.md`). It must be pinned explicitly: `auto` cannot
select it, because `swebench-endpoint.mjs`'s `LOCAL_MODEL` names the Q8 build.

`CT_LOCAL_EXCLUSIVE=1` takes all four connection slots. It is not politeness — opencode makes a model
call during init, before any session exists, and when every slot is busy that call **blocks with no
error, no log line and no session**. Slot exhaustion is invisible through opencode and takes down
other sessions' runs as readily as your own.

Preconditions: Node 22, `opencode` on PATH, `bwrap`, `socat`, and the pinned sandbox assets (`rg`,
`models.json`) under `/mnt/data/ctx-swebench/tooling/opencode-sandbox/`.

## Three repeats, then merge

One wave per repeat index, distinct tags — this is how the reference baselines were built, and it
lets a wave be re-run without discarding the others:

```bash
for R in 0 1 2; do
  CT_OPENCODE_MODEL=local/HuggingJoost/Swift-Qwen3.8-27B-NVFP4-GGUF \
  CT_LOCAL_EXCLUSIVE=1 CT_RUN_TIMEOUT_S=7200 \
  CT_REPEATS=1 CT_REPEAT_START=$R CT_TAG=baseline-w$R \
  node experiments/context-dedup/swebench-opencode.mjs
done

CT_FINALIZE_INPUTS=results-swebench-opencode-baseline-w0.json,results-swebench-opencode-baseline-w1.json,results-swebench-opencode-baseline-w2.json \
CT_FINALIZE_OUTPUT=results-swebench-opencode-baseline-x3.json \
CT_FINALIZE_REEXPORT=0 \
node experiments/context-dedup/swebench-opencode-finalize.mjs
```

`CT_FINALIZE_REEXPORT=0` skips re-running `opencode export`. Leave it at `0` unless an export is
actually missing: a re-export makes a model call at start-up and can steal a local slot from a live
run. Finalize also re-imports each export into context-tree and records the result per cell.

`CT_REPEATS=3` in one process is the simpler alternative when separable waves aren't needed — one
file, nothing to merge.

## OpenRouter instead of local

```bash
CT_OPENCODE_MODEL=openrouter/qwen/qwen3.8-27b CT_TAG=or-w0 \
node experiments/context-dedup/swebench-opencode.mjs
```

Needs `OPENROUTER_API_KEY` (already in `.env`). A remote pin takes no local slot. The entry is
pinned to DeepInfra bf16 with `allow_fallbacks: false`, because OpenRouter otherwise serves this
model from ~16 backends differing in precision (fp4–bf16), context (65k–1M) and max response
(32k–236k) — and opencode's export records only `providerID: openrouter`, so an unpinned run has an
**unknown precision, possibly changing mid-run**.

OpenRouter declares `limit.context: 262144` / `limit.output: 235929`, so it compacts at **230,144**,
not 119,040. It also reports real costs, which the local endpoint cannot (`cost=0`, no cache
pricing) — the cost hypotheses (U1, U8, U9) need this endpoint.

Remote sessions bill a separate titling call.

## Arms

```bash
# U18 — soft window, no summaries. W is swept; 87381 is the anchor, not the answer.
CT_ARM=ct CT_CT_TRIGGER=soft CT_CT_WINDOW=87381 CT_CT_SUMMARIES=0 \
CT_OPENCODE_MODEL=local/HuggingJoost/Swift-Qwen3.8-27B-NVFP4-GGUF \
CT_LOCAL_EXCLUSIVE=1 CT_RUN_TIMEOUT_S=7200 CT_TAG=u18-soft-w0 \
node experiments/context-dedup/swebench-opencode.mjs

# U18 is packaged: experiments/u18-soft-limit/run.sh (gates, three arms, resume, verdict).
# U19 — cadence          CT_CT_TRIGGER=cadence CT_CT_CADENCE_N=5
# U20 — summaries        CT_CT_SUMMARIES=1 (on the winning trigger)
# control                CT_ARM=off
# today's shipped default CT_CT_TRIGGER=hard
```

A treatment turn is `assemble` then an optional `evict` (`oc-plugin/policy.mjs`). The trigger is
**whether `evict` is called this turn, and at what window**: `off` → the control, which calls
nothing; `hard` → every turn at the real context; `soft` → every turn at `CT_CT_WINDOW`; `cadence` →
every Nth turn at `CT_CT_WINDOW` (assembly still runs every turn). Rulings are sticky, so an off turn
leaves the prompt as it was. Nothing in `packages/` changes between arms. To try a different
algorithm, swap one tool's handler (`withHandlers`) — G0 does exactly this.

### Choosing `CT_CT_WINDOW` — sweep to parity, don't compute a fraction

The soft limit is an **absolute** number, not a fraction of whatever the loaded build serves. The
premise is that models attend poorly across their full window, so the question is *how small a
working set still solves the problem* — an answer in tokens, transferable across builds. Anchor at
**87,381**, then sweep **down** while solve-rate parity with `off` holds, and up if it breaks.

Before picking a W, check it can actually fire. A soft window above the pool's own pressure produces
an arm byte-identical to its control, which is **void, not a null result**. From the 30-run Swift
baseline, counting runs whose uncapped peak exceeded W:

| W | binds on | of which on problems Swift can solve |
|---|---|---|
| 87,381 | 6/30 runs, 3/10 problems | **4 runs, 2 problems** |
| 76,117 | 8/30 runs, 3/10 problems | 5 runs, 2 problems |
| 60,000 | 9/30 runs, 4/10 problems | 6 runs, 3 problems |
| 50,347 | 13/30 runs, 7/10 problems | 7 runs, 4 problems |
| 40,000 | 18/30 runs, 7/10 problems | 9 runs, 4 problems |
| 30,000 | 24/30 runs, 10/10 problems | 15 runs, 7 problems |

Parity at 87,381 is close to guaranteed on this pool, because the arm fires on 4 of 30 runs and on
only two solvable problems (xarray-6721, django-11138 — pylint-4970 binds but is never solved). Read
that as "the treatment barely ran", not as support for the hypothesis. The informative range on this
pool is **lower**, and a parity result is only worth reporting alongside how often the arm engaged.

Median uncapped peak is ~45.6K (Swift) and ~61.9K (Q8): the pool's pressure, not the model's window,
is what limits this experiment.

In `ct` arms host compaction is turned off (`compaction.auto: false`) so context-tree is the only
reducer. That makes a genuine overflow a **hard session error**, so under EVERY arm the plugin calls
`evict` at the real window once the host prompt alone would overflow it, and logs that as the floor
(`evict_floor`), not as the arm.

Keep the prompt identical across arms. The point is to test the MCP tool, not the wording.

## Debugging an arm

Keep the sandbox on — turning it off is what makes an arm inert (see SKILL.md). Debug through the
artifacts a sandboxed run already writes, under `/mnt/data/ctx-swebench/opencode-runs/<CT_TAG>/<instance>__r<n>/`:

| Path | What it holds |
|---|---|
| `mcp/ct-plugin.jsonl` | per turn, measured AFTER the edit: messages dropped / folded / reduced, `kept_tokens`, which calls were made, `ms` |
| `mcp/ct-mcp.jsonl` | the sidecar's side: `ready` (the registry's resolved values), `ingest`, one `assemble` row and one `evict` row per call, `assemble_error` |
| `export.json` | the full session as opencode stored it; `parts[].type === "compaction"` marks a host compaction |
| `events.jsonl`, `prompt.txt`, `workspace/` | the event stream, the exact prompt, the edited tree |
| `wire.jsonl` | **what actually went upstream**: one row per provider request with `bytes`, `sha256` and needle `counts` (`role` = messages). Written by the relay, outside the sandbox, downstream of the plugin — the only artifact an inert arm cannot fake |

Run one cell (`CT_INSTANCES=<id>`), not the pool, and read the per-turn decision log by hand before
committing hours.

## Gates before a batch

- **G0 mutation visibility** — prove an in-place edit reaches the provider, read off the relay's wire
  record, not the plugin's own log. Without this every arm may be inert. **PASSED 2026-09-18** on
  Swift-NVFP4 / xarray-6721 (`reports/metrics/swebench-pilot/g0-mutation-visibility.json`).

  ```bash
  node experiments/context-dedup/g0-mutation-visibility.mjs        # ~20 min, takes all 4 slots
  CT_G0_ONLY=grade node experiments/context-dedup/g0-mutation-visibility.mjs   # re-grade, run nothing
  ```

  Two runs on one instance. A random marker goes in the task statement; the control must keep it on
  every hook-mediated request, while `CT_G0_DROP_FIRST=1` **folds** that message to a second marker
  **splices** the assistant message after it, and — from five messages on — **replaces one tool
  output in place** with a third marker (the edit every reduction makes), from three messages on. The claim is two-sided: the
  original marker must leave the wire *and* the replacement must arrive on it — removal alone could be
  opencode's own doing.

  It folds rather than splicing the task statement because opencode's loop holds exactly **one** user
  message: splicing it out draws `500 Jinja Exception: No user query found in messages`, and a
  rejected request cannot answer the question while the marker is duly absent. Requests are selected
  by `counts.tools > 0` and `status === 200`, never by message count — the title-generation call
  carries three provider messages and never passes through the hook.

  The verdict has three outcomes: PASS, FAIL, and **VOID** (the gate could not ask its question — an
  echoed marker, a plugin that never imported, rejected requests, missing wire rows). Exit 1 on
  anything but PASS. Both runs are **gate cells, not results** — they never pool with a measured arm.

- **G1 fidelity** — one `soft` cell completes and grades, every tool call still paired with its
  result, no session error.
- **G2 mechanism fires** — units dropped > 0 on at least one cell, and the agent still finishes.

If no arm evicts, report NOT RUNNABLE. Never a null.
