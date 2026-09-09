#!/usr/bin/env python3
"""Import Long-Horizon-Terminal-Bench (LHTB) tasks; never expose solution/ to agents.

LHTB's submission contract is a file list (`artifacts` in task.toml), not a git
commit, and its verifier writes a DENSE reward (passed/total) to
/logs/verifier/reward.txt. Both facts are carried into the manifest so the
adapter never has to re-read task.toml at runtime.

Example:
  python3 eval/scripts/import-lhtb.py \
      --source-dir /path/to/LHTB --output eval/scenarios/lhtb \
      --tasks great-expectations-audit,langchain-version-migration

Every field this harness depends on is required. A missing or malformed key
raises ValueError naming the file and the key -- a task is never silently
skipped, because a benchmark that quietly dropped a task would report an A/B on
a different task set than the one claimed.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tomllib

REPOSITORY = "https://github.com/zli12321/LHTB.git"
# Files the agent and the verifier may see. solution/ is deliberately absent.
PUBLIC_PREFIXES = ("environment/", "tests/")
PUBLIC_FILES = ("task.toml", "instruction.md")
TASK_ID = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]*$")


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class TaskError(ValueError):
    """Fail-loud error naming the offending file and key."""

    def __init__(self, where: str, message: str) -> None:
        super().__init__(f"{where}: {message}")


def _section(doc, where, key):
    value = doc.get(key)
    if not isinstance(value, dict):
        raise TaskError(where, f"missing or non-table section [{key}]")
    return value


def _required(table, where, section, key, kinds, predicate=None, hint=""):
    if key not in table:
        raise TaskError(where, f"missing required key {section}.{key}")
    value = table[key]
    if isinstance(value, bool) != (kinds is bool):
        raise TaskError(where, f"{section}.{key} must be {getattr(kinds, '__name__', kinds)}, got {value!r}")
    if not isinstance(value, kinds):
        raise TaskError(where, f"{section}.{key} must be {getattr(kinds, '__name__', kinds)}, got {value!r}")
    if predicate is not None and not predicate(value):
        raise TaskError(where, f"{section}.{key} is out of range: {value!r}{hint}")
    return value


def _positive(table, where, section, key):
    return _required(table, where, section, key, (int, float), lambda v: v > 0, " (must be > 0)")


def _nonnegative(table, where, section, key):
    return _required(table, where, section, key, (int, float), lambda v: v >= 0, " (must be >= 0)")


def _text(table, where, section, key):
    return _required(table, where, section, key, str, lambda v: v.strip() != "", " (must be nonempty)")


def scan_files(task_dir: Path, task_id: str) -> dict[str, bytes]:
    """Every regular file under the task dir, keyed by POSIX-relative path.

    A symlink is a hard error: it could point the verifier build context or the
    agent container at host state outside the import.
    """
    files: dict[str, bytes] = {}
    for path in sorted(task_dir.rglob("*")):
        relative = path.relative_to(task_dir).as_posix()
        if path.is_symlink():
            raise TaskError(f"tasks/{task_id}/{relative}", "symlink forbidden inside a task directory")
        if path.is_dir():
            continue
        if not path.is_file():
            raise TaskError(f"tasks/{task_id}/{relative}", "not a regular file")
        if ".." in PurePosixPath(relative).parts:
            raise TaskError(f"tasks/{task_id}/{relative}", "path escapes the task directory")
        files[relative] = path.read_bytes()
    return files


def read_task(task_dir: Path, task_id: str) -> tuple[dict, dict[str, bytes]]:
    """Validate one LHTB task and return its manifest entry plus its file bytes."""
    if not TASK_ID.match(task_id):
        raise TaskError(f"tasks/{task_id}", "task id is not a safe directory name")
    where = f"tasks/{task_id}/task.toml"
    files = scan_files(task_dir, task_id)
    if "task.toml" not in files:
        raise TaskError(f"tasks/{task_id}", "missing task.toml")
    try:
        doc = tomllib.loads(files["task.toml"].decode())
    except tomllib.TOMLDecodeError as error:
        raise TaskError(where, f"invalid TOML -- {error}") from error

    schema = doc.get("schema_version")
    if schema != "1.1":
        raise TaskError(where, f'schema_version must be "1.1", got {schema!r}')

    artifacts = doc.get("artifacts")
    if not isinstance(artifacts, list) or not artifacts:
        raise TaskError(where, "artifacts must be a nonempty list of output paths (the submission contract)")
    for index, entry in enumerate(artifacts):
        if not isinstance(entry, str) or entry.strip() == "":
            raise TaskError(where, f"artifacts[{index}] must be a nonempty string, got {entry!r}")
        if ".." in PurePosixPath(entry).parts:
            raise TaskError(where, f"artifacts[{index}] must not contain '..': {entry!r}")

    task = _section(doc, where, "task")
    metadata = _section(doc, where, "metadata")
    verifier = _section(doc, where, "verifier")
    agent = _section(doc, where, "agent")
    environment = _section(doc, where, "environment")

    # A separate-verifier task declares its own verifier environment; a
    # shared-environment task reuses [environment]. Either way this harness
    # runs the verifier in its OWN container -- see eval/src/adapters/lhtb.ts.
    mode = verifier.get("environment_mode", "shared")
    if mode not in ("shared", "separate"):
        raise TaskError(where, f'verifier.environment_mode must be "shared" or "separate", got {mode!r}')
    verifier_env = verifier.get("environment")
    if mode == "separate":
        if not isinstance(verifier_env, dict):
            raise TaskError(where, 'verifier.environment_mode = "separate" requires a [verifier.environment] table')
        verifier_section = "verifier.environment"
    else:
        if verifier_env is not None and not isinstance(verifier_env, dict):
            raise TaskError(where, "[verifier.environment] must be a table when present")
        verifier_env = verifier_env if isinstance(verifier_env, dict) else environment
        verifier_section = "verifier.environment" if verifier.get("environment") else "environment"

    entry = {
        "id": task_id,
        "taskDirectory": f"tasks/{task_id}",
        "name": _text(task, where, "task", "name"),
        "description": _text(task, where, "task", "description"),
        "difficulty": _text(metadata, where, "metadata", "difficulty"),
        "category": _text(metadata, where, "metadata", "category"),
        "expertTimeEstimateMin": _positive(metadata, where, "metadata", "expert_time_estimate_min"),
        "artifacts": list(artifacts),
        "image": _text(environment, where, "environment", "docker_image"),
        "cpus": _positive(environment, where, "environment", "cpus"),
        "memoryMb": _positive(environment, where, "environment", "memory_mb"),
        "storageMb": _positive(environment, where, "environment", "storage_mb"),
        "gpus": _nonnegative(environment, where, "environment", "gpus"),
        "allowInternet": _required(environment, where, "environment", "allow_internet", bool),
        "buildTimeoutSec": _positive(environment, where, "environment", "build_timeout_sec"),
        "agentTimeoutSec": _positive(agent, where, "agent", "timeout_sec"),
        "continueUntilTimeout": _required(agent, where, "agent", "continue_until_timeout", bool),
        "verifierMode": mode,
        "verifierTimeoutSec": _positive(verifier, where, "verifier", "timeout_sec"),
        "verifierImage": _text(verifier_env, where, verifier_section, "docker_image"),
        "verifierCpus": _positive(verifier_env, where, verifier_section, "cpus"),
        "verifierMemoryMb": _positive(verifier_env, where, verifier_section, "memory_mb"),
        "verifierAllowInternet": _required(verifier_env, where, verifier_section, "allow_internet", bool),
        "verifierBuildTimeoutSec": _positive(verifier_env, where, verifier_section, "build_timeout_sec"),
    }
    if entry["gpus"] != 0:
        raise TaskError(where, f"environment.gpus = {entry['gpus']}; this harness has no GPU sandbox")

    public = {name: value for name, value in files.items()
              if name in PUBLIC_FILES or name.startswith(PUBLIC_PREFIXES)}
    for required in ("instruction.md", "environment/Dockerfile", "tests/test.sh"):
        if required not in public:
            raise TaskError(f"tasks/{task_id}/{required}", "required task file is missing")
    solution = {name: value for name, value in files.items() if name.startswith("solution/")}
    if "solution/solve.sh" not in solution:
        raise TaskError(f"tasks/{task_id}/solution/solve.sh", "reference solution is required for the reference gate")
    unexpected = sorted(set(files) - set(public) - set(solution))
    if unexpected:
        raise TaskError(f"tasks/{task_id}", f"unexpected files outside task.toml/instruction.md/environment/tests/solution: {unexpected}")

    entry["files"] = {name: digest(value) for name, value in sorted(public.items())}
    # Recorded, never materialized: the reference gate resolves these against
    # the pinned source checkout, so a scored agent image can never contain them.
    entry["solutionFiles"] = {name: digest(value) for name, value in sorted(solution.items())}
    entry["sourceHash"] = digest(
        "".join(f"{digest(value)}  {name}\n" for name, value in sorted(files.items())).encode()
    )
    entry["instructionSha256"] = entry["files"]["instruction.md"]
    return entry, public


def git_commit(source_dir: Path) -> str:
    result = subprocess.run(["git", "-C", str(source_dir), "rev-parse", "HEAD"],
                            capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise ValueError(f"{source_dir} is not a Git checkout: {result.stderr.strip()}")
    commit = result.stdout.strip()
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError(f"{source_dir}: HEAD is not an immutable 40-character commit: {commit!r}")
    return commit


def verify_against_git(source_dir: Path, task_id: str, files: dict[str, bytes]) -> None:
    """Every materialized byte must equal the committed blob at HEAD.

    The dev checkout has an LFS-bypass index, so `git status` cleanliness proves
    nothing; comparing blob contents does.
    """
    prefix = f"tasks/{task_id}/"
    listed = subprocess.run(["git", "-C", str(source_dir), "ls-tree", "-r", "HEAD", "--name-only", "--", prefix],
                            capture_output=True, text=True, check=True).stdout.split("\n")
    tracked = {line[len(prefix):] for line in listed if line.startswith(prefix)}
    for name, value in files.items():
        if name not in tracked:
            raise TaskError(f"{prefix}{name}", "file is not tracked at HEAD in the pinned checkout")
        blob = subprocess.run(["git", "-C", str(source_dir), "cat-file", "blob", f"HEAD:{prefix}{name}"],
                              capture_output=True, check=True).stdout
        if blob != value:
            raise TaskError(f"{prefix}{name}", "working-tree bytes differ from the committed blob at HEAD")


def import_tasks(source_dir, output, task_ids, verify_git=True):
    source_dir = Path(source_dir)
    output = Path(output)
    tasks_root = source_dir / "tasks"
    if not tasks_root.is_dir():
        raise ValueError(f"{source_dir}: no tasks/ directory -- point --source-dir at an LHTB checkout")
    commit = git_commit(source_dir) if verify_git else "0" * 40
    if not task_ids:
        raise ValueError("--tasks is required; this harness imports an explicit subset, never a silent glob")
    if len(set(task_ids)) != len(task_ids):
        raise ValueError(f"duplicate task ids in --tasks: {task_ids}")

    # Validate every selected task before materializing anything.
    entries, payloads = [], {}
    for task_id in task_ids:
        task_dir = tasks_root / task_id
        if not task_dir.is_dir():
            raise ValueError(f"{tasks_root}: no such task directory: {task_id}")
        entry, public = read_task(task_dir, task_id)
        if verify_git:
            verify_against_git(source_dir, task_id, public)
        entries.append(entry)
        payloads[task_id] = public

    if output.exists() and any(output.iterdir()):
        raise ValueError(f"output must be absent or empty: {output}")
    for entry in entries:
        for name, value in payloads[entry["id"]].items():
            destination = output / entry["taskDirectory"] / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(value)
            if name.endswith(".sh"):
                destination.chmod(0o644)
    manifest = {"schemaVersion": 1, "benchmark": "lhtb",
                "source": {"repository": REPOSITORY, "commit": commit},
                "tasks": entries}
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", required=True, help="LHTB Git checkout")
    parser.add_argument("--output", required=True, help="scenarios directory to create (must be absent or empty)")
    parser.add_argument("--tasks", required=True, help="comma-separated task ids")
    parser.add_argument("--force", action="store_true", help="replace an existing non-empty --output")
    args = parser.parse_args()
    output = Path(args.output)
    if args.force and output.exists():
        shutil.rmtree(output)
    manifest = import_tasks(args.source_dir, output, [t for t in args.tasks.split(",") if t])
    print(json.dumps({"tasks": [t["id"] for t in manifest["tasks"]], "source": manifest["source"],
                      "manifest": str(output / "manifest.json"),
                      "sourceHashes": {t["id"]: t["sourceHash"] for t in manifest["tasks"]}}, indent=2))


if __name__ == "__main__":
    main()
