#!/usr/bin/env node
/**
 * LHTB pristine / reference gates. No model calls, ever.
 *
 * --pristine   grade the untouched environment; the dense reward is REPORTED,
 *              not asserted, because "near zero" is a real measurement.
 * --reference  run the task's own solution/solve.sh, then grade. A reward
 *              below 1.0 is a finding about the TASK, never something to tune
 *              away, so it is recorded and the exit status turns nonzero.
 *
 * usage: node eval/scripts/preflight-lhtb.mjs --scenarios-dir DIR --tasks ID[,ID]
 *          [--prepare] [--pristine] [--reference --source-dir LHTB_CHECKOUT]
 *          --output DIR
 * (run `pnpm exec tsc --build eval` first)
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { lhtbAdapter } from '../dist/adapters/lhtb.js';
import { createLhtbSandbox, prepareLhtbEnvironment } from '../dist/adapters/lhtb-sandbox.js';
import { dockerRuntime } from '../dist/sandbox.js';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
};
const directory = option('--scenarios-dir');
const taskIds = option('--tasks')?.split(',').filter(Boolean);
const output = option('--output');
if (!directory || !taskIds?.length || !output) {
  throw new Error('usage: node eval/scripts/preflight-lhtb.mjs --scenarios-dir DIR --tasks ID[,ID] --output DIR [--prepare] [--pristine] [--reference --source-dir DIR]');
}
const outputRoot = resolve(output);
const scenarios = lhtbAdapter.load(directory).filter((scenario) => taskIds.includes(scenario.id));
if (scenarios.length !== new Set(taskIds).size) throw new Error('unknown or duplicate task selection');
const version = dockerRuntime.sync(['version', '--format', '{{json .Server}}']);
if (version.exitCode !== 0) throw new Error(`Docker daemon unavailable: ${version.stderr}`);

/** Test ids pytest names in its short summary, so a failure is nameable. */
function failedTests(artifacts) {
  const log = join(artifacts, 'verifier', 'pytest.log');
  const text = existsSync(log) ? readFileSync(log, 'utf8') : readFileSync(join(artifacts, 'verifier', 'test-stdout.txt'), 'utf8');
  return [...text.matchAll(/^(?:FAILED|ERROR)\s+(\S+)/gm)].map((match) => match[1]);
}

function imageDigests(reference) {
  const inspect = dockerRuntime.sync(['image', 'inspect', '--format', '{{.Id}}|{{join .RepoDigests ","}}|{{.Architecture}}/{{.Os}}', reference]);
  if (inspect.exitCode !== 0) return { reference, error: inspect.stderr.trim() };
  const [id, repoDigests, platform] = inspect.stdout.trim().split('|');
  return { reference, id, repoDigests: repoDigests ? repoDigests.split(',') : [], platform };
}

/** The reference solution lives only in the pinned checkout, never in the import. */
function solutionDirectory(environment) {
  const sourceDir = option('--source-dir');
  if (!sourceDir) throw new Error('--reference requires --source-dir pointing at the pinned LHTB checkout');
  const root = resolve(sourceDir, 'tasks', environment.source.taskId, 'solution');
  for (const [name, hash] of Object.entries(environment.source.solutionFiles)) {
    const path = resolve(sourceDir, 'tasks', environment.source.taskId, name);
    if (!existsSync(path)) throw new Error(`reference solution file missing from --source-dir: ${name}`);
    const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (actual !== hash) throw new Error(`reference solution file differs from the pinned import: ${name}`);
  }
  return root;
}

