# DV1 — single-version working set: the gross opportunity

**Question (one variable — assembler retention):** if context kept only the latest version of each file
(superseded versions dropped) instead of append-all, how much smaller is the working set and the
multi-turn transmitted volume? Rerun: `node experiments/context-dedup/dv1-version-collapse.mjs`.

| session | turns | final working set (append → single-ver) | reduction | multi-turn read tokens (append → single-ver) | reduction |
|---|---|---|---|---|---|
| session-2 | 651 | 32,709 → 5,439 | 83.4% | 13,984,443 → 4,683,782 | 66.5% |
| session-3 | 98 | 76 → 25 | 66.7% | 6,388 → 2,172 | 66.0% |
| session-4 | 735 | 35,077 → 2,569 | 92.7% | 15,130,019 → 1,242,971 | 91.8% |
| session | 645 | 22,807 → 11,075 | 51.4% | 11,643,561 → 8,301,834 | 28.7% |

**Finding.** The working set shrinks 51.4%–92.7%, and because the stateless API re-sends context every turn, the multi-turn read-token volume falls 28.7%–91.8% (millions of tokens on the long sessions). The redundancy is stacked *whole prior versions*, not duplicate lines (those were ~4%).

**These are GROSS numbers — an upper bound, not a cost saving.** Append-all's re-sent prefix is cached at ~0.1×; single-version rewrites the prefix on each version swap (cache write 1.25×). DV2 resolves the cache-adjusted cost.

- Read-content only (system, tool schemas, assistant turns, edit diffs are equal across policies and excluded).
- GROSS: ignores prompt caching — append-all re-sends a cached prefix at ~0.1x, so multi-turn reduction is an upper bound on volume, not on cost. DV2 models the cache-adjusted cost.
- Single-version here retains one copy of EVERY file ever read (no eviction) — a conservative floor; relevance-eviction would shrink it further.
- chars/4 token estimate.
