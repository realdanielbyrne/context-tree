/**
 * Deterministic `NodeKey` scheme and human titles for §7 segmentation.
 *
 * D1 requires bit-identical output across runs, so keys are derived from
 * position and path only — no hashes, no timestamps, no ULIDs (`ingest/` mints
 * those). Keys are opaque to consumers: the three prefixes (`task`, `phase:`,
 * `file:`) cannot collide, and a file key is unique per (phase, path) pair,
 * which is exactly the reuse scope §7 asks for ("re-edits append spans to the
 * same file node").
 */
import { posix } from 'node:path';
import type { NodeKey, PhaseType } from '../contracts/index.js';

/** The single task root (§6: exactly one root per task DB). */
export const TASK_KEY: NodeKey = 'task';

/** `index` is the 0-based ordinal of the phase node in *open* order. */
export function phaseKey(index: number): NodeKey {
  return `phase:${index}`;
}

/** Scoped to the phase, so the same file edited in a later phase is a new node. */
export function fileKey(phaseIndex: number, path: string): NodeKey {
  return `file:${phaseIndex}:${path}`;
}

/** `ordinal` is the 1-based count of phases of this type, to keep titles distinct. */
export function phaseTitle(phase: PhaseType, ordinal: number): string {
  return ordinal <= 1 ? phase : `${phase} (${ordinal})`;
}

/** posix.basename, not platform basename: titles must not vary by host OS (D1). */
export function fileTitle(path: string): string {
  return posix.basename(path) || path;
}
