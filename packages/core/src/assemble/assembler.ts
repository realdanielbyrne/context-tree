/**
 * ⚠️ SUPERSEDED — pending removal. This is the Zone A/B/C assembler. Its layout
 * was TESTED-AND-LOST on cache economics (flex-append-sticky is ~14% cheaper —
 * `reports/metrics/assembler-flex-buffer/report.md`). The canonical assembler is
 * now `assembleFlex` in `./flex.ts` (frozen head + creation-order flex buffer +
 * D-EV eviction + drift dormancy). This class and the `Zone='A'|'B'|'C'` vocabulary
 * remain ONLY until the swap completes; that swap is blocked on a flex store-adapter
 * which is blocked on the retrieval/embedding rewrite (local MiniLM). Do not build
 * new callers on this — see `reports/session-handoff.md` → reconciliation. `toMessages`
 * / `toCompletionRequest` below are the only pieces still worth reusing (generalize
 * them to the flex vocabulary during the swap).
 *
 * §10 — cache-aware prompt assembly (D5).
 *
 * The layout is fixed and the content migrates through it:
 *
 *   Zone A  system contract + MCP tool schemas      frozen, cached permanently
 *   Zone B  task root summary, then branch summaries in CREATION ORDER
 *   Zone C  the ACTIVE branch expanded in full + this turn's tool results
 *   tail    `context_fetch`/`context_search`/`context_peek` output (D6)
 *
 * The single idea the whole file exists to protect: provider caches are keyed on
 * a *prefix*, so an edit in the middle invalidates everything after it. Zone B is
 * therefore never relevance-ordered (§10 rule 1) — relevance is expressed by
 * expansion in Zone C, and new summaries land at the END of Zone B where they
 * invalidate only the suffix that Zone C rewrites anyway (rule 2). Retrieval
 * results go after Zone C (rule 3) for the same reason.
 *
 * Block ids are stable functions of content coordinates (node id + summary
 * version, or L0 seq), because §17's cache-assertion harness proves "which
 * prefix ranges survived this event" by comparing ids and token counts across
 * two assemblies. If an id moved for a reason unrelated to content, that harness
 * silently stops testing anything.
 */
import { createHash } from 'node:crypto';
import { replyHeadroom } from './budgets.js';
import { DEFAULT_CONFIG } from '../config.js';
import { StoreInvariantError } from '../contracts/index.js';
import type {
  AssembleOptions,
  AssembledPrompt,
  BlobStore,
  BudgetReport,
  ChatMessage,
  CompletionRequest,
  DeliveredBlock,
  DeliveryPrompt,
  DeliveryReceipt,
  NodeId,
  PromptAssembler,
  PromptBlock,
  TailEntry,
  Tokenizer,
  ToolSchema,
  TraceLog,
  TreeNode,
  TreeStore,
  Zone,
} from '../contracts/index.js';
import {
  renderActiveHeader,
  renderActiveMap,
  renderEvent,
  renderLinksBlock,
  renderSummaryBlock,
  renderTailBlock,
  truncateToTokens,
} from './format.js';

export interface ZoneAssemblerDeps {
  store: TreeStore;
  blobs: BlobStore;
  /**
   * L0 is required, not optional: Zone C is "the active branch's raw detail",
   * and L1 stores only the seq coordinates of that detail (§6).
   */
  trace: TraceLog;
  tokenizer: Tokenizer;
  /**
   * Zone A's frozen text. Byte-identical across every turn of a session — any
   * per-turn value leaking in here (a timestamp, a node count, a budget number)
   * permanently defeats caching for the whole session.
   */
  systemContract: string;
  budgets?: { zoneB: number; zoneC: number };
  /**
   * The host's context window in tokens. Host-supplied on purpose: it is a
   * property of the deployment, not something this library can derive or
   * sensibly default. Supplying it is what makes `BudgetReport.window`,
   * `windowRemaining` and `overWindow` meaningful, and it is the input
   * `deriveZoneBudgets` needs so the zone allowances come from ONE measured
   * number instead of two independently chosen constants.
   */
  window?: number;
  /**
   * D5 experiment 4: mark a THIRD
   * provider breakpoint at the end of Zone C's stable run — every block except
   * the descendant map (`C:map:*`), which churns on every edit and must ride
   * after the marker (see the comment above `zoneC`). Anthropic honours up to
   * 4; the shipped default emits 2 (Zone A/B, Zone B/C) and leaves Zone C fresh
   * on every turn. Defaults to `false` — today's behaviour — because turning
   * this on is a request-shape change (`toMessages` splits Zone C into two
   * messages instead of one) that a caller opts into deliberately, not a bug
   * fix applied silently underneath existing callers.
   */
  cacheZoneCBreakpoint?: boolean;
  /**
   * Tokens reserved for the reply when enforcing the window. Defaults to
   * `replyHeadroom({ window })` — the window fraction — so a host that knows its
   * model's maximum output should pass the measured figure instead.
   */
  replyReserve?: number;
}

