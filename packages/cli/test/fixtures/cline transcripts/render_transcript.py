#!/usr/bin/env python3
"""Render a Cline CLI session store file into a readable Markdown transcript.

The CLI store (~/.cline/data/sessions/<session>/<session>.messages.json) already
holds everything: the system prompt, user prompts, assistant thinking blocks,
tool calls, and tool results. This script does not paraphrase any of it — it
re-serialises those blocks in order and pulls embedded base64 images out into
real files so the transcript stays diffable.

Usage:
    python3 render_transcript.py <messages.json> [<session.json>] <out.md>

The optional session.json is Cline's session metadata (cwd, model, start time,
the opening prompt); when omitted those rows are skipped.
"""

from __future__ import annotations

import base64
import binascii
import json
import re
import sys
from pathlib import Path

# A tool result that the store truncated mid-emoji leaves a lone surrogate code
# unit (e.g. "\ud83e" from a half-written 🧠). Python keeps it in the str, but it
# cannot be encoded to UTF-8, so replace any lone surrogate with U+FFFD.
_LONE_SURROGATE = re.compile("[\ud800-\udfff]")


def clean(text: str) -> str:
    return _LONE_SURROGATE.sub("\ufffd", text)


def fence_for(text: str) -> str:
    """A backtick fence longer than the longest run inside `text`."""
    longest = run = 0
    for ch in text:
        run = run + 1 if ch == "`" else 0
        longest = max(longest, run)
    return "`" * max(3, longest + 1)


def code_block(text: str, lang: str = "") -> str:
    fence = fence_for(text)
    return f"{fence}{lang}\n{text}\n{fence}\n"


def fmt_ts(ms: object) -> str:
    if not isinstance(ms, (int, float)):
        return ""
    from datetime import datetime, timezone

    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime(
        "%Y-%m-%d %H:%M:%SZ"
    )


def emit_metrics(message: dict) -> str:
    m = message.get("metrics") or {}
    info = message.get("modelInfo") or {}
    bits = []
    if info.get("id"):
        bits.append(str(info["id"]))
    if m.get("inputTokens") is not None:
        bits.append(
            "tokens in/out: {inp}/{out} (cache read {cr}, write {cw})".format(
                inp=m.get("inputTokens"),
                out=m.get("outputTokens"),
                cr=m.get("cacheReadTokens", 0),
                cw=m.get("cacheWriteTokens", 0),
            )
        )
    return f"*{' · '.join(bits)}*" if bits else ""


def render_result_content(content, assets: Path, asset_prefix: str, stem: str) -> list[str]:
    """Tool results are a list of {query, result} envelopes or plain blocks."""
    lines: list[str] = []
    if isinstance(content, str):
        lines.append(code_block(content, "text"))
        return lines
    if not isinstance(content, list):
        lines.append(code_block(json.dumps(content, indent=2, ensure_ascii=False), "json"))
        return lines

    for i, item in enumerate(content):
        if isinstance(item, dict) and item.get("type") == "image":
            data = item.get("data") or ""
            name = f"{stem}-image{i}.png"
            try:
                raw = base64.b64decode(data, validate=False)
                (assets / name).write_bytes(raw)
                magic = raw[:8].hex()
                lines.append(
                    f"![embedded image (decoded from base64, {len(raw)} bytes, "
                    f"magic {magic})]({asset_prefix}{name})\n"
                )
            except (binascii.Error, ValueError) as exc:  # pragma: no cover
                lines.append(f"*(undecodable image block: {exc})*\n")
            continue

        if isinstance(item, dict) and item.get("type") == "text":
            lines.append(code_block(item.get("text") or "", "text"))
            continue

        if isinstance(item, dict) and "query" in item:
            lines.append(f"*query:* `{item.get('query')}`\n")
            inner = item.get("result")
            if isinstance(inner, list):
                lines.extend(render_result_content(inner, assets, asset_prefix, f"{stem}-q{i}"))
            else:
                lines.append(code_block(json.dumps(inner, indent=2, ensure_ascii=False), "json"))
            continue

        lines.append(code_block(json.dumps(item, indent=2, ensure_ascii=False), "json"))
    return lines



