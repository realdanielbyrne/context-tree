/**
 * Line coordinates shared by the hunker and the extractor.
 *
 * Both must agree on "what line 1 is", or a hunk's 1-based range would not
 * address the same row tree-sitter reports (§12 step 2).
 */

/**
 * Splits into logical lines. A trailing newline terminates the last line
 * rather than starting an empty one — otherwise a file's line count would
 * exceed the rows tree-sitter can resolve.
 */
export function splitLines(content: string): string[] {
  const parts = content.split('\n');
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/** 1-based line count; always >= 1 so a degraded whole-file span is addressable. */
export function lineCount(content: string): number {
  return Math.max(1, splitLines(content).length);
}
