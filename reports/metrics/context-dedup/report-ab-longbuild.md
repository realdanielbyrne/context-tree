# A/B window-cap sweep — n=3 result (SUPERSEDED by n=10: the effect did NOT replicate)

> ⚠️ **CORRECTED BY THE n=10 RUN — do not cite this report's headline.** The n=3 finding below
> (idle 3/3 vs truncate-tail 1/3, with halved re-reads) **failed to replicate**. At n=10:
> truncate-tail **5/10**, idle **4/10**, random **1/10**. Pooled n=13: idle 7/13 vs truncate-tail 6/13,
> **Fisher p = 1.000** — zero evidence of any difference. The predicted *mechanism* also inverted
> (pooled median re-reads: idle 7, truncate-tail 4). The pre-registered falsification is **MET**:
> reference recency adds nothing over positional recency on this task. What survives is weaker and
> different: **both signal arms beat the random control** (13/26 vs 2/13, p=0.045). See
> `report-ab-combined.md` for the combined, authoritative analysis. This file is kept for provenance.

*(original n=3 report follows)*

**Question (one variable — the SELECTION signal):** when a coding agent's context is
capped, does keeping units by **reference recency** (how long since that file was last
touched) complete the task better than keeping by **positional recency** (the tail), and
does either beat a random control? All capped arms fit the **same budget W with the same
anchor rule** and differ ONLY in the order they sacrifice units, so they are
**volume-matched by construction** — a difference is a difference in selection signal,
not in how much was evicted.

**Method.** One model (`unsloth/Qwen3.8-27B-GGUF`, 262K real window) so the provider never
rejects a prompt; the only synthetic element is an artificial cap `W` enforced by the
assembler each turn — which is what a deployment window is. **Full tools kept** (no
artificial tool removal). Task: `longbuild` — a six-stage, five-module pure-stdlib Python
build whose phase-2 extension *amends* stages 2 and 3, graded by a **held-out** `unittest`
suite written at grade time (the agent never sees it; `Ran N > 0` guards the zero-test
false pass). Caps chosen from the measured uncapped peak (~19–21k): **9,500 (~50%)** and
**4,700 (~25%)**. n=3 per cell.

**Rerun:**
```
set -a; . ./.env; set +a
CT_LOCAL_MODEL=unsloth/Qwen3.8-27B-GGUF CT_TASK=longbuild \
CT_WINDOWS=9500,4700 CT_ARMS=uncapped,truncate-tail,random,idle \
CT_REPEATS=3 CT_MAX_TURNS=60 node experiments/context-dedup/ab-window-sweep.mjs
```

## Results

| cell | n | pass | turns med (min–max) | re-reads | evictions | peak | total prompt tok | stop reasons |
|---|---|---|---|---|---|---|---|---|
| uncapped | 3 | 100% | 53 (52–53) | 0 | 0 | 20,993 | 632,225 | end_turn ×3 |
| truncate-tail @9500 | 3 | 100% | 61 (61–61) | 3 | 25 | 8,971 | 499,612 | **maxTurns ×3** |
| random @9500 | 3 | 67% | 52 (46–61) | 2 | 23 | 8,970 | 421,218 | end,max,end |
| **idle @9500** | 3 | **100%** | **54 (53–58)** | 2 | 25 | 8,977 | 436,860 | **end_turn ×3** |
| truncate-tail @4700 | 3 | **33%** | 61 (57–61) | 8 | 39 | 4,182 | 269,995 | max,max,end |
| random @4700 | 3 | **33%** | 61 (61–61) | 9 | 40 | 4,180 | 275,546 | maxTurns ×3 |
| **idle @4700** | 3 | **100%** | 59 (57–61) | **4** | 37 | 4,184 | 265,174 | max,end,end |

`cap_violations = 0` in every cell: the caps were enforced exactly, so no result is an
artifact of the anchor floor overriding the budget.

## What the numbers say

**1. At the tight cap, only reference-recency completes reliably.** idle passes **3/3** at
W=4,700 where truncate-tail and random each pass **1/3**. Evictions are matched
(37 / 39 / 40), so the arms removed the same volume — the difference is *which* units
survived.

