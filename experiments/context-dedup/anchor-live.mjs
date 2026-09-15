/**
 * ANCHOR LIVE — does re-injecting part of what the model ALREADY HAS change whether
 * it completes the task?
 *
 * This replaces the replay probe, which measured "did it re-read in the next turn".
 * That had no ground truth: 7 of 11 turns scored as success never touched the file at
 * all. Here the outcome is the task's own held-out grader — pass or fail, earned.
 *
 * TRIGGER (identical in every arm, so arms differ ONLY in what is returned):
 * a tool result whose normalized bytes are already resident in the live message array
 * -- exact hash, or fully contained in a resident block on the same path -- with no
 * intervening edit, residency re-verified at fire time. It can never assert something
 * about a fragment; that false claim is what invalidated the previous experiment and
 * is what report-readloop.md's failed nudge actually measured.
 *
 * ARMS -- what the tool returns when the trigger fires:
 *   none        NO INTERVENTION. The real result, unchanged. The model does what it wanted.
 *   anchor      a reference only (~250 chars): "you read X at turn k, it is above".
 *   anchor-topk the reference PLUS the top-k chunks of the resident copy, ranked by
 *               the repo's BM25 over 800/100 chunks against the model's own request and
 *               recent turns (never the pending question -- that would be an oracle).
 *   placebo     length-matched to `anchor`, non-referential. Isolates the reference.
 *
 * The question this answers: HOW MUCH of the already-present content must be
 * re-injected to preserve task success? If anchor-topk matches `none` at a fraction of
 * the tokens, that is a deployable result. If only `none` works, the idea is dead and
 * we know precisely how dead.
 *
 * PILOT FIRST. `CT_ANCHOR_PASSIVE=1` runs arm `none` while recording every event that
 * WOULD have fired. If the trigger does not fire enough on a substrate, no arm
 * comparison on it can mean anything, and "not runnable here" is a legitimate result.
 *
 * Rerun:
 *   set -a; . ./.env; set +a
 *   CT_TASK=longbuild CT_REPEATS=3 CT_ANCHOR_PASSIVE=1 node experiments/context-dedup/anchor-live.mjs
 *   CT_TASK=longbuild CT_REPEATS=5 CT_ARMS=none,anchor,anchor-topk node experiments/context-dedup/anchor-live.mjs
 */
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgent, makeWorkspace, estTokens, MODEL, RETRY_STATS } from '../coding-harness/lib.mjs';
import { writeResults, gitSha, nowISO } from '../rung-1-live-probe/lib.mjs';
import { makeAnchorIndex, estTok } from './anchor-index.mjs';
import { makeCapture, writeCaptureIndex } from './capture.mjs';
import { join as pjoin, dirname as pdirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const TASK_NAME = process.env.CT_TASK || 'longbuild';
const REPEATS = +(process.env.CT_REPEATS || 3);
const MAX_TURNS = +(process.env.CT_MAX_TURNS || 60);
const ARMS = (process.env.CT_ARMS || 'none,anchor,anchor-topk').split(',');
const TOPK = +(process.env.CT_ANCHOR_TOPK || 3);
const MIN_CHARS = +(process.env.CT_ANCHOR_MIN_CHARS || 200);
const PASSIVE = process.env.CT_ANCHOR_PASSIVE === '1';
const TAG = process.env.CT_TAG || 'v1';
const SAVE_TRANSCRIPTS = process.env.CT_SAVE_TRANSCRIPTS !== '0';
const RUN_ID = `anchor-live-${TAG}-${Date.now()}`;
const CAPTURE_ROOT = pjoin(HERE, '..', '..', 'reports', 'metrics', 'context-dedup', 'captures');

async function runCell(task, arm, repeat) {
  const cellName = `${arm}-rep${repeat}`;
  const cap = SAVE_TRANSCRIPTS ? makeCapture(CAPTURE_ROOT, RUN_ID, cellName) : null;
  const ws = makeWorkspace();
  task.seed(ws);
  const idx = makeAnchorIndex({
    arm: PASSIVE ? 'none' : arm, passive: PASSIVE, topK: TOPK, minChars: MIN_CHARS,
    verify: 'identity', requireUnedited: true,
  });
  let peak = 0;
  // Hold the LIVE array. runAgent throws on a server 5xx and its return value is lost,
  // so without this a crashed run captures nothing and looks identical to a null.
  let liveMessages = null;
  const hook = (messages, turn) => { liveMessages = messages; idx.hook(messages, turn); peak = Math.max(peak, estTokens(messages)); };

  const t0 = Date.now();
  let r = null, err = null;
  try {
    r = await runAgent({ system: task.system, task: task.task, ws, maxTurns: MAX_TURNS,
      think: false, hook, reducer: idx.reducer, allowedTools: task.allowedTools ?? null });
  } catch (e) { err = String(e.message || e).slice(0, 200); }
  let pass = false, score = null;
  try { pass = task.grade(ws); } catch { pass = false; }
  // Partial credit where the task offers it: with 18 questions, all-or-nothing
  // discards almost all the signal and makes FAIL cells indistinguishable.
  if (typeof task.score === 'function') { try { score = task.score(ws); } catch { score = null; } }

  if (cap) {
    const msgs = r?.messages ?? liveMessages ?? [];
    cap.conversation(msgs, { usage: r?.usage ?? [], toolLog: r?.toolLog ?? [], anchorEvents: idx.events });
    cap.workspace(ws);
    cap.finish({ pass, score, turns: r?.turns ?? null, stop: r?.stop ?? 'error', error: err,
      captured_from: r ? 'return' : 'live-ref(crash)', messages: msgs.length });
  }
  const st = idx.stats();
  const fired = idx.events.filter((e) => e.fired);
  const reads = r ? r.toolLog.filter((t) => t.name === 'read_file') : [];
  const distinct = new Set(reads.map((t) => t.args?.path).filter(Boolean)).size;
  return {
    arm, repeat, passive: PASSIVE, pass,
    capture_dir: cap ? relative(pjoin(HERE, '..', '..'), cap.dir) : null,
    capture_blobs: cap ? cap.blobCount() : null, score_correct: score?.correct ?? null, score_total: score?.total ?? null,
    turns: r?.turns ?? null, stop: r?.stop ?? 'error',
    would_fire: st.would_fire, fires: st.fires, by_kind: st.by_kind,
    residency_false_count: st.residency_false_count,
    anchorable_chars: st.anchorable_chars,
    substituted_chars: fired.reduce((s, e) => s + (e.substituted_chars || 0), 0),
    replaced_chars: fired.reduce((s, e) => s + e.real_chars, 0),
    reads: reads.length, rereads: Math.max(0, reads.length - distinct),
    peak_history_tokens: peak,
    total_prompt_tokens: r ? r.usage.reduce((s, u) => s + (u.prompt_tokens || 0), 0) : 0,
    wall_seconds: Math.round((Date.now() - t0) / 1000), error: err,
  };
}

const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };

