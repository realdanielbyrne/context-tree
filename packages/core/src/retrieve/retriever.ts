/**
 * §9 tree-side read paths: collapsed-tree (RAPTOR) retrieval, the beam-search
 * fallback, and the two expansion tools.
 *
 * Everything here is synchronous except the paths that must await an injected
 * embedder — L1/L2/L0 are all synchronous (`better-sqlite3`, `fs`), so the
 * read side keeps the same single execution model as ingestion (§7.1).
 *
 * §19 Q2 is decided: search covers SUMMARIES ONLY, never raw turns. Raw turns
 * are reachable only by an explicit `context_fetch` / `context_peek` on a node
 * a summary pointed at.
 */
import type {
  BlobStore,
  NodeId,
  NodeSummary,
  TraceLog,
  TreeNode,
  TreeStore,
} from '../contracts/index.js';
import { ContextTreeError, StoreInvariantError } from '../contracts/index.js';
import { clampSpans, mergeSpans, nodeSpan, payloadRef, renderIndex, renderSpans } from './detail.js';
import { buildLexicalIndex, lexicalScore, summaryDocument, uniqueTerms } from './lexical.js';
import type {
  EmbedSummariesResult,
  FetchBranchOptions,
  FetchedBranch,
  SummaryEmbedder,
  SummaryHit,
  TreeSearchOptions,
  TreeSearchResult,
} from './types.js';

export interface TreeRetrieverDeps {
  store: TreeStore;
  blobs: BlobStore;
  /**
   * L0 reader. Optional because the summary-side paths (`search`,
   * `fetchBranch` at depth `summary`) need L1 alone — but `depth: 'full'` and
   * `peek` are L0 replays and throw loudly without it rather than returning a
   * plausible-looking empty excerpt.
   */
  trace?: TraceLog;
  /** Absent means L3 is never written and `search` uses the beam path (§9). */
  embed?: SummaryEmbedder;
}

const DEFAULT_LIMIT = 8;
const DEFAULT_PEEK_CHARS = 800;

/**
 * `knn` cannot filter by node kind, so a `kind`-scoped query over-fetches and
 * filters after. Bounded (not unbounded) because a collapsed tree is small and
 * a kind that is absent from the top 4·limit is not the answer anyway.
 */
const KIND_OVERFETCH = 4;

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.floor(limit));
}

export class TreeRetriever {
  private readonly store: TreeStore;
  private readonly blobs: BlobStore;
  private readonly trace: TraceLog | undefined;
  private readonly embed: SummaryEmbedder | undefined;

  constructor(deps: TreeRetrieverDeps) {
    this.store = deps.store;
    this.blobs = deps.blobs;
    this.trace = deps.trace;
    this.embed = deps.embed;
  }

  /**
   * `context_search`. Vector path when L3 can answer, beam otherwise, and the
   * result says which ran so §15's eval attributes recall to the mechanism
   * that earned it.
   */
  async search(query: string, options: TreeSearchOptions = {}): Promise<TreeSearchResult> {
    if (this.embed === undefined) return { ...this.beamSearch(query, options), fallback: 'no-embedder' };
    if (this.store.embeddingDim() === null) return { ...this.beamSearch(query, options), fallback: 'no-embeddings' };
    return this.searchSummaries(query, options);
  }

