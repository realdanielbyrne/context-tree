/**
 * §17's cache assertion harness — a deterministic tokenizer plus a provider
 * cache simulator asserting exactly which prefix ranges survive each event
 * type. This is where D5 regressions surface, and essentially nowhere else.
 */
export {
  ANTHROPIC_PROFILE,
  EXACT_PREFIX_PROFILE,
  ProviderCacheSimulator,
  cacheReport,
  type CacheMatchPolicy,
  type CacheOutcome,
  type CacheProviderProfile,
  type CacheSegment,
  type CacheSessionReport,
  type ProviderCacheSimulatorOptions,
  type SegmentOutcome,
} from './simulator.js';
export {
  CacheAssertionError,
  assertPrefixStable,
  findPrefixDivergence,
  type PrefixDivergence,
  type PrefixDivergenceKind,
  type PrefixStabilityOptions,
} from './prefix.js';
