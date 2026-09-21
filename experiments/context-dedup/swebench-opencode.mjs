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
 * SANDBOX (default on; CT_SANDBOX=0 disables it and says so in the results): opencode runs under
 * bubblewrap with no network and no view of the dataset, repos/, wscache/, other runs or the
 * operator's home — see swebench-sandbox.mjs. Each run's preflight is recorded in its cell.
 *
 *   node experiments/context-dedup/swebench-opencode.mjs            # CT_INSTANCES or selection
 *   CT_INSTANCES=psf__requests-2931 CT_TAG=probe node experiments/context-dedup/swebench-opencode.mjs
 *   CT_REPEATS=1 CT_REPEAT_START=1 CT_TAG=w2 ...   # a later wave numbered r1, to merge with an r0 wave
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, openSync, closeSync, realpathSync } from 'node:fs';
import { constants as osConstants, homedir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSwebenchTask, WORK, pythonPathFor, assertNoTestLeak, loadInstance } from './ab-tasks/swebench.mjs';
import { stratumOf } from './swebench-draw.mjs';
import { parseJsonLines, sessionIdOf, summarizeEvents, costAt, classifyExit, summarizeExport, eventsCompleteAgainstExport } from './swebench-opencode-events.mjs';
import { chooseEndpoint, acquireSlots, LEASE_MARKER, MAX_LOCAL_SLOTS } from './swebench-endpoint.mjs';
import { openSandbox, exitFromSandbox, pythonHomeOf, MASKED, MASKED_LIBRARIES } from './swebench-sandbox.mjs';
import { writeResults, gitSha, nowISO } from '../rung-1-live-probe/lib.mjs';
import { policyFromEnv, validatePolicy } from './oc-plugin/policy.mjs';

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
const SANDBOX = process.env.CT_SANDBOX !== '0';
const SANDBOX_ASSETS = process.env.CT_SANDBOX_ASSETS || join(WORK, 'tooling', 'opencode-sandbox');
/**
 * The arm (U5, U18–U20):
 *   off  the host's own context handling — the control
 *   mcp  the context-tree MCP tools, host still owns the prompt
 *   ct   the tools PLUS the assembly plugin: context-tree decides what the model sees
 *
 * `ct` also needs `CT_CT_TRIGGER` (off|hard|soft|cadence) and its window; those are read
 * by the sidecar, and recorded here so a cell says which arm produced it.
 */
const ARM = process.env.CT_ARM || 'off';
const WANTS_SIDECAR = ARM === 'mcp' || ARM === 'ct';
const WANTS_PLUGIN = ARM === 'ct';
/**
 * G0 (mutation visibility) — the gate, never a measured run. `CT_G0_MARKER` puts a unique
 * token in the task statement and hands it to the relay as a needle, so the wire record
 * says whether that message reached the provider; `CT_G0_DROP_FIRST` tells the sidecar to
 * drop exactly that message. Both perturb the run on purpose — one changes the prompt, the
 * other removes the task — so a cell carrying either is a gate cell and not a result.
 */
const G0_MARKER = process.env.CT_G0_MARKER || '';
const G0_FOLD_MARKER = process.env.CT_G0_FOLD_MARKER || '';
const G0_FOLD_TEXT = G0_FOLD_MARKER ? `Continue the task. Harness marker: ${G0_FOLD_MARKER}` : '';
const G0_DROP_FIRST = process.env.CT_G0_DROP_FIRST === '1';
/**
 * The arm, in two halves that travel to two processes. POLICY (when to evict, at what
 * window) is the plugin's and rides on opencode's process env; PIPELINE (the server
 * defaults of the tools it calls — every one PROVISIONAL in core, so every one a knob)
 * is the sidecar's and rides on the MCP `environment` block. Both are named here so a
 * cell says exactly which arm produced it; an unset knob is recorded as `null`, meaning
 * the package default, which the sidecar's own `ready` row then spells out.
 */
