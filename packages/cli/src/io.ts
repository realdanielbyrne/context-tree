/**
 * The CLI's output contract: human output on stdout, diagnostics on stderr,
 * and `--json` means exactly one JSON document on stdout and nothing else — so
 * a caller can pipe any reporting command into `jq` without filtering prose.
 *
 * Injected rather than called directly on `process` so every command is
 * testable by calling it, not by spawning a subprocess.
 */
export interface Io {
  out(line: string): void;
  err(line: string): void;
}

export const processIo: Io = {
  out(line: string): void {
    process.stdout.write(`${line}\n`);
  },
  err(line: string): void {
    process.stderr.write(`${line}\n`);
  },
};

/** Emits either the JSON payload or the human lines — never both. */
export function report(
  io: Io,
  json: boolean | undefined,
  payload: unknown,
  lines: readonly string[],
): void {
  if (json === true) {
    io.out(JSON.stringify(payload, null, 2));
    return;
  }
  for (const line of lines) io.out(line);
}
