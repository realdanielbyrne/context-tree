/**
 * TRANSCRIPT CAPTURE — writes each experiment run as an L0/L2 store, so runs become
 * reusable substrates for later experiments instead of evaporating into summary stats.
 *
 * Layout matches the project's own storage invariant (CLAUDE.md) and the existing
 * `captures/` convention under reports/metrics/attention-policy-continuation/:
 *
 *   captures/<run_id>/index.json            cells -> paths + outcomes
 *   captures/<run_id>/<cell>/events.jsonl   L0: append-only, monotonic `seq`, COORDINATES ONLY
 *   captures/<run_id>/<cell>/blobs/<aa>/<sha256>   L2: content-addressed, write-once
 *   captures/<run_id>/<cell>/workspace.json  final workspace file list + blob refs
 *
 * Why content-addressed: it is the project's own L2 contract, and in a DEDUP experiment
 * it doubles as a measurement — content the agent saw twice collapses to one blob, so
 * `events.jsonl` referencing the same sha twice IS the duplication, recorded structurally.
 *
 * Why capture incrementally from the live message array rather than runAgent's return:
 * when the model emits invalid tool-call JSON the server 500s, runAgent throws, and the
 * return value is lost. That turned a crash into an apparent zero once already. Holding a
 * reference to the live array means a crashed run still yields a full transcript.
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync, statSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, relative } from 'node:path';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export function makeCapture(rootDir, runId, cellName) {
  const dir = join(rootDir, runId, cellName);
  const blobDir = join(dir, 'blobs');
  mkdirSync(blobDir, { recursive: true });
  const eventsPath = join(dir, 'events.jsonl');
  writeFileSync(eventsPath, '');
  let seq = 0;
  const seen = new Set();

  /** L2 write-once. Returns the coordinate; never rewrites an existing blob. */
  const putBlob = (text) => {
    const s = String(text ?? '');
    const h = sha256(s);
    if (!seen.has(h)) {
      const p = join(blobDir, h.slice(0, 2), h);
      if (!existsSync(p)) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); }
      seen.add(h);
    }
    return { blob: h, bytes: s.length };
  };

  const emit = (ev) => { appendFileSync(eventsPath, JSON.stringify({ seq: seq++, ...ev }) + '\n'); return seq - 1; };

  return {
    dir, eventsPath,
    blobCount: () => seen.size,
    emit,
    /** One conversation message -> coordinates in L0 + payload in L2. */
    message(turn, m) {
      const content = putBlob(m.content ?? '');
      const base = { type: 'message', turn, role: m.role, ...content,
        preview: String(m.content ?? '').slice(0, 120) };
      if (m.tool_call_id) base.tool_call_id = m.tool_call_id;
      if (m.tool_calls) {
        base.tool_calls = m.tool_calls.map((tc) => {
          const a = putBlob(tc.function?.arguments ?? '');
          return { id: tc.id, name: tc.function?.name, args_blob: a.blob, args_bytes: a.bytes };
        });
      }
      return emit(base);
    },
    /** Serialise a whole conversation, plus usage, tool log and anchor events. */
    conversation(messages, { usage = [], toolLog = [], anchorEvents = [] } = {}) {
      let turn = 0;
      for (const m of messages) {
        if (m.role === 'assistant') turn += 1;
        this.message(turn, m);
      }
      for (const u of usage) emit({ type: 'usage', turn: u.turn, prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens });
      for (const t of toolLog) emit({ type: 'tool_log', turn: t.turn, name: t.name, args: t.args, out_preview: String(t.out ?? '').slice(0, 200) });
      for (const a of anchorEvents) emit({ type: 'anchor_event', ...a });
    },
    /** Final workspace: what the agent actually produced. Small files go to L2 too. */
    workspace(ws, { maxBytes = 200000 } = {}) {
      const files = [];
      const walk = (d) => {
        for (const name of readdirSync(d)) {
          if (name.startsWith('.')) continue;
          const p = join(d, name);
          const st = statSync(p);
          if (st.isDirectory()) { walk(p); continue; }
          const rel = relative(ws, p);
          if (st.size > maxBytes) { files.push({ path: rel, bytes: st.size, blob: null, skipped: 'too-large' }); continue; }
          let text = null;
          try { text = readFileSync(p, 'utf8'); } catch { files.push({ path: rel, bytes: st.size, blob: null, skipped: 'unreadable' }); continue; }
          files.push({ path: rel, ...putBlob(text) });
        }
      };
      try { walk(ws); } catch {}
      writeFileSync(join(dir, 'workspace.json'), JSON.stringify({ files }, null, 2));
      return files.length;
    },
    finish(outcome) { emit({ type: 'run_end', ...outcome }); },
  };
}

export function writeCaptureIndex(rootDir, runId, index) {
  const p = join(rootDir, runId, 'index.json');
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(index, null, 2));
  return p;
}
