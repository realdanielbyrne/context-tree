/**
 * MIDDLEWARE reducers — the payload of a context-tree plugin.
 *
 * Each is a pure `tool.execute.after` transform: given a large tool RESULT, shrink
 * its footprint to what the task needs, BEFORE it enters the model's context. This
 * is the exact seam that bolts onto opencode (`tool.execute.after`), Claude Code
 * (PostToolUse hook), or Cline. Nothing here touches the agent loop.
 *
 * Two footprint reducers (D-EV6), plus the null control:
 *   summarize     — lossy → gist (headings + first lines). Keeps navigation, DROPS buried detail.
 *   chunk_retrieve — lossless → the span(s) most relevant to the task query. KEEPS buried detail.
 * The point of the experiment is that these differ exactly when the needed info is a buried detail.
 */
export const OVERFLOW_CHARS = 1500; // only reduce a result once it is large (would pressure the budget)

export const reduceNone = ({ out }) => out;

export function reduceSummarize({ out }) {
  if (out.length < OVERFLOW_CHARS) return out;
  const lines = out.split('\n'); const gist = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^#{1,6}\s|^\s*§|^\s*Section\s|^[A-Z][A-Z0-9 ]{6,}$/.test(l)) { // a heading
      gist.push(l.trim());
      const next = (lines[i + 1] || '').trim(); if (next) gist.push('  ' + next.slice(0, 80));
    }
  }
  return `[middleware:summarize — headings + first lines, detail dropped]\n${gist.join('\n')}`;
}

export function reduceChunkRetrieve({ out, task }) {
  if (out.length < OVERFLOW_CHARS) return out;
  const chunks = []; for (let i = 0; i < out.length; i += 400) chunks.push(out.slice(i, i + 520)); // 120-char overlap
  const terms = [...new Set((task.toLowerCase().match(/[a-z0-9]{3,}/g) || []))];
  const score = (c) => { const lc = c.toLowerCase(); return terms.reduce((s, t) => s + (lc.includes(t) ? 1 : 0), 0); };
  const top = chunks.map((c) => [c, score(c)]).sort((a, b) => b[1] - a[1]).slice(0, 2).map((x) => x[0]);
  return `[middleware:chunk_retrieve — top spans for the task query, verbatim]\n${top.join('\n…\n')}`;
}

// The ROUTER — the plugin's decision logic: pick the reducer per query. A detail-seeking task
// (asks for a specific value/price/number/name) → chunk_retrieve (preserve the localized span);
// otherwise → summarize (gist). Default toward chunk (err toward more context, per the operator).
export function reduceRouter({ out, task }) {
  if (out.length < OVERFLOW_CHARS) return out;
  const detailSeeking = /\bprice|cost|value|number|rate|limit|count|exact|specific|how many|what is the\b|\d/i.test(task || '');
  return detailSeeking ? reduceChunkRetrieve({ out, task }) : reduceSummarize({ out });
}

export const REDUCERS = { none: reduceNone, summarize: reduceSummarize, chunk_retrieve: reduceChunkRetrieve, router: reduceRouter };