/** A Zone B node contributes a summary block plus an optional links block; the
 *  pair is kept or dropped as a unit so a dropped summary never leaves orphan
 *  link annotations pointing at prose the model cannot see. */
interface ZoneBEntry {
  nodeId: NodeId;
  isRoot: boolean;
  blocks: PromptBlock[];
  tokens: number;
}

export interface ZoneBSelection {
  /**
   * Branch ids to keep in Zone B, chosen by the caller (e.g. a DSA-style
   * top-k selector in the eval harness). `undefined` keeps every branch —
   * so k >= branch count and no selection at all are the same code path and
   * neither perturbs the prefix. The task root and the active branch are not
   * selectable: the root is the anchor and the active branch never appears in
   * Zone B anyway. Selected branches keep creation order (rule 1) — selection
   * changes membership, never position.
   */
  keepBranches?: ReadonlySet<NodeId>;
}

export class ZoneAssembler implements PromptAssembler {
  private readonly deps: ZoneAssemblerDeps;
  private readonly budgets: { zoneB: number; zoneC: number };
  /** D6 soft offloading: acknowledged fetched detail can leave at a phase boundary. */
  private tail: TailEntry[] = [];
  /** Delivery is explicit and keyed by both coordinate and selected bytes. */
  private readonly deliveredTail = new Set<string>();

  constructor(deps: ZoneAssemblerDeps) {
    this.deps = deps;
    this.budgets = deps.budgets ?? { ...DEFAULT_CONFIG.budgets };
  }

  /** Appends one retrieval result to the tail (after Zone C — rule 3). */
  appendTail(entry: TailEntry): void {
    this.tail.push({ ...entry });
  }

  tailEntries(): readonly TailEntry[] {
    return this.tail.map((entry) => ({ ...entry }));
  }

  /**
   * Commit a successfully delivered candidate. Replaying an acknowledgement is
   * harmless, and an old receipt cannot acknowledge or evict replacement text
   * under the same ID. This changes only the ephemeral assembly buffer.
   */
  acknowledgeDelivery(receipt: DeliveryReceipt): void {
    if (receipt.version !== 1) throw new RangeError('unsupported delivery receipt version');
    for (const block of receipt.blocks) {
      if (block.id.startsWith('tail:')) this.deliveredTail.add(deliveryKey(block));
    }
    if (receipt.tailSource === 'internal') {
      const evicted = new Set(receipt.evictedTail.map(deliveryKey));
      this.tail = this.tail.filter((entry) => !evicted.has(deliveryKey(tailIdentity(entry))));
    }
  }

  /**
   * D6: delivered fetched payloads die at phase boundaries. Unacknowledged
   * selected payloads survive. This does not touch L1, does not
   * close or open a node, and does not re-summarize. Phase state belongs to the
   * segmenter; the assembler only reads it.
   */
  onPhaseTransition(): void {
    this.tail = this.tail.filter((entry) => !entry.ephemeral || !this.deliveredTail.has(deliveryKey(tailIdentity(entry))));
  }

