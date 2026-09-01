/**
 * §8 summary content contract — the rehydration-pointer requirement.
 *
 * The contract is enforced exactly where the model is the source of truth, and
 * nowhere else. `parseSummaryResponse` (prompts/) rejects a reply with a
 * missing or mistyped field; `contractViolation` adds the one check that needs
 * the tree: whether the reply is *about this branch*.
 *
 * `meta.node_ids` must name every child branch this summary covers. Those ids
 * are the §9 fetch targets; a summary that omits one hides a branch, and the
 * prompt hands the model the exact list to echo, so a miss is the model not
 * having read the branch it was asked about.
 *
 * What is deliberately NOT checked is the *contents* of `meta.files` and
 * `meta.symbols`. `summaryMetaFrom` overwrites both from the tree (D9: spans
 * come from tree-sitter, never from a model), so validating them fails whole
 * branches over values the system discards — observed live, `claude-haiku-4.5`
 * broke that sub-contract on 3 of 3 runs (missing `start_line`, an empty
 * `symbol`, a path outside the branch), and the retry did not recover it. A
 * branch that goes unsummarized is a branch §9's reader can never ask about,
 * which is a far worse failure than a field nobody reads being wrong.
 */
import type { NodeId, SummaryMeta } from '../contracts/index.js';
import { parseSummaryResponse } from '../prompts/index.js';
import type { BranchFacts } from './detail.js';

export interface ContractExpectation {
  /** Child branches this summary covers — the ids the reply must name. */
  childIds: readonly NodeId[];
}

/** The violation, phrased for the retry prompt, or null when the reply is honest. */
export function contractViolation(meta: SummaryMeta, expected: ContractExpectation): string | null {
  const named = new Set(meta.node_ids);
  const missing = expected.childIds.filter((id) => !named.has(id));
  if (missing.length > 0) {
    return `meta.node_ids omits child branch id(s) ${missing.join(', ')}. It must list every node id given above, so a reader knows which branches to fetch.`;
  }
  return null;
}

/**
 * Parses a summarizer reply for the §8 contract, strictly on every field the
 * model owns and leniently on the two the tree overrides.
 *
 * Presence and array-ness of `files`/`symbols` are still the model's job — an
 * absent or mistyped field means the reply did not answer the question asked,
 * and `parseSummaryResponse` still fails it. Only the array *elements* are
 * dropped, and only because `summaryMetaFrom` replaces them wholesale two lines
 * later (D9).
 */
export function parseSummaryReply(raw: string): { text: string; meta: SummaryMeta } {
  return parseSummaryResponse(dropTreeOwnedContents(raw));
}

/** The `SummaryMeta` fields `summaryMetaFrom` takes from the tree, not the reply. */
const TREE_OWNED_FIELDS = ['files', 'symbols'] as const;

function dropTreeOwnedContents(raw: string): string {
  const root = asJsonObject(raw);
  if (root === null) return raw;
  const meta = root.meta;
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return raw;
  const fields = meta as Record<string, unknown>;
  let changed = false;
  for (const field of TREE_OWNED_FIELDS) {
    const value = fields[field];
    if (Array.isArray(value) && value.length > 0) {
      fields[field] = [];
      changed = true;
    }
  }
  // Untouched when there was nothing to drop, so a reply that fails the strict
  // parse fails on the text the model actually sent.
  return changed ? JSON.stringify(root) : raw;
}

const JSON_FENCE = /```(?:json)?[ \t]*\r?\n([\s\S]*?)```/;

/**
 * Finds the object `parseSummaryResponse` will read, tolerating the same fences
 * and prose it does. A miss is not an error here: the raw reply is handed back
 * untouched and the strict parser owns the diagnosis, so this never invents a
 * failure mode of its own.
 */
function asJsonObject(raw: string): Record<string, unknown> | null {
  const open = raw.indexOf('{');
  const close = raw.lastIndexOf('}');
  const candidates = [
    raw.trim(),
    JSON_FENCE.exec(raw)?.[1],
    open >= 0 && close > open ? raw.slice(open, close + 1) : undefined,
  ];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Next shape.
    }
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
