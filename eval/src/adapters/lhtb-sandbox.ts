/**
 * LHTB execution: an agent container that never sees tests/ or solution/, and
 * an independent verifier container that grades a transferred submission.
 *
 * The two containers share nothing writable. The submission crosses the
 * boundary as files on the host (`<artifacts>/submission/`), so the hidden
 * verifier image is never mounted, copied or reachable from the agent side.
 *
 * The reward is dense: /logs/verifier/reward.txt holds a float in [0, 1].
 * `passed`/`total` are parsed from the pytest log and reported separately --
 * `reward === 1` is a derived convenience, never the stored score.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { safeJoin, type CommandOutcome, type DockerRuntime, type Sandbox } from '../sandbox.js';
import { dockerRuntime } from '../sandbox.js';
import { lhtbArtifactPaths, submissionDigest, verifyLhtbFiles, type LhtbEnvironment } from './lhtb.js';

export interface LhtbVerification {
  /** The dense reward exactly as the official verifier wrote it. */
  reward: number;
  /** Reported alongside the reward, never folded into it. */
  passed: number;
  total: number;
  /** False when the task's verifier weights gates instead of counting tests. */
  rewardMatchesPassedTotal: boolean;
  rewardRaw: string;
  /**
   * SHA256 of every hidden test as read INSIDE the verifier container at grade
   * time. No verifier image is built (see prepareLhtbEnvironment), so this map
   * is the hidden-test provenance that a built image's label would otherwise
   * carry, and the gate verifier checks it against the pinned import.
   */
  stagedTests: Record<string, string>;
  artifactsDirectory: string;
  submissionSha256: string;
  missingArtifacts: readonly string[];
  imageId: string;
  verifierImageId: string;
  verifier: CommandOutcome;
}

function requireDocker(outcome: CommandOutcome, operation: string): string {
  if (outcome.exitCode !== 0 || outcome.timedOut) throw new Error(`lhtb: ${operation} failed: ${outcome.stderr || outcome.stdout}`);
  return outcome.stdout.trim();
}

/**
 * A container-produced symlink is allowed only when it stays inside the
 * exported tree -- a Python project legitimately contains them -- but one
 * pointing at host state outside it is refused.
 */
function verifyExportedFiles(root: string, path = root, base = realpathSync(root)): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    const rel = relative(base, resolve(dirname(path), readlinkSync(path)));
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
      throw new Error(`lhtb: exported symlink escapes the submission: ${path} -> ${readlinkSync(path)}`);
    }
    return;
  }
  if (!stat.isFile() && !stat.isDirectory()) throw new Error(`lhtb: nonregular exported artifact: ${path}`);
  if (stat.isDirectory()) for (const entry of readdirSync(path)) verifyExportedFiles(root, join(path, entry), base);
}

function countFrom(log: string, pattern: RegExp): number {
  const match = pattern.exec(log);
  return match === null ? 0 : Number.parseInt(match[1] ?? '0', 10);
}

/** The same counts tests/test.sh derives, so the pair can be cross-checked. */
export function parsePytestCounts(log: string): { passed: number; total: number } {
  let passed = countFrom(log, /(\d+) passed/);
  let failed = countFrom(log, /(\d+) failed/) + countFrom(log, /(\d+) errors?/);
  if (passed === 0 && failed === 0) {
    const compact = /^([.FEsxX]+)\s*$/m.exec(log);
    if (compact !== null) {
      const marks = compact[1] ?? '';
      passed = [...marks].filter((mark) => mark === '.').length;
      failed = [...marks].filter((mark) => mark === 'F' || mark === 'E').length;
    }
  }
  return { passed, total: passed + failed };
}

/**
 * Pull the official images. No model calls, and deliberately no image build:
 * this host is aarch64 with no buildx, and the legacy builder cannot export a
 * child of a single-platform linux/amd64 image ("no match for platform in
 * manifest"). Hidden tests are therefore staged into the VERIFIER CONTAINER at
 * grade time, which keeps the isolation invariant (they never exist in the
 * agent container or its image) without needing a builder at all.
 */
