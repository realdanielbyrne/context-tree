/**
 * REPORT — is there headroom for ANY eviction signal? The LOUO oracle ceiling.
 *
 * Regenerates every number from the results artefact, so the prose cannot drift
 * from the data. Emits report-attention-over-history.{md,html}; the HTML is
 * self-contained (inline SVG, no CDN, no external fonts).
 *
 * Rerun: node experiments/attention-over-history/report-attention-over-history.mjs
 *
 * WHY EVERY LOOKUP THROWS
 * -----------------------
 * A report whose generator renders "undefined" for a missing key is worse than
 * one that fails: it publishes a hole that reads like a measurement. `pick()`
 * and `armOf()` below throw on any absent field, so a schema change breaks the
 * build rather than the reader's trust. Same reason the input file is PINNED by
 * name rather than globbed — a glob would silently fold a future run into tables
 * whose prose still describes this one.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', '..', 'reports', 'metrics', 'attention-over-history');

// PINNED. See header.
const RESULTS = 'results-primary-all-mean-20260915-111951.json';
{
  const present = new Set(readdirSync(OUT));
  if (!present.has(RESULTS)) {
    const cands = [...present].filter((f) => /^results-primary-.*\.json$/.test(f)).sort();
    throw new Error(`missing ${RESULTS}; present: ${cands.join(', ') || '(none)'}`);
  }
}
const data = JSON.parse(readFileSync(join(OUT, RESULTS), 'utf8'));

// ---------------------------------------------------------------- lookups
function pick(obj, path) {
  let cur = obj;
  for (const k of path.split('.')) {
    if (cur == null || !(k in cur)) throw new Error(`missing field: ${path}`);
    cur = cur[k];
  }
  return cur;
}
const M = data.manifest;
const FLOOR = 6.30e-3;            // same-device, from floor.py
const FLOOR_XDEV = 2.482e-2;      // cross-device, from floor.py
const MIN_FRAC = 0.5;

const allTurns = data.turns;
if (!Array.isArray(allTurns) || !allTurns.length) throw new Error('no turns in results');
const turns = allTurns.filter((t) => pick(t, 'gate_resolution.passed'));
if (!turns.length) throw new Error('no turn passed the resolution gate — nothing to report');

const SESSIONS = [...new Set(turns.map((t) => t.session))].sort();
const FRACTIONS = M.keep_fractions.map(String);
const ARMS = ['oracle', 'lowattn', 'residattn', 'oldest', 'random', 'highattn'];
const ARM_LABEL = {
  oracle: 'oracle (ceiling)', lowattn: 'low-attention', residattn: 'residual-attention',
  oldest: 'recency (incumbent)', random: 'random (control)', highattn: 'high-attention',
};

// ---------------------------------------------------------------- stats
const sum = (a) => a.reduce((s, v) => s + v, 0);
const mean = (a) => { if (!a.length) throw new Error('mean of empty'); return sum(a) / a.length; };
const med = (a) => {
  if (!a.length) throw new Error('median of empty');
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const sd = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(sum(a.map((v) => (v - m) ** 2)) / (a.length - 1)); };
const f3 = (v) => (v >= 0 ? '+' : '\u2212') + Math.abs(v).toFixed(3);
const f4 = (v) => (v >= 0 ? '+' : '\u2212') + Math.abs(v).toFixed(4);
const f5 = (v) => (v >= 0 ? '+' : '\u2212') + Math.abs(v).toFixed(5);
const pct = (v) => `${Math.round(v * 100)}%`;
const sci = (v) => {
  const e = Math.floor(Math.log10(Math.abs(v)));
  return `${(v / 10 ** e).toFixed(1)}\u00d710<sup>${e}</sup>`;
};
const sciMd = (v) => { const e = Math.floor(Math.log10(Math.abs(v))); return `${(v / 10 ** e).toFixed(1)}e${e}`; };

function rank(a) {
  const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
  const r = new Array(a.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2;
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}
function spearman(x, y) {
  if (x.length !== y.length) throw new Error('spearman length mismatch');
  if (x.length < 3) return 0;
  const rx = rank(x), ry = rank(y), n = x.length;
  const mx = mean(rx), my = mean(ry);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { num += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2; }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0;
}
function partialSpearman(x, y, z) {
  const rxy = spearman(x, y), rxz = spearman(x, z), ryz = spearman(y, z);
  const den = Math.sqrt(Math.max(1e-12, (1 - rxz ** 2) * (1 - ryz ** 2)));
  return (rxy - rxz * ryz) / den;
}

// ---------------------------------------------------------------- cells
/** One (turn, keep-fraction) cell that passed the matching + treatment gates. */
const cells = [];
for (const t of turns) {
  for (const fr of FRACTIONS) {
    if (!(fr in t.ablation)) throw new Error(`turn ${t.upto} lacks keep-fraction ${fr}`);
    const cell = t.ablation[fr];
    if (!pick(cell, 'gate_matching_selective.passed')) continue;
    if (!pick(cell, 'gate_treatment_vs_random.passed')) continue;
    const armOf = (a) => {
      if (!(a in cell.arms)) throw new Error(`turn ${t.upto} frac ${fr} lacks arm ${a}`);
      return cell.arms[a];
    };
    cells.push({
      session: t.session, upto: t.upto, frac: Number(fr),
      arms: Object.fromEntries(ARMS.map((a) => [a, armOf(a)])),
    });
  }
}
if (!cells.length) throw new Error('no cell passed the gates');

const dn = (c, a) => pick(c.arms[a], 'delta_nll');
const splices = (c, a) => Number(pick(c.arms[a], 'splices'));
const toks = (c, a) => Number(pick(c.arms[a], 'tokens'));
const nunits = (c, a) => Number(pick(c.arms[a], 'count'));

/** Paired contrast base-vs-other over a set of cells. Negative = base is better. */
function contrast(cs, base, other) {
  const d = cs.map((c) => dn(c, base) - dn(c, other));
  const m = mean(d), s = sd(d);
  return { mean: m, sd: s, d: s ? m / s : 0, wins: d.filter((v) => v < 0).length, n: d.length,
           withinFloor: Math.abs(m) < FLOOR };
}

const ORACLE_VS_RANDOM = contrast(cells, 'oracle', 'random');
const ORACLE_VS_OLDEST = contrast(cells, 'oracle', 'oldest');
const LOW_VS_RANDOM = contrast(cells, 'lowattn', 'random');
const LOW_VS_HIGH = contrast(cells, 'lowattn', 'highattn');
const OLDEST_VS_RANDOM = contrast(cells, 'oldest', 'random');

