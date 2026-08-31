/**
 * Markdown neutralization for the L4 view (§6).
 *
 * Summary text is model-written prose inlined into a generated outline, so
 * anything in it that can restructure the document has to be defanged first: a
 * summary opening with `## Findings` forges a branch heading, an unbalanced code
 * fence or HTML comment swallows every node after it, and either one makes the
 * view lie about the shape of the tree. Escaping (rather than stripping) keeps
 * the text byte-faithful for the agent-readable consumer.
 */

/** ATX heading — the marker that would forge a node heading. */
const ATX = /^( {0,3})(#{1,6})(?:[ \t]|$)/;
/** Fence open/close: an odd one swallows the rest of the document. */
const FENCE = /^( {0,3})(?:`{3,}|~{3,})/;
/** Setext underline: promotes the *preceding* line to a heading. */
const SETEXT = /^( {0,3})(?:=+|-+)[ \t]*$/;
/** An HTML comment comments out the markdown that follows it. */
const HTML_COMMENT = /^( {0,3})<!--/;

const HAZARDS: readonly RegExp[] = [ATX, FENCE, SETEXT, HTML_COMMENT];

/**
 * Renders untrusted multi-line text safe to paste into the outline, preserving
 * its line structure. Line endings are normalized so the same summary produces
 * the same bytes regardless of what the model emitted (D8 determinism).
 */
export function escapeBlock(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(escapeLine)
    .join('\n');
}

function escapeLine(line: string): string {
  for (const hazard of HAZARDS) {
    const match = hazard.exec(line);
    if (match === null) continue;
    const indent = match[1] ?? '';
    // A backslash before the marker makes markdown render it as literal text.
    return `${indent}\\${line.slice(indent.length)}`;
  }
  return line;
}

/**
 * Collapses text to a single line for use inside a bullet or heading, where a
 * newline would end the item and break the outline.
 */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
