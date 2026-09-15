/**
 * Task module for the A/B sweeps — ONE SWE-bench Verified instance.
 *
 * WHY THIS EXISTS (backlog item 9, constraint C0 in reports/session-handoff.md):
 * every live experiment in this project runs on ONE synthetic task (`longbuild`), so n
 * repeats measure within-problem nondeterminism, not between-problem variance. SWE-bench
 * Verified is the instrument that fixes that. Before spending compute on a context-policy
 * sweep there, one thing has to be established: can the local 27B solve verified instances
 * AT ALL with unlimited context? This module is the substrate for that gate.
 *
 * Interface: { name, system, task, seed(ws), grade(ws)->bool, ... } — identical to
 * ab-tasks/longbuild.mjs, so an instance is a drop-in `CT_TASK` for ab-window-sweep.mjs.
 * `gradeDetail(ws)` reports F2P and P2P separately; `grade(ws)` is its boolean projection.
 *
 * WORKSPACE. The shared clone is never mutated: a per-instance cache is built once from
 * `git archive <base_commit>` (reads the commit object, touches neither index nor
 * worktree), and every workspace is a copy of that cache. A bare archive is not
 * importable for every repo, so the cache also receives (a) the clone's git-ignored
 * generated `.py` files (setuptools_scm `_version.py` and the like) and (b) an in-place
 * extension build when the clone holds compiled artefacts (scikit-learn, astropy,
 * matplotlib). Without that the envcheck would reject those repos for a reason that is a
 * property of this harness, not of the instance.
 *
 * INTERPRETER. `experiments/coding-harness/lib.mjs` whitelists `run_bash` head commands and
 * is out of bounds, so `seed()` PREPENDS the instance venv bin to PATH (the whitelisted
 * `python3`/`python`/`pytest` ARE the instance interpreter) and sets PYTHONPATH to the
 * workspace (plus `src/`, `lib/` layouts), so imports resolve to the agent's copy.
 *
 * GRADING dispatches like swebench_provision.run_tests: django through
 * `tests/runtests.py` with SWE-bench's `test_x (app.tests.Case)` ids converted to labels,
 * everything else through pytest. Outcomes are parsed per test from the FULL output;
 * the exit code is never trusted, and a test that was not reported is not a pass.
 *
 * LEAK DISCIPLINE. The agent sees the `problem_statement` VERBATIM and nothing else: never
 * the gold patch, the test patch, a FAIL_TO_PASS/PASS_TO_PASS id or the bare name of a
 * graded test. `assertNoTestLeak` enforces this at construction time and throws.
 */
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';

export const WORK = process.env.CT_SWEBENCH_WORK || '/mnt/data/ctx-swebench';
export const DATASET = join(WORK, 'dataset', 'swebench_verified.jsonl');
export const SPECS_PATH = join(WORK, 'dataset', 'repo_version_specs.json');
export const WSCACHE = join(WORK, 'wscache');
export const DEFAULT_INSTANCE = process.env.CT_SWEBENCH_INSTANCE || 'psf__requests-2931';

// ============================ pure helpers (unit-tested) ============================

export const asList = (v) => (typeof v === 'string' ? JSON.parse(v) : [...v]);

const IMPORT_NAME = { 'scikit-learn/scikit-learn': 'sklearn' };
export const importName = (repo) => IMPORT_NAME[repo] || repo.split('/')[1];

/** PYTHONPATH for a workspace: root first, then the src/ and lib/ layouts that exist. */
export function pythonPathFor(ws, exists = existsSync) {
  return [ws, join(ws, 'src'), join(ws, 'lib')].filter((p, i) => i === 0 || exists(p)).join(':');
}

