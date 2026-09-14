# Duplicate-content analysis

*How often a coding agent re-reads the same file into its context over a session — and what it costs.*
Source: 4 committed Claude Code session fixtures (`packages/cli/test/fixtures/claude-code-session*.jsonl`).
Generated 2026-09-14. Rerun: `node experiments/context-dedup/analyze-duplicate-reads.mjs`.

## Executive summary

**59.2% of all file reads were re-reads** of a file already in context
(42 of 71 across 4 sessions). Redundant re-loaded
content reaches **66.7%** of everything read in the
worst session, and a single file was pulled in as many as **13×**.
Every copy persists in the window, so this is recoverable context bloat — the motivation for a
"one copy per external reference" rule (experiment E3).

| metric | value |
|---|---|
| reads that were re-reads (pooled) | **59.2%** |
| re-reads / total reads | 42 / 71 |
| redundant tokens (all sessions) | 32.2k |
| most-read single file | 13× |

## Method & caveats

Each `Read` call is paired with its result and keyed by file path (and `offset`/`limit` where present).
A re-read is any read of a path already read earlier in the same session. "Redundant" tokens = every copy
of a file beyond the single largest copy kept (≈ what a keep-latest dedup removes). Tokens use the
harness `chars/4` estimate. Read-only.

- Counts the Read tool only — content also enters via Edit, Bash (cat), and Grep, which are not counted.
- Some re-reads are legitimate: the file was changed by an intervening Edit, or a different line range was read.
- Token counts are the chars/4 estimate used by the harness, not a real tokenizer.
- Redundant = every copy of a file beyond the single largest copy kept.

## Findings

### Re-read rate per session
- **session-2**: 70.4% (19/27)
- **session-3**: 66.7% (2/3)
- **session-4**: 73.7% (14/19)
- **session**: 31.8% (7/22)

Pooled across all fixtures: **59.2%**.

### Read tokens: unique vs redundant
- **session-2**: 14.5k redundant of 34.7k loaded (41.7%)
- **session-3**: 51 redundant of 76 loaded (66.7%)
- **session-4**: 13.3k redundant of 36.8k loaded (36.3%)
- **session**: 4.3k redundant of 24.5k loaded (17.7%)

### Per-session detail

| session | reads | distinct | re-reads | files ≥2× | redundant / loaded tokens | worst | edits |
|---|---|---|---|---|---|---|---|
| session-2 | 27 | 8 | 19 (70.4%) | 5 | 14.5k / 34.7k (41.7%) | 13× | 58 |
| session-3 | 3 | 1 | 2 (66.7%) | 1 | 51 / 76 (66.7%) | 3× | 0 |
| session-4 | 19 | 5 | 14 (73.7%) | 3 | 13.3k / 36.8k (36.3%) | 10× | 67 |
| session | 22 | 15 | 7 (31.8%) | 4 | 4.3k / 24.5k (17.7%) | 4× | 34 |

### Most re-read files (pooled)

| count | file | path |
|---|---|---|
| 13× | `hypothesis-test-ladder.md` | `/Users/danielbyrne/GitHub/rpm/context-tree/reports/hypothesis-test-ladder.md` |
| 10× | `algorithm.md` | `/home/realdanielbyrne/GitHub/context-tree/reports/algorithm.md` |
| 5× | `hypothesis-test-ladder.md` | `/home/realdanielbyrne/GitHub/context-tree/reports/hypothesis-test-ladder.md` |
| 4× | `algorithm.md` | `/Users/danielbyrne/GitHub/rpm/context-tree/reports/algorithm.md` |
| 4× | `loop.ts` | `/Users/danielbyrne/GitHub/rpm/context-tree/eval/src/loop.ts` |
| 3× | `retriever.ts` | `/Users/danielbyrne/GitHub/rpm/context-tree/packages/core/src/retrieve/retriever.ts` |
| 3× | `WA900.pdf` | `/home/realdanielbyrne/GitHub/context-tree/docs/WA900.pdf` |
| 3× | `assembler.ts` | `/Users/danielbyrne/GitHub/rpm/context-tree/packages/core/src/assemble/assembler.ts` |

### Reads-per-file distribution (pooled)

| reads of a file | number of files |
|---|---|
| 1× | 16 |
| 2× | 5 |
| 3× | 3 |
| 4× | 2 |
| 5× | 1 |
| 10× | 1 |
| 13× | 1 |

## Conclusion

Re-reading dominates file access in long sessions (59.2% of reads pooled;
73.7% in the worst), and every duplicate copy stays
resident in the window. A naive assembler rule — **keep only the most-recent copy of any external
reference** — would reclaim on the order of a third of all read tokens with no new information lost,
*provided the dropped copies are genuinely superseded*. Whether that holds without hurting task success
(an older read of a *different* section still being needed) is exactly what experiment **E3** tests before
any package change.

> Charts: see the self-contained HTML twin, `duplicate-read-analysis.html`.
