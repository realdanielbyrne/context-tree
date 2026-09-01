#!/usr/bin/env python3
"""Self-verifying generator for sw-4-bughunt (the symptom-driven debugging task).

The diverse-shapes suite (eval/scenarios-diverse) needs a task where the work
is LOCALIZATION, not implementation: sw-1/sw-2 tell the agent which file is
broken; here a five-stage pipeline (logparse -> transform -> validate ->
aggregate -> report) ships with exactly TWO subtle defects in two different
stages, and the task only describes the observed end-to-end symptoms, bug-
report style. The agent must reproduce, trace the pipeline stage by stage,
localize both defects, and fix them — a long diagnose-heavy phase texture.

The two planted defects:
  - data corruption (transform.py): str.rstrip("_raw") strips a CHARACTER SET,
    not a suffix — "sonar_raw" -> "son" while "pump_raw" -> "pump" survives by
    accident, so only SOME normalized sensors get mangled and mis-grouped;
  - boundary condition (validate.py): exclusive comparison drops readings that
    sit exactly on an inclusive min/max limit.

Same contract as build-multimod-scenario.py:
  - ships the buggy pipeline, asserts the hidden suite FAILS it — and that the
    failures localize correctly: transform/validate/e2e modules FAIL while the
    three clean stages PASS (proving there are exactly two buggy files);
  - writes reference fixes for only those two files, asserts the hidden suite
    PASSES and run_pipeline.py reproduces expected_output.txt byte-for-byte;
  - only then upserts the single row into the scenarios-diverse JSONL
    (append-or-replace by id, rows sorted by id, so reruns are byte-identical).
"""

import json
import pathlib
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
JSONL = (
    HERE.parent
    / "scenarios-diverse"
    / "deepswe-agents-last-exam"
    / "agents-last-exam.jsonl"
)

# ------------------------------------------------------------- shipped stages

SHIPPED_LOGPARSE = '''\
"""Stage 1 of the sensorlog pipeline: raw text -> record dicts.

A log line is "<day> <sensor> <value>", whitespace separated, e.g.
"2024-01-15 tank_a 12.5". Blank lines and lines starting with "#" are
skipped. Any other malformed line raises ValueError naming the line.

Record shape (used by every later stage):
    {"day": str, "sensor": str, "value": float}
"""


def parse_line(line):
    parts = line.split()
    if len(parts) != 3:
        raise ValueError("malformed log line: %r" % line)
    day, sensor, raw_value = parts
    try:
        value = float(raw_value)
    except ValueError:
        raise ValueError("malformed log line: %r" % line)
    return {"day": day, "sensor": sensor, "value": value}


def parse_log(text):
    records = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        records.append(parse_line(stripped))
    return records
'''

# The data-corruption defect lives here: rstrip("_raw") strips a trailing
# CHARACTER SET {_, r, a, w}, not the literal suffix.
SHIPPED_TRANSFORM = '''\
"""Stage 2: unit normalization.

Sensors logged under a name ending in "_raw" report millivolts; every
other sensor already reports engineering units. normalize() divides each
_raw reading by 1000.0 and drops the "_raw" suffix from the sensor name,
so downstream stages only ever see engineering units. The input list is
never mutated.
"""


def normalize(records):
    out = []
    for r in records:
        if r["sensor"].endswith("_raw"):
            out.append(
                {
                    "day": r["day"],
                    "sensor": r["sensor"].rstrip("_raw"),
                    "value": r["value"] / 1000.0,
                }
            )
        else:
            out.append(dict(r))
    return out
'''

# The boundary defect lives here: exclusive < where the README documents
# inclusive limits.
SHIPPED_VALIDATE = '''\
"""Stage 3: range validation.

validate_records(records, min_value, max_value) keeps in-range records
(in their original order) and counts the rest:

    returns (kept_records, rejected_count)

See README.md for the range contract.
"""


def validate_records(records, min_value, max_value):
    kept = []
    rejected = 0
    for r in records:
        if min_value < r["value"] < max_value:
            kept.append(r)
        else:
            rejected += 1
    return kept, rejected
'''

