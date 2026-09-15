/**
 * DV4 — ANCHOR-DEDUP OPPORTUNITY (offline, deterministic, no model).
 *
 * Question: if every tool result whose bytes are ALREADY RESIDENT in context were
 * replaced by a short referential anchor, how many tokens would that save on real
 * agent sessions — priced through the provider cache, not raw token volume?
 *
 * Why the cache pricing matters (caveat C2, reports/session-handoff.md:180):
 * context reduction normally LOSES under caching because mutating the prefix costs
 * a 1.25-2.0x rewrite. Anchor-dedup never mutates: it declines to APPEND. So it is
 * strictly append-only, like the baseline, and any saving is real rather than
 * repaid as cache writes. This script is what establishes that empirically.
 *
 * Arms (all append-only; none mutates a cached prefix):
 *   append-all     baseline. Every tool result appended in full. (= dv2's runAppend)
 *   anchor-strict  substitute ONLY where the resident copy is byte-truthful and
 *                  UNEDITED. The conservative, provably-honest policy.
 *   anchor-diff    also substitute where the file was edited since, naming the
 *                  model's own resident edit hunks. This is the majority case.
 *
 * FIXTURE CORRECTION: claude-code-session-4.jsonl is EXCLUDED — its 307 message.ids
 * are 307/307 contained in claude-code-session-5.jsonl. Counting both double-counts
 * a third of the corpus. Four independent sessions remain.
 *
 * Falsification (pre-registered): if pooled suppressible content is < 10% of total
 * prompt tokens under cache-adjusted accounting, the "dramatic reduction" claim is
 * dead and the live instruments are not run.
 *
 * Deterministic: no model, no RNG. Rerun and diff to prove it.
 *   node experiments/context-dedup/dv4-anchor-dedup.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProviderCacheSimulator, ANTHROPIC_PROFILE, cacheReport } from '../../packages/core/dist/cache/index.js';
import { writeResults, gitSha, nowISO } from '../rung-1-live-probe/lib.mjs';
import { makeAnchorIndex, normalizeContent, contentHash, normPath, estTok } from './anchor-index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FX = join(HERE, '..', '..', 'packages', 'cli', 'test', 'fixtures');
const SYS = 'You are a coding agent.';
const tokenizer = { id: 'chars4', count: (t) => Math.ceil(t.length / 4) };
/** Anthropic input multipliers. 5-minute write tier and 1-hour write tier (C3: g* is tier-dependent). */
const TIERS = { '5min': { read: 0.1, write: 1.25, fresh: 1.0 }, '1hour': { read: 0.1, write: 2.0, fresh: 1.0 } };
const EXCLUDE = new Set(['claude-code-session-4.jsonl']);

/** Claude JSONL -> a flat event stream on the message.id clock (NOT the line clock). */
function extractEvents(file) {
  const meta = new Map();
  const events = [];
  let lastId = null, turn = -1;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const m = o.message || {};
    const c = m.content;
    if (m.id && m.id !== lastId) { turn += 1; lastId = m.id; }
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_use') {
        meta.set(b.id, { name: b.name, path: normPath((b.input || {}).file_path), input: b.input || {} });
        if (b.name === 'Edit' || b.name === 'MultiEdit') {
          events.push({ turn, t: 'edit', path: normPath((b.input || {}).file_path), old: (b.input || {}).old_string, new: (b.input || {}).new_string });
        } else if (b.name === 'Write') {
          events.push({ turn, t: 'write', path: normPath((b.input || {}).file_path), text: (b.input || {}).content || '' });
        }
      } else if (b.type === 'tool_result') {
        const mm = meta.get(b.tool_use_id);
        if (!mm) continue;
        const text = resultText(o, b);
        if (mm.name === 'Read' && mm.path) events.push({ turn, t: 'read', path: mm.path, text, ranged: mm.input.offset !== undefined || mm.input.limit !== undefined });
        else events.push({ turn, t: 'other', text });
      } else if (b.type === 'text' && b.text) {
        events.push({ turn, t: 'assistant', text: b.text });
      }
    }
  }
  return events;
}
function resultText(o, b) {
  const tur = o.toolUseResult;
  if (tur && typeof tur === 'object' && tur.file && typeof tur.file.content === 'string') return tur.file.content;
  const c = b.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (x && typeof x === 'object' ? (x.text ?? '') : '')).join('');
  return '';
}