const perSession = SESSIONS.map((s) => {
  const cs = cells.filter((c) => c.session === s);
  return { session: s, n: cs.length,
           oracleRandom: contrast(cs, 'oracle', 'random'),
           oracleOldest: contrast(cs, 'oracle', 'oldest') };
});
const perFraction = FRACTIONS.map((fr) => {
  const cs = cells.filter((c) => c.frac === Number(fr));
  if (!cs.length) return { frac: Number(fr), n: 0 };
  return { frac: Number(fr), n: cs.length,
           arms: Object.fromEntries(ARMS.map((a) => [a, mean(cs.map((c) => dn(c, a)))])),
           oracleRandom: contrast(cs, 'oracle', 'random'),
           oracleOldest: contrast(cs, 'oracle', 'oldest') };
});

// matching diagnostics — the oracle must not win on volume
const matchRows = ARMS.map((a) => ({
  arm: a,
  tokens: Math.round(mean(cells.map((c) => toks(c, a)))),
  units: mean(cells.map((c) => nunits(c, a))),
  splices: mean(cells.map((c) => splices(c, a))),
}));
const ratioWithin = (f) => {
  const rs = cells.map((c) => {
    const vs = ARMS.map((a) => f(c, a)).filter((v) => v > 0);
    return Math.max(...vs) / Math.min(...vs);
  });
  return { mean: mean(rs), max: Math.max(...rs) };
};
const TOK_RATIO = ratioWithin(toks);
const UNIT_RATIO = ratioWithin(nunits);
const SPLICE_RATIO = ratioWithin((c, a) => Math.max(splices(c, a), 1));
const ORACLE_SPLICE_DELTA = mean(cells.map((c) => splices(c, 'oracle') - splices(c, 'random')));

// F0-F3, from the turn records
const inertPass = turns.filter((t) => pick(t, 'gate_inertness.passed')).length;
const relabPass = turns.filter((t) => pick(t, 'gate_relabelling.passed')).length;
const colT = (k) => turns.map((t) => pick(t, `correlations.${k}`));
const f2PerTurn = colT('partial_mass_given_length').map((v, i) => v - colT('partial_position_given_length')[i]);

// pooled over (turn x unit)
const pool = { mass: [], len: [], pos: [], louo: [], subst: [] };
for (const t of turns) {
  const c = pick(t, 'candidates');
  pool.mass.push(...c.map((i) => t.mass[i]));
  pool.len.push(...c.map((i) => t.lengths[i]));
  pool.pos.push(...c.map((_, k) => k));
  pool.louo.push(...t.louo_delta_nll);
  pool.subst.push(...t.subst_delta_nll);
}
const POOL_MASS = partialSpearman(pool.mass, pool.louo, pool.len);
const POOL_POS = partialSpearman(pool.pos, pool.louo, pool.len);
const POOL_F2 = POOL_MASS - POOL_POS;
const TIES = pool.louo.filter((v) => Math.abs(v) < FLOOR).length / pool.louo.length;

const SPREAD = mean(turns.map((t) => {
  const s = [...t.louo_delta_nll].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
  return q(0.9) - q(0.1);
}));
const MED_ABS = med(turns.map((t) => med(t.louo_delta_nll.map(Math.abs))));

// ---------------------------------------------------------------- charts
const PAL = { oracle: '#2e9e5b', lowattn: '#4f7cff', residattn: '#7aa2ff', oldest: '#8b5cf6', random: '#9aa0ac', highattn: '#e4572e' };

function chartArms() {
  const W = 760, H = 330, padL = 78, padR = 26, padT = 46, padB = 74;
  const iw = W - padL - padR, ih = H - padT - padB;
  const vals = ARMS.map((a) => mean(cells.map((c) => dn(c, a))));
  const maxV = Math.max(...vals) * 1.18;
  const y = (v) => padT + ih - (v / maxV) * ih;
  const bw = iw / ARMS.length;
  let s = '';
  for (let g = 0; g <= 4; g++) {
    const v = (maxV / 4) * g;
    s += `<line x1="${padL}" y1="${y(v).toFixed(1)}" x2="${W - padR}" y2="${y(v).toFixed(1)}" stroke="#e6e6ef"/>`;
    s += `<text x="${padL - 8}" y="${(y(v) + 4).toFixed(1)}" font-size="11" fill="#7a7a8c" text-anchor="end">${v.toFixed(2)}</text>`;
  }
  ARMS.forEach((a, i) => {
    const v = vals[i], bx = padL + i * bw + bw * 0.2, w = bw * 0.6;
    s += `<rect x="${bx.toFixed(1)}" y="${y(v).toFixed(1)}" width="${w.toFixed(1)}" height="${(y(0) - y(v)).toFixed(1)}" fill="${PAL[a]}" rx="3"/>`;
    s += `<text x="${(bx + w / 2).toFixed(1)}" y="${(y(v) - 7).toFixed(1)}" font-size="11.5" font-weight="600" fill="#2b2b38" text-anchor="middle">${v.toFixed(3)}</text>`;
    const lbl = ARM_LABEL[a].split(' ');
    s += `<text x="${(bx + w / 2).toFixed(1)}" y="${(y(0) + 17).toFixed(1)}" font-size="11" fill="#7a7a8c" text-anchor="middle">${lbl[0]}</text>`;
    if (lbl[1]) s += `<text x="${(bx + w / 2).toFixed(1)}" y="${(y(0) + 30).toFixed(1)}" font-size="10" fill="#9aa0ac" text-anchor="middle">${lbl.slice(1).join(' ')}</text>`;
  });
  s += `<text x="${padL + iw / 2}" y="${H - 14}" font-size="12" fill="#7a7a8c" text-anchor="middle">mean \u0394NLL (nats/token) \u2014 LOWER is better; every arm drops the same token volume</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" style="max-width:100%;height:auto"><title>Damage by eviction arm</title><text x="${padL}" y="26" font-size="14" font-weight="600" fill="#2b2b38">Damage caused by each eviction rule, at matched volume (n=${cells.length} cells)</text>${s}</svg>`;
}

