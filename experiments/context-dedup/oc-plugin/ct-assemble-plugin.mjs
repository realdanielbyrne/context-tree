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
 * The plugin is deliberately thin. It runs inside opencode's bun runtime, while the
 * pipeline it serves (SQLite store, tree-sitter, `assembleFlex`) needs Node — so the
 * decision is made by the sidecar over loopback, and a fault there leaves the prompt
 * untouched rather than taking down the host we are measuring.
 *
 * It registers exactly ONE hook. A plugin registering only `chat.params` hung opencode
 * at init in this repo's own run (`oc-runner.mjs:27-29`, cause undiagnosed).
 *
 * IT EXPORTS EXACTLY ONE THING. opencode calls every export of a plugin module as a
 * plugin factory, so a second export aborts the load and registers no hooks at all —
 * the helper lives in `apply-decisions.mjs` for that reason.
 *
 *   CT_ASSEMBLE_URL    sidecar endpoint       (default http://127.0.0.1:8899/assemble)
 *   CT_ASSEMBLE_MS     per-turn timeout       (default 8000)
 *   CT_ASSEMBLE_TOKEN  shared secret; the agent shares this loopback
 *   CT_PLUGIN_EVENTS   jsonl of what each turn did, for the fire gate
 */
import { appendFileSync } from 'node:fs';
import { applyDecisions } from './apply-decisions.mjs';

const URL_ = process.env.CT_ASSEMBLE_URL || 'http://127.0.0.1:8899/assemble';
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

/** The turn's question, for retrieval: the newest user text in the array. */
function queryOf(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.info?.role !== 'user') continue;
    const text = (messages[i].parts ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
    if (text.trim()) return text.slice(0, 2000);
  }
  return '';
}

export const server = async () => {
  let turn = 0;
  return {
    'experimental.chat.messages.transform': async (_input, output) => {
      turn += 1;
      const messages = output?.messages;
      if (!Array.isArray(messages) || messages.length === 0) return;

      const payload = {
        query: queryOf(messages),
        messages: messages.map((m) => ({
          id: m?.info?.id, role: m?.info?.role, tokens: estimateTokens(m), hasTools: hasTools(m),
        })),
      };
      const before = messages.length;
      const beforeTokens = payload.messages.reduce((n, m) => n + m.tokens, 0);

      let decisions = [];
      try {
        const response = await fetch(URL_, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(TOKEN ? { 'x-ct-token': TOKEN } : {}) },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const body = await response.json();
        decisions = Array.isArray(body.decisions) ? body.decisions : [];
      } catch (error) {
        // Fail open: an unreachable or slow sidecar must leave the turn untouched.
        log({ turn, error: String(error?.message ?? error), before, applied: false });
        return;
      }

      const applied = applyDecisions(messages, decisions);
      log({
        turn, before, after: messages.length, before_tokens: beforeTokens,
        dropped: applied.dropped, folded: applied.folded, decisions: decisions.length,
      });
    },
  };
};