def main(argv: list[str]) -> int:
    args = [a for a in argv[1:] if not a.startswith("--")]
    if len(args) == 2:
        messages_path, out_path = Path(args[0]), Path(args[1])
        session_path = None
    elif len(args) == 3:
        messages_path, session_path, out_path = Path(args[0]), Path(args[1]), Path(args[2])
    else:
        print(__doc__)
        return 2

    data = json.loads(messages_path.read_text())
    session = json.loads(session_path.read_text()) if session_path else {}
    messages = data.get("messages") or []
    stem = out_path.stem
    assets = out_path.parent / f"{stem}.assets"
    assets.mkdir(parents=True, exist_ok=True)
    asset_prefix = f"{stem}.assets/"

    counts: dict[str, int] = {}
    tokens = {"in": 0, "out": 0, "cacheRead": 0, "cacheWrite": 0}
    for m in messages:
        for b in m.get("content") or []:
            if isinstance(b, dict):
                counts[b.get("type", "?")] = counts.get(b.get("type", "?"), 0) + 1
        mm = m.get("metrics") or {}
        tokens["in"] += mm.get("inputTokens") or 0
        tokens["out"] += mm.get("outputTokens") or 0
        tokens["cacheRead"] += mm.get("cacheReadTokens") or 0
        tokens["cacheWrite"] += mm.get("cacheWriteTokens") or 0

    out: list[str] = []
    out.append(f"# Chat transcript — {stem}\n")
    out.append(
        "Verbatim session record, saved from the CLI session store "
        f"(`{messages_path.name}`). Nothing here is paraphrased: the system prompt, "
        "the user prompts, every assistant reasoning block, and every tool call "
        "with its full result are reproduced in order.\n"
    )
    out.append("## Session\n")
    out.append("| field | value |")
    out.append("| --- | --- |")
    rows = [
        ("session id", data.get("sessionId") or session.get("session_id")),
        ("source", session.get("source")),
        ("cwd", session.get("cwd")),
        ("workspace root", session.get("workspace_root")),
        ("started at", session.get("started_at")),
        ("last write to store", data.get("updated_at")),
        ("provider / model", f"{session.get('provider')} / {session.get('model')}"),
        ("status at snapshot", session.get("status")),
        ("messages", len(messages)),
        ("blocks", ", ".join(f"{k}: {v}" for k, v in sorted(counts.items()))),
        (
            "assistant tokens",
            "in {inp}, out {out}, cache read {cr}, cache write {cw}".format(
                inp=tokens["in"],
                out=tokens["out"],
                cr=tokens["cacheRead"],
                cw=tokens["cacheWrite"],
            ),
        ),
    ]
    for label, value in rows:
        if value not in (None, ""):
            out.append(f"| {label} | `{value}` |")
    out.append("")

    if session.get("prompt"):
        out.append("## Opening prompt\n")
        out.append(code_block(str(session["prompt"]), "text"))

    if data.get("system_prompt"):
        out.append("## System prompt\n")
        out.append("<details><summary>Full system prompt as sent to the model</summary>\n")
        out.append(code_block(data["system_prompt"], "text"))
        out.append("</details>\n")

    out.append("## Conversation\n")
    for idx, message in enumerate(messages, start=1):
        role = message.get("role", "?")
        out.append(f"### {idx}. {role}\n")
        meta_bits = []
        if message.get("ts"):
            meta_bits.append(fmt_ts(message["ts"]))
        line = emit_metrics(message)
        if line:
            meta_bits.append(line)
        if meta_bits:
            out.append(" · ".join(meta_bits) + "\n")

        for j, block in enumerate(message.get("content") or []):
            if not isinstance(block, dict):
                out.append(code_block(str(block), "text"))
                continue
            btype = block.get("type")
            if btype == "text":
                out.append(block.get("text") or "")
                out.append("")
            elif btype == "thinking":
                out.append("**🧠 thinking**\n")
                out.append(code_block(block.get("thinking") or "", "thinking"))
            elif btype == "tool_use":
                out.append(
                    f"**🔧 tool call — `{block.get('name')}`** "
                    f"(id `{block.get('id')}`)\n"
                )
                out.append(
                    code_block(
                        json.dumps(block.get("input"), indent=2, ensure_ascii=False),
                        "json",
                    )
                )
            elif btype == "tool_result":
                out.append(
                    f"**📥 tool result — `{block.get('name')}`** "
                    f"(for `{block.get('tool_use_id')}`)\n"
                )
                out.extend(
                    render_result_content(
                        block.get("content"),
                        assets,
                        asset_prefix,
                        f"{stem}-m{idx}-b{j}",
                    )
                )
            else:
                out.append(code_block(json.dumps(block, indent=2, ensure_ascii=False), "json"))

        bad = (message.get("metadata") or {}).get("invalidToolCalls")
        if bad:
            out.append(f"**⚠️ {len(bad)} invalid/rejected tool call(s) in this turn**\n")
            out.append(code_block(json.dumps(bad, indent=2, ensure_ascii=False), "json"))

    final = clean("\n".join(out) + "\n")
    # errors="replace" is belt-and-braces: `clean` already removed every lone
    # surrogate, but never let an encoding failure cost us the whole file.
    out_path.write_text(final, errors="replace")
    print(
        f"wrote {out_path} ({out_path.stat().st_size} bytes); "
        f"{len(messages)} messages, {counts.get('tool_use', 0)} tool calls, "
        f"{counts.get('thinking', 0)} thinking blocks; assets in {assets}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
