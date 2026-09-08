#!/usr/bin/env python3
"""Import immutable Datacurve DEEPSWE tasks; never expose solution/ to agents.

Example: python3 eval/scripts/import-deepswe.py --output /tmp/deepswe-public
Offline: add --archive FILE --archive-sha256 SHA256 (hash of the fetched archive).
"""
import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import tarfile
import tomllib
import urllib.request

REPOSITORY = "https://github.com/datacurve-ai/deep-swe"
PIN = "0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def import_archive(data, commit, output):
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("--commit must be an immutable 40-character Git commit")
    output = Path(output)
    if output.exists() and any(output.iterdir()):
        raise ValueError(f"output must be absent or empty: {output}")
    files = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        for entry in archive.getmembers():
            parts = PurePosixPath(entry.name).parts
            if not parts or PurePosixPath(entry.name).is_absolute() or ".." in parts:
                raise ValueError(f"unsafe archive path: {entry.name}")
            if not parts[0].startswith("datacurve-ai-deep-swe-") or not parts[0].endswith(commit[:7]):
                raise ValueError("archive root does not match the pinned official repository commit")
            if entry.isdir():
                continue
            if not entry.isfile():
                # The official archive has a tasks/README.md symlink. It is not
                # task input and is never extracted. Links inside tasks fail.
                if len(parts) >= 4 and parts[1] == "tasks":
                    raise ValueError(f"unsupported archive member: {entry.name}")
                continue
            relative = "/".join(parts[1:])
            if relative in files:
                raise ValueError(f"duplicate archive member: {relative}")
            files[relative] = archive.extractfile(entry).read()
    task_paths = sorted(p for p in files if re.fullmatch(r"tasks/[^/]+/task\.toml", p))
    if not task_paths:
        raise ValueError("archive contains no official task.toml tasks")
    source = {"repository": REPOSITORY, "commit": commit, "archiveSha256": digest(data)}
    tasks = []
    selected = {}
    for task_path in task_paths:
        prefix = task_path.removesuffix("task.toml")
        task_id = prefix.split("/")[1]
        doc = tomllib.loads(files[task_path].decode())
        metadata, environment, verifier = doc["metadata"], doc["environment"], doc["verifier"]
        if doc.get("schema_version") != "1.3" or metadata["task_id"] != task_id:
            raise ValueError(f"unsupported task identity/schema: {task_id}")
        if verifier.get("environment_mode") != "separate":
            raise ValueError(f"independent verifier required: {task_id}")
        if any(section.get("network_mode") != "no-network" for section in (doc["agent"], verifier)):
            raise ValueError(f"unsupported network policy: {task_id}")
        if environment.get("env") or verifier.get("env") or doc["agent"].get("env"):
            raise ValueError(f"explicit environment-variable support required: {task_id}")
        base = metadata["base_commit_hash"]
        if not re.fullmatch(r"[0-9a-f]{7,40}", base):
            raise ValueError(f"invalid official task base: {task_id}")
        collect = verifier.get("collect", [])
        expected = f"git diff --binary {base} HEAD > /logs/artifacts/model.patch"
        if len(collect) != 1 or expected not in collect[0]["command"]:
            raise ValueError(f"unsupported committed-patch collection: {task_id}")
        task_files = {p[len(prefix):]: value for p, value in files.items()
                      if p.startswith(prefix) and (p[len(prefix):] in ("task.toml", "instruction.md")
                          or p[len(prefix):].startswith(("environment/", "tests/")))}
        required = ("instruction.md", "environment/Dockerfile", "tests/Dockerfile", "tests/test.sh", "tests/grader.py", "tests/config.json", "tests/test.patch")
        if any(p not in task_files for p in required):
            raise ValueError(f"incomplete v1.1 task: {task_id}")
        hashes = {p: digest(value) for p, value in sorted(task_files.items())}
        tasks.append({"id": task_id, "taskDirectory": prefix.rstrip("/"),
                      "image": environment["docker_image"], "baseCommit": base,
                      "collect": [{"command": x["command"], "timeoutSec": x["timeout_sec"]} for x in collect],
                      "verifierTimeoutSec": verifier["timeout_sec"],
                      "verifierBuildTimeoutSec": verifier["environment"]["build_timeout_sec"],
                      "cpus": environment["cpus"], "memoryMb": environment["memory_mb"],
                      "verifierCpus": verifier["environment"]["cpus"],
                      "verifierMemoryMb": verifier["environment"]["memory_mb"],
                      "agentNetwork": "none", "verifierNetwork": "none", "files": hashes,
                      "repositoryUrl": metadata["repository_url"], "language": metadata.get("language")})
        selected.update({prefix + p: value for p, value in task_files.items()})
    # Validate the entire archive before materializing any task.
    output.mkdir(parents=True, exist_ok=True)
    for path, value in selected.items():
        destination = output / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(value)
    manifest = {"schemaVersion": 1, "benchmark": "deepswe", "source": source, "tasks": tasks}
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument("--commit", default=PIN)
    parser.add_argument("--archive")
    parser.add_argument("--archive-sha256")
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9a-f]{40}", args.commit):
        parser.error("--commit must be a full immutable commit")
    if args.archive:
        if not args.archive_sha256:
            parser.error("offline archives require --archive-sha256")
        data = Path(args.archive).read_bytes()
        if digest(data) != args.archive_sha256:
            parser.error("archive SHA256 mismatch")
    else:
        with urllib.request.urlopen(f"https://api.github.com/repos/datacurve-ai/deep-swe/tarball/{args.commit}") as response:
            data = response.read()
    manifest = import_archive(data, args.commit, args.output)
    print(json.dumps({"tasks": len(manifest["tasks"]), "source": manifest["source"], "manifest": str(Path(args.output) / "manifest.json")}))


if __name__ == "__main__":
    main()
