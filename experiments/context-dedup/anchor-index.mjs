/**
 * ANCHOR-DEDUP — resident-content index, trigger, and arm reducers.
 *
 * Hypothesis: when a tool is about to return content ALREADY RESIDENT in the
 * model's context, returning a short referential ANCHOR instead of the bytes
 * ("Remember our earlier conversation about X") lets the model attend to the
 * resident copy rather than appending a duplicate — cutting tokens with NO
 * eviction, NO window cap, and no mutation of the cached prefix.
 *
 * Why this is not the failed read-loop nudge. `reports/metrics/coding-harness/
 * report-readloop.md` "Fix #1 — Nudge: FAILED" ran UNDER EVICTION: the content
 * was genuinely gone, so the nudge was a lie the context contradicted. Here the
 * context is append-only, so the anchor is TRUE. `anchor_truthful` is recorded
 * on every fire precisely so that distinction is auditable and not assumed.
 *
 * Corpus reality this module is built around (measured over the 4 INDEPENDENT
 * fixtures; session-4 is entirely contained in session-5, 307/307 message.ids):
 *   82 path-repeat reads, but 63 (77%) read a DIFFERENT RANGE and 58 (71%) had
 *   an intervening Edit. Only 4 are contained-and-unedited. The "59.2% re-reads"
 *   headline is a PATH statistic; at the CONTENT level it mostly dissolves.
 * Consequences encoded here:
 *   - containment, not just exact hash, or ranged re-reads are invisible
 *   - `mutatedSince` gating, because a stale anchor IS the readloop failure
 *   - `anchor-diff`, because the edited case is the majority of the opportunity
 *
 * Seams: `runAgent` (experiments/coding-harness/lib.mjs:145) calls
 * hook(messages, turn) with the same mutated-in-place array (:151) and
 * reducer({name,args,out,task}) with no messages (:162). One factory returns
 * both so the reducer can see live context. lib.mjs needs no change.
 */
import { createHash } from 'node:crypto';
import { splitText } from '../../packages/core/dist/retrieve/chunk.js';
import { BM25 } from '../../packages/core/dist/retrieve/bm25.js';

export const DEFAULTS = {
  arm: 'baseline',
  minChars: 200,
  containment: true,
  nearDupThreshold: 0,
  requireUnedited: true,
  verify: 'identity',
  topK: 3,
  recentTurns: 3,
};

