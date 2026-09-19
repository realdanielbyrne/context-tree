---
name: swebench-harness
description: Use when running, changing or interpreting this repo's SWE-bench agent experiments — starting a baseline or repeat wave, merging result files, swapping the model on the local inference server, pointing runs at OpenRouter, setting an eviction/window arm (CT_ARM, CT_CT_*), or reasoning about compaction thresholds, context windows, KV cache and VRAM on this machine.
---

# The SWE-bench harness

Ten SWE-bench Verified problems run through **opencode** (an external agent host — D20 forbids an
in-repo eval loop), each in a bubblewrap sandbox with no network except a relay to the model.
`experiments/context-dedup/swebench-opencode.mjs` is the driver; grading is
`ab-tasks/swebench.mjs gradeDetail` against held-out tests after opencode exits.

**The source is the specification.** Every module carries a long header comment explaining why it
is shaped the way it is, and those comments are load-bearing — read them before changing behaviour.
This skill covers what the source does *not* say: the local inference server, the hardware, and the
traps that silently turn an experiment into its own control.

## Read these for detail

- **references/running.md** — baseline, repeat waves, merging, OpenRouter, the arms. Exact commands.
- **references/local-server.md** — the unsloth studio API: swapping models, choosing a context
  length, and the VRAM arithmetic on this box. Not documented publicly or in this repo.

## The two numbers that govern everything

| | |
|---|---|
| **opencode compacts at** | `limit.context − min(limit.output, 32000)`. At the current declaration: `151040 − 32000` = **119,040** |
| **the head you never see** | system block + tool schemas, assembled *after* the transform hook. ~8,100 tokens measured on baseline runs (no MCP); ~9,898 recorded for arm-bearing runs, whose MCP schemas add to it. The sidecar assumes 12,000 (`CT_CT_HEAD_TOKENS`) |

`limit.context` is a **declaration in `experiments/context-dedup/opencode.json`**, not a measurement.
Nothing checks it against what the server actually loaded. Both numbers must agree or the experiment
is measuring a fiction — see references/local-server.md.

Any imposed window must sit far above the head, or the arm compacts on turn one. This is why
`CT_OUTPUT_CAP` defaults to `max(4096, CT_WINDOW/6)` rather than staying at 32,000: at a one-third
window the default cap would put the compaction threshold *below* the head.

## Quick reference — environment knobs

Run selection and endpoint:

| Var | Default | Meaning |
|---|---|---|
| `CT_OPENCODE_MODEL` | `auto` | `auto` = local if a slot is free else OpenRouter; or pin `local/<id>` / `openrouter/<id>` |
| `CT_LOCAL_EXCLUSIVE` | — | `1` = local only when *nothing* else uses the device. Use for every real run |
| `CT_TAG` | `opencode` | names the output file and the run dir |
| `CT_REPEATS` / `CT_REPEAT_START` | `1` / `0` | one wave per repeat index, merged later |
| `CT_INSTANCES` | selection-v2 | comma-separated ids to override the 10-problem pool |
| `CT_RUN_TIMEOUT_S` | `3600` | **always set 7200.** 3600 once killed an already-solved run |
| `CT_SANDBOX` | on | `0` disables it — and silently disables the `mcp`/`ct` arms with it |

Context-tree arms (`CT_ARM=ct` only; `off`/`mcp` ignore them):

| Var | Default | Meaning |
|---|---|---|
| `CT_ARM` | `off` | `off` (control) \| `mcp` (tools only) \| `ct` (tools + assembly plugin) |
| `CT_CT_TRIGGER` | `soft` | `off` \| `hard` \| `soft` \| `cadence` |
| `CT_CT_WINDOW` | `50347` | the soft limit, in **absolute tokens** — the swept variable, not a fraction of the served window. Check it can fire before using it (references/running.md) |
| `CT_CT_HARD_WINDOW` | `151040` | the model's real context |
| `CT_CT_CADENCE_N` | `5` | fire every Nth turn under `cadence` |
| `CT_CT_SUMMARIES` | `0` | `1` folds evicted units to summaries instead of dropping |
| `CT_CT_ANCHOR` / `CT_CT_TOPK` / `CT_CT_PROTECT_TAIL` | `4` / `5` / `6` | never-evicted units, retrieval hits, protected trailing messages |
| `CT_CT_REPLY_RESERVE` | `8192` | headroom left for the reply |
| `CT_ASSEMBLE_PORT` | `8899` | loopback assembly endpoint |

`CT_WINDOW` / `CT_OUTPUT_CAP` are a **different mechanism**: they re-declare `limit.context` so
*opencode's* compaction binds earlier. They do not exercise context-tree. Don't confuse the two.

## Traps that turn an arm into its control

