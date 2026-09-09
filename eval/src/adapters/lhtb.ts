/**
 * Long-Horizon-Terminal-Bench (LHTB) v1.1, imported from an immutable Git
 * commit by eval/scripts/import-lhtb.py.
 *
 * Two facts separate LHTB from DEEPSWE and drive everything here:
 *
 * 1. The submission contract is a FILE LIST (`artifacts` in task.toml), not a
 *    git commit. Nothing is collected as a patch; the agent's declared output
 *    paths are transferred to the verifier.
 * 2. The reward is DENSE: tests/test.sh writes passed/total as a float in
 *    [0, 1] to /logs/verifier/reward.txt. It is never collapsed to a bit --
 *    `passed`/`total` are reported alongside it (see `LhtbVerification`).
 */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { Adapter, Scenario } from '../types.js';

export const LHTB_ID = 'lhtb';
export const LHTB_REPOSITORY = 'https://github.com/zli12321/LHTB.git';

/** `bridge` only where task.toml sets `allow_internet = true`. */
export type LhtbNetwork = 'none' | 'bridge';

/**
 * `shared` tasks declare no [verifier.environment], so upstream Harbor grades
 * them inside the agent's own environment. This harness still uses a separate
 * container in both modes -- hidden tests never touch the agent filesystem --
 * and the mode only decides WHAT is transferred: the whole /app tree (shared,
 * reproducing in-place grading) or exactly the declared artifacts (separate).
 */
export type LhtbVerifierMode = 'shared' | 'separate';

export interface LhtbEnvironment {
  kind: 'lhtb';
  taskDirectory: string;
  image: string;
  /** task.toml `artifacts`: the paths the agent must produce. */
  artifacts: readonly string[];
  verifierMode: LhtbVerifierMode;
  verifierImage: string;
  agentNetwork: LhtbNetwork;
  verifierNetwork: LhtbNetwork;
  cpus: number;
  memoryMb: number;
  storageMb: number;
  agentTimeoutSec: number;
  continueUntilTimeout: boolean;
  verifierCpus: number;
  verifierMemoryMb: number;
  verifierTimeoutSec: number;
  verifierBuildTimeoutSec: number;
  source: {
    repository: string;
    commit: string;
    taskId: string;
    sourceHash: string;
    files: Record<string, string>;
    solutionFiles: Record<string, string>;
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`lhtb: invalid ${label}`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`lhtb: invalid ${label}`);
  return value;
}

function positive(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`lhtb: invalid ${label}`);
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`lhtb: invalid ${label}`);
  return value;
}

function sha256Hex(value: unknown, label: string): string {
  const text = String(value);
  if (!/^[0-9a-f]{64}$/.test(text)) throw new Error(`lhtb: invalid ${label}`);
  return text;
}

function beneath(root: string, path: string): string {
  const destination = resolve(root, path);
  const rel = relative(root, destination);
  if (isAbsolute(path) || rel === '' || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
    throw new Error(`lhtb: path escapes import: ${path}`);
  }
  let cursor = root;
  for (const component of rel.split('/')) {
    cursor = join(cursor, component);
    if (lstatSync(cursor).isSymbolicLink()) throw new Error(`lhtb: symlink forbidden: ${path}`);
  }
  return destination;
}

function fileNames(root: string, prefix = ''): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`lhtb: symlink forbidden: ${name}`);
    return entry.isDirectory() ? fileNames(root, name) : [name];
  }).sort();
}

/** Recheck immediately before execution as well as at adapter load. */
export function verifyLhtbFiles(environment: LhtbEnvironment): void {
  const expected = Object.keys(environment.source.files).sort();
  if (JSON.stringify(fileNames(environment.taskDirectory)) !== JSON.stringify(expected)) {
    throw new Error(`lhtb: imported task file set changed: ${environment.source.taskId}`);
  }
  for (const name of expected) {
    const path = beneath(environment.taskDirectory, name);
    const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (actual !== environment.source.files[name]) throw new Error(`lhtb: SHA256 mismatch: ${name}`);
  }
  // The importer never materializes solution/; if one appeared, a scored agent
  // container built from this directory could read the reference answer.
  if (expected.some((name) => name.startsWith('solution/'))) {
    throw new Error(`lhtb: reference solution present in the agent-visible import: ${environment.source.taskId}`);
  }
}

/**
 * Container paths of the declared artifacts, absolute under /app. task.toml
 * writes some entries relative (`outputs/x.csv`) and some absolute
 * (`/app/src`); both mean the same place.
 */
export function lhtbArtifactPaths(environment: LhtbEnvironment): string[] {
  return environment.artifacts.map((entry) => {
    const path = entry.startsWith('/') ? entry : `/app/${entry}`;
    if (!path.startsWith('/app/')) throw new Error(`lhtb: artifact outside /app: ${entry}`);
    if (path.split('/').includes('..')) throw new Error(`lhtb: artifact path contains '..': ${entry}`);
    return path;
  });
}