/** Strip the Claude Read line-number gutter so `1\tfoo` and `foo` hash alike. */
export const normalizeContent = (s) =>
  String(s ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/^\s*\d+\t/gm, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

export const contentHash = (s) => createHash('sha256').update(normalizeContent(s)).digest('hex').slice(0, 16);

export const estTok = (s) => Math.ceil(String(s ?? '').length / 4);

/** Path tail after `context-tree/` — fixtures were recorded on two machines. */
export function normPath(p) {
  if (!p) return p;
  const i = String(p).indexOf('context-tree/');
  return i >= 0 ? String(p).slice(i + 'context-tree/'.length) : String(p);
}

/** Targets of `cat`/`head`/`tail`/`sed -n` so a bash read joins the index. */
export function bashReadTargets(cmd) {
  const out = [];
  const re = /\b(?:cat|head|tail|less|more)\b((?:\s+-\S+|\s+\d+)*)\s+([^\s|;&>]+)/g;
  let m;
  while ((m = re.exec(String(cmd || '')))) out.push(normPath(m[2]));
  const sed = /\bsed\s+-n[^|;&]*\s([^\s|;&>]+)/g;
  while ((m = sed.exec(String(cmd || '')))) out.push(normPath(m[1]));
  return out;
}

const shingles = (s, k = 5) => {
  const w = normalizeContent(s).split(/\s+/).filter(Boolean);
  const set = new Set();
  for (let i = 0; i + k <= w.length; i++) set.add(w.slice(i, i + k).join(' '));
  return set;
};
const jaccard = (a, b) => {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
};

export function summarize(rec, kind) {
  const first = normalizeContent(rec.captureText).split('\n').find((l) => l.trim()) || '';
  const gist = first.replace(/^#+\s*/, '').slice(0, 80);
  const where = `turn ${rec.firstTurn}`;
  if (kind === 'write-then-read') return `the ${rec.path} you wrote at ${where}`;
  if (kind === 'partial-overlap') return `the contents of ${rec.path}, which you already read at ${where}`;
  return `${rec.path} — "${gist}" — which you read at ${where}`;
}

export const anchorText = (rec, kind) => `[Remember our earlier conversation about ${summarize(rec, kind)}. It is above in this conversation, unchanged; use it rather than re-reading.]`;

/** Length-matched, NON-referential. Unmatched length would make D a volume arm. */
export function placeboText(target) {
  const base = 'Content withheld on this request.';
  if (base.length >= target) return base.slice(0, target);
  const filler = ' Content withheld on this request.';
  let s = base;
  while (s.length < target) s += filler;
  return s.slice(0, target);
}

/** Anchor + the model's own resident edit payloads: the majority-case intervention. */
export function anchorDiffText(rec, edits) {
  const hunks = edits.map((e, i) => `  (${i + 1}) turn ${e.turn}: replaced ${JSON.stringify(String(e.old).slice(0, 120))} with ${JSON.stringify(String(e.new).slice(0, 120))}`).join('\n');
  return `[Remember our earlier conversation about ${summarize(rec, 'read-then-edited')}. You have since edited it ${edits.length} time(s); those edits are above in this conversation:\n${hunks}\nReconstruct the current contents from that read plus those edits rather than re-reading.]`;
}

/**
 * TARGETED DUPLICATION. Instead of merely pointing at the resident copy, pull the
 * most relevant chunks of it back to the tail. This sits between "return the whole
 * file again" and "return a bare pointer", and it is the arm that answers the real
 * question: how much of what the model already has do you have to re-inject for it
 * to stay correct?
 *
 * Ranked with the repo's own promoted retriever (BM25 over 800/100 chunks). The
 * query is what a deployed middleware would actually have at fire time -- the tool
 * call plus the recent turns -- NEVER the pending question, which would be an oracle.
 */
export function retrieveTopK(captureText, query, k = 3) {
  const chunks = splitText(String(captureText), { chunkSize: 800, chunkOverlap: 100 });
  if (chunks.length <= k) return chunks.map((text, i) => ({ i, text }));
  const corpus = chunks.map((text, i) => ({ id: String(i), text }));
  const ranked = new BM25(corpus).search(String(query || ''));
  const pick = ranked.slice(0, k).map((r) => +r.id);
  while (pick.length < k && pick.length < chunks.length) {           // BM25 can return < k
    for (let i = 0; i < chunks.length && pick.length < k; i++) if (!pick.includes(i)) pick.push(i);
  }
  return pick.sort((a, b) => a - b).map((i) => ({ i, text: chunks[i] }));  // creation order
}

export function anchorTopKText(rec, kind, query, k) {
  const picked = retrieveTopK(rec.captureText, query, k);
  const total = splitText(String(rec.captureText), { chunkSize: 800, chunkOverlap: 100 }).length;
  const body = picked.map((c) => `--- ${rec.path} [chunk ${c.i + 1}/${total}] ---\n${c.text}`).join('\n');
  return `[You already read ${rec.path} at turn ${rec.firstTurn}; the full text is above in this conversation, unchanged. The ${picked.length} most relevant section(s) are repeated here so you do not have to scroll back:]\n${body}`;
}

export function makeAnchorIndex(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const byHash = new Map();
  const byPath = new Map();
  const edits = new Map();
  const events = [];
  let messagesRef = null;
  let turn = 0;

  const recOf = (path) => byPath.get(path) || [];

  function capture({ tool, path, text, argsKey }) {
    const t = normalizeContent(text);
    if (!t) return null;
    const h = contentHash(t);
    const rec = {
      hash: h, firstTurn: turn, tool, path: path || null, argsKey: argsKey || null,
      messageIndex: messagesRef ? messagesRef.length - 1 : -1,
      messageRef: messagesRef ? messagesRef[messagesRef.length - 1] : null,
      chars: t.length, captureText: t,
      shingles: o.nearDupThreshold > 0 ? shingles(t) : null,
    };
    if (!byHash.has(h)) byHash.set(h, rec);
    if (path) { if (!byPath.has(path)) byPath.set(path, []); byPath.get(path).push(rec); }
    return rec;
  }

  function classify({ tool, path, text }) {
    const t = normalizeContent(text);
    if (t.length < o.minChars) return null;
    const h = contentHash(t);

    const exact = byHash.get(h);
    if (exact) {
      const kind = exact.tool === 'write_file' || exact.tool === 'edit_file' ? 'write-then-read'
        : exact.tool !== tool ? 'cross-tool-duplicate' : 'duplicate-unchanged';
      return { kind, prior: exact, overlapRatio: 1 };
    }
    if (o.containment && path) {
      for (const rec of recOf(path)) {
        if (rec.captureText.includes(t)) return { kind: 'partial-overlap', prior: rec, overlapRatio: 1 };
      }
    }
    if (o.nearDupThreshold > 0 && path) {
      const sh = shingles(t);
      for (const rec of recOf(path)) {
        const j = jaccard(sh, rec.shingles || shingles(rec.captureText));
        if (j >= o.nearDupThreshold) return { kind: 'near-duplicate', prior: rec, overlapRatio: j };
      }
    }
    return null;
  }

  function verifyResidency(rec) {
    if (!messagesRef) return { resident: false, via: null };
    if (o.verify === 'off') return { resident: true, via: 'assumed' };
    if (rec.messageRef && messagesRef[rec.messageIndex] === rec.messageRef) return { resident: true, via: 'identity' };
    if (o.verify !== 'full') return { resident: false, via: 'identity-miss' };
    // Two encodings to match: raw text in tool results, and JSON-ESCAPED text
    // inside assistant tool_call arguments (where write_file payloads live).
    const needle = rec.captureText.slice(0, 400);
    const escaped = JSON.stringify(needle.slice(0, 200)).slice(1, -1);
    for (const m of messagesRef) {
      if (typeof m.content === 'string' && m.content.includes(needle)) return { resident: true, via: 'scan' };
      if (m.tool_calls && JSON.stringify(m.tool_calls).includes(escaped)) return { resident: true, via: 'scan-args' };
    }
    return { resident: false, via: 'scan-miss' };
  }

  const hook = (messages, t) => { messagesRef = messages; turn = t ?? turn; };

  function reducer({ name, args = {}, out }) {
    const path = normPath(args.path || args.file_path);
    let candidateText = out;
    let tool = name;

    if (name === 'write_file') { capture({ tool: 'write_file', path, text: args.content }); return out; }
    if (name === 'edit_file') {
      if (path) { if (!edits.has(path)) edits.set(path, []); edits.get(path).push({ turn, old: args.old_str, new: args.new_str }); }
      capture({ tool: 'edit_file', path, text: args.new_str });
      return out;
    }
    if (name === 'run_bash') { const tgt = bashReadTargets(args.command); if (tgt.length === 1) { tool = 'read_file'; } }

    const hit = classify({ tool, path, text: candidateText });
    if (!hit) { capture({ tool, path, text: candidateText, argsKey: JSON.stringify(args) }); return out; }

    const mutatedSince = (edits.get(path) || []).filter((e) => e.turn >= hit.prior.firstTurn);
    const residency = verifyResidency(hit.prior);
    const kind = mutatedSince.length ? 'read-then-edited' : hit.kind;
    const truthful = residency.resident && (kind !== 'read-then-edited' || o.arm === 'anchor-diff');

    const ev = {
      turn, tool: name, path, kind, overlap_ratio: hit.overlapRatio,
      prior_turn: hit.prior.firstTurn, gap_turns: turn - hit.prior.firstTurn,
      mutated_since: mutatedSince.length, anchor_truthful: truthful,
      residency_via: residency.via, resident: residency.resident,
      real_chars: normalizeContent(candidateText).length, arm: o.arm, fired: false,
      substituted_chars: null, suppressed: null,
    };

    const serve = () => { events.push(ev); capture({ tool, path, text: candidateText, argsKey: JSON.stringify(args) }); return out; };

    if (o.passive) { ev.suppressed = 'passive'; return serve(); }
    if (!residency.resident) { ev.suppressed = 'not-resident'; return serve(); }
    if (mutatedSince.length && o.requireUnedited && o.arm !== 'anchor-diff') { ev.suppressed = 'stale'; return serve(); }
    if (o.arm === 'baseline' || o.arm === 'none') { ev.suppressed = 'no-intervention'; return serve(); }

    let text;
    if (o.arm === 'anchor') text = anchorText(hit.prior, kind);
    else if (o.arm === 'anchor-diff') text = mutatedSince.length ? anchorDiffText(hit.prior, mutatedSince) : anchorText(hit.prior, kind);
    else if (o.arm === 'placebo') text = placeboText(anchorText(hit.prior, kind).length);
    else if (o.arm === 'anchor-topk') {
      // Query = what a real middleware sees at fire time: the request plus recent turns.
      const recent = (messagesRef || []).slice(-2 * o.recentTurns)
        .map((m) => String(m.content || '') + JSON.stringify(m.tool_calls || '')).join('\n');
      text = anchorTopKText(hit.prior, kind, `${JSON.stringify(args)}\n${recent}`.slice(0, 4000), o.topK);
    } else throw new Error(`unknown arm ${o.arm}`);

    ev.fired = true;
    ev.substituted_chars = text.length;
    events.push(ev);
    return text;
  }

  return {
    hook, reducer, events,
    stats: () => ({
      fires: events.filter((e) => e.fired).length,
      would_fire: events.length,
      by_kind: events.reduce((a, e) => ((a[e.kind] = (a[e.kind] || 0) + 1), a), {}),
      residency_false_count: events.filter((e) => !e.resident).length,
      tokens_saved: events.filter((e) => e.fired).reduce((s, e) => s + estTok(' '.repeat(e.real_chars)) - estTok(' '.repeat(e.substituted_chars)), 0),
      anchorable_chars: events.reduce((s, e) => s + e.real_chars, 0),
    }),
  };
}
