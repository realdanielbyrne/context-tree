# Attention-policy continuation journal

## 2026-09-08 — accepted scope and instrument epoch

User authorized implementation and parallel subagents after the DS-STAR design panel.
The final user corrections govern this pass: whole response preservation is a
hypothesis, not a default; no forced 25/50% context target; public multi-turn
software tasks are primary, recall questions diagnostic. GLM 5.3 Flash is the
primary model and Sonnet 5 confirms combined winners. Every live candidate uses
same-epoch equal n=5, one equal escalation to n=10 for ambiguity, pilot-derived
token ceilings, and no default promotion before checkpoints and holdout checks.

The original report and supporting artifacts were audited before coding. Existing
assembly/cache/loop/metrics tests passed 118/118. Historical task records lack
assistant transcripts and exact payloads, so historical attention/H4 replay is
unavailable; recorded task fetch AUC is null (zero context-tool calls). New durable
capture is required. The local `deepswe-agents-last-exam` rows are generated fixtures.

### Ordered work

1. Repair delivery receipts, capture, retry/accounting, and independent benchmark execution.
2. Gate public benchmark environments/reference solutions, qualify baseline-solvable tasks.
3. Isolate excerpt anchoring and ledger; compare excerpt/whole/structural payloads.
4. Test H1/H3/H6, priority, breadth, phase signals and demand independently, checkpointing
   at most three iterations per pass. Unsupported/inert mechanisms do not get live batches.
5. Confirm compatible winners on held-out tasks and Sonnet; report and promote only supported profiles.

Live batches have not begun. Their task manifests, measurable mechanisms, exact
model settings, and pilot-sized ceilings must be written here before dispatch.

### Environment

Docker/Colima were initially absent. Docker CLI and Colima installation was approved;
the local evaluation VM is being started. Provider key names are present in the
workspace dotenv; values are never written to the report or capture headers.

### Pre-registration: public-task qualification pilot 1

- Official Datacurve DeepSWE commit `0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea`,
  `abs-module-cache-flags`; pristine verifier reward 0, reference-patch reward 1.
- GLM `z-ai/glm-5.3-flash` via OpenRouter, provider-default sampling, native arm,
  n=1 qualification. No claim of treatment effect from this pilot.
- Physical provider window 1,310,720; `gpt-tokenizer@4.0.0/o200k_base` counts
  serialized provider-neutral requests as an estimate for this model.
- All-model ceiling 3,027,706 tokens, twice the largest historical step8 run
  (1,513,853). The ceiling stops the next call and may overshoot by one response.
  No turn, session-duration, or reply-length ceiling is introduced. Official
  verifier timeouts and the existing common per-command tool contract remain.
- Completed public pilots will determine the next stage ceiling. Nop/reference
  tests establish a valid instrument; only the model pilot establishes baseline
  solvability. Reference patches and hidden verifier files never enter scored
  agent containers. Tasks require model-created commits, per the benchmark.
- `pilot-native-abs.json` records settings; the runner freezes sources, compiled
  modules, manifest, gate hashes and policy environment before dispatch.
- Current published provider prices vary by routing. Dollar values use the
  repository price table and are estimates, not provider invoices; tokens with
  the cache split are the primary effort endpoint. Provider-neutral capture is
  exact at that interface and is not represented as exact HTTP wire capture.

