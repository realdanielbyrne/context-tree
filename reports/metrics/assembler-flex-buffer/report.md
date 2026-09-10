# Flex-buffer assembler redesign — cache economics (offline)

**Run:** `flex-buffer-cache@v1` · offline · deterministic · commit `d6a7f2c`
**Script:** `experiments/rung-0-assembler/flex-buffer-cache.mjs` · **Raw:** `results.json`
**Simulator:** shipped `ProviderCacheSimulator` (`packages/core/src/cache`). Cost = `0.1·cacheRead +
1.25·cacheWrite + 1.0·fresh` (Anthropic multipliers, `cost.ts`). Session: 50 turns, W=40,000.

## Proposal tested (operator redesign)

- Zone A grows to hold system + steering + **all user prompts** (append-only).
- Zones B and C merge into one **flex-fill buffer** (varying mix of ref / summary / raw), soft target.

Question: does the cache economics close? Zone B is separate today only for cache stability (D5); a
buffer that re-picks its mix each turn rewrites the cached prefix (cacheWrite 1.25×) every turn. Fix
hypothesised: append-mostly + sticky representation + a secondary breakpoint (layout R). **Every variant
carries identical content — only layout/order/breakpoints differ — so this isolates cache behaviour.**

## Result (effective input cost over the session; lower = cheaper)

| variant | effCost | vs naive | cacheRead | fresh | peakOcc |
| --- | ---: | ---: | ---: | ---: | ---: |
| **flex-append-sticky@0.4** | **341,040** | **36.9%** | 225,400 | 300,000 | 43% |
| flex-append-sticky@0.25 | 346,350 | 34.8% | 211,000 | 300,000 | 38% |
| current-zones | 395,220 | 30.1% | 190,200 | 370,200 | 44% |
| flex-remix | 433,650 | 23.3% | 147,000 | 415,200 | 44% |

## Findings

1. **The cache economics close — and flex-append-sticky beats the current zones (~14% cheaper).**
   Pinning user prompts (append-only Zone A) + creation-order summaries behind a secondary breakpoint
   caches more of the prompt: highest cacheRead, lowest fresh. Part 1 (user prompts in Zone A) is
   cache-*positive*, not merely cache-safe.
2. **flex-remix is the cache-death case, as predicted.** Re-picking the mix each turn diverges right
   after Zone A and re-sends almost everything — most expensive, highest fresh, lowest cacheRead. This
   is the proof that the discipline is load-bearing: **append-mostly + sticky representation + secondary
   breakpoint** is what makes the design viable; free re-mixing breaks it.
3. **The soft target trades occupancy for a little cache churn — not a free cache win.** Tightening
   0.4→0.25 drops occupancy (43%→38%) but nudges cost up (341k→346k), because evicting a cached summary
   forces a re-write when it leaves. Its real payoff — bounding total token *volume* — shows on long /
   overflowing sessions, which this 44%-occupancy run does not reach.

## Recommendation (best choice among those tested)

**flex-append-sticky with a loose soft target (0.4–0.5).** Cheapest on cache, dominates the current
zones, and realises the operator's design. Non-negotiable discipline that makes it work:
- Zone A append-only (user prompts in creation order, never reordered).
- Flex buffer in creation order; a unit's representation is **sticky** (chosen once); new content appends
  at the end; a **secondary breakpoint** sits after the stable head so it caches and only the volatile
  tail re-sends.
- **Never free-re-mix the buffer per turn** (flex-remix) — it is the cache-killer.

## Caveats

- **Cache mechanics only.** Synthetic session, stylised token sizes. Whether the flex *mix* helps task
  quality is live-only. The relative ordering across variants is the result, not the absolute tokens.
- **Soft target under-exercised** — occupancy peaks at 44%, so the target barely binds; its token-volume
  savings need a longer / overflowing session to measure. That is the natural follow-up.
