/**
 * The excerpt an event hit carries: a window of `chars` characters from the
 * event's rendered text, centred on the first occurrence of any matched term
 * (case-insensitive), or the head of the text when no term occurs. Elisions
 * are marked so a model can tell an excerpt from a whole.
 *
 * Why a window and not the whole event: the published alternative this unit
 * was measured against (claude.ai's `conversation_search`) returns ~200-360-word
 * chunks, and on this project's store that size carried the answer literal on
 * 48 of 56 recorded queries at ~1.7k tokens per five hits — a payload the
 * model can answer from without a fetch (`reports/metrics/window-regime-and-retrieval-unit-report.md` §7).
 */
export function excerptAround(text: string, terms: readonly string[], chars: number, anchor: 'first' | 'rarest' = 'first'): string {
  if (text.length <= chars) return text;
  const lower = text.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const idx = lower.indexOf(String(term).toLowerCase());
    if (idx >= 0 && (at < 0 || idx < at)) at = idx;
  }
  // Isolated experimental repair: prefer the least frequent matched term. The
  // historical first-match anchor remains the default and size is unchanged.
  if (anchor === 'rarest') {
    const matches = [...new Set(terms.map((term) => term.toLowerCase()).filter(Boolean))].flatMap((term) => {
      const start = lower.indexOf(term);
      if (start < 0) return [];
      let count = 0;
      let offset = start;
      while (offset >= 0) { count++; offset = lower.indexOf(term, offset + term.length); }
      return [{ start, count, length: term.length }];
    });
    matches.sort((a, b) => a.count - b.count || b.length - a.length || a.start - b.start);
    at = matches[0]?.start ?? -1;
  }
  let start = at < 0 ? 0 : Math.max(0, at - Math.floor(chars / 2));
  if (start + chars > text.length) start = Math.max(0, text.length - chars);
  const end = Math.min(text.length, start + chars);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}
