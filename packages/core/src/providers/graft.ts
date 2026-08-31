/**
 * §9.1 `GraftProvider` (tier `structural`). graft already owns the code graph;
 * this provider only translates a `SearchQuery` into the right subcommand and
 * graft's `path:Lstart-Lend` output back into `Candidate` coordinates. D13's
 * ranked-vs-exhaustive split *is* graft's own ask-vs-grep split, so the mapping
 * needs no heuristic.
 *
 * `search` is allowed to throw; the registry converts that into
 * `MergeResult.unavailable` (§18 last row). `available()` never throws, per the
 * `RetrievalProvider` contract.
 */
import type { Candidate, Content, ProviderTier, RetrievalProvider, SearchQuery } from '../contracts/index.js';
import { readFileSpan } from './hydrate.js';
import { execFileRunner, type CommandRunner } from './shell.js';

const DEFAULT_TIMEOUT_MS = 20_000;
/** Short on purpose: a probe is on the startup path, so it must fail fast. */
const DEFAULT_PROBE_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;
const PROBE_MAX_BUFFER = 64 * 1024;

/**
 * A hit carries `<path>:L<start>-L<end>`, sometimes behind graft's `covers:`
 * label. The leading alternation is the whole trick: it anchors the path to a
 * line start, a ` · ` column separator or a `(`, so a *source* line in graft's
 * inlined snippet that happens to mention `foo.ts:12` is not read as a hit.
 */
const HIT = /(?:^|·\s*|\(\s*|covers:\s*)([A-Za-z0-9_@./+-]+\.[A-Za-z0-9_]+):L?(\d+)(?:\s*[-–]\s*L?(\d+))?/;
/** `1. resolveConfig · function  [symbol]` — the span is on the following line. */
const RANKED_HEADER = /^\d+\.\s+([A-Za-z_$][\w$]*)\s*·/;
/** `resolveConfig · function · path:L1-L2` (`graft grep`). */
const SAME_LINE_SYMBOL = /^([A-Za-z_$][\w$]*)\s*·/;
/** `calls ← loadConfig (path:L1-L2)` (`graft callers`). */
const CALLER_SYMBOL = /←\s*([A-Za-z_$][\w$]*)/;

/**
 * graft's output order *is* its ranking, and `Candidate.score` is documented as
 * provider-local, so 1/rank preserves the order without inventing a number that
 * looks cross-provider comparable.
 */
function parseGraftHits(stdout: string, provider: string, tier: ProviderTier): Candidate[] {
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  let pendingSymbol: string | undefined;

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    const header = RANKED_HEADER.exec(line);
    if (header !== null) {
      pendingSymbol = header[1];
      continue;
    }
    const hit = HIT.exec(line);
    const path = hit?.[1];
    const startText = hit?.[2];
    if (path === undefined || startText === undefined) continue;

    const startLine = Number(startText);
    const endText = hit?.[3];
    const endLine = Math.max(startLine, endText === undefined ? startLine : Number(endText));
    // graft repeats a span across sections (a symbol header and then its
    // in-edges); a provider must not report the same coordinate twice.
    const key = `${path}:${startLine}-${endLine}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const symbol = SAME_LINE_SYMBOL.exec(line)?.[1] ?? CALLER_SYMBOL.exec(line)?.[1] ?? pendingSymbol;
    candidates.push({
      path,
      span: { start_line: startLine, end_line: endLine },
      ...(symbol === undefined ? {} : { symbol }),
      score: 1 / (candidates.length + 1),
      provider,
      tier,
    });
  }
  return candidates;
}

export interface GraftProviderOptions {
  /** Repo root graft runs in. */
  cwd?: string;
  bin?: string;
  run?: CommandRunner;
  timeoutMs?: number;
  probeTimeoutMs?: number;
  maxBuffer?: number;
}

export class GraftProvider implements RetrievalProvider {
  readonly id = 'graft';
  readonly tier: ProviderTier = 'structural';
  private readonly cwd: string;
  private readonly bin: string;
  private readonly run: CommandRunner;
  private readonly timeoutMs: number;
  private readonly probeTimeoutMs: number;
  private readonly maxBuffer: number;

  constructor(options: GraftProviderOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.bin = options.bin ?? 'graft';
    this.run = options.run ?? execFileRunner;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
  }

  async available(): Promise<boolean> {
    try {
      const result = await this.run(this.bin, ['--version'], {
        cwd: this.cwd,
        timeoutMs: this.probeTimeoutMs,
        maxBuffer: PROBE_MAX_BUFFER,
      });
      return result.exitCode === 0 && !result.timedOut;
    } catch {
      // The contract says a probe never throws: an un-runnable binary is a
      // capability answer, not an error.
      return false;
    }
  }

  async search(query: SearchQuery): Promise<Candidate[]> {
    if (query.mode === 'exhaustive') {
      // `graft grep` is the complete sweep; `ask` is top-N and would miss hits.
      return this.exec(['grep', query.query]);
    }
    return this.exec([
      'ask',
      query.query,
      '--source',
      ...(query.scope === undefined ? [] : ['--in', query.scope]),
    ]);
  }

  /**
   * `graft callers <symbol>` — blast radius (§9.1). Outside `RetrievalProvider`
   * because `SearchQuery` has no edge-direction field; the retrieval facade
   * reaches for it directly when a caller asks "who depends on this".
   */
  async callers(symbol: string): Promise<Candidate[]> {
    return this.exec(['callers', symbol]);
  }

  hydrate(ref: Candidate): Promise<Content> {
    return readFileSpan(this.id, ref, this.cwd);
  }

  private async exec(args: readonly string[]): Promise<Candidate[]> {
    const result = await this.run(this.bin, args, {
      cwd: this.cwd,
      timeoutMs: this.timeoutMs,
      maxBuffer: this.maxBuffer,
    });
    if (result.timedOut) throw new Error(`graft ${args[0]} timed out after ${this.timeoutMs}ms`);
    if (result.spawnCode !== undefined) throw new Error(`graft is not runnable (${result.spawnCode})`);
    // graft exits non-zero for "no answer", which is a valid empty result.
    // Only a non-zero exit that also produced nothing is a real failure.
    if (result.exitCode !== 0 && result.stdout.trim() === '') {
      throw new Error(
        `graft ${args[0]} failed (exit ${String(result.exitCode)}): ${result.stderr.trim().slice(0, 200)}`,
      );
    }
    return parseGraftHits(result.stdout, this.id, this.tier);
  }
}
