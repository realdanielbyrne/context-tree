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
  tail?: readonly TailEntry[];
  /** Tool schemas belong to Zone A and must be byte-stable across turns. */
  toolSchemasText?: string;
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
