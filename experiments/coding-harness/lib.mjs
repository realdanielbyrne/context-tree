/**
 * Faithful OpenAI tool-calling agentic loop against the LOCAL model.
 *
 * The local server round-trips native `tool_calls` (verified), so we use the
 * OpenAI message format on both sides — assistant messages with `tool_calls` are
 * appended VERBATIM, tool results come back as {role:"tool", tool_call_id}. This
 * makes the S4 trap (a bespoke ChatMessage that can't represent a tool call)
 * structurally impossible: the server owns the representation, not us.
 *
 * Tools run in a temp working dir; run_bash is whitelisted for safety.
 */
import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

export const BASE_URL = process.env.CT_LOCAL_BASE_URL || 'http://127.0.0.1:8888/v1';
export const MODEL = process.env.CT_LOCAL_MODEL || 'unsloth/Qwen3.8-27B-GGUF';
export const API_KEY = process.env.UNSLOTH_API_KEY || 'sk-unsloth-YOUR_KEY';

export const TOOL_SCHEMAS = [
  { type: 'function', function: { name: 'read_file', description: 'Read a file in the workspace.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Create or overwrite a file in the workspace.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'edit_file', description: 'Replace the first occurrence of old_str with new_str in a file.', parameters: { type: 'object', properties: { path: { type: 'string' }, old_str: { type: 'string' }, new_str: { type: 'string' } }, required: ['path', 'old_str', 'new_str'] } } },
  { type: 'function', function: { name: 'list_files', description: 'List files in the workspace.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'run_bash', description: 'Run a shell command in the workspace. Allowed: python3, python, pytest, ls, cat, echo, pwd, mkdir, head, tail, grep, find.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
];

const BASH_WHITELIST = ['python3', 'python', 'pytest', 'ls', 'cat', 'echo', 'pwd', 'mkdir', 'head', 'tail', 'grep', 'find'];
const clip = (s, n = 2000) => (s && s.length > n ? s.slice(0, n) + `\n…[${s.length} chars truncated]` : (s || ''));

export function makeWorkspace() { return mkdtempSync(join(tmpdir(), 'ct-code-')); }

export function execTool(ws, name, args) {
  try {
    if (name === 'read_file') { const p = join(ws, args.path); return existsSync(p) ? clip(readFileSync(p, 'utf8')) : `error: no such file ${args.path}`; }
    if (name === 'write_file') { const p = join(ws, args.path); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, args.content ?? ''); return `wrote ${args.path} (${(args.content ?? '').length} bytes)`; }
    if (name === 'edit_file') { const p = join(ws, args.path); if (!existsSync(p)) return `error: no such file ${args.path}`; const t = readFileSync(p, 'utf8'); if (!t.includes(args.old_str)) return `error: old_str not found in ${args.path}`; writeFileSync(p, t.replace(args.old_str, args.new_str)); return `edited ${args.path}`; }
    if (name === 'list_files') { return clip(execSync(`find . -type f -not -path '*/.*'`, { cwd: ws }).toString()); }
    if (name === 'run_bash') {
      const cmd = String(args.command || ''); const head = cmd.trim().split(/\s+/)[0];
      if (!BASH_WHITELIST.includes(head)) return `error: command '${head}' not allowed. Allowed: ${BASH_WHITELIST.join(', ')}`;
      try { return clip(execSync(cmd, { cwd: ws, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }).toString() || '(no output)'); }
      catch (e) { return clip(`exit ${e.status ?? '?'}\nstdout:\n${e.stdout?.toString() || ''}\nstderr:\n${e.stderr?.toString() || ''}`); }
    }
    return `error: unknown tool ${name}`;
  } catch (e) { return `error executing ${name}: ${e.message}`; }
}

async function callModel(messages, { think = false, maxTokens = 1024 }) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: MODEL, messages, tools: TOOL_SCHEMAS, tool_choice: 'auto', parallel_tool_calls: false, max_tokens: maxTokens, temperature: 0, chat_template_kwargs: { enable_thinking: think } }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

// ===================== eviction (the assembler under test) =====================
export const estTokens = (msgs) => Math.ceil(msgs.reduce((s, m) => s + (m.content || '').length + JSON.stringify(m.tool_calls || '').length, 0) / 4);

/**
 * Split the message array into pinned head (system + first user task) + UNITS.
 * A unit is a coherent slice that keeps tool-call validity: an assistant message
 * with tool_calls travels WITH all its following tool results, so eviction can
 * never orphan a call from its result (the S4/format trap for eviction).
 */
export function extractUnits(messages) {
  const pinned = messages.slice(0, 2); // [system, first user task]
  const units = []; let i = 2;
  while (i < messages.length) {
    const start = i; const m = messages[i];
    if (m.role === 'assistant' && m.tool_calls?.length) { i++; while (i < messages.length && messages[i].role === 'tool') i++; }
    else i++;
    const slice = messages.slice(start, i);
    const files = new Set(); let blob = '';
    for (const mm of slice) { blob += ' ' + (mm.content || ''); for (const tc of mm.tool_calls || []) { blob += ' ' + (tc.function.arguments || ''); try { const a = JSON.parse(tc.function.arguments || '{}'); if (a.path) files.add(a.path); } catch {} } }
    // fingerprint = paths + DISTINCTIVE identifiers (snake_case fns, filenames, CamelCase) so a unit
    // that references another's symbols (e.g. a module importing parse_ts) co-references it.
    const fp = new Set(files);
    for (const m2 of blob.matchAll(/[A-Za-z_][A-Za-z0-9_.]{2,}/g)) { const t = m2[0]; if ((/_/.test(t) && t.length >= 5) || /\.[a-z]{1,4}$/.test(t) || /^[A-Z][a-z]+[A-Z]/.test(t)) fp.add(t); }
    units.push({ slice, files, fp, wrote: slice.some((mm) => (mm.tool_calls || []).some((tc) => /write_file|edit_file/.test(tc.function.name))) });
  }
  return { pinned, units };
}

function rebuild(messages, pinned, keptUnits) {
  const next = [...pinned, ...keptUnits.flatMap((u) => u.slice)];
  messages.length = 0; messages.push(...next); // in-place (the hook mutates the live array)
}

// Recency eviction: keep pinned + the most-recent units that fit the budget.
export function evictRecency(messages, budget, reserve = 512) {
  const { pinned, units } = extractUnits(messages);
  const avail = budget - estTokens(pinned) - reserve;
  if (avail <= 0 || estTokens(units.flatMap((u) => u.slice)) <= avail) return false;
  const kept = []; let used = 0;
  for (let k = units.length - 1; k >= 0; k--) { const t = estTokens(units[k].slice); if (used + t <= avail || kept.length < 4) { kept.unshift(units[k]); used += t; } else break; }
  if (kept.length === units.length) return false;
  rebuild(messages, pinned, kept); return true;
}

// Priority eviction (recorded defaults D-EV2..4): keep pinned + highest-priority units
// (priority-dominant + recency + reference-recency; relevance≈0), always keeping the last 2.
export function evictPriority(messages, budget, reserve = 512) {
  const { pinned, units } = extractUnits(messages);
  const avail = budget - estTokens(pinned) - reserve;
  if (avail <= 0 || estTokens(units.flatMap((u) => u.slice)) <= avail) return false;
  const N = units.length;
  const coref = units.map((u, i) => units.filter((v, j) => j !== i && [...u.fp].some((f) => v.fp.has(f))).length);
  const lastCo = units.map((u, i) => { for (let j = N - 1; j > i; j--) if ([...u.fp].some((f) => units[j].fp.has(f))) return j; return i; });
  const prio = units.map((u, i) => (u.wrote ? 2 : 0) + coref[i]);
  const norm = (a) => { const lo = Math.min(...a), hi = Math.max(...a); return a.map((v) => (hi > lo ? (v - lo) / (hi - lo) : 0)); };
  const pN = norm(prio), rN = norm(units.map((_, i) => i)), fN = norm(lastCo);
  const score = units.map((_, i) => 2 * pN[i] + 1 * rN[i] + 0.5 * fN[i]);
  const order = units.map((u, i) => i).sort((a, b) => score[b] - score[a]);
  const forceKeep = new Set([N - 1, N - 2, N - 3, N - 4]); // recency anchor (keep the working set)
  const keepIdx = new Set(forceKeep); let used = [...forceKeep].reduce((s, i) => s + estTokens(units[i].slice), 0);
  for (const i of order) { if (keepIdx.has(i)) continue; const t = estTokens(units[i].slice); if (used + t <= avail) { keepIdx.add(i); used += t; } }
  if (keepIdx.size === N) return false;
  rebuild(messages, pinned, [...keepIdx].sort((a, b) => a - b).map((i) => units[i])); return true;
}

/**
 * Run the agent to completion (or maxTurns). `hook(messages, turn)` may mutate the
 * message array in place before each model call (this is where eviction plugs in).
 * Returns transcript, per-call usage, and tool-call log.
 */
export async function runAgent({ system, task, ws, maxTurns = 40, think = false, hook = null }) {
  const messages = [{ role: 'system', content: system }, { role: 'user', content: task }];
  const usage = []; const toolLog = []; let turns = 0, stop = 'maxTurns';
  for (turns = 0; turns < maxTurns; turns++) {
    if (hook) hook(messages, turns);
    const j = await callModel(messages, { think });
    const choice = j.choices?.[0]; const msg = choice?.message || {};
    usage.push({ turn: turns, prompt_tokens: j.usage?.prompt_tokens ?? null, completion_tokens: j.usage?.completion_tokens ?? null });
    // append the assistant message VERBATIM (with tool_calls if present)
    messages.push({ role: 'assistant', content: msg.content ?? '', ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}) });
    if (msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        let args = {}; try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
        const out = execTool(ws, tc.function.name, args);
        toolLog.push({ turn: turns, name: tc.function.name, args, out: out.slice(0, 200) });
        messages.push({ role: 'tool', tool_call_id: tc.id, content: String(out) });
      }
      process.stderr.write(msg.tool_calls.map((t) => t.function.name[0]).join(''));
    } else { stop = 'end_turn'; process.stderr.write('·'); break; }
  }
  process.stderr.write('\n');
  return { messages, usage, toolLog, turns: turns + 1, stop };
}
