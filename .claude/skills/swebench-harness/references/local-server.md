# The local inference server

**None of this is in the repo, and it is not in unsloth's public docs either** (unsloth.ai/docs
covers the `unsloth run` CLI, not the studio HTTP API). The authoritative source is the running
server's own schema:

```bash
curl -s -H "Authorization: Bearer $UNSLOTH_API_KEY" http://127.0.0.1:8888/openapi.json
```

`UNSLOTH_API_KEY` from the repo's `.env` authenticates every call below. You do **not** need to mint
a studio JWT.

The server is `unsloth studio -p 8888`, supervising a `llama-server` child. `opencode.json` points
`provider.local` at `http://127.0.0.1:8888/v1`.

## What is loaded right now

```bash
set -a; . ./.env; set +a
curl -s -H "Authorization: Bearer $UNSLOTH_API_KEY" http://127.0.0.1:8888/v1/models | jq '.data[]|select(.loaded)'
curl -s -H "Authorization: Bearer $UNSLOTH_API_KEY" http://127.0.0.1:8888/api/inference/status \
  | jq '{active_model,gguf_variant,context_length,native_context_length,requested_context_length,parallel_slots}'
```

The fields that matter:

| Field | Meaning |
|---|---|
| `context_length` | what this instance was actually loaded with — **the real window, and the only one that governs** |
| `native_context_length` | the Qwen3.8-27B architecture's trained context (262,144). Reported by every build; says nothing about what a given build will serve here |
| `requested_context_length` | what was asked for; `0` means the studio chose |
| `parallel_slots` | concurrent sequences; matches `MAX_LOCAL_SLOTS` = 4 |

All four are `null` for any model that is not currently loaded.

## Swapping the model

```bash
curl -s -X POST http://127.0.0.1:8888/api/inference/load \
  -H "Authorization: Bearer $UNSLOTH_API_KEY" -H 'Content-Type: application/json' \
  -d '{
        "model_path": "unsloth/Qwen3.8-27B-GGUF",
        "gguf_variant": "UD-Q8_K_XL",
        "max_seq_length": 262144,
        "n_parallel": 4,
        "force_reload": true
      }'

curl -s -H "Authorization: Bearer $UNSLOTH_API_KEY" http://127.0.0.1:8888/api/inference/load-progress
```

`model_path` is the only required field. Useful ones: `gguf_variant` (the quant, as `/v1/models`
reports it), `max_seq_length` (**0 = let the studio choose**), `n_parallel`, `cache_type_kv`,
`gpu_ids`, `tensor_parallel`, `llama_extra_args`, `force_reload`. `POST /api/inference/unload`
unloads. Loading a different model replaces the active one — there is one active model at a time.

**Then read back what you got.** `max_seq_length` is a request, not a guarantee; the studio can
serve less. Confirm with the status call above before trusting any window number.

**Then update the repo**, or the run is misconfigured in two ways at once:

1. Add the served id under `provider.local.models` in `experiments/context-dedup/opencode.json`,
   with `tool_call: true` and `limit.context` / `limit.output`. The id must equal llama-server's
   `--alias`. Without the entry, `modelConfig()` records `configured: false` with null limits, and
   `sandboxConfig` throws outright if a window is set.
2. Pin it: `CT_OPENCODE_MODEL=local/<that id>`. `auto` will not pick it — `LOCAL_MODEL` in
   `swebench-endpoint.mjs` is hardcoded to `local/unsloth/Qwen3.8-27B-GGUF`.

### The invariant nothing enforces

> `opencode.json`'s `limit.context` must equal the server's loaded `context_length`.

Nothing checks this. Both failure directions are silent:

- **Declared > loaded** — opencode sends a prompt the server cannot hold. Truncation or an error,
  attributed to the model.
- **Declared < loaded** — half the window is thrown away and the host compacts early. Every
  compaction-threshold number in the analysis is then wrong.

Check it after every load, before every batch.

## The window each build actually serves

**Observed on this machine — this is the operative fact:**

| build | quant | weights | window served | compacts at |
|---|---|---|---|---|
| `HuggingJoost/Swift-Qwen3.8-27B-NVFP4-GGUF` | Swift-NVFP4-Q8mix | 18.4 GiB | **151,040** | 119,040 |
| `jpetrina/Swift-Qwen3.8-27B-IQ4_XS-pure-GGUF` | IQ4_XS | 13.5 GiB | **228,352** | 196,352 |
| `unsloth/Qwen3.8-27B-GGUF` | UD-Q8_K_XL | 30.2 GiB | **262,144** | 230,144 |

