/**
 * Task module for the A/B window sweep — LONG-HORIZON build task.
 *
 * Why this shape (see reports/metrics/context-dedup/report-ab-rule-chain.md and
 * report-tier2-selfheal.md): with a full toolset an agent self-heals any context
 * loss for anything that lives on disk — it just greps it again. The ONLY context
 * that cannot be recovered by a tool call is the CONVERSATION HISTORY itself
 * (prior reasoning, tool calls, test output). So window pressure is intrinsically
 * LONG-HORIZON: it has to be manufactured by many turns of iterative work.
 *
 * v2 note — measured leak, and the fix. A v1 probe completed the task in 35 turns
 * but peaked at only ~10k history tokens. Instrumenting the run showed the model
 * deliberately shrinks its own context: it pipes every test run through `tail -20`,
 * so 11 `run_bash` calls contributed just 1,983 tokens. The context an agent CANNOT
 * shrink is (a) `read_file` results — the tool takes no range argument — and
 * (b) its own `write_file` / `edit_file` payloads, which it must emit in full to
 * make progress. v2 therefore sizes every spec document just under the harness's
 * 2000-char tool-output clip, enlarges the stubs (which the agent reads), and adds
 * a sixth stage whose module is substantial code to write. Turn count is raised
 * with it (CT_MAX_TURNS), because more stages means more turns to finish.
 *
 * PURE STDLIB PYTHON 3 (no pip / PyPI / docker available in this environment).
 * Graded by a HELD-OUT stdlib `unittest` suite written into the workspace at
 * grade time, exercising the specified behaviour on different data.
 *
 * Interface: { name, system, task, seed(ws), grade(ws)->bool, allowedTools? }
 */
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// NOTE: String.raw throughout so Python escapes (\n, \d) survive into the files.
const bt = '`';

const README = String.raw`# ledger — a pure-stdlib Python transaction toolkit

Implement a small ledger toolkit from a written specification. Python 3
STANDARD LIBRARY ONLY: no pip, no third-party imports, no network, no pytest.
Five modules exist in the workspace root as STUBS with the right names and
signatures; fill them in.

    STAGE 1   money.py     spec/01_money.md + spec/01b_money_format.md
    STAGE 2   parsing.py   spec/02_parsing.md + spec/02b_parse_lines.md
    STAGE 3   rules.py     spec/03_rules.md
    STAGE 4   report.py    spec/04_report.md
    STAGE 5   (extension)  spec/05_phase2_tags.md   changes parsing.py + rules.py
    STAGE 6   cli.py       spec/06_cli.md

Four reference documents are also normative; consult them, do not guess:

    spec/00_conventions.md   project conventions — READ THIS FIRST
    spec/00b_contracts.md    error contracts and comment syntax
    spec/07_examples.md      worked examples for money.parse_amount
    spec/07b_examples.md     worked examples for format_amount and categorize

Several specs are split in two. Where a file ends with a "continued in" pointer,
READ THE CONTINUATION — it carries requirements the first half omits. The specs
are authoritative; the stubs only fix names and signatures.

## How to check your work

    python3 -m unittest test_ledger -v

While iterating you may run one class, e.g. ` + bt + `python3 -m unittest
test_ledger.TestMoney -v` + bt + `. The classes are TestMoney, TestParsing, TestRules,
TestReport, TestPhase2 and TestCli. You are done when EVERY test passes.

Grading uses a HELD-OUT suite over the same behaviour on DIFFERENT data, so
implement the SPEC, not the visible test cases.

## Working notes

After each stage, append one line to NOTES.md: ` + bt + `stage <n>: <decision made>` + bt + `.

## Final deliverable

Once the whole suite passes, write SUMMARY.md: one section per stage, headed
` + bt + `## Stage <n> — <module>` + bt + `, each saying in two or three sentences what you
implemented and which spec edge case was most likely to be got wrong.
`;

const CONVENTIONS = String.raw`# Project conventions (read this before anything else)

## Language and dependencies

Python 3, STANDARD LIBRARY ONLY. No third-party imports, no network access, no
pytest. The only test runner available is ` + bt + `python3 -m unittest` + bt + `.

## Module layout

The modules are FLAT in the workspace root and import each other by plain name
(` + bt + `import money` + bt + `), never as a package. There is no __init__.py and you must not
create one. The allowed dependency direction is strictly:

    money.py     imports nothing from this project
    parsing.py   may import money
    rules.py     imports nothing from this project
    report.py    may import money and rules
    cli.py       may import parsing, rules and report

Do not introduce a cycle. Do not move code between modules.

## Money

INTEGER CENTS everywhere. Never use float for money — not for parsing, not for
summing, not for rounding. A cent value is a plain signed ` + bt + `int` + bt + `.

## The transaction dict

A "transaction" (txn) is a plain dict with exactly these four keys:

    {"date": str, "desc": str, "amount": int, "tags": list}

` + bt + `date` + bt + ` is the raw "YYYY-MM-DD" string exactly as it appeared in the input.
` + bt + `desc` + bt + ` is the stripped description. ` + bt + `amount` + bt + ` is signed cents. ` + bt + `tags` + bt + ` is a list
of strings, empty unless the line carried a tags field (see stage 5).

Continued in spec/00b_contracts.md — error contracts, comment syntax, and the
rule about signatures. Read it now; it is short and it is normative.
`;

const CONTRACTS = String.raw`# Conventions, part 2 — contracts

## Error types

    money.parse_amount    raises the builtin ValueError
    parsing.parse_line    raises parsing.LedgerError (defined in the stub)
    rules.load_rules      raises the builtin ValueError
    cli.main              never raises for bad input; it returns an exit code

A LedgerError must not leak out of parsing as a ValueError, and a ValueError
must not leak out of parsing at all — stage 2 says exactly where the conversion
from one to the other happens. Do not catch exceptions more broadly than the
spec says: a bare ` + bt + `except:` + bt + ` anywhere in this project is wrong.

## Comment syntax differs per file kind, ON PURPOSE

    ledger lines : a line whose stripped form starts with "#" is a comment
    rules text   : a line whose stripped form starts with ";" is a comment

This is because "#" is reserved as the TAG-MATCH prefix in rule patterns, which
stage 5 introduces. Do NOT unify the two comment characters, and do not treat a
rules line beginning with "#" as a comment. This is the single most common way
to get stage 3 and stage 5 wrong, and the two stages disagree about it only if
you implement "#" as a rules comment in stage 3.

Blank and whitespace-only lines are skipped wherever lines are parsed, in both
file kinds.

## Signatures

Public names and signatures are fixed by the stubs. Do not rename them, do not
add required arguments, and do not change a return type from a tuple to a list
or vice versa where the spec names one. A function the spec says returns a
2-tuple must return a tuple, not a list of two elements.

## Style

No third-party imports. Standard-library imports only, at the top of the file.
`;

