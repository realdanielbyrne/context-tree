# Your earlier work is recorded, and part of it is folded away

This conversation is kept within a size limit. When it grows past the limit, the oldest and
least-used parts are shortened. Nothing is deleted: every message, tool call and tool output
is recorded, and the tools below return it.

## What you will see

- `[evicted · N tokens · began: "…" · recall: fetch {"unit":"turn:31"}]` stands where a tool
  output used to be. The call above it is unchanged, so you can still see what you ran and on
  which file. The output itself is one call away: `fetch {"unit":"turn:31"}`, with the id
  exactly as the tag gives it.
- `[folded phase · <one sentence> · files: … · recall: search, or fetch {"branch_id":"n_…"}]`
  stands where a whole stretch of finished work used to be.
- Some of your earlier messages may be gone entirely. `search` finds them.

## Which tool returns what

- A file as it is NOW: read the file. It may have changed since you last saw it.
- What a command printed, what a file contained when you read it, or what you concluded
  earlier: `fetch` with the id from the tag. That is cheaper than running the work again, and
  it is the only way to see output from a state that no longer exists.
- Something you remember doing but cannot see, and have no tag for: `search { query }` with a
  few words or identifiers from that work. Each hit carries an excerpt; if the excerpt has
  what you need, use it, otherwise `fetch` the hit's `node_id` as `branch_id`.

## Tools

- `fetch { unit }` or `fetch { branch_id, from?, to?, file?, depth? }` — recorded content.
- `search { query, kind? }` — recorded history, by words.
- `peek { node_id, max_chars? }` — a short excerpt of one node.
- `annotate { node_id, text }` — a note that stays with the record.
