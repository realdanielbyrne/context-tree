/**
 * SWE-bench VERIFIED SOLVABILITY PILOT — the gate on backlog item 9.
 *
 * THE QUESTION. Every live experiment in this project runs on one synthetic task
 * (`longbuild`), so n repeats measure within-problem nondeterminism, not between-problem
 * variance — constraint C0 in reports/session-handoff.md, and the project's biggest
 * stated weakness. SWE-bench Verified is the instrument that fixes it. Before any compute
 * is spent on a context-policy sweep there, one thing must be established:
 *
 *     can the local 27B solve a VERIFIED instance when given UNLIMITED context?
 *
 * If it cannot, then every arm of a sweep on that substrate fails for reasons that have
 * nothing to do with context management, and the sweep measures task difficulty. This is
 * a NEGATIVE CONTROL ON THE SUBSTRATE, not a capability demo. A negative verdict is a
 * perfectly good result: it saves the project days on an unusable substrate.
 *
 * SO: UNCAPPED. No window cap, no eviction, no middleware, no reducer — the hook only
 * MEASURES. `peak_history_tokens` is recorded anyway, because it answers the second
 * question the gate raises: if the uncapped peak never approaches a deployment window,
 * SWE-bench instances do not generate enough context pressure for a window policy to
 * bind at all (constraint C1 — with a shell, agents shrink their own context), and the
 * substrate is unusable for a DIFFERENT reason than difficulty.
 *
 * The prompt is NOT tuned until it passes. Whatever the first honest configuration does
 * is the result.
 *
 * MODES
 *   --verify     run swebench_provision.py --verify on each instance first (3-way proof:
 *                pre-fix FAIL, gold-patch PASS, no regressions). Only verified instances
 *                are usable.
 *   --selftest   prove THIS harness's grader before trusting its verdict: on a freshly
 *                seeded workspace F2P must FAIL, and after the gold patch F2P and P2P
 *                must both PASS. A grader that cannot fail cannot gate anything.
 *
 * RUN (live):
 *   set -a; . ./.env; set +a
 *   CT_LOCAL_MODEL=unsloth/Qwen3.8-27B-GGUF CT_REPEATS=3 CT_MAX_TURNS=40 \
 *     node experiments/context-dedup/swebench-pilot.mjs
 */
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgent, makeWorkspace, execTool, estTokens, MODEL, BASE_URL, RETRY_STATS } from '../coding-harness/lib.mjs';
import { makeSwebenchTask, loadInstance, maxIdenticalStreak, WORK } from './ab-tasks/swebench.mjs';
import { runAgentClip, REASONING_OFF } from './swebench-agent.mjs';
import { selectByQuota, stratumOf, f2pOverlapsPatch, AMENDMENTS, P2P_MIN_COVERAGE } from './swebench-draw.mjs';
import { testPatchTargets } from './ab-tasks/swebench.mjs';
import { readFileSync } from 'node:fs';
import { writeResults, gitSha, nowISO } from '../rung-1-live-probe/lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const INSTANCES = (process.env.CT_SWEBENCH_INSTANCES || 'psf__requests-2931').split(',').map((s) => s.trim()).filter(Boolean);
const REPEATS = +(process.env.CT_REPEATS || 3);
const MAX_TURNS = +(process.env.CT_MAX_TURNS || 40);
const MAX_TOKENS = +(process.env.CT_MAX_TOKENS || 2048);
const TAG = process.env.CT_TAG || 'v1';
const KEEP_WS = process.env.CT_KEEP_WS === '1';
/**
 * DIAGNOSTIC ARM ONLY (CT_THINK=1). The gate itself runs the project's standard harness
 * configuration (thinking disabled, temperature 0), and the PROMPT is never changed. This
 * knob exists because the gate's failure mode turned out to be repetition collapse rather
 * than mis-localisation, and "the task is too hard for this model" and "this sampling
 * configuration degenerates on open-ended localisation" are different verdicts with
 * different remedies. Anything run with CT_THINK=1 is reported SEPARATELY and is not the
 * gate result.
 */
