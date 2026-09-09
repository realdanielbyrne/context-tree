/**
 * §17's provider cache simulator — "asserting exactly which prefix ranges
 * survive each event type".
 *
 * The model, and why it is shaped this way:
 *
 * Provider caches are keyed on a PREFIX and can only be cut at an emitted
 * breakpoint (§10 rule 5 puts exactly two of them in, at the Zone A/B and B/C
 * boundaries). So a prompt is a list of SEGMENTS, split at the breakpoints the
 * provider actually honours, plus a trailing remainder after the last one that
 * is never cacheable. A read takes the LONGEST cached prefix that still matches
 * byte-for-byte; everything after that boundary up to the last breakpoint is a
 * cache WRITE, and the trailing remainder is fresh input every single turn.
 *
 * The consequence this exists to measure: one changed byte in Zone B invalidates
 * Zone B and everything after it, but NOT Zone A. That asymmetry is the entire
 * reason §10 rule 1 forbids relevance-ordering Zone B, and it is invisible to
 * every other kind of test — the model sees the same text either way.
 *
 * `matchPolicy` (default `'automatic-prefix'`) decides HOW a submission's
 * prefix is checked against cache history — see the two modes documented on
 * `ProviderCacheSimulatorOptions`. Iteration 2 of the tuning loop
 * (tuning iteration 2, experiment 4) diagnosed the
 * original algorithm — matching only the immediately previous submission's
 * exact breakpoint positions — as unable to credit a read for a breakpoint
 * that moves forward by one block every turn, because that exact position
 * never recurs. That produced a false "+23% more expensive" verdict on the
 * Zone C 3rd breakpoint that a live, already-published measurement directly
 * contradicts (`reports/metrics/tree-vs-transcript.md:155`: cacheRead
 * climbing 4,788→23,794, cacheWrite staying delta-sized at ~1.2k, −18% cost
 * per turn) — and which Anthropic's own documented behaviour explains: a
 * single trailing breakpoint is matched against the LONGEST previously
 * cached prefix, not against one specific remembered position. `'exact-last-
 * position'` is the original algorithm, preserved byte-for-byte and still
 * reachable for anything that wants the more conservative model.
 *
 * Two remaining simplifications, both still conservative in the sense the
 * original comment claimed:
 *  - `'automatic-prefix'` tracks one running "longest known cached prefix",
 *    refreshed to this submission's own furthest cacheable position every
 *    turn. A real provider's cache persists under a TTL independent of what
 *    any one request's breakpoints reference, so a submission that (unlike
 *    every submission actually observed in this codebase) *drops* a
 *    previously-placed breakpoint would, in this model, lose credit for
 *    everything past its new, shorter reach a turn earlier than a real TTL
 *    would — under-crediting, not over-crediting, in that edge case.
 *  - the tokenizer is INJECTED and its id is stamped on every outcome (§17's
 *    "deterministic tokenizer"), and block tokens are re-counted from `text`
 *    rather than trusting `PromptBlock.tokens`. The harness's numbers must be a
 *    function of the bytes it was handed, so that swapping the tokenizer shows
 *    up as a deliberate diff in recorded ranges instead of silently shifting
 *    every one of them.
 */
import type { AssembledPrompt, Tokenizer, Zone } from '../contracts/index.js';
import { CacheAssertionError } from './prefix.js';

/**
 * Per-provider cache behaviour (§18 risk row 4: "cache behavior differs per
 * provider" -> "per-provider cache-simulator tests; provider-neutral layout +
 * provider-specific cache markers"). Only the two knobs that actually change
 * which ranges survive are modelled.
 */
export interface CacheProviderProfile {
  id: string;
  /**
   * Breakpoints honoured per request; the rest are ignored and their blocks fold
   * into the following segment.
   */
  maxBreakpoints: number;
  /**
   * A breakpoint whose whole preceding prefix is smaller than this is not cached
   * at all — the provider's minimum cacheable prefix.
   */
  minCacheableTokens: number;
}

/**
 * The harness default: every emitted breakpoint is honoured and there is no
 * minimum. Deliberately provider-neutral, because §17's assertions are about
 * the LAYOUT surviving, and a provider minimum would make every small fixture
 * report "nothing cached" and assert nothing.
 */
export const EXACT_PREFIX_PROFILE: CacheProviderProfile = {
  id: 'exact-prefix',
  maxBreakpoints: Number.POSITIVE_INFINITY,
  minCacheableTokens: 0,
};

/**
 * Anthropic prompt caching: at most 4 `cache_control` breakpoints, and a
 * 1024-token minimum cacheable prefix on Sonnet/Opus-class models (Haiku's is
 * higher — construct a profile with that minimum to model it).
 */
export const ANTHROPIC_PROFILE: CacheProviderProfile = {
  id: 'anthropic',
  maxBreakpoints: 4,
  minCacheableTokens: 1024,
};

