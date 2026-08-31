/**
 * §8 summary content contract — the rehydration-pointer requirement.
 *
 * `parseSummaryResponse` (prompts/) already rejects a reply with a missing or
 * mistyped field. What it cannot check is whether the reply is *about this
 * branch*: that needs the tree. Two things are checked here, and both are the
 * difference between a pointer and a guess —
 *
 *  - `meta.node_ids` must name every child branch this summary covers. Those
 *    ids are the §9 fetch targets; a summary that omits one hides a branch.
 *  - every `meta.files[].path` must be a path the tree says this branch
 *    touched. §9 calls these spans verifiable (D9); a path from outside the
 *    branch is a hallucination, and one of those makes every span suspect.
 */
import type { NodeId, SummaryMeta } from '../contracts/index.js';
import type { BranchFacts } from './detail.js';

export interface ContractExpectation {
  /** Child branches this summary covers — the ids the reply must name. */
  childIds: readonly NodeId[];
  /** Paths the tree recorded under this branch. */
  paths: ReadonlySet<string>;
}

/** The violation, phrased for the retry prompt, or null when the reply is honest. */
export function contractViolation(meta: SummaryMeta, expected: ContractExpectation): string | null {
  const named = new Set(meta.node_ids);
  const missing = expected.childIds.filter((id) => !named.has(id));
  if (missing.length > 0) {
    return `meta.node_ids omits child branch id(s) ${missing.join(', ')}. It must list every node id given above, so a reader knows which branches to fetch.`;
  }
  const unknown = [...new Set(meta.files.filter((file) => !expected.paths.has(file.path)).map((f) => f.path))];
  if (unknown.length > 0) {
    return `meta.files names path(s) this branch never touched: ${unknown.join(', ')}. Report only the files listed under BRANCH COORDINATES.`;
  }
  return null;
}

/**
 * The row that gets stored: prose, decisions, open questions, tests and
 * artifacts from the model; files, symbols and node ids from the tree.
 *
 * The split is not defensive tidying — it is D9. Spans are the coordinates
 * `context_fetch` resolves, so they may only ever come from tree-sitter's
 * output, never from the summarizer's reply.
 */
export function summaryMetaFrom(
  reply: SummaryMeta,
  facts: BranchFacts,
  nodeIds: readonly NodeId[],
): SummaryMeta {
  return {
    files: facts.spans,
    symbols: facts.symbols,
    tests: reply.tests,
    artifacts: reply.artifacts,
    open_questions: reply.open_questions,
    decisions: reply.decisions,
    node_ids: [...nodeIds],
  };
}
