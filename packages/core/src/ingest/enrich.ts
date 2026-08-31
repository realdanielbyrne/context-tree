/**
 * §7.1's OPTIONAL enrichment post-pass — the one sanctioned way semantics
 * enters ingestion, kept in its own file because `ingest()` must never call it
 * (D15). Two rules make it safe to have at all:
 *
 *  - it writes only provenance-stamped `meta_json.enrichment[]` records (plus
 *    lateral `relates_to` links, D10) — never a field the tree's structural
 *    correctness depends on, and all of it is dropped by a rebuild;
 *  - it is best-effort and non-blocking: a provider that fails its probe,
 *    throws, or is simply absent yields an identical tree minus the annotations.
 *
 * Both kinds the plan names are here: callers of changed symbols on file nodes
 * (from an injected §9.1 provider — this module owns no provider and opens no
 * socket), and branch-to-branch `relates_to` links from summary-embedding
 * similarity via L3.
 */
import type {
  Candidate,
  EmbeddingHit,
  EnrichmentRecord,
  NodeId,
  RetrievalProvider,
  TreeStore,
} from '../contracts/index.js';
import type { TaskStore } from './task-store.js';

/** Neighbours per branch. Small on purpose: a `relates_to` edge is a hint, not a search result. */
const RELATES_K = 3;
/**
 * Cosine-distance ceiling for a `relates_to` edge. Above this the two branches
 * merely share vocabulary, and a wrong lateral link costs more than a missing
 * one — it sends a resumed session down an unrelated branch.
 */
const RELATES_MAX_DISTANCE = 0.35;

const CALLERS_KIND = 'callers';
const RELATES_KIND = 'relates_to';
/** Provenance for the L3 pass: internal, no external index involved. */
const L3_PROVIDER = 'l3-summary-embeddings';

export interface EnrichInput {
  handle: TaskStore;
  /** §9.1 providers, capability-probed before use. Absent => the callers pass is skipped. */
  providers?: readonly RetrievalProvider[];
  /**
   * Embeds a branch summary for the L3 similarity pass. Injected because
   * `TreeStore` exposes `knn` but no vector read-back, so the query vector has
   * to come from the caller — and because that keeps every model call outside
   * this module. Absent => the `relates_to` pass is skipped.
   */
  embed?: (text: string) => Float32Array;
  /** Injected clock: the timestamp is part of the provenance stamp, so it is data, not ambience. */
  now?: () => string;
}

export interface EnrichResult {
  /** Nodes that gained an `enrichment[]` record. */
  annotated: number;
  /** `relates_to` links written. */
  links: number;
  /** Providers whose probe said no (or threw). */
  unavailable: string[];
  /** Providers that threw during a search — degraded, never fatal. */
  failed: string[];
}

export async function enrich(input: EnrichInput): Promise<EnrichResult> {
  const { store, config } = input.handle;
  const now = input.now ?? (() => new Date().toISOString());
  const annotated = new Set<NodeId>();
  const failed = new Set<string>();
  const unavailable: string[] = [];

  const usable: RetrievalProvider[] = [];
  for (const provider of input.providers ?? []) {
    let ok = false;
    try {
      ok = await provider.available();
    } catch {
      // §9.1 says a probe must never throw; one that does is unavailable, not fatal.
      ok = false;
    }
    if (ok) usable.push(provider);
    else unavailable.push(provider.id);
  }

  for (const node of store.byKind('file')) {
    const symbols = node.meta_json.symbols ?? [];
    // Nothing to ask about: §12 found no named symbol under this node.
    if (symbols.length === 0) continue;
    for (const provider of usable) {
      const hits: Array<{ symbol: string; callers: Candidate[] }> = [];
      for (const symbol of symbols) {
        try {
          const candidates = await provider.search({
            query: symbol,
            mode: 'ranked',
            limit: config.retrieval.limit,
          });
          if (candidates.length > 0) hits.push({ symbol, callers: candidates });
        } catch {
          failed.add(provider.id);
        }
      }
      if (hits.length === 0) continue;
      putEnrichment(store, node.id, {
        provider: provider.id,
        timestamp: now(),
        kind: CALLERS_KIND,
        data: { symbols: hits },
      });
      annotated.add(node.id);
    }
  }

  const links = input.embed === undefined ? 0 : relateBranches(store, input.embed, now, annotated);

  return { annotated: annotated.size, links, unavailable, failed: [...failed] };
}

/**
 * Branch-to-branch `relates_to` from summary-embedding similarity via L3 (§7.1).
 * Embeddings are written before any query so `knn` sees the whole branch set;
 * L3 is disposable (D8), so writing it here costs nothing structural.
 */
function relateBranches(
  store: TreeStore,
  embed: (text: string) => Float32Array,
  now: () => string,
  annotated: Set<NodeId>,
): number {
  const branches: Array<{ id: NodeId; vec: Float32Array }> = [];
  for (const node of store.byKind('phase')) {
    const summary = store.currentSummary(node.id);
    if (summary === null) continue;
    try {
      const vec = embed(summary.text);
      if (vec.length === 0) continue;
      store.putEmbedding(node.id, summary.version, vec);
      branches.push({ id: node.id, vec });
    } catch {
      // A bad vector width (or a failing embedder) skips this branch only.
      continue;
    }
  }

  let links = 0;
  for (const branch of branches) {
    let hits: EmbeddingHit[];
    try {
      // +1: the branch's own embedding is the nearest neighbour of itself.
      hits = store.knn(branch.vec, RELATES_K + 1);
    } catch {
      continue;
    }
    const neighbours = hits
      .filter((hit) => hit.node_id !== branch.id && hit.distance <= RELATES_MAX_DISTANCE)
      .slice(0, RELATES_K);
    if (neighbours.length === 0) continue;
    const timestamp = now();
    for (const hit of neighbours) {
      store.putLink({ from_id: branch.id, to_id: hit.node_id, kind: 'relates_to', created_at: timestamp });
      links += 1;
    }
    putEnrichment(store, branch.id, {
      provider: L3_PROVIDER,
      timestamp,
      kind: RELATES_KIND,
      data: { neighbours: neighbours.map((hit) => ({ node_id: hit.node_id, distance: hit.distance })) },
    });
    annotated.add(branch.id);
  }
  return links;
}

/**
 * One record per (provider, kind): a re-run replaces its own last answer rather
 * than growing the array forever, and a provider can never overwrite another's
 * record. Records from other providers are left untouched.
 */
function putEnrichment(store: TreeStore, id: NodeId, record: EnrichmentRecord): void {
  const node = store.getNode(id);
  if (node === null) return;
  const kept = (node.meta_json.enrichment ?? []).filter(
    (existing) => existing.provider !== record.provider || existing.kind !== record.kind,
  );
  store.mergeNodeMeta(id, { enrichment: [...kept, record] });
}
