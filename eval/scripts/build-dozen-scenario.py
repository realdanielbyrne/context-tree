#!/usr/bin/env python3
"""Self-verifying generator for sw-5-dozen (the long-horizon >200KB-trace task).

The existing long-task scenarios (sw-1..sw-4) all produce agent traces under
~60KB of raw text, so the context-tree's summarization machinery never
engages: the lazy-tokens threshold (EVAL_LAZY_TOKENS, §loop.ts) is a 4
chars/token heuristic, so 30k tokens == 120KB of rendered trace, and nothing
in the diverse suite comes close. This scenario forces a much bigger trace by
scaling the sw-2-multimod pattern (many independent modules, each requiring
its own read -> diagnose -> fix -> verify cycle) up from 4 modules to TWELVE,
each with a generously documented contract (so every read is substantial) and
exactly one subtle, independent bug.

Same self-verification contract as build-multimod-scenario.py, strengthened:
  - every one of the 12 shipped (buggy) modules must fail at least one of its
    OWN hidden tests when run together;
  - bug INDEPENDENCE is checked directly, not just inferred: for each module
    M, a mix of "only M buggy, the other 11 fixed" must fail exactly M's
    tests and pass every other module's tests — proving fixing one module
    can't accidentally fix (or break) another;
  - the full reference (all 12 fixed) must pass every hidden test;
  - smoke.py (shipped, visible) must fail before any fix and print
    "ALL 12 OK" only once every module is fixed;
  - total shipped+hidden content must exceed 60,000 characters.
Only after all of that passes does the row get upserted into the
scenarios-long JSONL (append-or-replace by id, rows sorted by id, so re-runs
of the two scenarios-long builders in either order are byte-identical).
"""

import json
import pathlib
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
JSONL = (
    HERE.parent
    / "scenarios-long"
    / "deepswe-agents-last-exam"
    / "agents-last-exam.jsonl"
)

MODULE_NAMES = (
    "wordfreq",
    "roman",
    "rle",
    "baseconv",
    "ipv4",
    "matrix",
    "template",
    "csvline",
    "caesar",
    "intervals",
    "pathnorm",
    "versioncmp",
)

# ------------------------------------------------------------- buggy modules

BUGGY_WORDFREQ = '''\
"""wordfreq.py — word frequency counting.

Contract:
- top_n(text, n) -> list[tuple[str, int]]: the n most frequent words in
  `text`, returned as (word, count) pairs.
- A "word" is a maximal run of ASCII letters and/or digits (regex
  [A-Za-z0-9]+); matching is case-insensitive and every returned word is
  lowercased.
- Results are sorted by count descending. Ties are broken by
  FIRST-APPEARANCE order in `text` — whichever tied word's first
  occurrence comes earlier in the text is listed first. Ties are NEVER
  broken alphabetically.
- If n is greater than the number of distinct words, every distinct word
  is returned, still ordered as above.
- If n <= 0, top_n returns an empty list. An empty or word-less `text`
  returns [].
- word_count(text) -> int: the TOTAL number of word occurrences in
  `text` (not the number of distinct words); this count is unrelated to
  the tie-break rule above and is unaffected by it.

Examples:
    top_n("the cat sat on the mat", 1)   -> [("the", 2)]
    top_n("b a b a c", 2)                -> [("b", 2), ("a", 2)]
    top_n("Cat cat CAT", 5)              -> [("cat", 3)]
    top_n("z z y y x", 3)                -> [("z", 2), ("y", 2), ("x", 1)]
    top_n("", 3)                         -> []
    top_n("one two three", 0)            -> []
    word_count("one, two -- three!")     -> 3
    top_n("v2 v2 v10 v10 v1", 2)         -> [("v2", 2), ("v10", 2)]

Notes:
- Matching is done with a single compiled regex pass over `text`; there
  is no separate tokenization step to keep in sync with it.

Rationale:
This module backs a "most-discussed terms" widget where the FIRST tied
word a reader noticed (the one that showed up earliest) should stay
first as new, equally-frequent words are typed in. An alphabetical
tie-break would make already-displayed words jump around every time a
new word ties an existing count, which is exactly the churn the widget
exists to avoid. Numbers count as word characters (so "v2" is one word)
because product names in the source text often contain them, and a
split "v" / "2" would double-count a single mention.
"""

import re

_WORD_RE = re.compile(r"[A-Za-z0-9]+")


def top_n(text, n):
    """Return the n most frequent words, ties broken by first appearance."""
    if n <= 0:
        return []
    counts = {}
    first_seen = {}
    next_index = 0
    for match in _WORD_RE.finditer(text):
        word = match.group(0).lower()
        if word not in counts:
            first_seen[word] = next_index
            next_index += 1
            counts[word] = 0
        counts[word] += 1
    # BUG: ties are broken alphabetically (by the word itself) instead of
    # by each word's first-appearance index, so any tied group whose
    # appearance order isn't already alphabetical gets silently reordered.
    ranked = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    return ranked[:n]


def word_count(text):
    """Total number of word occurrences (not distinct words) in `text`."""
    return sum(1 for _ in _WORD_RE.finditer(text))
'''

BUGGY_ROMAN = '''\
"""roman.py — integer <-> Roman numeral conversion.

Contract:
- to_roman(n) -> str: the Roman numeral for 1 <= n <= 3999, using
  standard subtractive notation (IV not IIII, IX not VIIII, XL, XC, CD,
  CM). Behavior for n outside 1..3999 is undefined.
- from_roman(s) -> int: the integer value of a well-formed, uppercase
  Roman numeral string `s` (built only from the standard subtractive
  pairs above). Behavior for malformed input is undefined — this module
  does not attempt to validate numeral well-formedness, only to decode
  well-formed input.
- from_roman(to_roman(n)) == n for every 1 <= n <= 3999.

Examples:
    to_roman(9)            -> "IX"
    to_roman(40)           -> "XL"
    to_roman(94)           -> "XCIV"
    to_roman(444)          -> "CDXLIV"
    to_roman(1994)         -> "MCMXCIV"
    to_roman(3999)         -> "MMMCMXCIX"
    from_roman("IX")       -> 9
    from_roman("MCMXCIV")  -> 1994

Rationale:
Both directions are exposed separately, rather than one being derived
from a search over the other, because callers need both a formatter for
generated invoice numbers and a parser for numerals a user typed by
hand, and the two rarely change together: from_roman only needs a flat
value table, while to_roman needs the ordered greedy table below, and a
change to one's internal representation should never risk breaking the
other.
"""

_ROMAN_VALUES = {"I": 1, "V": 5, "X": 10, "L": 50, "C": 100, "D": 500, "M": 1000}

# BUG: the symbols for the 90 and 40 thresholds are swapped ("XL" written
# where "XC" belongs, and "XC" where "XL" belongs), so any number whose
# greedy expansion passes through the 90s or 40s comes out with the wrong
# subtractive pair even though every OTHER threshold below is correct.
_GREEDY_TABLE = [
    (1000, "M"),
    (900, "CM"),
    (500, "D"),
    (400, "CD"),
    (100, "C"),
    (90, "XL"),
    (50, "L"),
    (40, "XC"),
    (10, "X"),
    (9, "IX"),
    (5, "V"),
    (4, "IV"),
    (1, "I"),
]


def to_roman(n):
    """Return the Roman numeral for 1 <= n <= 3999."""
    out = []
    for value, symbol in _GREEDY_TABLE:
        while n >= value:
            out.append(symbol)
            n -= value
    return "".join(out)


def from_roman(s):
    """Return the integer value of a well-formed Roman numeral string."""
    total = 0
    for i, ch in enumerate(s):
        value = _ROMAN_VALUES[ch]
        if i + 1 < len(s) and _ROMAN_VALUES[s[i + 1]] > value:
            total -= value
        else:
            total += value
    return total
'''

