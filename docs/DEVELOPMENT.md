# Development environment

Reproducible setup for working on `context-tree` from more than one machine.

## One-time setup (either machine)

```bash
./scripts/dev-setup.sh
```

That checks Node, enables pnpm via corepack, installs, and typechecks. Or do it by hand:

```bash
# Node >= 22 — pinned in .nvmrc. On Node 20 the better-sqlite3 native module
# segfaults and the vitest worker pool is unstable, so 22+ is required, not optional.
nvm install        # reads .nvmrc
nvm use

# pnpm is pinned by package.json "packageManager"; corepack fetches that exact
# version. If `pnpm` is "command not found", you just haven't enabled the shim:
corepack enable

pnpm install       # builds/fetches the better-sqlite3 binary for this Node
```

## Everyday commands

```bash
pnpm exec vitest run                 # full test suite (offline; no network)
pnpm exec vitest run packages/core   # one package
pnpm exec tsc -b tsconfig.json       # typecheck the workspace (project references)
pnpm test                            # the package.json script
```

If a machine's `vitest` run dies on worker teardown (`ERR_IPC_CHANNEL_CLOSED` /
`Channel closed`) rather than on an assertion, run it single-fork:

```bash
pnpm exec vitest run --pool=forks --poolOptions.forks.singleFork=true
```

Tests are **offline by default** (no network, recorded completions). Live-model
tests are opt-in with `LIVE=1` plus the relevant API key in `.env`.

## The two-machine split

Package/library development (everything under `packages/`) needs **only Node 22 +
pnpm** and runs identically on both machines — no model, no network.

The difference is the **experiments** under `experiments/`, some of which call a model:

| | This workstation (local-model capable) | The laptop |
|---|---|---|
| `packages/` build + tests | ✅ | ✅ |
| Offline experiments | ✅ | ✅ |
| Experiments needing a **local** model | ✅ via the local server | ❌ — use a hosted model instead |
| Experiments needing a hosted model | ✅ (`LIVE=1` + key) | ✅ (`LIVE=1` + key) |

- **Local models (this workstation):** an OpenAI-compatible server at
  `http://127.0.0.1:8888/v1`. Experiment scripts select a model with
  `CT_LOCAL_MODEL=<id>` (e.g. `unsloth/Qwen3.8-Flash-Next-GGUF`). The laptop can't
  run these; point those experiments at a hosted model or run them on this box.
- Nothing in `packages/` depends on the local server — it is experiment-only.

## Secrets

API keys live in `.env` (git-ignored — see `.gitignore`). Never commit it. Each
machine keeps its own `.env`. (If a key is ever exposed, rotate it.)

## The tree-sitter native-build fix (Linux)

`tree-sitter@0.25.x` ships a Linux prebuilt (`prebuilds/linux-x64/tree-sitter.node`)
that **dynamically links the system `libnode.so`** (e.g. Debian's `nodejs`/node-20
package). Run under a *different* Node (nvm's Node 22), that pulls a **second Node
runtime** into the process, which **segfaults** the instant tree-sitter coexists with
another native addon — and `better-sqlite3` + tree-sitter is exactly what the ingest
pipeline and the whole `packages/mcp` test suite load together. Symptom:
`vitest run packages/mcp` dies with `ERR_IPC_CHANNEL_CLOSED` / `Channel closed` and
`0 passed`, while `packages/core` (whose files each load only *one* addon) is fine.

The fix — automated, nothing to do by hand: the root **`postinstall`** runs
`scripts/rebuild-tree-sitter.sh`, which deletes tree-sitter's prebuilt and recompiles
it **from source against the running Node**, so it resolves Node symbols from the host
process (no `libnode` link). A source build is always clean; only the prebuilt is
broken. This means:

- It needs a C/C++ toolchain: `python3`, `make`, `g++` (present on most dev boxes;
  `sudo apt install -y build-essential python3` if not).
- It re-runs on every `pnpm install` (installs re-fetch the broken prebuilt).
- If you ever see the `Channel closed` crash, run it manually:
  `bash scripts/rebuild-tree-sitter.sh` (or `pnpm run postinstall`).

macOS/Windows prebuilts don't link a shared libnode, so the script no-ops there.

## Why Node 22 specifically

- `better-sqlite3` ships a prebuilt binary per Node ABI; on Node 20 the version
  installed here mismatches and **segfaults** in the test workers.
- `.nvmrc` pins `22` so `nvm use` gives both machines the same major. `pnpm` is
  pinned by `packageManager` in `package.json`, so corepack gives both machines the
  same pnpm — you never install pnpm globally.
