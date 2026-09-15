/**
 * Context-eviction policies under test — PURE and importable so they can be unit
 * tested without executing a live sweep.
 *
 * DESIGN (v2, after adversarial review found five blockers in v1):
 *  - All capped policies fit the SAME budget W with the SAME anchor rule and
 *    differ ONLY in the ORDER they sacrifice units. That makes them
 *    volume-matched by construction, so a difference between arms is a
 *    difference in SELECTION SIGNAL, not in how much was evicted (review M2).
 *  - `idleOf` keys on FILE PATHS, not the `fp` fingerprint. `fp` admits any
 *    token with an underscore and length>=5, so `__init__` — shared by every
 *    Python module — linked every unit to the newest one and pinned idle near 0.
 *    Measured on this repo's own task: idleOf [1,1,6,1,4,3,1,1,0] vs truth
 *    [8,7,6,5,4,3,2,1,0]. That made the idle arm nearly inert (review BLOCKER 1).
 *  - The budget fit is IDLE-ORDERED for the idle arm rather than delegating to
 *    `evictRecency`, which keeps a contiguous suffix and therefore deleted
 *    exactly the positionally-old-but-re-referenced unit the idle rule had just
 *    saved, in every cell where the cap binds (review BLOCKER 2).
 *
 * INVARIANT every policy preserves: units come from `extractUnits`, so an
 * assistant message with tool_calls always travels with its tool results — a
 * tool result can never be orphaned from its call.
 */
import { extractUnits, estTokens } from '../coding-harness/lib.mjs';

export const DEFAULT_ANCHOR = 4;
export const DEFAULT_RESERVE = 512;

/** Deterministic PRNG (mulberry32) so the random control reruns identically. */
export function makeRng(seed = 0x9e3779b9) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Replace `messages` with pinned head + kept units, in creation order, in place. */
export function rebuildLocal(messages, pinned, keptUnits) {
  const next = [...pinned, ...keptUnits.flatMap((u) => u.slice)];
  messages.length = 0;
  messages.push(...next);
}

/** Indices of the recency anchor (the last `anchor` units) — never evicted. */
export function anchorSet(n, anchor = DEFAULT_ANCHOR) {
  return new Set(Array.from({ length: Math.min(Math.max(0, anchor), n) }, (_, k) => n - 1 - k));
}

/**
 * Turns since each unit's FILE was last touched by a later unit (reference
 * recency). Units with no file identity (e.g. a `run_bash` test run) have no
 * path to re-reference, so they fall back to positional age.
 */
export function idleOf(units) {
  const N = units.length;
  return units.map((u, i) => {
    const files = u.files instanceof Set ? u.files : new Set();
    if (files.size === 0) return N - 1 - i;
    let last = i;
    for (let j = N - 1; j > i; j--) {
      let hit = false;
      for (const f of files) if (units[j].files.has(f)) { hit = true; break; }
      if (hit) { last = j; break; }
    }
    return N - 1 - last;
  });
}

/**
 * Generic budget fit. `rank(units, anchorIdx, idle)` returns the NON-ANCHOR unit
 * indices in preferred-KEEP order (best first); we keep anchors, then take from
 * `rank` while the budget allows. Every arm shares this, so arms are
 * volume-matched and differ only in `rank`.
 *
 * Returns { changed, kept, evicted, capViolated } — `capViolated` is true when
 * the forced anchor alone exceeds W, so a floor override is VISIBLE rather than
 * silently breaking the cap (review M3).
 */
export function evictToBudget(messages, W, rank, opts = {}) {
  const anchor = opts.anchor ?? DEFAULT_ANCHOR;
  const reserve = opts.reserve ?? DEFAULT_RESERVE;
  const { pinned, units } = extractUnits(messages);
  const N = units.length;
  if (N === 0) return { changed: false, kept: 0, evicted: 0, capViolated: false };

  const avail = W - estTokens(pinned) - reserve;
  const keepAnchor = anchorSet(N, anchor);
  const idle = idleOf(units);
  const keep = new Set(keepAnchor);
  let used = [...keepAnchor].reduce((s, i) => s + estTokens(units[i].slice), 0);

  for (const i of rank(units, keepAnchor, idle)) {
    if (keep.has(i)) continue;
    const t = estTokens(units[i].slice);
    if (used + t <= avail) { keep.add(i); used += t; }
  }

  const changed = keep.size !== N;
  if (changed) rebuildLocal(messages, pinned, [...keep].sort((a, b) => a - b).map((i) => units[i]));
  return { changed, kept: keep.size, evicted: N - keep.size, capViolated: estTokens(messages) > W };
}