  assemble(options: AssembleOptions = {}): DeliveryPrompt {
    const { store } = this.deps;
    const root = store.root();

    const activeNodeId = options.activeNodeId ?? store.openPhase()?.id ?? null;
    const active = activeNodeId === null ? null : store.getNode(activeNodeId);
    if (activeNodeId !== null && active === null) {
      throw new StoreInvariantError(`assemble: unknown activeNodeId ${activeNodeId}`);
    }

    const zoneA = this.zoneA(options.toolSchemasText);

    const zoneBBudget = options.zoneBBudget ?? this.budgets.zoneB;
    const zoneB = this.zoneB(root, this.activeBranchId(active, root), zoneBBudget, options.selection);

    const zoneCBudget = options.zoneCBudget ?? this.budgets.zoneC;
    const zoneC = this.zoneC(active, zoneCBudget);

    const tailEntries = [...(options.tail ?? this.tail)];
    const tailBlocks = tailEntries.map((entry) =>
      this.block('tail', `tail:${entry.id}`, renderTailBlock(entry.id, entry.text, entry.ephemeral)),
    );

    // Rule 5: breakpoints at the Zone A/B and Zone B/C boundaries, nowhere else.
    const cacheBreakpoints: string[] = [];
    for (const zoneBlocks of [zoneA, zoneB.blocks]) {
      const last = zoneBlocks.at(-1);
      if (last === undefined) continue;
      last.cacheBreakpointAfter = true;
      cacheBreakpoints.push(last.id);
    }
    // Experiment 4's 3rd breakpoint, opt-in only (`cacheZoneCBreakpoint`): the
    // last Zone C block that is not the descendant map, so the map (and any
    // tail) keep riding uncached after it exactly as `renderActiveMap`'s
    // comment above `zoneC` requires.
    if (this.deps.cacheZoneCBreakpoint === true) {
      const lastStable = [...zoneC.blocks].reverse().find((b) => !b.id.startsWith('C:map:'));
      if (lastStable !== undefined) {
        lastStable.cacheBreakpointAfter = true;
        cacheBreakpoints.push(lastStable.id);
      }
    }

    const overBudget: Zone[] = [];
    // The asymmetry is deliberate: Zone B reports its degradation through
    // `droppedFromZoneB`, so `overBudget` only names it when dropping was not
    // enough. Zone C has no dropped-list field, so truncation is reported here —
    // a silent drop or truncation is indistinguishable from a summarizer bug.
    if (zoneB.tokens > zoneBBudget) overBudget.push('B');
    if (zoneC.truncated) overBudget.push('C');

    const window = options.window ?? this.deps.window ?? null;
    if (window !== null && (!Number.isFinite(window) || window <= 0)) {
      throw new RangeError('window must be a finite positive number of tokens');
    }
    // Window enforcement proposes a candidate without committing buffer state.
    // Selected tail payloads stay until their exact bytes are acknowledged;
    // already-delivered ephemeral payloads leave first, then Zone C events
    // oldest-first under its existing selection policy. Both are reported.
    // The tail rides after the last breakpoint, so evicting it re-bills nothing.
    const evictedFromTail: string[] = [];
    const evictedTail: DeliveredBlock[] = [];
    let droppedFromZoneC = 0;
    if (window !== null) {
      const reply = this.deps.replyReserve ?? replyHeadroom({ window }).tokens;
      if (!Number.isFinite(reply) || reply < 0) throw new RangeError('replyReserve must be finite and nonnegative');
      const over = (): number =>
        sumTokens(zoneA) + zoneB.tokens + sumTokens(zoneC.blocks) + sumTokens(tailBlocks) + reply - window;
      let i = 0;
      while (over() > 0 && i < tailEntries.length) {
        const entry = tailEntries[i]!;
        const identity = tailIdentity(entry);
        if (entry.ephemeral && this.deliveredTail.has(deliveryKey(identity))) {
          evictedFromTail.push(entry.id);
          evictedTail.push(identity);
          tailEntries.splice(i, 1);
          tailBlocks.splice(i, 1);
        } else {
          i += 1;
        }
      }
      while (over() > 0) {
        const idx = zoneC.blocks.findIndex((b) => b.id.startsWith('C:event:'));
        if (idx < 0) break;
        zoneC.blocks.splice(idx, 1);
        droppedFromZoneC += 1;
      }
    }

    const tailTokens = sumTokens(tailBlocks);
    const budgets: BudgetReport = {
      zoneA: sumTokens(zoneA),
      zoneB: zoneB.tokens,
      zoneC: sumTokens(zoneC.blocks),
      tail: tailTokens,
      total: 0,
      overBudget,
      droppedFromZoneB: zoneB.dropped,
      window,
      windowRemaining: null,
      overWindow: false,
      replyAllowance: null,
      evictedFromTail,
      droppedFromZoneC,
    };
    budgets.total = budgets.zoneA + budgets.zoneB + budgets.zoneC + budgets.tail;
    // The one constraint that is not a matter of allocation: this prompt either
    // fits the host's window or cannot be sent. Report any residual overflow
    // after selection instead of cutting an unacknowledged selected payload.
    // The host must also count its serialized request framing and native tools
    // before sending: these block counts are in the supplied tokenizer's units.
    if (window !== null) {
      budgets.windowRemaining = window - budgets.total;
      budgets.overWindow = budgets.total > window;
      // The largest reply that fits beside what was just built. A caller passes
      // this straight to the provider as `max_tokens`, which is the honest form
      // of a reply limit: arithmetic per turn rather than a number anyone
      // picked. It shrinks as the session grows, so a small-window model keeps
      // iterating on short answers instead of the request becoming invalid.
      budgets.replyAllowance = Math.max(0, window - budgets.total);
    }

    const blocks = [...zoneA, ...zoneB.blocks, ...zoneC.blocks, ...tailBlocks];
    const deliveryReceipt: DeliveryReceipt = Object.freeze({
      version: 1,
      blocks: Object.freeze(blocks.map(blockIdentity)),
      tailSource: options.tail === undefined ? 'internal' : 'supplied',
      evictedTail: Object.freeze(evictedTail),
    });
    return {
      system: zoneA.map((b) => b.text).join('\n\n'),
      blocks,
      budgets,
      cacheBreakpoints,
      deliveryReceipt,
    };
  }