const SPEC_MONEY = String.raw`# Stage 1 — money.py

## parse_amount(s) -> int

Parse a money string into SIGNED INTEGER CENTS. Apply these steps IN ORDER; the
order decides how a string like "$-5" reads.

1. If ` + bt + `s` + bt + ` is not a ` + bt + `str` + bt + `, raise ValueError. Do not coerce numbers.
2. Strip outer whitespace. If nothing is left, raise ValueError.
3. NEGATIVE FORMS — at most one of these applies:
   - Wrapped in parentheses, "(" ... ")" — NEGATIVE. Take the text between them
     and strip it. If that inner text starts with "-" or "+", raise ValueError:
     a sign inside parentheses is a double-negative and is not accepted.
   - Starts with "-" — NEGATIVE. Take the rest and strip it.
   - Starts with "+" — raise ValueError. A leading plus is never accepted.
   - Otherwise positive.
4. CURRENCY SYMBOL — an optional "$" may appear ONLY at the very start of what
   remains after step 3, i.e. after the sign or after the opening parenthesis.
   So "-$5" and "($5)" are valid but "$-5" is NOT: there the "$" is consumed
   first and the remainder still carries a sign, which step 5 rejects. Remove
   one leading "$" if present.
5. MAGNITUDE — what remains must match one of these two shapes:
   - NO comma:   one or more digits, optionally "." then 1 OR 2 digits
   - WITH comma: 1-3 digits, then one or more groups of "," + EXACTLY 3 digits,
                 optionally "." then 1 OR 2 digits
   Anything else raises ValueError: letters, an empty remainder, a second ".",
   three or more decimals, bad grouping, or internal whitespace.
6. CENTS — split the magnitude on ".". A one-digit fractional part is
   RIGHT-padded with "0", so "0.5" is 50 cents, not 5. Cents equal
   whole * 100 + fraction. Apply the sign from step 3; return an ` + bt + `int` + bt + `.

Negative zero is just zero: "-0.00" returns 0, not -0.

The tables in spec/07_examples.md are normative — where an example and your
reading of this prose disagree, the example wins.

Continued in spec/01b_money_format.md, which specifies format_amount.
`;

const SPEC_MONEY_B = String.raw`# Stage 1, part 2 — money.format_amount

## format_amount(cents) -> str

` + bt + `cents` + bt + ` is a signed ` + bt + `int` + bt + ` number of cents. Produce a currency string:

  - Take the ABSOLUTE value. The sign is handled separately, at the end.
  - Split it into whole dollars and a remainder of cents with ` + bt + `divmod(v, 100)` + bt + `.
  - Render the dollars with "," thousands separators — Python's ` + bt + `"{:,}"` + bt + ` format
    does exactly this.
  - Render the cents with EXACTLY two digits, zero-padded, so 5 cents renders as
    "05" and 70 cents renders as "70". Never one digit, never three.
  - Join them with ".", prefix "$".
  - If the input was negative, put "-" BEFORE the "$".

So the sign goes outside the currency symbol: "-$12.50" is correct and
"$-12.50" is wrong. Likewise "$12.50" is correct and "$12.5" is wrong.

Zero formats as "$0.00" and never as "-$0.00", because zero is not negative.

Do not round, and do not go through ` + bt + `float` + bt + ` to get the two decimal places —
the input is already an exact integer number of cents.

This function is the ONLY place money is turned into text. report.py calls it
rather than formatting amounts itself, so getting it right once fixes the
column alignment in stage 4 as well.

The worked table is in spec/07b_examples.md.
`;

const SPEC_PARSING = String.raw`# Stage 2 — parsing.py

A ledger line has EXACTLY THREE pipe-separated fields at this stage. Stage 5
extends this to allow a fourth; do not implement the fourth field yet.

    DATE | DESCRIPTION | AMOUNT

## parse_line(line) -> txn dict

1. Split the whole line on "|". Do not limit the number of splits. If the
   resulting field count is not 3, raise LedgerError.
2. Strip every field.
3. DATE must satisfy BOTH of these, else LedgerError:
   - its SHAPE is YYYY-MM-DD: exactly 4 digits, "-", exactly 2 digits, "-",
     exactly 2 digits, and nothing else
   - it is a real calendar date
   The shape check is not redundant. ` + bt + `datetime.date.fromisoformat` + bt + ` accepts
   other spellings on modern Python — "20240105" parses fine — so a date that is
   real but wrongly shaped must still be rejected. Equally, "2024-02-30" has the
   right shape but is not a real date and must also be rejected.
4. DESCRIPTION must be non-empty after stripping, else LedgerError.
5. AMOUNT is parsed with ` + bt + `money.parse_amount` + bt + `. This is the ONLY place the
   conversion happens. A ValueError raised by it must be caught and re-raised as
   a LedgerError; a ValueError must never escape parse_line.
6. Return a dict ` + bt + `{"date": date, "desc": desc, "amount": cents, "tags": []}` + bt + `.
   The "tags" key is present and empty at this stage — it is not optional.

The LedgerError message is free text, but it must be a non-empty string; callers
record ` + bt + `str(exc)` + bt + ` and only assert that it is a string.

Continued in spec/02b_parse_lines.md, which specifies parse_lines.
`;

const SPEC_PARSING_B = String.raw`# Stage 2, part 2 — parsing.parse_lines

## parse_lines(lines) -> (txns, errors)

` + bt + `lines` + bt + ` is any iterable of strings — a list, or a file object. Return a
2-TUPLE (not a list of two elements, not a dict):

    txns    a list of txn dicts, in input order
    errors  a list of (lineno, message) 2-tuples

` + bt + `lineno` + bt + ` is 1-BASED and counts EVERY element of ` + bt + `lines` + bt + `, including the ones
that were skipped. So a bad line preceded by a comment and a blank line is
line 3, not line 1. ` + bt + `message` + bt + ` is ` + bt + `str(exc)` + bt + ` of the LedgerError.

SKIPPING — silently skip, recording no error, any line whose stripped form is
empty or starts with "#". A line that raises LedgerError is recorded in
` + bt + `errors` + bt + ` and is NOT added to ` + bt + `txns` + bt + `. Parsing continues after an error; one bad
line never aborts the run.
`;

const SPEC_RULES = String.raw`# Stage 3 — rules.py

A rules file maps descriptions to categories. It is a plain multi-line string,
NOT a path — the caller has already read the file.

## load_rules(text) -> list of Rule

Split ` + bt + `text` + bt + ` into lines. For each line:

  - Strip it. SKIP it, with no error, if it is empty or if it starts with ";".
    ";" is the rules-file comment character. "#" is NOT a comment here — stage 5
    gives "#" a meaning at the start of a pattern, so a line beginning with "#"
    is a real rule and must be parsed as one.
  - Split the stripped line on "=". There must be EXACTLY three parts. Two parts
    or four parts both raise ValueError.
  - Part 0 is the PATTERN, stripped. If it is empty, raise ValueError.
  - Part 1 is the CATEGORY, stripped. If it is empty, raise ValueError.
  - Part 2 is the PRIORITY, stripped, converted with ` + bt + `int()` + bt + `. A non-integer
    raises ValueError naturally and that is the behaviour we want — do not
    catch it and do not substitute a default. Priorities may be negative.

Return a list of ` + bt + `Rule` + bt + ` objects — the class is already defined in the stub, do
not redefine it — in FILE ORDER. File order is load-bearing: it is the
tie-breaker in ` + bt + `categorize` + bt + `.

## categorize(txn, rules) -> str

A rule MATCHES a txn when the rule's pattern, lower-cased, appears as a
SUBSTRING of the txn's "desc", lower-cased. Matching is therefore
case-insensitive and unanchored: pattern "shop" matches "Corner Shopping".
(Stage 5 adds a second, different pattern form. Until then this is the only one.)

Among ALL matching rules, pick the one with the HIGHEST ` + bt + `priority` + bt + `. If two or
more matching rules tie on priority, the one appearing EARLIER in the ` + bt + `rules` + bt + `
list wins. Return that rule's ` + bt + `category` + bt + ` string.

If no rule matches, return the literal string "uncategorized" — lower-case, and
never None and never an empty string.

` + bt + `rules` + bt + ` may be empty, in which case every txn is "uncategorized".
`;

