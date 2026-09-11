/**
 * Shared signal extraction for the assembler-weighting experiments.
 * One source of truth: the sweep (assembler-weighting.mjs) and the LR refinement
 * (lr-refinement.mjs) both build per-(turn × past-unit) signals from here.
 * Offline, deterministic — fingerprints only, no model.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO } from '../rung-1-live-probe/lib.mjs';

export const PARAMS = { K_RECENT: 5, H: 3, D_DORMANT: 10, START: 20 };
export const sessionPath = (n) => join(REPO, `packages/cli/test/fixtures/claude-code-session${n === '1' ? '' : '-2'}.jsonl`);

const RX = { path: /[\w-]+(?:\/[\w.-]+)*\.[a-z]{1,5}\b/gi, back: /`([^`]+)`/g, camel: /\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/g, pascal: /\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g, upper: /\b[A-Z][A-Z0-9_]{3,}\b/g };
function fingerprint(text) {
  const fp = new Set();
  for (const m of text.matchAll(RX.path)) fp.add(m[0].toLowerCase());
  for (const m of text.matchAll(RX.back)) if (m[1].length >= 3 && m[1].length < 40) fp.add(m[1]);
  for (const rx of [RX.camel, RX.pascal, RX.upper]) for (const m of text.matchAll(rx)) fp.add(m[0]);
  return fp;
}
function parse(path) {
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  const byId = {}; const turns = [];
  for (const l of lines) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (e.type !== 'user' && e.type !== 'assistant') continue;
    const arr = Array.isArray(e.message?.content) ? e.message.content : [];
    let text = '';
    if (e.type === 'assistant') {
      text = arr.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
      for (const b of arr) if (b.type === 'tool_use') { if (b.id) byId[b.id] = b.name; text += ' ' + (b.input?.file_path || '') + ' ' + JSON.stringify(b.input || {}).slice(0, 800); }
    } else {
      const tr = arr.find((b) => b.type === 'tool_result');
      if (tr) { let o = tr.content; if (Array.isArray(o)) o = o.map((x) => x.text || '').join(''); text = String(o || '').slice(0, 800); }
      else text = (typeof e.message.content === 'string' ? e.message.content : arr.filter((b) => b.type === 'text').map((b) => b.text).join(' ')).slice(0, 800);
    }
    const fp = fingerprint(text);
    if (!text.trim() && fp.size === 0) continue;
    turns.push({ i: turns.length, fp });
  }
  return turns;
}
const overlap = (a, b) => { for (const x of a) if (b.has(x)) return true; return false; };
const upTo = (arr, t) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < t) lo = m + 1; else hi = m; } return lo; };

/**
 * Per-turn candidate signals. Returns { turns, cand, perTurn:[{t, raw:[{u,rec,relN,prioN,refrec,needed,neededH,dormant}]}] }.
 * Signals are min-max normalized across each turn's candidates (as the eviction scorer sees them).
 */
export function buildTurnData(n) {
  const { K_RECENT, H, D_DORMANT, START } = PARAMS;
  const turns = parse(sessionPath(n));
  const T = turns.length;
  const cand = turns.filter((t) => t.fp.size > 0).map((t) => t.i);
  const refs = {};
  for (const u of cand) { const r = []; for (let j = u + 1; j < T; j++) if (overlap(turns[u].fp, turns[j].fp)) r.push(j); refs[u] = r; }
  const unionRecent = (t) => { const s = new Set(); for (let r = Math.max(0, t - K_RECENT); r < t; r++) for (const x of turns[r].fp) s.add(x); return s; };
  const jacc = (a, b) => { let inter = 0; for (const x of a) if (b.has(x)) inter++; return inter / (a.size + b.size - inter || 1); };

  const perTurn = [];
  for (let t = START; t < T; t++) {
    if (turns[t].fp.size === 0) continue;
    const C = cand.filter((u) => u < t);
    if (C.length < 8) continue;
    const uni = unionRecent(t);
    const raw = C.map((u) => {
      const r = refs[u]; const nBefore = upTo(r, t);
      const prio = nBefore, lastRef = nBefore > 0 ? r[nBefore - 1] : u;
      const dorm = t - lastRef, age = t - u, rel = jacc(turns[u].fp, uni);
      const needed = nBefore < r.length && r[nBefore] === t;
      const neededH = r.slice(nBefore).some((x) => x < t + H);
      return { u, prio, dorm, age, rel, needed, neededH, dormant: dorm > D_DORMANT };
    });
    const mm = (key) => { const vs = raw.map((x) => x[key]); const lo = Math.min(...vs), hi = Math.max(...vs); return (v) => (hi > lo ? (v - lo) / (hi - lo) : 0); };
    const nAge = mm('age'), nPrio = mm('prio'), nDorm = mm('dorm'), nRel = mm('rel');
    for (const x of raw) { x.rec = 1 - nAge(x.age); x.relN = nRel(x.rel); x.prioN = nPrio(x.prio); x.refrec = 1 - nDorm(x.dorm); }
    perTurn.push({ t, raw });
  }
  return { turns, cand, perTurn };
}
