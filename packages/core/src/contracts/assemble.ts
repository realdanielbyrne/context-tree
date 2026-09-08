/**
 * §10 prompt assembly — layered lifecycle layout (D5). The layout is fixed;
 * content migrates through it by lifecycle. Zone B is never relevance-ordered:
 * reordering the cached prefix is the cache killer.
 */
import type { NodeId } from './ids.js';

export type Zone = 'A' | 'B' | 'C' | 'tail';

export const ZONES: readonly Zone[] = ['A', 'B', 'C', 'tail'] as const;

export interface PromptBlock {
  zone: Zone;
  /** Stable within a zone across turns — cache assertions key on this. */
  id: string;
  text: string;
  tokens: number;
  nodeId?: NodeId;
  /** Provider cache breakpoint emitted after this block (§10 rule 5). */
  cacheBreakpointAfter?: boolean;
}

export interface BudgetReport {
  zoneA: number;
  zoneB: number;
  zoneC: number;
  tail: number;
  total: number;
  /** Zones that ran over their configured budget, after degradation attempts. */
  overBudget: Zone[];
  /** Summaries dropped to fit Zone B, oldest-first (never reordered). */
  droppedFromZoneB: NodeId[];
  /**
   * The host's context window, when the host supplied one, and what this prompt
   * leaves of it.
   *
   * This is the only real constraint in the report: a prompt that exceeds the
   * window fails at the provider, while a zone over its own share merely spent
   * an allocation someone chose. Until 2026-09-02 the assembler had no window
   * at all — it summed `total` and compared it to nothing — so "fits" could
   * only ever mean "fits a share of a number the library did not have". Both
   * fields are `null` when the host supplied no window, which is honest about
   * not knowing rather than assuming a default.
   */
  window: number | null;
  /** `window - total`, negative when the prompt cannot be sent. `null` if no window. */
  windowRemaining: number | null;
  /** True only when a window is known AND the prompt exceeds it. */
  overWindow: boolean;
  /**
   * What to pass as the provider's `max_tokens` this turn — the largest reply
   * that fits beside this prompt. `null` without a window.
   *
   * Per-turn arithmetic, not a chosen ceiling: early in a session it is nearly
   * the whole window, late in a long one it is small, and a session continues
   * on short replies where a fixed ceiling would have made the request invalid.
   */
  replyAllowance: number | null;
  /**
   * Tail entries omitted from THIS candidate so prompt + reply fit the window:
   * oldest acknowledged ephemeral payloads first. Held entries are removed only
   * when this candidate's delivery is acknowledged. Empty
   * when no window is known or nothing was over.
   */
  evictedFromTail: string[];
  /**
   * Zone C event blocks dropped, oldest first, when the tail alone could not
   * make room — the last valve, reported so a run that lost its own recent
   * detail says so.
   */
  droppedFromZoneC: number;
}

export interface TailEntry {
  /** `context_fetch` / `context_search` / `context_peek` result text. */
  id: string;
  text: string;
  /** Eligible for offloading after delivery has been acknowledged (D6). */
  ephemeral: boolean;
}

/** Identity of the selected, rendered payload, not of its full source response. */
export interface DeliveredBlock {
  readonly id: string;
  /** SHA-256 of the exact UTF-8 block text. */
  readonly contentHash: string;
}

/**
 * A delivery candidate. Creating this receipt acknowledges nothing. The host
 * acknowledges it only after successfully sending these exact selected blocks;
 * previews, failed calls, and requests that replace/cut blocks must not use it.
 * Receipts can be journalled beside requests without modifying L0 or L1.
 */
export interface DeliveryReceipt {
  readonly version: 1;
  readonly blocks: readonly DeliveredBlock[];
  readonly tailSource: 'internal' | 'supplied';
  /** Already-delivered tail payloads omitted from this candidate. */
  readonly evictedTail: readonly DeliveredBlock[];
}

export interface AssembleOptions {
  /** The branch expanded in full in Zone C. Defaults to the open phase. */
  activeNodeId?: NodeId;
  zoneBBudget?: number;
  zoneCBudget?: number;
  /**
   * The host's context window for this call, overriding the assembler's.
   * Supplying it is what lets the report name the real constraint; omitting it
   * leaves `window`/`windowRemaining` null rather than guessing.
   */
  window?: number;
  tail?: readonly TailEntry[];
  /** Tool schemas belong to Zone A and must be byte-stable across turns. */
  toolSchemasText?: string;
  /**
   * Optional caller-side Zone B branch selection (top-k). Typed structurally
   * (`{ keepBranches?: ReadonlySet<NodeId> }`) to avoid an import cycle with
   * the assembler; see `ZoneBSelection` there. `undefined` keeps all branches.
   */
  selection?: { keepBranches?: ReadonlySet<NodeId> };
}

export interface AssembledPrompt {
  system: string;
  blocks: PromptBlock[];
  budgets: BudgetReport;
  /** Block ids, in order, that precede each emitted cache breakpoint. */
  cacheBreakpoints: string[];
  /** Present on ZoneAssembler output; optional for other PromptAssembler implementations. */
  deliveryReceipt?: DeliveryReceipt;
}

export type DeliveryPrompt = AssembledPrompt & { deliveryReceipt: DeliveryReceipt };

export interface PromptAssembler {
  assemble(options?: AssembleOptions): AssembledPrompt;
}
