/**
 * BM25 lexical ranker over the chunk corpus (spec stage 3). Replaces the
 * tested-and-lost IDF term-overlap ranker (`lexical.ts`): BM25 beat plain
 * IDF-beam directionally (`reports/metrics/rung-0e-retrievers/report-isolation.md`).
 * Standard Okapi BM25 with the non-negative idf variant (BM25+), so a term in
 * most documents never contributes a negative score.
 */
export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

/** Lowercase alphanumeric tokens of length ≥ 2. */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 2);
}

interface BM25Doc {
  id: string;
  tf: Map<string, number>;
  len: number;
}

export interface Scored {
  id: string;
  score: number;
}

export class BM25 {
  private readonly docs: BM25Doc[] = [];
  private readonly df = new Map<string, number>();
  private readonly avgdl: number;

  constructor(
    corpus: readonly { id: string; text: string }[],
    private readonly k1: number = BM25_K1,
    private readonly b: number = BM25_B,
  ) {
    let totalLen = 0;
    for (const { id, text } of corpus) {
      const tokens = tokenize(text);
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      this.docs.push({ id, tf, len: tokens.length });
      totalLen += tokens.length;
    }
    this.avgdl = this.docs.length > 0 ? totalLen / this.docs.length : 0;
  }

  private idf(term: string): number {
    const df = this.df.get(term) ?? 0;
    const n = this.docs.length;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  /** Ranked docs with score > 0, highest first. */
  search(query: string): Scored[] {
    const qTokens = [...new Set(tokenize(query))];
    const avgdl = this.avgdl || 1;
    const scored: Scored[] = [];
    for (const d of this.docs) {
      let score = 0;
      for (const t of qTokens) {
        const f = d.tf.get(t);
        if (f === undefined) continue;
        const idf = this.idf(t);
        score += (idf * (f * (this.k1 + 1))) / (f + this.k1 * (1 - this.b + (this.b * d.len) / avgdl));
      }
      if (score > 0) scored.push({ id: d.id, score });
    }
    return scored.sort((a, b) => b.score - a.score);
  }
}
