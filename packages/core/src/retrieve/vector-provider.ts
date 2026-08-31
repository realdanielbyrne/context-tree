/**
 * `VectorProvider` (§9.1) — the tree itself as a retrieval backend.
 *
 * §9.1 calls it "always available; the v1 default", and that holds literally
 * here: with no embedder and an empty L3, `TreeRetriever.search` still answers
 * on the §9 beam path, so the capability probe can never fail. Every other
 * provider in that table talks to an external index and must degrade on a
 * failed probe; this one is the floor those degrade to.
 */
import type { Candidate, Content, RetrievalProvider, SearchQuery } from '../contracts/index.js';
import { ContextTreeError } from '../contracts/index.js';
import type { SummaryHit } from './types.js';
import type { TreeRetriever } from './retriever.js';

const PROVIDER_ID = 'vector';
/** Enough of a summary to judge relevance without a `context_fetch`. */
const SNIPPET_CHARS = 240;
/** Cap for the un-summarized case, where hydrate falls back to a raw excerpt. */
const HYDRATE_PEEK_CHARS = 2_000;

function toCandidate(hit: SummaryHit): Candidate {
  // `path`/`span` are only set for file nodes with a matching §8 pointer, so the
  // §9.1 merge's dedup key (path, span) never sees a half-populated pair.
  const file = hit.path === undefined ? undefined : hit.meta?.files.find((entry) => entry.path === hit.path);
  return {
    node_id: hit.nodeId,
    path: hit.path,
    span: file === undefined ? undefined : { start_line: file.start_line, end_line: file.end_line },
    symbol: hit.meta?.symbols[0],
    score: hit.score,
    provider: PROVIDER_ID,
    tier: 'fuzzy',
    snippet: hit.text.slice(0, SNIPPET_CHARS),
  };
}

export function createVectorProvider(retriever: TreeRetriever): RetrievalProvider {
  return {
    id: PROVIDER_ID,
    tier: 'fuzzy',

    async available(): Promise<boolean> {
      return true;
    },

    async search(query: SearchQuery): Promise<Candidate[]> {
      // `mode: 'exhaustive'` is grep's (§9.1) — a vector/lexical ranking has no
      // exhaustive form, so it answers ranked either way rather than pretending.
      const result = await retriever.search(query.query, { kind: query.kind, limit: query.limit });
      return result.hits.map(toCandidate);
    },

    async hydrate(ref: Candidate): Promise<Content> {
      const nodeId = ref.node_id;
      if (nodeId === undefined) {
        throw new ContextTreeError(
          'vector candidates are tree nodes; hydrate needs node_id',
          'E_RETRIEVE_CANDIDATE',
        );
      }
      const branch = retriever.fetchBranch(nodeId, { depth: 'summary' });
      if (branch.summaryVersion > 0) {
        return { text: branch.text, path: branch.file, provider: PROVIDER_ID, truncated: false };
      }
      // Not summarized yet (§8 summarizes async after phase close). A capped raw
      // excerpt is the honest answer; the agent escalates with context_fetch.
      const text = retriever.peek(nodeId, HYDRATE_PEEK_CHARS);
      return { text, path: branch.file, provider: PROVIDER_ID, truncated: text.length >= HYDRATE_PEEK_CHARS };
    },
  };
}