/** One breakpoint-delimited run of blocks. */
export interface CacheSegment {
  /** Position in the prompt's segment list. */
  index: number;
  /** Zones this segment spans, in order — `"A"`, `"B"`, `"C+tail"`. */
  label: string;
  zones: Zone[];
  blockIds: string[];
  tokens: number;
  /** Exclusive block index this segment ends at — the provider's cache key. */
  endBlockIndex: number;
  /** Id of the block whose breakpoint closes it; null for the trailing remainder. */
  breakpointBlockId: string | null;
  /** False only for the trailing remainder: nothing after the last breakpoint is cached. */
  cacheable: boolean;
}

export interface SegmentOutcome extends CacheSegment {
  /** Read from cache on this submission rather than re-sent. */
  reused: boolean;
}

export interface CacheOutcome {
  /** 1-based ordinal within the session. */
  submission: number;
  /** Recorded so a tokenizer swap is a visible diff, never a silent shift (§17). */
  tokenizerId: string;
  profileId: string;
  cacheRead: number;
  cacheWrite: number;
  /** Input tokens neither read from nor written to cache — the uncacheable tail. */
  fresh: number;
  /** `cacheRead + cacheWrite + fresh`, and the sum of every block's tokens. */
  total: number;
  /** Blocks matching the previous submission position-for-position, by id AND text. */
  commonPrefixBlocks: number;
  /**
   * Tokens in that byte-identical block prefix — what a provider with a
   * breakpoint at every block could have reused. Always >= `cacheRead`; the gap
   * is the price of §10 rule 5 allowing only two breakpoints, and it is the
   * number that documents the honest cost of a mid-Zone-B rewrite (D3/D4).
   */
  commonPrefixTokens: number;
  /** Block where divergence began; null on the first submission or an exact repeat. */
  divergedAtBlockId: string | null;
  divergedInZone: Zone | null;
  segments: SegmentOutcome[];
  /** Labels of the segments that survived intact. */
  survivingSegments: string[];
}

/** A block reduced to what the cache actually keys on. */
interface MeasuredBlock {
  id: string;
  zone: Zone;
  text: string;
  tokens: number;
  breakpointAfter: boolean;
}

interface Submission {
  blocks: MeasuredBlock[];
  segments: CacheSegment[];
}

/**
 * How a submission's prefix is checked against cache history.
 *
 *  - `'automatic-prefix'` (the default): matches against the LONGEST prefix
 *    ever cached, refreshed each turn to this submission's own furthest
 *    cacheable position. This is what lets a single breakpoint that moves
 *    forward by one block every turn still earn a read for everything before
 *    the new block — exactly the "climbing reads, delta-sized writes" shape
 *    `reports/metrics/tree-vs-transcript.md:155` measured live, and what
 *    Anthropic's own documented behaviour describes for a trailing
 *    breakpoint. A dropped breakpoint (the regression `cache.test.ts` guards
 *    against) still shows up as zero reads, because a submission with no
 *    cacheable segment cannot extend or read the cached prefix at all.
 *  - `'exact-last-position'`: the original algorithm, preserved byte-for-byte.
 *    It only credits a read when the CURRENT submission's breakpoint lands at
 *    the exact block position one of the PREVIOUS submission's breakpoints
 *    also landed at. This under-credits any breakpoint that advances by less
 *    than a whole previously-seen segment each turn (§1 of
 *    tuning iteration 2, experiment 4) — kept as an
 *    explicit opt-in for anything that wants that stricter, more
 *    pessimistic model rather than as the default.
 */
export type CacheMatchPolicy = 'automatic-prefix' | 'exact-last-position';

export interface ProviderCacheSimulatorOptions {
  tokenizer: Tokenizer;
  /** Defaults to `EXACT_PREFIX_PROFILE`. */
  profile?: CacheProviderProfile;
  /** Defaults to `'automatic-prefix'`. See `CacheMatchPolicy`. */
  matchPolicy?: CacheMatchPolicy;
}

export class ProviderCacheSimulator {
  private readonly tokenizer: Tokenizer;
  private readonly profile: CacheProviderProfile;
  private readonly matchPolicy: CacheMatchPolicy;
  private previous: Submission | null = null;
  /** `'automatic-prefix'` only: the longest prefix confirmed cached so far. */
  private cachedPrefix: MeasuredBlock[] = [];
  private readonly log: CacheOutcome[] = [];

  constructor(options: ProviderCacheSimulatorOptions) {
    this.tokenizer = options.tokenizer;
    this.profile = options.profile ?? EXACT_PREFIX_PROFILE;
    this.matchPolicy = options.matchPolicy ?? 'automatic-prefix';
  }

