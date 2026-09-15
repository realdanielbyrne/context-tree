/**
 * PRE-REGISTERED instance draw for the multi-problem SWE-bench pilot.
 *
 * One instance repeated n times is one problem — constraint C0, the very weakness
 * SWE-bench was brought in to fix. So the unit of analysis is the PROBLEM, and the
 * problems are chosen by a fixed, seeded rule written to disk BEFORE any agent runs, so
 * nobody can pick instances after seeing which ones the agent solves.
 *
 * RULE (every constant below is part of the pre-registration):
 *  1. Eligible repos: pytest-runner repos that install without a C-extension build.
 *     Excluded by construction, with reason, not by draw:
 *       django      ./tests/runtests.py runner, not pytest node ids
 *       sympy       bin/test runner, not pytest node ids
 *       sphinx      tox runner
 *       astropy, matplotlib, scikit-learn   per-version C-extension build from source on a
 *                   non-Docker host
 *     and any instance whose spec interpreter is 3.5/3.6 (no standalone CPython build).
 *  2. psf__requests-2931 is HELD OUT: it is the development instance the harness was
 *     diagnosed on, and a dev instance may not score the gate.
 *  3. Strata from the dataset's own `difficulty` field: E "<15 min fix", M "15 min - 1
 *     hour", H "1-4 hours" or ">4 hours".
 *  4. Within each stratum: sort by instance_id, seeded shuffle per repo, seeded repo order,
 *     then round-robin across repos, so no repo dominates a stratum. Take CANDIDATES[s].
 *  5. Every candidate is verified three ways (swebench_provision.py --verify), then must
 *     pass this harness's envcheck and its gold-patch selftest over the FULL P2P set.
 *  6. Acceptance: walk the candidate list in drawn order; accept a candidate that passed
 *     step 5 while its stratum is under QUOTA[s] and its repo under PER_REPO_CAP.
 *
 *   node experiments/context-dedup/swebench-draw.mjs      # writes the pre-registration
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * v2 (SUPERSEDES preregistration-multi.json, which stays on disk). Changed before any agent
 * ran on a drawn instance, for two reasons recorded in the report: the provisioner gained
 * python 3.5/3.6 and a django runner (the pool grew by 142 instances and three repos), and
 * 10 of v1's 16 rejections were provisioner defects (unpinned pytest/numpy, a pytest-6-only
 * flag), not properties of the instances.
 */
export const SEED = 20260915;
export const ELIGIBLE_REPOS = [
  'psf/requests', 'pallets/flask', 'pytest-dev/pytest', 'pylint-dev/pylint', 'pydata/xarray', 'mwaskom/seaborn',
  'django/django', 'scikit-learn/scikit-learn', 'astropy/astropy', 'matplotlib/matplotlib',
];
export const HELD_OUT = ['psf__requests-2931'];
export const CANDIDATES = { E: 10, M: 10, H: 8 };
export const QUOTA = { E: 4, M: 4, H: 4 };
/** Also the django cap: django is ~80% of the raw pool and must not dominate. */
export const PER_REPO_CAP = 2;
export const PREREG_FILE = 'preregistration-multi-v2.json';
/**
 * Context-pressure thresholds on the SERVER-REPORTED prompt size (max_prompt_tokens).
 * PRIMARY 32,768: the smallest context length commonly deployed for local models of this
 * class, and the scale at which a real host's window would bind. SECONDARY 9,500: the
 * largest artificial cap the project's own window sweeps used (longbuild W=9,500).
 */
export const PRESSURE = { primary: 32768, secondary: 9500 };
/**
 * Sweep sizing: the longbuild sweep's 13 runs per arm could not separate its two signal arms
 * (Fisher p = 1.0), so a between-problem sweep needs at least this many problems that are
 * BOTH solved uncapped AND exceed the primary threshold.
 */
export const SWEEP_MIN_PROBLEMS = 13;

/**
 * Amendments to the v2 rule, each made BEFORE any agent ran on a drawn instance. Copied into
 * every tranche manifest.
 */
