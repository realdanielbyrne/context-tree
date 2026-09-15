/**
 * Task module for the A/B sweeps — ONE SWE-bench Verified instance.
 *
 * WHY THIS EXISTS (backlog item 9, constraint C0 in reports/session-handoff.md):
 * every live experiment in this project runs on ONE synthetic task (`longbuild`),
 * so n repeats measure within-problem nondeterminism, not between-problem variance.
 * SWE-bench Verified is the instrument that fixes that. Before spending compute on a
 * context-policy sweep there, one thing has to be established: can the local 27B solve
 * a verified instance AT ALL with unlimited context? If it cannot, a sweep measures task
 * difficulty, not context policy. This module is the substrate for that gate.
 *
 * Interface: { name, system, task, seed(ws), grade(ws)->bool, ... } — identical to
 * ab-tasks/longbuild.mjs, so an instance is a drop-in `CT_TASK` for ab-window-sweep.mjs.
 * `gradeDetail(ws)` is the richer return (F2P and P2P reported separately); `grade(ws)`
 * is its boolean projection so the existing sweeps keep working unchanged.
 *
 * PROVISIONING is the non-Docker one validated in swebench_provision.py: a per-(repo,
 * version) venv on the period-appropriate interpreter, the repo checked out at
 * `base_commit`. This module never mutates the shared clone — the workspace is produced
 * with `git archive <base_commit> | tar -x`, which reads the commit object and touches
 * neither the index nor the worktree (the shared clone is routinely left dirty by
 * `swebench_provision.py --verify`, so reading its worktree would be WRONG as well as
 * rude).
 *
 * INTERPRETER. `experiments/coding-harness/lib.mjs` whitelists `run_bash` head commands
 * (python3/python/pytest/ls/cat/...) and is out of bounds for this work, so the whitelist
 * is "extended" the only sound way: `seed()` PREPENDS the instance's own venv bin to
 * PATH, so the whitelisted names `python3`, `python` and `pytest` ARE the instance
 * interpreter. It also sets PYTHONPATH to the workspace, so `import <pkg>` resolves to
 * the agent's copy and not to the venv's site-packages build. The absolute interpreter
 * path is stated in the system prompt, as is the fact that it must be invoked by name.
 *
 * LEAK DISCIPLINE (the pilot is meaningless without it). The agent sees the instance's
 * `problem_statement` VERBATIM and nothing else: never the gold patch, never the test
 * patch, never a FAIL_TO_PASS/PASS_TO_PASS id or the bare name of one of those tests,
 * and no hint about which file to edit. `assertNoTestLeak` enforces this at construction
 * time and throws — a leak must abort the run, not degrade it. The hidden tests arrive
 * only at grade time, after the agent has stopped.
 */
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';

export const WORK = process.env.CT_SWEBENCH_WORK || '/mnt/data/ctx-swebench';
export const DATASET = join(WORK, 'dataset', 'swebench_verified.jsonl');
export const SPECS_PATH = join(WORK, 'dataset', 'repo_version_specs.json');
export const DEFAULT_INSTANCE = process.env.CT_SWEBENCH_INSTANCE || 'psf__requests-2931';

// ============================ pure helpers (unit-tested) ============================

export const asList = (v) => (typeof v === 'string' ? JSON.parse(v) : [...v]);