**2. The mechanism behaves as predicted.** Median re-reads at W=4,700: **idle 4 vs
truncate-tail 8 vs random 9** — roughly half the re-fetches. Keeping a positionally-old but
recently-referenced file is exactly what avoids paying to read it again. This is the causal
story the hypothesis predicted, not a bare outcome difference.

**3. At the moderate cap, idle behaves like having no cap at all.** idle@9500 self-terminated
`end_turn` **3/3** in 54 median turns — statistically indistinguishable from uncapped's 53
(52–53) — while holding **43% of the context** (8,977 vs 20,993 peak) and spending **31%
fewer prompt tokens** (437k vs 632k). truncate-tail@9500 **never self-terminated** (maxTurns
3/3); it graded PASS but churned to the turn limit.

**4. Capping beat not capping, on cost.** Every capped arm used fewer total prompt tokens
than uncapped (632k → 265–500k), because uncapped re-sends a growing prefix every turn.
Completion and cost point in different directions — the same tension `report-dv2-cache-cost.md`
found from the caching side.

## Significance — honestly, this is underpowered

Fisher exact on the W=4,700 pass rates:

| comparison | p (two-tailed) |
|---|---|
| idle 3/3 vs truncate-tail 1/3 | **0.400** |
| idle 3/3 vs random 1/3 | **0.400** |
| idle 3/3 vs both pooled 2/6 | **0.167** |

**None of these reach significance at n=3.** A 3/3-vs-1/3 split simply cannot, whatever the
true effect. What raises this above noise-mining is that three independent signals point the
same way — pass rate, halved re-reads, and clean self-termination — and the re-read result is
the *predicted mechanism* rather than a post-hoc pick. Treat this as a **promising,
mechanistically coherent effect that needs n≥10 per cell to claim**, not an established one.

## Against the pre-registration

> *"if idle does not beat truncate-tail outside the measured run-to-run noise band, and/or
> does not beat random, reference-recency adds nothing over positional recency."*

Not met — idle beat both, on pass rate at the tight cap and on self-termination at the
moderate cap. The noise band here is tight (uncapped 52–53 turns over 3 runs), so the
54-vs-61 gap at W=9,500 sits outside it. The hypothesis **survives this round** without being
established.

## Provenance: this reverses the v1 run, and why

An earlier run reported idle *failing* at W=4,700 alongside random. That run was invalid —
adversarial review found and measurement confirmed:
- `idleOf` keyed on the promiscuous `fp` fingerprint, so `__init__` (shared by every Python
  module) linked every unit to the newest one and pinned idle near 0 — measured
  `[1,1,6,1,4,3,1,1,0]` against a truth of `[8,7,6,5,4,3,2,1,0]`. The arm was nearly inert.
- The budget backstop delegated to `evictRecency`, which keeps a *contiguous suffix* and
  therefore deleted exactly the old-but-re-referenced unit the idle rule had just saved —
  in every cell where the cap binds.

Both are fixed (`idleOf` keys on file paths; the backstop is idle-ordered), the sweep now
**imports** the unit-tested `policies.mjs` rather than carrying its own copy, peak is sampled
*after* eviction, and the control is volume-matched. 13/13 policy unit tests pass, including
the discriminator **under a binding cap** — the regime v1 never exercised.

## Caveats

- **n=3 per cell; not statistically significant** (see above). The headline is an effect
  size, not a p-value.
- **One local model, one task.** Synthetic long-horizon build, **not a published benchmark** —
  SWE-bench was environmentally impossible at the time of this run (no Docker/pip/PyPI). A
  non-Docker SWE-bench harness has since been validated (`swebench_provision.py`) and is the
  proper next substrate.
- `turns = 61` means the 60-turn budget was exhausted, i.e. "did not finish in 60 turns",
  not "cannot finish".
- Grading is all-or-nothing, so FAIL cells are not distinguished by how close they came.
- `total_prompt_tokens` is raw; the local server's caching behaviour is unknown, so this
  measures context volume, not cached cost (`report-dv2-cache-cost.md` covers that).
- temp 0 but not bit-identical on this host; read all differences against the min–max spread.
