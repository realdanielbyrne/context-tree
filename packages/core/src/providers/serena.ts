/**
 * §9.1 `SerenaProvider` (tier `structural`) — Serena's LSP-backed symbol tools
 * (`find_symbol`, `find_referencing_symbols`) over MCP.
 *
 * **Wiring a real Serena client is the host's job.** Serena is not installed
 * here and context-tree takes no MCP client dependency, so this provider talks
 * to an injected `SerenaClient`. With no client injected `available()` is false
 * and nothing else runs: §18's last row wants a missing language server to
 * degrade tier-by-tier, and declaring a capability we cannot exercise would be
 * worse than declaring it absent.
 *
 * Result shapes vary across Serena versions, so the normalizer accepts the MCP
 * text-content envelope or a bare array and *skips* entries it cannot read
 * instead of throwing — an unreadable entry is a lost hit, not a failed query.
 */
import type { Candidate, Content, ProviderTier, RetrievalProvider, SearchQuery } from '../contracts/index.js';
import { readFileSpan } from './hydrate.js';

/** The minimal MCP surface this provider needs. Injected, never constructed. */
export interface SerenaClient {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstString(source: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

function firstNumber(source: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

/** MCP wraps tool results as `{ content: [{ type: 'text', text: '<json>' }] }`. */
function unwrap(raw: unknown): unknown[] {
  if (isRecord(raw) && Array.isArray(raw.content)) {
    const entries: unknown[] = [];
    for (const part of raw.content) {
      const text = isRecord(part) ? part.text : undefined;
      if (typeof text !== 'string') continue;
      try {
        const parsed: unknown = JSON.parse(text);
        entries.push(...(Array.isArray(parsed) ? parsed : [parsed]));
      } catch {
        // Prose, not JSON. Serena narrates on some paths; there is no
        // coordinate to recover, so drop it rather than guess at one.
      }
    }
    return entries;
  }
  if (Array.isArray(raw)) return raw;
  if (isRecord(raw) && Array.isArray(raw.symbols)) return raw.symbols;
  return isRecord(raw) ? [raw] : [];
}

function readSpan(entry: Record<string, unknown>): { start_line: number; end_line: number } | undefined {
  const nested = [entry.body_location, entry.location, entry.range].find(isRecord);
  const source = nested ?? entry;
  const start = firstNumber(source, ['start_line', 'startLine', 'line']);
  if (start === undefined) return undefined;
  const end = firstNumber(source, ['end_line', 'endLine']) ?? start;
  return { start_line: start, end_line: Math.max(start, end) };
}

function toCandidates(raw: unknown, provider: string, tier: ProviderTier): Candidate[] {
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  for (const entry of unwrap(raw)) {
    if (!isRecord(entry)) continue;
    const path = firstString(entry, ['relative_path', 'path', 'file']);
    const symbol = firstString(entry, ['name_path', 'name', 'symbol']);
    if (path === undefined && symbol === undefined) continue;
    const span = readSpan(entry);

    const key = `${path ?? ''}:${span?.start_line ?? ''}-${span?.end_line ?? ''}:${symbol ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);

    candidates.push({
      ...(path === undefined ? {} : { path }),
      ...(span === undefined ? {} : { span }),
      ...(symbol === undefined ? {} : { symbol }),
      // The language server's order is its ranking; see graft.ts for why 1/rank.
      score: 1 / (candidates.length + 1),
      provider,
      tier,
    });
  }
  return candidates;
}

export interface SerenaProviderOptions {
  /** A *connected* client. Absent = provider unavailable, by design. */
  client?: SerenaClient;
  /** Repo root, for `hydrate` — LSP coordinates are plain file coordinates. */
  cwd?: string;
}

export class SerenaProvider implements RetrievalProvider {
  readonly id = 'serena';
  readonly tier: ProviderTier = 'structural';
  private readonly client: SerenaClient | null;
  private readonly cwd: string;

  constructor(options: SerenaProviderOptions = {}) {
    this.client = options.client ?? null;
    this.cwd = options.cwd ?? process.cwd();
  }

  async available(): Promise<boolean> {
    // Presence is the probe. There is no version tool we could call without
    // guessing at Serena's schema, and a guessed call is not a capability test.
    return this.client !== null;
  }

  async search(query: SearchQuery): Promise<Candidate[]> {
    const raw = await this.call('find_symbol', {
      name_path: query.query,
      ...(query.scope === undefined ? {} : { relative_path: query.scope }),
    });
    return toCandidates(raw, this.id, this.tier);
  }

  /** `find_referencing_symbols` — Serena's half of §9.1 blast radius. */
  async referencingSymbols(symbol: string, relativePath?: string): Promise<Candidate[]> {
    const raw = await this.call('find_referencing_symbols', {
      name_path: symbol,
      ...(relativePath === undefined ? {} : { relative_path: relativePath }),
    });
    return toCandidates(raw, this.id, this.tier);
  }

  /**
   * Reads from disk rather than through another Serena tool: an LSP hit is a
   * `path` plus a line span, so hydration needs no capability we would have to
   * invent a schema for.
   */
  hydrate(ref: Candidate): Promise<Content> {
    return readFileSpan(this.id, ref, this.cwd);
  }

  private async call(tool: string, args: Record<string, unknown>): Promise<unknown> {
    const client = this.client;
    if (client === null) throw new Error('serena: no client injected — the host must wire one');
    return client.callTool(tool, args);
  }
}
