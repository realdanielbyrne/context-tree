/**
 * Topic-shift drift classifier (spec stage 1) — the SETTLED dormancy signal.
 *
 * Provenance: the drift signal itself is a settled result — flagged boundaries
 * sit ~0.67–0.87σ below baseline and the sequence is ~9.5σ more clustered than a
 * permutation null; it carries a 3.75× coarse-precision edge over tool-phase
 * segmentation. `reports/metrics/rung-0b-topic-shift/report.md`,
 * `reports/metrics/online-segmentation/`.
 *
 * SETTLED: the drift magnitude — `drift(u) = 0.5·(1 − Jaccard(fp(u), fp(recent)))
 * + 0.5·(1 − cosine(emb(u), centroid(recent)))` over the last K units — and its
 * use as dormancy (min-max normalized). PROVISIONAL: the causal z-scoring and the
 * coarse threshold `τ`. The pre-registered permutation test FAILED as written
 * (tail reversed) and owes a corrected held-out re-run before the z/τ path is
 * treated as validated. `reports/session-handoff.md` → backlog item 3. The
 * continuous `dormancy` (what eviction consumes) does not depend on that path.
 *
 * KNOWN ISSUE in the z/τ path (resolve with the corrected validation): `classify`
 * re-pushes the WHOLE current buffer's drifts into the running stats every turn, so a
 * long-lived unit is counted once per turn and the session mean/std drift toward the
 * distribution of duplicated history rather than causal per-unit observations. This
 * biases `zDrift`/`dormant` only — `dormancy` is per-turn min-max and is unaffected.
 * The fix needs an API change (feed only new units' drift, or an id to dedupe).
 */

/** Recent-window size in units (spec default). */
export const DRIFT_K = 5;

/**
 * Coarse-dormant threshold on the z-scored drift: one SD above the session's
 * running mean drift (spec `τ = z-drift > 1`). PROVISIONAL — see the z/τ note
 * above. Eviction uses the continuous magnitude, not this boolean.
 */
export const DRIFT_TAU = 1;

/** One unit's inputs: its fingerprint set and (optionally) its reduced embedding. */
export interface ClassifyUnit {
  fingerprints: ReadonlySet<string>;
  /**
   * One vector per unit (the caller does the unit-embedding reduction). OPTIONAL:
   * when any unit lacks an embedding, `driftScores` degrades to LEXICAL-ONLY drift
   * (`drift = 1 − Jaccard`, no semantic term), so the classifier runs offline / with
   * no embedder. `reports/session-handoff.md`.
   */
  embedding?: Float32Array;
}

export interface DriftResult {
  /** Raw drift in [0,1]; 0.5·lexical + 0.5·semantic distance from the recent window. */
  drift: number;
  /** z-scored drift against the session's causal running mean/std; 0 until enough history. Provisional. */
  zDrift: number;
  /** Min-max normalized drift across the current units — the eviction dormancy signal. */
  dormancy: number;
  /** Coarse "dormant": zDrift > τ. Provisional; eviction uses `dormancy`, not this. */
  dormant: boolean;
}

/** Jaccard over fingerprint sets. Two empty sets are identical (drift 0). */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const x of small) if (large.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Cosine similarity; a zero vector has similarity 0. */
export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function minMaxNormalize(values: readonly number[]): number[] {
  if (values.length === 0) return [];
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = hi - lo;
  if (span <= 0) return values.map(() => 0);
  return values.map((v) => (v - lo) / span);
}

/**
 * Raw drift of each unit against the recent window (the last `k` units): the
 * union of their fingerprints and the centroid of their embeddings. Units inside
 * the window overlap it by construction and score low; units far from recent
 * activity score high. Pure — no session state.
 */
export function driftScores(units: readonly ClassifyUnit[], k: number = DRIFT_K): number[] {
  const n = units.length;
  if (n === 0) return [];
  if (!Number.isFinite(k) || k < 1) throw new RangeError('drift window k must be a finite number ≥ 1');
  const lo = Math.max(0, n - Math.floor(k));

  const recentFp = new Set<string>();
  for (let i = lo; i < n; i += 1) for (const f of units[i]!.fingerprints) recentFp.add(f);

  // Full drift needs an embedding on every unit; otherwise degrade to lexical-only.
  const semantic = units.every((u) => u.embedding !== undefined && u.embedding.length > 0);
  let centroid: Float32Array | null = null;
  if (semantic) {
    const dim = units[0]!.embedding!.length;
    for (const u of units) {
      if (u.embedding!.length !== dim) {
        throw new RangeError('all unit embeddings must share one dimension');
      }
    }
    const centroidAcc = new Float64Array(dim);
    const m = n - lo;
    for (let i = lo; i < n; i += 1) {
      const e = units[i]!.embedding!;
      for (let d = 0; d < dim; d += 1) centroidAcc[d]! += (e[d] ?? 0) / m;
    }
    centroid = Float32Array.from(centroidAcc);
  }

  return units.map((u) => {
    const lex = 1 - jaccard(u.fingerprints, recentFp);
    if (!semantic) return lex; // lexical-only degradation (drift = lexical distance)
    // cosine ∈ [-1,1]; clamp negatives to 0 so a dissimilar unit is distance 1 and
    // the semantic term (and drift) stays in [0,1] as the contract promises.
    const sem = 1 - Math.max(0, cosine(u.embedding!, centroid!));
    return 0.5 * lex + 0.5 * sem;
  });
}

/** Welford running mean/variance for the causal z-score. */
class RunningStats {
  count = 0;
  mean = 0;
  private m2 = 0;
  push(x: number): void {
    this.count += 1;
    const delta = x - this.mean;
    this.mean += delta / this.count;
    this.m2 += delta * (x - this.mean);
  }
  get std(): number {
    return this.count > 1 ? Math.sqrt(this.m2 / (this.count - 1)) : 0;
  }
}

/**
 * Stateful classifier: holds the session's causal running drift stats so z-drift
 * standardizes against the past only. Construct once per session; call `classify`
 * each turn with the current units.
 */
export class DriftClassifier {
  private readonly stats = new RunningStats();

  classify(
    units: readonly ClassifyUnit[],
    k: number = DRIFT_K,
    tau: number = DRIFT_TAU,
  ): DriftResult[] {
    const drift = driftScores(units, k);
    const dormancy = minMaxNormalize(drift);
    const mean = this.stats.mean;
    const std = this.stats.std;
    const ready = this.stats.count > 1 && std > 0;

    const results = drift.map((dv, i) => {
      const zDrift = ready ? (dv - mean) / std : 0;
      return {
        drift: dv,
        zDrift,
        dormancy: dormancy[i]!,
        dormant: ready ? zDrift > tau : false,
      };
    });

    // Causal: fold this turn's drifts into the running stats AFTER scoring, so a
    // unit is never standardized against future turns.
    for (const dv of drift) this.stats.push(dv);
    return results;
  }
}