BUGGY_RLE = '''\
"""rle.py — run-length encoding for lowercase-letter strings.

Contract:
- This module only needs to handle strings made of lowercase ASCII
  letters (a-z); behavior for other characters (including digits) is
  undefined, since a digit in the input could be confused with an
  encoded count.
- rle_encode(s) -> str: replace every maximal run of the same character
  with "<count><char>". A run of length 1 is still written with an
  explicit "1", e.g. "abc" -> "1a1b1c". The empty string encodes to "".
- rle_decode(s) -> str: the exact inverse of rle_encode, for ANY count —
  including counts of two or more digits, e.g. "12a" decodes to twelve
  'a' characters, not one 'a' followed by leftover, mis-parsed text.
- rle_decode(rle_encode(s)) == s for every s made of lowercase letters.
- run_count(s) -> int: the number of maximal same-character runs in `s`
  (i.e. the number of tokens rle_encode would produce), independent of
  how large any individual run's count is.

Examples:
    rle_encode("aaabbbcc")     -> "3a3b2c"
    rle_encode("abc")          -> "1a1b1c"
    rle_encode("")             -> ""
    rle_decode("3a3b2c")       -> "aaabbbcc"
    rle_decode("12a")          -> "aaaaaaaaaaaa"   (12 a's)
    run_count("aaabbbcc")      -> 3
    run_count("")              -> 0

Rationale:
Restricting the alphabet to lowercase letters keeps the encoding
unambiguous: a count is always digits, a payload character is always a
letter, so a decoder never has to guess where one token ends and the
next begins — mixing digits into the payload alphabet would make "31"
ambiguous between "three 1s" and "one 3 followed by a literal 1".
"""

import re


def rle_encode(s):
    """Encode `s` as <count><char> pairs for each maximal run."""
    if not s:
        return ""
    out = []
    prev = s[0]
    count = 1
    for ch in s[1:]:
        if ch == prev:
            count += 1
        else:
            out.append(str(count) + prev)
            prev = ch
            count = 1
    out.append(str(count) + prev)
    return "".join(out)


# BUG: this pattern only matches a SINGLE digit before the character, so
# any count of two or more digits (any run of length >= 10) is parsed as
# just its first digit, and the remaining digit(s) are misread as if they
# were themselves a character with no count of their own.
_TOKEN_RE = re.compile(r"(\\d)(.)")


def rle_decode(s):
    """Decode a string produced by rle_encode back to the original."""
    out = []
    for count_str, ch in _TOKEN_RE.findall(s):
        out.append(ch * int(count_str))
    return "".join(out)


def run_count(s):
    """Number of maximal same-character runs in `s`."""
    if not s:
        return 0
    count = 1
    for i in range(1, len(s)):
        if s[i] != s[i - 1]:
            count += 1
    return count
'''

BUGGY_BASECONV = '''\
"""baseconv.py — integer <-> string conversion in an arbitrary base.

Contract:
- to_base(n, base) -> str: n's representation in `base` (2 <= base <=
  36), using digits "0"-"9" then uppercase "A"-"Z" for digit values
  10-35. Negative n gets a leading "-". to_base(0, base) == "0" for
  every base (never the empty string).
- from_base(s, base) -> int: the inverse of to_base; `s` may use upper
  or lower case letters and an optional leading "-".
- digit_count(n, base) -> int: the number of digits to_base(n, base)
  would produce, NOT counting a leading "-" sign, e.g.
  digit_count(255, 16) == 2 and digit_count(-255, 16) == 2.
- from_base(to_base(n, base), base) == n for every int n and every base
  2 <= base <= 36.
- raises ValueError if base is outside 2..36.

Examples:
    to_base(0, 10)         -> "0"
    to_base(255, 16)       -> "FF"
    to_base(-10, 2)        -> "-1010"
    from_base("FF", 16)    -> 255
    from_base("ff", 16)    -> 255
    from_base("-1010", 2)  -> -10
    digit_count(255, 16)   -> 2
    digit_count(-255, 16)  -> 2

Rationale:
Uppercase output was chosen (rather than lowercase) to match the
convention used by this codebase's existing hex-dump tooling; from_base
accepts either case on input because it is often fed numerals a user
typed by hand, and rejecting "ff" just because "FF" is canonical would
be needless friction for no safety benefit.

Notes:
- Every base from 2 (binary) through 36 (all ten digits plus all
  twenty-six letters) is supported; there is no special-cased fast path
  for base 10 or base 16.
- digit_count exists because callers padding a column of numbers to a
  fixed width need the digit count without paying to allocate and then
  discard the formatted string itself for every entry.
"""


_DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz"


def to_base(n, base):
    """Return n's representation in the given base, "0"-"Z"."""
    if not (2 <= base <= 36):
        raise ValueError("base must be between 2 and 36")
    negative = n < 0
    n = abs(n)
    digits = []
    # BUG: n == 0 never enters this loop, so to_base(0, base) returns ""
    # instead of the documented "0".
    while n > 0:
        digits.append(_DIGITS[n % base].upper())
        n //= base
    digits.reverse()
    result = "".join(digits)
    return ("-" + result) if negative else result


def from_base(s, base):
    """Return the integer value of `s`, read in the given base."""
    if not (2 <= base <= 36):
        raise ValueError("base must be between 2 and 36")
    negative = s.startswith("-")
    if negative:
        s = s[1:]
    value = 0
    for ch in s.lower():
        value = value * base + _DIGITS.index(ch)
    return -value if negative else value


def digit_count(n, base):
    """Number of digits to_base(n, base) uses, not counting any sign."""
    return len(to_base(n, base).lstrip("-")) or 1
'''

BUGGY_IPV4 = '''\
"""ipv4.py — IPv4 address validation and integer conversion.

Contract:
- is_valid_ipv4(s) -> bool: True iff `s` is exactly four dot-separated
  decimal octets. Each octet is 1-3 ASCII digits, has NO leading zero
  unless the octet is exactly "0" (so "01" and "007" are invalid, but
  "0" and "10" are fine), and its numeric value is between 0 and 255
  inclusive.
- ip_to_int(s) -> int: the 32-bit unsigned integer for a valid `s` (the
  first octet is the high byte); raises ValueError if `s` is not a valid
  IPv4 address per is_valid_ipv4.
- int_to_ip(n) -> str: the canonical dotted-decimal string for
  0 <= n <= 2**32 - 1; raises ValueError otherwise.
- same_subnet(a, b, prefix_len) -> bool: True iff valid addresses `a`
  and `b` share the same top `prefix_len` bits (0 <= prefix_len <= 32).
- int_to_ip(ip_to_int(s)) == s for every valid, canonical `s`.

Examples:
    is_valid_ipv4("192.168.1.1")     -> True
    is_valid_ipv4("192.168.01.1")    -> False   (leading zero)
    is_valid_ipv4("256.1.1.1")       -> False   (out of range)
    ip_to_int("0.0.0.1")             -> 1
    ip_to_int("255.255.255.255")     -> 4294967295
    int_to_ip(4294967295)            -> "255.255.255.255"
    same_subnet("10.0.0.1", "10.0.0.200", 24) -> True

Rationale:
Leading zeros are rejected because some historic IP parsers treat a
leading zero as an octal prefix, silently reinterpreting an address like
"192.168.010.1" as a different numeric address than its digits suggest —
rejecting the ambiguous form outright is safer than picking a base for
callers who never intended anything but decimal.

Notes:
- `prefix_len=0` in same_subnet always returns True for any two valid
  addresses, since a zero-bit prefix matches everything.
- ip_to_int and int_to_ip are exact inverses of each other only for
  addresses that is_valid_ipv4 already accepts; feeding an invalid
  string to ip_to_int raises ValueError rather than guessing.
"""

import re

_OCTET_RE = re.compile(r"^\\d{1,3}$")


def is_valid_ipv4(s):
    """True iff `s` is a valid, canonically-formatted IPv4 address."""
    parts = s.split(".")
    if len(parts) != 4:
        return False
    for part in parts:
        if not _OCTET_RE.match(part):
            return False
        # BUG: never rejects a leading zero like "01" or "007" — only the
        # numeric range is checked, so non-canonical octets slip through.
        if int(part) > 255:
            return False
    return True


def ip_to_int(s):
    """Convert a valid dotted-decimal string to its 32-bit integer form."""
    if not is_valid_ipv4(s):
        raise ValueError("invalid IPv4 address: %r" % s)
    value = 0
    for part in s.split("."):
        value = (value << 8) | int(part)
    return value


def int_to_ip(n):
    """Convert a 32-bit integer back to dotted-decimal form."""
    if not (0 <= n <= 2 ** 32 - 1):
        raise ValueError("integer out of range for IPv4: %r" % n)
    return ".".join(str((n >> shift) & 0xFF) for shift in (24, 16, 8, 0))


def same_subnet(a, b, prefix_len):
    """True iff `a` and `b` share the same top `prefix_len` bits."""
    mask = (0xFFFFFFFF << (32 - prefix_len)) & 0xFFFFFFFF if prefix_len else 0
    return (ip_to_int(a) & mask) == (ip_to_int(b) & mask)
'''

