/**
 * TIER 2 (LIVE) — does LRU-at-g* eviction preserve the task while cutting context?
 *
 * Tier 1 showed backward idle predicts forward cold (offline). This asks the only
 * question that can make it canon: run a real agent on a retention task and see
 * whether evicting units idle > g* turns keeps the task passable — in BOTH regimes:
 *   overflow  (small window): append-all overflows; does idle-g* survive like recency?
 *   ample     (large window): append-all fits cheaply; does idle-g* AVOID hurting?
 *
 * One variable: the eviction policy.
 *   none        — append-all (current frameworks); the large-window baseline.
 *   recency     — keep the most-recent units that fit BUDGET (the tuned baseline).
 *   random      — CONTROL: evict RANDOM non-anchor units to BUDGET (seeded, so it
 *                 reruns identically). Ablates the selection signal at matched
 *                 volume: if recency/idle-gstar pass where random fails, the signal
 *                 is doing the work, not merely shrinking context.
 *   idle-gstar  — drop any non-anchor unit idle > g* turns (the derived rule; no
 *                 budget tuning — the threshold IS w/r).
 *
 * Retention task (from coding-harness/integration-full): read 4 catalogs, sum the
 * four buried prices (=139), write to answer.txt. Success = /\b139\b/.
 *
 * LIVE: needs the local model server (CT_LOCAL_BASE_URL, UNSLOTH_API_KEY) and a
 * model id in CT_LOCAL_MODEL. Rerun (overflow then ample):
 *   set -a; . ./.env; set +a
 *   CT_LOCAL_MODEL=unsloth/Qwen3.8-Flash-Next-GGUF CT_BUDGET=6800 \
 *     node experiments/context-dedup/tier2-idle-eviction.mjs overflow
 *   CT_LOCAL_MODEL=unsloth/Qwen3.8-27B-GGUF CT_BUDGET=200000 \
 *     node experiments/context-dedup/tier2-idle-eviction.mjs ample
 */
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runAgent, makeWorkspace, evictRecency, extractUnits, estTokens, MODEL } from '../coding-harness/lib.mjs';
import { writeResults, gitSha, nowISO } from '../rung-1-live-probe/lib.mjs';

const REGIME = process.argv[2] ?? 'overflow';
const BUDGET = +(process.env.CT_BUDGET || 6800);
const GSTAR = +(process.env.CT_GSTAR || 12); // idle>g* → evict; 12 ≈ w/r=12.5 in whole turns
const MAX_TURNS = +(process.env.CT_MAX_TURNS || 40);
const ANCHOR = +(process.env.CT_ANCHOR || 4);
const ARMS = (process.env.CT_ARMS || 'none,recency,random,idle-gstar').split(',');
// Restrict the toolset so the model cannot self-retrieve via grep (run_bash), which
// otherwise keeps the working set tiny and eviction never fires. Default: reads/writes only.
const ALLOWED_TOOLS = (process.env.CT_ALLOWED_TOOLS || 'read_file,write_file,list_files').split(',');

