/**
 * Scenario integrity tests. Run: node --test experiments/scenarios/scenarios.test.mjs
 *
 * These guard the two things that silently invalidated earlier attempts: a seed file
 * large enough to be clipped (making any "it is above in this conversation" claim
 * false), and an ORACLE that does not actually reproduce the spec it is graded against.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadScenario, scenarioTask, evalGate } from './load.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIP = 2000;   // coding-harness/lib.mjs clips tool output here

test('flapsim scenario loads and exposes an ordered turn sequence', () => {
  const sc = loadScenario('flapsim');
  assert.ok(sc.system.length > 100);
  // Phases are SEPARATE user turns. One message asking for all of them made the model
  // emit 141,497 chars of reasoning and never call a write tool.
  assert.equal(sc.turns.length, 6);
  assert.deepEqual(sc.turns.map((t) => t.id),
    ['core', 'engine', 'tests', 'review', 'artifact', 'feature-and-docs']);
  assert.ok(!sc.turns[0].gate, 'the opening turn is unconditional');
  for (const t of sc.turns.slice(1)) assert.ok(t.gate, `${t.id} must be gated on workspace state`);
});

test('every seed file stays under the 2000-char tool clip', () => {
  const sc = loadScenario('flapsim');
  const ws = mkdtempSync(join(tmpdir(), 'sc-'));
  sc.seed(ws);
  for (const rel of sc.seedFiles) {
    const n = readFileSync(join(ws, rel), 'utf8').length;
    assert.ok(n < CLIP - 100, `${rel} is ${n} chars — a read would be clipped, leaving only a FRAGMENT resident`);
  }
  assert.ok(sc.seedFiles.length >= 10);
});

test('the follow-up turn is released only once the workspace milestone is met', async () => {
  const sc = loadScenario('flapsim');
  const ws = mkdtempSync(join(tmpdir(), 'sc-'));
  sc.seed(ws);
  const { writeFileSync } = await import('node:fs');
  const gateOf = (id) => sc.turns.find((t) => t.id === id).gate;

  assert.equal(evalGate(ws, gateOf('engine')), false, 'core modules do not exist yet');
  for (const f of ['units.py', 'physics.py', 'world.py']) writeFileSync(join(ws, f), 'x');
  assert.equal(evalGate(ws, gateOf('engine')), false, 'three of four is not the milestone');
  writeFileSync(join(ws, 'collide.py'), 'x');
  assert.equal(evalGate(ws, gateOf('engine')), true, 'all four core modules present');

  const last = gateOf('feature-and-docs');
  assert.equal(evalGate(ws, last), false);
  writeFileSync(join(ws, 'replay.txt'), 'x'.repeat(300));
  assert.equal(evalGate(ws, last), false, 'replay.txt alone is not the milestone');
  writeFileSync(join(ws, 'REVIEW.md'), '- a.py:1 wrong -> fix');
  assert.equal(evalGate(ws, last), true, 'both conditions met');
});

test('makeHook releases each turn exactly once, and onEnd is the safety net', () => {
  const sc = loadScenario('flapsim');
  const ws = mkdtempSync(join(tmpdir(), 'sc-'));
  sc.seed(ws);
  const h = sc.makeHook(ws);
  const messages = [];
  h.hook(messages, 0);
  assert.equal(messages.length, 0, 'gate unmet, nothing released');
  // onEnd is the safety net: an agent that says DONE early must still get the next turn,
  // because runAgent-style loops exit the moment the model stops calling tools.
  for (let i = 1; i < sc.turns.length; i++) {
    assert.equal(h.onEnd(messages, i), true, `turn ${i} should be released on-end`);
  }
  assert.equal(messages.length, sc.turns.length - 1);
  assert.ok(messages.every((m) => m.role === 'user'));
  assert.equal(h.onEnd(messages, 99), false, 'no turns left');
  assert.equal(h.state().all_released, true);
});

test('the ORACLE reproduces every worked example the spec publishes', () => {
  // The spec quotes numbers; if the reference does not produce exactly those, every
  // downstream grade is measured against a false ground truth.
  const ref = join(HERE, 'flapsim', 'grader', 'ref.py');
  assert.ok(existsSync(ref));
  const out = execFileSync('python3', [ref, '--selfcheck'], { encoding: 'utf8' }).trim();
  const spec = readFileSync(join(HERE, 'flapsim', 'seed', 'spec', '08_examples.md'), 'utf8');
  const lines = out.split('\n');
  assert.equal(lines.length, 6);
  for (const line of lines) {
    assert.match(line, /OK$/, `oracle disagrees with itself: ${line}`);
    assert.ok(spec.includes(line), `spec/08_examples.md does not contain: ${line}`);
  }
});

test('the task discriminates — examples are not all the same outcome', () => {
  const ref = join(HERE, 'flapsim', 'grader', 'ref.py');
  const out = execFileSync('python3', [ref, '--selfcheck'], { encoding: 'utf8' });
  const alive = [...out.matchAll(/expect score=(\d+) alive=(\d)/g)].map((m) => [+m[1], +m[2]]);
  assert.ok(new Set(alive.map((a) => a[0])).size > 1, 'all examples score the same — the task cannot discriminate');
  assert.ok(alive.some((a) => a[1] === 1) && alive.some((a) => a[1] === 0), 'need both survivals and deaths');
});

test('--powerups changes the digest, and its absence does not', () => {
  const ref = join(HERE, 'flapsim', 'grader', 'ref.py');
  const args = ['--seed', '7', '--ticks', '200', '--flaps', '0010'];
  const plain = execFileSync('python3', [ref, ...args], { encoding: 'utf8' });
  const plain2 = execFileSync('python3', [ref, ...args], { encoding: 'utf8' });
  const pu = execFileSync('python3', [ref, ...args, '--powerups'], { encoding: 'utf8' });
  assert.equal(plain, plain2, 'the demo must be byte-identical across runs — the regression check depends on it');
  assert.notEqual(plain, pu);
  assert.match(pu.trim().split('\n').at(-1), /shields=\d/);
  assert.doesNotMatch(plain.trim().split('\n').at(-1), /shields/);
});

test('scenarioTask adapts to the coding-harness task-module shape', () => {
  const t = scenarioTask('flapsim', { grade: () => false });
  for (const k of ['name', 'system', 'task', 'seed', 'grade', 'makeHook']) assert.ok(t[k], `missing ${k}`);
  assert.match(t.task, /Build `flapsim`/);
});

test('the spec UNIQUELY determines the reference output — no format ambiguity', () => {
  // The first flapsim run failed because the spec said "one TRACE line every N//20
  // ticks" without saying WHICH ticks, and said score is "2 digits" while the
  // reference pads it only in TRACE. The agent thrashed trying to satisfy a
  // contradiction it could not see. Verifying the oracle reproduces its own examples
  // was NOT enough — the spec TEXT must pin the output too.
  const ref = join(HERE, 'flapsim', 'grader', 'ref.py');
  const demo = execFileSync('python3', [ref, '--seed', '7', '--ticks', '200', '--flaps', '0010'], { encoding: 'utf8' }).trimEnd();
  const expected = readFileSync(join(HERE, 'flapsim', 'seed', 'spec', '09_expected_output.md'), 'utf8');
  assert.ok(expected.includes(demo), 'spec/09 must contain the reference output verbatim, or the agent has nothing to diff against');

  const cli = readFileSync(join(HERE, 'flapsim', 'seed', 'spec', '06_cli.md'), 'utf8');
  assert.match(cli, /t % EVERY == 0/, 'the spec must say WHICH ticks emit a TRACE line');
  assert.match(cli, /FIRST tick of each group/, 'and disambiguate first-vs-last');
  assert.match(cli, /NOT padded in DIGEST/, 'and resolve the score-padding contradiction');

  const first = demo.split('\n')[0];
  const digest = demo.split('\n').at(-1);
  assert.match(first, /^TRACE t=\d{4} y=\d{4} vy=[+-]\d{4} score=\d{2} alive=[01]$/);
  assert.match(digest, /^DIGEST seed=\d+ ticks=\d+ score=\d+ alive=[01] y=\d{4} vy=[+-]\d{4} ticks_run=\d+$/);
  assert.doesNotMatch(digest, /score=0\d /, 'DIGEST score must not be zero-padded');
});