SHIPPED_AGGREGATE = '''\
"""Stage 4: per-day, per-sensor statistics.

daily_stats(records) -> {(day, sensor): {"count": int, "min": float,
"max": float, "mean": float}} where mean is the exact float sum/count
(rendering and rounding are stage 5's job).
"""


def daily_stats(records):
    groups = {}
    for r in records:
        groups.setdefault((r["day"], r["sensor"]), []).append(r["value"])
    stats = {}
    for key, values in groups.items():
        stats[key] = {
            "count": len(values),
            "min": min(values),
            "max": max(values),
            "mean": sum(values) / len(values),
        }
    return stats
'''

SHIPPED_REPORT = '''\
"""Stage 5: render the stats as a plain-text report.

One line per (day, sensor) group, sorted by day then sensor:

    "<day> <sensor> n=<count> min=<min> max=<max> mean=<mean>"

with min/max/mean formatted to three decimals. Lines are joined with a
single newline and there is no trailing newline.
"""


def format_report(stats):
    lines = []
    for (day, sensor) in sorted(stats):
        s = stats[(day, sensor)]
        lines.append(
            "%s %s n=%d min=%.3f max=%.3f mean=%.3f"
            % (day, sensor, s["count"], s["min"], s["max"], s["mean"])
        )
    return "\\n".join(lines)
'''

RUN_PIPELINE = '''\
"""Run the whole sensorlog pipeline on a log file.

Usage: python3 run_pipeline.py [logfile]      (default: sample_log.txt)

Stages: logparse.parse_log -> transform.normalize ->
validate.validate_records -> aggregate.daily_stats ->
report.format_report, then a final "rejected=<n>" line.

With the pipeline working correctly, the output for sample_log.txt is
exactly the contents of expected_output.txt.
"""

import sys

from aggregate import daily_stats
from logparse import parse_log
from report import format_report
from transform import normalize
from validate import validate_records

MIN_VALUE = 0.0
MAX_VALUE = 100.0


def run(text, min_value=MIN_VALUE, max_value=MAX_VALUE):
    records = parse_log(text)
    records = normalize(records)
    kept, rejected = validate_records(records, min_value, max_value)
    stats = daily_stats(kept)
    return format_report(stats) + "\\nrejected=%d" % rejected


if __name__ == "__main__":
    path = sys.argv[1] if len(sys.argv) > 1 else "sample_log.txt"
    with open(path, "r", encoding="utf-8") as f:
        print(run(f.read()))
'''

SAMPLE_LOG = """\
# fleet sensor log, week 3
2024-01-15 tank_a 12.5
2024-01-15 sonar_raw 1500
2024-01-15 tank_a 99.9
2024-01-15 sonar_raw 2500
2024-01-16 pump 0.0
2024-01-16 tank_a 100.0
2024-01-16 sonar_raw 1000
2024-01-16 pump 55.5
2024-01-17 pump 101.5
"""

EXPECTED_OUTPUT = """\
2024-01-15 sonar n=2 min=1.500 max=2.500 mean=2.000
2024-01-15 tank_a n=2 min=12.500 max=99.900 mean=56.200
2024-01-16 pump n=2 min=0.000 max=55.500 mean=27.750
2024-01-16 sonar n=1 min=1.000 max=1.000 mean=1.000
2024-01-16 tank_a n=1 min=100.000 max=100.000 mean=100.000
rejected=1
"""

README = """\
# sensorlog

A five-stage pipeline that turns raw sensor logs into a daily report:

1. `logparse.py`  — text -> records `{"day", "sensor", "value"}`
2. `transform.py` — `_raw` sensors: value / 1000, `_raw` suffix dropped
3. `validate.py`  — range check; limits are INCLUSIVE (a reading exactly
                    at min or max is valid and must be kept)
4. `aggregate.py` — per (day, sensor): count / min / max / mean
5. `report.py`    — sorted plain-text report

Driver: `python3 run_pipeline.py sample_log.txt`
Correct output for the sample log: `expected_output.txt`
"""

