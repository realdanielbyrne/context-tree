/**
 * ANCHOR LIVE — does anchoring save TOTAL TOKENS and WALL-CLOCK TIME to completion?
 *
 * THE DECISION THIS FEEDS: if anchoring saves tokens and time at equal task success,
 * fold it into context-tree. If it does not, leave it out. So the primary outcomes are
 * cumulative `total_prompt_tokens` and `wall_seconds` TO COMPLETION, gated on the task
 * actually being completed correctly — saving tokens on a task you failed is worthless.
 *
 * WHY THE SAVING COMPOUNDS, and why a one-shot count understates it ~370x. Prompt cost
 * is cumulative: every turn re-sends the whole prefix. A token NOT appended at turn k is
 * therefore never re-sent on any of the remaining turns. DV4 measured this directly on
 * real transcripts — 11,716 bytes suppressed produced a 4,375,005-token cumulative
 * reduction, a 373x multiplier (results-dv4-anchor-dedup.json). Any estimate that
 * multiplies fires by bytes-saved and stops there is wrong by that factor.
 *
 * WHY TOKENS AND TIME ARE MEASURED SEPARATELY, not as proxies for each other. This
 * server caches prefixes: a 30k-token prefill measured 15.2s cold and 0.6s warm. So
 * re-sending cached tokens is nearly free in WALL TIME while still being billed. Time
 * can therefore move independently of tokens, and in either direction — it improves if
 * anchors remove whole turns or shrink the KV to attend over, and it WORSENS if the
 * model re-requests after an anchor and spends an extra round trip. Both are primary.
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
  // The scenario releases its follow-up user turns; compose its hook with the index's.
  const tk = task.makeHook ? task.makeHook(ws) : null;
  let peak = 0;
  // Hold the LIVE array. runAgent throws on a server 5xx and its return value is lost,
  // so without this a crashed run captures nothing and looks identical to a null.
  let liveMessages = null;
  const hook = (messages, turn) => {
    const now = Date.now(); if (turn > 0) turnMs.push(now - lastT); lastT = now;
    liveMessages = messages; tk?.hook(messages, turn); idx.hook(messages, turn); peak = Math.max(peak, estTokens(messages));
  };

  const t0 = Date.now();
  const turnMs = [];
  let lastT = t0;
  let r = null, err = null;
  try {
    r = await runAgent({ system: task.system, task: task.task, ws, maxTurns: MAX_TURNS,
      think: false, hook, reducer: idx.reducer, allowedTools: task.allowedTools ?? null,
      onEnd: tk ? ((m, t) => tk.onEnd(m, t)) : null, maxTokens: +(process.env.CT_MAX_TOKENS || 2048) });
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
  // How the run ENDED matters as much as the score. Without context-tree machinery a
  // long task eventually exhausts the window and fails outright, so a run that is
  // window-limited is a different observation from one that finished or ran out of turns.
  const WINDOW = +(process.env.CT_MODEL_WINDOW || 262144);
  const realPeak = r ? Math.max(0, ...r.usage.map((u) => u.prompt_tokens || 0)) : 0;
  const errStr = String(err || '');
  const terminated_by =
    err ? (/context|token|too long|exceed|n_ctx|KV cache/i.test(errStr) ? 'context-window' : 'error')
    : r?.stop === 'maxTurns' ? 'turn-limit'
    : tk && !tk.state().all_released ? 'ended-early'
    : 'completed';
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
    wall_seconds: +((Date.now() - t0) / 1000).toFixed(1),
    turn_ms_median: turnMs.length ? [...turnMs].sort((a, b) => a - b)[Math.floor(turnMs.length / 2)] : null,
    turn_ms_total: turnMs.reduce((a, b) => a + b, 0),
    tokens_per_turn: r ? Math.round(r.usage.reduce((s2, u) => s2 + (u.prompt_tokens || 0), 0) / Math.max(1, r.usage.length)) : null,
    terminated_by,
    peak_prompt_tokens: realPeak,
    window_headroom_pct: realPeak ? +(100 * (1 - realPeak / WINDOW)).toFixed(1) : null,
    error: err,
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
      phase_mean: cs[0]?.phase_index !== undefined ? +(cs.reduce((a, c) => a + (c.phase_index ?? 0), 0) / cs.length).toFixed(2) : null,
      phase_furthest: Math.max(0, ...cs.map((c) => c.phase_index ?? 0)),
      terminated: cs.reduce((a, c) => ((a[c.terminated_by] = (a[c.terminated_by] || 0) + 1), a), {}),
      peak_prompt_tokens_median: med(cs.map((c) => c.peak_prompt_tokens ?? 0)),
      score_total: cs[0]?.score_total ?? null,
      turns_median: med(cs.map((c) => c.turns ?? MAX_TURNS)),
      would_fire_median: med(cs.map((c) => c.would_fire)), fires_median: med(cs.map((c) => c.fires)),
      tokens_median: med(cs.map((c) => c.total_prompt_tokens)),
      wall_seconds_median: med(cs.map((c) => c.wall_seconds)),
      turn_ms_median: med(cs.map((c) => c.turn_ms_median ?? 0)),
      tokens_saved_median: med(cs.map((c) => Math.ceil((c.replaced_chars - c.substituted_chars) / 4))),
      residency_false_total: cs.reduce((s, c) => s + c.residency_false_count, 0) };
  });

  // The decision table: tokens and time against the no-intervention arm.
  const baseRow = summary.find((x) => x.arm === 'none');
  if (baseRow) for (const row of summary) {
    row.tokens_delta_pct = baseRow.tokens_median ? +(100 * (1 - row.tokens_median / baseRow.tokens_median)).toFixed(2) : null;
    row.wall_delta_pct = baseRow.wall_seconds_median ? +(100 * (1 - row.wall_seconds_median / baseRow.wall_seconds_median)).toFixed(2) : null;
    row.score_delta = (row.score_mean ?? 0) - (baseRow.score_mean ?? 0);
    row.verdict = row.arm === 'none' ? '—'
      : (row.tokens_delta_pct > 0 && row.wall_delta_pct > 0 && row.score_delta >= -1) ? 'FOLD IN — saves tokens and time at equal score'
      : (row.score_delta < -1) ? 'LEAVE OUT — task score degraded'
      : (row.tokens_delta_pct <= 0) ? 'LEAVE OUT — no token saving'
      : 'LEAVE OUT — tokens saved but no wall-clock saving';
  }

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
      hypothesis: 'Returning an anchor (or an anchor plus the most relevant chunks of the resident copy) instead of content the model already has REDUCES cumulative prompt tokens and wall-clock time to completion, at no cost to task success. The saving compounds because a token not appended is never re-sent on any later turn (DV4 measured a 373x multiplier).',
      falsification: 'FOLD IN only if an anchor arm cuts BOTH cumulative total_prompt_tokens AND wall_seconds against the no-intervention arm, at task score within noise. LEAVE OUT if either metric fails to improve, or if score drops. If the trigger fires too rarely to move either metric, the substrate cannot decide it and the run reports NOT RUNNABLE rather than a null.',
      caveats: [
        'NO EVICTION and NO WINDOW CAP anywhere: the context is append-only, so every anchor is truthful by construction and residency is re-verified at fire time.',
        'The retrieval query is the model\'s own request plus recent turns — never the pending question, which would be an oracle a deployed middleware could not have.',
        'Single task = single problem (caveat C0). Repeats measure within-problem nondeterminism, not between-problem variance.',
        'Grading is all-or-nothing, so FAIL cells are not distinguished by how close they came.',
        'total_prompt_tokens is RAW and CUMULATIVE across turns — the right denominator for a cost claim, since every turn re-sends the prefix. The local server reports no cache counters, so this is billed volume, not cache-adjusted cost.',
        'wall_seconds includes server-side prefix caching, which makes re-sent tokens nearly free in TIME though still billed. Tokens and time can therefore move in opposite directions; both are reported and neither substitutes for the other.',
        'This host is shared with other work, so wall-clock carries ambient noise. Report the per-turn median alongside the total, and treat a time delta smaller than the between-repeat spread as no effect.',
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
  console.error('  arm           n  pass   score  phase  turns  fires   totalTok   Δtok%   wall_s   Δwall%');
  for (const s of summary) console.error(`  ${s.arm.padEnd(12)} ${String(s.n).padStart(2)}  ${String(s.passes + '/' + s.n).padStart(4)}  ${String(s.score_mean === null ? '-' : s.score_mean + '/' + s.score_total).padStart(6)}  ${String(s.phase_mean ?? '-').padStart(5)}  ${String(s.turns_median).padStart(5)}  ${String(s.fires_median).padStart(5)}  ${String(s.tokens_median).padStart(9)}  ${String(s.tokens_delta_pct ?? '—').padStart(6)}  ${String(s.wall_seconds_median).padStart(6)}  ${String(s.wall_delta_pct ?? '—').padStart(6)}`);
  console.error('\n  PROGRESS AT TERMINATION:');
  for (const s3 of summary) console.error(`    ${s3.arm.padEnd(14)} furthest=${s3.phase_furthest}/${cells[0]?.phases_total ?? '?'}  mean=${s3.phase_mean}  peakPromptTok=${s3.peak_prompt_tokens_median}  ${JSON.stringify(s3.terminated)}`);
  if (!PASSIVE && baseRow) { console.error('\n  DECISION:'); for (const row of summary) if (row.arm !== 'none') console.error(`    ${row.arm.padEnd(14)} ${row.verdict}`); }
  if (gate) { console.error('\n  PILOT GATE:'); for (const [k, v] of Object.entries(gate)) console.error(`    ${k.padEnd(30)} ${v}`); }
  console.error(`\n  written: ${path}`);
  if (capIndex) console.error(`  transcripts: ${relative(pjoin(HERE, '..', '..'), capIndex)}  (${cells.length} cells, L0 events.jsonl + L2 blobs/)`);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
