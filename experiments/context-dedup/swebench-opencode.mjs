/**
 * SWE-bench pilot — agent runs through OPENCODE (D20: evaluation runs in an external host,
 * not an in-repo loop). Replaces the homegrown loop, whose 2,000-char tool-output clip caused
 * the v1 zero-edit result. Everything harness-independent is reused unchanged: the
 * pre-registered draw, verification, gold-patch/P2P calibration (selection-v2.json), and
 * grading (ab-tasks/swebench.mjs gradeDetail on the workspace opencode edited).
 *
 * Invocation (verified by the coordinator; four traps each silently waste a run):
 *   opencode run --pure -m <model> --format json --dir <ws> --auto "<prompt>" < /dev/null
 *   - stdin MUST be /dev/null, or `run` waits forever with no output;
 *   - XDG_{CONFIG,DATA,STATE,CACHE}_HOME are isolated per run, so runs cannot see each
 *     other's sessions and the user's real opencode data is untouched;
 *   - --auto approves shell commands, so --dir is ALWAYS the per-run scratch workspace;
 *   - the session is exported with the SAME XDG env, using the id from the event stream.
 * No tool-output clip is added: opencode's own tools decide what the agent sees. Thinking is
 * ON on every endpoint (the host default; nothing in opencode.json disables it). Uncapped, no
 * eviction, no middleware.
 *
 * ENDPOINT, per run. CT_OPENCODE_MODEL=auto (the default) runs on the LOCAL model when one of
 * its 4 connection slots is free and falls back to OpenRouter (pinned DeepInfra bf16)
 * otherwise; see swebench-endpoint.mjs. CT_LOCAL_EXCLUSIVE=1 is for runs expected to stress the
 * device: local only when nothing else is using it. An explicit model id pins the endpoint.
 * The endpoint and the evidence behind the choice are recorded per cell, because local
 * (quantized GGUF) and OpenRouter (bf16) are different weights: compare within an endpoint.
 *
 * The instance interpreter reaches opencode's shell by PATH (venv bin first) and PYTHONPATH
 * (the workspace), set on the opencode process environment; the prompt states it.
 *
 *   node experiments/context-dedup/swebench-opencode.mjs            # CT_INSTANCES or selection
 *   CT_INSTANCES=psf__requests-2931 CT_TAG=probe node experiments/context-dedup/swebench-opencode.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, openSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSwebenchTask, WORK, pythonPathFor, assertNoTestLeak, loadInstance } from './ab-tasks/swebench.mjs';
import { stratumOf } from './swebench-draw.mjs';
import { parseJsonLines, sessionIdOf, summarizeEvents, costAt, classifyExit, summarizeExport, eventsCompleteAgainstExport } from './swebench-opencode-events.mjs';
import { chooseEndpoint, LEASE_MARKER, MAX_LOCAL_SLOTS } from './swebench-endpoint.mjs';
import { writeResults, gitSha, nowISO } from '../rung-1-live-probe/lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const OUTDIR = join(REPO, 'reports', 'metrics', 'swebench-pilot');
const MODEL_REQUEST = process.env.CT_OPENCODE_MODEL || 'auto';
const EXCLUSIVE = process.env.CT_LOCAL_EXCLUSIVE === '1';
const TAG = process.env.CT_TAG || 'opencode';
const RUN_TIMEOUT_S = +(process.env.CT_RUN_TIMEOUT_S || 3600);
const RUNS_ROOT = process.env.CT_RUNS_ROOT || join(WORK, 'opencode-runs');
const SELECTION = join(OUTDIR, process.env.CT_SELECTION_FILE || 'selection-v2.json');
const OPENCODE_CONFIG = join(HERE, 'opencode.json');

/** List prices per million tokens. Local runs have no per-token price. */
const pricesFor = (model) => (model.startsWith('openrouter/qwen/qwen3.8-27b') ? { input: 0.214, output: 2.55 } : null);
const endpointOf = (model) => (model.startsWith('local/') ? 'local' : model.split('/')[0]);

/**
 * The model's CONFIGURED limits and options, as opencode will apply them. Recorded per run: an
 * undefended `limit.output` placeholder (16,384) capped a response in the first tranche and
 * made a run look like a model failure.
 */
function modelConfig(model) {
  try {
    const cfg = JSON.parse(readFileSync(OPENCODE_CONFIG, 'utf8'));
    const [provider, ...rest] = model.split('/');
    const entry = cfg.provider?.[provider]?.models?.[rest.join('/')];
    if (!entry) return { configured: false, limit_output: null, limit_context: null, options: null };
    return { configured: true, limit_output: entry.limit?.output ?? null, limit_context: entry.limit?.context ?? null, options: entry.options ?? null };
  } catch (e) { return { configured: false, error: String(e.message) }; }
}