/** Bare test function name of a test id: pytest "a.py::Cls::test_x[p]" or django "test_x (app.Case)". */
export function testFnName(id) {
  const s = String(id);
  const dj = /^\s*(\w+)\s+\(/.exec(s);
  if (dj && !s.includes('::')) return dj[1];
  const parts = s.split('::');
  return (parts[parts.length - 1] || '').split('[')[0];
}

/** Files a unified diff touches (post-image paths), for restore-before-grade. */
export function testPatchTargets(diff) {
  const out = [];
  for (const line of String(diff || '').split('\n')) {
    const m = /^\+\+\+ (?:b\/)?(.+?)\s*$/.exec(line);
    if (!m) continue;
    const p = m[1];
    if (p === '/dev/null') continue;
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * Throw if anything the agent will see leaks the answer. Checked: every F2P/P2P id, every
 * bare function name of an F2P test, and every substantive added/removed line of the gold
 * and test patches.
 */
/*
 * `text` is what THE HARNESS writes (system prompt + framing); `statement` is the issue,
 * passed through verbatim by requirement. Test ids and failing-test names are forbidden in
 * both. Patch lines are forbidden only in harness text: an issue routinely quotes the buggy
 * line or the reporter's reproducer, which the test patch then copies, and rejecting those
 * would silently bias the sample toward issues that contain no code (6 of 28 candidates).
 */
export function assertNoTestLeak({ text, statement = '', f2p = [], p2p = [], goldPatch = '', testPatch = '' }) {
  const hay = String(text || '');
  const both = `${hay}\n${String(statement || '')}`;
  const bad = [];
  for (const id of [...f2p, ...p2p]) if (both.includes(id)) bad.push(`test id: ${id}`);
  // Bare names only for F2P: a P2P name can be a common word that legitimately appears in a
  // bug report, whereas naming the failing test is the leak that matters.
  for (const id of f2p) {
    const fn = testFnName(id);
    if (fn && fn.length > 4 && both.includes(fn)) bad.push(`test name: ${fn}`);
  }
  for (const src of [goldPatch, testPatch]) {
    for (const line of String(src || '').split('\n')) {
      if (!/^[+-]/.test(line) || /^(\+\+\+|---)/.test(line)) continue;
      const body = line.slice(1).trim();
      if (body.length < 25) continue;
      if (hay.includes(body)) bad.push(`patch line: ${body.slice(0, 60)}`);
    }
  }
  if (bad.length) throw new Error(`SWE-bench prompt LEAKS the answer -> ${bad.join(' | ')}`);
  return true;
}

/**
 * pytest `-rA` summary -> id -> outcome, under TWO keys:
 *  1. SWE-bench's own convention (`parse_log_pytest`): drop " - " on FAILED lines, split the
 *     line on whitespace, key = token 2. The dataset's ids were produced by that parser, so
 *     an id whose brackets contain a space is RECORDED truncated at the space
 *     (requests-6028: `test__parse_content_type_header[application/json;`). Only this key
 *     can match such an id.
 *  2. The exact full id as a line prefix, for ids recorded whole (containing spaces or " - ").
 */
const OUTCOMES = ['PASSED', 'FAILED', 'ERROR', 'SKIPPED', 'XFAIL', 'XPASS'];
export function parsePytestOutcomes(out, ids = []) {
  const res = new Map();
  const lines = String(out || '').split('\n').map((l) => l.trim());
  for (const raw of lines) {
    if (!OUTCOMES.some((s) => raw.startsWith(`${s} `))) continue;
    const line = raw.startsWith('FAILED ') ? raw.replace(' - ', ' ') : raw;
    const tok = line.split(/\s+/);
    if (tok.length > 1 && OUTCOMES.includes(tok[0])) res.set(tok[1].replace(/^\.\//, ''), tok[0]);
  }
  for (const id of ids) {
    for (const line of lines) {
      const st = OUTCOMES.find((s) => line === `${s} ${id}` || line.startsWith(`${s} ${id} - `));
      if (st) { res.set(id, st); break; }
    }
  }
  return res;
}

/** `test_x (app.tests.Case)` -> `app.tests.Case.test_x` (mirrors swebench_provision.django_label). */
export function djangoLabel(id) {
  const m = /^\s*(\w+)\s+\(([\w.]+)\)\s*$/.exec(String(id));
  return m ? `${m[2]}.${m[1]}` : String(id).trim();
}

/**
 * Test MODULES a django test patch touches: `tests/app/test_x.py` -> `app.test_x`. This is
 * how the official harness selects what to run, and it is the only option: some SWE-bench
 * django ids are a test's DOCSTRING, not a method name, and cannot be passed as a label.
 */
export function djangoTestModules(testPatch) {
  return testPatchTargets(testPatch)
    .filter((p) => p.startsWith('tests/') && p.endsWith('.py'))
    .map((p) => p.slice('tests/'.length, -'.py'.length).replace(/\//g, '.'))
    .filter((m) => !m.endsWith('__init__'));
}

/**
 * django runtests.py `--verbosity 2` -> id -> outcome, keyed the way SWE-bench records ids:
 * the text before ` ... <status>` (which is the docstring when a test has one), plus the
 * normalised `test_x (app.tests.Case)` form for the pre-3.11 line, the 3.11+ line
 * `test_x (app.tests.Case.test_x)`, and a method line whose status sits on the docstring
 * line below it.
 */
const DJ_STATUS = { ok: 'PASSED', FAIL: 'FAILED', ERROR: 'ERROR', skipped: 'SKIPPED', 'expected failure': 'XFAIL', 'unexpected success': 'XPASS' };
export function parseDjangoOutcomes(out) {
  const res = new Map();
  const lines = String(out || '').split('\n').map((l) => l.replace(/\s+$/, ''));
  const head = /^(\w+) \(([\w.]+?)(?:\.\1)?\)$/;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(.*?) \.\.\. (ok|FAIL|ERROR|skipped\b.*|expected failure|unexpected success)$/.exec(lines[i]);
    if (!m) continue;
    const st = DJ_STATUS[m[2].startsWith('skipped') ? 'skipped' : m[2]];
    const key = m[1].trim();
    res.set(key, st);
    const h = head.exec(key);
    if (h) res.set(`${h[1]} (${h[2]})`, st);
    const prev = i > 0 ? head.exec(lines[i - 1].trim()) : null;
    if (!h && prev) res.set(`${prev[1]} (${prev[2]})`, st);
  }
  return res;
}

/** Every requested id must be present AND PASSED. Missing => not passed. */
export function gradeOutcomes(ids, outcomes) {
  const results = ids.map((id) => ({ id, status: outcomes.get(id) || 'MISSING' }));
  return { all: results.length > 0 && results.every((r) => r.status === 'PASSED'), results };
}

/** Longest run of consecutive IDENTICAL tool calls (same tool, same argument). */
export function maxIdenticalStreak(calls) {
  let best = 0, cur = 0, prev = null;
  for (const c of calls) {
    const key = `${c.name} ${c.arg}`;
    cur = key === prev ? cur + 1 : 1;
    prev = key;
    if (cur > best) best = cur;
  }
  return best;
}

export const failedIds = (g) => g.results.filter((r) => r.status !== 'PASSED').map((r) => `${r.id} [${r.status}]`);

// ============================ provisioning ============================

export function loadInstance(instanceId, datasetPath = DATASET) {
  for (const line of readFileSync(datasetPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    if (r.instance_id === instanceId) return r;
  }
  throw new Error(`instance not found in ${datasetPath}: ${instanceId}`);
}

export function specFor(repo, version) {
  const specs = existsSync(SPECS_PATH) ? JSON.parse(readFileSync(SPECS_PATH, 'utf8')) : {};
  return (specs[repo] || {})[String(version)] || {};
}

export const repoDir = (repo) => join(WORK, 'repos', repo.replace('/', '__'));
export const venvDir = (repo, version, pyver) =>
  join(WORK, 'venvs', `${repo.replace('/', '__')}__${version}__py${pyver}`);

const sh = (cmd, opts = {}) =>
  execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 900_000, maxBuffer: 256 * 1024 * 1024, ...opts });
const q = (s) => JSON.stringify(s);

/** Extract `commit` of `clone` into `dest`. Read-only w.r.t. the shared clone. */
export function extractCommit(clone, commit, dest) {
  mkdirSync(dest, { recursive: true });
  sh(`git -C ${q(clone)} archive ${commit} | tar -x -C ${q(dest)}`, { shell: '/bin/bash' });
}

/**
 * Build (once) the importable pristine tree for an instance. Atomic: built in a temp dir
 * and renamed, so a crashed build never leaves a half-cache that later runs would trust.
 */
const CACHE_VERSION = 2;
export function ensureWorkspaceCache({ instanceId, clone, baseCommit, py, pythonpath }) {
  const dest = join(WSCACHE, instanceId);
  try {
    if (JSON.parse(readFileSync(join(dest, '.ct-cache-ok'), 'utf8')).version === CACHE_VERSION) return dest;
  } catch {}
  const tmp = `${dest}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  extractCommit(clone, baseCommit, tmp);
  const ignored = sh(`git -C ${q(clone)} ls-files --others --ignored --exclude-standard`).split('\n').filter(Boolean);
  const generatedPy = ignored.filter((p) => p.endsWith('.py') && !/(^|\/)(build|dist|\.tox|\.eggs|node_modules|__pycache__)\//.test(p) && !/egg-info\//.test(p));
  const log = { version: CACHE_VERSION, copied_generated_py: [], built_extensions: false };
  for (const rel of generatedPy) {
    if (existsSync(join(tmp, rel))) continue;
    try { mkdirSync(dirname(join(tmp, rel)), { recursive: true }); writeFileSync(join(tmp, rel), readFileSync(join(clone, rel))); log.copied_generated_py.push(rel); } catch {}
  }
  // Decide from the COMMIT's own tracked files, never from the shared clone's current
  // state: the clone is left at whatever the last verification checked out (or cleaned),
  // which silently skipped the build for scikit-learn-14983.
  const compiled = sh(`git -C ${q(clone)} ls-tree -r --name-only ${baseCommit}`).split('\n').some((p) => /\.pyx$/.test(p));
  if (compiled && existsSync(join(tmp, 'setup.py'))) {
    const b = spawnSync(py, ['setup.py', 'build_ext', '--inplace'], {
      cwd: tmp, encoding: 'utf8', timeout: 5_400_000, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, PYTHONPATH: pythonpath(tmp) },
    });
    if (b.status !== 0) {
      writeFileSync(`${dest}.build-error.log`, `${b.stdout || ''}\n${b.stderr || ''}`);
      rmSync(tmp, { recursive: true, force: true });
      throw new Error(`build_ext failed (exit ${b.status}); see ${dest}.build-error.log`);
    }
    log.built_extensions = true;
  }
  writeFileSync(join(tmp, '.ct-cache-ok'), JSON.stringify(log));
  rmSync(dest, { recursive: true, force: true });
  renameSync(tmp, dest);
  return dest;
}

// ============================ task module factory ============================

/**
 * `opts.p2p` overrides PASS_TO_PASS with the ENVIRONMENT-CALIBRATED subset: the dataset's
 * P2P ids that pass on the gold patch in this non-Docker environment (see the pilot's
 * selftest). It must be a subset of the dataset's P2P; a superset would grade on tests the
 * benchmark never specified.
 */
export function makeSwebenchTask(instanceId = DEFAULT_INSTANCE, opts = {}) {
  const inst = loadInstance(instanceId);
  const { repo, version, base_commit: baseCommit } = inst;
  const f2p = asList(inst.FAIL_TO_PASS);
  const p2pDataset = asList(inst.PASS_TO_PASS);
  if (opts.p2p) {
    const allowed = new Set(p2pDataset);
    const extra = opts.p2p.filter((id) => !allowed.has(id));
    if (extra.length) throw new Error(`p2p override is not a subset of the dataset P2P: ${extra.slice(0, 2).join(', ')}`);
  }
  const p2p = opts.p2p ? [...opts.p2p] : p2pDataset;
  const spec = specFor(repo, version);
  const pyver = spec.python;
  if (!pyver) throw new Error(`no install spec for ${repo} ${version} — instance not provisionable`);

  const clone = repoDir(repo);
  const venv = venvDir(repo, version, pyver);
  const py = join(venv, 'bin', 'python');
  const venvBin = join(venv, 'bin');
  const pkg = importName(repo);
  const isDjango = repo === 'django/django';

  const testHow = isDjango
    ? `  This project's own test runner is \`python3 tests/runtests.py <app.module.Class.test>\`.`
    : `  Tests run with \`python3 -m pytest <path>::<test>\`.`;

  const system = [
    `You are a software engineer fixing a bug in the ${repo} Python repository.`,
    `The complete repository source is already checked out in your workspace, at an older commit.`,
    `Use the tools to explore it, find the cause of the reported problem, and fix it.`,
    ``,
    `ENVIRONMENT`,
    `- \`python3\` (also \`python\` and \`pytest\`) on PATH is this project's OWN virtual environment`,
    `  interpreter, at ${py}. It already has the project's dependencies and pytest installed.`,
    `  Invoke it by name (\`python3 ...\`); the sandbox only permits the command names`,
    `  python3, python, pytest, ls, cat, echo, pwd, mkdir, head, tail, grep, find,`,
    `  so an absolute interpreter path will be refused.`,
    testHow,
    `- Your workspace is first on the import path, so \`import ${pkg}\` loads YOUR copy of the`,
    `  source and an edit takes effect on the very next command.`,
    `- Shell commands are killed after 30 seconds and long tool results are truncated. Run`,
    `  targeted commands and targeted tests rather than the whole suite.`,
    `- There is no network access. Anything that talks to a remote host will hang and be killed.`,
    ``,
    `RULES`,
    `- Fix the LIBRARY SOURCE. Keep the change minimal and do not break existing behaviour.`,
    `- Do NOT add or modify test files: your fix is graded by tests you cannot see, and any edit`,
    `  you make to a test file is discarded before grading.`,
    `- Verify your reasoning by running code, not by assuming an edit worked.`,
    `- When you are confident the reported problem is fixed, reply with a short message`,
    `  containing DONE and no tool call.`,
  ].join('\n');

  const framing = [`Fix the following issue reported against this repository.`, ``, `--- issue report ---`, `--- end of issue report ---`];
  const task = [framing[0], framing[1], framing[2], inst.problem_statement, framing[3]].join('\n');

  assertNoTestLeak({
    text: `${system}\n${framing.join('\n')}`, statement: inst.problem_statement,
    f2p, p2p: p2pDataset, goldPatch: inst.patch, testPatch: inst.test_patch,
  });

  const cacheArgs = { instanceId, clone, baseCommit, py, pythonpath: (d) => pythonPathFor(d) };

  const djangoModules = isDjango ? djangoTestModules(inst.test_patch) : [];

  /**
   * `ran` is false when the RUNNER did not run the tests (pytest exit 2-5: interrupted,
   * internal error, usage error, nothing collected; django: no status line at all). That is
   * not the same as the tests failing, and gradeDetail refuses to score it as such.
   */
  const graded = [...f2p, ...p2p];

  /**
   * One invocation over every graded test, both streams captured on EVERY exit status.
   * pytest runs the test FILES, as the official harness does: passing ids aborts the whole
   * run (exit 4) on a single id pytest cannot resolve, and SWE-bench records some ids
   * truncated. django runs the test modules; its runner reports results on STDERR, so a
   * stdout-only capture of a passing (exit 0) run saw no results at all.
   * `ran` is false when the runner did not run: pytest exit 2/3/4/5, a timeout or signal, or
   * no parseable result line.
   */
  function runTests(ws) {
    const env = { ...process.env, PYTHONPATH: pythonPathFor(ws) };
    let args;
    if (isDjango) {
      const labels = djangoModules.length ? djangoModules : [...new Set(graded.map(djangoLabel))].sort();
      args = ['tests/runtests.py', '--verbosity', '2', '--settings=test_sqlite', '--parallel', '1', ...labels];
      Object.assign(env, { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PYTHONIOENCODING: 'utf8' });
    } else {
      const files = [...new Set(graded.map((i) => (i.includes('::') ? i.split('::')[0] : i)))];
      args = ['-m', 'pytest', '-rA', '-p', 'no:cacheprovider', ...files];
    }
    const r = spawnSync(py, args, { cwd: ws, encoding: 'utf8', timeout: 3_600_000, env, maxBuffer: 256 * 1024 * 1024 });
    const out = `${r.stdout || ''}\n${r.stderr || ''}`;
    const status = r.status ?? -1;
    const outcomes = isDjango ? parseDjangoOutcomes(out) : parsePytestOutcomes(out, graded);
    const ran = outcomes.size > 0 && (isDjango || ![2, 3, 4, 5, -1].includes(status));
    return { outcomes, out, ran, status };
  }

  /** Does the runner run on the PRISTINE tree + test patch? Separates harness from agent. */
  function pristineRuns() {
    const tmp = join(WSCACHE, `${instanceId}.control-${process.pid}-${Date.now()}`);
    try {
      sh(`cp -a ${q(join(WSCACHE, instanceId))}/. ${q(tmp)}/`, { shell: '/bin/bash' });
      execFileSync('git', ['apply', '-'], { cwd: tmp, input: inst.test_patch, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      return runTests(tmp).ran;
    } catch { return false; } finally { rmSync(tmp, { recursive: true, force: true }); }
  }

  return {
    name: `swebench(${instanceId}, ${repo}@${version}, F2P=${f2p.length} P2P=${p2p.length})`,
    instanceId, repo, version, baseCommit, pyver, python: py, importName: pkg, f2p, p2p,
    p2pDataset, p2pCalibrated: !!opts.p2p,
    difficulty: inst.difficulty,
    system,
    task,

    seed(ws) {
      if (!existsSync(join(clone, '.git'))) throw new Error(`repo not provisioned: ${clone}`);
      if (!existsSync(py)) throw new Error(`venv not provisioned: ${py}`);
      const cache = ensureWorkspaceCache(cacheArgs);
      mkdirSync(ws, { recursive: true });
      sh(`cp -a ${q(cache)}/. ${q(ws)}/ && rm -f ${q(join(ws, '.ct-cache-ok'))}`, { shell: '/bin/bash' });
      if (!(process.env.PATH || '').startsWith(venvBin + ':')) process.env.PATH = `${venvBin}:${process.env.PATH || ''}`;
      process.env.PYTHONPATH = pythonPathFor(ws);
      process.env.PYTHONDONTWRITEBYTECODE = '1';
    },

    /** Unified diff of what the agent changed, against the pristine cache. Call BEFORE grade(). */
    agentDiff(ws) {
      const cache = join(WSCACHE, instanceId);
      try {
        return sh(`diff -ru -x __pycache__ -x '*.pyc' -x .ct-cache-ok -x .pytest_cache ${q(cache)} ${q(ws)} 2>&1 | head -c 20000`, { shell: '/bin/bash' });
      } catch (e) { return String(e.stdout || e.message).slice(0, 20000); }
    },

    /**
     * Restore every file the test patch touches (an agent edit to a test cannot break the
     * patch or fake a pass), apply the test patch, then run F2P and P2P SEPARATELY.
     * Pass iff every F2P passes AND every P2P still passes.
     */
    gradeDetail(ws) {
      const base = { f2p_pass: false, p2p_pass: false, pass: false, stage: 'ok', f2p_failures: [], p2p_failures: [] };
      try {
        for (const rel of testPatchTargets(inst.test_patch)) {
          const p = join(ws, rel);
          mkdirSync(dirname(p), { recursive: true });
          let content = null;
          try {
            content = execFileSync('git', ['-C', clone, 'show', `${baseCommit}:${rel}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
          } catch { content = null; }
          if (content === null) { rmSync(p, { force: true }); continue; }
          writeFileSync(p, content);
        }
        try {
          execFileSync('git', ['apply', '-'], { cwd: ws, input: inst.test_patch, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
        } catch (e) {
          return { ...base, stage: 'test_patch', valid: true, error: String(e.stderr || e.message).slice(0, 400) };
        }
        const a = runTests(ws);
        const b = a;
        let stage = 'ok';
        if (!a.ran) {
          // The agent may have broken collection (a genuine fail), or the runner may not run
          // here at all (a void grade). Only the pristine control can tell which.
          if (!pristineRuns()) {
            return { ...base, stage: 'grader_did_not_run', valid: false, error: `runner exit ${a.status}`, f2p_tail: a.out.slice(-1200) };
          }
          stage = 'agent_broke_test_run';
        }
        const gf = gradeOutcomes(f2p, a.outcomes);
        const gp = gradeOutcomes(p2p, b.outcomes);
        return {
          f2p_pass: gf.all, p2p_pass: gp.all, pass: gf.all && gp.all, stage, valid: true,
          f2p_failures: failedIds(gf), p2p_failures: failedIds(gp),
          f2p_n: f2p.length, p2p_n: p2p.length,
          f2p_tail: a.out.slice(-1200), p2p_tail: b.out.slice(-600),
        };
      } catch (e) {
        return { ...base, stage: 'exception', valid: false, error: String(e.message).slice(0, 400) };
      }
    },

    grade(ws) { return this.gradeDetail(ws).pass; },
  };
}

let _default;
if (!existsSync(DATASET)) {
  const msg = `SWE-bench dataset missing at ${DATASET} (set CT_SWEBENCH_WORK)`;
  _default = { name: `swebench(UNAVAILABLE)`, system: '', task: '', seed() { throw new Error(msg); }, grade: () => false };
} else {
  _default = makeSwebenchTask(DEFAULT_INSTANCE); // throws loudly on a prompt leak
}
export default _default;