const SPEC_REPORT = String.raw`# Stage 4 — report.py

## summarize(txns, rule_list) -> list of (category, total_cents, count)

Categorize every txn with ` + bt + `rules.categorize` + bt + `, passing ` + bt + `rule_list` + bt + ` through
unchanged, then group the txns by the returned category.

For each group, ` + bt + `total_cents` + bt + ` is the sum of that group's "amount" values and
` + bt + `count` + bt + ` is how many txns are in it. Return a list of 3-TUPLES — tuples, not
lists and not dicts — sorted by ` + bt + `total_cents` + bt + ` ASCENDING, so the most negative
category comes first. Ties on total are broken by category name ASCENDING using
plain ` + bt + `str` + bt + ` comparison, which is case-sensitive: "Zebra" sorts before "apple".

An empty ` + bt + `txns` + bt + ` gives an empty list.

## render_report(rows) -> str

` + bt + `rows` + bt + ` is exactly what ` + bt + `summarize` + bt + ` returns and is rendered IN THE ORDER GIVEN
— ` + bt + `render_report` + bt + ` never re-sorts. Build these lines and join them with "\n".
There is NO trailing newline. The column widths are exact and total 33:

  1. the header line:
         "CATEGORY".ljust(15) + "TOTAL".rjust(12) + "COUNT".rjust(6)
  2. a rule line:  "-" * 33
  3. one line per row, in order:
         category.ljust(15) + money.format_amount(total).rjust(12)
             + str(count).rjust(6)
  4. a SECOND rule line:  "-" * 33
  5. the grand-total line:
         "TOTAL".ljust(15) + money.format_amount(grand).rjust(12)
             + str(total_count).rjust(6)
     where ` + bt + `grand` + bt + ` is the sum of every row's total and ` + bt + `total_count` + bt + ` is the
     sum of every row's count.

Note that ` + bt + `ljust` + bt + ` and ` + bt + `rjust` + bt + ` do NOT truncate: a category name longer than 15
characters simply pushes the rest of its line right. That is correct — do not
truncate it, and do not switch to a format spec that would.

An EMPTY ` + bt + `rows` + bt + ` still produces FOUR lines: the header, both rule lines, and a
grand-total line reading "$0.00" with a count of 0.
`;

const SPEC_PHASE2 = String.raw`# Stage 5 (EXTENSION) — tags

Do this ONLY once stages 1-4 are implemented and their tests pass. This stage
CHANGES decisions made in stage 2 and stage 3. Re-read spec/02_parsing.md and
spec/03_rules.md if you need to — the rest of what they say still holds, and
this file states only the differences.

## parsing.py — an optional FOURTH field

A ledger line may now have THREE OR FOUR pipe-separated fields:

    DATE | DESCRIPTION | AMOUNT | TAGS

A field count of 3 or 4 is accepted. ANY other count is still a LedgerError, so
the check becomes a membership test, not an equality test.

TAGS is a comma-separated list. Split it on ",". Strip each element and
LOWER-CASE it. DROP empty elements, which is what makes a trailing comma
harmless. Preserve the order of the rest. Store the list under the key "tags".

A three-field line still yields ` + bt + `"tags": []` + bt + `. A four-field line whose tags field
is empty or is only commas and spaces also yields ` + bt + `[]` + bt + `.

    "2024-01-05 | Coffee | -4.50 | Food, DAILY ,"   ->   ["food", "daily"]
    "2024-01-05 | Coffee | -4.50 |   "              ->   []

## rules.py — TAG patterns

A rule pattern that STARTS WITH "#" is a TAG pattern rather than a description
substring. Take the text after the "#", strip it, lower-case it, and match it
against the txn's tags compared lower-cased. The match is EXACT — full-string
equality against one tag — and never a substring match. So pattern "#daily"
matches the tag "Daily" but NOT the tag "dailyish", and it does NOT match a
description containing the word "daily".

A tag pattern on a txn with no tags simply does not match.

Everything else about matching is unchanged: highest priority among matching
rules wins, ties go to the earlier rule, and no match returns "uncategorized".

Remember spec/00b_contracts.md: rules-file comments start with ";" and NOT with
"#". A rules line beginning with "#" is a TAG RULE, not a comment. If you
implemented "#" as a comment character in stage 3, fix it now.
`;

const SPEC_CLI = String.raw`# Stage 6 — cli.py

A thin command-line front end. It reads files, calls the modules you already
wrote, prints, and returns an EXIT CODE. It never raises for bad input and it
never calls ` + bt + `sys.exit` + bt + ` itself.

## main(argv) -> int

` + bt + `argv` + bt + ` is a list of arguments WITHOUT the program name, exactly what you would
pass to ` + bt + `parser.parse_args(argv)` + bt + `. Use ` + bt + `argparse` + bt + `. The grammar is:

    report [--strict] --ledger LEDGER --rules RULES

so: one positional command whose only accepted value is "report", a required
` + bt + `--ledger` + bt + ` path, a required ` + bt + `--rules` + bt + ` path, and an optional ` + bt + `--strict` + bt + ` flag
stored as a boolean.

Then, IN THIS ORDER:

1. Read the LEDGER file as text and the RULES file as text. If EITHER cannot be
   read, print ` + bt + `cannot read <path>` + bt + ` to STDERR and return 2. Use the path
   exactly as given. Catch ` + bt + `OSError` + bt + `; do not let it propagate.
2. Call ` + bt + `rules.load_rules` + bt + ` on the rules text. If it raises ValueError, print
   ` + bt + `rules error: <message>` + bt + ` to STDERR and return 2. Nothing goes to stdout.
3. Call ` + bt + `parsing.parse_lines` + bt + ` on the ledger text split with ` + bt + `splitlines()` + bt + `.
4. If ` + bt + `--strict` + bt + ` was given AND the errors list is non-empty, print one line
   per error to STDERR in the form ` + bt + `line <n>: <message>` + bt + `, in the order the
   errors were reported, and return 1. Print NOTHING to stdout — no report.
5. Otherwise print ` + bt + `report.render_report(report.summarize(txns, rules))` + bt + ` to
   STDOUT with a single ` + bt + `print()` + bt + `, which gives it exactly one trailing newline.
6. If there were errors and ` + bt + `--strict` + bt + ` was NOT given, additionally print
   ` + bt + `warning: <k> malformed line(s) skipped` + bt + ` to STDERR, where ` + bt + `<k>` + bt + ` is the
   number of errors. The report still goes to stdout and the exit code is still
   0 — a warning is not a failure.
7. Return 0.

Use ` + bt + `print(..., file=sys.stderr)` + bt + ` for stderr so the tests can capture it with
` + bt + `contextlib.redirect_stderr` + bt + `. A successful run with no malformed lines prints
the report to stdout and NOTHING AT ALL to stderr.
`;

