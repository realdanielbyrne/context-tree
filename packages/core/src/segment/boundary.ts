/**
 * BOUNDARY STRATEGIES — where the transcript is cut into segments, as a selectable rule.
 *
 * Which cut is right is a research question this repo has run several times
 * (rung-0b topic shift, online-segmentation), so each survivor is a strategy here, behind
 * one interface, with its constants as parameters. All of them are pure functions of
 * text already resolved by the caller (D1: bit-identical; D15: no model, no embeddings —
 * the embedding and kNN variants of rung-0b stay outside the ingest path for that reason).
 *
 *   toolPhase  the §7 state machine in `segment.ts`: a non-neutral tool-phase change cuts
 *   tiling     TextTiling over a sliding window: cut at a local minimum of the cosine
 *              between the `window` blocks before and after a gap, below mean − t·sd.
 *              Two-sided, so it needs the block after the gap (offline by one window).
 *   drift      causal topic shift (online-segmentation arm 2): each block's lexical drift
 *              from the `window` blocks BEFORE it, z-scored against a running Welford mean;
 *              cut where z > t. Single pass, sees only the past.
 *   topK       on top of tiling/drift: keep only the K strongest cuts (strength-ranked
 *              segmentation, P@16 .19 against .05 for the flat rule).
 */
import type { BoundaryConfig } from '../contracts/segment.js';

export type Bag = Map<string, number>;

/** Token counts. No stopword list: every cutoff below is RELATIVE to this trace's own gaps. */
export function bagOf(text: string): Bag {
  const bag: Bag = new Map();
  for (const token of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (token.length < 2) continue;
    bag.set(token, (bag.get(token) ?? 0) + 1);
  }
  return bag;
}

export function mergeBags(bags: readonly Bag[], from: number, to: number): Bag {
  const out: Bag = new Map();
  for (let i = from; i < to; i += 1) {
    for (const [token, count] of bags[i]!) out.set(token, (out.get(token) ?? 0) + count);
  }
  return out;
}

export function bagCosine(a: Bag, b: Bag): number {
  let dot = 0;
  for (const [token, count] of a) dot += count * (b.get(token) ?? 0);
  const normA = Math.sqrt([...a.values()].reduce((sum, v) => sum + v * v, 0));
  const normB = Math.sqrt([...b.values()].reduce((sum, v) => sum + v * v, 0));
  return normA === 0 || normB === 0 ? 0 : dot / (normA * normB);
}

function jaccard(a: Bag, b: Bag): number {
  let inter = 0;
  for (const token of a.keys()) if (b.has(token)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Block indices that start a new segment (never 0). */
export type Cuts = Set<number>;

const strongest = (scored: readonly { index: number; strength: number }[], topK: number): Cuts =>
  new Set((topK > 0 ? [...scored].sort((a, b) => b.strength - a.strength || a.index - b.index).slice(0, topK) : scored).map((c) => c.index));

export function tilingCuts(texts: readonly string[], { window, threshold, topK }: Omit<BoundaryConfig, 'strategy'>): Cuts {
  const bags = texts.map(bagOf);
  if (bags.length < window * 2) return new Set();
  const gaps: number[] = [];
  for (let g = window; g <= bags.length - window; g += 1) {
    gaps.push(bagCosine(mergeBags(bags, g - window, g), mergeBags(bags, g, g + window)));
  }
  const mean = gaps.reduce((sum, v) => sum + v, 0) / gaps.length;
  const sd = Math.sqrt(gaps.reduce((sum, v) => sum + (v - mean) ** 2, 0) / gaps.length);
  const cutoff = mean - threshold * sd;
  const found: { index: number; strength: number }[] = [];
  let lastGap = -window;
  for (let i = 0; i < gaps.length; i += 1) {
    const score = gaps[i]!;
    const left = gaps[i - 1] ?? Infinity;
    const right = gaps[i + 1] ?? Infinity;
    if (score < cutoff && score <= left && score <= right && i - lastGap >= window) {
      found.push({ index: i + window, strength: cutoff - score });
      lastGap = i;
    }
  }
  return strongest(found, topK);
}

export function driftCuts(texts: readonly string[], { window, threshold, topK }: Omit<BoundaryConfig, 'strategy'>): Cuts {
  const bags = texts.map(bagOf);
  const found: { index: number; strength: number }[] = [];
  // Welford, causal: the z-score of block i uses only blocks before it.
  let n = 0;
  let mean = 0;
  let m2 = 0;
  for (let i = 1; i < bags.length; i += 1) {
    const before = mergeBags(bags, Math.max(0, i - window), i);
    const drift = 0.5 * (1 - jaccard(bags[i]!, before)) + 0.5 * (1 - bagCosine(bags[i]!, before));
    const sd = n > 1 ? Math.sqrt(m2 / (n - 1)) : 0;
    const z = sd > 0 ? (drift - mean) / sd : 0;
    if (n >= window && z > threshold) found.push({ index: i, strength: z });
    n += 1;
    const delta = drift - mean;
    mean += delta / n;
    m2 += delta * (drift - mean);
  }
  return strongest(found, topK);
}

export function cutsOf(texts: readonly string[], config: BoundaryConfig): Cuts {
  switch (config.strategy) {
    case 'toolPhase': return new Set();
    case 'tiling': return tilingCuts(texts, config);
    case 'drift': return driftCuts(texts, config);
  }
}
