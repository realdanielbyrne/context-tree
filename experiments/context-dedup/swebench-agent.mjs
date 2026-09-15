/**
 * Agent loop for the SWE-bench pilot with a CONFIGURABLE tool-output clip.
 *
 * Why a second loop exists: `experiments/coding-harness/lib.mjs` clips every tool result
 * at 2,000 characters and is out of bounds for this work. That clip was calibrated for
 * `longbuild`, whose spec files were deliberately sized just under it. A real repository
 * is not: in the v1 gate, 26/50 tool results were clipped in two of three runs, and the
 * agent's degenerate loop was widening `grep -A N` past the clip, where every widening
 * returns the same visible prefix. Whether the zero-edit failure is the MODEL or this
 * CLIP is the difference between a solvability verdict and a void pilot, so the clip has
 * to be a variable.
 *
 * Tool semantics are identical to lib.mjs `execTool` (same schemas, whitelist, 30 s bash
 * timeout); with `clipChars: 2000` it reproduces lib.mjs output byte for byte (checked on
 * all 150 v1 tool calls).
 *
 * ENDPOINT. Runs are sent to OpenRouter (CT_LOCAL_BASE_URL / CT_LOCAL_MODEL, key via
 * UNSLOTH_API_KEY, as lib.mjs reads them) so the pilot does not contend with the shared
 * local GPU. That changes three things this loop must handle, which lib.mjs does not:
 *  - 429s, 5xx, `error` bodies and dropped connections are RETRIED with backoff at the SAME
 *    temperature; lib.mjs's sampler jitter was for a local server's deterministic
 *    malformed-JSON 500s, and would silently change the experiment here.
 *  - A run whose retries are exhausted throws; the pilot records it as an ERRORED cell,
 *    never as the model failing the task.
 *  - Every call records `provider`, `cost`, reasoning tokens and `finish_reason`, because
 *    OpenRouter routes between backends and exact cost must be computable.
 * The credential is read from the environment and never recorded.
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { TOOL_SCHEMAS, BASE_URL, MODEL, API_KEY } from '../coding-harness/lib.mjs';

const BASH_WHITELIST = ['python3', 'python', 'pytest', 'ls', 'cat', 'echo', 'pwd', 'mkdir', 'head', 'tail', 'grep', 'find'];
/**
 * CT_REASONING_OFF=1 adds OpenRouter's `reasoning: {enabled: false}`. Needed because the
 * provider ignores `chat_template_kwargs.enable_thinking=false` (measured: 17 reasoning
 * tokens on a one-call smoke test), while every local run in this repo had thinking off.
 */
export const REASONING_OFF = process.env.CT_REASONING_OFF === '1';
const CALL_TIMEOUT_MS = +(process.env.CT_CALL_TIMEOUT_MS || 600_000);
const MAX_ATTEMPTS = +(process.env.CT_MAX_ATTEMPTS || 8);

export const makeClip = (n) => (s) => (s && s.length > n ? s.slice(0, n) + `\n…[${s.length} chars truncated]` : (s || ''));

export function execToolClip(ws, name, args, clipChars) {
  const clip = makeClip(clipChars);
  try {
    if (name === 'read_file') { const p = join(ws, args.path); return existsSync(p) ? clip(readFileSync(p, 'utf8')) : `error: no such file ${args.path}`; }
    if (name === 'write_file') { const p = join(ws, args.path); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, args.content ?? ''); return `wrote ${args.path} (${(args.content ?? '').length} bytes)`; }
    if (name === 'edit_file') { const p = join(ws, args.path); if (!existsSync(p)) return `error: no such file ${args.path}`; const t = readFileSync(p, 'utf8'); if (!t.includes(args.old_str)) return `error: old_str not found in ${args.path}`; writeFileSync(p, t.replace(args.old_str, args.new_str)); return `edited ${args.path}`; }
    if (name === 'list_files') { return clip(execSync(`find . -type f -not -path '*/.*'`, { cwd: ws, maxBuffer: 64 * 1024 * 1024 }).toString()); }
    if (name === 'run_bash') {
      const cmd = String(args.command || ''); const head = cmd.trim().split(/\s+/)[0];
      if (!BASH_WHITELIST.includes(head)) return `error: command '${head}' not allowed. Allowed: ${BASH_WHITELIST.join(', ')}`;
      try { return clip(execSync(cmd, { cwd: ws, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).toString() || '(no output)'); }
      catch (e) { return clip(`exit ${e.status ?? '?'}\nstdout:\n${e.stdout?.toString() || ''}\nstderr:\n${e.stderr?.toString() || ''}`); }
    }
    return `error: unknown tool ${name}`;
  } catch (e) { return `error executing ${name}: ${e.message}`; }
}

