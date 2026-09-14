# DV3 — eviction cadence and cache TTL: a small window DOES pay for its own re-caching

**Finding.** There is an **interior optimum eviction cadence**. Evicting on *every* turn is by far the
worst policy (−183%), but evicting every ~25 turns makes a capped window **33.5% cheaper** than
append-only. A previous conclusion ("append-only is cache-optimal below the window") was an artifact of
DV2 testing only cadence N=1 — the worst case — and generalising from it.

**Why:** cache-write is charged **per mutation**, the cache-read discount accrues **per turn**. Evicting
every `N` turns amortises one write across `N` cheaper turns, so the crossover is
`N·r·(C_large − C_small) > w·S`.

**Setup.** Simulated with the repo's `ProviderCacheSimulator` (Anthropic profile). Synthetic session:
120 turns, frozen head 2000 tok ("always keep": system + steering + prompts),
500 tok added per turn, cap 12000. Effective cost = cacheRead·r + cacheWrite·w + fresh.
Rerun: `node experiments/context-dedup/dv3-cadence-ttl.mjs && node experiments/context-dedup/report-dv3.mjs`

## Results by scenario

### 5-min TTL / continuous

| arm | eff cost | cache-read | cache-write | evictions | vs append-only |
|---|---|---|---|---|---|
| append-only (uncapped) | 0.46M | 3.81M | 0.06M | 0 | — |
| cap 12000, evict every 1 | 1.30M | 0.33M | 1.01M | 100 | **−183.3%** |
| cap 12000, evict every 5 | 0.43M | 1.19M | 0.25M | 20 | **+5.2%** |
| cap 12000, evict every 10 | 0.34M | 1.41M | 0.16M | 10 | **+26.3%** |
| cap 12000, evict every 25 | 0.30M | 1.80M | 0.10M | 4 | **+33.5%** |
| cap 12000, evict every 50 | 0.32M | 2.20M | 0.08M | 2 | **+29.8%** |

### 5-min TTL / resumed x3

| arm | eff cost | cache-read | cache-write | evictions | vs append-only |
|---|---|---|---|---|---|
| append-only (uncapped) | 0.57M | 3.71M | 0.16M | 0 | — |
| cap 12000, evict every 1 | 1.31M | 0.33M | 1.02M | 100 | **−129.5%** |
| cap 12000, evict every 5 | 0.44M | 1.19M | 0.26M | 20 | **+22.4%** |
| cap 12000, evict every 10 | 0.34M | 1.41M | 0.16M | 10 | **+39.4%** |
| cap 12000, evict every 25 | 0.36M | 1.75M | 0.15M | 4 | **+36.4%** |
| cap 12000, evict every 50 | 0.40M | 2.14M | 0.15M | 2 | **+30.3%** |

### 1-hour TTL / continuous

| arm | eff cost | cache-read | cache-write | evictions | vs append-only |
|---|---|---|---|---|---|
| append-only (uncapped) | 0.50M | 3.81M | 0.06M | 0 | — |
| cap 12000, evict every 1 | 2.06M | 0.33M | 1.01M | 100 | **−307.5%** |
| cap 12000, evict every 5 | 0.62M | 1.19M | 0.25M | 20 | **−23.5%** |
| cap 12000, evict every 10 | 0.46M | 1.41M | 0.16M | 10 | **+9.8%** |
| cap 12000, evict every 25 | 0.38M | 1.80M | 0.10M | 4 | **+24.8%** |
| cap 12000, evict every 50 | 0.38M | 2.20M | 0.08M | 2 | **+24.2%** |

### 1-hour TTL / resumed x3

| arm | eff cost | cache-read | cache-write | evictions | vs append-only |
|---|---|---|---|---|---|
| append-only (uncapped) | 0.69M | 3.71M | 0.16M | 0 | — |
| cap 12000, evict every 1 | 2.07M | 0.33M | 1.02M | 100 | **−201.0%** |
| cap 12000, evict every 5 | 0.63M | 1.19M | 0.26M | 20 | **+7.6%** |
| cap 12000, evict every 10 | 0.47M | 1.41M | 0.16M | 10 | **+32.1%** |
| cap 12000, evict every 25 | 0.47M | 1.75M | 0.15M | 4 | **+31.1%** |
| cap 12000, evict every 50 | 0.51M | 2.14M | 0.15M | 2 | **+26.4%** |

## Cheapest arm per scenario

| scenario | cheapest | eff cost | vs append-only |
|---|---|---|---|
| 5-min TTL / continuous | cap 12000, evict every 25 | 0.30M | +33.5% |
| 5-min TTL / resumed x3 | cap 12000, evict every 10 | 0.34M | +39.4% |
| 1-hour TTL / continuous | cap 12000, evict every 25 | 0.38M | +24.8% |
| 1-hour TTL / resumed x3 | cap 12000, evict every 10 | 0.47M | +32.1% |

## Three consequences

1. **The optimum is interior.** Neither N=1 (mutate constantly) nor N=∞ (never evict) is right; ~25 wins
   here. **Cadence is a tunable the assembler does not currently expose.**
2. **Resumption amplifies the small window's advantage.** With 3 TTL cold starts, append-only's cost rises
   0.46M → 0.57M
   (its cache-write nearly triples, because it has the largest prefix to re-cache) while capped arms barely
   move — the best capped arm improves from **+26.3% to +39.4%**. A cold cache punishes whoever is holding
   the most context, and that is append-only. This is the regime long sessions actually live in.
3. **`g* = w/r` is tier-dependent, not the constant 12.5.** At the 1-hour write tier (2.0×), cadence-5
   flips from **+5.2% cheaper to −23.5% more expensive**; the optimum stays ~25. Re-derive per tier.

## What this does NOT establish

- **SIMULATED, not live.** No model was run. It is the current best cost model, not a measurement.
- **Cost says nothing about task success.** The cheapest cadence may evict content the task needs; only the
  live A/B can price that. Pair before promoting.
- **Synthetic uniform session** (constant head, constant tokens/turn) — real sessions are bursty.
- **Eviction drops the OLDEST units**, which is the *maximally cache-destructive* choice: it invalidates the
  entire prefix after the head. Dropping late-position units would be cheaper, but those are the most
  recent and most relevant. That tension is real and unexamined — likely where the next gain is.
