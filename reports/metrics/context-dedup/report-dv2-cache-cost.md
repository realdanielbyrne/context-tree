# DV2 — cache-adjusted cost of a single-version working set

**Question (one variable — assembler policy):** once prompt caching is priced in, does a single-version
working set still beat append-all, given that a version swap rewrites the prefix (cache write 1.25×)
while append-all's stale prefix is cache-read at 0.1×? Simulated with the repo's `ProviderCacheSimulator`
(Anthropic profile, automatic-prefix). Rerun: `node experiments/context-dedup/dv2-cache-cost.mjs`.

Arms: **append-all** (current frameworks), **sv-flat** (file blocks inline, mutated in place),
**sv-placed** (reference files in a static cached segment), **sv-tail** (file versions in a dedicated
volatile tail so a swap rewrites only the tail). Δ is vs append-all; **negative = MORE expensive.**

## Cached cost (Anthropic prompt caching) — lower is better
| session | turns | edited | append-all | sv-flat | sv-placed | sv-tail |
|---|---|---|---|---|---|---|
| session-2 | 651 | 12 | 7.97M | 13.63M (−71.0%) | 14.26M (−79.0%) | 12.50M (−56.9%) |
| session-3 | 98 | 0 | 0.25M | 0.25M (0.2%) | 0.25M (−0.4%) | 0.25M (−0.8%) |
| session-4 | 735 | 17 | 8.99M | 11.31M (−25.8%) | 11.42M (−27.0%) | 9.14M (−1.6%) |
| session | 645 | 9 | 5.39M | 6.88M (−27.6%) | 7.63M (−41.7%) | 14.64M (−171.8%) |

## No-cache cost (raw tokens transmitted) — lower is better
| session | append-all | sv-flat | sv-placed | sv-tail |
|---|---|---|---|---|
| session-2 | 77.16M | 67.95M (11.9%) | 67.95M (11.9%) | 67.95M (11.9%) |
| session-3 | 2.01M | 2.01M (0.2%) | 2.01M (0.2%) | 2.01M (0.2%) |
| session-4 | 87.38M | 73.61M (15.8%) | 73.61M (15.8%) | 73.61M (15.8%) |
| session | 52.17M | 48.88M (6.3%) | 48.88M (6.3%) | 48.88M (6.3%) |

## Finding — the result INVERTS with caching

**Under prompt caching, append-only wins — decisively.** Append-only mutates nothing, so it runs at a ~100% cache-read ratio (every prior token billed at 0.1×) and writes only the small per-turn delta. Single-version shrinks the context but every version swap forces a cache **write** at 1.25×; at a **12.5× write/read multiplier**, the rewrites cost far more than the cheap reads they save — even sv-tail, which confines swaps to a small tail, does not overcome it here. This matches the cache asymmetry the flex assembler already exploits: *never rewrite a cached prefix.*

**Without caching, single-version is cheaper** (no-cache table) — but only modestly, because file reads are a minority of the full context (assistant turns, edit diffs, and non-file tool output dominate and are equal across arms). The dramatic DV1 numbers were on the read subset alone.

**The real caveat: no window limit is modelled.** Append-only "wins" here precisely because it is allowed to cache an unbounded, ever-growing prefix. A real hard window forbids that — past the limit the prefix must be dropped or compacted, forfeiting both the content and the cache. **So single-version's value is not cost-under-caching; it is fitting more *relevant* content under a bounded window** (the overflow regime), and lowering cost for providers/turns without caching. That is what E1 (gating) and DV3 (task success under a forced window) must test — not raw cost with an infinite window.

- Cached cost = cacheRead*0.1 + cacheWrite*1.25 + fresh*1.0 (Anthropic input multipliers). No-cache cost = total tokens transmitted.
- Simulator: ProviderCacheSimulator, ANTHROPIC_PROFILE, automatic-prefix matching; chars/4 tokenizer.
- No WINDOW LIMIT is modelled: append-all is allowed to cache an unbounded, ever-growing prefix. This structurally favours append-all — its whole advantage here is that nothing is ever dropped, which a real hard window forbids. The single-version case for a bounded window (fitting more relevant content) is NOT what this measures; see E1/DV3.
- sv-placed/tail use ORACLE placement (whole-session knowledge of which files are edited) — an upper bound a deterministic online policy would approach.
- An edit yields no post-edit full content, so a file block is version-bumped with a marker; reads carry real content. Non-file tool outputs are kept identically in all arms.
