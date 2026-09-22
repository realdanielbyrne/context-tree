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
