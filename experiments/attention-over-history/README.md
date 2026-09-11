# Attention over history — untested hypothesis

This folder holds the **attention-over-history** hypothesis: retain/evict past context by how much
it bears on the current turn. It was lifted out of `packages/core/src/attention/` (see
`snapshot/`, git history preserved) because **the package holds only settled results, and this
hypothesis was never validly tested** — it is not superseded canon, it is unfinished research.

## Why it left the package

- The bespoke eval harness that would have measured attention policies could not represent a tool
  call (its `ChatMessage` had no `tool_calls` field), so it stripped the model's own tool calls and
  replayed results as user text. **Every arm comparison it produced is void.** The harness was
  deleted (D20). `reports/metrics/harness-deletion-and-hypothesis-register-report.md` §2–3.
- `selectAttention` (relevance-mass admission + priority boost), `rederive.ts`/`evictRederivable`
  (the priority channel), and `topic-index.ts` ("Zone B as an index") have **zero production
  callers** and pass only a *mechanism-can-fire* gate — never an *effect* measurement. The priority
  channel's `boost`/`halfLifeTurns` were shown **inert** in the zero-relevance limit (the gate can't
  discriminate them without query fingerprints). Register §6, hypothesis-ladder :873–882.
- `signals.ts` `detectAttentionSignals` is a **void artifact**: four regexes standing in for the
  "small classifier over assistant text" the design specified; it fires on 0.245% of turns. This is
  a mis-implementation, not a result — do not revive the regex approach. Register §4.

The umbrella hypothesis and H1–H6 are on the register's explicit **untested** list.

## What the record already settles about it (design constraints for the test)

- **It is an ADMISSION signal, not an eviction one.** D-EV4 measured relevance-to-recent as the
  *worst* eviction signal (0.06/0.10) — a dormant-but-returning unit by definition doesn't match the
  recent window, so relevance-eviction drops exactly the unit that returns. So attention/relevance
  belongs at the **retriever / assembler-in** (what to pull back), and eviction stays keyed on
  priority + recency + drift-dormancy. `reports/metrics/assembler-weighting/report-assembler-weighting.md`
  conclusion 4 (D-EV4/D-EV5).
- **Per-turn attention-eviction destroys the prefix cache.** `flex-remix` (re-pick each turn) is the
  measured cache-death case (433k vs 341k effCost). Anthropic break-even to invalidate a cached
  prefix is ~12.5 turns at keep=0.5 (`cacheWrite 1.25×` / `cacheRead 0.1×`). So admission must
  **append after the buffer** (never reorder the prefix) and fire at a **multi-turn cadence**, and
  the experiment must report effective cost, not token volume. `reports/metrics/assembler-flex-buffer/report.md`,
  register §7 item 6.

## The test design (to build here before any re-promotion)

See `reports/session-handoff.md` → "Untested-hypothesis experiment backlog" item 1. In short:
- **Arm:** relevance-admission (push query-relevant dormant units back up-front, append-only) vs the
  on-demand baseline. This is also the spec's OPEN "retrieval trigger" A/B.
- **Regime:** the overflow regime — the corpus that reaches it exists (109 sessions ≥100 tool calls,
  55 > 131K tokens). Use a task with cross-turn retention required and **no re-read escape**.
- **Falsification (fixed in advance):** the admission arm must beat on-demand on task-success in the
  overflow regime by a pre-set margin, or attention-as-admission is retired. Report cacheWrite/cacheRead.

Only a settled result from that experiment earns a return to `packages/`.
