/**
 * Deterministic Zone B root: compose the root summary from the leaf summaries
 * with a pure function instead of an LLM call.
 *
 * Zone B already carries every leaf summary verbatim in creation order, so the
 * root's LLM synthesis was mostly redundant prose bought at the strong-model
 * rate on every phase close (measured: the root share of the §8 summarizer
 * bucket, ~$0.035/run median on sw-2-multimod, plus the entire truncation-retry
 * failure mode). The root here is an index, not an essay: the task title, one
 * headline per closed branch, and the merged open questions.
 *
 * Byte-stability is the cache contract: when the composed text matches the
 * current root summary exactly, NO new version is written — Zone B's root block
 * only churns when a leaf actually changed, which is what keeps the Zone B
 * prefix cache-stable across phase closes (D5).
 */
import type { NodeId, NodeSummary, SummaryMeta, TreeStore } from '../contracts/index.js';
import { summaryMetaFrom } from './contract.js';
import { branchFacts } from './detail.js';

/** The `model` stamped on composed root rows — an audit marker, not an LLM id. */
export const DETERMINISTIC_ROOT_MODEL = 'deterministic-rollup-v1';

const HEADLINE_MAX_CHARS = 200;

/** First line (or sentence) of a leaf summary, capped — the branch's one-line index entry. */
function headline(text: string): string {
  const firstLine = text.split('\n', 1)[0] ?? '';
  const firstSentence = /^.*?[.!?](?=\s|$)/.exec(firstLine)?.[0] ?? firstLine;
  return firstSentence.slice(0, HEADLINE_MAX_CHARS);
}

function mergedMeta(children: readonly NodeSummary[]): SummaryMeta {
  const dedupe = <T>(values: readonly T[]): T[] => {
    const seen = new Set<string>();
    const kept: T[] = [];
    for (const value of values) {
      const key = JSON.stringify(value);
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(value);
    }
    return kept;
  };
  return {
    // files/symbols are overwritten from the tree by summaryMetaFrom (D9).
    files: [],
    symbols: [],
    tests: dedupe(children.flatMap((child) => child.meta.tests)),
    artifacts: dedupe(children.flatMap((child) => child.meta.artifacts)),
    open_questions: dedupe(children.flatMap((child) => child.meta.open_questions)),
    decisions: dedupe(children.flatMap((child) => child.meta.decisions)),
    node_ids: [],
  };
}

/**
 * Compose and store the root summary from the current leaf summaries.
 *
 * Returns the stored summary, or `null` when there is nothing to do: no child
 * has a summary yet (nothing to index), or the composed text is byte-identical
 * to the current root summary (no new version — see the cache contract above).
 */
export function composeRootSummary(store: TreeStore, rootId: NodeId, now?: () => string): NodeSummary | null {
  const root = store.getNode(rootId);
  if (root === null) throw new Error(`composeRootSummary: unknown node ${rootId}`);
  const covered: { id: NodeId; summary: NodeSummary }[] = [];
  for (const child of store.children(rootId)) {
    const summary = store.currentSummary(child.id);
    if (summary !== null) covered.push({ id: child.id, summary });
  }
  if (covered.length === 0) return null;

  const lines = covered.map(({ summary }) => `- ${headline(summary.text)}`);
  const open = [...new Set(covered.flatMap(({ summary }) => summary.meta.open_questions))];
  const text = [root.title, ...lines, ...(open.length > 0 ? [`open: ${open.join('; ')}`] : [])].join('\n');
  if (text === store.currentSummary(rootId)?.text) return null;

  const childIds = covered.map(({ id }) => id);
  return store.putSummary({
    node_id: rootId,
    model: DETERMINISTIC_ROOT_MODEL,
    text,
    meta: summaryMetaFrom(mergedMeta(covered.map(({ summary }) => summary)), branchFacts(store, root), [
      rootId,
      ...childIds,
    ]),
    ...(now !== undefined ? { created_at: now() } : {}),
  });
}