async function main() {
  const task = (await import(join(HERE, 'ab-tasks', `${TASK_NAME}.mjs`))).default;
  const arms = PASSIVE ? ['none'] : ARMS;
  const cells = [];
  for (let rep = 0; rep < REPEATS; rep++) {
    for (const arm of arms) {
      console.error(`\n--- rep${rep} ${arm}${PASSIVE ? ' (PASSIVE PILOT)' : ''} ---`);
      const c = await runCell(task, arm, rep);
      cells.push(c);
      console.error(`    -> ${c.pass ? 'PASS' : 'FAIL'}${c.score_total ? ` score=${c.score_correct}/${c.score_total}` : ''} turns=${c.turns} wouldFire=${c.would_fire} fires=${c.fires} kinds=${JSON.stringify(c.by_kind)} tok=${c.total_prompt_tokens}`);
    }
  }
  const summary = arms.map((arm) => {
    const cs = cells.filter((c) => c.arm === arm);
    return { arm, n: cs.length,
      pass_rate: +(cs.filter((c) => c.pass).length / Math.max(1, cs.length)).toFixed(3),
      passes: cs.filter((c) => c.pass).length,
      score_mean: cs[0]?.score_total ? +(cs.reduce((a, c) => a + (c.score_correct ?? 0), 0) / cs.length).toFixed(2) : null,
      score_total: cs[0]?.score_total ?? null,
      turns_median: med(cs.map((c) => c.turns ?? MAX_TURNS)),
      would_fire_median: med(cs.map((c) => c.would_fire)), fires_median: med(cs.map((c) => c.fires)),
      tokens_median: med(cs.map((c) => c.total_prompt_tokens)),
      tokens_saved_median: med(cs.map((c) => Math.ceil((c.replaced_chars - c.substituted_chars) / 4))),
      residency_false_total: cs.reduce((s, c) => s + c.residency_false_count, 0) };
  });

  const wf = med(cells.map((c) => c.would_fire));
  const anchorable = med(cells.map((c) => Math.ceil(c.anchorable_chars / 4)));
  const totalTok = med(cells.map((c) => c.total_prompt_tokens)) || 1;
  // A crashed run reports reads=0 / fires=0 and is INDISTINGUISHABLE from a genuine
  // null unless we say so. Refuse to issue a gate decision when any cell errored.
  const errored = cells.filter((c) => c.error).length;
  const gate = PASSIVE ? (errored ? {
    would_fire_median: null, errored_cells: errored, total_cells: cells.length,
    decision: `INVALID — ${errored}/${cells.length} cells errored, so zero fires is not a measurement. Fix the error and re-run.`,
    first_error: cells.find((c) => c.error)?.error ?? null,
  } : {
    would_fire_median: wf, anchorable_tokens_median: anchorable,
    anchorable_share_of_prompt: +(anchorable / totalTok).toFixed(5),
    decision: wf >= 12 ? 'GO — run the full arm comparison'
      : wf >= 4 ? 'CONDITIONAL — too few fires for a clean comparison; widen the trigger once or pick another substrate'
      : 'STOP — the trigger does not fire on this substrate/model. Report "not runnable" rather than forcing it.',
  }) : null;

  const out = {
    manifest: {
      run_id: RUN_ID,
      experiment: `context-dedup / anchor live ${PASSIVE ? 'PILOT' : 'A/B'} (${TASK_NAME})`,
      model: MODEL, task: task.name, commit: gitSha(), date: nowISO(),
      params: { arms, repeats: REPEATS, max_turns: MAX_TURNS, top_k: TOPK, min_chars: MIN_CHARS, passive: PASSIVE },
      hypothesis: 'When a tool would return content the model already has, returning a reference (anchor) — or a reference plus the most relevant chunks of that resident copy (anchor-topk) — preserves task success at a fraction of the tokens.',
      falsification: 'If anchor or anchor-topk loses task success against the no-intervention arm beyond the run-to-run spread, re-injection is required and referencing is not enough. If the trigger fires too rarely to distinguish arms, the substrate cannot test the question.',
      caveats: [
        'NO EVICTION and NO WINDOW CAP anywhere: the context is append-only, so every anchor is truthful by construction and residency is re-verified at fire time.',
        'The retrieval query is the model\'s own request plus recent turns — never the pending question, which would be an oracle a deployed middleware could not have.',
        'Single task = single problem (caveat C0). Repeats measure within-problem nondeterminism, not between-problem variance.',
        'Grading is all-or-nothing, so FAIL cells are not distinguished by how close they came.',
        'total_prompt_tokens is RAW; the local server does not report cache counters, so this is context volume, not cache-adjusted cost.',
      ],
    },
    summary, gate, retry_stats: { ...RETRY_STATS }, errored_cells: errored, cells,
  };
  const path = writeResults('context-dedup', `results-anchor-live-${TASK_NAME}-${TAG}.json`, out);
  let capIndex = null;
  if (SAVE_TRANSCRIPTS) {
    capIndex = writeCaptureIndex(CAPTURE_ROOT, RUN_ID, {
      run_id: RUN_ID, experiment: out.manifest.experiment, model: MODEL, task: task.name,
      commit: out.manifest.commit, date: out.manifest.date, params: out.manifest.params,
      note: 'L0 events.jsonl carries COORDINATES ONLY; payloads are content-addressed in blobs/. Identical content collapses to one blob, so a repeated sha IS recorded duplication.',
      cells: cells.map((c) => ({ cell: `${c.arm}-rep${c.repeat}`, arm: c.arm, repeat: c.repeat,
        dir: c.capture_dir, blobs: c.capture_blobs, pass: c.pass,
        score: c.score_total ? `${c.score_correct}/${c.score_total}` : null,
        turns: c.turns, stop: c.stop, would_fire: c.would_fire, fires: c.fires, error: c.error })),
    });
  }
  console.error(`\n=== ANCHOR LIVE ${PASSIVE ? 'PILOT' : 'A/B'} [${task.name}] model=${MODEL} n=${REPEATS} ===`);
  console.error('  arm           n  pass   score  turns  wouldFire  fires  savedTok  totalTok');
  for (const s of summary) console.error(`  ${s.arm.padEnd(12)} ${String(s.n).padStart(2)}  ${String(s.passes + '/' + s.n).padStart(4)}  ${String(s.score_mean === null ? '-' : s.score_mean + '/' + s.score_total).padStart(6)}  ${String(s.turns_median).padStart(5)}  ${String(s.would_fire_median).padStart(9)}  ${String(s.fires_median).padStart(5)}  ${String(s.tokens_saved_median).padStart(8)}  ${s.tokens_median}`);
  if (gate) { console.error('\n  PILOT GATE:'); for (const [k, v] of Object.entries(gate)) console.error(`    ${k.padEnd(30)} ${v}`); }
  console.error(`\n  written: ${path}`);
  if (capIndex) console.error(`  transcripts: ${relative(pjoin(HERE, '..', '..'), capIndex)}  (${cells.length} cells, L0 events.jsonl + L2 blobs/)`);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