const rows = [];
let failures = 0;
for (const scenario of scenarios) {
  const environment = scenario.environment;
  const row = { task: scenario.id, source: environment.source, verifierMode: environment.verifierMode,
    artifacts: environment.artifacts, agentNetwork: environment.agentNetwork, verifierNetwork: environment.verifierNetwork };
  rows.push(row);
  const started = Date.now();
  console.log(JSON.stringify({ task: scenario.id, stage: 'preflight-start' }));
  if (args.includes('--prepare')) {
    row.prepared = await prepareLhtbEnvironment(environment);
    console.log(JSON.stringify({ task: scenario.id, stage: 'prepared', ...row.prepared }));
  }
  row.images = { task: imageDigests(environment.image), verifierBase: imageDigests(environment.verifierImage) };

  if (args.includes('--pristine')) {
    const sandbox = createLhtbSandbox(environment, `pristine-${scenario.id}`);
    try {
      // Recorded, not merely asserted: the gate verifier re-checks this field
      // rather than inferring the property from the absence of a thrown error.
      const probe = 'test ! -e /tests && test ! -e /solution && ls -A /app | head -50';
      const isolation = await sandbox.run(probe, 0);
      if (isolation.exitCode !== 0) throw new Error(`${scenario.id}: hidden verifier/solution leaked into agent`);
      row.isolation = { probe, exitCode: isolation.exitCode, agentHasHiddenTests: false, agentHasSolution: false,
        agentWorkspace: isolation.stdout.trim().split('\n') };
      const artifacts = join(outputRoot, `${scenario.id}-pristine`);
      const verification = await sandbox.verifyLhtb(artifacts);
      row.pristine = { ...verification, failedTests: failedTests(artifacts) };
      console.log(JSON.stringify({ task: scenario.id, stage: 'pristine-complete', reward: verification.reward, passed: verification.passed, total: verification.total }));
    } finally {
      sandbox.cleanup();
    }
  }

  if (args.includes('--reference')) {
    const solution = solutionDirectory(environment);
    // A fresh diagnostic container. No model is called, and no scored agent
    // container ever has this filesystem or /solution.
    const sandbox = createLhtbSandbox(environment, `reference-${scenario.id}`);
    try {
      const staged = dockerRuntime.sync(['cp', '--archive', join(solution, '.'), `${sandbox.execution.containerId}:/solution`]);
      if (staged.exitCode !== 0) {
        dockerRuntime.sync(['exec', sandbox.execution.containerId, 'mkdir', '-p', '/solution']);
        const retry = dockerRuntime.sync(['cp', '--archive', join(solution, '.'), `${sandbox.execution.containerId}:/solution`]);
        if (retry.exitCode !== 0) throw new Error(`staging the reference solution failed: ${retry.stderr}`);
      }
      const solve = await sandbox.run('bash /solution/solve.sh', environment.agentTimeoutSec * 1000);
      const artifacts = join(outputRoot, `${scenario.id}-reference`);
      // solve.sh output is durable evidence whether or not the gate passes.
      mkdirSync(outputRoot, { recursive: true });
      writeFileSync(join(outputRoot, `${scenario.id}-solve.json`), JSON.stringify(solve, null, 2) + '\n');
      if (solve.timedOut || solve.exitCode !== 0) {
        row.reference = { solveFailed: true, solve };
        failures += 1;
        console.log(JSON.stringify({ task: scenario.id, stage: 'reference-solve-failed', exitCode: solve.exitCode, timedOut: solve.timedOut }));
      } else {
        const verification = await sandbox.verifyLhtb(artifacts);
        const names = failedTests(artifacts);
        row.reference = { ...verification, failedTests: names, solveExitCode: solve.exitCode };
        if (verification.reward !== 1) failures += 1;
        console.log(JSON.stringify({ task: scenario.id, stage: 'reference-complete', reward: verification.reward, passed: verification.passed, total: verification.total, failedTests: names }));
      }
    } finally {
      sandbox.cleanup();
    }
  }
  row.elapsedMs = Date.now() - started;
}

const report = { runtime: JSON.parse(version.stdout), noModelCalls: true, dockerDefaultPlatform: process.env.DOCKER_DEFAULT_PLATFORM ?? null, tasks: rows };
mkdirSync(outputRoot, { recursive: true });
writeFileSync(join(outputRoot, 'preflight.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ stage: 'report', path: join(outputRoot, 'preflight.json'), gateFailures: failures }));
if (failures > 0) process.exitCode = 1;
