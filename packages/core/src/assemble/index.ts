/**
 * §10 prompt assembly (D5) — fixed zone layout, content migrates by lifecycle.
 * Zone A frozen, Zone B in creation order, Zone C rewritten each phase, tail
 * after Zone C and dropped at phase boundaries (D6).
 */
export {
  ZoneAssembler,
  toCompletionRequest,
  toMessages,
  type CompletionRequestOptions,
  type ZoneAssemblerDeps,
} from './assembler.js';
export {
  renderActiveHeader,
  renderActiveMap,
  renderEvent,
  renderLinksBlock,
  renderSummaryBlock,
  renderTailBlock,
  truncateToTokens,
} from './format.js';
