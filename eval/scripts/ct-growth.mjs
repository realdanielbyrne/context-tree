#!/usr/bin/env node
/**
 * Per-turn context-growth analyzer: is an arm's per-turn processed context
 * (input + cacheRead + cacheWrite) bounded or growing? A growing per-turn
 * context integrates to quadratic total tokens over the conversation — the
 * exact failure the tree exists to prevent. Reports, per run/arm:
 *   - fresh/turn: median fresh input per turn (what you pay at 1x)
 *   - ctx@last: context processed on the final turn
 *   - slope: least-squares slope of per-turn processed context vs turn index
 *            (tokens/turn^2 — 0 means bounded, native cached ~= per-turn growth)
 *   - quad: total processed tokens / turns^2 (the quadratic coefficient)
 * Usage: node eval/scripts/ct-growth.mjs <results.json | dir> ...
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const files = [];
const walk = (p) => {
  if (statSync(p).isDirectory()) {
    for (const e of readdirSync(p)) walk(join(p, e));
  } else if (p.endsWith('results.json')) files.push(p);
};
for (const arg of process.argv.slice(2)) walk(arg);

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const slope = (ys) => {
  const n = ys.length;
  if (n < 2) return 0;
  const mx = (n - 1) / 2;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  ys.forEach((y, x) => { num += (x - mx) * (y - my); den += (x - mx) ** 2; });
  return num / den;
};

const rows = [];
for (const file of files) {
  for (const s of JSON.parse(readFileSync(file, 'utf8'))) {
    const turns = s.turns ?? [];
    if (turns.length === 0) continue;
    const ctx = turns.map((t) => t.usage.input + t.usage.cacheRead + t.usage.cacheWrite);
    const fresh = turns.map((t) => t.usage.input);
    const total = ctx.reduce((a, b) => a + b, 0);
    rows.push({
      run: s.runId,
      arm: s.arm,
      task: s.scenarioId,
      ok: s.success,
      turns: turns.length,
      'fresh/turn': Math.round(median(fresh)),
      'ctx@last': ctx.at(-1),
      slope: Math.round(slope(ctx)),
      quad: Math.round(total / turns.length ** 2),
      costUsd: s.metrics?.costUsd,
    });
  }
}
rows.sort((a, b) => a.arm.localeCompare(b.arm) || a.run.localeCompare(b.run));
console.table(rows);