  /**
   * Collapsed-tree retrieval (RAPTOR, arXiv:2401.18059): one flat knn over
   * node-summary vectors at every level, so a leaf and the root compete on the
   * same ranking instead of the query walking down a hierarchy.
   */
  async searchSummaries(query: string, options: TreeSearchOptions = {}): Promise<TreeSearchResult> {
    const embed = this.embed;
    if (embed === undefined) {
      throw new ContextTreeError(
        'searchSummaries needs an injected embedder; call search() for the §9 beam fallback',
        'E_RETRIEVE_NO_EMBEDDER',
      );
    }
    const limit = normalizeLimit(options.limit);
    const vectors = await embed([query]);
    const vec = vectors[0];
    if (vec === undefined) {
      throw new ContextTreeError('embedder returned no vector for the query', 'E_RETRIEVE_EMBED_SHAPE');
    }

    const hits: SummaryHit[] = [];
    const seen = new Set<NodeId>();
    for (const hit of this.store.knn(vec, options.kind === undefined ? limit : limit * KIND_OVERFETCH)) {
      if (hits.length >= limit) break;
      if (seen.has(hit.node_id)) continue;
      const node = this.store.getNode(hit.node_id);
      // L3 is disposable (D8): a row may outlive the node it was built for.
      if (node === null) continue;
      if (options.kind !== undefined && node.kind !== options.kind) continue;
      seen.add(hit.node_id);
      // Report the version that actually matched, not the newest one (D3): the
      // vector was built from THAT text, so quoting a later version would
      // misreport what the ranking is based on.
      const summary = this.store.summaryVersion(node.id, hit.version) ?? this.store.currentSummary(node.id);
      // knn returns cosine distance; flip it so higher is better everywhere.
      hits.push(toHit(node, summary, 1 - hit.distance));
    }
    return { hits, path: 'vector' };
  }

  /**
   * Top-down beam search over summary TEXT — the fallback §9 mandates when L3
   * is absent. Needs no embedder and no network, which is the point: offline
   * (i.e. CI) `context_search` still answers.
   *
   * Only the top-`beamWidth` nodes of each level are expanded; the rest of the
   * level is still scored and rankable, but its subtree is never visited. That
   * pruning is the cost model — O(width · depth) documents, not O(nodes).
   */
  beamSearch(query: string, options: TreeSearchOptions = {}): TreeSearchResult {
    const limit = normalizeLimit(options.limit);
    const beamWidth = options.beamWidth === undefined ? limit : Math.max(1, Math.floor(options.beamWidth));

    const nodes = this.store.nodesInCreationOrder();
    const documents = new Map<NodeId, string>();
    const summaries = new Map<NodeId, NodeSummary | null>();
    const childrenOf = new Map<NodeId | null, TreeNode[]>();
    const ordinal = new Map<NodeId, number>();
    nodes.forEach((node, index) => {
      const summary = this.store.currentSummary(node.id);
      summaries.set(node.id, summary);
      documents.set(node.id, summaryDocument(node, summary));
      ordinal.set(node.id, index);
      const siblings = childrenOf.get(node.parent_id);
      if (siblings === undefined) childrenOf.set(node.parent_id, [node]);
      else siblings.push(node);
    });

    // IDF corpus = every node document. One pass over L1, zero LLM calls.
    const index = buildLexicalIndex([...documents.values()]);
    const queryTerms = uniqueTerms(query);
    // Ties break on creation order (Ruling C4's ordering) so two runs over one
    // L1 return byte-identical results.
    const byScore = (a: SummaryHit, b: SummaryHit): number =>
      b.score - a.score || (ordinal.get(a.nodeId) ?? 0) - (ordinal.get(b.nodeId) ?? 0);

    const scored: SummaryHit[] = [];
    let frontier = childrenOf.get(null) ?? [];
    while (frontier.length > 0) {
      const level = frontier.map((node) =>
        toHit(node, summaries.get(node.id) ?? null, lexicalScore(index, queryTerms, documents.get(node.id) ?? '')),
      );
      scored.push(...level);
      frontier = [...level]
        .sort(byScore)
        .slice(0, beamWidth)
        .flatMap((hit) => childrenOf.get(hit.nodeId) ?? []);
    }

    // The kind filter narrows the ANSWER, not the descent: file nodes are only
    // reachable through the phase nodes above them.
    const kept = options.kind === undefined ? scored : scored.filter((hit) => hit.kind === options.kind);
    return { hits: kept.sort(byScore).slice(0, limit), path: 'beam' };
  }

