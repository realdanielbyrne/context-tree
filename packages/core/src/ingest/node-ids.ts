/**
 * Node ids minted from the §7 `NodeKey` instead of from a clock and an RNG.
 *
 * WHY (D8). L1 is always a deterministic function of L0 + L2 — but L0 *names
 * L1 nodes*: a `manual_annotation` (§9's `annotate`) carries the `node_id` its
 * note and its `node_links` edge belong to. While ids were per-run ULIDs, that
 * reference pointed at nothing once `rebuild()` deleted and re-derived L1, so
 * the plan's own "rebuild instead of migrate" workflow silently discarded every
 * annotation, and L1 depended on runtime write history no replay reproduces.
 * Minting the id from the key fixes that at the root: a key is a coordinate
 * (phase ordinal, file path) and a pure function of L0 (D1), so the id is one
 * too. §6's rule that L1 stores coordinates now covers identity as well.
 *
 * Both halves of the shape are load-bearing:
 *  - 26 Crockford-base32 characters keep §6's `n_<ulid>` shape for everything
 *    that pattern-matches or sizes an id;
 *  - the first character is the node's *kind* rank, because `ORDER_CREATION`
 *    breaks a `span_start_seq` tie with the id (Ruling C4) and a phase shares
 *    its start seq with the file node that opened it. task < phase < file keeps
 *    the parent ahead of its child there, which is the order Zone B is emitted
 *    in (§10 rule 1) — a reordered prefix is a cache miss, not a cosmetic diff.
 */
import { createHash } from 'node:crypto';
import type { NodeId, NodeKey, NodeKind, TraceEvent } from '../contracts/index.js';
import { serializeTraceEvent } from '../trace/index.js';

/** Mints the id for a §7 node. Same key + same trace => same id, always. */
export type NodeIdMinter = (key: NodeKey, kind: NodeKind) => NodeId;

/** ULID's alphabet: base32 minus I, L, O, U. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** The `ORDER_CREATION` tie-break: a parent must sort ahead of a child that shares its start seq. */
const KIND_RANK: Readonly<Record<NodeKind, number>> = { task: 0, phase: 1, file: 2, turn: 3 };

/** 25 characters × 5 bits = 125 bits of digest, which is ULID's entropy budget. */
const DIGEST_CHARS = 25;

/**
 * Salts the key with the first L0 event, so two *different* tasks do not mint
 * the same id for `phase:0`: node ids stay unique the way a ULID was, without
 * being unique per *run*. The first event is the earliest thing that is both
 * session-specific and immutable (L0 is append-only), so every later append and
 * every rebuild of that trace salts identically.
 */
export function nodeIdMinter(events: readonly TraceEvent[]): NodeIdMinter {
  const first = events[0];
  const salt = first === undefined ? '' : serializeTraceEvent(first);
  return (key, kind) => `n_${CROCKFORD[KIND_RANK[kind]] ?? '0'}${digest(salt, key)}`;
}

function digest(salt: string, key: NodeKey): string {
  // NUL-separated: without it, `salt + key` could be produced by two different
  // (salt, key) pairs, which is a collision the whole scheme is here to avoid.
  const bytes = createHash('sha256').update(salt).update('\u0000').update(key).digest();
  let out = '';
  for (let i = 0; i < DIGEST_CHARS; i += 1) out += CROCKFORD[(bytes[i] ?? 0) & 31];
  return out;
}
