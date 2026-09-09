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

### Qualification v3 recovery and v4 terminal results

The interrupted v3 shells left valid attempt markers but no result rows. On
re-entry, the runner consumed both slots as explicit interrupted attempts, as
designed. Fresh v4 output directories retained the same scientific inputs and
epochs; only the output paths changed.

Both v4 runs are now terminal. Aiomonitor ended after 13 attempts on a provider
timeout following ten returned responses and two recorded empty completions. Its
score is null, with 154,236 observed tokens and unknown complete usage/cost.
ABS completed after 49 calls and 1,490,544 all-model tokens. Its verifier-backed
binary score is 0, diagnostic partial 0.13043478260869565 (P2P 3/3, F2P 0/20).
The agent left four files dirty but did not commit, so the committed-only
submission patch was empty and the pristine base was graded. Neither task
qualifies for n=5 treatment comparison. The final write-up is
`../attention-policy-continuation-report.md`.

## 2026-09-08 evening — DS-STAR iteration 1: the record correction and the router's re-derivation

### Record correction (user, 2026-09-08 evening)

The 25–50% soft occupancy target was **not withdrawn**. The user clarified only that it is
not a *hard requirement*. Its status is identical to attention-over-history: a live
hypothesis with no evidence for or against it. The prior pass recorded it as "withdrawn by
the user" in `reports/algorithm.md` (boundary table, rule 9) and in the parent report's
header note and §16; all four sites are corrected. Standing constraint restated by the
user: *"We want to make decisions based upon evidence."* Neither hypothesis is privileged
and neither is retired.

### Router step 0 — recomputing the number the queue was ordered on

The prior pass's queue was ordered on "no task qualifies, therefore no comparison is
possible." Before accepting that, the router recomputed occupancy from the one artifact
with complete per-turn accounting, `pilot-native-abs-v4/results.json`.

**The ABS run never came close to its window.** 49 model turns, 67 tool calls, 27.9
minutes, W = 1,310,720:

| quantity | value |
| --- | --- |
| peak context | 73,801 tokens = **5.63% of W** |
| cumulative prompt sent | 1,711,722 tokens = **23.2x the peak context** |
| billed | 169,846 fresh input + 1,276,032 cache read (88.3% hit) |
| prompt cost | $0.031879, against $0.108441 if nothing had cached (caching saves 70.6%) |

Aiomonitor (10 turns, terminated on a provider timeout) peaked at 29,938 = 2.28% of W with
a 4.8x re-send multiplier.

Two consequences, both of which reorder the queue:

1. **At the physical window, neither hypothesis's mechanism can fire on this task.** A
   25–50% target of W = 1.31M is 327k–655k tokens; the task demanded 74k. The target would
   have to *add* a quarter-million tokens of context, not evict any. Ejection has no window
   pressure to relieve. This is a **boundary condition on both hypotheses, not evidence
   against either**: the experiment was never in a regime where they apply.
2. **The tokens are not in the context, they are in the re-sends.** Context peaked at 74k
   but the run paid for 1.71M prompt tokens, because every turn re-sends the whole prefix.
   The re-send burden is concentrated in *early* tokens: turn 6 added 6,902 tokens that were
   re-sent 42 times, 17.7% of the entire re-send burden by itself. Early, dormant history is
   simultaneously what attention-over-history wants to evict and what costs the most to keep.

### Router step 0b — the cache tax, and a crossover

Ejection is not free under prefix caching: dropping a segment at prefix position p
invalidates the cache for everything after p, converting cache reads (GLM 5.3 Flash:
$0.015/M) into fresh input ($0.075/M), a 5x penalty. Simulated over the ABS turn sequence,
holding model behaviour fixed (`scratchpad/eject_sim.py` — a **ceiling probe**, generous to
ejection by construction, since a real ejection would cause re-reads and extra turns):

| budget | % of peak demand (73,801) | Δ prompt tokens | Δ cost |
| ---: | ---: | ---: | ---: |
| 4,000 | 5.4% | −89.5% | **−53.7%** |
| 8,000 | 10.8% | −80.9% | −40.7% |
| 16,000 | 21.7% | −65.2% | −23.3% |
| 24,000 | 32.5% | −54.0% | −22.7% |
| 32,000 | 43.4% | −35.9% | −5.3% |
| 48,000 | 65.0% | −13.9% | **+13.1%** |
| 65,536 | 88.8% | −3.4% | **+29.7%** |

**Ejection always saves tokens and does not always save money.** The sign of the cost
result flips at roughly 45% of peak demand. Rare, large ejections are taxed heavily (each
one re-sends a large suffix at 5x); frequent, aggressive ejection keeps the invalidated
suffix small and wins. The worst policy is a half-hearted one — eject hard or not at all.

Expressed against *demand* rather than against *window*, the user's proposed 25–50% band
sits almost exactly on the crossover: 25% of demand saves ~23% of cost, 50% is roughly
break-even. That is a coincidence worth stating carefully — it makes the band the right
thing to measure, not a validated setting.

**Status of this number: unaudited.** The simulation's no-ejection baseline (73,801 fresh /
1,637,921 cache read) does not reproduce the recorded split (169,846 / 1,276,032), so the
cache model is wrong in a way that has not yet been characterised. An adversarial audit
lens is recomputing it. No decision rests on these figures until that returns.

### Iteration 1 analyzer panel (dispatched, fresh context, claude-opus-4-6[1m])

1. **Cache economics, adversarial** — refute or repair the crossover; derive the algebraic
   break-even; explain the baseline discrepancy and the cacheRead=0 turns (15, 27, 31, 39).
2. **Demand/occupancy profile** — is 5.63% typical across every trace in the repo? Did any
   run ever approach 25% of its window from task demand rather than a harness-imposed
   budget? Is growth actually exponential, as the hypothesis assumes?
3. **Ejection safety / recurrence** — from the first trace with complete tool-call metadata,
   how much history is referenced again after going dormant, and would a recency policy have
   thrown it away? Also: did the agent *lose track* of the commit requirement over 49 turns
   (evidence for pinning instructions, H3) or simply not follow it (a harness bug)?
4. **Null hypothesis, steelmanned** — caching already discounts these tokens 5x and the run
   cost $0.043; argue nothing should be built, then state the exact regime where that fails.

### Iteration 1, lens 1 (adversarial cache audit) — the router's simulation was defective; the crossover survives but moves, and its cause changes

The audit reproduced the router's output, then refuted the model that produced it. **Do not cite
the router's step-0b table above**; the corrected figures supersede it. Scripts:
`scratchpad/eject_sim_v2.py` (corrected simulator + crossover bisection), `_v3.py` (policy /
trace-length / price sweeps), `_v4.py` (algebraic break-even, 40 cells).

**Defects found (ordered by cost impact).**

1. **`keep_frac` was dead code — and this defect manufactured the result.** The `while` guard
   already required `total > budget`, so the `total <= keep_frac*budget` break could never fire.
   High-water and low-water were both `budget`, so the policy evicted the *minimum* each turn and
   re-evicted on nearly every subsequent turn. The router measured a sliding window while believing
   it measured hysteresis.
2. **The budget was not enforced.** The newest turn's own delta could never be evicted, so every
   budget from 4,000 to 24,000 produced the *same* peak of 30,053 — a context 7.5x its stated
   budget. Those rows' "% of peak" labels were fiction and the rows were substantially one policy.
3. **Cache hits were matched by segment token-count equality, not identity**, so equal-sized
   distinct segments produced phantom hits. The tell was in the router's own output: `fresh` was
   non-monotone in budget (87,717 → 140,036 → 140,756 → 192,431 → **148,286**), which is
   physically impossible for a prefix cache.
4. **Zero cache misses were modelled** (baseline fresh 73,801 against the recorded 169,846, 2.30x).
   Misses scale with prompt size, so ejection *reduces* them: this omission was the one defect
   biased **against** the hypothesis.
5. **Wrong token unit throughout.** `eval/src/loop.ts:150` counts `JSON.stringify(request)` with
   `gpt-tokenizer` (o200k), which is neither GLM's tokenizer nor the provider's prompt. The
   provider/harness ratio drifts 1.101 → 0.841 across the run. **True peak demand is 62,042
   provider tokens, not 73,801 — the router's demand axis was 18.4% inflated.**
6. The `ideal_cache` "ceiling" subtracted the un-evicted `deltas[t]` unconditionally, understating
   the ideal hit by `d_t` every turn, so the stated hypothesis ceiling was *below* the true one.

**The billing identity, recovered rather than assumed** (`packages/core/src/models/openrouter.ts:176-188`):
`usage.input + usage.cacheRead ≡ the provider's prompt_tokens`, exactly. Recorded cost reproduces
to the cent: 169,846x0.075 + 44,666x0.25 + 1,276,032x0.015 per 1M = $0.04304543 against a recorded
$0.043045429999999996.

