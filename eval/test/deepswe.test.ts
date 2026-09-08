import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deepSweAdapter, DEEPSWE_REPOSITORY, verifyDeepSweFiles } from '../src/adapters/deepswe.js';
import { createDockerSandbox, prepareDeepSweEnvironment, type CommandOutcome, type DockerRuntime } from '../src/sandbox.js';

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
const base = 'a'.repeat(40);
const success = (stdout = ''): CommandOutcome => ({ exitCode: 0, stdout, stderr: '', timedOut: false });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'deepswe-test-'));
  temporary.push(root);
  const taskDirectory = join(root, 'tasks', 'test-task');
  const contents: Record<string, string> = {
    'task.toml': 'schema_version = "1.3"', 'instruction.md': 'Implement the public behavior and commit your work.',
    'environment/Dockerfile': 'FROM upstream\nWORKDIR /app\n',
    'tests/Dockerfile': 'FROM task-image:version\nCOPY test.sh /tests/test.sh\n',
    'tests/test.sh': 'exit 0', 'tests/grader.py': '# hidden verifier',
    'tests/config.json': '{"reward":0}', 'tests/test.patch': 'held out patch',
  };
  const files: Record<string, string> = {};
  for (const [name, content] of Object.entries(contents)) {
    const path = join(taskDirectory, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
    files[name] = createHash('sha256').update(content).digest('hex');
  }
  const manifest = {
    schemaVersion: 1, benchmark: 'deepswe', source: { repository: DEEPSWE_REPOSITORY, commit: 'b'.repeat(40), archiveSha256: 'c'.repeat(64) },
    tasks: [{ id: 'test-task', taskDirectory: 'tasks/test-task', image: 'task-image:version', baseCommit: base,
      collect: [{ command: `cd /app && mkdir -p /logs/artifacts && git diff --binary ${base} HEAD > /logs/artifacts/model.patch`, timeoutSec: 300 }],
      verifierTimeoutSec: 1800, verifierBuildTimeoutSec: 1800,
      cpus: 2, memoryMb: 8192, verifierCpus: 2, verifierMemoryMb: 8192,
      agentNetwork: 'none', verifierNetwork: 'none', files }],
  };
  const save = () => writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest));
  save();
  const environment = deepSweAdapter.load(root)[0]!.environment!;
  return { root, taskDirectory, manifest, save, environment };
}

function fakeDocker(options: { reward?: unknown; verifierExit?: number; baseMismatch?: boolean; ancestryMismatch?: boolean } = {}) {
  const calls: { args: readonly string[]; input?: string }[] = [];
  let containers = 0;
  const runtime: DockerRuntime = {
    sync(args, input) {
      calls.push({ args: [...args], input });
      if (args[0] === 'image') {
        if (String(args[3]).includes('Labels')) return success(options.ancestryMismatch ? 'wrong-base' : 'sha256:agent-image');
        return success(String(args.at(-1)).startsWith('context-tree-deepswe-verifier:') ? 'sha256:verifier-image' : 'sha256:agent-image');
      }
      if (args[0] === 'run') return success(`container-${++containers}`);
      if (args.includes('rev-parse')) return success(options.baseMismatch && args.at(-1) === 'HEAD' ? 'd'.repeat(40) : base);
      if (args.includes('cat')) return success('raw file\n');
      if (args[0] === 'cp' && String(args[1]).endsWith(':/logs/artifacts/model.patch')) writeFileSync(String(args[2]), 'committed binary patch');
      if (args[0] === 'cp' && String(args[1]).endsWith(':/logs/verifier')) {
        const output = join(String(args[2]), 'verifier');
        mkdirSync(output);
        writeFileSync(join(output, 'reward.json'), JSON.stringify({ reward: options.reward ?? 0, f2p_total: 2, f2p_passed: 0 }));
        writeFileSync(join(output, 'ctrf.json'), '{"results":{"tests":[]}}');
      }
      return success();
    },
    async run(args) {
      calls.push({ args: [...args] });
      if (args.includes('/tests/test.sh')) return { ...success('full verifier output'), exitCode: options.verifierExit ?? 0 };
      if (String(args.at(-1)).includes('git status')) return success(' M uncommitted.txt\n');
      return success('x'.repeat(20_000));
    },
  };
  return { calls, runtime };
}

describe('official DEEPSWE import adapter', () => {
  it('loads only the instruction into the agent task and records pinned provenance', () => {
    const { root } = fixture();
    const scenario = deepSweAdapter.load(root)[0]!;
    expect(scenario.benchmark).toBe('deepswe');
    expect(scenario.task).toContain('public behavior');
    expect(scenario.task).not.toContain('held out');
    expect(scenario.files).toBeUndefined();
    expect(scenario.judge.kind).toBe('deepswe');
    expect(scenario.environment?.source.commit).toHaveLength(40);
  });
  it('rejects modified verifier bytes and new build-context files', () => {
    const { root, taskDirectory } = fixture();
    writeFileSync(join(taskDirectory, 'tests', 'test.sh'), 'tampered');
    expect(() => deepSweAdapter.load(root)).toThrow('SHA256 mismatch');
    writeFileSync(join(taskDirectory, 'tests', 'unexpected'), 'extra');
    expect(() => deepSweAdapter.load(root)).toThrow('file set changed');
  });
  it('rejects substituted repository identity and floating commits', () => {
    const { root, manifest, save } = fixture();
    manifest.source.commit = 'main'; save();
    expect(() => deepSweAdapter.load(root)).toThrow('immutable commit');
    manifest.source.commit = 'b'.repeat(40); manifest.source.repository = 'https://github.com/someone/deep-swe'; save();
    expect(() => deepSweAdapter.load(root)).toThrow('official repository');
  });
  it('rejects traversal, links and accidentally included solutions', () => {
    const { root, taskDirectory, manifest, save } = fixture();
    manifest.tasks[0]!.taskDirectory = '../elsewhere'; save();
    expect(() => deepSweAdapter.load(root)).toThrow('noncanonical');
    manifest.tasks[0]!.taskDirectory = 'tasks/test-task'; save();
    symlinkSync('/tmp', join(taskDirectory, 'tests', 'linked'));
    expect(() => deepSweAdapter.load(root)).toThrow('symlink');
  });
  it('rechecks changed task files immediately before execution', () => {
    const { environment, taskDirectory } = fixture();
    writeFileSync(join(taskDirectory, 'instruction.md'), 'changed');
    expect(() => verifyDeepSweFiles(environment)).toThrow('SHA256 mismatch');
  });
});

