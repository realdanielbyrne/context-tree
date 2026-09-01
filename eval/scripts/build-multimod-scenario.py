#!/usr/bin/env python3
"""Self-verifying generator for sw-2-multimod (the >k-branch long task).

Phase-0 prerequisite from the long-task report (§9.1): the tree-dsa selector
never fired because sw-1-jsonc grew <= 3 branches. This task forces module-by-
module read->test->fix cycles across FOUR independent modules, so segmentation
alternates diagnosis/implementation and yields ~8 phase branches (> k=3).

Same contract as build-jsonc-scenario.py:
  - ships four buggy modules, asserts they FAIL the hidden suite;
  - writes the correct reference modules, asserts they PASS;
  - only then writes the single-row scenario JSONL.
"""

import json
import os
import pathlib
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
JSONL = HERE.parent / "scenarios" / "deepswe-agents-last-exam" / "agents-last-exam.jsonl"

# ---------------------------------------------------------------- buggy modules

BUGGY_SLUGIFY = '''\
"""slugify(text) -> str

Contract:
- lowercase the input;
- every maximal run of characters that are not a-z or 0-9 becomes ONE hyphen;
- no leading or trailing hyphens in the result.
"""
import re


def slugify(text):
    text = text.lower()
    # BUG: replaces each character individually (runs are not collapsed) and
    # never strips boundary hyphens.
    return re.sub(r"[^a-z0-9]", "-", text)
'''

BUGGY_WORDWRAP = '''\
"""wrap_text(text, width) -> list[str]

Contract (greedy wrap):
- words are maximal runs of non-whitespace; original whitespace is not kept;
- pack words left to right; a line never exceeds `width` characters counting
  the single joining spaces;
- a single word longer than `width` goes on its own line, unsplit;
- no empty lines in the result.
"""


def wrap_text(text, width):
    words = text.split()
    lines = []
    current = []
    current_len = 0
    for word in words:
        # BUG: the joining space is not counted, so lines overflow `width`.
        if current and current_len + len(word) > width:
            lines.append(" ".join(current))
            current = []
            current_len = 0
        current.append(word)
        current_len += len(word)
    if current:
        lines.append(" ".join(current))
    return lines
'''

BUGGY_NUMPARSE = '''\
"""parse_count(s) -> int

Contract:
- s is a human-readable count: optional leading "-", digits with optional
  thousands commas ("1,234,567"), OR a decimal number with a k/K (x1000) or
  m/M (x1000000) suffix ("2.5k" -> 2500, "-3M" -> -3000000);
- the multiplier applies to the full decimal value BEFORE truncating to int.
"""


def parse_count(s):
    s = s.strip().replace(",", "")
    mult = 1
    if s and s[-1] in "kK":
        mult = 1000
        s = s[:-1]
    elif s and s[-1] in "mM":
        mult = 1000000
        s = s[:-1]
    # BUG: truncates the decimal BEFORE applying the multiplier, so
    # "2.5k" -> int(2.5) * 1000 = 2000 instead of 2500.
    return int(float(s)) * mult
'''

BUGGY_DEDENT = '''\
"""dedent_text(text) -> str

Contract:
- remove the LARGEST COMMON leading whitespace shared by all non-blank lines;
- blank lines (empty or whitespace-only) become empty lines and are ignored
  when computing the common indent;
- line structure is otherwise preserved.
"""


def dedent_text(text):
    lines = text.split("\\n")
    # BUG: uses the FIRST non-blank line's indent as the amount to strip from
    # every line, so less-indented lines lose real content.
    indent = 0
    for line in lines:
        if line.strip():
            indent = len(line) - len(line.lstrip())
            break
    out = []
    for line in lines:
        if not line.strip():
            out.append("")
        else:
            out.append(line[indent:])
    return "\\n".join(out)
'''

# ------------------------------------------------------------ reference fixes

FIXED_SLUGIFY = '''\
import re


def slugify(text):
    text = text.lower()
    text = re.sub(r"[^a-z0-9]+", "-", text)
    return text.strip("-")
'''

FIXED_WORDWRAP = '''\
def wrap_text(text, width):
    words = text.split()
    lines = []
    current = []
    current_len = 0
    for word in words:
        extra = len(word) if not current else len(word) + 1
        if current and current_len + extra > width:
            lines.append(" ".join(current))
            current = [word]
            current_len = len(word)
        else:
            current.append(word)
            current_len += extra
    if current:
        lines.append(" ".join(current))
    return lines
'''

FIXED_NUMPARSE = '''\
def parse_count(s):
    s = s.strip().replace(",", "")
    mult = 1
    if s and s[-1] in "kK":
        mult = 1000
        s = s[:-1]
    elif s and s[-1] in "mM":
        mult = 1000000
        s = s[:-1]
    return int(float(s) * mult)
'''

FIXED_DEDENT = '''\
def dedent_text(text):
    lines = text.split("\\n")
    indents = [
        len(line) - len(line.lstrip())
        for line in lines
        if line.strip()
    ]
    indent = min(indents) if indents else 0
    out = []
    for line in lines:
        if not line.strip():
            out.append("")
        else:
            out.append(line[indent:])
    return "\\n".join(out)
'''

# --------------------------------------------------------------- hidden tests


