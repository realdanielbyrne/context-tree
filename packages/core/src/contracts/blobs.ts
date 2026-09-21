/**
 * L2 — content-addressed payload store (plan §6): `blobs/<first2>/<sha256>`.
 * Write-once; identical content is stored once and referenced many times.
 */
import type { BlobRef } from './ids.js';

export interface BlobStore {
  /** Absolute path of the blobs root. */
  readonly root: string;
  /** Stores content, returning its digest. Idempotent. */
  put(content: string | Uint8Array): BlobRef;
  get(ref: BlobRef): Uint8Array;
  getText(ref: BlobRef): string;
  /** Reads at most `maxBytes` from the head of a blob — for `peek`. */
  getTextPrefix(ref: BlobRef, maxBytes: number): string;
  has(ref: BlobRef): boolean;
  size(ref: BlobRef): number;
  /** On-disk path for a ref. Does not assert existence. */
  pathFor(ref: BlobRef): string;
  /** Digest without storing — lets callers dedup before writing. */
  digest(content: string | Uint8Array): BlobRef;
}
