/**
 * POSITION PROBE — does this model retrieve worse from the MIDDLE of its context?
 *
 * Motivation: our eviction policies decide only PRESENCE, never POSITION (survivors
 * keep creation order). If retrieval quality depends on WHERE a fact sits, then two
 * policies that keep the same amount and leave survivors in the same band look
 * identical — which is exactly what the A/B measured (idle vs positional, p=1.000).
 * This probe tests whether the lever our design cannot express actually exists, on
 * THIS model at OUR context sizes.
 *
 * Design (needle-in-a-haystack, classic):
 *   - haystack of ~L estimated tokens of non-repetitive filler
 *   - one needle ("The access code for sector <NAME> is <NNNN>.") inserted at DEPTH d
 *   - question appended at the END; grade = does the reply contain the exact code
 *   - swept over depth x context length x several distinct needles
 *
 * Single-turn completions, so this is minutes not hours. temp 0, deterministic
 * filler and needles, so it reruns identically.
 *
 * Rerun: node experiments/context-dedup/position-probe.mjs
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate, MODEL, gitSha } from '../rung-1-live-probe/lib.mjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'reports', 'metrics', 'context-dedup');
const LENGTHS = (process.env.CT_PROBE_LENGTHS || '5000,10000,20000').split(',').map(Number);
const DEPTHS = (process.env.CT_PROBE_DEPTHS || '0,0.25,0.5,0.75,1').split(',').map(Number);
const NEEDLES = +(process.env.CT_PROBE_NEEDLES || 6);
// DISTRACTORS: competing 'access code' lines for OTHER sectors, scattered through the
// haystack. Without them the needle is the only 4-digit number near the phrase the
// question uses, so the model can pattern-match instead of discriminating -> ceiling.
const DISTRACTORS = +(process.env.CT_PROBE_DISTRACTORS || 0);

/** Deterministic PRNG so the whole probe is reproducible. */
const rng = (() => { let s = 0x2545f491; return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();

const SECTORS = ['ALDERAAN', 'BRAVURA', 'CINNABAR', 'DELPHINE', 'EPHESUS', 'FORTUNA', 'GRANITE', 'HALCYON'];
const TOPICS = ['logistics', 'maintenance', 'staffing', 'compliance', 'procurement', 'scheduling', 'inventory', 'training'];

/** Non-repetitive filler: each line is distinct so the model cannot pattern-match its way out. */
function haystack(approxTokens) {
  const lines = [];
  let tok = 0, i = 0;
  while (tok < approxTokens) {
    const t = TOPICS[i % TOPICS.length];
    const line = `Record ${String(i).padStart(5, '0')}: the ${t} review for quarter ${1 + (i % 4)} noted ` +
      `${20 + (i % 60)} open items, ${3 + (i % 17)} escalations, and a cycle time of ${40 + (i % 90)} hours ` +
      `across depot ${String.fromCharCode(65 + (i % 26))}${i % 13}.`;
    lines.push(line);
    tok += Math.ceil(line.length / 4);
    i++;
  }
  return lines;
}

const SYSTEM = 'You answer questions about the records provided. Reply with only the requested value and nothing else.';

async function probe(len, depth, n) {
  const sector = SECTORS[n % SECTORS.length];
  const code = 1000 + Math.floor(rng() * 8999);
  const needle = `IMPORTANT RECORD: the access code for sector ${sector} is ${code}.`;
  const lines = haystack(len);
  // scatter distractors first, at deterministic positions, skipping the target sector
  for (let k = 0; k < DISTRACTORS; k++) {
    const ds = SECTORS[(n + 1 + k) % SECTORS.length];
    if (ds === sector) continue;
    const dc = 1000 + Math.floor(rng() * 8999);
    const pos = Math.floor(((k + 1) / (DISTRACTORS + 1)) * lines.length);
    lines.splice(pos, 0, `IMPORTANT RECORD: the access code for sector ${ds} is ${dc}.`);
  }
  const at = Math.min(lines.length - 1, Math.max(0, Math.round(depth * (lines.length - 1))));
  lines.splice(at, 0, needle);
  const user = `${lines.join('\n')}\n\nQuestion: what is the access code for sector ${sector}? Answer with the 4-digit number only.`;
  const t0 = Date.now();
  let content = '', usage = null, err = null;
  try { const r = await generate({ system: SYSTEM, user, temperature: 0 }); content = r.content || ''; usage = r.usage || null; }
  catch (e) { err = String(e.message || e).slice(0, 120); }
  const hit = new RegExp(`(^|[^0-9])${code}([^0-9]|$)`).test(content);
  return { len, depth, needle_idx: n, sector, code, hit, answer: content.trim().slice(0, 40),
    prompt_tokens: usage?.prompt_tokens ?? null, depth_line: at, total_lines: lines.length,
    seconds: Math.round((Date.now() - t0) / 1000), error: err };
}

const rows = [];
for (const len of LENGTHS) {
  for (const depth of DEPTHS) {
    for (let n = 0; n < NEEDLES; n++) {
      const r = await probe(len, depth, n);
      rows.push(r);
      process.stderr.write(r.error ? 'E' : r.hit ? '.' : 'X');
    }
    const cell = rows.filter((x) => x.len === len && x.depth === depth);
    const hits = cell.filter((x) => x.hit).length;
    process.stderr.write(`  len=${len} depth=${(depth * 100).toFixed(0)}% -> ${hits}/${cell.length}\n`);
  }
}

console.error('\n=== POSITION PROBE (needle-in-haystack) ===');
console.error(`model=${MODEL}  needles/cell=${NEEDLES}  temp=0`);
const hdr = ['ctx\\depth', ...DEPTHS.map((d) => `${(d * 100).toFixed(0)}%`)].map((s) => s.padStart(9)).join('');
console.error(hdr);
for (const len of LENGTHS) {
  const cells = DEPTHS.map((d) => {
    const c = rows.filter((x) => x.len === len && x.depth === d);
    return `${c.filter((x) => x.hit).length}/${c.length}`.padStart(9);
  });
  const realTok = rows.find((x) => x.len === len && x.prompt_tokens)?.prompt_tokens ?? '?';
  console.error(`${String(len).padStart(9)}${cells.join('')}   (real prompt tok ~${realTok})`);
}
const byDepth = DEPTHS.map((d) => { const c = rows.filter((x) => x.depth === d); return { d, rate: c.filter((x) => x.hit).length / c.length, n: c.length }; });
console.error('\npooled by depth:');
for (const b of byDepth) console.error(`  depth ${(b.d * 100).toFixed(0).padStart(3)}%  ${(b.rate * 100).toFixed(0).padStart(3)}%  (n=${b.n})`);

writeFileSync(join(OUT, 'results-position-probe.json'), JSON.stringify({
  experiment: 'position probe / needle-in-haystack by depth and context length',
  date: new Date().toISOString(), model: MODEL, commit: gitSha(),
  lengths: LENGTHS, depths: DEPTHS, needles_per_cell: NEEDLES, distractors: DISTRACTORS, rows, by_depth: byDepth,
  question: 'Does retrieval quality depend on WHERE a fact sits in the context? If yes, position-aware assembly is a lever our presence-only eviction policies cannot express.',
  caveats: [
    'Synthetic needle-in-haystack: a single distinctive sentence in homogeneous filler. Real context is heterogeneous and the needle is rarely this lexically distinct — this is the EASY version of retrieval.',
    'Lengths are estimated tokens (chars/4) for construction; the real prompt_tokens from the provider is recorded per row.',
    'Single-turn retrieval, not multi-turn agentic use. A null here does not prove position is irrelevant to an agent loop.',
    'One model.',
  ],
}, null, 2));
console.error(`\nwrote results-position-probe.json -> ${OUT}`);