# ------------------------------------------------------------ reference fixes

FIXED_TRANSFORM = '''\
"""Stage 2: unit normalization.

Sensors logged under a name ending in "_raw" report millivolts; every
other sensor already reports engineering units. normalize() divides each
_raw reading by 1000.0 and drops the "_raw" suffix from the sensor name,
so downstream stages only ever see engineering units. The input list is
never mutated.
"""


def normalize(records):
    out = []
    for r in records:
        if r["sensor"].endswith("_raw"):
            out.append(
                {
                    "day": r["day"],
                    "sensor": r["sensor"][: -len("_raw")],
                    "value": r["value"] / 1000.0,
                }
            )
        else:
            out.append(dict(r))
    return out
'''

FIXED_VALIDATE = '''\
"""Stage 3: range validation.

validate_records(records, min_value, max_value) keeps in-range records
(in their original order) and counts the rest:

    returns (kept_records, rejected_count)

See README.md for the range contract.
"""


def validate_records(records, min_value, max_value):
    kept = []
    rejected = 0
    for r in records:
        if min_value <= r["value"] <= max_value:
            kept.append(r)
        else:
            rejected += 1
    return kept, rejected
'''

# --------------------------------------------------------------- hidden tests

HIDDEN_LOGPARSE = '''\
import unittest

from logparse import parse_line, parse_log


class TestParseLine(unittest.TestCase):
    def test_basic_line(self):
        self.assertEqual(
            parse_line("2024-01-15 tank_a 12.5"),
            {"day": "2024-01-15", "sensor": "tank_a", "value": 12.5},
        )

    def test_malformed_field_count(self):
        with self.assertRaises(ValueError):
            parse_line("2024-01-15 tank_a")

    def test_malformed_value(self):
        with self.assertRaises(ValueError):
            parse_line("2024-01-15 tank_a twelve")


class TestParseLog(unittest.TestCase):
    def test_skips_blanks_and_comments(self):
        text = "# header\\n\\n2024-01-15 a 1.0\\n   \\n2024-01-15 b 2.0\\n"
        self.assertEqual(len(parse_log(text)), 2)

    def test_preserves_order(self):
        text = "2024-01-15 b 2.0\\n2024-01-15 a 1.0"
        self.assertEqual([r["sensor"] for r in parse_log(text)], ["b", "a"])


if __name__ == "__main__":
    unittest.main()
'''

HIDDEN_TRANSFORM = '''\
import unittest

from transform import normalize


class TestNormalize(unittest.TestCase):
    def test_suffix_dropped_exactly_once(self):
        recs = normalize([{"day": "d", "sensor": "sonar_raw", "value": 1500.0}])
        self.assertEqual(recs[0]["sensor"], "sonar")

    def test_name_ending_in_suffix_letters_survives(self):
        recs = normalize([{"day": "d", "sensor": "extra_raw", "value": 1000.0}])
        self.assertEqual(recs[0]["sensor"], "extra")

    def test_value_scaled(self):
        recs = normalize([{"day": "d", "sensor": "a_raw", "value": 1500.0}])
        self.assertEqual(recs[0]["value"], 1.5)

    def test_non_raw_untouched(self):
        rec = {"day": "d", "sensor": "pump", "value": 42.0}
        self.assertEqual(normalize([rec]), [rec])

    def test_input_not_mutated(self):
        rec = {"day": "d", "sensor": "sonar_raw", "value": 1500.0}
        normalize([rec])
        self.assertEqual(rec, {"day": "d", "sensor": "sonar_raw", "value": 1500.0})


if __name__ == "__main__":
    unittest.main()
'''

