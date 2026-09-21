/**
 * §10 prompt assembly — the flex-buffer layout. A frozen head (system + steering +
 * all user prompts) → a creation-order flex buffer of units (evicted to a soft
 * floor) → a tail appended after it. `assembleFlex` builds it; `buildFlexSource`
 * sources it from the store; `toMessages`/`toCompletionRequest` project it to a
 * provider request.
 */
export {
  assembleFlex,
  unitSignals,
  toMessages,
  toCompletionRequest,
  DEFAULT_SOFT_TARGET_FRAC,
  DEFAULT_ANCHOR,
  DEFAULT_PRIORITY_HALFLIFE,
  type FlexUnit,
  type FlexHead,
  type FlexAssembleOptions,
  type Representation,
  type CompletionRequestOptions,
} from './flex.js';
export {
  mapFlexUnits,
  buildFlexSource,
  readNodeText,
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
  representUnits,
  perUnitBudget,
  tokensUnder,
  KEEP,
  type Disposition,
  type AssembleUnit,
  type AssembleParams,
} from './represent.js';
export {
  planRetention,
  type ProtectionMode,
  type RetentionUnit,
  type RetentionParams,
  type RetentionPlan,
} from './retention.js';
export { replyAllowance, replyHeadroom, REPLY_WINDOW_FRACTION } from './budgets.js';
export {
  reduceChunk,
  reduceSummarize,
  resolveReducer,
  DEFAULT_REDUCER,
  type Reducer,
  type ReducerName,
  type ReduceInput,
  type ReduceContext,
} from './reduce.js';
export {
  ARGS_CAP_WITH_BLOB,
  elision,
  renderEvent,
  renderLinksBlock,
  renderSummaryBlock,
  renderTailBlock,
  safeCut,
  truncateToTokens,
} from './format.js';
