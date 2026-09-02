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
}

export interface TailEntry {
  /** `context_fetch` / `context_search` / `context_peek` result text. */
  id: string;
  text: string;
  /** Dropped at the next phase boundary — soft offloading (D6). */
  ephemeral: boolean;
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
}

export interface PromptAssembler {
  assemble(options?: AssembleOptions): AssembledPrompt;
}
