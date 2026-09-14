import { describe, it, expect } from 'vitest';
import { HeuristicTokenizer } from '../src/tokens/index.js';
import {
  reduceChunk,
  reduceSummarize,
  resolveReducer,
  DEFAULT_REDUCER,
  type ReduceContext,
} from '../src/assemble/index.js';

const tok = new HeuristicTokenizer();

// Small chunks so a modest text yields many, giving the reducer real choices.
const chunkOptions = { chunkSize: 80, chunkOverlap: 16 };
const ctx = (over: Partial<ReduceContext> = {}): ReduceContext => ({
  budgetTokens: 60,
  tokenizer: tok,
  chunkOptions,
  ...over,
});

const filler = 'the quick brown fox jumps over the lazy dog and keeps on running. ';
// A buried detail sandwiched between filler — far larger than any small budget.
const buried = `${filler.repeat(8)}The SECRET_PRICE is 4297 cents exactly. ${filler.repeat(8)}`;

describe('reduceChunk — the SETTLED detail-preserving reducer', () => {
  it('returns the text unchanged when it already fits the budget', () => {
    const small = 'short enough';
    expect(reduceChunk({ raw: small }, ctx({ budgetTokens: 1000 }))).toBe(small);
  });

  it('the result fits the per-unit budget', () => {
    const out = reduceChunk({ raw: buried }, ctx());
    expect(tok.count(out)).toBeLessThanOrEqual(60);
    expect(tok.count(buried)).toBeGreaterThan(60); // the input really did overflow
  });

  it('preserves a BURIED DETAIL that matches the query (the win over summarize)', () => {
    const out = reduceChunk({ raw: buried }, ctx({ query: 'SECRET_PRICE cents' }));
    expect(out).toContain('SECRET_PRICE');
    expect(out).toContain('4297');
  });

  it('marks the elided spans so the loss is visible (§10 rule 4)', () => {
    const out = reduceChunk({ raw: buried }, ctx({ query: 'SECRET_PRICE' }));
    expect(out).toMatch(/elided/);
  });

  it('without a query, keeps the LEADING spans in document order', () => {
    const out = reduceChunk({ raw: buried }, ctx());
    // The head of the text survives; a trailing-only excerpt would not start here.
    expect(out.startsWith('the quick brown fox')).toBe(true);
  });

  it('a single unsplittable unit is hard-truncated to the budget', () => {
    // Under the default 800-char chunk size a 200-char blob is one chunk, so the
    // reducer falls to `truncateToTokens` — the single-chunk path.
    const oneChunk = 'x'.repeat(200);
    const out = reduceChunk({ raw: oneChunk }, { budgetTokens: 30, tokenizer: tok });
    expect(tok.count(out)).toBeLessThanOrEqual(30);
    expect(out).toContain('elided');
  });

  it('fuses a vector ranking with BM25 via RRF (the ensemble arm)', () => {
    // Supplying a vectorRanking never throws and still returns a budget-fitting
    // excerpt (here BM25 has no lexical hit, so fusion falls to document order).
    const withVec = reduceChunk({ raw: buried }, ctx({ query: 'zzz', vectorRanking: [] }));
    expect(tok.count(withVec)).toBeLessThanOrEqual(60);
  });

  it('an empty budget yields nothing', () => {
    expect(reduceChunk({ raw: buried }, ctx({ budgetTokens: 0 }))).toBe('');
  });
});

describe('reduceSummarize — the gist reducer', () => {
  it('folds to the latched summary, clamped to budget', () => {
    const out = reduceSummarize({ raw: buried, summary: 'A short gist of the change.' }, ctx());
    expect(out).toContain('gist');
    expect(tok.count(out)).toBeLessThanOrEqual(40);
  });

  it('falls back to chunk when no summary has latched yet', () => {
    const out = reduceSummarize({ raw: buried }, ctx({ query: 'SECRET_PRICE' }));
    expect(out).toContain('SECRET_PRICE'); // chunk behaviour, not an empty gist
  });

  it('clamps an oversized summary to the budget', () => {
    const bigSummary = filler.repeat(10);
    const out = reduceSummarize({ raw: buried, summary: bigSummary }, ctx({ budgetTokens: 20 }));
    expect(tok.count(out)).toBeLessThanOrEqual(20);
  });
});

describe('resolveReducer', () => {
  it('defaults to chunk (detail-preserving)', () => {
    expect(DEFAULT_REDUCER).toBe('chunk');
    expect(resolveReducer()).toBe(reduceChunk);
  });

  it('resolves names and passes functions through', () => {
    expect(resolveReducer('summarize')).toBe(reduceSummarize);
    const custom = (): string => 'x';
    expect(resolveReducer(custom)).toBe(custom);
  });
});