  // ── zones ──────────────────────────────────────────────────────────────────

  private zoneA(toolSchemasText: string | undefined): PromptBlock[] {
    const blocks = [this.block('A', 'A:system', this.deps.systemContract)];
    if (toolSchemasText !== undefined && toolSchemasText !== '') {
      blocks.push(this.block('A', 'A:tools', toolSchemasText));
    }
    return blocks;
  }

  /**
   * Zone B in creation order (rule 1) from `nodesInCreationOrder()`, restricted
   * to the task root and its direct branches — deeper nodes are detail, reachable
   * by expansion in Zone C or by `context_fetch`, and putting them here would
   * spend the 8k budget on exactly the content Zone C already carries.
   */
  private zoneB(
    root: TreeNode | null,
    activeBranchId: NodeId | null,
    budget: number,
    selection?: ZoneBSelection,
  ): { blocks: PromptBlock[]; tokens: number; dropped: NodeId[] } {
    if (root === null) return { blocks: [], tokens: 0, dropped: [] };
    const { store } = this.deps;
    const entries: ZoneBEntry[] = [];

    for (const node of store.nodesInCreationOrder()) {
      const isRoot = node.id === root.id;
      if (!isRoot && node.parent_id !== root.id) continue;
      // The active branch's detail is in Zone C; its summary would duplicate it.
      // Every other block keeps its position, so promoting or demoting a branch
      // never reorders its neighbours.
      if (!isRoot && node.id === activeBranchId) continue;
      // Caller-side top-k selection (ZoneBSelection): a branch outside the
      // keep-set is excluded before budget accounting — selection is a
      // relevance decision, rule-4 budget dropping remains the overflow valve.
      if (!isRoot && selection?.keepBranches !== undefined && !selection.keepBranches.has(node.id)) continue;

      const summary = store.currentSummary(node.id);
      if (summary === null) continue;

      const blocks = [
        this.block(
          'B',
          `${isRoot ? 'B:root' : 'B:summary'}:${node.id}:${summary.version}`,
          renderSummaryBlock(node, summary, isRoot),
          node.id,
        ),
      ];
      const links = store.linksFrom(node.id);
      if (links.length > 0) {
        blocks.push(
          this.block('B', `B:links:${node.id}:${links.length}`, renderLinksBlock(node, links), node.id),
        );
      }
      entries.push({ nodeId: node.id, isRoot, blocks, tokens: sumTokens(blocks) });
    }

    // Rule 4 degradation: drop the OLDEST summaries first, never reorder. The
    // root summary is exempt — it is the task anchor a resumed session reads
    // first, and it is also the oldest, so oldest-first would drop it first.
    const dropped: NodeId[] = [];
    let tokens = entries.reduce((sum, entry) => sum + entry.tokens, 0);
    for (const entry of entries) {
      if (tokens <= budget) break;
      if (entry.isRoot) continue;
      dropped.push(entry.nodeId);
      tokens -= entry.tokens;
    }

    const droppedIds = new Set(dropped);
    const blocks = entries.filter((e) => !droppedIds.has(e.nodeId)).flatMap((e) => e.blocks);
    return { blocks, tokens, dropped };
  }

