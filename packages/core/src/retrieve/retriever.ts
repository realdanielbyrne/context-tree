/**
 * ⚠️ PARTLY SUPERSEDED — pending removal. The SEARCH/RANK path here (ranking over
 * node SUMMARIES: `searchSummaries`, `beamSearch`, `mergeWithGrep`) was
 * TESTED-AND-LOST (`reports/metrics/ds-star-retrieval-pass-report.md`) and is
 * replaced by the RRF ensemble over L0-unit chunks (`retrieve/ensemble.ts`). The
 * L0-replay / expansion machinery (`fetchBranch`, `peek`) is VALID SCAFFOLDING and
 * survives the swap. Retiring the rank path + rewiring `search` is the
 * retrieval-swap step — see `reports/session-handoff.md`.
 *
 * §9 tree-side read paths: collapsed-tree (RAPTOR) retrieval, the beam-search
 * fallback, and the two expansion tools.
 *
 * Everything here is synchronous except the paths that must await an injected
 * embedder — L1/L2/L0 are all synchronous (`better-sqlite3`, `fs`), so the
 * read side keeps the same single execution model as ingestion (§7.1).
 *
 * §19 Q2 is decided: search covers SUMMARIES ONLY, never raw turns. Raw turns
 * are reachable only by an explicit `fetch` / `peek` on a node
 * a summary pointed at.
 */
import { excerptAround } from './excerpt.js';
import { renderEvent } from '../assemble/format.js';
import type {
  BlobStore,
  NodeId,
  NodeSummary,
  SeqSpan,
  Tokenizer,
  TraceLog,
  TreeNode,
  TreeStore,
} from '../contracts/index.js';
import { ContextTreeError, StoreInvariantError } from '../contracts/index.js';
import { HeuristicTokenizer } from '../tokens/index.js';
import { clampSpans, mergeSpans, nodeSpan, payloadRef, renderIndex, renderSpans } from './detail.js';
import { buildLexicalIndex, extractFingerprints, lexicalScore, summaryDocument, uniqueTerms } from './lexical.js';
import type {
  EmbedSummariesResult,
  EventHit,
  EventSearchOptions,
  EventSearchResult,
  FetchBranchOptions,
  FetchDiagnostic,
  FetchedBranch,
  QueryRewriter,
  RetrievalCenterFingerprintMode,
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
  /**
   * Fallback query rewriter — called once per search when regex extraction
   * finds no distinctive terms in the query. Extracts searchable phrases
   * from natural language. Optional; absent means regex-only extraction.
   */
  rewrite?: QueryRewriter;
  /**
   * Counts the tokens the narrowing band is budgeted in. Optional; absent
   * means `HeuristicTokenizer`. It exists because the band used to be sized
   * by `text.length * 0.85` — a heuristic->BPE ratio applied to CHARACTERS,
   * which overstates tokens by ~3.4x (the heuristic charges ~1 token per 4
   * characters). That made every band ~3.4x narrower than the budget allowed,
   * discarding relevant events for no reason, and left the true fit unverified
   * so an oversized band still had to be re-cut downstream.
   */
  tokenizer?: Tokenizer;
  /** Changes only query terms used inside `findRelevantCenter`; search ranking is untouched. */
  retrievalCenterFingerprintMode?: RetrievalCenterFingerprintMode;
  /** Harness-only diagnostics. Observations never alter model-visible fetch bytes. */
  observeFetch?: (diagnostic: FetchDiagnostic) => void;
}

interface CenterResult {
  centerSeq: number | null;
  terms: FetchDiagnostic['terms'];
  scores: FetchDiagnostic['scores'];
}

