/**
 * §8 summarization engine (D2, D11) + the D4 invalidation cascade.
 *
 * Leaves on the cheap model from raw L0+L2 detail, one root call over the leaf
 * summaries on the strong model, path-scoped staleness on append. Providers
 * arrive as the §11 `ModelProvider`/`CostMeter` interfaces, so nothing here
 * knows whether the model is mocked, recorded or live.
 */
export {
  Summarizer,
  type SummarizeOutcome,
  type SummarizeRole,
  type SummarizerOptions,
} from './summarizer.js';
export { branchFacts, renderBranchDetail, type BranchFacts, type DetailSources } from './detail.js';
export {
  contractViolation,
  parseSummaryReply,
  summaryMetaFrom,
  type ContractExpectation,
} from './contract.js';
