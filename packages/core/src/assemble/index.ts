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
  ZONE_FRACTIONS,
  deriveZoneBudgets,
  replyAllowance,
  replyHeadroom,
  zoneBRemainder,
  type ZoneBudgets,
} from './budgets.js';
export {
  ARGS_CAP_WITH_BLOB,
  elision,
  renderActiveHeader,
  renderActiveMap,
  renderEvent,
  renderLinksBlock,
  renderSummaryBlock,
  renderTailBlock,
  safeCut,
  truncateToTokens,
} from './format.js';
