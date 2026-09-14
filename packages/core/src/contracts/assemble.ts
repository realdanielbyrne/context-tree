/**
 * §10 prompt assembly — the flex-buffer layout. A frozen head (system + steering
 * + all user prompts) → a cache breakpoint → a creation-order flex buffer of
 * units → a tail of retrieved results appended after it. Nothing reorders the
 * cached prefix (a re-mixed buffer is cache-death). Built by `assembleFlex`.
 */
import type { NodeId } from './ids.js';

/** Prompt regions, in prefix order. */
export type Zone = 'head' | 'flex' | 'tail';

export const ZONES: readonly Zone[] = ['head', 'flex', 'tail'] as const;

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
  /** Frozen-head tokens (system + steering + all user prompts). */
  head: number;
  /** Flex-buffer tokens (the units kept this turn). */
  flex: number;
  /** Tail tokens (retrieved results appended after the buffer). */
  tail: number;
  total: number;
  /** Regions that ran over a configured budget. */
  overBudget: Zone[];
  /** Units evicted from the flex buffer this turn (lowest-scoring first). */
  evicted: NodeId[];
  /**
   * Raw units shrunk in place by reduce-on-overflow this turn — each exceeded the
   * per-unit budget `b` and was chunked/summarized down to it (anchors included:
   * they are never evicted but can still be reduced).
   */
  reduced: NodeId[];
  /**
   * The host's context window, when supplied, and what this prompt leaves of it.
   * The only real constraint in the report: a prompt over the window fails at the
   * provider. `null` when the host supplied no window (honest about not knowing).
   */
  window: number | null;
  /** `window - total`, negative when the prompt cannot be sent. `null` if no window. */
  windowRemaining: number | null;
  /** True only when a window is known AND the prompt exceeds it. */
  overWindow: boolean;
  /**
   * What to pass as the provider's `max_tokens` this turn — the largest reply
   * that fits beside this prompt. `null` without a window. Per-turn arithmetic,
   * not a chosen ceiling.
   */
  replyAllowance: number | null;
  /** Tail entries omitted from THIS candidate so prompt + reply fit the window. */
  evictedFromTail: string[];
}

export interface AssembledPrompt {
  system: string;
  blocks: PromptBlock[];
  budgets: BudgetReport;
  /** Block ids, in order, that precede each emitted cache breakpoint. */
  cacheBreakpoints: string[];
}
