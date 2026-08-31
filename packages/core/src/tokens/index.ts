/**
 * Deterministic token accounting (Ruling C8; contracts/tokens.ts `Tokenizer`).
 *
 * §10 rule 4 sizes Zone B/C against a token budget, and §17's cache-assertion
 * harness must reproduce exact token ranges offline forever — so the default
 * tokenizer is deliberately NOT tiktoken or any provider vocabulary: no native
 * dependency, no model-specific BPE table to go stale, just an arithmetic
 * function of the string that any machine gets the same answer for.
 *
 * `HeuristicTokenizer` algorithm — a single left-to-right scan over Unicode
 * code points, classified into five run kinds:
 *   - `word`      `\p{Script=Latin}`, `\p{Nd}`, or `_` (identifiers, prose).
 *                 A run of length n costs `max(1, ceil(n/4))` — the common
 *                 "~4 chars/token" approximation for subword-compressible text.
 *   - `wide`      any other letter (`\p{L}`): CJK, Cyrillic, Arabic, Hangul...
 *                 Charged 1 token PER CHARACTER, not per run, because subword
 *                 tokenizers don't compress these scripts the way they do Latin.
 *   - `newline`   `\n`, charged 1 token per character (each line break is
 *                 structurally significant to a model reading code/logs).
 *   - `space`     any other whitespace — charged 0; it rides along with the
 *                 token before or after it in real tokenizers.
 *   - `punct`     everything else (symbols, punctuation, emoji, ...). A whole
 *                 *run* of consecutive punct chars costs a flat 1, mirroring
 *                 how "..." or "==" commonly collapses to one real token.
 *
 * Every run-cost function above is non-decreasing in run length (constant,
 * linear, or ceil-of-linear), and appending text can only extend the final
 * run or open new runs after it — earlier runs' costs never get revisited.
 * That is what makes `count` monotonic: `count(s + t) >= count(s)` for any
 * s, t. §10's budget checks and §17's cache simulator both depend on that
 * property to reason about growth without recomputing from scratch.
 *
 * Known simplification: decomposed Unicode (NFD, e.g. "e" + combining acute)
 * splits into a `word` + `punct` run instead of one `word` run, over-counting
 * by one. Precomposed text (NFC, the common case for real trace content) is
 * unaffected. Not worth handling in a heuristic whose job is a stable
 * approximation, not exactness.
 */
import type { Tokenizer } from '../contracts/index.js';

type RunKind = 'word' | 'wide' | 'newline' | 'space' | 'punct';

const LATIN_WORD_RE = /[\p{Script=Latin}\p{Nd}_]/u;
const LETTER_RE = /\p{L}/u;
const SPACE_RE = /\s/u;

function classify(ch: string): RunKind {
  if (ch === '\n') return 'newline';
  if (LATIN_WORD_RE.test(ch)) return 'word';
  if (LETTER_RE.test(ch)) return 'wide';
  if (SPACE_RE.test(ch)) return 'space';
  return 'punct';
}

/** §10/§17's default tokenizer — see file header for the counting rules. */
export class HeuristicTokenizer implements Tokenizer {
  readonly id = 'heuristic-v1';

  count(text: string): number {
    let total = 0;
    let runKind: RunKind | null = null;
    let runLen = 0;

    // `word` and `punct` runs are only priced once we know their full length
    // (word cost depends on n; punct cost is flat but still waits so a run
    // isn't double-charged); `wide` and `newline` price per character as they
    // arrive, so they bypass run tracking entirely.
    const flushRun = (): void => {
      if (runKind === 'word') total += Math.max(1, Math.ceil(runLen / 4));
      else if (runKind === 'punct') total += 1;
    };

    for (const ch of text) {
      const kind = classify(ch);
      if (kind === 'wide' || kind === 'newline') {
        if (runKind !== null) {
          flushRun();
          runKind = null;
          runLen = 0;
        }
        total += 1;
        continue;
      }
      if (kind === runKind) {
        runLen += 1;
      } else {
        if (runKind !== null) flushRun();
        runKind = kind;
        runLen = 1;
      }
    }
    if (runKind !== null) flushRun();
    return total;
  }
}

/**
 * Wraps a provider's real token-counting endpoint behind the same interface,
 * so production can bill exact tokens while §17's offline tests stay on
 * `HeuristicTokenizer`. `id` is caller-supplied (e.g. "anthropic-count-tokens")
 * so a swap between exact tokenizers is as visible in cache assertions as a
 * swap to the heuristic is.
 */
export class ExactTokenizer implements Tokenizer {
  constructor(
    readonly id: string,
    private readonly counter: (text: string) => number,
  ) {}

  count(text: string): number {
    return this.counter(text);
  }
}

const heuristicSingleton: Tokenizer = new HeuristicTokenizer();

/** The process-wide default: deterministic, offline, no provider dependency. */
export function defaultTokenizer(): Tokenizer {
  return heuristicSingleton;
}

/**
 * Sums token counts across prompt blocks (§10's `PromptBlock[]`). Exists here
 * rather than in the assembler because the "how do I count a run of blocks"
 * policy belongs next to the tokenizer, not duplicated at each call site.
 */
export function countBlocks(blocks: readonly { text: string }[], tokenizer: Tokenizer): number {
  let total = 0;
  for (const block of blocks) total += tokenizer.count(block.text);
  return total;
}
