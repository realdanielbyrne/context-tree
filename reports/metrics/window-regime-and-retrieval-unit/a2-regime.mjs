#!/usr/bin/env node
/**
 * A2 regime analyzer — offline computation over the frozen s1 fixture.
 * Zero LLM calls. Reproduces every number in analyzer-a2-regime.md.
 *
 * All inputs are read from the frozen fixture JSON files (gates.json,
 * manifest.json, questions-deep.json, questions-overflow.json) and the
 * harness constants. No @context-tree/core import needed.
 *
 * Usage (from repo root):
 *   node reports/metrics/window-regime-and-retrieval-unit/a2-regime.mjs
 */
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const FIXTURE = join(REPO, 'eval/fixtures/transplant/s1');
const ARTIFACTS = join(FIXTURE, 'e1b289c32f40');

// ── frozen fixture data ──────────────────────────────────────────────────
const manifest = JSON.parse(readFileSync(join(ARTIFACTS, 'manifest.json'), 'utf8'));
const gates = JSON.parse(readFileSync(join(ARTIFACTS, 'gates.json'), 'utf8'));
const deepQ = JSON.parse(readFileSync(join(ARTIFACTS, 'questions-deep.json'), 'utf8'));
const overflowQ = JSON.parse(readFileSync(join(ARTIFACTS, 'questions-overflow.json'), 'utf8'));

const RATIO = manifest.ratio; // 0.850896663206653
const NATIVE_EXACT = gates.results.find(g => g.id === 'g6-native-exceeds-window').nativeExact; // 196385
const NATIVE_HEURISTIC = gates.results.find(g => g.id === 'g6-native-exceeds-window').nativeHeuristic; // 232624
const FRACTIONS = manifest.fractions;
const K_FRACTION = 0.85;
const L0_EVENTS = manifest.store.l0_events; // 754

// Zone A measured from run turn data: zoneA heuristic = 2271 (tree-tail-v2 W=65536 turn 1)
const ZONE_A_H = 2271;
const ZONE_A_CL = Math.round(ZONE_A_H * RATIO); // ~1932

console.log('=== A2 REGIME ANALYSIS ===');
console.log(`Native: ${NATIVE_EXACT} cl100k / ${NATIVE_HEURISTIC} heuristic (gates.json g6)`);
console.log(`Ratio: ${RATIO.toFixed(6)} (manifest.ratio)`);
console.log(`Zone A: ${ZONE_A_H} heur / ${ZONE_A_CL} cl100k (run turn data)`);
console.log(`L0 events: ${L0_EVENTS}`);
console.log();

// ── budget derivation (mirrors transplant.mjs deriveBudgets) ─────────────
function deriveBudgets(W) {
  const slackFraction = RATIO > 1.15 ? 0.15 : FRACTIONS.slack;
  const zoneCFraction = FRACTIONS.zoneC - (slackFraction - FRACTIONS.slack);
  const per = (f) => Math.floor((f * W) / RATIO);
  const reply = per(FRACTIONS.reply);
  return {
    W,
    reply,
    zoneA: per(FRACTIONS.zoneA),
    zoneB: per(FRACTIONS.zoneB),
    zoneC: per(zoneCFraction),
    lazy: per(FRACTIONS.lazy),
    slack: per(slackFraction),
    K: Math.floor((K_FRACTION * W) / RATIO) - reply,
    maxReply: Math.floor(FRACTIONS.reply * W), // cl100k
  };
}

// ── truncation boundary approximation ────────────────────────────────────
// truncationBoundarySeq scans events from the end, accumulating heuristic cost.
// We approximate boundary = L0 * (1 - K / NATIVE_HEURISTIC), checked against
// the two known points from the frozen question files.
function approxBoundarySeq(K_heur) {
  if (K_heur >= NATIVE_HEURISTIC) return 1;
  return Math.max(1, Math.round(L0_EVENTS * (1 - K_heur / NATIVE_HEURISTIC)));
}

// Use exact known boundaries where available (from frozen files)
function boundarySeq(K_heur, W) {
  if (W === 65536) return 523;       // questions-overflow.json
  if (W === 131072) return 268;      // questions-deep.json
  return approxBoundarySeq(K_heur);
}

