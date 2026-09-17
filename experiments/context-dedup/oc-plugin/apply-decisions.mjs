/**
 * Applying the sidecar's verdicts to opencode's live message array.
 *
 * This lives BESIDE the plugin, not inside it: opencode's loader calls EVERY export of
 * a plugin module as a plugin factory (`for (let X of Object.values($))` … `throw
 * TypeError("Plugin export is not a function")`), so a second export is invoked with
 * the plugin context, throws, and aborts the load — leaving zero hooks registered and
 * the arm byte-identical to its control, with the failure swallowed into opencode's log.
 * The plugin module therefore exports exactly one thing.
 */

/**
 * Mutates `messages` in place — the hook discards a return value, so a new array would
 * be silently ignored. `drop` splices; `fold` REPLACES the element with a shallow clone
 * rather than editing the host's own message object, which the session store and the
 * export used for grading also reference.
 */
export function applyDecisions(messages, decisions) {
  const byId = new Map();
  for (const decision of decisions) {
    // An id-less decision would collide with every other id-less one and delete the
    // wrong message, including the task statement the sidecar explicitly protected.
    if (typeof decision?.id === 'string' && decision.id) byId.set(decision.id, decision);
  }
  let dropped = 0;
  let folded = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const id = messages[i]?.info?.id;
    if (typeof id !== 'string') continue;
    const decision = byId.get(id);
    if (!decision || decision.action === 'keep') continue;

    if (decision.action === 'drop') {
      messages.splice(i, 1);
      dropped += 1;
      continue;
    }
    if (decision.action === 'fold' && typeof decision.text === 'string') {
      const message = messages[i];
      const text = (message.parts ?? []).find((p) => p.type === 'text');
      // Fold is offered only for a text-only message, so this cannot separate a tool
      // call from its result.
      if (!text) continue;
      messages[i] = { ...message, parts: [{ ...text, text: decision.text }] };
      folded += 1;
    }
  }
  return { dropped, folded };
}
