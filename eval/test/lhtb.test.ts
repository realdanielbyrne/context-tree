import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LHTB_REPOSITORY, lhtbAdapter, lhtbArtifactPaths, submissionDigest, verifyLhtbFiles } from '../src/adapters/lhtb.js';
import { verifyEnvironmentGates } from '../src/experiment-runner.js';
import { createLhtbSandbox, parsePytestCounts, prepareLhtbEnvironment } from '../src/adapters/lhtb-sandbox.js';
import type { CommandOutcome, DockerRuntime } from '../src/sandbox.js';

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
const success = (stdout = ''): CommandOutcome => ({ exitCode: 0, stdout, stderr: '', timedOut: false });
const ARTIFACTS = ['outputs/report.json', '/app/src'];
const TESTS = 'mkdir -p /logs/verifier; echo 0.75 > /logs/verifier/reward.txt';
const AGENT_IMAGE = `sha256:${'1'.repeat(64)}`;
const VERIFIER_IMAGE = `sha256:${'2'.repeat(64)}`;

function fixture(overrides: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'lhtb-test-'));
  temporary.push(root);
  const taskDirectory = join(root, 'tasks', 'test-task');
  const contents: Record<string, string> = {
    'task.toml': 'schema_version = "1.1"', 'instruction.md': 'Produce the required artifacts.',
    'environment/Dockerfile': 'FROM upstream\nWORKDIR /app\n',
    'tests/test.sh': TESTS, 'tests/test_outputs.py': '# hidden verifier',
  };
  const files: Record<string, string> = {};
  for (const [name, content] of Object.entries(contents)) {
    const path = join(taskDirectory, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
    files[name] = createHash('sha256').update(content).digest('hex');
  }
  const solutionFiles = { 'solution/solve.sh': 'd'.repeat(64) };
  const manifest = {
    schemaVersion: 1, benchmark: 'lhtb', source: { repository: LHTB_REPOSITORY, commit: 'b'.repeat(40) },
    tasks: [{
      id: 'test-task', taskDirectory: 'tasks/test-task', name: 'lhtb/test-task', description: 'A task.',
      difficulty: 'hard', category: 'software-engineering', expertTimeEstimateMin: 120,
      artifacts: ARTIFACTS, image: 'task-image:version', verifierImage: 'task-image:version',
      cpus: 2, memoryMb: 4096, storageMb: 8192, gpus: 0, allowInternet: true, buildTimeoutSec: 1800,
      agentTimeoutSec: 3600, continueUntilTimeout: true, verifierMode: 'shared', verifierTimeoutSec: 900,
      verifierCpus: 2, verifierMemoryMb: 4096, verifierAllowInternet: false, verifierBuildTimeoutSec: 1800,
      sourceHash: 'a'.repeat(64), instructionSha256: files['instruction.md'], files, solutionFiles,
      ...overrides,
    }],
  };
  const save = () => writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest));
  save();
  const environment = lhtbAdapter.load(root)[0]!.environment!;
  if (environment.kind !== 'lhtb') throw new Error('expected an lhtb environment');
  return { root, taskDirectory, manifest, save, environment, files };
}

/**
 * The fake runtime records the real `docker` argv, which is how the isolation
 * boundary is asserted: a test can prove tests/ never reached container-1.
 */