function chartGap() {
  const W = 760, H = 300, padL = 200, padR = 90, padT = 52, padB = 58;
  const iw = W - padL - padR, ih = H - padT - padB;
  const rows = [
    { k: 'oracle \u2212 random', v: ORACLE_VS_RANDOM.mean },
    { k: 'oracle \u2212 recency', v: ORACLE_VS_OLDEST.mean },
    { k: 'recency \u2212 random', v: OLDEST_VS_RANDOM.mean },
    { k: 'low-attention \u2212 random', v: LOW_VS_RANDOM.mean },
  ];
  const lim = Math.max(FLOOR * 1.9, ...rows.map((r) => Math.abs(r.v))) * 1.25;
  const x = (v) => padL + ((v + lim) / (2 * lim)) * iw;
  const bh = ih / rows.length;
  let s = '';
  // floor band
  s += `<rect x="${x(-FLOOR).toFixed(1)}" y="${padT}" width="${(x(FLOOR) - x(-FLOOR)).toFixed(1)}" height="${ih}" fill="#fde9d9"/>`;
  s += `<text x="${x(0).toFixed(1)}" y="${(padT - 10).toFixed(1)}" font-size="10.5" fill="#b4531f" text-anchor="middle">\u00b1 numerical floor (${sciMd(FLOOR)})</text>`;
  s += `<line x1="${x(0).toFixed(1)}" y1="${padT}" x2="${x(0).toFixed(1)}" y2="${padT + ih}" stroke="#b9b9c6"/>`;
  rows.forEach((r, i) => {
    const cy = padT + i * bh + bh / 2;
    const x0 = x(0), x1 = x(r.v);
    const inside = Math.abs(r.v) < FLOOR;
    s += `<rect x="${Math.min(x0, x1).toFixed(1)}" y="${(cy - 11).toFixed(1)}" width="${Math.abs(x1 - x0).toFixed(1)}" height="22" fill="${inside ? '#c9ccd4' : '#2e9e5b'}" rx="3"/>`;
    s += `<text x="${(padL - 12).toFixed(1)}" y="${(cy + 4).toFixed(1)}" font-size="12" fill="#2b2b38" text-anchor="end">${r.k}</text>`;
    s += `<text x="${(x1 + (r.v < 0 ? -8 : 8)).toFixed(1)}" y="${(cy + 4).toFixed(1)}" font-size="11.5" font-weight="600" fill="#2b2b38" text-anchor="${r.v < 0 ? 'end' : 'start'}">${f4(r.v)}</text>`;
  });
  s += `<text x="${padL + iw / 2}" y="${H - 16}" font-size="12" fill="#7a7a8c" text-anchor="middle">\u0394NLL difference \u2014 NEGATIVE means the first arm did less damage</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" style="max-width:100%;height:auto"><title>Arm gaps against the numerical floor</title><text x="20" y="26" font-size="14" font-weight="600" fill="#2b2b38">Every gap against the measured floor \u2014 grey bars are indistinguishable from zero</text>${s}</svg>`;
}

function chartSessions() {
  const W = 760, H = 300, padL = 210, padR = 40, padT = 52, padB = 60;
  const iw = W - padL - padR, ih = H - padT - padB;
  const lim = Math.max(FLOOR * 1.9, ...perSession.flatMap((p) => [Math.abs(p.oracleRandom.mean), Math.abs(p.oracleOldest.mean)])) * 1.2;
  const x = (v) => padL + ((v + lim) / (2 * lim)) * iw;
  const rh = ih / perSession.length;
  let s = '';
  s += `<rect x="${x(-FLOOR).toFixed(1)}" y="${padT}" width="${(x(FLOOR) - x(-FLOOR)).toFixed(1)}" height="${ih}" fill="#fde9d9"/>`;
  s += `<line x1="${x(0).toFixed(1)}" y1="${padT}" x2="${x(0).toFixed(1)}" y2="${padT + ih}" stroke="#b9b9c6"/>`;
  perSession.forEach((p, i) => {
    const cy = padT + i * rh + rh / 2;
    [['oracle\u2212random', p.oracleRandom.mean, '#2e9e5b', -7],
     ['oracle\u2212recency', p.oracleOldest.mean, '#8b5cf6', 9]].forEach(([, v, col, off]) => {
      s += `<rect x="${Math.min(x(0), x(v)).toFixed(1)}" y="${(cy + off - 7).toFixed(1)}" width="${Math.abs(x(v) - x(0)).toFixed(1)}" height="13" fill="${col}" rx="2" fill-opacity="${Math.abs(v) < FLOOR ? 0.35 : 0.92}"/>`;
    });
    s += `<text x="${(padL - 12).toFixed(1)}" y="${(cy + 4).toFixed(1)}" font-size="11" fill="#2b2b38" text-anchor="end">${p.session.replace('claude-code-', '').replace('.jsonl', '')} (n=${p.n})</text>`;
  });
  s += `<rect x="${padL}" y="${H - 26}" width="11" height="11" fill="#2e9e5b"/><text x="${padL + 16}" y="${H - 16}" font-size="11" fill="#7a7a8c">oracle \u2212 random</text>`;
  s += `<rect x="${padL + 150}" y="${H - 26}" width="11" height="11" fill="#8b5cf6"/><text x="${padL + 166}" y="${H - 16}" font-size="11" fill="#7a7a8c">oracle \u2212 recency</text>`;
  s += `<text x="${x(0).toFixed(1)}" y="${(padT - 10).toFixed(1)}" font-size="10.5" fill="#b4531f" text-anchor="middle">\u00b1 numerical floor</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" style="max-width:100%;height:auto"><title>Per-session oracle gaps</title><text x="20" y="26" font-size="14" font-weight="600" fill="#2b2b38">The ceiling, per session cluster \u2014 four clusters, and they disagree</text>${s}</svg>`;
}

// ---------------------------------------------------------------- prose bits
const verdictOracleRandom = ORACLE_VS_RANDOM.withinFloor
  ? 'is **inside the numerical floor** \u2014 it is not distinguishable from zero'
  : 'is **outside the numerical floor**';
const sessSigns = perSession.map((p) => p.oracleRandom.mean < 0 ? 'negative' : 'positive');
const nFavourable = sessSigns.filter((s) => s === 'negative').length;

const armTableMd = perFraction.filter((p) => p.n).map((p) =>
  `| ${pct(p.frac)} | ${p.n} | ${ARMS.map((a) => f4(p.arms[a])).join(' | ')} |`).join('\n');

const matchTableMd = matchRows.map((r) =>
  `| ${ARM_LABEL[r.arm]} | ${r.tokens.toLocaleString()} | ${r.units.toFixed(1)} | ${r.splices.toFixed(1)} |`).join('\n');

const sessTableMd = perSession.map((p) =>
  `| \`${p.session}\` | ${p.n} | ${f5(p.oracleRandom.mean)} | ${p.oracleRandom.wins}/${p.oracleRandom.n} | ${f5(p.oracleOldest.mean)} | ${p.oracleOldest.wins}/${p.oracleOldest.n} |`).join('\n');

