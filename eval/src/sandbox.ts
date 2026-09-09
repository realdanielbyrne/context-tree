/**
 * The per-run sandbox: a temp directory with the scenario's files materialized,
 * a shell runner with a hard timeout, and cleanup. Every benchmark's agent work
 * and every judge command happens inside one of these — nothing the harness
 * writes ever lands in the repo.
 */
import { execFile, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Scenario } from './types.js';
import { deepSweVerifierImage, verifyDeepSweFiles, type DeepSweEnvironment } from './adapters/deepswe.js';
import { createLhtbSandbox, type LhtbVerification } from './adapters/lhtb-sandbox.js';

export interface CommandOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface Sandbox {
  readonly path: string;
  readonly execution?: { kind: 'docker'; containerId: string; workdir: string; imageId: string };
  run(command: string, timeoutMs: number): Promise<CommandOutcome>;
  readFile(relPath: string): string;
  writeFile(relPath: string, content: string): void;
  cleanup(): void;
  verify?(artifactDirectory: string): Promise<DeepSweVerification>;
  /** LHTB's dense-reward verifier; distinct because its result is not binary. */
  verifyLhtb?(artifactDirectory: string): Promise<LhtbVerification>;
}

export interface DeepSweVerification {
  reward: number;
  rewardDetails: Record<string, unknown>;
  artifactsDirectory: string;
  patchSha256: string;
  imageId: string;
  verifier: CommandOutcome;
}

/** Injectable Docker transport lets deterministic tests assert the isolation boundary. */
export interface DockerRuntime {
  sync(args: readonly string[], input?: string): CommandOutcome;
  run(args: readonly string[], timeoutMs?: number): Promise<CommandOutcome>;
}

export const dockerRuntime: DockerRuntime = {
  sync(args, input) {
    const result = spawnSync('docker', [...args], { encoding: 'utf8', input, maxBuffer: Infinity });
    return { exitCode: result.status, stdout: result.stdout ?? '', stderr: `${result.stderr ?? ''}${result.error?.message ?? ''}`, timedOut: false };
  },
  run(args, timeoutMs) {
    return new Promise((resolvePromise) => {
      const child = spawn('docker', [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let timedOut = false;
      const timer = timeoutMs !== undefined && timeoutMs > 0 ? setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs) : undefined;
      child.stdout.on('data', (data: Buffer) => stdout.push(data));
      child.stderr.on('data', (data: Buffer) => stderr.push(data));
      child.on('error', (error) => stderr.push(Buffer.from(error.message)));
      child.on('close', (exitCode) => {
        if (timer !== undefined) clearTimeout(timer);
        resolvePromise({ exitCode, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(), timedOut });
      });
    });
  },
};

function requireDocker(outcome: CommandOutcome, operation: string): string {
  if (outcome.exitCode !== 0 || outcome.timedOut) throw new Error(`deepswe: ${operation} failed: ${outcome.stderr || outcome.stdout}`);
  return outcome.stdout.trim();
}

/** A container-produced symlink must never be followed on the host. */
function verifyExportedFiles(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error(`deepswe: nonregular exported artifact: ${path}`);
  if (stat.isDirectory()) for (const entry of readdirSync(path)) verifyExportedFiles(join(path, entry));
}

/** Pull the official agent image and build its separate, pinned verifier image. No model calls. */
export async function prepareDeepSweEnvironment(environment: DeepSweEnvironment, runtime: DockerRuntime = dockerRuntime): Promise<{ imageId: string; verifierImageId: string }> {
  verifyDeepSweFiles(environment);
  requireDocker(await runtime.run(['pull', environment.image]), 'pull task image');
  const imageId = requireDocker(runtime.sync(['image', 'inspect', '--format', '{{.Id}}', environment.image]), 'inspect task image');
  const tests = join(environment.taskDirectory, 'tests');
  const dockerfile = readFileSync(join(tests, 'Dockerfile'), 'utf8');
  // The official verifier Dockerfile has one FROM, referencing the same task image.
  const from = [...dockerfile.matchAll(/^FROM\s+(\S+)\s*$/gmi)];
  if (from.length !== 1 || from[0]?.[1] !== environment.image) throw new Error('deepswe: unsupported verifier base image');
  const build = mkdtempSync(join(tmpdir(), 'ct-deepswe-build-'));
  try {
    const pinnedDockerfile = join(build, 'Dockerfile');
    writeFileSync(pinnedDockerfile, dockerfile.replace(/^FROM\s+\S+\s*$/mi, `FROM ${imageId}`));
    requireDocker(await runtime.run(['build', '--pull=false', '--label', `context-tree.deepswe.base-image=${imageId}`, '--file', pinnedDockerfile, '--tag', deepSweVerifierImage(environment), tests], environment.verifierBuildTimeoutSec * 1000), 'build official verifier');
    const verifierImageId = requireDocker(runtime.sync(['image', 'inspect', '--format', '{{.Id}}', deepSweVerifierImage(environment)]), 'inspect verifier image');
    return { imageId, verifierImageId };
  } finally {
    rmSync(build, { recursive: true, force: true });
  }
}

const MAX_READ_BYTES = 256 * 1024;

/**
 * Resolves `relPath` inside `root`, refusing any path that escapes it. An
 * absolute path is tolerated by stripping its leading separator — models pass
 * the sandbox-cwd-qualified path back more often than not — but `..` climbing
 * out of the sandbox is always an error, never a silent containment.
 */
export function safeJoin(root: string, relPath: string): string {
  if (typeof relPath !== 'string' || relPath.trim() === '') {
    throw new Error('empty path');
  }
  const stripped = isAbsolute(relPath) ? relPath.slice(1) : relPath;
  const target = resolve(root, stripped);
  const rel = relative(root, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`path escapes the sandbox: ${relPath}`);
  }
  return target;
}