Sources: [GLM model context and routing](https://openrouter.ai/z-ai/glm-5.3-flash),
[official DeepSWE](https://github.com/datacurve-ai/deep-swe).

### Implementation checkpoint 1 — deterministic gates

Delivered: immutable payload selection identities and explicit delivery receipts;
assembly no longer marks data consumed while merely constructing a candidate.
Failed sends do not acknowledge payloads. Original provider/tool responses remain
in content-addressed capture and L0/L2; selected payloads have separate records.
One identical retry for empty GLM answers preserves both attempts and known usage.
The old tree capture flag no longer controls durable tool-result evidence.

Core experiment primitives cover H1 current-turn irrelevance with recurrence,
H2 candidate relevance mass, H3 plan protection, H4 assistant sufficiency/topic
signals, H5 explicit-demand expansion and H6 exchange/subtask/all retention.
Priority is deterministic over supplied prefix references with explicit calibration
IDs. No live host inference invents missing relevance, plan, or reference labels.
The synthetic API→UI→tests test proves mechanism invariants only; it is not a
public benchmark score or fitted calibration. Unsupported structural payloads
remain explicit fallbacks and receive no mechanism credit.

The payload experiment can name its producers. The existing default covers context
tools only. A separately declared `['context', 'read_file']` profile compares file
context too, giving a measurable producer boundary on real software tasks without
forcing the model to call a retrieval tool. Results from file reads will not be
presented as evidence for Augment/Graft/Serena/vector search as a whole.

Initial full check: typecheck passed; 1,071 tests passed, 9 skipped, 2 registry
expectations failed because the public DeepSWE adapter makes six adapters. Those
expectations were updated to include the new adapter. New model-usage and runner
integrity tests are being added before the scored epoch.

Independent review found runner gaps around dotenv ordering, complete gate binding,
resumed evidence, interrupted attempts and n5→n10 continuation. It also identified
successful provider responses with missing usage being represented as zeros.
These are being repaired before comparison. The in-flight n1 pilot remains
qualification evidence only; `.env` currently contains no EVAL_ variables, so the
identified dotenv issue does not alter its policy settings.

### Pilot 1 disqualified — action metadata defect

The native transcript contained tool name+output but omitted call IDs and arguments.
Thus an empty assistant tool-call turn followed by a file read did not identify
the read path, and command output did not identify its command. This is an invalid
full-history baseline, not evidence for a ledger policy. The pilot was interrupted
after 12 returned responses and 396,416 reported tokens. The in-flight request
has unknown usage; total usage, cost and task outcome remain null. Its worktree
was clean. No failure is assigned to GLM or the benchmark.

The repair preserves exact call IDs/arguments in a shared result header, including
file paths and commands. All transcript-based arms use the same representation.
The core tree already retains tool_call args in L0. SDK/provider retries are also
disabled explicitly in subsequent experiments; the original run could not expose
internal transport retries. Preserved-thinking remains a separate, untested model
option; it is not silently enabled.

### Pre-registration: repaired qualification pilot 2

`pilot-native-aiomonitor-v2.json`: GLM 5.3 Flash, official
`aiomonitor-task-snapshots-diff`, native arm, n=1. Nop0/reference1 gates and
all raw verifier files are now durable at `deepswe/preflight.json` and its
referenced subdirectories. The same historical3,027,706-token sizing ceiling is
validated from source hashes and recorded all-model sums; no historical result
supplies an efficacy comparison. The new run freezes complete call metadata
(`tool-result-call-v1`), SDK maxRetries0, provider attempts1, explicit policy
environment, runtime, source and compiled module hashes. Empty answers still get
one explicit identical harness retry with both attempts recorded. All other
model/window/sampling/stopping settings match the prior qualification design.

This is qualification after an instrument repair, not a policy-treatment test.
The native request representation preserves action/result history; provider
thinking continuation remains at the existing model default. The optional
preserved-thinking behavior is a separate hypothesis, not silently added here.

`pilot-native-abs-v2.json` registers the corresponding repaired ABS qualification
with identical settings/ceiling and a fresh container. It can run alongside the
Python qualification; neither is a treatment comparison or latency benchmark.
The interrupted original ABS run remains separate and is never reused as a
paired baseline.

### Recovery checkpoint — qualification v2

The aiomonitor v2 run ended on an OpenRouter request timeout after 10 returned
responses and 11 attempts. It has 112,336 observed all-model tokens; complete
usage, cost and task outcome remain null. The ABS v2 process stopped with its
tenth request pending after nine returned responses and 92,162 observed tokens.
The existing runner recovered that slot as interrupted without issuing another
model call. Neither run establishes baseline solvability or model failure.

The cohort reducer incorrectly read complete totals when summarizing observed
usage, hiding both partial token counts. It now uses the explicit observed field,
retains null complete totals, and supports older rows without that field. A
regression test covers partial usage, unknown and zero observations, mixed
cohorts and non-promotion. The pre-change full check passed 1,120 tests with nine
skipped; the corrected cohort/runner tests passed 34/34 and the build passed.
`qualification-recovery-summary.json` binds corrected summaries to the original
result hashes; original frozen summaries and captures are retained.

### Pre-registration: qualification v3

`pilot-native-aiomonitor-v3.json` and `pilot-native-abs-v3.json` register one
fresh native qualification attempt each after the timeout/process interruption.
They retain the v2 model, task, transport, sampling, window and historical
3,027,706-token ceiling settings, with new output directories and a new instrument
epoch for the reporting correction. No treatment comparison or automatic retry
of a failed slot is introduced. Both earlier attempts remain in the journal and
recovery ledger. Each new task still requires independently verified completion
before it can qualify a scored same-epoch n=5 comparison.

### Offline replay checkpoint

`qualification-v2-policy-replay.json` replays both v2 captures using the declared
1,000-character excerpt envelope. Aiomonitor supplies 15 measured file payloads;
whole versus excerpt is a measurable intervention, while first versus rarest
anchoring changes zero selections. Structural selection lacks a verified
partition. ABS supplies no payloads inside the declared producer boundary: its
reads used commands. Both runs contain zero context-tool calls and zero phase
signals. H1–H6 and priority remain ineligible for live comparisons under the
recorded label/calibration requirements. No task-quality conclusion follows.

The six offline replay tests and five Python importer tests pass, as do the final
typecheck and build. The graph was refreshed. Both v3 runners' 601 frozen source,
compiled and dependency-manifest hashes were checked after validation with zero
differences. The orphaned v2 ABS container was stopped after confirming it still
had the pristine base commit and a clean worktree; it was retained on disk.
See `qualification-checkpoint.md` for the qualification and comparison gates.
