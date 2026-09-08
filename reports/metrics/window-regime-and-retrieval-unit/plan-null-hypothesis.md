# Plan: Null Hypothesis (Stance C)

Run the already-developed arm (tree-search-coordinates, 8 offline gates passed, 0 live rows) at two windows — the existing baseline window and one modeling a realistic host. No new code. No Fable interface port. The 2x2 factorial below decomposes window size from compact search using one existing cell (tree-tail-v2 W=65536: 1/25, provenance-audit 0 unearned).

## 1. CANDIDATES

### A — tree-search-coordinates at eff-W=130,000

Compact-search arm at effective window 130,000, simulating W=200k with a 70k host prompt (`--window 130000` is arithmetically exact per A2 Section 0). **Bucket**: delivery, currently 0 live rows; the nearest comparison is tree-center-filename at W=65536 (4/25, all on qo03). **Arm flag**: `--window 130000 --arms truncate-tail,tree-search-coordinates --questions-file questions-deep.json`, model glm-5.3-flash, n=5. **Kill gate**: offline script computing `truncationBoundarySeq` at W=130000 and asserting all 5 deep-set seqs (18, 151, 193, 218, 264) fall below the boundary (~354). Zero live tokens. **Win**: tree-search-coordinates > 0/25 on the deep set, AND truncate-tail = 0/25 at this window (confirming the questions test overflow, not the tail).

### B — tree-search-coordinates at W=65,536

Same arm at the window where all prior baselines were measured. **Bucket**: delivery, same. **Arm flag**: `--window 65536 --arms tree-search-coordinates --questions-file questions-deep.json`, n=5. Truncate-tail reused from existing results (0/50 across two files, provenance-verified). **Kill gate**: `search-coordinate-killgate.mjs` — already PASS (8/8, last verified in A3; NC23 tokens min=1194, max=1402). **Win**: score > 4/25, OR score >= 4/25 with successes on questions OTHER than qo03 (the only one tree-center-filename answered — its branch is 813 tokens, small enough to fit through residual headroom).

### C — tree-tail-v2 at eff-W=130,000

Standard tree arm (20-hit full-surface search) at the wider window. Isolates the window-size variable from compact search. **Bucket**: delivery, 1/25 at W=65536. **Arm flag**: `--window 130000 --arms tree-tail-v2 --questions-file questions-deep.json`, n=5. Shares truncate-tail baseline with A. **Kill gate**: same validity gate as A. **Win**: score > 1/25.

Together with the existing cell (tree-tail-v2 W=65536: 1/25), A+B+C form a 2x2 factorial {compact-search, standard-search} x {W=65536, W=130000}. The window effect is (A+C) minus (B+existing); the compact-search effect is (A+B) minus (C+existing).

## 2. ORDER

**B first.** Cheapest batch (~$0.40). Result gates what follows: if tree-search-coordinates scores 0/25 at W=65536, the freed headroom (~5k tokens) is insufficient and the small-window regime is confirmed as the binding constraint — proceed to the wider window. If it scores > 4/25, the compact search alone moved the needle and the wider window provides incremental rather than enabling value.

**A + C second**, as one batch with shared truncate-tail baseline (~$1.98). B's result determines interpretation: if B showed 0/25, A vs C tells us whether wider headroom alone (C) is enough or compact search (A minus C) also matters. If B scored well, A tells us whether the wider window compounds.

## 3. MECHANISM

**B (compact search, W=65536)**: `tree-search-coordinates` replaces the 20-hit full-surface search (6,094-7,257 tokens, centering report Section 3) with coordinate-only hits (1,194-1,402 tokens, killgate NC23). Freed headroom: 4,900-5,855 tokens. After the first search, appendable headroom rises from ~600-1,800 to ~5,500-7,650 tokens. **Fires when** the first `context_fetch` returns non-zero `afterChars` (row field `toolCalls[].afterChars > 0`) on a question where tree-center-filename returned zero. **Recorded** per row: `toolCalls[].afterChars`, `toolCalls[].droppedChars`, `resultTokensTruncated`, `perLiteral`.

**A (compact search, W=130000)**: Same search savings plus wider window. Headroom before any tool call is ~18,339 tokens (A2 Section 2); after compact search, ~16,937-17,145 remains for fetch — enough for a 57k-token branch to deliver a 16k-token band. **Fires when** fetch payloads arrive non-empty AND the band contains an answer literal. **Recorded**: same fields; additionally `peakRequestTokens` confirms the prompt fits the window.

**C (standard search, W=130000)**: No compact search — the 20-hit full-surface response costs 6.1-7.3k tokens. But headroom starts at ~18k, leaving 11-12k for fetch after search. **Fires when** even at full search cost, the wider window provides enough headroom for non-empty fetches. Comparison to A isolates whether the 5k compact-search savings matters at this headroom level.

## 4. COST

| Candidate | Runs | Input tokens (est.) | Output tokens | Cost |
|---|---:|---:|---:|---:|
| B (W=65536, search-coords) | 25 | 5,300k | 5k | $0.40 |
| A (W=130k, search-coords) | 25 | 13,100k | 5k | $0.99 |
| A truncate-tail baseline | 25 | 2,600k | 5k | $0.20 |
| C (W=130k, tree-tail-v2) | 25 | 10,500k | 5k | $0.79 |
| **Total** | **100** | **31,500k** | **20k** | **$2.38** |

Existing baselines reused at zero cost: truncate-tail W=65536 deep (0/50, two files), tree-tail-v2 W=65536 deep (1/25), naive-full W=200k deep (25/25). All provenance-verified (A3, audit output: 0 unearned).

## 5. WHAT THIS PLAN DOES NOT TEST

- **Fable behavioral guidance** (opens-per-question cap, query construction hints). Requires contract text changes (~230 LOC per A4). Deferred: the existing mechanism may suffice once headroom is adequate.
- **Hit-count reduction to 5.** At eff-W=130k, compact search uses <8% of headroom (1.4k of 18.3k). Further reduction saves ~1k tokens — unlikely to bind.
- **Page-token addressing.** Architectural change. Worth testing only if A scores well on selection but fails on centering (the qo04 pattern persisting at wider headroom).
- **Snippet-in-hit.** Keyword variant refuted (18/25 vs 18/25, +32% tokens). Prose variant untested. Deferred until delivery is validated.
- **Longer traces.** The s1 trace (196k cl100k) overflows adequately at eff-W=130k (48% outside the tail per A2 Section 1). A larger fixture is needed only for W >= 400k.
- **Model-specific effects.** All runs use glm-5.3-flash. Generalizes only to the extent headroom arithmetic is model-independent.
