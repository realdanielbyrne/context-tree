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
 * be silently ignored. `drop` splices; `fold` and `reduce` REPLACE the element with a
 * shallow clone rather than editing the host's own message object, which the session
 * store and the export used for grading also reference.
 *
 * `reduce` swaps the OUTPUT TEXT of the named tool parts and nothing else: the part, its
 * call and its result stay where they are, so a reduction can never orphan a result.
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
  let reduced = 0;
  let stubbed = 0;
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
      continue;
    }
    // `stub` is `reduce` plus the reasoning removed: the message, its text and its tool calls
    // stay — the agent's own record of what it did — and each listed output becomes a tag.
    const stub = decision.action === 'stub';
    if ((stub || decision.action === 'reduce') && Array.isArray(decision.outputs)) {
      const message = messages[i];
      const byToolIndex = new Map(decision.outputs.map((o) => [o.index, o.text]));
      let toolIndex = -1;
      let touched = false;
      const kept = (message.parts ?? []).filter((part) => !(stub && part.type === 'reasoning'));
      if (kept.length !== (message.parts ?? []).length) touched = true;
      const parts = kept.map((part) => {
        if (part.type !== 'tool') return part;
        toolIndex += 1;
        const text = byToolIndex.get(toolIndex);
        if (typeof text !== 'string' || typeof part.state?.output !== 'string') return part;
        touched = true;
        return { ...part, state: { ...part.state, output: text } };
      });
      if (!touched) continue;
      // Nothing but reasoning: there is no residue to show, and an empty message is not a message.
      if (!parts.some((part) => part.type === 'text' || part.type === 'tool')) messages.splice(i, 1);
      else messages[i] = { ...message, parts };
      if (stub) stubbed += 1;
      else reduced += 1;
    }
  }
  return { dropped, folded, reduced, stubbed };
}
