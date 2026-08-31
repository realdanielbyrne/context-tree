# Testing

**Run targeted tests locally; the full suite is CI's.**

```bash
pnpm vitest run packages/core/test/segment.test.ts    # one file — the default
pnpm vitest run packages/core/test                    # one package
pnpm vitest run                                       # full suite = CI's
pnpm typecheck                                        # tsc over src and test
```

Tests **never hit the network.** Not "usually" — never. Every model call in the
suite goes through `MockProvider` or `RecordedProvider`, and any test that would
dial out is a defect. Live-model tests are opt-in:

```bash
LIVE=1 ANTHROPIC_API_KEY=... pnpm vitest run packages/core/test/live
```

## The five kinds of test here, and what each is for

### 1. Unit tests on the deterministic layers

`segment`, `store`, `trace`, `blobs`, `spans`, `tokens`. These layers have no
LLM in them at all, which is the point of the design — so their tests are
ordinary, fast, and exhaustive. Table-driven where the input space is a mapping
(tool → phase), invariant-driven where it is a data structure.

A test name here should name the decision it protects, not the function it
calls:

```
✗ it('marks nodes stale')
✓ it('marks the leaf and every ancestor, and no sibling')
```

The second one fails when D4 breaks. The first one passes forever.

### 2. Golden fixtures

Recorded traces under `eval/fixtures/`, with the derived tree snapshotted. A
segmenter change shows up as a fixture diff you have to look at and approve —
which is the whole reason L1 is rebuilt rather than migrated.

Fixtures in this repo are **synthetic**, generated programmatically or
hand-authored to mirror the shape of real sessions. Real transcripts are not
committed: scrubbing is never provably complete, and a trace log is a verbatim
record of someone's private work.

### 3. Contract tests against recorded completions

Prompt templates are versioned artifacts (`src/prompts/*.v1.md`). Their tests
run against cassettes so a prompt edit is a visible diff in a golden snapshot,
and CI never needs a key. `RecordingProvider` re-records with one flag rather
than hand-edited JSON.

The thing being tested is the **§8 content contract**: does the model's reply
carry the structured rehydration pointers — files with spans, symbols, tests,
artifacts, open questions, decisions? A summary that violates it is worse than
no summary, because §9's entire relevance-detection story rests on those fields
being present.

### 4. The cache assertion harness

`packages/core/src/cache/` plus `packages/core/test/cache.test.ts`. A
deterministic tokenizer and a provider cache simulator, asserting **exactly
which prefix ranges survive each event type**.

This is the highest-leverage test infrastructure in the project, because D5 is
the one decision whose violation is silent. Break the zone layout and nothing
fails — the system just quietly costs several times more. The harness makes it
fail.

One test per event type:

| Event | What must survive |
|---|---|
| append a turn to the active branch | Zone A + Zone B; only Zone C is fresh |
| phase transition | Zone A; Zone B up to the newly-appended summary |
| `context_fetch` result | everything before the tail |
| a middle branch re-summarized | Zone A; Zone B up to that branch (the honest cost of D3/D4) |
| Zone B relevance-ordered *(negative control)* | nothing — the harness must catch this |

The negative control is mandatory. A harness that can't catch the exact
regression §10 rule 1 forbids is decoration.

### 5. The resumption benchmark

`eval/` — §15. Not a unit test; a benchmark with four arms on the same frontier
model:

| Arm | Context given to the fresh resuming agent |
|---|---|
| A | full transcript (quality upper bound, worst cost) |
| B | flat last-N-token window (what naive agents do) |
| C | single-level whole-transcript summary (Mem0-style flatten) |
| D | **this system** (tree summaries + active branch + tools) |

Metrics: success rate, tool-call count, input tokens split cache-read vs
cache-write, p50/p95 latency, cost per task, and organization quality
(stale-summary incidents, `context_peek` precision).

It costs real money and it is not part of `pnpm test`.

## What a test must not be

- **A test that cannot fail.** Asserting a function returns without throwing,
  or snapshotting output nobody reads.
- **A test that mirrors the implementation.** If it re-derives the expected
  value with the same code path, it asserts nothing.
- **A network call.** See above.
- **A write outside `mkdtempSync`.** Nothing in the suite may write inside the
  repo.