const POLICY_KEYS = Object.freeze({
    CT_CT_TRIGGER: 'soft', CT_CT_WINDOW: '50347', CT_CT_HARD_WINDOW: '151040', CT_CT_CADENCE_N: '5',
    CT_CT_SUMMARIES: '0', CT_CT_REPLY_RESERVE: '8192', CT_CT_HEAD_TOKENS: '12000', CT_CT_PROTECT_TAIL: '6',
});
const PIPELINE_KEYS = Object.freeze([
    'CT_CT_ANCHOR', 'CT_CT_W_PRIORITY', 'CT_CT_W_RECENCY', 'CT_CT_W_REFRECENCY', 'CT_CT_W_DORMANCY',
    'CT_CT_PRIORITY_HALFLIFE', 'CT_CT_EVICT_HEADROOM', 'CT_CT_SOFT_TARGET_FRAC', 'CT_CT_REDUCER',
    'CT_CT_DRIFT_K', 'CT_CT_DRIFT_TAU', 'CT_CT_RRF_K', 'CT_CT_CHUNK_SIZE', 'CT_CT_CHUNK_OVERLAP',
    'CT_CT_NEUTRAL_PHASES', 'CT_CONTRACT',
]);
const fromEnv = (keys) => Object.fromEntries(keys.filter((k) => process.env[k] !== undefined && process.env[k] !== '').map((k) => [k, process.env[k]]));
const POLICY_ENV = Object.freeze(Object.fromEntries(Object.entries(POLICY_KEYS).map(([k, d]) => [k, process.env[k] || d])));
// CT_CT_PROTECT_TAIL is both: the plugin passes it per call, the sidecar holds the default.
const PIPELINE_ENV = Object.freeze({ ...fromEnv(PIPELINE_KEYS), CT_CT_PROTECT_TAIL: POLICY_ENV.CT_CT_PROTECT_TAIL });
const ASSEMBLE_PORT = process.env.CT_ASSEMBLE_PORT || '8899';
const ASSEMBLE_MS = process.env.CT_ASSEMBLE_MS || '8000';
const CT_OPTIONS = Object.freeze({
    ...POLICY_ENV, ...PIPELINE_ENV, CT_ASSEMBLE_PORT: ASSEMBLE_PORT, CT_ASSEMBLE_MS: ASSEMBLE_MS,
    // Recorded, not just forwarded: a gate cell has to be unmistakable in the results file.
    ...(G0_DROP_FIRST ? { CT_G0_DROP_FIRST: '1', CT_G0_FOLD_TEXT: G0_FOLD_TEXT } : {}),
});
/** What the SIDECAR needs. The policy never goes there: a sidecar cannot evict by itself any more. */
const SIDECAR_ENV = Object.freeze({
    ...PIPELINE_ENV, CT_ASSEMBLE_PORT: ASSEMBLE_PORT,
    ...(G0_DROP_FIRST ? { CT_G0_DROP_FIRST: '1', CT_G0_FOLD_TEXT: G0_FOLD_TEXT } : {}),
});
/**
 * The arm's window in tokens (0 = the model's declared context). opencode compacts at
 * `limit.context − output cap`, so the window is imposed by declaring it, and the output
 * cap moves with it — at a 1/3 window the default 32,000-token cap would leave a
 * threshold below opencode's own ~9,898 tokens of overhead and compact on turn one.
 */
const WINDOW = +(process.env.CT_WINDOW || 0);
const OUTPUT_CAP = +(process.env.CT_OUTPUT_CAP || (WINDOW > 0 ? Math.max(4096, Math.round(WINDOW / 6)) : 0));

/**
 * What the sandbox preflight asserts for one run: the answer sources are absent, and every
 * masked directory above a visible path holds only the entries this run needs.
 */