BUGGY_MATRIX = '''\
"""matrix.py — basic 2-D list matrix operations.

Contract:
- A matrix is a non-empty list of equal-length rows (lists of numbers).
- transpose(m) -> list[list]: the standard transpose; the result has
  len(m[0]) rows and len(m) columns.
- multiply(a, b) -> list[list]: the standard matrix product; raises
  ValueError if len(a[0]) != len(b) (inner dimensions must match). The
  result has len(a) rows and len(b[0]) columns — for NON-square inputs
  this is generally a different shape than either input matrix.
- identity(n) -> list[list]: the n x n identity matrix (1s on the
  diagonal, 0s elsewhere); identity(0) is [].
- none of these functions mutate their input matrices.

Examples:
    transpose([[1, 2, 3], [4, 5, 6]])              -> [[1, 4], [2, 5], [3, 6]]
    multiply([[1, 2], [3, 4]], [[5, 6], [7, 8]])   -> [[19, 22], [43, 50]]
    multiply([[1, 2, 3], [4, 5, 6]],
              [[7, 8], [9, 10], [11, 12]])          -> [[58, 64], [139, 154]]
    identity(3)             -> [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
    multiply(identity(2), [[9, 8], [7, 6]])        -> [[9, 8], [7, 6]]
    transpose([[1, 2]])                            -> [[1], [2]]
    identity(1)                                    -> [[1]]

Rationale:
Square-matrix multiplication is the common case exercised during
development, which is exactly the kind of input that hides a dimension
mix-up bug: a bug that miscounts the number of inner-product terms is
invisible whenever the two matrices happen to share both dimensions, and
only shows up once a genuinely non-square pair is multiplied — which is
precisely why this module's own docstring calls out a non-square
example explicitly, rather than leaving readers to assume square inputs
are the only case worth handling correctly.

Notes:
- `multiply` raises ValueError rather than silently truncating or
  padding when the inner dimensions disagree; callers rely on that
  ValueError to catch shape mistakes made upstream, so it must never be
  downgraded to a wrong-but-quiet result.
- `transpose` accepts a single-row or single-column matrix; the result
  is still a list of one-element rows, never a flattened list.
"""


def transpose(m):
    """Return the transpose of `m` as a new matrix."""
    return [list(row) for row in zip(*m)]


def multiply(a, b):
    """Return the matrix product a @ b."""
    rows_a, cols_a = len(a), len(a[0])
    rows_b, cols_b = len(b), len(b[0])
    if cols_a != rows_b:
        raise ValueError("inner dimensions must match: %d != %d" % (cols_a, rows_b))
    result = [[0] * cols_b for _ in range(rows_a)]
    for i in range(rows_a):
        for j in range(cols_b):
            total = 0
            # BUG: sums over `cols_b` instead of `cols_a`. For square
            # inputs cols_a == cols_b so this is invisible; for a
            # non-square pair it silently drops or overruns inner-product
            # terms instead of raising or producing the documented result.
            for k in range(cols_b):
                total += a[i][k] * b[k][j]
            result[i][j] = total
    return result


def identity(n):
    """Return the n x n identity matrix."""
    return [[1 if i == j else 0 for j in range(n)] for i in range(n)]
'''

BUGGY_TEMPLATE = '''\
"""template.py — minimal {{name}} / {{name|default}} substitution.

Contract:
- render(template, context) -> str: for every `{{name}}` marker,
  substitute str(context[name]); for every `{{name|default}}` marker,
  substitute str(context[name]) when name IS present in context, and
  fall back to the literal text `default` ONLY when name is missing — a
  present value always wins over a given default, never the reverse.
- name matches [A-Za-z_][A-Za-z0-9_]*; surrounding whitespace inside the
  braces (around name and around default) is stripped before use.
- text outside `{{...}}` markers is copied through unchanged, including
  any single `{` or `}` that isn't part of a well-formed marker.
- raises KeyError(name) when name is missing from context and no
  default was given.
- has_placeholder(template, name) -> bool: True iff `template` contains
  a `{{name}}` or `{{name|...}}` marker for exactly that name.

Examples:
    render("Hi {{name}}!", {"name": "Sam"})       -> "Hi Sam!"
    render("Hi {{name|there}}!", {"name": "Sam"}) -> "Hi Sam!"
    render("Hi {{name|there}}!", {})              -> "Hi there!"
    render("{a} {{x}}", {"x": 1})                 -> "{a} 1"
    has_placeholder("Hi {{name}}!", "name")       -> True
    has_placeholder("Hi {{name}}!", "age")        -> False
    render("{{a}}-{{b|x}}", {"a": 1, "b": 2})     -> "1-2"
    has_placeholder("no markers here", "name")    -> False

Rationale:
A default is meant as a fallback for OPTIONAL context keys — e.g. a
greeting template rendered before all profile fields are known — and
once the real value shows up it must take over, or every caller would
need to remember to delete its default text the moment the value became
available, defeating the point of having a default at all.

Notes:
- `context` may hold extra keys the template never references; those
  are simply ignored, not an error.
- The default text itself is copied through verbatim — it is never
  itself scanned for further `{{...}}` markers to substitute.
- `has_placeholder` deliberately shares its matching logic with
  `render`'s own tag pattern (down to the same optional-default group)
  so the two never silently disagree about what counts as a marker.
"""

import re

_TAG_RE = re.compile(r"\\{\\{\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*(?:\\|\\s*([^}]*?)\\s*)?\\}\\}")


def render(template, context):
    """Substitute every {{name}} / {{name|default}} marker in `template`."""

    def replace(match):
        name, default = match.group(1), match.group(2)
        # BUG: a given default always wins, even when `name` is present
        # in context — this should only ever be the fallback for a
        # MISSING name, per the documented contract above.
        if default is not None:
            return default
        if name in context:
            return str(context[name])
        raise KeyError(name)

    return _TAG_RE.sub(replace, template)


def has_placeholder(template, name):
    """True iff `template` contains a {{name}} or {{name|...}} marker."""
    pattern = re.compile(r"\\{\\{\\s*" + re.escape(name) + r"\\s*(?:\\|[^}]*)?\\}\\}")
    return bool(pattern.search(template))
'''

BUGGY_CSVLINE = '''\
"""csvline.py — parse and format one CSV data line (double-quote rules).

Contract:
- parse_line(line) -> list[str]: split `line` on commas, except commas
  that fall inside a field wrapped in a matching pair of double quotes.
  Inside a quoted field, a DOUBLED quote `""` represents one literal `"`
  character and does NOT end the field; a single `"` ends the quoted
  section. Unquoted fields are returned exactly as written (not
  trimmed).
- format_line(fields) -> str: the inverse of parse_line — a field is
  wrapped in double quotes (with every internal `"` doubled) iff it
  contains a comma, a double quote, or a newline; other fields are left
  bare.
- field_count(line) -> int: len(parse_line(line)), exposed separately so
  callers that only need a count don't have to build the whole list.
- parse_line(format_line(fields)) == fields for every list of strings.

Examples:
    parse_line("a,b,c")            -> ["a", "b", "c"]
    parse_line('"a,b",c')          -> ["a,b", "c"]
    parse_line('"a""b",x')         -> ['a"b', "x"]
    format_line(["a", "b,c"])      -> 'a,"b,c"'
    format_line(['a"b'])           -> '"a""b"'
    field_count('"a,b",c,d')       -> 3

Rationale:
The doubled-quote escape (rather than a backslash escape) matches
RFC 4180, the format every spreadsheet export this module reads
actually uses — a backslash scheme would look simpler to implement here
but would silently mis-parse every real file this module is fed in
production.

Notes:
- A trailing comma at the end of `line` produces a trailing empty
  field, e.g. parse_line("a,") == ["a", ""], matching how spreadsheet
  exports represent an intentionally blank last column.
- format_line never adds quotes it doesn't need to; a field with no
  comma, quote, or newline round-trips through format_line unchanged.
"""


def parse_line(line):
    """Parse one CSV data line into its fields."""
    fields = []
    i = 0
    n = len(line)
    while True:
        if i < n and line[i] == '"':
            i += 1
            chars = []
            while i < n:
                if line[i] == '"':
                    # BUG: a closing quote always ends the field here; the
                    # doubled-quote escape ("" -> literal ") is never
                    # recognized, so an escaped quote truncates the field
                    # early and corrupts the rest of the line's parsing.
                    i += 1
                    break
                chars.append(line[i])
                i += 1
            field = "".join(chars)
        else:
            j = line.find(",", i)
            if j == -1:
                j = n
            field = line[i:j]
            i = j
        fields.append(field)
        if i < n and line[i] == ",":
            i += 1
            continue
        break
    return fields


def format_line(fields):
    """Format `fields` back into one CSV data line."""
    parts = []
    for field in fields:
        if any(c in field for c in (",", '"', "\\n")):
            parts.append('"' + field.replace('"', '""') + '"')
        else:
            parts.append(field)
    return ",".join(parts)


def field_count(line):
    """Number of fields parse_line(line) would return."""
    return len(parse_line(line))
'''

