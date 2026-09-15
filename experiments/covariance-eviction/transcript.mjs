/**
 * Claude Code JSONL -> a per-turn FILE REFERENCE LOG. Pure parsing, no network,
 * separate module so tests can feed it a synthetic transcript.
 *
 * ⚠️ THE TURN CLOCK IS THE WHOLE REASON THIS IS NOT `tier1-idle-predicts-cold.mjs`'s
 * parser. That parser increments `turn` on every JSONL line of type `assistant`, and
 * Tier 1's own writeup records what that costs: a Claude assistant *message* is split
 * across several JSONL lines, one per content block, so 645 lines were being counted
 * as 645 turns where only 331 API turns occurred — a 2.0-2.4x inflation. Every
 * turn-denominated quantity inherits it: idle, the g* = w/r horizon, the K-turn hot
 * window, the L-turn dilation. `reports/session-handoff.md` C3 flags this as a defect
 * to audit for, so this parser advances the clock on a change of `message.id`, the
 * same rule `anchor-replay.mjs:83` uses.
 *
 * A "reference" is a tool call that names a file path — Read, Edit, MultiEdit, Write,
 * NotebookEdit — PLUS file paths appearing in a `Bash` command line. The Bash class is
 * not optional bookkeeping: in this corpus Bash is 875 of 1,528 tool calls (1,482 of
 * them Read/Write/Bash-family), six times Read, which is C1 ("with `run_bash` available the model cat/greps exactly what it
 * needs and never loads whole files") showing up in the data. A reference log that
 * ignores it is blind to most of what these agents actually touch. It is nonetheless
 * kept behind `includeBash` so the whole analysis can be re-run without it as a
 * sensitivity check, since the extraction is a regex over a command string and is
 * therefore the least trustworthy part of this file.
 *
 * Search tools (Grep, Glob) are NOT references: they return matching lines, not the
 * payload, so folding them in would inflate co-activation between every file one
 * `grep -r` happened to touch. The same distinction `anchor-replay` draws between
 * `re-requested` and `searched`.
 *
 * Rerun (diagnostic dump of the corpus this parser sees):
 *   node experiments/covariance-eviction/transcript.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = join(HERE, '..', '..');
export const FIXTURES = join(REPO, 'packages', 'cli', 'test', 'fixtures');

/** Tools whose call brings a file's CONTENT into (or out of) the transcript. */
export const READ_TOOLS = new Set(['Read', 'NotebookRead']);
export const WRITE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/**
 * `claude-code-session-4.jsonl` is excluded by default, matching
 * `anchor-replay.mjs:54`. Override with CT_COV_FIXTURES to run over an explicit list.
 */
export const DEFAULT_EXCLUDE = new Set(['claude-code-session-4.jsonl']);

/** Trim an absolute path back to a repo-relative one so the same file has one identity. */
export function normPath(p) {
  if (typeof p !== 'string' || !p) return null;
  const i = p.lastIndexOf('context-tree/');
  return i >= 0 ? p.slice(i + 'context-tree/'.length) : p;
}

/**
 * File paths named on a shell command line. Deliberately conservative: a token must
 * carry a file extension of 1-5 word characters, must not be a flag, and a bare
 * directory (`packages/core`) is rejected. Over-matching would fabricate
 * co-activation, which is the one error this experiment cannot absorb.
 */
