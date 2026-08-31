/**
 * Identifier and coordinate primitives shared by every layer.
 *
 * L1 stores *coordinates*, not content (plan §6): a node's content is the L0
 * `seq` range it covers, and payloads live in L2 behind a `BlobRef`.
 */

/** Monotonic L0 event ordinal. Strictly increasing, gap-free within a trace. */
export type Seq = number;

/** SHA-256 hex digest of an L2 payload. 64 lowercase hex chars. */
export type BlobRef = string;

/** L1 node id: `n_` + ULID. ULIDs sort lexicographically by creation time. */
export type NodeId = string;

/** Inclusive L0 range a node covers. */
export interface SeqSpan {
  start: Seq;
  end: Seq;
}