console.log('Boundary check: W=65536 K=61616 actual=523 approx=' + approxBoundarySeq(61616));
console.log('Boundary check: W=131072 K=123232 actual=268 approx=' + approxBoundarySeq(123232));
console.log();

// ── constants ────────────────────────────────────────────────────────────
const WINDOWS = [65_536, 131_072, 200_000, 1_000_000];
const PADS = [0, 70_000];
const DEEP_SEQS = deepQ.questions.map(q => ({ id: q.id, seq: q.seq }));
const OVERFLOW_SEQS = overflowQ.questions.map(q => ({ id: q.id, seq: q.seq }));

// ═══════════════════════════════════════════════════════════════════════
// SECTION 1: TRUNCATE-TAIL BOUNDARIES
// ═══════════════════════════════════════════════════════════════════════
console.log('=== 1. TRUNCATE-TAIL K AND BOUNDARY SEQ ===');
console.log('| W | P | eff W | K (heur) | boundary | deep valid | overflow valid |');
console.log('|---|---|-------|----------|----------|-----------|----------------|');

for (const W of WINDOWS) {
  for (const P of PADS) {
    const effW = W - P;
    if (effW <= 0) {
      console.log(`| ${W} | ${P} | ${effW} | -- | -- | DEAD | DEAD |`);
      continue;
    }
    const b = deriveBudgets(effW);
    const bdy = boundarySeq(b.K, effW);
    const dv = DEEP_SEQS.filter(q => q.seq < bdy).length;
    const ov = OVERFLOW_SEQS.filter(q => q.seq < bdy).length;
    console.log(`| ${W} | ${P} | ${effW} | ${b.K} | ${bdy} | ${dv}/5 | ${ov}/${OVERFLOW_SEQS.length} |`);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// SECTION 2: TREE PROMPT SIZES AND HEADROOM
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== 2. TREE PROMPT SIZE AND HEADROOM ===');
console.log('tree-tail-v2: Zone A + Zone B (heuristic) -> tail fills remainder.');
console.log('CRITICAL: buildArm uses MIXED UNITS: headroom(for tail) = W(cl100k) - total(heur) - maxReply(cl100k).');
console.log('This over-estimates the heuristic tail budget because cl100k > heuristic for same text.');
console.log();

// rootKeep from manifest for known windows; derive for effective windows
function rootKeep(effW) {
  // From manifest root_by_window (known points for P=0)
  if (effW >= 98304) return 40;
  if (effW >= 65536) return 40;
  if (effW >= 32768) return 16;
  if (effW >= 16384) return 2;
  return null;
}

console.log('| W | P | effW | rootKeep | ZoneB(h) | base(h) | tailBudget(mixed) | tail(~cl) | total(~cl) | headroom(~cl) | 20-hit? |');
console.log('|---|---|------|----------|----------|---------|-------------------|-----------|------------|---------------|---------|');

for (const W of WINDOWS) {
  for (const P of PADS) {
    const effW = W - P;
    if (effW <= 0) {
      console.log(`| ${W} | ${P} | ${effW} | -- | -- | -- | -- | -- | -- | -- | DEAD |`);
      continue;
    }
    const b = deriveBudgets(effW);
    const rk = rootKeep(effW);
    if (rk === null) {
      console.log(`| ${W} | ${P} | ${effW} | null | -- | -- | -- | -- | -- | -- | DEAD |`);
      continue;
    }

    // Zone B ACTUAL: use manifest for P=0 known windows, else use budget as upper bound
    let zoneBH;
    if (P === 0 && manifest.root_by_window?.[String(W)]?.tree) {
      zoneBH = manifest.root_by_window[String(W)].tree.zoneB;
    } else {
      zoneBH = b.zoneB; // budget allocation = upper bound
    }

    // tree-tail-v2 has Zone C = 0 (raw tail replaces it)
    const baseH = ZONE_A_H + zoneBH; // heuristic
    const baseCL = Math.round(baseH * RATIO); // approximate cl100k

    // buildArm MIXED-UNIT headroom for tail:
    // headroom = W(cl100k) - total(heuristic) - maxReply(cl100k)
    const tailBudgetMixed = Math.max(0, effW - baseH - b.maxReply);

    // Tail fills tailBudgetMixed in heuristic tokens
    // But NATIVE_HEURISTIC = 232624, so if tailBudgetMixed > NATIVE_HEURISTIC,
    // the entire trace fits
    const tailH = Math.min(tailBudgetMixed, NATIVE_HEURISTIC);
    const tailCL = Math.round(tailH * RATIO); // approximate cl100k

    const totalCL = baseCL + tailCL;

    // First-turn headroom in cl100k (what appendHeadroom computes):
    // appendHeadroom = W - requestTokens(system+messages+tools, exact) - maxReply - margin(64) - prefix - msgOverhead(4)
    // We approximate requestTokens = totalCL + priming(8) + message_overheads
    const overhead = 64 + 8 + 4; // margin + priming + msgOverhead
    const headroom = effW - totalCL - b.maxReply - overhead;

    // 20-hit search: 6.1-7.3k cl100k (prior report)
    const fits = headroom >= 7300 ? 'YES' : (headroom >= 6100 ? 'marginal' : 'NO');

    console.log(`| ${W} | ${P} | ${effW} | ${rk} | ${zoneBH} | ${baseH} | ${tailBudgetMixed} | ${tailCL} | ${totalCL} | ${headroom} | ${fits} |`);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// SECTION 3: DEEP-SET ANSWERS vs TREE RAW TAIL
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== 3. DEEP-SET ANSWERS vs TREE RAW TAIL FILL ===');
for (const W of WINDOWS) {
  for (const P of PADS) {
    const effW = W - P;
    if (effW <= 0) continue;
    const b = deriveBudgets(effW);
    let zoneBH;
    if (P === 0 && manifest.root_by_window?.[String(W)]?.tree) {
      zoneBH = manifest.root_by_window[String(W)].tree.zoneB;
    } else {
      zoneBH = b.zoneB;
    }
    const baseH = ZONE_A_H + zoneBH;
    const tailBudgetMixed = Math.max(0, effW - baseH - b.maxReply);
    const tailH = Math.min(tailBudgetMixed, NATIVE_HEURISTIC);
    // Approximate tail boundary: events from seq >= boundary fit in tailH heuristic tokens
    const treeRawBdy = approxBoundarySeq(tailH);

    console.log(`W=${W} P=${P} effW=${effW} tailBudget(h)=${tailH} boundary~=${treeRawBdy}:`);
    for (const q of DEEP_SEQS) {
      console.log(`  ${q.id} seq=${q.seq} ${q.seq >= treeRawBdy ? 'INSIDE tail' : 'OUTSIDE (needs search)'}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// SECTION 4: NAIVE-FULL FIT
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== 4. NAIVE-FULL FIT ===');
const FLAT_SYS_CL = 77; // FLAT_SYSTEM ~77 cl100k
for (const W of WINDOWS) {
  for (const P of PADS) {
    const effW = W - P;
    if (effW <= 0) { console.log(`W=${W} P=${P}: DEAD`); continue; }
    const replyBudget = Math.floor(FRACTIONS.reply * effW);
    const total = NATIVE_EXACT + FLAT_SYS_CL + 76 + replyBudget;
    console.log(`W=${W} P=${P} effW=${effW}: need ${total} vs ${effW} -> ${total <= effW ? 'FITS' : 'DOES NOT FIT'}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// SECTION 5: COST ESTIMATE
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== 5. COST ESTIMATE (n=5 x 5 deep questions x 4 arms, W=200k, glm-5.3-flash) ===');
const P_IN = 0.075e-6;
const P_OUT = 0.25e-6;
const NQ = 5, REPS = 5, OUT_PER_TURN = 200;
// Medians from results:
//   tree-tail-v2 deep W=65536: median 4 turns (file: run-W65536-tree-tail-v2-questions-deep)
//   truncate-tail: 1 turn
//   naive-full: 1 turn
//   tree-search-coordinates: estimated = 4 (no live run)

for (const P of [0, 70_000]) {
  const effW = 200_000 - P;
  const b = deriveBudgets(effW);
  let zoneBH;
  if (P === 0 && manifest.root_by_window?.['200000']?.tree) {
    zoneBH = manifest.root_by_window['200000'].tree.zoneB;
  } else {
    zoneBH = b.zoneB;
  }
  const baseH = ZONE_A_H + zoneBH;
  const tailBudget = Math.max(0, effW - baseH - b.maxReply);
  const tailH = Math.min(tailBudget, NATIVE_HEURISTIC);
  const treeCL = Math.round((baseH + tailH) * RATIO);
  const truncTailCL = Math.round(b.K * RATIO) + FLAT_SYS_CL + 76;

  console.log(`\nW=200000 P=${P} effW=${effW}:`);
  const arms = [
    { name: 'naive-full', turns: 1, prompt: NATIVE_EXACT + FLAT_SYS_CL + 76 },
    { name: 'truncate-tail', turns: 1, prompt: truncTailCL },
    { name: 'tree-tail-v2', turns: 4, prompt: treeCL },
    { name: 'tree-search-coordinates', turns: 4, prompt: treeCL },
  ];
  let bIn = 0, bOut = 0;
  for (const a of arms) {
    const tIn = a.turns * a.prompt * NQ * REPS;
    const tOut = a.turns * OUT_PER_TURN * NQ * REPS;
    bIn += tIn; bOut += tOut;
    console.log(`  ${a.name}: ${a.turns}t x ${a.prompt}tok x ${NQ}q x ${REPS}r = ${tIn.toLocaleString()} in + ${tOut.toLocaleString()} out = $${(tIn * P_IN + tOut * P_OUT).toFixed(4)}`);
  }
  console.log(`  TOTAL: ${bIn.toLocaleString()} in + ${bOut.toLocaleString()} out = $${(bIn * P_IN + bOut * P_OUT).toFixed(4)}`);
}

// ═══════════════════════════════════════════════════════════════════════
// SECTION 6: DEAD CELLS
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== 6. DEAD CELLS ===');
for (const W of WINDOWS) {
  for (const P of PADS) {
    const effW = W - P;
    const reasons = [];
    if (effW <= 0) reasons.push('W-P<=0');
    else {
      const b = deriveBudgets(effW);
      let zoneBH = P === 0 && manifest.root_by_window?.[String(W)]?.tree
        ? manifest.root_by_window[String(W)].tree.zoneB : b.zoneB;
      const baseH = ZONE_A_H + zoneBH;
      const tailBudget = Math.max(0, effW - baseH - b.maxReply);
      const tailH = Math.min(tailBudget, NATIVE_HEURISTIC);
      const totalCL = Math.round((baseH + tailH) * RATIO);
      const headroom = effW - totalCL - b.maxReply - 76;
      if (rootKeep(effW) === null) reasons.push('no rootKeep');
      // naive-full: always fits if effW > NATIVE_EXACT + reply + overhead
      // truncate-tail: always has headroom
      // tree arms: the only dead condition at these windows is if rootKeep fails
    }
    console.log(`W=${W} P=${P} effW=${effW}: ${reasons.length === 0 ? 'LIVE' : 'DEAD (' + reasons.join('; ') + ')'}`);
  }
}

console.log('\n=== HARNESS PAD EXPRESSIBILITY ===');
console.log('transplant.mjs: no --pad, no systemPad, no Zone A pad parameter. Searched: pad, systemText, FLAT_SYSTEM, TREE_SYSTEM.');
console.log('Workaround: pass --window (W-P). Budgets derive from --window alone, so this is semantically exact.');

console.log('\n=== LONGER TRACES ===');
console.log('build-dozen-scenario.py: 12-module sw-5-dozen task, target >200KB raw trace. Offline generator, zero LLM.');
console.log('marathon.mjs: 160-200 branches, offline prompt-sizing only (no Q&A). Zero LLM.');
console.log('Freezing a real 400k+ token agent trace for transplant requires a live session.');
console.log('The s1 fixture is 196k cl100k. For a true overflow regime at W=200k P=0, the trace must exceed ~188k cl100k (K at that window). It barely does (196k vs 188k), leaving only ~8k tokens of true overflow. A 400k trace would provide robust overflow even at W=200k P=0.');

console.log('\nDone.');