const BASH_PATH_RX = /(?:^|[\s'"=(|;&])([A-Za-z0-9_./@-]*[A-Za-z0-9_-]\.[A-Za-z0-9]{1,5})(?=$|[\s'":,)|;&])/g;
const BASH_PATH_DENY = /^(?:\d|-)|^(?:\.{1,2})$|node_modules|^https?/i;

export function bashPaths(command) {
  const out = new Set();
  if (typeof command !== 'string') return out;
  for (const m of command.slice(0, 4000).matchAll(BASH_PATH_RX)) {
    const raw = m[1];
    if (BASH_PATH_DENY.test(raw)) continue;
    const p = normPath(raw.replace(/^\.\//, ''));
    if (p && p.length >= 4) out.add(p);
  }
  return out;
}

/**
 * Parse one session into `{ turns, nTurns, nLines, nRefs }` where `turns[t]` is
 * `{ read: Set<path>, wrote: Set<path>, files: Set<path> }` for API turn `t`.
 * Turns with no file reference are kept as empty sets — dropping them would compress
 * the clock and silently change every turn-denominated parameter.
 */
/**
 * `extractFingerprints`, transcribed EXACTLY from `packages/core/src/retrieve/lexical.ts:41-62`
 * — the function `flex-store.ts:57` feeds into the shipped `coOccurrence`.
 *
 * ⚠️ CORRECTED after adversarial review. An earlier version of this file used a
 * hand-written regex family that was NOT the shipped one: it added a snake_case rule
 * (`/\b\w*_\w{2,}\w*\b/`) and omitted the DOTTED and BACKTICK patterns, and its file-path
 * pattern did not require a slash. That matters for more than fidelity — the shipped
 * extractor does **not** match `__init__` or `parse_line` (there is no snake_case rule,
 * and `UPPER_SNAKE` requires leading capitals), so the `__init__` story cannot be told
 * about it. The `__init__` regression is real but it belongs to
 * `experiments/coding-harness/lib.mjs:82`, whose `fp` admits any token with an
 * underscore and length >= 5. Both designs now say which of the two they mean.
 *
 * The saturation headline survived the swap when the reviewer re-ran it with the real
 * regexes, so this correction changes the provenance of the number, not the number.
 */
const FILE_PATH_PATTERN = /(?:[\w.-]+\/)+[\w.-]+\.\w+/g;
const CAMEL_PATTERN = /\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/g;
const PASCAL_PATTERN = /\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g;
const UPPER_SNAKE_PATTERN = /\b[A-Z][A-Z0-9_]{2,}\b/g;
const DOTTED_PATTERN = /\b[a-z]\w*(?:\.[a-z]\w*)+\b/g;
const BACKTICK_PATTERN = /`([^`]+)`/g;

export function extractFingerprints(text, cap = 400) {
  const fps = new Set();
  const add = (v) => { if (fps.size < cap) fps.add(v); };
  for (const m of String(text).matchAll(FILE_PATH_PATTERN)) add(m[0]);
  for (const m of String(text).matchAll(CAMEL_PATTERN)) add(m[0]);
  for (const m of String(text).matchAll(PASCAL_PATTERN)) add(m[0]);
  for (const m of String(text).matchAll(UPPER_SNAKE_PATTERN)) add(m[0]);
  for (const m of String(text).matchAll(DOTTED_PATTERN)) add(m[0]);
  for (const m of String(text).matchAll(BACKTICK_PATTERN)) { if (m[1] !== undefined) add(m[1]); }
  return fps;
}

/**
 * LEXICAL features — content tokens, the densest feature space under test.
 *
 * Deliberately crude: lowercased word-ish tokens of length >= 3, minus a stopword list
 * of English function words and the code/agent boilerplate that appears in almost every
 * turn of every transcript. Crudeness is acceptable here because the phi coefficient
 * already neutralises a token that appears on every turn (its margin is degenerate, so
 * it scores 0 against everything) — the stopword list is a speed optimisation and a
 * legibility aid, not the thing standing between this feature space and nonsense.
 *
 * ⚠️ This is the feature space most at risk of the OPPOSITE failure from file-keying: if
 * everything co-occurs with everything, covariance is uninformative in the other
 * direction. That is why the saturation diagnostics exist and why they gate.
 */
const STOP = new Set(('a an the and or but if then else for while do to of in on at by with from as is are was were be been '
  + 'being have has had not no yes it its this that these those there here we you they he she them their our your my me '
  + 'i s t can will just don should now what which who when where how all any both each few more most other some such '
  + 'only own same so than too very will would could shall may might must let get got make made use used using need '
  + 'file files line lines code function functions return returns value values test tests error errors true false null '
  + 'undefined const var new class def self import export from default async await try catch throw type types string '
  + 'number boolean object array log console print run running runs call called calls add added adds set sets get gets '
  + 'you are assistant user tool result content text json name input output').split(/\s+/));

export function lexicalTokens(text, cap = 400) {
  const out = new Set();
  for (const m of String(text).toLowerCase().matchAll(/[a-z][a-z0-9_.\/-]{2,}/g)) {
    const t = m[0];
    if (t.length > 40 || STOP.has(t)) continue;
    out.add(t);
    if (out.size >= cap) break;
  }
  return out;
}

export function parseSession(file, { includeBash = true, withFingerprints = false, withLexical = false } = {}) {
  const turns = [];
  let lastId = null;
  let nLines = 0, nRefs = 0, nBashRefs = 0, nAssistantLines = 0;
  const push = () => turns.push({ read: new Set(), wrote: new Set(), files: new Set(), fp: new Set(), lex: new Set() });

  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    nLines += 1;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'assistant') continue;
    nAssistantLines += 1;
    const msg = o.message || {};
    if (msg.id && msg.id !== lastId) { lastId = msg.id; push(); }
    if (turns.length === 0) push();
    const cur = turns[turns.length - 1];
    const content = Array.isArray(msg.content) ? msg.content : [];
    if (withFingerprints || withLexical) {
      let text = '';
      for (const b of content) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text' && b.text) text += ` ${b.text}`;
        else if (b.type === 'tool_use') text += ` ${JSON.stringify(b.input || {}).slice(0, 1200)}`;
      }
      const clipped = text.slice(0, 6000);
      if (withFingerprints) for (const f of extractFingerprints(clipped)) cur.fp.add(f);
      if (withLexical) for (const f of lexicalTokens(clipped)) cur.lex.add(f);
    }
    for (const b of content) {
      if (!b || b.type !== 'tool_use') continue;
      const input = b.input || {};
      if (includeBash && b.name === 'Bash') {
        for (const p of bashPaths(input.command)) { cur.read.add(p); cur.files.add(p); nRefs += 1; nBashRefs += 1; }
        continue;
      }
      const p = normPath(input.file_path ?? input.notebook_path);
      if (!p) continue;
      if (READ_TOOLS.has(b.name)) { cur.read.add(p); cur.files.add(p); nRefs += 1; }
      else if (WRITE_TOOLS.has(b.name)) { cur.wrote.add(p); cur.files.add(p); nRefs += 1; }
    }
  }
  return { turns, nTurns: turns.length, nLines, nAssistantLines, nRefs, nBashRefs };
}

/** The per-turn reference log the covariance signal consumes. */
export const refLogOf = (parsed) => parsed.turns.map((t) => t.files);

/** Fixture files, sorted, honouring CT_COV_FIXTURES and the default exclusion. */
export function fixtureFiles(env = process.env) {
  if (env.CT_COV_FIXTURES) return env.CT_COV_FIXTURES.split(',').map((f) => (f.includes('/') ? f : join(FIXTURES, f)));
  return readdirSync(FIXTURES)
    .filter((f) => /^claude-code-session.*\.jsonl$/.test(f) && !DEFAULT_EXCLUDE.has(f))
    .sort()
    .map((f) => join(FIXTURES, f));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const includeBash = process.env.CT_COV_BASH !== '0';
  console.log(`includeBash=${includeBash}`);
  for (const f of fixtureFiles()) {
    const p = parseSession(f, { includeBash });
    const files = new Set();
    for (const t of p.turns) for (const x of t.files) files.add(x);
    const inflation = p.nTurns ? (p.nAssistantLines / p.nTurns).toFixed(2) : 'n/a';
    console.log(
      `${basename(f).padEnd(30)} turns=${String(p.nTurns).padStart(5)}  ` +
      `assistant-lines=${String(p.nAssistantLines).padStart(6)} (clock inflation ${inflation}x)  ` +
      `refs=${String(p.nRefs).padStart(5)} (bash ${p.nBashRefs})  distinct-files=${files.size}  ` +
      `refs/turn=${(p.nRefs / Math.max(1, p.nTurns)).toFixed(2)}`,
    );
  }
}
