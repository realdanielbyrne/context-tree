/**
 * §11 / §16 cost meter. §16 caps per-PR spend through this object, so its one
 * hard requirement is that no call can be accounted as free: a model absent
 * from the price table is charged the most expensive first-party tier and is
 * listed by `unpricedModels()`, because a silently-free model defeats the cap
 * more completely than a wrong rate ever could.
 */
import type {
  CompletionRequest,
  CompletionResult,
  CostEntry,
  CostMeter,
  CostSnapshot,
  ModelProvider,
  TokenUsage,
} from '../contracts/index.js';
import { CostCapExceededError, EmptyCompletionError } from '../contracts/index.js';

/** USD per 1M tokens. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Keyed by model-id **prefix**; the longest matching prefix wins. */
export type PriceTable = Readonly<Record<string, ModelPrice>>;

export const ZERO_USAGE: TokenUsage = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
});

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

/** Anthropic cache rates are fixed multiples of the input rate (0.1x / 1.25x). */
function tier(input: number, output: number): ModelPrice {
  return { input, output, cacheRead: input * 0.1, cacheWrite: input * 1.25 };
}

/**
 * Prefixes, not exact ids, so a dated snapshot (`claude-haiku-4-5-20251001`)
 * and an OpenRouter id (`anthropic/claude-haiku-4-5`) both price correctly
 * without a table edit per release.
 */
export const DEFAULT_PRICES: PriceTable = Object.freeze({
  'claude-fable': tier(10, 50),
  'claude-mythos': tier(10, 50),
  'claude-opus': tier(5, 25),
  'claude-sonnet-5': tier(2, 10),
  'claude-sonnet': tier(3, 15),
  'claude-haiku': tier(1, 5),
  // OpenRouter catalog rates (2026-09-01). Cache-read on these providers is
  // published at 0.2x input, not Anthropic's 0.1x; cache-write is unpublished
  // except qwen3.7-flash, so the Anthropic 1.25x multiple stands in — the
  // OpenRouter provider reports cacheWrite as 0, so the rate only guards a
  // future provider that starts reporting it (never free, per the §16 rule).
  // qwen3.7-flash has tiered overrides above 32k prompt tokens; base tier here.
  // Verified against OpenRouter's own /api/v1/models on 2026-09-02, not
  // transcribed from a catalog page. Three rows had drifted: deepseek's input
  // was 16% low, glm's cache-write was invented (the provider publishes 0), and
  // qwen-2.5-72b's cache-read was 0.036 against a published 0. The meter
  // enforces the §16 spend cap, so a wrong rate here is a wrong cap.
  //
  // A `cacheWrite` of 0 is what the provider publishes, not an unknown: these
  // endpoints do not bill a cache write. `qwen/qwen-2.5-72b-instruct` is the
  // only row with a real 32,768-token window — every flash model below has a
  // million-token window, so for them W is a budget the harness imposes rather
  // than a wall the provider enforces.
  'z-ai/glm-5.3-flash': { input: 0.075, output: 0.25, cacheRead: 0.015, cacheWrite: 0 },
  'deepseek/deepseek-v4-flash': { input: 0.0855, output: 0.1711, cacheRead: 0.0171, cacheWrite: 0 },
  'qwen/qwen3.7-flash': { input: 0.03, output: 0.13, cacheRead: 0.006, cacheWrite: 0.038 },
  'qwen/qwen-2.5-72b-instruct': { input: 0.36, output: 0.4, cacheRead: 0, cacheWrite: 0 },
  'google/gemini-3.7-flash': { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.0417 },
  'openai/gpt-3.5-turbo': { input: 0.5, output: 1.5, cacheRead: 0.05, cacheWrite: 0.625 },
  'openai/gpt-4o-mini': { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0 },
  'openai/gpt-4.1-mini': { input: 0.4, output: 1.6, cacheRead: 0.1, cacheWrite: 0 },
  'openai/gpt-5-mini': { input: 0.25, output: 2.0, cacheRead: 0.05, cacheWrite: 0 },
  'anthropic/claude-sonnet-4': tier(3, 15),
  // Embeddings have no output/cache tokens; an embedding call reports only
  // `input`, so those three rates are irrelevant but must still be present —
  // `ModelPrice` has no optional fields, and a partial price is a silent gap
  // in the §16 cap the moment a caller's usage shape ever includes them.
  'text-embedding-3-small': { input: 0.02, output: 0, cacheRead: 0, cacheWrite: 0 },
});

/**
 * Rate for a model no prefix matches. Deliberately the priciest tier: an
 * unknown model must make the §16 cap tighter, never looser.
 */
export const FALLBACK_PRICE: ModelPrice = Object.freeze(tier(10, 50));

export interface PriceMatch {
  price: ModelPrice;
  /** The prefix that matched, or `null` when the fallback rate was used. */
  matched: string | null;
}

