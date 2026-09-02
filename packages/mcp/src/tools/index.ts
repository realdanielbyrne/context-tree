/**
 * The four §9 tools as plain handlers. They are exported from the package root
 * as well as registered on the server so §11's eval harness — which runs its
 * own minimal tool-use loop rather than depending on a host — calls exactly the
 * functions the agent sees.
 */
import { ANNOTATE, annotate } from './annotate.js';
import { CONTEXT_FETCH, contextFetch } from './context-fetch.js';
import { CONTEXT_PEEK, contextPeek } from './context-peek.js';
import { CONTEXT_SEARCH, contextSearch } from './context-search.js';
import type { ToolHandler } from '../types.js';

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
  type SearchHitMeta,
  type SearchHitPayload,
} from './context-search.js';

/**
 * Exactly four (§9: three read tools plus one write tool). The set is closed on
 * purpose — Zone A is frozen (D5), and every tool added to it is paid for in
 * every prompt of every session forever.
 */
export const TOOL_NAMES = [CONTEXT_FETCH, CONTEXT_SEARCH, CONTEXT_PEEK, ANNOTATE] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export const HANDLERS: Readonly<Record<ToolName, ToolHandler>> = Object.freeze({
  [CONTEXT_FETCH]: contextFetch,
  [CONTEXT_SEARCH]: contextSearch,
  [CONTEXT_PEEK]: contextPeek,
  [ANNOTATE]: annotate,
});
