/**
 * §9.1 fan-out. Everything here exists to keep the merge reproducible and the
 * query un-failable:
 *
 *  - `available()` is probed exactly ONCE, at init, and the result is cached.
 *    Probes shell out and read config; re-probing per query would put that on
 *    the model's critical path, and a provider does not appear mid-session.
 *  - providers run CONCURRENTLY but are collected in registration order via
 *    `allSettled` — §9.1's merge must not depend on settle order.
 *  - a provider that throws or times out becomes `MergeResult.unavailable` and
 *    is dropped. It never fails the query (§18 last row).
 *
 * The registry constructs nothing: every provider — including the vector one it
 * knows nothing about — is injected, which is what keeps L3 out of this file.
 */
import type { Candidate, Content, MergeResult, RetrievalProvider, SearchQuery } from '../contracts/index.js';
import { mergeCandidates, type ProviderOutcome } from './merge.js';

const DEFAULT_PROBE_TIMEOUT_MS = 3_000;
const DEFAULT_SEARCH_TIMEOUT_MS = 20_000;

export interface ProviderRegistryOptions {
  probeTimeoutMs?: number;
  searchTimeoutMs?: number;
}

/**
 * A hung provider must not hold the whole fan-out. `Promise.race` also attaches
 * a handler to `work`, so a late rejection is not an unhandled one.
 */
async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${String(ms)}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class ProviderRegistry {
  private readonly providers: readonly RetrievalProvider[];
  private readonly probeTimeoutMs: number;
  private readonly searchTimeoutMs: number;
  /** Memoized, so concurrent first queries share one probe round. */
  private probe: Promise<ReadonlySet<string>> | null = null;

  constructor(providers: readonly RetrievalProvider[], options: ProviderRegistryOptions = {}) {
    this.providers = [...providers];
    this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.searchTimeoutMs = options.searchTimeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS;
  }

  /** Ids that passed the capability probe. Idempotent — probes once, ever. */
  async init(): Promise<ReadonlySet<string>> {
    this.probe ??= this.runProbe();
    return this.probe;
  }

  async search(query: SearchQuery): Promise<MergeResult> {
    const availableIds = await this.init();
    const settled = await Promise.allSettled(
      // An `async` wrapper turns a provider's *synchronous* throw into a
      // rejection; without it one rogue provider would break the whole map.
      this.providers.map(async (provider) => {
        if (!availableIds.has(provider.id)) return null;
        return withTimeout(provider.search(query), this.searchTimeoutMs, `${provider.id}.search`);
      }),
    );

    const outcomes: ProviderOutcome[] = this.providers.map((provider, index) => {
      const result = settled[index];
      if (result === undefined || result.status === 'rejected' || result.value === null) {
        return { provider: provider.id, tier: provider.tier, candidates: [], unavailable: true };
      }
      return { provider: provider.id, tier: provider.tier, candidates: result.value };
    });

    return mergeCandidates(outcomes, query);
  }

  /**
   * Routes `context_fetch` back to the provider that produced the candidate.
   * Availability is deliberately not re-checked: hydration usually just reads a
   * file, which still works when the provider's own binary has gone missing.
   */
  async hydrate(ref: Candidate): Promise<Content> {
    const provider = this.providers.find((candidate) => candidate.id === ref.provider);
    if (provider === undefined) throw new Error(`no registered provider for candidate: ${ref.provider}`);
    return provider.hydrate(ref);
  }

  private async runProbe(): Promise<ReadonlySet<string>> {
    const settled = await Promise.allSettled(
      this.providers.map(async (provider) =>
        withTimeout(provider.available(), this.probeTimeoutMs, `${provider.id}.available`),
      ),
    );
    const ok = new Set<string>();
    for (const [index, result] of settled.entries()) {
      const provider = this.providers[index];
      if (provider === undefined) continue;
      if (result.status === 'fulfilled' && result.value) ok.add(provider.id);
    }
    return ok;
  }
}
