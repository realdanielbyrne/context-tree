/**
 * ============================================================================
 * EXPERIMENT: flex-buffer assembler redesign — cache economics (offline)
 * ============================================================================
 *
 * Results: reports/metrics/assembler-flex-buffer/results.json
 *
 * PROPOSAL UNDER TEST (operator's redesign)
 * -----------------------------------------
 *  - Zone A grows to hold system + steering + ALL user prompts (append-only), so
 *    user intent is never evicted.
 *  - Zones B and C merge into ONE flex-fill buffer holding a varying mix of
 *    representations (single-line ref / summary / whole raw result) up to a soft
 *    target.
 *
 * THE QUESTION: does the cache economics close? Zone B is separate today ONLY for
 * cache stability (D5). A flex buffer that RE-PICKS its mix each turn rewrites the
 * cached prefix and pays cacheWrite (1.25x) every turn — the cache-killer. The
 * hypothesised fix is append-mostly + sticky representation + a secondary
 * breakpoint (layout R), so the buffer's head stays cached and only its tail
 * re-sends. This run measures that against the real multi-turn cache model.
 *
 * METHOD: a deterministic simulated session (units accrue; phases close; user
 * prompts arrive). For each design VARIANT, build the per-turn AssembledPrompt and
 * feed it to the SHIPPED ProviderCacheSimulator. Effective input cost per turn =
 * 0.1*cacheRead + 1.25*cacheWrite + 1.0*fresh (Anthropic multipliers, cost.ts).
 *
 * VARIANTS
 *  - current-zones      : Zone A frozen + Zone B (summaries, creation order, cached)
 *                         + Zone C (open phase raw, rewritten each turn). Today's shape.
 *  - flex-remix         : Zone A frozen + one buffer re-ranked by relevance each
 *                         turn (cache-death baseline — order churns after Zone A).
 *  - flex-append-sticky : Zone A = system+steering+all user prompts (append-only)
 *                         + flex buffer, creation order, sticky representation,
 *                         secondary breakpoint after the stable head, soft target.
 *
 * CAVEAT: synthetic session; token sizes are stylised. This measures the CACHE
 * MECHANICS (does the design invalidate the prefix, and what it costs), not task
 * quality — that is live-only. The relative ordering across variants is the result.
 * RERUN: node flex-buffer-cache.mjs   (needs @context-tree/core built)
 * ============================================================================
 */
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const OUT_DIR = join(REPO, 'reports', 'metrics', 'assembler-flex-buffer');
const D = (p) => join(REPO, 'packages', 'core', 'dist', p);
const { HeuristicTokenizer } = await import(D('tokens/index.js'));
const { ProviderCacheSimulator } = await import(D('cache/index.js'));
function gitSha() { try { return execSync('git rev-parse HEAD', { cwd: REPO }).toString().trim(); } catch { return null; } }

const W = 40000;
const TURNS = 50;
const UNITS_PER_PHASE = 5;
const USER_EVERY = 6;
const TOK = { system: 1000, tools: 2000, steering: 1500, userPrompt: 300, raw: 2000, summary: 200, ref: 20 };
const COST = { read: 0.1, write: 1.25, fresh: 1.0 }; // Anthropic multipliers (cost.ts)

// SHARED CONTENT (identical across variants so only LAYOUT/order/breakpoints differ):
// closed-phase units render as summaries, the open phase's units render as raw,
// plus the user-prompt units. Variants place/order/pin/break these differently.
function contentBlocks(s) {
  const summaries = []; for (let p = 0; p < s.closedPhases; p++) summaries.push({ id: `sum:phase${p}`, tokens: TOK.summary });
  const raw = s.units.filter((u) => u.phase === s.openPhase).map((u) => ({ id: `raw:${u.id}`, tokens: TOK.raw }));
  const users = s.userPrompts.map((p) => ({ id: `user:${p}`, tokens: TOK.userPrompt }));
  return { summaries, raw, users };
}