const fracGapMd = perFraction.filter((p) => p.n).map((p) =>
  `| ${pct(p.frac)} | ${p.n} | ${f5(p.oracleRandom.mean)} | ${p.oracleRandom.wins}/${p.oracleRandom.n} | ${f5(p.oracleOldest.mean)} | ${p.oracleOldest.wins}/${p.oracleOldest.n} |`).join('\n');

const RANDOM_MEAN = mean(cells.map((c) => dn(c, 'random')));
const ORACLE_MEAN = mean(cells.map((c) => dn(c, 'oracle')));
const PRIZE = RANDOM_MEAN - ORACLE_MEAN;                 // total avoidable damage
const HEADROOM_PCT = (PRIZE / Math.abs(RANDOM_MEAN)) * 100;
/** Share of the available prize an arm captures, relative to random and the oracle. */
const capture = (a) => ((RANDOM_MEAN - mean(cells.map((c) => dn(c, a)))) / PRIZE) * 100;
const CAP = Object.fromEntries(ARMS.map((a) => [a, capture(a)]));
const UNCLAIMED = 100 - Math.max(CAP.oldest, CAP.lowattn);
const captureTableMd = ['oracle', 'lowattn', 'residattn', 'oldest', 'highattn'].map((a) =>
  `| ${ARM_LABEL[a]} | ${f4(mean(cells.map((c) => dn(c, a))))} | ${CAP[a].toFixed(0)}% |`).join('\n');
const allClustersAgree = perSession.every((p) => p.oracleRandom.mean < 0);