/** Renders one `CommandOutcome` as the text the agent (or judge) sees. */
export function renderOutcome(outcome: CommandOutcome, maxChars = 16_000): string {
  const status = outcome.timedOut ? 'timed out' : `exit ${outcome.exitCode ?? 'null'}`;
  const text = `--- ${status} ---\n--- stdout ---\n${outcome.stdout}\n--- stderr ---\n${outcome.stderr}`;
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n... (truncated)`;
}

export function createSandbox(scenario: Scenario, label: string): Sandbox {
  if (scenario.environment?.kind === 'deepswe') return createDockerSandbox(scenario.environment, label);
  if (scenario.environment?.kind === 'lhtb') return createLhtbSandbox(scenario.environment, label);
  const safeLabel = label.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64);
  const path = mkdtempSync(join(tmpdir(), `ct-eval-${safeLabel}-`));

  const writeFile = (relPath: string, content: string): void => {
    const target = safeJoin(path, relPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  for (const [relPath, content] of Object.entries(scenario.files ?? {})) {
    writeFile(relPath, content);
  }

  return {
    path,
    run(command: string, timeoutMs: number): Promise<CommandOutcome> {
      return new Promise((resolvePromise) => {
        execFile(
          '/bin/sh',
          ['-c', command],
          { cwd: path, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
          (error, stdout, stderr) => {
            const err = error as (Error & { code?: string | number; killed?: boolean }) | undefined;
            const timedOut = err?.killed === true;
            const exitCode = timedOut
              ? null
              : typeof err?.code === 'number'
                ? err.code
                : err
                  ? 1
                  : 0;
            resolvePromise({ exitCode, stdout: String(stdout), stderr: String(stderr), timedOut });
          },
        );
      });
    },
    readFile(relPath: string): string {
      const target = safeJoin(path, relPath);
      let size: number;
      try {
        size = statSync(target).size;
      } catch {
        throw new Error(`read_file: no such file: ${relPath}`);
      }
      if (size > MAX_READ_BYTES) {
        throw new Error(`read_file: ${relPath} is larger than the ${MAX_READ_BYTES} byte cap`);
      }
      return readFileSync(target, 'utf8');
    },
    writeFile,
    cleanup(): void {
      rmSync(path, { recursive: true, force: true });
    },
  };
}

/** Agent and verifier share immutable image ancestry, never a writable filesystem. */
export function createDockerSandbox(environment: DeepSweEnvironment, label: string, runtime: DockerRuntime = dockerRuntime): Sandbox {
  verifyDeepSweFiles(environment);
  const imageId = requireDocker(runtime.sync(['image', 'inspect', '--format', '{{.Id}}', environment.image]), 'task image unavailable; run preflight-deepswe.mjs --prepare');
  const verifierImageId = requireDocker(runtime.sync(['image', 'inspect', '--format', '{{.Id}}', deepSweVerifierImage(environment)]), 'verifier image unavailable; run preflight-deepswe.mjs --prepare');
  const verifierBase = requireDocker(runtime.sync(['image', 'inspect', '--format', '{{index .Config.Labels "context-tree.deepswe.base-image"}}', verifierImageId]), 'inspect verifier ancestry');
  if (verifierBase !== imageId) throw new Error('deepswe: verifier base differs from task image; rerun preflight --prepare');
  const path = mkdtempSync(join(tmpdir(), `ct-eval-${label.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64)}-`));
  let agent = '';
  let cleaned = false;
  const create = (image: string, cpus: number, memory: number): string => requireDocker(runtime.sync([
    'run', '--detach', '--network', 'none', '--cpus', String(cpus), '--memory', `${memory}m`,
    '--workdir', '/app', '--entrypoint', '/bin/sh', image, '-c', 'while :; do sleep 3600; done',
  ]), 'start isolated container');
  try {
    agent = create(imageId, environment.cpus, environment.memoryMb);
    const base = requireDocker(runtime.sync(['exec', '--workdir', '/app', agent, 'git', 'rev-parse', 'HEAD']), 'verify task base');
    const resolvedBase = requireDocker(runtime.sync(['exec', '--workdir', '/app', agent, 'git', 'rev-parse', `${environment.baseCommit}^{commit}`]), 'resolve official task base');
    if (base !== resolvedBase) throw new Error(`deepswe: image HEAD ${base} differs from pinned task base ${resolvedBase}`);
  } catch (error) {
    if (agent) runtime.sync(['rm', '--force', agent]);
    rmSync(path, { recursive: true, force: true });
    throw error;
  }
  const containerPath = (requested: string): string => {
    const rel = requested.startsWith('/app/') ? requested.slice('/app/'.length) : requested;
    if (isAbsolute(rel)) throw new Error(`path escapes the task repository: ${requested}`);
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
    async verify(artifactDirectory) {
      verifyDeepSweFiles(environment);
      const output = resolve(artifactDirectory);
      if (existsSync(output)) throw new Error(`deepswe: verifier artifact directory must be new: ${output}`);
      mkdirSync(join(output, 'artifacts'), { recursive: true });
      const status = await exec('git status --porcelain=v1');
      const head = await exec('git rev-parse HEAD');
      writeFileSync(join(output, 'submission.json'), JSON.stringify({ source: environment.source, imageId, verifierImageId, head: head.stdout.trim(), dirty: status.stdout, committedOnly: true }, null, 2));
      for (const hook of environment.collect) requireDocker(await exec(hook.command, hook.timeoutSec * 1000), 'official patch collection');
      // No host directory or hidden test is ever mounted/copied into the agent.
      requireDocker(runtime.sync(['cp', `${agent}:/logs/artifacts/model.patch`, join(output, 'artifacts', 'model.patch')]), 'export committed patch');
      verifyExportedFiles(join(output, 'artifacts', 'model.patch'));
      const patchSha256 = createHash('sha256').update(readFileSync(join(output, 'artifacts', 'model.patch'))).digest('hex');
      const verifier = create(verifierImageId, environment.verifierCpus, environment.verifierMemoryMb);
      let outcome: CommandOutcome;
      try {
        const base = requireDocker(runtime.sync(['exec', '--workdir', '/app', verifier, 'git', 'rev-parse', 'HEAD']), 'verify pristine verifier base');
        const resolvedBase = requireDocker(runtime.sync(['exec', '--workdir', '/app', verifier, 'git', 'rev-parse', `${environment.baseCommit}^{commit}`]), 'resolve verifier task base');
        if (base !== resolvedBase) throw new Error('deepswe: verifier does not start at pinned base');
        requireDocker(runtime.sync(['exec', verifier, 'mkdir', '-p', '/logs/artifacts', '/logs/verifier']), 'create verifier logs');
        requireDocker(runtime.sync(['cp', join(output, 'artifacts', 'model.patch'), `${verifier}:/logs/artifacts/model.patch`]), 'transfer patch to verifier');
        outcome = await runtime.run(['exec', '--workdir', '/app', verifier, '/bin/bash', '/tests/test.sh'], environment.verifierTimeoutSec * 1000);
        requireDocker(runtime.sync(['cp', `${verifier}:/logs/verifier`, output]), 'export official verifier artifacts');
        verifyExportedFiles(join(output, 'verifier'));
        writeFileSync(join(output, 'verifier', 'test-stdout.txt'), `${outcome.stdout}\n${outcome.stderr}`);
        writeFileSync(join(output, 'verifier-outcome.json'), JSON.stringify(outcome, null, 2));
      } finally {
        runtime.sync(['rm', '--force', verifier]);
      }
      if (outcome.timedOut || outcome.exitCode !== 0) throw new Error(`deepswe: official verifier infrastructure failure; see ${output}`);
      const rewardPath = join(output, 'verifier', 'reward.json');
      if (!existsSync(rewardPath)) throw new Error(`deepswe: verifier produced no reward.json; see ${output}`);
      const rewardDetails = JSON.parse(readFileSync(rewardPath, 'utf8')) as Record<string, unknown>;
      if (rewardDetails.reward !== 0 && rewardDetails.reward !== 1) throw new Error(`deepswe: invalid official reward; see ${output}`);
      return { reward: rewardDetails.reward, rewardDetails, artifactsDirectory: output, patchSha256, imageId, verifier: outcome };
    },
    cleanup() {
      if (cleaned) return;
      requireDocker(runtime.sync(['rm', '--force', agent]), 'remove agent container');
      rmSync(path, { recursive: true, force: true });
      cleaned = true;
    },
  };
}