The served window bounds what the host can do. It is **not** the basis for the soft limit — that is
an absolute number swept on its own terms; see references/running.md.

The served window does **not** track weight size: the heaviest build gets the largest window and the
mid-weight NVFP4 build gets the smallest. Whatever the studio decides wins — read it, don't model it.

Both Swift rows are the same fine-tune at different quantizations. **Accuracy is not transferable
between them.** The 19/30 baseline (`reports/metrics/swebench-pilot/report-swift-vs-q8.md`) was
measured on NVFP4-Q8mix only; IQ4_XS is a more aggressive pure-4-bit artifact and is un-baselined.
Using it as the instrument means re-establishing the baseline first — 10 problems × 3 repeats.

Two traps follow directly:

- `opencode.json` declares **both** the models it lists at `limit.context: 151040`. Correct for
  Swift-NVFP4 only — 111k short for Q8, 77k short for IQ4_XS. An under-declared run throws the
  surplus away and compacts early, and nothing warns.
- **The IQ4_XS build has no `opencode.json` entry at all.** Running against it without adding one
  gives `configured: false` with null limits, and `sandboxConfig` throws if a window is set.
- `CT_CT_HARD_WINDOW` defaults to `151040` too, and is stale for anything but Swift-NVFP4.

An arm compared across builds is confounded by served window *and* by quantization, not just by the
fine-tune. Pair within a build.

### Reading it, rather than assuming it

`context_length` is populated **only for the currently loaded model**; unloaded entries report
`null` for every context field. So you cannot compare two builds from one query — load one, read it,
load the other, read it.

`native_context_length: 262144` is a property of the **Qwen3.8-27B architecture** and is reported by
every build of it. It is *not* evidence that a given build can be served at that size on this box.
Conflating the two is a mistake that has already been made here: a static `estimate-memory` reading
was used to claim Swift could serve 262,144, against the operator's direct observation that it
serves 151.0k. The loaded `context_length` is the answer; the estimator is a planning aid.

## What the model actually is

Qwen3.8-27B is a **hybrid attention model**, not a dense transformer. 64 layers plus an MTP head:

| Layers | Mechanism | Grows with context? |
|---|---|---|
| 16 | full attention (q/k/v/o) | yes — a real KV cache |
| 48 | Gated DeltaNet linear attention (`attn_qkv`, `attn_gate`, `ssm_out`) | no — fixed-size recurrent state |
| blk.64 | MTP head (`nextn.eh_proj`), for self-speculative decoding | — |

Confirmed two ways: the server reports `n_layers: 65` (64 + the MTP head), and the estimator's KV
figures fit **64.0 KiB/token + 0.60 GiB fixed** exactly across four context sizes. 64 KiB/token is
16 layers × 2 (K,V) × 1024 × 2 bytes — sixteen KV-bearing layers, not sixty-four. The 0.60 GiB
constant is the DeltaNet recurrent state. This is why KV is cheap here relative to a dense 27B.

**This gives U18 a mechanistic basis.** Three quarters of the layers compress history into a
fixed-size state rather than attending over it exactly, so "effective context < served context" is
structural for this architecture, not just an empirical attention-decay observation. It does not
prove the hypothesis — it means a negative result would be the surprising one.

### Swift-NVFP4-Q8mix, tensor by tensor

The "Q8mix" half of the name is load-bearing — only the bulk compute is 4-bit:

| Tensors | Quant | In the checkpoint |
|---|---|---|
| All MLP (64 × gate/up/down) + full attention q/k/v/o (16 layers) — 256 tensors | NVFP4 | byte-identical to UkisAI's llm-compressor NVFP4, per-tensor scales |
| Gated DeltaNet linear attention (`attn_qkv`, `attn_gate`, `ssm_out`, 48 layers) | Q8_0 | BF16 |
| `output` (lm_head), `token_embd` | Q8_0 | BF16 |
| MTP head (blk.64, incl. `nextn.eh_proj`) | Q8_0 | BF16 |
| `ssm_alpha`, `ssm_beta`, `ssm_conv1d` | F32 | BF16 (lossless) |

