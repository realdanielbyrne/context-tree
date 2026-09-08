# Attention over history: qualification report

Date: 2026-09-08

## Executive summary

Two fresh native qualification runs were completed or settled against official
Datacurve DeepSWE tasks with GLM 5.3 Flash. Neither task qualifies for an n=5
attention-policy comparison.

`aiomonitor-task-snapshots-diff` has no score. The run returned ten model
responses, including two empty completions handled by the registered identical
retry, then its thirteenth provider attempt reached the inherited ten-minute
request timeout. It has 154,236 observed all-model tokens, but total usage, cost,
task outcome and verifier evidence remain unknown.

`abs-module-cache-flags` completed and has a verifier-backed binary score of 0.
Its diagnostic partial score is 0.1304: all 3 preservation tests passed and all
20 feature tests failed. The model edited four files but did not commit them.
Because the benchmark task explicitly requires a commit and the submission
contract collects committed changes, `model.patch` is empty and the verifier
correctly graded the pristine base. This score establishes a submission failure
under the tested agent protocol; it does not measure the quality of the
uncommitted working tree.

No attention policy ran in either qualification arm. These results are baseline
qualification evidence only. They provide no treatment comparison and support no
default-policy promotion.

## 1 Question and decision rule

The qualification question was whether a public, multi-turn software task is
solvable by the native GLM 5.3 Flash agent under the same durable capture and
verifier contract intended for later policy comparisons. A task qualifies only
when one fresh run completes, submits the model's committed patch, receives a
verifier-backed passing score, and has complete usage accounting.

Qualification is stricter than observing useful edits or passing preservation
tests. An error has score `null`, not 0. A completed verifier failure has score 0.
A partial diagnostic is reported separately from the benchmark's binary reward.

## 2 Frozen setup

- Official DeepSWE source commit:
  `0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea`.
- Model: `z-ai/glm-5.3-flash` through OpenRouter, provider-default sampling.
- Arm: native full-history transcript with exact tool call IDs, names, arguments
  and results.
- Physical model window: 1,310,720 tokens.
- Qualification ceiling: 3,027,706 reported all-model tokens, sized at twice the
  largest historical step-8 run.
- No turn cap, run-duration cap or harness reply limit.
- OpenAI SDK retries: 0. Harness provider attempts: 1. Empty completions receive
  one explicit identical retry, with both attempts captured.
- Agent and verifier containers have no network. Pristine and reference-patch
  gates passed before dispatch. Hidden verifier inputs never entered the agent
  container.
- Dollars use the repository price table and are estimates, not invoices.

The two task manifests have separate epochs because each freezes a different
scenario. They are not paired comparison cells.

## 3 Current-run scores

| Task | Terminal status | Binary score | Diagnostic partial | Evidence verified | Qualification |
| --- | --- | ---: | ---: | --- | --- |
| `aiomonitor-task-snapshots-diff` | provider error | null | null | no | no |
| `abs-module-cache-flags` | completed | 0 | 0.1304 | yes | no |

For ABS, the verifier reported P2P 3/3 and F2P 0/20. The binary DeepSWE reward is
therefore 0. The model patch has SHA-256
`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`,
the digest of an empty file. The submission record shows the base commit as HEAD
and a dirty working tree containing modifications to `evaluator/functions.go`
and `repl/repl.go`, plus new `evaluator/module.go` and
`evaluator/module_test.go`. Those bytes were captured as tool evidence but were
not eligible submission content under the committed-only contract.

## 4 Usage and execution

| Task | Provider attempts | Provider errors | Model turns | Tool calls | All-model tokens | Estimated cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `aiomonitor-task-snapshots-diff` | 13 | 3 | 10 | 16 | null (154,236 observed) | null ($0.004082 observed estimate) |
| `abs-module-cache-flags` | 49 | 0 | 49 | 67 | 1,490,544 | $0.04304543 |

