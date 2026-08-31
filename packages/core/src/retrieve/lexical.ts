/**
 * Deterministic lexical scoring for the §9 beam-search fallback.
 *
 * §9 mandates a fallback for "L3 is absent", and L3 is absent for most of CI:
 * a hard dependency on an embedding key would make `context_search` useless
 * offline. So scoring here is IDF-weighted term overlap over summary text —
 * no embeddings, no network, no state — which keeps the beam path a pure
 * function of L1 and therefore bit-identical across runs (D8).
 */
import type { NodeSummary, TreeNode } from '../contracts/index.js';

/** Case-folded alphanumeric runs. `_` is kept so `snake_case` symbols survive. */
const TERM_PATTERN = /[a-z0-9_]+/g;

/** Saturating tf so a term repeated 20× cannot outweigh covering a second term. */
function tfWeight(count: number): number {
  return 1 + Math.log(count);
}

export function terms(text: string): string[] {
  return text.toLowerCase().match(TERM_PATTERN) ?? [];
}

export function uniqueTerms(text: string): string[] {
  return [...new Set(terms(text))];
}

function termFrequency(text: string): Map<string, number> {
  const tf = new Map<string, number>();
  for (const term of terms(text)) tf.set(term, (tf.get(term) ?? 0) + 1);
  return tf;
}

/**
 * The document text for one node — the SAME string the vector path embeds, so
 * the two mechanisms in §15's eval rank identical content and only the scoring
 * function differs.
 *
 * Title and the §8 rehydration pointers (file paths, symbols) are part of the
 * document because they are what a query actually names ("the pricing.go
 * change"), and §8 guarantees every summary carries them. A node with no
 * summary yet still scores on its title rather than dropping out of the tree.
 */
export function summaryDocument(node: TreeNode, summary: NodeSummary | null): string {
  const parts: string[] = [node.title];
  const nodePath = node.meta_json.path;
  if (typeof nodePath === 'string') parts.push(nodePath);
  if (summary !== null) {
    parts.push(summary.text);
    for (const file of summary.meta.files) parts.push(file.symbol === undefined ? file.path : `${file.path} ${file.symbol}`);
    for (const symbol of summary.meta.symbols) parts.push(symbol);
  }
  return parts.join('\n');
}

export interface LexicalIndex {
  readonly docCount: number;
  /** Inverse document frequency; a term in no document scores as maximally rare. */
  idf(term: string): number;
}

export function buildLexicalIndex(documents: readonly string[]): LexicalIndex {
  const df = new Map<string, number>();
  for (const document of documents) {
    for (const term of new Set(terms(document))) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const docCount = documents.length;
  return {
    docCount,
    idf(term: string): number {
      return Math.log(1 + docCount / (1 + (df.get(term) ?? 0)));
    },
  };
}

/**
 * IDF-weighted coverage of the query by the document, normalized to [0, ~1] by
 * the query's own IDF mass so scores are comparable across queries. Summation
 * runs over `queryTerms` in the caller's order, which is what makes the beam's
 * float arithmetic reproducible run to run.
 */
export function lexicalScore(index: LexicalIndex, queryTerms: readonly string[], document: string): number {
  const tf = termFrequency(document);
  let matched = 0;
  let mass = 0;
  for (const term of queryTerms) {
    const idf = index.idf(term);
    mass += idf;
    const count = tf.get(term);
    if (count !== undefined) matched += idf * tfWeight(count);
  }
  return mass === 0 ? 0 : matched / mass;
}