export function priceFor(model: string, prices: PriceTable = DEFAULT_PRICES): PriceMatch {
  const direct = longestPrefixMatch(model, prices);
  if (direct) return direct;
  // OpenRouter ids are `vendor/model`; one table serves both providers.
  const slash = model.lastIndexOf('/');
  if (slash >= 0) {
    const bare = longestPrefixMatch(model.slice(slash + 1), prices);
    if (bare) return bare;
  }
  return { price: FALLBACK_PRICE, matched: null };
}

function longestPrefixMatch(model: string, prices: PriceTable): PriceMatch | null {
  let best: PriceMatch | null = null;
  for (const [prefix, price] of Object.entries(prices)) {
    if (!model.startsWith(prefix)) continue;
    if (best === null || prefix.length > (best.matched?.length ?? 0)) {
      best = { price, matched: prefix };
    }
  }
  return best;
}

export function usdFor(usage: TokenUsage, price: ModelPrice): number {
  return (
    (usage.input * price.input +
      usage.output * price.output +
      usage.cacheRead * price.cacheRead +
      usage.cacheWrite * price.cacheWrite) /
    1_000_000
  );
}

export interface CostMeterOptions {
  /** null disables the cap (mirrors `ContextTreeConfig.costCapUsd`). */
  capUsd?: number | null;
  prices?: PriceTable;
}

/** Missing flags preserve compatibility with providers returning valid TokenUsage. */
export function hasKnownUsage(result: Pick<CompletionResult, 'usage' | 'usageKnown'>): boolean {
  return result.usageKnown !== false && result.usage != null
    && [result.usage.input, result.usage.output, result.usage.cacheRead, result.usage.cacheWrite]
      .every((count) => Number.isSafeInteger(count) && count >= 0);
}

export class InMemoryCostMeter implements CostMeter {
  private readonly totals = new Map<string, { calls: number; usage: TokenUsage }>();
  private readonly unpriced = new Set<string>();
  private readonly capUsd: number | null;
  private readonly prices: PriceTable;

  constructor(options: CostMeterOptions = {}) {
    this.capUsd = options.capUsd ?? null;
    this.prices = options.prices ?? DEFAULT_PRICES;
  }

  record(model: string, usage: TokenUsage): void {
    if (!hasKnownUsage({ usage })) throw new RangeError('cost meter requires known nonnegative integer usage');
    const current = this.totals.get(model) ?? { calls: 0, usage: ZERO_USAGE };
    this.totals.set(model, { calls: current.calls + 1, usage: addUsage(current.usage, usage) });
    if (priceFor(model, this.prices).matched === null) this.unpriced.add(model);
  }

  /** Entries in first-recorded order, so a snapshot diff is stable. */
  snapshot(): CostSnapshot {
    const entries: CostEntry[] = [];
    for (const [model, total] of this.totals) {
      const price = priceFor(model, this.prices);
      entries.push({
        model,
        calls: total.calls,
        usage: total.usage,
        usd: usdFor(total.usage, price.price),
        priceMatched: price.matched,
      });
    }
    return {
      entries,
      totalUsd: entries.reduce((sum, entry) => sum + entry.usd, 0),
      capUsd: this.capUsd,
    };
  }

  totalUsd(): number {
    return this.snapshot().totalUsd;
  }

  /**
   * Refuses at the cap, not past it: at exactly the cap the budget is spent, so
   * the next call would overshoot and there is nothing left to authorize.
   */
  assertUnderCap(): void {
    if (this.capUsd === null) return;
    const spent = this.totalUsd();
    if (spent >= this.capUsd) throw new CostCapExceededError(spent, this.capUsd);
  }

  /** Models charged the fallback rate — the audit trail for a table gap. */
  unpricedModels(): string[] {
    return [...this.unpriced];
  }
}

/**
 * Records usage and enforces the cap around any provider, so no call site has
 * to remember to do it. The cap check runs *after* the call: the spend already
 * happened, and the point is to stop the next one.
 */
export class MeteredProvider implements ModelProvider {
  readonly id: string;
  /** Mirrors the inner provider's capability — a decorator must not hide it. */
  embed?: (texts: readonly string[], model: string) => Promise<Float32Array[]>;

  constructor(
    private readonly inner: ModelProvider,
    private readonly meter: CostMeter,
  ) {
    this.id = `metered:${inner.id}`;
    const innerEmbed = inner.embed;
    if (innerEmbed) this.embed = (texts, model) => innerEmbed.call(inner, texts, model);
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    let result: CompletionResult;
    try {
      result = await this.inner.complete(request);
    } catch (error) {
      if (error instanceof EmptyCompletionError && error.usageKnown && hasKnownUsage(error.result)) {
        this.meter.record(error.result.model, error.result.usage);
        this.meter.assertUnderCap();
      }
      throw error;
    }
    if (hasKnownUsage(result)) this.meter.record(result.model, result.usage);
    else result = { ...result, usageKnown: false };
    this.meter.assertUnderCap();
    return result;
  }
}