Everything precision-sensitive — embeddings, the output head, the whole DeltaNet path, the SSM
scalars — is held at Q8_0 or F32. That is the likeliest reason it matched UD-Q8_K_XL at 19/30.

**`IQ4_XS-pure` is "pure" in exactly the sense that matters: it quantizes what Q8mix protected** —
lm_head, token_embd and the DeltaNet path all go to 4-bit. It is a materially more aggressive
artifact and its accuracy is unmeasured. Do not read the NVFP4 baseline across to it.

### The speculative drafter is auto-selected and differs per build

`speculative_type: "auto"` picks a drafter at load. Observed: the NVFP4 build ran
`--spec-type ngram-mod`; the IQ4_XS build reports `spec_drafter_kind: "mtp"` (it can use the MTP
head). Rejection sampling makes speculative decoding output-distribution-preserving, so this should
not move accuracy — but it **does** move wall time, and it is not recorded in any results file.
Treat wall-time comparisons across builds as carrying an unrecorded covariate until the drafter is
captured per run.

## Estimating memory

Useful for asking what a configuration would cost, not for deciding what is possible:

```bash
curl -s -X POST http://127.0.0.1:8888/api/inference/estimate-memory \
  -H "Authorization: Bearer $UNSLOTH_API_KEY" -H 'Content-Type: application/json' \
  -d '{"model_path":"unsloth/Qwen3.8-27B-GGUF","gguf_variant":"UD-Q8_K_XL","n_ctx":262144,"n_parallel":4}'
```

**`available: true` is not a VRAM check.** It returns `true` at 100 GiB on a 63.7 GiB box — it means
"the estimate is computable". Compare `total_bytes` to VRAM yourself and leave headroom.

## This machine

2× NVIDIA RTX 5090, 32,607 MiB each = **63.7 GiB** total VRAM. 123 GB system RAM.

Measured by `estimate-memory` at `n_parallel: 4`, f16 KV:

| build | weights | KV @151k | total @151k | KV @262k | total @262k |
|---|---|---|---|---|---|
| Swift-Qwen3.8-27B-NVFP4-Q8mix | 18.4 GiB | 9.8 GiB | 31.8 GiB | 16.6 GiB | **39.2 GiB** |
| UD-Q8_K_XL | 30.2 GiB | 9.8 GiB | 44.0 GiB | 16.6 GiB | **51.3 GiB** |

Read the table as cost, not as permission. The estimator says Swift at 262,144 would occupy 39.2 GiB
of 63.7 GiB — and the studio nonetheless serves that build at 151.0k. **Whatever the studio decides
wins.** The gap between this arithmetic and the served window is unexplained and has not been chased;
treat it as a known unknown rather than something to argue with.

Two levers when a configuration is genuinely too big: `cache_type_kv: "q8_0"` (saves ~5 GiB at 262k)
and `n_parallel` (4 → 1 saves ~3 GiB).

### The `llama-server` command line

Worth reading once — several harness assumptions come from it:

```
--parallel 4 --kv-unified --flash-attn on --no-context-shift -c 151040
-ngl -1 --fit off --spec-type ngram-mod --jinja
--chat-template-kwargs {"enable_thinking": true, "preserve_thinking": true}
```

- **`--kv-unified`** — `--parallel 4` does *not* split the context into four 37,760-token slices.
  One sequence can use the whole window.
- **`--no-context-shift`** — overflow is an error, not a silent slide. Good: it cannot hide.
- **`enable_thinking: true`** — thinking is on at the server, which is why every run has reasoning
  parts. The server still reports `reasoning_tokens: 0`; measure `reasoning_chars` from the export.
- **`--spec-type ngram-mod`** — speculative decoding is n-gram based, no draft model, so the
  estimator's `drafter_runtime_bytes` overstates this configuration slightly.

## Concurrency

Four slots, leased through `/mnt/data/ctx-swebench/locks/local-model`. The server exposes no health,
queue or slot endpoint (all 404), and GPU utilisation does not distinguish busy from idle — agents
spend most wall-clock in tools, so an instantaneous probe reads ~1%. Counting **sessions** is the
only signal that works: this repo's leases plus a scan for foreign local-model clients.

Over-subscribing does not degrade gracefully. It hangs opencode at init, invisibly. Always
`CT_LOCAL_EXCLUSIVE=1` for a real run.