function emptyCenterResult(): CenterResult {
  return { centerSeq: null, terms: [], scores: [] };
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
  private readonly rewrite: QueryRewriter | undefined;
  private readonly tokenizer: Tokenizer;
  private readonly retrievalCenterFingerprintMode: RetrievalCenterFingerprintMode;
  private readonly observeFetch: ((diagnostic: FetchDiagnostic) => void) | undefined;
  private fingerprintCache: Map<NodeId, Set<string>> | null = null;

  constructor(deps: TreeRetrieverDeps) {
    this.store = deps.store;
    this.blobs = deps.blobs;
    this.trace = deps.trace;
    this.embed = deps.embed;
    this.rewrite = deps.rewrite;
    this.tokenizer = deps.tokenizer ?? new HeuristicTokenizer();
    this.retrievalCenterFingerprintMode = deps.retrievalCenterFingerprintMode ?? 'legacy';
    this.observeFetch = deps.observeFetch;
  }

  /** The injected embedder, if any — used by the RRF ensemble's vector arm at query time. */
  get embedder(): SummaryEmbedder | undefined {
    return this.embed;
  }

  /**
   * Extract fingerprints (file paths, identifiers, symbols) from raw events
   * for all phase nodes. Computed once, cached for subsequent searches.
   */
  private getFingerprints(): Map<NodeId, Set<string>> {
    if (this.fingerprintCache !== null) return this.fingerprintCache;
    if (this.trace === undefined) return new Map();

    const cache = new Map<NodeId, Set<string>>();
    for (const node of this.store.nodesInCreationOrder()) {
      if (node.kind !== 'phase') continue;
      const span = nodeSpan(node);
      if (span === null) continue;
      const parts: string[] = [];
      for (const event of this.trace.read({ from: span.start, to: span.end })) {
        for (const field of ['blob', 'args_blob', 'output_blob'] as const) {
          const ref = (event as unknown as Record<string, unknown>)[field];
          if (typeof ref === 'string') {
            parts.push(this.blobs.getTextPrefix(ref, 8192));
          }
        }
      }
      cache.set(node.id, extractFingerprints(parts.join('\n')));
    }
    this.fingerprintCache = cache;
    return cache;
  }

  /**
   * `search`. Vector path when L3 can answer, beam otherwise, and the
   * result says which ran so §15's eval attributes recall to the mechanism
   * that earned it. When L0 is available, distinctive terms from the query
   * are grepped against raw events and merged via rank-reciprocal fusion.
   */
  async search(query: string, options: TreeSearchOptions = {}): Promise<TreeSearchResult> {
    let base: TreeSearchResult;
    if (this.embed === undefined) {
      base = { ...this.beamSearch(query, options), fallback: 'no-embedder' };
    } else if (this.store.embeddingDim() === null) {
      base = { ...this.beamSearch(query, options), fallback: 'no-embeddings' };
    } else {
      base = await this.searchSummaries(query, options);
    }

    if (this.trace === undefined) return base;
    let grepTerms = extractQueryFingerprints(query);
    if (grepTerms.length === 0 && this.rewrite !== undefined) {
      try { grepTerms = await this.rewrite(query); } catch { /* degrade gracefully */ }
    }
    if (grepTerms.length === 0) return base;

    const limit = normalizeLimit(options.limit);
    const grepHits = new Map<NodeId, number>();
    const MAX_GREP_PASSES = 5;
    for (const term of grepTerms.slice(0, MAX_GREP_PASSES)) {
      const result = this.grepEvents(term, { limit });
      for (const hit of result.hits) {
        grepHits.set(hit.nodeId, (grepHits.get(hit.nodeId) ?? 0) + 1);
      }
    }
    if (grepHits.size === 0) return base;

    return mergeWithGrep(base, grepHits, limit);
  }

  /**
   * Event-level search: the unit the model is shown is the EVENT, and the hit
   * carries its payload. The branch pool is exactly `search()`'s (same ranking,
   * limit and kind filter); within each ranked branch the same relevance scorer
   * that centres a narrowed fetch (`findRelevantCenter`) scores that branch's
   * events for the query, and the best `hits` events across all branches are
   * returned, each with its `seq` and an excerpt of its own rendered text.
   * Branches whose events match nothing fill the remaining slots as bare
   * coordinates, so the caller still sees `hits` rows. Without a trace there is
   * nothing to excerpt and every row is a bare coordinate.
   *
   * Measured against the branch-coordinate unit on one store at W=131,072
   * (GLM 5.3 Flash, n=5): 15/25 vs 6/25, every success with zero fetches
   * (`reports/metrics/window-regime-and-retrieval-unit-report.md` §7).
   */
  async searchEvents(query: string, options: EventSearchOptions): Promise<EventSearchResult> {
    const base = await this.search(query, options);
    const branches = base.hits;
    const coordinate = (branch: SummaryHit, rank: number): Omit<EventHit, 'seq' | 'score' | 'excerpt'> => ({
      nodeId: branch.nodeId,
      kind: branch.kind,
      title: branch.title,
      phaseType: branch.phaseType,
      ...(branch.path === undefined ? {} : { path: branch.path }),
      version: branch.version,
      meta: branch.meta,
      branchRank: rank + 1,
      branchScore: branch.score,
    });
    const bare = (branch: SummaryHit, rank: number): EventHit => ({ ...coordinate(branch, rank), seq: null, score: branch.score, excerpt: null });
    const result = (hits: EventHit[]): EventSearchResult =>
      base.fallback === undefined ? { hits, branches, path: base.path } : { hits, branches, path: base.path, fallback: base.fallback };

    const trace = this.trace;
    if (trace === undefined) return result(branches.slice(0, options.hits).map(bare));

    // Branches nest (task ⊃ phase ⊃ file), so one event can sit inside several
    // ranked branches. It is attributed to the MOST SPECIFIC one — the smallest
    // span that contains it — never to whichever branch happened to rank first,
    // or the root would swallow every event and the phase that did the work
    // would vanish from the hit list.
    // Ordering, however, uses the BEST rank of any branch holding the event: the
    // pool's relevance is a property of the event's context, not of the label it
    // is filed under, and tie-breaking on a file node's rank would push the top
    // phase's events below those of unrelated branches.
    type Entry = { branch: SummaryHit; rank: number; bestRank: number; seq: number; score: number; width: number; terms: string[] };
    const scored = new Set<NodeId>();
    const bySeq = new Map<number, Entry>();
    branches.forEach((branch, rank) => {
      const node = this.store.getNode(branch.nodeId);
      if (node === null) return;
      const span = nodeSpan(node);
      if (span === null) return;
      const center = this.findRelevantCenter(query, [span]);
      if (center.scores.length > 0) scored.add(branch.nodeId);
      const width = span.end - span.start;
      for (const { seq, score } of center.scores) {
        const held = bySeq.get(seq);
        const terms = center.terms.map((term) => term.value);
        if (held === undefined) {
          bySeq.set(seq, { branch, rank, bestRank: rank, seq, score, width, terms });
          continue;
        }
        held.bestRank = Math.min(held.bestRank, rank);
        held.score = Math.max(held.score, score);
        if (width < held.width || (width === held.width && rank < held.rank)) {
          held.branch = branch;
          held.rank = rank;
          held.width = width;
          held.terms = terms;
        }
      }
    });
    const events = [...bySeq.values()].sort((a, b) => b.score - a.score || a.bestRank - b.bestRank || b.seq - a.seq);

    const hits: EventHit[] = [];
    for (const entry of events) {
      if (hits.length >= options.hits) break;
      const event = [...trace.read({ from: entry.seq, to: entry.seq })][0];
      if (event === undefined) continue;
      hits.push({
        ...coordinate(entry.branch, entry.rank),
        seq: entry.seq,
        score: entry.score,
        excerpt: excerptAround(renderEvent(event, this.blobs), entry.terms, options.excerptChars, options.excerptAnchor),
      });
    }
    branches.forEach((branch, rank) => {
      if (hits.length >= options.hits || scored.has(branch.nodeId)) return;
      hits.push(bare(branch, rank));
    });
    return result(hits);
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
   * (i.e. CI) `search` still answers.
   *
   * Only the top-`beamWidth` nodes of each level are expanded; the rest of the
   * level is still scored and rankable, but its subtree is never visited. That
   * pruning is the cost model — O(width · depth) documents, not O(nodes).
   */
  beamSearch(query: string, options: TreeSearchOptions = {}): TreeSearchResult {
    const limit = normalizeLimit(options.limit);
    const beamWidth = options.beamWidth === undefined ? limit : Math.max(1, Math.floor(options.beamWidth));

    const nodes = this.store.nodesInCreationOrder();
    const fingerprints = this.getFingerprints();
    const documents = new Map<NodeId, string>();
    const summaries = new Map<NodeId, NodeSummary | null>();
    const childrenOf = new Map<NodeId | null, TreeNode[]>();
    const ordinal = new Map<NodeId, number>();
    nodes.forEach((node, index) => {
      const summary = this.store.currentSummary(node.id);
      summaries.set(node.id, summary);
      documents.set(node.id, summaryDocument(node, summary, fingerprints.get(node.id)));
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
   * `fetch`. Defaults to `depth: 'full'` (R9): `depth: 'summary'` is
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
      const result = {
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
      this.observeFetch?.({
        nodeId: branch.id, depth, strategy: 'summary', centerSeq: null, terms: [], scores: [],
        inputSpans: [], returnedSpans: [], maxTokens: options.maxTokens ?? null,
        renderedTokens: this.tokenizer.count(result.text),
      });
      return result;
    }

    const rawSpans = mergeSpans(
      targets.flatMap((node) => {
        const span = nodeSpan(node);
        return span === null ? [] : [span];
      }),
    );
    let { from, to } = options;

    // Semantic narrowing: when the branch exceeds the token budget and a query
    // is provided, center the result on the most relevant section and grow the
    // band outward from there until the next event would not fit.
    //
    // The band is MEASURED, not estimated. It used to be sized from an average
    // tokens-per-event over an inflated total, which is wrong twice: the
    // average misprices a band whose events are bigger or smaller than typical,
    // and nothing checked that the result actually fit — so an oversized band
    // was re-cut by whatever appended it, front-first and blind to relevance,
    // which is exactly how a centered excerpt loses the section it was centered
    // on. Growing under a real token count makes this the ONLY cut: what comes
    // back is guaranteed to be within budget, so no downstream cap has anything
    // left to take.
    let center = emptyCenterResult();
    let strategy: FetchDiagnostic['strategy'] = options.query === undefined ? 'no-query' : 'fits';
    if (options.maxTokens !== undefined && options.query !== undefined && depth !== 'index' && this.trace !== undefined) {
      const fullSpans = clampSpans(rawSpans, from, to);
      const fullRendered = renderSpans(this.trace, this.blobs, fullSpans);
      if (this.tokenizer.count(fullRendered.text) > options.maxTokens) {
        center = this.findRelevantCenter(options.query, fullSpans);
        strategy = center.centerSeq === null ? 'no-center' : 'centered';
        if (center.centerSeq !== null) {
          const allEvents = [...this.trace.read({ from: fullSpans[0]?.start, to: fullSpans[fullSpans.length - 1]?.end })];
          const centerIdx = Math.max(0, allEvents.findIndex((e) => e.seq >= center.centerSeq!));
          const fits = (startIdx: number, endIdx: number): boolean => {
            const span = clampSpans(rawSpans, allEvents[startIdx]!.seq, allEvents[endIdx]!.seq);
            return this.tokenizer.count(renderSpans(this.trace!, this.blobs, span).text) <= options.maxTokens!;
          };
          let startIdx = centerIdx;
          let endIdx = centerIdx;
          // The centre event alone can exceed the budget. Keep it anyway: a
          // caller that asked for the most relevant section gets it, and the
          // append path marks the elision rather than silently returning a
          // band that excludes the very event the query matched.
          let grew = true;
          while (grew) {
            grew = false;
            if (endIdx + 1 < allEvents.length && fits(startIdx, endIdx + 1)) {
              endIdx += 1;
              grew = true;
            }
            if (startIdx > 0 && fits(startIdx - 1, endIdx)) {
              startIdx -= 1;
              grew = true;
            }
          }
          from = allEvents[startIdx]!.seq;
          to = allEvents[endIdx]!.seq;
        }
      }
    }

    const spans = clampSpans(rawSpans, from, to);

    if (depth === 'index') {
      const rendered = renderIndex(this.requireTrace("fetchBranch depth:'index'"), this.blobs, spans);
      const result = { ...base, text: rendered.text, spans, events: rendered.events };
      this.observeFetch?.({
        nodeId: branch.id, depth, strategy: 'index', centerSeq: null, terms: [], scores: [],
        inputSpans: rawSpans, returnedSpans: spans, maxTokens: options.maxTokens ?? null,
        renderedTokens: this.tokenizer.count(rendered.text),
      });
      return result;
    }

    const rendered = renderSpans(this.requireTrace("fetchBranch depth:'full'"), this.blobs, spans);
    const result = { ...base, text: rendered.text, spans, events: rendered.events };
    this.observeFetch?.({
      nodeId: branch.id, depth, strategy, centerSeq: center.centerSeq,
      terms: center.terms, scores: center.scores, inputSpans: rawSpans,
      returnedSpans: spans, maxTokens: options.maxTokens ?? null,
      renderedTokens: this.tokenizer.count(rendered.text),
    });
    return result;
  }

  /**
   * `peek` — §9's "suspicion costs one small call, not a full
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

  /**
   * Text search over raw event blobs — the fallback when summary-based search
   * ranks the correct branch too low. Scans L0 events, reads each blob
   * through L2, and returns the branches whose events contain the query as a
   * substring. Zero model calls, deterministic, offline-safe.
   */
  grepEvents(query: string, options: TreeSearchOptions = {}): TreeSearchResult {
    const trace = this.requireTrace('grepEvents');
    const limit = normalizeLimit(options.limit);
    const lowerQuery = query.toLowerCase();

    const nodes = this.store.nodesInCreationOrder();
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    const childrenOf = new Map<NodeId | null, TreeNode[]>();
    for (const node of nodes) {
      const siblings = childrenOf.get(node.parent_id);
      if (siblings === undefined) childrenOf.set(node.parent_id, [node]);
      else siblings.push(node);
    }

    const branchHits = new Map<NodeId, { count: number; firstSeq: number }>();
    for (const event of trace.read({})) {
      const refs: string[] = [];
      const record = event as unknown as Record<string, unknown>;
      for (const field of ['blob', 'args_blob', 'output_blob']) {
        const ref = record[field];
        if (typeof ref === 'string') refs.push(ref);
      }
      for (const ref of refs) {
        const text = this.blobs.getTextPrefix(ref, 4096);
        if (text.toLowerCase().includes(lowerQuery)) {
          for (const node of nodes) {
            const span = nodeSpan(node);
            if (span !== null && span.start <= event.seq && event.seq <= span.end && node.kind === 'phase') {
              const existing = branchHits.get(node.id);
              if (existing === undefined) {
                branchHits.set(node.id, { count: 1, firstSeq: event.seq });
              } else {
                existing.count += 1;
              }
              break;
            }
          }
        }
      }
    }

    const hits: SummaryHit[] = [];
    for (const [nodeId, { count }] of branchHits) {
      const node = nodeById.get(nodeId);
      if (node === undefined) continue;
      if (options.kind !== undefined && node.kind !== options.kind) continue;
      const summary = this.store.currentSummary(node.id);
      hits.push(toHit(node, summary, count));
    }
    hits.sort((a, b) => b.score - a.score);
    return { hits: hits.slice(0, limit), path: 'beam' };
  }

  /**
   * Find the most relevant event seq within a set of spans for a query.
   * Uses the same fingerprint extraction as hybrid grep: extract distinctive
   * terms from the query, scan events for matches, return the seq with the
   * most hits. Returns null when no distinctive term matches.
   */
  /**
   * Find the most relevant event seq within a set of spans for a query.
   * Prioritizes specific terms (backtick-quoted, file paths) over generic ones.
   * When multiple events match equally, picks the one closest to the query's
   * answer (estimated by weighting later events slightly — answers tend to be
   * specific content produced deeper in the branch).
   */
  private findRelevantCenter(query: string, spans: readonly SeqSpan[]): CenterResult {
    if (this.trace === undefined) return emptyCenterResult();
    const legacyTerms = extractQueryFingerprints(query);
    const bareFilenames = this.retrievalCenterFingerprintMode === 'bare-filename'
      ? extractBareFilenames(query, legacyTerms)
      : [];
    let terms = [...bareFilenames, ...legacyTerms];
    let sources = new Map<string, 'legacy' | 'bare-filename' | 'fallback'>([
      ...bareFilenames.map((term) => [term, 'bare-filename'] as const),
      ...legacyTerms.map((term) => [term, 'legacy'] as const),
    ]);
    // Fallback: split the query into significant words (4+ chars) for substring matching.
    // This handles natural-language queries with no distinctive identifiers.
    if (terms.length === 0) {
      const STOP = new Set(['what', 'when', 'where', 'which', 'that', 'this', 'from', 'with', 'they', 'their',
        'there', 'were', 'have', 'been', 'about', 'only', 'also', 'after', 'before', 'into', 'does', 'most',
        'more', 'than', 'then', 'each', 'both', 'such', 'over', 'even', 'same', 'other', 'could', 'would',
        'should', 'will', 'being', 'under', 'the', 'and', 'for', 'not', 'was', 'are', 'but', 'how', 'its']);
      terms = query.split(/\s+/)
        .map(w => w.replace(/[^a-zA-Z0-9_-]/g, ''))
        .filter(w => w.length >= 4 && !STOP.has(w.toLowerCase()));
      sources = new Map(terms.map((term) => [term, 'fallback'] as const));
    }
    if (terms.length === 0) return emptyCenterResult();

    // Weight terms by specificity: earlier in the extraction order = more specific
    // (backtick-quoted first, then file paths, then identifiers)
    const termWeight = new Map<string, number>();
    legacyTerms.forEach((t, i) => termWeight.set(t.toLowerCase(), legacyTerms.length - i));
    bareFilenames.forEach((t, i) => termWeight.set(t.toLowerCase(), legacyTerms.length + bareFilenames.length - i));
    if (legacyTerms.length === 0 && bareFilenames.length === 0) {
      terms.forEach((t, i) => termWeight.set(t.toLowerCase(), terms.length - i));
    }

    const hits = new Map<number, number>(); // seq -> weighted score
    for (const span of spans) {
      for (const event of this.trace.read({ from: span.start, to: span.end })) {
        for (const field of ['blob', 'args_blob', 'output_blob'] as const) {
          const ref = (event as unknown as Record<string, unknown>)[field];
          if (typeof ref !== 'string') continue;
          const text = this.blobs.getTextPrefix(ref, 8192);
          const lower = text.toLowerCase();
          for (const term of terms) {
            const lowerTerm = term.toLowerCase();
            if (lower.includes(lowerTerm)) {
              hits.set(event.seq, (hits.get(event.seq) ?? 0) + (termWeight.get(lowerTerm) ?? 1));
            }
          }
        }
      }
    }
    const observedTerms = terms.map((value) => ({
      value,
      source: sources.get(value) ?? 'legacy',
      weight: termWeight.get(value.toLowerCase()) ?? 1,
    }));
    if (hits.size === 0) return { centerSeq: null, terms: observedTerms, scores: [] };
    // Pick the LAST event at the highest score — the answer is typically in the
    // specific action event, not the earlier discussion that mentions the same terms.
    let bestSeq = 0;
    let bestScore = 0;
    for (const [seq, score] of hits) {
      if (score > bestScore || (score === bestScore && seq > bestSeq)) {
        bestSeq = seq;
        bestScore = score;
      }
    }
    return {
      centerSeq: bestSeq,
      terms: observedTerms,
      scores: [...hits].map(([seq, score]) => ({ seq, score })).sort((a, b) => b.score - a.score || b.seq - a.seq),
    };
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

// Patterns for extracting distinctive terms from a search query.
const BACKTICK_Q = /`([^`]+)`/g;
const QUOTED_Q = /['"]([^'"]{3,})['"]/g;
const FILE_PATH_Q = /[\w\-.]+(?:\/[\w\-.]+)+/g;
const BARE_FILENAME_Q = /\b[\w-]+(?:\.[\w-]+)+\b/g;
const CAMEL_Q = /\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/g;
const PASCAL_Q = /\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g;
const UPPER_SNAKE_Q = /\b[A-Z][A-Z0-9_]{3,}\b/g;

/**
 * Extract distinctive substrings from a search query that are worth grepping
 * for in raw events: backtick-quoted, file paths, identifiers.
 */
function extractQueryFingerprints(query: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const add = (s: string) => { if (s.length >= 3 && !seen.has(s)) { seen.add(s); result.push(s); } };

  for (const m of query.matchAll(BACKTICK_Q)) add(m[1]!);
  for (const m of query.matchAll(QUOTED_Q)) add(m[1]!);
  for (const m of query.matchAll(FILE_PATH_Q)) add(m[0]);
  for (const m of query.matchAll(CAMEL_Q)) add(m[0]);
  for (const m of query.matchAll(PASCAL_Q)) add(m[0]);
  for (const m of query.matchAll(UPPER_SNAKE_Q)) add(m[0]);
  return result;
}

/**
 * Extra centring-only terms for queries that name files without a slash.
 * Search keeps using `extractQueryFingerprints`, so this candidate cannot move
 * branch rank. Names already represented by a path or quoted term are omitted
 * to avoid awarding the same evidence twice.
 */
function extractBareFilenames(query: string, legacyTerms: readonly string[]): string[] {
  const covered = legacyTerms.map((term) => term.toLowerCase());
  const seen = new Set<string>();
  const result: string[] = [];
  for (const match of query.matchAll(BARE_FILENAME_Q)) {
    const value = match[0];
    const lower = value.toLowerCase();
    if (seen.has(lower)) continue;
    if (covered.some((term) => term === lower || term.endsWith(`/${lower}`))) continue;
    seen.add(lower);
    result.push(value);
  }
  return result;
}

const RRF_K = 60;

function mergeWithGrep(
  base: TreeSearchResult,
  grepHits: Map<NodeId, number>,
  limit: number,
): TreeSearchResult {
  const merged = new Map<NodeId, { hit: SummaryHit; rrfScore: number }>();

  for (const [rank, hit] of base.hits.entries()) {
    merged.set(hit.nodeId, { hit, rrfScore: 1 / (RRF_K + rank + 1) });
  }

  const maxGrepScore = Math.max(...grepHits.values(), 1);
  for (const [nodeId, count] of grepHits) {
    const existing = merged.get(nodeId);
    const grepRrf = (count / maxGrepScore) / (RRF_K + 1);
    if (existing !== undefined) {
      existing.rrfScore += grepRrf;
    }
  }

  const sorted = [...merged.values()]
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, limit);

  return {
    hits: sorted.map(({ hit, rrfScore }) => ({ ...hit, score: rrfScore })),
    path: base.path,
    fallback: base.fallback,
  };
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