ABS's complete token split is 169,846 uncached input, 44,666 output, 1,276,032
cache-read and 0 cache-write tokens. Aiomonitor's observed split is 26,756
uncached input, 696 output, 126,784 cache-read and 0 cache-write tokens. Because
its final timed-out request has unknown usage, neither its complete token total
nor complete cost is reported.

Aiomonitor's three provider-error events comprise two captured empty completions
and the terminal timeout. The run stopped before any write-bearing turn and has
no verifier result. ABS completed in about 27.9 minutes, produced a final text
response, and ran the independent verifier successfully.

## 5 Interpretation

The instrument now distinguishes transport failure with unknown outcome,
completed benchmark failure, and verified success. Partial observed usage
survives error reporting without becoming a complete total.

The ABS result also exposes a protocol boundary. The agent did substantial work,
but the benchmark requested a commit and the final repository HEAD remained at
the base commit. Grading the dirty working tree after the fact would change the
registered submission contract and reward behavior that violated the task. The
0 is valid for this run. It is not evidence that the attempted code itself passes
0/20 feature tests; that code was not submitted to the verifier.

The current runs do not test whole versus excerpt payloads, ledger injection,
H1-H6, priority, breadth, phase signals or demand expansion. Their
`mechanismEvents` values are zero by design. The earlier offline replay shows a
measurable whole-versus-excerpt intervention for aiomonitor file reads, but no
quality conclusion can be attached without a qualified baseline and paired live
runs.

## 6 Decision

Do not schedule a scored n=5 attention-policy comparison on either current task.
Aiomonitor lacks a score and complete accounting. ABS has a verified score of 0
caused by an empty committed submission. Neither meets the preregistered
baseline-solvability gate. No profile is promoted and no product default changes.

## 7 Next steps

1. Add a submission-readiness gate before the agent's terminal answer. It should
   expose whether HEAD differs from the base and whether tracked or untracked
   changes remain, then give the agent one ordinary model turn to satisfy the
   task's existing commit requirement. This is an agent-protocol change and must
   be preregistered in a new epoch; the current ABS score remains unchanged.
2. Make request transport an explicit frozen field. Test OpenRouter streaming or
   an explicit timeout policy in a qualification-only pilot, retaining zero
   hidden retries and exact usage provenance. Do not reinterpret aiomonitor's
   null score.
3. Requalify one public task per repaired protocol with n=1. Require a non-empty
   committed patch, verified reward 1, complete usage, and durable capture. If a
   task still fails, select another official task rather than tuning attention
   against a baseline the agent cannot solve.
4. Derive the scored comparison's token ceiling from completed qualified pilots,
   then freeze native, tree and one mechanism-isolated candidate in the same
   epoch at equal n=5. The first eligible payload comparison is whole versus the
   declared 1,000-character excerpt on `read_file` producers; rarest anchoring
   and structural selection remain ineligible on current evidence.
5. Escalate once to n=10 only when the registered n=5 comparison is ambiguous.
   Confirm a compatible winner on held-out tasks and Sonnet before considering a
   default change.

## 8 Reproducibility and artifacts

- `attention-policy-continuation/pilot-native-aiomonitor-v4/results.json`
  (SHA-256 `4b5719eb15acf42813e450eb0ed389ec421a52537d3ccbb78c9637da68215cac`).
- `attention-policy-continuation/pilot-native-abs-v4/results.json`
  (SHA-256 `f1abff4fec7f60c4be618d654431619547ecb65aa3f9a70ed9a1880f69d29f54`).
- ABS reward artifact
  (SHA-256 `f4d45f32ddb3514e84217611d041e08d2e2f7319a7654c78305527392b9a862f`).

The manifests, frozen instrument hashes, schedules, attempt markers, provider
request/response blobs, tool evidence, verifier images, submission record and raw
test output live beside those result files. Earlier v2 and v3 attempts remain in
the continuation directory and are excluded from the current-run score table.

Repository validation for the instrumentation change: full check 1,120 tests
passed with 9 skipped; focused attention/experiment/runner check 45/45; offline
attention replay 6/6; DeepSWE importer 5/5; TypeScript build and typecheck passed.
These checks validate the harness and reporting invariants, not task success.
