/**
 * DV3 — eviction CADENCE and cache TTL. CPU-only; no model, no GPU.
 *
 * Attacks two gaps in DV2 that the handoff's C2 overstated:
 *   (1) DV2's single-version arm mutated the prefix on EVERY swap (cadence N=1, the
 *       worst case) and I generalised that to "append-only is cache-optimal below
 *       the window". Mutation is charged PER-MUTATION while the read discount
 *       accrues PER-TURN, so evicting every N turns should win once
 *       N*r*(C_large - C_small) > w*S. This sweeps N to find the crossover.
 *   (2) DV2 modelled NO cache TTL (review finding M7). Real caches expire (5 min,
 *       or 1 hour on a subscription), and on resumption the WHOLE prompt re-caches
 *       at write rate — which is the regime long sessions actually live in.
 *
 * Also reports the tier dependence of g* = w/r: providers price the long-TTL write
 * above the short-TTL write, so g* is not the single constant 12.5 the handoff
 * previously implied.
 *
 * Rerun: node experiments/context-dedup/dv3-cadence-ttl.mjs
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProviderCacheSimulator, ANTHROPIC_PROFILE, cacheReport } from '../../packages/core/dist/cache/index.js';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'reports', 'metrics', 'context-dedup');
const tokenizer = { id: 'chars4', count: (t) => Math.ceil(t.length / 4) };
const tok = (n) => 'tok '.repeat(Math.max(1, n));          // n tokens under chars4

// Session shape
const T = +(process.env.CT_TURNS || 120);       // turns
const H = +(process.env.CT_HEAD || 2000);       // frozen head: system + steering + prompts ("always keep")
const U = +(process.env.CT_UNIT || 500);        // tokens added per turn
const W = +(process.env.CT_WINDOW || 12000);    // small-window cap
const CADENCES = [1, 5, 10, 25, 50];
// Anthropic-style multipliers. The long-TTL write tier is priced ABOVE the short one.
const TIERS = [
  { name: '5-min TTL', read: 0.1, write: 1.25, ttlTurns: Infinity },
  { name: '1-hour TTL', read: 0.1, write: 2.0, ttlTurns: Infinity },
];
const HEAD = { id: 'head', zone: 'head', text: tok(H) };

/**
 * Run a session under a retention policy.
 *  cadence = Infinity -> append-only (never evict)
 *  coldAt  = turn indices where the cache has EXPIRED (fresh simulator = cold prefix)
 */
function runSession({ cadence, cap, coldAt = new Set(), read, write }) {
  let sim = new ProviderCacheSimulator({ tokenizer, profile: ANTHROPIC_PROFILE });
  let reports = [];
  const units = [];               // ids of units currently in context, oldest first
  let evictions = 0, coldStarts = 0;
  for (let t = 0; t < T; t++) {
    units.push(t);
    // eviction fires only on cadence turns, and only if over the cap
    if (cadence !== Infinity && t % cadence === 0) {
      let before = units.length;
      while (H + units.length * U > cap && units.length > 1) units.shift();  // drop OLDEST
      if (units.length !== before) evictions++;
    }
    if (coldAt.has(t)) {          // TTL expiry: cached prefix is gone
      reports.push(cacheReport(sim.outcomes()));
      sim = new ProviderCacheSimulator({ tokenizer, profile: ANTHROPIC_PROFILE });
      coldStarts++;
    }
    const blocks = [HEAD, ...units.map((i) => ({ id: `u${i}`, zone: 'flex', text: tok(U) }))];
    sim.submit({ system: '', blocks, budgets: {}, cacheBreakpoints: ['head', blocks[blocks.length - 1].id] });
  }
  reports.push(cacheReport(sim.outcomes()));
  const agg = reports.reduce((a, r) => ({ cacheRead: a.cacheRead + r.cacheRead, cacheWrite: a.cacheWrite + r.cacheWrite, fresh: a.fresh + r.fresh, total: a.total + r.total }), { cacheRead: 0, cacheWrite: 0, fresh: 0, total: 0 });
  return { ...agg, evictions, coldStarts, eff: agg.cacheRead * read + agg.cacheWrite * write + agg.fresh };
}

const rows = [];
for (const tier of TIERS) {
  for (const scenario of ['continuous', 'resumed x3']) {
    // "resumed": the cache expires 3 times across the session (the normal long-session pattern)
    const coldAt = scenario === 'continuous' ? new Set() : new Set([Math.floor(T * 0.25), Math.floor(T * 0.5), Math.floor(T * 0.75)]);
    const base = runSession({ cadence: Infinity, cap: Infinity, coldAt, read: tier.read, write: tier.write });
    rows.push({ tier: tier.name, scenario, arm: 'append-only (uncapped)', ...base, vsBase: 0 });
    for (const N of CADENCES) {
      const r = runSession({ cadence: N, cap: W, coldAt, read: tier.read, write: tier.write });
      rows.push({ tier: tier.name, scenario, arm: `cap ${W}, evict every ${N}`, ...r, vsBase: 1 - r.eff / base.eff });
    }
  }
}

const M = (v) => (v / 1e6).toFixed(2) + 'M';
const pc = (v) => `${v >= 0 ? '' : '−'}${Math.abs(v * 100).toFixed(1)}%`;
console.log(`DV3 cadence/TTL — T=${T} turns, head=${H}, unit=${U}/turn, cap=${W}`);
console.log('(vs base: positive = CHEAPER than append-only)\n');
let cur = '';
for (const r of rows) {
  const key = `${r.tier} / ${r.scenario}`;
  if (key !== cur) { cur = key; console.log(`--- ${key} ---`); }
  console.log(`  ${r.arm.padEnd(26)} eff=${M(r.eff).padStart(7)}  read=${M(r.cacheRead)} write=${M(r.cacheWrite)}  evictions=${String(r.evictions).padStart(3)}  coldStarts=${r.coldStarts}  vs append-only: ${r.arm.startsWith('append') ? '—' : pc(r.vsBase)}`);
}
const best = {};
for (const r of rows) {
  const k = `${r.tier} / ${r.scenario}`;
  if (!best[k] || r.eff < best[k].eff) best[k] = r;
}
console.log('\n=== cheapest arm per scenario ===');
for (const k in best) console.log(`  ${k.padEnd(28)} -> ${best[k].arm}`);
writeFileSync(join(OUT, 'results-dv3-cadence-ttl.json'), JSON.stringify({
  experiment: 'DV3 / eviction cadence + cache TTL', date: new Date().toISOString(),
  params: { turns: T, head: H, unit: U, cap: W, cadences: CADENCES, tiers: TIERS.map((t) => t.name) },
  rows, cheapest: best,
  caveats: [
    'SIMULATED (ProviderCacheSimulator), not live. Synthetic uniform session: constant head, constant tokens/turn.',
    'Eviction drops the OLDEST units, which is the maximally cache-destructive choice: it invalidates the entire prefix after the head. Dropping late-position units would be cheaper but those are the most recent/relevant.',
    'TTL is modelled as a hard cold start (fresh cached prefix) at the resumption turns, which is what an expired cache does to the next request.',
    'g* = w/r is tier-dependent: 12.5 at a 1.25x write, 20 at a 2.0x write. It is not one constant.',
  ],
}, null, 2));
console.log(`\nwrote results-dv3-cadence-ttl.json -> ${OUT}`);