const SPEC_EXAMPLES = String.raw`# Worked examples, part 1 — money.parse_amount (normative)

These tables are part of the specification. Where an example and your reading of
the prose disagree, the example wins. The format_amount and categorize tables
are in spec/07b_examples.md.

## money.parse_amount — accepted

    "5"             ->        500
    "42"            ->       4200
    "12.34"         ->       1234
    "0.5"           ->         50      one decimal is right-padded
    "0.07"          ->          7
    "0.7"           ->         70
    "$1,234.56"     ->     123456
    "$12,345.60"    ->    1234560
    "-3"            ->       -300
    "-$2.05"        ->       -205
    "-0.99"         ->        -99
    " -$0.01 "      ->         -1      outer whitespace is stripped
    "(12.50)"       ->      -1250      parentheses mean negative
    "($1,000)"      ->    -100000
    "($2,500.25)"   ->    -250025
    "  7.25  "      ->        725
    "-0.00"         ->          0      negative zero is zero

## money.parse_amount — must raise ValueError

    ""              empty after stripping
    "   "           empty after stripping
    "abc"           not a number
    "12a"           trailing garbage
    "1.234"         three decimal places
    "1..2"          two decimal points
    "5 5"           internal whitespace
    "+5"            leading plus is never accepted
    "(-5)"          sign inside parentheses
    "(+1)"          sign inside parentheses
    "$-5"           "$" must follow the sign, not precede it
    "1,23.00"       malformed thousands grouping
    "12,34"         malformed thousands grouping
    5               not a str
    None            not a str
`;

const SPEC_EXAMPLES_B = String.raw`# Worked examples, part 2 — format_amount and categorize (normative)

## money.format_amount

              0    ->  "$0.00"
              5    ->  "$0.05"
              7    ->  "$0.07"
             -7    ->  "-$0.07"
          -1250    ->  "-$12.50"
         123456    ->  "$1,234.56"
        1234560    ->  "$12,345.60"
        -250025    ->  "-$2,500.25"

## rules.categorize precedence, given this rules text

    ; a comment
    coffee=Food=10
    shop=Shopping=5
    #daily=Habit=20
    rent=Housing=50

    desc "COFFEE bar",  tags []         -> "Food"          case-insensitive
    desc "coffee shop", tags []         -> "Food"          10 beats 5
    desc "coffee shop", tags ["Daily"]  -> "Habit"         20 beats 10
    desc "daily grind", tags []         -> "uncategorized" tag rule, not desc
    desc "mystery",     tags ["dailyish"] -> "uncategorized" exact tag only
    desc "mystery",     tags []         -> "uncategorized"
`;

const STUB_MONEY = String.raw`"""Money parsing and formatting — integer cents only.

This stub fixes the public names and signatures. It does NOT describe the
behaviour; spec/01_money.md is authoritative and spec/07_examples.md holds the
normative example table. Read both before implementing.

Dependency rule (see spec/00_conventions.md): this module imports nothing from
the project. It is the bottom of the dependency order, so parsing.py and
report.py may import it but it may import neither of them.

Never use float. Every value that represents money in this project is a signed
integer number of cents, so that summing a column of amounts is exact and the
rendered report never shows a rounding artefact.

What this module must NOT do: read files, know about ledger lines or rules, or
raise LedgerError — that type belongs to parsing.py, and this module is below it
in the dependency order. The only exception type it raises is ValueError.
"""


def parse_amount(s):
    """Parse a money string into signed integer cents.

    The parsing rules are ORDERED and the order is load-bearing; see
    spec/01_money.md. The accepted and rejected tables in spec/07_examples.md
    are normative and settle every edge case, including the ones the prose
    leaves implicit.

    Returns a signed int number of cents. Raises ValueError on anything the
    spec does not accept, including a non-str argument.
    """
    raise NotImplementedError("parse_amount")


def format_amount(cents):
    """Format signed integer cents as a currency string.

    See spec/01b_money_format.md, with the worked table in spec/07b_examples.md.
    Thousands separators, exactly two decimal places, a leading "$", and the
    minus sign placed BEFORE the "$" for negatives.

    This is the only place in the project where money becomes text; report.py
    calls it rather than formatting amounts itself, so the fixed-width columns
    in stage 4 depend on this being exactly right.
    """
    raise NotImplementedError("format_amount")
`;

const STUB_PARSING = String.raw`"""Ledger line parsing.

This stub fixes the public names and signatures only. spec/02_parsing.md is
authoritative for stage 2, and spec/05_phase2_tags.md amends it in stage 5 by
adding an optional fourth field. Read the stage 2 spec now and the stage 5 spec
later; do not implement the fourth field before stage 5.

Dependency rule (see spec/00_conventions.md): this module may import money and
nothing else from the project.

Error contract: this module raises LedgerError, never ValueError. The ValueError
money.parse_amount raises must be caught here and converted — see
spec/00b_contracts.md.

Note the asymmetry: parse_line RAISES on a bad line, while parse_lines never
raises and instead COLLECTS what went wrong — one bad line must never abort a
batch run.
"""

import money


class LedgerError(Exception):
    """Raised for any malformed ledger line.

    The message is free text but must be a non-empty string; parse_lines
    records str(exc) for each failing line and callers print it.
    """


def parse_line(line):
    """Parse one ledger line into a txn dict.

    See spec/02_parsing.md, amended by spec/05_phase2_tags.md, which adds an
    optional fourth field. Returns a dict with exactly the keys "date", "desc",
    "amount" and "tags" — all four always present, "tags" empty rather than
    absent when the line carries none.

    Raises LedgerError for a malformed line: a bad field count, a wrongly
    shaped or unreal date, an empty description, or a rejected amount.
    """
    raise NotImplementedError("parse_line")


def parse_lines(lines):
    """Parse an iterable of lines into (txns, errors).

    See spec/02b_parse_lines.md. Returns a 2-TUPLE, not a list of two things.
    Comment and blank lines are skipped silently; malformed lines become
    (lineno, message) pairs with a 1-based lineno that counts skipped lines
    too, so it matches what a text editor would show.
    """
    raise NotImplementedError("parse_lines")
`;

const STUB_RULES = String.raw`"""Categorization rules.

This stub fixes the public names and signatures only. spec/03_rules.md is
authoritative for stage 3, and spec/05_phase2_tags.md amends it in stage 5 by
giving patterns that begin with "#" a tag-matching meaning.

Dependency rule (see spec/00_conventions.md): this module imports nothing from
the project.

Comment character: a rules-file comment line starts with ";". A line starting
with "#" is NOT a comment here — see spec/00b_contracts.md.
"""


class Rule:
    """A single categorization rule. Do not redefine or subclass this."""

    def __init__(self, pattern, category, priority):
        self.pattern = pattern
        self.category = category
        self.priority = priority

    def __repr__(self):
        return "Rule(%r, %r, %r)" % (self.pattern, self.category, self.priority)


def load_rules(text):
    """Parse rules TEXT (not a path) into a list of Rule, in file order.

    See spec/03_rules.md. The argument is the CONTENT of a rules file, so this
    function never opens anything. File order is load-bearing: it is the
    tie-breaker categorize() uses when matching rules have equal priority.

    Raises ValueError for a malformed rule line: not exactly three "="-separated
    parts, an empty pattern, an empty category, or a non-integer priority.
    """
    raise NotImplementedError("load_rules")


def categorize(txn, rules):
    """Return the category string for one txn.

    See spec/03_rules.md, amended by spec/05_phase2_tags.md, which gives a
    pattern beginning with "#" a tag-matching meaning.

    Selection among matching rules: highest priority wins; ties go to the rule
    earlier in the list; nothing matching gives the literal "uncategorized".
    An empty rules list is legal. This function must not mutate its arguments.
    """
    raise NotImplementedError("categorize")
`;

