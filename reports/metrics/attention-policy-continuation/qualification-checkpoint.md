# Qualification checkpoint — 2026-09-08

The v2 pilots do not qualify either task as baseline-solvable. Aiomonitor ended
on a provider timeout; ABS was interrupted with a request pending. The recovery
ledger retains both logical attempts. Observed usage is 112,336 and 92,162 tokens,
respectively; complete usage, cost and task outcomes are unknown.

[Corrected recovery summaries](qualification-recovery-summary.json) bind to the
original result hashes. The reporting fix preserves partial observed tokens
without making them complete totals or eligible efficacy evidence. Original
frozen summaries remain unchanged.

## Offline mechanism evidence

[Replay artifact](qualification-v2-policy-replay.json), using the declared
1,000-character excerpt envelope and only captured request prefixes:

| Task | Returned responses | File payloads measured | Anchor differences | Context-tool calls | Phase signals |
| --- | ---: | ---: | ---: | ---: | ---: |
| aiomonitor-task-snapshots-diff | 10 | 15 | 0 | 0 | 0 |
| abs-module-cache-flags | 9 | 0 | 0 | 0 | 0 |

Aiomonitor supports a measurable whole-versus-excerpt file payload intervention.
It does not establish that either delivers better task outcomes. Ordinary
file reads supply no query terms, so first-versus-rarest anchoring is inert here.
Structural selection lacks a supported partition and remains ineligible. ABS's
recorded reads used commands, outside the declared context/read_file boundary.
The boundary is retained; it is not widened after observing the pilot.

H1–H6 and priority remain ineligible under the recorded evidence requirements:
there are no supplied subtask/relevance/plan labels, context searches or fetched
candidate outcomes, and no observed phase signals. Missing measurements are not
evidence of equivalence. Identifier overlap is observational and cannot label
causal usefulness or fit a priority policy.

## Qualification v3

One fresh native attempt per task is registered in the journal using unchanged
model/task/transport settings. It remains qualification only. A completed and
independently verified native solution is needed before scheduling efficacy
comparisons. A completed pilot is also needed to derive their token ceiling.
Any eventual comparison must freeze native and tree baselines with its candidate
in one epoch at equal n=5; these separate qualification epochs cannot supply
paired treatment baselines. No default has been promoted.
