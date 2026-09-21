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
 * tree-sitter) and this is opencode's bun runtime. A treatment turn calls `assemble` (how
 * each unit is represented) and then `evict` if — and only if — its policy says so
 * (`policy.mjs`). The LAST call it makes carries the message list and answers with one
 * decision per message. A fault in either call leaves the prompt untouched rather than
 * taking down the host we are measuring.
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
import { TOKENIZER_ID, sizeOf } from './size.mjs';
import { assembleWindowFor, ceilingOf, evictCallFor, policyFromEnv, reserveOf, validatePolicy } from './policy.mjs';

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

const hasTools = (message) => (message.parts ?? []).some((p) => p.type === 'tool');

/** The turn's question — ranks what a reduction keeps: the newest user text in the array. */
function queryOf(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.info?.role !== 'user') continue;
    const text = (messages[i].parts ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
    if (text.trim()) return text.slice(0, 2000);
  }
  return undefined;
}

// A plugin that fails to import registers no hooks and opencode says NOTHING about it —
// no log line, no error — which is indistinguishable from a plugin that loaded and never
// fired. One line at module scope tells the two apart afterwards.
const POLICY = policyFromEnv();
const PROBLEMS = validatePolicy(POLICY);
log({ event: 'loaded', url: URL_, policy: POLICY, tokenizer: TOKENIZER_ID, problems: PROBLEMS });

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

      const sized = messages.map((m) => ({ id: m?.info?.id, hasTools: hasTools(m) }));
      const before = messages.length;
      const beforeTokens = sizeOf(messages);
      const deadline = Date.now() + TIMEOUT_MS;
      const started = Date.now();

      let assembled = null;
      let evicted = null;
      try {
        const evictCall = evictCallFor(POLICY, turn, beforeTokens);
        const window = assembleWindowFor(POLICY);
        if (window !== null) {
          assembled = await callTool('assemble', {
            window_tokens: window, reserve_tokens: reserveOf(POLICY, window), query: queryOf(messages), turn,
            ...(evictCall ? {} : { messages: sized }),
          }, deadline);
        }
        if (evictCall) {
          const { floor, ...args } = evictCall;
          evicted = { floor, window: args.window_tokens, ...(await callTool('evict', { ...args, messages: sized }, deadline)) };
        }
      } catch (error) {
        // Fail open: an unreachable or slow server must leave the turn untouched.
        log({ turn, error: String(error?.message ?? error), before, applied: false, ms: Date.now() - started });
        return;
      }

      const decisions = (evicted ?? assembled)?.decisions ?? [];
      const applied = applyDecisions(messages, decisions);
      const keptTokens = sizeOf(messages);
      log({
        turn, before, after: messages.length, before_tokens: beforeTokens, kept_tokens: keptTokens,
        dropped: applied.dropped, folded: applied.folded, reduced: applied.reduced, decisions: decisions.length,
        assembled: assembled !== null, evict_called: evicted !== null, evict_window: evicted?.window ?? null, evict_floor: evicted?.floor ?? false,
        evicted_now: evicted?.evicted?.length ?? 0, evicted_total: evicted?.evicted_total ?? null,
        over_ceiling: keptTokens > ceilingOf(POLICY), ms: Date.now() - started,
      });
    },
  };
};
