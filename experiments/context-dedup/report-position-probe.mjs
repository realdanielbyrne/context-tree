/**
 * Report generator for the POSITION PROBE (both stages).
 *
 * Stage 1 (easy, 0 distractors, <=26k real tokens)  -> results-position-probe-easy.json
 * Stage 2 (hard, 7 distractors, <=156k real tokens) -> results-position-probe.json
 *
 * Emits report-position-probe.{md,html}. The HTML is self-contained (inline CSS +
 * hand-built SVG); no CDN, renders offline.
 *
 * Rerun: node experiments/context-dedup/report-position-probe.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'reports', 'metrics', 'context-dedup');
const load = (f) => JSON.parse(readFileSync(join(OUT, f), 'utf8'));
const easy = load('results-position-probe-easy.json');
const hard = load('results-position-probe.json');

/** One-sided 95% upper bound on the failure rate given n trials and zero failures. */
const ruleOut = (n) => 1 - Math.pow(0.05, 1 / n);
const pct = (v, d = 1) => `${(v * 100).toFixed(d)}%`;

/**
 * The slices the null is quoted over. Every n is DERIVED from the data — an earlier
 * revision hardcoded the both-stages-per-depth slice as 30 when it is 36
 * (18 per depth per stage), which understated the null by 1.5pp.
 */
const perDepth = (d) => d.rows.length / d.depths.length;
const SLICES = [
  { label: 'one cell', n: hard.needles_per_cell },
  { label: 'one depth, hard stage', n: perDepth(hard) },
  { label: 'one depth, both stages', n: perDepth(hard) + perDepth(easy) },
  { label: 'hard probe pooled', n: hard.rows.length },
  { label: 'both stages pooled', n: hard.rows.length + easy.rows.length },
];

/** Per (length, depth) cell: hits/total and the real prompt-token count actually sent. */
function cells(d) {
  return d.lengths.map((len) => {
    const byDepth = d.depths.map((dep) => {
      const c = d.rows.filter((x) => x.len === len && x.depth === dep);
      return { depth: dep, hits: c.filter((x) => x.hit).length, n: c.length };
    });
    const all = d.rows.filter((x) => x.len === len);
    const toks = all.map((x) => x.prompt_tokens).filter(Boolean);
    const secs = all.map((x) => x.seconds).sort((a, b) => a - b);
    return {
      len, byDepth,
      realTok: toks.length ? Math.max(...toks) : null,
      medSec: secs.length ? secs[Math.floor(secs.length / 2)] : null,
      distractors: d.distractors ?? 0,
      hits: all.filter((x) => x.hit).length, n: all.length,
    };
  });
}
const rowsE = cells(easy), rowsH = cells(hard);
const all = [...rowsE, ...rowsH];
const totalN = all.reduce((a, r) => a + r.n, 0);
const totalHits = all.reduce((a, r) => a + r.hits, 0);

// ---------------------------------------------------------------- charts ----
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Chart 1 — accuracy grid. Every cell is 6/6, and the point of the chart is that uniformity. */
function svgGrid() {
  const depths = hard.depths;
  const cw = 104, ch = 44, x0 = 200, y0 = 54;
  const w = x0 + depths.length * cw + 24, h = y0 + all.length * ch + 40;
  let s = `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="retrieval accuracy by needle depth and context length">`;
  s += `<text x="12" y="24" class="ct">Retrieval accuracy by needle depth × context length</text>`;
  depths.forEach((d, i) => {
    s += `<text x="${x0 + i * cw + cw / 2}" y="${y0 - 10}" class="ax mid">${(d * 100).toFixed(0)}%</text>`;
  });
  s += `<text x="${x0 + (depths.length * cw) / 2}" y="${h - 8}" class="ax mid">needle depth (0% = start of context, 100% = end)</text>`;
  all.forEach((r, ri) => {
    const y = y0 + ri * ch;
    const label = `${(r.realTok / 1000).toFixed(0)}k tok  ·  ${r.distractors} distr.`;
    s += `<text x="${x0 - 12}" y="${y + 27}" class="ax end">${esc(label)}</text>`;
    r.byDepth.forEach((c, ci) => {
      const ok = c.hits === c.n;
      const x = x0 + ci * cw;
      s += `<rect x="${x + 2}" y="${y + 2}" width="${cw - 6}" height="${ch - 6}" rx="4" fill="${ok ? '#1b7f4b' : '#b3261e'}"/>`;
      s += `<text x="${x + cw / 2 - 2}" y="${y + 27}" class="cell mid">${c.hits}/${c.n}</text>`;
    });
  });
  return s + '</svg>';
}

