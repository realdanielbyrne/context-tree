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
// Current (flex-buffer) assembler — replaces ZoneAssembler; see flex.ts provenance.
export {
  assembleFlex,
  DEFAULT_SOFT_TARGET_FRAC,
  DEFAULT_ANCHOR,
  DEFAULT_PRIORITY_HALFLIFE,
  type FlexUnit,
  type FlexHead,
  type FlexAssembleOptions,
  type Representation,
} from './flex.js';
export {
  mapFlexUnits,
  buildFlexSource,
  type FlexEntry,
  type MapFlexOptions,
  type FlexSourceDeps,
  type FlexSourceOptions,
  type FlexSource,
} from './flex-store.js';
export {
  scoreUnits,
  planEviction,
  minMaxNormalize,
  DEFAULT_EVICTION_WEIGHTS,
  type EvictionSignals,
  type EvictionWeights,
  type EvictionCandidate,
  type EvictionPlan,
} from './eviction.js';
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
