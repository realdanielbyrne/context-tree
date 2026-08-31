import { loadApiKeys } from '@context-tree/core';

/**
 * A failure the user caused or must decide about (a missing store, a refused
 * overwrite, no API key). Carries the process exit code so `run()` never has to
 * guess one, and is reported as a single stderr line rather than a stack trace.
 */
export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

/**
 * §11 keeps API keys in the environment only, which means a provider SDK error
 * can quote a request that carried one. No command may print a secret — not
 * even inside an error — so every message crosses this on its way to stderr.
 */
export function scrubSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let scrubbed = text;
  for (const key of Object.values(loadApiKeys(env))) {
    // Short values would match innocuous substrings; a real key is never short.
    if (key !== undefined && key.length >= 8) scrubbed = scrubbed.split(key).join('[redacted]');
  }
  return scrubbed;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
