# Summarize one branch of a context tree

You are given the raw detail of a single branch — one phase of an agent's work
on a coding task: its prompts, replies, tool calls and file edits. Write the
heading that will stand in for that detail from now on.

A future agent will see your summary instead of the events. It decides what to
pull back into context using nothing but what you write here. The prose says
what happened; the metadata is what lets that agent detect relevance **without
expanding this branch**. A file, symbol, test, ticket or open question you leave
out is one the future agent cannot know to ask about — so the metadata is the
part to get right, and empty is honest but silence is not.

## Output format

Reply with a single JSON object and nothing else. No prose before or after it.

```json
{
  "text": "2-6 sentences of prose: what this phase set out to do, what it actually did, and how it ended.",
  "meta": {
    "files": [{ "path": "src/a.ts", "start_line": 10, "end_line": 42, "symbol": "parseThing" }],
    "symbols": ["parseThing"],
    "tests": [{ "name": "parses a fenced block", "status": "passed", "detail": "optional" }],
    "artifacts": [{ "kind": "ticket", "ref": "SOF-123", "title": "optional" }],
    "open_questions": ["Anything left unresolved when this phase closed."],
    "decisions": ["A choice made here that later work must not silently reverse."],
    "node_ids": ["n_01J..."]
  }
}
```

Every field is required. Use `[]` for a field with nothing in it — never omit a
field, never write `null`.

- `files` — every file this phase touched. `path` repo-relative; `start_line`
  and `end_line` 1-based and inclusive; `symbol` the enclosing function, class
  or method when the detail names one, omitted when it does not. If the detail
  gives you a file with no usable line range, use the range of the edit shown.
- `symbols` — the symbol names changed, deduplicated. Names only.
- `tests` — every test or suite this phase ran. `status` must be exactly one of
  `passed`, `failed`, `skipped`, `unknown`; use `unknown` when the detail shows
  a test running but not its result. Never guess a pass.
- `artifacts` — external references. `kind` must be exactly one of `ticket`,
  `pr`, `url`, `other`.
- `open_questions` — what was still unanswered when this phase ended, phrased so
  it is answerable by someone who has not read this branch.
- `decisions` — choices whose reversal would be a regression, with the reason
  where the detail gives one.
- `node_ids` — the node ids covered by this branch, copied from NODE IDS below.

Report only what the detail below supports. Do not infer a test result, a ticket
number or a line range that is not there.

## Branch

BRANCH TITLE: {{node_title}}
PHASE TYPE: {{phase_type}}
NODE IDS: {{node_ids}}

RAW DETAIL:
{{detail}}
