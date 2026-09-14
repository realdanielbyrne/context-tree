#!/usr/bin/env python3
"""
SWE-bench (Verified) NON-DOCKER provisioner + grading validator.

Docker is unavailable on this host, so each instance is provisioned directly:
clone the repo, check out `base_commit`, build a per-(repo,version) venv, install
the project, then grade with the instance's own FAIL_TO_PASS / PASS_TO_PASS tests.

Everything lands on the big spinning volume (WORK), never the NVMe.

VALIDATE MODE (--verify) proves the pipeline is trustworthy before any agent runs:
  1. apply test_patch, run FAIL_TO_PASS  -> must FAIL   (the bug is real & reachable)
  2. apply the gold patch, run again     -> must PASS   (the tests actually verify the fix)
  3. run PASS_TO_PASS                    -> must PASS   (no regressions)
An instance that does not satisfy all three is unusable for an experiment and is
reported as such rather than silently included.

Usage:
  python3 swebench_provision.py --list-light
  python3 swebench_provision.py --verify psf__requests-2931
"""
import argparse, json, os, subprocess, sys, venv
from pathlib import Path

WORK = Path(os.environ.get("CT_SWEBENCH_WORK", "/mnt/data/ctx-swebench"))
DATASET = WORK / "dataset" / "swebench_verified.jsonl"
SPECS_PATH = WORK / "dataset" / "repo_version_specs.json"
REPOS, VENVS, RUNS = WORK / "repos", WORK / "venvs", WORK / "runs"
PYDIR = WORK / "tooling" / "pythons"          # uv-managed standalone CPythons
UVPY = WORK / "tooling" / "venv" / "bin" / "python"
LIGHT = {"psf/requests", "pallets/flask", "pytest-dev/pytest", "pylint-dev/pylint", "django/django"}
# Pilot pool: pytest-driven repos only. django uses ./tests/runtests.py, a different
# runner that needs its own handling, so it is excluded from the first pass.
PYTEST_REPOS = {"psf/requests", "pallets/flask", "pytest-dev/pytest", "pylint-dev/pylint"}

SPECS = json.loads(SPECS_PATH.read_text()) if SPECS_PATH.exists() else {}


def spec_for(repo, version):
    """Official install spec (python version, packages, install cmd, test cmd).

    SWE-bench normally encodes this in a per-instance Docker image. Without Docker
    we must honour it explicitly: e.g. psf/requests 2.9 needs python 3.9, and on
    the host's 3.13 it fails at `import cgi` (removed in 3.13 by PEP 594).
    """
    return (SPECS.get(repo) or {}).get(str(version)) or {}


def ensure_python(pyver):
    """Path to a uv-managed standalone CPython `pyver` (installed on WORK, no sudo)."""
    env = {"UV_PYTHON_INSTALL_DIR": str(PYDIR)}
    sh([str(UVPY), "-m", "uv", "python", "install", pyver], env=env, timeout=900)
    r = sh([str(UVPY), "-m", "uv", "python", "find", pyver], env=env, timeout=300)
    path = (r.stdout or "").strip().splitlines()[0] if r.stdout.strip() else ""
    if not path or not Path(path).exists():
        raise RuntimeError(f"python {pyver} unavailable via uv (3.5/3.6 predate standalone builds)")
    return path


def sh(cmd, cwd=None, env=None, timeout=1800, check=False):
    """Run a command, capturing output. Never raises on non-zero unless check."""
    p = subprocess.run(cmd, cwd=cwd, env={**os.environ, **(env or {})}, shell=isinstance(cmd, str),
                       capture_output=True, text=True, timeout=timeout)
    if check and p.returncode != 0:
        raise RuntimeError(f"cmd failed ({p.returncode}): {cmd}\n{p.stdout[-2000:]}\n{p.stderr[-2000:]}")
    return p


def load(instance_id=None):
    rows = [json.loads(l) for l in DATASET.open()]
    if instance_id:
        for r in rows:
            if r["instance_id"] == instance_id:
                return r
        sys.exit(f"instance not found: {instance_id}")
    return rows


def as_list(v):
    return json.loads(v) if isinstance(v, str) else list(v)


def repo_dir(repo):
    return REPOS / repo.replace("/", "__")


def ensure_clone(repo):
    d = repo_dir(repo)
    if not (d / ".git").exists():
        d.parent.mkdir(parents=True, exist_ok=True)
        print(f"[clone] {repo} -> {d}", flush=True)
        sh(["git", "clone", f"https://github.com/{repo}.git", str(d)], timeout=3600, check=True)
    return d


def checkout(d, commit):
    sh(["git", "-C", str(d), "reset", "--hard"], check=False)
    sh(["git", "-C", str(d), "clean", "-fdx"], check=False)
    r = sh(["git", "-C", str(d), "checkout", "-f", commit])
    if r.returncode != 0:                      # commit may not be in a shallow/stale clone
        sh(["git", "-C", str(d), "fetch", "--all", "--tags"], timeout=3600)
        sh(["git", "-C", str(d), "checkout", "-f", commit], check=True)


