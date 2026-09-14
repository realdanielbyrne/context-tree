/**
 * DV2 — the DECISIVE test: does a single-version working set still win once prompt
 * caching is priced in? Single-version shrinks context but MUTATES the prefix on
 * every version swap (a cache write, 1.25x); append-all keeps a stable prefix
 * (cache reads, 0.1x) but carries every stale version forever. This models the
 * cache-adjusted effective cost with the repo's own ProviderCacheSimulator
 * (Anthropic profile, automatic-prefix matching).
 *
 * Arms (one variable — assembler policy):
 *   append-all   : current frameworks — every read/edit appended, nothing dropped.
 *   sv-flat      : single-version, one block per file at first-seen position, all
 *                  after the system breakpoint (no static/volatile split).
 *   sv-placed    : single-version with placement — reference files (never edited)
 *                  in a static cached segment; edit-target files in the volatile
 *                  region so a version swap only rewrites the tail. (Oracle
 *                  placement: uses whole-session knowledge of which files are
 *                  edited — an upper bound a deterministic online policy approaches.)
 *
 * Effective cost = cacheRead*0.1 + cacheWrite*1.25 + fresh*1.0 (Anthropic multipliers).
 * Rerun: node experiments/context-dedup/dv2-cache-cost.mjs
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProviderCacheSimulator, ANTHROPIC_PROFILE, cacheReport } from '../../packages/core/dist/cache/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const FIX = join(ROOT, 'packages', 'cli', 'test', 'fixtures');
const OUT = join(ROOT, 'reports', 'metrics', 'context-dedup');
const tokenizer = { id: 'chars4', count: (t) => Math.ceil(t.length / 4) };
const SYS = 'SYSTEM-PROMPT-AND-TOOL-SCHEMAS '.repeat(170); // ~5100 chars > Anthropic 1024-token min
const EDIT_RESULT = 'The file has been updated. Here is the result of the edit with a short patch preview.'; // ~85 chars
// Anthropic input-token multipliers (relative to base uncached input).
const W = { read: 0.1, write: 1.25, fresh: 1.0 };

const norm = (p) => {
  if (typeof p !== 'string') return '(unknown)';
  const i = p.lastIndexOf('context-tree/');
  return i >= 0 ? p.slice(i + 'context-tree/'.length) : p;
};

/** Parse a fixture into an ordered event stream + the set of files ever edited. */
function parse(file) {
  const meta = new Map(); // tool_use id -> {name, path, argsText}
  const events = [];
  const edited = new Set();
  for (const s of readFileSync(file, 'utf8').split('\n')) {
    if (!s.trim()) continue;
    let o;
    try { o = JSON.parse(s); } catch { continue; }
    const c = o?.message?.content;
    if (o.type === 'assistant' && Array.isArray(c)) {
      let text = '';
      for (const b of c) {
        if (b?.type === 'text') text += b.text ?? '';
        if (b?.type === 'tool_use') {
          meta.set(b.id, { name: b.name, path: norm(b.input?.file_path), args: JSON.stringify(b.input ?? {}) });
          text += `\n[tool_call ${b.name}] ${JSON.stringify(b.input ?? {})}`; // the diff/args ride in the assistant msg
        }
      }
      events.push({ t: 'assistant', text: text || '(assistant)' });
    } else if (o.type === 'user' && Array.isArray(c)) {
      for (const b of c) {
        if (b?.type !== 'tool_result') continue;
        const m = meta.get(b.tool_use_id);
        if (!m) { events.push({ t: 'other', text: resultText(o, b) }); continue; }
        if (m.name === 'Read') events.push({ t: 'read', file: m.path, text: resultText(o, b) });
        else if (m.name === 'Edit') { edited.add(m.path); events.push({ t: 'edit', file: m.path }); }
        else events.push({ t: 'other', text: resultText(o, b) });
      }
    }
  }
  return { events, edited };
}
function resultText(o, b) {
  const tur = o.toolUseResult;
  if (tur && typeof tur === 'object' && tur.file && typeof tur.file.content === 'string') return tur.file.content;
  const c = b.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (x && typeof x === 'object' ? (x.text ?? '') : '')).join('');
  return '';
}

const blk = (id, zone, text) => ({ id, zone, text });
const submit = (sim, blocks, bpIds) => sim.submit({ system: SYS, blocks, budgets: {}, cacheBreakpoints: bpIds });

/** append-all: stable growing prefix; every read/edit is its own block, nothing dropped. */
function runAppend(events) {
  const sim = new ProviderCacheSimulator({ tokenizer, profile: ANTHROPIC_PROFILE });
  const log = [blk('task', 'head', 'TASK')];
  let n = 0;
  for (const e of events) {
    if (e.t === 'assistant') {
      const blocks = [blk('sys', 'head', SYS), ...log];
      submit(sim, blocks, ['sys', blocks[blocks.length - 1].id]);
      log.push(blk(`a${n++}`, 'flex', e.text));
    } else if (e.t === 'read') log.push(blk(`r${n++}`, 'flex', e.text));
    else if (e.t === 'edit') log.push(blk(`e${n++}`, 'flex', EDIT_RESULT));
    else log.push(blk(`o${n++}`, 'flex', e.text));
  }
  return cacheReport(sim.outcomes());
}