/** Chart 2 — what a null of this size can and cannot rule out. */
function svgPower() {
  const bars = SLICES.map((s) => ({ k: `${s.label} (n=${s.n})`, n: s.n }));
  const x0 = 250, bw = 460, bh = 30, gap = 14, y0 = 52;
  const h = y0 + bars.length * (bh + gap) + 40, w = x0 + bw + 70;
  const max = 0.45;
  let s = `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="largest failure rate consistent with zero observed failures">`;
  s += `<text x="12" y="24" class="ct">Largest true failure rate still consistent with 0 observed failures (95% one-sided)</text>`;
  bars.forEach((b, i) => {
    const v = ruleOut(b.n), y = y0 + i * (bh + gap);
    s += `<text x="${x0 - 12}" y="${y + 20}" class="ax end">${esc(b.k)}</text>`;
    s += `<rect x="${x0}" y="${y}" width="${bw}" height="${bh}" fill="#eceff1" rx="3"/>`;
    s += `<rect x="${x0}" y="${y}" width="${(v / max) * bw}" height="${bh}" fill="#37618e" rx="3"/>`;
    s += `<text x="${x0 + (v / max) * bw + 8}" y="${y + 20}" class="val">${pct(v)}</text>`;
  });
  s += `<text x="${x0 + bw / 2}" y="${h - 10}" class="ax mid">a smaller bar = a tighter null. Only the pooled rows exclude a small deficit.</text>`;
  return s + '</svg>';
}

/** Chart 3 — the one dose-response that IS present: prefill latency. */
function svgLatency() {
  const pts = all.filter((r) => r.realTok && r.medSec != null).sort((a, b) => a.realTok - b.realTok);
  const x0 = 70, y0 = 48, pw = 600, ph = 230;
  const w = x0 + pw + 40, h = y0 + ph + 56;
  const mx = Math.max(...pts.map((p) => p.realTok)), my = Math.max(...pts.map((p) => p.medSec));
  const px = (v) => x0 + (v / mx) * pw, py = (v) => y0 + ph - (v / my) * ph;
  let s = `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="median latency versus real prompt tokens">`;
  s += `<text x="12" y="24" class="ct">Median call latency vs real prompt tokens (prefill, not degradation)</text>`;
  s += `<line x1="${x0}" y1="${y0 + ph}" x2="${x0 + pw}" y2="${y0 + ph}" stroke="#9aa0a6"/>`;
  s += `<line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y0 + ph}" stroke="#9aa0a6"/>`;
  s += `<polyline fill="none" stroke="#37618e" stroke-width="2" points="${pts.map((p) => `${px(p.realTok)},${py(p.medSec)}`).join(' ')}"/>`;
  for (const p of pts) {
    s += `<circle cx="${px(p.realTok)}" cy="${py(p.medSec)}" r="4.5" fill="#37618e"/>`;
    s += `<text x="${px(p.realTok)}" y="${py(p.medSec) - 10}" class="val mid">${p.medSec}s</text>`;
    s += `<text x="${px(p.realTok)}" y="${y0 + ph + 18}" class="ax mid">${(p.realTok / 1000).toFixed(0)}k</text>`;
  }
  s += `<text x="${x0 + pw / 2}" y="${h - 12}" class="ax mid">real prompt tokens</text>`;
  return s + '</svg>';
}

// Derived headline figures. Nothing below restates a number the data can supply.
const MODEL_WINDOW = 262144;
const maxOf = (rows) => rows[rows.length - 1];
const MAX_TOK = maxOf(rowsH).realTok;
const hitsOf = (rows) => rows.reduce((a, r) => a + r.hits, 0);
const nOf = (rows) => rows.reduce((a, r) => a + r.n, 0);
const GRID = `${hard.lengths.length} context lengths × ${hard.depths.length} depths × ${hard.needles_per_cell} distinct needles per cell`;
const CANDIDATES = hard.distractors + 1;
const LEN_GROWTH = MAX_TOK / maxOf(rowsE).realTok;
const LATENCY_RATIO = maxOf(rowsH).medSec / rowsH[0].medSec;
const medOf = (x) => { const t = [...x].sort((a, b) => a - b); return t.length % 2 ? t[(t.length - 1) / 2] : (t[t.length / 2 - 1] + t[t.length / 2]) / 2; };
const TOK_OVER_EST = medOf([...hard.rows, ...easy.rows].filter((r) => r.prompt_tokens).map((r) => r.prompt_tokens / r.len)) - 1;
// The slice error withdrawn below: an earlier revision hardcoded this slice's n.
const SLICE_ERR_N = 30;
const SLICE_OK = SLICES.find((x) => x.label === 'one depth, both stages');
if (!SLICE_OK) throw new Error('slice "one depth, both stages" missing');
const RULEOUT_HARD = ruleOut(hard.rows.length);

