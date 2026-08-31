/** Error taxonomy. Every failure the plan names as non-fatal degrades instead. */

export class ContextTreeError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** L0 seq monotonicity or gap violation — the log's one hard invariant. */
export class TraceIntegrityError extends ContextTreeError {
  constructor(message: string) {
    super(message, 'E_TRACE_INTEGRITY');
  }
}

/** A referenced blob is absent from L2. */
export class BlobMissingError extends ContextTreeError {
  constructor(ref: string) {
    super(`blob not found: ${ref}`, 'E_BLOB_MISSING');
  }
}

/** An L1 invariant would be broken (two roots, cyclic parent, unknown node). */
export class StoreInvariantError extends ContextTreeError {
  constructor(message: string) {
    super(message, 'E_STORE_INVARIANT');
  }
}

/** The per-run spend cap was reached (§16). */
export class CostCapExceededError extends ContextTreeError {
  constructor(spentUsd: number, capUsd: number) {
    super(`cost cap exceeded: $${spentUsd.toFixed(4)} > $${capUsd.toFixed(4)}`, 'E_COST_CAP');
  }
}

/** A model call failed after exhausting retries. */
export class ModelCallError extends ContextTreeError {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message, 'E_MODEL_CALL');
  }
}

/** A model returned a summary that violates the §8 content contract. */
export class SummaryContractError extends ContextTreeError {
  constructor(message: string) {
    super(message, 'E_SUMMARY_CONTRACT');
  }
}

export class ConfigError extends ContextTreeError {
  constructor(message: string) {
    super(message, 'E_CONFIG');
  }
}
