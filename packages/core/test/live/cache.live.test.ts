/**
 * LIVE, opt-in (§17): the only test that can prove D5 rather than assert it.
 *
 * §10 rule 5 says to emit a cache breakpoint at the Zone A/B boundary, and D5
 * says the frozen prefix is what makes the whole layout pay for itself. Every
 * other test in this repo can only check that we *set* a field. This one checks
 * that the provider honoured it — and the counterfactual checks that removing
 * the breakpoint really does lose the caching, which is what makes this a
 * regression detector instead of a green light.
 *
 * Costs a few cents. Run with:
 *   LIVE=1 npx vitest run packages/core/test/live
 */
import { describe, expect, it } from 'vitest';
import { loadApiKeys, loadDotEnv } from '../../src/config.js';
import { AnthropicProvider, InMemoryCostMeter, MeteredProvider } from '../../src/models/index.js';
import { systemContract } from '../../src/prompts/index.js';

loadDotEnv();
const keys = loadApiKeys();
const enabled = Boolean(process.env.LIVE) && Boolean(keys.anthropic);

/**
 * A nonce per run, because a cached prefix survives ~5 minutes on Anthropic's
 * side. Reusing fixed padding makes the FIRST call of a re-run a cache hit, so
 * the "did it write?" assertion fails for a reason that has nothing to do with
 * the code under test. The nonce is the one place non-determinism belongs here.
 */
const RUN_NONCE = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** Anthropic will not cache a prefix below its minimum, so pad past it. */
function paddedSystem(marker: string): string {
  return `${systemContract()}\n\nRUN ${RUN_NONCE} ${marker}\n${`FILLER CONTEXT LINE.\n`.repeat(400)}`;
}

const MODEL = process.env.LIVE_ANTHROPIC_MODEL ?? 'claude-sonnet-4-5-20250929';

describe.skipIf(!enabled)('live: Anthropic prompt caching honours the Zone A breakpoint', () => {
  it('writes the frozen prefix to cache, then reads it back instead of re-sending it', async () => {
    const meter = new InMemoryCostMeter({ capUsd: 1 });
    const provider = new MeteredProvider(new AnthropicProvider({ apiKey: keys.anthropic! }), meter);
    const req = {
      model: MODEL,
      system: paddedSystem('marked'),
      systemCacheBreakpoint: true,
      messages: [{ role: 'user' as const, content: 'Reply with the single word OK.' }],
      maxTokens: 16,
    };

    const first = await provider.complete(req);
    const second = await provider.complete(req);

    // cacheWrite === 0 on the first call means the breakpoint never reached the
    // provider; cacheRead === 0 on the second means it did not stick.
    expect(first.usage.cacheWrite).toBeGreaterThan(0);
    expect(second.usage.cacheRead).toBeGreaterThan(0);
    // The cached prefix must be the bulk of the input, not a token or two of it.
    expect(second.usage.cacheRead).toBeGreaterThan(second.usage.input);
  }, 120_000);

  it('caches nothing without the breakpoint, which is what makes the assertion above meaningful', async () => {
    const meter = new InMemoryCostMeter({ capUsd: 1 });
    const provider = new MeteredProvider(new AnthropicProvider({ apiKey: keys.anthropic! }), meter);
    // Same shape, breakpoint omitted. A distinct marker keeps this off the
    // other test's cache entry, so a hit here would be a real leak.
    const req = {
      model: MODEL,
      system: paddedSystem('unmarked'),
      messages: [{ role: 'user' as const, content: 'Reply with the single word OK.' }],
      maxTokens: 16,
    };

    const first = await provider.complete(req);
    const second = await provider.complete(req);

    expect(first.usage.cacheWrite).toBe(0);
    expect(second.usage.cacheRead).toBe(0);
    // And the prefix is billed as fresh input every time, which is the cost D5 avoids.
    expect(second.usage.input).toBeGreaterThan(1_000);
  }, 120_000);
});

describe.skipIf(enabled)('live suite guard', () => {
  it('skips without LIVE=1 and a key, so CI never needs a secret (§17)', () => {
    expect(enabled).toBe(false);
  });
});