export function sandboxExpectations({ work, runsRoot, tag, runDir, venv, pythonHomes, home, repo, arm = 'off', exists = existsSync }) {
    const hidden = ['dataset', 'repos', 'wscache', 'runs', 'locks'].map((d) => join(work, d)).concat([home, repo]);
    const only = { '/tmp': [], '/home': ['.ct-sandbox', 'agent'], [runsRoot]: [tag], [join(runsRoot, tag)]: [basename(runDir)], [runDir]: arm === 'off' ? ['sandbox', 'workspace', 'xdg'] : ['mcp', 'sandbox', 'workspace', 'xdg'] };
    // A masked library directory still exists (as an empty tmpfs), so it is asserted empty.
    for (const lib of MASKED_LIBRARIES) if (exists(lib)) only[lib] = [];
    const underMask = (d) => MASKED.some((m) => d === m || d.startsWith(`${m}/`));
    for (const p of [runsRoot, venv, ...pythonHomes]) {
        const parts = p.split('/').filter(Boolean);
        for (let i = 1; i < parts.length; i++) {
            const dir = `/${parts.slice(0, i).join('/')}`;
            if (underMask(dir)) only[dir] = [...new Set([...(only[dir] ?? []), parts[i]])];
        }
    }
    return { hidden, only };
}

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

/**
 * The endpoint for ONE run: auto-selected, or pinned by an explicit CT_OPENCODE_MODEL.
 *
 * A PINNED LOCAL model still takes a lease. It used to return `release: () => {}` and no marker,
 * so `-m local/...` ran holding no slot: invisible to every other session's capacity check, which
 * counts leases. Three pinned shards would then be three uncounted connections on a 4-connection
 * host, and the failure is silent — opencode's start-up model call blocks with no session, no
 * error and no log line, taking down the OTHER session's runs as readily as our own.
 * Waiting for a slot is correct here: the alternative is corrupting someone's in-flight cell.
 */
function resolveModel() {
    if (MODEL_REQUEST === 'auto') return chooseEndpoint({ exclusive: EXCLUSIVE });
    const endpoint = endpointOf(MODEL_REQUEST);
    if (endpoint !== 'local') {
        return {
            model: MODEL_REQUEST, endpoint, reason: 'pinned by CT_OPENCODE_MODEL (remote: no local slot needed)',
            signals: null, marker: null, release: () => { }, decided_at: new Date().toISOString()
        };
    }
    const lease = acquireSlots({ exclusive: EXCLUSIVE });
    if (!lease.slots.length) {
        throw new Error(
            `pinned local model ${MODEL_REQUEST} but no local slot is free (${MAX_LOCAL_SLOTS} in use). `
            + 'Refusing to run unleased: an unleased local run is invisible to other sessions and can hang '
            + 'them at start-up. Wait for a slot, or set CT_OPENCODE_MODEL=auto to fall back to OpenRouter.',
        );
    }
    return {
        model: MODEL_REQUEST, endpoint, reason: `pinned by CT_OPENCODE_MODEL; holds local slot ${lease.slots.join(',')}`,
        signals: { pinned: true, slots: lease.slots }, marker: String(lease.slots[0]), release: lease.release,
        decided_at: new Date().toISOString()
    };
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
        'Do a review of your code changes, and fix any issues you find.',
        // G0 only. A random token the model has no reason to reproduce, so its presence on
        // the wire means THIS message was sent, not that the agent quoted it back.
        ...(G0_MARKER ? [`Ignore this line; it is a harness marker: ${G0_MARKER}`] : []),
    ];
    // These lines are harness-authored, so they get the full leak check (patch lines included).
    const inst = task.__instance ?? loadInstance(task.instanceId);
    assertNoTestLeak({ text: harnessLines.join('\n'), f2p: task.f2p, p2p: task.p2pDataset, goldPatch: inst.patch, testPatch: inst.test_patch });
    return [statement, '', ...harnessLines].join('\n');
}