**Provider cache behaviour, derived from the capture rather than assumed.** All 49 request blobs
were reconstructed and the message list is strictly append-only, so no miss in this run is our
fault. The block size is **64 tokens** (all 43 nonzero cacheReads ≡ 0 mod 64; only 25/43 ≡ 0 mod
128), and `cacheRead[i] = floor64(prompt_tokens[i-1])` exactly in 33 of 49 turns: the whole previous
prompt caches, floor-rounded. The 169,846 fresh input decomposes exactly as 62,042 perfect-cache
floor + 1,500 block rounding + **99,072 hard cache misses** + 7,232 stale residual — so **58.3% of
all fresh input is miss re-send, 13.8% of billed cost.** Misses fall at turns 1, 15, 16, 27, 31
(the router's "15, 27, 31, 39" was wrong; turn 39 was a normal 31,424-token hit). Not TTL, not
retries, not our prefix: after a miss the next turn reads an entry from an *older* request
(turn 17 read floor64(P15), turn 28 read floor64(P26), turn 32 read floor64(P27)), which is
provider-side write lag. Events carry no timestamps, so this is the only consistent hypothesis
rather than a proven one. Observed miss rate 10.4% (5/48), n=1.

**Corrected crossover — and the finding is that eviction frequency, not budget, sets the sign.**
Baseline reproduction error against the real run: cost −1.01%.

| eviction policy | crossover budget | % of peak demand (62,042) | % of window |
| --- | ---: | ---: | ---: |
| sliding window, evict every turn (= what v1 actually measured) | 28,446 | **45.9%** | 2.17% |
| hysteresis, keep 0.90 | 42,781 | **69.0%** | 3.26% |
| hysteresis, keep 0.75 (v1's *intent*) | 55,810 | **90.0%** | 4.26% |
| hysteresis, keep <= 0.50 | none in range | **>100%** | — |

The same budget flips sign on policy shape alone. At budget 32,000 (51.6% of peak): sliding window
**+20.8%** cost (8 eviction turns), hysteresis keep 0.90 **−14.9%** (2 turns), keep 0.75 **−10.8%**
(1 turn), a single compaction at turn 20 **−31.5%** (1 turn). **Eject rarely and deeply, or not at
all**; the half-hearted policy is the one that loses. The router's crossover number was
approximately right for its own policy by cancellation — the inflated demand axis and the omitted
misses roughly offset — which is precisely how a broken model hides the real mechanism.

**The break-even, derived.** Without ejection the fresh term is linear in n but the cache-read term
is **quadratic** (`Total ~= f*P_n + c*sum_{i<n} P_i`), which is the entire reason ejection can beat
a 5x discount. Ejecting `E` tokens at prefix position `p` at turn `t`, inserting `G` tokens of
summary, with `S` = previously-cached surviving tokens after `p`:

    Dcost = (f - c)*(S + G) - c*(E - G)*(n - t)
    break-even:  (E - G)*(n - t) = (f/c - 1)*(S + G)     [= 4x for GLM 5.3 Flash]

Validated against the simulator across 40 (t, E, G) cells: sign agrees in every non-degenerate
cell, magnitudes within 10-30% (residual is 64-block rounding plus whole-turn quantization).

Three corrections to the router's stated intuition. The penalty is **not** the whole suffix after
`p` — only the *previously cached* part of the surviving suffix, so **if you evict everything
between the pinned head and a brand-new payload, S = 0 and the one-time penalty vanishes
entirely.** `E` must be counted net of the summary inserted (`E - G`, and `G` also joins the
penalty). And the horizon is `(n - t)`, not `n`: the same ejection at turn 45 of 49 is worth a
third of what it is worth at turn 20.

**Sign-flip boundaries.** Price ratio `r = c/f` sets the multiplier at `1/r - 1`: OpenRouter's
r = 0.2 gives 4x, **Anthropic's r = 0.1 gives 9x and is materially more pro-ejection**. Billed
cache writes cut the other way — at Anthropic's `w = 1.25f` the crossover falls from 90.0% to
**47.8% of peak**, the largest cross-provider swing. Ejection improves monotonically with session
length (it attacks the quadratic term): tiling this trace gives 90.0% of peak at 49 turns rising to
98.7% at 481 turns.

**The limit that governs the next step, and it is decisive.** The simulation holds model behaviour
fixed, so it is a ceiling and a soft one. Mean billed cost of a late turn here is $0.001068, so the
corrected saving at budget 32,000 ($0.004582) is erased by **4.3 extra turns** — and by 15.4 at
budget 16,000. On a 49-turn trace, a policy that induces >9% more turns is net negative *even
though the token accounting says it saves 21%*. No token-accounting argument can settle this
hypothesis; only a live arm measuring turns and success can.

**`W = 1,310,720` is flagged as a magic number.** `cost.ts` describes this model as having a ~1M
window; 1,310,720 = 1.25 x 2^20 is unexplained and is a harness budget, not a provider wall. Peak
demand is 4.73% of it. **This trace cannot speak to the overflow regime at all** — nothing was ever
truncated for lack of room, which is the regime where the memory notes
*live-verification-findings* and *minimum-window-boundary* say the tree is supposed to earn its
keep.

**Consequence for hypothesis H-A (the 25-50% soft occupancy target).** Expressed as a fraction of
the *window*, the target is untestable on this trace: the whole ejection sweep lives between 0.31%
and 5% of W. Expressed as a fraction of *peak demand* it is exactly the right axis, and 25-50% of
demand is where the corrected sliding-window crossover sits (45.9%). The target is therefore
**re-specified, not rejected**: the quantity to hold is a fraction of measured demand, and the
window enters only as a ceiling.

### Iteration 1, lens 2 (demand/occupancy across every trace) — the regime exists, but only in one artifact, and growth is linear not exponential

Swept 331 harness runs plus one real agent session. Scripts: `scratchpad/sweep.py` (corpus sweep
and curve fits), `scratchpad/an.py` (events.jsonl reconstruction), `scratchpad/rows.json` (331
per-run records with full per-turn series).

**Verified the ABS figures** (peak 73,801 = 5.631% of W; cumulative 1,711,722; 23.19x) and confirmed
lens 1's unit finding independently: billed prompt (`input + cacheRead + cacheWrite`) peaks at
**62,042 = 4.73% of W**, ~19% below the harness's own `promptTokens`. **The entire `eval/results/`
family has no `promptTokens` field at all**, so pilot and eval figures sit on different rulers and
are not directly comparable.

**Occupancy against the physical window, n = 329 harness runs:**

    min 0.11% | p25 0.75% | median 1.25% | p75 1.92% | p90 2.91% | p99 5.31% | max 72.32%
    >= 25% of W: 2 runs (both gpt-3.5-turbo, W = 16,385) | >= 10%: 2 | >= 5%: 3

**5.63% is not typical — it is roughly p99, and ABS has the largest peak prompt of any harness run**
(73,801; next is 45,564). In absolute tokens the corpus is tightly clustered: median peak 12,339,
p90 29,069. The whole harness corpus lives in a 1-75k band on 1M-1.31M windows.

**The one trace with a real regime, and it had never been profiled.**
`eval/fixtures/transplant/s1/trace.src.jsonl` is a **real Claude Code session** doing research/eval
work in this very repo, on Fable 5 (W = 1,000,000). It had only ever been consumed as a frozen
store to replay QA against; nobody had measured its occupancy. Router recomputed it directly
(`scratchpad/real_session.py`, `scratchpad/compact_cf.py`):

| quantity | value |
| --- | --- |
| model calls | **645** |
| peak context | **320,461 = 32.05% of W** |
| cumulative prompt | **112,470,739 tokens** |
| re-send multiplier | **351x** (ABS: 23x) |
| cache read | 110,461,354 = **98.2% of all prompt tokens** |
| cache write | 2,008,095 (1.8%) |
| fresh input | 1,290 (0.0%) |
| cost at Fable 5 prices | **$166.37**, of which **$110.46 (66.4%) is cache read alone** |
| prompt-side share of cost | **81.5%** |
| pay-each-token-once floor | $3.20 |

**Its ceiling was a human, not a limit.** Both drops carry `compactMetadata: {"trigger":"manual"}`
— a person typed `/compact` at call 328 (320,461 -> 75,583) and again at call 640 (246,459 ->
74,988). Nothing auto-fired, and demand was still climbing at 768 tokens/call when it was cut.

**Compaction is therefore the incumbent practitioner baseline, and it is worth 31%.** Extrapolating
segment 1's uncompacted slope across all 645 calls: peak would have reached 563,959 (56.4% of W,
still under it) and cumulative prompt 204,220,121 at a cost of $241.50. The two manual compactions
saved **31.1% of run cost and 91.7M prompt tokens.** Any ejection candidate must beat compaction,
not the do-nothing arm.

**Growth is linear, not exponential — H-B's stated premise is refuted.** Across 269 runs of >= 8
turns, linear R^2 beats exponential in 205 (76%); median R^2 0.938 linear against 0.872
exponential; curvature sign is a coin flip (149 concave, 120 convex); the second-half slope is a
median 0.877x the first-half, and 58% of runs *decelerate*. On the real session, segment 1 gives
R^2 0.978 linear against 0.982 exponential (indistinguishable over a 4.6x range) and segment 2
gives **0.990 linear against 0.979 — linear wins outright**. The form is piecewise linear with
occasional step discontinuities, reset by external events. Mechanistically this is what an agent
loop must produce: each turn appends one tool result drawn from a stationary size distribution, so
the prefix is a random walk with positive drift. Exponential growth would require each turn's
output to scale with the history, and nothing does.

**This refutes the argument for H-B, not H-B itself.** A 351x re-send multiplier and $110 of pure
cache-read is a large cost whatever the curve shape. The case has to be rebuilt on re-send
economics. Recorded as a rejected premise, not a rejected hypothesis.

**A stable demand model, agreeing across two unrelated harnesses.**

| corpus | tokens added per turn |
| --- | ---: |
| 269 harness runs >= 8 turns | median **622** (p90 1,694) |
| real Claude Code session, seg 1 / seg 2 | **768 / 549** |

So `demand(N) ~= floor + 600-770 * N`, where `floor` is the Zone-A-equivalent prefix: ~1,100 tokens
for the eval harness but **69,282 for Fable 5 in Claude Code** — its system prompt plus tool schemas
are 21% of segment 1's entire growth before a single tool runs. Within-cell CV across replicates is
0.17, so one measurement plus ~2 sigma pins a budget. Deriving demand from turn count alone does
not work (pooled R^2 = 0.241); scenario identity dominates.

**Consequence that reorders the queue: H-A cannot be tested on this harness at all.** At 700
tok/turn, filling 25% of a 1M window takes ~350 turns. The 331 harness runs have a median of 14
turns and a max of 65 — **the benchmark tasks are ~25x too short for the hypothesis's mechanism to
engage.** H-A needs the real-session corpus or a 300+ turn task. This is a boundary condition on the
instrument, not evidence about the target.

**Reporting error found and owed a correction.** `reports/metrics/context-growth.md` and
`tuning-summary-policy.md` compute occupancy for claude-sonnet-5 against **W = 200,000**, described
as "this host's window". Sonnet 5's window is **1M**, and `result.configuration` is absent from every
`eval/results` record because no `--window` was passed. Every occupancy percentage in those two
reports is **5x too high**. The tokens are right and the headroom is wrong: real headroom on the
45,564-token peak is 954,436, not 154,436 — which makes those reports' own conclusion ("nothing was
in danger of overflowing anything") five times stronger.

**Granularity, and a warning about tuning on the wrong corpus.** Largest single context event in the
repo: one `read_file` of `evaluator/functions.go`, 79,373 chars ~= 24,900 tokens, delivered as one
message at ABS turn 39 — **34.6% of that run's entire final context in a single message.**

| | harness runs (n = 5,199 deltas) | real session (n = 644) |
| --- | ---: | ---: |
| median positive delta | 448 | 116 |
| p99 | 9,800 | 5,554 |
| largest single turn's share of growth | median **29%** | **10.2%** |
| top-3 turns' share | median **62%** | 19.4% |
| turns to reach 50% of growth | ~2-3 | **22 of 327** |

Growth is a few large chunks in the benchmark runs and many small increments in real work. **A
policy tuned on the pilot traces will be tuned on the wrong shape**: on ABS one decision recovers
34% of the context, while in the real session no single ejection buys more than 10% and half the
context requires 22 separate correct decisions.

**Schema hazards recorded so the next pass does not re-hit them.** `turns[]` sits at
`record.result.turns` in pilot records but `record.turns` in eval records — a sweep assuming one
shape silently drops 155 of 160 files. `events.jsonl` `response.usage.input` is the *uncached
delta*, not the prompt: summing it yields 25 negative per-turn deltas out of 48 and a fictitious
plateau. `events.jsonl` `read_file` events include harness-side pre/post-edit captures that never
reach the model (`functions.go` appears 7x in ABS events, ~500 KB, but exactly once in the prompt),
so byte-counting the event log overstates context ~5x. `deepseek-v4-flash`'s window is recorded
nowhere (2 runs excluded rather than guessed), and gpt-3.5-turbo's W = 16,385 is the analyst's prior
rather than repo data — both >= 25% harness runs rest on it.

### Iteration 1, lens 3 (ejection safety / recurrence) — recurrence is real and long-horizon, the ABS zero was a harness bug, and the design axis is re-derivability

Reconstructed the full transcript from the capture (each request blob holds the entire accumulated
message list, so nothing was inferred). Scripts: `scratchpad/{recon,strict,tier3,big,verbatim}.py`.
Correction to the router's brief: **41** of 49 deltas are under 1,500 tokens, not 39; they sum to
29.1% of growth, while turns 6 and 39 alone are **48.8%**.

**A causal instrument, not just identifier overlap.** `edit_file` replaces the first occurrence of
`old_text` and *fails* if the string is absent, so a successful edit whose `old_text` appears
byte-exactly in exactly one prior unit is near-proof that unit was still functionally present. All
24 `edit_file` calls have a verbatim in-context source; gap to the newest source is median 3 turns,
mean 5.5, **max 19**.

| keep-last-K recency policy | edits whose newest verbatim source is evicted |
| --- | ---: |
| K = 1 | 15/24 = **62%** |
| K = 3 | 10/24 = 42% |
| K = 5 | 9/24 = 38% |
| K = 10 | 5/24 = **21%** |

The hardest single case: **turn 19's edit to `functions.go` has a 1,018-character `old_text` whose
only verbatim source anywhere in context is `U4_2b50`, the turn-4 `sed` window — a gap of 15
turns.** Turn 37's edit sources solely from turn 18, a gap of 19.

The identifier-overlap instrument was run at three strictness tiers and **the loose tier was
worthless** — English words and JSON-escape artifacts (`\treturn` -> `treturn`) inflated recurrence
to 100% of large units. At the project-specific tier (34 of 67 units carry novel project
identifiers): 20.6% never referenced again, 44.1% not referenced beyond +5 turns, 52.9% not beyond
+10; median gap 8.5 turns, max 45. This tier is **observational** — it shows a later turn *mentions*
vocabulary a unit introduced, not that the unit caused it — and is reported as an upper bound on
necessity.

**Recurrence is unpredictable by both recency and topical relevance.** 52.9% of identifier-bearing
units go dormant >= 5 turns and return. The longest-lived units are the *earliest and smallest*:
`U3_1b3f` (turn 3, a `grep -rn "require"`) is referenced at 19 distinct later turns spanning 44
turns, with three separate >= 5-turn dormancies. `U4_2b50` is dormant **turns 24 -> 40, sixteen
turns**, exactly across the `repl.go` CLI phase and the test-triage phase, and then becomes the
operative unit at turn 40. That is H1's "early API edit is irrelevant during UI work and relevant
again during tests" case, instantiated on real work: `functions.go` internals -> `repl.go` flags ->
test triage -> `functions.go` internals. **Every recency policy inverts exactly the right ranking.**

**The finding that reframes the design: the savings and the risk live in different units.** The
recurrent set is 29.1% of unit mass; two turns with no or redundant recurrence are 48.8% of growth.
- `U6_b257` (turn 6, 13,332 chars: `cat evaluator/stdlib.go` and friends) introduced 46 novel
  project identifiers and has **zero** later project-specific references. Free to eject — the
  cleanest such unit in the run.
- `U39_1e47` (turn 39, 12,074 chars, a full re-read of `module.go`) has **0 novel identifiers;
  67/67 already present.** The agent had authored that file itself over turns 15-37 and re-read it
  in full anyway. It should never have been *added*.
- `U39_d41f` (`functions.go`, 72,387 chars) was 34% already present, 66% genuinely novel.

So **a pure size-based eviction and a pure recency-based eviction would make almost opposite
mistakes.** And turn 39 is the agent's own behavioural verdict on its context: unprompted, it spent
29,082 tokens re-acquiring files it had been editing for 24 turns, because narrow `sed` windows plus
its own diff fragments had stopped being a usable model of those files. That re-read was billed as
fresh input (turn 40: `input: 24387, cacheRead: 31424`), not cached prefix. **Ejection does not
avoid that cost; it schedules more of it.**

**The operational reframe.** Ejection safety is not a function of a scalar relevance score but of
whether the ejected unit is **re-derivable, and at what price**. A unit whose content is a
coordinate into a file still on disk is cheap to eject: the agent re-reads it, as at turn 39, and
the measured price is 29,082 tokens. A unit whose content is *not* on disk — command output, test
failures, the `git stash` A/B that established which failures were pre-existing (`U33_2d68`,
referenced 10 turns later; `U32_61d7`, 11 turns later) — is **unrecoverable at any price and must be
kept regardless of relevance or age.** This is exactly this repo's own L0/L1/L2 invariant: *keep
coordinates, eject payloads that coordinates can re-derive, never eject observations nothing can
re-derive.* The question worth testing is not "which units are relevant to this turn" but "which
units are re-derivable, and what does re-derivation cost".

**THE ABS ZERO WAS A HARNESS BUG. It is not evidence for H3, and the prior report's framing is
wrong.** Three findings, each independently verified:

1. **The commit instruction never left the context.** Hashing `messages[0].content` across all 49
   request blobs yields **one distinct hash**, and the substring `commit everything when you are
   done` is asserted present in every one. It was verbatim in position 0 on every turn.
2. **The agent acted on the instruction at turn 14**: *"Now let me create a branch and implement the
   module loader"* -> `git checkout -b module-loader-improvements`. The commit clause is conditioned
   on *"when you are done"*, and the run never reached done.
3. **The agent did not believe it was finished — it was cut off mid-thought.** Turn 49 in full:
   `text: 'Now the cache info issue: `info.misses` was NULL — property access on hash. Let me test
   the hash in isolation:'`, `toolCalls: []`, `stopReason: 'stop'`. 110 characters ending in a
   colon, announcing the next action. `eval/src/loop.ts:562-566` ends the run on **one** bare turn
   with no confirmation and no retry; the metrics record `trailingBareTurns: 1`, `gateFired: true`,
   **`gateRescued: false`**. `maxTurns: null` and 1,490,544 tokens against a 3,027,706 cap — the run
   had ample budget and stopped anyway. Four files of real work sat on disk (`submission.json`
   `dirty`: ` M evaluator/functions.go`, ` M repl/repl.go`, `?? evaluator/module.go`,
   `?? evaluator/module_test.go`) and were discarded by `committedOnly: true`.

Salience dilution is real but did not cause this: the task statement fell from ~two-thirds of the
turn-1 prompt to ~0.9% of the turn-49 prompt, a **~75x dilution**, and the commit sentence alone is
~0.03% of the final prompt. That is a legitimate H3 pressure and **this run cannot test it**,
because the run did not terminate on the agent's own judgment. Fixing the bare-turn gate
(`gateRescued: false` -> `true`) is a precondition for any H3 experiment.

The one failed edit in the run is also instructive: turn 22's `old_text` **was** in context
(introduced 3 turns earlier) but the agent attributed it to the wrong file, and said so at turn 23
(*"That edit was a mistake (it's in functions.go...)"*). A misattribution failure, not a loss
failure. **Nothing in this run is a case of ejected content breaking the agent** — the context was
never remotely full (73,801 of 1,310,720), so nothing was ever forced out.

**Limits stated by the lens.** Causal evidence exists only for `edit_file` turns; `run_command` and
`write_file` references are observational. Reference horizons for units added at turns 39-48 are
censored by the run ending at 49, biasing late units toward "never referenced". No ejection arm
exists in this pilot, so nothing here measures ejection's effect on outcome. Per-unit sizes are in
characters (~2.74 chars/token observed) because the harness tokenizer is not installed here.

### Iteration 1, lens 4 (null hypothesis, steelmanned) — the strongest result in the pass: caching already took the win, and a per-turn ejection policy is underwater by construction

Scripts: `scratchpad/{attrib,attrib2,echo,cachemiss,verify,combined,model,regime}.{mjs,py}`.

**The decisive measurement was already in the repository and nobody had cited it.**
`reports/metrics/window-regime-and-retrieval-unit/step8-sonnet/results-r{1,2,3}.json` — 18 rows,
real Sonnet 5, real multi-turn SWE tasks, three arms at n = 6. Router re-verified every column:

| arm | success | turns | wall-clock | cost | fresh input | cacheRead | output |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `native` (unmanaged full history) | **6/6** | 31.2 | 235 s | **$0.186** | **42** | 330,119 | 8,746 |
| `context-tree` | 6/6 | 15.7 | 334 s | $0.291 | 82,445 | 97,167 | 6,614 |
| `prefix-retrieval` | **3/6** | 16.8 | 195 s | $0.339 ($0.678/success) | 137,040 | 58,140 | 4,384 |

**The unmanaged arm's average fresh input across an entire multi-turn run is 42 tokens.** Per-turn,
from the 65-turn `sw-2-multimod` native row: `turn 61 input: 2, cacheRead: 35,213`. An append-only
transcript with an incremental cache breakpoint bills each token **once at 1.25x** (cacheWrite) and
then **0.1x forever** (cacheRead). Managing context cost 1.6x more, took 42% longer, and bought
identical success. **That is a null result already on disk, on the deployment model, at equal n.**
(Lens 4 reported $0.575 for context-tree using the `claude-sonnet` tier(3,15) row; the correct row
for this model is `claude-sonnet-5` tier(2,10), giving $0.291. The ordering and the conclusion are
unchanged.)

**Router self-correction, and it matters.** The journal's earlier claim that the real session's
prompt-side cost was 42x its pay-once floor is **wrong**. That floor used the *peak context*
(320,461 tokens, $3.20) instead of *all unique content ever cached* (fresh + cacheWrite =
2,009,385 tokens, $20.09). The correct effective multiplier is **6.75x**, against 3.76x for the
31-turn step8 native arm. The raw multipliers (23x, 351x, 56x) are pre-cache figures and must never
be quoted as the size of the opportunity — **caching has already collapsed them by roughly 8x.**

**THE KILL GATE THAT FIRES: ejection cadence, a hard arithmetic bound.** Ejecting at turn `t` down
to a retained prefix `C`, with `E` tokens removed and `(n-t)` turns remaining, the retained prefix
must be re-written at the cache-write price while each later turn saves `E` tokens at the
cache-read price. Break-even is `r*E*(n-t) = w*C`, so with `keep_frac` retained:

    break-even turns after one ejection = w * keep_frac / (r * (1 - keep_frac))

| provider | cacheRead r | cacheWrite w | keep 75% | keep 50% | keep 25% |
| --- | ---: | ---: | ---: | ---: | ---: |
| **Anthropic** (Sonnet/Opus/Fable) | 0.1x | 1.25x | 37.5 | **12.5** | 4.2 |
| OpenRouter GLM 5.3 Flash | 0.2x | 0 (re-billed fresh at 1.0x) | 15.0 | **5.0** | 1.7 |

**On the deployment platform, ejecting to half pays for itself only if at least 12.5 more turns
follow. H-B as originally written — "categorise AND prioritise per turn, not summarised once and
forgotten" — is therefore 12.5x underwater by construction.** This retires, unspent, every
per-turn attention candidate in the queue: H1's per-turn re-prioritisation, H2's per-turn breadth,
H5's dynamic top-k, and the per-turn admission loop of the §15 design note. **Attention over
history survives only as a phase-boundary policy**, which is what `/compact` already is.

**Platform asymmetry that would have biased every planned experiment.** GLM 5.3 Flash reports
`cacheWrite: 0` and discounts reads only 5x; Anthropic charges 1.25x to re-write and discounts
reads 10x. **Measuring ejection on GLM/OpenRouter systematically overstates its benefit relative to
the deployment platform** — a 5-turn break-even against a 12.5-turn one. The pass's primary model
was the most ejection-favourable substrate available.

**There is no "inconsequential history" to eject that is not a tool result.** Exhaustive content
attribution across all 49 ABS request blobs:

| kind | unique msgs | sent once | re-sent volume | share | multiplier |
| --- | ---: | ---: | ---: | ---: | ---: |
| `run_command` | 37 | 21,609 | 829,071 | 58.8% | 38.4x |
| `read_file` | 3 | 24,954 | 264,100 | 18.7% | 10.6x |
| `edit_file` | 24 | 7,272 | 145,722 | 10.3% | 20.0x |
| `write_file` | 3 | 6,131 | 133,637 | 9.5% | 21.8x |
| task prompt | 1 | 520 | 25,480 | 1.8% | 49.0x |
| **assistant text** | 23 | 610 | 11,900 | **0.8%** | 19.5x |

**Assistant reasoning text is 0.8% of prompt volume.** "Eject inconsequential history" resolves, on
real data, to "truncate tool results" — which is better done at the source, where it costs no cache
invalidation.

**Wall-clock is not a prompt-size problem.** Regression over **382 real Sonnet turns** with per-turn
latency and usage: `corr(latency, output) = 0.966`, `corr(latency, prompt) = 0.136`,
`corr(latency, fresh input) = 0.175`. **Prompt size explains 1.8% of latency variance.** Ejection
reduces the axis that does not drive latency, and a summarizing layer *generates* tokens on the axis
that does.

**Every recorded failure in this pass has a non-context cause.** 6 of 7 live attempts produced no
score and **0 of 7 failed for a context-management reason**: one instrument bug (missing tool call
IDs), two process interruptions, three identical provider timeouts, one uncommitted submission. The
three timeouts occurred at prompt sizes of 26,456 / 29,628 / 25,923 tokens — **2.0% of the window**,
where no occupancy policy could fire. Proximate cause is one line,
`eval/scripts/run-attention-experiment.mjs:59`: `{ sdkMaxRetries: 0, retry: { attempts: 1 } }`. The
harness already performs one identical retry for empty completions and preserves both attempts, so
retrying a *timeout* is consistent with the accounting design.

Historical corroboration: the only interventions in this repository that ever measurably changed
task success were **agent-protocol fixes** — a byte-identical-repeat-call guard and a Zone A clause
telling the model that replying *is* the answer moved the tree arm from 3/6 to 6/6. No context
policy has ever moved a success rate here.

**Four cheaper alternatives, priced on the same run.** (a) Six of 27 `read_file` calls were
byte-identical re-reads of content already in context (4 distinct paths; `module.go` read 15
times), worth 116,237 bytes. (b) Capping tool-result bodies at source: **5 results (7%) hold 57% of
tool-result tokens; 2 results (3%) hold 44%.** A 2,000-token cap saves **29.3%** of prompt volume;
1,000 saves 46.6%. (c) `eval/src/transcript.ts:9` echoes `call.input` back inside every tool result,
so for `write_file` the model is re-sent the entire file **it authored one turn earlier**:
**107,531 tokens, 7.6% of prompt volume, 80% of all write_file volume.** This waste was *created by
this pass's own* `tool-result-call-v1` repair. One-line fix. (d) Already at the cheapest model.

Combined source-side hygiene — drop the write echo, cap bodies at 2,000 tokens — cuts prompt volume
**31.2%** while **preserving the append-only prefix and the 88% cache hit rate.** That is the same
order of reduction "hold context at 50%" targets, without paying the invalidation tax. Verified
property: across all 48 successive ABS request pairs, each request's message list is a
byte-identical prefix of the next modulo a single moving `cacheBreakpoint` marker — **the harness's
caching is already optimal.**

**The two largest line items in the whole run are agent tool-use mistakes, not context failures.**
281,822 tokens (16.6% of the entire prompt bill) is one `run_command` result of 6,554 tokens
re-sent 43 times, whose content is `cat evaluator/stdlib.go` — a go-bindata file whose second line
reads `// Code generated for package evaluator by go-bindata DO NOT EDIT.` And 253,640 tokens
(15.0%) is one whole-file `read_file` of `functions.go` with no line range, re-sent 10 times.

**A finding no context policy can touch.** 6 of 49 calls billed `cacheRead: 0` on a provably
append-only prefix; the four mid-run misses cost **102,144 fresh tokens = 60.1% of the entire
fresh-input bill** for zero new content. Provider-side cache eviction is the single largest
component of the fresh-token bill. (Lens 1 independently identified the same misses as write lag,
naming turns 1, 15, 16, 27, 31 against lens 4's 1, 2, 16, 17, 28, 32 — a one-based/zero-based
indexing difference over the same events.)

**The regime where ejection wins, simulated from the measured growth rate (g = 1,508 tok/turn),
with ejection at phase boundaries rather than per turn:**

| turns | cap | append-only prompt | with ejection | prompt saved | Opus saving |
| ---: | ---: | ---: | ---: | ---: | ---: |
| **49** | 73,887 | 1,847,175 | 1,847,175 | **0.0%** | **$0.00** |
| 100 | 73,887 | 7,614,884 | 4,712,935 | 38.1% | $0.95 |
| 200 | 73,887 | 30,308,748 | 10,367,552 | 65.8% | **$8.81** |
| 200 | 300,000 | 30,308,748 | 30,158,677 | 0.5% | **−$0.60** |
| 500 | 73,887 | 188,864,219 | 27,331,404 | 85.5% | $77.61 |
| 1000 | 73,887 | 754,702,928 | 55,604,491 | **92.6%** | **$343.07** |

**Turn count, not window size, is the independent variable — and this project has been varying
window size.** Crossover is 100-150 turns; at 49 turns the saving is exactly zero because no cap is
ever reached. A cap set near actual demand (300,000 at 200 turns) is *negative*: the cache write is
paid and the read saving never accrues.

**Lens 4's disposition on H-A: drop it.** Its trigger cannot fire on the only scored run at any
window >= 148k tokens (25% of 1.31M is 327,680; the run grew 1,508 tok/turn and would need ~217
turns to reach it, having run 49). It has no ejection mechanism distinct from H-B's. And its other
half — padding unused space *up* to 25% — is a token-expenditure proposal with no hypothesis
attached. On a real 200k Sonnet window the 25% floor would be crossed at turn ~40 of 49 and the 50%
ceiling never reached, so even there the band would have ejected nothing; it would merely have
declined to pad.

**The part of lens 4's own case it does not believe, and it is the most important paragraph in the
pass.** Every argument above is about **cost, latency and reliability**. None of it addresses the
one claim that could still justify H-B: **that a shorter context makes the model reason better.**
If ejecting stale tool results raises the success rate — attention dilution, lost-in-the-middle,
the distractor decay this repo's own notes record for qo05 — then every figure above is irrelevant,
because a 5-point success gain on an SWE task outweighs $343 of Opus tokens. **No cost analysis can
refute a score hypothesis, and none of the four lenses refuted one.** Lens 4 also declines to cite
`ds-star-live-verification-report.md` (tree losing to truncate-tail at every tested window) as
evidence, because the mechanism there is retrieval tool overhead, not ejection. And it could not
test whether provider timeouts scale with prompt size — the three timeout events carry `usage: null`
and no latency — so if they do, context reduction buys reliability by a route none of this measures.

### Iteration 1 synthesis — the gap model

**Where the loss actually is, decomposed so the buckets sum.** Of the ABS run's $0.04305:
output 26%, cache-read re-send 44%, cache-miss re-send 13.8%, block rounding 0.2%, unique content
~16%. Of the real session's $166.37: output 18.5%, cache read 66.4%, cache write 15.1%, fresh 0.0%.

**Four candidate classes, ranked by information per unit of effort:**

1. **Harness defects blocking all measurement (obligatory, no hypothesis attached).** The bare-turn
   gate voided the only scored run; `gateRescued` is unreachable in 0/48 runs; provider timeouts
   are not retried and voided 3 of 7 pilots; two reports state occupancy 5x too high. **Land these
   before any epoch-dependent measurement.**
2. **Source-side payload hygiene (cache-preserving, −31% prompt volume).** Drop the write echo
   (−7.6%, one line, waste this pass created); cap tool-result bodies at source (−29.3%). Wins its
   bucket without paying the invalidation tax. These change what the model sees, so they are
   **arms, not fixes** — but with a strong prior and a near-zero cost of trial.
3. **Phase-boundary ejection (H-B, re-specified).** Survives the cadence bound only at >= 12.5-turn
   intervals on Anthropic. Its correct axis is **re-derivability, not relevance** (lens 3): keep
   coordinates, eject payloads a coordinate can re-derive, never eject observations nothing can
   re-derive. Measured re-derivation price: 29,082 tokens. **Requires >= 150-turn tasks; no such
   task exists in the manifest.**
4. **Score-hypothesis test (the only test that can vindicate H-B).** Primary endpoint success rate,
   not cost. Needs n >= 78/arm for 0.20->0.40 at 80% power — affordable (~$67/arm-pair on GLM) but
   blocked by the 1-in-7 scored-run completion rate until (1) lands.

**Both of the user's hypotheses are re-specified rather than rejected, and the record must say
which part died.** H-A's *window-fraction* framing is refuted as untestable here (no run in the repo
reaches 25% of a real window from task demand; the only 32% case is the real session, cut by a
human). Its *demand-fraction* framing survives and is the right axis. H-B's *premise* (exponential
growth) is refuted; its *per-turn* form is refuted by arithmetic; its *phase-boundary* form on
long horizons is untested and remains live. Neither hypothesis has been tested on the endpoint that
matters — success rate — and no evidence in this pass bears on it.

