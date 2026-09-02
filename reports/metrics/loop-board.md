> Markdown equivalent of [loop-board.html](./loop-board.html). The HTML version is the canonical rendering; this file exists so the report is readable and diffable in git.

# Context-Tree Loop Board

loop 7 · complete (7 iterations) · **v6.x final** · snapshot 2026-09-01 15:05 CDT

## Summary tiles

| Value | Label | Note |
|---|---|---|
| v6.x | final config | + lazy-tokens at the Zone C budget |
| 121 | runs today | all landed · 7 experiment batches |
| $20.76 | API spend today | program total ≈ $44 |
| 833 | tests green | 9 skipped (live-only) |
| 2 of 4 | scenarios at parity+ | sw-1 & sw-4; sw-2/sw-3 gap open |

## Leaderboard — long-horizon pair (n=5 medians)

Cost median · turns median · success, tree configs vs the cached-native baseline every arm must beat. Same-epoch runs, same model (sonnet-5), judged by hidden test suites. Sampling temperature cannot be pinned on Claude 5 — the API rejects the parameter — so every verdict is a median over replicates.

| config | state | sw-1-jsonc | turns | ok | sw-2-multimod | turns | ok |
|---|---|---:|---:|---:|---:|---:|---:|
| **native**<br>full transcript, incremental cache — the baseline | baseline | $0.097 | 19 | 5/5 | $0.151 | 35 | 3/5 |
| **v5.6.1**<br>prior head: zone cache + summarize-on-close + FM-1 fix | superseded | $0.180 | 16 | 5/5 | $0.272 | 18 | 5/5 |
| **v5.7**<br>+ lazy-k(4) + det-root + no-atools | shelved | $0.101 | 11 | 5/5 | $0.427 | 40 | 4/5 |
| **v5.7b**<br>det-root + no-atools (ablation: lazy-k off) | superseded | $0.156 | 18 | 3/4 | $0.231 | 19 | 4/4 |
| **v5.8**<br>+ fetch-results-are-events (stuck-tail bug fix) | superseded | $0.105 | 13 | 4/5 | $0.224 | 24 | 5/5 |
| **v5.9**<br>+ args dropped when post-state present — too aggressive | shelved | $0.206 | 25 | 4/5 | $0.265 | 23 | 4/5 |
| **v5.9b**<br>+ args capped at 512B when post-state present | superseded | $0.170 | 21 | 4/4 | $0.130 | 16.5 | 4/4 |
| **v6.x**<br>+ lazy-tokens: full trace while it fits the Zone C budget (v6.0+v6.1 pooled — identical config, no run crossed) | final | $0.098 | 11 | 10/10 | $0.163 | 25 | 10/10 |
| **v6.2**<br>crossing probe at 8k: bounded swap is SAFE (no flail) but does not pay at this scale — machinery correctly dormant | probe | — | — | — | $0.185 | 26 | 5/5 |

Final read: **v6.x is the consistent config** — sw-1 at exact cost parity ($0.098 vs $0.097) with 10/10 vs 5/5 and half the turns; sw-2 at +8% cost with 10/10 vs 3/5 (cost-per-success $0.17 vs $0.29); sw-4 beaten outright; sw-3 the one open cost gap (+$0.037). v5.9b's cheaper summarized mode on sw-2 ($0.130) shows what the machinery earns at long horizons; v6.x engages it only when the trace outgrows the context budget — which, on tasks this size, is correctly never.

## Gap anatomy — where each dollar goes (sw-2, per-run means)

The five-bucket decomposition the verdict runs on. Two buckets are solved: summarizer overhead fell $0.089 → $0.020 (deterministic root, no strong-model call) and fresh input fell $0.043 → $0.002 (the never-dropping fetch tail was a bug — payloads now ride the cache). The remaining gap is almost entirely **cache writes**, which v5.9's payload dedup targets.

**Gap anatomy — stacked bar chart, where each dollar goes (sw-2, per-run means)** (data rendered as table in this markdown equivalent)

| config | fresh input | output | cache read | cache write | summarizer | total |
|---|---:|---:|---:|---:|---:|---:|
| v5.6.1 tree (prior head) | $0.0428 | $0.1412 | $0.0598 | $0.0754 | $0.0886 | $0.408 |
| v5.9b tree (current head) | $0.0017 | $0.0625 | $0.0240 | $0.0451 | $0.0115 | $0.145 |
| native (baseline) | $0.0001 | $0.0802 | $0.0588 | $0.0321 | $0.0000 | $0.171 |

