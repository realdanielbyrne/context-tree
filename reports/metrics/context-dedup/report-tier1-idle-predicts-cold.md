# Tier 1 — does backward idle predict forward cold? (LRU-at-g\* signal)

**Question:** the eviction rule LRU-at-g\* drops a file reference once it has been idle > g\* = 12.5 turns
(the cache break-even w/r). That uses a trivially-countable backward signal (turns since last use) as a
proxy for the unknowable forward question (reused soon?). Does the proxy hold on real transcripts? This
validates the SIGNAL only — task-success/cost is Tier 2. Rerun: `node experiments/context-dedup/tier1-idle-predicts-cold.mjs`.

## Reuse-gap structure & classifier ("idle > g\* ⇒ cold within g\*")
| session | turns | files | gaps ≤ g\* | precision | recall | accuracy |
|---|---|---|---|---|---|---|
| session-2 | 651 | 18 | 79% | 98% | 95% | 93% |
| session-3 | 98 | 1 | 100% | 100% | 86% | 86% |
| session-4 | 735 | 19 | 73% | 97% | 95% | 92% |
| session | 645 | 20 | 53% | 97% | 94% | 92% |

- **precision** = of references the rule would evict, the share genuinely not reused within g\* (few needless re-fetches).
- **recall** = of the genuinely-cold references, the share the rule catches.

## Hazard curve — P(reused within g\* | current idle = k), pooled
0-2: 34% (n=325)  ·  3-6: 17% (n=491)  ·  7-12: 15% (n=667)  ·  13-25: 10% (n=1270)  ·  26+: 2% (n=19616)

**Reading it:** if P(reuse) falls as idle grows — and is low by the time idle passes g\* — then long idle
predicts cold and LRU-at-g\* is a sound proxy. A flat curve would falsify it. Pooled classifier:
precision 98%, recall 94%, accuracy 92%.

- OFFLINE signal validation only — tests whether backward idle predicts forward cold. Does NOT test task success or cost; that is Tier 2 (live).
- A "reference" is a Read or Edit of a file; turn clock = assistant model calls. File granularity (not sub-file ranges).
- These fixtures largely fit the window (not the extreme-overflow corpus); the reuse structure in a stressed session may differ.
