/**
 * Re-derivability: can the agent get this content back by re-running a tool?
 *
 * Iteration 1 (lens 3) found that eviction safety is not a function of a
 * relevance score. A unit whose content is a coordinate into a durable store is
 * cheap to eject, because the agent re-reads it — that behaviour was observed
 * unprompted at ABS turn 39, which spent 29,082 tokens re-acquiring files the
 * agent had been editing for 24 turns. A unit whose content is an observation of
 * transient state cannot be recovered at any price: the `git stash` A/B that
 * established which test failures pre-existed was referenced 10 and 11 turns
 * later and nothing on disk could reconstruct it.
 *
 * This is the repo's own L0/L2 invariant applied to attention: keep coordinates,
 * eject payloads a coordinate can re-derive, never eject unrepeatable
 * observations. It is also the "dependency-tracking" eviction criterion that the
 * long-context literature lists as proposed but does not specify.
 *
 * Deterministic and label-free by construction — it reads the tool name only.
 * That is the point: every earlier attention hypothesis was ineligible for want
 * of hand-supplied relevance labels.
 */

/** Tools whose results are a view of a durable store, re-readable on demand. */
const DURABLE_VIEW = new Set(['read_file', 'write_file', 'edit_file']);

/** Tools that read the append-only trace, which is deterministic by D1. */
const TRACE_VIEW = new Set(['context_fetch', 'context_search', 'context_peek']);

/**
 * `undefined` when the tool is unknown — an unknown tool is NOT assumed
 * re-derivable, because assuming it is would evict content nothing can restore.
 * Unknown degrades to "keep", never to "crash" and never to "drop".
 */
/**
 * Tools known to observe transient state: exit codes, test results, timestamps,
 * the working tree at one instant. Re-running one is not a re-read and may not
 * reproduce what it produced.
 */
const KNOWN_TRANSIENT = new Set(['run_command']);

export function isRederivable(tool: string | undefined): boolean | undefined {
  if (tool === undefined || tool.trim() === '') return undefined;
  if (DURABLE_VIEW.has(tool) || TRACE_VIEW.has(tool)) return true;
  if (KNOWN_TRANSIENT.has(tool)) return false;
  // An unfamiliar tool is `undefined`, not `false`. Both are kept, but they are
  // different facts and the audit must not blur them: `false` is a measured
  // classification, `undefined` is an admission that this host has a tool the
  // policy has never seen. Silently classifying the unknown would let a new
  // tool's output be evicted the day it ships.
  return undefined;
}