/** Other `opencode run` processes on the host (not ours). Forensics for external kills. */
/**
 * Did the MCP arm actually do anything? Tool calls come from the agent's own
 * event stream (opencode names an MCP tool `<server>_<tool>`); the ingest ticks
 * come from the server's log. Zero calls means the arm is inert and the cell is
 * evidence about the CONTRACT, not about retrieval.
 */
function mcpActivity(sandbox, summary) {
    const calls = Object.entries(summary.tools_by_name ?? {})
        .filter(([name]) => name.startsWith('context-tree') || /^context_(fetch|search|peek)$/.test(name) || name === 'annotate');
    const log = sandbox?.record?.mcp?.log;
    let ingests = 0, appended = 0, ready = false, errors = 0;
    if (log && existsSync(log)) {
        for (const line of readFileSync(log, 'utf8').split('\n')) {
            if (!line) continue;
            let row;
            try { row = JSON.parse(line); } catch { continue; }
            if (row.event === 'ingest') { ingests += 1; appended += row.appended ?? 0; }
            else if (row.event === 'ready') ready = true;
            else if (row.event === 'ingest_error' || row.event === 'fatal') errors += 1;
        }
    }
    return {
        server_ready: ready, ingest_ticks: ingests, events_ingested: appended, server_errors: errors,
        tool_calls: calls.reduce((n, [, count]) => n + count, 0), tools: Object.fromEntries(calls),
    };
}

/**
 * Did the sidecar receive the arm we asked for?
 *
 * The knobs travel a long way — runner env, `mcp.env`, the sandbox plan, the per-run
 * opencode config, the MCP `environment` block — and a break anywhere leaves the sidecar on
 * its OWN defaults, which start at `CT_CT_TRIGGER=off`: never evicts. The cell would still
 * record the requested arm. One link of that chain was missing for the whole of this arm's
 * life, so the request is compared against what the sidecar says it booted with.
 */
const ARM_FIELDS = Object.freeze({
    CT_CT_TRIGGER: ['trigger', String],
    CT_CT_WINDOW: ['softWindow', Number],
    CT_CT_HARD_WINDOW: ['hardWindow', Number],
    CT_CT_CADENCE_N: ['cadenceN', Number],
    CT_CT_SUMMARIES: ['summaries', (v) => v === '1'],
    CT_CT_REPLY_RESERVE: ['replyReserve', Number],
    CT_CT_HEAD_TOKENS: ['headTokens', Number],
    CT_CT_PROTECT_TAIL: ['protectTail', Number],
    CT_CT_ANCHOR: ['anchor', Number],
    CT_CT_W_PRIORITY: ['w_priority', Number],
    CT_CT_W_RECENCY: ['w_recency', Number],
    CT_CT_W_REFRECENCY: ['w_refRecency', Number],
    CT_CT_W_DORMANCY: ['w_dormancy', Number],
    CT_CT_PRIORITY_HALFLIFE: ['priorityHalfLife', Number],
    CT_CT_EVICT_HEADROOM: ['evictHeadroomTokens', Number],
    CT_CT_SOFT_TARGET_FRAC: ['softTargetFrac', Number],
    CT_CT_REDUCER: ['reducer', String],
    CT_CT_DRIFT_K: ['driftK', Number],
    CT_CT_DRIFT_TAU: ['driftTau', Number],
    CT_CT_RRF_K: ['rrfK', Number],
    CT_CT_CHUNK_SIZE: ['chunkSize', Number],
    CT_CT_CHUNK_OVERLAP: ['chunkOverlap', Number],
    CT_CT_NEUTRAL_PHASES: ['neutralPhases', (v) => (v === 'none' ? '' : v.split(',').map((p) => p.trim()).filter(Boolean).join(','))],
    CT_CONTRACT: ['contract', String],
});

/**
 * The arm as the two processes say they booted: the plugin's policy (its `loaded` row)
 * over the sidecar's pipeline defaults (its `ready` row), flattened to one record.
 */
