/**
 * Loads the workspace-root `.env` (model keys, Langfuse credentials) without
 * clobbering variables already set in the environment. Node 22 ships
 * `process.loadEnvFile`, but it throws on a missing file and its override
 * semantics are not the "existing environment wins" rule a harness wants —
 * a manual parse gives both in one testable place.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Parses dotenv-shaped text: `KEY=value`, `#` comments, optional `export`, quotes stripped. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const withoutExport = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    let value = withoutExport.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
    if (quoted && value.length >= 2) value = value.slice(1, -1);
    if (key !== '') out[key] = value;
  }
  return out;
}

/**
 * Walks up from `startDir` to the filesystem root and loads the first `.env`
 * found into `process.env`, never overriding a variable that is already set.
 */
export function loadWorkspaceEnv(startDir: string = dirname(fileURLToPath(import.meta.url))): void {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      const parsed = parseEnvFile(readFileSync(candidate, 'utf8'));
      for (const [key, value] of Object.entries(parsed)) {
        if (process.env[key] === undefined) process.env[key] = value;
      }
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}