// Seeded RNG (mulberry32) so the random control reruns identically.
let _seed = 0x9e3779b9;
const resetRng = () => { _seed = 0x9e3779b9; };
function rng() {
  _seed = (_seed + 0x6d2b79f5) | 0;
  let t = Math.imul(_seed ^ (_seed >>> 15), 1 | _seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function rebuildLocal(messages, pinned, keptUnits) {
  const next = [...pinned, ...keptUnits.flatMap((u) => u.slice)];
  messages.length = 0;
  messages.push(...next);
}

const ITEMS = [{ file: 'widget_catalog.md', name: 'Widget', price: 13 }, { file: 'gadget_catalog.md', name: 'Gadget', price: 27 },
  { file: 'gizmo_catalog.md', name: 'Gizmo', price: 41 }, { file: 'doohickey_catalog.md', name: 'Doohickey', price: 58 }];
const TOTAL = ITEMS.reduce((s, i) => s + i.price, 0); // 139
function seed(ws) {
  const secs = ['Overview', 'Specifications', 'Materials', 'Assembly', 'Warranty', 'Compliance', 'Shipping', 'Returns', 'Support', 'Maintenance'];
  const filler = (s, n) => (`The ${s} section of the ${n} catalog details conventions, procedures, and expectations at length. Integrators should review this and cross-reference parameters. `).repeat(15);
  for (const it of ITEMS) {
    const lines = [`# ${it.name} Catalog`, ''];
    for (const s of secs) { lines.push(`## ${s}`, filler(s, it.name)); if (s === 'Specifications') lines.push(`Pricing note: the ${it.name} unit price is ${it.price} dollars per unit.`); lines.push(''); }
    writeFileSync(join(ws, it.file), lines.join('\n'));
  }
}
const SYSTEM = 'You are an agent in a workspace. Use the tools to read files and run commands. Work step by step; when finished reply with a short message containing DONE and no tool call.';
const TASK = `Four catalogs are in the workspace: ${ITEMS.map((i) => i.file).join(', ')}. Read each and find its product unit price. Write ONLY the integer sum of the four prices to answer.txt, then reply DONE.`;

/** LRU-at-g*: drop any non-anchor unit whose fingerprints have gone unreferenced for > g* units. */
function evictIdle(messages, g) {
  const { pinned, units } = extractUnits(messages);
  const N = units.length;
  const lastRef = units.map((u, i) => { let last = i; for (let j = N - 1; j > i; j--) if ([...u.fp].some((f) => units[j].fp.has(f))) { last = j; break; } return last; });
  const anchor = new Set(Array.from({ length: Math.min(ANCHOR, N) }, (_, k) => N - 1 - k));
  const kept = units.filter((u, i) => anchor.has(i) || (N - 1 - lastRef[i]) <= g);
  if (kept.length === N) return false;
  const next = [...pinned, ...kept.flatMap((u) => u.slice)];
  messages.length = 0; messages.push(...next);
  return true;
}

function evictorFor(arm) {
  if (arm === 'none') return () => false;
  if (arm === 'recency') return (m) => evictRecency(m, BUDGET);
  if (arm === 'idle-gstar') return (m) => evictIdle(m, GSTAR);
  throw new Error(`unknown arm ${arm}`);
}

async function runArm(arm) {
  const ws = makeWorkspace(); seed(ws);
  const track = { peak: 0, evictions: 0 };
  const evict = evictorFor(arm);
  const hook = async (m) => { track.peak = Math.max(track.peak, estTokens(m)); if (await evict(m)) track.evictions++; };
  let err = null, r = null;
  try { r = await runAgent({ system: SYSTEM, task: TASK, ws, maxTurns: MAX_TURNS, hook }); }
  catch (e) { err = String(e.message || e).slice(0, 200); }
  let answer = ''; try { answer = execSync('cat answer.txt', { cwd: ws, timeout: 5000 }).toString().trim(); } catch { answer = '(none)'; }
  const reads = r ? r.toolLog.filter((t) => t.name === 'read_file').length : 0;
  const distinctReads = r ? new Set(r.toolLog.filter((t) => t.name === 'read_file').map((t) => t.args?.path)).size : 0;
  return { arm, success: /\b139\b/.test(answer), answer: answer.slice(0, 30), turns: r?.turns ?? null, stop: r?.stop ?? 'error',
    evictions: track.evictions, peak_history_tokens: track.peak, reads, rereads: reads - distinctReads,
    total_prompt_tokens: r ? r.usage.reduce((s, u) => s + (u.prompt_tokens || 0), 0) : 0, error: err };
}

async function main() {
  const arms = [];
  for (const arm of ARMS) { console.error(`\n--- [${REGIME}] ${arm} ---`); arms.push(await runArm(arm)); }
  const out = {
    manifest: {
      run_id: `tier2-idle-eviction-${REGIME}-${Date.now()}`, experiment: `context-dedup / Tier 2 idle-eviction (${REGIME})`,
      regime: REGIME, model: MODEL, budget: BUDGET, g_star: GSTAR, max_turns: MAX_TURNS, anchor: ANCHOR, correct_sum: TOTAL,
      commit: gitSha(), date: nowISO(),
      falsification: 'idle-gstar must PASS in the overflow regime (like recency, unlike append-all) AND not lose PASS vs append-all in the ample regime; otherwise the derived g* threshold is not usable as-is.',
      caveats: ['n=1 per arm, temp 0.', 'total_prompt_tokens is RAW (the local server may not do Anthropic-style prompt caching); this measures task survival + raw context, not cached cost (DV2 covers cached cost).', 'g* in whole turns (12 ≈ w/r 12.5).'],
    }, arms,
  };
  const path = writeResults('context-dedup', `results-tier2-${REGIME}.json`, out);
  console.error(`\n=== TIER 2 [${REGIME}] model=${MODEL} budget=${BUDGET} g*=${GSTAR} ===  [success|turns|evict|reads|rereads|peakTok|totalTok]`);
  for (const a of arms) console.error(`  ${a.arm.padEnd(11)} ${a.success ? 'PASS' : 'FAIL'}  turns=${a.turns}  evict=${a.evictions}  reads=${a.reads}  rereads=${a.rereads}  peak=${a.peak_history_tokens}  total=${a.total_prompt_tokens}  ${a.error ? 'ERR=' + a.error : 'ans=' + JSON.stringify(a.answer)}`);
  console.error(`  written: ${path}`);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