function fakeDocker(options: { reward?: string; missing?: string[]; testsInImage?: boolean } = {}) {
  const calls: { args: readonly string[]; input?: string }[] = [];
  let containers = 0;
  const runtime: DockerRuntime = {
    sync(args, input) {
      calls.push({ args: [...args], input });
      if (args[0] === 'image') return success('sha256:agent-image');
      if (args[0] === 'run') return success(`container-${++containers}`);
      if (args[0] === 'cp') {
        const [source, destination] = [String(args.at(-2)), String(args.at(-1))];
        if (source.endsWith(':/app')) {
          mkdirSync(join(destination, 'outputs'), { recursive: true });
          writeFileSync(join(destination, 'outputs', 'report.json'), '{"ok":true}');
        } else if (source.endsWith(':/logs/verifier')) {
          mkdirSync(join(destination, 'verifier'), { recursive: true });
          writeFileSync(join(destination, 'verifier', 'reward.txt'), options.reward ?? '0.75');
          writeFileSync(join(destination, 'verifier', 'pytest.log'), '3 passed, 1 failed in 1.0s\n');
        } else if (source.startsWith('container-')) {
          mkdirSync(dirname(destination), { recursive: true });
          writeFileSync(destination, '{"ok":true}');
        }
        return success();
      }
      if (String(args.at(-1)).startsWith('sha256sum')) {
        // sha256sum runs with --workdir /tests, so it prints basenames.
        return success(Object.entries(fixtureHashes)
          .filter(([name]) => name.startsWith('tests/'))
          .map(([name, hash]) => `${hash}  ${name.slice('tests/'.length)}`).join('\n'));
      }
      if (args.includes('test') && args.includes('-e')) {
        return (options.missing ?? []).includes(String(args.at(-1))) ? { ...success(), exitCode: 1 } : success();
      }
      if (String(args.at(-1)) === 'test -f /tests/test.sh') return options.testsInImage === true ? success() : { ...success(), exitCode: 1 };
      return success();
    },
    async run(args) {
      calls.push({ args: [...args] });
      if (args.includes('/tests/test.sh')) return { ...success('short summary'), exitCode: 1 };
      return success('agent output');
    },
  };
  return { calls, runtime };
}

/** Filled per test so the staged-tests hash check sees the fixture's bytes. */
let fixtureHashes: Record<string, string> = {};

describe('LHTB import adapter', () => {
  it('carries the file-based submission contract into the agent prompt and records provenance', () => {
    const { root } = fixture();
    const scenario = lhtbAdapter.load(root)[0]!;
    expect(scenario.benchmark).toBe('lhtb');
    expect(scenario.task).toContain('Produce the required artifacts.');
    // The agent must be told the paths, because LHTB grades files, not claims.
    expect(scenario.task).toContain('outputs/report.json');
    expect(scenario.task).not.toContain('hidden verifier');
    expect(scenario.files).toBeUndefined();
    expect(scenario.judge.kind).toBe('lhtb');
    expect(scenario.environment?.kind).toBe('lhtb');
    expect((scenario.meta as { artifacts: string[] }).artifacts).toEqual(ARTIFACTS);
  });

  it('preserves the runtime budget task.toml declared rather than a harness default', () => {
    const { environment } = fixture();
    expect(environment.agentTimeoutSec).toBe(3600);
    expect(environment.continueUntilTimeout).toBe(true);
    expect(environment.cpus).toBe(2);
    expect(environment.memoryMb).toBe(4096);
    expect(environment.verifierTimeoutSec).toBe(900);
    // allow_internet is per-container, and the verifier's is independent.
    expect(environment.agentNetwork).toBe('bridge');
    expect(environment.verifierNetwork).toBe('none');
  });

  it('refuses a task with no submission contract', () => {
    const { root, manifest, save } = fixture();
    manifest.tasks[0]!.artifacts = []; save();
    expect(() => lhtbAdapter.load(root)).toThrow('declares no artifacts');
  });

  it('rejects modified verifier bytes and new files in the import', () => {
    const { root, taskDirectory } = fixture();
    writeFileSync(join(taskDirectory, 'tests', 'test.sh'), 'tampered');
    expect(() => lhtbAdapter.load(root)).toThrow('SHA256 mismatch');
    writeFileSync(join(taskDirectory, 'tests', 'unexpected'), 'extra');
    expect(() => lhtbAdapter.load(root)).toThrow('file set changed');
  });

  it('rejects an accidentally materialized reference solution', () => {
    const { root, taskDirectory, manifest, save } = fixture();
    mkdirSync(join(taskDirectory, 'solution'), { recursive: true });
    writeFileSync(join(taskDirectory, 'solution', 'solve.sh'), 'the answer');
    manifest.tasks[0]!.files = { ...manifest.tasks[0]!.files, 'solution/solve.sh': 'e'.repeat(64) }; save();
    expect(() => lhtbAdapter.load(root)).toThrow('unexpected task file');
  });

  it('rejects substituted repository identity, floating commits, traversal and links', () => {
    const { root, manifest, save } = fixture();
    manifest.source.commit = 'main'; save();
    expect(() => lhtbAdapter.load(root)).toThrow('immutable 40-character commit');
    manifest.source.commit = 'b'.repeat(40); manifest.source.repository = 'https://github.com/someone/LHTB.git'; save();
    expect(() => lhtbAdapter.load(root)).toThrow('official repository');
    manifest.source.repository = LHTB_REPOSITORY; manifest.tasks[0]!.taskDirectory = '../elsewhere'; save();
    expect(() => lhtbAdapter.load(root)).toThrow('noncanonical');
    const linked = fixture();
    symlinkSync('/tmp', join(linked.taskDirectory, 'tests', 'linked'));
    expect(() => lhtbAdapter.load(linked.root)).toThrow('symlink');
  });

  it('rechecks changed task files immediately before execution', () => {
    const { environment, taskDirectory } = fixture();
    writeFileSync(join(taskDirectory, 'instruction.md'), 'changed');
    expect(() => verifyLhtbFiles(environment)).toThrow('SHA256 mismatch');
  });

  it('normalizes relative and absolute artifact paths to one /app-rooted form', () => {
    const { environment } = fixture();
    expect(lhtbArtifactPaths(environment)).toEqual(['/app/outputs/report.json', '/app/src']);
    expect(() => lhtbArtifactPaths({ ...environment, artifacts: ['/etc/passwd'] })).toThrow('outside /app');
    expect(() => lhtbArtifactPaths({ ...environment, artifacts: ['../escape'] })).toThrow("contains '..'");
  });
});