const text = (n) => `t${'ok '.repeat(Math.max(1, n))}`; // ~n tokens under HeuristicTokenizer
const blk = (zone, id, tokens) => ({ zone, id, text: text(tokens), tokens });

// ---- simulated session state at turn t (0-based): units 0..t, phases, user prompts ----
function stateAt(t) {
  const units = []; for (let i = 0; i <= t; i++) units.push({ id: `u${i}`, phase: Math.floor(i / UNITS_PER_PHASE) });
  const openPhase = Math.floor(t / UNITS_PER_PHASE);
  const closedPhases = openPhase; // phases 0..openPhase-1 are closed
  const userPrompts = []; for (let i = 0; i * USER_EVERY <= t; i++) userPrompts.push(`p${i}`);
  return { units, openPhase, closedPhases, userPrompts };
}

// ---- per-variant AssembledPrompt builders (SAME content, different layout) ----
// current-zones: [system,tools][summaries creation-order, cached][user prompts + open-phase raw, recent, re-sent]
function currentZones(t) {
  const s = stateAt(t); const c = contentBlocks(s);
  const blocks = [blk('A', 'A:system', TOK.system), blk('A', 'A:tools', TOK.tools)];
  const bp = ['A:tools'];
  for (const sm of c.summaries) blocks.push(blk('B', `B:${sm.id}`, sm.tokens));
  if (c.summaries.length) bp.push(`B:${c.summaries[c.summaries.length - 1].id}`);
  for (const u of c.users) blocks.push(blk('C', `C:${u.id}`, u.tokens)); // user prompts float in recent (not pinned)
  for (const r of c.raw) blocks.push(blk('C', `C:${r.id}`, r.tokens));
  return { blocks, cacheBreakpoints: bp };
}
// flex-remix: [system,tools][ALL content re-ranked by churning relevance each turn] — cache-death baseline
function flexRemix(t) {
  const s = stateAt(t); const c = contentBlocks(s);
  const all = [...c.users, ...c.summaries, ...c.raw];
  const order = all.map((b, i) => ({ b, r: (i * 7 + t * 13) % Math.max(1, all.length) }));
  order.sort((a, b) => a.r - b.r);
  const blocks = [blk('A', 'A:system', TOK.system), blk('A', 'A:tools', TOK.tools)];
  for (const { b } of order) blocks.push(blk('F', `F:${b.id}`, b.tokens));
  return { blocks, cacheBreakpoints: ['A:tools'] };
}
// flex-append-sticky: [system,steering,user prompts append-only][summaries+raw creation-order, secondary bp after stable head]
function flexAppendSticky(t, softFrac) {
  const s = stateAt(t); const c = contentBlocks(s);
  const blocks = [blk('A', 'A:system', TOK.system), blk('A', 'A:steering', TOK.steering)];
  for (const u of c.users) blocks.push(blk('A', `A:${u.id}`, u.tokens)); // user prompts pinned, append-only
  const bp = c.users.length ? [`A:${c.users[c.users.length - 1].id}`] : ['A:steering'];
  // Flex buffer, creation order: stable head = closed-phase summaries; volatile tail = open-phase raw.
  const stable = c.summaries.map((sm) => ({ id: `F:${sm.id}`, tokens: sm.tokens }));
  const volatile = c.raw.map((r) => ({ id: `F:${r.id}`, tokens: r.tokens }));
  // Soft target: bound the buffer by dropping the OLDEST stable summaries first (conservative: keep recent+raw).
  const soft = softFrac * W;
  let used = [...stable, ...volatile].reduce((x, b) => x + b.tokens, 0);
  while (used > soft && stable.length > 0) { used -= stable[0].tokens; stable.shift(); }
  for (const b of stable) blocks.push(blk('F', b.id, b.tokens));
  if (stable.length) bp.push(stable[stable.length - 1].id); // secondary breakpoint after stable head
  for (const b of volatile) blocks.push(blk('F', b.id, b.tokens));
  return { blocks, cacheBreakpoints: bp };
}

