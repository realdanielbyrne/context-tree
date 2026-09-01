/**
 * §17's prefix assertion — the half of the cache harness that fails *readably*.
 *
 * D5's failure mode is silent. A relevance-ordered Zone B (§10 rule 1), a
 * summary rewritten in the middle of the prefix, a tail result spliced in ahead
 * of Zone C (rule 3) — none of these change what the model is told, so no
 * behavioural test notices. They change only what the provider can reuse, and
 * the session quietly costs several times more per turn.
 *
 * So this file exists to turn that into a thrown error, and the *diagnostic* is
 * the deliverable: "prefix changed" tells a reviewer nothing, while "block
 * B:summary:n_01H…:1 moved from position 5 to position 3 in zone B" names the
 * rule 1 violation outright.
 *
 * Growth at the END of the checked prefix is deliberately NOT an offense: §10
 * rule 2 is precisely that a new branch summary appends to the end of Zone B,
 * invalidating only the suffix Zone C rewrites anyway. An assertion that
 * demanded equal length would flag the one mutation the layout is designed
 * around.
 */
import { ContextTreeError, ZONES } from '../contracts/index.js';
import type { AssembledPrompt, PromptBlock, Zone } from '../contracts/index.js';

/** Thrown by the §17 harness: a cache invariant, not a runtime failure. */
export class CacheAssertionError extends ContextTreeError {
  constructor(
    message: string,
    readonly divergence?: PrefixDivergence,
  ) {
    super(message, 'E_CACHE_ASSERT');
  }
}

/**
 * How a block broke the prefix. The kinds are separated because they map to
 * different §10 rules: `position` is rule 1 (reordering), `content` is a
 * rewritten summary (D3's honest cost), `inserted`/`replaced` are a mid-prefix
 * splice, `removed` is a dropped summary (rule 4 degradation reaching too far
 * forward).
 */
export type PrefixDivergenceKind = 'content' | 'position' | 'inserted' | 'replaced' | 'removed';

export interface PrefixDivergence {
  /** Position in the checked prefix where the two prompts first disagree. */
  index: number;
  /** The offending block: the one now at `index`, or the one `after` lost. */
  blockId: string;
  zone: Zone;
  kind: PrefixDivergenceKind;
  /** Where `blockId` sat in `before` — set only for `position`. */
  previousIndex?: number;
  /** The other block involved: displaced by `blockId`, or the one that slid up. */
  displacedBlockId?: string;
  /** One-line explanation; reused verbatim as the thrown message. */
  detail: string;
}

export interface PrefixStabilityOptions {
  /** Every block up to and including this zone must survive unchanged. */
  throughZone: Zone;
}

/**
 * The leading run of blocks belonging to `throughZone` or an earlier one.
 *
 * Reading a *leading run* rather than filtering by zone is what makes zone
 * interleaving detectable: a Zone B block emitted after Zone C started falls
 * outside the prefix, so the two prompts' prefixes differ in length and the
 * assertion fires instead of silently comparing a reshuffled subset.
 */
function prefixThrough(prompt: AssembledPrompt, throughZone: Zone): PromptBlock[] {
  const limit = ZONES.indexOf(throughZone);
  const blocks: PromptBlock[] = [];
  for (const block of prompt.blocks) {
    if (ZONES.indexOf(block.zone) > limit) break;
    blocks.push(block);
  }
  return blocks;
}