const THINK = process.env.CT_THINK === '1';
/**
 * CT_CLIP unset -> lib.mjs runAgent, whose tool results are clipped at 2,000 chars (the v1
 * gate). CT_CLIP=<n> -> swebench-agent.mjs, identical except results are clipped at n.
 * The v1 diagnosis found the zero-edit loop was the agent widening `grep -A N` past the
 * 2,000-char clip, so the clip is a candidate harness defect and must be varied.
 */
const CLIP = process.env.CT_CLIP ? +process.env.CT_CLIP : null;

/**
 * The model server is shared and the GPU is contended, so a single call can sit for a
 * long time before its first byte. Node's fetch defaults to a 300 s headers timeout and
 * lib.mjs only retries HTTP 5xx — a timeout would abort a whole run and be recorded as a
 * failure that is really a queueing artefact. Relax the global dispatcher instead of
 * tightening anything. Best-effort: this pokes an internal Node symbol, so it is wrapped.
 */
async function relaxFetchTimeouts() {
  const S = Symbol.for('undici.globalDispatcher.1');
  try {
    await fetch('http://127.0.0.1:1/').catch(() => {}); // force lazy dispatcher creation
    const cur = globalThis[S];
    if (!cur) return 'unavailable';
    // FINITE, not 0: an infinite timeout left the thinking-diagnostic arm hung for 25+ min on
    // one dropped stream while the server answered other requests in 0.3 s.
    globalThis[S] = new cur.constructor({ headersTimeout: 900_000, bodyTimeout: 900_000, connectTimeout: 60_000 });
    return 'relaxed';
  } catch (e) { return `unavailable (${e.message})`; }
}