const GLOSS = [
  ['Token', 'The unit text is measured in — roughly ¾ of a word. Counts in the tables are the provider\'s real prompt-token counts.'],
  ['Context window', `The most tokens a model accepts in one request. For the model here, ${MODEL_WINDOW.toLocaleString()}.`],
  ['Needle-in-a-haystack', 'A retrieval test: hide one specific fact (the needle) in a long body of filler text (the haystack), then ask for it.'],
  ['Depth', 'Where in the context the needle sits, as a fraction of its length: 0% is the very start, 100% the very end, just before the question.'],
  ['Distractor', 'A decoy sentence with the same wording as the needle but about a different subject, so the model must pick the right one rather than the only one.'],
  ['Hit', 'The model\'s answer exactly matches the needle\'s 4-digit code.'],
  ['Unit / eviction', 'A unit is one piece of an agent\'s transcript; eviction deletes units to fit a size limit. This project\'s eviction rules decide which units stay, never where they sit.'],
  ['RoPE', 'Rotary position embedding, how this model family encodes token position. It is known to weaken attention between distant tokens.'],
  ['Lost in the middle', 'A reported pattern in long-context models: facts at the start or end are found more reliably than facts in the middle.'],
  ['One-sided 95% upper bound', 'With zero failures in n trials, the largest true failure rate still consistent with the data at 95% confidence: 1 − 0.05^(1/n). It is what a clean null can rule out.'],
  ['Ceiling', 'Every condition scoring 100%. A ceiling can refute a claimed deficit but cannot rank conditions against each other.'],
  ['Prefill', 'The model\'s pass over the whole prompt before it writes anything; its cost grows with prompt length.'],
];
const glossMd = GLOSS.map(([t, m]) => `| **${t}** | ${m} |`).join('\n');
const glossHtml = GLOSS.map(([t, m]) => `<tr><td><strong>${esc(t)}</strong></td><td>${esc(m)}</td></tr>`).join('');

// ------------------------------------------------------------- markdown ----
const gridTable = (rows, d) => {
  const head = `| real prompt tok | ${d.depths.map((x) => `depth ${(x * 100).toFixed(0)}%`).join(' | ')} |`;
  const sep = `|---|${d.depths.map(() => '---').join('|')}|`;
  const body = rows.map((r) => `| ${r.realTok.toLocaleString()} | ${r.byDepth.map((c) => `${c.hits}/${c.n}`).join(' | ')} |`).join('\n');
  return [head, sep, body].join('\n');
};