BUGGY_CAESAR = '''\
"""caesar.py — Caesar-cipher shifting.

Contract:
- shift_encode(text, n) -> str: shift every ASCII letter by n positions
  through the alphabet, wrapping around (mod 26) and preserving its
  case; n may be any integer, negative or larger than 25. Non-letter
  characters (spaces, punctuation, digits) pass through unchanged.
- shift_decode(text, n) -> str: exactly undoes shift_encode(text, n), so
  shift_decode(shift_encode(text, n), n) == text for every text and n.
- rot13(text) -> str: shift_encode(text, 13) — its own inverse, since
  13 + 13 == 26, provided purely as a named convenience.

Examples:
    shift_encode("abc", 1)             -> "bcd"
    shift_encode("xyz", 3)             -> "abc"
    shift_encode("Hello, World!", 5)   -> "Mjqqt, Btwqi!"
    shift_encode("abc", -1)            -> "zab"
    shift_encode("abc", 27)            -> "bcd"        (27 mod 26 == 1)
    shift_decode("Mjqqt, Btwqi!", 5)   -> "Hello, World!"
    rot13("abc")                       -> "nop"
    rot13(rot13("Attack at dawn"))     -> "Attack at dawn"
    shift_encode("A", 26)              -> "A"          (full wraparound)
    shift_encode("A B! c9", 1)         -> "B C! d9"

Rationale:
Non-letters pass through unchanged (rather than raising, or being
dropped) because this module is mainly applied to freeform chat
messages, where punctuation, digits and emoji are the common case, not
a rare exception worth special-casing into an error. n is accepted as
any integer, not just 0-25, because callers often compute a shift from
untrusted arithmetic (a hash, a day-of-year) that can easily land
outside that range.

Notes:
- Case is tracked per character, not per string: "AbC" shifted by 1
  becomes "BcD", never "Bcd" or "BCD".
- `rot13` is provided as a named convenience only; it does no more than
  call shift_encode(text, 13), and is expected to stay that way.
- A shift of exactly 0 (or any multiple of 26) always returns `text`
  unchanged, letters included.
- There is no length limit on `text`; every character is handled
  independently of every other, so this scales linearly.
"""


def shift_encode(text, n):
    """Shift every letter in `text` by n positions, wrapping mod 26."""
    out = []
    for ch in text:
        if "a" <= ch <= "z":
            base = ord("a")
        elif "A" <= ch <= "Z":
            base = ord("A")
        else:
            out.append(ch)
            continue
        out.append(chr(base + (ord(ch) - base + n) % 26))
    return "".join(out)


def shift_decode(text, n):
    """Undo shift_encode(text, n)."""
    # BUG: forgets to negate the shift, so this just re-encodes instead of
    # undoing the encoding — a no-op only in the special case n % 26 == 0.
    return shift_encode(text, n)


def rot13(text):
    """shift_encode(text, 13) — its own inverse."""
    return shift_encode(text, 13)
'''

BUGGY_INTERVALS = '''\
"""intervals.py — merge overlapping integer intervals.

Contract:
- merge_intervals(intervals) -> list[list[int, int]]: `intervals` is a
  list of [start, end] pairs with start <= end. Return the merged list,
  sorted by start ascending, where any two intervals that overlap OR
  merely TOUCH (one's end equals the other's start) are combined into a
  single [min(start), max(end)] interval — [1, 5] and [5, 9] MUST merge
  into [1, 9], because "touching" counts as overlapping in this module.
  The input list is never mutated.
- total_coverage(intervals) -> int: the sum of (end - start) over the
  MERGED intervals — i.e. the total integer span covered, without
  double-counting any overlap.

Examples:
    merge_intervals([[1, 3], [2, 6], [8, 10]])   -> [[1, 6], [8, 10]]
    merge_intervals([[1, 5], [5, 9]])            -> [[1, 9]]
    merge_intervals([])                          -> []
    merge_intervals([[1, 2], [3, 4], [5, 6]])    -> [[1, 2], [3, 4], [5, 6]]
    merge_intervals([[1, 1], [1, 5]])            -> [[1, 5]]
    merge_intervals([[-3, 0], [0, 4], [9, 9]])   -> [[-3, 4], [9, 9]]
    total_coverage([[1, 4], [2, 6], [10, 12]])   -> 7
    total_coverage([])                           -> 0

Rationale:
This module backs a scheduling view where two meetings that end exactly
when the next one begins must render as one unbroken block, not as two
blocks with a hairline visual gap between them — hence treating a touch
as an overlap rather than requiring a strict, non-zero overlap before
two intervals combine.

Notes:
- A single-point interval like [9, 9] (start == end) is valid input; it
  only merges with a neighbor that overlaps or touches it, exactly like
  any other interval — there is no special case for zero-width spans.
- Intervals may use negative numbers; there is nothing in this module
  that assumes a non-negative timeline.
- `merge_intervals` always returns freshly-built [start, end] lists, not
  references into the caller's own interval objects, so mutating the
  result afterward can never corrupt the caller's input.
- `total_coverage` is defined purely in terms of `merge_intervals`, so a
  correct merge is a prerequisite for a correct coverage total — this
  module never computes the two independently.
- The order of `intervals` in the input never matters to the output;
  `merge_intervals` sorts internally before combining anything.
- An `intervals` list containing exactly one entry is returned as a
  single-entry list, unchanged in value.
"""


def merge_intervals(intervals):
    """Merge overlapping (and touching) intervals, sorted by start."""
    if not intervals:
        return []
    ordered = sorted((list(iv) for iv in intervals), key=lambda iv: iv[0])
    merged = [ordered[0][:]]
    for start, end in ordered[1:]:
        last = merged[-1]
        # BUG: uses strict `<` so intervals that only TOUCH (start equals
        # the previous interval's end) are left separate instead of being
        # merged, contradicting the documented "touching counts" rule.
        if start < last[1]:
            last[1] = max(last[1], end)
        else:
            merged.append([start, end])
    return merged


def total_coverage(intervals):
    """Total span covered by `intervals`, after merging."""
    return sum(end - start for start, end in merge_intervals(intervals))
'''

BUGGY_PATHNORM = '''\
"""pathnorm.py — POSIX-style path normalization (no os.path).

Contract:
- normalize_path(path) -> str: split `path` on "/"; drop empty segments
  (from repeated slashes) and "." segments. A ".." segment pops the
  previously kept REAL segment (never a placeholder ".." itself) —
  UNLESS the path is absolute and there is nothing left to pop, in which
  case the ".." is silently dropped (you cannot go above the root); for
  a RELATIVE path with nothing to pop, ".." is instead kept literally in
  the output, and further ".." segments accumulate the same way. The
  result keeps a leading "/" iff `path` started with "/", never ends
  with "/" (except the input "/" itself, which normalizes to "/"), and a
  relative path that fully collapses to nothing normalizes to ".".
- join_paths(*parts) -> str: normalize_path("/".join(parts)) — join a
  sequence of path pieces and normalize the result in one step.

Examples:
    normalize_path("a/./b/../c")     -> "a/c"
    normalize_path("/a/../../b")     -> "/b"
    normalize_path("../../a")        -> "../../a"
    normalize_path(".")              -> "."
    normalize_path("/")              -> "/"
    normalize_path("//a//b/")        -> "/a/b"
    join_paths("a", "b", "..", "c")  -> "a/c"
    join_paths("a", "..", "..", "b") -> "../b"

Rationale:
A relative ".." that has nothing left to pop is KEPT (not silently
dropped the way it is at the root of an absolute path) because a
relative path is meant to be resolved later against some as-yet-unknown
base directory — dropping the ".." there would silently change which
directory the caller ends up in once that base is finally known.

Notes:
- This module never touches the filesystem; it is pure string
  manipulation over the path's segments, so it works identically on
  paths that don't exist yet.
- A "..": segment can only pop a REAL segment that was itself kept from
  the input — it never pops another accumulated ".." placeholder, since
  doing so would incorrectly cancel out two levels of "go up" into one.
- `join_paths` is a thin convenience over normalize_path; it does not
  independently reimplement any of the ".." or "." handling above.
"""


def normalize_path(path):
    """Normalize a POSIX-style path string."""
    absolute = path.startswith("/")
    segments = [seg for seg in path.split("/") if seg not in ("", ".")]
    stack = []
    for seg in segments:
        if seg == "..":
            # BUG: pops whatever is on top of the stack unconditionally,
            # even when that top entry is itself a literal ".." that
            # should have been left alone to accumulate — this silently
            # cancels out ".." segments that the documented contract says
            # must instead pile up for a relative path.
            if stack:
                stack.pop()
            elif not absolute:
                stack.append("..")
        else:
            stack.append(seg)
    body = "/".join(stack)
    if absolute:
        return "/" + body
    return body if body else "."


def join_paths(*parts):
    """Join `parts` with "/" and normalize the result."""
    return normalize_path("/".join(parts))
'''