### Iteration 1, implement + verify — the completion-gate asymmetry, landed

Only the defects landed. **No hypothesis candidate was implemented, and no product default changed.**
These are epoch-shifting harness repairs, taken before any epoch-dependent measurement per the
DS-STAR ordering rule.

**1. The completion gate is now shared by every arm** (`eval/src/loop.ts`: new exported
`COMPLETION_NUDGE` and `completionGateOpen()`; applied in `runNativeArm`, `runDsaArm`,
`runPrefixRetrievalArm`, the tree arm, and `eval/src/attention-loop.ts`).

The gate existed only in the tree arm, and **its own source comment already identified the
asymmetry as a confound**: *"the gate is a tree-only stopping rule the native arm never had
(native returns on the first bare-text reply), so while it stands every tree turn-count number is
`the arm's effect + 1`. Corpus replay over eval/results: 204 tree runs, 185 fires, 23 rescues."*
So the tree arm was handed a second chance on a premature bare reply **23 times** that the baseline
was never offered, and every tree-vs-native turn count carried a +1 the baseline did not pay. That
is not a tuning detail; it is a systematic bias in the comparison this project exists to make.

The concrete cost of leaving it: ABS v4 turn 49 emitted `'Now the cache info issue:
`info.misses` was NULL — property access on hash. Let me test the hash in isolation:'` with no tool
call — 110 characters ending in a colon, mid-debug, 20 F2P tests still failing, `maxTurns: null`,
and 1.5M of a 3.0M token budget unspent. The harness read that as task completion and scored the
run 0. Under the shared gate that run gets one nudged turn and continues.

