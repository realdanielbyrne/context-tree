import { describe, expect, it, vi } from 'vitest';
import { countBlocks, defaultTokenizer, ExactTokenizer, HeuristicTokenizer } from '../src/tokens/index.js';

describe('HeuristicTokenizer — documented per-class cost rules', () => {
  const tok = new HeuristicTokenizer();

  it('exposes a stable id so a tokenizer swap shows up as a diff in cache assertions (Ruling C8)', () => {
    expect(tok.id).toBe('heuristic-v1');
    expect(new HeuristicTokenizer().id).toBe(tok.id);
  });

  it('is deterministic: the same text counted twice yields the same number', () => {
    const text = 'function add(a, b) {\n  return a + b;\n}';
    expect(tok.count(text)).toBe(tok.count(text));
  });

  it('charges a word run ceil(n/4) with a floor of 1, per the documented formula', () => {
    expect(tok.count('a')).toBe(1); // floor of 1, not ceil(1/4) rounding to 0
    expect(tok.count('abcd')).toBe(1); // exactly 4 chars -> 1
    expect(tok.count('abcde')).toBe(2); // 5th char starts a new charged unit
    expect(tok.count('abcdefgh')).toBe(2); // 8 chars -> ceil(8/4)
  });

  it('charges whitespace (non-newline) nothing, since it rides along with an adjacent token in real tokenizers', () => {
    expect(tok.count('a b')).toBe(tok.count('a') + tok.count('b'));
    expect(tok.count('   ')).toBe(0);
  });

  it('charges one whole punctuation run as 1 token, not 1 per character, mirroring "==" or "..." collapsing in real BPE vocabularies', () => {
    expect(tok.count('...')).toBe(1);
    expect(tok.count('!?!?')).toBe(1);
    // separated by a (zero-cost) space, these are two DISTINCT runs, not one:
    expect(tok.count('. .')).toBe(2);
  });

  it('charges CJK/non-Latin letters 1 token per character, since subword models do not compress those scripts', () => {
    expect(tok.count('日')).toBe(1);
    expect(tok.count('日本語')).toBe(3);
    expect(tok.count('日本語日本語')).toBe(6); // doubling the run doubles the cost, unlike a Latin word run
  });

  it('charges each newline 1 token, distinct from the run-collapsed punctuation rule', () => {
    expect(tok.count('\n')).toBe(1);
    expect(tok.count('\n\n\n')).toBe(3);
    expect(tok.count('a\nb')).toBe(tok.count('a') + 1 + tok.count('b'));
  });

  it('counts an empty string as zero tokens', () => {
    expect(tok.count('')).toBe(0);
  });
});

describe('HeuristicTokenizer — monotonicity under append (§10 budgets and §17 cache assertions both assume this)', () => {
  const tok = new HeuristicTokenizer();

  // A deliberately varied table: prose, punctuation-heavy code, CJK (per-char
  // charging), the empty string, and a single very long word (the boundary
  // case for the ceil(n/4) formula). If any class's run-cost function were
  // ever non-monotonic (e.g. someone "fixed" punctuation to cost per-char but
  // with a bug that resets on run boundaries), one of these should catch it.
  const bases: Record<string, string> = {
    empty: '',
    'ascii prose': 'The quick brown fox jumps over the lazy dog.',
    'code with punctuation': 'function add(a, b) {\n  return a + b;\n}',
    cjk: '日本語のテキストです、これはテストです。',
    'very long single word': 'a'.repeat(2000),
  };

  const suffixes = ['', ' more words here', '!!!???', '\n\n\n', '日本語追加', 'x'.repeat(37)];

  for (const [label, base] of Object.entries(bases)) {
    for (const suffix of suffixes) {
      it(`appending ${JSON.stringify(suffix)} to "${label}" never lowers the count`, () => {
        const before = tok.count(base);
        const after = tok.count(base + suffix);
        expect(after).toBeGreaterThanOrEqual(before);
      });
    }
  }
});

describe('HeuristicTokenizer — calibration against a realistic code snippet', () => {
  it('lands within 0.5x-2x of a hand-computed ballpark, so a wildly wrong heuristic fails rather than merely being imprecise', () => {
    const snippet = [
      'export function clamp(value: number, min: number, max: number): number {',
      '  if (value < min) return min;',
      '  if (value > max) return max;',
      '  return value;',
      '}',
    ].join('\n');

    // Independent hand-computed ballpark: the widely-cited "~4 characters per
    // token" rule of thumb for English/code text, applied to raw length —
    // NOT derived from HeuristicTokenizer's own run-classification logic.
    const handComputed = snippet.length / 4;

    const actual = defaultTokenizer().count(snippet);

    expect(actual).toBeGreaterThanOrEqual(handComputed * 0.5);
    expect(actual).toBeLessThanOrEqual(handComputed * 2);
  });
});

describe('defaultTokenizer', () => {
  it('returns the heuristic tokenizer, the offline-reproducible default §17 requires', () => {
    expect(defaultTokenizer().id).toBe('heuristic-v1');
  });
});

describe('ExactTokenizer', () => {
  it('delegates counting to the injected function and reports the caller-supplied id, so production billing can swap in a real endpoint without touching call sites', () => {
    const counter = vi.fn((text: string) => text.length * 2);
    const exact = new ExactTokenizer('anthropic-count-tokens', counter);

    expect(exact.id).toBe('anthropic-count-tokens');
    expect(exact.count('abc')).toBe(6);
    expect(counter).toHaveBeenCalledExactlyOnceWith('abc');
  });
});

describe('countBlocks', () => {
  it('sums per-block counts rather than concatenating text first, so block boundaries never accidentally merge into one word/punct run', () => {
    const tok = defaultTokenizer();
    // Concatenated ("abcd" + "efgh" = "abcde fgh"... ) would NOT change this
    // particular example, so pick blocks whose boundary would merge runs if
    // counted as one string: a word run split across two blocks.
    const blocks = [{ text: 'ab' }, { text: 'cd' }];
    // Counted separately: ceil(2/4)=1 + ceil(2/4)=1 = 2.
    // Counted concatenated ("abcd"): ceil(4/4) = 1. The difference proves
    // countBlocks respects block boundaries instead of joining text.
    expect(countBlocks(blocks, tok)).toBe(2);
    expect(tok.count('abcd')).toBe(1);
  });

  it('returns 0 for an empty block list', () => {
    expect(countBlocks([], defaultTokenizer())).toBe(0);
  });
});