BUGGY_VERSIONCMP = '''\
"""versioncmp.py — numeric comparison of MAJOR.MINOR.PATCH version strings.

Contract:
- parse_version(s) -> tuple[int, int, int]: split `s` on "." into
  exactly three non-negative integer components; raises ValueError if
  `s` does not have exactly three dot-separated integer parts.
- compare_versions(a, b) -> int: -1 if a < b, 0 if a == b, 1 if a > b,
  comparing (major, minor, patch) NUMERICALLY component by component —
  "1.10.0" > "1.9.0", unlike a plain string comparison.
- sort_versions(versions) -> list[str]: `versions` sorted ascending by
  compare_versions (numeric order), NEVER lexicographic string order.
- max_version(versions) -> str: the single largest version string in
  `versions` by compare_versions; raises ValueError on an empty list.

Examples:
    parse_version("1.2.3")                       -> (1, 2, 3)
    compare_versions("1.9.0", "1.10.0")          -> -1
    compare_versions("2.0.0", "2.0.0")           -> 0
    sort_versions(["1.9.0", "1.10.0", "1.2.0"])  -> ["1.2.0", "1.9.0", "1.10.0"]
    sort_versions(["0.1.0", "0.0.9"])            -> ["0.0.9", "0.1.0"]
    max_version(["1.2.0", "1.10.0", "1.9.0"])    -> "1.10.0"
    compare_versions("1.0.0", "1.0.0")            -> 0

Rationale:
This module exists specifically because Python's default string sort
gets multi-digit version components wrong ("1.10.0" sorts before
"1.9.0" lexicographically, since the character "1" is less than "9" at
the first differing position) — reproducing that exact mistake is the
one bug this module must never contain.

Notes:
- Pre-release suffixes ("1.0.0-rc1") are out of scope; every version
  string handled here is exactly three dot-separated integers.
"""


def parse_version(s):
    """Parse "MAJOR.MINOR.PATCH" into a 3-tuple of ints."""
    parts = s.split(".")
    if len(parts) != 3:
        raise ValueError("expected MAJOR.MINOR.PATCH: %r" % s)
    try:
        return tuple(int(p) for p in parts)
    except ValueError:
        raise ValueError("non-integer component in version: %r" % s)


def compare_versions(a, b):
    """-1 / 0 / 1 as a is numerically less than / equal to / greater than b."""
    pa, pb = parse_version(a), parse_version(b)
    if pa < pb:
        return -1
    if pa > pb:
        return 1
    return 0


def sort_versions(versions):
    """`versions` sorted ascending by numeric (major, minor, patch)."""
    # BUG: sorts the raw strings lexicographically instead of by their
    # parsed numeric components, so e.g. "1.10.0" incorrectly sorts
    # before "1.9.0".
    return sorted(versions)


def max_version(versions):
    """The largest version string in `versions`, numerically."""
    if not versions:
        raise ValueError("max_version() of an empty sequence")
    best = versions[0]
    for v in versions[1:]:
        if compare_versions(v, best) > 0:
            best = v
    return best
'''

DOZEN_BUGGY = {
    "wordfreq.py": BUGGY_WORDFREQ,
    "roman.py": BUGGY_ROMAN,
    "rle.py": BUGGY_RLE,
    "baseconv.py": BUGGY_BASECONV,
    "ipv4.py": BUGGY_IPV4,
    "matrix.py": BUGGY_MATRIX,
    "template.py": BUGGY_TEMPLATE,
    "csvline.py": BUGGY_CSVLINE,
    "caesar.py": BUGGY_CAESAR,
    "intervals.py": BUGGY_INTERVALS,
    "pathnorm.py": BUGGY_PATHNORM,
    "versioncmp.py": BUGGY_VERSIONCMP,
}

# ------------------------------------------------------------ reference fixes

FIXED_WORDFREQ = '''\
import re

_WORD_RE = re.compile(r"[A-Za-z0-9]+")


def top_n(text, n):
    if n <= 0:
        return []
    counts = {}
    first_seen = {}
    next_index = 0
    for match in _WORD_RE.finditer(text):
        word = match.group(0).lower()
        if word not in counts:
            first_seen[word] = next_index
            next_index += 1
            counts[word] = 0
        counts[word] += 1
    ranked = sorted(counts.items(), key=lambda kv: (-kv[1], first_seen[kv[0]]))
    return ranked[:n]


def word_count(text):
    return sum(1 for _ in _WORD_RE.finditer(text))
'''

FIXED_ROMAN = '''\
_ROMAN_VALUES = {"I": 1, "V": 5, "X": 10, "L": 50, "C": 100, "D": 500, "M": 1000}

_GREEDY_TABLE = [
    (1000, "M"),
    (900, "CM"),
    (500, "D"),
    (400, "CD"),
    (100, "C"),
    (90, "XC"),
    (50, "L"),
    (40, "XL"),
    (10, "X"),
    (9, "IX"),
    (5, "V"),
    (4, "IV"),
    (1, "I"),
]


def to_roman(n):
    out = []
    for value, symbol in _GREEDY_TABLE:
        while n >= value:
            out.append(symbol)
            n -= value
    return "".join(out)


def from_roman(s):
    total = 0
    for i, ch in enumerate(s):
        value = _ROMAN_VALUES[ch]
        if i + 1 < len(s) and _ROMAN_VALUES[s[i + 1]] > value:
            total -= value
        else:
            total += value
    return total
'''

FIXED_RLE = '''\
import re


def rle_encode(s):
    if not s:
        return ""
    out = []
    prev = s[0]
    count = 1
    for ch in s[1:]:
        if ch == prev:
            count += 1
        else:
            out.append(str(count) + prev)
            prev = ch
            count = 1
    out.append(str(count) + prev)
    return "".join(out)


_TOKEN_RE = re.compile(r"(\\d+)(.)")


def rle_decode(s):
    out = []
    for count_str, ch in _TOKEN_RE.findall(s):
        out.append(ch * int(count_str))
    return "".join(out)


def run_count(s):
    if not s:
        return 0
    count = 1
    for i in range(1, len(s)):
        if s[i] != s[i - 1]:
            count += 1
    return count
'''

FIXED_BASECONV = '''\
_DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz"


def to_base(n, base):
    if not (2 <= base <= 36):
        raise ValueError("base must be between 2 and 36")
    if n == 0:
        return "0"
    negative = n < 0
    n = abs(n)
    digits = []
    while n > 0:
        digits.append(_DIGITS[n % base].upper())
        n //= base
    digits.reverse()
    result = "".join(digits)
    return ("-" + result) if negative else result


def from_base(s, base):
    if not (2 <= base <= 36):
        raise ValueError("base must be between 2 and 36")
    negative = s.startswith("-")
    if negative:
        s = s[1:]
    value = 0
    for ch in s.lower():
        value = value * base + _DIGITS.index(ch)
    return -value if negative else value


def digit_count(n, base):
    return len(to_base(n, base).lstrip("-")) or 1
'''