Semantics, deliberately identical across arms: fires only after tool work has happened (a task
answered in one turn is not premature), **at most once per run** (a determined model can still
stop), and `EVAL_NO_COMPLETION_GATE=1` disables it everywhere at once — which was previously the
only parity setting available. In the attention arm the nudge is appended as an L0 `user_message`
event with `role: 'steering'`, so it rides behind the moving cache breakpoint like every other
event rather than re-billing fresh.

One asymmetry was introduced and removed during implementation: the first native patch reset
`completionConfirmed` after each tool-work turn, which would have given native *more* nudges than
the tree and swapped one bias for its mirror image. The tree arm confirms at most once per run, so
native now does too; the reason is recorded in the code.

**2. `gateRescued` is no longer a dead branch.** It was `false` in **0 of 48** recorded runs and
was structurally unreachable: it inspects `turns[firstBareAfterWork + 1]`, but every non-tree arm
returned *at* `firstBareAfterWork`, so no such turn ever existed. The metric measured something
the harness made impossible. The definition is unchanged and now reachable;
`eval/src/metrics.ts` records why.

**3. Two reports carried occupancy figures 5x too high.** `reports/metrics/context-growth.md` and
`reports/metrics/tuning-summary-policy.md` both compute Sonnet 5 occupancy against `W = 200,000`,
described as "this host's window", when Sonnet 5's window is 1,000,000 and no `--window` was
passed on those runs. Both now carry a correction header. The bodies are left intact: their
analyses are explicitly conditional on a candidate budget, and their central conclusion —
that nothing was near overflow — gets **five times stronger**, so rewriting them would replace a
sound conditional result with a worse one.