export const AMENDMENTS = [
  {
    when: '2026-09-15, after v2 verification began, before any tranche agent run',
    rule: 'exclude a candidate whose FAIL_TO_PASS test files are disjoint from every file the test patch or gold patch touches (f2pOverlapsPatch)',
    why: 'django__django-10097 verified-looking but its 438 F2P ids live in modules the fix never reaches: they pass with or without the gold patch, so they cannot detect a fix',
  },
  {
    when: '2026-09-15, after the first selection-only admission, before any scored agent run',
    rule: 'the patch-line leak check applies only to harness-authored text (system prompt + framing); test ids and failing-test names remain forbidden in the verbatim issue too',
    why: '6 of 28 candidates were rejected because their issue quotes the buggy line or a reproducer that the test patch copies; that is benchmark content, and rejecting it biases the sample toward code-free issues',
  },
  {
    when: '2026-09-15, after the first selection-only admission, before any scored agent run',
    rule: `P2P is calibrated to this environment: grade on the dataset P2P ids that PASS on the gold patch here; admit only if every F2P passes on gold and at least ${'P2P_MIN_COVERAGE'} of dataset P2P is kept; every dropped id is recorded`,
    why: 'official ids were produced in Docker images; here some P2P tests are skipped for missing optional packages (xarray sparse/bottleneck/cftime) or carry absolute-path parameter ids (requests-6028). A test that does not pass on gold in this environment cannot grade an agent. The 0.90 floor was set after seeing one instance\'s ratio (requests-6028, 175/185) but before any agent result existed',
  },
];
/** Minimum fraction of dataset PASS_TO_PASS that must pass on the gold patch here (amendment 3). */
export const P2P_MIN_COVERAGE = 0.9;
AMENDMENTS[2].rule = AMENDMENTS[2].rule.replace("P2P_MIN_COVERAGE", String(P2P_MIN_COVERAGE));

/** SWE-bench test id -> repo-relative test FILE, or null when the id carries no module. */
export function testFileOf(id) {
  const s = String(id);
  if (s.includes('::')) return s.split('::')[0];
  const dj = /^\s*\w+\s+\(([\w.]+)\)\s*$/.exec(s);
  if (dj) {
    const parts = dj[1].split('.');
    const mod = parts.slice(0, -1);                 // drop the TestCase class
    return mod.length ? `tests/${mod.join('/')}.py` : null;
  }
  return null;                                      // a docstring id names no module
}

/**
 * Can this instance's F2P tests detect the fix at all? `ok` unless at least one F2P id names
 * a file and NONE of those files is touched by the test patch or the gold patch. An instance
 * whose ids carry no module (all docstrings) is kept: absence of evidence is not exclusion.
 */
export function f2pOverlapsPatch({ FAIL_TO_PASS, patch = '', test_patch = '' }, diffTargets) {
  const ids = typeof FAIL_TO_PASS === 'string' ? JSON.parse(FAIL_TO_PASS) : FAIL_TO_PASS;
  const files = [...new Set(ids.map(testFileOf).filter(Boolean))];
  if (!files.length) return { ok: true, reason: 'no F2P id names a module', f2p_files: 0 };
  const touched = new Set([...diffTargets(patch), ...diffTargets(test_patch)]);
  const hit = files.filter((f) => touched.has(f));
  return hit.length
    ? { ok: true, f2p_files: files.length, overlapping: hit.length }
    : { ok: false, reason: `f2p_not_in_patched_files: ${files.length} F2P file(s), none touched by the test or gold patch (e.g. ${files[0]})`, f2p_files: files.length };
}