describe('LHTB dense reward', () => {
  it('reports the verifier float and passed/total without collapsing either to a bit', async () => {
    const { root, environment, files } = fixture();
    fixtureHashes = files;
    const { runtime } = fakeDocker({ reward: '0.7272727272727273' });
    const sandbox = createLhtbSandbox(environment, 'reward', runtime);
    try {
      const result = await sandbox.verifyLhtb(join(root, 'verification'));
      expect(result.reward).toBeCloseTo(0.7272727272727273, 12);
      expect(result.passed).toBe(3);
      expect(result.total).toBe(4);
      // 0.727... is not 3/4: the task weights gates, and that is reported, not smoothed.
      expect(result.rewardMatchesPassedTotal).toBe(false);
      expect(result.submissionSha256).toHaveLength(64);
    } finally { sandbox.cleanup(); }
  });

  it('accepts a failing verifier exit status, because a failing test suite is not an infrastructure failure', async () => {
    const { root, environment, files } = fixture();
    fixtureHashes = files;
    const { runtime, calls } = fakeDocker({ reward: '0.0' });
    const sandbox = createLhtbSandbox(environment, 'zero', runtime);
    try {
      const result = await sandbox.verifyLhtb(join(root, 'verification'));
      expect(result.reward).toBe(0);
      expect(calls.find((call) => call.args.includes('/tests/test.sh'))).toBeDefined();
    } finally { sandbox.cleanup(); }
  });

  it('refuses a reward that is not a float in [0, 1]', async () => {
    for (const reward of ['', 'PASS', '1.5', '-0.1']) {
      const { root, environment, files } = fixture();
      fixtureHashes = files;
      const sandbox = createLhtbSandbox(environment, 'bad', fakeDocker({ reward }).runtime);
      try { await expect(sandbox.verifyLhtb(join(root, 'verification'))).rejects.toThrow('not a float in [0,1]'); }
      finally { sandbox.cleanup(); }
    }
  });

  it('parses pytest counts the way tests/test.sh does, including the compact form', () => {
    expect(parsePytestCounts('11 passed in 30.5s')).toEqual({ passed: 11, total: 11 });
    expect(parsePytestCounts('3 failed, 15 warnings, 8 errors in 4.38s')).toEqual({ passed: 0, total: 11 });
    expect(parsePytestCounts('.F.E\n')).toEqual({ passed: 2, total: 4 });
    expect(parsePytestCounts('no counts here')).toEqual({ passed: 0, total: 0 });
  });
});

