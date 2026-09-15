/**
 * ANCHOR REPLAY PROBE — tests F2 and F3 (the BEHAVIOURAL claims).
 *
 *   F2  the model ACCEPTS the anchor rather than just re-requesting the content.
 *       Falsified if arm `anchor` proceeds-without-re-requesting < 70%.
 *   F3  ANCHORING, not withholding, is the mechanism.
 *       Falsified if `anchor` does not beat the length-matched non-referential
 *       `placebo` by >= 15pp on acceptance or on needle correctness.
 *
 * DV4 already rejected F1 (the savings claim). F2/F3 are independent of it: a
 * policy can be not-worth-deploying and still tell us something true about
 * attention. F3 is the one that tests the actual hypothesis -- that a REFERENCE
 * to earlier tokens raises their salience -- rather than the trivial alternative
 * that any withholding makes a model look back at what it already has.
 *
 * DESIGN -- seeded counterfactual replay.
 * Only 8 natural anchorable re-reads exist in the whole corpus (DV4 §3), which
 * cannot support a percentage. So the TRIGGER is synthesised while the CONTEXT
 * stays real: take a real transcript prefix in which file F was genuinely read,
 * append a synthetic `read_file(F)` tool call, substitute the arm's output for
 * the result, and let the model take one turn. The prefix, the resident copy and
 * the file are all real; only the re-read is manufactured. That trade buys
 * unbounded n and perfect pairing, and is stated in the manifest, not hidden.
 *
 * Two probes per event:
 *   action  no user turn. Does the model re-request F? -> F2.
 *   needle  a question whose answer is a literal appearing EXACTLY ONCE in the
 *           whole prefix, inside F. Regex-graded. -> F3 + the safety measure
 *           (answered_wrong is confabulation-from-anchor and is disqualifying).
 *
 * PAIRED: all three arms see the identical prefix and the identical needle, so
 * event difficulty cancels. Analysis is McNemar on discordant pairs.
 *
 * D20 GUARD: the repo deleted its previous eval harness because its message type
 * had no tool_calls field and no 'tool' role, so it replayed tool results as user
 * text and invalidated every comparison. assertToolCallIntegrity() THROWS rather
 * than warns; a violation kills the run instead of producing a clean-looking lie.
 *
 * Rerun:
 *   set -a; . ./.env; set +a
 *   CT_REPLAY_MAX_EVENTS=40 node experiments/context-dedup/anchor-replay.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeResults, gitSha, nowISO } from '../rung-1-live-probe/lib.mjs';
import { normalizeContent, normPath, anchorText, placeboText, estTok } from './anchor-index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FX = join(HERE, '..', '..', 'packages', 'cli', 'test', 'fixtures');
const BASE_URL = process.env.CT_LOCAL_BASE_URL || 'http://127.0.0.1:8888/v1';
const MODEL = process.env.CT_LOCAL_MODEL || 'unsloth/Qwen3.8-27B-GGUF';
const API_KEY = process.env.UNSLOTH_API_KEY || '';
const EXCLUDE = new Set(['claude-code-session-4.jsonl']);
const MAX_EVENTS = +(process.env.CT_REPLAY_MAX_EVENTS || 40);
const PER_PATH = +(process.env.CT_REPLAY_PER_PATH || 3);
const MAX_PREFIX_TOK = +(process.env.CT_REPLAY_MAX_PREFIX || 60000);
const MIN_PREFIX_TOK = +(process.env.CT_REPLAY_MIN_PREFIX || 800);
const ARMS = (process.env.CT_REPLAY_ARMS || 'baseline,anchor,placebo').split(',');
const TAG = process.env.CT_TAG || 'v1';

const TOOLS = [
  { type: 'function', function: { name: 'read_file', description: 'Read a file.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'run_bash', description: 'Run a shell command.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Write a file.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
];

/** Claude JSONL -> OpenAI messages, preserving tool_calls / role:'tool' exactly (D20). */
function toOpenAI(file) {
  const messages = [];
  const reads = [];
  const meta = new Map();
  let lastId = null, turn = -1;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const m = o.message || {};
    const c = m.content;
    if (m.id && m.id !== lastId) { turn += 1; lastId = m.id; }
    if (typeof c === 'string') { if (c.trim()) messages.push({ role: 'user', content: c.slice(0, 4000) }); continue; }
    if (!Array.isArray(c)) continue;
    if (o.type === 'assistant') {
      const texts = [], calls = [];
      for (const b of c) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text' && b.text) texts.push(b.text);
        else if (b.type === 'tool_use') {
          meta.set(b.id, { name: b.name, path: normPath((b.input || {}).file_path) });
          calls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } });
        }
      }
      if (texts.length || calls.length) {
        messages.push({ role: 'assistant', content: texts.join('\n').slice(0, 6000), ...(calls.length ? { tool_calls: calls } : {}) });
      }
    } else if (o.type === 'user') {
      for (const b of c) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'tool_result') {
          const mm = meta.get(b.tool_use_id);
          if (!mm) continue;
          const text = resultText(o, b);
          messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: String(text).slice(0, 8000) });
          if (mm.name === 'Read' && mm.path && text) {
            reads.push({ turn, path: mm.path, text: String(text), msgIndex: messages.length - 1 });
          }
        } else if (b.type === 'text' && b.text) {
          messages.push({ role: 'user', content: b.text.slice(0, 4000) });
        }
      }
    }
  }
  return { messages, reads };
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
 * A Claude assistant message can emit several tool_calls whose results arrive as
 * separate later messages. Slicing at one result orphans its siblings, which the
 * D20 tripwire (correctly) rejects. Extend forward until every declared call is
 * answered, so the prefix is always a structurally valid conversation.
 */