const MD = `# Position probe — does retrieval depend on WHERE a fact sits?

## Abstract

This project's eviction rules for an AI coding agent decide which parts of a long transcript to keep, but never
where the kept parts sit: survivors stay in their original order. If a model's ability to use a fact depended on
its position in the context, that would be a design lever the rules cannot express, and it would also offer an
alternative explanation for failures seen when the transcript is capped. Two known mechanisms predict such an
effect: RoPE's attenuation with distance and the "lost in the middle" pattern.

We tested for it directly with a needle-in-a-haystack probe on \`${hard.model}\`: ${GRID}, graded by exact
match, run in two stages. The first stage had no distractors and was too easy to be informative. The second
placed ${hard.distractors} identically-worded distractors in the context and raised its length to
${MAX_TOK.toLocaleString()} real prompt tokens, ${pct(MAX_TOK / MODEL_WINDOW, 0)} of the model's window.

**The result is a clean null: ${totalHits} of ${totalN} retrievals succeeded, at every depth and every length.**
There is no decay with depth and no U-shape. Zero failures in the ${hard.rows.length} hard-stage trials rule out a
position-dependent failure rate above ${pct(RULEOUT_HARD)} on this task (one-sided 95%), which removes
position-aware assembly as a lever for this model at these lengths. The limit is the strength of the claim
at finer grain, and the task itself: a single depth could still hide a ${pct(ruleOut(perDepth(hard)), 0)} deficit,
and single-turn retrieval of a lexically distinct sentence is far easier than an agent using its own history.
The one dose-response present is latency, which grows with prompt length.

## What you need to know to read the rest

| Term | Meaning |
|---|---|
${glossMd}

## Why we ran this

Our eviction policies decide only **presence** — which units survive — never **position**. Survivors keep
creation order. If retrieval quality depended on where a fact sat, two policies that keep the same units
and leave them in the same band would be indistinguishable to the metric while differing in reality, and
we would be blind to a whole axis of the design space. The A/B window sweep saw exactly that shape:
idle vs positional recency, pooled \`p = 1.000\` (backlog item 8).

So the question is prior to any policy: **does the lever exist at all on this model?** Two mechanisms
predict it should — RoPE's long-term decay (attenuation with relative distance) and the "lost in the
middle" U-shape reported for long-context LLMs.

## The experimental setup

### The agent task these results are read against

The probe itself is synthetic, but the question comes from live runs of a fixed programming job called
\`longbuild\`. There the agent starts in a workspace holding a README, 13 specification documents (~20,000
characters in total) describing a small Python accounting library, five empty Python stubs to fill in
(\`money.py\`, \`parsing.py\`, \`rules.py\`, \`report.py\`, \`cli.py\`), and a visible test suite it may run at
any time. It works through six stages — read a stage's specification, implement it, run the tests, fix
failures, move on — and runs take roughly 53 to 61 steps. It is graded by a *held-out* test suite written
into the workspace only after it stops, which it never sees. When its transcript is capped (the "W-sweep"),
success falls; this probe asks whether part of that could be facts that are present but positioned badly.

### The probe

Classic needle-in-a-haystack, single-turn, \`temperature = 0\`, deterministic PRNG, so the whole probe
reruns identically.

- **Haystack** — non-repetitive synthetic records (each line distinct, so no pattern-match escape).
- **Needle** — \`IMPORTANT RECORD: the access code for sector <NAME> is <NNNN>.\` inserted at depth *d*.
- **Question** — appended at the very end; graded by exact match on the 4-digit code.
- **Grid** — ${GRID}.

### What was varied

**Stage 1 (easy)** ran with **${easy.distractors ?? 0} distractors**. It hit ${hitsOf(rowsE)}/${nOf(rowsE)} — but that result is
weak by construction: the needle was the only 4-digit number near the question's wording, so the model could
pattern-match rather than discriminate. A ceiling reached that way proves little.

**Stage 2 (hard)** is the one that counts. It adds **${hard.distractors} distractors** — competing \`IMPORTANT RECORD: the
access code for sector X is NNNN\` lines for *other* sectors, scattered at deterministic positions through
the haystack. Every distractor carries the identical framing, so neither the marker phrase nor "the only
4-digit number here" is a usable shortcut: the model must discriminate on the sector name among ${CANDIDATES}
candidates. Stage 2 also pushes the lengths up ~${LEN_GROWTH.toFixed(0)}×, to **${MAX_TOK.toLocaleString()} real prompt tokens** —
${pct(MAX_TOK / MODEL_WINDOW, 0)} of the model's ${MODEL_WINDOW.toLocaleString()}-token window.

### What was recorded, and how to rerun

Per trial: the answer, whether it was a hit, the real prompt-token count from the provider, and wall-clock
seconds.

- Model: \`${hard.model}\`, local, \`temp 0\`, \`max_tokens 32\`.
- Rerun: \`CT_PROBE_LENGTHS=${hard.lengths.join(',')} CT_PROBE_DISTRACTORS=${hard.distractors} node experiments/context-dedup/position-probe.mjs\`
- Commit: \`${hard.commit}\`, ${hard.date.slice(0, 10)}.

## Results

### Stage 2 — hard (${hard.distractors} distractors)

${gridTable(rowsH, hard)}

### Stage 1 — easy (${easy.distractors ?? 0} distractors)

${gridTable(rowsE, easy)}

### Pooled

| stage | distractors | max real tok | trials | hits | accuracy |
|---|---|---|---|---|---|
| easy | ${easy.distractors ?? 0} | ${maxOf(rowsE).realTok.toLocaleString()} | ${nOf(rowsE)} | ${hitsOf(rowsE)} | ${pct(hitsOf(rowsE) / nOf(rowsE), 0)} |
| hard | ${hard.distractors} | ${MAX_TOK.toLocaleString()} | ${nOf(rowsH)} | ${hitsOf(rowsH)} | ${pct(hitsOf(rowsH) / nOf(rowsH), 0)} |
| **both** | | | **${totalN}** | **${totalHits}** | **${pct(totalHits / totalN, 0)}** |

Zero errors, zero refusals, zero off-format answers across all ${totalN} calls.

### What this null does and does not cover

A null is only as strong as its detection floor. With zero observed failures, the 95% one-sided upper
bound on the true failure rate is:

| slice | n | largest deficit still consistent with the data |
|---|---|---|
${SLICES.map((x) => `| ${x.label} | ${x.n} | ${pct(ruleOut(x.n))} |`).join('\n')}

So the honest claim is: **no position-dependent failure rate above ~${pct(RULEOUT_HARD, 0)}
exists on this task at these lengths.** A claim about one *depth* is much weaker — a single depth could
carry a ${pct(ruleOut(perDepth(hard)), 0)} deficit and this design would likely miss it, and a single
*cell* weaker still (${pct(ruleOut(hard.needles_per_cell), 0)}). What is ruled out is a *large* effect,
which is what the design space cared about.

### The one real dose-response

Accuracy is flat; **latency is not**. Median call time scales ~linearly with prompt length
(${rowsH.map((r) => `${r.medSec}s @ ${(r.realTok / 1000).toFixed(0)}k`).join(', ')}). That is prefill
compute, not retrieval degradation — the model is doing more work per call, not doing it worse. Worth
noting because it means "just use a bigger window" is not free even when quality says it is: on this host
a ${(MAX_TOK / 1000).toFixed(0)}k-token turn costs ~${LATENCY_RATIO.toFixed(0)}× the wall-clock of a ${(rowsH[0].realTok / 1000).toFixed(0)}k-token turn.

## What we got wrong

**The detection floor for a single depth was overstated.** An earlier revision of this report hardcoded the
number of trials in the "one depth, both stages" slice as ${SLICE_ERR_N}. It is ${SLICE_OK.n}
(${perDepth(hard)} per depth in the hard stage plus ${perDepth(easy)} in the easy stage), so the largest
failure rate that slice can hide was quoted as ${pct(ruleOut(SLICE_ERR_N))} when it is ${pct(ruleOut(SLICE_OK.n))}
— ${((ruleOut(SLICE_ERR_N) - ruleOut(SLICE_OK.n)) * 100).toFixed(1)} percentage points too weak. The error ran against the null rather than for it and
changed no conclusion; every slice size is now derived from the data. Nothing else was withdrawn.

## Conclusions

1. **The RoPE-attenuation hypothesis is not supported at these lengths on this model.** No decay with
   depth, and no U-shape: depth 50% is identical to depth 0% and depth 100%. Whatever MRoPE's long-term
   decay does to attention weights, it does not produce measurable retrieval loss out to ${pct(MAX_TOK / MODEL_WINDOW, 0)} of the window.
2. **Position-aware assembly is dead as a lever here.** Our policies' inability to express position costs
   us nothing on this model at these sizes. That is a *relief* for the design, not a loss — it means the
   presence-only policy class is not leaving a known effect on the table.
3. **It removes an alternative explanation for the window-cap results.** The failures in the W-sweep were
   not "the fact was present but buried too deep to retrieve." Presence is sufficient. The failures were
   eviction removing content outright, which makes the eviction-cadence finding load-bearing rather than
   possibly-confounded by a positional artifact.

**What this does not license.** A large positional deficit in explicit, single-turn retrieval has been
**tested and rejected** for this model up to ${MAX_TOK.toLocaleString()} tokens. Three things remain
**untested**: whether position affects how much an agent *spontaneously* uses its own history in a multi-turn
loop; whether a smaller effect (below ~${pct(RULEOUT_HARD, 0)} pooled, or ~${pct(ruleOut(perDepth(hard)), 0)} at one depth) exists; and whether any
of this holds for another model or beyond ${pct(MAX_TOK / MODEL_WINDOW, 0)} of the window. Because every cell is at ceiling, the
probe also cannot say which ordering is better, only that none is detectably worse.

## Caveats

- **Single-turn retrieval of a lexically distinct sentence.** The needle is a copy target, not something
  the model must reason over. Real agent context is heterogeneous and the needed fact is rarely this
  distinct. A null here does not prove position is irrelevant inside a multi-turn agent loop.
- **A ceiling cannot rank policies.** 100% can only refute a claimed deficit. It cannot tell us which
  ordering is better, because every ordering is perfect.
- **One model** (\`${hard.model}\`), one host, one quantization. Positional effects are known to be
  architecture- and length-dependent; this says nothing about a different model or about longer contexts.
- **One synthetic problem.** Every trial is the same haystack design with different needles; the ${totalN}
  trials are repeats of one retrieval problem, not ${totalN} problems.
- **Lengths are estimated (chars/4) for construction**; real \`prompt_tokens\` from the provider ran ~${pct(TOK_OVER_EST, 0)}
  above the estimate and is what is reported in every table here.
- Stage 1's ${hitsOf(rowsE)}/${nOf(rowsE)} is a weak ceiling (no distractors) and is reported only as the pre-registered stage that
  motivated the hard variant.

---
*Data: \`results-position-probe.json\` (hard), \`results-position-probe-easy.json\` (easy).
Charts in the HTML twin: \`report-position-probe.html\`.*
`;

