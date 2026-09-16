/**
 * OPENCODE RUNNER — runs a scenario as real opencode sessions, one cell per arm/repeat.
 *
 * Per D20 the host is opencode, not an in-repo harness. Everything the bespoke harness
 * had to fake, opencode does natively:
 *   - tool calls are represented properly (the defect that voided the deleted eval/ harness)
 *   - the mid-run user turn is a REAL second user message (`run --session <id>`), not a
 *     hook bolted onto a loop that exits the moment the agent stops calling tools
 *   - transcripts come from `export <sessionID>`
 *   - the intervention attaches at `tool.execute.after`
 *
 * THE HYPOTHESIS: an anchor saves cumulative tokens AND wall-clock to completion at
 * equal task success. Both are primary; neither substitutes for the other, because
 * providers cache prefixes (re-sent tokens are cheap in TIME while still billed).
 *
 * Operational notes learned the hard way:
 *   - `--format json` HANGS. Do not use it. Session ids come from --print-logs.
 *   - a lingering opencode server causes intermittent hangs, so every cell gets fresh
 *     XDG_* directories.
 *   - `--pure` disables external plugins, i.e. the arms. Never pass it when an arm is active.
 *   - NEVER kill opencode host-wide. A parallel session shares this machine; a
 *     `pkill opencode` takes out its runs too. Clean up only PIDs this runner launched.
 *   - the local host serves 4 concurrent connections and opencode makes a model call
 *     during init (`small=true agent=title`) BEFORE session creation. With every slot
 *     busy that call blocks and the run "hangs at init" with no session, no error and no
 *     log line — silent, and easily misread as a stale-server bug. Take a lease.
 *   - a plugin registering only `chat.params` HUNG opencode at init (never reached session
 *     creation). Sampling is therefore left at opencode's default, which is identical for
 *     every arm, so the arms still differ solely in tool-result substitution.
 *   - the model reasons, and that is left alone: it is how the model really behaves, and
 *     with reasoning on a smaller context may also mean less to re-reason over each turn.
 *     Requires limit.output well above the reasoning budget — at 16384 the model spent the
 *     entire cap reasoning, emitted no tool call, and every run wrote zero files.
 *
 * Rerun:
 *   set -a; . ./.env; set +a
 *   CT_ARMS=none,anchor,anchor-topk,placebo CT_REPEATS=3 node experiments/context-dedup/oc-runner.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeResults, gitSha, nowISO } from '../rung-1-live-probe/lib.mjs';
import { acquireSlots } from './swebench-endpoint.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const PLUGIN = join(HERE, 'oc-plugin', 'anchor-plugin.mjs');
const BASE_CFG = join(HERE, 'opencode.json');

const SCENARIO = process.env.CT_SCENARIO || 'flapsim';
const TASK_MOD = process.env.CT_TASK || 'flapsim';
const ARMS = (process.env.CT_ARMS || 'none,anchor,anchor-topk,placebo').split(',');
const REPEATS = +(process.env.CT_REPEATS || 3);
const MODEL = process.env.CT_OC_MODEL || 'local/unsloth/Qwen3.8-27B-GGUF';
const TOPK = +(process.env.CT_ANCHOR_TOPK || 2);
const TURN_TIMEOUT = +(process.env.CT_TURN_TIMEOUT || 2400);
const TAG = process.env.CT_TAG || 'v1';

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', timeout: (opts.timeoutSec ?? TURN_TIMEOUT) * 1000, ...opts });

function runTurn({ ws, env, message, sessionId, logPath }) {
  const args = ['run', '--print-logs', '--log-level', 'INFO', '--dir', ws, '-m', MODEL];
  if (sessionId) args.push('--session', sessionId);
  args.push(message);
  const t0 = Date.now();
  const r = sh('opencode', args, { cwd: ws, env });
  const seconds = +((Date.now() - t0) / 1000).toFixed(1);
  const err = r.stderr || '';
  writeFileSync(logPath, `${r.stdout || ''}\n===STDERR===\n${err}`);
  const sid = sessionId || (err.match(/session\.id=(ses_[A-Za-z0-9]+)/) || [])[1] || null;
  return { seconds, sid, stdout: r.stdout || '', status: r.status, timedOut: r.error?.code === 'ETIMEDOUT' };
}

async function runCell(task, arm, repeat, outDir) {
  const ws = mkdtempSync(join(tmpdir(), `oc-${arm}-`));
  const xdg = mkdtempSync(join(tmpdir(), 'ocx-'));     // fresh per cell: a lingering server hangs runs
  const cellDir = join(outDir, `${arm}-rep${repeat}`);
  mkdirSync(cellDir, { recursive: true });
  task.seed(ws);

  const cfg = JSON.parse(readFileSync(BASE_CFG, 'utf8'));
  if (arm !== 'none') cfg.plugin = [PLUGIN];
  const cfgPath = join(cellDir, 'opencode.json');
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  const eventsPath = join(cellDir, 'anchor-events.jsonl');
  writeFileSync(eventsPath, '');
  const env = { ...process.env,
    XDG_CONFIG_HOME: join(xdg, 'cfg'), XDG_DATA_HOME: join(xdg, 'data'),
    XDG_STATE_HOME: join(xdg, 'state'), XDG_CACHE_HOME: join(xdg, 'cache'),
    OPENCODE_CONFIG: cfgPath,
    CT_ARM: arm, CT_ANCHOR_TOPK: String(TOPK), CT_ANCHOR_EVENTS: eventsPath };

  const turns = task.scenario.turns;
  const log = [];
  let sid = null, totalSeconds = 0, timedOut = false;

  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    // A follow-up turn is released only once the WORKSPACE says its milestone is met,
    // so every arm receives it at the same logical stage, not the same turn number.
    let via = 'gate';
    if (i > 0) {
      const { evalGate } = await import('../scenarios/load.mjs');
      if (!evalGate(ws, t.gate)) via = 'unmet-milestone';   // sent anyway; recorded as a confound
    }
    const r = runTurn({ ws, env, message: t.text, sessionId: sid, logPath: join(cellDir, `turn${i + 1}.log`) });
    sid = r.sid || sid;
    totalSeconds += r.seconds;
    timedOut = timedOut || r.timedOut;
    log.push({ turn_id: t.id, index: i, seconds: r.seconds, via, session: sid, timed_out: r.timedOut, status: r.status });
    if (r.timedOut) break;
  }

  // transcript straight from the host
  let messages = 0, usage = { input: 0, output: 0, cost: 0, reasoningParts: 0, reasoningChars: 0 };
  if (sid) {
    // Redirect to a file: spawnSync's captured buffer silently TRUNCATED a 222,750-byte
    // transcript to 146,176 bytes mid-string, so the JSON failed to parse and every token
    // count came out 0 — which reads as "the run used no tokens", not "capture broke".
    const trPath = join(cellDir, 'transcript.json');
    spawnSync('sh', ['-c', `opencode export ${sid} > ${JSON.stringify(trPath)}`], { cwd: ws, env, timeout: 180000 });
    const ex = { stdout: existsSync(trPath) ? readFileSync(trPath, 'utf8') : '' };
    if (ex.stdout) {
      try {
        const t = JSON.parse(ex.stdout);
        messages = (t.messages || []).length;
        for (const m of t.messages || []) {
          const u = (m.info || m).tokens || {};
          usage.input += (u.input || 0) + (u.cache?.read || 0) + (u.cache?.write || 0);
          usage.output += u.output || 0;
          usage.cost += (m.info || m).cost || 0;
          // The local host THINKS but reports reasoning_tokens: 0, so reasoning must be
          // measured from the export's reasoning PARTS or local and OpenRouter numbers
          // are not comparable. Chars, not tokens — the only honest unit available here.
          for (const part of m.parts || []) {
            if (part.type === 'reasoning') { usage.reasoningParts += 1; usage.reasoningChars += String(part.text || '').length; }
          }
        }
      } catch {}
    }
  }

  const events = readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const fired = events.filter((e) => e.fired);
  const score = task.score ? task.score(ws) : null;
  const metrics = task.metrics ? task.metrics(ws) : {};
  writeFileSync(join(cellDir, 'workspace-listing.json'), JSON.stringify({ ws, metrics }, null, 2));

  return {
    arm, repeat, session: sid, ws, cell_dir: cellDir.replace(REPO + '/', ''),
    pass: task.grade ? task.grade(ws) : null,
    score_correct: score?.correct ?? null, score_total: score?.total ?? null, score_parts: score?.parts ?? null,
    ...metrics,
    turns_released: log.length, turn_log: log,
    wall_seconds: +totalSeconds.toFixed(1), timed_out: timedOut,
    messages, prompt_tokens: usage.input, output_tokens: usage.output, cost_usd: +usage.cost.toFixed(6),
    reasoning_parts: usage.reasoningParts, reasoning_chars: usage.reasoningChars,
    would_fire: events.length, fires: fired.length,
    by_kind: events.reduce((a, e) => ((a[e.kind] = (a[e.kind] || 0) + 1), a), {}),
    anchor_untruthful: events.filter((e) => e.fired && !e.anchor_truthful).length,
    degenerate_topk: events.filter((e) => e.degenerate_topk).length,
    replaced_chars: fired.reduce((s, e) => s + e.real_chars, 0),
    substituted_chars: fired.reduce((s, e) => s + (e.substituted_chars || 0), 0),
  };
}

const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };

async function main() {
  // A missing key does not error — opencode reports "Not authenticated" per stream and
  // the cell completes in 3s with 0 tokens, which reads exactly like a task failure.
  // Fail loudly instead.
  const cfgRaw = readFileSync(BASE_CFG, 'utf8');
  for (const m of cfgRaw.matchAll(/\{env:([A-Z0-9_]+)\}/g)) {
    if (!process.env[m[1]]) throw new Error(`${m[1]} is not set — run: set -a; . ./.env; set +a`);
  }
  const task = (await import(join(HERE, 'ab-tasks', `${TASK_MOD}.mjs`))).default;
  const runId = `oc-${SCENARIO}-${TAG}-${Date.now()}`;
  const outDir = join(REPO, 'reports', 'metrics', 'context-dedup', 'captures', runId);
  mkdirSync(outDir, { recursive: true });

  const cells = [];
  for (let rep = 0; rep < REPEATS; rep++) for (const arm of ARMS) {
    process.stderr.write(`\n--- rep${rep} ${arm} ---\n`);
    // One non-exclusive slot, so the parallel session's scan counts us exactly rather
    // than by process inspection, and so we never oversubscribe the 4-connection host.
    const lease = acquireSlots({ exclusive: false });
    if (!lease.slots?.length) process.stderr.write('    (no local slot free — proceeding; init may block)\n');
    let c; try { c = await runCell(task, arm, rep, outDir); } finally { lease.release?.(); }
    cells.push(c);
    process.stderr.write(`    ${c.pass ? 'PASS' : 'FAIL'} score=${c.score_correct}/${c.score_total} milestones=${(c.phases_done || []).length}/${(c.phases_total ?? 9) + 1} fires=${c.fires}/${c.would_fire} tok=${c.prompt_tokens} wall=${c.wall_seconds}s cost=$${c.cost_usd}\n`);
  }

  const summary = ARMS.map((arm) => {
    const cs = cells.filter((c) => c.arm === arm);
    return { arm, n: cs.length, passes: cs.filter((c) => c.pass).length,
      score_mean: +(cs.reduce((a, c) => a + (c.score_correct || 0), 0) / Math.max(1, cs.length)).toFixed(2),
      milestones_mean: +(cs.reduce((a, c) => a + ((c.phases_done || []).length), 0) / Math.max(1, cs.length)).toFixed(2),
      prompt_tokens_median: med(cs.map((c) => c.prompt_tokens)),
      reasoning_chars_median: med(cs.map((c) => c.reasoning_chars || 0)),
      wall_seconds_median: med(cs.map((c) => c.wall_seconds)),
      cost_usd_total: +cs.reduce((a, c) => a + c.cost_usd, 0).toFixed(4),
      fires_median: med(cs.map((c) => c.fires)), would_fire_median: med(cs.map((c) => c.would_fire)),
      anchor_untruthful_total: cs.reduce((a, c) => a + c.anchor_untruthful, 0),
      degenerate_topk_total: cs.reduce((a, c) => a + c.degenerate_topk, 0),
      timed_out: cs.filter((c) => c.timed_out).length };
  });
  const base = summary.find((s) => s.arm === 'none');
  if (base) for (const s of summary) {
    s.tokens_delta_pct = base.prompt_tokens_median ? +(100 * (1 - s.prompt_tokens_median / base.prompt_tokens_median)).toFixed(2) : null;
    s.wall_delta_pct = base.wall_seconds_median ? +(100 * (1 - s.wall_seconds_median / base.wall_seconds_median)).toFixed(2) : null;
    s.score_delta = +(s.score_mean - base.score_mean).toFixed(2);
    s.verdict = s.arm === 'none' ? '—'
      : s.anchor_untruthful_total > 0 ? 'INVALID — an anchor asserted something untrue'
      : s.score_delta < -1 ? 'LEAVE OUT — task score degraded'
      : (s.tokens_delta_pct > 0 && s.wall_delta_pct > 0) ? 'FOLD IN — saves tokens and time at equal score'
      : s.tokens_delta_pct <= 0 ? 'LEAVE OUT — no token saving'
      : 'LEAVE OUT — tokens saved but no wall-clock saving';
  }

  const out = { manifest: {
      run_id: runId, experiment: `context-dedup / anchor arms on opencode (${SCENARIO})`,
      host: 'opencode', host_version: (spawnSync('opencode', ['--version'], { encoding: 'utf8' }).stdout || '').trim(),
      model: MODEL, task: task.name, commit: gitSha(), date: nowISO(),
      params: { arms: ARMS, repeats: REPEATS, top_k: TOPK, turn_timeout_s: TURN_TIMEOUT },
      hypothesis: 'Returning an anchor (or an anchor plus the most relevant chunks of the resident copy) instead of content the model already has reduces cumulative prompt tokens AND wall-clock time to completion, at no cost to task success. If it does, fold it into context-tree; if not, leave it out.',
      falsification: 'FOLD IN only if an arm cuts BOTH tokens and wall-clock against the no-intervention arm at score within noise. Any fired anchor that was not truthful invalidates the run.',
      caveats: [
        'Host is opencode per D20; the previous in-repo harness could not represent a tool call and is not used.',
        'NO eviction and NO window cap: the context is append-only, so residency is by construction and every anchor is truthful; clipped results are detected and suppressed rather than anchored.',
        'The mid-run user turn is a real second user message via `run --session`, released on a WORKSPACE predicate so every arm gets it at the same logical stage; `via` is recorded and a between-arm difference in it is a confound, not a result.',
        'Wall-clock is measured on a shared host and includes provider prefix caching, so tokens and time can move independently; treat a delta inside the between-repeat spread as no effect.',
        'Single scenario = single problem (caveat C0): repeats measure within-problem nondeterminism, not between-problem variance.',
        'The model REASONS and that is left alone — it is how the model really behaves, and with reasoning on a smaller context may also mean less to re-reason over per turn. Reasoning is measured from the export reasoning PARTS (chars), because the local host reports reasoning_tokens: 0 while genuinely reasoning; token counts alone would undercount it and would not be comparable with OpenRouter.',
        'The local host serves 4 concurrent connections and this runner takes one non-exclusive lease per cell. With all slots busy, opencode blocks during its init title call and the run hangs with no error — so a hang is a scheduling symptom, not necessarily a task failure.',
      ] }, summary, cells };

  const p = writeResults('context-dedup', `results-oc-${SCENARIO}-${TAG}.json`, out);
  console.error(`\n=== ANCHOR ARMS ON OPENCODE [${task.name}] model=${MODEL} n=${REPEATS} ===`);
  console.error('  arm           n  pass  score  miles  fires  promptTok   Δtok%   wall_s   Δwall%   cost$');
  for (const s of summary) console.error(`  ${s.arm.padEnd(12)} ${String(s.n).padStart(2)}  ${String(s.passes).padStart(4)}  ${String(s.score_mean).padStart(5)}  ${String(s.milestones_mean).padStart(5)}  ${String(s.fires_median).padStart(5)}  ${String(s.prompt_tokens_median).padStart(9)}  ${String(s.tokens_delta_pct ?? '—').padStart(6)}  ${String(s.wall_seconds_median).padStart(6)}  ${String(s.wall_delta_pct ?? '—').padStart(6)}  ${s.cost_usd_total}`);
  console.error('\n  DECISION:');
  for (const s of summary) if (s.arm !== 'none') console.error(`    ${s.arm.padEnd(14)} ${s.verdict}`);
  console.error(`\n  written: ${p}\n  transcripts: ${outDir.replace(REPO + '/', '')}`);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
