# Official Datacurve DEEPSWE integration gates

Source: https://github.com/datacurve-ai/deep-swe, commit
`0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea` (public v1.1 tasks, Harbor schema 1.3).
The downloaded archive SHA256 is
`4371bf83523ffece2c992c81af6774fddda80b80661b2486b4944b80fd654198`.
All 113 tasks imported successfully; `import-manifest.json` retains the selected
two tasks' file hashes and original metadata. Reference solutions are excluded
from the imported agent task data.

`gates.json` records four official independent-verifier outcomes, with raw
verifier artifacts in the correspondingly named directories. No model calls
were made for these gates. Pristine tasks scored zero, with all original P2P
tests passing; the official reference patches scored one. These are instrument
checks, not scored agent arms or evidence for any attention policy.

`preflight.json` is the runner-compatible gate document for both tasks. Its
artifact references point into this report directory, including the collected
patches needed to revalidate hashes. These host-side reference artifacts never
enter scored agent containers. Reimporting the pinned archive at another path
does not require temporary gate files. If Docker images must be rebuilt and
their IDs change, rerun the gates against those new images before qualification.

The agent operates in an unmounted, network-disabled task container. At the
end, the benchmark's original `verifier.collect` hook exports committed changes
only. A second container starts from the independently built official
`tests/Dockerfile`, receives only that patch, and runs `/tests/test.sh`.
Uncommitted changes are reported in `submission.json`; they are not included in
the official committed-patch evaluation. Infrastructure failure, missing reward,
nonbinary reward, base-commit mismatch, changed task files, and verifier-image
ancestry mismatch fail explicitly.

Reproduce after installing Docker and building the evaluation package:

```sh
python3 eval/scripts/import-deepswe.py --output /tmp/deepswe-import
pnpm exec tsc --build eval
node eval/scripts/preflight-deepswe.mjs --scenarios-dir /tmp/deepswe-import --tasks abs-module-cache-flags,aiomonitor-task-snapshots-diff --prepare --nop --output /tmp/deepswe-nop-gates
```

To run the reference gate, supply the same immutable archive used for import:

```sh
node eval/scripts/preflight-deepswe.mjs --scenarios-dir /tmp/deepswe-import --tasks abs-module-cache-flags,aiomonitor-task-snapshots-diff --reference-archive /path/to/pinned-official-archive.tar.gz --output /tmp/deepswe-reference-gates
```

Reference patches enter only fresh diagnostic containers with no model calls.
Scored runs always start from fresh base images. Image IDs and task provenance
are retained with each gate submission; the verifier image is built using the
resolved task image ID rather than a mutable `FROM` tag.

Deterministic verification: `pnpm exec vitest run eval/test/deepswe.test.ts
eval/test/tools.test.ts` passed 23 tests; `python3 -m unittest discover -s
eval/test -p '*_test.py'` passed 5 importer tests. Container gates were executed
with Docker 29.5.2 on Colima; these tasks' limits come from their official
`task.toml` files. No new agent turn, wall-clock, or reply limits were introduced.
