/**
 * ⚠️ SUPERSEDED (the IDF ranker) — pending removal. `lexicalScore` (IDF-weighted
 * term overlap) was TESTED-AND-LOST to BM25 (`reports/metrics/rung-0e-retrievers/
 * report-isolation.md`); the canonical lexical ranker is now `retrieve/bm25.ts`.
 * `extractFingerprints` here is still reusable scaffolding. Removed with the
 * retrieval swap — see `reports/session-handoff.md`.
 *
 * Deterministic lexical scoring for the §9 beam-search fallback.
 *
 * §9 mandates a fallback for "L3 is absent", and L3 is absent for most of CI:
 * a hard dependency on an embedding key would make `search` useless
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

// Patterns for extracting distinctive fingerprints from raw event text.
const FILE_PATH_PATTERN = /(?:[\w.-]+\/)+[\w.-]+\.\w+/g;
const CAMEL_PATTERN = /\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/g;
const PASCAL_PATTERN = /\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g;
const UPPER_SNAKE_PATTERN = /\b[A-Z][A-Z0-9_]{2,}\b/g;
const DOTTED_PATTERN = /\b[a-z]\w*(?:\.[a-z]\w*)+\b/g;
const BACKTICK_PATTERN = /`([^`]+)`/g;

/**
 * Extract distinctive fingerprints (file paths, identifiers, symbols) from
 * raw text. These are the specific, low-frequency tokens that uniquely
 * identify a branch's content — the signal TF-IDF over summary prose misses.
 */
export function extractFingerprints(text: string): Set<string> {
  const fps = new Set<string>();
  for (const m of text.matchAll(FILE_PATH_PATTERN)) fps.add(m[0]);
  for (const m of text.matchAll(CAMEL_PATTERN)) fps.add(m[0]);
  for (const m of text.matchAll(PASCAL_PATTERN)) fps.add(m[0]);
  for (const m of text.matchAll(UPPER_SNAKE_PATTERN)) fps.add(m[0]);
  for (const m of text.matchAll(DOTTED_PATTERN)) fps.add(m[0]);
  for (const m of text.matchAll(BACKTICK_PATTERN)) { if (m[1] !== undefined) fps.add(m[1]); }
  return fps;
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
 *
 * When `fingerprints` are provided (extracted from raw events), they are
 * appended so the index covers the specific identifiers summaries omit.
 */
export function summaryDocument(node: TreeNode, summary: NodeSummary | null, fingerprints?: Set<string>): string {
  const parts: string[] = [node.title];
  const nodePath = node.meta_json.path;
  if (typeof nodePath === 'string') parts.push(nodePath);
  if (summary !== null) {
    parts.push(summary.text);
    for (const file of summary.meta.files) parts.push(file.symbol === undefined ? file.path : `${file.path} ${file.symbol}`);
    for (const symbol of summary.meta.symbols) parts.push(symbol);
  }
  if (fingerprints !== undefined && fingerprints.size > 0) {
    parts.push([...fingerprints].join(' '));
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
