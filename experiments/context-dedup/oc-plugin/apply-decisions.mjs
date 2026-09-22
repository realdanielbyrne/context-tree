/**
 * Applying the sidecar's decisions to opencode's live message array.
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
 * be silently ignored. `drop` splices. `edit` REPLACES the element with a shallow clone
 * whose parts are edited, never the host's own message object, which the session store
 * and the export used for grading also reference.
 *
 * An edit names parts, not the message (D26): `reasoning` / `text` apply to every part
 * of that kind (the importer joins them into one block) — replaced by `text`, or removed
 * when `text` is null; `tool` names the n-th tool part and replaces its OUTPUT, or removes
 * the whole part (call and result together) when `text` is null. A message left with no
 * text, reasoning or tool part is dropped: an empty message is not a message.
 */
export function applyDecisions(messages, decisions) {
  const byId = new Map();
  for (const decision of decisions) {
    // An id-less decision would collide with every other id-less one and delete the
    // wrong message, including the task statement the sidecar explicitly protected.
    if (typeof decision?.id === 'string' && decision.id) byId.set(decision.id, decision);
  }
  // `reasoning_edited` is a reasoning part replaced OR removed; `reasoning_replaced` only the former
  // (the think rule and a carrier), `tools_removed` a whole tool part gone (a carrier) — the gate
  // dates each edit kind from its own first turn, and a stub's removed reasoning is not a think.
  const counts = { dropped: 0, edited: 0, reasoning_edited: 0, reasoning_replaced: 0, text_edited: 0, outputs_edited: 0, parts_removed: 0, tools_removed: 0 };
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const id = messages[i]?.info?.id;
    if (typeof id !== 'string') continue;
    const decision = byId.get(id);
    if (!decision || decision.action === 'keep') continue;

    if (decision.action === 'drop') {
      messages.splice(i, 1);
      counts.dropped += 1;
      continue;
    }
    if (decision.action !== 'edit' || !Array.isArray(decision.edits)) continue;
    const message = messages[i];
    const byKind = { reasoning: null, text: null };
    const byTool = new Map();
    for (const edit of decision.edits) {
      if (edit.part === 'tool' && Number.isInteger(edit.index)) byTool.set(edit.index, edit.text);
      else if (edit.part === 'reasoning' || edit.part === 'text') byKind[edit.part] = { text: edit.text };
    }
    let toolIndex = -1;
    let touched = false;
    const seen = { reasoning: false, text: false };
    const parts = [];
    for (const part of message.parts ?? []) {
      if (part.type === 'reasoning' || part.type === 'text') {
        const edit = byKind[part.type];
        if (edit === null) { parts.push(part); continue; }
        touched = true;
        if (part.type === 'reasoning') counts.reasoning_edited += 1; else counts.text_edited += 1;
        if (edit.text === null) { counts.parts_removed += 1; continue; }
        // The replacement goes in the first part of its kind; later ones go.
        if (seen[part.type]) { counts.parts_removed += 1; continue; }
        seen[part.type] = true;
        if (part.type === 'reasoning') counts.reasoning_replaced += 1;
        parts.push({ ...part, text: edit.text });
        continue;
      }
      if (part.type === 'tool') {
        toolIndex += 1;
        if (!byTool.has(toolIndex)) { parts.push(part); continue; }
        const text = byTool.get(toolIndex);
        touched = true;
        if (text === null) { counts.parts_removed += 1; counts.tools_removed += 1; continue; }
        if (typeof part.state?.output !== 'string') { parts.push(part); continue; }
        counts.outputs_edited += 1;
        parts.push({ ...part, state: { ...part.state, output: text } });
        continue;
      }
      parts.push(part);
    }
    if (!touched) continue;
    counts.edited += 1;
    if (!parts.some((part) => part.type === 'text' || part.type === 'tool' || part.type === 'reasoning')) messages.splice(i, 1);
    else messages[i] = { ...message, parts };
  }
  return counts;
}
