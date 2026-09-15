/**
 * ANCHOR PLUGIN — the intervention, as an opencode plugin.
 *
 * Per D20 the evaluation host is opencode, not an in-repo harness. This attaches at
 * `tool.execute.after`, whose `output` object is mutated in place, so assigning
 * `output.output` replaces what the model sees. Verified end to end: the model read
 * back the substituted text rather than the file's real contents.
 *
 * RESIDENCY IS BY CONSTRUCTION HERE, which is why this is sound without access to the
 * message array. The hook fires after EVERY tool call, so anything this plugin has
 * already seen has, by definition, been appended to the conversation — and the
 * experiment runs append-only with no eviction and no window cap. An anchor can
 * therefore never claim something absent, which is exactly the failure
 * (reports/metrics/coding-harness/report-readloop.md, "Fix #1 — Nudge: FAILED") that
 * invalidates a lying anchor. The one case that CAN lie is a clipped/truncated result,
 * which is detected and suppressed rather than anchored.
 *
 * ARMS (env CT_ARM): none | anchor | anchor-topk | placebo
 * Events are appended as JSONL to CT_ANCHOR_EVENTS for the runner to collect, so the
 * measurement never depends on parsing stdout.
 */
import { appendFileSync } from 'node:fs';
import {
  normalizeContent, contentHash, normPath, CLIP_RE,
  anchorText, placeboText, anchorTopKText, retrieveTopK,
} from '../anchor-index.mjs';

const ARM = process.env.CT_ARM || 'none';
const TOPK = +(process.env.CT_ANCHOR_TOPK || 2);
const MIN_CHARS = +(process.env.CT_ANCHOR_MIN_CHARS || 200);
const EVENTS = process.env.CT_ANCHOR_EVENTS || '';

const log = (ev) => { if (EVENTS) { try { appendFileSync(EVENTS, JSON.stringify(ev) + '\n'); } catch {} } };

/** opencode tool names are lowercase and args differ from the bespoke harness. */
const pathOf = (tool, args = {}) => {
  const p = args.filePath ?? args.path ?? args.file_path;
  return p ? normPath(String(p)) : null;
};

export const server = async () => {
  const byHash = new Map();      // hash -> {turn, tool, path, text}
  const byPath = new Map();      // path -> [records]  (containment, same file)
  const edited = new Map();      // path -> [turns]    (staleness)
  let turn = 0;

  const capture = (tool, path, text) => {
    const t = normalizeContent(text);
    if (!t) return;
    const h = contentHash(t);
    const rec = { hash: h, firstTurn: turn, tool, path, captureText: t, chars: t.length };
    if (!byHash.has(h)) byHash.set(h, rec);
    if (path) { if (!byPath.has(path)) byPath.set(path, []); byPath.get(path).push(rec); }
  };

  const classify = (tool, path, text) => {
    const t = normalizeContent(text);
    if (t.length < MIN_CHARS) return null;
    const exact = byHash.get(contentHash(t));
    if (exact) {
      const kind = exact.tool === 'write' || exact.tool === 'edit' ? 'write-then-read'
        : exact.tool !== tool ? 'cross-tool-duplicate' : 'duplicate-unchanged';
      return { kind, prior: exact };
    }
    if (path) for (const rec of (byPath.get(path) || [])) {
      if (rec.captureText.length >= t.length && rec.captureText.includes(t)) return { kind: 'partial-overlap', prior: rec };
    }
    return null;
  };

  return {
    "tool.execute.after": async (input, output) => {
      turn += 1;
      const tool = String(input.tool || '');
      const args = input.args || {};
      const path = pathOf(tool, args);
      const raw = String(output.output ?? '');

      // The model's own write/edit payloads are resident in its tool call, so they
      // count as context even though the tool RESULT is just a confirmation line.
      if (tool === 'write') { capture('write', path, args.content); return; }
      if (tool === 'edit') {
        if (path) { if (!edited.has(path)) edited.set(path, []); edited.get(path).push(turn); }
        capture('edit', path, args.newString ?? args.new_string);
        return;
      }

      const hit = classify(tool, path, raw);
      if (!hit) { capture(tool, path, raw); return; }

      const stale = (edited.get(path) || []).some((x) => x > hit.prior.firstTurn);
      const clipped = CLIP_RE.test(hit.prior.captureText) || CLIP_RE.test(normalizeContent(raw));
      const ev = {
        turn, tool, path, kind: stale ? 'read-then-edited' : hit.kind,
        prior_turn: hit.prior.firstTurn, gap_turns: turn - hit.prior.firstTurn,
        real_chars: normalizeContent(raw).length, arm: ARM,
        anchor_truthful: !stale && !clipped, partial_residency: clipped,
        fired: false, substituted_chars: null, topk_coverage: null,
        degenerate_topk: false, suppressed: null,
      };

      const serve = (why) => { ev.suppressed = why; log(ev); capture(tool, path, raw); };
      if (clipped) return serve('clipped-residency');
      if (stale) return serve('stale');
      if (ARM === 'none') return serve('no-intervention');

      let text;
      if (ARM === 'anchor') text = anchorText(hit.prior, ev.kind);
      else if (ARM === 'placebo') text = placeboText(anchorText(hit.prior, ev.kind).length);
      else if (ARM === 'anchor-topk') {
        const q = `${tool} ${path || ''} ${JSON.stringify(args).slice(0, 500)}`;
        const picked = retrieveTopK(hit.prior.captureText, q, TOPK);
        text = anchorTopKText(hit.prior, ev.kind, q, TOPK);
        ev.topk_coverage = +(text.length / Math.max(1, ev.real_chars)).toFixed(3);
        ev.degenerate_topk = !!picked.degenerate || text.length >= ev.real_chars;
        // Substituting something LARGER than the content is strictly worse than not
        // intervening; record it rather than corrupt the arm silently.
        if (ev.degenerate_topk) return serve('topk-degenerate');
      } else return serve(`unknown-arm:${ARM}`);

      output.output = text;
      ev.fired = true;
      ev.substituted_chars = text.length;
      log(ev);
    },
  };
};