export function effectiveArm(ready, loaded) {
    if (!ready || !loaded?.policy) return null;
    const { weights = {}, ...pipeline } = ready.pipeline ?? {};
    return {
        ...pipeline, ...Object.fromEntries(Object.entries(weights).map(([k, v]) => [`w_${k}`, v])),
        neutralPhases: (ready.neutral_phases ?? []).join(','), contract: ready.contract ?? null,
        // The policy last: `protectTail` is passed per call, so the plugin's value is the one that ran.
        ...loaded.policy,
    };
}

export function armDisagreements(requested, ready) {
    if (!ready) return ['the sidecar never reported ready, or the plugin never loaded: nothing confirms which arm ran'];
    const out = [];
    for (const [key, [field, cast]] of Object.entries(ARM_FIELDS)) {
        if (requested[key] === undefined) continue;
        const want = cast(requested[key]);
        if (ready[field] !== want) out.push(`${key}: asked ${JSON.stringify(want)}, sidecar booted ${JSON.stringify(ready[field])}`);
    }
    return out;
}

/**
 * Did the assembly arm actually change the prompt? The plugin logs one row per turn and
 * the sidecar logs its decision; zero turns, or turns with nothing dropped, means the arm
 * is byte-identical to its control and the cell is VOID rather than a null result.
 */
function assembleActivity(runDir) {
    const read = (name) => {
        const p = join(runDir, 'mcp', name);
        if (!existsSync(p)) return [];
        return readFileSync(p, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
            try { return [JSON.parse(line)]; } catch { return []; }
        });
    };
    const plugin = read('ct-plugin.jsonl');
    const rows = read('ct-mcp.jsonl');
    const sidecar = rows.filter((r) => r.event === 'assemble' || r.event === 'assemble_error');
    const ready = rows.find((r) => r.event === 'ready');
    const loaded = plugin.find((r) => r.event === 'loaded');
    const effective = effectiveArm(ready, loaded);
    const disagreements = [...armDisagreements(CT_OPTIONS, effective), ...(loaded?.problems ?? []).map((p) => `plugin refused its policy: ${p}`)];
    const turns = plugin.filter((r) => r.turn !== undefined);
    return {
        arm_effective: effective,
        arm_agrees: disagreements.length === 0,
        arm_disagreements: disagreements,
        // Zero turns means one of two different defects: the module never imported, or it
        // imported and its hook never ran. opencode logs neither, so the plugin says so itself.
        plugin_loaded: plugin.some((r) => r.event === 'loaded'),
        plugin_registered: plugin.some((r) => r.event === 'registered'),
        plugin_turns: turns.length,
        plugin_errors: turns.filter((r) => r.error).length,
        messages_dropped: turns.reduce((n, r) => n + (r.dropped ?? 0), 0),
        messages_folded: turns.reduce((n, r) => n + (r.folded ?? 0), 0),
        assemble_calls: sidecar.length,
        assemble_errors: sidecar.filter((r) => r.event === 'assemble_error').length,
        evicted_units: sidecar.reduce((n, r) => n + (r.evicted?.length ?? 0), 0),
        evict_calls: rows.filter((r) => r.event === 'evict').length,
        floor_evictions: turns.filter((r) => r.evict_floor).length,
        fired: turns.some((r) => (r.dropped ?? 0) > 0 || (r.folded ?? 0) > 0),
    };
}

function otherOpencodeRuns(ownPid = null) {
    const r = spawnSync('pgrep', ['-f', '^opencode run'], { encoding: 'utf8' });
    return (r.stdout || '').split('\n').filter(Boolean).map(Number).filter((p) => p !== ownPid).length;
}