function closePrefix(messages, endIdx) {
  const declared = new Set(), answered = new Set();
  for (let i = 0; i <= endIdx; i++) {
    const m = messages[i];
    if (m.role === 'assistant' && m.tool_calls) for (const tc of m.tool_calls) declared.add(tc.id);
    if (m.role === 'tool' && m.tool_call_id) answered.add(m.tool_call_id);
  }
  let i = endIdx;
  while ([...declared].some((d) => !answered.has(d)) && i + 1 < messages.length) {
    i += 1;
    const m = messages[i];
    if (m.role === 'assistant' && m.tool_calls) for (const tc of m.tool_calls) declared.add(tc.id);
    if (m.role === 'tool' && m.tool_call_id) answered.add(m.tool_call_id);
  }
  return [...declared].some((d) => !answered.has(d)) ? null : messages.slice(0, i + 1);
}

/** D20 tripwire. Throws — a violation must kill the run, not warn. */
function assertToolCallIntegrity(messages) {
  const declared = new Set();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'assistant' && m.tool_calls) for (const tc of m.tool_calls) declared.add(tc.id);
    if (m.role === 'tool') {
      if (!m.tool_call_id) throw new Error(`I2 violation: role:'tool' at ${i} has no tool_call_id`);
      if (!declared.has(m.tool_call_id)) throw new Error(`I2 violation: tool result at ${i} for undeclared id ${m.tool_call_id}`);
    }
    if (m.role === 'user' && /"tool_use_id"|"type":\s*"tool_result"/.test(String(m.content || ''))) {
      throw new Error(`I3 violation: a tool_result was emitted as role:'user' at ${i}`);
    }
  }
  const answered = new Set(messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) if (!answered.has(tc.id)) throw new Error(`I1 violation: tool_call ${tc.id} at ${i} has no result`);
    }
  }
  return true;
}

/**
 * A needle is a line of F carrying a token that occurs EXACTLY ONCE in the whole
 * prefix, so the answer cannot be guessed or found anywhere but in F's resident copy.
 */
function pickNeedle(fileText, prefixText) {
  const lines = normalizeContent(fileText).split('\n').map((l) => l.trim()).filter((l) => l.length >= 45 && l.length <= 300);
  for (const line of lines) {
    const toks = (line.match(/[A-Za-z_][A-Za-z0-9_.-]{7,}|\d{4,}/g) || []).filter((t) => t.length >= 8);
    for (const t of toks) {
      if ((prefixText.split(t).length - 1) !== 1) continue;   // answer must be unguessable and locatable only in F
      const at = line.indexOf(t);
      // The cue must be a CONTIGUOUS substring of the real line (taking the part
      // before or after the token), or the question asks about text that does not
      // exist and is unanswerable in every arm.
      const before = line.slice(0, at).trim();
      const after = line.slice(at + t.length).trim();
      const cue = (before.length >= 20 ? before : after.length >= 20 ? after : '').slice(0, 45).trim();
      if (cue.length < 20) continue;
      if ((prefixText.split(cue).length - 1) !== 1) continue;  // cue must also be unambiguous
      return { line, token: t, cue };
    }
  }
  return null;
}

