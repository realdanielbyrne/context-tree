/**
 * §7 segmentation (D1). `segment()` is the only entry point; the key helpers
 * are exported because the `NodeKey` scheme is a contract with `ingest/`, which
 * maps keys to ULIDs.
 */
export { segment, type SegmentOptions } from './segment.js';
export { TASK_KEY, fileKey, phaseKey } from './keys.js';
export { deriveTurns, turnIdAt, type Turn } from './turns.js';
export { bagOf, bagCosine, cutsOf, driftCuts, tilingCuts, type Cuts } from './boundary.js';
export { covarianceScores, type CovarianceParams } from './score.js';
export { foldsFrom, parseSummaryBlob, replaySummaries, stubFoldId, summaryFoldId, writeSummary, type Fold, type Ledger } from './ledger.js';
export { blocksOf, type Block, type BlockKind } from './blocks.js';
export { outputTag, stubOf, tailOf, thinkingTag, type FoldReasoning, type Stub, type StubParams, type StubPart } from './stubs.js';
export { foldView, shownTokens, type BlockState, type FoldTexts, type StubBlob } from './view.js';
export {
  GRAVITY_EPSILON, adaptKappa, distanceOf, irrelevanceOf, massOf, planDeletions, planGravity, pullOf,
  type BlockFoldState, type Breakpoints, type DeletePlan, type GravityBlock, type GravityInput, type GravityPlan, type GravitySummary, type GravityUnit, type KappaSignals,
} from './gravity.js';