  /**
   * `context_fetch`. Defaults to `depth: 'full'` (R9): `depth: 'summary'` is
   * an L1 read of the §8 paraphrase, `depth: 'full'` replays the branch's L0
   * span through L2, and `depth: 'index'` lists that span's events instead of
   * reading them (R10) — a shape-before-content peek at a branch too big to
   * fetch whole. `file` narrows every depth to the file node(s) under the
   * branch keyed by that path (§10 rule 4); `from`/`to` (R10) additionally
   * narrows a `'full'`/`'index'` read to an inclusive L0 `seq` range, clamped
   * to the target span so an over-wide range is a no-op and a disjoint one
   * yields an empty result rather than a throw.
   */
  fetchBranch(nodeId: NodeId, options: FetchBranchOptions = {}): FetchedBranch {
    const branch = this.requireNode(nodeId);
    const depth = options.depth ?? 'full';
    const targets = options.file === undefined ? [branch] : this.fileNodes(branch, options.file);
    const single = targets.length === 1 ? targets[0] : undefined;
    const file = options.file ?? asPath(branch.meta_json.path);
    // The §8 rehydration pointers travel with every depth (not just `summary`):
    // a `'full'`/`'index'` read is still ABOUT this branch, and meta is what
    // lets a caller judge relevance without a second round trip.
    const summary = single === undefined ? null : this.store.currentSummary(single.id);

    const base = {
      nodeId: branch.id,
      kind: branch.kind,
      title: branch.title,
      phaseType: branch.phase_type,
      depth,
      file,
      nodes: targets.map((node) => node.id),
      summaryVersion: summary?.version ?? 0,
      meta: summary?.meta ?? null,
    };

    if (depth === 'summary') {
      return {
        ...base,
        // Several nodes only happens when one path was touched by more than one
        // phase under this branch; label them so the merge is not ambiguous.
        text:
          single !== undefined
            ? (summary?.text ?? '')
            : targets
                .map((node) => `## ${node.title}\n${this.store.currentSummary(node.id)?.text ?? ''}`)
                .join('\n\n'),
        spans: [],
        events: 0,
      };
    }

    const rawSpans = mergeSpans(
      targets.flatMap((node) => {
        const span = nodeSpan(node);
        return span === null ? [] : [span];
      }),
    );
    const spans = clampSpans(rawSpans, options.from, options.to);

    if (depth === 'index') {
      const rendered = renderIndex(this.requireTrace("fetchBranch depth:'index'"), this.blobs, spans);
      return { ...base, text: rendered.text, spans, events: rendered.events };
    }

    const rendered = renderSpans(this.requireTrace("fetchBranch depth:'full'"), this.blobs, spans);
    return { ...base, text: rendered.text, spans, events: rendered.events };
  }

  /**
   * `context_peek` — §9's "suspicion costs one small call, not a full
   * expansion". Reads RAW L0 payloads, not the summary, because rule 3 of the
   * system contract points here precisely when a summary is suspected stale.
   */
  peek(nodeId: NodeId, maxChars: number = DEFAULT_PEEK_CHARS): string {
    const node = this.requireNode(nodeId);
    if (!Number.isFinite(maxChars) || maxChars <= 0) return '';
    const cap = Math.floor(maxChars);
    const span = nodeSpan(node);
    if (span === null) return '';

    const trace = this.requireTrace('peek');
    const parts: string[] = [];
    let budget = cap;
    for (const event of trace.read({ from: span.start, to: span.end })) {
      if (budget <= 0) break;
      const ref = payloadRef(event);
      if (ref === null) continue;
      // The byte cap is the read cap: a 10MB tool output is never paged in
      // just to preview it. `budget` is bytes here; the slice below enforces
      // the caller's contract, which is characters.
      const chunk = this.blobs.getTextPrefix(ref, budget);
      if (chunk.length === 0) continue;
      parts.push(chunk);
      budget -= chunk.length;
    }
    return parts.join('\n').slice(0, cap);
  }