/**
 * single-version: one block per file (latest text). mode:
 *  'flat'   — file blocks at first-seen position in the convo stream (mutated in place).
 *  'placed' — never-edited (reference) files pulled into a static cached segment;
 *             edit-target files stay in the stream.
 *  'tail'   — file blocks live in a dedicated VOLATILE TAIL after the (cacheable)
 *             convo, so a version swap only rewrites the small tail, never the convo.
 */
function runSingleVersion(events, edited, mode) {
  const sim = new ProviderCacheSimulator({ tokenizer, profile: ANTHROPIC_PROFILE });
  const convo = [blk('task', 'flex', 'TASK')]; // assistant/edit/other, append-only (never mutated)
  const stream = mode === 'tail' ? [] : convo; // where file blocks live (own tail, or inline)
  const tail = [];                              // 'tail' mode: file blocks, first-seen order
  const fileBlock = new Map();
  let n = 0;
  const touchFile = (file, text) => {
    let b = fileBlock.get(file);
    if (!b) {
      b = blk(`f:${file}`, edited.has(file) ? 'flex' : 'head', text);
      fileBlock.set(file, b);
      (mode === 'tail' ? tail : stream).push(b);
    } else b.text = text; // version swap: mutate in place
  };
  for (const e of events) {
    if (e.t === 'assistant') {
      let blocks, bps;
      if (mode === 'flat') {
        blocks = [blk('sys', 'head', SYS), ...convo];
        bps = ['sys', blocks[blocks.length - 1].id];
      } else if (mode === 'placed') {
        const refs = convo.filter((b) => b.id.startsWith('f:') && !edited.has(b.id.slice(2)));
        const rest = convo.filter((b) => !(b.id.startsWith('f:') && !edited.has(b.id.slice(2))));
        blocks = [blk('sys', 'head', SYS), ...refs, ...rest];
        bps = ['sys'];
        if (refs.length) bps.push(refs[refs.length - 1].id);
        bps.push(blocks[blocks.length - 1].id);
      } else { // tail
        blocks = [blk('sys', 'head', SYS), ...convo, ...tail];
        bps = ['sys', convo[convo.length - 1].id];
        if (tail.length) bps.push(tail[tail.length - 1].id);
      }
      submit(sim, blocks, bps);
      convo.push(blk(`a${n++}`, 'flex', e.text));
    } else if (e.t === 'read') touchFile(e.file, e.text);
    else if (e.t === 'edit') {
      const b = fileBlock.get(e.file);
      touchFile(e.file, (b ? b.text : `FILE ${e.file}`) + `\n[edit r${n}]`);
      convo.push(blk(`e${n++}`, 'flex', EDIT_RESULT)); // changelog entry stays in convo
    } else convo.push(blk(`o${n++}`, 'flex', e.text));
  }
  return cacheReport(sim.outcomes());
}

const eff = (r) => r.cacheRead * W.read + r.cacheWrite * W.write + r.fresh * W.fresh; // cached cost
const raw = (r) => r.total; // no-cache cost = total tokens transmitted

const files = readdirSync(FIX).filter((f) => /^claude-code-session.*\.jsonl$/.test(f)).sort();
const sessions = [];
for (const f of files) {
  const { events, edited } = parse(join(FIX, f));
  const arms = {
    append: runAppend(events),
    flat: runSingleVersion(events, edited, 'flat'),
    placed: runSingleVersion(events, edited, 'placed'),
    tail: runSingleVersion(events, edited, 'tail'),
  };
  const name = basename(f).replace('claude-code-', '').replace('.jsonl', '');
  const effs = Object.fromEntries(Object.entries(arms).map(([k, r]) => [k, eff(r)]));
  const raws = Object.fromEntries(Object.entries(arms).map(([k, r]) => [k, raw(r)]));
  sessions.push({ name, editedFiles: edited.size, submissions: arms.append.submissions, arms, effs, raws,
    cachedBest: Object.entries(effs).sort((a, b) => a[1] - b[1])[0][0],
    tailCachedVsAppend: 1 - effs.tail / effs.append,   // negative = single-version costs MORE (cached)
    tailRawVsAppend: 1 - raws.tail / raws.append });   // positive = cheaper without caching
}
const results = { experiment: 'DV2 / cache-adjusted cost of a single-version working set', date: new Date().toISOString(),
  profile: ANTHROPIC_PROFILE.id, multipliers: W, sessions,
  caveats: [
    'Cached cost = cacheRead*0.1 + cacheWrite*1.25 + fresh*1.0 (Anthropic input multipliers). No-cache cost = total tokens transmitted.',
    'Simulator: ProviderCacheSimulator, ANTHROPIC_PROFILE, automatic-prefix matching; chars/4 tokenizer.',
    'No WINDOW LIMIT is modelled: append-all is allowed to cache an unbounded, ever-growing prefix. This structurally favours append-all — its whole advantage here is that nothing is ever dropped, which a real hard window forbids. The single-version case for a bounded window (fitting more relevant content) is NOT what this measures; see E1/DV3.',
    'sv-placed/tail use ORACLE placement (whole-session knowledge of which files are edited) — an upper bound a deterministic online policy would approach.',
    'An edit yields no post-edit full content, so a file block is version-bumped with a marker; reads carry real content. Non-file tool outputs are kept identically in all arms.',
  ] };
