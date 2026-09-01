/**
 * §7 tree ops -> L1 rows. This is where the segmenter's deterministic
 * `NodeKey`s become node ids (`node-ids.ts` mints them from the key, so they
 * are a function of L0 like every other L1 column — D8): `segment()` stays pure
 * (D1) precisely because id minting and every write live here instead.
 *
 * Two properties this file owes its callers:
 *  - **Atomicity.** The whole op list applies in ONE transaction. §6's forest
 *    invariant is not something a truncated op list can be trusted to satisfy,
 *    so a crash must leave no half-tree at all.
 *  - **Idempotence.** The incremental path re-segments the whole trace and
 *    re-applies it (see `ingest.ts`), so `open` reuses an already-mapped node,
 *    `extend`/`close` only ever widen a span, and `tool` dedupes. That is what
 *    makes N appends land on the tree a rebuild would have produced (D8).
 */
import { StoreInvariantError } from '../contracts/index.js';
import type {
  NodeId,
  NodeKey,
  NodeMeta,
  Segmentation,
  TreeOp,
  TreeStore,
} from '../contracts/index.js';
import { TASK_KEY, fileKey, phaseKey } from '../segment/index.js';
import type { NodeIdMinter } from './node-ids.js';

export function applySegmentation(
  segmentation: Segmentation,
  store: TreeStore,
  mintId: NodeIdMinter,
): Map<NodeKey, NodeId> {
  return store.transaction(() => {
    const keyMap = resolveExistingKeys(store);

    for (const op of segmentation.ops) {
      switch (op.op) {
        case 'open': {
          const mapped = keyMap.get(op.key);
          if (mapped !== undefined) {
            reconcileOpen(store, mapped, op);
            break;
          }
          const parentId = op.parent === null ? null : requireMapped(keyMap, op.parent);
          // `path` is what `findFileNode` keys off, so it belongs on the node
          // from the moment it exists, not after span extraction.
          const meta: NodeMeta = op.path === undefined ? {} : { path: op.path };
          const node = store.insertNode({
            // Minted from the key, not from a clock (D8): L0's
            // `manual_annotation` names its subject by node id, so an id that
            // changed on every derivation made `rebuild()` a data loss.
            id: mintId(op.key, op.kind),
            parent_id: parentId,
            kind: op.kind,
            title: op.title,
            phase_type: op.phase_type,
            // An `open` covers its own `start_seq`: the segmenter emits no
            // `extend` for the event that opened the node.
            span_start_seq: op.start_seq,
            span_end_seq: op.start_seq,
            status: 'open',
            meta_json: meta,
          });
          keyMap.set(op.key, node.id);
          break;
        }

        case 'extend':
          store.extendSpan(requireMapped(keyMap, op.key), op.seq);
          break;

        case 'close':
          // The segmentation is authoritative about coverage (D8), so a close
          // *sets* the end seq instead of widening it: a re-segmentation must be
          // able to correct a span an earlier pass had wider — which is exactly
          // what happens when the §7 text fallback hands over to the tool state
          // machine on the first `tool_call` of a session.
          store.updateNode(requireMapped(keyMap, op.key), { status: 'closed', span_end_seq: op.end_seq });
          break;

        case 'tool':
          appendTool(store, requireMapped(keyMap, op.key), op.tool);
          break;
      }
    }

    // Keyed on what this segmentation *produced*, not on everything the store
    // happened to hold: `resolveExistingKeys` maps stale phases too.
    assertNoOrphans(store, segmentation.nodeOrder, keyMap);
    return keyMap;
  });
}

/**
 * The append path re-segments from scratch, and a re-segmentation may *reassign*
 * what a key means — the §7 text fallback labels every phase `other` starting at
 * the first message, and the tool state machine takes over (with different
 * titles, types and start seqs) the moment a `tool_call` appears. Patching the
 * differing fields is what keeps an incrementally-built tree equal to a rebuilt
 * one. `kind` is not patchable and never drifts: a key's prefix fixes it.
 */
function reconcileOpen(store: TreeStore, id: NodeId, op: Extract<TreeOp, { op: 'open' }>): void {
  const node = store.getNode(id);
  if (node === null) throw new StoreInvariantError(`open op for unknown node ${id}`);
  if (
    node.title === op.title &&
    node.phase_type === op.phase_type &&
    node.span_start_seq === op.start_seq
  ) {
    return;
  }
  store.updateNode(id, { title: op.title, phase_type: op.phase_type, span_start_seq: op.start_seq });
}

