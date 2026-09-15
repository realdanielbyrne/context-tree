/**
 * Pure parsing of `opencode run --format json` event streams and `opencode export` JSON, for
 * the SWE-bench pilot. No I/O; unit-tested in swebench-opencode-events.test.mjs.
 *
 * The event schema is not documented as stable, so every accessor tolerates missing fields
 * and the summary records how many lines were unparseable rather than throwing: a run whose
 * accounting cannot be read is flagged, not silently zeroed.
 */

export function parseJsonLines(text) {
  const events = []; let bad = 0;
  for (const line of String(text || '').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { events.push(JSON.parse(s)); } catch { bad += 1; }
  }
  return { events, bad };
}

const get = (o, path) => path.reduce((v, k) => (v == null ? undefined : v[k]), o);
const firstDefined = (...xs) => xs.find((x) => x !== undefined && x !== null);

/** First session id seen on any event (top level, part, or info). */
export function sessionIdOf(events) {
  for (const e of events) {
    const id = firstDefined(e.sessionID, get(e, ['part', 'sessionID']), get(e, ['properties', 'sessionID']), get(e, ['info', 'sessionID']));
    if (id) return id;
  }
  return null;
}

/** Normalise a token record from a step_finish part or event. */
export function tokensOf(t) {
  if (!t || typeof t !== 'object') return null;
  const n = (v) => (Number.isFinite(+v) ? +v : 0);
  return {
    input: n(t.input), output: n(t.output), reasoning: n(t.reasoning),
    cache_read: n(get(t, ['cache', 'read'])), cache_write: n(get(t, ['cache', 'write'])),
  };
}

/** Every part-like object in an event stream: `{ ...part }` from `e.part` or the event itself. */
function partsOf(events) {
  return events.map((e) => (e && typeof e.part === 'object' ? { ...e.part, _event: e.type } : { ...e, _event: e.type }));
}

const isStepFinish = (p) => p.type === 'step-finish' || p.type === 'step_finish' || p._event === 'step_finish' || p._event === 'step-finish';
const isTool = (p) => p.type === 'tool' || p._event === 'tool_use' || p._event === 'tool';

/**
 * Per-run accounting. Peak context = max per-step PROMPT size, where the prompt is
 * input + cache_read + cache_write (providers report cached prefix tokens outside `input`).
 */
export function summarizeEvents(events) {
  const steps = [];
  const seenStep = new Set();
  for (const p of partsOf(events)) {
    if (!isStepFinish(p)) continue;
    const key = p.id ?? `${steps.length}`;
    if (seenStep.has(key)) continue;
    seenStep.add(key);
    const t = tokensOf(p.tokens);
    if (t) steps.push({ ...t, cost: Number.isFinite(+p.cost) ? +p.cost : 0, reason: p.reason ?? null });
  }
  const tools = [];
  const seenTool = new Set();
  for (const p of partsOf(events)) {
    if (!isTool(p)) continue;
    const status = get(p, ['state', 'status']);
    const key = p.callID ?? p.id;
    if (status && status !== 'completed' && status !== 'error') continue; // pending/running updates
    if (key && seenTool.has(key)) continue;
    if (key) seenTool.add(key);
    tools.push({ tool: p.tool ?? p.name ?? null, status: status ?? null, input: get(p, ['state', 'input']) ?? null });
  }
  const sum = (k) => steps.reduce((s, x) => s + x[k], 0);
  const promptOf = (x) => x.input + x.cache_read + x.cache_write;
  const errors = events.filter((e) => e.type === 'error' || e.error).map((e) => String(get(e, ['error', 'data', 'message']) ?? get(e, ['error', 'message']) ?? e.error ?? 'error').slice(0, 300));
  return {
    steps: steps.length,
    // `length` = a step ended because the output budget ran out (here: reasoning consumed it
    // all). If the FINAL step is a length stop, the session ended without the agent deciding to.
    final_step_reason: steps.length ? steps[steps.length - 1].reason : null,
    length_stops: steps.filter((x) => x.reason === 'length').length,
    // Largest single response (output + reasoning in one step): what a per-response cap binds on.
    max_step_response_tokens: steps.length ? Math.max(...steps.map((x) => x.output + x.reasoning)) : 0,
    tokens: {
      input: sum('input'), output: sum('output'), reasoning: sum('reasoning'),
      cache_read: sum('cache_read'), cache_write: sum('cache_write'),
    },
    peak_prompt_tokens: steps.length ? Math.max(...steps.map(promptOf)) : 0,
    first_step_prompt_tokens: steps.length ? promptOf(steps[0]) : 0,
    cost_reported: +sum('cost').toFixed(6),
    tool_calls: tools.length,
    tools_by_name: tools.reduce((a, t) => ({ ...a, [t.tool]: (a[t.tool] || 0) + 1 }), {}),
    tool_errors: tools.filter((t) => t.status === 'error').length,
    files_edited: [...new Set(tools.filter((t) => /^(edit|write|patch|multiedit|apply_patch)$/.test(String(t.tool))).map((t) => firstDefined(get(t, ['input', 'filePath']), get(t, ['input', 'path']))).filter(Boolean))],
    files_read: [...new Set(tools.filter((t) => t.tool === 'read').map((t) => firstDefined(get(t, ['input', 'filePath']), get(t, ['input', 'path']))).filter(Boolean))],
    reads: tools.filter((t) => t.tool === 'read').length,
    errors,
  };
}

