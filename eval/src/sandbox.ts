/**
 * The per-run sandbox: a temp directory with the scenario's files materialized,
 * a shell runner with a hard timeout, and cleanup. Every benchmark's agent work
 * and every judge command happens inside one of these — nothing the harness
 * writes ever lands in the repo.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Scenario } from './types.js';

export interface CommandOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface Sandbox {
  readonly path: string;
  run(command: string, timeoutMs: number): Promise<CommandOutcome>;
  readFile(relPath: string): string;
  writeFile(relPath: string, content: string): void;
  cleanup(): void;
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