export const lhtbAdapter: Adapter = {
  id: LHTB_ID,
  load(directory: string): Scenario[] {
    const root = resolve(directory);
    const manifest = record(JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')), 'manifest');
    if (manifest.schemaVersion !== 1 || manifest.benchmark !== LHTB_ID || !Array.isArray(manifest.tasks) || manifest.tasks.length === 0) {
      throw new Error('lhtb: expected a nonempty pinned manifest; run eval/scripts/import-lhtb.py');
    }
    const source = record(manifest.source, 'source');
    if (source.repository !== LHTB_REPOSITORY || !/^[0-9a-f]{40}$/.test(String(source.commit))) {
      throw new Error('lhtb: official repository and an immutable 40-character commit are required');
    }
    const ids = new Set<string>();
    return manifest.tasks.map((raw): Scenario => {
      const task = record(raw, 'task');
      const id = string(task.id, 'task id');
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id) || ids.has(id)) throw new Error(`lhtb: invalid/duplicate task id: ${id}`);
      ids.add(id);
      if (task.taskDirectory !== `tasks/${id}`) throw new Error(`lhtb: noncanonical task directory: ${id}`);
      const taskDirectory = beneath(root, task.taskDirectory);
      const verifierMode = task.verifierMode === 'shared' || task.verifierMode === 'separate'
        ? task.verifierMode
        : (() => { throw new Error(`lhtb: invalid verifier mode: ${id}`); })();
      const artifacts = Array.isArray(task.artifacts) && task.artifacts.length > 0
        ? task.artifacts.map((entry, index) => string(entry, `artifacts[${index}] of ${id}`))
        : (() => { throw new Error(`lhtb: task ${id} declares no artifacts; the submission contract is missing`); })();
      const files: Record<string, string> = {};
      for (const [name, hash] of Object.entries(record(task.files, 'files'))) {
        if (!(name === 'task.toml' || name === 'instruction.md' || name.startsWith('environment/') || name.startsWith('tests/'))) {
          throw new Error(`lhtb: unexpected task file: ${name}`);
        }
        files[name] = sha256Hex(hash, `file hash: ${name}`);
      }
      for (const required of ['task.toml', 'instruction.md', 'environment/Dockerfile', 'tests/test.sh']) {
        if (!(required in files)) throw new Error(`lhtb: missing required task file: ${required}`);
      }
      const solutionFiles: Record<string, string> = {};
      for (const [name, hash] of Object.entries(record(task.solutionFiles, 'solutionFiles'))) {
        if (!name.startsWith('solution/')) throw new Error(`lhtb: non-solution entry in solutionFiles: ${name}`);
        solutionFiles[name] = sha256Hex(hash, `solution hash: ${name}`);
      }
      if (!('solution/solve.sh' in solutionFiles)) throw new Error(`lhtb: no reference solution recorded for ${id}`);
      const environment: LhtbEnvironment = {
        kind: 'lhtb', taskDirectory, image: string(task.image, 'image'), artifacts, verifierMode,
        verifierImage: string(task.verifierImage, 'verifier image'),
        agentNetwork: boolean(task.allowInternet, 'allow_internet') ? 'bridge' : 'none',
        verifierNetwork: boolean(task.verifierAllowInternet, 'verifier allow_internet') ? 'bridge' : 'none',
        cpus: positive(task.cpus, 'cpus'), memoryMb: positive(task.memoryMb, 'memory'),
        storageMb: positive(task.storageMb, 'storage'),
        agentTimeoutSec: positive(task.agentTimeoutSec, 'agent timeout'),
        continueUntilTimeout: boolean(task.continueUntilTimeout, 'continue_until_timeout'),
        verifierCpus: positive(task.verifierCpus, 'verifier cpus'),
        verifierMemoryMb: positive(task.verifierMemoryMb, 'verifier memory'),
        verifierTimeoutSec: positive(task.verifierTimeoutSec, 'verifier timeout'),
        verifierBuildTimeoutSec: positive(task.verifierBuildTimeoutSec, 'verifier build timeout'),
        source: {
          repository: LHTB_REPOSITORY, commit: String(source.commit), taskId: id,
          sourceHash: sha256Hex(task.sourceHash, `source hash of ${id}`), files, solutionFiles,
        },
      };
      verifyLhtbFiles(environment);
      const instruction = readFileSync(join(taskDirectory, 'instruction.md'), 'utf8');
      if (sha256Hex(task.instructionSha256, `instruction hash of ${id}`) !== createHash('sha256').update(instruction).digest('hex')) {
        throw new Error(`lhtb: instruction.md does not match its pinned hash: ${id}`);
      }
      return {
        id, benchmark: LHTB_ID,
        // The artifact list is part of the agent-facing prompt: LHTB grades
        // files on disk, so an agent that never writes them scores 0 no matter
        // what it reports.
        task: `${instruction}\n\n## Submission contract\n\nThe verifier reads these paths from the container filesystem. Nothing you say counts; only these files.\n\n${artifacts.map((path) => `- ${path}`).join('\n')}\n`,
        judge: { kind: 'lhtb' }, environment,
        meta: {
          provenance: environment.source, publicBenchmark: true,
          name: task.name, description: task.description, difficulty: task.difficulty,
          category: task.category, expertTimeEstimateMin: task.expertTimeEstimateMin,
          artifacts, allowInternet: task.allowInternet, continueUntilTimeout: environment.continueUntilTimeout,
          agentTimeoutSec: environment.agentTimeoutSec,
        },
      };
    });
  },
};