/** Part-type counts and step/tool totals of an `opencode export` document. */
export function summarizeExport(doc) {
  const parts = (doc?.messages || []).flatMap((m) => m.parts || []);
  const types = parts.reduce((a, p) => ({ ...a, [p.type]: (a[p.type] || 0) + 1 }), {});
  const tools = parts.filter((p) => p.type === 'tool' && ['completed', 'error'].includes(p.state?.status)).length;
  // Reasoning measured from the transcript itself. Token counts cannot be used: the local host
  // reports reasoning_tokens as 0 even while it returns reasoning text.
  const reasoning = parts.filter((p) => p.type === 'reasoning');
  const reasoningChars = reasoning.reduce((s, p) => s + (typeof p.text === 'string' ? p.text.length : 0), 0);
  return { messages: (doc?.messages || []).length, part_types: types, steps: types['step-finish'] || 0, tool_calls: tools, reasoning_parts: reasoning.length, reasoning_chars: reasoningChars };
}

/**
 * Did the captured event stream see the whole run? The export (read from opencode's session
 * store) is the reference. A stream with FEWER steps or tool calls lost events; token
 * accounting and peak context computed from it would be understated.
 */
export function eventsCompleteAgainstExport(eventSummary, exportSummary) {
  const missingSteps = exportSummary.steps - eventSummary.steps;
  const missingTools = exportSummary.tool_calls - eventSummary.tool_calls;
  return { complete: missingSteps <= 0 && missingTools <= 0, missing_steps: Math.max(0, missingSteps), missing_tool_calls: Math.max(0, missingTools) };
}

/**
 * Classify how an opencode process ended. The runner's own timeout kills with SIGKILL, so a
 * SIGTERM/SIGINT/SIGHUP is attributed to something OUTSIDE the harness. A run is valid only
 * on a clean exit 0 that produced at least one step and no error event.
 */
export function classifyExit({ code, signal, timedOut, steps = 0, errors = 0 }) {
  if (timedOut) return { outcome: 'timeout', killed_externally: false, valid: false };
  if (signal !== null && signal !== undefined) {
    return { outcome: signal === 'SIGKILL' ? 'killed' : 'killed_externally', killed_externally: signal !== 'SIGKILL', valid: false };
  }
  if (code !== 0) return { outcome: 'nonzero_exit', killed_externally: false, valid: false };
  if (steps <= 0) return { outcome: 'no_steps', killed_externally: false, valid: false };
  if (errors > 0) return { outcome: 'error_event', killed_externally: false, valid: false };
  return { outcome: 'ok', killed_externally: false, valid: true };
}

/** Cost at list prices ($ per million tokens). Cached reads billed at `cacheRead` if given. */
export function costAt(tokens, { input, output, cacheRead = input, cacheWrite = input }) {
  return +((tokens.input * input + (tokens.output + tokens.reasoning) * output + tokens.cache_read * cacheRead + tokens.cache_write * cacheWrite) / 1e6).toFixed(6);
}