describe('LHTB verifier isolation', () => {
  it('never lets tests/ or solution/ reach the agent container, and grades in a second one', async () => {
    const { root, environment, files } = fixture();
    fixtureHashes = files;
    const { runtime, calls } = fakeDocker();
    const sandbox = createLhtbSandbox(environment, 'isolation', runtime);
    try {
      await sandbox.verifyLhtb(join(root, 'verification'));
      const started = calls.filter((call) => call.args[0] === 'run');
      expect(started).toHaveLength(2);
      for (const call of started) {
        expect(call.args).not.toContain('--volume');
        expect(call.args).not.toContain('--mount');
      }
      // Hidden tests are copied into container-2 only.
      const staged = calls.filter((call) => call.args[0] === 'cp' && String(call.args.at(-1)).endsWith(':/tests'));
      expect(staged).toHaveLength(1);
      expect(String(staged[0]!.args.at(-1))).toBe('container-2:/tests');
      expect(calls.some((call) => call.args[0] === 'cp' && String(call.args.at(-1)).startsWith('container-1:'))).toBe(false);
      // The graded command runs in the verifier container, never the agent's.
      const grade = calls.find((call) => call.args.includes('/tests/test.sh'))!.args;
      expect(grade).toContain('container-2');
      expect(grade).not.toContain('container-1');
      expect(calls.some((call) => call.args[0] === 'rm' && call.args.at(-1) === 'container-2')).toBe(true);
    } finally { sandbox.cleanup(); }
  });

  it('refuses to grade if a staged hidden test differs from the pinned import', async () => {
    const { root, environment, files } = fixture();
    fixtureHashes = { ...files, 'tests/test.sh': 'f'.repeat(64) };
    const sandbox = createLhtbSandbox(environment, 'drift', fakeDocker().runtime);
    try { await expect(sandbox.verifyLhtb(join(root, 'verification'))).rejects.toThrow('differs from the pinned import'); }
    finally { sandbox.cleanup(); }
  });

  it('refuses to start when the agent image already carries the hidden tests', () => {
    const { environment, files } = fixture();
    fixtureHashes = files;
    const { runtime } = fakeDocker();
    const original = runtime.sync;
    runtime.sync = (args, input) => {
      if (String(args.at(-1)).startsWith('test ! -e /tests')) return { ...success(), exitCode: 1 };
      return original(args, input);
    };
    expect(() => createLhtbSandbox(environment, 'leak', runtime)).toThrow('present in the agent container');
  });

  it('rejects a container-exported symlink that escapes the submission', async () => {
    const { root, environment, files } = fixture();
    fixtureHashes = files;
    const { runtime } = fakeDocker();
    const original = runtime.sync;
    runtime.sync = (args, input) => {
      if (args[0] === 'cp' && String(args.at(-2)).endsWith(':/app')) {
        mkdirSync(String(args.at(-1)), { recursive: true });
        symlinkSync('/etc/passwd', join(String(args.at(-1)), 'leak'));
        return success();
      }
      return original(args, input);
    };
    const sandbox = createLhtbSandbox(environment, 'symlink', runtime);
    try { await expect(sandbox.verifyLhtb(join(root, 'verification'))).rejects.toThrow('escapes the submission'); }
    finally { sandbox.cleanup(); }
  });

  it('transfers exactly the declared artifacts in separate-verifier mode and records the missing ones', async () => {
    const { root, environment, files } = fixture({ verifierMode: 'separate' });
    fixtureHashes = files;
    const { runtime, calls } = fakeDocker({ missing: ['/app/src'] });
    const sandbox = createLhtbSandbox(environment, 'separate', runtime);
    try {
      const result = await sandbox.verifyLhtb(join(root, 'verification'));
      expect(result.missingArtifacts).toEqual(['/app/src']);
      const exported = calls.filter((call) => call.args[0] === 'cp' && String(call.args.at(-2)).startsWith('container-1:'));
      expect(exported.map((call) => String(call.args.at(-2)))).toEqual(['container-1:/app/outputs/report.json']);
      const submission = JSON.parse(readFileSync(join(root, 'verification', 'submission.json'), 'utf8'));
      expect(submission.verifierMode).toBe('separate');
      expect(submission.missingArtifacts).toEqual(['/app/src']);
    } finally { sandbox.cleanup(); }
  });

  it('pulls both images and builds nothing, so a cross-platform host needs no builder', async () => {
    const { environment, files } = fixture();
    fixtureHashes = files;
    const { runtime, calls } = fakeDocker();
    const prepared = await prepareLhtbEnvironment(environment, runtime);
    expect(prepared.imageId).toBe('sha256:agent-image');
    expect(calls.some((call) => call.args[0] === 'build')).toBe(false);
    expect(calls.filter((call) => call.args[0] === 'pull').map((call) => call.args[1])).toEqual(['task-image:version']);
  });
});

