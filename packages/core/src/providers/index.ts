/**
 * ⚠️ NEVER-COMPARED — not on the canonical retrieval path. This fixed-order
 * `structural → fuzzy → grep` `RetrievalProvider` stack (D13/§9.1) is a design
 * decision that was NEVER A/B'd against the RRF ensemble (`retrieve/ensemble.ts`)
 * and has zero production callers (`reports/metrics/harness-deletion-and-hypothesis-register-report.md`).
 * It is neither settled-canon nor tested-and-lost — kept as the structural-retrieval
 * hypothesis pending an actual comparison. Do not treat it as the retriever.
 *
 * §9.1 retrieval backends (D13). context-tree does not reimplement code
 * semantics — it orchestrates the tools that already do, behind one interface
 * and one deterministic merge.
 */
export { AugmentProvider, type AugmentFetch, type AugmentProviderOptions } from './augment.js';
export { GraftProvider, type GraftProviderOptions } from './graft.js';
export { GrepProvider, type GrepProviderOptions } from './grep.js';
export { SerenaProvider, type SerenaClient, type SerenaProviderOptions } from './serena.js';
export { DEFAULT_HYDRATE_MAX_CHARS, containedPath, readFileSpan } from './hydrate.js';
export { mergeCandidates, tierOrderFor, type ProviderOutcome } from './merge.js';
export { ProviderRegistry, type ProviderRegistryOptions } from './registry.js';
export { execFileRunner, type CommandOptions, type CommandResult, type CommandRunner } from './shell.js';