/**
 * AUTHORITATIVE path-vs-content statistics for the Read tool.
 *
 * This exists because the motivating figure for this whole line of work -- the
 * "59.2% of reads are re-reads" in duplicate-read-analysis.md -- is a PATH
 * statistic, and the anchor policy can only act on CONTENT. The two differ by
 * roughly an order of magnitude and the difference is the finding.
 *
 * Taxonomy, per Read call in order:
 *   first-read    this normalized path has not been Read before
 *   path-repeat   it has
 * Attributes of a path-repeat (NOT mutually exclusive except where noted):
 *   ranged          the call carries offset/limit -- it asks for a DIFFERENT SLICE
 *   edited_since    an Edit/MultiEdit/Write touched this path after the last Read of it
 *   content_exact   normalized bytes equal some resident block (any path, incl. Write payloads)
 *   content_contained  normalized bytes are a substring of a resident block for the SAME path
 *   anchorable_strict  (exact or contained) AND NOT edited_since -- the truthfully replaceable set
 */
function corpusStats(rawEvents, minChars = 200) {
  const st = {
    reads: 0, first_read: 0, path_repeat: 0,
    repeat_ranged: 0, repeat_edited_since: 0,
    repeat_content_exact: 0, repeat_content_contained: 0,
    anchorable_strict: 0, anchorable_if_edits_included: 0,
    anchorable_strict_no_floor: 0,
  };
  const residentByPath = new Map();   // path -> [{turn, text}]
  const residentHashes = new Map();   // hash -> turn (any path, incl. Write payloads)
  const editTurns = new Map();        // path -> [turn]  -- Edit/MultiEdit ONLY
  const seenPath = new Set();

  for (const e of rawEvents) {
    if (e.t === 'write') {
      // A Write is NOT staleness: its payload IS the current content and it is
      // resident in the tool-call arguments. Treating it as an edit while also
      // matching against it is self-contradictory (it suppressed the policy's
      // own best case). Only Edit/MultiEdit invalidate a resident block.
      const t = normalizeContent(e.text);
      if (t) residentHashes.set(contentHash(t), e.turn);
      if (e.path) { if (!residentByPath.has(e.path)) residentByPath.set(e.path, []); residentByPath.get(e.path).push({ turn: e.turn, text: t }); }
      continue;
    }
    if (e.t === 'edit') {
      if (e.path) { if (!editTurns.has(e.path)) editTurns.set(e.path, []); editTurns.get(e.path).push(e.turn); }
      continue;
    }
    if (e.t !== 'read') continue;
    st.reads += 1;
    const t = normalizeContent(e.text);
    const prior = residentByPath.get(e.path) || [];

    if (!seenPath.has(e.path)) {
      st.first_read += 1;
    } else {
      st.path_repeat += 1;
      if (e.ranged) st.repeat_ranged += 1;

      // Find the resident block this read's bytes match, and its capture turn.
      let matchTurn = null, exact = false, contained = false;
      if (t.length > 0 && residentHashes.has(contentHash(t))) { exact = true; matchTurn = residentHashes.get(contentHash(t)); }
      else if (t.length > 0) {
        for (let i = prior.length - 1; i >= 0; i--) {
          if (prior[i].text.length >= t.length && prior[i].text.includes(t)) { contained = true; matchTurn = prior[i].turn; break; }
        }
      }
      // Staleness is measured against the MATCHED block, not the last read, and
      // uses `>` because a same-turn edit is parsed before the read it precedes.
      const ref = matchTurn ?? (prior.length ? prior[prior.length - 1].turn : -1);
      const edited = (editTurns.get(e.path) || []).some((x) => x > ref);
      if (edited) st.repeat_edited_since += 1;
      if (exact) st.repeat_content_exact += 1;
      if (contained) st.repeat_content_contained += 1;
      const hit = exact || contained;
      if (hit && !edited) {
        st.anchorable_strict_no_floor += 1;
        // The policy will not fire below its own floor, and the anchor text is
        // ~180-200 chars, so anchoring anything smaller COSTS tokens.
        if (t.length >= minChars) st.anchorable_strict += 1;
      }
      if (hit) st.anchorable_if_edits_included += 1;
    }
    if (t) residentHashes.set(contentHash(t), e.turn);
    if (!residentByPath.has(e.path)) residentByPath.set(e.path, []);
    residentByPath.get(e.path).push({ turn: e.turn, text: t });
    seenPath.add(e.path);
  }
  return st;
}

