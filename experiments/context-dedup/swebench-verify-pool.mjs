/**
 * Verify every pre-registered candidate three ways (swebench_provision.py --verify).
 *
 * The rejection rate is itself a property of the substrate, so every candidate is verified
 * and every failure is recorded with its stage — nothing is silently dropped.
 *
 * Parallel ACROSS repos (independent clones), sequential WITHIN a repo (a shared clone is
 * checked out per instance). Interpreters are installed serially first so concurrent
 * workers cannot race on the shared uv install directory. A hard per-instance timeout
 * turns a network-bound test suite (psf__requests-2317 sat in SYN-SENT for 11+ minutes)
 * into a recorded rejection instead of a hang.
 *
 *   node experiments/context-dedup/swebench-verify-pool.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORK = process.env.CT_SWEBENCH_WORK || '/mnt/data/ctx-swebench';
const UVPY = join(WORK, 'tooling', 'venv', 'bin', 'python');
const OUT = join(HERE, '..', '..', 'reports', 'metrics', 'swebench-pilot');
const PREREG = join(OUT, process.env.CT_PREREG_FILE || 'preregistration-multi-v2.json');
const RESULTS = join(OUT, process.env.CT_VERIFY_RESULTS_FILE || 'results-swebench-verify-pool-v2.json');
const TIMEOUT_S = +(process.env.CT_VERIFY_TIMEOUT_S || 2700);
const LOGDIR = process.env.CT_VERIFY_LOGDIR || join(WORK, 'runs', 'verify-logs');
// Repos another job is verifying hold a shared clone that `verify()` checks out; running a
// second job on the same repo silently corrupts both. CT_VERIFY_SKIP_REPOS defers them;
// a later run with CT_VERIFY_ONLY_REPOS fills them in and results are MERGED by id.
const SKIP = new Set((process.env.CT_VERIFY_SKIP_REPOS || '').split(',').filter(Boolean));
const ONLY = new Set((process.env.CT_VERIFY_ONLY_REPOS || '').split(',').filter(Boolean));

const prereg0 = JSON.parse(readFileSync(PREREG, 'utf8'));
const prereg = { ...prereg0, candidates: prereg0.candidates.filter((c) => !SKIP.has(c.repo) && (!ONLY.size || ONLY.has(c.repo))) };
const specs = JSON.parse(readFileSync(join(WORK, 'dataset', 'repo_version_specs.json'), 'utf8'));
mkdirSync(LOGDIR, { recursive: true });

const pyvers = [...new Set(prereg.candidates.map((c) => specs[c.repo][c.version].python))];
for (const v of pyvers) {
  console.error(`[python] ensure ${v}`);
  try {
    execFileSync(UVPY, ['-m', 'uv', 'python', 'install', v], { env: { ...process.env, UV_PYTHON_INSTALL_DIR: join(WORK, 'tooling', 'pythons') }, stdio: 'ignore', timeout: 900_000 });
  } catch (e) { console.error(`[python] ${v} failed: ${e.message}`); }
}

function verifyOne(c) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const log = join(LOGDIR, `verify-${c.instance_id}.log`);
    let buf = '';
    const p = spawn(UVPY, ['-u', join(HERE, 'swebench_provision.py'), '--verify', c.instance_id], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    p.stdout.on('data', (d) => { buf += d; });
    p.stderr.on('data', (d) => { buf += d; });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-p.pid, 'SIGKILL'); } catch {} }, TIMEOUT_S * 1000);
    p.on('close', (code) => {
      clearTimeout(timer);
      writeFileSync(log, buf);
      const json = join(WORK, 'runs', `verify-${c.instance_id}.json`);
      let v = null;
      if (!timedOut && existsSync(json)) { try { v = JSON.parse(readFileSync(json, 'utf8')); } catch {} }
      const stage = timedOut ? 'timeout' : v ? (v.usable ? 'ok' : v.stage || (!v.pre_fail ? 'pre_fix_passes' : !v.post_pass ? 'gold_fails_f2p' : !v.p2p_pass ? 'gold_fails_p2p' : 'unknown')) : `crash(exit ${code})`;
      const r = { ...c, usable: !timedOut && !!v?.usable, stage, seconds: Math.round((Date.now() - t0) / 1000), log, tail: buf.slice(-600) };
      console.error(`[verify] ${c.instance_id.padEnd(30)} usable=${r.usable} stage=${stage} ${r.seconds}s`);
      resolve(r);
    });
  });
}

const byRepo = new Map();
for (const c of prereg.candidates) { if (!byRepo.has(c.repo)) byRepo.set(c.repo, []); byRepo.get(c.repo).push(c); }
const t0 = Date.now();
const results = (await Promise.all([...byRepo.values()].map(async (cs) => {
  const rs = [];
  for (const c of cs) rs.push(await verifyOne(c));
  return rs;
}))).flat();
const previous = existsSync(RESULTS) ? JSON.parse(readFileSync(RESULTS, 'utf8')) : { results: [], manifest: { runs: [] } };
const merged = new Map(previous.results.map((r) => [r.instance_id, r]));
for (const r of results) merged.set(r.instance_id, r);
const order = new Map(prereg0.candidates.map((c, i) => [c.instance_id, i]));
const all = [...merged.values()].sort((a, b) => order.get(a.instance_id) - order.get(b.instance_id));

writeFileSync(RESULTS, JSON.stringify({
  manifest: {
    prereg: PREREG.split('/').pop(), timeout_s: TIMEOUT_S, date: new Date().toISOString(),
    runs: [...(previous.manifest.runs || []), { skip: [...SKIP], only: [...ONLY], n: results.length, wall_seconds: Math.round((Date.now() - t0) / 1000) }],
    candidates_total: prereg0.candidates.length, candidates_verified_so_far: all.length,
  },
  results: all,
}, null, 2));
console.error(`verified ${results.filter((r) => r.usable).length}/${results.length} this run; ${all.filter((r) => r.usable).length}/${all.length} of ${prereg0.candidates.length} overall, in ${Math.round((Date.now() - t0) / 60000)} min`);