/**
 * L1 is a function of L0 + L2 (D8), so a §7-owned node the current segmentation
 * does not produce cannot be reconciled — and `TreeStore` has no delete, by
 * design. Failing loud with the rebuild instruction beats leaving a tree that
 * silently differs from what a replay would produce. `turn` nodes are exempt:
 * §7 never emits them, so they belong to whoever did.
 */
function assertNoOrphans(
  store: TreeStore,
  produced: readonly NodeKey[],
  keyMap: ReadonlyMap<NodeKey, NodeId>,
): void {
  const mapped = new Set<NodeId>();
  for (const key of produced) {
    const id = keyMap.get(key);
    if (id !== undefined) mapped.add(id);
  }
  const orphans = store
    .nodesInCreationOrder()
    .filter((node) => node.kind !== 'turn' && !mapped.has(node.id));
  if (orphans.length === 0) return;
  throw new SegmentationShrankError(
    `L1 holds ${orphans.length} node(s) this segmentation does not produce (${orphans
      .map((node) => `${node.kind}:${node.title}`)
      .join(', ')}); L1 is derived (D8) — re-deriving instead of reconciling`,
  );
}

/**
 * Raised when a re-segmentation no longer produces a node L1 already holds.
 *
 * This is recoverable, and the caller is expected to recover: the key scheme is
 * positional (`phase:<i>`), so a shrink invalidates every mapping after it and
 * the only correct response is to re-derive L1 from L0 + L2 (D8). It is its own
 * type precisely so `ingest` can act on it rather than treating a routine
 * re-derivation as a corrupt store.
 *
 * A shrink is rare but reachable: §7's text fallback scores boundaries against
 * a relative cutoff, so appending a message can remove a boundary an earlier
 * pass found, and a message-only trace that later gets its first tool call
 * switches state machines entirely.
 */
export class SegmentationShrankError extends StoreInvariantError {}

/**
 * Rebuilds the key -> id map for a tree that already exists, which is what
 * makes re-applying a re-segmentation a reconciliation instead of a duplicate
 * insert.
 *
 * Exact rather than heuristic: the key scheme is positional (`phase:<i>` is the
 * i-th phase in open order, `file:<i>:<path>` its file node), L0 is append-only,
 * and `children()` returns creation order (Ruling C4) — so phase i keeps index
 * i for the life of the trace.
 */
function resolveExistingKeys(store: TreeStore): Map<NodeKey, NodeId> {
  const keyMap = new Map<NodeKey, NodeId>();
  const root = store.root();
  if (root === null) return keyMap;
  keyMap.set(TASK_KEY, root.id);

  const phases = store.children(root.id).filter((node) => node.kind === 'phase');
  phases.forEach((phase, index) => {
    keyMap.set(phaseKey(index), phase.id);
    for (const child of store.children(phase.id)) {
      const path = child.meta_json.path;
      if (child.kind === 'file' && typeof path === 'string') {
        keyMap.set(fileKey(index, path), child.id);
      }
    }
  });
  return keyMap;
}

/**
 * First-seen order, no duplicates. `meta_json.tools` on the root ends up as the
 * session's whole tool vocabulary (§7), and `mergeNodeMeta` replaces arrays
 * rather than concatenating them, so the read-modify-write is required.
 */
function appendTool(store: TreeStore, id: NodeId, tool: string): void {
  const node = store.getNode(id);
  if (node === null) throw new StoreInvariantError(`tool op for unknown node ${id}`);
  const tools = node.meta_json.tools ?? [];
  if (tools.includes(tool)) return;
  store.mergeNodeMeta(id, { tools: [...tools, tool] });
}

function requireMapped(keyMap: ReadonlyMap<NodeKey, NodeId>, key: NodeKey): NodeId {
  const id = keyMap.get(key);
  // The segmenter opens a node before it extends, closes or tags it. A miss
  // here means the op list is not a §7 op list, which L1 must not absorb quietly.
  if (id === undefined) throw new StoreInvariantError(`op references unopened node key ${JSON.stringify(key)}`);
  return id;
}