const STUB_REPORT = String.raw`"""Aggregation and fixed-width rendering.

This stub fixes the public names and signatures only. spec/04_report.md is
authoritative, including the exact column widths, which are asserted
character-for-character by the tests.

Dependency rule (see spec/00_conventions.md): this module may import money and
rules, and must not import parsing or cli.

The division of labour between the two functions is strict. summarize decides
WHAT is in the table and in WHAT ORDER. render_report decides only how it LOOKS,
and renders whatever order it is handed — it never sorts, never filters, and
never drops a row. Tests exercise it with deliberately out-of-order rows.

This module formats no money itself: every amount goes through
money.format_amount.
"""

import money
import rules


def summarize(txns, rule_list):
    """Group txns by category into [(category, total_cents, count)].

    See spec/04_report.md. Each txn is categorized with rules.categorize, then
    grouped; total_cents is the sum of the group's amounts and count is the
    size of the group.

    Returns a list of 3-TUPLES sorted by total ascending — most negative first
    — with ties broken by category name ascending using plain str comparison,
    which is case-sensitive. An empty txns list gives an empty list.
    """
    raise NotImplementedError("summarize")


def render_report(rows):
    """Render summarize() output as a fixed-width text table.

    See spec/04_report.md for the exact layout, which the tests assert
    character for character: a header, a rule line, one line per row in the
    order given, a second rule line, then a grand-total line. Joined with
    newlines, with NO trailing newline.

    The three columns are 15, 12 and 6 characters wide, ljust then rjust then
    rjust, totalling 33 — which is also the length of each rule line. An empty
    rows list still renders four lines.
    """
    raise NotImplementedError("render_report")
`;

const STUB_CLI = String.raw`"""Command-line front end.

This stub fixes the public name and signature only. spec/06_cli.md is
authoritative for the argument grammar, the ordered behaviour, the exact
message texts and the exit codes.

Dependency rule (see spec/00_conventions.md): this module may import parsing,
rules and report.

Contract: main() returns an int exit code and never calls sys.exit itself, so
the tests can call it directly and capture stdout and stderr with
contextlib.redirect_stdout / redirect_stderr. Print to stderr with
print(..., file=sys.stderr) — a logging handler would bypass the capture.

This module contains no business logic. It reads two files, hands their text to
parsing and rules, hands the result to report, prints, and picks an exit code.
Anything more interesting than that belongs in one of the other modules, and
the ORDER of the steps is specified because the tests distinguish, for example,
an unreadable rules file (exit 2, "cannot read") from an unparseable one
(exit 2, "rules error: ").

The stream discipline matters: the report goes to STDOUT and every diagnostic —
errors and warnings alike — goes to STDERR, so a successful run with clean
input writes nothing at all to stderr.
"""

import sys

import parsing
import rules
import report


def main(argv):
    """Run the CLI over argv (WITHOUT the program name) and return an exit code.

    See spec/06_cli.md for the argument grammar, the ordered behaviour, the
    exact message texts and the exit codes:

        0  success — the report was printed
        1  --strict was given and the ledger had malformed lines
        2  an input file could not be read, or the rules file was malformed
    """
    raise NotImplementedError("main")
`;

