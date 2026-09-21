/**
 * CT-ASSEMBLE PLUGIN — context-tree at opencode's prompt-assembly seam.
 *
 * `experimental.chat.messages.transform` is the only place anything outside opencode
 * can change what the model sees: it fires once per turn with the message array, just
 * before `toModelMessagesEffect` converts it for the provider.
 *
 * THREE FACTS ABOUT THIS HOOK, read off the 1.18.31 binary, each of which silently
 * voids an arm if ignored:
 *   1. It is IN-PLACE ONLY. `Plugin.trigger` discards the hook's return value and the
 *      call site consumes its own binding, so `output.messages = next` is a no-op.
 *      Every edit here goes through `splice` on the array we were handed.
 *   2. The system prompt, skills and MCP instructions are assembled AFTER this hook,
 *      so the frozen head is out of reach from here — by construction, not by choice.
 *   3. It fires a SECOND time during compaction, on a clone of the compaction head,
 *      with the same empty `input` — the two calls are indistinguishable. The arms run
 *      with `compaction.auto: false`, so that second call does not happen; if it ever
 *      does, the turn counter would double-count.
 *
 * The plugin holds the POLICY and nothing else. The pipeline is tools served over loopback
 * HTTP by `@context-tree/mcp` (D22), running in the sidecar because it needs Node (SQLite,
 * tree-sitter) and this is opencode's bun runtime. Each turn the plugin calls
 * `evict` if — and only if — its policy says so (`policy.mjs`), then
 * `verdicts` to learn what that means for the host's messages. A fault in either
 * call leaves the prompt untouched rather than taking down the host we are measuring.
 *
 * It registers exactly ONE hook. A plugin registering only `chat.params` hung opencode
 * at init in this repo's own run (`oc-runner.mjs:27-29`, cause undiagnosed).
 *
 * IT EXPORTS EXACTLY ONE THING. opencode calls every export of a plugin module as a
 * plugin factory, so a second export aborts the load and registers no hooks at all —
 * the helper lives in `apply-decisions.mjs` for that reason.
 *
 *   CT_TOOLS_URL       the tool API's base    (default http://127.0.0.1:8899/v1/tools)
 *   CT_ASSEMBLE_MS     per-turn budget, shared by both calls (default 8000)
 *   CT_CT_*            the policy — see policy.mjs
 *   CT_ASSEMBLE_TOKEN  shared secret; the agent shares this loopback
 *   CT_PLUGIN_EVENTS   jsonl of what each turn did, for the fire gate
 */
import { appendFileSync } from 'node:fs';
import { applyDecisions } from './apply-decisions.mjs';
import { ceilingOf, evictCallFor, policyFromEnv, validatePolicy } from './policy.mjs';

const URL_ = process.env.CT_TOOLS_URL || 'http://127.0.0.1:8899/v1/tools';
const TIMEOUT_MS = Number(process.env.CT_ASSEMBLE_MS || 8000);
const TOKEN = process.env.CT_ASSEMBLE_TOKEN || '';
const EVENTS = process.env.CT_PLUGIN_EVENTS || '';

const log = (ev) => {
  if (!EVENTS) return;
  try {
    appendFileSync(EVENTS, `${JSON.stringify({ ts: new Date().toISOString(), ...ev })}\n`);
  } catch {
    // Evidence, not the experiment.
  }
};

/** ~4 chars per token — the host's own fallback, and good enough to rank messages. */
const estimateTokens = (message) => {
  let chars = 0;
  for (const part of message.parts ?? []) {
    if (typeof part.text === 'string') chars += part.text.length;
    const state = part.state ?? {};
    if (typeof state.output === 'string') chars += state.output.length;
    if (state.input) chars += JSON.stringify(state.input).length;
  }
  return Math.ceil(chars / 4);
};

const hasTools = (message) => (message.parts ?? []).some((p) => p.type === 'tool');

// A plugin that fails to import registers no hooks and opencode says NOTHING about it —
// no log line, no error — which is indistinguishable from a plugin that loaded and never
// fired. One line at module scope tells the two apart afterwards.
const POLICY = policyFromEnv();
const PROBLEMS = validatePolicy(POLICY);
log({ event: 'loaded', url: URL_, policy: POLICY, problems: PROBLEMS });

async function callTool(name, body, deadline) {
  const response = await fetch(`${URL_}/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
  });
  const outcome = await response.json();
  if (!outcome?.ok) throw new Error(`${name}: ${outcome?.error?.code ?? response.status} ${outcome?.error?.message ?? ''}`.trim());
  return outcome.data;
}

export const server = async () => {
  log({ event: 'registered' });
  let turn = 0;
  return {
    'experimental.chat.messages.transform': async (_input, output) => {
      turn += 1;
      const messages = output?.messages;
      if (!Array.isArray(messages) || messages.length === 0) return;
      // A mistyped knob is refused by the runner before anything starts; if one gets here
      // anyway the arm does nothing and says so, rather than running on a NaN window.
      if (PROBLEMS.length > 0) { log({ turn, error: `policy refused: ${PROBLEMS.join('; ')}`, applied: false }); return; }

      const sized = messages.map((m) => ({ id: m?.info?.id, tokens: estimateTokens(m), hasTools: hasTools(m) }));
      const before = messages.length;
      const beforeTokens = sized.reduce((n, m) => n + m.tokens, 0);
      const deadline = Date.now() + TIMEOUT_MS;
      const started = Date.now();

      let evict = null;
      let verdicts;
      try {
        const call = evictCallFor(POLICY, turn, beforeTokens);
        if (call) {
          const { floor, ...args } = call;
          evict = { floor, window: args.window_tokens, ...(await callTool('evict', args, deadline)) };
        }
        verdicts = await callTool('verdicts', {
          messages: sized, protect_tail: POLICY.protectTail, summaries: POLICY.summaries, ceiling_tokens: ceilingOf(POLICY), turn,
        }, deadline);
      } catch (error) {
        // Fail open: an unreachable or slow server must leave the turn untouched.
        log({ turn, error: String(error?.message ?? error), before, applied: false, ms: Date.now() - started });
        return;
      }

      const applied = applyDecisions(messages, verdicts.decisions ?? []);
      log({
        turn, before, after: messages.length, before_tokens: beforeTokens, kept_tokens: verdicts.kept_tokens,
        dropped: applied.dropped, folded: applied.folded, decisions: (verdicts.decisions ?? []).length,
        evict_called: evict !== null, evict_window: evict?.window ?? null, evict_floor: evict?.floor ?? false,
        evicted_now: evict?.evicted?.length ?? 0, evicted_total: verdicts.evicted_units,
        indexed: verdicts.indexed, over_ceiling: verdicts.over_ceiling, escalations: verdicts.escalations, ms: Date.now() - started,
      });
    },
  };
};
