import { createHash } from 'node:crypto';
import type { Tokenizer } from '../contracts/tokens.js';

export type PayloadMode = 'excerpt' | 'whole' | 'structural';
export interface PayloadSection {
  start: number;
  end: number;
  relevance: 'relevant' | 'irrelevant' | 'unknown';
  /** Required to omit an irrelevant section; absence conservatively retains it. */
  reason?: string;
}
export interface PayloadSelectionInput {
  /** The original producer response must already be preserved in L2. */
  original: { text: string; blobId: string; producerTruncated?: boolean };
  mode: PayloadMode;
  /** Remaining physical payload space, after the caller accounts for wrappers. */
  availableTokens: number;
  tokenizer: Pick<Tokenizer, 'count'>;
  excerpt?: { chars: number; terms: readonly string[]; anchor: 'first' | 'rarest' };
  /** A parser-supported, complete partition of the original response. Arbitrary
   * line splitting is not structural support. Unknown sections are retained. */
  structure?: { parser: string; sections: readonly PayloadSection[] };
}
export interface PayloadSelection {
  configuration: { mode: PayloadMode; availableTokens: number; excerpt?: PayloadSelectionInput['excerpt']; structureParser?: string };
  /** This identifies a selection, never a delivered/consumed receipt. */
  selectionId: string;
  sourceBlobId: string;
  mode: PayloadMode;
  status: 'ready' | 'unsupported_structure' | 'overflow';
  producerStatus: 'complete' | 'producer_truncated';
  text: string | null;
  tokens: number | null;
  originalTokens: number;
  selectedSpans: { start: number; end: number }[];
  omittedChars: number;
}

/** Find one anchor on the original response. Rarity is measured in this response;
 * ties prefer the longer match, then source order. No hardcoded excerpt size. */
function anchorOffset(text: string, terms: readonly string[], mode: 'first' | 'rarest'): number {
  const lower = text.toLowerCase();
  const matches = [...new Set(terms.map((term) => term.toLowerCase()).filter(Boolean))].flatMap((term) => {
    const at = lower.indexOf(term);
    if (at < 0) return [];
    let count = 0;
    let offset = at;
    while (offset >= 0) { count++; offset = lower.indexOf(term, offset + term.length); }
    return [{ at, count, length: term.length }];
  });
  matches.sort((a, b) => mode === 'first' ? a.at - b.at : a.count - b.count || b.length - a.length || a.at - b.at);
  return matches[0]?.at ?? 0;
}

export function selectPayload(input: PayloadSelectionInput): PayloadSelection {
  if (!input.original.blobId.trim()) throw new Error('original response must have an L2 blobId before selection');
  if (!['excerpt', 'whole', 'structural'].includes(input.mode)) throw new RangeError('unsupported payload mode');
  if (!Number.isFinite(input.availableTokens) || input.availableTokens < 0) throw new RangeError('availableTokens must be finite and nonnegative');
  const { text: original } = input.original;
  let text: string | null = original;
  let selectedSpans = [{ start: 0, end: original.length }];
  let status: PayloadSelection['status'] = 'ready';
  if (input.mode === 'excerpt') {
    const excerpt = input.excerpt;
    if (excerpt === undefined || !Number.isSafeInteger(excerpt.chars) || excerpt.chars < 0) throw new RangeError('excerpt mode requires an explicit nonnegative character size');
    const at = anchorOffset(original, excerpt.terms, excerpt.anchor);
    const band = (chars: number): { text: string; start: number; end: number } => {
      if (chars === 0) return { text: '', start: at, end: at };
      let start = Math.max(0, Math.min(at - Math.floor(chars / 2), original.length - chars));
      let end = Math.min(original.length, start + chars);
      // Coordinates are UTF-16 offsets; never emit an isolated surrogate.
      const splitsPair = (offset: number): boolean => offset > 0 && offset < original.length
        && original.charCodeAt(offset - 1) >= 0xd800 && original.charCodeAt(offset - 1) <= 0xdbff
        && original.charCodeAt(offset) >= 0xdc00 && original.charCodeAt(offset) <= 0xdfff;
      if (splitsPair(start)) start++;
      if (splitsPair(end)) end--;
      return { text: `${start > 0 ? '…' : ''}${original.slice(start, end)}${end < original.length ? '…' : ''}`, start, end };
    };
    // Select once from original bytes; the appender receives an already fitting
    // result. Binary search is conservative if token counts are non-monotonic.
    let lo = 0;
    let hi = Math.min(excerpt.chars, original.length);
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (input.tokenizer.count(band(mid).text) <= input.availableTokens) lo = mid;
      else hi = mid - 1;
    }
    const selected = band(lo);
    text = selected.text;
    selectedSpans = selected.start >= selected.end ? [] : [{ start: selected.start, end: selected.end }];
    if (original.length > 0 && selectedSpans.length === 0) status = 'overflow';
  } else if (input.mode === 'structural') {
    const structure = input.structure;
    let end = 0;
    const supported = structure !== undefined && structure.parser.trim() !== '' && structure.sections.every((section) => {
      const valid = Number.isSafeInteger(section.start) && Number.isSafeInteger(section.end)
        && section.start === end && section.end > section.start && section.end <= original.length;
      end = section.end;
      return valid;
    }) && end === original.length;
    if (!supported || structure === undefined) {
      status = 'unsupported_structure';
      text = null;
      selectedSpans = [];
    } else {
      selectedSpans = structure.sections.filter((section) => section.relevance !== 'irrelevant' || !section.reason?.trim())
        .map(({ start, end: sectionEnd }) => ({ start, end: sectionEnd }));
      text = selectedSpans.map((span) => original.slice(span.start, span.end)).join('');
    }
  }
  const tokens = text === null ? null : input.tokenizer.count(text);
  if (tokens !== null && tokens > input.availableTokens) status = 'overflow';
  const selectedText = status === 'ready' ? text : null;
  const omittedChars = original.length - selectedSpans.reduce((sum, span) => sum + span.end - span.start, 0);
  const selectionId = createHash('sha256').update(JSON.stringify({ source: input.original.blobId, mode: input.mode, text, selectedSpans, status })).digest('hex');
  return {
    configuration: {
      mode: input.mode, availableTokens: input.availableTokens,
      ...(input.excerpt === undefined ? {} : { excerpt: { ...input.excerpt, terms: [...input.excerpt.terms] } }),
      ...(input.structure === undefined ? {} : { structureParser: input.structure.parser }),
    },
    selectionId, sourceBlobId: input.original.blobId, mode: input.mode, status,
    producerStatus: input.original.producerTruncated === true ? 'producer_truncated' : 'complete',
    text: selectedText, tokens, originalTokens: input.tokenizer.count(original), selectedSpans, omittedChars,
  };
}
