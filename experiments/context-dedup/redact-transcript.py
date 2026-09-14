#!/usr/bin/env python3
"""
Redact live credentials out of a Claude Code session transcript before it is
committed as a test fixture.

A raw transcript captures shell-expanded command text, so values from .env end up
embedded verbatim (measured on this session: 110 occurrences of 5 distinct live
keys). Committing that publishes them into git history permanently.

This replaces every exact secret VALUE with <REDACTED:NAME>, then re-scans and
refuses to write unless the result is provably clean. Structure is untouched — the
tool_use/tool_result shape that makes these transcripts useful as a corpus survives
byte-for-byte apart from the secret literals.

Usage:
  python3 redact-transcript.py <src.jsonl> <dst.jsonl> [--env .env]
"""
import argparse, json, os, re, sys

GENERIC = {
    "sk-proj-":    r"sk-proj-[A-Za-z0-9_\-]{12,}",
    "sk-ant-":     r"sk-ant-[A-Za-z0-9_\-]{12,}",
    "sk-unsloth-": r"sk-unsloth-[A-Za-z0-9_\-]{12,}",
    "sk-or-":      r"sk-or-[A-Za-z0-9_\-]{12,}",
    "gh-token":    r"gh[pos]_[A-Za-z0-9]{20,}",
    "aws-akia":    r"AKIA[0-9A-Z]{16}",
    "langfuse":    r"[ps]k-lf-[A-Za-z0-9_\-]{12,}",
}


def load_env(path):
    """name -> value, for values long enough to be credentials."""
    out = {}
    if not os.path.exists(path):
        return out
    for line in open(path):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        v = v.strip().strip('"').strip("'")
        if len(v) >= 12:
            out[k.strip()] = v
    return out


def scan(text, secrets):
    """(exact_hits, pattern_hits) — never returns the secret itself."""
    exact = {k: text.count(v) for k, v in secrets.items()}
    pats = {n: len(re.findall(p, text)) for n, p in GENERIC.items()}
    return exact, pats


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--env", default=".env")
    a = ap.parse_args()

    secrets = load_env(a.env)
    if not secrets:
        sys.exit(f"no credentials loaded from {a.env}; refusing to run blind")
    text = open(a.src, "r", errors="replace").read()

    before_exact, before_pat = scan(text, secrets)
    print("BEFORE — exact .env value occurrences:")
    for k, n in before_exact.items():
        print(f"  {k:<22} {n}")
    print("BEFORE — generic patterns:")
    for k, n in before_pat.items():
        if n:
            print(f"  {k:<14} {n}")

    # longest-first so a key that contains another is replaced whole
    for name, val in sorted(secrets.items(), key=lambda kv: -len(kv[1])):
        text = text.replace(val, f"<REDACTED:{name}>")
    # sweep any credential-shaped literal that was never in .env
    for name, pat in GENERIC.items():
        text = re.sub(pat, f"<REDACTED:{name}>", text)

    after_exact, after_pat = scan(text, secrets)
    total_after = sum(after_exact.values()) + sum(after_pat.values())
    print(f"\nAFTER — remaining occurrences: {total_after}")
    if total_after:
        for k, n in {**after_exact, **after_pat}.items():
            if n:
                print(f"  STILL PRESENT: {k} x{n}")
        sys.exit("REFUSING TO WRITE — redaction incomplete")

    # every line must still parse as JSON, or the fixture is useless
    bad = 0
    for i, line in enumerate(text.split("\n")):
        if not line.strip():
            continue
        try:
            json.loads(line)
        except Exception:
            bad += 1
            if bad <= 3:
                print(f"  WARN: line {i+1} no longer parses as JSON")
    if bad:
        sys.exit(f"REFUSING TO WRITE — {bad} line(s) broke JSON parsing")

    open(a.dst, "w").write(text)
    n_red = text.count("<REDACTED:")
    print(f"clean. wrote {a.dst}  ({os.path.getsize(a.dst):,} bytes, {n_red} redactions, JSON intact)")


if __name__ == "__main__":
    main()
