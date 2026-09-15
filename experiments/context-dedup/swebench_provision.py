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
import argparse, json, os, re, subprocess, sys, venv
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


MAMBA = WORK / "tooling" / "micromamba" / "bin" / "micromamba"
MAMBA_PYTHONS = WORK / "pythons"


def ensure_python(pyver):
    """Path to a CPython `pyver` installed on WORK, no sudo.

    uv's standalone builds start at 3.7, so 3.5/3.6 (113 django, 25 scikit-learn and
    4 astropy verified instances) come from conda-forge via micromamba instead. Not a
    source build: the host's OpenSSL 3.x breaks `ssl` on 3.5/3.6, while conda-forge
    ships them against OpenSSL 1.0.2/1.1.1 with a complete stdlib.
    """
    env = {"UV_PYTHON_INSTALL_DIR": str(PYDIR)}
    sh([str(UVPY), "-m", "uv", "python", "install", pyver], env=env, timeout=900)
    r = sh([str(UVPY), "-m", "uv", "python", "find", pyver], env=env, timeout=300)
    path = (r.stdout or "").strip().splitlines()[0] if r.stdout.strip() else ""
    if path and Path(path).exists():
        return path

    prefix = MAMBA_PYTHONS / f"py{pyver}"
    py = prefix / "bin" / "python"
    if not py.exists():
        if not MAMBA.exists():
            raise RuntimeError(f"python {pyver}: no uv build and micromamba missing at {MAMBA}")
        menv = {"MAMBA_ROOT_PREFIX": str(WORK / "tooling" / f"mamba-root-{pyver}")}
        sh([str(MAMBA), "create", "-y", "-p", str(prefix), "-c", "conda-forge",
            f"python={pyver}", "pip", "setuptools", "wheel"], env=menv, timeout=1800, check=True)
    if not py.exists():
        raise RuntimeError(f"python {pyver} unavailable via uv or micromamba")
    return str(py)


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
    # pip_packages carries the period-appropriate PINS (e.g. numpy==1.19.2 for sklearn
    # 0.20); installing only the unpinned `packages` would pull versions that cannot
    # build on py3.5/3.6. Pins go first so later installs resolve against them.
    # An UNVERSIONED `cython` resolves to Cython 3.x today, which changed the default
    # language_level and dropped implicit relative cimports — scikit-learn 0.20 fails at
    # `from _tree cimport Node`. The official Docker images were built before Cython 3
    # (2023) existed, so cap it to reproduce the environment the specs were written for.
    CAPS = {"cython": "cython<3"}
    pins = [CAPS.get(p.strip().lower(), p.strip()) for p in (spec.get("pip_packages") or []) if p.strip()]
    # Try the pin list as one resolve first (pins that constrain each other resolve
    # together); if pip rejects it, fall back to one pin at a time. pip is
    # all-or-nothing, and the official specs contain pins that do not exist on PyPI
    # (astropy 1.3 lists `exceptiongroup==0.0.0a0`) — one such pin silently dropped the
    # WHOLE list, left MarkupSafe unpinned, and easy_install then pulled a py3.9-only
    # release that broke the build.
    if pins:
        r = sh([str(py), "-m", "pip", "install", "-q", *pins], timeout=3600)
        if r.returncode != 0:
            skipped = []
            for p in pins:
                if sh([str(py), "-m", "pip", "install", "-q", p], timeout=1800).returncode != 0:
                    skipped.append(p)
            if skipped:
                print(f"[pins] could not install {len(skipped)}/{len(pins)}: {', '.join(skipped)}", flush=True)
    pkgs = (spec.get("packages") or "").strip()
    if pkgs and pkgs not in ("requirements.txt", "environment.yml"):
        sh([str(py), "-m", "pip", "install", "-q", *pkgs.split()], timeout=3600)
    sh([str(py), "-m", "pip", "install", "-q", "pytest"], timeout=1800)
    # Rewrite EVERY leading `python` to the venv interpreter, not just `python -m`:
    # django 2.2's spec is `python setup.py install`, which would otherwise run on
    # whatever `python` the host PATH resolves to.
    cmd = spec.get("install") or "python -m pip install -e ."
    cmd = " && ".join(f"{py}{part.strip()[len('python'):]}" if part.strip().startswith("python ") else part.strip()
                      for part in cmd.split("&&"))
    r = sh(cmd, cwd=str(d), timeout=3600)
    return r.returncode == 0, (r.stdout + r.stderr)[-3000:]


def apply_patch(d, patch, reverse=False):
    if not patch.strip():
        return True
    args = ["git", "-C", str(d), "apply", "-v"] + (["-R"] if reverse else [])
    p = subprocess.run(args, input=patch, text=True, capture_output=True)
    return p.returncode == 0


def django_label(test_id):
    """`test_x (app.tests.Case)` -> `app.tests.Case.test_x`, the form runtests.py accepts.

    SWE-bench records django tests in unittest's repr form, not as a runnable label.
    Ids already in dotted form pass through unchanged.
    """
    m = re.match(r"^\s*(\w+)\s+\(([\w.]+)\)\s*$", test_id)
    return f"{m.group(2)}.{m.group(1)}" if m else test_id.strip()