  /** Submits one assembled prompt and reports what the cache did with it. */
  submit(prompt: AssembledPrompt): CacheOutcome {
    const blocks = this.measure(prompt);
    const segments = this.segment(blocks);
    const previous = this.previous;

    // This diagnostic (commonPrefixBlocks/commonPrefixTokens) is deliberately
    // scoped to the immediately previous submission only, regardless of
    // matchPolicy — it answers "how much of literally last turn's bytes
    // survived", the number the D3/D4 cascade tests key on, which is a
    // different question from "how much can the provider actually serve from
    // cache" below.
    let commonPrefixBlocks = 0;
    let commonPrefixTokens = 0;
    if (previous !== null) {
      while (commonPrefixBlocks < blocks.length && commonPrefixBlocks < previous.blocks.length) {
        const mine = blocks[commonPrefixBlocks];
        const theirs = previous.blocks[commonPrefixBlocks];
        if (mine === undefined || theirs === undefined) break;
        if (mine.id !== theirs.id || mine.text !== theirs.text) break;
        commonPrefixTokens += mine.tokens;
        commonPrefixBlocks += 1;
      }
    }

    let outcomeSegments: SegmentOutcome[];
    let cacheRead = 0;
    let cacheWrite = 0;
    let fresh = 0;

    if (this.matchPolicy === 'exact-last-position') {
      // Original algorithm, unchanged: a read hits the longest cached prefix
      // that still matches, so the boundary is the furthest segment end that
      // (a) the previous submission actually cached at that EXACT position and
      // (b) is still byte-identical. Requiring (a) at exact-position
      // granularity is what makes a breakpoint that moves every turn never
      // earn a read here — the documented limitation this policy exists to
      // preserve on request.
      const previouslyCached = new Set(
        (previous?.segments ?? []).filter((s) => s.cacheable).map((s) => s.endBlockIndex),
      );
      let readBoundary = 0;
      for (const segment of segments) {
        if (!segment.cacheable) continue;
        if (segment.endBlockIndex > commonPrefixBlocks) break;
        if (!previouslyCached.has(segment.endBlockIndex)) continue;
        readBoundary = segment.endBlockIndex;
      }

      outcomeSegments = segments.map((segment) => ({
        ...segment,
        reused: segment.cacheable && segment.endBlockIndex <= readBoundary,
      }));
      for (const segment of outcomeSegments) {
        if (segment.reused) cacheRead += segment.tokens;
        else if (segment.cacheable) cacheWrite += segment.tokens;
        else fresh += segment.tokens;
      }
    } else {
      // 'automatic-prefix': match against the longest prefix ever cached,
      // not only the immediately previous submission's exact breakpoint
      // positions. Read credit is computed at BLOCK granularity — a segment
      // can be partially read and partially (re)written — because that
      // partial credit inside a single marked span is exactly the mechanism
      // that produces delta-sized writes under one moving breakpoint; a
      // whole-segment-or-nothing model cannot reproduce that shape no matter
      // how much history it is given.
      let commonWithCache = 0;
      while (commonWithCache < blocks.length && commonWithCache < this.cachedPrefix.length) {
        const mine = blocks[commonWithCache];
        const theirs = this.cachedPrefix[commonWithCache];
        if (mine === undefined || theirs === undefined) break;
        if (mine.id !== theirs.id || mine.text !== theirs.text) break;
        commonWithCache += 1;
      }
      const furthestCacheableEnd = segments.reduce(
        (max, s) => (s.cacheable ? Math.max(max, s.endBlockIndex) : max),
        0,
      );
      const readBoundary = Math.min(commonWithCache, furthestCacheableEnd);

      outcomeSegments = segments.map((segment) => ({
        ...segment,
        reused: segment.cacheable && segment.endBlockIndex <= readBoundary,
      }));
      for (let i = 0; i < blocks.length; i += 1) {
        const block = blocks[i];
        if (block === undefined) continue;
        if (i < readBoundary) cacheRead += block.tokens;
        else if (i < furthestCacheableEnd) cacheWrite += block.tokens;
        else fresh += block.tokens;
      }

      this.cachedPrefix = blocks.slice(0, furthestCacheableEnd);
    }

    const divergence = this.divergence(blocks, previous, commonPrefixBlocks);
    const outcome: CacheOutcome = {
      submission: this.log.length + 1,
      tokenizerId: this.tokenizer.id,
      profileId: this.profile.id,
      cacheRead,
      cacheWrite,
      fresh,
      total: cacheRead + cacheWrite + fresh,
      commonPrefixBlocks,
      commonPrefixTokens,
      divergedAtBlockId: divergence?.id ?? null,
      divergedInZone: divergence?.zone ?? null,
      segments: outcomeSegments,
      survivingSegments: outcomeSegments.filter((s) => s.reused).map((s) => s.label),
    };

    this.previous = { blocks, segments };
    this.log.push(outcome);
    return outcome;
  }

