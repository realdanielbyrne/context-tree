/**
 * §9.1 `AugmentProvider` (tier `fuzzy`) — the Augment Context Engine over HTTP.
 *
 * Endpoint and token come from injected options or the environment
 * (`AUGMENT_API_URL`, `AUGMENT_API_TOKEN`), never from the config file (§11).
 * The endpoint is configured *whole* rather than assembled from a base URL: the
 * real path is deployment-specific here, and inventing one would produce a
 * provider that looks configured and always 404s.
 *
 * `available()` is configuration-only and MUST NOT touch the network. A probe
 * that dials out on every startup is both latency on a cold path and an
 * unrequested egress — §18 wants degradation, not phoning home.
 */
import type { Candidate, Content, ProviderTier, RetrievalProvider, SearchQuery } from '../contracts/index.js';
import { readFileSpan } from './hydrate.js';

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Structural subset of `fetch` — the global is assignable to it, so a host
 * passes nothing and a test passes a recorder.
 */
export type AugmentFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Accepts the shapes the Context Engine has shipped, and ignores the rest. */
function rows(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!isRecord(raw)) return [];
  for (const key of ['results', 'chunks', 'matches', 'items', 'blobs']) {
    const value = raw[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function str(source: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

function num(source: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function toCandidates(raw: unknown, provider: string, tier: ProviderTier): Candidate[] {
  const candidates: Candidate[] = [];
  for (const row of rows(raw)) {
    if (!isRecord(row)) continue;
    const path = str(row, ['path', 'relative_path', 'file', 'filePath']);
    if (path === undefined) continue;

    const range = [row.range, row.lines, row.span].find(isRecord) ?? row;
    const start = num(range, ['start_line', 'startLine', 'start', 'line']);
    const end = num(range, ['end_line', 'endLine', 'end']);
    const snippet = str(row, ['snippet', 'text', 'content', 'blob']);

    candidates.push({
      path,
      ...(start === undefined ? {} : { span: { start_line: start, end_line: Math.max(start, end ?? start) } }),
      ...(snippet === undefined ? {} : { snippet }),
      // Its own relevance score when it gives one; otherwise 1/rank, which
      // preserves the order Augment returned without faking a magnitude.
      score: num(row, ['score', 'relevance']) ?? 1 / (candidates.length + 1),
      provider,
      tier,
    });
  }
  return candidates;
}

export interface AugmentProviderOptions {
  apiUrl?: string;
  apiToken?: string;
  fetch?: AugmentFetch;
  /** Repo root, for hydrating a hit that came back without a snippet. */
  cwd?: string;
  timeoutMs?: number;
  /** Injected so a test never has to mutate `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export class AugmentProvider implements RetrievalProvider {
  readonly id = 'augment';
  readonly tier: ProviderTier = 'fuzzy';
  private readonly apiUrl: string | undefined;
  private readonly apiToken: string | undefined;
  private readonly fetchImpl: AugmentFetch;
  private readonly cwd: string;
  private readonly timeoutMs: number;

  constructor(options: AugmentProviderOptions = {}) {
    const env = options.env ?? process.env;
    this.apiUrl = options.apiUrl ?? env.AUGMENT_API_URL;
    this.apiToken = options.apiToken ?? env.AUGMENT_API_TOKEN;
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.cwd = options.cwd ?? process.cwd();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async available(): Promise<boolean> {
    return this.apiUrl !== undefined && this.apiUrl !== '' && this.apiToken !== undefined && this.apiToken !== '';
  }

  async search(query: SearchQuery): Promise<Candidate[]> {
    const url = this.apiUrl;
    const token = this.apiToken;
    if (url === undefined || url === '' || token === undefined || token === '') {
      throw new Error('augment: AUGMENT_API_URL / AUGMENT_API_TOKEN not configured');
    }
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      // Key order is fixed by this literal: the request body is part of what a
      // recorded-fixture test compares.
      body: JSON.stringify({
        query: query.query,
        mode: query.mode ?? 'ranked',
        limit: query.limit ?? null,
        scope: query.scope ?? null,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`augment: HTTP ${String(response.status)}`);
    return toCandidates(await response.json(), this.id, this.tier);
  }

  async hydrate(ref: Candidate): Promise<Content> {
    if (ref.snippet !== undefined && ref.snippet !== '') {
      // A snippet is by definition a window on the file, hence `truncated`.
      // Reusing it avoids a second network round trip for text we already have.
      return { text: ref.snippet, path: ref.path, span: ref.span, provider: this.id, truncated: true };
    }
    return readFileSpan(this.id, ref, this.cwd);
  }
}
