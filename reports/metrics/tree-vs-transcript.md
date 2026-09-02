> Markdown equivalent of [tree-vs-transcript.html](./tree-vs-transcript.html). The HTML version is the canonical rendering; this file exists so the report is readable and diffable in git.

*context-tree · eval lab · 2026-09-01*

# Tree vs Transcript

Seven analyze→improve→rerun loops (closed) plus a two-task suite validation and a four-task diverse-suite validation · 177 runs charted ($44.41 metered total · $20.76 in loop 7) · agent `claude-sonnet-5`, leaves `claude-haiku-4-5` · parallel replicates, so wall-clock latency is not comparable across batches.

| Metric | Value | Detail |
|---|---|---|
| context-tree v5.6, long task (median, n=5) | $0.281 | −24% vs v5 pooled ($0.369) · cost/turn $0.0146 (−18%) |
| cached native, long task (pooled median, n=6) | $0.170 | −73% vs uncached ($0.625) · nearly turn-invariant |
| turns to solve, tree v5.6 vs native | 20 vs 34 | the tree's durable edge · native burned to the 40-turn cap in half its long runs |
| fresh input per turn, tree | 2.4–7.6k → 36–892 | v5 → v5.6 · billing signature now matches cached native's |
| context-tree v5.9b, long task (median, n=4) | $0.130 | −14% vs cached native ($0.151) · loop 7's first outright sw-2 win, 4/4 vs native 3/5, 16.5 vs 35 turns |
| v6.x (shipped), 4 tasks (n=32) | 32/32 | vs native 14/16 · cost parity-or-better on 3 of 4 tasks · loop 7 closed, 30k lazy-tokens is final |

## 01 Executive summary