  /** Every outcome so far, in submission order — `cacheReport`'s input. */
  outcomes(): readonly CacheOutcome[] {
    return this.log;
  }

  private measure(prompt: AssembledPrompt): MeasuredBlock[] {
    const marked = new Set(prompt.cacheBreakpoints);
    return prompt.blocks.map((block) => ({
      id: block.id,
      zone: block.zone,
      text: block.text,
      tokens: this.tokenizer.count(block.text),
      // Either channel counts: the assembler sets the flag on the block and
      // lists the id, and a hand-built prompt in a test may set only one.
      breakpointAfter: block.cacheBreakpointAfter === true || marked.has(block.id),
    }));
  }

  private segment(blocks: readonly MeasuredBlock[]): CacheSegment[] {
    const segments: CacheSegment[] = [];
    let start = 0;
    let prefixTokens = 0;
    let honoured = 0;

    for (let i = 0; i < blocks.length; i += 1) {
      const block = blocks[i];
      if (block === undefined) continue;
      prefixTokens += block.tokens;
      if (!block.breakpointAfter) continue;
      if (honoured >= this.profile.maxBreakpoints) continue;
      if (prefixTokens < this.profile.minCacheableTokens) continue;
      honoured += 1;
      segments.push(makeSegment(segments.length, blocks.slice(start, i + 1), start, block.id, true));
      start = i + 1;
    }
    if (start < blocks.length) {
      segments.push(makeSegment(segments.length, blocks.slice(start), start, null, false));
    }
    return segments;
  }

  /**
   * The block where this submission stopped matching the previous one. A block
   * present on only one side counts: a removal invalidates the suffix exactly as
   * a rewrite does.
   */
  private divergence(
    blocks: readonly MeasuredBlock[],
    previous: Submission | null,
    commonPrefixBlocks: number,
  ): { id: string; zone: Zone } | null {
    if (previous === null) return null;
    const mine = blocks[commonPrefixBlocks];
    if (mine !== undefined) return { id: mine.id, zone: mine.zone };
    const theirs = previous.blocks[commonPrefixBlocks];
    if (theirs !== undefined) return { id: theirs.id, zone: theirs.zone };
    return null;
  }
}

function makeSegment(
  index: number,
  blocks: readonly MeasuredBlock[],
  startBlockIndex: number,
  breakpointBlockId: string | null,
  cacheable: boolean,
): CacheSegment {
  const zones: Zone[] = [];
  let tokens = 0;
  for (const block of blocks) {
    if (!zones.includes(block.zone)) zones.push(block.zone);
    tokens += block.tokens;
  }
  return {
    index,
    label: zones.join('+'),
    zones,
    blockIds: blocks.map((block) => block.id),
    tokens,
    endBlockIndex: startBlockIndex + blocks.length,
    breakpointBlockId,
    cacheable,
  };
}

/**
 * §15's headline cost metric: "input tokens (cache-read vs cache-write split)"
 * across a whole session. The eval harness aggregates arms through this.
 */
export interface CacheSessionReport {
  tokenizerId: string;
  profileId: string;
  submissions: number;
  cacheRead: number;
  cacheWrite: number;
  fresh: number;
  total: number;
  /** `cacheRead / total` — 0 when nothing was submitted. */
  cacheReadRatio: number;
}

export function cacheReport(outcomes: readonly CacheOutcome[]): CacheSessionReport {
  const first = outcomes[0];
  if (first === undefined) {
    throw new CacheAssertionError('cacheReport: no submissions to aggregate');
  }

  const report: CacheSessionReport = {
    tokenizerId: first.tokenizerId,
    profileId: first.profileId,
    submissions: outcomes.length,
    cacheRead: 0,
    cacheWrite: 0,
    fresh: 0,
    total: 0,
    cacheReadRatio: 0,
  };

  for (const outcome of outcomes) {
    // Mixing tokenizers or providers makes the aggregate meaningless, and a
    // meaningless cost split in a §15 results table is worse than a crash.
    if (outcome.tokenizerId !== report.tokenizerId) {
      throw new CacheAssertionError(
        `cacheReport: mixed tokenizers (${report.tokenizerId} vs ${outcome.tokenizerId}) — token ranges are not comparable`,
      );
    }
    if (outcome.profileId !== report.profileId) {
      throw new CacheAssertionError(
        `cacheReport: mixed provider profiles (${report.profileId} vs ${outcome.profileId}) — cache behaviour differs per provider (§18)`,
      );
    }
    report.cacheRead += outcome.cacheRead;
    report.cacheWrite += outcome.cacheWrite;
    report.fresh += outcome.fresh;
    report.total += outcome.total;
  }

  if (report.total > 0) report.cacheReadRatio = report.cacheRead / report.total;
  return report;
}