def build_hidden_test() -> str:
    cases = []

    def case(module, expr, expected):
        cases.append((module, expr, expected))

    # slugify: run collapse + boundary strip
    case("slugify", 'slugify("Hello, World!")', "hello-world")
    case("slugify", 'slugify("  --A  B--  ")', "a-b")
    case("slugify", 'slugify("a_b c")', "a-b-c")
    case("slugify", 'slugify("Rock & Roll #1")', "rock-roll-1")

    # wordwrap: width honored counting joining spaces; long word unsplit
    case("wordwrap", 'wrap_text("aa bb cc dd", 5)', ["aa bb", "cc dd"])
    case("wordwrap", 'wrap_text("one two three", 8)', ["one two", "three"])
    case(
        "wordwrap",
        'wrap_text("tiny extraordinarily tiny", 6)',
        ["tiny", "extraordinarily", "tiny"],
    )
    case("wordwrap", 'wrap_text("a b c", 3)', ["a b", "c"])

    # numparse: decimal-before-truncate; commas; sign; plain ints
    case("numparse", 'parse_count("1,234,567")', 1234567)
    case("numparse", 'parse_count("2.5k")', 2500)
    case("numparse", 'parse_count("-3M")', -3000000)
    case("numparse", 'parse_count("42")', 42)
    case("numparse", 'parse_count("-1.5k")', -1500)

    # dedent: common (minimum) indent; blank lines blanked and ignored
    case("dedent", 'dedent_text("    a\\n  b\\n      c")', "  a\nb\n    c")
    case("dedent", 'dedent_text("  a\\n\\n  b")', "a\n\nb")
    case("dedent", 'dedent_text("a\\n  b")', "a\n  b")
    case("dedent", 'dedent_text("   \\n  x")', "\nx")

    lines = [
        "import sys",
        "from slugify import slugify",
        "from wordwrap import wrap_text",
        "from numparse import parse_count",
        "from dedent import dedent_text",
        "",
        "failures = 0",
    ]
    for module, expr, expected in cases:
        lines.append("try:")
        lines.append("    got = %s" % expr)
        lines.append("except Exception as e:")
        lines.append("    got = 'raised %s: %s' % (type(e).__name__, e)")
        lines.append("if got != %r:" % (expected,))
        lines.append(
            "    print('FAIL [%s] %s -> %%r (want %%r)' %% (got, %r))"
            % (module, expr.replace("%", "%%"), expected)
        )
        lines.append("    failures += 1")
    lines.append("")
    lines.append("if failures:")
    lines.append("    print('%d case(s) failed' % failures)")
    lines.append("    sys.exit(1)")
    lines.append("print('all cases passed')")
    return "\n".join(lines) + "\n"


TASK = """\
The working directory contains four small, independent text-utility modules —
`slugify.py`, `wordwrap.py`, `numparse.py`, `dedent.py` — plus a `README.md`.
Each module has a docstring stating its exact contract, and each module
currently has a bug that violates that contract.

Fix all four modules so they satisfy their documented contracts.

Work module by module, in this order: slugify, wordwrap, numparse, dedent.
For EACH module: (1) read the module file; (2) write a few focused test cases
for its documented contract into a scratch test file and run it to see the
bug; (3) fix the module; (4) re-run your tests to confirm the fix — only then
move on to the next module. Do not batch the fixes.

When all four modules pass your tests, reply DONE.
"""

README = """\
# textkit

Four tiny text utilities. Each module documents its contract in its docstring:

- `slugify.py` — URL slugs from arbitrary text.
- `wordwrap.py` — greedy word wrapping to a width.
- `numparse.py` — human-readable counts ("1,234", "2.5k") to ints.
- `dedent.py` — strip the common leading indent from a block of text.

Known issue: every module currently has one contract-violating bug.
"""


def write_files(root: pathlib.Path, files: dict) -> None:
    for name, content in files.items():
        (root / name).write_text(content, encoding="utf-8")


def run(test_path: pathlib.Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(test_path)], capture_output=True, text=True
    )


def main() -> None:
    hidden = build_hidden_test()
    row = {
        "id": "sw-2-multimod",
        "task": TASK,
        "files": {
            "slugify.py": BUGGY_SLUGIFY,
            "wordwrap.py": BUGGY_WORDWRAP,
            "numparse.py": BUGGY_NUMPARSE,
            "dedent.py": BUGGY_DEDENT,
            "README.md": README,
        },
        "judge_command": "python3 hidden_test.py",
        "judge_files": {"hidden_test.py": hidden},
    }

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = pathlib.Path(tmp)
        cwd_before = os.getcwd()
        os.chdir(tmp_path)
        try:
            write_files(tmp_path, {**row["files"], **row["judge_files"]})
            buggy = run(tmp_path / "hidden_test.py")
            print("=== BUGGY exit=%s ===" % buggy.returncode)
            print((buggy.stdout + buggy.stderr)[-1200:])
            # Every module must fail at least one case on its own — a module
            # whose bug the suite cannot see would measure nothing (defect #4
            # in the report's ledger).
            per_module_fail = {
                m: ("[%s]" % m) in buggy.stdout
                for m in ("slugify", "wordwrap", "numparse", "dedent")
            }
            write_files(
                tmp_path,
                {
                    "slugify.py": FIXED_SLUGIFY,
                    "wordwrap.py": FIXED_WORDWRAP,
                    "numparse.py": FIXED_NUMPARSE,
                    "dedent.py": FIXED_DEDENT,
                },
            )
            fixed = run(tmp_path / "hidden_test.py")
            print("=== FIXED exit=%s ===" % fixed.returncode)
            print((fixed.stdout + fixed.stderr)[-400:])
        finally:
            os.chdir(cwd_before)

    assert buggy.returncode != 0, "buggy modules should FAIL the hidden test"
    for module, failed in per_module_fail.items():
        assert failed, "hidden suite never catches the %s bug" % module
    assert fixed.returncode == 0, "reference modules should PASS the hidden test"

    JSONL.write_text(json.dumps(row, ensure_ascii=False) + "\n", encoding="utf-8")
    print("OK: sw-2-multimod written; buggy FAILS (all 4 modules) / fixed PASSES")


if __name__ == "__main__":
    main()
