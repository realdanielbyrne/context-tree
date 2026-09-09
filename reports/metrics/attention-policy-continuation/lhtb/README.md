# Long-Horizon-Terminal-Bench (LHTB) integration gates

Source: https://github.com/zli12321/LHTB.git, commit
`1ece75aa255307a01430a754ce91f732e0ae6bb6` (47 task directories, task schema 1.1;
the README advertises 46). Every one ships `tests/` and `solution/`.
Two tasks are imported for development — `great-expectations-audit` and
`langchain-version-migration` — and neither needs Git LFS.
`import-manifest.json` retains their per-file SHA256 hashes, their whole-task
`sourceHash`, and their original `task.toml` metadata. Reference solutions are
recorded by hash but are **never materialized** into the imported task data.

`gates.json` records four independent-verifier outcomes, with raw verifier
artifacts in the correspondingly named directories. **No model calls were made
for these gates.** They are instrument checks — not scored agent arms, and not
evidence for any attention policy.

| gate | reward | pytest | verifier exit |
| --- | --- | --- | --- |
| `great-expectations-audit` pristine | **0.0** | 0 / 11 | 1 |
| `great-expectations-audit` reference | **1.0** | 11 / 11 | 0 |
| `langchain-version-migration` pristine | **0.0** (raw `0`) | 0 / 0 (fails closed before pytest) | 1 |
| `langchain-version-migration` reference | **1.0** | 1 / 1 | 0 |

## What LHTB grades, and why the reward is not a bit

Two facts separate LHTB from DEEPSWE and shape the adapter:

1. **The submission contract is a file list, not a git commit.** `task.toml`'s
   top-level `artifacts` names the paths the agent must produce. Nothing is
   collected as a patch, and the agent's own report of success is worth nothing.
2. **The reward is dense.** `tests/test.sh` writes a float in `[0, 1]` to
   `/logs/verifier/reward.txt`. `great-expectations-audit` derives it as
   `passed / total` over 11 pytest cases; `langchain-version-migration` derives
   it from a weighted gate table its `test_outputs.py` writes to
   `/logs/verifier/migration_details.json` while exposing a single pytest case.
   The harness therefore stores `reward`, `passed` and `total` **separately**
   and flags whether they agree (`rewardMatchesPassedTotal`) — it never folds
   the reward into a pass/fail bit. `success` is a derived convenience only.

A failing test suite makes `test.sh` exit nonzero *by design*, so exit status is
not an infrastructure signal here. A **missing or out-of-range reward** is: that
fails loud, as do a changed task file, a staged hidden test whose bytes differ
from the pinned import, a hidden test or reference solution found inside the
agent container, and an exported symlink escaping the submission.

## Verifier isolation

The agent works in an unmounted container started from the official task image,
with networking set from `task.toml`'s `allow_internet` (bridge for
`great-expectations-audit`, none for `langchain-version-migration`). Its
filesystem is asserted free of `/tests` and `/solution` before any work starts.

At grade time the submission crosses to the host as files under
`<gate>/submission/`, and a **second** container is started from the pinned
verifier image. The hidden tests are copied into that container only — the one
`docker cp` targeting `/tests` is asserted in
`eval/test/lhtb.test.ts` to address the verifier container, never the agent's —
and every staged test byte is re-hashed inside the container against the pinned
import before `/tests/test.sh` runs.

What is transferred depends on the task's declared verifier mode:

- `shared` (`great-expectations-audit`, no `[verifier.environment]`): upstream
  Harbor grades in place, so the whole `/app` tree moves and the verifier's
  `/app` is wiped first. This is needed because three of its eleven tests
  *execute the agent's pipeline* on a hidden dataset rather than reading
  `outputs/`.
- `separate` (`langchain-version-migration`): exactly the declared `artifacts`
  move, and nothing else. Missing artifacts are recorded, not silently
  tolerated; the task's own `test.sh` then fails closed on them.

**No verifier image is built.** This host is aarch64 with no `buildx`, and the
legacy builder cannot export a child of a single-platform `linux/amd64` image —
`docker build` of `FROM <amd64 image>` fails with `failed to export image: no
match for platform in manifest ...: not found` (reproduced with both the tag and
the resolved image ID as `FROM`). Staging tests into the verifier *container*
achieves the same isolation with no builder at all, and the per-file hash check
replaces the image-provenance label a built image would have carried.

## Reproduce

```sh
git clone https://github.com/zli12321/LHTB.git /tmp/lhtb
git -C /tmp/lhtb checkout 1ece75aa255307a01430a754ce91f732e0ae6bb6

python3 eval/scripts/import-lhtb.py \
  --source-dir /tmp/lhtb --output eval/scenarios/lhtb \
  --tasks great-expectations-audit,langchain-version-migration

pnpm exec tsc --build eval

export DOCKER_DEFAULT_PLATFORM=linux/amd64   # required on Apple Silicon
node eval/scripts/preflight-lhtb.mjs \
  --scenarios-dir eval/scenarios/lhtb \
  --tasks great-expectations-audit,langchain-version-migration \
  --output reports/metrics/attention-policy-continuation/lhtb \
  --prepare --pristine --reference --source-dir /tmp/lhtb
```

The importer verifies every materialized byte against the committed blob at
`HEAD` (the dev checkout has an LFS-bypass index, so `git status` cleanliness
proves nothing) and refuses to write anything at all if any selected task is
malformed. `eval/scenarios/` is gitignored, so the import is local-only and the
hashes in `import-manifest.json` are the in-repo record.

The reference gate resolves `solution/` from `--source-dir` — never from the
import — after checking each solution file against the recorded hash, and runs
it in a fresh diagnostic container. No scored agent container ever has that
filesystem.

## Deterministic verification

```sh
npx vitest run eval/test/lhtb.test.ts eval/test/adapters.test.ts eval/test/deepswe.test.ts
python3 -m unittest eval.test.lhtb_importer_test
```

18 adapter/sandbox tests + 9 importer tests, all passing; `adapters.test.ts` and
`deepswe.test.ts` are included because the registry grew by one entry. Container
gates were executed with Docker 29.5.2 on aarch64 with
`DOCKER_DEFAULT_PLATFORM=linux/amd64`. Task limits come from each task's own
`task.toml`; no new agent turn, wall-clock or reply limits were introduced.

## Open items

- Only 2 of the 47 task directories are imported. The other 45 include LFS
  assets and have not been validated against this importer.
- `langchain-version-migration`'s dense reward comes from a weighted gate table,
  so its `passed`/`total` (1/1) is a pytest count and not the reward's
  denominator. The gate breakdown is preserved in the exported
  `migration_details.json`, but the harness does not parse it into a metric.
- `verifierBuildTimeoutSec` is imported and recorded but currently unused,
  because nothing is built.
