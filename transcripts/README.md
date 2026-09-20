# Transcripts

Verbatim chat-session records, saved here so a session's reasoning and tool
history can be read back later (or diffed) without the CLI store.

## Naming

```
<date>-<ticket>-<slug>.session.json                      # session metadata
<date>-<ticket>-<slug>.messages.json                     # the record itself
<date>-<ticket>-<slug>.md                                # readable rendering
<date>-<ticket>-<slug>.assets/                           # images pulled out of it
<date>-<ticket>-<slug>.agent-<name>.messages.json        # spawned sub-agent(s)
```

## What is in them

The CLI session store already holds the complete picture, and these files are
copies of it — nothing is summarised, filtered, or reworded:

- the **system prompt** (top-level `system_prompt` in the `.messages.json`),
- every **user prompt**, as sent (including its `<user_input mode=…>` wrapper),
- every **assistant reasoning block** (`thinking`),
- every **tool call** with its full input (`tool_use`),
- every **tool result**, including attached screenshots as base64 (`tool_result`),
- per-message **token counts** (`metrics`) and the model that produced it.

The `.md` file is a rendering of exactly those blocks in order, with embedded
images decoded into `.assets/` and referenced inline. It is regenerated, never
hand-edited.

## Refreshing

A session keeps writing to its store while it runs, so a copy is a snapshot.
Re-copy and re-render to bring one up to date:

```bash
src=~/.cline/data/sessions/1789761678413_fr0iq
base=2026-09-18-sof-1305-po-entry-button-alignment
cp "$src/1789761678413_fr0iq.messages.json" "$base.messages.json"
cp "$src/1789761678413_fr0iq.json"          "$base.session.json"
python3 render_transcript.py "$base.messages.json" "$base.session.json" "$base.md"
```

`render_transcript.py --help`-style usage is in its docstring; the session
metadata argument is optional (`render_transcript.py <messages.json> <out.md>`).

## Index

| file | session | content |
| --- | --- | --- |
| `2026-09-18-sof-1305-po-entry-button-alignment.*` | `1789761678413_fr0iq` | SOF-1305 — align Add PO / Import from Quote with Export, match Export corner radius; ticket, PR #551, review loop |
| `2026-09-18-sof-1305-po-entry-button-alignment.agent-adversarial-pr-reviewer.*` | `…__agent_1789762998234_aqrfrx` | The spawned adversarial PR reviewer (hit a provider rate limit) |