**4. NOT changed, and referred to the user: the provider-timeout retry.**
`eval/scripts/run-attention-experiment.mjs:59` sets `{ sdkMaxRetries: 0, retry: { attempts: 1 } }`,
which voided 3 of 7 pilots on `Request timed out`. `isRetryableStatus(undefined)` already returns
`true` (`packages/core/src/models/retry.ts:33`), so a timeout *is* retryable and only
`attempts: 1` suppresses it — the fix is genuinely one line. It was left alone because
`attempts: 1` is a deliberate, documented accounting choice (*"Set 0 with retry.attempts=1 to
expose every local transport attempt to the caller"*, `models/factory.ts:21`) and raising it
changes what a recorded `providerError` means. That is the user's call, not the router's.

**Verification.** Zero live tokens. `npx tsc --noEmit` clean. **Full suite 1,125 passed, 9 skipped,
0 failed** (49 files), up from 1,120 passed before this pass. Twelve pre-existing tests failed
first and every one was a fixture that scripted exactly N replies for the old
stop-on-first-bare-reply behaviour; none encoded stopping semantics as intent. They were updated to
script the bare reply twice — keeping them on the default path rather than disabling the gate — and
the shared `agentReplies` fixture now carries that second bare reply for every arm, so the tree
arm no longer appends a `confirmReply` of its own.

Two metering assertions are worth recording because their *convergence* is the finding: the same
scripted work previously metered **300 input tokens on the native arm and 400 on the tree arm**;
both now meter **500**. The old numbers differed because the arms spent different numbers of turns
on identical work.

**A new test encodes the intent none of the updated fixtures did** (`eval/test/loop.test.ts`,
`describe('completion gate parity across arms')`): for native, context-tree and prefix-retrieval,
a premature bare reply followed by real work must still reach `done`, the shared nudge wording must
appear in some request, and it must appear at most once. Plus unit coverage that the gate never
fires before tool work, never fires twice, and is disabled by the env flag.

**The parity test was mutation-checked.** Disabling only the native arm's gate (line 610, replacing
the condition with `false`) makes it fail — `× native spends one nudged turn on a premature bare
reply and keeps working` — and restoring the gate makes it pass. A test that cannot fail when the
behaviour regresses would have been worthless here, which is exactly the trap the 0-of-48
`gateRescued` metric fell into.

