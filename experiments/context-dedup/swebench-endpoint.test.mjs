/**
 * Tests for per-run endpoint selection (node:test, stdlib).
 * Run: node --test experiments/context-dedup/swebench-endpoint.test.mjs
 *
 * The expensive failure is OVER-SUBSCRIBING the local host (more sessions than it serves, or
 * a device-stressing run sharing the GPU). So the tests pin the slot arithmetic, the exclusive
 * rule, session de-duplication, and that slots are never double-granted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isLocalClient, sessionsOf, decide, acquireSlots, heldSlots, LOCAL_MODEL, FALLBACK_MODEL } from './swebench-endpoint.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'slots-'));
const foreign = (n) => Array.from({ length: n }, (_, i) => ({ pid: 1000 + i, ppid: 1, kind: 'opencode-local-model' }));

// ------------------------------------------------------------------ decide
test('shared run: local while fewer than 4 sessions are in use', () => {
  for (const [held, f] of [[0, 0], [1, 0], [0, 3], [2, 1]]) {
    const d = decide({ heldLeases: held, foreignSessions: foreign(f), maxSlots: 4 });
    assert.equal(d.endpoint, 'local', `${held} leases + ${f} foreign = ${held + f} < 4`);
    assert.equal(d.model, LOCAL_MODEL);
  }
});

test('shared run: falls back when all 4 slots are in use, however they are split', () => {
  for (const [held, f] of [[4, 0], [0, 4], [2, 2], [3, 1], [1, 5]]) {
    const d = decide({ heldLeases: held, foreignSessions: foreign(f), maxSlots: 4 });
    assert.equal(d.endpoint, 'openrouter', `${held} + ${f} >= 4 must fall back`);
    assert.equal(d.model, FALLBACK_MODEL);
  }
});

test('exclusive run: local ONLY when nothing else is using the device', () => {
  assert.equal(decide({ heldLeases: 0, foreignSessions: [], exclusive: true, maxSlots: 4 }).endpoint, 'local');
  assert.equal(decide({ heldLeases: 1, foreignSessions: [], exclusive: true, maxSlots: 4 }).endpoint, 'openrouter');
  assert.equal(decide({ heldLeases: 0, foreignSessions: foreign(1), exclusive: true, maxSlots: 4 }).endpoint, 'openrouter',
    'one other session sharing the GPU is enough to disqualify a device-stressing run');
});

test('GPU readings never decide — they were measured indistinguishable from idle under load', () => {
  const hot = [99, 99, 99, 99, 99];
  assert.equal(decide({ heldLeases: 0, foreignSessions: [], gpuSamples: hot, maxSlots: 4 }).endpoint, 'local');
  const d = decide({ heldLeases: 0, foreignSessions: [], gpuSamples: hot, maxSlots: 4 });
  assert.deepEqual(d.signals.gpu_samples_evidence_only, hot, 'but they are recorded');
});

test('the decision records its evidence', () => {
  const d = decide({ heldLeases: 1, foreignSessions: foreign(2), maxSlots: 4 });
  assert.equal(d.signals.in_use_before, 3);
  assert.equal(d.signals.held_leases, 1);
  assert.equal(d.signals.foreign_sessions.length, 2);
  assert.match(d.reason, /3\/4 slots in use/);
});

// ------------------------------------------------------- sessions, clients
test('a `timeout` wrapper and the opencode run it spawns are ONE session', () => {
  const procs = [
    { pid: 10, ppid: 1, kind: 'opencode-local-model', cmdline: 'timeout 900 opencode run -m local/x' },
    { pid: 11, ppid: 10, kind: 'opencode-local-model', cmdline: 'opencode run -m local/x' },
    { pid: 20, ppid: 1, kind: 'opencode-local-model', cmdline: 'opencode run -m local/x' },
  ];
  assert.equal(sessionsOf(procs).length, 2, 'measured on this host: one wrapped run showed up as two processes');
});

test('recognizes local-model clients and ignores OpenRouter ones', () => {
  assert.equal(isLocalClient({ cmdline: 'opencode run --print-logs --dir /tmp/x -m local/unsloth/Qwen3.8-27B-GGUF go' }), 'opencode-local-model');
  assert.equal(isLocalClient({ cmdline: 'opencode run --pure -m openrouter/qwen/qwen3.8-27b --format json' }), null);
  assert.equal(isLocalClient({ cmdline: 'node experiments/context-dedup/anchor-live.mjs', env: { CT_LOCAL_BASE_URL: 'http://127.0.0.1:8888/v1' } }), 'harness-env-local');
  assert.equal(isLocalClient({ cmdline: 'node experiments/context-dedup/anchor-live.mjs', env: { UNSLOTH_API_KEY: 'x' } }), 'harness-default-local');
  assert.equal(isLocalClient({ cmdline: 'node experiments/x.mjs', env: { UNSLOTH_API_KEY: 'x', CT_LOCAL_BASE_URL: 'https://openrouter.ai/api/v1' } }), null);
  assert.equal(isLocalClient({ cmdline: 'python3 -m pytest -q' }), null);
});

test('the opencode RUNNER is not itself a client — its opencode child is', () => {
  // Measured: the runner process carries UNSLOTH_API_KEY from .env, so the generic harness rule
  // matched it. It must not: it would double-count a local run and falsely block an OpenRouter one.
  assert.equal(isLocalClient({ cmdline: 'node experiments/context-dedup/swebench-opencode.mjs', env: { UNSLOTH_API_KEY: 'x' } }), null);
  assert.equal(isLocalClient({ cmdline: 'opencode run --pure -m local/unsloth/Qwen3.8-27B-GGUF --format json' }), 'opencode-local-model');
});

// ------------------------------------------------------------------- slots
test('slots are never double-granted: 4 shared acquires succeed, the 5th gets nothing', () => {
  const dir = tmp();
  const leases = Array.from({ length: 4 }, () => acquireSlots({ dir, maxSlots: 4 }));
  assert.deepEqual(leases.map((l) => l.slots.length), [1, 1, 1, 1]);
  assert.equal(new Set(leases.map((l) => l.slots[0])).size, 4, 'each worker must hold a DIFFERENT slot');
  assert.equal(acquireSlots({ dir, maxSlots: 4 }).slots.length, 0);
  leases[2].release();
  assert.equal(acquireSlots({ dir, maxSlots: 4 }).slots.length, 1, 'a released slot is reusable');
});

test('exclusive takes ALL slots, and fails cleanly if any is held', () => {
  const dir = tmp();
  const ex = acquireSlots({ dir, maxSlots: 4, exclusive: true });
  assert.equal(ex.slots.length, 4);
  assert.equal(acquireSlots({ dir, maxSlots: 4 }).slots.length, 0, 'nothing else may run beside an exclusive run');
  ex.release();
  const one = acquireSlots({ dir, maxSlots: 4 });
  const ex2 = acquireSlots({ dir, maxSlots: 4, exclusive: true });
  assert.equal(ex2.slots.length, 0, 'exclusive must not start while a shared run holds a slot');
  assert.equal(readdirSync(dir).length, 1, 'a failed exclusive attempt must not leave partial slots behind');
  one.release();
});

test('slots held by DEAD pids are stale and reclaimed', () => {
  const dir = tmp();
  for (let i = 0; i < 4; i++) writeFileSync(join(dir, `slot-${i}`), JSON.stringify({ pid: 2 ** 22 + 777 + i }));
  assert.equal(heldSlots({ dir, maxSlots: 4 }).length, 0, 'a crashed worker must not hold the host forever');
  assert.equal(acquireSlots({ dir, maxSlots: 4 }).slots.length, 1);
});