writeFileSync(join(OUT, 'results-dv2.json'), JSON.stringify(results, null, 2));

// Δ = savings vs append-all (1 − arm/append); NEGATIVE = more expensive than append-all.
const d = (v) => `${v >= 0 ? '' : '−'}${Math.abs(v * 100).toFixed(1)}%`;
const M = (v) => `${(v / 1e6).toFixed(2)}M`;
const cachedRows = sessions.map((s) => {
  const dv = (k) => d(1 - s.effs[k] / s.effs.append);
  return `| ${s.name} | ${s.submissions} | ${s.editedFiles} | ${M(s.effs.append)} | ${M(s.effs.flat)} (${dv('flat')}) | ${M(s.effs.placed)} (${dv('placed')}) | ${M(s.effs.tail)} (${dv('tail')}) |`;
}).join('\n');
const rawRows = sessions.map((s) => {
  const dv = (k) => d(1 - s.raws[k] / s.raws.append);
  return `| ${s.name} | ${M(s.raws.append)} | ${M(s.raws.flat)} (${dv('flat')}) | ${M(s.raws.placed)} (${dv('placed')}) | ${M(s.raws.tail)} (${dv('tail')}) |`;
}).join('\n');
const allAppendCached = sessions.every((s) => s.cachedBest === 'append');
const md = `# DV2 — cache-adjusted cost of a single-version working set

**Question (one variable — assembler policy):** once prompt caching is priced in, does a single-version
working set still beat append-all, given that a version swap rewrites the prefix (cache write 1.25×)
while append-all's stale prefix is cache-read at 0.1×? Simulated with the repo's \`ProviderCacheSimulator\`
(Anthropic profile, automatic-prefix). Rerun: \`node experiments/context-dedup/dv2-cache-cost.mjs\`.

Arms: **append-all** (current frameworks), **sv-flat** (file blocks inline, mutated in place),
**sv-placed** (reference files in a static cached segment), **sv-tail** (file versions in a dedicated
volatile tail so a swap rewrites only the tail). Δ is vs append-all; **negative = MORE expensive.**

## Cached cost (Anthropic prompt caching) — lower is better
| session | turns | edited | append-all | sv-flat | sv-placed | sv-tail |
|---|---|---|---|---|---|---|
${cachedRows}

## No-cache cost (raw tokens transmitted) — lower is better
| session | append-all | sv-flat | sv-placed | sv-tail |
|---|---|---|---|---|
${rawRows}

## Finding — the result INVERTS with caching

**Under prompt caching, append-only wins${allAppendCached ? ' in every session' : ''} — decisively.** Append-only mutates nothing, so it runs at a ~100% cache-read ratio (every prior token billed at 0.1×) and writes only the small per-turn delta. Single-version shrinks the context but every version swap forces a cache **write** at 1.25×; at a **12.5× write/read multiplier**, the rewrites cost far more than the cheap reads they save — even sv-tail, which confines swaps to a small tail, does not overcome it here. This matches the cache asymmetry the flex assembler already exploits: *never rewrite a cached prefix.*

**Without caching, single-version is cheaper** (no-cache table) — but only modestly, because file reads are a minority of the full context (assistant turns, edit diffs, and non-file tool output dominate and are equal across arms). The dramatic DV1 numbers were on the read subset alone.

**The real caveat: no window limit is modelled.** Append-only "wins" here precisely because it is allowed to cache an unbounded, ever-growing prefix. A real hard window forbids that — past the limit the prefix must be dropped or compacted, forfeiting both the content and the cache. **So single-version's value is not cost-under-caching; it is fitting more *relevant* content under a bounded window** (the overflow regime), and lowering cost for providers/turns without caching. That is what E1 (gating) and DV3 (task success under a forced window) must test — not raw cost with an infinite window.

${results.caveats.map((c) => `- ${c}`).join('\n')}
`;
writeFileSync(join(OUT, 'report-dv2-cache-cost.md'), md);
console.log('DV2 done. Cached cost (lower=better), Δ vs append (negative=more expensive):');
for (const s of sessions) console.log(`  ${s.name}: append ${M(s.effs.append)}  tail ${M(s.effs.tail)} (${d(1 - s.effs.tail / s.effs.append)})  | no-cache tail Δ ${d(s.tailRawVsAppend)}  | cached best: ${s.cachedBest}`);
console.log(`Wrote results-dv2.json, report-dv2-cache-cost.md → ${OUT}`);
