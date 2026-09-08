"""Deterministic importer tests; python3 -m unittest discover -s eval/test -p '*_test.py'."""
import hashlib
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("deepswe_importer", Path(__file__).parents[1] / "scripts/import-deepswe.py")
IMPORTER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(IMPORTER)
BASE = "a" * 40
TASK = f'''schema_version = "1.3"
[metadata]
task_id = "example"
base_commit_hash = "{BASE}"
repository_url = "https://github.com/example/repo"
language = "go"
[environment]
docker_image = "public-image:version"
cpus = 2
memory_mb = 8192
[agent]
network_mode = "no-network"
[verifier]
environment_mode = "separate"
network_mode = "no-network"
timeout_sec = 1800
[verifier.environment]
build_timeout_sec = 1800
cpus = 2
memory_mb = 8192
[[verifier.collect]]
command = "git diff --binary {BASE} HEAD > /logs/artifacts/model.patch"
timeout_sec = 300
'''


def archive(overrides=None, extra=None):
    files = {"task.toml": TASK, "instruction.md": "Implement behavior.",
             "environment/Dockerfile": "FROM public-image:version",
             "tests/Dockerfile": "FROM public-image:version", "tests/test.sh": "exit 0",
             "tests/grader.py": "# verifier", "tests/config.json": "{}", "tests/test.patch": "patch",
             "solution/solution.patch": "secret reference"}
    files.update(overrides or {})
    root = "datacurve-ai-deep-swe-" + IMPORTER.PIN[:7]
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as out:
        for name, content in files.items():
            encoded = content.encode()
            info = tarfile.TarInfo(f"{root}/tasks/example/{name}")
            info.size = len(encoded)
            out.addfile(info, io.BytesIO(encoded))
        if extra:
            out.addfile(extra)
    return buffer.getvalue()


class ImporterTests(unittest.TestCase):
    def test_materializes_pinned_task_without_reference_solution(self):
        with tempfile.TemporaryDirectory() as folder:
            data = archive()
            manifest = IMPORTER.import_archive(data, IMPORTER.PIN, folder)
            self.assertEqual(len(manifest["tasks"]), 1)
            self.assertEqual(manifest["source"]["archiveSha256"], hashlib.sha256(data).hexdigest())
            self.assertFalse((Path(folder) / "tasks/example/solution").exists())
            self.assertTrue((Path(folder) / "tasks/example/tests/test.sh").exists())

    def test_rejects_floating_revision_and_wrong_archive_root(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(ValueError, "immutable"):
                IMPORTER.import_archive(archive(), "main", folder)
            with self.assertRaisesRegex(ValueError, "archive root"):
                IMPORTER.import_archive(archive(), "f" * 40, folder)

    def test_rejects_nonisolated_verifier_before_writing_anything(self):
        with tempfile.TemporaryDirectory() as folder:
            data = archive({"task.toml": TASK.replace('environment_mode = "separate"', 'environment_mode = "same"')})
            with self.assertRaisesRegex(ValueError, "independent verifier"):
                IMPORTER.import_archive(data, IMPORTER.PIN, folder)
            self.assertEqual(list(Path(folder).iterdir()), [])

    def test_rejects_task_symlinks_and_traversal(self):
        for name in ["tasks/example/tests/link", "tasks/example/../../escape"]:
            entry = tarfile.TarInfo("datacurve-ai-deep-swe-" + IMPORTER.PIN[:7] + "/" + name)
            entry.type = tarfile.SYMTYPE
            entry.linkname = "/tmp"
            with tempfile.TemporaryDirectory() as folder:
                with self.assertRaises(ValueError):
                    IMPORTER.import_archive(archive(extra=entry), IMPORTER.PIN, folder)

    def test_preserves_official_abbreviated_base_for_runtime_resolution(self):
        with tempfile.TemporaryDirectory() as folder:
            manifest = IMPORTER.import_archive(archive({"task.toml": TASK.replace(BASE, BASE[:7])}), IMPORTER.PIN, folder)
            self.assertEqual(manifest["tasks"][0]["baseCommit"], BASE[:7])


if __name__ == "__main__":
    unittest.main()