/**
 * The CEILING an omniscient dedup policy could reach, over EVERY content source —
 * not just read results. This is the number that decides whether the whole idea can
 * be "dramatic": no policy, however clever, can suppress more than this.
 */
function dedupCeiling(events, minChars = 200) {
  const tot = {}, dup = {};
  const seen = new Set();
  const texts = [];
  const add = (src, raw) => {
    const t = normalizeContent(raw);
    tot[src] = (tot[src] || 0) + t.length;
    if (t.length < minChars) return;
    const h = contentHash(t);
    if (seen.has(h)) { dup[src] = (dup[src] || 0) + t.length; return; }
    for (let i = texts.length - 1, n = 0; i >= 0 && n < 400; i--, n++) {
      if (texts[i].length >= t.length && texts[i].includes(t)) { dup[src] = (dup[src] || 0) + t.length; return; }
    }
    seen.add(h); texts.push(t);
  };
  for (const e of events) {
    if (e.t === 'read') add('read_results', e.text);
    else if (e.t === 'write') add('tool_call_args', e.text);
    else if (e.t === 'edit') { add('tool_call_args', e.new); add('tool_call_args', e.old); }
    else if (e.t === 'assistant') add('assistant_text', e.text);
    else add('other_tool_results', e.text);
  }
  const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  const by_source = Object.fromEntries(Object.keys(tot).map((k) => [k, {
    total_tokens: Math.ceil(tot[k] / 4), dup_tokens: Math.ceil((dup[k] || 0) / 4),
    dup_pct: +(100 * (dup[k] || 0) / Math.max(tot[k], 1)).toFixed(1),
  }]));
  return { by_source, total_tokens: Math.ceil(sum(tot) / 4), dup_tokens: Math.ceil(sum(dup) / 4),
           dup_pct: +(100 * sum(dup) / Math.max(sum(tot), 1)).toFixed(1) };
}

/**
 * SENSITIVITY on the ceiling. The single number `dedupCeiling` returns is the yield
 * of ONE matcher (block-granular, exact+containment, >=200 chars, text blocks only).
 * It is NOT a bound on what any dedup design could reach, and the spread below is the
 * evidence for that. A line-granular encoder in particular clears the F1 threshold.
 */
function ceilingSensitivity(rawEvents) {
  const lineGranular = (minLine = 20) => {
    const seen = new Set();
    let tot = 0, dup = 0;
    const feed = (raw) => {
      for (const ln of normalizeContent(raw).split('\n')) {
        const L = ln.length;
        if (!L) continue;
        tot += L;
        if (L < minLine) continue;
        const h = contentHash(ln.trim());
        if (seen.has(h)) dup += L; else seen.add(h);
      }
    };
    for (const e of rawEvents) {
      if (e.t === 'read' || e.t === 'assistant' || e.t === 'other') feed(e.text);
      else if (e.t === 'write') feed(e.text);
      else if (e.t === 'edit') { feed(e.new); feed(e.old); }
    }
    return { total_tokens: Math.ceil(tot / 4), dup_tokens: Math.ceil(dup / 4), dup_pct: +(100 * dup / Math.max(tot, 1)).toFixed(1) };
  };
  return {
    block_min200: dedupCeiling(rawEvents, 200),
    block_min0: dedupCeiling(rawEvents, 0),
    line_min20: lineGranular(20),
  };
}

/** What the sessions ACTUALLY sent, from `message.usage` in the fixtures. The simulated
 *  denominator is a reconstruction and is far smaller; reporting a percentage against the
 *  reconstruction alone overstates the saving. */