export async function prepareLhtbEnvironment(
  environment: LhtbEnvironment,
  runtime: DockerRuntime = dockerRuntime,
): Promise<{ imageId: string; verifierImageId: string; testsInImage: boolean }> {
  verifyLhtbFiles(environment);
  requireDocker(await runtime.run(['pull', environment.image]), 'pull task image');
  const imageId = requireDocker(runtime.sync(['image', 'inspect', '--format', '{{.Id}}', environment.image]), 'inspect task image');
  if (environment.verifierImage !== environment.image) {
    requireDocker(await runtime.run(['pull', environment.verifierImage]), 'pull verifier image');
  }
  const verifierImageId = requireDocker(runtime.sync(['image', 'inspect', '--format', '{{.Id}}', environment.verifierImage]), 'inspect verifier image');
  return { imageId, verifierImageId, testsInImage: verifierImageId !== imageId };
}

/** Relative names under tests/, as recorded in the pinned import. */
function testFileNames(environment: LhtbEnvironment): string[] {
  const names = Object.keys(environment.source.files).filter((name) => name.startsWith('tests/')).sort();
  for (const name of names) {
    if (!/^[A-Za-z0-9._/-]+$/.test(name)) throw new Error(`lhtb: unshellable test path: ${name}`);
  }
  return names;
}

/**
 * Every hidden test byte in the verifier container must equal the pinned
 * import. This replaces the image-provenance label a built verifier image
 * would have carried, and additionally catches a published verifier image
 * whose baked /tests has drifted from the pinned commit.
 */
function verifyStagedTests(environment: LhtbEnvironment, container: string, runtime: DockerRuntime): Record<string, string> {
  const names = testFileNames(environment);
  const listed = names.map((name) => `'${name.slice('tests/'.length)}'`).join(' ');
  const outcome = runtime.sync(['exec', '--workdir', '/tests', container, '/bin/sh', '-c', `sha256sum ${listed}`]);
  requireDocker(outcome, 'hash staged hidden tests');
  const actual = new Map<string, string>();
  for (const line of outcome.stdout.trim().split('\n')) {
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
    if (match === null) throw new Error(`lhtb: unparseable sha256sum line: ${line}`);
    actual.set(`tests/${match[2]}`, match[1] ?? '');
  }
  const staged: Record<string, string> = {};
  for (const name of names) {
    const hash = actual.get(name) ?? '';
    if (hash !== environment.source.files[name]) {
      throw new Error(`lhtb: staged hidden test differs from the pinned import: ${name}`);
    }
    staged[name] = hash;
  }
  return staged;
}

/**
 * The agent container. Its filesystem is asserted free of /tests and /solution
 * at creation, and no host path is ever mounted into it.
 */
