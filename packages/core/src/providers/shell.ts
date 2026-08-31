/**
 * §9.1 provider subprocesses. Two rules here, both load-bearing:
 *
 *  - `execFile` with an ARGUMENT ARRAY. Never `exec`, never a shell string.
 *    Provider queries originate from a model, so a query that reaches a shell
 *    is a command-injection hole; argv keeps `; rm -rf /` a search term.
 *  - every spawn carries a timeout and a maxBuffer. A provider that hangs or
 *    floods stdout must become *unavailable* (§18 last row) — not a crash, and
 *    not an unbounded buffer in the agent's hot path.
 */
import { execFile } from 'node:child_process';

export interface CommandOptions {
  cwd: string;
  timeoutMs: number;
  maxBuffer: number;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  /** Numeric exit status, or null when the process never got to exit. */
  exitCode: number | null;
  timedOut: boolean;
  /** Spawn-level failure code — `ENOENT` is how "tool not installed" arrives. */
  spawnCode?: string;
}

/**
 * The seam every shelling provider takes as an option, so a test can record
 * argv without the real binary on PATH (and without a real subprocess).
 */
export type CommandRunner = (
  file: string,
  args: readonly string[],
  options: CommandOptions,
) => Promise<CommandResult>;

type SpawnFailure = Error & { code?: number | string; killed?: boolean; signal?: string | null };

/**
 * Resolves rather than rejects: a non-zero exit is normal for these tools (`rg`
 * exits 1 on no matches, graft exits non-zero on an empty answer), so the
 * caller — not the runner — decides what counts as a failure.
 */
export const execFileRunner: CommandRunner = (file, args, options) =>
  new Promise<CommandResult>((settle) => {
    execFile(
      file,
      [...args],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer,
        encoding: 'utf8',
        // Explicit even though it is the default: `shell: false` is the entire
        // reason a model-authored query is safe to pass through as argv.
        shell: false,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const failure = error as SpawnFailure | null;
        settle({
          stdout,
          stderr,
          exitCode: failure === null ? 0 : typeof failure.code === 'number' ? failure.code : null,
          // `killed` plus a signal is how execFile reports its own timeout kill.
          timedOut: failure?.killed === true && typeof failure.signal === 'string',
          ...(typeof failure?.code === 'string' ? { spawnCode: failure.code } : {}),
        });
      },
    );
  });
