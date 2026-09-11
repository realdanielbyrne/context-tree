/**
 * ============================================================================
 * EXPERIMENT: online segmentation — tool-phase vs topic-shift (tests D1)
 * ============================================================================
 *
 * D1 (ASSERTED, never tested): deterministic TOOL-PHASE segmentation is as good
 * as CONTENT-based (topic-shift) segmentation. One variable = the boundary rule.
 * Both are ONLINE (real-time): each boundary is decided causally from past+present
 * turns as the trace streams, and committed once (cache-safe, never re-cut).
 *
 * REFERENCE (the "against the local model" part): the local model is an independent
 * TOPIC-BOUNDARY ORACLE. For a sampled position between two turns it judges SAME vs
 * DIFFERENT task/topic — blind to which segmenter proposed the position, with tool
 * NAMES stripped from the shown content (so it judges topic, not tool mechanics).
 * Each segmenter is scored precision/recall/F1 of its boundaries against the oracle.
 *
 * ARMS (one variable): tool-phase@v1 · topic-shift@v1 · random@v1 (floor).
 *
 * CONFOUND CONTROLS (the point of this design):
 *   C1 matched count   — topic-shift & random emit the SAME number of boundaries as
 *                        tool-phase (top-K drift), so granularity can't drive the result.
 *   C2 blind oracle    — positions are judged with NO arm label; the three arms'
 *                        boundaries are pooled + shuffled before labeling.
 *   C3 no tool leakage — the oracle sees turn CONTENT with tool names removed, so it
 *                        cannot label a shift merely because the tool changed.
 *   C4 shared sample   — all arms scored on ONE labeled position sample.
 *   C5 random floor + base rate — a random segmenter's precision ≈ base rate; if the
 *                        real arms don't beat it, the oracle is uninformative (reported).
 *   C6 fixed oracle    — same prompt / window / temp 0 / thinking off for every call.
 *   C7 determinism     — seeded RNG for all sampling and the random arm.
 *   C8 causal drift    — topic-shift drift uses only the PREVIOUS window (online).
 *
 * PRE-REGISTERED FALSIFICATION (fixed before the run):
 *   Instrument-valid IFF both real arms' F1 > random floor by >=0.05 (else oracle uninformative).
 *   D1 HOLDS  if |tool-phase F1 − topic-shift F1| <= 0.10 (comparable).
 *   D1 FAILS (content segmentation better) if topic-shift F1 − tool-phase F1 > 0.10.
 *
 * RERUN: node experiments/online-segmentation/online-segmentation.mjs [--cap 40]
 *   needs the local host + MiniLM (rung-0a deps symlinked).
 * ============================================================================
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contentWords, jaccard, cosine, makeEmbedder } from '../rung-0e-retrievers/lib.mjs';
import { generate, writeResults, gitSha, nowISO, MODEL, REPO } from '../rung-1-live-probe/lib.mjs';

const argv = process.argv.slice(2);
const CAP = +(argv[argv.indexOf('--cap') + 1] || 40) || 40; // max sampled boundaries per arm
const W = 3;               // drift window (previous turns) — online/causal
const SESSION = join(REPO, 'packages/cli/test/fixtures/claude-code-session-2.jsonl');
const SEED = 1234;
const ARM_VER = { tool: 'tool-phase@v1', topic: 'topic-shift@v1', random: 'random@v1' };

function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rng = mulberry32(SEED);
function sample(arr, n) { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, n); }
const clip = (s, n) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);

// ---- parse the session into an ordered turn sequence ----
export function parseTurns() {
  const lines = readFileSync(SESSION, 'utf8').split('\n').filter(Boolean);
  const toolNameById = {};
  const turns = [];
  for (const l of lines) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (e.type !== 'user' && e.type !== 'assistant') continue;
    const c = e.message?.content;
    const arr = Array.isArray(c) ? c : [];
    let tool = null, text = '';
    if (e.type === 'assistant') {
      const texts = arr.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
      const tu = arr.find((b) => b.type === 'tool_use');
      if (tu) { tool = tu.name; if (tu.id) toolNameById[tu.id] = tu.name; text = texts + ' ' + clip(JSON.stringify(tu.input || {}), 500); }
      else { tool = 'TEXT'; text = texts; }
    } else { // user
      const tr = arr.find((b) => b.type === 'tool_result');
      if (tr) { let out = tr.content; if (Array.isArray(out)) out = out.map((x) => x.text || '').join(''); tool = 'RESULT:' + (toolNameById[tr.tool_use_id] || '?'); text = clip(String(out || ''), 600); }
      else { tool = 'USER_PROMPT'; text = clip(typeof c === 'string' ? c : arr.filter((b) => b.type === 'text').map((b) => b.text).join(' '), 600); }
    }
    const clipped = clip(text, 600);
    if (clipped.trim().length < 3) continue; // drop empty non-event turns (message wrappers): they carry no
    // content, so contentWords()=∅ → jaccard=0 → MAX drift, an artifact that dominated the drift ranking.
    turns.push({ i: turns.length, role: e.type, tool, text: clipped });
  }
  return turns;
}

// ---- ARM 1: tool-phase boundaries (phase label changes) ----
export function toolPhaseBoundaries(turns) {
  // carry a tool_use/result as its own phase; assistant TEXT carries forward the prior phase
  const phase = []; let cur = turns[0].tool;
  for (const t of turns) { if (t.tool === 'TEXT') phase.push(cur); else { cur = t.tool.startsWith('RESULT:') ? t.tool.slice(7) : t.tool; phase.push(cur); } }
  const b = new Set();
  for (let p = 1; p < turns.length; p++) if (phase[p] !== phase[p - 1]) b.add(p);
  return b;
}

// ---- ARM 2: topic-shift boundaries (causal drift z-score, matched to K) ----
export async function topicShiftScores(turns, embed) {
  const cw = turns.map((t) => new Set(contentWords(t.text)));
  const emb = []; for (const t of turns) emb.push(await embed(t.text || ' '));
  const drift = new Array(turns.length).fill(0);
  for (let t = 1; t < turns.length; t++) {
    const lo = Math.max(0, t - W);
    const winCW = new Set(); for (let k = lo; k < t; k++) for (const w of cw[k]) winCW.add(w);
    const dLex = 1 - jaccard(cw[t], winCW);
    const mean = new Float32Array(emb[t].length);
    for (let k = lo; k < t; k++) for (let d = 0; d < mean.length; d++) mean[d] += emb[k][d] / (t - lo);
    const dSem = 1 - cosine(emb[t], mean);
    drift[t] = 0.5 * dLex + 0.5 * dSem;
  }
  // causal z-score (Welford over past drifts), online
  const z = new Array(turns.length).fill(0); let n = 0, m = 0, s = 0;
  for (let t = 1; t < turns.length; t++) { const x = drift[t]; if (n > 1) { const sd = Math.sqrt(s / (n - 1)) || 1e-9; z[t] = (x - m) / sd; } n++; const dm = x - m; m += dm / n; s += dm * (x - m); }
  return z;
}
export function topKBoundaries(z, K) {
  return new Set([...z.map((v, i) => [i, v]).filter(([i]) => i >= 1)].sort((a, b) => b[1] - a[1]).slice(0, K).map(([i]) => i));
}

// ---- the oracle: SAME vs DIFFERENT topic across a position (blind, tool-stripped) ----
const ORACLE_SYS = 'You judge software-development conversation transcripts. Given an EARLIER passage and a LATER passage, decide whether the LATER passage continues the SAME underlying task/subject as the earlier one, or has moved to a DIFFERENT task/subject. Judge by what is being worked on (files, features, questions), not by the kind of action. Answer with exactly one word: SAME or DIFFERENT.';
export function windowText(turns, p) {
  const earlier = turns.slice(Math.max(0, p - 3), p).map((t) => clip(t.text, 220)).join('\n');
  const later = turns.slice(p, Math.min(turns.length, p + 2)).map((t) => clip(t.text, 220)).join('\n');
  return `EARLIER:\n${earlier}\n\nLATER:\n${later}`;
}
export async function oracleLabel(turns, p, think = false) {
  const r = await generate({ system: ORACLE_SYS, user: windowText(turns, p), maxTokens: think ? 300 : 8, temperature: 0, think });
  const t = (r.grade_text || '').toUpperCase();
  // take the LAST occurrence so a thinking trace that mentions both resolves to the verdict
  const iD = t.lastIndexOf('DIFFERENT'), iS = t.lastIndexOf('SAME');
  return iD > iS ? 'shift' : 'no';
}

// Instrument validation: does the oracle fire more at USER-PROMPT positions (strong true
// boundaries) than at interior positions? If not, it is SAME-biased (a confound). Reports
// thinking off vs on so we pick the better oracle before the scored run.
async function diagnose(turns) {
  const N = turns.length;
  const userPos = turns.map((t, i) => i).filter((p) => p >= 3 && p <= N - 3 && turns[p].tool === 'USER_PROMPT');
  const interior = turns.map((t, i) => i).filter((p) => p >= 3 && p <= N - 3 && turns[p].tool !== 'USER_PROMPT');
  const up = sample(userPos, 12), ip = sample(interior, 12);
  console.error(`diagnose: ${userPos.length} user-prompt positions, sampling ${up.length}; ${ip.length} interior, sampling ${ip.length}`);
  for (const think of [false, true]) {
    let uShift = 0, iShift = 0;
    for (const p of up) if (await oracleLabel(turns, p, think) === 'shift') uShift++;
    for (const p of ip) if (await oracleLabel(turns, p, think) === 'shift') iShift++;
    console.error(`  thinking=${think}: shift-rate  user-prompt=${(uShift / up.length).toFixed(2)} (${uShift}/${up.length})  interior=${(iShift / ip.length).toFixed(2)} (${iShift}/${ip.length})  separation=${((uShift / up.length) - (iShift / ip.length)).toFixed(2)}`);
  }
}

function score(boundaries, sampleSet, labels) {
  const inSample = [...boundaries].filter((p) => sampleSet.has(p));
  const shiftInSample = [...sampleSet].filter((p) => labels[p] === 'shift');
  const tp = inSample.filter((p) => labels[p] === 'shift').length;
  const precision = inSample.length ? tp / inSample.length : 0;
  const recall = shiftInSample.length ? shiftInSample.filter((p) => boundaries.has(p)).length / shiftInSample.length : 0;
  const f1 = (precision + recall) ? 2 * precision * recall / (precision + recall) : 0;
  return { n_boundaries_total: boundaries.size, n_in_sample: inSample.length, precision: +precision.toFixed(4), recall: +recall.toFixed(4), f1: +f1.toFixed(4) };
}

async function main() {
  const turns = parseTurns();
  if (argv.includes('--diagnose')) { await diagnose(turns); return; }
  const emb = await makeEmbedder();
  if (!emb.ok) throw new Error('MiniLM needed: ' + emb.reason);
  console.error(`turns: ${turns.length} | drift window W=${W} | cap=${CAP}`);

  const tool = toolPhaseBoundaries(turns);
  const z = await topicShiftScores(turns, emb.embed);
  const topic = topKBoundaries(z, tool.size);                 // C1 matched count
  const N = turns.length;
  const allPos = Array.from({ length: N }, (_, i) => i).filter((p) => p >= 3 && p <= N - 3);
  const random = new Set(sample(allPos, tool.size));          // C1 matched count, C7 seeded

  // shared, blind position sample: pooled arm boundaries + interior, capped, shuffled
  const valid = (S) => [...S].filter((p) => p >= 3 && p <= N - 3);
  const interior = allPos.filter((p) => !tool.has(p) && !topic.has(p) && !random.has(p));
  const pool = new Set([...sample(valid(tool), CAP), ...sample(valid(topic), CAP), ...sample(valid(random), CAP), ...sample(interior, CAP)]);
  const positions = sample([...pool], pool.size); // shuffle (C2)
  console.error(`boundaries → tool:${tool.size} topic:${topic.size} random:${random.size} | labeling ${positions.length} positions`);

  const labels = {};
  let done = 0;
  for (const p of positions) { labels[p] = await oracleLabel(turns, p); process.stderr.write(labels[p] === 'shift' ? '|' : '.'); if (++done % 40 === 0) process.stderr.write(` ${done}\n`); }
  process.stderr.write('\n');

  const sampleSet = new Set(positions);
  const baseRate = +([...positions].filter((p) => labels[p] === 'shift').length / positions.length).toFixed(4);
  const arms = {
    'tool-phase': score(tool, sampleSet, labels),
    'topic-shift': score(topic, sampleSet, labels),
    'random': score(random, sampleSet, labels),
  };
  const floor = arms.random.f1;
  const instrument_valid = arms['tool-phase'].f1 > floor + 0.05 && arms['topic-shift'].f1 > floor + 0.05;
  const d1_holds = Math.abs(arms['tool-phase'].f1 - arms['topic-shift'].f1) <= 0.10;
  const d1_fails_content_better = arms['topic-shift'].f1 - arms['tool-phase'].f1 > 0.10;

  const out = {
    manifest: {
      run_id: `online-seg-${Date.now()}`, experiment: 'online-segmentation / D1 tool-phase vs topic-shift',
      arms: ARM_VER, model: MODEL, oracle: 'local model SAME/DIFFERENT, blind, tool-name-stripped, thinking off, temp 0',
      corpus: 'packages/cli/test/fixtures/claude-code-session-2.jsonl', turns: turns.length, drift_window_W: W, seed: SEED, cap: CAP,
      commit: gitSha(), date: nowISO(),
      confound_controls: ['C1 matched boundary count', 'C2 blind pooled+shuffled positions', 'C3 tool names stripped from oracle input', 'C4 shared labeled sample', 'C5 random floor + base rate', 'C6 fixed oracle prompt/temp/thinking', 'C7 seeded RNG', 'C8 causal (online) drift'],
      falsification: { instrument_valid: 'both real arms F1 > random floor + 0.05', d1_holds: '|toolF1 - topicF1| <= 0.10', d1_fails: 'topicF1 - toolF1 > 0.10' },
      caveats: ['n≈labeled positions, directional.', 'Oracle is a single 27B model, thinking off — coarse binary judge; base rate + random floor gauge its informativeness.', 'topic-shift and the oracle are both content-based (correlated); tool-phase agreement is the load-bearing quantity.', 'Segmenter modeling choices (phase carry-forward, W, 50/50 lex/sem) are fixed, not swept.'],
    },
    n_positions: positions.length, base_rate_shift: baseRate,
    arms, random_floor_f1: floor,
    verdict: { instrument_valid, d1_holds, d1_fails_content_better },
  };
  const path = writeResults('online-segmentation', 'results-online-segmentation.json', out);

  console.error('\n=== ONLINE SEGMENTATION (D1) ===  base-rate shift=' + baseRate + ' | labeled=' + positions.length);
  for (const [a, s] of Object.entries(arms)) console.error(`  ${a.padEnd(11)} P=${s.precision} R=${s.recall} F1=${s.f1}  (cuts ${s.n_boundaries_total}, ${s.n_in_sample} in sample)`);
  console.error(`  instrument valid (both > floor+.05): ${instrument_valid} | random floor F1=${floor}`);
  console.error(`  D1 holds (|Δ|≤.10): ${d1_holds} | D1 fails / content better (topic−tool>.10): ${d1_fails_content_better}`);
  console.error(`  written: ${path}`);
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error('FATAL', e); process.exit(1); });