export function createLhtbSandbox(
  environment: LhtbEnvironment,
  label: string,
  runtime: DockerRuntime = dockerRuntime,
): Sandbox & { verifyLhtb(artifactDirectory: string): Promise<LhtbVerification> } {
  verifyLhtbFiles(environment);
  const imageId = requireDocker(runtime.sync(['image', 'inspect', '--format', '{{.Id}}', environment.image]), 'task image unavailable; run preflight-lhtb.mjs --prepare');
  const verifierImageId = requireDocker(runtime.sync(['image', 'inspect', '--format', '{{.Id}}', environment.verifierImage]), 'verifier image unavailable; run preflight-lhtb.mjs --prepare');
  const path = mkdtempSync(join(tmpdir(), `ct-eval-${label.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64)}-`));
  let agent = '';
  let cleaned = false;
  const create = (image: string, cpus: number, memory: number, network: string): string => requireDocker(runtime.sync([
    'run', '--detach', '--network', network, '--cpus', String(cpus), '--memory', `${memory}m`,
    '--workdir', '/app', '--entrypoint', '/bin/sh', image, '-c', 'while :; do sleep 3600; done',
  ]), 'start isolated container');
  try {
    agent = create(imageId, environment.cpus, environment.memoryMb, environment.agentNetwork);
    const isolation = runtime.sync(['exec', agent, '/bin/sh', '-c', 'test ! -e /tests && test ! -e /solution && test -d /app']);
    if (isolation.exitCode !== 0) throw new Error(`lhtb: hidden verifier or reference solution present in the agent container: ${environment.source.taskId}`);
  } catch (error) {
    if (agent) runtime.sync(['rm', '--force', agent]);
    rmSync(path, { recursive: true, force: true });
    throw error;
  }
  const containerPath = (requested: string): string => {
    const rel = requested.startsWith('/app/') ? requested.slice('/app/'.length) : requested;
    if (isAbsolute(rel)) throw new Error(`path escapes the task workspace: ${requested}`);
    return safeJoin('/app', rel);
  };
  const exec = (command: string, timeoutMs?: number) => runtime.run(['exec', '--workdir', '/app', agent, '/bin/sh', '-c', command], timeoutMs);
  return {
    path, execution: { kind: 'docker', containerId: agent, workdir: '/app', imageId },
    run: exec,
    readFile(requested) {
      const outcome = runtime.sync(['exec', '--workdir', '/app', agent, 'cat', '--', containerPath(requested)]);
      requireDocker(outcome, `read ${requested}`);
      return outcome.stdout;
    },
    writeFile(requested, content) {
      requireDocker(runtime.sync(['exec', '--interactive', '--workdir', '/app', agent, '/bin/sh', '-c', 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', 'write-file', containerPath(requested)], content), `write ${requested}`);
    },
    async verifyLhtb(artifactDirectory) {
      verifyLhtbFiles(environment);
      const output = resolve(artifactDirectory);
      if (existsSync(output)) throw new Error(`lhtb: verifier artifact directory must be new: ${output}`);
      const submission = join(output, 'submission');
      mkdirSync(submission, { recursive: true });
      const artifacts = lhtbArtifactPaths(environment);
      const missingArtifacts: string[] = [];
      for (const artifact of artifacts) {
        if (runtime.sync(['exec', agent, 'test', '-e', artifact]).exitCode !== 0) missingArtifacts.push(artifact);
      }
      // `shared` reproduces upstream in-place grading by moving the whole /app
      // tree; `separate` moves exactly the declared artifacts and nothing else.
      const transfers: { from: string; into: string }[] = environment.verifierMode === 'shared'
        ? [{ from: '/app', into: 'app' }]
        : artifacts.filter((artifact) => !missingArtifacts.includes(artifact))
            .map((artifact) => ({ from: artifact, into: `app/${artifact.slice('/app/'.length)}` }));
      for (const transfer of transfers) {
        const destination = join(submission, transfer.into);
        mkdirSync(dirname(destination), { recursive: true });
        requireDocker(runtime.sync(['cp', '--archive', `${agent}:${transfer.from}`, destination]), `export submission ${transfer.from}`);
      }
      verifyExportedFiles(submission);
      const { submissionSha256, files } = submissionDigest(submission);
      writeFileSync(join(output, 'submission.json'), JSON.stringify({
        source: environment.source, imageId, verifierImageId, verifierMode: environment.verifierMode,
        artifacts, missingArtifacts, transfers, submissionSha256, files,
        agentNetwork: environment.agentNetwork, verifierNetwork: environment.verifierNetwork,
      }, null, 2) + '\n');

      const verifier = create(verifierImageId, environment.verifierCpus, environment.verifierMemoryMb, environment.verifierNetwork);
      let outcome: CommandOutcome;
      let stagedTests: Record<string, string> = {};
      try {
        // Hidden tests enter the VERIFIER container only, and only here.
        if (runtime.sync(['exec', verifier, '/bin/sh', '-c', 'test -f /tests/test.sh']).exitCode !== 0) {
          requireDocker(runtime.sync(['exec', verifier, 'mkdir', '-p', '/tests']), 'create verifier test directory');
          requireDocker(runtime.sync(['cp', '--archive', `${join(environment.taskDirectory, 'tests')}/.`, `${verifier}:/tests`]), 'stage hidden tests into the verifier');
        }
        stagedTests = verifyStagedTests(environment, verifier, runtime);
        if (environment.verifierMode === 'shared') {
          requireDocker(runtime.sync(['exec', verifier, '/bin/sh', '-c', 'rm -rf /app && mkdir -p /app']), 'reset verifier workspace');
        }
        requireDocker(runtime.sync(['exec', verifier, '/bin/sh', '-c', 'mkdir -p /app /logs/verifier /logs/artifacts']), 'create verifier logs');
        for (const transfer of transfers) {
          // `DIR/.` copies the contents into an existing directory; a plain
          // path would nest it (DEST/basename). Artifact targets are removed
          // first so a pristine image copy can never survive underneath.
          const target = environment.verifierMode === 'shared' ? '/app' : transfer.from;
          const source = join(submission, transfer.into);
          if (environment.verifierMode !== 'shared') {
            requireDocker(runtime.sync(['exec', verifier, '/bin/sh', '-c', 'rm -rf -- "$1" && mkdir -p -- "$(dirname -- "$1")"', 'prepare', target]), `prepare ${target}`);
          }
          // `${dir}/.` copies CONTENTS; path.join would normalize the `/.` away
          // and docker cp would then nest the directory under the target.
          const spec = lstatSync(source).isDirectory() && environment.verifierMode === 'shared' ? `${source}/.` : source;
          requireDocker(runtime.sync(['cp', '--archive', spec, `${verifier}:${target}`]), `transfer submission ${transfer.from}`);
        }
        outcome = await runtime.run(['exec', '--workdir', '/app', verifier, '/bin/bash', '/tests/test.sh'], environment.verifierTimeoutSec * 1000);
        requireDocker(runtime.sync(['cp', '--archive', `${verifier}:/logs/verifier`, output]), 'export official verifier artifacts');
        verifyExportedFiles(join(output, 'verifier'));
        writeFileSync(join(output, 'verifier', 'test-stdout.txt'), `${outcome.stdout}\n${outcome.stderr}`);
        writeFileSync(join(output, 'verifier-outcome.json'), JSON.stringify(outcome, null, 2) + '\n');
      } finally {
        runtime.sync(['rm', '--force', verifier]);
      }
      // A failing test suite makes test.sh exit nonzero BY DESIGN, so exit
      // status is not an infrastructure signal here -- a missing reward is.
      if (outcome.timedOut) throw new Error(`lhtb: official verifier timed out after ${environment.verifierTimeoutSec}s; see ${output}`);
      const rewardPath = join(output, 'verifier', 'reward.txt');
      if (!existsSync(rewardPath)) throw new Error(`lhtb: verifier produced no reward.txt; see ${output}`);
      const rewardRaw = readFileSync(rewardPath, 'utf8');
      const reward = Number.parseFloat(rewardRaw.trim());
      if (!Number.isFinite(reward) || reward < 0 || reward > 1) throw new Error(`lhtb: reward.txt is not a float in [0,1]: ${JSON.stringify(rewardRaw)}; see ${output}`);
      const logPath = join(output, 'verifier', 'pytest.log');
      const { passed, total } = parsePytestCounts(existsSync(logPath) ? readFileSync(logPath, 'utf8') : `${outcome.stdout}\n${outcome.stderr}`);
      const rewardMatchesPassedTotal = total > 0 && Math.abs(reward - passed / total) < 1e-9;
      const verification: LhtbVerification = {
        reward, passed, total, rewardMatchesPassedTotal, rewardRaw, stagedTests, artifactsDirectory: output,
        submissionSha256, missingArtifacts, imageId, verifierImageId, verifier: outcome,
      };
      writeFileSync(join(output, 'verification.json'), JSON.stringify(verification, null, 2) + '\n');
      return verification;
    },
    cleanup() {
      if (cleaned) return;
      requireDocker(runtime.sync(['rm', '--force', agent]), 'remove agent container');
      rmSync(path, { recursive: true, force: true });
      cleaned = true;
    },
  };
}