function asPrompt(built) {
  return { system: '', blocks: built.blocks, cacheBreakpoints: built.cacheBreakpoints, budgets: {}, deliveryReceipt: { blocks: [] } };
}

function runVariant(name, builder) {
  const tokenizer = new HeuristicTokenizer();
  const sim = new ProviderCacheSimulator({ tokenizer });
  let read = 0, write = 0, fresh = 0, peakTotal = 0;
  const perTurn = [];
  for (let t = 0; t < TURNS; t++) {
    const o = sim.submit(asPrompt(builder(t)));
    read += o.cacheRead; write += o.cacheWrite; fresh += o.fresh;
    peakTotal = Math.max(peakTotal, o.total);
    perTurn.push({ t, total: o.total, cacheRead: o.cacheRead, cacheWrite: o.cacheWrite, fresh: o.fresh, divergedInZone: o.divergedInZone });
  }
  const effective = COST.read * read + COST.write * write + COST.fresh * fresh;
  const naive = perTurn.reduce((s, x) => s + x.total, 0); // cost if nothing cached (all fresh)
  return { name, totalRead: read, totalWrite: write, totalFresh: fresh, effectiveInputCost: Math.round(effective),
    naiveCost: naive, cacheSavingsPct: +(100 * (1 - effective / naive)).toFixed(1), peakOccupancy: +(peakTotal / W).toFixed(3), perTurn };
}

function main() {
  const variants = [
    runVariant('current-zones', currentZones),
    runVariant('flex-remix', flexRemix),
    runVariant('flex-append-sticky@0.4', (t) => flexAppendSticky(t, 0.4)),
    runVariant('flex-append-sticky@0.25', (t) => flexAppendSticky(t, 0.25)),
    runVariant('flex-append-sticky@0.5', (t) => flexAppendSticky(t, 0.5)),
  ];
  const out = {
    runId: process.env.RUN_ID ?? `assembler-flex-buffer-${new Date().toISOString().slice(0, 10)}`,
    armId: 'flex-buffer-cache@v1', offline: true, deterministic: true, model: null,
    commit: gitSha(), date: new Date().toISOString(),
    setup: { window: W, turns: TURNS, unitsPerPhase: UNITS_PER_PHASE, userEvery: USER_EVERY, tokens: TOK, costMultipliers: COST },
    simulator: 'shipped ProviderCacheSimulator (packages/core/src/cache)',
    caveat: 'Synthetic session; stylised token sizes. Measures CACHE MECHANICS (prefix invalidation + cost), not task quality (live-only). Relative ordering is the result.',
    variants: variants.map(({ perTurn, ...v }) => v),
    perTurnByVariant: Object.fromEntries(variants.map((v) => [v.name, v.perTurn])),
  };
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'results.json'), JSON.stringify(out, null, 2));

  console.log(`session: ${TURNS} turns, W=${W} | cost = 0.1*read + 1.25*write + 1.0*fresh (Anthropic)`);
  console.log('\nvariant'.padEnd(26) + 'effCost'.padStart(10) + 'vsNaive'.padStart(9) + 'read'.padStart(9) + 'write'.padStart(9) + 'fresh'.padStart(9) + 'peakOcc'.padStart(9));
  for (const v of variants) {
    console.log(v.name.padEnd(26) + String(v.effectiveInputCost).padStart(10) + `${v.cacheSavingsPct}%`.padStart(9) +
      String(v.totalRead).padStart(9) + String(v.totalWrite).padStart(9) + String(v.totalFresh).padStart(9) + `${(v.peakOccupancy * 100).toFixed(0)}%`.padStart(9));
  }
  console.log('\neffCost = total effective input tokens over the session (lower = cheaper); vsNaive = % saved vs no cache.');
  console.log(`wrote ${join('reports', 'metrics', 'assembler-flex-buffer', 'results.json')}`);
}

main();