FIXED_IPV4 = '''\
import re

_OCTET_RE = re.compile(r"^\\d{1,3}$")


def is_valid_ipv4(s):
    parts = s.split(".")
    if len(parts) != 4:
        return False
    for part in parts:
        if not _OCTET_RE.match(part):
            return False
        if len(part) > 1 and part[0] == "0":
            return False
        if int(part) > 255:
            return False
    return True


def ip_to_int(s):
    if not is_valid_ipv4(s):
        raise ValueError("invalid IPv4 address: %r" % s)
    value = 0
    for part in s.split("."):
        value = (value << 8) | int(part)
    return value


def int_to_ip(n):
    if not (0 <= n <= 2 ** 32 - 1):
        raise ValueError("integer out of range for IPv4: %r" % n)
    return ".".join(str((n >> shift) & 0xFF) for shift in (24, 16, 8, 0))


def same_subnet(a, b, prefix_len):
    mask = (0xFFFFFFFF << (32 - prefix_len)) & 0xFFFFFFFF if prefix_len else 0
    return (ip_to_int(a) & mask) == (ip_to_int(b) & mask)
'''

FIXED_MATRIX = '''\
def transpose(m):
    return [list(row) for row in zip(*m)]


def multiply(a, b):
    rows_a, cols_a = len(a), len(a[0])
    rows_b, cols_b = len(b), len(b[0])
    if cols_a != rows_b:
        raise ValueError("inner dimensions must match: %d != %d" % (cols_a, rows_b))
    result = [[0] * cols_b for _ in range(rows_a)]
    for i in range(rows_a):
        for j in range(cols_b):
            total = 0
            for k in range(cols_a):
                total += a[i][k] * b[k][j]
            result[i][j] = total
    return result


def identity(n):
    return [[1 if i == j else 0 for j in range(n)] for i in range(n)]
'''

FIXED_TEMPLATE = '''\
import re

_TAG_RE = re.compile(r"\\{\\{\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*(?:\\|\\s*([^}]*?)\\s*)?\\}\\}")


def render(template, context):
    def replace(match):
        name, default = match.group(1), match.group(2)
        if name in context:
            return str(context[name])
        if default is not None:
            return default
        raise KeyError(name)

    return _TAG_RE.sub(replace, template)


def has_placeholder(template, name):
    pattern = re.compile(r"\\{\\{\\s*" + re.escape(name) + r"\\s*(?:\\|[^}]*)?\\}\\}")
    return bool(pattern.search(template))
'''

FIXED_CSVLINE = '''\
def parse_line(line):
    fields = []
    i = 0
    n = len(line)
    while True:
        if i < n and line[i] == '"':
            i += 1
            chars = []
            while i < n:
                if line[i] == '"':
                    if i + 1 < n and line[i + 1] == '"':
                        chars.append('"')
                        i += 2
                        continue
                    i += 1
                    break
                chars.append(line[i])
                i += 1
            field = "".join(chars)
        else:
            j = line.find(",", i)
            if j == -1:
                j = n
            field = line[i:j]
            i = j
        fields.append(field)
        if i < n and line[i] == ",":
            i += 1
            continue
        break
    return fields


def format_line(fields):
    parts = []
    for field in fields:
        if any(c in field for c in (",", '"', "\\n")):
            parts.append('"' + field.replace('"', '""') + '"')
        else:
            parts.append(field)
    return ",".join(parts)


def field_count(line):
    return len(parse_line(line))
'''

FIXED_CAESAR = '''\
def shift_encode(text, n):
    out = []
    for ch in text:
        if "a" <= ch <= "z":
            base = ord("a")
        elif "A" <= ch <= "Z":
            base = ord("A")
        else:
            out.append(ch)
            continue
        out.append(chr(base + (ord(ch) - base + n) % 26))
    return "".join(out)


def shift_decode(text, n):
    return shift_encode(text, -n)


def rot13(text):
    return shift_encode(text, 13)
'''

FIXED_INTERVALS = '''\
def merge_intervals(intervals):
    if not intervals:
        return []
    ordered = sorted((list(iv) for iv in intervals), key=lambda iv: iv[0])
    merged = [ordered[0][:]]
    for start, end in ordered[1:]:
        last = merged[-1]
        if start <= last[1]:
            last[1] = max(last[1], end)
        else:
            merged.append([start, end])
    return merged


def total_coverage(intervals):
    return sum(end - start for start, end in merge_intervals(intervals))
'''

FIXED_PATHNORM = '''\
def normalize_path(path):
    absolute = path.startswith("/")
    segments = [seg for seg in path.split("/") if seg not in ("", ".")]
    stack = []
    for seg in segments:
        if seg == "..":
            if stack and stack[-1] != "..":
                stack.pop()
            elif not absolute:
                stack.append("..")
        else:
            stack.append(seg)
    body = "/".join(stack)
    if absolute:
        return "/" + body
    return body if body else "."


def join_paths(*parts):
    return normalize_path("/".join(parts))
'''

FIXED_VERSIONCMP = '''\
def parse_version(s):
    parts = s.split(".")
    if len(parts) != 3:
        raise ValueError("expected MAJOR.MINOR.PATCH: %r" % s)
    try:
        return tuple(int(p) for p in parts)
    except ValueError:
        raise ValueError("non-integer component in version: %r" % s)


def compare_versions(a, b):
    pa, pb = parse_version(a), parse_version(b)
    if pa < pb:
        return -1
    if pa > pb:
        return 1
    return 0


def sort_versions(versions):
    return sorted(versions, key=parse_version)


def max_version(versions):
    if not versions:
        raise ValueError("max_version() of an empty sequence")
    best = versions[0]
    for v in versions[1:]:
        if compare_versions(v, best) > 0:
            best = v
    return best
'''

DOZEN_FIXED = {
    "wordfreq.py": FIXED_WORDFREQ,
    "roman.py": FIXED_ROMAN,
    "rle.py": FIXED_RLE,
    "baseconv.py": FIXED_BASECONV,
    "ipv4.py": FIXED_IPV4,
    "matrix.py": FIXED_MATRIX,
    "template.py": FIXED_TEMPLATE,
    "csvline.py": FIXED_CSVLINE,
    "caesar.py": FIXED_CAESAR,
    "intervals.py": FIXED_INTERVALS,
    "pathnorm.py": FIXED_PATHNORM,
    "versioncmp.py": FIXED_VERSIONCMP,
}

# --------------------------------------------------------------------- smoke

SMOKE = '''\
"""Quick per-module sanity check — NOT the full hidden test suite.

Run: python3 smoke.py
Prints one OK/FAIL line per module, then a summary line. DO NOT EDIT this
file — fix the twelve modules instead.
"""

results = []


def check(name, fn):
    try:
        fn()
        results.append((name, True, ""))
    except Exception as e:
        results.append((name, False, "%s: %s" % (type(e).__name__, e)))


def check_wordfreq():
    from wordfreq import top_n
    got = top_n("zebra apple zebra apple mango", 2)
    assert got == [("zebra", 2), ("apple", 2)], "got %r" % (got,)


def check_roman():
    from roman import to_roman
    got = to_roman(94)
    assert got == "XCIV", "got %r" % (got,)


def check_rle():
    from rle import rle_decode, rle_encode
    got = rle_decode(rle_encode("a" * 12))
    assert got == "a" * 12, "got %r" % (got,)


def check_baseconv():
    from baseconv import to_base
    got = to_base(0, 10)
    assert got == "0", "got %r" % (got,)


def check_ipv4():
    from ipv4 import is_valid_ipv4
    got = is_valid_ipv4("192.168.01.1")
    assert got is False, "got %r" % (got,)


def check_matrix():
    from matrix import multiply
    got = multiply([[1, 2, 3], [4, 5, 6]], [[7, 8], [9, 10], [11, 12]])
    assert got == [[58, 64], [139, 154]], "got %r" % (got,)


def check_template():
    from template import render
    got = render("Hi {{name|there}}!", {"name": "Sam"})
    assert got == "Hi Sam!", "got %r" % (got,)


def check_csvline():
    from csvline import parse_line
    got = parse_line('"a""b",x')
    assert got == ['a"b', "x"], "got %r" % (got,)


def check_caesar():
    from caesar import shift_decode, shift_encode
    got = shift_decode(shift_encode("Attack at dawn", 7), 7)
    assert got == "Attack at dawn", "got %r" % (got,)


def check_intervals():
    from intervals import merge_intervals
    got = merge_intervals([[1, 5], [5, 9]])
    assert got == [[1, 9]], "got %r" % (got,)


def check_pathnorm():
    from pathnorm import normalize_path
    got = normalize_path("../../a")
    assert got == "../../a", "got %r" % (got,)


def check_versioncmp():
    from versioncmp import sort_versions
    got = sort_versions(["1.9.0", "1.10.0", "1.2.0"])
    assert got == ["1.2.0", "1.9.0", "1.10.0"], "got %r" % (got,)


CHECKS = [
    ("wordfreq", check_wordfreq),
    ("roman", check_roman),
    ("rle", check_rle),
    ("baseconv", check_baseconv),
    ("ipv4", check_ipv4),
    ("matrix", check_matrix),
    ("template", check_template),
    ("csvline", check_csvline),
    ("caesar", check_caesar),
    ("intervals", check_intervals),
    ("pathnorm", check_pathnorm),
    ("versioncmp", check_versioncmp),
]

for _name, _fn in CHECKS:
    check(_name, _fn)

_ok_count = 0
for _name, _ok, _reason in results:
    if _ok:
        _ok_count += 1
        print("%s: OK" % _name)
    else:
        print("%s: FAIL (%s)" % (_name, _reason))

if _ok_count == len(results):
    print("ALL %d OK" % len(results))
else:
    print("%d/%d modules OK" % (_ok_count, len(results)))
'''