HIDDEN_VALIDATE = '''\
import unittest

from validate import validate_records


def rec(value):
    return {"day": "2024-01-15", "sensor": "s", "value": value}


class TestValidateRecords(unittest.TestCase):
    def test_keeps_reading_exactly_at_max(self):
        kept, rejected = validate_records([rec(100.0)], 0.0, 100.0)
        self.assertEqual((len(kept), rejected), (1, 0))

    def test_keeps_reading_exactly_at_min(self):
        kept, rejected = validate_records([rec(0.0)], 0.0, 100.0)
        self.assertEqual((len(kept), rejected), (1, 0))

    def test_rejects_out_of_range(self):
        kept, rejected = validate_records([rec(-0.1), rec(100.1)], 0.0, 100.0)
        self.assertEqual((len(kept), rejected), (0, 2))

    def test_keeps_order_and_counts(self):
        records = [rec(5.0), rec(101.0), rec(7.0)]
        kept, rejected = validate_records(records, 0.0, 100.0)
        self.assertEqual([r["value"] for r in kept], [5.0, 7.0])
        self.assertEqual(rejected, 1)


if __name__ == "__main__":
    unittest.main()
'''

HIDDEN_AGGREGATE = '''\
import unittest

from aggregate import daily_stats


class TestDailyStats(unittest.TestCase):
    def test_groups_by_day_and_sensor(self):
        records = [
            {"day": "d1", "sensor": "a", "value": 1.0},
            {"day": "d1", "sensor": "a", "value": 3.0},
            {"day": "d2", "sensor": "a", "value": 5.0},
        ]
        stats = daily_stats(records)
        self.assertEqual(set(stats), {("d1", "a"), ("d2", "a")})
        self.assertEqual(stats[("d1", "a")]["count"], 2)

    def test_min_max_mean(self):
        stats = daily_stats(
            [
                {"day": "d", "sensor": "a", "value": 2.0},
                {"day": "d", "sensor": "a", "value": 4.0},
                {"day": "d", "sensor": "a", "value": 9.0},
            ]
        )
        s = stats[("d", "a")]
        self.assertEqual((s["min"], s["max"]), (2.0, 9.0))
        self.assertAlmostEqual(s["mean"], 5.0)

    def test_all_negative_values(self):
        stats = daily_stats(
            [
                {"day": "d", "sensor": "f", "value": -8.0},
                {"day": "d", "sensor": "f", "value": -2.0},
            ]
        )
        s = stats[("d", "f")]
        self.assertEqual((s["min"], s["max"]), (-8.0, -2.0))


if __name__ == "__main__":
    unittest.main()
'''

HIDDEN_REPORT = '''\
import unittest

from report import format_report


class TestFormatReport(unittest.TestCase):
    def test_line_format_and_rounding(self):
        stats = {("2024-01-15", "a"): {"count": 2, "min": 1.5, "max": 2.5, "mean": 2.0}}
        self.assertEqual(
            format_report(stats),
            "2024-01-15 a n=2 min=1.500 max=2.500 mean=2.000",
        )

    def test_sorted_by_day_then_sensor(self):
        stats = {
            ("2024-01-16", "a"): {"count": 1, "min": 1.0, "max": 1.0, "mean": 1.0},
            ("2024-01-15", "b"): {"count": 1, "min": 2.0, "max": 2.0, "mean": 2.0},
            ("2024-01-15", "a"): {"count": 1, "min": 3.0, "max": 3.0, "mean": 3.0},
        }
        out = format_report(stats).splitlines()
        self.assertEqual(
            [line.split(" n=")[0] for line in out],
            ["2024-01-15 a", "2024-01-15 b", "2024-01-16 a"],
        )

    def test_no_trailing_newline(self):
        stats = {("d", "a"): {"count": 1, "min": 1.0, "max": 1.0, "mean": 1.0}}
        self.assertFalse(format_report(stats).endswith("\\n"))


if __name__ == "__main__":
    unittest.main()
'''