const VISIBLE_TESTS = String.raw`"""Visible test suite. Run: python3 -m unittest test_ledger -v"""

import contextlib
import io
import os
import tempfile
import unittest

import money
import parsing
import rules
import report
import cli

RULES_TEXT = """; visible rules file
coffee=Food=10
shop=Shopping=5
#daily=Habit=20
rent=Housing=50
"""

SAMPLE = [
    "# a sample ledger",
    "2024-01-01 | Coffee Bar | -4.50 | daily",
    "2024-01-02 | Rent March | -1,200.00",
    "2024-01-03 | Coffee Bar | -3.25 | daily",
    "2024-01-04 | Paycheck | 2,000.00",
    "2024-01-05 | Corner Shop | -20.00",
]


def row(category, amount_text, count):
    return category.ljust(15) + amount_text.rjust(12) + str(count).rjust(6)


class TestMoney(unittest.TestCase):
    def test_plain_integer(self):
        self.assertEqual(money.parse_amount("5"), 500)

    def test_two_decimals(self):
        self.assertEqual(money.parse_amount("12.34"), 1234)

    def test_one_decimal_is_padded(self):
        self.assertEqual(money.parse_amount("0.5"), 50)

    def test_dollar_and_commas(self):
        self.assertEqual(money.parse_amount("$1,234.56"), 123456)

    def test_leading_minus(self):
        self.assertEqual(money.parse_amount("-3"), -300)

    def test_minus_then_dollar(self):
        self.assertEqual(money.parse_amount("-$2.05"), -205)

    def test_parentheses(self):
        self.assertEqual(money.parse_amount("(12.50)"), -1250)

    def test_parentheses_dollar_commas(self):
        self.assertEqual(money.parse_amount("($1,000)"), -100000)

    def test_surrounding_whitespace(self):
        self.assertEqual(money.parse_amount("  7.25  "), 725)

    def test_negative_zero(self):
        self.assertEqual(money.parse_amount("-0.00"), 0)

    def test_bad_empty(self):
        self.assertRaises(ValueError, money.parse_amount, "")

    def test_bad_three_decimals(self):
        self.assertRaises(ValueError, money.parse_amount, "1.234")

    def test_bad_letters(self):
        self.assertRaises(ValueError, money.parse_amount, "12a")

    def test_bad_inner_sign(self):
        self.assertRaises(ValueError, money.parse_amount, "(-5)")

    def test_bad_dollar_before_sign(self):
        self.assertRaises(ValueError, money.parse_amount, "$-5")

    def test_bad_comma_grouping(self):
        self.assertRaises(ValueError, money.parse_amount, "1,23.00")

    def test_bad_leading_plus(self):
        self.assertRaises(ValueError, money.parse_amount, "+5")

    def test_bad_internal_space(self):
        self.assertRaises(ValueError, money.parse_amount, "5 5")

    def test_bad_non_string(self):
        self.assertRaises(ValueError, money.parse_amount, 5)

    def test_format_positive(self):
        self.assertEqual(money.format_amount(123456), "$1,234.56")

    def test_format_negative(self):
        self.assertEqual(money.format_amount(-1250), "-$12.50")

    def test_format_zero(self):
        self.assertEqual(money.format_amount(0), "$0.00")

    def test_format_sub_dime(self):
        self.assertEqual(money.format_amount(5), "$0.05")


class TestParsing(unittest.TestCase):
    def test_basic_line(self):
        t = parsing.parse_line("2024-01-05 | Coffee Shop | -4.50")
        self.assertEqual(t["date"], "2024-01-05")
        self.assertEqual(t["desc"], "Coffee Shop")
        self.assertEqual(t["amount"], -450)
        self.assertEqual(t["tags"], [])

    def test_bad_field_count(self):
        self.assertRaises(parsing.LedgerError, parsing.parse_line, "2024-01-05 | Coffee")

    def test_bad_date_shape(self):
        self.assertRaises(parsing.LedgerError, parsing.parse_line, "01/05/2024 | Coffee | 1.00")

    def test_bad_date_compact(self):
        self.assertRaises(parsing.LedgerError, parsing.parse_line, "20240105 | Coffee | 1.00")

    def test_bad_date_value(self):
        self.assertRaises(parsing.LedgerError, parsing.parse_line, "2024-13-01 | Coffee | 1.00")

    def test_empty_description(self):
        self.assertRaises(parsing.LedgerError, parsing.parse_line, "2024-01-05 |    | 1.00")

    def test_bad_amount_becomes_ledger_error(self):
        self.assertRaises(parsing.LedgerError, parsing.parse_line, "2024-01-05 | Coffee | abc")

    def test_parse_lines_returns_tuple(self):
        result = parsing.parse_lines([])
        self.assertIsInstance(result, tuple)
        self.assertEqual(len(result), 2)

    def test_parse_lines_skips_blank_and_hash(self):
        lines = ["# comment", "", "2024-01-05 | A | 1.00", "   ", "2024-01-06 | B | 2.00"]
        txns, errors = parsing.parse_lines(lines)
        self.assertEqual(len(txns), 2)
        self.assertEqual(errors, [])

    def test_parse_lines_records_line_numbers(self):
        lines = ["2024-01-05 | A | 1.00", "bogus", "2024-99-01 | C | 1.00"]
        txns, errors = parsing.parse_lines(lines)
        self.assertEqual(len(txns), 1)
        self.assertEqual([e[0] for e in errors], [2, 3])
        self.assertTrue(all(isinstance(e[1], str) and e[1] for e in errors))


class TestRules(unittest.TestCase):
    def setUp(self):
        self.rules = rules.load_rules(RULES_TEXT)

    def test_load_skips_semicolon_comment(self):
        self.assertEqual(len(self.rules), 4)

    def test_load_fields(self):
        self.assertEqual(self.rules[0].pattern, "coffee")
        self.assertEqual(self.rules[0].category, "Food")
        self.assertEqual(self.rules[0].priority, 10)

    def test_substring_case_insensitive(self):
        t = {"date": "2024-01-01", "desc": "COFFEE bar", "amount": -100, "tags": []}
        self.assertEqual(rules.categorize(t, self.rules), "Food")

    def test_highest_priority_wins(self):
        t = {"date": "2024-01-01", "desc": "coffee shop", "amount": -100, "tags": []}
        self.assertEqual(rules.categorize(t, self.rules), "Food")

    def test_no_match(self):
        t = {"date": "2024-01-01", "desc": "mystery thing", "amount": -100, "tags": []}
        self.assertEqual(rules.categorize(t, self.rules), "uncategorized")

    def test_empty_rule_list(self):
        t = {"date": "2024-01-01", "desc": "coffee", "amount": -100, "tags": []}
        self.assertEqual(rules.categorize(t, []), "uncategorized")

    def test_tie_goes_to_earlier_rule(self):
        rs = rules.load_rules("aa=First=1\nbb=Second=1\n")
        t = {"date": "2024-01-01", "desc": "aa bb", "amount": -100, "tags": []}
        self.assertEqual(rules.categorize(t, rs), "First")

    def test_negative_priority(self):
        rs = rules.load_rules("aa=Low=-5\naa=High=0\n")
        t = {"date": "2024-01-01", "desc": "aa", "amount": -100, "tags": []}
        self.assertEqual(rules.categorize(t, rs), "High")

    def test_bad_rule_line(self):
        self.assertRaises(ValueError, rules.load_rules, "onlytwo=Fields\n")

    def test_bad_priority(self):
        self.assertRaises(ValueError, rules.load_rules, "a=B=high\n")

    def test_empty_pattern(self):
        self.assertRaises(ValueError, rules.load_rules, "  =B=1\n")


class TestReport(unittest.TestCase):
    def setUp(self):
        self.txns, self.errors = parsing.parse_lines(SAMPLE)
        self.rules = rules.load_rules(RULES_TEXT)

    def test_sample_parses_clean(self):
        self.assertEqual(self.errors, [])
        self.assertEqual(len(self.txns), 5)

    def test_summarize(self):
        rows = report.summarize(self.txns, self.rules)
        self.assertEqual(
            rows,
            [
                ("Housing", -120000, 1),
                ("Shopping", -2000, 1),
                ("Habit", -775, 2),
                ("uncategorized", 200000, 1),
            ],
        )

    def test_summarize_empty(self):
        self.assertEqual(report.summarize([], self.rules), [])

    def test_render(self):
        rows = [("Housing", -120000, 1), ("uncategorized", 200000, 1)]
        expected = "\n".join([
            "CATEGORY".ljust(15) + "TOTAL".rjust(12) + "COUNT".rjust(6),
            "-" * 33,
            row("Housing", "-$1,200.00", 1),
            row("uncategorized", "$2,000.00", 1),
            "-" * 33,
            row("TOTAL", "$800.00", 2),
        ])
        self.assertEqual(report.render_report(rows), expected)

    def test_render_does_not_resort(self):
        rows = [("uncategorized", 200000, 1), ("Housing", -120000, 1)]
        out = report.render_report(rows).split("\n")
        self.assertTrue(out[2].startswith("uncategorized"))
        self.assertTrue(out[3].startswith("Housing"))

    def test_render_empty(self):
        out = report.render_report([])
        lines = out.split("\n")
        self.assertEqual(len(lines), 4)
        self.assertEqual(lines[-1], row("TOTAL", "$0.00", 0))


class TestPhase2(unittest.TestCase):
    def test_tags_parsed(self):
        t = parsing.parse_line("2024-01-05 | Coffee | -4.50 | Food, DAILY ,")
        self.assertEqual(t["tags"], ["food", "daily"])

    def test_empty_tags_field(self):
        t = parsing.parse_line("2024-01-05 | Coffee | -4.50 |   ")
        self.assertEqual(t["tags"], [])

    def test_three_fields_still_empty_tags(self):
        t = parsing.parse_line("2024-01-05 | Coffee | -4.50")
        self.assertEqual(t["tags"], [])

    def test_five_fields_still_error(self):
        self.assertRaises(parsing.LedgerError, parsing.parse_line, "a|b|c|d|e")

    def test_tag_rule_matches_exactly(self):
        rs = rules.load_rules(RULES_TEXT)
        t = {"date": "2024-01-01", "desc": "coffee shop", "amount": -100, "tags": ["Daily"]}
        self.assertEqual(rules.categorize(t, rs), "Habit")

    def test_tag_rule_is_not_substring(self):
        rs = rules.load_rules(RULES_TEXT)
        t = {"date": "2024-01-01", "desc": "mystery", "amount": -100, "tags": ["dailyish"]}
        self.assertEqual(rules.categorize(t, rs), "uncategorized")

    def test_tag_rule_does_not_match_description(self):
        rs = rules.load_rules(RULES_TEXT)
        t = {"date": "2024-01-01", "desc": "daily grind", "amount": -100, "tags": []}
        self.assertEqual(rules.categorize(t, rs), "uncategorized")


class TestCli(unittest.TestCase):
    def _write(self, ledger_text, rules_text):
        d = tempfile.mkdtemp()
        lp = os.path.join(d, "ledger.txt")
        rp = os.path.join(d, "rules.txt")
        with open(lp, "w") as fh:
            fh.write(ledger_text)
        with open(rp, "w") as fh:
            fh.write(rules_text)
        return lp, rp

    def _run(self, args):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = cli.main(args)
        return code, out.getvalue(), err.getvalue()

    def test_report_ok(self):
        lp, rp = self._write("\n".join(SAMPLE) + "\n", RULES_TEXT)
        code, out, err = self._run(["report", "--ledger", lp, "--rules", rp])
        self.assertEqual(code, 0)
        self.assertEqual(err, "")
        txns, _ = parsing.parse_lines(SAMPLE)
        rs = rules.load_rules(RULES_TEXT)
        self.assertEqual(out, report.render_report(report.summarize(txns, rs)) + "\n")

    def test_strict_reports_errors_and_exits_1(self):
        lp, rp = self._write("2024-01-01 | A | 1.00\nbogus\n", RULES_TEXT)
        code, out, err = self._run(["report", "--strict", "--ledger", lp, "--rules", rp])
        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        self.assertTrue(err.startswith("line 2: "), err)

    def test_warning_without_strict(self):
        lp, rp = self._write("2024-01-01 | A | 1.00\nbogus\n", RULES_TEXT)
        code, out, err = self._run(["report", "--ledger", lp, "--rules", rp])
        self.assertEqual(code, 0)
        self.assertIn("warning: 1 malformed line(s) skipped", err)
        self.assertTrue(out.startswith("CATEGORY"))

    def test_bad_rules_file(self):
        lp, rp = self._write("2024-01-01 | A | 1.00\n", "broken rule line\n")
        code, out, err = self._run(["report", "--ledger", lp, "--rules", rp])
        self.assertEqual(code, 2)
        self.assertEqual(out, "")
        self.assertTrue(err.startswith("rules error: "), err)

    def test_missing_ledger_file(self):
        _, rp = self._write("", RULES_TEXT)
        missing = os.path.join(tempfile.mkdtemp(), "nope.txt")
        code, out, err = self._run(["report", "--ledger", missing, "--rules", rp])
        self.assertEqual(code, 2)
        self.assertIn("cannot read " + missing, err)


if __name__ == "__main__":
    unittest.main()
`;

