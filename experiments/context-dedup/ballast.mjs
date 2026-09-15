/**
 * BALLAST — provably worthless context, for the instrument-sensitivity control.
 *
 * WHY THIS EXISTS. Every live selection result so far is a null: selection signal
 * (arm p=0.70), reference vs positional recency (p=1.000), needle position
 * (180/180), and — once achieved peak is controlled for — eviction cadence
 * (p=0.97). Two explanations are observationally identical from here:
 *   (a) selection genuinely does not matter on `longbuild`, or
 *   (b) the harness CANNOT DETECT selection quality, in which case every one of
 *       those nulls is uninformative rather than negative.
 * A positive control separates them: put context in the buffer that is provably
 * worth nothing, then compare a policy that drops it against one with no signal.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * TWO EARLIER DESIGNS WERE PILOTED AND DISCARDED. Both derailed the agent, and
 * the reason is the same in each case — this substrate does not tolerate FOREIGN
 * content in its context:
 *
 *   v1  fabricated assistant `read_file` calls on unrelated `vendor/*.py` files.
 *       MEASURED: 60 distractor reads in 61 turns, zero files written, both arms
 *       failing identically. The fabricated calls were few-shot demonstrations
 *       and the model imitated them.
 *   v2  the same modules as a user-role reference paste, nothing on disk, framed
 *       "no action required". MEASURED: 51 tool calls, still zero writes. A
 *       passing trace writes by call ~9. Removing the imitation target was not
 *       enough; a stream of unrelated user messages derails it just as well.
 *
 * That is worth recording on its own: injecting foreign material into an agent's
 * context does not merely waste budget, it changes what the agent does. Any
 * middleware that synthesises context — summaries written as agent actions,
 * retrieved passages spliced into history — should expect this.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * v3 (this file) MAKES THE BALLAST ENDOGENOUS. Ballast is a DUPLICATE of content
 * the agent already has: a re-read of a file it has already read, returning
 * byte-identical content. Properties that matter:
 *
 *  - PROVABLY WORTHLESS, and provable without a model: a byte-identical copy of
 *    something already in the buffer carries exactly zero additional information.
 *  - ON-TASK, so there is nothing harmful to imitate. The demonstrated behaviour
 *    is "re-read a task file", which is behaviour the agent already exhibits
 *    (median 2–10 re-reads per run in the A/B series).
 *  - INDISTINGUISHABLE FROM REAL CONTEXT to every policy under test. It is a
 *    normal read unit with normal size and normal file identity, so no policy
 *    gets a free signal from formatting.
 *  - THE LABEL IS EXACT AND DYNAMIC. A unit is junk iff a LATER unit in the
 *    current buffer holds an identical read of the same file. Recomputed on the
 *    live buffer every time, so a copy that becomes the last surviving one stops
 *    being junk — which a static label would get wrong after eviction.
 *
 * NOTE THAT THIS MAKES THE ORACLE IMPLEMENTABLE. Unlike a hand-placed label,
 * "drop superseded duplicate reads" is a policy that could ship (it is the naive
 * dedup rule this project has been circling since DV1). So the oracle arm is both
 * the sensitivity ceiling AND a candidate policy — if it wins, it is a result,
 * not only a calibration.
 */
import { extractUnits } from '../coding-harness/lib.mjs';

/** Key separator: a control character that cannot appear in a path or in file content. */
export const SEP = String.fromCharCode(1);

/** The read a unit represents: path + SEP + content, or null if it is not a single successful read. */
export function readKeyOf(unit) {
  let path = null, content = null, calls = 0;
  for (const m of unit.slice) {
    for (const tc of m.tool_calls || []) {
      calls += 1;
      if (tc.function?.name !== 'read_file') return null;
      try { path = JSON.parse(tc.function.arguments || '{}').path ?? null; } catch { return null; }
    }
    if (m.role === 'tool') content = m.content;
  }
  if (calls !== 1 || path == null || content == null) return null;
  if (/^error/.test(String(content))) return null;         // a failed read is not content
  return `${path}${SEP}${content}`;                        // SEP cannot occur in either half
}