HIDDEN_E2E = '''\
import unittest

from run_pipeline import run

LOG_A = "\\n".join(
    [
        "# shift log",
        "2024-02-01 extra_raw 1500",
        "2024-02-01 pump_raw 2000",
        "2024-02-01 tank_b 100.0",
        "2024-02-02 tank_b 0.0",
        "2024-02-02 extra_raw 500",
        "2024-02-02 tank_b 250.0",
    ]
)


class TestEndToEnd(unittest.TestCase):
    def test_full_report(self):
        expected = "\\n".join(
            [
                "2024-02-01 extra n=1 min=1.500 max=1.500 mean=1.500",
                "2024-02-01 pump n=1 min=2.000 max=2.000 mean=2.000",
                "2024-02-01 tank_b n=1 min=100.000 max=100.000 mean=100.000",
                "2024-02-02 extra n=1 min=0.500 max=0.500 mean=0.500",
                "2024-02-02 tank_b n=1 min=0.000 max=0.000 mean=0.000",
                "rejected=1",
            ]
        )
        self.assertEqual(run(LOG_A), expected)

    def test_boundary_readings_survive(self):
        out = run("2024-03-01 t 100.0\\n2024-03-01 t 0.0")
        self.assertIn("n=2", out)
        self.assertTrue(out.endswith("rejected=0"))

    def test_mangling_prone_names_survive(self):
        out = run("2024-03-01 sonar_raw 1500\\n2024-03-01 warm_raw 2000")
        self.assertIn("sonar ", out)
        self.assertIn("warm ", out)


if __name__ == "__main__":
    unittest.main()
'''

BUGGY_HIDDEN_MODULES = (
    "hidden_test_transform",
    "hidden_test_validate",
    "hidden_test_e2e",
)
CLEAN_HIDDEN_MODULES = (
    "hidden_test_logparse",
    "hidden_test_aggregate",
    "hidden_test_report",
)

RUNNER = '''\
"""Hidden judge runner: run every hidden unittest module; exit 0 iff all pass."""

import sys
import unittest

MODULES = [
    "hidden_test_logparse",
    "hidden_test_transform",
    "hidden_test_validate",
    "hidden_test_aggregate",
    "hidden_test_report",
    "hidden_test_e2e",
]


def main():
    failed = []
    total = 0
    for name in MODULES:
        suite = unittest.defaultTestLoader.loadTestsFromName(name)
        result = unittest.TextTestRunner(stream=sys.stderr, verbosity=0).run(suite)
        total += result.testsRun
        ok = result.wasSuccessful()
        print("[%s] %s (%d tests)" % (name, "PASS" if ok else "FAIL", result.testsRun))
        if not ok:
            failed.append(name)
    if failed:
        print(
            "%d of %d hidden module(s) failed: %s"
            % (len(failed), len(MODULES), ", ".join(failed))
        )
        sys.exit(1)
    print("all %d hidden tests passed" % total)


if __name__ == "__main__":
    main()
'''

TASK = """\
The working directory contains `sensorlog`, a five-stage pipeline —
`logparse.py`, `transform.py`, `validate.py`, `aggregate.py`,
`report.py` (see README.md) — driven by `run_pipeline.py`.

Bug report from the field:

1. Some `_raw` sensors come out of the daily report with mangled names —
   the sample log's `sonar_raw` shows up as `son` instead of `sonar`, so
   its readings land under the wrong sensor name. Oddly, other `_raw`
   sensors are unaffected (a `pump_raw` unit tested fine at the bench).
2. Readings exactly equal to a configured limit disappear: the sample
   log has a `tank_a 100.0` and a `pump 0.0` reading, both valid under
   the inclusive 0..100 limits, yet the report drops them and the
   rejected count is 3 when it should be 1.

Exactly two defects, in two different stage files, cause both symptoms.
Reproduce them first: run `python3 run_pipeline.py sample_log.txt` and
compare against `expected_output.txt`. Then localize each symptom to its
stage — read the stage files and test stages in isolation as needed —
fix both defects, and re-run the driver.

Do not modify run_pipeline.py, sample_log.txt, or expected_output.txt,
and do not change any public function signature or the record shape.

You are done when `python3 run_pipeline.py sample_log.txt` prints
exactly the contents of expected_output.txt. Then reply DONE.
"""