function provisionVerify(instanceId) {
  const py = join(WORK, 'tooling', 'venv', 'bin', 'python');
  try {
    const out = execFileSync(py, [join(HERE, 'swebench_provision.py'), '--verify', instanceId],
      { encoding: 'utf8', timeout: 3_600_000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { usable: /usable=True/.test(out), tail: out.slice(-800) };
  } catch (e) {
    return { usable: false, tail: `${e.stdout || ''}${e.stderr || ''}`.slice(-800) };
  }
}

/**
 * Prove the AGENT'S OWN TOOL LAYER can run the instance's tests, through `execTool` and
 * the real run_bash whitelist — not through a convenient side channel. Without this, a
 * 0/n result is ambiguous between "the model cannot solve it" and "the environment never
 * worked". Three things must hold: `python3` is the instance venv interpreter, `import
 * <pkg>` resolves to the AGENT'S workspace copy (so an edit takes effect), and `pytest`
 * can run one of the repo's existing tests.
 */
function envcheck(task) {
  const ws = makeWorkspace();
  task.seed(ws);
  const pkg = task.importName;
  const probe = execTool(ws, 'run_bash',
    { command: `python3 -c "import sys, ${pkg}; print(sys.executable); print(${pkg}.__file__)"` });
  // 2>&1: period pytest (e.g. 5.x, the pytest repo's own checkout) prints --version to STDERR,
  // and execTool returns only stdout on success — the probe read "(no output)".
  const pytestProbe = execTool(ws, 'run_bash', { command: `python3 -m pytest --version 2>&1` });
  const [exe = '', mod = ''] = String(probe).split('\n');
  const r = {
    instance: task.instanceId,
    interpreter: exe.trim(), package_file: mod.trim(), pytest: String(pytestProbe).split('\n')[0].trim(),
    interpreter_is_instance_venv: exe.trim() === join(dirname(task.python), 'python3'),
    package_resolves_to_workspace: mod.trim().startsWith(ws),
    pytest_available: /pytest \d/.test(String(pytestProbe)),
  };
  r.env_ok = r.interpreter_is_instance_venv && r.package_resolves_to_workspace && r.pytest_available;
  if (!KEEP_WS) rmSync(ws, { recursive: true, force: true });
  return r;
}

/** Prove the grader can both fail and pass before any agent result is believed. */
function selftest(task) {
  const ws = makeWorkspace();
  task.seed(ws);
  const pre = task.gradeDetail(ws);
  // gradeDetail already applied the test patch; now add the gold patch on top.
  const inst = task.__instance;
  execFileSync('git', ['apply', '-'], { cwd: ws, input: inst.patch, encoding: 'utf8' });
  const post = task.gradeDetail(ws);
  if (!KEEP_WS) rmSync(ws, { recursive: true, force: true });
  // Calibrate P2P to this environment (amendment 3): keep the dataset P2P ids that PASS on gold.
  const failed = new Set((post.p2p_failures ?? []).map((s) => s.replace(/ \[[A-Z]+\]$/, '')));
  const p2pEffective = task.p2p.filter((id) => !failed.has(id));
  const coverage = task.p2p.length ? p2pEffective.length / task.p2p.length : 1;
  const validRuns = pre.valid === true && pre.stage === 'ok' && post.valid === true && post.stage === 'ok';
  return {
    instance: task.instanceId,
    pre_fix_f2p_fails: pre.f2p_pass === false,
    gold_f2p_passes: post.f2p_pass === true,
    gold_p2p_passes: post.p2p_pass === true,
    p2p_dataset_n: task.p2p.length, p2p_effective_n: p2pEffective.length, p2p_coverage: +coverage.toFixed(4),
    p2p_dropped: [...failed], p2p_effective: p2pEffective,
    // A runner that did not run is NOT "pre-fix FAIL": both grades must be valid runs.
    grader_ok: validRuns && pre.f2p_pass === false && post.f2p_pass === true && coverage >= P2P_MIN_COVERAGE,
    pre: { ...pre, f2p_tail: undefined, p2p_tail: undefined }, post: { ...post, f2p_tail: undefined, p2p_tail: undefined, p2p_failures: (post.p2p_failures ?? []).slice(0, 20) },
  };
}

async function runCell(task, repeat) {
  const ws = makeWorkspace();
  task.seed(ws);
  const track = { peak: 0 };
  const hook = async (m) => { track.peak = Math.max(track.peak, estTokens(m)); }; // MEASURE ONLY — uncapped

  let err = null, r = null;
  const t0 = Date.now();
  try {
    const opts = {
      system: task.system, task: task.task, ws, maxTurns: MAX_TURNS, think: THINK,
      hook, maxTokens: MAX_TOKENS, allowedTools: task.allowedTools ?? null,
    };
    r = CLIP === null ? await runAgent(opts) : await runAgentClip({ ...opts, clipChars: CLIP });
  } catch (e) {
    err = String(e.message || e).slice(0, 300);
    r = e.partial ?? null; // an ERRORED run keeps its partial trace and spend; it is never scored
  }

  const diff = task.agentDiff(ws);           // BEFORE grading — grading restores test files
  let g;
  try { g = task.gradeDetail(ws); } catch (e) { g = { pass: false, stage: 'grade_threw', error: String(e.message) }; }

  const log = r?.toolLog ?? [];
  const reads = log.filter((t) => t.name === 'read_file');
  const writes = log.filter((t) => t.name === 'write_file');
  const edits = log.filter((t) => t.name === 'edit_file');
  const bash = log.filter((t) => t.name === 'run_bash');
  const touched = [...new Set([...writes, ...edits].map((t) => t.args?.path).filter(Boolean))];
  const ranTests = bash.filter((t) => /pytest|unittest/.test(String(t.args?.command || ''))).length;

  const cell = {
    instance: task.instanceId, repeat,
    repo: task.repo, difficulty: task.difficulty, stratum: stratumOf(task.difficulty),
    files_read: [...new Set(reads.map((t) => t.args?.path).filter(Boolean))],
    pass: !!g.pass, f2p_pass: !!g.f2p_pass, p2p_pass: !!g.p2p_pass, grade_stage: g.stage,
    // false => the grade is VOID (the runner does not run even on the pristine tree); such a
    // cell is excluded from every solvability denominator, never counted as a fail.
    grade_valid: g.valid !== false,
    // false => the RUN errored (retries exhausted, request rejected). Scored as ERRORED,
    // excluded from solvability denominators, never counted as the model failing.
    run_valid: err === null,
    scored: err === null && g.valid !== false,
    endpoint: BASE_URL, model: MODEL,
    providers: r ? [...new Set(r.usage.map((u) => u.provider).filter(Boolean))] : [],
    api_retries: r?.retries ?? null,
    completion_tokens_total: r ? r.usage.reduce((s, u) => s + (u.completion_tokens || 0), 0) : 0,
    reasoning_tokens_total: r ? r.usage.reduce((s, u) => s + (u.reasoning_tokens || 0), 0) : 0,
    cost_usd: r ? +r.usage.reduce((s, u) => s + (u.cost || 0), 0).toFixed(6) : 0,
    finish_reasons: r ? r.usage.reduce((a, u) => ({ ...a, [u.finish_reason ?? 'null']: (a[u.finish_reason ?? 'null'] || 0) + 1 }), {}) : {},
    f2p_failures: g.f2p_failures ?? null, p2p_failures: (g.p2p_failures ?? []).slice(0, 8),
    turns: r?.turns ?? null, stop: r?.stop ?? 'error',
    tool_calls: log.length,
    reads: reads.length, rereads: Math.max(0, reads.length - new Set(reads.map((t) => t.args?.path)).size),
    writes: writes.length, edits: edits.length, files_touched: touched,
    bash_calls: bash.length, bash_rejected: bash.filter((t) => /^error: command/.test(t.out || '')).length,
    test_runs: ranTests,
    clip_chars: CLIP ?? 2000,
    // lib.mjs's toolLog does not record clipping; null there, counted by swebench-agent.mjs.
    clipped_outputs: log.length && 'clipped' in log[0] ? log.filter((t) => t.clipped).length : null,
    max_identical_call_streak: maxIdenticalStreak(log.map((t) => ({ name: t.name, arg: JSON.stringify(t.args ?? {}) }))),
    first_edit_turn: [...writes, ...edits].reduce((m, t) => Math.min(m, t.turn), Infinity) === Infinity
      ? null : [...writes, ...edits].reduce((m, t) => Math.min(m, t.turn), Infinity),
    peak_history_tokens: track.peak,
    total_prompt_tokens: r ? r.usage.reduce((s, u) => s + (u.prompt_tokens || 0), 0) : 0,
    max_prompt_tokens: r ? Math.max(0, ...r.usage.map((u) => u.prompt_tokens || 0)) : 0,
    wall_seconds: Math.round((Date.now() - t0) / 1000),
    error: err,
    agent_diff: diff.slice(0, 6000),
    diff_empty: !/^[+-][^+-]/m.test(diff),
    last_assistant: (r?.messages ?? []).filter((m) => m.role === 'assistant').slice(-1).map((m) => (m.content || '').slice(0, 500))[0] ?? null,
    f2p_tail: g.f2p_tail ?? null,
    // The trace SHAPE is the whole point of a negative result: read forever? edit the
    // wrong file? never run the tests? Keep it compact but complete.
    tool_trace: log.map((t) => ({
      turn: t.turn, name: t.name,
      arg: String(t.args?.command ?? t.args?.path ?? '').slice(0, 160),
      out: String(t.out || '').slice(0, 160),
    })),
  };
  if (!KEEP_WS) rmSync(ws, { recursive: true, force: true });
  return cell;
}

const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };

async function main() {
  const doVerify = process.argv.includes('--verify');
  const doSelftest = process.argv.includes('--selftest');
  const dispatcher = await relaxFetchTimeouts();

  const tasks = [];
  const verifications = [];
  const envchecks = [];
  const selftests = [];
  let selection = null;

  // An instance is admitted only if its prompt does not leak, the agent's own tool layer can
  // run its tests (envcheck), and the grader both fails pre-fix and passes the gold patch
  // over the FULL P2P set (selftest). A failure REJECTS the instance with a recorded reason;
  // it never aborts the run, because the rejection rate is a property of the substrate.
  // CT_SELECT_ONLY=1: resolve the pre-registered selection with HARNESS-INDEPENDENT checks
  // only (F2P overlap, three-way verification, gold-patch grader selftest over the full P2P
  // set), write it, and exit. No agent runs. The envcheck is skipped because it tests THIS
  // loop's run_bash whitelist, which an external host (opencode, D20) does not share.
  const selectOnly = process.env.CT_SELECT_ONLY === '1';
  const admit = (id) => {
    let t;
    try { t = makeSwebenchTask(id); } catch (e) { return { ok: false, reason: `construct: ${String(e.message).slice(0, 200)}` }; }
    t.__instance = loadInstance(id);
    if (!doSelftest) return { ok: true, task: t };
    if (!selectOnly) {
      let e;
      try { e = envcheck(t); } catch (err) { return { ok: false, reason: `envcheck threw: ${String(err.message).slice(0, 200)}` }; }
      envchecks.push(e);
      console.error(`--- envcheck ${id}: interpreter=${e.interpreter_is_instance_venv} workspace-import=${e.package_resolves_to_workspace} pytest=${e.pytest_available} -> ${e.env_ok ? 'OK' : 'BROKEN'}`);
      if (!e.env_ok) return { ok: false, reason: `envcheck: interpreter=${e.interpreter_is_instance_venv} workspace-import=${e.package_resolves_to_workspace} pytest=${e.pytest_available}` };
    }
    let s;
    try { s = selftest(t); } catch (err) { return { ok: false, reason: `selftest threw: ${String(err.message).slice(0, 200)}` }; }
    selftests.push(s);
    console.error(`--- grader selftest ${id}: pre-fix F2P fails=${s.pre_fix_f2p_fails} gold F2P=${s.gold_f2p_passes} gold P2P=${s.gold_p2p_passes} -> ${s.grader_ok ? 'OK' : 'BROKEN'}`);
    if (!s.grader_ok) {
      return { ok: false, reason: `selftest: pre_fix_f2p_fails=${s.pre_fix_f2p_fails} gold_f2p=${s.gold_f2p_passes} p2p_coverage=${s.p2p_coverage} (min ${P2P_MIN_COVERAGE}) ${[...(s.post.f2p_failures ?? []), ...(s.post.p2p_failures ?? [])].slice(0, 3).join('; ')}`.trim() };
    }
    // Grade the agent against the calibrated P2P from here on.
    return { ok: true, task: Object.assign(makeSwebenchTask(id, { p2p: s.p2p_effective }), { __instance: t.__instance }) };
  };

  if (process.env.CT_PREREG) {
    const prereg = JSON.parse(readFileSync(process.env.CT_PREREG, 'utf8'));
    const vpath = process.env.CT_VERIFY_RESULTS;
    if (!vpath) throw new Error('CT_PREREG requires CT_VERIFY_RESULTS');
    const vmap = new Map(JSON.parse(readFileSync(vpath, 'utf8')).results.map((r) => [r.instance_id, r]));
    const admitted = new Map();
    const sel = selectByQuota(prereg.candidates, (c) => {
      const ov = f2pOverlapsPatch(loadInstance(c.instance_id), testPatchTargets);
      if (!ov.ok) return { ok: false, reason: ov.reason };
      const v = vmap.get(c.instance_id);
      if (!v) return { ok: false, reason: 'verify: missing from verify results' };
      if (!v.usable) return { ok: false, reason: `verify: ${v.stage}` };
      const a = admit(c.instance_id);
      if (a.ok) admitted.set(c.instance_id, a.task);
      return a;
    }, { quota: prereg.quota, perRepoCap: prereg.per_repo_cap });
    selection = { prereg: process.env.CT_PREREG, verify_results: vpath, amendments: AMENDMENTS, accepted: sel.accepted, rejected: sel.rejected, skipped: sel.skipped };
    for (const c of sel.accepted) tasks.push(admitted.get(c.instance_id));
    console.error(`--- selection: accepted ${sel.accepted.length}, rejected ${sel.rejected.length}, skipped ${sel.skipped.length}`);
    for (const r of sel.rejected) console.error(`    REJECT ${r.instance_id}: ${r.reason}`);
    if (selectOnly) {
      const path = writeResults('swebench-pilot', `selection-${TAG}.json`, {
        manifest: {
          written_at: nowISO(), commit: gitSha(), mode: 'CT_SELECT_ONLY: harness-independent admission, no agent runs',
          checks: ['f2pOverlapsPatch (amendment 1)', 'leak check on harness text + test ids in the verbatim issue (amendment 2)', 'three-way verification (swebench_provision.py --verify)', `gold-patch grader selftest: pre-fix F2P fails, gold F2P passes, >= ${P2P_MIN_COVERAGE} of dataset P2P passes on gold; the passing subset becomes the graded P2P (amendment 3)`],
          p2p_min_coverage: P2P_MIN_COVERAGE,
          calibrated_p2p: Object.fromEntries(selftests.filter((s) => s.grader_ok).map((s) => [s.instance, { dataset_n: s.p2p_dataset_n, effective_n: s.p2p_effective_n, coverage: s.p2p_coverage, dropped: s.p2p_dropped, effective: s.p2p_effective }])),
          not_applied: 'envcheck — specific to the homegrown loop\'s run_bash whitelist',
        },
        selection, selftests,
      });
      console.error(`  written: ${path}`);
      return;
    }
  } else {
    for (const id of INSTANCES) {
      if (doVerify) {
        console.error(`--- provision verify ${id} ---`);
        const v = provisionVerify(id);
        verifications.push({ instance: id, ...v });
        console.error(`    usable=${v.usable}`);
        if (!v.usable) { console.error(`    SKIPPING ${id} (did not verify three ways)`); continue; }
      }
      const a = admit(id);
      if (!a.ok) { console.error(`    REJECT ${id}: ${a.reason}`); continue; }
      tasks.push(a.task);
    }
    if (selectOnly) {
      const path = writeResults('swebench-pilot', `selection-${TAG}.json`, {
        manifest: { written_at: nowISO(), commit: gitSha(), mode: 'CT_SELECT_ONLY: grader selftest only, no agent runs', instances: INSTANCES },
        admitted: tasks.map((t) => t.instanceId), selftests,
      });
      console.error(`  written: ${path}`);
      return;
    }
  }
  if (!tasks.length) { console.error('no usable instances'); process.exit(2); }

  const cells = [];
  for (const t of tasks) {
    console.error(`\n=== ${t.name} ===`);
    for (let rep = 0; rep < REPEATS; rep++) {
      console.error(`--- ${t.instanceId} rep${rep} (UNCAPPED) ---`);
      const c = await runCell(t, rep);
      cells.push(c);
      console.error(`    -> ${c.pass ? 'PASS' : 'FAIL'} f2p=${c.f2p_pass} p2p=${c.p2p_pass} turns=${c.turns} stop=${c.stop} peak=${c.peak_history_tokens} maxprompt=${c.max_prompt_tokens} touched=${JSON.stringify(c.files_touched)} ${c.wall_seconds}s`);
    }
  }

  const byInstance = new Map();
  for (const c of cells) { if (!byInstance.has(c.instance)) byInstance.set(c.instance, []); byInstance.get(c.instance).push(c); }
  const summary = [...byInstance.entries()].map(([id, all]) => ({ id, all, cs: all.filter((c) => c.scored) })).map(({ id, all, cs }) => ({
    instance: id, n: cs.length, n_errored_or_void: all.length - cs.length, repo: all[0].repo, difficulty: all[0].difficulty,
    cost_usd_total: +all.reduce((s, c) => s + c.cost_usd, 0).toFixed(4),
    pass_rate: cs.length ? cs.filter((c) => c.pass).length / cs.length : null,
    f2p_rate: cs.length ? cs.filter((c) => c.f2p_pass).length / cs.length : null,
    p2p_rate: cs.length ? cs.filter((c) => c.p2p_pass).length / cs.length : null,
    turns_median: med(cs.map((c) => c.turns ?? MAX_TURNS)),
    turns_min: Math.min(...cs.map((c) => c.turns ?? MAX_TURNS)),
    turns_max: Math.max(...cs.map((c) => c.turns ?? MAX_TURNS)),
    peak_history_median: med(cs.map((c) => c.peak_history_tokens)),
    peak_history_max: Math.max(...cs.map((c) => c.peak_history_tokens)),
    max_prompt_tokens_max: Math.max(...cs.map((c) => c.max_prompt_tokens)),
    total_tokens_median: med(cs.map((c) => c.total_prompt_tokens)),
    reads_median: med(cs.map((c) => c.reads)),
    rereads_median: med(cs.map((c) => c.rereads)),
    test_runs_median: med(cs.map((c) => c.test_runs)),
    empty_diff_runs: cs.filter((c) => c.diff_empty).length,
    zero_edit_runs: cs.filter((c) => c.writes + c.edits === 0).length,
    max_identical_call_streak_median: med(cs.map((c) => c.max_identical_call_streak)),
    stops: cs.reduce((a, c) => ({ ...a, [c.stop]: (a[c.stop] || 0) + 1 }), {}),
    wall_seconds_median: med(cs.map((c) => c.wall_seconds)),
  }));

  const out = {
    manifest: {
      run_id: `swebench-pilot-${TAG}-${Date.now()}`,
      experiment: 'context-dedup / SWE-bench Verified SOLVABILITY PILOT (gate on backlog item 9)',
      model: MODEL, instances: INSTANCES, repeats: REPEATS, max_turns: MAX_TURNS,
      max_completion_tokens: MAX_TOKENS, temperature: 0, think: THINK, arm: THINK ? 'DIAGNOSTIC (thinking enabled) — NOT the gate result' : 'GATE (standard harness config: thinking disabled)',
      clip_chars: CLIP ?? 2000, agent_loop: CLIP === null ? 'coding-harness/lib.mjs runAgent' : 'context-dedup/swebench-agent.mjs runAgentClip',
      endpoint: BASE_URL, reasoning_off_param: REASONING_OFF,
      price_per_million_usd_as_stated_at_run_time: BASE_URL.includes('openrouter') ? { input: 0.214, output: 2.55 } : null,
      capped: false, eviction: 'none',
      middleware: 'none', dispatcher, commit: gitSha(), date: nowISO(),
      question: 'Can the local 27B solve a three-way-verified SWE-bench instance with UNLIMITED context?',
      why: 'If it cannot, a context-policy sweep on SWE-bench measures task difficulty, not context policy. NEGATIVE CONTROL on the substrate, not a capability demo.',
      falsification: 'A 0/n pass rate at temperature 0 with unlimited context means the substrate is unusable for the window/eviction experiments as-is.',
      second_question: 'Does an uncapped SWE-bench run generate enough context pressure for a window policy to bind? If peak_history_tokens stays far below a deployment window, the substrate fails for a second, independent reason (constraint C1: with a shell, agents shrink their own context).',
      caveats: [
        'ONE instance family (psf/requests) unless CT_SWEBENCH_INSTANCES says otherwise — this is a gate, not a benchmark score.',
        'The prompt was NOT tuned against the outcome; the first honest configuration is the reported one.',
        'The agent never sees the gold patch, the test patch, or any F2P/P2P test id (asserted at construction by assertNoTestLeak).',
        'run_bash has a 30 s timeout and tool output is clipped at ~2000 chars (experiments/coding-harness/lib.mjs) — an agent that wants to run a whole suite will be cut off.',
        'The model server is shared and GPU-contended; wall_seconds is not a clean latency measure.',
        'temperature 0, but this host is not bit-reproducible across runs (lib.mjs jitters the sampler after repeated 5xx; see RETRY_STATS).',
      ],
      retry_stats: { ...RETRY_STATS },
      verifications, envchecks, selftests, selection,
    },
    summary, cells,
  };
  const path = writeResults('swebench-pilot', `results-swebench-pilot-${TAG}.json`, out);

  console.error(`\n=== SWE-BENCH SOLVABILITY PILOT (UNCAPPED) model=${MODEL} n=${REPEATS} ===`);
  console.error('  instance                 n  pass  f2p   p2p   turns(med/min-max)  peak_hist  maxprompt  reads  tests');
  for (const s of summary) {
    console.error(`  ${s.instance.padEnd(24)} ${s.n}  ${(s.pass_rate * 100).toFixed(0).padStart(3)}%  ${(s.f2p_rate * 100).toFixed(0).padStart(3)}%  ${(s.p2p_rate * 100).toFixed(0).padStart(3)}%  ${String(s.turns_median).padStart(5)} (${s.turns_min}-${s.turns_max})   ${String(s.peak_history_median).padStart(7)}  ${String(s.max_prompt_tokens_max).padStart(8)}  ${String(s.reads_median).padStart(5)}  ${s.test_runs_median}`);
  }
  console.error(`  written: ${path}`);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