function runOpencode({ ws, runDir, prompt, env, model, sandbox }) {
    return new Promise((resolve) => {
        const t0 = Date.now();
        const othersAtStart = otherOpencodeRuns();
        const out = join(runDir, 'events.jsonl');
        // stdout/stderr go to FILE descriptors, not pipes: opencode exits before flushing a large
        // final write into a pipe (a piped export arrived cut at 146,176 of 430,431 bytes).
        const outFd = openSync(out, 'w');
        const errFd = openSync(join(runDir, 'stderr.log'), 'w');
        // `--pure` disables EXTERNAL PLUGINS, so an arm that carries one must not pass it
        // (`oc-runner.mjs:20`). It does not disable MCP servers, so the `mcp` arm keeps it.
        const ocArgs = ['run', ...(WANTS_PLUGIN ? [] : ['--pure']), '-m', model, '--format', 'json', '--dir', ws, '--auto', prompt];
        const [cmd, args, runEnv] = sandbox ? [sandbox.cmd, sandbox.argsFor(ocArgs), sandbox.env] : ['opencode', ocArgs, env];
        const p = spawn(cmd, args, {
            cwd: ws, env: runEnv, stdio: ['ignore', outFd, errFd], detached: true, // stdio[0]='ignore' == < /dev/null
        });
        let timedOut = false;
        // Our own timeout uses SIGKILL, so any SIGTERM/SIGINT in the record came from OUTSIDE.
        const timer = setTimeout(() => { timedOut = true; try { process.kill(-p.pid, 'SIGKILL'); } catch { } }, RUN_TIMEOUT_S * 1000);
        let othersPeak = othersAtStart;
        const poll = setInterval(() => { othersPeak = Math.max(othersPeak, otherOpencodeRuns(p.pid)); }, 15_000);
        p.on('close', (rawCode, rawSignal) => {
            const { code, signal } = sandbox ? exitFromSandbox(rawCode, rawSignal, osConstants.signals) : { code: rawCode, signal: rawSignal };
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
    } catch { }
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
    let r, sandbox = null;
    try {
        if (SANDBOX) {
            const venv = dirname(dirname(task.python));
            const pythonHome = pythonHomeOf(venv);
            sandbox = await openSandbox({
                runDir, ws, xdg, venv, model, configPath: OPENCODE_CONFIG, importName: task.importName,
                pythonPath: pythonPathFor(ws), assets: SANDBOX_ASSETS, window: WINDOW,
                mcp: WANTS_SIDECAR ? { repoRoot: REPO, env: WANTS_PLUGIN ? SIDECAR_ENV : {} } : null,
                plugin: WANTS_PLUGIN,
                needles: {
                    ...(G0_MARKER ? { g0: G0_MARKER } : {}),
                    ...(G0_FOLD_MARKER ? { g0fold: G0_FOLD_MARKER } : {}),
                },
                marker: {
                    ...(sel.marker !== null && sel.marker !== undefined ? { [LEASE_MARKER]: sel.marker } : {}),
                    ...(OUTPUT_CAP > 0 ? { OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: String(OUTPUT_CAP) } : {}),
                    // The plugin runs inside opencode, so its settings ride on the process env.
                    ...(WANTS_PLUGIN ? {
                        ...POLICY_ENV, CT_ASSEMBLE_MS: ASSEMBLE_MS,
                        CT_TOOLS_URL: `http://127.0.0.1:${ASSEMBLE_PORT}/v1/tools`,
                        CT_PLUGIN_EVENTS: join(runDir, 'mcp', 'ct-plugin.jsonl'),
                    } : {}),
                },
                ...sandboxExpectations({ work: WORK, runsRoot: RUNS_ROOT, tag: TAG, runDir, venv, pythonHomes: [pythonHome, realpathSync(pythonHome)], home: homedir(), repo: REPO, arm: ARM }),
            });
        }
        r = await runOpencode({ ws, runDir, prompt, env, model, sandbox });
    } finally {
        sel.release();
        await sandbox?.close();
    }
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
        // The arm, and whether its mechanism FIRED: an arm byte-identical to its
        // control must never be written up as a failed hypothesis (ladder gate 4).
        arm: ARM, window: WINDOW > 0 ? WINDOW : null, output_cap: OUTPUT_CAP > 0 ? OUTPUT_CAP : null,
        ct: WANTS_PLUGIN ? { ...CT_OPTIONS, ...assembleActivity(runDir) } : null,
        mcp: WANTS_SIDECAR ? mcpActivity(sandbox, s) : null,
        sandbox: sandbox ? sandbox.record : { enabled: false },
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
    if (WANTS_PLUGIN) {
        // Refused HERE, before a GPU-hour is spent: inside the sandbox a bad knob can only fail open.
        const problems = validatePolicy(policyFromEnv(POLICY_ENV));
        for (const k of PIPELINE_KEYS.filter((key) => !['CT_CT_REDUCER', 'CT_CT_NEUTRAL_PHASES', 'CT_CONTRACT'].includes(key))) {
            if (PIPELINE_ENV[k] !== undefined && !(Number.isFinite(Number(PIPELINE_ENV[k])) && Number(PIPELINE_ENV[k]) >= 0)) problems.push(`${k} must be a non-negative number, got "${PIPELINE_ENV[k]}"`);
        }
        if (PIPELINE_ENV.CT_CT_REDUCER && !['chunk', 'summarize'].includes(PIPELINE_ENV.CT_CT_REDUCER)) problems.push(`CT_CT_REDUCER must be chunk|summarize, got "${PIPELINE_ENV.CT_CT_REDUCER}"`);
        if (problems.length) throw new Error(`arm misconfigured: ${problems.join('; ')}`);
    }
    const selection = existsSync(SELECTION) ? JSON.parse(readFileSync(SELECTION, 'utf8')) : null;
    const calibrated = selection?.manifest?.calibrated_p2p ?? {};
    const ids = process.env.CT_INSTANCES
        ? process.env.CT_INSTANCES.split(',').map((s) => s.trim()).filter(Boolean)
        : selection.selection.accepted.map((c) => c.instance_id);
    const repeats = +(process.env.CT_REPEATS || 1);
    const firstRepeat = +(process.env.CT_REPEAT_START || 0);

    const cells = [];
    for (const id of ids) {
        const cal = calibrated[id];
        const task = cal ? makeSwebenchTask(id, { p2p: cal.effective }) : makeSwebenchTask(id);
        console.error(`=== ${task.name} (P2P graded ${task.p2p.length}/${task.p2pDataset.length}) ===`);
        for (let r = firstRepeat; r < firstRepeat + repeats; r++) cells.push(await runOne(task, r));
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
            sandbox: SANDBOX
                ? 'bwrap: no network (model relay only), no dataset/repos/wscache/other runs/operator home; per-run preflight in each cell'
                : 'OFF (CT_SANDBOX=0): the agent can read the dataset, repos/, wscache/, other runs and the network',
            arm: ARM === 'ct'
                ? `ct: the plugin at opencode's experimental.chat.messages.transform calls the @context-tree/mcp tools over loopback HTTP — context_evict per its policy (trigger ${CT_OPTIONS.CT_CT_TRIGGER}, window ${CT_OPTIONS.CT_CT_WINDOW}, cadence ${CT_OPTIONS.CT_CT_CADENCE_N}, summaries ${CT_OPTIONS.CT_CT_SUMMARIES}), then context_verdicts; eviction is sticky; the agent sees the same tools over MCP; host compaction OFF; per-cell \`ct\` records whether it fired`
                : ARM === 'mcp'
                    ? 'mcp: @context-tree/mcp attached as an opencode MCP server, fed from the live session db (experiments/context-dedup/ct-sidecar.mjs); per-cell `mcp` records whether it fired'
                    : 'off: the host\'s own context handling, no context-tree server',
            window: WINDOW > 0
                ? `${WINDOW} tokens declared as the model's context (opencode compacts at context − output cap), output cap ${OUTPUT_CAP}`
                : "the model's own declared context",
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