function loggedUsage(file) {
  let prompt = 0, cacheCreate = 0, cacheRead = 0, input = 0, n = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const u = (o.message || {}).usage;
    if (!u || typeof u !== 'object') continue;
    n += 1;
    input += u.input_tokens || 0;
    cacheCreate += u.cache_creation_input_tokens || 0;
    cacheRead += u.cache_read_input_tokens || 0;
  }
  prompt = input + cacheCreate + cacheRead;
  return { submissions: n, prompt_tokens: prompt, input_tokens: input, cache_creation: cacheCreate, cache_read: cacheRead,
           eff_cost_5min: Math.round(cacheRead * 0.1 + cacheCreate * 1.25 + input * 1.0) };
}

const blk = (id, zone, text) => ({ id, zone, text });

/**
 * One arm. Append-only in every arm: blocks are pushed, never rewritten, so the
 * cached prefix is identical in shape across arms and only its SIZE differs.
 */
function runArm(events, arm) {
  const sim = new ProviderCacheSimulator({ tokenizer, profile: ANTHROPIC_PROFILE });
  const idx = makeAnchorIndex({ arm: arm === 'append-all' ? 'baseline' : arm === 'anchor-strict' ? 'anchor' : 'anchor-diff', verify: 'full', requireUnedited: arm !== 'anchor-diff' });
  const messages = [{ role: 'system', content: SYS }];
  const log = [blk('task', 'head', 'TASK')];
  let n = 0, savedChars = 0, servedChars = 0;

  for (const e of events) {
    idx.hook(messages, e.turn);
    if (e.t === 'assistant') {
      const blocks = [blk('sys', 'head', SYS), ...log];
      sim.submit({ system: SYS, blocks, budgets: {}, cacheBreakpoints: ['sys', blocks[blocks.length - 1].id] });
      log.push(blk(`a${n++}`, 'flex', e.text));
      messages.push({ role: 'assistant', content: e.text });
      continue;
    }
    if (e.t === 'write') {
      messages.push({ role: 'assistant', content: '', tool_calls: [{ id: `w${n}`, function: { name: 'write_file', arguments: JSON.stringify({ path: e.path, content: e.text }) } }] });
      idx.reducer({ name: 'write_file', args: { path: e.path, content: e.text }, out: `wrote ${e.path}` });
      log.push(blk(`w${n++}`, 'flex', e.text));
      continue;
    }
    if (e.t === 'edit') {
      messages.push({ role: 'assistant', content: '', tool_calls: [{ id: `e${n}`, function: { name: 'edit_file', arguments: JSON.stringify({ path: e.path, old_str: e.old, new_str: e.new }) } }] });
      idx.reducer({ name: 'edit_file', args: { path: e.path, old_str: e.old, new_str: e.new }, out: `edited ${e.path}` });
      log.push(blk(`e${n++}`, 'flex', String(e.new ?? '')));
      continue;
    }
    if (e.t === 'read') {
      messages.push({ role: 'assistant', content: '', tool_calls: [{ id: `r${n}`, function: { name: 'read_file', arguments: JSON.stringify({ path: e.path }) } }] });
      const out = idx.reducer({ name: 'read_file', args: { path: e.path }, out: e.text });
      messages.push({ role: 'tool', tool_call_id: `r${n}`, content: out });
      if (out !== e.text) savedChars += e.text.length - out.length; else servedChars += e.text.length;
      log.push(blk(`r${n++}`, 'flex', out));
      continue;
    }
    // Non-Read tool results (Bash/Grep/... - 27% of appended content) must also
    // pass the index, or `bashReadTargets` and every cross-tool duplicate is dead code.
    messages.push({ role: 'assistant', content: '', tool_calls: [{ id: `o${n}`, function: { name: 'other_tool', arguments: '{}' } }] });
    const oOut = idx.reducer({ name: 'other_tool', args: {}, out: e.text });
    if (oOut !== e.text) savedChars += e.text.length - oOut.length; else servedChars += e.text.length;
    log.push(blk(`o${n++}`, 'flex', oOut));
    messages.push({ role: 'tool', tool_call_id: `o${n}`, content: oOut });
  }
  const rep = cacheReport(sim.outcomes());
  return { arm, report: rep, stats: idx.stats(), events: idx.events, saved_chars: savedChars, served_chars: servedChars };
}