// ───────────────────────────── hidden grading suite ─────────────────────────
// Same SPECIFIED behaviour, different data. Never shown to the agent.

const HIDDEN_TESTS = String.raw`"""HELD-OUT grading suite (never shown to the agent)."""

import contextlib
import io
import os
import tempfile
import unittest

import money
import parsing
import rules
import report
import cli

HID_RULES = """; held-out rules
market=Groceries=10
gas=Auto=5
#work=Business=30
salary=Income=1
"""

HID_LINES = [
    "# held-out sample",
    "2023-06-01 | Corner Market | -35.20 | weekly",
    "2023-06-02 | Gas Station | (45.00) | Work",
    "2023-06-03 | Salary June | $3,000 ",
    "",
    "2023-06-04 | Corner Market | -$4.80 | WEEKLY,",
    "2023-06-05 | Odd Thing | 1.5",
    "2023-13-01 | Bad Date | 1.00",
]


def row(category, amount_text, count):
    return category.ljust(15) + amount_text.rjust(12) + str(count).rjust(6)


class HMoney(unittest.TestCase):
    def test_values(self):
        self.assertEqual(money.parse_amount("42"), 4200)
        self.assertEqual(money.parse_amount("0.07"), 7)
        self.assertEqual(money.parse_amount("0.7"), 70)
        self.assertEqual(money.parse_amount("$12,345.60"), 1234560)
        self.assertEqual(money.parse_amount("-0.99"), -99)
        self.assertEqual(money.parse_amount("($2,500.25)"), -250025)
        self.assertEqual(money.parse_amount(" -$0.01 "), -1)
        self.assertEqual(money.parse_amount("-0.00"), 0)

    def test_rejects(self):
        for bad in ["", "   ", "abc", "1.2345", "(+1)", "(-1)", "$-1", "12,34", "+7", "1..2", "5 5"]:
            with self.subTest(bad=bad):
                self.assertRaises(ValueError, money.parse_amount, bad)

    def test_non_string(self):
        self.assertRaises(ValueError, money.parse_amount, None)

    def test_format(self):
        self.assertEqual(money.format_amount(0), "$0.00")
        self.assertEqual(money.format_amount(7), "$0.07")
        self.assertEqual(money.format_amount(-7), "-$0.07")
        self.assertEqual(money.format_amount(1234560), "$12,345.60")
        self.assertEqual(money.format_amount(-250025), "-$2,500.25")


class HParsing(unittest.TestCase):
    def test_line(self):
        t = parsing.parse_line(" 2023-06-02 | Gas Station | (45.00) ")
        self.assertEqual(t, {"date": "2023-06-02", "desc": "Gas Station", "amount": -4500, "tags": []})

    def test_errors(self):
        for bad in [
            "2023-06-02 | Gas Station",
            "2023-6-2 | Gas | 1.00",
            "20230602 | Gas | 1.00",
            "2023-02-30 | Gas | 1.00",
            "2023-06-02 |  | 1.00",
            "2023-06-02 | Gas | nope",
            "a|b|c|d|e",
        ]:
            with self.subTest(bad=bad):
                self.assertRaises(parsing.LedgerError, parsing.parse_line, bad)

    def test_parse_lines(self):
        txns, errors = parsing.parse_lines(HID_LINES)
        self.assertEqual(len(txns), 5)
        self.assertEqual([e[0] for e in errors], [8])
        self.assertIsInstance(errors[0][1], str)
        self.assertEqual(txns[0]["amount"], -3520)
        self.assertEqual(txns[1]["tags"], ["work"])
        self.assertEqual(txns[3]["tags"], ["weekly"])


class HRules(unittest.TestCase):
    def setUp(self):
        self.rs = rules.load_rules(HID_RULES)

    def test_loaded(self):
        self.assertEqual(len(self.rs), 4)
        self.assertEqual([r.pattern for r in self.rs], ["market", "gas", "#work", "salary"])
        self.assertEqual(self.rs[2].priority, 30)

    def test_bad(self):
        for bad in ["a=b", "a=b=c=d", "a=b=x", "=b=1", "a= =1"]:
            with self.subTest(bad=bad):
                self.assertRaises(ValueError, rules.load_rules, bad + "\n")

    def test_match(self):
        t = {"date": "2023-06-01", "desc": "CORNER MARKET", "amount": -1, "tags": []}
        self.assertEqual(rules.categorize(t, self.rs), "Groceries")

    def test_tag_beats_substring(self):
        t = {"date": "2023-06-02", "desc": "Gas Station", "amount": -1, "tags": ["Work"]}
        self.assertEqual(rules.categorize(t, self.rs), "Business")

    def test_tag_exact_only(self):
        t = {"date": "2023-06-02", "desc": "nothing", "amount": -1, "tags": ["workday"]}
        self.assertEqual(rules.categorize(t, self.rs), "uncategorized")

    def test_tie_earlier_wins(self):
        rs = rules.load_rules("zz=Late=3\n;c\nqq=Early=3\n")
        t = {"date": "2023-06-02", "desc": "qq zz", "amount": -1, "tags": []}
        self.assertEqual(rules.categorize(t, rs), "Late")

    def test_empty_rules(self):
        t = {"date": "2023-06-05", "desc": "anything", "amount": 1, "tags": ["work"]}
        self.assertEqual(rules.categorize(t, []), "uncategorized")


class HReport(unittest.TestCase):
    def setUp(self):
        self.txns, _ = parsing.parse_lines(HID_LINES)
        self.rs = rules.load_rules(HID_RULES)

    def test_summarize(self):
        rows = report.summarize(self.txns, self.rs)
        self.assertEqual(
            rows,
            [
                ("Business", -4500, 1),
                ("Groceries", -4000, 2),
                ("uncategorized", 150, 1),
                ("Income", 300000, 1),
            ],
        )

    def test_render(self):
        rows = [("Auto", -4500, 2), ("Income", 300000, 1)]
        expected = "\n".join([
            "CATEGORY".ljust(15) + "TOTAL".rjust(12) + "COUNT".rjust(6),
            "-" * 33,
            row("Auto", "-$45.00", 2),
            row("Income", "$3,000.00", 1),
            "-" * 33,
            row("TOTAL", "$2,955.00", 3),
        ])
        self.assertEqual(report.render_report(rows), expected)

    def test_render_preserves_order(self):
        rows = [("Income", 300000, 1), ("Auto", -4500, 2)]
        lines = report.render_report(rows).split("\n")
        self.assertTrue(lines[2].startswith("Income"))
        self.assertTrue(lines[3].startswith("Auto"))

    def test_render_empty(self):
        lines = report.render_report([]).split("\n")
        self.assertEqual(len(lines), 4)
        self.assertEqual(lines[1], "-" * 33)
        self.assertEqual(lines[2], "-" * 33)
        self.assertEqual(lines[3], row("TOTAL", "$0.00", 0))


class HCli(unittest.TestCase):
    def _write(self, ledger_text, rules_text):
        d = tempfile.mkdtemp()
        lp = os.path.join(d, "led.txt")
        rp = os.path.join(d, "rul.txt")
        with open(lp, "w") as fh:
            fh.write(ledger_text)
        with open(rp, "w") as fh:
            fh.write(rules_text)
        return lp, rp

    def _run(self, args):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = cli.main(args)
        return code, out.getvalue(), err.getvalue()

    def test_ok(self):
        lp, rp = self._write("\n".join(HID_LINES[:4]) + "\n", HID_RULES)
        code, out, err = self._run(["report", "--ledger", lp, "--rules", rp])
        self.assertEqual(code, 0)
        self.assertEqual(err, "")
        txns, _ = parsing.parse_lines(HID_LINES[:4])
        rs = rules.load_rules(HID_RULES)
        self.assertEqual(out, report.render_report(report.summarize(txns, rs)) + "\n")

    def test_strict(self):
        lp, rp = self._write("\n".join(HID_LINES) + "\n", HID_RULES)
        code, out, err = self._run(["report", "--strict", "--ledger", lp, "--rules", rp])
        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        self.assertTrue(err.startswith("line 8: "), err)

    def test_warning(self):
        lp, rp = self._write("\n".join(HID_LINES) + "\n", HID_RULES)
        code, out, err = self._run(["report", "--ledger", lp, "--rules", rp])
        self.assertEqual(code, 0)
        self.assertIn("warning: 1 malformed line(s) skipped", err)
        self.assertTrue(out.startswith("CATEGORY"))

    def test_rules_error(self):
        lp, rp = self._write("2023-06-01 | A | 1.00\n", "this is not a rule\n")
        code, out, err = self._run(["report", "--ledger", lp, "--rules", rp])
        self.assertEqual(code, 2)
        self.assertEqual(out, "")
        self.assertTrue(err.startswith("rules error: "), err)

    def test_missing_rules_file(self):
        lp, _ = self._write("2023-06-01 | A | 1.00\n", HID_RULES)
        missing = os.path.join(tempfile.mkdtemp(), "gone.txt")
        code, out, err = self._run(["report", "--ledger", lp, "--rules", missing])
        self.assertEqual(code, 2)
        self.assertIn("cannot read " + missing, err)


if __name__ == "__main__":
    unittest.main()
`;