/** First point of disagreement in the checked prefix, or null when it is intact. */
export function findPrefixDivergence(
  before: AssembledPrompt,
  after: AssembledPrompt,
  options: PrefixStabilityOptions,
): PrefixDivergence | null {
  const { throughZone } = options;
  const oldBlocks = prefixThrough(before, throughZone);
  const newBlocks = prefixThrough(after, throughZone);
  const oldIds = oldBlocks.map((block) => block.id);
  const newIds = newBlocks.map((block) => block.id);

  for (let i = 0; i < oldBlocks.length; i += 1) {
    const old = oldBlocks[i];
    if (old === undefined) break;
    const next = newBlocks[i];

    if (next === undefined) {
      return {
        index: i,
        blockId: old.id,
        zone: old.zone,
        kind: 'removed',
        detail:
          `block ${old.id} (zone ${old.zone}) disappeared from position ${i}; ` +
          `the prefix through zone ${throughZone} may only grow at its end (§10 rule 2)`,
      };
    }

    if (next.id === old.id) {
      if (next.text === old.text) continue;
      return {
        index: i,
        blockId: old.id,
        zone: old.zone,
        kind: 'content',
        detail:
          `block ${old.id} (zone ${old.zone}) changed content in place at position ${i}: ` +
          describeTextChange(old.text, next.text),
      };
    }

    // Two independent questions decide the diagnosis: did the block that used to
    // sit here survive anywhere in the new prefix, and did the block that took
    // its place exist in the old one? The 2x2 is exhaustive, and each cell maps
    // to a different §10 rule, so naming the wrong one sends a reviewer to the
    // wrong rule.
    const arrivedFrom = oldIds.indexOf(next.id);
    const survivesAt = newIds.indexOf(old.id);

    if (survivesAt === -1) {
      if (arrivedFrom === -1) {
        return {
          index: i,
          blockId: next.id,
          zone: next.zone,
          kind: 'replaced',
          displacedBlockId: old.id,
          detail:
            `block ${next.id} (zone ${next.zone}) replaced ${old.id} at position ${i}; ` +
            `every block from here on is re-sent as fresh input`,
        };
      }
      return {
        index: i,
        blockId: old.id,
        zone: old.zone,
        kind: 'removed',
        displacedBlockId: next.id,
        detail:
          `block ${old.id} (zone ${old.zone}) was dropped from position ${i} and ${next.id} slid up ` +
          `into it; dropping inside the cached prefix costs the whole suffix (§10 rule 4)`,
      };
    }

    if (arrivedFrom !== -1) {
      return {
        index: i,
        blockId: next.id,
        zone: next.zone,
        kind: 'position',
        previousIndex: arrivedFrom,
        displacedBlockId: old.id,
        detail:
          `block ${next.id} (zone ${next.zone}) moved from position ${arrivedFrom} to ${i}, ` +
          `displacing ${old.id} — Zone B is creation-ordered and never relevance-ordered (§10 rule 1)`,
      };
    }

    return {
      index: i,
      blockId: next.id,
      zone: next.zone,
      kind: 'inserted',
      displacedBlockId: old.id,
      detail:
        `block ${next.id} (zone ${next.zone}) was inserted at position ${i}, pushing ${old.id} back; ` +
        `only the END of the prefix may grow (§10 rule 2)`,
    };
  }

  return null;
}

/**
 * Asserts that everything up to and including `throughZone` is byte-identical
 * and in the same order, so a provider can still read it from cache. Throws
 * `CacheAssertionError` carrying the offending block, otherwise returns.
 */
export function assertPrefixStable(
  before: AssembledPrompt,
  after: AssembledPrompt,
  options: PrefixStabilityOptions,
): void {
  const divergence = findPrefixDivergence(before, after, options);
  if (divergence === null) return;
  throw new CacheAssertionError(
    `cache prefix through zone ${options.throughZone} is unstable (${divergence.kind}): ${divergence.detail}`,
    divergence,
  );
}

/**
 * Byte offset of the first difference plus both excerpts. A whole-text dump of
 * two 8k-token zones is unreadable in a test failure; the offset is what tells
 * a reviewer whether a timestamp leaked into Zone A or a summary was rewritten.
 */
function describeTextChange(before: string, after: string): string {
  let offset = 0;
  while (offset < before.length && offset < after.length && before[offset] === after[offset]) {
    offset += 1;
  }
  return (
    `first differing byte at offset ${offset} ` +
    `(${JSON.stringify(before.slice(offset, offset + 40))} -> ${JSON.stringify(after.slice(offset, offset + 40))})`
  );
}