const effCost = (rep, tier) => rep.cacheRead * tier.read + rep.cacheWrite * tier.write + rep.fresh * tier.fresh;

const files = readdirSync(FX).filter((f) => /^claude-code-session.*\.jsonl$/.test(f) && !EXCLUDE.has(f)).sort();
const ARMS = ['append-all', 'anchor-strict', 'anchor-diff'];
const cells = [];
const pooled = {};

const ceilings = [];
const corpora = [];
const sens = [];
const logged = [];
for (const f of files) {
  const events = extractEvents(join(FX, f));
  ceilings.push({ session: basename(f), ...dedupCeiling(events) });
  corpora.push({ session: basename(f), ...corpusStats(events) });
  sens.push({ session: basename(f), ...ceilingSensitivity(events) });
  logged.push({ session: basename(f), ...loggedUsage(join(FX, f)) });
  for (const arm of ARMS) {
    const r = runArm(events, arm);
    const row = {
      session: basename(f), arm,
      cache_read: r.report.cacheRead, cache_write: r.report.cacheWrite, fresh: r.report.fresh,
      total_tokens: r.report.total,
      eff_cost_5min: Math.round(effCost(r.report, TIERS['5min'])),
      eff_cost_1hour: Math.round(effCost(r.report, TIERS['1hour'])),
      fires: r.stats.fires, would_fire: r.stats.would_fire, by_kind: r.stats.by_kind,
      residency_false_count: r.stats.residency_false_count,
      saved_tokens: Math.ceil(r.saved_chars / 4),
    };
    cells.push(row);
    const k = arm;
    pooled[k] ??= { arm, sessions: 0, total_tokens: 0, eff_cost_5min: 0, eff_cost_1hour: 0, fires: 0, would_fire: 0, saved_tokens: 0, residency_false_count: 0, by_kind: {} };
    const p = pooled[k];
    p.sessions++; p.total_tokens += row.total_tokens; p.eff_cost_5min += row.eff_cost_5min;
    p.eff_cost_1hour += row.eff_cost_1hour; p.fires += row.fires; p.would_fire += row.would_fire;
    p.saved_tokens += row.saved_tokens; p.residency_false_count += row.residency_false_count;
    for (const [k2, v] of Object.entries(row.by_kind)) p.by_kind[k2] = (p.by_kind[k2] || 0) + v;
  }
}

const base = pooled['append-all'];
const summary = ARMS.map((a) => {
  const p = pooled[a];
  return {
    ...p,
    pct_tokens_vs_baseline: +(100 * (1 - p.total_tokens / base.total_tokens)).toFixed(2),
    pct_effcost_5min_vs_baseline: +(100 * (1 - p.eff_cost_5min / base.eff_cost_5min)).toFixed(2),
    pct_effcost_1hour_vs_baseline: +(100 * (1 - p.eff_cost_1hour / base.eff_cost_1hour)).toFixed(2),
  };
});

const pooledCeiling = (() => {
  const by = {};
  for (const c of ceilings) for (const [k, v] of Object.entries(c.by_source)) {
    by[k] ??= { total_tokens: 0, dup_tokens: 0 };
    by[k].total_tokens += v.total_tokens; by[k].dup_tokens += v.dup_tokens;
  }
  for (const v of Object.values(by)) v.dup_pct = +(100 * v.dup_tokens / Math.max(v.total_tokens, 1)).toFixed(1);
  const T = Object.values(by).reduce((a, v) => a + v.total_tokens, 0);
  const D = Object.values(by).reduce((a, v) => a + v.dup_tokens, 0);
  return { by_source: by, total_tokens: T, dup_tokens: D, dup_pct: +(100 * D / Math.max(T, 1)).toFixed(1) };
})();

const pooledCorpus = corpora.reduce((a, c) => {
  for (const [k, v] of Object.entries(c)) if (typeof v === 'number') a[k] = (a[k] || 0) + v;
  return a;
}, {});