**Consequence for every prior result in this repository.** Turn counts, token totals and costs for
tree-arm runs recorded before this change include one gate turn the native and prefix arms never
spent. **Cross-arm comparisons of turns or tokens from earlier epochs are not valid at face value**
and must either be re-run or read with that +1 in mind. Graded scores are affected wherever a run
ended on a premature bare reply, which the corpus replay puts at 185 fires across 204 tree runs
with 23 rescues.

## 2026-09-08 late — TWO ROUTER ERRORS CORRECTED BY OPERATOR EVIDENCE; the corpus is the defect

The operator supplied `/context` output from real Claude Code sessions and challenged the pass's
statistics. Both challenges land. **The affected conclusions above are withdrawn as marked.**

### Error 1 — "growth is linear, not exponential, so H-B's premise is refuted" was a category error

Lens 2 fitted **prompt length per turn** against turn index and found it linear (R^2 0.978/0.990).
That fit is correct. The inference drawn from it was not. The growth the literature calls quadratic
is **cumulative token consumption**, and a linear per-turn prompt curve is exactly its mechanism:
every turn re-sends the whole prefix, so

    sum_{i<=n} (a + b*i) = a*n + b*n(n+1)/2 = O(n^2)

The pass's own headline numbers *are* that quadratic term and were mislabelled as evidence against
it: a 23x re-send multiplier on a 49-turn task, 351x on a 645-call session, 1.71M and 112M
cumulative prompt tokens respectively. **Nothing was refuted.** Prefix caching discounts the term
by roughly 8x (the effective multipliers are 3.76x and 6.75x) but does not change its order. The
correct statement is: consumption grows quadratically, caching reduces the constant, and ejection
is the only intervention that attacks the exponent.

`reports/algorithm.md` rule 9 carried the wrong claim and is corrected.

### Error 2 — the occupancy corpus cannot reach the regime, and that was reported as a finding about the hypothesis

Lens 2's distribution (median peak **1.25% of window**, p99 5.31%, only 2 of 329 runs above 25%)
is arithmetically right and **describes an invalid instrument**. Operator measurements on
`claude-opus-5[1m]`, 1M window:

| observation | total context | messages | occupancy |
| --- | ---: | ---: | ---: |
| after **1** user prompt | 368.1k | 334k | **37%** |
| after **2** user prompts (iteration 3, "baked 1h 7m") | 562.5k | 525.3k | **56%** |

Fixed overhead before any message: system 4.6k + system tools 1.3k + MCP tools 4.5k (455 tools)
+ custom agents 2.9k (14) + memory files 14.3k (4) + skills 9.9k (180) = **~37.5k tokens**, with a
33k autocompact buffer against a 1M auto-compact window.

**The two measurements reconcile exactly, which is what makes the corpus defect precise.** The
per-turn rate lens 2 measured (600-770 tok/turn, agreeing across two unrelated harnesses) is
right; so is the operator's ~191k jump per user prompt. 191,300 / 700 ~= **273 model turns per
user prompt** — consistent with "baked for 1h 7m" driving subagents. The error was reporting
"median 14 turns" from generated scenarios as though it characterised real sessions. One operator
prompt is roughly twenty of this repo's benchmark tasks end to end.

Consequences, replacing what iteration 1 concluded:

- **H-A's mechanism fires routinely in real use.** "H-A cannot be tested on this harness" stands
  only as a statement about the harness. At ~191k/prompt a 1M window autocompacts after roughly
  four to five operator prompts. The 25-50% band is *inside the operating range*, not 25x beyond it.
- **The cadence bound stops binding.** The 12.5-turn Anthropic break-even is correct arithmetic but
  was applied to 49-turn tasks where it dominates. At 273 turns per prompt, ejecting at turn 100
  leaves a horizon of ~170, clearing the bound by more than 13x. **Phase-boundary ejection is
  comfortably above water in the real regime; only per-turn re-prioritisation remains dead.**
- **The step8-sonnet null result (native 6/6 at $0.186, cheapest and equal-best) is a result about
  31-turn tasks.** It does not transfer to 273-turn sessions, where the quadratic term is ~75x
  larger.

### The instrument replacement: Long-Horizon-Terminal-Bench (LHTB)

Selection criterion was verifier availability, because success rate is the endpoint that decides
these hypotheses and a hidden grader forecloses it.

| candidate | scale | verifier | verdict |
| --- | --- | --- | --- |
| **LHTB** (arXiv 2607.08964) | 46 tasks, **9.9M tokens, ~231 episodes, 85.3 min per task** | **Apache 2.0, `tests/` + `solution/` in repo** | **selected** |
| SWE-Marathon | 20 tasks, 27M avg / 877M max tokens | hidden test suite | rejected: no endpoint |
| Agents' Last Exam | 250+ occupational tasks | not public | rejected: no endpoint |
| Meta-Agent Challenge | — | dev set only | rejected: partial |
| AgencyBench (arXiv 2601.11044) | ~90 tool calls, ~1M tokens/scenario | unverified | hold |

LHTB's per-task profile (231 episodes, 85 minutes) matches the operator's regime almost exactly
(~273 turns, 67 minutes). 30 of 46 tasks set `continue_until_timeout = true`, and the multi-stage
tasks are the right shape: **law 70 stages, investment banking 38, management consulting 33**.
Layout is `task.toml` / `instruction.md` / `environment/` (Dockerfile) / `tests/` (hidden verifier)
/ `solution/` (reference) — which maps onto the DeepSWE integration already built here, including
the pristine-0 / reference-1 gate pair. Docker plus Git LFS; Colima is already installed.
Sources: `github.com/zli12321/LHTB`, `huggingface.co/datasets/IntelligenceLab/Long-Horizon-Terminal-Bench`
(1.18 GB; the HF copy withholds verifiers and solutions, so the GitHub clone is the required one).

Note honestly: none of these benchmarks was built to evaluate context-management policy. That is
fine and does not weaken the choice — the benchmark supplies a long task and a verifiable outcome,
and the arms supply the policy contrast. What it does mean is that no published baseline exists to
compare against on this axis.

### Pre-registration: iteration 2 — LHTB, success-gated

Operator decisions (2026-09-08 late): instrument is **LHTB**; endpoint is **both, success-gated**.

**Endpoint rule, registered before any run.** Task success (verifier reward) and cumulative prompt
tokens are both reported. **A token win accompanied by any success regression is recorded as a
regression, never as a tradeoff.** Tokens cannot override success. This is registered now
precisely because the break-even arithmetic already predicts the token direction, so the token
column is the cheap signal and not the verdict.

**Why success is load-bearing here.** Nothing in iteration 1 tested whether a shorter context makes
the model reason better — every lens argued cost, latency or reliability. If ejection raises
success, the entire cost analysis is beside the point; if it lowers success, no token saving
redeems it.

**Arms (3, same epoch, equal n).** `native` full history (the practitioner default and the arm that
won at 31 turns); `context-tree` (the shipped stack); one **mechanism-isolated** phase-boundary
ejection arm. Per-turn re-prioritisation is excluded by the cadence bound and gets no live tokens.
One measurable change per candidate.

**Ejection arm specification, from iteration 1's evidence.** Fires only at phase boundaries at
least 12.5 turns apart (the Anthropic break-even, `w*keep/(r*(1-keep))`, derived not fitted).
Ranks by **re-derivability, not relevance** (lens 3): a unit whose content is a coordinate into a
file still on disk is cheap to eject because the agent can re-read it — measured price 29,082
tokens; a unit whose content is **not** reconstructible (command output, test results, a `git
stash` A/B establishing which failures pre-existed) is never ejected regardless of age or
relevance. Task, plan and steering text are pinned. This is the repo's own L0/L2 invariant applied
to attention: keep coordinates, eject re-derivable payloads, never eject unrepeatable observations.

**Pilot before the matrix.** n=1 on one LHTB task per arm, to derive the token ceiling from
observed behaviour rather than from the historical 3,027,706 figure (which came from a 49-turn
task and is ~3x too small if LHTB averages 9.9M).

**Sizing, from LHTB's published 9.9M tokens/task and the ABS-measured 88/12 cache split.**

| model | per run | 3 arms x n=5 x 4 tasks (60) | Sonnet confirmation (15) |
| --- | ---: | ---: | ---: |
| GLM 5.3 Flash (primary) | $0.29 | **$18** | — |
| Sonnet 5 (confirmation) | $7.09 | $425 | **$106** |
| Opus 5 | $17.72 | $1,063 | $266 |

Wall-clock is the binding constraint, not spend: 85 min/run x 60 = 85 h serial, ~14 h at 6-way
parallel. Escalation to n=10 only on an ambiguous registered comparison, baseline included.

**Kill gates, as numbered steps before the first scored batch (zero live tokens each).**
1. LHTB clone + `git lfs pull`; confirm `tests/` and `solution/` are present for the chosen tasks.
   If verifiers are absent, the success endpoint is unavailable and the instrument is rejected —
   the HF mirror withholds them, so this is a real risk, not a formality.
2. Pristine run scores 0 and reference solution scores 1, in a verifier container the agent never
   touches. A task failing either gate is replaced, not tuned.
3. Baseline solvability: `native` completes one task with a non-empty submission and a verified
   reward. Iteration 1's ABS lesson — a 0 caused by an unmet submission contract is not a
   capability measurement.
4. Mechanism can fire at all: offline, confirm the ejection arm's boundaries occur >= 12.5 turns
   apart on a recorded trace of that length and that it would eject a non-zero number of tokens.
   An arm byte-identical to its own baseline must never be written up as a failed hypothesis.
5. Turn/token ceiling derived from the pilot, not inherited.

**What this batch still will not test:** models other than GLM (Sonnet confirms winners only),
windows other than 1M-class, non-terminal task families, and sessions past ~231 episodes. A policy
that wins here is proven at LHTB scale, not proven.

### Iteration 2, kill gates 1-2 — LHTB qualifies as an instrument, and it is a better one than DeepSWE

