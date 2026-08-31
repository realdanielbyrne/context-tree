/**
 * §9.1 `GrepProvider` (tier `fallback`) — and the only provider that is
 * *always* available, which is what §18's last row leans on: whatever else is
 * missing, a query still returns something. So the ripgrep path has a
 * node-builtin twin (recursive walk + per-line match) used whenever `rg` is not
 * on PATH, is too slow, or errors.
 *
 * Authoritative in `exhaustive` mode (§9.1 merge rule 3): there completeness
 * beats a structural provider's ranking, and the merge puts this tier first.
 */
import { readFile, readdir } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import type { Candidate, Content, ProviderTier, RetrievalProvider, SearchQuery } from '../contracts/index.js';
import { containedPath, readFileSpan } from './hydrate.js';
import { execFileRunner, type CommandRunner } from './shell.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;
const DEFAULT_MAX_RESULTS = 200;
/** Walker-only guards; `rg` has its own. */
const DEFAULT_MAX_FILES = 5_000;
const DEFAULT_MAX_FILE_CHARS = 1024 * 1024;
const SNIPPET_CHARS = 240;
/** A NUL byte in decoded text is the classic binary tell. */
const NUL = String.fromCharCode(0);

const SKIP_DIRS: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.venv',
  'target',
  '.context-tree',
]);

/** Deny-list, not an allow-list: an allow-list would silently miss a language. */
const SKIP_EXT: ReadonlySet<string> = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.tgz', '.bz2',
  '.woff', '.woff2', '.ttf', '.eot', '.mp3', '.mp4', '.mov', '.wasm', '.node', '.so',
  '.dylib', '.dll', '.db', '.sqlite', '.bin',
]);

/**
 * Only `exhaustive` treats the query as a pattern — mirroring graft's own
 * grep — because in `ranked` mode a model's query is prose and a stray `(`
 * would be a syntax error rather than a search. An invalid pattern degrades to
 * a literal too: a model writes a broken regex often enough that throwing would
 * make the always-available provider unavailable.
 */
function compilePattern(query: SearchQuery): RegExp | null {
  if (query.mode !== 'exhaustive') return null;
  try {
    return new RegExp(query.query);
  } catch {
    return null;
  }
}

function snippetOf(line: string): string {
  const trimmed = line.trim();
  return trimmed.length > SNIPPET_CHARS ? trimmed.slice(0, SNIPPET_CHARS) : trimmed;
}