## Diverse suite — the generalization check

Two new self-verifying scenarios built today so candidates aren't tuned to one task shape: **sw-3-refactor** (API migration across 5 files, 29 hidden tests) and **sw-4-bughunt** (two planted defects in a 5-stage pipeline, 23 hidden tests). Both turned out short-horizon (6–11 turns) — they test that the tree devolves gracefully. All 12 runs succeeded.

| scenario | tree (v5.7 gates, n=3) | native (n=3) | Δ cost | note |
|---|---:|---:|---:|---|
| sw-3-refactor | $0.070 · 10t | $0.050 · 9t | +40% | residue = Zone A size + uncached map/tail |
| sw-4-bughunt | $0.047 · 8t | $0.039 · 11t | ≈ parity | within noise; tree wins turns |

v5.9 gate-set reruns on both are in flight (n=3).

## Findings ledger

### Landed today

- **Deterministic root** — the strong-model Zone B root call is a pure headline compose now; its truncation-retry failure mode is gone. Summarizer bucket $0.089 → $0.020. *Never regressed success across n=9.*
- **Stuck-tail bug fixed** — "ephemeral" fetch results never actually dropped (dead code) while the prompt claimed they would; one run re-billed a 7.6k-token payload fresh for 12 turns ($0.19). Context-tool exchanges are L0 events now.
- **Schema dedup** — tool schemas shipped twice (API param + 1.1k-token Zone A text block). Text block deleted.
- **§8 retry fix** — truncation doublings no longer consume the contract retry; bounded ×3, loud failure after.
- **Payload dedup, capped** — a written file rendered twice per event (args + post-state). v5.9 dropped args entirely and sw-1 turns went 13 → 25: an edit's args are the model's only record of *what it changed*. v5.9b caps args at 512B instead — sw-2 fell to $0.130. *Lesson: dedup the bytes, keep the intent.*
- **Attribution telemetry** — per-model spend ledger persisted in every results.json.

### Shelved / ruled out

- **lazy-k (below-k skip)** — works exactly as designed below k (6/6 diverse runs, zero summarizer spend) and won sw-1 outright, but the mid-task crossing swap makes agents flail: runs crossing late (t11–17) hit the 40-turn cap; early crossers (t6–8) were fine. *Shelved pending a transition fix that doesn't add a rule.*
- **Temperature pinning** — Claude 5 API rejects the parameter outright. Variance control is statistical: n≥5, medians, IQR.
- **DSA / eviction line** — remains retired: destructive when it fires, dead weight when cache-safe.
- **Epoch-merge (B-bump/C-swap desync)** — real ~$0.02 mechanism, but needs the §17 cache harness to attack safely. Backlog.

## The whole algorithm, as shipped (v5.8)

The program's standing constraint: if it stops fitting in a dozen lines of pseudo-code, it's wrong. Today's iterations *removed* three rules and added none.

```
every event (message, any tool exchange) → append to L0        # one rule, no tail special case
on phase close:
    summarize closed leaves on the cheap model                 # haiku, parallel
    root summary = title + one headline per leaf               # pure function, no LLM call
every turn, prompt =
    A: contract + tool schemas (frozen)                        # cached, never changes
  | B: branch summaries, creation order          [breakpoint]  # bumps only when a leaf changes
  | C: active-branch events, one block each      [moving bp]   # prior blocks read at 0.1×
  | C:map + volatile tail                                      # the only uncached bytes
```

## In flight now

**closed** — **v5.9 — write_file payload dedup** (n=5 on sw-1/sw-2, n=3 on sw-3/sw-4). A written file's content rendered *twice* per event — once in `args:`, once as the post-state blob — and the duplicate rode through every cache write (1.25×) and read (0.1×/turn). Now the post-state renders once. Predicted: $0.02–0.03 off the sw-2 cacheWrite bucket, plus smaller summary prompts. Verdict criteria: beat v5.8 medians with success ≥ 5/5 held.

---

DS-STAR loop: analyze (5 lenses) → synthesize → plan (3 angles) → judge → implement → verify n≥5 → route

context-tree eval · deepswe-agents-last-exam · claude-sonnet-5