/** Bare test function name of a pytest node id: "a/b.py::Cls::test_x" -> "test_x". */
export function testFnName(id) {
  const parts = String(id).split('::');
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
 * Throw if anything the agent will see leaks the answer. Checked: every F2P/P2P node id,
 * every bare test function name of an F2P test, and every added/removed source line of
 * the gold patch. A pilot whose prompt names the test it is graded on measures nothing.
 */
export function assertNoTestLeak({ text, f2p = [], p2p = [], goldPatch = '', testPatch = '' }) {
  const hay = String(text || '');
  const bad = [];
  for (const id of [...f2p, ...p2p]) if (hay.includes(id)) bad.push(`test id: ${id}`);
  // Bare names only for F2P: a P2P name can be a common word that legitimately appears
  // in a bug report, whereas naming the failing test is the leak that matters.
  for (const id of f2p) {
    const fn = testFnName(id);
    if (fn && hay.includes(fn)) bad.push(`test name: ${fn}`);
  }
  for (const src of [goldPatch, testPatch]) {
    for (const line of String(src || '').split('\n')) {
      if (!/^[+-]/.test(line) || /^(\+\+\+|---)/.test(line)) continue;
      const body = line.slice(1).trim();
      if (body.length < 25) continue; // short lines ('}', 'import os') are not a leak
      if (hay.includes(body)) bad.push(`patch line: ${body.slice(0, 60)}`);
    }
  }
  if (bad.length) throw new Error(`SWE-bench prompt LEAKS the answer -> ${bad.join(' | ')}`);
  return true;
}

/**
 * Parse pytest's `-rA` "short test summary info" into id -> outcome. Grading reads THIS,
 * not the exit code: an exit code cannot tell "the test failed" from "the test was never
 * collected", and a missing test must never count as a pass.
 */
export function parsePytestOutcomes(out) {
  const res = new Map();
  for (const line of String(out || '').split('\n')) {
    const m = /^(PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS)\s+(\S+)/.exec(line.trim());
    if (m) res.set(m[2].replace(/^\.\//, ''), m[1]);
  }
  return res;
}

/** Every requested id must be present AND PASSED. Missing => not passed. */
export function gradeOutcomes(ids, outcomes) {
  const results = ids.map((id) => ({ id, status: outcomes.get(id) || 'MISSING' }));
  return { all: results.length > 0 && results.every((r) => r.status === 'PASSED'), results };
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
  execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 900_000, ...opts });

/** Extract `commit` of `clone` into `dest`. Read-only w.r.t. the shared clone. */
export function extractCommit(clone, commit, dest) {
  mkdirSync(dest, { recursive: true });
  sh(`git -C ${JSON.stringify(clone)} archive ${commit} | tar -x -C ${JSON.stringify(dest)}`, { shell: '/bin/bash' });
}

// ============================ task module factory ============================

export function makeSwebenchTask(instanceId = DEFAULT_INSTANCE) {
  const inst = loadInstance(instanceId);
  const { repo, version, base_commit: baseCommit } = inst;
  const f2p = asList(inst.FAIL_TO_PASS);
  const p2p = asList(inst.PASS_TO_PASS);
  const spec = specFor(repo, version);
  const pyver = spec.python;
  if (!pyver) throw new Error(`no install spec for ${repo} ${version} — instance not provisionable`);

  const clone = repoDir(repo);
  const venv = venvDir(repo, version, pyver);
  const py = join(venv, 'bin', 'python');
  const venvBin = join(venv, 'bin');
  const pkgName = repo.split('/')[1];

  const system = [
    `You are a software engineer fixing a bug in the ${repo} Python repository.`,
    `The complete repository source is already checked out in your workspace, at an older commit.`,
    `Use the tools to explore it, find the cause of the reported problem, and fix it.`,
    ``,
    `ENVIRONMENT`,
    `- \`python3\` (also \`python\` and \`pytest\`) on PATH is this project's OWN virtual environment`,
    `  interpreter, at ${py}. It already has the project's dependencies and pytest installed.`,
    `  Invoke it by name (\`python3 ...\`, \`python3 -m pytest ...\`); the sandbox only permits the`,
    `  command names python3, python, pytest, ls, cat, echo, pwd, mkdir, head, tail, grep, find,`,
    `  so an absolute interpreter path will be refused.`,
    `- Your workspace is first on the import path, so \`import ${pkgName}\` loads YOUR copy of the`,
    `  source and an edit takes effect on the very next command.`,
    `- Shell commands are killed after 30 seconds and every tool result is truncated at ~2000`,
    `  characters. Run targeted commands and targeted tests rather than the whole suite.`,
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

  // The problem statement is passed through VERBATIM (no paraphrase, no added hint about
  // which file to edit). The surrounding two lines are framing only.
  const task = [
    `Fix the following issue reported against this repository.`,
    ``,
    `--- issue report ---`,
    inst.problem_statement,
    `--- end of issue report ---`,
  ].join('\n');

  // Hard gate: abort construction if the prompt names a graded test or echoes the fix.
  assertNoTestLeak({ text: `${system}\n${task}`, f2p, p2p, goldPatch: inst.patch, testPatch: inst.test_patch });

  function runTests(ws, ids) {
    if (!ids.length) return { outcomes: new Map(), out: '(no tests)' };
    let out = '';
    try {
      out = execFileSync(py, ['-m', 'pytest', '-rA', '--no-header', '-q', '-p', 'no:warnings', ...ids], {
        cwd: ws, encoding: 'utf8', timeout: 1_800_000, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONPATH: ws },
      });
    } catch (e) {
      out = `${e.stdout || ''}\n${e.stderr || ''}`;
    }
    return { outcomes: parsePytestOutcomes(out), out };
  }

  return {
    name: `swebench(${instanceId}, ${repo}@${version}, F2P=${f2p.length} P2P=${p2p.length})`,
    instanceId, repo, version, baseCommit, pyver, python: py, f2p, p2p,
    difficulty: inst.difficulty,
    system,
    task,

    seed(ws) {
      if (!existsSync(join(clone, '.git'))) throw new Error(`repo not provisioned: ${clone}`);
      if (!existsSync(py)) throw new Error(`venv not provisioned: ${py}`);
      extractCommit(clone, baseCommit, ws);
      // "extend the bash whitelist" without touching lib.mjs: make the whitelisted
      // names resolve to the instance's own interpreter, and make the workspace the
      // first thing on the import path.
      if (!(process.env.PATH || '').startsWith(venvBin + ':')) {
        process.env.PATH = `${venvBin}:${process.env.PATH || ''}`;
      }
      const srcDir = join(ws, 'src');
      process.env.PYTHONPATH = existsSync(srcDir) ? `${ws}:${srcDir}` : ws;
      process.env.PYTHONDONTWRITEBYTECODE = '1';
    },

    /** Unified diff of what the agent actually changed. Call BEFORE grade(). */
    agentDiff(ws) {
      const ref = `${ws}.pristine`;
      try {
        rmSync(ref, { recursive: true, force: true });
        extractCommit(clone, baseCommit, ref);
        try {
          return sh(`diff -ru ${JSON.stringify(ref)} ${JSON.stringify(ws)} 2>&1 | head -c 20000`, { shell: '/bin/bash' });
        } catch (e) { return String(e.stdout || e.message).slice(0, 20000); }
      } catch (e) { return `(diff unavailable: ${e.message})`; }
      finally { rmSync(ref, { recursive: true, force: true }); }
    },

    /**
     * Grade exactly as swebench_provision.verify() does, with the instance's own runner:
     * restore every file the test patch touches (so an agent edit to a test cannot break
     * the patch or fake a pass), apply the test patch, then run F2P and P2P SEPARATELY.
     * Pass iff every F2P passes AND every P2P still passes.
     */
    gradeDetail(ws) {
      const base = { f2p_pass: false, p2p_pass: false, pass: false, stage: 'ok', f2p_failures: [], p2p_failures: [] };
      try {
        for (const rel of testPatchTargets(inst.test_patch)) {
          const p = join(ws, rel);
          mkdirSync(dirname(p), { recursive: true });
          let content = '';
          try {
            content = execFileSync('git', ['-C', clone, 'show', `${baseCommit}:${rel}`],
              { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
          } catch { content = null; } // file is added by the test patch; leave it absent
          if (content === null) { rmSync(p, { force: true }); continue; }
          writeFileSync(p, content);
        }
        try {
          execFileSync('git', ['apply', '-'], { cwd: ws, input: inst.test_patch, encoding: 'utf8' });
        } catch (e) {
          return { ...base, stage: 'test_patch', error: String(e.stderr || e.message).slice(0, 400) };
        }
        const a = runTests(ws, f2p);
        const b = runTests(ws, p2p);
        const gf = gradeOutcomes(f2p, a.outcomes);
        const gp = gradeOutcomes(p2p, b.outcomes);
        return {
          f2p_pass: gf.all, p2p_pass: gp.all, pass: gf.all && gp.all, stage: 'ok',
          f2p_failures: failedIds(gf), p2p_failures: failedIds(gp),
          f2p_n: f2p.length, p2p_n: p2p.length,
          f2p_tail: a.out.slice(-1200), p2p_tail: b.out.slice(-600),
        };
      } catch (e) {
        return { ...base, stage: 'exception', error: String(e.message).slice(0, 400) };
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
