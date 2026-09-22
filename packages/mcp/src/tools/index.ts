/**
 * Every tool as a plain handler, and the one REGISTRY both transports serve. They are exported from the package root
 * as well as registered on the server so §11's eval harness — which runs its
 * own minimal tool-use loop rather than depending on a host — calls exactly the
 * functions the agent sees.
 */
import { ANNOTATE, annotate } from './annotate.js';
import { CONTEXT_FETCH, contextFetch } from './context-fetch.js';
import { CONTEXT_PEEK, contextPeek } from './context-peek.js';
import { CONTEXT_SEARCH, contextSearch } from './context-search.js';
import { CONTEXT_ASSEMBLE, CONTEXT_ASSEMBLE_DESCRIPTION, contextAssemble, contextAssembleInputShape } from './context-assemble.js';
import { CONTEXT_CLASSIFY, CONTEXT_CLASSIFY_DESCRIPTION, contextClassify, contextClassifyInputShape } from './context-classify.js';
import {
  CONTEXT_EVICT,
  CONTEXT_EVICT_DESCRIPTION,
  CONTEXT_RESTORE,
  CONTEXT_RESTORE_DESCRIPTION,
  contextEvict,
  contextEvictInputShape,
  contextRestore,
  contextRestoreInputShape,
} from './context-evict.js';
import { CONTEXT_UNITS, CONTEXT_UNITS_DESCRIPTION, contextUnits, contextUnitsInputShape } from './context-units.js';
import { CONTEXT_FOLD, CONTEXT_FOLD_DESCRIPTION, contextFold, contextFoldInputShape } from './context-fold.js';
import { CONTEXT_SUMMARIZE, CONTEXT_SUMMARIZE_DESCRIPTION, contextSummarize, contextSummarizeInputShape } from './context-summarize.js';
import { ANNOTATE_DESCRIPTION, annotateInputShape } from './annotate.js';
import { CONTEXT_FETCH_DESCRIPTION, contextFetchInputShape } from './context-fetch.js';
import { CONTEXT_PEEK_DESCRIPTION, contextPeekInputShape } from './context-peek.js';
import { CONTEXT_SEARCH_DESCRIPTION, contextSearchInputShape } from './context-search.js';
import type { ToolContext, ToolHandler } from '../types.js';
import { modeOf } from '../types.js';
import type { ZodRawShape } from 'zod';

export {
  ANNOTATE,
  ANNOTATE_DESCRIPTION,
  annotate,
  annotateInputShape,
  annotateSchema,
  type AnnotateData,
  type ContextLinkPayload,
} from './annotate.js';
export {
  CONTEXT_FETCH,
  CONTEXT_FETCH_DESCRIPTION,
  contextFetch,
  contextFetchInputShape,
  contextFetchSchema,
  type ContextFetchData,
} from './context-fetch.js';
export {
  CONTEXT_PEEK,
  CONTEXT_PEEK_DESCRIPTION,
  DEFAULT_PEEK_CHARS,
  MAX_PEEK_CHARS,
  contextPeek,
  contextPeekInputShape,
  contextPeekSchema,
  type ContextPeekData,
} from './context-peek.js';
export {
  CONTEXT_SEARCH,
  CONTEXT_SEARCH_DESCRIPTION,
  contextSearch,
  contextSearchInputShape,
  contextSearchSchema,
  type ContextSearchData,
  type SearchHitPayload,
} from './context-search.js';

export * from './context-assemble.js';
export * from './context-fold.js';
export * from './context-summarize.js';
export * from './context-classify.js';
export * from './context-evict.js';
export * from './context-units.js';
export * from './render.js';
export { budgetOf, messagesArg, turnArg, windowShape } from './pipeline-args.js';

export type Transport = 'mcp' | 'http';

export interface ToolAnnotations {
  readOnlyHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
  destructiveHint?: boolean;
}

/**
 * One row per tool. The MCP server and the HTTP API are both built by iterating
 * this table, so a stage is reachable the same way by an agent and by a host plugin,
 * and replacing a row's `handler` swaps the algorithm behind a name without touching
 * either transport or any caller.
 */
export interface ToolSpec {
  name: string;
  title: string;
  description: string;
  inputShape: ZodRawShape;
  handler: ToolHandler;
  /** Where it is served. */
  transports: readonly Transport[];
  annotations: (ctx: ToolContext) => ToolAnnotations;
}

const BOTH: readonly Transport[] = ['mcp', 'http'];

