/**
 * What the plugin's message array costs, in the SAME tokenizer the sidecar budgets with
 * (`@context-tree/core` `HeuristicTokenizer`, the session's `tokenizer`). The plugin used
 * its own `ceil(chars/4)`, so a window was ruled in one unit and checked in another: on the
 * U18 gate cells the provider served 1.17–1.18 tokens per chars/4 token and 0.86–0.92 per
 * core token.
 *
 * Imported by file, not through the package index, which loads SQLite and tree-sitter into
 * the host's runtime. The relative path has the same shape inside the sandbox (`MCP_PATHS`).
 */
import { HeuristicTokenizer } from '../../../packages/core/dist/tokens/index.js';

const tokenizer = new HeuristicTokenizer();
export const TOKENIZER_ID = tokenizer.id;

/** Everything of a message the host sends: text and reasoning, tool input and output. */
export function messageTokens(message) {
  let total = 0;
  for (const part of message?.parts ?? []) {
    if (typeof part.text === 'string') total += tokenizer.count(part.text);
    const state = part.state ?? {};
    if (typeof state.output === 'string') total += tokenizer.count(state.output);
    if (state.input) total += tokenizer.count(JSON.stringify(state.input));
  }
  return total;
}

export const sizeOf = (messages) => messages.reduce((n, m) => n + messageTokens(m), 0);