/** The endpoint for ONE run: auto-selected, or pinned by an explicit CT_OPENCODE_MODEL. */
function resolveModel() {
  if (MODEL_REQUEST !== 'auto') {
    return { model: MODEL_REQUEST, endpoint: endpointOf(MODEL_REQUEST), reason: 'pinned by CT_OPENCODE_MODEL',
      signals: null, marker: null, release: () => {}, decided_at: new Date().toISOString() };
  }
  return chooseEndpoint({ exclusive: EXCLUSIVE });
}

const opencodeVersion = () => spawnSync('opencode', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).stdout.trim();

/** Prompt = the pilot's framing + verbatim issue + environment facts; no hint, no test names. */
function promptFor(task) {
  const statement = task.task; // framing + verbatim problem_statement (leak-checked at construction)
  const runner = task.repo === 'django/django' ? '`python tests/runtests.py <app.module.Class.test>`' : '`python -m pytest <path>::<test>`';
  const harnessLines = [
    'Environment: the repository is checked out at the relevant older commit in the current directory.',
    `\`python\`/\`python3\` on PATH is this project's own virtual environment (${task.python}) with its dependencies installed, and the current directory is first on the import path. Tests run with ${runner}. There is no network access.`,
    'Fix the library source so the reported problem is resolved without breaking existing behaviour. Do not modify test files; the fix is graded by tests you cannot see.',
  ];
  // These lines are harness-authored, so they get the full leak check (patch lines included).
  const inst = task.__instance ?? loadInstance(task.instanceId);
  assertNoTestLeak({ text: harnessLines.join('\n'), f2p: task.f2p, p2p: task.p2pDataset, goldPatch: inst.patch, testPatch: inst.test_patch });
  return [statement, '', ...harnessLines].join('\n');
}

/** Other `opencode run` processes on the host (not ours). Forensics for external kills. */
function otherOpencodeRuns(ownPid = null) {
  const r = spawnSync('pgrep', ['-f', '^opencode run'], { encoding: 'utf8' });
  return (r.stdout || '').split('\n').filter(Boolean).map(Number).filter((p) => p !== ownPid).length;
}

function runOpencode({ ws, runDir, prompt, env, model }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const othersAtStart = otherOpencodeRuns();
    const out = join(runDir, 'events.jsonl');
    // stdout/stderr go to FILE descriptors, not pipes: opencode exits before flushing a large
    // final write into a pipe (a piped export arrived cut at 146,176 of 430,431 bytes).
    const outFd = openSync(out, 'w');
    const errFd = openSync(join(runDir, 'stderr.log'), 'w');
    const p = spawn('opencode', ['run', '--pure', '-m', model, '--format', 'json', '--dir', ws, '--auto', prompt], {
      cwd: ws, env, stdio: ['ignore', outFd, errFd], detached: true, // stdio[0]='ignore' == < /dev/null
    });
    let timedOut = false;
    // Our own timeout uses SIGKILL, so any SIGTERM/SIGINT in the record came from OUTSIDE.
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-p.pid, 'SIGKILL'); } catch {} }, RUN_TIMEOUT_S * 1000);
    let othersPeak = othersAtStart;
    const poll = setInterval(() => { othersPeak = Math.max(othersPeak, otherOpencodeRuns(p.pid)); }, 15_000);
    p.on('close', (code, signal) => {
      clearTimeout(timer); clearInterval(poll);
      closeSync(outFd); closeSync(errFd);
      const stdout = readFileSync(out, 'utf8');
      const stderr = readFileSync(join(runDir, 'stderr.log'), 'utf8');
      resolve({
        code, signal, timedOut, wall_seconds: Math.round((Date.now() - t0) / 1000), stdout, stderr,
        killed_externally: !timedOut && signal !== null && signal !== 'SIGKILL',
        other_opencode_runs_at_start: othersAtStart, other_opencode_runs_peak: othersPeak,
        ended_at: new Date().toISOString(),
      });
    });
  });
}

/**
 * `opencode export` to a FILE (never a pipe), with the run's own XDG env, then check the
 * captured event stream against it. Exported for swebench-opencode-finalize.mjs.
 */