const SEED_FILES = {
  'README.md': README,
  'spec/00_conventions.md': CONVENTIONS,
  'spec/00b_contracts.md': CONTRACTS,
  'spec/01_money.md': SPEC_MONEY,
  'spec/01b_money_format.md': SPEC_MONEY_B,
  'spec/02_parsing.md': SPEC_PARSING,
  'spec/02b_parse_lines.md': SPEC_PARSING_B,
  'spec/03_rules.md': SPEC_RULES,
  'spec/04_report.md': SPEC_REPORT,
  'spec/05_phase2_tags.md': SPEC_PHASE2,
  'spec/06_cli.md': SPEC_CLI,
  'spec/07_examples.md': SPEC_EXAMPLES,
  'spec/07b_examples.md': SPEC_EXAMPLES_B,
  'money.py': STUB_MONEY,
  'parsing.py': STUB_PARSING,
  'rules.py': STUB_RULES,
  'report.py': STUB_REPORT,
  'cli.py': STUB_CLI,
  'test_ledger.py': VISIBLE_TESTS,
  'NOTES.md': '# Working notes\n',
};

export default {
  name: 'longbuild(ledger, 6 stages, stdlib unittest)',
  system:
    'You are a coding agent working in a Python workspace. Use the tools to read files, write files and run commands. ' +
    'Work step by step and verify with the test suite after every change — do not assume an edit worked. ' +
    'Only the Python 3 standard library is available (no pip, no network, no pytest); use `python3 -m unittest`. ' +
    'The written specification is authoritative: read the spec file for a stage before you implement that stage. ' +
    'When the whole visible suite passes, reply with a short message containing DONE and no tool call.',
  task:
    'Implement the `ledger` toolkit in this workspace from its written specification.\n\n' +
    '1. Read README.md, then spec/00_conventions.md and spec/00b_contracts.md.\n' +
    '2. Then, one stage at a time, read that stage\'s spec file(s) and implement its module: ' +
    'spec/01_money.md + spec/01b_money_format.md -> money.py, ' +
    'spec/02_parsing.md + spec/02b_parse_lines.md -> parsing.py, ' +
    'spec/03_rules.md -> rules.py, spec/04_report.md -> report.py.\n' +
    '3. After each stage run `python3 -m unittest test_ledger -v` (or a single test class while ' +
    'iterating) and fix whatever fails before moving on.\n' +
    '4. When stages 1-4 pass, read spec/05_phase2_tags.md and apply the PHASE 2 extension, which ' +
    'changes parsing.py and rules.py.\n' +
    '5. Then read spec/06_cli.md and implement cli.py.\n' +
    '6. spec/07_examples.md and spec/07b_examples.md hold the normative worked-example tables; ' +
    'consult them rather than guessing an edge case.\n' +
    '7. Several specs are split in two — where a file ends with a "continued in" pointer, read the ' +
    'continuation as well.\n' +
    '8. Append one line to NOTES.md after each stage recording the decision you made.\n' +
    '9. When the whole suite passes, write SUMMARY.md with one short section per stage, as README.md ' +
    'describes.\n\n' +
    'Grading uses a held-out suite over the same specified behaviour on different data, so implement ' +
    'the spec rather than special-casing the visible tests. When every test in test_ledger.py passes ' +
    'and SUMMARY.md is written, reply with a short message containing DONE and no tool call.',

  seed(ws) {
    for (const [rel, content] of Object.entries(SEED_FILES)) {
      const p = join(ws, rel);
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, content);
    }
  },

  grade(ws) {
    try {
      writeFileSync(join(ws, 'hidden_grade_test.py'), HIDDEN_TESTS);
      const out = execSync('python3 -m unittest hidden_grade_test 2>&1', {
        cwd: ws, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
      });
      const m = out.match(/Ran\s+(\d+)\s+test/);
      return /^OK\b/m.test(out) && !!m && +m[1] > 0;
    } catch {
      return false; // non-zero exit (failures/errors) or timeout
    }
  },
};