Each of these produces a run that completes, grades, and reports nothing wrong.

- **`CT_ARM=mcp|ct` with `CT_SANDBOX=0` silently degrades to the control** — and the results file
  does not admit it. All arm wiring sits inside `if (SANDBOX)`, so the `mcp`/`plugin` config blocks
  are never written and the sidecar never starts; but the cell still records `arm: "ct"` and a
  populated `ct: {...}` block with every knob you set, and `--pure` is still dropped (that is keyed
  on the arm, not the sandbox). Only the zero counts in `ct.assemble_*` betray it. Never debug an
  arm by turning the sandbox off.
- **`CT_ARM=ct` needs `packages/*/dist` built**, and it drops `--pure` (which disables plugins).
- **opencode says NOTHING when a plugin module fails to import** — no log line, no error, zero hooks
  registered, the run completes normally. A plugin whose sibling import is missing inside the sandbox
  is therefore indistinguishable from one that loaded and never fired. This is not hypothetical: the
  `ct` arm was inert this way until gate G0 caught it (`oc-plugin/apply-decisions.mjs` was not bound;
  `MCP_PATHS` now binds the whole `oc-plugin` directory). The plugin logs `loaded` and `registered`
  rows for exactly this reason — check `ct.plugin_loaded` in the cell before reading anything else.
- **`@opencode-ai/plugin` fails to install in the sandbox** (`background dependency install failed`,
  ECONNREFUSED — there is no network). It is a detached fork whose result is ignored, so it does
  **not** block plugin loading. Expect the WARN in every sandboxed run and do not chase it.
- **`CT_CT_HEAD_TOKENS` cannot be set from the shell** for a sandboxed run. The sidecar reads it
  (default 12,000) but the runner's forwarded key set omits it and `sandboxEnv` is a whitelist.
- **`swebench-endpoint.mjs`'s `LOCAL_MODEL` is hardcoded to the Q8 model**, not Swift. `auto` will
  never choose Swift — that is why every Swift baseline is explicitly pinned.
- **A mistyped knob is refused at start-up**, deliberately: `CT_CT_WINDOW=50k` reads as `NaN`, which
  the keep-everything path would swallow with nothing logged. Trust the refusal; don't work around it.
- **The arm knobs travel five hops to reach the sidecar, and a break anywhere is silent.** For the
  whole of this arm's life `openSandbox` dropped `mcp.env`, so no `CT_CT_*` ever arrived and the
  sidecar booted on its own defaults — `CT_CT_TRIGGER=off`, which never evicts — while the cell
  recorded the arm that was asked for. Fixed, and the cell now carries the sidecar's own account:
  **check `ct.arm_agrees` before reading any arm result**, and `ct.arm_disagreements` when it is false.
- **An arm byte-identical to its control is void, not a null result.** Prove the mechanism fired
  (units dropped > 0) before reporting anything about it.

## Facts that are easy to get wrong

- **The window depends on which build is loaded, and the three differ a lot** — Swift-NVFP4
  **151,040**, Swift-IQ4_XS **228,352**, UD-Q8_K_XL **262,144** (observed, not inferred; it does not
  track weight size). Compaction threshold, `CT_CT_HARD_WINDOW` and `limit.context` are all
  model-specific, `opencode.json` declares everything it lists at 151040, and the IQ4_XS build is not
  listed at all. See references/local-server.md.
- **Accuracy does not transfer between quantizations of the same fine-tune.** The 19/30 baseline is a
  Swift-**NVFP4** result. Swift-IQ4_XS is un-baselined.
- **`--kv-unified` is set**, so `--parallel 4` does *not* divide the context into four 37,760-token
  slices. One sequence can use the whole window — but the four slots share one pool, so concurrent
  sessions contend and none is guaranteed either figure. Another reason for `CT_LOCAL_EXCLUSIVE=1`.
- **Local runs report `reasoning_tokens: 0`.** Measure thinking from the export's reasoning parts
  (`reasoning_chars`), never from token counts, on this endpoint.
- **Local (quantized GGUF) and OpenRouter (bf16) are different weights.** Pair comparisons within an
  endpoint; never mix them in one arm.
- **Never `kill` opencode processes host-wide.** Three runs were lost that way. Kill only PIDs you
  launched.
- `50347` survives as the `CT_CT_WINDOW` default from an earlier fractional framing (it is
  `floor(151040/3)`, off by one from the `50346` some analysis code computes). It is a leftover
  default, not a recommendation — set W deliberately.

## Before committing GPU hours

1. `node --test experiments/context-dedup/*.test.mjs`
2. One cell end to end, graded, with the per-turn decision log read by hand.
3. Confirm `sandbox.preflight` is all-true in the cell and the session did not error.
4. For any arm: confirm the mechanism actually fired.