def write_files(root: pathlib.Path, files: dict) -> None:
    for name, content in files.items():
        (root / name).write_text(content, encoding="utf-8")


def run_script(root: pathlib.Path, *argv: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, *argv], capture_output=True, text=True, cwd=str(root)
    )


def upsert_row(row: dict) -> None:
    """Append-or-replace this script's row by id; rows stay sorted by id so
    running the diverse builders in any order yields byte-identical output."""
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


def main() -> None:
    row = {
        "id": "sw-4-bughunt",
        "task": TASK,
        "files": {
            "logparse.py": SHIPPED_LOGPARSE,
            "transform.py": SHIPPED_TRANSFORM,
            "validate.py": SHIPPED_VALIDATE,
            "aggregate.py": SHIPPED_AGGREGATE,
            "report.py": SHIPPED_REPORT,
            "run_pipeline.py": RUN_PIPELINE,
            "sample_log.txt": SAMPLE_LOG,
            "expected_output.txt": EXPECTED_OUTPUT,
            "README.md": README,
        },
        "judge_command": "python3 run_hidden_tests.py",
        "judge_files": {
            "run_hidden_tests.py": RUNNER,
            "hidden_test_logparse.py": HIDDEN_LOGPARSE,
            "hidden_test_transform.py": HIDDEN_TRANSFORM,
            "hidden_test_validate.py": HIDDEN_VALIDATE,
            "hidden_test_aggregate.py": HIDDEN_AGGREGATE,
            "hidden_test_report.py": HIDDEN_REPORT,
            "hidden_test_e2e.py": HIDDEN_E2E,
        },
    }

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = pathlib.Path(tmp)
        write_files(tmp_path, {**row["files"], **row["judge_files"]})

        buggy = run_script(tmp_path, "run_hidden_tests.py")
        print("=== BUGGY judge exit=%s ===" % buggy.returncode)
        print((buggy.stdout + buggy.stderr)[-1200:])
        buggy_pipe = run_script(tmp_path, "run_pipeline.py")

        write_files(
            tmp_path,
            {"transform.py": FIXED_TRANSFORM, "validate.py": FIXED_VALIDATE},
        )
        fixed = run_script(tmp_path, "run_hidden_tests.py")
        print("=== FIXED judge exit=%s ===" % fixed.returncode)
        print((fixed.stdout + fixed.stderr)[-400:])
        fixed_pipe = run_script(tmp_path, "run_pipeline.py")

    assert buggy.returncode != 0, "shipped pipeline should FAIL the hidden suite"
    # The failures must localize to exactly the two planted defects: the two
    # buggy stages (plus e2e) fail, the three clean stages already pass.
    for name in BUGGY_HIDDEN_MODULES:
        assert ("[%s] FAIL" % name) in buggy.stdout, (
            "hidden suite never catches the planted bug behind %s" % name
        )
    for name in CLEAN_HIDDEN_MODULES:
        assert ("[%s] PASS" % name) in buggy.stdout, (
            "%s should already pass on the shipped code — only two files are buggy"
            % name
        )
    assert buggy_pipe.returncode == 0, (
        "buggy pipeline should still RUN (the bugs corrupt output, not crash)"
    )
    assert buggy_pipe.stdout != EXPECTED_OUTPUT, (
        "the planted bugs must visibly corrupt the sample report"
    )
    assert fixed.returncode == 0, "reference fixes should PASS the hidden suite"
    assert fixed_pipe.stdout == EXPECTED_OUTPUT, (
        "reference pipeline must reproduce expected_output.txt exactly"
    )

    upsert_row(row)
    total_chars = (
        len(row["task"])
        + sum(len(c) for c in row["files"].values())
        + sum(len(c) for c in row["judge_files"].values())
    )
    print(
        "OK: sw-4-bughunt upserted; buggy FAILS (transform/validate/e2e) with clean "
        "stages passing / fixed PASSES; %d chars total content" % total_chars
    )


if __name__ == "__main__":
    main()