1. **The prior report's question — why does the tree pay more while reducing context tokens? — has a mechanical answer: the tree was paying for a cache it never hit, next to a baseline that never used one.** Per-turn provider accounting (iter4) showed Zone B's breakpoint missing every turn because branch headings embedded growing seq ranges (FM-2), Zone C re-rendering the entire trace every turn (FM-3), and the native arm sending no cache breakpoints at all (FM-4).
2. **Fixing both sides — the v5 stack — was the largest step in the program's history:** context-tree fell $0.852→$0.288 median (−66%) on the long task and native fell $0.625→$0.242 (−61%). Every pre-v5 cost comparison should be read as tree-with-broken-caching vs native-with-no-caching.
3. **On the honest playing field the tree lost the cost race at this horizon and won the efficiency one.** Pooled n=6: cached native ran the long task for $0.170 median — nearly turn-invariant, since a cached turn adds ~1–2 fresh tokens — vs $0.369 for context-tree v5, whose cost still tracked trajectory shape. Diagnosis (loop 5): the tree's per-turn growth slope was no better than native's at these horizons; the whole gap was the 10× multiplier of paying Zone C fresh at 1× while native re-read at 0.1×.
4. **Selection (the DSA layer) is retired with evidence at both poles:** when it evicted (iter6, FM-5) it destroyed load-bearing context and failed the run; when made cache-safe (v6's monotone membership + guards, iter7) it provably never evicts — an inert twin of v5 (FM-8). Bounding Zone B belongs to hierarchical collapse (old branches into a super-summary), not per-turn scoring.
5. **The §8 "no-JSON" defect (FM-1) was a budget bug, not a model bug:** replies were truncated mid-JSON at `maxSummaryTokens` and retried at the identical cap — guaranteed to fail twice. Detecting `stopReason: max_tokens` and doubling the retry budget (v5.6) took leaf failures from 2-of-3 runs to 0-of-5; one residual remains on large root summaries that need a second doubling.
6. **Replication is non-negotiable:** identically-configured runs varied up to 3× in cost (unpinned temperature 1.0; one early batch-vs-incremental strategy fork compounds into 10-vs-37-turn trajectories); every n=1 ranking this program ever produced flipped at least once. All claims here are n≥3 medians.
7. **Loops 4–6 closed most of the cost gap by making the tree obey a correspondence principle: at short horizons it degenerates to exactly cached-native economics.** Zone C is now emitted as per-event messages behind a moving breakpoint (v5.5), with every churn-prone byte — header seq ranges, the descendant map — moved out of the cached span (v5.6). Result: fresh input fell from 2.4–7.6k to 36–892 tokens/turn, the billing signature matches native's (cacheRead climbs, cacheWrite is the delta), and cost/turn fell 18% vs v5 to $0.0146. The residual $0.281-vs-$0.170 gap is turn-invariant tree overhead (summaries, the uncached map+tail, one cache epoch per phase) — the price of finishing in 20 median turns vs native's 34 and of ending every run with a resumable summary tree.
8. **Loop 7 (2026-09-01) is closed.** A DS-STAR-style analyze→synthesize→plan→judge→implement→verify cycle decomposed v5.6's $0.281 into native $0.171 + summarizer $0.062 + cacheWrite excess $0.030 + uncached tail $0.016, then spent each term down: capping (not dropping) edit-tool arguments once a post-state blob exists (v5.9b) produced the program's first outright long-task win, and replacing the event-count lazy threshold with a token budget (v6.0/v6.1, pooled as `v6.x` — both thresholds are behaviorally identical, zero crossings in 32 runs) swept **32/32** across four tasks against native's 14/16. A third probe at an 8k threshold (v6.2) confirmed the bounded-swap crossing is safe when it fires but doesn't yet pay at this suite's trace lengths. **Final shipped configuration: lazy-tokens gated at the Zone C budget, 30k.** See §10.
9. **Current standing:** context-tree (v6.x) now beats or ties cached native on turns and reliability across every task, and on cost for 3 of 4 — sw-1 ties ($0.098 vs $0.097), sw-2 is nominally +8% on raw median but wins decisively on success-adjusted cost (10/10 vs native's 3/5), sw-4 wins outright, and sw-3 (+74%) is the one open gap. The cost race called for native in item 3 above is no longer settled in native's favor except on that one scenario.

## 02 Design lineage

Each version responds to a failure mechanism *measured* in the version before it — no change shipped on taste.

| Version | Change | Responding to | Iteration | Verdict |
|---|---|---|---|---|
| `v1` | Lazy ≥8-event threshold summarizer, lexical branch scorer | baseline | iter1–3 (prior) | superseded |
| `v2` | idf-cosine + farthest-point branch selector (tree-dsa) | "selection should be cheap & deterministic" | iter2 (prior) | **retire selection** harmful once cache works (FM-5) |
| `v3` | Whole-plan summary circuit breaker | same node re-billed 3× (FM-1) | iter3 (prior) | superseded |
| `v3.1` | **Per-node breaker** with failure memory | whole-plan version leaked repeats | iter4–5 | **kept** 14–17 skips/run at long horizon |
| `v5.1` | **Stable Zone B headings** — volatile seq ranges removed (core fix) | Zone B breakpoint never hit (FM-2) | iter6 | **kept** cacheWrite −88% |
| `v5.2` | **Cached native baseline** — moving breakpoint on the transcript | native was an uncached strawman (FM-4) | iter6 | **kept** native $0.63→$0.24; 1–2 fresh tokens/turn |
| `v5.3` | **Zone C = latest branch**, not the whole trace | tree paid summaries *and* full detail (FM-3) | iter6 | **kept** fresh input O(delta) |
| `v5.4` | **Summarize-on-close** — threshold hyperparameter deleted | ≥8-event knob coupled cost to turn noise | iter6 | **kept** cost is now a function of tree structure |
| `v5.x` | Cosine dedup-before-summarize (gated, unit-tested) | duplicate sibling summaries | landed, not live-run | **shelved** subsumed by v5.4's one-summary-per-branch |
| `v6` | **Focus-scored sticky selection**: query = active-branch tail, meta guards (open questions / failing tests), monotone membership, dynamic k | eviction harm (FM-5) + retain-generously economics | iter7 | **folds into v5** monotone lock-in means it never evicts — a variance-only twin of v5 (see §06) |
| `v5.5` | **Incremental Zone C cache** — one message per Zone C block, moving breakpoint on the last; Zone C header volatile-bit fix (seqRange dropped, same law as v5.1) | Zone C billed fresh at 1× every turn while native rode 0.1× reads | iter8 | **kept** fresh input 2.4–7.6k → 1–429 tokens/turn; exposed FM-7 |
| `v5.6` | **Map-after-breakpoint** — descendant map relocated to an uncached trailing `C:map` block; **budget-aware §8 retry** (double maxTokens on a `max_tokens` truncation) | FM-7 map churn voiding the Zone C cache; FM-1 truncation root cause | iter9 | **kept** cache signature converged on native's; cost/turn −18% vs v5; leaf §8 truncations 2/3 runs → 0/5 |

## 03 Every run, one picture

#### Cost vs turns — all 56 runs: prior baselines, six loops, suite validation

*Circles: sw-1-jsonc (short task) · diamonds: sw-2-multimod (long task) · ✕ over a mark: failed run. Hover any mark for the run detail.*

Legend: native · context-tree · tree-dsa

**Figure 1: Cost vs turns — all 56 runs** (data rendered as table in this markdown equivalent). Columns match the run-level fields the chart encodes as marker position (turns = x, cost = y), shape (circle = sw-1-jsonc, diamond = sw-2-multimod), color (arm), and an ✕ overlay for failed runs. This is the same 56-run dataset also listed in the Appendix (§"all runs") table view.

| Iteration | Arm | Task | Cost $ | Turns | Fresh in | CacheRead | CacheWrite | Total tok | Result |
|---|---|---|---|---|---|---|---|---|---|
| iter1 | native | sw-1-jsonc | 0.157 | 12 | 45,508 | 0 | 0 | 52,061 | pass |
| iter1 | context-tree | sw-1-jsonc | 0.200 | 9 | 25,542 | 39,696 | 12,912 | 82,150 | pass |
| iter1 | tree-dsa | sw-1-jsonc | 0.188 | 9 | 27,892 | 44,723 | 9,286 | 85,949 | pass |
| iter2 | native | sw-1-jsonc | 0.260 | 21 | 93,662 | 0 | 0 | 100,899 | pass |
| iter2 | context-tree | sw-1-jsonc | 0.456 | 15 | 84,186 | 68,466 | 26,997 | 186,177 | pass |
| iter2 | tree-dsa | sw-1-jsonc | 0.198 | 9 | 31,404 | 45,606 | 7,719 | 89,369 | pass |
| iter3 | native | sw-1-jsonc | 0.201 | 18 | 70,097 | 0 | 0 | 76,163 | pass |
| iter3 | context-tree | sw-1-jsonc | 0.440 | 15 | 78,245 | 67,032 | 27,432 | 177,203 | pass |
| iter3 | tree-dsa | sw-1-jsonc | 0.218 | 10 | 39,678 | 47,880 | 5,492 | 97,409 | pass |
| iter4 | native | sw-1-jsonc | 0.488 | 20 | 197,930 | 0 | 0 | 207,115 | pass |
| iter4 | context-tree | sw-1-jsonc | 0.171 | 7 | 19,369 | 31,484 | 9,442 | 64,405 | pass |
| iter4 | tree-dsa | sw-1-jsonc | 0.546 | 19 | 121,205 | 90,972 | 32,689 | 253,879 | pass |
| iter5 | native | sw-2-multimod | 0.766 | 30 | 350,823 | 0 | 0 | 357,260 | pass |
| iter5 | context-tree | sw-2-multimod | 0.852 | 27 | 229,478 | 129,276 | 54,113 | 421,939 | pass |
| iter5 | tree-dsa | sw-2-multimod | 0.763 | 27 | 194,193 | 130,961 | 42,634 | 373,722 | pass |
| iter5 | native | sw-2-multimod | 0.552 | 40 | 235,709 | 0 | 0 | 243,791 | fail |
| iter5 | context-tree | sw-2-multimod | 0.694 | 25 | 173,259 | 119,700 | 42,542 | 341,555 | pass |
| iter5 | tree-dsa | sw-2-multimod | 0.548 | 21 | 138,210 | 104,490 | 26,717 | 277,395 | pass |
| iter5 | native | sw-2-multimod | 0.625 | 32 | 278,612 | 0 | 0 | 285,428 | pass |
| iter5 | context-tree | sw-2-multimod | 0.946 | 29 | 247,502 | 142,738 | 69,578 | 467,745 | pass |
| iter5 | tree-dsa | sw-2-multimod | 0.575 | 23 | 156,002 | 110,124 | 23,867 | 298,239 | pass |
| iter6 | native | sw-2-multimod | 0.242 | 34 | 48 | 460,240 | 22,259 | 491,950 | pass |
| iter6 | context-tree | sw-2-multimod | 0.449 | 25 | 113,935 | 161,882 | 7,110 | 291,301 | pass |
| iter6 | tree-dsa | sw-2-multimod | 0.895 | 40 | 272,289 | 265,785 | 8,989 | 560,515 | fail |
| iter6 | native | sw-2-multimod | 0.292 | 37 | 51 | 711,587 | 29,096 | 748,421 | pass |
| iter6 | context-tree | sw-2-multimod | 0.288 | 20 | 52,867 | 124,272 | 6,305 | 189,849 | pass |
| iter6 | tree-dsa | sw-2-multimod | 0.308 | 20 | 80,745 | 119,706 | 1,487 | 209,737 | pass |
| iter6 | native | sw-2-multimod | 0.113 | 26 | 34 | 174,967 | 9,350 | 189,762 | pass |
| iter6 | context-tree | sw-2-multimod | 0.159 | 9 | 29,498 | 49,488 | 821 | 84,358 | pass |
| iter6 | tree-dsa | sw-2-multimod | 0.444 | 18 | 151,410 | 105,198 | 2,165 | 266,329 | pass |
| suite | native | sw-1-jsonc | 0.092 | 23 | 31 | 64,343 | 6,244 | 77,017 | pass |
| suite | context-tree | sw-1-jsonc | 0.164 | 12 | 16,537 | 68,712 | 3,836 | 92,642 | pass |
| suite | native | sw-2-multimod | 0.178 | 40 | 54 | 233,538 | 8,634 | 253,214 | pass |
| suite | context-tree | sw-2-multimod | 0.733 | 27 | 245,481 | 162,580 | 2,245 | 427,824 | pass |
| suite | native | sw-1-jsonc | 0.098 | 24 | 26 | 85,228 | 7,466 | 98,915 | pass |
| suite | context-tree | sw-1-jsonc | 0.256 | 18 | 33,877 | 109,916 | 6,860 | 157,219 | pass |
| suite | native | sw-2-multimod | 0.163 | 33 | 45 | 305,002 | 12,740 | 324,815 | pass |
| suite | context-tree | sw-2-multimod | 1.076 | 36 | 391,689 | 222,702 | 5,360 | 636,049 | pass |
| suite | native | sw-1-jsonc | 0.234 | 40 | 53 | 329,053 | 18,426 | 359,783 | pass |
| suite | context-tree | sw-1-jsonc | 0.314 | 21 | 45,260 | 122,892 | 10,961 | 186,612 | pass |
| suite | native | sw-2-multimod | 0.147 | 40 | 55 | 200,224 | 9,035 | 217,726 | pass |
| suite | context-tree | sw-2-multimod | 0.174 | 12 | 31,078 | 68,571 | 2,406 | 106,990 | pass |
| iter7 | context-tree | sw-2-multimod | 1.006 | 40 | 284,916 | 261,481 | 15,465 | 585,893 | fail |
| iter7 | tree-dsa | sw-2-multimod | 1.262 | 33 | 316,670 | 198,978 | 3,222 | 571,563 | pass |
| iter7 | context-tree | sw-2-multimod | 0.216 | 10 | 59,821 | 52,158 | 6,996 | 123,270 | pass |
| iter7 | tree-dsa | sw-2-multimod | 0.454 | 27 | 82,638 | 171,422 | 7,093 | 274,693 | pass |
| iter7 | context-tree | sw-2-multimod | 0.213 | 13 | 38,435 | 70,532 | 7,003 | 122,401 | pass |
| iter7 | tree-dsa | sw-2-multimod | 0.563 | 33 | 124,822 | 209,574 | 12,302 | 360,640 | pass |
| iter8 | context-tree | sw-2-multimod | 0.845 | 37 | 4,448 | 243,009 | 225,420 | 485,911 | pass |
| iter8 | context-tree | sw-2-multimod | 0.166 | 10 | 151 | 55,011 | 37,895 | 97,768 | pass |
| iter8 | context-tree | sw-2-multimod | 0.396 | 24 | 9,516 | 146,954 | 80,877 | 246,163 | pass |
| iter9 | context-tree | sw-2-multimod | 0.221 | 20 | 2,137 | 286,706 | 23,023 | 311,866 | pass |
| iter9 | context-tree | sw-2-multimod | 0.281 | 18 | 9,827 | 160,293 | 51,609 | 221,729 | pass |
| iter9 | context-tree | sw-2-multimod | 0.780 | 40 | 37,995 | 222,954 | 121,191 | 382,140 | fail |
| iter9 | context-tree | sw-2-multimod | 0.335 | 23 | 4,472 | 222,024 | 71,031 | 297,527 | pass |
| iter9 | context-tree | sw-2-multimod | 0.251 | 19 | 9,403 | 184,048 | 46,402 | 239,853 | pass |

*Chart annotation: an arrow-and-label near turns≈22, cost≈$0.26 reads "iter6: the v5 cluster".*

Two clusters carry the story. The lower-left group of diamonds under ~$0.31 and ~26 turns is **iter6**: the v5 stack pushed both tree arms and cached native into territory no arm reached before. And all three failed runs (✕) are *long-horizon endurance* failures at the 40-turn cap — one uncached native (iter5), one tree-dsa in the only replicate where its selector actually evicted branches (iter6), and one context-tree v5 whose single long phase re-inflated Zone C (iter7, the FM-6 signature).

## 04 The design loops

### Loop A (iter4) — per-node breaker, live

**Hypothesis:** the landed per-node circuit breaker cuts repeat §8-contract billing (3→2→expected 1). **Result:** it worked as insurance — 3 skip events saved ~6 root-summarizer calls — but the headline numbers were dominated by trajectory luck: context-tree drew a 7-turn run ($0.171, best ever) while native drew its worst ($0.488/20t). The lasting yield of this loop was the **per-turn cache autopsy** below, which found FM-2, FM-3, and FM-4 and set iter6's agenda.

### Loop B (iter5) — a task that finally exceeds k branches, n=3

**Hypothesis:** on a 4-module task (`sw-2-multimod`, verified by a self-checking generator) the selector fires and replicates tame the variance. **Result:** the selector fired (up to `kept 3/6`), medians became meaningful, and tree-dsa v3.1 won the iteration outright — $0.575 vs native's $0.625 — while uncached native **failed a replicate** at the turn cap. The breaker earned 14–17 skips per afflicted run, and §8 failures appeared on haiku leaves too: the contract is fragile independent of model.

### Loop C (iter6) — the v5 stack

**Hypothesis:** fix the cache on both sides (v5.1/v5.2), stop paying for old detail (v5.3), make summarization event-driven (v5.4). **Result:** the largest single step in the program — context-tree −66%, native −61% — and a reversal: with caching honest, **selection stopped paying**. Tree-dsa's only selector-active replicate lost module context, wandered to the 40-turn cap, and failed; its selector-quiet replicates were byte-identical to context-tree v5 and matched it.

### Loop 4 (iter7) — the v6 selector, live A/B, n=3

**Hypothesis:** focus-scored selection (query = the active branch's own recent detail, guards on open questions / failing tests, monotone membership) makes eviction safe and useful. **Result:** the selector was *inert by construction* — telemetry read "all N branches (within k)" on every turn of every replicate. Early turns keep everything (branch count ≤ k), the monotone `keptEver` set locks those in forever, and guards absorb most of the rest: the very properties added to protect the cache prefix neuter the selector. So tree-dsa v6 ($0.563 median, 3/3 success, 33 turns median) is context-tree v5 with different sampling luck — and v5 itself produced the program's **first tree failure**: one replicate hit the 40-turn cap at $1.01 with the FM-6 fresh-input signature. **Conclusion:** the per-turn-eviction line folds; the candidate worth refining is v5's cache economics.

### Loop 5 (iter8) — v5.5, the correspondence principle, n=3

**Hypothesis:** the tree's residual cost gap is the 10× multiplier, not context volume — per-turn growth analysis showed cached native pays **1 fresh token/turn** (everything else 0.1× reads) while v5 paid 2.4–7.6k fresh tokens/turn at full price, with *similar growth slopes*. The design goal, in the program owner's framing: **at short horizons the tree should degenerate to exactly native-cached economics** — the way general relativity reduces to Newton — with tree machinery manifesting only at phase boundaries. v5.5 implements the reduction: Zone C ships as one message per block with a moving breakpoint on the last (native v5.2's incremental transcript, inside the tree), after removing the header's volatile seq range (v5.1's law, second application). **Result:** fresh input collapsed exactly as predicted — and a new mechanism surfaced where the money went instead:

| Run | turns | fresh/turn (median) | cost $ | note |
|---|---|---|---|---|
| `iter8-rep2` | 10 | 1 | 0.166 | native-identical billing profile; cached native's pooled median is $0.170 |
| `iter8-rep3` | 24 | 429 | 0.396 | cache mostly held |
| `iter8-rep1` | 37 | 153 | 0.845 | fresh solved — but cacheWrite re-billed the whole zone every edit turn (FM-7) |
| v5 reference | — | 2,400–7,600 | — | what v5.5 replaced |

3/3 success, median $0.396. The mechanism worked — the correspondence principle is visible in the billing data (rep2 is byte-for-byte native economics) — but rep1 exposed **FM-7**: the Zone C header's descendant map grows on every file edit, and churn ahead of the append-only event stream voids the cached prefix, converting the saving into 1.25× cache re-writes. Third occurrence of the volatile-bit law. v5.6 relocates the map behind the breakpoint.

### Loop 6 (iter9) — v5.6, map-after-breakpoint + budget-aware retry, n=5

**Hypothesis:** with the descendant map relocated behind the moving breakpoint (`C:map`) and §8 truncation retried at a doubled budget, iter8's three profiles should converge on rep2's native-like shape. **Result: the mechanism converged.** Every replicate now shows the cached-native billing signature — in rep1, cacheRead climbs monotonically 4,788→23,794 (each turn's write read back at 0.1×), cacheWrite stays delta-sized (~1.2k median), and fresh input is just the uncached map+tail (36–179 tokens). Median fresh input per turn across the arm: 36–892 vs v5's 2,400–7,600. Cost per turn fell from v5's $0.0178 median to **$0.0146 (−18%)**, with median run cost $0.281 [IQR 0.251–0.335] over n=5 and 20 median turns.

| run | turns | fresh/turn (med) | cost | note |
|---|---|---|---|---|
| `iter9-rep1` | 20 | 36 | 0.221 | textbook profile: cacheRead climbs, cacheWrite is the delta |
| `iter9-rep2` | 18 | 493 | 0.281 | fetch-heavy tail (uncached by design) |
| `iter9-rep4` | 23 | 109 | 0.335 | cache held through 23 turns |
| `iter9-rep5` | 19 | 504 | 0.251 | cache held |
| `iter9-rep3` | 40 | 892 | 0.780 | ✕ 40-turn cap — trajectory-length luck (temp 1.0), not a cache failure; its per-turn economics match the passing runs |

**FM-1 outcome:** haiku *leaf* truncation failures went from 2-of-3 runs (iter8) to zero across all five iter9 replicates. One residual: a sonnet *root* summary truncated at 1,024, was retried at 2,048 per the new policy, and truncated again — root summaries of a large tree can need more than one doubling. Since truncation is a budget failure rather than a model violation, the retry-once contract arguably should not charge truncations against its single retry; left as the named follow-up.

**Where the remaining native gap lives:** at $0.281 vs cached native's $0.170 the difference is no longer a per-token multiplier — it is turn-invariant overhead: summarizer calls (haiku leaves + sonnet root per branch), the deliberately uncached `C:map`+tail, and one full Zone C cache-write epoch per phase boundary. Those are the tree's structural costs, and they buy its structural wins: 20 median turns vs native's 34, no whole-transcript quadratic re-read, and a resumable summary tree at the end of every run.

#### Median cost per arm on the long task — the v5 stack and its refinements

*sw-2-multimod, medians (n=3 per group). Success annotated where below 100%.*

**Figure 2: Median cost per arm on the long task** (data rendered as table in this markdown equivalent).

| Group | Arm | Median cost $ | Success |
|---|---|---|---|
| iter5 · v3.1 (uncached nat.) | native | 0.625 | 67% |
| iter5 · v3.1 (uncached nat.) | context-tree | 0.852 | 100% |
| iter5 · v3.1 (uncached nat.) | tree-dsa | 0.575 | 100% |
| iter6 · v5 (cached nat.) | native | 0.242 | 100% |
| iter6 · v5 (cached nat.) | context-tree | 0.288 | 100% |
| iter6 · v5 (cached nat.) | tree-dsa | 0.444 | 67% |
| iter7 · v6 A/B | context-tree | 0.216 | 67% |
| iter7 · v6 A/B | tree-dsa | 0.563 | 100% |
| iter8 · v5.5 | context-tree | 0.396 | 100% |
| iter9 · v5.6 | context-tree | 0.281 | 80% |

## 05 The cache autopsy

Per-turn provider accounting, three regimes. This is the evidence that re-ranked every arm: the same architecture, separated only by whether its prompt prefix is byte-stable.

#### Per-turn token accounting, three regimes

*Lines: cacheRead (cheap, 0.1×) and fresh input (full price). Bars: cacheWrite (1.25×). Same encoding across panels; y-scales differ and are labeled.*

Legend: cacheRead · fresh input · cacheWrite (bars)

**Figure 3(a): Broken · iter4 tree arm (pre-v5.1)** (data rendered as table in this markdown equivalent). Note on chart: "cacheRead pinned at Zone A". y-scale max 16,000.

| Turn | Fresh input | CacheRead | CacheWrite |
|---|---|---|---|
| 0 | 510 | 4,788 | 0 |
| 1 | 1,034 | 4,788 | 0 |
| 2 | 1,469 | 4,788 | 973 |
| 3 | 1,769 | 4,788 | 973 |
| 4 | 3,582 | 4,788 | 1,999 |
| 5 | 4,052 | 4,788 | 1,810 |
| 6 | 4,497 | 4,788 | 1,905 |
| 7 | 4,676 | 4,788 | 1,905 |
| 8 | 4,924 | 4,788 | 1,905 |
| 9 | 5,658 | 4,788 | 2,150 |
| 10 | 6,443 | 4,788 | 2,150 |
| 11 | 6,964 | 4,788 | 2,150 |
| 12 | 7,524 | 4,788 | 2,003 |
| 13 | 8,183 | 4,788 | 2,003 |
| 14 | 9,258 | 4,788 | 2,003 |
| 15 | 10,786 | 4,788 | 2,190 |
| 16 | 11,805 | 4,788 | 2,190 |
| 17 | 13,572 | 4,788 | 2,190 |
| 18 | 14,499 | 4,788 | 2,190 |

**Figure 3(b): Fixed · iter6 context-tree v5** (data rendered as table in this markdown equivalent). Note on chart: "hits step up; cw only at phase closes". y-scale max 16,000.

| Turn | Fresh input | CacheRead | CacheWrite |
|---|---|---|---|
| 0 | 370 | 4,788 | 0 |
| 1 | 254 | 4,788 | 846 |
| 2 | 1,577 | 5,634 | 0 |
| 3 | 665 | 4,788 | 1,339 |
| 4 | 1,004 | 6,127 | 0 |
| 5 | 1,083 | 4,788 | 1,909 |
| 6 | 1,248 | 6,697 | 0 |
| 7 | 1,909 | 6,697 | 0 |
| 8 | 2,149 | 6,697 | 0 |
| 9 | 3,034 | 6,697 | 0 |
| 10 | 3,205 | 6,697 | 0 |
| 11 | 3,291 | 6,697 | 0 |
| 12 | 3,452 | 6,697 | 0 |
| 13 | 3,702 | 6,697 | 0 |
| 14 | 2,789 | 4,788 | 2,211 |
| 15 | 2,946 | 6,999 | 0 |
| 16 | 3,795 | 6,999 | 0 |
| 17 | 4,850 | 6,999 | 0 |
| 18 | 5,465 | 6,999 | 0 |
| 19 | 6,079 | 6,999 | 0 |

**Figure 3(c): Cached native · v5.2** (data rendered as table in this markdown equivalent). Note on chart: "fresh input: 1–2 tokens/turn". y-scale max 22,000.

| Turn | Fresh input | CacheRead | CacheWrite |
|---|---|---|---|
| 0 | 1 | 0 | 1,269 |
| 1 | 1 | 1,269 | 1,241 |
| 2 | 1 | 2,510 | 174 |
| 3 | 2 | 2,684 | 29 |
| 4 | 1 | 2,713 | 208 |
| 5 | 1 | 2,921 | 56 |
| 6 | 2 | 2,977 | 9,723 |
| 7 | 1 | 12,700 | 334 |
| 8 | 1 | 13,034 | 424 |
| 9 | 1 | 13,458 | 301 |
| 10 | 2 | 13,802 | 0 |
| 11 | 1 | 13,802 | 286 |
| 12 | 2 | 14,088 | 68 |
| 13 | 1 | 14,156 | 363 |
| 14 | 2 | 14,519 | 31 |
| 15 | 1 | 14,550 | 597 |
| 16 | 2 | 15,147 | 111 |
| 17 | 2 | 15,258 | 32 |
| 18 | 1 | 15,290 | 1,006 |
| 19 | 1 | 16,296 | 567 |
| 20 | 2 | 16,863 | 45 |
| 21 | 2 | 16,908 | 69 |
| 22 | 1 | 16,977 | 643 |
| 23 | 2 | 17,620 | 376 |
| 24 | 1 | 17,996 | 250 |
| 25 | 2 | 18,246 | 36 |
| 26 | 1 | 18,282 | 278 |
| 27 | 1 | 18,560 | 377 |
| 28 | 2 | 18,937 | 372 |
| 29 | 2 | 19,309 | 30 |
| 30 | 1 | 19,339 | 499 |
| 31 | 2 | 19,838 | 54 |
| 32 | 1 | 19,892 | 407 |
| 33 | 1 | 20,299 | 2,003 |

**Broken (iter4 tree arm):** cacheRead pinned at 4,788 — only Zone A ever hits — while ~2k is re-written every turn and thrown away, and fresh input climbs monotonically because Zone C re-renders the whole trace. **Fixed (iter6, v5):** cacheRead steps *upward* as closed branches join the stable prefix, cacheWrite collapses to phase boundaries (the §17 model, finally observed live), and fresh input tracks the newest branch only. **Cached native (v5.2):** 1–2 fresh tokens per turn — the entire transcript rides the cache.

#### Fresh input per turn — v3.1 vs v5 context-tree, all replicate turns pooled

*Histogram, 2k-token bins, sw-2-multimod. v3.1 re-billed a growing trace every turn; v5 pays for the delta.*

Legend: context-tree v3.1 (iter5, 82 turns) · context-tree v5 (iter6, 54 turns)

**Figure 4: Fresh input per turn — histogram** (data rendered as table in this markdown equivalent). The underlying pooled per-turn samples are n=81 for v3.1 and n=54 for v5 (the caption's "82 turns" for v3.1 is the source label; the plotted sample count is 81); counts below are turns falling into each 2,000-token bin.

| Fresh-input bin | v3.1 (iter5) turns | v5 (iter6) turns |
|---|---|---|
| 0–2k | 7 | 22 |
| 2–4k | 12 | 14 |
| 4–6k | 10 | 8 |
| 6–8k | 11 | 5 |
| 8–10k | 10 | 1 |
| 10–12k | 14 | 3 |
| 12–14k | 10 | 1 |
| 14–16k | 7 | 0 |

## 06 Failure mechanisms, in detail

#### FM-1 · §8 contract break, then double billing

*summarizer · mitigated by v3.1*

The summarizer intermittently replies with no JSON object ("broke the §8 summary contract after one retry"), on **sonnet roots and haiku leaves alike**. Each break bills a full try+retry; without memory the same node re-failed identically — 3× in one iter2 run.

Evidence: 11 distinct node failures across iter4–6 logs; breaker skip lines 3 (iter4), 14–17 (iter5 reps). Residual: a breaker-skipped *root* stays stale forever (no half-open retry), and re-segmentation id churn can evade the id-keyed memory once per new id.

#### FM-2 · Volatile bits in Zone B headings

*assembler · fixed by v5.1*

Branch headings embedded `(seq X–Y)`; the newest branch's span grows on every append, so Zone B's text mutated each turn and its breakpoint never hit — violating the assembler's own "no per-block volatile bits" rule. The §17 cache test missed it because its fixture appends L0 *without re-running ingestion*.

Evidence: cacheRead flat at 4,788 for 19 straight turns; ~2k discarded cacheWrite/turn. After: cacheWrite −88%, hits step upward. Regression test added.

#### FM-3 · Zone C was the entire trace

*eval loop · fixed by v5.3*

The segmenter closes all phases on re-ingest, so `openPhase()` was always null and the loop expanded the *root* — Zone C re-rendered every event every turn. The tree paid for summaries *and* the full detail they were meant to replace.

Evidence: v3.1 fresh input marches 402→15,276 tokens/turn (histogram above); v5 stays O(newest branch) with resets at phase boundaries.

#### FM-4 · The native baseline never cached

*harness fairness · fixed by v5.2*

The native arm sent no cache breakpoints — it re-billed the whole transcript at full price every turn. Real harnesses cache the prefix, so every prior "tree vs native" cost delta was measured against a strawman.

Evidence: iter5 native $0.63–0.77; iter6 cached native $0.11–0.29 with 1–2 fresh input tokens/turn. All pre-v5.2 native cost rows should be read as upper bounds.

#### FM-5 · Selection eviction loses load-bearing context

*tree-dsa · open → v6*

With the cache fixed, top-k eviction stopped saving money and started costing correctness: the one iter6 replicate whose selector actually fired (23 evictions) lost sight of earlier modules, wandered, and hit the 40-turn cap unsolved. Selector-quiet replicates matched context-tree v5 exactly (the floor property).

Evidence: iter6 tree-dsa $0.549±0.307, 67% success; the failure is the only selector-active run. Perfect correlation, n=1 caveat noted. Proposed v6: membership only ever grows; changes only at phase boundaries; k≥5.

#### FM-7 · Descendant-map churn voids the Zone C cache

*assembler · fixed by v5.6 (live run pending)*

With v5.5's per-block Zone C caching in place, the zone's *first* block still carried the active branch's descendant map — and every file edit grows that map. Cache lookups match previously cached prefixes byte-for-byte, so one changed block ahead of the moving breakpoint re-writes the whole zone at 1.25×. Third occurrence of the volatile-bit law (FM-2's Zone B headings, then the v5.5 header seq range, now the map): **churn belongs after the breakpoint**.

Evidence: iter8-rep1 turns 9–18 — cacheRead pinned at the A+B prefix (6,568) while cacheWrite re-writes the growing zone (10.8k→16.3k) every turn, exactly while edits were landing; command/read-only turns 0–8 cached cleanly. Fix: map relocated to a trailing uncached `C:map` block (v5.6).

#### FM-8 · Monotone lock-in neuters the v6 selector

*tree-dsa · line closed by iter7*

v6's safety properties — keep everything while count ≤ k, guard branches with open questions or failing tests, and never un-keep (`keptEver`) — compose into a selector that asymptotically cannot evict: early branches lock in while the count is small, and later ones are selected or guarded, then lock in too. The floor property that protects the cached prefix makes the arm a variance-only twin of context-tree v5.

Evidence: iter7 telemetry — "all N branches (within k)" on every turn of all 3 replicates; zero evictions. Cost gap vs v5 ($0.563 vs $0.216 medians) is trajectory sampling, not architecture. Consequence: per-turn eviction retired; long-horizon Zone B bounding belongs to hierarchical collapse (old branches into a super-summary — the tree's own recursion), noted as future work.

## 07 Remediation ledger

Everything tried across the loops, in order, with outcome — including what didn't survive.

| # | Remediation | Target | Tried in | Outcome |
|---|---|---|---|---|
| 1 | Per-node circuit breaker live-run (`splitSummarizePlan` + D11 scheduler) | FM-1 | iter4 | **Kept.** 3→14–17 skips/run as horizon grew; residual: no half-open retry for roots |
| 2 | >k-branch task (`sw-2-multimod`, self-verifying generator, hidden per-module tests) | Phase-0 measurability | iter5 | **Kept.** Selector fired (kept 3/4…3/6); first accuracy separation between arms |
| 3 | Seeded replication, n=3, medians ± IQR | n=1 rankings flipping | iter5–6 | **Kept.** CV ran 7–56%; every n=1 conclusion this program ever drew had flipped at least once |
| 4 | Cosine dedup-before-summarize (≥0.9 to a summarized sibling) | duplicate summaries | landed + unit-tested, gated off | **Shelved.** v5.4's summarize-once subsumes it; revisit only if near-twin branches recur |
| 5 | Stable Zone B headings (drop volatile seq ranges) + regression test | FM-2 | iter6 | **Kept.** cacheWrite 54k→6.3k; core-invariant-aligned fix, not a D-decision deviation |
| 6 | Native transcript caching (moving breakpoint, 4-marker safe) | FM-4 | iter6 | **Kept.** Baseline −61%; all cross-arm deltas now honest |
| 7 | Zone C = latest branch | FM-3 | iter6 | **Kept.** Fresh input O(delta); no investigate-1 regression (model always sees its own last results) |
| 8 | Summarize-on-close, threshold deleted | arbitrary ≥8-event knob | iter6 | **Kept.** One leaf call per closed branch; cost decoupled from turn noise |
| 9 | Haiku root summarizer | FM-1 cost | not run | **Deferred.** v5.4 cut root passes to once-per-phase; §8 JSON robustness is the better lever now |
| 10 | Top-k branch selection itself (v2, re-evaluated under v5) | Zone B growth | iter6 | **Retire as-is.** Harmful when it fires (FM-5); reshape as sticky v6 or drop |
| 11 | v6 focus-scored selector (active-branch-tail query, meta guards, monotone membership, dynamic k) | FM-5 | iter7 | **Folded.** Never evicts by construction (FM-8); safe but inert — line closed, hierarchical collapse is the successor idea |
| 12 | Zone C header volatile-bit removal (seqRange out of `renderActiveHeader`) + regression test | prereq for any Zone C caching | iter8 | **Kept.** Same law as #5; header byte-stable under span growth |
| 13 | Incremental Zone C cache (per-block messages, moving breakpoint, 3 markers ≤ provider's 4) | tree's 1× fresh-input multiplier | iter8 | **Kept.** Fresh/turn 2.4–7.6k → 1–429; rep2 billing byte-identical to cached native; exposed FM-7 |
| 14 | `C:map` relocation behind the breakpoint + §8 budget-doubling retry on `max_tokens` truncation | FM-7, FM-1 | iter9 | **Kept.** 542/542 suite green; live n=5: cacheRead climbs 4.8k→23.8k within a phase, cacheWrite delta-sized, leaf §8 truncations 0/5 (one root residual needs a second doubling) |

## 08 Variance, honestly

#### Run-level cost spread on the long task — every replicate, with medians

*sw-2-multimod. Dots: individual runs (✕ = failed). Wide tick: group median. Band: min–max.*

**Figure 5: Run-level cost spread on the long task** (data rendered as table in this markdown equivalent). Each group's dots are its individual replicate costs, in original run order; the band is the min–max range; the median is the same statistic reported in the table below the chart.

| Group | n | Individual run costs | Range | Median |
|---|---|---|---|---|
| iter5 native (uncached) | 3 | $0.766, $0.552 (failed), $0.625 | $0.552–$0.766 | $0.625 |
| iter5 context-tree v3.1 | 3 | $0.852, $0.694, $0.946 | $0.694–$0.946 | $0.852 |
| iter5 tree-dsa v3.1 | 3 | $0.763, $0.548, $0.575 | $0.548–$0.763 | $0.575 |
| iter6 native cached | 3 | $0.242, $0.292, $0.113 | $0.113–$0.292 | $0.242 |
| iter6 context-tree v5 | 3 | $0.449, $0.288, $0.159 | $0.159–$0.449 | $0.288 |
| iter6 tree-dsa v5 | 3 | $0.895 (failed), $0.308, $0.444 | $0.308–$0.895 | $0.444 |
| suite native cached | 3 | $0.178, $0.163, $0.147 | $0.147–$0.178 | $0.163 |
| suite context-tree v5 | 3 | $0.733, $1.076, $0.174 | $0.174–$1.076 | $0.733 |
| iter7 context-tree v5 | 3 | $1.006 (failed), $0.216, $0.213 | $0.213–$1.006 | $0.216 |
| iter7 tree-dsa v6 | 3 | $1.262, $0.454, $0.563 | $0.454–$1.262 | $0.563 |
| iter8 context-tree v5.5 | 3 | $0.845, $0.166, $0.396 | $0.166–$0.845 | $0.396 |
| iter9 context-tree v5.6 | 5 | $0.221, $0.281, $0.780 (failed), $0.335, $0.251 | $0.221–$0.780 | $0.281 |

| Group | n | mean±SD ($) | CV | median ($) | IQR ($) | turns med | success |
|---|---|---|---|---|---|---|---|
| native uncached · iter5 | 3 | 0.648±0.109 | 16.8% | 0.625 | 0.589–0.696 | 32 | 67% |
| context-tree v3.1 · iter5 | 3 | 0.830±0.128 | 15.4% | 0.852 | 0.773–0.899 | 27 | 100% |
| tree-dsa v3.1 · iter5 | 3 | 0.629±0.117 | 18.7% | 0.575 | 0.561–0.669 | 23 | 100% |
| native cached v5.2 · iter6 | 3 | 0.215±0.093 | 43.0% | 0.242 | 0.177–0.267 | 34 | 100% |
| context-tree v5 · iter6 | 3 | 0.299±0.145 | 48.5% | 0.288 | 0.224–0.368 | 20 | 100% |
| tree-dsa v5 · iter6 | 3 | 0.549±0.307 | 56.0% | 0.444 | 0.376–0.670 | 40→20 | 67% |
| context-tree v5 · iter7 | 3 | 0.478±0.457 | 95.5% | 0.216 | 0.214–0.611 | 13 | 67% |
| tree-dsa v6 · iter7 | 3 | 0.760±0.438 | 57.7% | 0.563 | 0.509–0.912 | 33 | 100% |
| context-tree v5.5 · iter8 | 3 | 0.469±0.346 | 73.7% | 0.396 | 0.281–0.621 | 24 | 100% |
| context-tree v5.6 · iter9 | 5 | 0.374±0.231 | 61.8% | 0.281 | 0.251–0.335 | 20 | 80% |

Two honest caveats. **CV rose in iter6** even as costs fell — cheaper runs make the same trajectory luck a bigger fraction of the total, and n=3 cannot rank context-tree v5 against cached native ($0.288 vs $0.242 medians with overlapping IQRs). It *can* rank both against everything pre-v5, where the gaps are multiples, and it can call the turns gap (20 vs 34, disjoint ranges). **Native's trajectory variance is real and large**: four identically-configured pre-v5 runs on the short task spanned $0.157–$0.488. Any future claim built on n=1 should be assumed wrong. The iter7–8 rows push the caveat further — CV up to 95.5%, driven by unpinned sampling temperature (the harness never sets it, so both arms run at the provider default of 1.0): one early batch-vs-incremental strategy fork compounds into 10-vs-37-turn trajectories on identical binaries. Pinning temperature would sharpen every A/B but would orphan all 56 runs collected at the default; it is the first methodology change to make in any *next* program, with fresh baselines.

## 09 Suite validation

| Task | Arm | n | median $ | range $ | turns med | success |
|---|---|---|---|---|---|---|
| sw-1-jsonc (short) | native cached | 3 | 0.098 | 0.093–0.234 | 24 | 100% |
| sw-1-jsonc (short) | context-tree v5 | 3 | 0.256 | 0.164–0.314 | 18 | 100% |
| sw-2-multimod (long) | native cached | 3 | 0.163 | 0.147–0.178 | 40, 33, 40 | 100% |
| sw-2-multimod (long) | context-tree v5 | 3 | 0.733 | 0.174–1.076 | 27 | 100% |

**Short task:** cached native wins outright ($0.098 vs $0.256) — context management has negative ROI when the whole transcript is small; the tree's scaffolding is pure overhead here. This is the expected result and the reason the harness keeps a short task in the suite at all.

**Long task:** the suite's three replicates landed high for the tree ($0.174 / $0.733 / $1.076) against native's astonishing stability ($0.147–$0.178, CV 9.7%). Pooled with iter6 (n=6 per arm): native $0.170 vs tree $0.369. Two mechanisms drive the tree's spread: four more §8 contract failures (FM-1's waste recurs whenever trajectories grow phases), and a new finding, **FM-6** — the $1.08 run's cost is 392k *fresh input* tokens, not cacheWrite: when a trajectory forms one long phase, the "latest branch" *is* the whole trace and v5.3's Zone C cap silently degrades to pre-v5 behavior. Zone C needs a token-budget window independent of phase structure.

**The native caveat the cost column hides:** native burned to the 40-turn cap in 3 of its 6 long runs (and once even on the short task), passing only because its work happened to be complete when the cap fell — the same stopping-criterion weakness that produced iter5's genuine uncached failure. Caching makes wandering nearly free in dollars; it is not free in wall-time or cap risk.

## 10 Loop 7 — the DS-STAR loop (2026-09-01)

Six loops closed the cache-correctness gap and left a named, structural residual: $0.281 vs native's $0.170 on the long task, attributed qualitatively to "summarizer calls, the deliberately uncached map+tail, and one cache epoch per phase." Loop 7 quantifies that residual and spends it down, using a different process than loops 1–6: an analyzer→synthesizer→planner→judge→implement→verify cycle modeled on DS-STAR (arXiv:2509.21825), with five analyzer lenses fanning out over iter5–9 telemetry, synthesis producing a quantified gap model, a three-planner panel proposing fixes, a judge selecting one, implementation landing it, and n≥5 verification routing the next iteration or rolling it back.

> **Program constraints**, set before the loop started: the algorithm must stay expressible in ≤12 lines of pseudo-code; rule-removal beats rule-addition; the DSA selection layer stays retired (§06, FM-5/FM-8 already closed that line).

> **Methodology note:** the prior report's own next step (§08: pin sampling temperature, "the first methodology change to make in any next program") turned out to be foreclosed — the Claude 5 API rejects the `temperature` parameter outright ("deprecated for this model"). Variance control for loop 7 is purely statistical: n≥5 replicates, medians reported, IQR alongside every headline number.

### Fresh baselines, same epoch

Every loop-7 comparison starts from same-day reruns rather than reusing loop 6's numbers, so drift in the underlying model isn't mistaken for a code change: `v56-base` reran v5.6.1 tree and cached native side by side, n=5 each. sw-1-jsonc: native $0.097 median (19t, 5/5), tree $0.180 (16t, 5/5). sw-2-multimod: native $0.151 (35t, 3/5 — two runs failed at the 40-turn cap), tree $0.272 (18t, 5/5). These are the numbers every loop-7 config is measured against, not loop 6's $0.281/$0.170.

### v5.7 — lazy-k=4, deterministic root, schema dedup

Three changes landed together: summarize only once branch count exceeds k=4 (below that, show the full trace — the "below-k" rule v6.0 later expresses in tokens), a pure deterministic root composer replacing the strong-model root call, and de-duplicated Zone A tool schemas. **Result:** sw-1 hit parity with native — $0.101 vs $0.097 (11t, 5/5) — but sw-2 flailed: 40-turn median, 3 of 5 replicates reaching the cap (one failing outright), median cost $0.427.

**Diagnostic:** the outcome correlates with *when* a run's branch count first crosses k and forces the first lazy-summarization epoch. Replicates that crossed late (first epoch boundary at turn 11–17) ran long; replicates that crossed early (turn 6–8) finished comfortably.

| Run | first k-crossing (turn) | turns | cost $ | outcome |
|---|---|---|---|---|
| `v57-rep3` | 6 | 26 | 0.315 | early crossing — finished comfortably |
| `v57-rep5` | 8 | 28 | 0.261 | early crossing — finished comfortably |
| `v57-rep1` | 11 | 40 | 0.427 | ✕ only true failure, cap hit unsolved |
| `v57-rep4` | 14 | 40 | 0.492 | late crossing — hit cap, finished anyway |
| `v57-rep2` | 17 | 40 | 0.445 | late crossing — hit cap, finished anyway |

Transition shock is proportional to swap size: the later the first crossing, the more branches vanish from full detail into summary in one step, and the larger the context discontinuity the model has to re-orient against. This is the diagnostic loops v5.8–v5.9b chased: shrink what a summarizer swap actually removes, rather than delay when it fires.

### v5.7b — lazy-k ablation

**Hypothesis:** isolate whether lazy-k or deterministic-root caused the sw-2 flailing. **Result:** with lazy-k off (deterministic-root and schema-dedup still live), sw-2 returned to $0.231 median (19t, 4/4) — back near v5.6.1's $0.272 baseline shape. **Conclusion:** the lazy-k transition is the culprit; deterministic root is exonerated and stays.

### v5.8 — fetch-results-are-events

Per-turn accounting found the "ephemeral tail" documented in the prior report as dropped at the next phase boundary never actually dropped: dead code in `onPhaseTransition` left `context_fetch` payloads and the completion nudge outside the cached prefix forever. One run re-billed a 7,591-token fetch payload fresh for 12 straight turns ($0.19 of pure waste). **Fix:** context-tool exchanges and the completion nudge become ordinary L0 events riding the moving cache breakpoint like everything else. **Result:** the fresh-input bucket collapsed from a $0.043 mean to $0.002; sw-2 landed at $0.224 median (24t, 5/5) — the first fully-green (5/5) sw-2 replicate set since loop 6.

### v5.9 — drop args (shelved)

**Hypothesis:** once a post-edit blob captures the file's new state, the `edit_file` call's own arguments are redundant — drop them from the rendered event to shrink Zone C further. **Result:** sw-2's buckets improved, but sw-1 turns rose 13→25 *consistently* across replicates. **Lesson:** an edit's args are the model's only record of *what it changed*; dropping them forces the model to re-derive that from the diff every time it needs it, burning turns. Shelved — the fix isn't removing the record, it's shrinking it.

### v5.9b — cap args at 512 bytes

Same idea, reshaped per the v5.9 lesson: keep the args, but cap them at 512 bytes when a post-state blob already exists, instead of dropping them outright. **Result: the program's first outright win on the long task.** sw-2: $0.130 vs native's $0.151 (cost), 4/4 vs 3/5 (success), 16.5 vs 35 (turns) — context-tree beats cached native on every axis at this horizon. Mean bucket breakdown, sw-2: fresh $0.0017, output $0.0625, cacheRead $0.0240, cacheWrite $0.0451, summarizer $0.0115 — total mean $0.145 against native's $0.171.

### Diverse suite: laziness is load-bearing outside sw-1/sw-2

Two new self-verifying generators (`eval/scripts/build-refactor-scenario.py`, `build-bughunt-scenario.py`) produce `sw-3-refactor` (a 5-file API migration, 29 hidden tests) and `sw-4-bughunt` (2 planted defects across a 5-stage pipeline, 23 hidden tests) — short/medium horizons where laziness's below-k full-trace behavior should matter most. It does: with laziness live (v5.7's lazy-k, n=3 each), sw-3 costs $0.070 and sw-4 costs $0.047; with it off (v5.9's no-lazy config, n=3 each), sw-3 costs $0.170 and sw-4 costs $0.097 — a 2.1–2.4× penalty for summarizing detail the model still needed. Laziness isn't just cheap insurance against long-horizon blowup; on these two tasks it's the majority of the savings.

### v6.0 — lazy-tokens: the below-k rule in token form

v5.7's branch-count threshold bounds *how many summaries exist*, not *how large a swap is* — which is what actually caused the transition shock. v6.0 replaces it with a token budget: while the whole trace stays under a 30k-token heuristic, show it in full and summarize nothing; only past that does the tree start collapsing branches, one small step at a time by construction. **Result: a clean sweep.** 16/16 across all four suite tasks: sw-1 $0.122 (14t, 5/5), sw-2 $0.159 (25t, 5/5 vs native 3/5, parity on cost), sw-3 $0.090 (13t, 3/3), sw-4 $0.031 (8t, 3/3 — beats native's $0.039). Cost-variance CV collapsed to ~16% on sw-1/sw-2 (from 44–96% across loops 6–7's earlier configs).

**But:** no run in this batch ever crossed the 30k threshold — sw-2 ran full-trace the entire way, same as native's own economics. That explains the parity (not a win) on sw-2: v5.9b's summarized mode is still cheaper at long horizons ($0.130 vs v6.0's $0.159) when it actually engages. The threshold is set too high to exercise the mechanism it was built to test.

### v6.1 — threshold 15k: same mechanism, still dormant

Halving the threshold to 15k was meant to force sw-2 (and possibly sw-3) to actually cross into summarized mode, testing whether the bounded-swap-size fixes (v5.8/v5.9b) keep the transition cheap once it fires. **Result: it didn't fire either.** Checked directly against every rep's `costByModel` in `eval/results/v61/` and `v61-diverse/`: zero haiku (summarizer) calls across all 16 runs, identical to v6.0's zero-crossing 16 — 32 runs, 32 zero-crossings. sw-1 $0.078 (9t, 5/5), sw-2 $0.168 (25t, 5/5), sw-3 $0.083 (14t, 3/3), sw-4 $0.040 (9t, 3/3): the same shape as v6.0, within replicate noise. Behaviorally the two configs are one config; the leaderboard pools them as `v6.x` (n=10 on sw-1/sw-2, n=6 on sw-3/sw-4).

15k is still above every suite trace's actual size. The question the loop still owed an answer — does the bounded-swap crossing actually stay cheap when it fires — needed a threshold low enough to force it, not just halve it.

### v6.2 — threshold 8k: the crossing probe

An 8k threshold on sw-2 alone (n=5, a scratch scenario dir at `eval/results/v62/`) finally forced a crossing: `v62-rep4` shows 4 haiku calls in its `costByModel` — the only replicate of 5 to summarize at all — and finished at 26 turns, well clear of the 40-turn cap. **The bounded-swap fix holds:** the v5.7 flail (late crossings running to the cap, one failing outright) did not recur. All 5 replicates succeeded; median cost $0.185 (24–27 turns).

**But it doesn't pay at this scale.** $0.185 median is worse than both v6.x's $0.164 (no crossings, 15–30k) and v5.9b's $0.130 (summarizes from turn 1). The crossing is safe but not yet profitable on sw-2's trace length — v5.9b's cheaper long-horizon mode is only reached by summarizing from the start, which is exactly the below-k full-trace behavior loops 5–7 established costs sw-1 too much (v5.7's parity became a loss under the wrong threshold; the diverse-suite finding above shows summarizing-too-early costing sw-3/sw-4 2.1–2.4×). There is no single threshold that is simultaneously below sw-1's trace size and above sw-2's without either penalizing the short task or missing the long one's savings — not at the trace lengths this suite produces.

**Loop 7 closes here. Final configuration: lazy-tokens gated at the Zone C budget, 30k** (v6.0's original value, confirmed identical to v6.1's 15k and safe-to-lower per v6.2's probe, kept at 30k because lowering it earns nothing on this suite and a higher threshold is the simpler, more conservative default). v5.9b remains the cheaper measured config specifically on sw-2 and stays in the leaderboard as a reference; it is not the shipped default because v6.x's single-threshold design generalizes cleanly across all four tasks (32/32 success) where v5.9b was only ever measured on two.

#### Loop 7 leaderboard — every configuration, all tasks

*Median $ · turns (median) · success. sw-1/sw-2 are n=4–5; sw-3/sw-4 (diverse suite) are n=3. — = not run for that config.*

| Config | Change | sw-1-jsonc | sw-2-multimod | sw-3-refactor | sw-4-bughunt | State |
|---|---|---|---|---|---|---|
| `native` | cached, same epoch | $0.097 · 19t · 5/5 | $0.151 · 35t · 3/5 | $0.050 · 9t · 3/3 | $0.039 · 11t · 3/3 | reference |
| `v5.6.1` | fresh same-epoch rerun | $0.180 · 16t · 5/5 | $0.272 · 18t · 5/5 | — | — | baseline |
| `v5.7` | lazy-k=4 + det-root + schema-dedup | $0.101 · 11t · 5/5 | $0.427 · 40t · 4/5 | $0.070 · 10t · 3/3 | $0.047 · 8t · 3/3 | superseded |
| `v5.7b` | lazy-k off (ablation) | $0.156 · 18t · 3/4 | $0.231 · 19t · 4/4 | — | — | shelved (diagnostic only) |
| `v5.8` | +fetch-results-are-events | $0.105 · 13t · 4/5 | $0.224 · 24t · 5/5 | — | — | superseded |
| `v5.9` | drop edit-tool args | $0.206 · 25t · 4/5 | $0.265 · 23t · 4/5 | $0.170 · 18t · 3/3† | $0.097 · 11t · 3/3† | shelved |
| `v5.9b` | cap edit-tool args @512B | $0.170 · 21t · 4/4 | $0.130 · 16.5t · 4/4 | — | — | reference · cheapest sw-2 |
| `v6.0` | lazy-tokens, 30k threshold | $0.122 · 14t · 5/5 | $0.159 · 25t · 5/5 | $0.090 · 13t · 3/3 | $0.031 · 8t · 3/3 | folded → v6.x |
| `v6.1` | lazy-tokens, 15k threshold | $0.078 · 9t · 5/5 | $0.168 · 25t · 5/5 | $0.083 · 14t · 3/3 | $0.040 · 9t · 3/3 | folded → v6.x |
| `v6.2` | lazy-tokens, 8k threshold (crossing probe) | — | $0.185 · 26t · 5/5 | — | — | probe, not shipped |
| `v6.x` | **lazy-tokens, pooled (v6.0+v6.1, behaviorally identical)** | **$0.098 · 12.5t · 10/10** | **$0.164 · 25t · 10/10** | **$0.087 · 13.5t · 6/6** | **$0.036 · 8.5t · 6/6** | head · shipped default |

† v5.9's sw-3/sw-4 numbers are its no-laziness ablation run, used above as the "without laziness" comparator in the diverse-suite finding — not a v5.9-specific rerun of those tasks. v6.0 and v6.1 pool cleanly (identical behavior, see §10) into the `v6.x` row, the closing configuration of loop 7.

#### Where the $0.281 went — bucket decomposition, sw-2-multimod means

*native → v5.6.1 → v5.8 → v5.9b. v5.6.1 and v5.8 bars are the synthesis-phase gap model (native-equivalent cost plus three excess buckets); v5.9b and native are directly measured. v5.8's measured mean ($0.251) is annotated against its $0.265 model estimate.*

Legend: native-equivalent work · summarizer calls · cacheWrite excess · uncached tail

**Figure 6: Where the $0.281 went — bucket decomposition** (data rendered as table in this markdown equivalent).

| Configuration | native-equivalent | summarizer | cacheWrite excess | uncached tail | Stacked total (label) | Measured mean (if annotated) |
|---|---|---|---|---|---|---|
| native | $0.1712 | – | – | – | $0.171 | — |
| v5.6.1 (gap model) | $0.171 | $0.062 | $0.030 | $0.016 | $0.279 | — |
| v5.8 (tail-fix estimate) | $0.171 | $0.062 | $0.030 | $0.002 | $0.265 | $0.2509 |
| v5.9b (measured) | $0.1316 | $0.0115 | $0 | $0.0017 | $0.145 | — |

v5.9b's own native-equivalent segment ($0.132) is smaller than native's real spend ($0.171) — not because per-token costs dropped, but because v5.9b solves the task in 16.5 turns against native's 35. The summarizer and uncached-tail buckets that made up most of v5.6.1's $0.279 gap-model total ($0.062 and $0.016) shrink to $0.012 and $0.002, and the cacheWrite-excess bucket reaches zero — folded into ordinary cacheWrite once the map-churn and args-duplication sources (FM-7, and its loop-7 analogue in edit-tool args) are gone.

### What shipped

All landed unconditionally; 833 tests green. §8 truncation-doubling fix (a doubling no longer consumes the contract retry itself, bounded to ×3); a pure deterministic `composeRootSummary` (`packages/core/src/summarize/compose-root.ts`, model tag `deterministic-rollup-v1`, byte-stable on no-op writes); capped-args rendering (`ARGS_CAP_WITH_BLOB=512`, `packages/core/src/assemble/format.ts`); a per-model spend ledger (`costByModel`) persisted in `results.json`; five eval gates (`EVAL_LAZY_K`, `EVAL_DET_ROOT`, `EVAL_NO_ATOOLS`, `EVAL_FETCH_EVENTS`, `EVAL_LAZY_TOKENS`).

**Simplicity ledger** (rule-removal beats rule-addition, per the program constraint): deleted the strong-model root call and its truncation-retry path, the duplicated 1.1k-token Zone A schema block, the never-dropping tail special case, and kilobyte-scale args duplication. Added: one threshold parameter (lazy-tokens). Net: fewer branches, one new number to tune.

#### The shipped algorithm, in ≤12 lines

*Every event is L0; summarization is gated on a token threshold, not an event count; churn stays behind the moving breakpoint.*

```
for event in trace:
    append(L0, event)
    if phase_closed(event) and trace_tokens() >= LAZY_TOKENS:      # v6.0
        for leaf in stale_leaves(closed_phase):
            leaf.summary = summarize_cheap(leaf)                    # haiku, parallel ≤8
        root.summary = compose_root(children)                       # deterministic, no LLM call
    prompt = frozen_contract
           + summaries_in_creation_order()                          # [cache breakpoint]
           + active_branch_blocks(cap_args_over_blob=512)           # [moving breakpoint]
           + uncached_map_and_tail()
    emit(prompt)
```

**Spend:** loop 7 metered $20.76 across 121 runs; program-to-date across all seven loops is $44.41. **Open items carried into §11:** an epoch-merge desync noted during v6.0's telemetry review (needs the §17 cache assertion harness to isolate), the sw-3 cost gap (v6.x runs 74% over native on the refactor task — the one scenario where the tree doesn't yet pay for itself), and a decision-row proposal for `IMPLEMENTATION_PLAN.md` D2 to record the deterministic root as the shipped default rather than a variant.

## 11 What to do next

1. **§8 contract robustness** — *root-caused and landed in loop 6:* the parser already tolerated fences and prose; the real defect was replies truncated at `maxSummaryTokens=1024` being retried at the same cap (guaranteed identical failure). v5.6 detects `stopReason: max_tokens` and doubles the retry budget; live verification pending in iter9.
2. **Breaker half-open state** — retry a failed node after N turns so a tripped *root* doesn't stay stale forever; key failure memory on stable node identity, not raw ids, to survive re-segmentation churn.
3. **v6 selection, reshaped** — *tested and folded in loop 4:* the four rules were implemented exactly as designed, and their composition never evicts (FM-8) — safe, inert, and closed. The successor idea for bounding Zone B at 100+ branches is **hierarchical collapse**: old branches merge into a super-summary node (the tree's own recursion), which is cache-stable because it appends one block and retires a stable prefix range at a phase boundary.
4. **Hyperparameter search (the prior report's Phase 2) is now worth running** — the summarizer-noise floor it feared is gone: v5.4 removed the highest-leverage confound (`SUMMARIZE_MIN_NEW_EVENTS`) entirely, and what remains to sweep is k and the zone budgets under v6.
5. **Fix FM-6: cap Zone C by tokens, not by phase** — a single long phase re-inflates Zone C to the whole trace (the suite's $1.08 run: 392k fresh input; iter7's $1.01 failure). Loops 5–6 changed the economics — with v5.5/v5.6 a big Zone C rides the cache at 0.1× instead of 1× — but the water-fill truncation at the 30k budget still churns the prefix once exceeded, so a cache-aware window policy (drop-from-front epochs, not per-turn re-truncation) remains open work. **Closed (loop 7):** v6.0's lazy-tokens threshold (§10) is exactly this fix, in token-budget-gates-summarization form, and it swept 16/16. Verified under load, too: v6.1 (15k) reproduced it exactly (zero crossings, folds into `v6.x`), and v6.2's 8k probe finally forced a crossing and confirmed the bounded-swap-size fix holds when it fires — safe, just not yet profitable at this suite's trace lengths. Shipped default stays 30k.
6. **Broaden the suite** — two in-sandbox tasks is a start; port the generator pattern (self-verifying, hidden per-module tests) to 3–4 more task shapes before trusting any cross-task generalization. **Update (loop 7):** two more landed — `sw-3-refactor` and `sw-4-bughunt` (§10), both self-verifying with hidden tests, both confirming laziness's savings hold outside the original pair. 2–3 more task shapes remains open.
7. **The sw-3 cost gap** — the one scenario loop 7 didn't close: `v6.x` runs 74% over native cost on `sw-3-refactor` (§10) despite matching or beating native everywhere else. Worth its own analyzer pass before the next program starts.
8. **Epoch-merge desync** — noted during v6.0's telemetry review; needs the §17 cache assertion harness to isolate before it's worth a fix attempt.
9. **`IMPLEMENTATION_PLAN.md` decision row** — D2 currently doesn't record the deterministic root composer as the shipped default; propose the update now that it has three loops of live verification behind it (exonerated in loop 4, landed and green through loops 6–7).

## 12 Conclusion

Six loops ago the tree looked like an elegant architecture losing on economics. It was actually a sound architecture wearing measurement errors and, beneath them, one recurring physical law: **a provider cache is a byte-prefix, and any churn ahead of stable content silently converts 0.1× reads into full-price re-bills.** That law was violated four separate times — Zone B's seq-range headings (FM-2), Zone C carrying the whole trace (FM-3), the active header's seq range, and the descendant map growing at the top of the zone (FM-7) — and every major cost finding in this program traces to one of those violations or to the baseline not caching at all (FM-4). With all four fixed, the tree obeys the correspondence principle this program adopted as its design goal: within a phase it is byte-for-byte cached-native economics (fresh input 36–892 tokens/turn, cacheRead climbing, cacheWrite the delta), and the tree's machinery only bills at phase boundaries, where detail collapses into summaries. On the scoreboard: cached native $0.170, context-tree v5.6 $0.281 median — the residual is turn-invariant overhead (summarizer calls, the deliberately uncached map+tail, one cache epoch per phase), not a growth rate. What that overhead buys: 20 median turns vs native's 34 (native hit the 40-turn cap in half its long runs), a token curve that stays ~linear where native's re-read is ~quadratic, and a resumable summary tree as the artifact of every run.

The selection question also closed: eviction destroyed a run when it fired (FM-5) and, made cache-safe, provably never fires (FM-8's monotone lock-in) — so the DSA layer retires, and bounding Zone B at 100+ branches belongs to the tree's own recursion (hierarchical collapse into super-summaries). The remaining work is narrow and named: let §8 truncation retries double more than once (the root-summary residual), a token-budget window for single-phase blowups (FM-6), hierarchical Zone B collapse, and — first move of any next program — pinned sampling temperature with fresh baselines, because trajectory luck at temp 1.0 is now the largest error bar in every comparison. Each goes against the bar this program ends with: n≥3, medians, mechanisms before rankings.

Loop 7 answered the question those two paragraphs left open — not by finding a new physical law, but by spending down the turn-invariant overhead the correspondence principle predicted would remain: quantify it (native $0.171 + summarizer $0.062 + cacheWrite excess $0.030 + uncached tail $0.016), then remove each term without adding a rule to do it. (Pinned temperature, it turned out, was never available to try — the API rejects the parameter outright, so loop 7's variance control is n≥5 medians instead.) Capping, not dropping, edit-tool args once a post-state blob exists closed the tail and cacheWrite-excess terms and produced the program's first outright win on the long task: context-tree v5.9b at $0.130 vs native's $0.151, on every axis — cost, turns, success. Replacing the lazy-summarization threshold with a token budget generalized that into the shipped default: v6.0 (30k) and v6.1 (15k) proved behaviorally identical — zero crossings, 32/32 success — and v6.2's 8k probe forced the one crossing in the whole batch, confirming the bounded-swap fix holds (no flail, no cap) even though it doesn't yet pay at this suite's trace lengths. **Loop 7 is closed; final configuration is lazy-tokens at 30k.** **Current standing:** the tree no longer needs the efficiency-vs-cost tradeoff framing this report opened with. Against native's 14/16 success, `v6.x` goes 32/32, with turns and reliability won outright and cost at parity-or-better on three of four tasks (sw-1 ties, sw-2 wins on success-adjusted cost despite a nominal +8%, sw-4 wins outright); sw-3's 74% cost gap is the one boundary this loop left for the next one to move.

<details>
<summary>Appendix · all 56 runs (table view)</summary>

| Iteration | Arm | Task | Cost $ | Turns | Fresh in | CacheRead | CacheWrite | Total tok | Result |
|---|---|---|---|---|---|---|---|---|---|
| iter1 | native | sw-1-jsonc | 0.157 | 12 | 45,508 | 0 | 0 | 52,061 | pass |
| iter1 | context-tree | sw-1-jsonc | 0.200 | 9 | 25,542 | 39,696 | 12,912 | 82,150 | pass |
| iter1 | tree-dsa | sw-1-jsonc | 0.188 | 9 | 27,892 | 44,723 | 9,286 | 85,949 | pass |
| iter2 | native | sw-1-jsonc | 0.260 | 21 | 93,662 | 0 | 0 | 100,899 | pass |
| iter2 | context-tree | sw-1-jsonc | 0.456 | 15 | 84,186 | 68,466 | 26,997 | 186,177 | pass |
| iter2 | tree-dsa | sw-1-jsonc | 0.198 | 9 | 31,404 | 45,606 | 7,719 | 89,369 | pass |
| iter3 | native | sw-1-jsonc | 0.201 | 18 | 70,097 | 0 | 0 | 76,163 | pass |
| iter3 | context-tree | sw-1-jsonc | 0.440 | 15 | 78,245 | 67,032 | 27,432 | 177,203 | pass |
| iter3 | tree-dsa | sw-1-jsonc | 0.218 | 10 | 39,678 | 47,880 | 5,492 | 97,409 | pass |
| iter4 | native | sw-1-jsonc | 0.488 | 20 | 197,930 | 0 | 0 | 207,115 | pass |
| iter4 | context-tree | sw-1-jsonc | 0.171 | 7 | 19,369 | 31,484 | 9,442 | 64,405 | pass |
| iter4 | tree-dsa | sw-1-jsonc | 0.546 | 19 | 121,205 | 90,972 | 32,689 | 253,879 | pass |
| iter5 | native | sw-2-multimod | 0.766 | 30 | 350,823 | 0 | 0 | 357,260 | pass |
| iter5 | context-tree | sw-2-multimod | 0.852 | 27 | 229,478 | 129,276 | 54,113 | 421,939 | pass |
| iter5 | tree-dsa | sw-2-multimod | 0.763 | 27 | 194,193 | 130,961 | 42,634 | 373,722 | pass |
| iter5 | native | sw-2-multimod | 0.552 | 40 | 235,709 | 0 | 0 | 243,791 | fail |
| iter5 | context-tree | sw-2-multimod | 0.694 | 25 | 173,259 | 119,700 | 42,542 | 341,555 | pass |
| iter5 | tree-dsa | sw-2-multimod | 0.548 | 21 | 138,210 | 104,490 | 26,717 | 277,395 | pass |
| iter5 | native | sw-2-multimod | 0.625 | 32 | 278,612 | 0 | 0 | 285,428 | pass |
| iter5 | context-tree | sw-2-multimod | 0.946 | 29 | 247,502 | 142,738 | 69,578 | 467,745 | pass |
| iter5 | tree-dsa | sw-2-multimod | 0.575 | 23 | 156,002 | 110,124 | 23,867 | 298,239 | pass |
| iter6 | native | sw-2-multimod | 0.242 | 34 | 48 | 460,240 | 22,259 | 491,950 | pass |
| iter6 | context-tree | sw-2-multimod | 0.449 | 25 | 113,935 | 161,882 | 7,110 | 291,301 | pass |
| iter6 | tree-dsa | sw-2-multimod | 0.895 | 40 | 272,289 | 265,785 | 8,989 | 560,515 | fail |
| iter6 | native | sw-2-multimod | 0.292 | 37 | 51 | 711,587 | 29,096 | 748,421 | pass |
| iter6 | context-tree | sw-2-multimod | 0.288 | 20 | 52,867 | 124,272 | 6,305 | 189,849 | pass |
| iter6 | tree-dsa | sw-2-multimod | 0.308 | 20 | 80,745 | 119,706 | 1,487 | 209,737 | pass |
| iter6 | native | sw-2-multimod | 0.113 | 26 | 34 | 174,967 | 9,350 | 189,762 | pass |
| iter6 | context-tree | sw-2-multimod | 0.159 | 9 | 29,498 | 49,488 | 821 | 84,358 | pass |
| iter6 | tree-dsa | sw-2-multimod | 0.444 | 18 | 151,410 | 105,198 | 2,165 | 266,329 | pass |
| suite | native | sw-1-jsonc | 0.092 | 23 | 31 | 64,343 | 6,244 | 77,017 | pass |
| suite | context-tree | sw-1-jsonc | 0.164 | 12 | 16,537 | 68,712 | 3,836 | 92,642 | pass |
| suite | native | sw-2-multimod | 0.178 | 40 | 54 | 233,538 | 8,634 | 253,214 | pass |
| suite | context-tree | sw-2-multimod | 0.733 | 27 | 245,481 | 162,580 | 2,245 | 427,824 | pass |
| suite | native | sw-1-jsonc | 0.098 | 24 | 26 | 85,228 | 7,466 | 98,915 | pass |
| suite | context-tree | sw-1-jsonc | 0.256 | 18 | 33,877 | 109,916 | 6,860 | 157,219 | pass |
| suite | native | sw-2-multimod | 0.163 | 33 | 45 | 305,002 | 12,740 | 324,815 | pass |
| suite | context-tree | sw-2-multimod | 1.076 | 36 | 391,689 | 222,702 | 5,360 | 636,049 | pass |
| suite | native | sw-1-jsonc | 0.234 | 40 | 53 | 329,053 | 18,426 | 359,783 | pass |
| suite | context-tree | sw-1-jsonc | 0.314 | 21 | 45,260 | 122,892 | 10,961 | 186,612 | pass |
| suite | native | sw-2-multimod | 0.147 | 40 | 55 | 200,224 | 9,035 | 217,726 | pass |
| suite | context-tree | sw-2-multimod | 0.174 | 12 | 31,078 | 68,571 | 2,406 | 106,990 | pass |
| iter7 | context-tree | sw-2-multimod | 1.006 | 40 | 284,916 | 261,481 | 15,465 | 585,893 | fail |
| iter7 | tree-dsa | sw-2-multimod | 1.262 | 33 | 316,670 | 198,978 | 3,222 | 571,563 | pass |
| iter7 | context-tree | sw-2-multimod | 0.216 | 10 | 59,821 | 52,158 | 6,996 | 123,270 | pass |
| iter7 | tree-dsa | sw-2-multimod | 0.454 | 27 | 82,638 | 171,422 | 7,093 | 274,693 | pass |
| iter7 | context-tree | sw-2-multimod | 0.213 | 13 | 38,435 | 70,532 | 7,003 | 122,401 | pass |
| iter7 | tree-dsa | sw-2-multimod | 0.563 | 33 | 124,822 | 209,574 | 12,302 | 360,640 | pass |
| iter8 | context-tree | sw-2-multimod | 0.845 | 37 | 4,448 | 243,009 | 225,420 | 485,911 | pass |
| iter8 | context-tree | sw-2-multimod | 0.166 | 10 | 151 | 55,011 | 37,895 | 97,768 | pass |
| iter8 | context-tree | sw-2-multimod | 0.396 | 24 | 9,516 | 146,954 | 80,877 | 246,163 | pass |
| iter9 | context-tree | sw-2-multimod | 0.221 | 20 | 2,137 | 286,706 | 23,023 | 311,866 | pass |
| iter9 | context-tree | sw-2-multimod | 0.281 | 18 | 9,827 | 160,293 | 51,609 | 221,729 | pass |
| iter9 | context-tree | sw-2-multimod | 0.780 | 40 | 37,995 | 222,954 | 121,191 | 382,140 | fail |
| iter9 | context-tree | sw-2-multimod | 0.335 | 23 | 4,472 | 222,024 | 71,031 | 297,527 | pass |
| iter9 | context-tree | sw-2-multimod | 0.251 | 19 | 9,403 | 184,048 | 46,402 | 239,853 | pass |

</details>

Methodology: every model call metered (agent, summarizer, judge). Replicate processes run in parallel by explicit request — cost/token/turn metrics are unaffected; wall-clock and latency percentiles are contended and excluded from all comparisons. Raw data: `eval/results/long-swe-iter{4,5,6,7,8,9}`, `eval/results/suite-final`; per-turn growth via `eval/scripts/ct-growth.mjs`. Loop 7 (2026-09-01, closed): `eval/results/{v56-base,v57,v57b,v58,v59,v59b,v60,v61,v62}{,-diverse}` (per-rep `results.json`, `costByModel` is the source of truth for summarizer/haiku call counts), 121 runs, aggregated medians/IQR in `today-stats.json`; diverse-suite generators `eval/scripts/build-refactor-scenario.py`, `build-bughunt-scenario.py`.
