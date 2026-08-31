/**
 * L2 — content-addressed payload store (plan §6, D8): `blobs/<first2>/<rest62>`.
 *
 * Structural sharing is the point: identical content hashes to the same ref,
 * so it is stored once and referenced from as many L0 events / L1 spans as
 * need it. Because L1/L3/L4 are deterministic functions of L0+L2 (D8), a
 * missing or corrupted blob is not a degradable condition — it means a
 * derived layer points at content that was never durably written, so `get`
 * and friends throw loud rather than returning empty (plan Rule: fail loud).
 */
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { BlobStore } from '../contracts/blobs.js';
import type { BlobRef } from '../contracts/ids.js';
import { BlobMissingError } from '../contracts/errors.js';

/** A ref is a bare SHA-256 hex digest — never build a path from anything else. */
const REF_PATTERN = /^[0-9a-f]{64}$/;

function assertRef(ref: string): asserts ref is BlobRef {
  if (!REF_PATTERN.test(ref)) {
    // Rejecting here — rather than in pathFor's caller — is what stops a
    // traversal-shaped string (e.g. "../../etc/passwd") from ever reaching
    // a filesystem call built from it.
    throw new Error(`invalid blob ref: ${JSON.stringify(ref)}`);
  }
}

function sha256(content: string | Uint8Array): BlobRef {
  return createHash('sha256').update(content).digest('hex');
}

export class FsBlobStore implements BlobStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
    mkdirSync(root, { recursive: true });
  }

  digest(content: string | Uint8Array): BlobRef {
    return sha256(content);
  }

  pathFor(ref: BlobRef): string {
    assertRef(ref);
    return join(this.root, ref.slice(0, 2), ref.slice(2));
  }

  has(ref: BlobRef): boolean {
    return existsSync(this.pathFor(ref));
  }

  put(content: string | Uint8Array): BlobRef {
    const ref = sha256(content);
    const dest = this.pathFor(ref);
    if (existsSync(dest)) return ref; // write-once: identical content is never rewritten.

    const dir = join(this.root, ref.slice(0, 2));
    mkdirSync(dir, { recursive: true });

    // Atomic write: a crash mid-write must never leave a partial file at the
    // final path — under content addressing a half-written blob is otherwise
    // indistinguishable from a good one. Temp file lives in the same
    // directory so renameSync is same-filesystem (atomic on POSIX).
    const tmp = join(dir, `.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
    writeFileSync(tmp, content);
    try {
      renameSync(tmp, dest);
    } catch (error) {
      // Another writer raced us to the same content (same hash => same
      // bytes), and it wrote first — dest already has a valid store-once
      // copy of exactly this content, so ours can be discarded.
      if (existsSync(dest)) {
        unlinkSync(tmp);
      } else {
        throw error;
      }
    }
    return ref;
  }

  get(ref: BlobRef): Uint8Array {
    const path = this.pathFor(ref);
    if (!existsSync(path)) throw new BlobMissingError(ref);
    const fd = openSync(path, 'r');
    try {
      const size = statSync(path).size;
      const buf = Buffer.alloc(size);
      readSync(fd, buf, 0, size, 0);
      return buf;
    } finally {
      closeSync(fd);
    }
  }

  getText(ref: BlobRef): string {
    return Buffer.from(this.get(ref)).toString('utf8');
  }

  getTextPrefix(ref: BlobRef, maxBytes: number): string {
    const path = this.pathFor(ref);
    if (!existsSync(path)) throw new BlobMissingError(ref);
    const fd = openSync(path, 'r');
    try {
      // §9 context_peek is "one small call, not a full expansion" — read via
      // a file handle capped at maxBytes so a multi-MB tool output blob never
      // gets fully paged into memory just to preview it.
      const size = Math.min(maxBytes, statSync(path).size);
      const buf = Buffer.alloc(size);
      const bytesRead = readSync(fd, buf, 0, size, 0);
      return buf.subarray(0, bytesRead).toString('utf8');
    } finally {
      closeSync(fd);
    }
  }

  size(ref: BlobRef): number {
    const path = this.pathFor(ref);
    if (!existsSync(path)) throw new BlobMissingError(ref);
    return statSync(path).size;
  }
}