def ensure_venv(repo, version, pyver):
    """Per (repo, version) venv built on the PERIOD-APPROPRIATE interpreter."""
    key = f"{repo.replace('/', '__')}__{version}__py{pyver}"
    vd = VENVS / key
    py = vd / "bin" / "python"
    if not py.exists():
        base = ensure_python(pyver)
        print(f"[venv] {key}  (base {base})", flush=True)
        vd.parent.mkdir(parents=True, exist_ok=True)
        sh([base, "-m", "venv", str(vd)], timeout=900, check=True)
        sh([str(py), "-m", "pip", "install", "-q", "--upgrade", "pip", "setuptools", "wheel"], timeout=1800)
    return py


def install(py, d, spec):
    """Run the official install command for this repo+version, plus its test packages."""
    pkgs = (spec.get("packages") or "").strip()
    if pkgs and pkgs not in ("requirements.txt", "environment.yml"):
        sh([str(py), "-m", "pip", "install", "-q", *pkgs.split()], timeout=1800)
    sh([str(py), "-m", "pip", "install", "-q", "pytest"], timeout=1800)
    cmd = (spec.get("install") or "python -m pip install -e .").replace("python -m", f"{py} -m")
    r = sh(cmd, cwd=str(d), timeout=3600)
    return r.returncode == 0, (r.stdout + r.stderr)[-3000:]


def apply_patch(d, patch, reverse=False):
    if not patch.strip():
        return True
    args = ["git", "-C", str(d), "apply", "-v"] + (["-R"] if reverse else [])
    p = subprocess.run(args, input=patch, text=True, capture_output=True)
    return p.returncode == 0


def run_tests(py, d, tests):
    if not tests:
        return True, "(no tests)"
    r = sh([str(py), "-m", "pytest", "-rA", "--no-header", "-q", *tests], cwd=str(d), timeout=1800)
    out = (r.stdout + r.stderr)[-4000:]
    return r.returncode == 0, out


def verify(instance_id):
    inst = load(instance_id)
    repo, ver = inst["repo"], inst["version"]
    f2p, p2p = as_list(inst["FAIL_TO_PASS"]), as_list(inst["PASS_TO_PASS"])
    print(f"=== {instance_id}  repo={repo} v{ver} difficulty={inst['difficulty']} "
          f"F2P={len(f2p)} P2P={len(p2p)} ===", flush=True)

    spec = spec_for(repo, ver)
    pyver = spec.get("python")
    if not pyver:
        print(f"[spec] MISSING for {repo} {ver}")
        return {"instance_id": instance_id, "usable": False, "stage": "spec"}
    print(f"[spec] python={pyver} install={spec.get('install')!r} test={spec.get('test_cmd')!r}")

    d = ensure_clone(repo)
    checkout(d, inst["base_commit"])
    try:
        py = ensure_venv(repo, ver, pyver)
    except RuntimeError as e:
        print(f"[venv] {e}")
        return {"instance_id": instance_id, "usable": False, "stage": "python", "detail": str(e)}
    ok, log = install(py, d, spec)
    print(f"[install] {'OK' if ok else 'FAILED'}")
    if not ok:
        print(log[-1200:])
        return {"instance_id": instance_id, "usable": False, "stage": "install"}

    if not apply_patch(d, inst["test_patch"]):
        print("[test_patch] FAILED to apply")
        return {"instance_id": instance_id, "usable": False, "stage": "test_patch"}

    pre_ok, pre_out = run_tests(py, d, f2p)
    print(f"[pre-fix ] FAIL_TO_PASS -> {'PASS (UNEXPECTED)' if pre_ok else 'FAIL (expected)'}")

    if not apply_patch(d, inst["patch"]):
        print("[gold patch] FAILED to apply")
        return {"instance_id": instance_id, "usable": False, "stage": "gold_patch"}

    post_ok, post_out = run_tests(py, d, f2p)
    print(f"[post-fix] FAIL_TO_PASS -> {'PASS (expected)' if post_ok else 'FAIL (UNEXPECTED)'}")
    p2p_ok, _ = run_tests(py, d, p2p[:40])   # cap: P2P can be thousands
    print(f"[post-fix] PASS_TO_PASS(<=40) -> {'PASS' if p2p_ok else 'FAIL'}")

    usable = (not pre_ok) and post_ok and p2p_ok
    print(f"[VERDICT] {instance_id} usable={usable}")
    if not usable:
        print("--- pre_out tail ---\n", pre_out[-800:], "\n--- post_out tail ---\n", post_out[-800:])
    return {"instance_id": instance_id, "usable": usable, "pre_fail": not pre_ok,
            "post_pass": post_ok, "p2p_pass": p2p_ok, "repo": repo, "version": ver,
            "difficulty": inst["difficulty"], "f2p": len(f2p)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list-light", action="store_true")
    ap.add_argument("--verify", metavar="INSTANCE_ID")
    a = ap.parse_args()
    RUNS.mkdir(parents=True, exist_ok=True)
    if a.list_light:
        for r in load():
            if r["repo"] in LIGHT:
                print(f"{r['instance_id']:<36} {r['repo']:<22} v{r['version']:<8} {r['difficulty']}")
        return
    if a.verify:
        res = verify(a.verify)
        (RUNS / f"verify-{a.verify}.json").write_text(json.dumps(res, indent=2))
        sys.exit(0 if res.get("usable") else 1)
    ap.print_help()


if __name__ == "__main__":
    main()