export function stratumOf(difficulty) {
  if (difficulty === '<15 min fix') return 'E';
  if (difficulty === '15 min - 1 hour') return 'M';
  if (difficulty === '1-4 hours' || difficulty === '>4 hours') return 'H';
  return null;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(xs, rng) {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

export function isEligible(row, specs, { repos = ELIGIBLE_REPOS, heldOut = HELD_OUT } = {}) {
  if (!repos.includes(row.repo) || heldOut.includes(row.instance_id)) return false;
  const py = ((specs[row.repo] || {})[String(row.version)] || {}).python;
  return !!py && stratumOf(row.difficulty) !== null;
}

/** Deterministic, stratified, repo-balanced candidate list. */
export function drawCandidates(rows, specs, { seed = SEED, candidates = CANDIDATES, repos = ELIGIBLE_REPOS, heldOut = HELD_OUT } = {}) {
  const rng = mulberry32(seed);
  const out = [];
  for (const s of Object.keys(candidates)) {
    const byRepo = new Map();
    const pool = rows.filter((r) => isEligible(r, specs, { repos, heldOut }) && stratumOf(r.difficulty) === s)
      .sort((a, b) => (a.instance_id < b.instance_id ? -1 : 1));
    for (const r of pool) { if (!byRepo.has(r.repo)) byRepo.set(r.repo, []); byRepo.get(r.repo).push(r); }
    const repoOrder = shuffle([...byRepo.keys()].sort(), rng);
    const queues = repoOrder.map((repo) => shuffle(byRepo.get(repo), rng));
    const picked = [];
    while (picked.length < candidates[s] && queues.some((q) => q.length)) {
      for (const q of queues) { if (q.length && picked.length < candidates[s]) picked.push(q.shift()); }
    }
    for (const r of picked) out.push({ instance_id: r.instance_id, repo: r.repo, version: String(r.version), difficulty: r.difficulty, stratum: s });
  }
  return out;
}

/**
 * Walk candidates in drawn order; `check(c)` -> { ok, reason }. Accept while the stratum
 * quota and repo cap allow. Candidates skipped because a quota is already full are NOT
 * checked (their verification outcome cannot influence the set) and are recorded as such.
 */
export function selectByQuota(candidates, check, { quota = QUOTA, perRepoCap = PER_REPO_CAP } = {}) {
  const taken = { strata: {}, repos: {} };
  const accepted = [], rejected = [], skipped = [];
  for (const c of candidates) {
    if ((taken.strata[c.stratum] || 0) >= (quota[c.stratum] ?? 0)) { skipped.push({ ...c, reason: 'stratum quota full' }); continue; }
    if ((taken.repos[c.repo] || 0) >= perRepoCap) { skipped.push({ ...c, reason: 'repo cap reached' }); continue; }
    const r = check(c);
    if (!r.ok) { rejected.push({ ...c, reason: r.reason }); continue; }
    accepted.push(c);
    taken.strata[c.stratum] = (taken.strata[c.stratum] || 0) + 1;
    taken.repos[c.repo] = (taken.repos[c.repo] || 0) + 1;
  }
  return { accepted, rejected, skipped };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const WORK = process.env.CT_SWEBENCH_WORK || '/mnt/data/ctx-swebench';
  const rows = readFileSync(join(WORK, 'dataset', 'swebench_verified.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const specs = JSON.parse(readFileSync(join(WORK, 'dataset', 'repo_version_specs.json'), 'utf8'));
  const HERE = dirname(fileURLToPath(import.meta.url));
  const outDir = join(HERE, '..', '..', 'reports', 'metrics', 'swebench-pilot');
  const path = join(outDir, PREREG_FILE);
  if (existsSync(path) && process.env.CT_FORCE !== '1') {
    console.error(`refusing to overwrite the pre-registration at ${path} (CT_FORCE=1 to override)`);
    process.exit(1);
  }
  const eligible = rows.filter((r) => isEligible(r, specs));
  const poolByStratum = {};
  for (const r of eligible) { const k = `${r.repo} ${stratumOf(r.difficulty)}`; poolByStratum[k] = (poolByStratum[k] || 0) + 1; }
  const candidates = drawCandidates(rows, specs);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path, JSON.stringify({
    written_at: new Date().toISOString(),
    written_before_any_agent_run: true,
    supersedes: 'preregistration-multi.json (v1)',
    seed: SEED, eligible_repos: ELIGIBLE_REPOS, held_out: HELD_OUT,
    candidates_per_stratum: CANDIDATES, quota: QUOTA, per_repo_cap: PER_REPO_CAP,
    gate: {
      solvability: 'fraction of distinct accepted problems with pass=true (F2P and P2P), Wilson 95% interval, pooled and per repo; void grades excluded from the denominator',
      pressure_thresholds_prompt_tokens: PRESSURE,
      pressure: 'among SOLVED problems, fraction whose max_prompt_tokens exceeds PRESSURE.primary (and .secondary)',
      verdict: `usable for the window/eviction sweeps only if the projected number of problems that are BOTH solved AND above PRESSURE.primary reaches ${SWEEP_MIN_PROBLEMS}; projected = joint rate x eligible verified pool`,
      config: 'uncapped, no eviction, no middleware, temperature 0, thinking disabled, tool-output clip 30,000 chars (swebench-agent.mjs), max 50 turns, n=1 per problem',
    },
    exclusions: {
      'sympy/sympy': 'bin/test runner, not pytest node ids',
      'sphinx-doc/sphinx': 'tox runner',
      'psf__requests-2931': 'held out: development instance the harness was diagnosed on',
    },
    eligible_pool_size: eligible.length, eligible_pool_by_repo_stratum: poolByStratum,
    candidates,
  }, null, 2));
  console.error(`wrote ${path}: ${candidates.length} candidates from an eligible pool of ${eligible.length}`);
  for (const c of candidates) console.error(`  ${c.stratum} ${c.instance_id.padEnd(30)} ${c.repo}`);
}