  /**
   * Zone C: the active branch expanded in full, read straight out of L0 over the
   * node's seq span, plus this turn's tool results — for an OPEN branch the read
   * runs to `lastSeq()` so results appended since the last ingest pass are
   * present (§10 rule 2: "+ this turn's tool results").
   */
  private zoneC(
    active: TreeNode | null,
    budget: number,
  ): { blocks: PromptBlock[]; truncated: boolean } {
    if (active === null) return { blocks: [], truncated: false };
    const { store, blobs, trace } = this.deps;

    const blocks = [this.block('C', `C:head:${active.id}`, renderActiveHeader(active), active.id)];

    if (active.span_start_seq !== null) {
      const from = active.span_start_seq;
      const recorded = active.span_end_seq ?? from;
      const to = active.status === 'open' ? Math.max(recorded, trace.lastSeq()) : recorded;
      for (const event of trace.read({ from, to })) {
        blocks.push(this.block('C', `C:event:${event.seq}`, renderEvent(event, blobs)));
      }
    }

    // The descendant map goes LAST: it grows with every edit, and churn ahead
    // of the append-only event stream voids the events' cache (see
    // renderActiveMap). Callers that cache Zone C must keep it after their
    // moving breakpoint.
    const descendants = store.descendants(active.id);
    if (descendants.length > 0) {
      blocks.push(this.block('C', `C:map:${active.id}`, renderActiveMap(descendants), active.id));
    }

    return { blocks, truncated: this.fitZoneC(blocks, budget) };
  }

  /**
   * Rule 4: when Zone C is over budget, truncate the LARGEST detail blocks. Cap
   * chosen by water-filling (smallest cap `c` where `sum(min(tokens, c))` fits),
   * so the cost falls on the blocks actually responsible for the overflow and
   * small blocks survive intact. Returns whether anything was truncated.
   */
  private fitZoneC(blocks: PromptBlock[], budget: number): boolean {
    const total = sumTokens(blocks);
    if (total <= budget) return false;

    const fill = (cap: number): number =>
      blocks.reduce((sum, block) => sum + Math.min(block.tokens, cap), 0);
    let lo = 0;
    // reduce, not Math.max(...spread): Zone C can hold one block per L0 event.
    let hi = blocks.reduce((max, block) => Math.max(max, block.tokens), 0);
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (fill(mid) <= budget) lo = mid + 1;
      else hi = mid;
    }
    // `lo` is now the smallest cap that does NOT fit; the largest that fits is
    // lo - 1 (fill(0) === 0 always fits, so lo >= 1).
    const cap = lo - 1;

    for (const block of blocks) {
      if (block.tokens <= cap) continue;
      block.text = truncateToTokens(block.text, cap, this.deps.tokenizer);
      block.tokens = this.deps.tokenizer.count(block.text);
    }
    return true;
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  /**
   * The direct branch of the task root that owns `active`. Zone C may be pointed
   * at a file node deep inside a phase; the summary that would duplicate it is
   * still the phase's. When `active` IS the root, nothing is excluded — Zone C
   * expands everything and the root summary stays as the anchor.
   */
  private activeBranchId(active: TreeNode | null, root: TreeNode | null): NodeId | null {
    if (active === null || root === null || active.id === root.id) return null;
    const path = this.deps.store.ancestorPath(active.id);
    return path[1]?.id ?? null;
  }

  private block(zone: Zone, id: string, text: string, nodeId?: NodeId): PromptBlock {
    const block: PromptBlock = { zone, id, text, tokens: this.deps.tokenizer.count(text) };
    if (nodeId !== undefined) block.nodeId = nodeId;
    return block;
  }
}

function blockIdentity(block: Pick<PromptBlock, 'id' | 'text'>): DeliveredBlock {
  return Object.freeze({ id: block.id, contentHash: createHash('sha256').update(block.text, 'utf8').digest('hex') });
}

function tailIdentity(entry: TailEntry): DeliveredBlock {
  return blockIdentity({ id: `tail:${entry.id}`, text: renderTailBlock(entry.id, entry.text, entry.ephemeral) });
}

function deliveryKey(block: DeliveredBlock): string {
  return JSON.stringify([block.id, block.contentHash]);
}

function sumTokens(blocks: readonly PromptBlock[]): number {
  return blocks.reduce((sum, block) => sum + block.tokens, 0);
}

/**
 * Does `zone` end at a §10 rule 5 breakpoint? Both provider-facing projections
 * below read this one predicate, so the system flag and the message flags cannot
 * drift apart — which is exactly how the Zone A marker got lost before.
 */
function zoneEndsAtBreakpoint(prompt: AssembledPrompt, zone: Zone): boolean {
  const last = prompt.blocks.filter((block) => block.zone === zone).at(-1);
  if (last === undefined) return false;
  return last.cacheBreakpointAfter === true || prompt.cacheBreakpoints.includes(last.id);
}

