import { extractFingerprints } from '../retrieve/lexical.js';

/**
 * Zone B as an INDEX, not as content.
 *
 * The operator's specification: a summary's only job is to tell the model that
 * it once worked on X, so it can go and find X with `context_search`. It is not
 * a substitute for the content and should never be expected to answer from
 * itself.
 *
 * That reframing is what the measurements already said. Zone B is inert on
 * literal recall — `flat-events` scored 15/25 against 16/25 for the same stack
 * with Zone B present — which is the correct behaviour for an index, and was
 * previously read as a failure. Showing the model MORE Zone B prose was
 * separately refuted (+32% tokens, no change in what it selected). So the
 * question this renderer poses is not "can the model answer from Zone B" but
 * "does Zone B raise the rate at which the model successfully retrieves".
 *
 * The unit is therefore a keyword fingerprint — file paths and identifiers,
 * the low-frequency tokens a query actually names — and explicitly not prose.
 */

export interface TopicIndexEntry {
  /** Retrieval coordinate the model passes back to `context_search`. */
  id: string;
  /** Distinctive identifiers this region touched, in first-appearance order. */
  keywords: readonly string[];
  /** L0 span, so a hit is fetchable without a second lookup. */
  spanStartSeq: number;
  spanEndSeq: number;
}

export interface TopicIndexInput {
  regions: readonly { id: string; text: string; spanStartSeq: number; spanEndSeq: number }[];
  /** Hard cap per region. Keeps the index a fixed cost as history grows. */
  keywordsPerRegion: number;
  /**
   * Fingerprints appearing in more regions than this are dropped as
   * non-discriminating. An identifier present everywhere routes nowhere, which
   * is the same failure that made fusing disjoint indexes harmful.
   */
  maxRegionFraction: number;
}

export interface TopicIndex {
  entries: TopicIndexEntry[];
  /** Dropped for appearing in too many regions — reported, not silent. */
  droppedCommon: string[];
  totalKeywords: number;
}

export function buildTopicIndex(input: TopicIndexInput): TopicIndex {
  const { regions, keywordsPerRegion, maxRegionFraction } = input;
  if (!Number.isInteger(keywordsPerRegion) || keywordsPerRegion <= 0) {
    throw new RangeError('keywordsPerRegion must be a positive integer');
  }
  if (!(maxRegionFraction > 0 && maxRegionFraction <= 1)) {
    throw new RangeError('maxRegionFraction must be in (0, 1]');
  }
  // Per-region fingerprints first, so document frequency is measured over
  // regions rather than over occurrences — one region mentioning a symbol
  // fifty times must not make it look common.
  const perRegion = regions.map((region) => ({ region, fps: [...extractFingerprints(region.text)] }));
  const regionCount = new Map<string, number>();
  for (const { fps } of perRegion) for (const fp of new Set(fps)) regionCount.set(fp, (regionCount.get(fp) ?? 0) + 1);
  const limit = Math.max(1, Math.floor(regions.length * maxRegionFraction));
  const droppedCommon = [...regionCount.entries()].filter(([, n]) => n > limit).map(([fp]) => fp).sort();
  const dropped = new Set(droppedCommon);
  const entries = perRegion.map(({ region, fps }) => ({
    id: region.id,
    // Rarest first: a keyword in one region routes there unambiguously.
    keywords: [...new Set(fps)].filter((fp) => !dropped.has(fp))
      .sort((a, b) => (regionCount.get(a)! - regionCount.get(b)!) || a.localeCompare(b))
      .slice(0, keywordsPerRegion),
    spanStartSeq: region.spanStartSeq,
    spanEndSeq: region.spanEndSeq,
  }));
  return { entries, droppedCommon, totalKeywords: entries.reduce((sum, e) => sum + e.keywords.length, 0) };
}

/**
 * Render the index for Zone B. Deliberately not prose: one line per region,
 * keywords only, plus the coordinate the model needs to retrieve it. The
 * closing line is the contract — an index that does not tell the model what to
 * do with a hit is a list of words.
 */
export function renderTopicIndex(index: TopicIndex): string {
  if (index.entries.length === 0) return '';
  const lines = index.entries
    .filter((entry) => entry.keywords.length > 0)
    .map((entry) => `${entry.id} [${entry.spanStartSeq}-${entry.spanEndSeq}] ${entry.keywords.join(' ')}`);
  if (lines.length === 0) return '';
  return [
    'Earlier work in this session, by identifier. These are pointers, not content:',
    ...lines,
    'To read any of it, call context_search with the identifiers you need.',
  ].join('\n');
}