writeFileSync(join(OUT, 'report-position-probe.md'), MD);

// ------------------------------------------------------------------ html ----
const mdTableToHtml = (block) => {
  const lines = block.trim().split('\n').filter((l) => l.trim().startsWith('|'));
  const cellsOf = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const body = lines.filter((l) => !/^\|[\s|:-]+\|$/.test(l.trim()));
  const [h, ...rest] = body;
  const bold = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  return `<table><thead><tr>${cellsOf(h).map((c) => `<th>${bold(c)}</th>`).join('')}</tr></thead><tbody>${
    rest.map((r) => `<tr>${cellsOf(r).map((c) => `<td>${bold(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
};

const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Position probe — context-tree</title><style>
:root{--fg:#1b1c1e;--mut:#5f6368;--line:#dadce0;--bg:#fff;--accent:#37618e}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:960px;margin:0 auto;padding:32px 20px 80px}
h1{font-size:28px;line-height:1.25;margin:0 0 6px}
h2{font-size:20px;margin:40px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--line)}
h3{font-size:16px;margin:24px 0 8px;color:var(--mut)}
code{background:#f1f3f4;padding:1px 5px;border-radius:3px;font-size:13px}
table{border-collapse:collapse;width:100%;margin:12px 0;font-size:14px;display:block;overflow-x:auto}
th,td{border:1px solid var(--line);padding:6px 10px;text-align:left;white-space:nowrap}
th{background:#f8f9fa;font-weight:600}
.lede{font-size:17px;background:#e8f0f8;border-left:4px solid var(--accent);padding:14px 18px;border-radius:0 6px 6px 0;margin:18px 0 28px}
figure{margin:20px 0;border:1px solid var(--line);border-radius:8px;padding:12px;background:#fcfcfd}
figcaption{font-size:13px;color:var(--mut);margin-top:8px}
.ct{font:600 14px sans-serif;fill:#1b1c1e}
.ax{font:12px sans-serif;fill:#5f6368}
.val{font:600 12px sans-serif;fill:#1b1c1e}
.cell{font:700 14px sans-serif;fill:#fff}
.mid{text-anchor:middle}.end{text-anchor:end}
ul{padding-left:22px}li{margin:6px 0}
.note{font-size:14px;color:var(--mut);border-top:1px solid var(--line);margin-top:40px;padding-top:12px}
</style></head><body><main>

<h1>Position probe — does retrieval depend on <em>where</em> a fact sits?</h1>

<h2>Abstract</h2>
<p>This project's eviction rules for an AI coding agent decide which parts of a long transcript to keep, but
never where the kept parts sit: survivors stay in their original order. If a model's ability to use a fact
depended on its position in the context, that would be a design lever the rules cannot express, and it would
also offer an alternative explanation for failures seen when the transcript is capped. Two known mechanisms
predict such an effect: RoPE's attenuation with distance and the "lost in the middle" pattern.</p>
<p>We tested for it directly with a needle-in-a-haystack probe on <code>${esc(hard.model)}</code>: ${GRID},
graded by exact match, run in two stages. The first stage had no distractors and was too easy to be
informative. The second placed ${hard.distractors} identically-worded distractors in the context and raised its
length to ${MAX_TOK.toLocaleString()} real prompt tokens, ${pct(MAX_TOK / MODEL_WINDOW, 0)} of the model's window.</p>
<p class="lede"><strong>The result is a clean null: ${totalHits} of ${totalN} retrievals succeeded, at every
depth and every length.</strong> There is no decay with depth and no U-shape. Zero failures in the
${hard.rows.length} hard-stage trials rule out a position-dependent failure rate above ${pct(RULEOUT_HARD)} on this
task (one-sided 95%), which removes position-aware assembly as a lever for this model at these lengths. The
limit is the strength of the claim at finer grain, and the task itself: a single depth could still hide a
${pct(ruleOut(perDepth(hard)), 0)} deficit, and single-turn retrieval of a lexically distinct sentence is far easier
than an agent using its own history. The one dose-response present is latency, which grows with prompt
length.</p>

<h2>What you need to know to read the rest</h2>
<table><thead><tr><th>Term</th><th>Meaning</th></tr></thead><tbody>${glossHtml}</tbody></table>

<h2>Why we ran this</h2>
<p>Our eviction policies decide only <strong>presence</strong> — which units survive — never
<strong>position</strong>. Survivors keep creation order. If retrieval quality depended on where a fact
sat, two policies keeping the same units in the same band would look identical to the metric while
differing in reality. The A/B window sweep showed exactly that shape (idle vs positional recency, pooled
<code>p = 1.000</code>, backlog item 8). So the question is prior to any policy: <strong>does the lever exist
at all on this model?</strong> Two mechanisms predict it should: RoPE long-term decay, and the "lost in the
middle" U-shape.</p>

<h2>The experimental setup</h2>
<h3>The agent task these results are read against</h3>
<p>The probe itself is synthetic, but the question comes from live runs of a fixed programming job called
<code>longbuild</code>. There the agent starts in a workspace holding a README, 13 specification documents
(~20,000 characters in total) describing a small Python accounting library, five empty Python stubs to fill in
(<code>money.py</code>, <code>parsing.py</code>, <code>rules.py</code>, <code>report.py</code>,
<code>cli.py</code>), and a visible test suite it may run at any time. It works through six stages — read a
stage's specification, implement it, run the tests, fix failures, move on — and runs take roughly 53 to 61
steps. It is graded by a <em>held-out</em> test suite written into the workspace only after it stops, which it
never sees. When its transcript is capped (the "W-sweep"), success falls; this probe asks whether part of that
could be facts that are present but positioned badly.</p>
<h3>The probe</h3>
<p>Needle-in-a-haystack, single-turn, <code>temperature = 0</code>, deterministic PRNG. Haystack lines are
all distinct; the needle is <code>IMPORTANT RECORD: the access code for sector &lt;NAME&gt; is
&lt;NNNN&gt;.</code>; the question is appended at the end and graded by exact match. Grid: ${GRID}.</p>
<h3>What was varied</h3>
<p><strong>Stage 1 (easy, ${easy.distractors ?? 0} distractors)</strong> hit ${hitsOf(rowsE)}/${nOf(rowsE)}, but weakly — the
needle was the only 4-digit number near the question's wording. <strong>Stage 2 (hard, ${hard.distractors}
distractors)</strong> is the real test: every distractor uses the identical framing for a different sector, so
the model must discriminate on the sector name among ${CANDIDATES} candidates, and the lengths rise
~${LEN_GROWTH.toFixed(0)}× to <strong>${MAX_TOK.toLocaleString()} real prompt tokens</strong>
(${pct(MAX_TOK / MODEL_WINDOW, 0)} of the ${MODEL_WINDOW.toLocaleString()}-token window).</p>
<h3>What was recorded, and how to rerun</h3>
<p>Per trial: the answer, whether it was a hit, the real prompt-token count from the provider, and wall-clock
seconds. Model <code>${esc(hard.model)}</code>, local, <code>temp 0</code>, <code>max_tokens 32</code>. Rerun:
<code>CT_PROBE_LENGTHS=${hard.lengths.join(',')} CT_PROBE_DISTRACTORS=${hard.distractors} node experiments/context-dedup/position-probe.mjs</code>.
Commit <code>${esc(hard.commit)}</code>, ${hard.date.slice(0, 10)}.</p>

<h2>Results</h2>
<figure>${svgGrid()}<figcaption>Every cell is ${hard.needles_per_cell}/${hard.needles_per_cell}. Rows are ordered by real prompt tokens; the bottom
three are the hard stage, with ${hard.distractors} distractors each.</figcaption></figure>

<h3>Stage 2 — hard (${hard.distractors} distractors)</h3>
${mdTableToHtml(gridTable(rowsH, hard))}
<h3>Stage 1 — easy (${easy.distractors ?? 0} distractors)</h3>
${mdTableToHtml(gridTable(rowsE, easy))}
<h3>Pooled</h3>
<table><thead><tr><th>stage</th><th>distractors</th><th>max real tok</th><th>trials</th><th>hits</th><th>accuracy</th></tr></thead><tbody>
<tr><td>easy</td><td>${easy.distractors ?? 0}</td><td>${maxOf(rowsE).realTok.toLocaleString()}</td><td>${nOf(rowsE)}</td><td>${hitsOf(rowsE)}</td><td>${pct(hitsOf(rowsE) / nOf(rowsE), 0)}</td></tr>
<tr><td>hard</td><td>${hard.distractors}</td><td>${MAX_TOK.toLocaleString()}</td><td>${nOf(rowsH)}</td><td>${hitsOf(rowsH)}</td><td>${pct(hitsOf(rowsH) / nOf(rowsH), 0)}</td></tr>
<tr><td><strong>both</strong></td><td></td><td></td><td><strong>${totalN}</strong></td><td><strong>${totalHits}</strong></td><td><strong>${pct(totalHits / totalN, 0)}</strong></td></tr>
</tbody></table>
<p>Zero errors, zero refusals, zero off-format answers across all ${totalN} calls.</p>

<h3>What this null does and does not cover</h3>
<p>A null is only as strong as its detection floor. With zero observed failures, the 95% one-sided upper
bound on the true failure rate is:</p>
<figure>${svgPower()}<figcaption>The honest claim is the pooled one: no position-dependent failure rate
above ~${pct(RULEOUT_HARD, 0)} exists on this task at these lengths. A single depth could
still hide a ${pct(ruleOut(perDepth(hard)), 0)} deficit, and a single cell
${pct(ruleOut(hard.needles_per_cell), 0)}.</figcaption></figure>

<h3>The one real dose–response</h3>
<figure>${svgLatency()}<figcaption>Accuracy is flat; latency is not. This is prefill compute, not retrieval
degradation — the model does more work per call, not worse work. A ${(MAX_TOK / 1000).toFixed(0)}k-token turn costs
~${LATENCY_RATIO.toFixed(0)}× the wall-clock of a ${(rowsH[0].realTok / 1000).toFixed(0)}k-token one on this host.</figcaption></figure>

<h2>What we got wrong</h2>
<p><strong>The detection floor for a single depth was overstated.</strong> An earlier revision of this report
hardcoded the number of trials in the "one depth, both stages" slice as ${SLICE_ERR_N}. It is ${SLICE_OK.n}
(${perDepth(hard)} per depth in the hard stage plus ${perDepth(easy)} in the easy stage), so the largest failure
rate that slice can hide was quoted as ${pct(ruleOut(SLICE_ERR_N))} when it is ${pct(ruleOut(SLICE_OK.n))} —
${((ruleOut(SLICE_ERR_N) - ruleOut(SLICE_OK.n)) * 100).toFixed(1)} percentage points too weak. The error ran against the null rather than for it and changed
no conclusion; every slice size is now derived from the data. Nothing else was withdrawn.</p>

<h2>Conclusions</h2>
<ul>
<li><strong>The RoPE-attenuation hypothesis is not supported</strong> at these lengths on this model. No
decay with depth and no U-shape: depth 50% equals depth 0% equals depth 100%, out to ${pct(MAX_TOK / MODEL_WINDOW, 0)} of the window.</li>
<li><strong>Position-aware assembly is dead as a lever here.</strong> The presence-only policy class is not
leaving a known effect on the table — a relief for the design, not a loss.</li>
<li><strong>It removes an alternative explanation for the window-cap results.</strong> W-sweep failures
were not "present but buried too deep to retrieve"; presence is sufficient. Eviction removed content
outright, which makes the cadence finding load-bearing rather than possibly confounded.</li>
</ul>
<p><strong>What this does not license.</strong> A large positional deficit in explicit, single-turn retrieval
has been <strong>tested and rejected</strong> for this model up to ${MAX_TOK.toLocaleString()} tokens. Three
things remain <strong>untested</strong>: whether position affects how much an agent <em>spontaneously</em> uses
its own history in a multi-turn loop; whether a smaller effect (below ~${pct(RULEOUT_HARD, 0)} pooled, or
~${pct(ruleOut(perDepth(hard)), 0)} at one depth) exists; and whether any of this holds for another model or beyond
${pct(MAX_TOK / MODEL_WINDOW, 0)} of the window. Because every cell is at ceiling, the probe also cannot say which
ordering is better, only that none is detectably worse.</p>

<h2>Caveats</h2>
<ul>
<li><strong>Single-turn retrieval of a lexically distinct sentence.</strong> A copy target, not something
the model must reason over. A null here does not prove position is irrelevant in a multi-turn agent loop.</li>
<li><strong>A ceiling cannot rank policies</strong> — 100% can only refute a claimed deficit.</li>
<li><strong>One model, one host, one quantization.</strong> Positional effects are architecture- and
length-dependent; this says nothing about longer contexts or a different model.</li>
<li><strong>One synthetic problem.</strong> The ${totalN} trials are repeats of one retrieval problem, not ${totalN}
problems.</li>
<li>Lengths are estimated (chars/4) for construction; real <code>prompt_tokens</code> ran ~${pct(TOK_OVER_EST, 0)} above the
estimate and is what every table reports.</li>
<li>Stage 1's ${hitsOf(rowsE)}/${nOf(rowsE)} is a weak ceiling and is reported only as the stage that motivated the hard variant.</li>
</ul>

<p class="note">Data: <code>results-position-probe.json</code> (hard),
<code>results-position-probe-easy.json</code> (easy). Markdown twin:
<code>report-position-probe.md</code>. Generated by
<code>experiments/context-dedup/report-position-probe.mjs</code> at commit <code>${esc(hard.commit)}</code>.</p>
</main></body></html>`;

writeFileSync(join(OUT, 'report-position-probe.html'), HTML);
console.log(`wrote report-position-probe.{md,html} -> ${OUT}`);
console.log(`pooled ${totalHits}/${totalN}; rule-out @n=90 = ${pct(ruleOut(90))}`);