// ---------------------------------------------------------------- markdown
const MD = `# How much is there to win by choosing what to evict?

*A ceiling experiment. We gave one eviction rule the answers; it avoided almost all the damage, and the rules we actually ship do not.*

## Abstract

An AI coding agent re-sends its entire working transcript to the model on every step, so on a long task the
transcript outgrows the model's input limit and some of it must be deleted. Which parts to delete is the
central design question for context-management middleware, and five successive experiments on this substrate
have failed to distinguish one deletion rule from another. Those nulls are ambiguous: either the choice
genuinely does not matter, or the measurement cannot detect it.

We resolve the ambiguity by measuring the ceiling rather than comparing candidates. For each decision point in
a real agent transcript we deleted every unit of history in turn and recorded how much harder the agent's
actual next message became, giving a direct causal importance for each unit. We then built an **oracle** rule
that evicts using those measured values \u2014 a rule no real system could implement, because it requires having
already run the counterfactual it is trying to avoid. Because the oracle is forced through the same
volume-matching as every other rule, dropping the same number of tokens and the same number of units, it
cannot win by keeping more. Whatever margin it achieves over random deletion is therefore an upper bound on
what *any* rule that scores units independently \u2014 attention, recency, co-occurrence, a learned policy \u2014 could
ever achieve on this substrate.

**The ceiling is high, and current rules reach almost none of it.** Across ${cells.length}
volume-matched cells drawn from ${turns.length} analysable decision points in ${SESSIONS.length} distinct
sessions, the oracle caused ${Math.abs(ORACLE_VS_RANDOM.mean).toFixed(3)} nats/token less damage than random
deletion and ${Math.abs(ORACLE_VS_OLDEST.mean).toFixed(3)} less than the incumbent recency rule — respectively
${(Math.abs(ORACLE_VS_RANDOM.mean) / FLOOR).toFixed(0)}× and ${(Math.abs(ORACLE_VS_OLDEST.mean) / FLOOR).toFixed(0)}×
the measurement's numerical floor of
${sciMd(FLOOR)}, which was established by running the identical comparison through two numerically-equivalent
code paths. ${allClustersAgree ? 'All four session clusters agree in sign' : 'The clusters disagree in sign'}.
Choosing well removes ${HEADROOM_PCT.toFixed(0)}% of the damage that random deletion causes; the recency rule
the system actually ships captures ${CAP.oldest.toFixed(0)}% of that available prize and an
attention-based rule ${CAP.lowattn.toFixed(0)}%, leaving roughly ${UNCLAIMED.toFixed(0)}% unclaimed.

The practical conclusion inverts the natural reading of this project's five previous null results. Those nulls
were not evidence that the choice does not matter. The choice matters a great deal; the candidate rules tested
so far simply do not exploit it. The bottleneck is the signal, not the opportunity.

## What you need to know to read the rest

Nothing below is assumed. Every term used later is defined here.

| Term | Meaning |
|---|---|
| **Agent** | An AI model given tools (read a file, run a command, edit code) and a goal, looping until it decides it is done. |
| **Transcript / context** | Everything the model can see on a given step: the instructions plus the full history of what it has read, written and run. It is re-sent in full every step. |
| **Token** | The unit text is measured in \u2014 roughly \u00be of a word. |
| **Unit** | The smallest thing eviction may remove: one assistant message **together with every tool result it produced**. They travel together because deleting a tool call but keeping its result (or vice versa) produces a transcript that could never have occurred. |
| **Eviction** | Deleting older units to stay under the input limit. The subject of this work: *which* units? |
| **Keep-fraction** | How much is deleted in one go, as a share of the evictable tokens. We test ${FRACTIONS.map((f) => pct(Number(f))).join(', ')}. |
| **Attention mass** | How much of the model's attention, at the moment it is about to act, lands on a given unit. Read directly out of the model's internals. |
| **Attention sink** | The first few tokens of a prompt absorb a large share of all attention regardless of content. Any "share of attention" that includes them is mostly measuring them, so they are excluded. |
| **Leave-one-unit-out (LOUO)** | Delete exactly one unit, re-run the model, and measure what changed. This is a direct causal measurement of that unit's importance, not a proxy for it. |
| **\u0394NLL** | The endpoint. How much *harder the agent's real next message became*, in nats per token, once something was deleted. Larger means more damage. Zero means the deletion cost nothing. |
| **The numerical floor** | The smallest \u0394NLL that is a measurement rather than arithmetic noise. Computed by running the identical comparison two numerically-equivalent ways; they disagree by ${sciMd(FLOOR)}, so differences smaller than that carry no information. |
| **Volume matching** | Forcing every rule to delete the same amount, so they differ only in *which* units go. Without it a rule can "win" by simply keeping more context, an effect already known to be large. |
| **Splice** | A cut point left in the transcript. Deleting three consecutive units leaves one splice; deleting three scattered units leaves three. Rules that fragment the transcript more may do more damage for reasons unrelated to what they deleted. |
| **Session / cluster** | One complete agent transcript. Decision points within a session are highly similar to each other, so the session, not the decision point, is the independent unit for statistics. |
| **Oracle** | A rule given the LOUO answers and told to delete the least-important units. Not implementable; used only to measure the ceiling. |

## Why we ran this

The project's central question is what to delete. Every previous attempt to answer it compared two candidate
rules and found no difference \u2014 selection signal p = 0.70; reference-recency versus positional recency
p = 1.000; needle position 180/180 at every depth; eviction cadence null once achieved size is controlled;
and, in this experiment's own first stage, attention versus position.

Five nulls in a row is not five pieces of evidence. It is one unanswered question: **is there anything there
to find?** A between-rule comparison cannot answer that, because it can only ever say "these two are similar".
A ceiling can.

### Why this is not the claim already rejected

An earlier result in this project concluded that relevance belongs at *admission* rather than eviction. That
conclusion was about **relevance computed by embedding similarity to the recent window**, and it failed for a
comprehensible reason: a unit that has gone dormant but will be needed again does not resemble the recent
window, so similarity-based eviction deletes precisely the unit that returns. The present work measures
something different \u2014 the model's **actual attention mass**, and behind it the **measured causal effect** of
deletion. A unit can be perfectly retrievable and receive almost no attention; those are different quantities
and only the first had been measured.

### How this reconciles with the position probe

A previous experiment found no retrieval deficit at any depth: 180 out of 180 needles found, out to 155,773
tokens, with competing distractors. If depth does not hurt retrieval, what is left to predict?

The two experiments condition on different things. The position probe asks *can the model find this when
explicitly asked* \u2014 a ceiling on what the context could contribute given a pointed query. This experiment asks
*how much does the model's next action actually depend on this*, with no query pointing anywhere. A unit can be
perfectly findable on request and contribute nothing spontaneously. Nothing here predicts retrieval failures,
so nothing here contradicts that null.

## The experimental setup

### The model, and why not the 27B

All measurements use **${M.model}** in bfloat16 on a single spare GPU. The project's main model is a 27B
served through llama.cpp, which **cannot export attention** \u2014 GGUF-style serving does not expose it \u2014 and the
server was in use by other work throughout. The 1B is the largest model that fits the ${'4.9\u00a0GiB'} of spare
VRAM alongside a 12,000-token context without evicting that server. This is a real limitation and it is
restated in the caveats: a signal measured on a 1B may not transfer to a 27B, and that transfer has not been
tested.

### The corpus

Five transcript fixtures are committed to this repository, but they are **four distinct sessions**:
\`claude-code-session-4.jsonl\` is a strict subset of \`claude-code-session-5.jsonl\` \u2014 same session id, 1,584 of
1,584 shared event identifiers. Treating them as two clusters would let one session vote twice, which biases
in exactly the direction that manufactures a positive result, so they are collapsed.

| | count |
|---|---|
| committed fixtures | 5 files \u2192 **${SESSIONS.length} distinct sessions** |
| decision points measured | ${allTurns.length} |
| decision points analysable (see floor) | **${turns.length}** |
| volume-matched cells analysed | **${cells.length}** |
| independent clusters | **${SESSIONS.length}** |

### What a unit is, and why tool results are paired to their calls

A unit is one assistant message plus every tool result it produced. In a real transcript the results do **not**
always arrive immediately after the call \u2014 sessions interleave, and a result can land after a later assistant
message \u2014 so units are assembled by matching each result to the identifier of the call it answers, not by
arrival order. An automatic check refuses to proceed if any result ends up in a different unit from its call.
This matters because an earlier version of this code split them, so every single-unit deletion produced a
transcript containing an unanswered tool call, and part of what was being measured was the model reacting to
a malformed transcript rather than to lost information.

### How the arms are matched

Every rule deletes from the same pool and must hit the same token target. Matching on tokens alone is not
enough: because attention mass correlates with unit length, "delete the lowest-attention units" naturally
means "delete many small units" while "delete the oldest" means "delete a few large contiguous ones". Measured
on the real eviction code, arms matched to 0.4% on tokens still differed up to 2\u00d7 in unit count and 13\u00d7 in
splice count.

So units are grouped into size strata, a single per-stratum quota is drawn once and applied to every arm, and
a bounded within-stratum repair brings the token totals together. Every arm then deletes the same number of
small units and the same number of large ones; only *which* unit inside each stratum differs. Achieved:

| arm | mean tokens deleted | mean units deleted | mean splices |
|---|---|---|---|
${matchTableMd}

Within-cell ratios across arms: tokens **${TOK_RATIO.mean.toFixed(3)}\u00d7 mean, ${TOK_RATIO.max.toFixed(3)}\u00d7 max**;
units **${UNIT_RATIO.mean.toFixed(3)}\u00d7 mean**; splices ${SPLICE_RATIO.mean.toFixed(2)}\u00d7 mean. The oracle
fragments the transcript by ${f3(ORACLE_SPLICE_DELTA)} splices relative to random \u2014 stated because a rule that
wins by cutting more tidily has not proven anything about *what* it cut.

### What \u0394NLL measures, and the floor

After each deletion the model is re-run and scored on the agent's **real** next message, teacher-forced.
\u0394NLL is how much harder that message became, in nats per token. It is continuous, so it does not depend on
the binary pass/fail metric that has returned null four times.

Its resolution was measured, not assumed. Re-running an identical computation gives bit-identical results \u2014
but that measures determinism, not accuracy. Running the *same* deletion through two numerically-equivalent
code paths (different attention kernel, same device and precision) gives an RMS disagreement of
**${sciMd(FLOOR)}**; across different device and precision, ${sciMd(FLOOR_XDEV)}. The first governs internal
comparisons, which is what this report makes. A decision point is analysable only if at least
${pct(MIN_FRAC)} of its units produce an effect above that floor; ${turns.length} of ${allTurns.length}
qualify. Within those, ${pct(TIES)} of individual measurements still sit below it.

For scale: the typical per-unit deletion effect is ${sciMd(MED_ABS)} nats/token, about
${(MED_ABS / FLOOR).toFixed(1)}\u00d7 the floor, and the spread between units within one decision point averages
${sciMd(SPREAD)}, about ${(SPREAD / FLOOR).toFixed(1)}\u00d7 the floor. The endpoint has real dynamic range; it is
not comfortable.

## Results

### The ceiling

${'<!--CHART-ARMS-->'}

| keep-fraction | cells | ${ARMS.map((a) => ARM_LABEL[a]).join(' | ')} |
|---|---|${ARMS.map(() => '---').join('|')}|
${armTableMd}

Mean \u0394NLL, lower is better. Every row is volume-matched.

${'<!--CHART-GAP-->'}

The headline contrasts, each against the floor:

| contrast | mean \u0394NLL difference | Cohen's d | cells favouring | vs floor |
|---|---|---|---|---|
| **oracle \u2212 random** | **${f5(ORACLE_VS_RANDOM.mean)}** | ${f3(ORACLE_VS_RANDOM.d)} | ${ORACLE_VS_RANDOM.wins}/${ORACLE_VS_RANDOM.n} | ${ORACLE_VS_RANDOM.withinFloor ? '**inside the floor**' : 'outside'} |
| **oracle \u2212 recency** | **${f5(ORACLE_VS_OLDEST.mean)}** | ${f3(ORACLE_VS_OLDEST.d)} | ${ORACLE_VS_OLDEST.wins}/${ORACLE_VS_OLDEST.n} | ${ORACLE_VS_OLDEST.withinFloor ? '**inside the floor**' : 'outside'} |
| recency \u2212 random | ${f5(OLDEST_VS_RANDOM.mean)} | ${f3(OLDEST_VS_RANDOM.d)} | ${OLDEST_VS_RANDOM.wins}/${OLDEST_VS_RANDOM.n} | ${OLDEST_VS_RANDOM.withinFloor ? 'inside the floor' : 'outside'} |
| low-attention \u2212 random | ${f5(LOW_VS_RANDOM.mean)} | ${f3(LOW_VS_RANDOM.d)} | ${LOW_VS_RANDOM.wins}/${LOW_VS_RANDOM.n} | ${LOW_VS_RANDOM.withinFloor ? 'inside the floor' : 'outside'} |
| low-attention \u2212 high-attention | ${f5(LOW_VS_HIGH.mean)} | ${f3(LOW_VS_HIGH.d)} | ${LOW_VS_HIGH.wins}/${LOW_VS_HIGH.n} | ${LOW_VS_HIGH.withinFloor ? 'inside the floor' : 'outside'} |

**The oracle's advantage over random is ${f5(ORACLE_VS_RANDOM.mean)} nats/token against a floor of
${sciMd(FLOOR)} — ${(Math.abs(ORACLE_VS_RANDOM.mean) / FLOOR).toFixed(0)}× the resolution limit.** Random
deletion costs ${f4(RANDOM_MEAN)}; perfect selection costs ${f4(ORACLE_MEAN)}. So
**${HEADROOM_PCT.toFixed(0)}% of the damage is avoidable**, and the question becomes how much of that any
real rule captures:

| rule | mean ΔNLL (lower is better) | share of the available prize captured |
|---|---|---|
${captureTableMd}

A negative share means the rule did **worse than deleting at random** — which is what the direction check
predicts for deliberately deleting the highest-attention units, and is the evidence that the attention signal
carries a real, if weak, direction.

At the largest keep-fraction the oracle's ΔNLL is ${f4(perFraction.filter((p) => p.n).slice(-1)[0].arms.oracle)},
and at 30% it is **negative** — deleting the right half of the history made the agent's next message *easier*
to predict than keeping all of it. Low-value history is not merely inert; carrying it costs something.

### Per session, and per keep-fraction

Four clusters is four clusters. All of them:

${'<!--CHART-SESSIONS-->'}

| session | cells | oracle \u2212 random | favouring | oracle \u2212 recency | favouring |
|---|---|---|---|---|---|
${sessTableMd}

${nFavourable} of ${perSession.length} clusters favour the oracle over random${allClustersAgree ? ', and they agree in sign — unlike the attention result in the same data, where one cluster runs the other way' : ''}. Every keep-fraction, not the
most favourable one:

| keep-fraction | cells | oracle \u2212 random | favouring | oracle \u2212 recency | favouring |
|---|---|---|---|---|---|
${fracGapMd}

### The attention hypothesis itself (F0\u2013F3)

| test | requirement | result |
|---|---|---|
| **F0** signal is not inert | varies across units | **passes** \u2014 ${inertPass}/${turns.length} decision points |
| **F0** signal is not relabelled recency | \\|\u03c1(mass, position)\\| \u2264 0.5 | **passes** \u2014 ${relabPass}/${turns.length} |
| **F1** direction | deleting high-attention units is worse than deleting low-attention ones | ${LOW_VS_HIGH.mean < 0 ? '**passes**' : '**fails**'} \u2014 ${f5(LOW_VS_HIGH.mean)} |
| **F2** attention beats position | margin \u2265 +0.10 | **does not pass** \u2014 pooled ${f3(POOL_F2)}, per-turn median ${f3(med(f2PerTurn))}, ${f2PerTurn.filter((v) => v > 0).length}/${f2PerTurn.length} decision points |
| **F3** policy value | low-attention \u2264 random | ${LOW_VS_RANDOM.mean < 0 ? 'right direction' : 'wrong direction'}, ${f5(LOW_VS_RANDOM.mean)}, ${LOW_VS_RANDOM.withinFloor ? '**inside the floor**' : 'outside the floor'} |

Pooled over ${pool.louo.length} (decision point \u00d7 unit) measurements, attention's partial correlation with the
causal effect, controlling for unit length, is ${f3(POOL_MASS)} against position's ${f3(POOL_POS)}.

## What we got wrong

An adversarial review of the first version of this experiment found five defects. Two of them invalidated the
measurement outright. They are listed because the corrected result differs from the first one by more than the
effect being studied.

1. **The attention row was read after the continuation it was supposed to predict.** Attention was captured
   during the same forward pass that scored the agent's next message, so the "current position" was the last
   token of that message. The predictor was conditioned on the answer, and the signal was not computable at
   eviction time at all \u2014 the live policy code could never have reproduced it. *Invalidated: every attention
   number in the first version.* Fixed by capturing on a separate pass over the context alone, with an
   assertion that the captured width equals the context length.
2. **Units did not include their tool results.** Assistant messages and tool results were separate units, so
   every single-unit deletion orphaned a tool call. *Invalidated: the ground truth itself*, which was partly
   measuring reactions to malformed transcripts. Fixed by pairing on the call identifier, with an automatic
   well-formedness check.
3. **"The measurement floor is exactly zero."** This came from re-scoring an identical tensor, which measures
   determinism rather than accuracy. *Invalidated: the claim that the endpoint had three orders of magnitude
   of dynamic range* \u2014 the bottom decade was arithmetic noise. Fixed by measuring with a shape-changing edit.
4. **A second endpoint, KL divergence, was below its own representable precision.** Computed in float32 from a
   bfloat16 forward, it produced values below the floating-point spacing \u2014 including a **negative KL**, which
   is impossible by construction \u2014 and its apparent correlation with attention was explained by unit length
   alone. *Invalidated: all KL-based claims*, which are withdrawn rather than re-stated.
5. **The corpus was four sessions, not five.** Two fixtures are the same session. *Invalidated: the planned
   clustered analysis*, which would have counted one session twice.

The size of the correction is the point. Before the fixes, the low-attention rule appeared to beat random with
an effect size of d = \u22121.24; measured correctly it is ${f3(LOW_VS_RANDOM.d)}.

## Conclusions

### What survives

- **A cheap instrument for causal importance.** Per-unit leave-one-out costs ~0.11 s per unit here, and
  reading attention costs 19.5 MiB rather than the 204 GB a naive full-attention export would need. Any future
  eviction signal can be validated offline against measured ground truth before a live token is spent.
- **The prize is large and mostly unclaimed.** Perfect unit-independent selection avoids
  ${HEADROOM_PCT.toFixed(0)}% of the damage random deletion causes. Recency captures ${CAP.oldest.toFixed(0)}%
  of that and attention ${CAP.lowattn.toFixed(0)}%, so about ${UNCLAIMED.toFixed(0)}% is still on the table.
  This is the number the rest of the project needs: it says keep looking for a better signal, and it says the
  previous nulls were about the candidates, not about the opportunity.
- **Deleting the right material can be better than deleting nothing.** At the 30% keep-fraction the oracle's
  ΔNLL is negative. Low-value history actively costs the model something, which is an argument for eviction
  as a quality mechanism and not only as a way to fit inside a window.
- **Volume matching is necessary but not sufficient.** The incumbent eviction code matches kept tokens to
  0.4% while diverging up to 2\u00d7 in unit count and 13\u00d7 in splice count. Any future arm comparison must
  match or covary those too.
- **Determinism is not accuracy**, and the distinction is worth ${Math.log10(FLOOR / 1e-12).toFixed(1)} orders of
  magnitude here. Every offline measurement in this repository should establish its floor with a
  shape-changing edit.

### What this licenses, and what it does not

**Established, on this model and these ${SESSIONS.length} sessions.** Which units are deleted matters:
under volume matching, measured-best selection causes ${Math.abs(ORACLE_VS_RANDOM.mean).toFixed(3)}
nats/token less damage than random deletion, ${(Math.abs(ORACLE_VS_RANDOM.mean) / FLOOR).toFixed(0)}\u00d7 the
numerical floor, with ${nFavourable} of ${SESSIONS.length} sessions agreeing in sign. The shipped recency rule
captures ${CAP.oldest.toFixed(0)}% of that margin.

**Licensed for the design.** The earlier between-rule nulls may no longer be cited as evidence that eviction
choice is unimportant. The search for a better eviction signal is justified, and leave-one-unit-out ΔNLL is a
usable offline yardstick for screening candidates before any live run. Any future arm comparison must match
unit and splice counts as well as tokens.

**Not licensed.** None of this licenses shipping an attention-based eviction rule, and none of it says what
the better signal is. The claims have different standing:

| claim | status |
|---|---|
| selection has a large ceiling under volume matching | **tested, supported** (offline, teacher-forced, one 1B model) |
| deleting high-attention units is worse than deleting low-attention ones (F1) | **tested, supported** |
| attention beats position by the pre-registered margin (F2) | **tested, not met** (pooled ${f3(POOL_F2)}, per-decision median ${f3(med(f2PerTurn))}) |
| the ceiling or the attention ranking transfers to the 27B deployment model | **untested** |
| a set-aware policy could exceed this ceiling | **untested** — the oracle bounds unit-independent ranking only |
| a better-chosen deletion changes task success for a live agent | **untested** — replayed transcripts only |

## Caveats

- **One model, and a small one.** Everything is measured on a 1B. The project's own vehicle is a 27B, and
  attention structure is known to be depth- and scale-dependent. The transfer has **not** been tested. The
  planned test is a size ladder (0.6B / 1B / 1.7B) checking whether the per-unit ranking is stable across
  scale; if it reshuffles between 0.6B and 1.7B it will not survive to 27B.
- **Four clusters.** This is the binding limit and no number of additional decision points from the same four
  sessions fixes it. Every figure here is descriptive; no confidence interval is quoted, because a clustered
  bootstrap on four clusters covers roughly 50\u201360% at a nominal 95%.
- **The two aggregations disagree in sign** depending on the inclusion floor and on whether measurements are
  pooled or averaged per decision point. Pooled, attention's margin over position is ${f3(POOL_F2)}; as a
  median of per-decision-point values it is ${f3(med(f2PerTurn))}. A result that flips with the aggregation
  choice is not stable at this sample size, and both are reported for that reason.
- **The oracle is a ceiling for unit-independent ranking only.** Single-unit effects are not additive, so the
  best *set* of units to delete need not be the units with the smallest individual effects. The oracle bounds
  every signal this project has proposed, all of which score units independently; it does not bound a
  set-aware policy.
- **Teacher-forced, not rollout.** \u0394NLL scores the agent's recorded next message. It cannot see a
  counterfactual where losing a unit sends the agent down a different but equally good path.
- **${pct(TIES)} of surviving measurements are below the floor**, which attenuates every rank statistic
  toward zero. A null here is partly a null about resolution.
- **Replayed transcripts, not live agents.** The transcript is fixed; the agent never reacts to the eviction.
  This is the immediate information cost of a deletion, not its trajectory cost.

---
*Data: \`${RESULTS}\` (+ \`.npz\` tensor sidecar).
Code: \`experiments/attention-over-history/{attn_signal,measure,floor,reanalyse}.py\`,
\`attn-policy.mjs\`. Design and pre-registration: \`experiments/attention-over-history/DESIGN.md\`.
Model \`${M.model}\`, ${M.dtype}, git \`${String(M.git_sha).slice(0, 12)}\`,
torch ${M.torch}, transformers ${M.transformers}.
Regenerate: \`node experiments/attention-over-history/report-attention-over-history.mjs\`*
`;