export function exportSession({ runDir, ws, env, sessionID, eventSummary, reexport = true }) {
  const res = { export_ok: false, export_part_types: null, export_bytes: 0, events_complete: null, missing_steps: null, missing_tool_calls: null, summary: null };
  if (!sessionID) return res;
  const file = join(runDir, 'export.json');
  // `reexport: false` re-derives the summary from an export ALREADY on disk. Used to backfill new
  // fields into old results without starting opencode: it makes a model call at init (session
  // titling), so on a busy local host a re-export can hang and, worse, take a connection slot
  // from a live run in another session.
  if (!(reexport === false && existsSync(file))) {
    const fd = openSync(file, 'w');
    const errFd = openSync(join(runDir, 'export.stderr.log'), 'w');
    const r = spawnSync('opencode', ['export', sessionID], { cwd: ws, env, stdio: ['ignore', fd, errFd], timeout: 600_000 });
    closeSync(fd); closeSync(errFd);
    if (r.status !== 0) return res;
  }
  const text = readFileSync(file, 'utf8');
  res.export_bytes = Buffer.byteLength(text);
  try {
    const summary = summarizeExport(JSON.parse(text.slice(text.indexOf('{'))));
    res.export_ok = true;
    res.export_part_types = summary.part_types;
    res.summary = summary;
    const c = eventsCompleteAgainstExport(eventSummary, summary);
    Object.assign(res, { events_complete: c.complete, missing_steps: c.missing_steps, missing_tool_calls: c.missing_tool_calls });
  } catch {}
  return res;
}

async function runOne(task, repeat) {
  const runDir = join(RUNS_ROOT, TAG, `${task.instanceId}__r${repeat}`);
  rmSync(runDir, { recursive: true, force: true });
  const ws = join(runDir, 'workspace');
  const xdg = Object.fromEntries(['config', 'data', 'state', 'cache'].map((k) => [`XDG_${k.toUpperCase()}_HOME`, join(runDir, 'xdg', k)]));
  for (const d of Object.values(xdg)) mkdirSync(d, { recursive: true });
  task.seed(ws);                                     // copies the pristine tree; sets PATH/PYTHONPATH on process.env

  const sel = resolveModel();
  const model = sel.model;
  console.error(`    endpoint: ${sel.endpoint} (${model}) — ${sel.reason}`);
  const env = {
    ...process.env, ...xdg, OPENCODE_CONFIG,
    PATH: `${dirname(task.python)}:${process.env.PATH}`,
    PYTHONPATH: pythonPathFor(ws), PYTHONDONTWRITEBYTECODE: '1',
    // A run holding a local slot is counted by its lease; the marker stops the host scan from
    // counting its opencode process a second time.
    ...(sel.marker !== null && sel.marker !== undefined ? { [LEASE_MARKER]: sel.marker } : {}),
  };
  const prompt = promptFor(task);
  writeFileSync(join(runDir, 'prompt.txt'), prompt);

  // The slot is released as soon as opencode exits — grading never touches the model — and on
  // any throw, so a failed run cannot hold a local connection slot.
  let r;
  try { r = await runOpencode({ ws, runDir, prompt, env, model }); } finally { sel.release(); }
  const { events, bad } = parseJsonLines(r.stdout);
  const sessionID = sessionIdOf(events);
  const s = summarizeEvents(events);

  const ex = exportSession({ runDir, ws, env, sessionID, eventSummary: s });
  const exportOk = ex.export_ok, exportParts = ex.export_part_types;

  const diff = task.agentDiff(ws);
  let g;
  try { g = task.gradeDetail(ws); } catch (e) { g = { pass: false, valid: false, stage: 'grade_threw', error: String(e.message) }; }

  const prices = pricesFor(model);
  const exitClass = classifyExit({ code: r.code, signal: r.signal, timedOut: r.timedOut, steps: s.steps, errors: s.errors.length });
  const runValid = exitClass.valid;
  const cell = {
    instance: task.instanceId, repeat, repo: task.repo, difficulty: task.difficulty, stratum: stratumOf(task.difficulty),
    vehicle: 'opencode', opencode_version: opencodeVersion(), model, model_config: modelConfig(model),
    endpoint: sel.endpoint,
    endpoint_selection: { request: MODEL_REQUEST, exclusive: EXCLUSIVE, reason: sel.reason, signals: sel.signals, decided_at: sel.decided_at },
    pass: !!g.pass, f2p_pass: !!g.f2p_pass, p2p_pass: !!g.p2p_pass, grade_stage: g.stage, grade_valid: g.valid !== false,
    f2p_failures: g.f2p_failures ?? null, p2p_failures: (g.p2p_failures ?? []).slice(0, 10),
    p2p_graded_n: task.p2p.length, p2p_dataset_n: task.p2pDataset.length,
    run_valid: runValid, scored: runValid && g.valid !== false,
    exit_code: r.code, signal: r.signal, timed_out: r.timedOut, wall_seconds: r.wall_seconds,
    exit_outcome: exitClass.outcome,
    killed_externally: exitClass.killed_externally, other_opencode_runs_at_start: r.other_opencode_runs_at_start,
    other_opencode_runs_peak: r.other_opencode_runs_peak, ended_at: r.ended_at,
    last_event_type: events.length ? events[events.length - 1].type ?? null : null,
    error: r.timedOut ? `timeout after ${RUN_TIMEOUT_S}s`
      : r.killed_externally ? `killed externally by ${r.signal} (not this runner; mid-step: last event ${events.length ? events[events.length - 1].type : 'none'})`
        : s.errors[0] ?? (r.code !== 0 ? `exit ${r.code}` : null),
    steps: s.steps, tool_calls: s.tool_calls, tools_by_name: s.tools_by_name, tool_errors: s.tool_errors,
    files_edited: s.files_edited, files_read: s.files_read, reads: s.reads,
    diff_empty: !/^[+-][^+-]/m.test(diff), agent_diff: diff.slice(0, 6000),
    tokens: s.tokens, peak_prompt_tokens: s.peak_prompt_tokens, first_step_prompt_tokens: s.first_step_prompt_tokens,
    cost_reported: s.cost_reported, cost_list_price: prices ? costAt(s.tokens, prices) : null,
    events: events.length, events_unparseable: bad, session_id: sessionID,
    export_ok: exportOk, export_part_types: exportParts, export_bytes: ex.export_bytes,
    events_complete: ex.events_complete, events_missing_steps: ex.missing_steps, events_missing_tool_calls: ex.missing_tool_calls,
    run_dir: runDir,
  };
  console.error(`    -> ${cell.pass ? 'PASS' : 'FAIL'} [${cell.endpoint}] f2p=${cell.f2p_pass} p2p=${cell.p2p_pass} valid=${cell.scored} steps=${cell.steps} tools=${cell.tool_calls} edited=${cell.files_edited.length} peak=${cell.peak_prompt_tokens} cost=${cell.cost_reported} ${cell.wall_seconds}s ${cell.error ?? ''}`);
  return cell;
}