async function callModel(messages, { tools = TOOLS, maxTokens = 320 } = {}) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: MODEL, messages, tools, tool_choice: 'auto', parallel_tool_calls: false,
      max_tokens: maxTokens, temperature: 0, chat_template_kwargs: { enable_thinking: false } }),
    signal: AbortSignal.timeout(300000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const esc = (p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A FULL re-read of the file: the whole payload comes back into context. */
const REREAD_RE = (p) => new RegExp(`\\b(cat|head|tail|sed|less|more|read_file)\\b[^|;&]*${esc(p)}`, 'i');
/** A targeted SEARCH of the file. Distinct from a re-read: it pulls back matching
 *  lines, not the payload, so counting it as a rejection of the anchor overstates
 *  rejection. Reported as its own label rather than folded into either bucket. */
const SEARCH_RE = (p) => new RegExp(`\\b(grep|rg|ag|awk|find)\\b[^|;&]*${esc(p)}`, 'i');

/** Acceptance label. Rules applied in this fixed order (pre-registered). */
function classifyAction(msg, path, err) {
  if (err) return { label: 'errored', via: 'exception' };
  const calls = msg.tool_calls || [];
  const text = String(msg.content || '');
  let searched = null;
  for (const tc of calls) {
    let a = {}; try { a = JSON.parse(tc.function.arguments || '{}'); } catch { return { label: 'errored', via: 'bad-json-args' }; }
    const tgt = normPath(a.path || a.file_path || '');
    if (tgt && tgt === path) return { label: 're-requested', via: `${tc.function.name}:path` };
    const cmd = String(a.command || '');
    if (cmd && REREAD_RE(path).test(cmd)) return { label: 're-requested', via: 'bash:reread' };
    if (cmd && SEARCH_RE(path).test(cmd)) searched = 'bash:search';
  }
  if (searched) return { label: 'searched', via: searched };
  if (calls.length) return { label: 'proceeded', via: 'other-tool-call' };
  if (!text.trim()) return { label: 'errored', via: 'empty' };
  if (/\b(I'?ll need to|let me re-?read|need to (re-?)?read|I should (re-?)?read|I don'?t have|not shown|cannot see|isn'?t (shown|available))\b/i.test(text)) {
    return { label: 'stalled', via: 'stall-lexicon' };
  }
  return { label: 'proceeded', via: 'text' };
}

async function main() {
  if (!API_KEY) throw new Error('UNSLOTH_API_KEY not set — run: set -a; . ./.env; set +a');
  const files = readdirSync(FX).filter((f) => /^claude-code-session.*\.jsonl$/.test(f) && !EXCLUDE.has(f)).sort();

  // ---- build the seeded event set ----
  const events = [];
  const lost = { total_reads: 0, unclosable: 0, too_small: 0, too_big: 0, no_needle: 0, per_path_cap: 0, kept: 0 };
  for (const f of files) {
    const { messages, reads } = toOpenAI(join(FX, f));
    const perPath = new Map();
    for (const r of reads) {
      lost.total_reads += 1;
      if (events.length >= MAX_EVENTS * 4) break;
      // Cap per path so one heavily-re-read file cannot dominate (DV4 found 4 of 8
      // natural anchorables were the same file).
      if ((perPath.get(r.path) || 0) >= PER_PATH) { lost.per_path_cap += 1; continue; }
      const prefix = closePrefix(messages, r.msgIndex);
      if (!prefix) { lost.unclosable += 1; continue; }
      const tok = estTok(prefix.map((m) => (m.content || '') + JSON.stringify(m.tool_calls || '')).join(''));
      if (tok < MIN_PREFIX_TOK) { lost.too_small += 1; continue; }
      if (tok > MAX_PREFIX_TOK) { lost.too_big += 1; continue; }
      const prefixText = prefix.map((m) => String(m.content || '')).join('\n');
      const needle = pickNeedle(r.text, prefixText);
      if (!needle) { lost.no_needle += 1; continue; }
      perPath.set(r.path, (perPath.get(r.path) || 0) + 1);
      lost.kept += 1;
      events.push({ fixture: f, path: r.path, turn: r.turn, prefix, prefix_tokens: tok,
        real_text: r.text, needle, rec: { path: r.path, firstTurn: r.turn, captureText: r.text } });
    }
  }
  const chosen = events.slice(0, MAX_EVENTS);
  console.error(`seeded events: ${chosen.length} (from ${files.length} fixtures, ${MIN_PREFIX_TOK}-${MAX_PREFIX_TOK} tok prefixes)`);
  if (!chosen.length) throw new Error('no usable seeded events');
  if (process.env.CT_REPLAY_DRYRUN === '1') {
    const byFix = {};
    for (const e of chosen) byFix[e.fixture] = (byFix[e.fixture] || 0) + 1;
    console.error('  candidate funnel:', JSON.stringify(lost));
    console.error('  per fixture:', JSON.stringify(byFix));
    console.error('  prefix tokens: min', Math.min(...chosen.map((e) => e.prefix_tokens)), 'max', Math.max(...chosen.map((e) => e.prefix_tokens)),
      'median', chosen.map((e) => e.prefix_tokens).sort((a, b) => a - b)[Math.floor(chosen.length / 2)]);
    console.error('  distinct files:', new Set(chosen.map((e) => e.path)).size);
    for (const e of chosen.slice(0, 5)) console.error(`   ${e.fixture.slice(18)} t${e.turn} ${e.path}  tok=${e.prefix_tokens}  needle="${e.needle.token}" cue="${e.needle.cue.slice(0, 32)}"`);
    const totalCalls = chosen.length * ARMS.length * 2;
    console.error(`  -> ${totalCalls} model calls (${chosen.length} events x ${ARMS.length} arms x 2 probes)`);
    return;
  }

  const armText = (arm, ev) => {
    if (arm === 'baseline') return String(ev.real_text).slice(0, 8000);
    if (arm === 'anchor') return anchorText(ev.rec, 'duplicate-unchanged');
    if (arm === 'placebo') return placeboText(anchorText(ev.rec, 'duplicate-unchanged').length);
    throw new Error(`unknown arm ${arm}`);
  };

  const cells = [];
  let done = 0;
  for (const ev of chosen) {
    const seedId = `seed_${done}`;
    for (const arm of ARMS) {
      const base = [...ev.prefix,
        { role: 'assistant', content: '', tool_calls: [{ id: seedId, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: ev.path }) } }] },
        { role: 'tool', tool_call_id: seedId, content: armText(arm, ev) }];
      assertToolCallIntegrity(base);

      // --- ACTION probe (F2) ---
      let a = { label: 'errored', via: 'unrun' }, aRaw = '', aErr = null;
      let aCalls = [];
      try { const j = await callModel(base); const m = j.choices?.[0]?.message || {}; aRaw = String(m.content || '').slice(0, 600); aCalls = (m.tool_calls || []).map((t) => ({ name: t.function.name, args: String(t.function.arguments || '').slice(0, 300) })); a = classifyAction(m, ev.path, null); }
      catch (e) { aErr = String(e.message || e).slice(0, 160); a = classifyAction({}, ev.path, aErr); }

      // --- NEEDLE probe (F3 + safety) ---
      const q = `Without using any tools, quote the complete line from ${ev.path} that contains the text "${ev.needle.cue}". Reply with only that line.`;
      let nRaw = '', nErr = null, nCalls = 0;
      try {
        const j = await callModel([...base, { role: 'user', content: q }]);
        const m = j.choices?.[0]?.message || {};
        nRaw = String(m.content || '').slice(0, 600); nCalls = (m.tool_calls || []).length;
      } catch (e) { nErr = String(e.message || e).slice(0, 160); }
      const correct = !nErr && nRaw.includes(ev.needle.token);
      const declined = !nErr && !correct && (nCalls > 0 || /\b(I don'?t have|cannot|can'?t|not (shown|available|present))\b/i.test(nRaw));
      const needle_label = nErr ? 'errored' : correct ? 'correct' : declined ? 'declined' : 'wrong';

      cells.push({
        event_id: `${basename(ev.fixture, '.jsonl')}#t${ev.turn}#${ev.path}`,
        fixture: ev.fixture, path: ev.path, turn: ev.turn, prefix_tokens: ev.prefix_tokens,
        arm, substituted_chars: armText(arm, ev).length, real_chars: String(ev.real_text).length,
        action_label: a.label, action_via: a.via, action_text: aRaw, action_calls: aCalls, action_error: aErr,
        needle_token: ev.needle.token, needle_cue: ev.needle.cue,
        needle_label, needle_text: nRaw, needle_error: nErr,
      });
      process.stderr.write(a.label === 'proceeded' ? '.' : a.label === 're-requested' ? 'R' : a.label === 'stalled' ? 's' : 'E');
    }
    done += 1;
    process.stderr.write(` [${done}/${chosen.length}]\n`);
  }

  // ---- summary ----
  const byArm = ARMS.map((arm) => {
    const cs = cells.filter((c) => c.arm === arm);
    const n = cs.length || 1;
    const cnt = (k, v) => cs.filter((c) => c[k] === v).length;
    return { arm, n: cs.length,
      proceeded: cnt('action_label', 'proceeded'), re_requested: cnt('action_label', 're-requested'),
      searched: cnt('action_label', 'searched'),
      stalled: cnt('action_label', 'stalled'), errored: cnt('action_label', 'errored'),
      acceptance_pct: +(100 * cnt('action_label', 'proceeded') / n).toFixed(1),
      acceptance_incl_search_pct: +(100 * (cnt('action_label', 'proceeded') + cnt('action_label', 'searched')) / n).toFixed(1),
      needle_correct: cnt('needle_label', 'correct'), needle_wrong: cnt('needle_label', 'wrong'),
      needle_declined: cnt('needle_label', 'declined'), needle_errored: cnt('needle_label', 'errored'),
      needle_correct_pct: +(100 * cnt('needle_label', 'correct') / n).toFixed(1) };
  });

  // paired McNemar on discordant pairs, per contrast
  const idOf = (c) => c.event_id;
  const mcnemar = (armA, armB, key, good) => {
    const A = new Map(cells.filter((c) => c.arm === armA).map((c) => [idOf(c), c]));
    const B = new Map(cells.filter((c) => c.arm === armB).map((c) => [idOf(c), c]));
    let b = 0, c2 = 0, n = 0;
    for (const [id, x] of A) {
      const y = B.get(id); if (!y) continue;
      n += 1;
      const gx = x[key] === good, gy = y[key] === good;
      if (gx && !gy) b += 1; else if (!gx && gy) c2 += 1;
    }
    // exact two-sided binomial on the discordant pairs
    const m = b + c2;
    let p = 1;
    if (m > 0) {
      const logC = (nn, kk) => { let s = 0; for (let i = 0; i < kk; i++) s += Math.log(nn - i) - Math.log(i + 1); return s; };
      let tail = 0;
      const k0 = Math.min(b, c2);
      for (let i = 0; i <= k0; i++) tail += Math.exp(logC(m, i) - m * Math.log(2));
      p = Math.min(1, 2 * tail);
    }
    return { contrast: `${armA}_vs_${armB}`, metric: key, n_paired: n, b, c: c2, discordant: m,
      delta_pp: +(100 * (b - c2) / Math.max(n, 1)).toFixed(1), mcnemar_p: +p.toFixed(4) };
  };
  const paired = [];
  if (ARMS.includes('anchor') && ARMS.includes('baseline')) {
    paired.push(mcnemar('anchor', 'baseline', 'action_label', 'proceeded'));
    paired.push(mcnemar('anchor', 'baseline', 'needle_label', 'correct'));
  }
  if (ARMS.includes('anchor') && ARMS.includes('placebo')) {
    paired.push(mcnemar('anchor', 'placebo', 'action_label', 'proceeded'));
    paired.push(mcnemar('anchor', 'placebo', 'needle_label', 'correct'));
  }

  const A = byArm.find((x) => x.arm === 'anchor') || {};
  const P = byArm.find((x) => x.arm === 'placebo') || {};
  const B0 = byArm.find((x) => x.arm === 'baseline') || {};
  const verdict = {
    F2_acceptance_pct: A.acceptance_pct ?? null,
    F2_threshold: 70,
    F2: (A.acceptance_pct ?? 0) < 70 ? 'CONDITION MET -> F2 REJECTED' : 'not rejected',
    F3_anchor_minus_placebo_acceptance_pp: +(((A.acceptance_pct ?? 0) - (P.acceptance_pct ?? 0))).toFixed(1),
    F3_anchor_minus_placebo_needle_pp: +(((A.needle_correct_pct ?? 0) - (P.needle_correct_pct ?? 0))).toFixed(1),
    F3_threshold_pp: 15,
    F3: (Math.max((A.acceptance_pct ?? 0) - (P.acceptance_pct ?? 0), (A.needle_correct_pct ?? 0) - (P.needle_correct_pct ?? 0)) < 15)
      ? 'CONDITION MET -> F3 REJECTED (withholding, not anchoring)' : 'not rejected',
    saturation_check: (B0.acceptance_pct ?? 0) < 5 || (B0.acceptance_pct ?? 0) > 95
      ? 'SATURATED — baseline acceptance outside 5-95%, contrast uninformative' : 'ok',
  };

  const out = {
    manifest: {
      run_id: `anchor-replay-${TAG}-${Date.now()}`,
      experiment: 'context-dedup / anchor replay probe (F2 acceptance, F3 anchoring-vs-withholding)',
      model: MODEL, commit: gitSha(), date: nowISO(),
      params: { arms: ARMS, mode: 'seeded', events: chosen.length, per_path_cap: PER_PATH, funnel: lost, max_prefix_tokens: MAX_PREFIX_TOK,
        min_prefix_tokens: MIN_PREFIX_TOK, temperature: 0, thinking: false, fixtures: files, excluded: [...EXCLUDE] },
      hypothesis: 'When content is already resident, returning a referential ANCHOR instead of the bytes yields the same next action and the same content-dependent recall as returning the bytes, while a length-matched NON-referential withhold (placebo) does not.',
      falsification: 'F2: anchor acceptance < 70%. F3: anchor does not beat placebo by >= 15pp on acceptance or needle correctness.',
      caveats: [
        'SEEDED trigger: the re-read is synthetic. The prefix, the resident copy and the file are real; the model did not itself ask to re-read.',
        'OFF-POLICY: transcripts were produced by a frontier Claude model and are continued by Qwen3-27B. Between-arm contrasts are paired and interpretable; ABSOLUTE rates are not an estimate of the original model behaviour.',
        'This model shows no distal-recall deficit at these sizes (position-probe 90/90; 6/6 at 60k), so a high baseline may saturate the contrast. The saturation_check field reports this.',
        'Thinking blocks in the fixtures are redacted (empty), so the replayed prefix shows the prior model acting with no visible reasoning.',
        'One event per (fixture, file) to stop a single heavily-re-read file dominating, per the DV4 finding that 4 of 8 natural anchorables were the same file.',
        'A targeted `grep <path>` is labelled `searched`, NOT `re-requested`: it returns matching lines, not the payload, so counting it as a rejection would overstate rejection. `acceptance_incl_search_pct` reports the lenient reading.',
        'Needle is a line-quote task with a token occurring exactly once in the prefix. It measures verbatim recall, which is harder than the task-relevant use of content.',
        'Prefixes are capped and truncated at a turn boundary; truncation is NOT eviction of the target (residency of F is required by construction).',
      ],
    },
    summary: { by_arm: byArm, paired, verdict }, cells,
  };
  const path = writeResults('context-dedup', `results-anchor-replay-${TAG}.json`, out);

  console.error(`\n=== ANCHOR REPLAY (F2/F3) model=${MODEL} events=${chosen.length} ===`);
  console.error('  arm        n   proceed  re-req  srch  err   accept%   needle✓  wrong  decl   needle%');
  for (const s of byArm) console.error(`  ${s.arm.padEnd(10)} ${String(s.n).padStart(3)}  ${String(s.proceeded).padStart(7)} ${String(s.re_requested).padStart(7)} ${String(s.stalled).padStart(6)} ${String(s.errored).padStart(4)}  ${String(s.acceptance_pct).padStart(7)}  ${String(s.needle_correct).padStart(7)} ${String(s.needle_wrong).padStart(6)} ${String(s.needle_declined).padStart(5)}  ${String(s.needle_correct_pct).padStart(7)}`);
  console.error('\n  paired (McNemar, exact two-sided):');
  for (const p of paired) console.error(`    ${p.contrast.padEnd(22)} ${p.metric.padEnd(13)} n=${p.n_paired} b=${p.b} c=${p.c} Δ=${p.delta_pp}pp p=${p.mcnemar_p}`);
  console.error('\n  VERDICT:');
  for (const [k, v] of Object.entries(verdict)) console.error(`    ${k.padEnd(42)} ${v}`);
  console.error(`\n  written: ${path}`);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
