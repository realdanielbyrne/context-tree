"""Deterministic LHTB importer tests; python3 -m unittest discover -s eval/test -p '*_test.py'."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("lhtb_importer", Path(__file__).parents[1] / "scripts/import-lhtb.py")
IMPORTER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(IMPORTER)

TASK = '''schema_version = "1.1"
artifacts = [
  "outputs/report.json",
  "/app/src",
]

[task]
name = "long-horizon-terminal-bench/example"
description = "An example long-horizon task."

[metadata]
difficulty = "hard"
category = "software-engineering"
expert_time_estimate_min = 120.0

[verifier]
timeout_sec = 900.0

[agent]
timeout_sec = 3600.0
continue_until_timeout = true

[environment]
build_timeout_sec = 1800.0
docker_image = "public-image:version"
cpus = 2
memory_mb = 4096
storage_mb = 8192
gpus = 0
allow_internet = true
'''

SEPARATE = TASK.replace(
    "[verifier]\ntimeout_sec = 900.0\n",
    '''[verifier]
timeout_sec = 900.0
environment_mode = "separate"

[verifier.environment]
build_timeout_sec = 1800.0
docker_image = "public-verifier:version"
cpus = 2
memory_mb = 4096
allow_internet = false
''',
)

FILES = {
    "task.toml": TASK,
    "instruction.md": "Produce the required artifacts.",
    "environment/Dockerfile": "FROM python:3.11-slim",
    "environment/project/src/app.py": "print('hi')",
    "tests/test.sh": "echo 0.5 > /logs/verifier/reward.txt",
    "tests/test_outputs.py": "# hidden verifier",
    "solution/solve.sh": "cp /solution/files/app.py /app/src/app.py",
    "solution/files/app.py": "the reference answer",
}


def checkout(overrides=None, task_id="example"):
    """A task directory laid out like an LHTB checkout, without a Git repo."""
    files = dict(FILES)
    files.update(overrides or {})
    root = Path(tempfile.mkdtemp())
    for name, content in files.items():
        if content is None:
            continue
        path = root / "tasks" / task_id / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
    return root


def run(root, task_ids=("example",), output=None):
    """verify_git=False: these fixtures are not Git checkouts."""
    return IMPORTER.import_tasks(root, output or Path(tempfile.mkdtemp()) / "out", list(task_ids), verify_git=False)


class ImporterTests(unittest.TestCase):
    def test_materializes_the_task_without_the_reference_solution(self):
        output = Path(tempfile.mkdtemp()) / "out"
        manifest = run(checkout(), output=output)
        task = manifest["tasks"][0]
        self.assertEqual(task["id"], "example")
        self.assertTrue((output / "tasks/example/tests/test.sh").exists())
        # The reference answer is recorded but never written where an agent could read it.
        self.assertFalse((output / "tasks/example/solution").exists())
        self.assertIn("solution/solve.sh", task["solutionFiles"])
        self.assertIn("solution/files/app.py", task["solutionFiles"])
        self.assertNotIn("solution/solve.sh", task["files"])

    def test_preserves_the_submission_contract_and_every_runtime_budget(self):
        task = run(checkout())["tasks"][0]
        self.assertEqual(task["artifacts"], ["outputs/report.json", "/app/src"])
        self.assertEqual(task["image"], "public-image:version")
        self.assertEqual((task["cpus"], task["memoryMb"], task["storageMb"]), (2, 4096, 8192))
        self.assertTrue(task["allowInternet"])
        self.assertEqual(task["agentTimeoutSec"], 3600.0)
        self.assertTrue(task["continueUntilTimeout"])
        self.assertEqual(task["verifierTimeoutSec"], 900.0)
        self.assertEqual(task["expertTimeEstimateMin"], 120.0)
        self.assertEqual(task["difficulty"], "hard")
        self.assertEqual(task["category"], "software-engineering")
        # A shared-environment task's verifier inherits [environment].
        self.assertEqual(task["verifierMode"], "shared")
        self.assertEqual(task["verifierImage"], "public-image:version")
        self.assertTrue(task["verifierAllowInternet"])

    def test_reads_the_separate_verifier_environment_when_declared(self):
        task = run(checkout({"task.toml": SEPARATE}))["tasks"][0]
        self.assertEqual(task["verifierMode"], "separate")
        self.assertEqual(task["verifierImage"], "public-verifier:version")
        self.assertFalse(task["verifierAllowInternet"])
        self.assertTrue(task["allowInternet"])

    def test_source_hash_covers_the_solution_and_changes_with_any_byte(self):
        first = run(checkout())["tasks"][0]["sourceHash"]
        self.assertEqual(first, run(checkout())["tasks"][0]["sourceHash"])
        changed = run(checkout({"solution/files/app.py": "a different answer"}))["tasks"][0]["sourceHash"]
        self.assertNotEqual(first, changed)
        self.assertEqual(len(first), 64)

    def test_missing_or_malformed_keys_name_the_file_and_the_key(self):
        cases = [
            ("artifacts", TASK.replace('artifacts = [\n  "outputs/report.json",\n  "/app/src",\n]', "artifacts = []")),
            ("environment.docker_image", TASK.replace('docker_image = "public-image:version"\n', "")),
            ("environment.allow_internet", TASK.replace("allow_internet = true", "allow_internet = 1")),
            ("agent.continue_until_timeout", TASK.replace("continue_until_timeout = true", "continue_until_timeout = 1")),
            ("environment.cpus", TASK.replace("cpus = 2", "cpus = 0")),
            ("metadata.expert_time_estimate_min", TASK.replace("expert_time_estimate_min = 120.0\n", "")),
            ("verifier.timeout_sec", TASK.replace("[verifier]\ntimeout_sec = 900.0", "[verifier]")),
            ("task.name", TASK.replace('name = "long-horizon-terminal-bench/example"', 'name = ""')),
            ("schema_version", TASK.replace('schema_version = "1.1"', 'schema_version = "2.0"')),
        ]
        for key, text in cases:
            with self.subTest(key=key), self.assertRaises(ValueError) as caught:
                run(checkout({"task.toml": text}))
            self.assertIn("tasks/example/task.toml", str(caught.exception))
            self.assertIn(key.split(".")[-1], str(caught.exception))

    def test_missing_required_task_files_are_named_not_skipped(self):
        for name in ("instruction.md", "environment/Dockerfile", "tests/test.sh", "solution/solve.sh"):
            with self.subTest(name=name), self.assertRaises(ValueError) as caught:
                run(checkout({name: None}))
            self.assertIn(f"tasks/example/{name}", str(caught.exception))

    def test_rejects_unexpected_files_symlinks_and_traversing_artifacts(self):
        with self.assertRaisesRegex(ValueError, "unexpected files"):
            run(checkout({"scratch/notes.txt": "stray"}))
        with self.assertRaisesRegex(ValueError, r"must not contain '\.\.'"):
            run(checkout({"task.toml": TASK.replace('"outputs/report.json"', '"../../etc/passwd"')}))
        root = checkout()
        (root / "tasks/example/tests/link").symlink_to("/tmp")
        with self.assertRaisesRegex(ValueError, "symlink forbidden"):
            run(root)

    def test_refuses_a_silent_glob_and_writes_nothing_on_any_failure(self):
        with self.assertRaisesRegex(ValueError, "--tasks is required"):
            run(checkout(), task_ids=())
        with self.assertRaisesRegex(ValueError, "no such task directory"):
            run(checkout(), task_ids=("absent",))
        output = Path(tempfile.mkdtemp()) / "out"
        with self.assertRaises(ValueError):
            run(checkout({"tests/test.sh": None}), output=output)
        self.assertFalse(output.exists())

    def test_manifest_is_json_and_pins_the_official_repository(self):
        output = Path(tempfile.mkdtemp()) / "out"
        run(checkout(), output=output)
        manifest = json.loads((output / "manifest.json").read_text())
        self.assertEqual(manifest["benchmark"], "lhtb")
        self.assertEqual(manifest["schemaVersion"], 1)
        self.assertEqual(manifest["source"]["repository"], IMPORTER.REPOSITORY)


if __name__ == "__main__":
    unittest.main()
