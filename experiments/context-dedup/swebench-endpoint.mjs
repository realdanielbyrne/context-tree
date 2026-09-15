/**
 * Per-run ENDPOINT SELECTION: the local model when it has capacity, otherwise OpenRouter.
 *
 * CAPACITY, NOT EXCLUSIVITY. The unsloth studio host serves up to MAX_LOCAL_SLOTS concurrent
 * connections, so "free" means fewer than that many sessions are using it. An experiment that
 * is expected to stress the device (long contexts, large KV cache) instead declares
 * `exclusive: true` and runs locally only when NOTHING else is using it; otherwise it falls
 * back to OpenRouter (or the caller waits).
 *
 * WHY THE SIGNALS ARE WHAT THEY ARE. The server exposes no health, slots or queue endpoint
 * (all 404). Two plausible signals were measured and REJECTED as decision inputs:
 *   - an instantaneous probe: with an agent session live on the local model, a 1-token request
 *     answered in 25 ms and GPU read 1%/0% — agents spend most wall-clock in tools;
 *   - a GPU window: with TWO other sessions' runs live, 30 one-second samples gave p90 3%,
 *     max 4% — indistinguishable from idle.
 * GPU samples are still RECORDED as evidence, but they do not decide.
 *
 * What does work is counting SESSIONS:
 *   1. SLOT LEASES — this repo's workers each hold one slot file for a run's lifetime (an
 *      exclusive run holds all of them), so concurrent workers never over-subscribe.
 *   2. FOREIGN CLIENTS — local-model clients on the host that hold no lease: an
 *      `opencode run ... -m local/...` from any session, or the in-repo harness pointed at the
 *      local server. Processes carrying our lease marker are excluded, so our own runs are
 *      counted once (by lease), not twice.
 *
 * The choice is made ONCE per run and recorded with its evidence. Endpoint is then a
 * covariate: local (quantized GGUF) and OpenRouter (pinned DeepInfra bf16) are not the same
 * weights, so comparisons between arms must be paired within an endpoint.
 */
import { readFileSync, readdirSync, openSync, closeSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

export const LOCAL_MODEL = 'local/unsloth/Qwen3.8-27B-GGUF';
export const FALLBACK_MODEL = 'openrouter/qwen/qwen3.8-27b';
export const LEASE_DIR = process.env.CT_LOCAL_LEASE_DIR || '/mnt/data/ctx-swebench/locks/local-model';
/** Host-configured concurrency on the unsloth studio server (set by the operator, 2026-09-15). */
export const MAX_LOCAL_SLOTS = +(process.env.CT_LOCAL_MAX_SLOTS || 4);
/** Env marker set on processes we spawn under a lease, so the scan does not count them twice. */
export const LEASE_MARKER = 'CT_LOCAL_LEASE_SLOT';

// ---------------------------------------------------------------- pure logic

/**
 * Is a process a local-model client? Pure over (cmdline, env) so it is unit-testable.
 * Conservative: a false "in use" only costs a fallback to OpenRouter.
 */
export function isLocalClient({ cmdline = '', env = {} }) {
  if (/(^|\s|\/)opencode\s+run\b/.test(cmdline) && /(^|\s)-m\s+local\//.test(cmdline)) return 'opencode-local-model';
  const base = env.CT_LOCAL_BASE_URL;
  if (base && /(127\.0\.0\.1|localhost):8888/.test(base)) return 'harness-env-local';
  // The in-repo harness defaults to the local server when CT_LOCAL_BASE_URL is unset. The
  // opencode runner is excluded: it never calls the server itself, and when it drives the local
  // model its `opencode run -m local/...` child is what gets counted. Counting the runner too
  // would score one session as two — and would mark local busy even when it drives OpenRouter.
  if (!base && env.UNSLOTH_API_KEY && /\bnode\b.*experiments\//.test(cmdline) && !/swebench-opencode\.mjs/.test(cmdline)) return 'harness-default-local';
  return null;
}

/**
 * Collapse processes into SESSIONS. `timeout 900 opencode run ...` and the `opencode run ...`
 * it spawns are one session; counting processes double-counts every wrapped run.
 */
export function sessionsOf(clients) {
  const pids = new Set(clients.map((c) => c.pid));
  return clients.filter((c) => !(c.ppid && pids.has(c.ppid)));
}

/** The decision, pure. Records every signal behind it. */
export function decide({ heldLeases, foreignSessions, exclusive = false, maxSlots = MAX_LOCAL_SLOTS, gpuSamples = [] }) {
  const inUse = heldLeases + foreignSessions.length;
  const reasons = [];
  if (exclusive && inUse > 0) reasons.push(`exclusive run needs an idle device; ${inUse} session(s) in use`);
  if (!exclusive && inUse >= maxSlots) reasons.push(`all ${maxSlots} local slots in use`);
  const local = reasons.length === 0;
  return {
    model: local ? LOCAL_MODEL : FALLBACK_MODEL,
    endpoint: local ? 'local' : 'openrouter',
    reason: local
      ? `local: ${inUse}/${maxSlots} slots in use before this run${exclusive ? ' (exclusive)' : ''}`
      : `fallback: ${reasons.join('; ')}`,
    signals: {
      exclusive, max_slots: maxSlots, held_leases: heldLeases,
      foreign_sessions: foreignSessions, in_use_before: inUse,
      gpu_samples_evidence_only: gpuSamples,
    },
  };
}

// ------------------------------------------------------------- host probes

function procEnv(pid) {
  try {
    return Object.fromEntries(readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean)
      .map((kv) => { const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)]; }));
  } catch { return {}; }
}