function isMarked(prompt: AssembledPrompt, block: PromptBlock): boolean {
  return block.cacheBreakpointAfter === true || prompt.cacheBreakpoints.includes(block.id);
}

/**
 * Splits one zone's blocks at its LAST marked block, so a breakpoint planted
 * anywhere inside a zone (not only at the zone's own end) still lands on a
 * message boundary a provider can key on. Two zone-B blocks are 1:1 with
 * `zoneEndsAtBreakpoint`'s old behaviour when the mark sits on the zone's final
 * block — `rest` is then empty and the caller emits one message, unchanged.
 * Zone C's experiment-4 mark (last block before `C:map:*`) is what this exists
 * for: everything through that block is one cacheable message, and the map
 * (plus anything after it in the zone) rides in a second, uncached message.
 */
function splitAtLastMark(
  prompt: AssembledPrompt,
  blocks: readonly PromptBlock[],
): { cached: readonly PromptBlock[]; rest: readonly PromptBlock[] } {
  let cut = -1;
  for (let i = 0; i < blocks.length; i += 1) {
    if (isMarked(prompt, blocks[i]!)) cut = i;
  }
  if (cut === -1) return { cached: [], rest: blocks };
  return { cached: blocks.slice(0, cut + 1), rest: blocks.slice(cut + 1) };
}

/**
 * Provider-facing projection of an assembled prompt: one message per zone by
 * default, or two for a zone carrying an internal breakpoint (experiment 4's
 * opt-in 3rd marker) — the cached run up to and including the marked block,
 * then the remainder, uncached, so the models layer only has to translate a
 * flag into a provider-native one.
 *
 * Zone A is deliberately absent — it ships as `AssembledPrompt.system`, and
 * repeating it here would duplicate the frozen prefix. Its A/B breakpoint is the
 * system/messages boundary, which no message can express: that half of rule 5
 * travels as `CompletionRequest.systemCacheBreakpoint`, so build the request
 * with `toCompletionRequest` rather than assembling one around `toMessages`.
 */
export function toMessages(prompt: AssembledPrompt): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const zone of ['B', 'C', 'tail'] as const) {
    const blocks = prompt.blocks.filter((block) => block.zone === zone);
    if (blocks.length === 0) continue;
    const { cached, rest } = splitAtLastMark(prompt, blocks);
    if (cached.length > 0) {
      messages.push({
        role: 'user',
        content: cached.map((block) => block.text).join('\n\n'),
        cacheBreakpoint: true,
      });
    }
    if (rest.length > 0) {
      messages.push({ role: 'user', content: rest.map((block) => block.text).join('\n\n') });
    }
  }
  return messages;
}

/** Per-call knobs that are not the assembler's business (§11). */
export interface CompletionRequestOptions {
  maxTokens?: number;
  temperature?: number;
  /** Zone A's schemas as the provider's native tool list, not as prompt text. */
  tools?: readonly ToolSchema[];
  json?: boolean;
}

/**
 * The whole prompt as one provider request — Zone A as `system`, zones B/C/tail
 * as messages, and BOTH rule 5 breakpoints attached.
 *
 * This exists because the two halves of rule 5 leave the assembler by different
 * doors: the B/C marker rides a message, while the A/B marker is the
 * system/messages boundary itself and needs a request-level flag. A caller that
 * built a request from `toMessages` alone dropped the Zone A marker silently —
 * nothing fails, the session just pays full price for the frozen prefix on every
 * turn (§17: this failure surfaces here and essentially nowhere else). Emitting
 * both from one function is what keeps them from drifting again.
 */
export function toCompletionRequest(
  prompt: AssembledPrompt,
  model: string,
  options: CompletionRequestOptions = {},
): CompletionRequest {
  const request: CompletionRequest = {
    model,
    system: prompt.system,
    messages: toMessages(prompt),
  };
  // An empty Zone A is not worth a cache write, and a marker on an empty text
  // block is a request the providers reject.
  if (prompt.system !== '' && zoneEndsAtBreakpoint(prompt, 'A')) {
    request.systemCacheBreakpoint = true;
  }
  if (options.maxTokens !== undefined) request.maxTokens = options.maxTokens;
  if (options.temperature !== undefined) request.temperature = options.temperature;
  if (options.tools !== undefined) request.tools = options.tools;
  if (options.json !== undefined) request.json = options.json;
  return request;
}
