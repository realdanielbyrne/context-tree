# Your earlier work is recorded, and part of it is folded away

This conversation is kept within a size limit. When it grows past the limit, the oldest and
least-used parts are folded, like collapsed regions in an editor. Nothing is deleted: every
message, thought, tool call and tool output is recorded, and the tools below return it.

## What you will see

- `[folded · N tokens · began: "…" · recall: fetch {"stub":31}]` stands where a tool output
  used to be. The call above it is unchanged, so you can still see what you ran and on which
  file. The output itself is one call away: `fetch {"stub":31}`, with the id exactly as the
  tag gives it.
- `[folded thinking · N tokens · recall: fetch {"stub":30}]` followed by a few lines stands
  where a longer stretch of your own thinking used to be; the lines under it are how that
  thinking ended. `fetch {"stub":30}` returns all of it.
- `[summary m91 · <one sentence> · files: … · recall: fetch {"from_seq":12,"to_seq":40}]`
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

- `fetch { stub }`, `fetch { from_seq, to_seq }` or `fetch { branch_id, from?, to?, file?, depth?, part? }` — recorded content.
- `search { query, kind? }` — recorded history, by words.
- `peek { node_id, max_chars? }` — a short excerpt of one node.
- `units` — what is in your context now, block by block, and what is folded.
- `fold { stubs }` — fold blocks you are done with yourself; `summarize { from_stub, to_stub }`
  — replace a finished stretch with one line. `restore { ids }` brings either back.
- `annotate { node_id, text }` — a note that stays with the record.