function procPpid(pid) {
  try { return Number(readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[1]); } catch { return null; }
}

/** Local-model client processes that hold no lease of ours. */
export function scanForeignClients({ excludePids = [] } = {}) {
  const exclude = new Set(excludePids.map(Number));
  const out = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (exclude.has(pid)) continue;
    let cmdline;
    try { cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim(); } catch { continue; }
    if (!cmdline || /^(\/bin\/)?(ba)?sh\s+-c\b/.test(cmdline)) continue;   // a shell MENTIONING a client is not one
    const env = procEnv(pid);
    if (env[LEASE_MARKER] !== undefined) continue;                          // ours: counted by its lease
    const kind = isLocalClient({ cmdline, env });
    if (kind) out.push({ pid, ppid: procPpid(pid), kind, cmdline: cmdline.slice(0, 120) });
  }
  return sessionsOf(out);
}

export function sampleGpu({ samples = 5, intervalMs = 1000 } = {}) {
  const xs = [];
  for (let i = 0; i < samples; i++) {
    const r = spawnSync('nvidia-smi', ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'], { encoding: 'utf8' });
    const vals = (r.stdout || '').split('\n').map((s) => Number(s.trim())).filter(Number.isFinite);
    xs.push(vals.length ? Math.max(...vals) : 0);
    if (i < samples - 1) spawnSync('sleep', [String(intervalMs / 1000)]);
  }
  return xs;
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Slot files held by LIVE pids. A slot whose holder died is stale and is reclaimed. */
export function heldSlots({ dir = LEASE_DIR, maxSlots = MAX_LOCAL_SLOTS } = {}) {
  mkdirSync(dir, { recursive: true });
  const held = [];
  for (let i = 0; i < maxSlots; i++) {
    const p = join(dir, `slot-${i}`);
    let holder = null;
    try { holder = JSON.parse(readFileSync(p, 'utf8')).pid; } catch { continue; }
    if (holder && alive(holder)) held.push(i);
    else { try { unlinkSync(p); } catch {} }
  }
  return held;
}

/** Take ONE free slot (or ALL slots when exclusive), atomically per slot via O_EXCL. */
export function acquireSlots({ dir = LEASE_DIR, maxSlots = MAX_LOCAL_SLOTS, exclusive = false } = {}) {
  mkdirSync(dir, { recursive: true });
  heldSlots({ dir, maxSlots });                         // reclaim stale slots first
  const got = [];
  const release = () => { for (const i of got) { try { unlinkSync(join(dir, `slot-${i}`)); } catch {} } got.length = 0; };
  for (let i = 0; i < maxSlots; i++) {
    try {
      const fd = openSync(join(dir, `slot-${i}`), 'wx');
      writeFileSync(fd, JSON.stringify({ pid: process.pid, since: new Date().toISOString(), exclusive }));
      closeSync(fd);
      got.push(i);
      if (!exclusive) break;
    } catch (e) {
      if (e.code !== 'EEXIST') { release(); throw e; }
      if (exclusive) { release(); return { slots: [], release: () => {} }; }   // exclusive needs every slot
    }
  }
  if (exclusive && got.length !== maxSlots) { release(); return { slots: [], release: () => {} }; }
  return { slots: [...got], release };
}

/**
 * Choose an endpoint for ONE run. When local is chosen, the slot(s) are held until the caller
 * calls `release()`; spawn the run with `env[LEASE_MARKER]` set so the scan never double-counts
 * it. A crashed worker's slots are reclaimed as stale.
 */
export function chooseEndpoint({ exclusive = false, dir = LEASE_DIR, maxSlots = MAX_LOCAL_SLOTS, excludePids = [process.pid] } = {}) {
  const foreign = scanForeignClients({ excludePids });
  const held = heldSlots({ dir, maxSlots }).length;
  const d = decide({ heldLeases: held, foreignSessions: foreign, exclusive, maxSlots, gpuSamples: sampleGpu() });
  if (d.endpoint !== 'local') return { ...d, slots: [], release: () => {}, decided_at: new Date().toISOString() };
  // Re-check capacity by actually taking a slot: another worker may have raced us since the scan.
  const lease = acquireSlots({ dir, maxSlots, exclusive });
  if (!lease.slots.length || (!exclusive && held + 1 + foreign.length > maxSlots)) {
    lease.release();
    const lost = decide({ heldLeases: maxSlots, foreignSessions: foreign, exclusive, maxSlots });
    return { ...lost, reason: `${lost.reason} (lost a race for the last slot)`, slots: [], release: () => {}, decided_at: new Date().toISOString() };
  }
  return { ...d, slots: lease.slots, release: lease.release, marker: String(lease.slots[0]), decided_at: new Date().toISOString() };
}