Clone: `github.com/zli12321/LHTB`, Apache 2.0, shallow clone into the scratchpad. **Git LFS is not
installed and turned out not to be needed** for the dev subset: the software-engineering
`continue_until_timeout` tasks carry **zero LFS pointers** (games tasks carry 2 each). The clone
does require bypassing the LFS filter locally (`git config filter.lfs.process ""`,
`smudge/clean = cat`, `required = false`) because git invokes the filter even under
`GIT_LFS_SKIP_SMUDGE=1` when the binary is absent.

**Kill gate 1 — verifier availability: PASS.** All **47/47** task directories ship `tests/`,
`solution/` and `task.toml`. The HuggingFace mirror withholds verifiers; the GitHub clone does
not. The success endpoint is therefore available, which is the condition the instrument was
selected on.

**The corpus.** 47 tasks, 20 categories, **31 with `continue_until_timeout = true`**. Expert time
estimates span **30 min (games) to 600 min (management consulting)**; the tool-use "matter" tasks
are 240-600 min and the software-engineering ones 120-480. For scale reference the paper reports
9.9M tokens, ~231 episodes and 85.3 min per task, against the operator's measured ~273 turns and
67 minutes per prompt — the same regime.

**LHTB's submission contract is strictly better than DeepSWE's, and it removes iteration 1's
confound.** `task.toml` declares an explicit `artifacts` list of output files
(`outputs/validation_report.json`, `outputs/audit_summary.md`, ...). Grading reads **files**, not a
git commit. The ABS v4 zero — real work left uncommitted, `model.patch` the SHA-256 of the empty
string, pristine base graded — **cannot occur in this format.** No submission-readiness gate needs
to be invented; the benchmark already specifies one.

**The reward is dense, not binary.** `tests/test.sh` runs pytest and writes
`passed / total` to `/logs/verifier/reward.txt`. The dev task has 11 tests, so granularity is
~0.09 and the endpoint carries far more statistical power per run than a 0/1 reward. This
materially lowers the n needed to detect an effect.

**Environments are prebuilt and declarative.** `docker_image = "zli12321/lhtb-<task>:<date>"` on
Docker Hub, with `cpus`, `memory_mb`, `storage_mb`, `gpus`, `allow_internet` and
`build_timeout_sec` declared per task; separate `verifier.timeout_sec` (900) and
`agent.timeout_sec` (3600). Local Docker is 29.5.2 on aarch64, so `DOCKER_DEFAULT_PLATFORM=linux/amd64`
is required; 267 GB free.

**Development subset (operator instruction: subset only while developing).** Zero-LFS,
`continue_until_timeout`, software-engineering: `great-expectations-audit` (120 min expert, 11
tests), `langchain-version-migration` (120 min), `duckdb-optimizer-closure` (300 min) held in
reserve. The full 47 and the 240-600 min tool-use tasks are out of scope until the pipeline is
validated on these.

### Constraint change (operator, 2026-09-08 late): OpenRouter cheap models only, no Anthropic

All Anthropic arms are dropped: the planned Sonnet 5 confirmation ($106) and the Opus/Fable
pricing rows are out. GLM 5.3 Flash on OpenRouter was already the primary at ~$18 for the full
matrix, so the budget is unaffected.

**This has one scientific consequence that must be carried into every conclusion.** The
ejection break-even depends on the provider's cache price ratio, and OpenRouter GLM is the most
ejection-favourable substrate available: `cacheWrite = 0` and `cacheRead = 0.2x` give a **5-turn**
break-even against Anthropic's **12.5** (`w*keep/(r*(1-keep))`). Lens 4's finding stands —
**measuring ejection on OpenRouter systematically overstates its benefit relative to an Anthropic
deployment.** Any token-side win measured here is an upper bound for Anthropic hosts and must be
reported as such. The success-side endpoint is not affected by pricing, which is a further reason
the success-gated rule is the right one. Cross-provider confirmation is deferred, not assumed.

### Literature anchor — Edge Review, "The Long-Context Conundrum" (operator-supplied, 2026-09-08)

The article's taxonomy maps onto this project's design almost one-for-one at the level of
*mechanism*, and not at all at the level of *cost*. Both halves matter.