/**
 * ORACLE LABEL, computed on the live buffer: the indices of units that are
 * SUPERSEDED — an identical read of the same file appears later. Keeping the
 * latest copy means the information is never lost, so every index returned here
 * is provably zero-information given the rest of the buffer.
 */
export function supersededIndices(units) {
  const lastAt = new Map();
  units.forEach((u, i) => { const k = readKeyOf(u); if (k !== null) lastAt.set(k, i); });
  const out = new Set();
  units.forEach((u, i) => { const k = readKeyOf(u); if (k !== null && lastAt.get(k) !== i) out.add(i); });
  return out;
}

/** Predicate form over a whole buffer: `isJunk(unit, index, units)`. */
export function makeSupersededLabel() {
  let cacheUnits = null, cacheSet = null;
  return (unit, index, units) => {
    if (units !== cacheUnits) { cacheUnits = units; cacheSet = supersededIndices(units); }
    return cacheSet.has(index);
  };
}

/** A label for arms that carry no ballast at all — nothing is ever superseded. */
export const NO_BALLAST = () => false;

let _dupSeq = 0;
/** Clone a read unit as a fresh duplicate: same file, same content, new call id. */
export function cloneReadUnit(unit) {
  const src = unit.slice;
  const assistant = src.find((m) => m.tool_calls?.length);
  const result = src.find((m) => m.role === 'tool');
  if (!assistant || !result) return null;
  const id = `dup-${_dupSeq++}`;
  return [
    { role: 'assistant', content: assistant.content ?? '', tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: assistant.tool_calls[0].function.arguments } }] },
    { role: 'tool', tool_call_id: id, content: result.content },
  ];
}

/**
 * Injector. Every `every` turns, adds `burst` duplicate read units.
 *
 * SOURCE CHOICE IS UNIFORM AT RANDOM over the resident read units, and this is
 * load-bearing. The canonical copy is the LAST one, so duplicating a unit makes
 * the EARLIER copy the junk — meaning junk position is the SOURCE's position.
 * Cycling sources oldest-first (the obvious implementation) therefore piles all
 * the junk at the front of the buffer, exactly where positional recency evicts
 * for free: `truncate-tail` would score as well as the oracle for reasons that
 * have nothing to do with knowing what is junk. Measured on the first version:
 * mean junk position 3.2 vs mean unique position 10.0. Uniform sampling spreads
 * junk across the buffer so no positional policy gets it free.
 *
 * INSERTION POINT. Clones go in immediately BEFORE the newest unit, not at the
 * tail. Appending at the tail would put junk in the recency anchor on every
 * eviction — measured at exactly 2.00 pinned junk units per turn in review, ~83%
 * of the oracle's residual junk — handicapping the oracle in the one place the
 * experiment needs it clean. One position earlier keeps the agent's own latest
 * turn newest and keeps the transcript chronologically coherent.
 *
 * Returns how many units were injected (0 when the agent has not read anything
 * yet, which is normal for the first turns).
 */
export function makeBallastInjector({ every = 2, burst = 2, rng = null } = {}) {
  const rand = rng ?? (() => { let s = 0x5bf03635; return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();
  return function inject(messages, turn) {
    if (every <= 0 || burst <= 0) return 0;
    if (turn % every !== 0) return 0;
    const { units } = extractUnits(messages);
    if (units.length < 2) return 0;

    // every resident read unit is an eligible source, in buffer order
    const sources = units.filter((u) => readKeyOf(u) !== null);
    if (!sources.length) return 0;

    const clones = [];
    for (let b = 0; b < burst; b++) {
      const c = cloneReadUnit(sources[Math.floor(rand() * sources.length)]);
      if (c) clones.push(...c);
    }
    if (!clones.length) return 0;

    // splice before the newest unit
    const lastUnitLen = units[units.length - 1].slice.length;
    const at = messages.length - lastUnitLen;
    messages.splice(at, 0, ...clones);
    return burst;
  };
}