README = """\
# textkit12

Twelve independent, self-contained Python utility modules, each with its
exact contract documented in its own docstring:

- `wordfreq.py`  — word frequency counting, ties broken by first appearance.
- `roman.py`     — integer <-> Roman numeral conversion.
- `rle.py`       — run-length encoding for lowercase strings.
- `baseconv.py`  — integer <-> string conversion in an arbitrary base.
- `ipv4.py`      — IPv4 address validation and integer conversion.
- `matrix.py`    — transpose / multiply / identity for 2-D list matrices.
- `template.py`  — minimal {{name}} / {{name|default}} substitution.
- `csvline.py`   — one-line CSV parsing and formatting (double-quote rules).
- `caesar.py`    — Caesar-cipher shifting.
- `intervals.py` — merging overlapping (and touching) integer intervals.
- `pathnorm.py`  — POSIX-style path normalization.
- `versioncmp.py`— numeric MAJOR.MINOR.PATCH version comparison.

Run `python3 smoke.py` for a quick per-module sanity check.

Known issue: every module currently has exactly one contract-violating
bug, and every module's bug is independent of every other module's.

Development notes:
- Every module is stdlib-only and has zero dependencies on any other
  module in this directory — read one module at a time, in any order,
  without worrying about import cycles or shared mutable state.
- Each module's docstring is the full specification for that module;
  nothing about its correct behavior lives anywhere else, including in
  `smoke.py`, which only spot-checks one example per module.
"""

TASK = """\
The working directory contains twelve independent, self-contained Python
utility modules — wordfreq.py, roman.py, rle.py, baseconv.py, ipv4.py,
matrix.py, template.py, csvline.py, caesar.py, intervals.py, pathnorm.py,
and versioncmp.py — plus a README.md and a smoke.py.

Each module's docstring states its exact contract (with worked examples),
and each module currently has exactly one subtle bug that violates its own
contract. The bugs are fully independent: fixing one module never affects
any other module, and no module imports another.

Run `python3 smoke.py` first. It runs one quick sanity check per module and
prints "<module>: OK" or "<module>: FAIL (<reason>)" for each, followed by a
summary line. Treat its output as your work list: every module reporting
FAIL needs to be fixed.

For each failing module, in any order you like: read the module's full
docstring to understand its documented contract, locate the bug, fix it, and
re-run `python3 smoke.py` to confirm that module now reports OK before
moving to the next one. Do not modify smoke.py, and do not change any
module's documented contract or its function names/signatures — only fix
the bug that violates the contract already written down.

You are done when `python3 smoke.py` prints "ALL 12 OK". Then reply DONE.

Every module is completely self-contained (none of the twelve import from
any other module in this directory), so there is no ordering dependency
between fixes and no risk that fixing one module's bug could break, mask,
or accidentally fix another module's bug — each is an independent unit of
work with its own docstring as the full specification of what "fixed"
means for that module.
"""

# --------------------------------------------------------------- hidden tests

_CASES = []


def _case(module, expr, expected):
    _CASES.append((module, expr, expected))


# wordfreq
_case("wordfreq", 'top_n("the cat sat on the mat", 1)', [("the", 2)])
_case("wordfreq", 'top_n("b a b a c", 2)', [("b", 2), ("a", 2)])
_case("wordfreq", 'top_n("Cat cat CAT", 5)', [("cat", 3)])
_case("wordfreq", 'top_n("", 3)', [])
_case("wordfreq", 'word_count("one, two -- three!")', 3)

# roman
_case("roman", "to_roman(94)", "XCIV")
_case("roman", "to_roman(44)", "XLIV")
_case("roman", "to_roman(1994)", "MCMXCIV")
_case("roman", "to_roman(3999)", "MMMCMXCIX")
_case("roman", 'from_roman("MCMXCIV")', 1994)
_case("roman", 'from_roman("IX")', 9)

# rle
_case("rle", 'rle_encode("aaabbbcc")', "3a3b2c")
_case("rle", 'rle_encode("abc")', "1a1b1c")
_case("rle", 'rle_encode("")', "")
_case("rle", 'rle_decode("3a3b2c")', "aaabbbcc")
_case("rle", 'rle_decode("12a")', "a" * 12)
_case("rle", 'run_count("aaabbbcc")', 3)

# baseconv
_case("baseconv", "to_base(0, 10)", "0")
_case("baseconv", "to_base(255, 16)", "FF")
_case("baseconv", "to_base(-10, 2)", "-1010")
_case("baseconv", 'from_base("FF", 16)', 255)
_case("baseconv", 'from_base("ff", 16)', 255)
_case("baseconv", 'from_base("-1010", 2)', -10)
_case("baseconv", "digit_count(255, 16)", 2)

# ipv4
_case("ipv4", 'is_valid_ipv4("192.168.1.1")', True)
_case("ipv4", 'is_valid_ipv4("192.168.01.1")', False)
_case("ipv4", 'is_valid_ipv4("256.1.1.1")', False)
_case("ipv4", 'ip_to_int("0.0.0.1")', 1)
_case("ipv4", 'ip_to_int("255.255.255.255")', 4294967295)
_case("ipv4", "int_to_ip(4294967295)", "255.255.255.255")
_case("ipv4", 'same_subnet("10.0.0.1", "10.0.0.200", 24)', True)

# matrix
_case("matrix", "transpose([[1, 2, 3], [4, 5, 6]])", [[1, 4], [2, 5], [3, 6]])
_case("matrix", "multiply([[1, 2], [3, 4]], [[5, 6], [7, 8]])", [[19, 22], [43, 50]])
_case(
    "matrix",
    "multiply([[1, 2, 3], [4, 5, 6]], [[7, 8], [9, 10], [11, 12]])",
    [[58, 64], [139, 154]],
)
_case("matrix", "identity(3)", [[1, 0, 0], [0, 1, 0], [0, 0, 1]])
_case("matrix", "multiply(identity(2), [[9, 8], [7, 6]])", [[9, 8], [7, 6]])

# template
_case("template", 'render("Hi {{name}}!", {"name": "Sam"})', "Hi Sam!")
_case("template", 'render("Hi {{name|there}}!", {"name": "Sam"})', "Hi Sam!")
_case("template", 'render("Hi {{name|there}}!", {})', "Hi there!")
_case("template", 'render("{a} {{x}}", {"x": 1})', "{a} 1")
_case("template", 'has_placeholder("Hi {{name}}!", "name")', True)

# csvline
_case("csvline", 'parse_line("a,b,c")', ["a", "b", "c"])
_case("csvline", "parse_line('\"a,b\",c')", ["a,b", "c"])
_case("csvline", "parse_line('\"a\"\"b\",x')", ['a"b', "x"])
_case("csvline", 'format_line(["a", "b,c"])', 'a,"b,c"')
_case("csvline", "format_line(['a\"b'])", '"a""b"')
_case("csvline", "field_count('\"a,b\",c,d')", 3)

# caesar
_case("caesar", 'shift_encode("abc", 1)', "bcd")
_case("caesar", 'shift_encode("xyz", 3)', "abc")
_case("caesar", 'shift_encode("Hello, World!", 5)', "Mjqqt, Btwqi!")
_case("caesar", 'shift_decode(shift_encode("Attack at dawn", 7), 7)', "Attack at dawn")
_case("caesar", 'rot13("abc")', "nop")

