# The eviction read-loop: root cause and break-out (systematic debugging)

**Symptom.** Under eviction at a tight budget, the coding agent falls into a **read-loop** — it
re-reads the same reference files over and over, never progressing, until it hits maxTurns and the
task fails. First seen in the eviction experiment at budget 2500 (both policies, identical failure).

**Reproduced reliably** (`debug-readloop.mjs`, `CT_ANCHOR` configurable): at ANCHOR≤2, budget≤2000
the agent cycles `r1→r2→…→r6→r1→…` — 6-read cycle repeated ~7×, 41 turns (maxTurns), task fails.

## Root cause — working-set thrashing (not confusion)

The per-turn trace is unambiguous:
- The agent reads `r1..r6` (6 units, ~268 tokens each ≈ 1600 tokens).
- The eviction budget holds only ~1100 tokens of units (~5 units); from the moment it fills,
  `units` pins at 5 and tokens sit at the budget ceiling.
- Six reads **cannot all fit**. When the agent needs a spec whose file was evicted, it re-reads it —
  which evicts another needed read — forever. A perfect livelock.

**This is cache thrashing: the working set exceeds the cache.** Exactly analogous to OS page
thrashing when RAM < working set. `filesKnown` shows the agent always knows the file *names* (from
the pinned task) — what it loses and re-fetches is the *content*.

## Fixes tried (one at a time)

- **#1 — Nudge (behavioral): FAILED.** On a repeated read, return the content prefixed with "you
  already read this; stop re-reading, proceed." It fired **33×** and the agent **ignored it** and kept
  looping. Lesson: **you cannot instruct an agent out of a thrash** — it trusts what its context
  *shows* (the content is genuinely missing) over what a tool result *says*.
- **#2 — Summarize reads (retention): WORKS.** Return a compact summary of each read (docstring +
  signatures, ~5× smaller) instead of the full file. The working set now fits the budget → no thrash.
  **Verified:** at the loop config (ANCHOR=1) the task **completes** — budget 2000 → 20 turns, budget
  1500 → 22 turns, each ref read **once**; the raw-read control loops (41 turns, fail) at both budgets.

## Implication for context-tree — the break-out is FOOTPRINT REDUCTION, and it has two operators

The read-loop is not a model-reasoning bug to be prompted away; it is **a capacity failure** —
eviction alone, on raw tool results, *thrashes* whenever the required working set exceeds the budget.
The break-out is to **reduce the resident footprint of a large result to what the task needs**. There
are **two reducers**, and *which one works depends on the query↔content relationship* — this is the
exact mechanism:

| reducer | keeps | works WHEN | FAILS when |
| --- | --- | --- | --- |
| **summarize** (lossy → gist) | shape/abstraction (docstring, signatures, headline, TL;DR) | the needed info **survives abstraction** — structural/navigational facts, "what is this / what does it expose" | the need is a **specific buried detail** the summary drops (a price in row 47, a value in §8.3) — thrash continues or the model answers wrong |
| **chunk + retrieve** (lossless → span) | the exact relevant span, verbatim | the need is **localized** to a findable span the query can select | the need is **distributed** across the whole doc (no single span suffices), or retrieval misses the span |
| **neither alone; use the TREE** | summary as *index* → drill to chunk on demand | **whole-document synthesis** or unknown-locus detail | — (this is the general case the summary-headed tree + on-demand retrieval is built for) |

**What this verified failure establishes for the design:**

- **D-EV6: eviction is necessary but NOT sufficient — pair it with a footprint reducer.** When a
  fetched result overflows the budget, reduce it by a *structure-preserving* operation (HR2-INVARIANT):
  **summarize** if the need survives abstraction, **chunk+retrieve** if the need is a localized detail.
  Without a reducer, eviction livelocks. This test proved summarize on gist-sufficient content
  (docstrings); it did **not** prove summarize on buried detail — where **chunking is the right reducer**
  (see the follow-up experiment).
- **The two reducers are the two arms of the summary-headed tree.** Summary = navigational index (gist);
  on-demand chunk retrieval = the detail drill-down. The read-loop failure is direct evidence that
  *both* are needed — a summary-only system loses buried detail; a chunk-only system loses the cheap
  gist/index. The tree (summary → drill to chunk) is the general break-out.
- A **behavioral nudge / instruction is not a break-out** — the agent follows context, not exhortation.

## Tested vs. open

- **Tested (live, reproduced + fixed):** the read-loop = working-set thrashing; a behavioral nudge
  does not break it; **summarizing tool results does** (robust across budgets 1500–2000 where raw
  reads loop).
- **Open / caveats:** single task/model. The summary here is a heuristic (docstring + signatures),
  sufficient because these reference files' value lived in their docstrings; a task needing full file
  *content* would need **on-demand retrieval of the one relevant file** (not blanket summaries) — i.e.
  the retriever, not just compression. A **loop detector** (repeated-identical-call → forced
  summarize/retrieve) is a natural safety net worth adding. Whether a **completed-steps ledger** helps
  orthogonally (it did not, alone, in the earlier maxTurns run) is untested here.

**Instrument:** `experiments/coding-harness/debug-readloop.mjs` (flags: `--budget --policy --maxturns
--dethrash --summarize`; `CT_ANCHOR` env). Deterministic at temp 0.