**Its four token-eviction criteria against ours.** The article lists recency-based ("oldest tokens
first"), attention-based ("tokens with very low attention weights from all other tokens"),
summary-based (evict detail after summarizing, retain the summary), and **dependency-tracking
("conditional eviction respecting dependencies"), which it presents as proposed rather than
built.** Ours are the same four, and our empirical results already discriminate among them:

| article criterion | our analog | status here |
| --- | --- | --- |
| recency-based | keep-last-K recency slice | **empirically refuted** (lens 3): keep-last-1 breaks 62% of the run's `edit_file` calls, keep-last-10 still breaks 21%; the longest-lived units are the *earliest and smallest* |
| attention-based | relevance + priority dual-channel scoring (§15) | untested; per-turn form killed by the cadence bound |
| summary-based | Zone B branch summaries | measured **inert** on literal recall (flat-events 15/25 vs 16/25) |
| **dependency-tracking (proposed)** | **re-derivability ranking** — keep coordinates, eject payloads a coordinate can re-derive, never eject observations nothing can re-derive | **our iteration-2 arm; the article proposes this and does not specify it** |

So the one criterion the article flags as an open direction is the one iteration 2 is built on, and
we have a concrete specification for it plus a measured re-derivation price (29,082 tokens).

**Zone A/B/C is BigBird's sparse-attention pattern lifted to the message level.** BigBird combines
global attention (a few designated tokens see everything), local/sliding-window attention
(neighbours within a fixed radius), and random attention. Our layout is global (**pinned** task,
plan, steering) + local (**recency slice**) + **summarized** distant history — the same
factorization with summary substituted for random. The article's "eclipsed attention" ("different
parts of the context are eclipsed from full view according to need") is the general form.

Its chunking family is also ours: "chunk-and-summarize" and hierarchical chunking with fusion are
the summary-headed tree; the retrieval-augmented variant of "context fusion" is
`context_search` / `context_fetch` / `context_peek`.

**THE DIFFERENCE THAT DOES NOT TRANSFER, and it is the one that produced our binding constraint.**
Every eviction and sparse-attention technique in the article operates **inside a single forward
pass, on the KV cache**. It saves FLOPs and GPU memory, and dropping a token is *free* — you simply
do not compute it. We operate on the **message list across API calls**, and we are billed for a
cached prefix. Evicting there is **not** free: it invalidates the prefix suffix and forces a
cache re-write at 1.25x input, which is the entire origin of the break-even

    turns needed after one ejection = w * keep / (r * (1 - keep))

— 12.5 turns on Anthropic, 5 on OpenRouter GLM. **No token-level technique in the article has an
analog of this cost, because none of them is paying a provider for a prefix.** Anyone importing
"token eviction" reasoning into an API-level agent harness inherits a cost model that does not
apply. This is worth stating in the eventual report: the mechanisms are borrowed legitimately, the
economics are not.

The article's quadratic claim is about **attention compute** ("every token compares itself to every
other token"; doubling length roughly quadruples the work). Ours is about **cumulative billed
tokens** (every turn re-sends the prefix). Different quantities, both O(n^2), and the router
previously conflated a linear per-turn prompt curve with a refutation of the second — see the
correction above.

**Its strongest result for us is not an eviction technique at all: it is evidence for the endpoint
we have not tested.** The article reports NIAH near 100% for GPT-4 and Claude at all tested
lengths, while the RULER benchmark and a cited enterprise trial show GPT-4 32K and Claude 2.1 100K
at only **~59% accuracy on realistic long-document QA** — "effective context often much less than
claimed context." That is external support for the one hypothesis no lens in iteration 1 could
refute: **that a shorter, better-curated context makes the model reason better.** It is the reason
the operator's success-gated endpoint is the right primary, and it means the token column is the
secondary signal rather than the verdict. Also directly relevant: this repo's own qo05 distractor
result (tail arms answered from a distractor 14/15 times with the whole tail present) is a
small-scale instance of the same phenomenon.

**Out of reach for us.** LongRoPE positional rescaling (Llama2 128K -> 2,048K), Transformer+Mamba
hybrids (LongLLaVA, 933 images on one 80GB GPU), V2PE, and mPLUG-Owl3's hyper-attention blocks
(~88% inference-time and ~48% memory reduction) are all model-internal. We are a harness over
hosted frontier models — no fine-tuning in v1 — so these are context for why the field cares, not
candidates.

**What we have that the article's techniques do not.** Versioned `node_summaries` as an audit trail
of what the model actually saw; the L0/L1/L2 rebuildability invariant (derived layers are
deterministic functions of the log); and the cache-preserving constraint that makes
`context_fetch` results append *after* Zone C rather than reorder the prefix. Prefix stability has
no counterpart in KV-cache eviction, where there is no cached prefix to protect.

## 2026-09-08 late — LOOP 3: both named mechanisms made runnable and gated

Operator direction: get usable results; test **attention-based** and **dependency-tracking**; hard
numbers on a small number of hard examples; Zone B summaries are only an **index** ("the model
once discussed X") that sends it to `context_search`, not a substitute for content.

### The unlock: every prior hypothesis was ineligible for want of hand-supplied labels

`selectAttention`'s only eviction path was `excludeIrrelevant`, which fires only on an explicit
`relevance: { value: 'irrelevant', reason }` declaration carrying current-turn evidence, and the
module deliberately refuses to infer one ("No live host inference invents missing relevance, plan,
or reference labels"). That is why the v2 replay returned `eligible: false, status: missing_labels`
for H1, H2, H3, H5, H6 and priority alike. **Both mechanisms the operator named can be computed
from L0 alone, and that is what makes loop 3 runnable at all.**

### Dependency-tracking, implemented as re-derivability

New `packages/core/src/attention/rederive.ts`. `isRederivable(tool)` is a pure function of the
producing tool name — no labels, no fitting:

- **true** — `read_file`, `write_file`, `edit_file` (a view of the filesystem) and
  `context_fetch`, `context_search`, `context_peek` (a view of the append-only trace, deterministic
  by D1). The agent can get this back by re-reading; ABS turn 39 did exactly that unprompted, at a
  measured price of 29,082 tokens.
- **false** — `run_command`. Observes transient state: exit codes, test results, the working tree
  at one instant. ABS's `git stash` A/B established which failures pre-existed and was referenced
  10 and 11 turns later; nothing on disk could reconstruct it.
- **undefined** — anything else. **Deliberately not `false`.** Both are kept, but they are
  different facts and the audit must not blur them: `false` is a classification, `undefined` is an
  admission that the host has a tool this policy has never seen. Classifying the unknown silently
  would let a new tool's output be evicted the day it ships. (The first implementation returned
  `false` for unknown tools; a test caught it.)

Policy switch `evictRederivable: { minCadenceTurns }` on `AttentionPolicy`, with
`lastEvictionTurn` supplied by the caller so `selectAttention` stays pure. **The cadence is part of
the mechanism, not a tuning knob** — it is the `w*keep/(r*(1-keep))` break-even from iteration 1
(12.5 turns on Anthropic, 5 on OpenRouter GLM), and a policy re-evaluating every turn is underwater
by construction. New disposition `evicted_rederivable`; new counters `evictedRederivableTokens`,
`evictedRederivableUnits`, `cadenceOpen`. Absent switch changes nothing.

Eviction is refused for a unit that is pinned (task/steering/plan), inside the recency slice, not
re-derivable, unclassified, **or matched by this turn's query fingerprints** — recurrence beats
re-derivability, which is the ABS turn-40 case made a rule.

Wired into `projectAttentionPrefix` (`eval/src/attention-loop.ts`): `producingTool(seq)` walks
`tool_result -> call_seq -> tool_call.tool` from L0 and feeds `isRederivable`. New evidence
counters `rederivableUnits` / `transientUnits` / `unclassifiedUnits` so an inert arm and a null
result are different numbers. Profile schema accepts `evictRederivable`.

Eight new tests in `packages/core/test/attention.test.ts` encode the intent, including the two
failure modes that would make the policy dangerous: **never evict an unrepeatable observation at
any cadence or age**, and **never evict an unfamiliar tool's output**. Full suite 1,133 passed,
9 skipped, 0 failed.

### Kill gate 4 — the mechanism-can-fire gate, zero live tokens

Substrate: the ABS v4 capture, 49 turns, 67 tool-result units, 73,049 tokens, tool mix
`run_command 37, edit_file 24, write_file 3, read_file 3`.

**Composition of the trace by re-derivability:**

| class | tokens | share | treatment |
| --- | ---: | ---: | --- |
| re-derivable | 46,511 | **63.7%** | eligible for eviction |
| transient (`run_command`) | 26,538 | **36.3%** | never evicted |
| unclassified | 0 | 0.0% | never evicted |

So on a real trace the policy has a large but bounded target: it can consider two thirds of the
context and is structurally forbidden from touching the other third. **Cadence sweep:**

| cadence | evictions fired | cadence-open turns | peak evicted |
| ---: | ---: | ---: | ---: |
| c=0 | 35 | 49 | 46,511 tok / 30 units |
| c=5 (OpenRouter break-even) | 7 | 21 | 44,748 tok / 25 units |
| c=12 (Anthropic break-even) | 3 | 17 | 12,330 tok / 18 units |
| c=25 | 2 | 16 | 41,410 tok / 23 units |

**Dependency-tracking arm: GATE PASSES, mechanism live and non-trivial at every cadence.**

**The attention-priority arm needed a second attempt, and the first result was the harness's fault,
not the arm's.** Gate 4a passed `references: []` and reported `priorityChangedOrder=false` —
"inert". That was wrong: `projectAttentionPrefix` builds **edit-provenance** edges (a write/edit to
a path emits an `edit` edge to every prior unit touching that path), and the gate had starved the
mechanism of its only available edge source. Rebuilt in gate 4b from the capture's real action
sequence (paths recovered from `events.jsonl`: `module.go` written 15x / read 15x,
`functions.go` read 7x / written 6x, `repl.go` 4x/3x, `module_test.go` 2x/1x):

    units 90 | reference edges 265 | budget = half the trace
    boost=1 halfLife=8:  priorityChangedOrder=true, selectionDiffers=true, 45 selected vs 45 base, overlap 19
    boost=1 halfLife=4:  identical
    boost=2 halfLife=8:  identical
    boost=1 halfLife=16: identical

**Attention-priority arm: GATE PASSES.** Priority replaces **26 of 45** admitted units — a large
mechanism effect, not a marginal reordering.

**But note what is identical across all four parameter settings, because it is a finding.** With no
query fingerprints, relevance is 0 for every unit, so ranking is decided entirely by priority and
*any* positive boost yields the same order. `boost` and `halfLifeTurns` are therefore **inert in
the zero-relevance limit** and can only matter when relevance is non-zero and competing. Live runs
do supply fingerprints, so this does not block the arm — but it means a sweep of these two
constants on a fingerprint-free substrate would have measured nothing, and any future tuning of
them must report the relevance distribution alongside.

**Methodology lesson for the skill.** The gate's own instruction — "prove the candidate's mechanism
can fire at all" — is not enough on its own: gate 4a *ran*, produced a clean `false`, and would
have retired a live mechanism as inert. What caught it was asking where the mechanism's inputs come
from in production and checking the gate supplied them. **A mechanism-can-fire gate must be fed the
same inputs the live path builds, and an "inert" verdict is a claim about the gate until that is
verified.**

### Zone B re-specified per the operator (not yet implemented)

Zone B summaries are an **index, not content**: their job is to tell the model that it once worked
on X so it can go find X with `context_search`. This is consistent with the measured result that
Zone B is inert on literal recall (flat-events 15/25 vs 16/25) — an index should not be expected to
answer from itself — and with the headline-fingerprint work already in the record. Under this
reading the correct Zone B evaluation is **whether it raises the rate of successful retrieval**,
not whether the model can answer from Zone B directly. Registered as a distinct arm for a later
loop; no code yet.

### Loop 3 live batch — pre-registered BEFORE the numbers land

Manifest `reports/metrics/attention-policy-continuation/loop3-pilot.json`, epoch
`74dbe1364cfdf769ffcfbdec67c8a2d270138889b424cb1c598eaf3807ffc425`, output
`loop3-pilot-n1/`. Task `great-expectations-audit` (11 dense pytest cases).
Model `z-ai/glm-5.3-flash` via OpenRouter, provider-default sampling. Window 1,310,720.

**Shared budget, not a shared clock.** Every arm gets the same all-model token ceiling —
**1,552,615**, derived by `max-run-plus-max-request` from the ABS v4 capture (measured run
1,490,544 + its largest single request), verified by the harness against the source hash rather
than asserted. The question the design asks is therefore *who gets furthest on equal tokens*, and
the dense reward answers it. **This ceiling is ~1/6 of LHTB's published 9.9M mean, deliberately:
loop 3 is looking for winning patterns cheaply. No published claim may rest on it, and the scored
batch must derive its ceiling from a completed LHTB pilot.**

**Four arms, one measurable change each.**

| arm | policy | isolates |
| --- | --- | --- |
| `native` | full history, no policy | the practitioner default |
| **`attn-control`** | attention arm, payload `whole`, **no attention policy** | **the arm's plumbing** |
| `attn-priority` | `priority: { boost 1, halfLifeTurns 8 }` | attention-based eviction |
| `dep-rederive-c5` | `evictRederivable: { minCadenceTurns 5 }` | dependency-tracking eviction |

`attn-control` is the arm that makes the other two readable. Without it, any gap between `native`
and a policy arm could be the attention arm's own plumbing — its payload selection, its message
rendering, its L0 round-trip — rather than the mechanism under test. Both policy arms are read
**against the control**, not against native.

Cadence 5 is chosen because the substrate is OpenRouter GLM (`cacheWrite = 0`, `cacheRead = 0.2x`),
whose break-even is 5 turns. It is derived, not tuned.

**Endpoint, per the operator's standing rule.** Dense reward (`passed/total`) is primary; prompt
tokens secondary. **A token win accompanied by any reward regression is recorded as a regression,
never a tradeoff.** Registered now because the break-even arithmetic already predicts the token
direction, so the token column cannot be allowed to become the verdict.

**Reading rules, fixed in advance.**
- n=1 per arm. **This batch cannot settle anything.** It is a pilot: it proves the pipeline live,
  produces an LHTB-derived ceiling for the scored batch, and gives a first read on whether either
  mechanism moves the reward at all. Any arm ordering it produces is a hypothesis for n=5, not a
  result. The harness enforced this — `stage: pilot` implies `n=1` and `scheduleSlots` accepts only
  n in {1,5,10}, so n=3 was refused. That guard was left intact rather than relaxed.
- A run whose status is not `completed` has reward **null**, never 0.
- `mechanismEvents` / `evictedRederivableUnits` / `priorityChangedOrder` must be nonzero for a
  policy arm's number to mean anything. **An arm whose mechanism never fired is reported as inert,
  not as a failed hypothesis** — gate 4 already caught one such false negative in this loop.
- `evidenceVerified` must be true. It was silently `false` for every LHTB run until the
  `inspectAttempt` fix landed this loop; any run predating that fix is void.
- Before quoting any reward, confirm it against the raw `reward.txt` in that run's artifacts, per
  the standing provenance rule.

**What this batch will not test:** any model but GLM 5.3 Flash, any task but one, full-length LHTB
horizons, Anthropic cache economics (this substrate is the most ejection-favourable available, so a
token win here is an upper bound), and the Zone-B-as-index arm, which has no code yet.