/** `rg --no-heading --with-filename --line-number` prints `path:line:text`. */
function parseRipgrep(
  stdout: string,
  provider: string,
  tier: ProviderTier,
  maxResults: number,
): Candidate[] {
  const candidates: Candidate[] = [];
  for (const line of stdout.split('\n')) {
    if (candidates.length >= maxResults) break;
    const firstColon = line.indexOf(':');
    if (firstColon <= 0) continue;
    const secondColon = line.indexOf(':', firstColon + 1);
    if (secondColon < 0) continue;
    const lineNumber = Number(line.slice(firstColon + 1, secondColon));
    if (!Number.isInteger(lineNumber) || lineNumber <= 0) continue;

    const path = line.slice(0, firstColon).replace(/^\.\//, '');
    candidates.push({
      path,
      span: { start_line: lineNumber, end_line: lineNumber },
      snippet: snippetOf(line.slice(secondColon + 1)),
      score: 1 / (candidates.length + 1),
      provider,
      tier,
    });
  }
  return candidates;
}

export interface GrepProviderOptions {
  cwd?: string;
  bin?: string;
  run?: CommandRunner;
  timeoutMs?: number;
  maxBuffer?: number;
  maxResults?: number;
}

export class GrepProvider implements RetrievalProvider {
  readonly id = 'grep';
  readonly tier: ProviderTier = 'fallback';
  private readonly cwd: string;
  private readonly bin: string;
  private readonly run: CommandRunner;
  private readonly timeoutMs: number;
  private readonly maxBuffer: number;
  private readonly maxResults: number;

  constructor(options: GrepProviderOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.bin = options.bin ?? 'rg';
    this.run = options.run ?? execFileRunner;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
    this.maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
  }

  async available(): Promise<boolean> {
    // Unconditional, per §9.1: GrepProvider and VectorProvider are the two the
    // rest of the system is allowed to assume. The `rg`-vs-walker choice is an
    // implementation detail of `search`, not a capability.
    return true;
  }

  async search(query: SearchQuery): Promise<Candidate[]> {
    if (query.query === '') return [];
    const pattern = compilePattern(query);
    return (await this.searchWithRipgrep(query, pattern)) ?? this.searchWithWalk(query, pattern);
  }

  hydrate(ref: Candidate): Promise<Content> {
    return readFileSpan(this.id, ref, this.cwd);
  }

  /** null = `rg` could not answer, so the caller falls back to the walker. */
  private async searchWithRipgrep(query: SearchQuery, pattern: RegExp | null): Promise<Candidate[] | null> {
    const scope = this.scopeArg(query);
    const args = [
      '--line-number',
      '--no-heading',
      '--with-filename',
      '--color',
      'never',
      ...(pattern === null ? ['--fixed-strings'] : []),
      // `--regexp` keeps the query in its own argv slot, so a query starting
      // with `-` is a search term and not a flag.
      '--regexp',
      query.query,
      ...(scope === null ? [] : ['--', scope]),
    ];

    let result;
    try {
      result = await this.run(this.bin, args, {
        cwd: this.cwd,
        timeoutMs: this.timeoutMs,
        maxBuffer: this.maxBuffer,
      });
    } catch {
      return null;
    }
    // exit 1 is "no matches", which is an answer. ENOENT (rg absent), a timeout
    // kill and exit 2 are not.
    if (result.spawnCode !== undefined || result.timedOut) return null;
    if (result.exitCode !== 0 && result.exitCode !== 1) return null;
    return parseRipgrep(result.stdout, this.id, this.tier, this.maxResults);
  }

  /**
   * Breadth-first over sorted directory entries: the walk order becomes the
   * candidate order, and §9.1's merge is only reproducible if each provider's
   * own output is.
   */
  private async searchWithWalk(query: SearchQuery, pattern: RegExp | null): Promise<Candidate[]> {
    const scope = this.scopeArg(query);
    const queue: string[] = [scope === null ? this.cwd : join(this.cwd, scope)];
    const candidates: Candidate[] = [];
    let filesRead = 0;

    while (queue.length > 0 && candidates.length < this.maxResults && filesRead < DEFAULT_MAX_FILES) {
      const dir = queue.shift();
      if (dir === undefined) break;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

      for (const entry of entries) {
        if (candidates.length >= this.maxResults || filesRead >= DEFAULT_MAX_FILES) break;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) queue.push(full);
          continue;
        }
        if (!entry.isFile() || SKIP_EXT.has(extname(entry.name).toLowerCase())) continue;

        let text: string;
        try {
          text = await readFile(full, 'utf8');
        } catch {
          continue;
        }
        filesRead++;
        if (text.length > DEFAULT_MAX_FILE_CHARS || text.includes(NUL)) continue;

        const rel = relative(this.cwd, full);
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (candidates.length >= this.maxResults) break;
          const line = lines[i];
          if (line === undefined) continue;
          const matched = pattern === null ? line.includes(query.query) : pattern.test(line);
          if (!matched) continue;
          candidates.push({
            path: rel,
            span: { start_line: i + 1, end_line: i + 1 },
            snippet: snippetOf(line),
            score: 1 / (candidates.length + 1),
            provider: this.id,
            tier: this.tier,
          });
        }
      }
    }
    return candidates;
  }

  /**
   * `scope` is model-supplied, so a `../` in it would search outside the repo.
   * An escaping scope narrows to the repo root instead of failing the query.
   */
  private scopeArg(query: SearchQuery): string | null {
    if (query.scope === undefined || query.scope === '' || query.scope === '.') return null;
    return containedPath(this.cwd, query.scope) === null ? null : query.scope;
  }
}