  /**
   * (Re)builds L3 for `nodeIds`, or for every currently summarized node.
   * Safely re-runnable: L3 is disposable (D8) and the store replaces the row
   * for a `(node, version)` pair, so a second run writes the same vectors.
   */
  async embedSummaries(nodeIds?: readonly NodeId[]): Promise<EmbedSummariesResult> {
    const targets =
      nodeIds === undefined
        ? this.store.nodesInCreationOrder().filter((node) => node.current_summary_version > 0)
        : nodeIds.map((id) => this.requireNode(id));

    if (this.embed === undefined) {
      // No embedder is a supported configuration, not an error: `search` then
      // runs the beam path forever. Say so instead of half-writing L3.
      return { embedded: [], skipped: targets.map((node) => node.id), embedderAvailable: false };
    }

    const pending: Array<{ node: TreeNode; version: number; text: string }> = [];
    const skipped: NodeId[] = [];
    for (const node of targets) {
      const summary = this.store.currentSummary(node.id);
      if (summary === null) {
        skipped.push(node.id);
        continue;
      }
      pending.push({ node, version: summary.version, text: summaryDocument(node, summary) });
    }
    if (pending.length === 0) return { embedded: [], skipped, embedderAvailable: true };

    const vectors = await this.embed(pending.map((item) => item.text));
    if (vectors.length !== pending.length) {
      throw new ContextTreeError(
        `embedder returned ${vectors.length} vectors for ${pending.length} summaries`,
        'E_RETRIEVE_EMBED_SHAPE',
      );
    }
    const embedded: NodeId[] = [];
    for (const [position, item] of pending.entries()) {
      const vec = vectors[position];
      if (vec === undefined) {
        throw new ContextTreeError(`embedder returned no vector for ${item.node.id}`, 'E_RETRIEVE_EMBED_SHAPE');
      }
      // Keyed by the summary version, so a re-summarized node gets a new row
      // rather than silently reusing a vector built from replaced text (D3).
      this.store.putEmbedding(item.node.id, item.version, vec);
      embedded.push(item.node.id);
    }
    return { embedded, skipped, embedderAvailable: true };
  }

  private requireNode(id: NodeId): TreeNode {
    const node = this.store.getNode(id);
    if (node === null) throw new StoreInvariantError(`unknown node ${id}`);
    return node;
  }

  private requireTrace(operation: string): TraceLog {
    if (this.trace === undefined) {
      throw new ContextTreeError(
        `${operation} replays L0 and needs a TraceLog; construct TreeRetriever with { trace }`,
        'E_RETRIEVE_NO_TRACE',
      );
    }
    return this.trace;
  }

  /**
   * File nodes keyed by `path` at or under `branch`, in creation order. All
   * matches, not the first: one path can be touched by several phases under a
   * root, and dropping the later ones would silently hide edits.
   */
  private fileNodes(branch: TreeNode, path: string): TreeNode[] {
    const matches: TreeNode[] = [];
    if (branch.kind === 'file' && branch.meta_json.path === path) matches.push(branch);
    for (const node of this.store.descendants(branch.id)) {
      if (node.kind === 'file' && node.meta_json.path === path) matches.push(node);
    }
    if (matches.length === 0) {
      throw new ContextTreeError(
        `no file node for ${JSON.stringify(path)} under ${branch.id}`,
        'E_RETRIEVE_NO_FILE_NODE',
      );
    }
    return matches;
  }
}

function asPath(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function toHit(node: TreeNode, summary: NodeSummary | null, score: number): SummaryHit {
  return {
    nodeId: node.id,
    kind: node.kind,
    title: node.title,
    phaseType: node.phase_type,
    path: asPath(node.meta_json.path),
    version: summary?.version ?? 0,
    text: summary?.text ?? '',
    meta: summary?.meta ?? null,
    score,
  };
}
