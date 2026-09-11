/**
 * Recursive character splitter (spec stage 3 corpus builder). Splits a unit's
 * text into ~chunkSize pieces with chunkOverlap, preferring to break on the
 * coarsest separator that appears (paragraph → line → space → character), so a
 * chunk stays as semantically whole as its size allows.
 *
 * PROVISIONAL params: `chunkSize ~800 / chunkOverlap ~100` are borrowed, unswept
 * defaults (the isolation runs used 512/128). Sweep with the transcript-corpus
 * retrieval experiment. `reports/session-handoff.md` backlog item 5.
 */
export const DEFAULT_CHUNK_SIZE = 800;
export const DEFAULT_CHUNK_OVERLAP = 100;
const DEFAULT_SEPARATORS = ['\n\n', '\n', ' ', ''] as const;

export interface ChunkOptions {
  chunkSize?: number;
  chunkOverlap?: number;
  separators?: readonly string[];
}

/** Merge small consecutive splits up to chunkSize, carrying chunkOverlap forward. */
function mergeSplits(
  splits: readonly string[],
  sep: string,
  chunkSize: number,
  chunkOverlap: number,
): string[] {
  const sepLen = sep.length;
  const docs: string[] = [];
  const current: string[] = [];
  let total = 0; // sum of piece lengths in `current` (separators added when joined)
  const joinedLen = (): number => total + Math.max(0, current.length - 1) * sepLen;

  for (const piece of splits) {
    if (piece.length === 0) continue;
    if (current.length > 0 && joinedLen() + sepLen + piece.length > chunkSize) {
      docs.push(current.join(sep));
      // Trim from the front, leaving ~chunkOverlap of tail context for the next chunk.
      while (
        current.length > 0 &&
        (joinedLen() > chunkOverlap || joinedLen() + sepLen + piece.length > chunkSize)
      ) {
        total -= current[0]!.length;
        current.shift();
      }
    }
    current.push(piece);
    total += piece.length;
  }
  if (current.length > 0) docs.push(current.join(sep));
  return docs;
}

function recurse(
  text: string,
  separators: readonly string[],
  chunkSize: number,
  chunkOverlap: number,
): string[] {
  if (text.length <= chunkSize) return text.length > 0 ? [text] : [];

  // The coarsest separator that occurs; '' (character split) is the last resort.
  let sepIndex = separators.length - 1;
  for (let i = 0; i < separators.length; i += 1) {
    const s = separators[i]!;
    if (s === '' || text.includes(s)) {
      sepIndex = i;
      break;
    }
  }
  const sep = separators[sepIndex]!;
  const remaining = separators.slice(sepIndex + 1);
  const pieces = sep === '' ? Array.from(text) : text.split(sep);

  const out: string[] = [];
  let good: string[] = [];
  for (const piece of pieces) {
    if (piece.length <= chunkSize) {
      good.push(piece);
    } else {
      if (good.length > 0) {
        out.push(...mergeSplits(good, sep, chunkSize, chunkOverlap));
        good = [];
      }
      // A single piece still too large: recurse with the finer separators.
      if (remaining.length > 0) out.push(...recurse(piece, remaining, chunkSize, chunkOverlap));
      else out.push(piece);
    }
  }
  if (good.length > 0) out.push(...mergeSplits(good, sep, chunkSize, chunkOverlap));
  return out;
}

/** Split `text` into overlapping chunks. Empty/whitespace-only text yields []. */
export function splitText(text: string, options: ChunkOptions = {}): string[] {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const chunkOverlap = options.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP;
  const separators = options.separators ?? DEFAULT_SEPARATORS;
  if (chunkSize <= 0) throw new RangeError('chunkSize must be positive');
  if (chunkOverlap < 0 || chunkOverlap >= chunkSize) {
    throw new RangeError('chunkOverlap must be in [0, chunkSize)');
  }
  return recurse(text, separators, chunkSize, chunkOverlap);
}

/** One chunk of a unit's text, tagged with the unit it came from. */
export interface UnitChunk {
  unitId: string;
  index: number; // global chunk index across the corpus
  text: string;
}

/** Chunk a corpus of units into `UnitChunk`s (the retrieval corpus). */
export function chunkUnits(
  units: readonly { id: string; text: string }[],
  options: ChunkOptions = {},
): UnitChunk[] {
  const chunks: UnitChunk[] = [];
  let index = 0;
  for (const u of units) {
    for (const text of splitText(u.text, options)) {
      chunks.push({ unitId: u.id, index: index++, text });
    }
  }
  return chunks;
}
