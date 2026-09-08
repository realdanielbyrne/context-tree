#!/usr/bin/env node
/** No model calls. Validate import/runtime, optionally prepare images and grade nop. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { deepSweAdapter } from '../dist/adapters/deepswe.js';
import { createDockerSandbox, dockerRuntime, prepareDeepSweEnvironment } from '../dist/sandbox.js';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
};
const directory = option('--scenarios-dir');
const taskIds = option('--tasks')?.split(',');
if (!directory || !taskIds?.length) {
  throw new Error('usage: node eval/scripts/preflight-deepswe.mjs --scenarios-dir DIR --tasks ID[,ID] [--prepare] [--nop] [--reference-archive PINNED_ARCHIVE] [--output DIR] (run pnpm exec tsc --build eval first)');
}
const scenarios = deepSweAdapter.load(directory).filter((scenario) => taskIds.includes(scenario.id));
if (scenarios.length !== new Set(taskIds).size) throw new Error('unknown or duplicate task selection');
const version = dockerRuntime.sync(['version', '--format', '{{json .Server}}']);
if (version.exitCode !== 0) throw new Error(`Docker daemon unavailable: ${version.stderr}`);
const rows = [];
for (const scenario of scenarios) {
  const environment = scenario.environment;
  const started = Date.now();
  console.log(JSON.stringify({ task: scenario.id, stage: 'preflight-start' }));
  if (args.includes('--prepare')) await prepareDeepSweEnvironment(environment);
  const sandbox = createDockerSandbox(environment, `preflight-${scenario.id}`);
  try {
    const isolation = await sandbox.run('test ! -e /tests/test.sh && test ! -e /solution && git status --porcelain=v1', 0);
    if (isolation.exitCode !== 0) throw new Error(`${scenario.id}: hidden verifier/solution leaked into agent`);
    let verification;
    if (args.includes('--nop')) {
      const output = option('--output');
      if (!output) throw new Error('--nop requires --output for durable verifier artifacts');
      verification = await sandbox.verify(join(resolve(output), scenario.id));
      if (verification.reward !== 0) throw new Error(`${scenario.id}: pristine baseline unexpectedly passes official verifier`);
    }
    rows.push({ task: scenario.id, execution: sandbox.execution, source: environment.source, dirtyBase: isolation.stdout, verification, elapsedMs: Date.now() - started });
    console.log(JSON.stringify({ task: scenario.id, stage: 'preflight-complete', nopReward: verification?.reward ?? null }));
  } finally {
    sandbox.cleanup();
  }
  const referenceArchive = option('--reference-archive');
  if (referenceArchive) {
    const output = option('--output');
    if (!output) throw new Error('--reference-archive requires --output');
    const actualHash = createHash('sha256').update(readFileSync(referenceArchive)).digest('hex');
    if (actualHash !== environment.source.archiveSha256) throw new Error('reference archive differs from imported pinned archive');
    const patch = execFileSync('python3', ['-c',
      'import sys,tarfile; a=tarfile.open(sys.argv[1]); name="datacurve-ai-deep-swe-"+sys.argv[2][:7]+"/tasks/"+sys.argv[3]+"/solution/solution.patch"; sys.stdout.buffer.write(a.extractfile(name).read())',
      referenceArchive, environment.source.commit, scenario.id], { encoding: 'utf8', maxBuffer: Infinity });
    // A fresh diagnostic container; no model is called, and no scored agent can
    // access either this filesystem or the host archive containing solutions.
    const reference = createDockerSandbox(environment, `reference-${scenario.id}`);
    try {
      const applied = dockerRuntime.sync(['exec', '--interactive', '--workdir', '/app', reference.execution.containerId,
        'git', 'apply', '--whitespace=nowarn', '-'], patch);
      if (applied.exitCode !== 0) throw new Error(`official reference patch does not apply: ${applied.stderr}`);
      const commit = await reference.run("git add -A && git -c user.name='DEEPSWE reference gate' -c user.email='deepswe-reference@example.invalid' commit -m 'Apply official reference patch'", 0);
      if (commit.exitCode !== 0) throw new Error(`reference commit failed: ${commit.stderr}`);
      const verification = await reference.verify(join(resolve(output), `${scenario.id}-reference`));
      if (verification.reward !== 1) throw new Error(`${scenario.id}: official reference does not pass; task is ineligible for model batches`);
      rows.at(-1).reference = verification;
      console.log(JSON.stringify({ task: scenario.id, stage: 'reference-complete', reward: verification.reward }));
    } finally { reference.cleanup(); }
  }
}
const report = { runtime: JSON.parse(version.stdout), noModelCalls: true, tasks: rows };
const output = option('--output');
if (output) {
  mkdirSync(resolve(output), { recursive: true });
  writeFileSync(join(resolve(output), 'preflight.json'), JSON.stringify(report, null, 2) + '\n');
} else console.log(JSON.stringify(report, null, 2));