describe('Docker sandbox official verifier boundary', () => {
  it('executes every agent tool inside its container without host mounts or output cuts', async () => {
    const { environment } = fixture();
    const { runtime, calls } = fakeDocker();
    const sandbox = createDockerSandbox(environment, 'tools', runtime);
    try {
      expect(sandbox.readFile('/app/src/a.ts')).toBe('raw file\n');
      sandbox.writeFile('src/quoted file.ts', 'literal $(do-not-run)');
      expect((await sandbox.run('git status', 0)).stdout).toContain('uncommitted');
      expect((await sandbox.run('echo large', 0)).stdout).toHaveLength(20_000);
      expect(() => sandbox.readFile('../hidden')).toThrow('escapes');
      const start = calls.find((call) => call.args[0] === 'run')!.args;
      expect(start).toContain('none');
      expect(start).not.toContain('--volume');
      expect(start).not.toContain('--mount');
      expect(calls.find((call) => call.input !== undefined)?.input).toBe('literal $(do-not-run)');
    } finally { sandbox.cleanup(); }
  });
  it('exports committed patch only and grades it in a distinct pristine container', async () => {
    const { root, environment } = fixture();
    const { runtime, calls } = fakeDocker();
    const sandbox = createDockerSandbox(environment, 'verify', runtime);
    try {
      const result = await sandbox.verify!(join(root, 'verification'));
      expect(result.reward).toBe(0);
      expect(result.patchSha256).toHaveLength(64);
      expect(readFileSync(join(root, 'verification', 'submission.json'), 'utf8')).toContain('uncommitted');
      const grade = calls.find((call) => call.args.includes('/tests/test.sh'))!.args;
      expect(grade).toContain('container-2');
      expect(grade).not.toContain('container-1');
      expect(calls.some((call) => call.args[0] === 'cp' && String(call.args[2]).startsWith('container-1:'))).toBe(false);
      expect(calls.some((call) => String(call.args.at(-1)).includes(`git diff --binary ${base} HEAD`))).toBe(true);
      expect(calls.some((call) => call.args[0] === 'rm' && call.args.at(-1) === 'container-2')).toBe(true);
    } finally { sandbox.cleanup(); }
  });
  it('reports a verifier crash as infrastructure failure even if reward.json exists', async () => {
    const { root, environment } = fixture();
    const { runtime } = fakeDocker({ verifierExit: 1, reward: 1 });
    const sandbox = createDockerSandbox(environment, 'crash', runtime);
    try { await expect(sandbox.verify!(join(root, 'verification'))).rejects.toThrow('infrastructure failure'); }
    finally { sandbox.cleanup(); }
  });
  it('rejects container-exported symlinks before reading host artifacts', async () => {
    const { root, environment } = fixture();
    const { runtime } = fakeDocker();
    const originalSync = runtime.sync;
    runtime.sync = (args, input) => {
      if (args[0] === 'cp' && String(args[1]).endsWith(':/logs/artifacts/model.patch')) {
        symlinkSync(join(root, 'manifest.json'), String(args[2]));
        return success();
      }
      return originalSync(args, input);
    };
    const sandbox = createDockerSandbox(environment, 'symlink', runtime);
    try { await expect(sandbox.verify!(join(root, 'verification'))).rejects.toThrow('nonregular exported artifact'); }
    finally { sandbox.cleanup(); }
  });
  it('rejects image ancestry drift and a wrong repository base before agent work', () => {
    const { environment } = fixture();
    expect(() => createDockerSandbox(environment, 'wrong-image', fakeDocker({ ancestryMismatch: true }).runtime)).toThrow('base differs');
    const { runtime, calls } = fakeDocker({ baseMismatch: true });
    expect(() => createDockerSandbox(environment, 'wrong-base', runtime)).toThrow('differs from pinned');
    expect(calls.some((call) => call.args[0] === 'rm')).toBe(true);
  });
  it('builds the official verifier from the tests context with a resolved base image ID', async () => {
    const { environment, taskDirectory } = fixture();
    const { runtime, calls } = fakeDocker();
    let dockerfile = '';
    const originalRun = runtime.run;
    runtime.run = async (args, timeout) => {
      if (args[0] === 'build') dockerfile = readFileSync(String(args[args.indexOf('--file') + 1]), 'utf8');
      return originalRun(args, timeout);
    };
    await prepareDeepSweEnvironment(environment, runtime);
    expect(dockerfile).toContain('FROM sha256:agent-image');
    const build = calls.find((call) => call.args[0] === 'build')!;
    expect(build.args.at(-1)).toBe(join(taskDirectory, 'tests'));
    expect(readFileSync(join(taskDirectory, 'tests', 'Dockerfile'), 'utf8')).toContain('FROM task-image:version');
  });
});
