/**
 * Shared `hydrate` body for the providers whose candidates are real file
 * coordinates (graft, Serena, grep, and Augment when it returns no snippet).
 *
 * One place, because one rule matters: a `Candidate` round-trips through the
 * model — `context_search` hands it out and `context_fetch` hands it back (§9) —
 * so its `path` is untrusted input and must be proven to live under the repo
 * root before anything opens it.
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Candidate, Content } from '../contracts/index.js';

/** Cap on hydrated text; a wider span comes back `truncated: true`. */
export const DEFAULT_HYDRATE_MAX_CHARS = 64 * 1024;

/**
 * Resolves `candidatePath` under `cwd`, or null when it escapes. Null rather
 * than a throw because the two callers differ: `hydrate` must refuse loudly,
 * while a bad `scope` hint on a search should just narrow to the repo root.
 */
export function containedPath(cwd: string, candidatePath: string): string | null {
  const absolute = resolve(cwd, candidatePath);
  const rel = relative(cwd, absolute);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return absolute;
}

export async function readFileSpan(
  provider: string,
  ref: Candidate,
  cwd: string,
  maxChars: number = DEFAULT_HYDRATE_MAX_CHARS,
): Promise<Content> {
  if (ref.path === undefined || ref.path === '') {
    throw new Error(`${provider}: cannot hydrate a candidate with no path`);
  }
  const absolute = containedPath(cwd, ref.path);
  if (absolute === null) {
    throw new Error(`${provider}: refusing to read outside the repo root: ${ref.path}`);
  }

  const lines = (await readFile(absolute, 'utf8')).split('\n');
  const start = Math.min(Math.max(1, ref.span?.start_line ?? 1), Math.max(1, lines.length));
  const end = Math.max(start, Math.min(lines.length, ref.span?.end_line ?? lines.length));
  const text = lines.slice(start - 1, end).join('\n');
  // Clamping a span to EOF is not truncation — the file simply ends there.
  // Only the byte cap loses content the caller asked for.
  const truncated = text.length > maxChars;
  return {
    text: truncated ? text.slice(0, maxChars) : text,
    path: ref.path,
    span: { start_line: start, end_line: end },
    provider,
    truncated,
  };
}