# intervals
_case("intervals", "merge_intervals([[1, 3], [2, 6], [8, 10]])", [[1, 6], [8, 10]])
_case("intervals", "merge_intervals([[1, 5], [5, 9]])", [[1, 9]])
_case("intervals", "merge_intervals([])", [])
_case("intervals", "merge_intervals([[1, 2], [3, 4], [5, 6]])", [[1, 2], [3, 4], [5, 6]])
_case("intervals", "total_coverage([[1, 4], [2, 6], [10, 12]])", 7)

# pathnorm
_case("pathnorm", 'normalize_path("a/./b/../c")', "a/c")
_case("pathnorm", 'normalize_path("/a/../../b")', "/b")
_case("pathnorm", 'normalize_path("../../a")', "../../a")
_case("pathnorm", 'normalize_path(".")', ".")
_case("pathnorm", 'normalize_path("/")', "/")
_case("pathnorm", 'join_paths("a", "b", "..", "c")', "a/c")

# versioncmp
_case("versioncmp", 'parse_version("1.2.3")', (1, 2, 3))
_case("versioncmp", 'compare_versions("1.9.0", "1.10.0")', -1)
_case("versioncmp", 'compare_versions("2.0.0", "2.0.0")', 0)
_case(
    "versioncmp",
    'sort_versions(["1.9.0", "1.10.0", "1.2.0"])',
    ["1.2.0", "1.9.0", "1.10.0"],
)
_case("versioncmp", 'sort_versions(["0.1.0", "0.0.9"])', ["0.0.9", "0.1.0"])
_case("versioncmp", 'max_version(["1.2.0", "1.10.0", "1.9.0"])', "1.10.0")


def build_hidden_test() -> str:
    lines = ["import sys"]
    for name in MODULE_NAMES:
        lines.append("from %s import *" % name)
    lines.append("")
    lines.append("failures = 0")
    for module, expr, expected in _CASES:
        lines.append("try:")
        lines.append("    got = %s" % expr)
        lines.append("except Exception as e:")
        lines.append("    got = 'raised %s: %s' % (type(e).__name__, e)")
        lines.append("if got != %r:" % (expected,))
        lines.append(
            "    print('FAIL [%s] %%r -> %%r (want %%r)' %% (%r, got, %r))"
            % (module, expr, expected)
        )
        lines.append("    failures += 1")
    lines.append("")
    # Canonical graded-score line the eval judge parses (partial credit even
    # on a failing exit); keep it before the human-readable verdict lines.
    lines.append("print('SCORE: %%d/%d' %% (%d - failures))" % (len(_CASES), len(_CASES)))
    lines.append("if failures:")
    lines.append("    print('%d case(s) failed' % failures)")
    lines.append("    sys.exit(1)")
    lines.append("print('all %d cases passed')" % len(_CASES))
    return "\n".join(lines) + "\n"


# ------------------------------------------------------------------- helpers


def write_files(root: pathlib.Path, files: dict) -> None:
    for name, content in files.items():
        (root / name).write_text(content, encoding="utf-8")


def run(root: pathlib.Path, script: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, script], capture_output=True, text=True, cwd=str(root)
    )


def upsert_row(row: dict) -> None:
    """Append-or-replace this script's row by id; rows stay sorted by id so
    the scenarios-long builders can run in any order and stay byte-identical
    across re-runs."""
    JSONL.parent.mkdir(parents=True, exist_ok=True)
    rows = []
    if JSONL.exists():
        for line in JSONL.read_text(encoding="utf-8").splitlines():
            if line.strip():
                rows.append(json.loads(line))
    rows = [r for r in rows if r.get("id") != row["id"]]
    rows.append(row)
    rows.sort(key=lambda r: r["id"])
    JSONL.write_text(
        "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows),
        encoding="utf-8",
    )


# ------------------------------------------------------------------------ main


def main() -> None:
    # Line-count self-check: every shipped (buggy) module must be a
    # substantial read, 70-110 lines, per the long-horizon trace-size goal.
    _bad_counts = []
    for name, content in DOZEN_BUGGY.items():
        n_lines = len(content.splitlines())
        print("  %-14s %d lines" % (name, n_lines))
        if not (70 <= n_lines <= 110):
            _bad_counts.append("%s: %d lines (want 70-110)" % (name, n_lines))
    assert not _bad_counts, "; ".join(_bad_counts)
    print("line counts OK (70-110 each)")

    hidden = build_hidden_test()
    module_tags = list(MODULE_NAMES)
    assert set(m for m, _, _ in _CASES) == set(module_tags), "case/module tag mismatch"
    counts = {}
    for m, _, _ in _CASES:
        counts[m] = counts.get(m, 0) + 1
    for m, c in counts.items():
        assert 4 <= c <= 8, "%s has %d hidden cases (want 4-8)" % (m, c)

    row = {
        "id": "sw-5-dozen",
        "task": TASK,
        "files": {**DOZEN_BUGGY, "smoke.py": SMOKE, "README.md": README},
        "judge_command": "python3 run_hidden_tests.py",
        "judge_files": {"run_hidden_tests.py": hidden},
    }

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = pathlib.Path(tmp)

        # 1. All twelve buggy: hidden suite must fail, and EVERY module's
        #    tag must show up as a failure (every bug is independently
        #    detectable by the suite).
        write_files(tmp_path, {**row["files"], **row["judge_files"]})
        buggy = run(tmp_path, "run_hidden_tests.py")
        print("=== ALL-BUGGY judge exit=%s ===" % buggy.returncode)
        print((buggy.stdout + buggy.stderr)[-1500:])
        assert buggy.returncode != 0, "shipped (all-buggy) state should FAIL the hidden suite"
        for tag in module_tags:
            assert ("FAIL [%s]" % tag) in buggy.stdout, (
                "hidden suite never catches the %s bug when all modules are buggy" % tag
            )

        buggy_smoke = run(tmp_path, "smoke.py")
        assert "ALL 12 OK" not in buggy_smoke.stdout, "smoke.py should not report ALL 12 OK yet"

        # 2. All twelve fixed: hidden suite must pass fully, smoke.py prints
        #    ALL 12 OK.
        write_files(tmp_path, DOZEN_FIXED)
        fixed = run(tmp_path, "run_hidden_tests.py")
        print("=== ALL-FIXED judge exit=%s ===" % fixed.returncode)
        print((fixed.stdout + fixed.stderr)[-400:])
        assert fixed.returncode == 0, "fully-fixed reference should PASS the hidden suite"
        assert ("all %d cases passed" % len(_CASES)) in fixed.stdout

        fixed_smoke = run(tmp_path, "smoke.py")
        assert "ALL 12 OK" in fixed_smoke.stdout, "smoke.py should print ALL 12 OK once fixed"

        # 3. Bug independence: for each module M, "only M buggy, the other
        #    eleven fixed" must fail exactly M's tag and no other tag.
        for target in module_tags:
            mix = dict(DOZEN_FIXED)
            mix[target + ".py"] = DOZEN_BUGGY[target + ".py"]
            write_files(tmp_path, mix)
            result = run(tmp_path, "run_hidden_tests.py")
            assert result.returncode != 0, (
                "isolating %s as the only buggy module should still fail" % target
            )
            assert ("FAIL [%s]" % target) in result.stdout, (
                "isolating %s as the only buggy module should fail ITS OWN tests" % target
            )
            for other in module_tags:
                if other == target:
                    continue
                assert ("FAIL [%s]" % other) not in result.stdout, (
                    "%s's bug should not affect %s's tests (independence violated)"
                    % (target, other)
                )
        print("OK: bug independence verified for all 12 modules")

    total_chars = (
        len(row["task"])
        + sum(len(c) for c in row["files"].values())
        + sum(len(c) for c in row["judge_files"].values())
    )
    print("sw-5-dozen total content: %d chars" % total_chars)
    assert total_chars > 60000, "sw-5-dozen content must exceed 60,000 chars, got %d" % total_chars

    upsert_row(row)
    print(
        "OK: sw-5-dozen upserted; all-buggy FAILS (%d cases, all 12 tags) / "
        "all-fixed PASSES / bug independence verified / %d chars total"
        % (len(_CASES), total_chars)
    )


if __name__ == "__main__":
    main()