/** Mode A's read tools touch nothing; Mode B appends a call/result pair to L0 per retrieval (D14). */
const retrieval = (openWorld: (ctx: ToolContext) => boolean) => (ctx: ToolContext): ToolAnnotations => ({
  readOnlyHint: modeOf(ctx) === 'tool-backend',
  idempotentHint: true,
  openWorldHint: openWorld(ctx),
});
const readOnly = (): ToolAnnotations => ({ readOnlyHint: true, idempotentHint: true, openWorldHint: false });
const sessionWrite = (): ToolAnnotations => ({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });

/**
 * The set is FROZEN PER SESSION, not small by decree: tool schemas sit in Zone A, the
 * cached prefix (D5), so what matters is that they do not change mid-session.
 */
export const TOOLS: readonly ToolSpec[] = Object.freeze([
  { name: CONTEXT_FETCH, title: 'Fetch a branch', description: CONTEXT_FETCH_DESCRIPTION, inputShape: contextFetchInputShape, handler: contextFetch, transports: BOTH, annotations: retrieval(() => false) },
  // §9.1 providers shell out to graft/ripgrep and call the Augment API.
  { name: CONTEXT_SEARCH, title: 'Search branch summaries', description: CONTEXT_SEARCH_DESCRIPTION, inputShape: contextSearchInputShape, handler: contextSearch, transports: BOTH, annotations: retrieval((ctx) => ctx.registry !== undefined) },
  { name: CONTEXT_PEEK, title: 'Peek at a node', description: CONTEXT_PEEK_DESCRIPTION, inputShape: contextPeekInputShape, handler: contextPeek, transports: BOTH, annotations: retrieval(() => false) },
  // Summaries are versioned and never overwritten (D3); a note appends.
  { name: ANNOTATE, title: 'Annotate a node', description: ANNOTATE_DESCRIPTION, inputShape: annotateInputShape, handler: annotate, transports: BOTH, annotations: () => ({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }) },
  { name: CONTEXT_UNITS, title: 'List context units', description: CONTEXT_UNITS_DESCRIPTION, inputShape: contextUnitsInputShape, handler: contextUnits, transports: BOTH, annotations: readOnly },
  { name: CONTEXT_CLASSIFY, title: 'Classify units for drift', description: CONTEXT_CLASSIFY_DESCRIPTION, inputShape: contextClassifyInputShape, handler: contextClassify, transports: BOTH, annotations: readOnly },
  { name: CONTEXT_EVICT, title: 'Evict units', description: CONTEXT_EVICT_DESCRIPTION, inputShape: contextEvictInputShape, handler: contextEvict, transports: BOTH, annotations: sessionWrite },
  { name: CONTEXT_RESTORE, title: 'Undo rulings on units', description: CONTEXT_RESTORE_DESCRIPTION, inputShape: contextRestoreInputShape, handler: contextRestore, transports: BOTH, annotations: sessionWrite },
  { name: CONTEXT_ASSEMBLE, title: 'Assemble unit representations', description: CONTEXT_ASSEMBLE_DESCRIPTION, inputShape: contextAssembleInputShape, handler: contextAssemble, transports: BOTH, annotations: sessionWrite },
  // Folds are L0 events (D26): written, never overwritten; `restore` retires one.
  { name: CONTEXT_FOLD, title: 'Fold blocks', description: CONTEXT_FOLD_DESCRIPTION, inputShape: contextFoldInputShape, handler: contextFold, transports: BOTH, annotations: () => ({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }) },
  // Calls the model the context was given (the relay, in the harness) — an outside world.
  { name: CONTEXT_SUMMARIZE, title: 'Summarize a range', description: CONTEXT_SUMMARIZE_DESCRIPTION, inputShape: contextSummarizeInputShape, handler: contextSummarize, transports: BOTH, annotations: () => ({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }) },
]);

export const TOOL_NAMES = [
  CONTEXT_FETCH, CONTEXT_SEARCH, CONTEXT_PEEK, ANNOTATE,
  CONTEXT_UNITS, CONTEXT_CLASSIFY, CONTEXT_ASSEMBLE, CONTEXT_FOLD, CONTEXT_EVICT, CONTEXT_RESTORE, CONTEXT_SUMMARIZE,
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export const HANDLERS = Object.freeze(Object.fromEntries(TOOLS.map((t) => [t.name, t.handler]))) as Readonly<Record<ToolName, ToolHandler>>;

/** The registry with some handlers replaced — how an experiment swaps one stage. */
export function withHandlers(overrides: Readonly<Record<string, ToolHandler>>, base: readonly ToolSpec[] = TOOLS): ToolSpec[] {
  const unknown = Object.keys(overrides).filter((name) => !base.some((t) => t.name === name));
  if (unknown.length > 0) throw new RangeError(`no such tool: ${unknown.join(', ')}`);
  return base.map((t) => (overrides[t.name] !== undefined ? { ...t, handler: overrides[t.name]! } : t));
}