const nonAnchor = (units, anchorIdx) => units.map((_, i) => i).filter((i) => !anchorIdx.has(i));

/** BASELINE (what real harnesses do): keep the most recent units that fit. */
export const rankRecency = (units, anchorIdx) => nonAnchor(units, anchorIdx).sort((a, b) => b - a);

/** CONTROL: no selection signal — keep a random subset that fits. */
export const rankRandom = (rng = makeRng()) => (units, anchorIdx) => {
  const rest = nonAnchor(units, anchorIdx);
  for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
  return rest;
};

/**
 * TREATMENT: keep the units whose files were referenced most recently (lowest
 * idle) — reference recency rather than positional recency. Ties break toward
 * the newer unit so it is never worse than recency on a tie.
 */
export const rankIdle = (units, anchorIdx, idle) =>
  nonAnchor(units, anchorIdx).sort((a, b) => (idle[a] - idle[b]) || (b - a));

/**
 * BLEND: interpolate between positional recency (alpha=0) and reference recency
 * (alpha=1). Ranks each unit by both and keeps the lowest weighted rank, so the
 * "strength of the LRU signal" becomes a continuous dial rather than on/off.
 */
export const rankBlend = (alpha) => (units, anchorIdx, idle) => {
  const rest = nonAnchor(units, anchorIdx);
  const posRank = new Map(); [...rest].sort((a, b) => b - a).forEach((i, r) => posRank.set(i, r));
  const idleRank = new Map(); [...rest].sort((a, b) => (idle[a] - idle[b]) || (b - a)).forEach((i, r) => idleRank.set(i, r));
  return rest.sort((a, b) =>
    (alpha * idleRank.get(a) + (1 - alpha) * posRank.get(a)) -
    (alpha * idleRank.get(b) + (1 - alpha) * posRank.get(b)));
};

/**
 * ORACLE (positive control only — NOT a shippable policy). Sacrifices units the
 * label marks worthless before anything else, then falls back to positional
 * recency. It differs from `rankRecency` in exactly one respect, so the
 * oracle-vs-truncate-tail contrast isolates "knowing which units are junk" and
 * nothing else.
 *
 * A real policy cannot compute `isJunk`. This exists to put a ceiling on what
 * any selection signal could buy, and to prove the harness can see such a
 * difference at all.
 */
export const rankOracle = (isJunk) => (units, anchorIdx) => {
  const junk = units.map((u, i) => (isJunk(u, i, units) ? 1 : 0));
  return nonAnchor(units, anchorIdx).sort((a, b) => (junk[a] - junk[b]) || (b - a));
};

/** PROTECTION: units fresher than `g` are never evicted, even under budget pressure. */
export const rankProtect = (g) => (units, anchorIdx, idle) =>
  nonAnchor(units, anchorIdx).sort((a, b) => {
    const pa = idle[a] <= g ? 0 : 1, pb = idle[b] <= g ? 0 : 1;   // protected first
    return (pa - pb) || (idle[a] - idle[b]) || (b - a);
  });

export const evictByBlend = (messages, W, alpha, opts) => evictToBudget(messages, W, rankBlend(alpha), opts);
export const evictByRecency = (messages, W, opts) => evictToBudget(messages, W, rankRecency, opts);
export const evictByRandom = (messages, W, rng, opts) => evictToBudget(messages, W, rankRandom(rng), opts);
export const evictByIdle = (messages, W, opts) => evictToBudget(messages, W, rankIdle, opts);
export const evictByOracle = (messages, W, isJunk, opts) => evictToBudget(messages, W, rankOracle(isJunk), opts);