const sum = (rows, k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
const pooledLogged = {
  submissions: sum(logged, 'submissions'), prompt_tokens: sum(logged, 'prompt_tokens'),
  input_tokens: sum(logged, 'input_tokens'), cache_creation: sum(logged, 'cache_creation'),
  cache_read: sum(logged, 'cache_read'), eff_cost_5min: sum(logged, 'eff_cost_5min'),
};
const pooledSens = ['block_min200', 'block_min0', 'line_min20'].reduce((a, k) => {
  const T = sens.reduce((x, r) => x + r[k].total_tokens, 0);
  const D = sens.reduce((x, r) => x + r[k].dup_tokens, 0);
  a[k] = { total_tokens: T, dup_tokens: D, dup_pct: +(100 * D / Math.max(T, 1)).toFixed(1) };
  return a;
}, {});
const strict = summary.find((x) => x.arm === 'anchor-strict');
const realism = {
  simulated_eff_cost_5min: base.eff_cost_5min,
  logged_eff_cost_5min: pooledLogged.eff_cost_5min,
  simulated_over_logged_ratio: +(base.eff_cost_5min / Math.max(pooledLogged.eff_cost_5min, 1)).toFixed(3),
  saving_pct_vs_simulated: strict.pct_effcost_5min_vs_baseline,
  saving_pct_vs_logged: +(100 * (base.eff_cost_5min - pooled['anchor-strict'].eff_cost_5min) / Math.max(pooledLogged.eff_cost_5min, 1)).toFixed(3),
  note: 'The simulated prefix omits the system prompt, tool schemas, user turns, thinking blocks and image payloads, and submits only on assistant text blocks. saving_pct_vs_logged rescales the SAME absolute saving onto what the sessions actually sent.',
};

const out = {
  manifest: {
    run_id: `dv4-anchor-dedup-${Date.now()}`,
    experiment: 'context-dedup / DV4 anchor-dedup opportunity (offline, cache-priced)',
    model: null, commit: gitSha(), date: nowISO(),
    params: { arms: ARMS, tiers: TIERS, tokenizer: tokenizer.id, profile: ANTHROPIC_PROFILE.id, fixtures: files, excluded: [...EXCLUDE] },
    hypothesis: 'Replacing already-resident tool-result bytes with a short referential anchor is append-only, so unlike eviction it never pays a prefix rewrite; the saving therefore survives cache-adjusted pricing.',
    falsification: 'If pooled suppressible content is < 10% of total prompt tokens under cache-adjusted accounting, the "dramatic reduction" claim is dead and the live instruments are not run.',
    caveats: [
      'claude-code-session-4.jsonl EXCLUDED: its 307 message.ids are 307/307 contained in session-5. Four independent sessions.',
      'Turn clock is message.id, not JSONL lines (line-counting inflates 2.0-2.4x; tier1b-idle-rescored.mjs:40-45).',
      'Paths keyed on the tail after context-tree/ because fixtures were recorded on two machines.',
      'chars/4 tokenizer, not a real tokenizer. Ranks large differences; do not read small marginals.',
      'SIMULATED cache accounting via ProviderCacheSimulator, not live provider counters. Same provenance class as C2/C3.',
      'Offline upper bound on OPPORTUNITY only. It says nothing about whether a model ACCEPTS an anchor -- that is the live instrument.',
      'anchor-diff assumes the model can reconstruct current state from a resident read plus resident edit hunks. That assumption is UNTESTED here.',
    ],
  },
  summary, cells,
  dedup_ceiling: { pooled: pooledCeiling, per_session: ceilings },
  corpus_stats: { pooled: pooledCorpus, per_session: corpora },
  ceiling_sensitivity: { pooled: pooledSens, per_session: sens },
  logged_usage: { pooled: pooledLogged, per_session: logged },
  realism_check: realism,
};

const path = writeResults('context-dedup', 'results-dv4-anchor-dedup.json', out);
console.error(`\n=== DV4 ANCHOR-DEDUP OPPORTUNITY (offline, ${files.length} independent sessions) ===`);
console.error('  arm             fires/would   savedTok   totalTok   eff5min   eff1hr   %tok   %eff5   %eff1h');
for (const s of summary) {
  console.error(`  ${s.arm.padEnd(14)} ${String(s.fires).padStart(5)}/${String(s.would_fire).padEnd(5)} ${String(s.saved_tokens).padStart(9)} ${String(s.total_tokens).padStart(10)} ${String(s.eff_cost_5min).padStart(9)} ${String(s.eff_cost_1hour).padStart(8)} ${String(s.pct_tokens_vs_baseline).padStart(6)} ${String(s.pct_effcost_5min_vs_baseline).padStart(7)} ${String(s.pct_effcost_1hour_vs_baseline).padStart(8)}`);
}
console.error('\n  by kind (pooled):');
for (const s of summary) console.error(`    ${s.arm.padEnd(14)} ${JSON.stringify(s.by_kind)}  residency_false=${s.residency_false_count}`);
const pc = pooledCorpus, pr = pc.path_repeat || 1;
console.error('\n  READ CORPUS — path statistic vs content statistic:');
console.error(`    Read calls                ${String(pc.reads).padStart(5)}`);
console.error(`    first-read                ${String(pc.first_read).padStart(5)}`);
console.error(`    path-repeat               ${String(pc.path_repeat).padStart(5)}   (${(100 * pc.path_repeat / pc.reads).toFixed(1)}% of reads)`);
console.error(`      ranged (diff slice)     ${String(pc.repeat_ranged).padStart(5)}   (${(100 * pc.repeat_ranged / pr).toFixed(1)}% of repeats)`);
console.error(`      edited since last read  ${String(pc.repeat_edited_since).padStart(5)}   (${(100 * pc.repeat_edited_since / pr).toFixed(1)}%)`);
console.error(`      content exact-dup       ${String(pc.repeat_content_exact).padStart(5)}   (${(100 * pc.repeat_content_exact / pr).toFixed(1)}%)`);
console.error(`      content contained       ${String(pc.repeat_content_contained).padStart(5)}   (${(100 * pc.repeat_content_contained / pr).toFixed(1)}%)`);
console.error(`      anchorable, no size floor ${String(pc.anchorable_strict_no_floor).padStart(3)}   (${(100 * pc.anchorable_strict_no_floor / pr).toFixed(1)}%)`);
console.error(`      ANCHORABLE (strict, >=200ch)${String(pc.anchorable_strict).padStart(3)}   (${(100 * pc.anchorable_strict / pr).toFixed(1)}% of repeats, ${(100 * pc.anchorable_strict / pc.reads).toFixed(1)}% of reads)`);

console.error('\n  DEDUP CEILING (omniscient policy, ALL content sources):');
console.error(`    ${'source'.padEnd(20)}${'total tok'.padStart(12)}${'dup tok'.padStart(11)}${'dup %'.padStart(8)}`);
for (const [k, v] of Object.entries(pooledCeiling.by_source).sort((a, b) => b[1].total_tokens - a[1].total_tokens)) {
  console.error(`    ${k.padEnd(20)}${String(v.total_tokens).padStart(12)}${String(v.dup_tokens).padStart(11)}${String(v.dup_pct).padStart(7)}%`);
}
console.error(`    ${'TOTAL'.padEnd(20)}${String(pooledCeiling.total_tokens).padStart(12)}${String(pooledCeiling.dup_tokens).padStart(11)}${String(pooledCeiling.dup_pct).padStart(7)}%`);
console.error('\n  CEILING SENSITIVITY (the 5.1% is ONE matcher, not a bound):');
for (const [k, v] of Object.entries(pooledSens)) console.error(`    ${k.padEnd(14)} ${String(v.dup_pct).padStart(5)}%  (${v.dup_tokens} of ${v.total_tokens} tok)`);
console.error('\n  REALISM CHECK vs the sessions\' own logged counters:');
console.error(`    simulated eff cost  ${String(realism.simulated_eff_cost_5min).padStart(12)}`);
console.error(`    LOGGED    eff cost  ${String(realism.logged_eff_cost_5min).padStart(12)}   (simulated is ${realism.simulated_over_logged_ratio}x the logged)`);
console.error(`    saving vs simulated ${String(realism.saving_pct_vs_simulated).padStart(11)}%`);
console.error(`    saving vs LOGGED    ${String(realism.saving_pct_vs_logged).padStart(11)}%`);
console.error(`\n  written: ${path}`);