describe('LHTB environment gates', () => {
  /**
   * A gate document with the exact shape eval/scripts/preflight-lhtb.mjs
   * writes, plus the on-disk artifacts the verifier re-reads rather than
   * trusting. Built from the same fixture the adapter loads, so a tampered
   * byte anywhere fails the same way it would in a real batch.
   */
  function gateFixture(mutate: (parts: any) => void = () => {}) {
    // A distinct verifier image is the general case; both dev tasks happen to
    // reuse the task image, which this fixture's tag mapping also covers.
    const { root, environment, files } = fixture({ verifierImage: 'verifier-image:version' });
    const stagedTests = Object.fromEntries(Object.entries(files).filter(([name]) => name.startsWith('tests/')));
    const gate = (kind: 'pristine' | 'reference') => {
      const path = join(root, kind);
      mkdirSync(join(path, 'verifier'), { recursive: true });
      mkdirSync(join(path, 'submission', 'app', 'outputs'), { recursive: true });
      writeFileSync(join(path, 'submission', 'app', 'outputs', 'report.json'), kind === 'reference' ? '{"ok":true}' : '');
      const digest = submissionDigest(join(path, 'submission'));
      const reward = kind === 'pristine' ? 0 : 1;
      writeFileSync(join(path, 'verifier', 'reward.txt'), `${reward}.0`);
      writeFileSync(join(path, 'verifier-outcome.json'), JSON.stringify({ exitCode: reward === 1 ? 0 : 1, timedOut: false }));
      writeFileSync(join(path, 'submission.json'), JSON.stringify({
        source: environment.source, imageId: AGENT_IMAGE, verifierImageId: VERIFIER_IMAGE,
        verifierMode: environment.verifierMode, agentNetwork: environment.agentNetwork,
        verifierNetwork: environment.verifierNetwork, files: digest.files,
      }));
      const verification = {
        reward, passed: reward === 1 ? 11 : 0, total: 11, rewardMatchesPassedTotal: true, rewardRaw: `${reward}.0`,
        stagedTests, artifactsDirectory: path, submissionSha256: digest.submissionSha256, missingArtifacts: [],
        imageId: AGENT_IMAGE, verifierImageId: VERIFIER_IMAGE, verifier: { exitCode: reward === 1 ? 0 : 1, stdout: '', stderr: '', timedOut: false },
      };
      writeFileSync(join(path, 'verification.json'), JSON.stringify(verification));
      return { ...verification, failedTests: [] };
    };
    const parts = {
      pristine: gate('pristine'), reference: gate('reference'),
      isolation: { probe: 'test ! -e /tests && test ! -e /solution && ls -A /app | head -50', exitCode: 0,
        agentHasHiddenTests: false, agentHasSolution: false, agentWorkspace: ['src'] },
      images: { task: { id: AGENT_IMAGE }, verifierBase: { id: VERIFIER_IMAGE } },
    };
    mutate(parts);
    const document = { tasks: [{ task: 'test-task', source: environment.source, ...parts }] };
    const runtime: DockerRuntime = {
      sync: (args) => success(String(args.at(-1)) === 'verifier-image:version' ? VERIFIER_IMAGE : AGENT_IMAGE),
      async run() { throw new Error('no container/model work allowed in evidence checks'); },
    };
    const scenario = { id: 'test-task', benchmark: 'lhtb', task: 'x', judge: { kind: 'lhtb' as const }, environment };
    return { root, environment, document, runtime, scenario, stagedTests, parts };
  }

  it('accepts the document preflight-lhtb.mjs writes and pins both image identities', () => {
    const { document, runtime, scenario, stagedTests } = gateFixture();
    const identity = verifyEnvironmentGates(scenario, [document], runtime);
    expect(identity.benchmark).toBe('lhtb');
    expect(identity.imageId).toBe(AGENT_IMAGE);
    expect(identity.verifierImageId).toBe(VERIFIER_IMAGE);
    // No verifier image is built, so these hashes are the hidden-test provenance.
    expect(identity.stagedTests).toEqual(stagedTests);
    expect(identity.checks.map((check) => check.kind)).toEqual(['pristine', 'reference']);
  });

  it('rejects a task byte that differs from the pinned import even when the commit matches', () => {
    const { document, runtime, scenario } = gateFixture();
    const changed = { ...scenario, environment: { ...scenario.environment, source: { ...scenario.environment.source, sourceHash: '9'.repeat(64) } } };
    expect(() => verifyEnvironmentGates(changed, [document], runtime)).toThrow('full imported source');
  });

  it('refuses anything but reward 0 pristine and reward 1 reference', () => {
    for (const [kind, value] of [['pristine', '0.09090909090909091'], ['reference', '0.9090909090909091']] as const) {
      const { document, runtime, scenario, parts } = gateFixture();
      writeFileSync(join(parts[kind].artifactsDirectory, 'verifier', 'reward.txt'), value);
      expect(() => verifyEnvironmentGates(scenario, [document], runtime)).toThrow(`invalid ${kind} gate artifacts`);
    }
  });

  it('refuses a reference gate whose suite did not fully pass', () => {
    const { document, runtime, scenario, parts } = gateFixture((p) => { p.reference.failedTests = ['tests/test_outputs.py::test_x']; });
    void parts;
    expect(() => verifyEnvironmentGates(scenario, [document], runtime)).toThrow('invalid reference gate artifacts');
  });

  it('refuses a submission tree edited after the gate ran', () => {
    const { document, runtime, scenario, parts } = gateFixture();
    writeFileSync(join(parts.reference.artifactsDirectory, 'submission', 'app', 'outputs', 'report.json'), 'tampered');
    expect(() => verifyEnvironmentGates(scenario, [document], runtime)).toThrow('invalid reference gate artifacts');
  });

  it('refuses a hidden test byte the verifier container did not confirm', () => {
    const { document, runtime, scenario, parts } = gateFixture((p) => { p.reference.stagedTests = { 'tests/test.sh': 'a'.repeat(64) }; });
    void parts;
    expect(() => verifyEnvironmentGates(scenario, [document], runtime)).toThrow('invalid reference gate artifacts');
  });

  it('refuses a submission carrying a hidden test, matched by content and not by path', () => {
    const { document, runtime, scenario, parts } = gateFixture();
    // The agent could only have this byte if the hidden tests reached its container.
    writeFileSync(join(parts.reference.artifactsDirectory, 'submission', 'app', 'harmless-name.txt'), TESTS);
    const verification = JSON.parse(readFileSync(join(parts.reference.artifactsDirectory, 'verification.json'), 'utf8'));
    const digest = submissionDigest(join(parts.reference.artifactsDirectory, 'submission'));
    verification.submissionSha256 = digest.submissionSha256;
    parts.reference.submissionSha256 = digest.submissionSha256;
    writeFileSync(join(parts.reference.artifactsDirectory, 'verification.json'), JSON.stringify(verification));
    const submission = JSON.parse(readFileSync(join(parts.reference.artifactsDirectory, 'submission.json'), 'utf8'));
    submission.files = digest.files;
    writeFileSync(join(parts.reference.artifactsDirectory, 'submission.json'), JSON.stringify(submission));
    expect(() => verifyEnvironmentGates(scenario, [document], runtime)).toThrow('invalid reference gate artifacts');
  });

  it('requires the recorded agent-isolation probe, and refuses a weakened one', () => {
    for (const mutate of [
      (p: any) => { delete p.isolation; },
      (p: any) => { p.isolation.exitCode = 1; },
      (p: any) => { p.isolation.agentHasHiddenTests = true; },
      (p: any) => { p.isolation.probe = 'ls -A /app'; },
    ]) {
      const { document, runtime, scenario } = gateFixture(mutate);
      expect(() => verifyEnvironmentGates(scenario, [document], runtime)).toThrow(/isolation probe|free of hidden tests/);
    }
  });

  it('requires exactly one pristine and one reference gate', () => {
    const { document, runtime, scenario } = gateFixture((p) => { delete p.reference; });
    expect(() => verifyEnvironmentGates(scenario, [document], runtime)).toThrow('exactly one pristine and reference gate');
  });

  it('refuses live images that no longer match the gated identities', () => {
    const { document, scenario } = gateFixture();
    const drifted: DockerRuntime = {
      sync: () => success(`sha256:${'9'.repeat(64)}`),
      async run() { throw new Error('unreachable'); },
    };
    expect(() => verifyEnvironmentGates(scenario, [document], drifted)).toThrow('current Docker images differ from gates');
  });
});
