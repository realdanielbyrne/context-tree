# Summarize a whole task from its branch summaries

You are given the summaries of every branch of one task, in creation order. You
are not given the raw events, and you do not need them: summarize the summaries.

Your output is the first thing an agent resuming this task will read, and often
the only thing. It has to answer "where does this task stand, and what do I
touch next?" from the prose, and "which branch holds the detail I need?" from
the metadata. The metadata is what lets that agent detect relevance **without
expanding any branch**, so it must roll up the children faithfully: a file,
test, artifact, open question or decision that appears in a child and not in
your roll-up is invisible to whoever comes next.

## Output format

Reply with a single JSON object and nothing else. No prose before or after it.

```json
{
  "text": "A short narrative of the task: the goal, the arc of the work across phases, the current state, and what is unfinished.",
  "meta": {
    "files": [{ "path": "src/a.ts", "start_line": 10, "end_line": 42, "symbol": "parseThing" }],
    "symbols": ["parseThing"],
    "tests": [{ "name": "parses a fenced block", "status": "passed", "detail": "optional" }],
    "artifacts": [{ "kind": "ticket", "ref": "SOF-123", "title": "optional" }],
    "open_questions": ["Still unresolved across the whole task."],
    "decisions": ["A task-level choice later work must not silently reverse."],
    "node_ids": ["n_01J..."]
  }
}
```

Every field is required. Use `[]` for a field with nothing in it — never omit a
field, never write `null`.

Roll-up rules:

- `files` and `symbols` — the union across children, deduplicated by path and
  span. Where two children touched the same file, keep the widest range.
- `tests` — the **latest** outcome per test name, not every run: a test that
  failed in one phase and passed in a later one is `passed`. `status` must be
  exactly one of `passed`, `failed`, `skipped`, `unknown`.
- `artifacts` — the union across children. `kind` must be exactly one of
  `ticket`, `pr`, `url`, `other`.
- `open_questions` — questions still open at task level. Drop any a later child
  answers; keep everything else, merging duplicates.
- `decisions` — the task-level decisions. Where a later branch reversed an
  earlier one, state the decision that stands and that it superseded the other.
- `node_ids` — the node ids of the child branches you summarized, so a reader
  knows exactly which branches to fetch.

Carry nothing forward that the child summaries do not support, and do not
resolve a contradiction between two children by picking one silently — say that
the branches disagree and name them.

## Task

TASK: {{task_title}}

CHILD SUMMARIES:
{{child_summaries}}
