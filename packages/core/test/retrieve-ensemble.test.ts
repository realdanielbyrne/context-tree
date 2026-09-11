import { describe, it, expect } from 'vitest';
import { splitText, chunkUnits, DEFAULT_CHUNK_SIZE } from '../src/retrieve/chunk.js';
import { BM25, tokenize } from '../src/retrieve/bm25.js';
import { reciprocalRankFusion } from '../src/retrieve/rrf.js';
import { ensembleRetrieve } from '../src/retrieve/ensemble.js';

describe('splitText (recursive character splitter)', () => {
  it('empty / whitespace-free short text', () => {
    expect(splitText('')).toEqual([]);
    expect(splitText('short', { chunkSize: 800 })).toEqual(['short']);
  });

  it('splits long text into chunks near the size limit with overlap, losing no content', () => {
    const para = Array.from({ length: 60 }, (_, i) => `sentence number ${i} has some words`).join('. ');
    const chunks = splitText(para, { chunkSize: 200, chunkOverlap: 40 });
    expect(chunks.length).toBeGreaterThan(1);
    // no chunk wildly exceeds the size (a single unbreakable token could, but this text breaks on spaces)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(200 + 40);
    // every source word appears in at least one chunk
    const joined = chunks.join(' ');
    for (const w of ['sentence', 'number', '59', 'words']) expect(joined).toContain(w);
  });

  it('consecutive chunks overlap', () => {
    const text = Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ');
    const chunks = splitText(text, { chunkSize: 30, chunkOverlap: 12 });
    expect(chunks.length).toBeGreaterThan(1);
    // the tail of chunk i shares at least one token with the head of chunk i+1
    for (let i = 0; i + 1 < chunks.length; i += 1) {
      const tail = new Set(chunks[i]!.split(' ').slice(-3));
      const head = chunks[i + 1]!.split(' ').slice(0, 3);
      expect(head.some((t) => tail.has(t))).toBe(true);
    }
  });

  it('rejects nonsensical params', () => {
    expect(() => splitText('x', { chunkSize: 0 })).toThrow();
    expect(() => splitText('x', { chunkSize: 10, chunkOverlap: 10 })).toThrow();
  });

  it('chunkUnits tags each chunk with its unit and a global index', () => {
    const chunks = chunkUnits(
      [
        { id: 'a', text: 'alpha beta' },
        { id: 'b', text: 'gamma delta' },
      ],
      { chunkSize: DEFAULT_CHUNK_SIZE },
    );
    expect(chunks.map((c) => c.unitId)).toEqual(['a', 'b']);
    expect(chunks.map((c) => c.index)).toEqual([0, 1]);
  });
});

describe('BM25', () => {
  const corpus = [
    { id: 'd0', text: 'the retry policy backs off on error' },
    { id: 'd1', text: 'the cache prefix invalidates on change' },
    { id: 'd2', text: 'the segmenter maps tool names to phases' },
  ];

  it('ranks the document containing the query terms first', () => {
    const bm25 = new BM25(corpus);
    const r = bm25.search('retry error backoff');
    expect(r[0]!.id).toBe('d0');
  });

  it('only returns docs with a positive score', () => {
    const bm25 = new BM25(corpus);
    const r = bm25.search('retry');
    expect(r.every((s) => s.score > 0)).toBe(true);
    expect(r.map((s) => s.id)).toEqual(['d0']);
  });

  it('tokenize lowercases and drops 1-char tokens', () => {
    expect(tokenize('A Cache-Prefix x9')).toEqual(['cache', 'prefix', 'x9']);
  });
});

describe('reciprocalRankFusion', () => {
  it('a doc ranked highly in BOTH lists beats one ranked highly in only one', () => {
    const a = ['x', 'y', 'z'];
    const b = ['x', 'w', 'y'];
    const fused = reciprocalRankFusion([a, b]);
    expect(fused[0]!.id).toBe('x'); // top of both
  });

  it('handles disjoint coverage (a doc in only one list still scores)', () => {
    const fused = reciprocalRankFusion([['a'], ['b']]);
    const ids = fused.map((f) => f.id).sort();
    expect(ids).toEqual(['a', 'b']);
    // equal single-list rank-1 → equal score
    expect(fused[0]!.score).toBeCloseTo(fused[1]!.score, 10);
  });
});

// Deterministic bag-of-words embedder so the vector arm is meaningful without a model.
const VOCAB = ['retry', 'error', 'cache', 'prefix', 'segment', 'phase', 'price', 'widget'];
const fakeEmbed = async (texts: readonly string[]): Promise<Float32Array[]> =>
  texts.map((t) => {
    const low = t.toLowerCase();
    return Float32Array.from(VOCAB.map((w) => (low.split(w).length - 1)));
  });

describe('ensembleRetrieve', () => {
  const units = [
    { id: 'u_retry', text: 'the retry policy backs off on error and retries the request' },
    { id: 'u_cache', text: 'the cache prefix invalidates everything after the first changed byte' },
    { id: 'u_price', text: 'the widget unit price is forty two dollars per unit' },
  ];

  it('returns the unit matching the query first, as a whole unit', async () => {
    const r = await ensembleRetrieve('retry on error', units, fakeEmbed);
    expect(r[0]!.unitId).toBe('u_retry');
    expect(r.map((x) => x.unitId).sort()).toEqual(['u_cache', 'u_price', 'u_retry']);
  });

  it('finds a lexical-only match the embedder vocab does not cover', async () => {
    // "dollars" is not in VOCAB, so only BM25 can surface u_price — the ensemble still finds it.
    const r = await ensembleRetrieve('dollars per unit', units, fakeEmbed, { topK: 1 });
    expect(r[0]!.unitId).toBe('u_price');
  });

  it('respects topK and returns [] on an empty corpus', async () => {
    expect(await ensembleRetrieve('anything', [], fakeEmbed)).toEqual([]);
    const r = await ensembleRetrieve('cache prefix', units, fakeEmbed, { topK: 1 });
    expect(r).toHaveLength(1);
  });

  it('returns an excerpt (the best-matching chunk text) with each unit', async () => {
    const r = await ensembleRetrieve('retry on error', units, fakeEmbed, { topK: 1 });
    expect(typeof r[0]!.excerpt).toBe('string');
    expect(r[0]!.excerpt).toContain('retry');
  });

  it('degrades to BM25-only when no embedder is supplied', async () => {
    const r = await ensembleRetrieve('retry on error', units); // no embedder
    expect(r[0]!.unitId).toBe('u_retry');
    expect(typeof r[0]!.excerpt).toBe('string');
  });

  it('rejects a negative topK instead of returning almost everything', async () => {
    await expect(ensembleRetrieve('cache', units, fakeEmbed, { topK: -1 })).rejects.toThrow();
  });

  it('throws on a malformed embedder (wrong vector count)', async () => {
    const badEmbed = async (texts: readonly string[]): Promise<Float32Array[]> =>
      texts.slice(1).map(() => Float32Array.from([1])); // one short
    await expect(ensembleRetrieve('cache', units, badEmbed)).rejects.toThrow();
  });
});

describe('retrieval param validation', () => {
  it('whitespace-only text yields no chunks (not a blank chunk)', () => {
    expect(splitText('   \n  ')).toEqual([]);
  });
  it('rejects invalid BM25 / RRF params', () => {
    expect(() => new BM25([], -1)).toThrow();
    expect(() => new BM25([], 1.2, 2)).toThrow(); // b out of [0,1]
    expect(() => reciprocalRankFusion([['a']], -5)).toThrow();
  });
});
