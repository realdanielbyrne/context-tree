/** Datacurve DEEPSWE v1.1, imported from an immutable official Git commit. */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { Adapter, Scenario } from '../types.js';

export const DEEPSWE_ID = 'deepswe';
export const DEEPSWE_REPOSITORY = 'https://github.com/datacurve-ai/deep-swe';

export interface DeepSweEnvironment {
  kind: 'deepswe';
  taskDirectory: string;
  image: string;
  baseCommit: string;
  collect: readonly { command: string; timeoutSec: number }[];
  verifierTimeoutSec: number;
  verifierBuildTimeoutSec: number;
  agentNetwork: 'none';
  verifierNetwork: 'none';
  cpus: number;
  memoryMb: number;
  verifierCpus: number;
  verifierMemoryMb: number;
  source: { repository: string; commit: string; archiveSha256: string; taskId: string; files: Record<string, string> };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`deepswe: invalid ${label}`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`deepswe: invalid ${label}`);
  return value;
}

function positive(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`deepswe: invalid ${label}`);
  return value;
}

function beneath(root: string, path: string): string {
  const destination = resolve(root, path);
  const rel = relative(root, destination);
  if (isAbsolute(path) || rel === '' || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
    throw new Error(`deepswe: path escapes import: ${path}`);
  }
  let cursor = root;
  for (const component of rel.split('/')) {
    cursor = join(cursor, component);
    if (lstatSync(cursor).isSymbolicLink()) throw new Error(`deepswe: symlink forbidden: ${path}`);
  }
  return destination;
}

function fileNames(root: string, prefix = ''): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`deepswe: symlink forbidden: ${name}`);
    return entry.isDirectory() ? fileNames(root, name) : [name];
  }).sort();
}

/** Recheck immediately before execution as well as at adapter load. */
export function verifyDeepSweFiles(environment: DeepSweEnvironment): void {
  const expected = Object.keys(environment.source.files).sort();
  if (JSON.stringify(fileNames(environment.taskDirectory)) !== JSON.stringify(expected)) {
    throw new Error(`deepswe: imported task file set changed: ${environment.source.taskId}`);
  }
  for (const name of expected) {
    const path = beneath(environment.taskDirectory, name);
    const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (actual !== environment.source.files[name]) throw new Error(`deepswe: SHA256 mismatch: ${name}`);
  }
}

export function deepSweVerifierImage(environment: DeepSweEnvironment): string {
  const fingerprint = createHash('sha256').update(JSON.stringify(environment.source)).digest('hex').slice(0, 24);
  return `context-tree-deepswe-verifier:${fingerprint}`;
}

export const deepSweAdapter: Adapter = {
  id: DEEPSWE_ID,
  load(directory: string): Scenario[] {
    const root = resolve(directory);
    const manifest = record(JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')), 'manifest');
    if (manifest.schemaVersion !== 1 || manifest.benchmark !== DEEPSWE_ID || !Array.isArray(manifest.tasks) || manifest.tasks.length === 0) {
      throw new Error('deepswe: expected a nonempty pinned manifest; run eval/scripts/import-deepswe.py');
    }
    const source = record(manifest.source, 'source');
    if (source.repository !== DEEPSWE_REPOSITORY || !/^[0-9a-f]{40}$/.test(String(source.commit)) || !/^[0-9a-f]{64}$/.test(String(source.archiveSha256))) {
      throw new Error('deepswe: official repository, immutable commit and archive SHA256 required');
    }
    const ids = new Set<string>();
    return manifest.tasks.map((raw): Scenario => {
      const task = record(raw, 'task');
      const id = string(task.id, 'task id');
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id) || ids.has(id)) throw new Error(`deepswe: invalid/duplicate task id: ${id}`);
      ids.add(id);
      if (task.taskDirectory !== `tasks/${id}`) throw new Error(`deepswe: noncanonical task directory: ${id}`);
      const taskDirectory = beneath(root, task.taskDirectory);
      if (task.agentNetwork !== 'none' || task.verifierNetwork !== 'none') throw new Error('deepswe: unsupported network policy');
      const baseCommit = string(task.baseCommit, 'base commit');
      if (!/^[0-9a-f]{7,40}$/.test(baseCommit)) throw new Error('deepswe: official task commit required');
      const files: Record<string, string> = {};
      for (const [name, hash] of Object.entries(record(task.files, 'files'))) {
        if (!/^[0-9a-f]{64}$/.test(String(hash))) throw new Error(`deepswe: invalid file hash: ${name}`);
        if (!(name === 'task.toml' || name === 'instruction.md' || name.startsWith('environment/') || name.startsWith('tests/'))) {
          throw new Error(`deepswe: unexpected task file: ${name}`);
        }
        files[name] = String(hash);
      }
      for (const required of ['task.toml', 'instruction.md', 'environment/Dockerfile', 'tests/Dockerfile', 'tests/test.sh', 'tests/grader.py', 'tests/config.json', 'tests/test.patch']) {
        if (!(required in files)) throw new Error(`deepswe: missing required task file: ${required}`);
      }
      if (!Array.isArray(task.collect) || task.collect.length !== 1) throw new Error('deepswe: exactly one official patch collection hook required');
      const collect = task.collect.map((rawHook) => {
        const hook = record(rawHook, 'collect hook');
        const command = string(hook.command, 'collect command');
        if (!command.includes(`git diff --binary ${baseCommit} HEAD > /logs/artifacts/model.patch`)) throw new Error('deepswe: unsupported committed-patch collection');
        return { command, timeoutSec: positive(hook.timeoutSec, 'collect timeout') };
      });
      const environment: DeepSweEnvironment = {
        kind: 'deepswe', taskDirectory, image: string(task.image, 'image'), baseCommit, collect,
        verifierTimeoutSec: positive(task.verifierTimeoutSec, 'verifier timeout'),
        verifierBuildTimeoutSec: positive(task.verifierBuildTimeoutSec, 'verifier build timeout'),
        agentNetwork: 'none', verifierNetwork: 'none',
        cpus: positive(task.cpus, 'cpus'), memoryMb: positive(task.memoryMb, 'memory'),
        verifierCpus: positive(task.verifierCpus, 'verifier cpus'), verifierMemoryMb: positive(task.verifierMemoryMb, 'verifier memory'),
        source: { repository: DEEPSWE_REPOSITORY, commit: String(source.commit), archiveSha256: String(source.archiveSha256), taskId: id, files },
      };
      verifyDeepSweFiles(environment);
      return {
        id, benchmark: DEEPSWE_ID, task: readFileSync(join(taskDirectory, 'instruction.md'), 'utf8'),
        judge: { kind: 'deepswe' }, environment,
        meta: { provenance: environment.source, repository: task.repositoryUrl, language: task.language, publicBenchmark: true },
      };
    });
  },
};