DJANGO_STATUS = re.compile(r"^(.*?) \.\.\. (ok|FAIL|ERROR|skipped.*|expected failure|unexpected success)\s*$")


def django_statuses(output):
    """Map each reported test id to its status, from runtests.py --verbosity 2 output.

    A test with a docstring prints `method (module.Class)` on one line and then its
    docstring on the next, followed by ` ... ok` — and SWE-bench records THAT
    docstring line as the test id. So ids are read off the line carrying the status,
    exactly as the official log parser does.
    """
    out = {}
    for line in output.splitlines():
        m = DJANGO_STATUS.match(line)
        if m:
            out[m.group(1).strip()] = m.group(2)
    return out


def _django_run(py, d, labels):
    # PYTHONPATH=checkout is load-bearing. runtests.py is run as a SCRIPT, so sys.path[0]
    # is tests/, not the repo root — and specs that use `python setup.py install`
    # (django 2.2) leave a frozen egg copy in site-packages. Without this the tests
    # import that egg, so neither the test patch nor the fix ever reaches the code under
    # test: django-10097 "passed" its fail-to-pass tests before the fix was applied.
    env = {"LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "PYTHONIOENCODING": "utf8", "PYTHONPATH": str(d)}
    r = sh([str(py), "tests/runtests.py", "--verbosity", "2", "--settings=test_sqlite",
            "--parallel", "1", *labels], cwd=str(d), env=env, timeout=5400)
    return django_statuses(r.stdout + r.stderr), r.stdout + r.stderr


def run_tests(py, d, tests, repo=None):
    if not tests:
        return True, "(no tests)"
    if repo == "django/django":
        # Docstring-form ids name no module, so they cannot be passed as labels. Run the
        # MODULES the method-form ids live in and grade every id from the status lines;
        # if a docstring id is still unreported, widen to its app packages once.
        want = [t.strip() for t in tests]
        modules = sorted({django_label(t).rsplit(".", 2)[0] for t in want if django_label(t) != t})
        statuses, log = _django_run(py, d, modules) if modules else ({}, "")
        missing = [t for t in want if t not in statuses]
        if missing:
            apps = sorted({m.split(".")[0] for m in modules}) or []
            if apps:
                more, log2 = _django_run(py, d, apps)
                statuses.update(more)
                log += log2
            missing = [t for t in want if t not in statuses]
        # Only ok / expected failure count as passing, as in the official evaluator. A
        # SKIPPED fail-to-pass test has not demonstrated the fix, so it is not a pass.
        bad = [t for t in want if statuses.get(t) not in ("ok", "expected failure")]
        summary = (f"[django] {len(want)} ids, {len(want) - len(bad)} ok, "
                   f"{len([t for t in bad if t in statuses])} failed, {len(missing)} not reported"
                   + (f"; unreported e.g. {missing[:3]}" if missing else ""))
        # Truncate the LOG, never the summary: `(summary + log)[-4000:]` cut the summary
        # off the front, so the one line saying why grading failed was never printed.
        return not bad, summary + "\n" + log[-(4000 - len(summary) - 1):]
    else:
        # No `--no-header`: it only exists from pytest 6, and pytest-dev/pytest's own
        # period checkouts (e.g. 5.2) ARE the pytest that runs, so it rejects the flag and
        # every such instance fails verification for a reason unrelated to the instance.
        r = sh([str(py), "-m", "pytest", "-rA", "-q", *tests], cwd=str(d), timeout=1800)
        out = (r.stdout + r.stderr)[-4000:]
        # pytest exit 2/3/4/5 = interrupted / internal error / usage error / nothing
        # collected: the tests DID NOT RUN. Returning False would let verify() score a
        # harness crash as "pre-fix FAIL (expected)" — the false positive astropy-7166
        # produced when period pytest rejected a flag. Raise so it cannot be misread.
        if r.returncode in (2, 3, 4, 5):
            raise TestsDidNotRun(f"pytest exit {r.returncode}: tests did not run\n{out[-1500:]}")
        return r.returncode == 0, out


class TestsDidNotRun(RuntimeError):
    """The test runner failed to execute the tests at all (as opposed to tests failing)."""


def verify(instance_id):
    try:
        return _verify(instance_id)
    except TestsDidNotRun as e:
        print(f"[VERDICT] {instance_id} usable=False  (tests did not run: {str(e).splitlines()[0]})")
        print(str(e)[-1200:])
        return {"instance_id": instance_id, "usable": False, "stage": "tests_did_not_run", "detail": str(e)[:500]}


def _verify(instance_id):
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

    pre_ok, pre_out = run_tests(py, d, f2p, repo)
    print(f"[pre-fix ] FAIL_TO_PASS -> {'PASS (UNEXPECTED)' if pre_ok else 'FAIL (expected)'}")

    if not apply_patch(d, inst["patch"]):
        print("[gold patch] FAILED to apply")
        return {"instance_id": instance_id, "usable": False, "stage": "gold_patch"}

    post_ok, post_out = run_tests(py, d, f2p, repo)
    print(f"[post-fix] FAIL_TO_PASS -> {'PASS (expected)' if post_ok else 'FAIL (UNEXPECTED)'}")
    p2p_ok, _ = run_tests(py, d, p2p[:40], repo)   # cap: P2P can be thousands
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