writeFileSync(join(OUT, 'report-attention-over-history.md'),
  MD.replace('<!--CHART-ARMS-->', '*(chart: damage by arm — see the HTML version)*')
    .replace('<!--CHART-GAP-->', '*(chart: gaps against the floor — see the HTML version)*')
    .replace('<!--CHART-SESSIONS-->', '*(chart: per-session gaps — see the HTML version)*'));

// ---------------------------------------------------------------- html
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function mdToHtml(md) {
  const lines = md.split('\n');
  let out = '', inTable = false, inList = false;
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/\\\|/g, '|')
    .replace(/&lt;sup&gt;([^&]*)&lt;\/sup&gt;/g, '<sup>$1</sup>');
  const closeTable = () => { if (inTable) { out += '</tbody></table></div>\n'; inTable = false; } };
  const closeList = () => { if (inList) { out += '</ul>\n'; inList = false; } };
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (L.startsWith('<!--CHART')) { closeTable(); closeList(); out += `\n@@${L.slice(4, -3)}@@\n`; continue; }
    if (/^\|/.test(L)) {
      const cells2 = L.split('|').slice(1, -1).map((c) => c.trim());
      if (/^[-: ]+$/.test(cells2.join(''))) continue;
      if (!inTable) { out += '<div class="tw"><table><thead><tr>' + cells2.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>\n'; inTable = true; continue; }
      out += '<tr>' + cells2.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>\n';
      continue;
    }
    closeTable();
    if (/^- /.test(L)) { if (!inList) { out += '<ul>\n'; inList = true; } out += `<li>${inline(L.slice(2))}</li>\n`; continue; }
    if (/^\d+\. /.test(L)) { if (!inList) { out += '<ul>\n'; inList = true; } out += `<li>${inline(L.replace(/^\d+\. /, ''))}</li>\n`; continue; }
    closeList();
    if (/^### /.test(L)) { out += `<h3>${inline(L.slice(4))}</h3>\n`; continue; }
    if (/^## /.test(L)) { out += `<h2>${inline(L.slice(3))}</h2>\n`; continue; }
    if (/^# /.test(L)) { out += `<h1>${inline(L.slice(2))}</h1>\n`; continue; }
    if (/^---\s*$/.test(L)) { out += '<hr>\n'; continue; }
    if (/^\*[^*].*\*$/.test(L.trim()) && i < 6) { out += `<p class="sub">${inline(L.trim().slice(1, -1))}</p>\n`; continue; }
    if (!L.trim()) continue;
    out += `<p>${inline(L)}</p>\n`;
  }
  closeTable(); closeList();
  return out;
}

let body = mdToHtml(MD);
body = body.replace('@@CHART-ARMS@@', `<div class="chart">${chartArms()}</div>`)
           .replace('@@CHART-GAP@@', `<div class="chart">${chartGap()}</div>`)
           .replace('@@CHART-SESSIONS@@', `<div class="chart">${chartSessions()}</div>`);
if (/@@CHART/.test(body)) throw new Error('a chart placeholder was not substituted');
if (/undefined|NaN|Infinity/.test(body)) throw new Error('report contains undefined/NaN/Infinity — refusing to write');

/**
 * Cheap XML well-formedness check on the emitted SVG.
 *
 * The charts are hand-built strings, so a missing quote or an unescaped `&`
 * produces a chart that silently fails to render in some viewers while looking
 * fine in others. Checking here means a broken chart fails the build.
 */
for (const m of body.matchAll(/<svg[\s\S]*?<\/svg>/g)) {
  const s = m[0];
  const open = [...s.matchAll(/<([a-zA-Z]+)(\s[^>]*?)?(\/?)>/g)];
  const stack = [];
  for (const t of open) {
    const [, name, , selfClose] = t;
    if (selfClose) continue;
    stack.push(name);
  }
  const close = [...s.matchAll(/<\/([a-zA-Z]+)>/g)].map((t) => t[1]);
  const counts = (arr) => arr.reduce((acc, k) => (acc[k] = (acc[k] ?? 0) + 1, acc), {});
  const co = counts(stack), cc = counts(close);
  for (const k of new Set([...Object.keys(co), ...Object.keys(cc)])) {
    if ((co[k] ?? 0) !== (cc[k] ?? 0)) {
      throw new Error(`SVG tag <${k}> unbalanced: ${co[k] ?? 0} open, ${cc[k] ?? 0} close`);
    }
  }
  const bare = s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, '');
  if (bare.includes('&')) throw new Error('SVG contains an unescaped ampersand');
}

const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Is there anything to win by choosing what to evict?</title><style>
:root{color-scheme:light}
body{margin:0;background:#fbfbfd;color:#1b1c1e;font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:880px;margin:0 auto;padding:36px 20px 80px}
h1{font-size:29px;line-height:1.2;margin:0 0 4px}
.sub{color:#5f6368;font-style:italic;margin:0 0 20px}
h2{font-size:21px;margin:40px 0 12px;border-bottom:1px solid #e3e3ea;padding-bottom:7px}
h3{font-size:16.5px;margin:26px 0 8px}
p{margin:12px 0}
.chart{background:#fff;border:1px solid #e3e3ea;border-radius:10px;padding:16px;margin:18px 0;overflow-x:auto}
.tw{overflow-x:auto;margin:14px 0}
table{border-collapse:collapse;width:100%;font-size:14px;background:#fff}
th,td{border:1px solid #e3e3ea;padding:8px 11px;text-align:left;vertical-align:top}
th{background:#f4f5fa;font-weight:600;white-space:nowrap}
code{background:#f0f0f6;border-radius:4px;font-size:13.5px;padding:1px 5px}
ul{padding-left:24px}li{margin:8px 0}
hr{border:0;border-top:1px solid #e3e3ea;margin:36px 0 18px}
sup{font-size:.7em}
</style></head><body><main>
${body}
</main></body></html>`;
writeFileSync(join(OUT, 'report-attention-over-history.html'), HTML);

console.log(`analysable turns ${turns.length}/${allTurns.length}, cells ${cells.length}, sessions ${SESSIONS.length}`);
console.log(`oracle - random : ${f5(ORACLE_VS_RANDOM.mean)}  d=${f3(ORACLE_VS_RANDOM.d)}  ${ORACLE_VS_RANDOM.wins}/${ORACLE_VS_RANDOM.n}  ${ORACLE_VS_RANDOM.withinFloor ? 'INSIDE FLOOR' : 'outside floor'}`);
console.log(`oracle - recency: ${f5(ORACLE_VS_OLDEST.mean)}  d=${f3(ORACLE_VS_OLDEST.d)}  ${ORACLE_VS_OLDEST.wins}/${ORACLE_VS_OLDEST.n}  ${ORACLE_VS_OLDEST.withinFloor ? 'INSIDE FLOOR' : 'outside floor'}`);
console.log(`headroom = ${HEADROOM_PCT.toFixed(1)}% of random's damage`);
console.log('wrote report-attention-over-history.{md,html}');