/** Group by repo; run repos in drawn order, one instance at a time (never two from one repo concurrently). */
async function main() {
  const selection = existsSync(SELECTION) ? JSON.parse(readFileSync(SELECTION, 'utf8')) : null;
  const calibrated = selection?.manifest?.calibrated_p2p ?? {};
  const ids = process.env.CT_INSTANCES
    ? process.env.CT_INSTANCES.split(',').map((s) => s.trim()).filter(Boolean)
    : selection.selection.accepted.map((c) => c.instance_id);
  const repeats = +(process.env.CT_REPEATS || 1);

  const cells = [];
  for (const id of ids) {
    const cal = calibrated[id];
    const task = cal ? makeSwebenchTask(id, { p2p: cal.effective }) : makeSwebenchTask(id);
    console.error(`=== ${task.name} (P2P graded ${task.p2p.length}/${task.p2pDataset.length}) ===`);
    for (let r = 0; r < repeats; r++) cells.push(await runOne(task, r));
    writeResults('swebench-pilot', `results-swebench-opencode-${TAG}.json`, manifestAndCells(ids, cells, selection));
  }
  const path = writeResults('swebench-pilot', `results-swebench-opencode-${TAG}.json`, manifestAndCells(ids, cells, selection));
  console.error(`written: ${path}`);
}

function manifestAndCells(ids, cells, selection) {
  const models = [...new Set(cells.map((c) => c.model))];
  return {
    manifest: {
      run_id: `swebench-opencode-${TAG}`, date: nowISO(), commit: gitSha(),
      vehicle: 'opencode', opencode_version: opencodeVersion(),
      // A single model when every run landed on one endpoint; otherwise see each cell.
      model: models.length === 1 ? models[0] : MODEL_REQUEST,
      models_used: models,
      endpoint_policy: MODEL_REQUEST === 'auto'
        ? `auto: local when one of ${MAX_LOCAL_SLOTS} connection slots is free${EXCLUSIVE ? ' and NOTHING else is using the device (exclusive)' : ''}, else OpenRouter pinned DeepInfra bf16; decided per run, recorded per cell`
        : `pinned: ${MODEL_REQUEST}`,
      endpoints_used: Object.fromEntries(['local', 'openrouter'].map((e) => [e, cells.filter((c) => c.endpoint === e).length])),
      invocation: 'opencode run --pure -m <model> --format json --dir <ws> --auto <prompt> < /dev/null; per-run XDG dirs; export with same XDG env',
      config: 'experiments/context-dedup/opencode.json (no credential in file)',
      model_configs: Object.fromEntries(models.map((m) => [m, modelConfig(m)])),
      host_defaults: 'thinking ON on every endpoint (host default), no tool-output clip, no cap, no eviction, no middleware',
      run_timeout_s: RUN_TIMEOUT_S, instances: ids,
      selection_file: selection ? SELECTION.split('/').pop() : null,
      grading: 'ab-tasks/swebench.mjs gradeDetail after opencode exits: restore test-patch files, apply test patch, run the instance runner over F2P + calibrated P2P; void grades and errored runs excluded from rates',
      prices_per_million_usd: Object.fromEntries(models.map((m) => [m, pricesFor(m)])),
    },
    cells,
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main().catch((e) => { console.error('FATAL', e); process.exit(1); });