class Retryable extends Error {}

/** Pure: is this failure transient (retry) or a real request error (fail the run)? */
export function isRetryable({ status = null, bodyError = null, networkError = false } = {}) {
  if (networkError) return true;
  if (status === 429 || (status !== null && status >= 500)) return true;
  if (status === 200 && bodyError) return true;       // OpenRouter upstream error in a 200 body
  return false;
}

/** Pure: capped exponential backoff with deterministic jitter from the attempt number. */
export const backoffMs = (attempt) => Math.min(60_000, 1000 * 2 ** attempt) + (attempt * 137) % 500;

async function callModel(messages, { think, maxTokens, tools }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), CALL_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model: MODEL, messages, tools, tool_choice: 'auto', parallel_tool_calls: false, max_tokens: maxTokens,
        temperature: 0, chat_template_kwargs: { enable_thinking: think },
        ...(REASONING_OFF && !think ? { reasoning: { enabled: false } } : {}),
      }),
    });
  } catch (e) {
    throw new Retryable(`network: ${String(e.message || e).slice(0, 120)}`);
  } finally { clearTimeout(timer); }
  const text = await res.text();
  let j = null; try { j = JSON.parse(text); } catch {}
  const bodyError = j?.error?.message ?? (res.ok && !j?.choices?.length ? 'no choices in response' : null);
  if (!res.ok || bodyError) {
    const msg = `HTTP ${res.status}: ${(bodyError || text).slice(0, 200)}`;
    if (isRetryable({ status: res.status, bodyError })) throw new Retryable(msg);
    throw new Error(msg);
  }
  return j;
}

async function callModelRetrying(messages, opts, stats) {
  let last = null;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    try { return await callModel(messages, opts); }
    catch (e) {
      if (!(e instanceof Retryable)) throw e;
      last = e; stats.retries += 1; stats.last_retry_error = e.message;
      process.stderr.write('!');
      await new Promise((r) => setTimeout(r, backoffMs(i)));
    }
  }
  throw new Error(`retries exhausted after ${MAX_ATTEMPTS} attempts: ${last?.message}`);
}

/** Same contract as lib.mjs runAgent; toolLog entries also carry `clipped`/`out_len`, usage carries provider/cost. */
export async function runAgentClip({ system, task, ws, maxTurns = 40, think = true, hook = null, allowedTools = null, maxTokens = 1024, clipChars = 2000, onProgress = null }) {
  const messages = [{ role: 'system', content: system }, { role: 'user', content: task }];
  const usage = []; const toolLog = []; let turns = 0, stop = 'maxTurns';
  const stats = { retries: 0, last_retry_error: null };
  const tools = allowedTools ? TOOL_SCHEMAS.filter((t) => allowedTools.includes(t.function.name)) : TOOL_SCHEMAS;
  const partial = () => ({ messages, usage, toolLog, turns: turns + 1, stop, retries: stats.retries, last_retry_error: stats.last_retry_error });
  try {
    for (turns = 0; turns < maxTurns; turns++) {
      if (hook) await hook(messages, turns);
      const j = await callModelRetrying(messages, { think, tools, maxTokens }, stats);
      const choice = j.choices[0]; const msg = choice.message || {};
      usage.push({
        turn: turns, prompt_tokens: j.usage?.prompt_tokens ?? null, completion_tokens: j.usage?.completion_tokens ?? null,
        reasoning_tokens: j.usage?.completion_tokens_details?.reasoning_tokens ?? null,
        cached_tokens: j.usage?.prompt_tokens_details?.cached_tokens ?? null,
        cost: j.usage?.cost ?? null, provider: j.provider ?? null, finish_reason: choice.finish_reason ?? null,
      });
      messages.push({ role: 'assistant', content: msg.content ?? '', ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}) });
      if (msg.tool_calls?.length) {
        for (const tc of msg.tool_calls) {
          let args = {}; try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
          const out = execToolClip(ws, tc.function.name, args, clipChars);
          toolLog.push({ turn: turns, name: tc.function.name, args, out: out.slice(0, 200), out_len: out.length, clipped: /chars truncated\]$/.test(out) });
          messages.push({ role: 'tool', tool_call_id: tc.id, content: String(out) });
        }
        process.stderr.write(msg.tool_calls.map((t) => t.function.name[0]).join(''));
      } else { stop = choice.finish_reason === 'length' ? 'length' : 'end_turn'; process.stderr.write('·'); break; }
      if (onProgress) onProgress(partial());
    }
  } catch (e) {
    // Keep what the run did before it errored: the pilot scores it as ERRORED, not FAIL,
    // but the partial trace and spend are still data.
    e.partial = partial();
    throw e;
  }
  process.stderr.write('\n');
  return partial();
}
