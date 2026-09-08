/** Exercise the actual CLI preflight against a fake Docker binary; never a model. */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { sha256, writeJsonAtomic } from '../src/experiment-runner.js';

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
it('runs CLI bootstrap/dry-run without providers and keeps n/output outside the scientific epoch', () => {
  const root = mkdtempSync(join(tmpdir(), 'runner-cli-')); temporary.push(root);
  const taskDirectory = join(root, 'import/tasks/task');
  const imageId = `sha256:${'a'.repeat(64)}`, verifierImageId = `sha256:${'b'.repeat(64)}`;
  const baseCommit = 'c'.repeat(40);
  const source = { repository: 'https://github.com/datacurve-ai/deep-swe', commit: 'd'.repeat(40), archiveSha256: 'e'.repeat(64) };
  const contents = { 'task.toml': 'schema_version="1.3"', 'instruction.md': 'Implement task.', 'environment/Dockerfile': 'FROM public:task',
    'tests/Dockerfile': 'FROM public:task', 'tests/test.sh': 'exit 0', 'tests/grader.py': '# verifier', 'tests/config.json': '{}', 'tests/test.patch': '' };
  for (const [name, bytes] of Object.entries(contents)) { mkdirSync(dirname(join(taskDirectory, name)), { recursive: true }); writeFileSync(join(taskDirectory, name), bytes); }
  const task = { id: 'task', taskDirectory: 'tasks/task', image: 'public:task', baseCommit,
    collect: [{ command: `git diff --binary ${baseCommit} HEAD > /logs/artifacts/model.patch`, timeoutSec: 300 }],
    verifierTimeoutSec: 1800, verifierBuildTimeoutSec: 1800, agentNetwork: 'none', verifierNetwork: 'none',
    cpus: 2, memoryMb: 8192, verifierCpus: 2, verifierMemoryMb: 8192, files: Object.fromEntries(Object.entries(contents).map(([path, bytes]) => [path, sha256(bytes)])) };
  writeJsonAtomic(join(root, 'import/manifest.json'), { schemaVersion: 1, benchmark: 'deepswe', source, tasks: [task] });
  const fullSource = { ...source, taskId: 'task', files: task.files };
  const gateResult = (name: string, reward: number) => {
    const path = join(root, name);
    mkdirSync(join(path, 'artifacts'), { recursive: true }); mkdirSync(join(path, 'verifier'));
    writeFileSync(join(path, 'artifacts/model.patch'), reward ? 'patch' : '');
    writeJsonAtomic(join(path, 'submission.json'), { source: fullSource, imageId, verifierImageId });
    writeJsonAtomic(join(path, 'verifier/reward.json'), { reward });
    writeJsonAtomic(join(path, 'verifier-outcome.json'), { exitCode: 0, timedOut: false });
    return { reward, artifactsDirectory: path, imageId, patchSha256: sha256(reward ? 'patch' : '') };
  };
  const gatesPath = join(root, 'gates.json');
  writeJsonAtomic(gatesPath, { tasks: [{ task: 'task', source: fullSource, execution: { imageId }, verification: gateResult('nop', 0), reference: gateResult('reference', 1) }] });
  const binary = join(root, 'bin/docker'); mkdirSync(dirname(binary));
  writeFileSync(binary, `#!${process.execPath}\nconst a=process.argv.slice(2); if(a[0]==='version')console.log(JSON.stringify({Version:'test',Arch:'test'}));else if(a[0]==='image')console.log(a[3].includes('Labels')?'${imageId}':a.at(-1).startsWith('context-tree-')?'${verifierImageId}':'${imageId}');else throw Error('container execution forbidden in dry-run');\n`);
  chmodSync(binary, 0o755);
  const script = resolve('eval/scripts/run-attention-experiment.mjs');
  const env = { ...process.env, PATH: `${dirname(binary)}:${process.env.PATH}`, EVAL_SHOULD_NOT_LEAK: '1' };
  const invoke = (args: string[]) => {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env });
    expect(result.stderr, result.stdout).toBe(''); expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  };
  const historical = join(root, 'historical.json');
  writeJsonAtomic(historical, [{ runId: 'old', costByModel: [{ model: 'old-model', usage: { input: 100, output: 10, cacheRead: 20, cacheWrite: 0 } }] }]);
  const sizing = invoke(['--derive-historical-ceiling', historical]);
  expect(sizing.tokenCap).toBe(260);
  const manifest = { version: 1, stage: 'pilot', provider: 'openrouter', model: 'model', window: 131072, ...sizing, n: 1,
    scenariosDir: join(root, 'import'), tasks: ['task'], gates: [gatesPath], arms: [{ id: 'native', arm: 'native' }],
    environment: { EVAL_NATIVE_CACHE: '1' }, output: join(root, 'out') };
  const manifestPath = join(root, 'manifest.json'); writeJsonAtomic(manifestPath, manifest);
  const first = invoke(['--manifest', manifestPath, '--dry-run']);
  expect(first.plannedLogicalRuns).toBe(1);
  manifest.output = join(root, 'other-out'); writeJsonAtomic(manifestPath, manifest);
  const relocated = invoke(['--manifest', manifestPath, '--dry-run']);
  expect(relocated.epoch).toBe(first.epoch);
  expect(readFileSync(join(taskDirectory, 'instruction.md'), 'utf8')).toBe('Implement task.');
});
