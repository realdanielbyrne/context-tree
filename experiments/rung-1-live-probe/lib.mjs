/**
 * Shared harness for the Rung 1 LIVE single-turn probe experiments.
 * One source of truth for: the local model client, deterministic grading,
 * fixture recovery, and manifest writing — so the naive-QA wire-up and the
 * taxing overflow probes can't drift on any of those.
 *
 * The model is a TRUE window-bounded host: Qwen3.8-27B-GGUF, hard 262,144-token
 * ceiling on this machine. We call it OpenAI-style over plain fetch (no SDK).
 * Qwen3 is a thinking model; we disable thinking so `content` is the answer and
 * the host's reported `prompt_tokens` is honest context accounting.
 */
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = join(HERE, '..', '..');

export const BASE_URL = process.env.CT_LOCAL_BASE_URL || 'http://127.0.0.1:8888/v1';
export const MODEL = process.env.CT_LOCAL_MODEL || 'unsloth/Qwen3.8-27B-GGUF';
export const API_KEY = process.env.UNSLOTH_API_KEY || 'sk-unsloth-YOUR_KEY';
export const WINDOW = 262144; // hard ceiling on this host — exceeding it errors

export const estTok = (s) => Math.ceil((s || '').length / 4); // pre-call estimate only; real cost = usage.prompt_tokens

export function gitSha() {
  try { return execSync('git rev-parse HEAD', { cwd: REPO }).toString().trim(); } catch { return null; }
}

/**
 * One chat call to the local host. Thinking disabled. Returns content + real usage.
 * Retries transient failures; throws after `retries` exhausted so a run fails loud.
 */
export async function generate({ system, user, maxTokens = 256, temperature = 0, think = false, retries = 2 }) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: user });
  const body = {
    model: MODEL,
    messages,
    max_tokens: maxTokens,
    temperature,
    chat_template_kwargs: { enable_thinking: think },
  };
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 300_000);
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const j = await res.json();
      const choice = j.choices?.[0];
      let content = choice?.message?.content || '';
      const reasoning = choice?.message?.reasoning_content || '';
      // With thinking on, some builds inline <think>..</think> in content; strip it.
      content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      // If the answer landed only in the reasoning stream, fall back to its tail for grading.
      const gradeText = content || reasoning.trim();
      return {
        content: content.trim(),
        grade_text: gradeText,
        reasoning_len: reasoning.length,
        finish: choice?.finish_reason,
        usage: j.usage || {},
      };
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/**
 * Deterministic grade, no judge model. Correct iff any answer_regex matches the
 * output, OR (fallback) any answer_literal appears as a case-insensitive substring.
 * Regex is primary because the fixtures were authored with anchored regexes.
 */
export function grade(output, { answer_regexes = [], answer_literals = [] }) {
  const text = output || '';
  for (const rx of answer_regexes) {
    try { if (new RegExp(rx).test(text)) return { correct: true, via: 'regex', pattern: rx }; } catch { /* bad pattern */ }
  }
  for (const lit of answer_literals) {
    if (lit && text.toLowerCase().includes(String(lit).toLowerCase())) return { correct: true, via: 'literal', pattern: lit };
  }
  return { correct: false, via: null, pattern: null };
}

/** Recover a committed s1 question set from git (self-contained; no store rebuild). */
export function loadQuestionSet(name) {
  const raw = execSync(`git show 7d459f9^:eval/fixtures/transplant/s1/e1b289c32f40/${name}.json`, {
    cwd: REPO, maxBuffer: 1 << 26,
  }).toString();
  const parsed = JSON.parse(raw);
  return parsed.questions || parsed; // questions*.json wrap in {questions:[...]}
}

export const QUESTION_SETS = ['questions', 'questions-deep', 'questions-overflow'];

/**
 * The canonical de-duplicated question set for the rung-1 probes.
 * The three committed sets reuse 4 overflow ids (`s1-qo01..04-overflow`) across
 * `questions-deep` and `questions-overflow` for DIFFERENT questions, so a raw
 * id is not a unique key. This tags each question with its origin set and assigns
 * a stable unique `uid` (origin set disambiguates only the collisions), dropping
 * any TRUE duplicate (identical question text) — there are none today, so all 22
 * distinct questions survive with unique ids. Deterministic; no committed fixture.
 */
export function loadMergedQuestions() {
  const all = QUESTION_SETS.flatMap((set) => loadQuestionSet(set).map((q) => ({ ...q, set })));
  const idCount = {};
  for (const q of all) idCount[q.id] = (idCount[q.id] || 0) + 1;
  const seenText = new Set();
  const out = [];
  for (const q of all) {
    const key = `${q.id}::${q.question}`;
    if (seenText.has(key)) continue; // true duplicate (same id AND same text) — drop
    seenText.add(key);
    out.push({ ...q, uid: idCount[q.id] > 1 ? `${q.id}@${q.set}` : q.id });
  }
  return out;
}

export function writeResults(dir, filename, obj) {
  const outDir = join(REPO, 'reports', 'metrics', dir);
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, filename);
  writeFileSync(path, JSON.stringify(obj, null, 2));
  return path;
}

export function nowISO() { return new Date().toISOString(); }
