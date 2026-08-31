/**
 * Changed-line ranges between two revisions of a file, in POST-edit
 * coordinates — the extractor parses the post-edit blob (§12 step 1), so a
 * hunk that addressed pre-edit rows would point at the wrong lines.
 *
 * Line-level LCS with prefix/suffix trimming, no dependency: an agent's edit
 * touches a handful of lines, so the trimmed middle is tiny in the normal case.
 */
import type { DiffHunk, DiffHunker } from '../contracts/index.js';
import { splitLines } from './lines.js';

/**
 * Above this the LCS table stops being ms-scale (§7.1 reason 2), so a
 * pathological rewrite degrades to one hunk over the whole changed middle —
 * still true, just coarser.
 */
const MAX_DP_CELLS = 4_000_000;

export class LineDiffHunker implements DiffHunker {
  hunks(before: string | null, after: string): DiffHunk[] {
    const b = splitLines(after);
    // A new file has no unchanged region: everything in it is the change.
    if (before === null) return [{ start_line: 1, end_line: Math.max(1, b.length) }];

    const a = splitLines(before);
    let prefix = 0;
    while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
    let suffix = 0;
    while (
      suffix < a.length - prefix &&
      suffix < b.length - prefix &&
      a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
    ) {
      suffix++;
    }

    const am = a.slice(prefix, a.length - suffix);
    const bm = b.slice(prefix, b.length - suffix);
    if (am.length === 0 && bm.length === 0) return [];

    const touched =
      am.length * bm.length > MAX_DP_CELLS
        ? range(0, bm.length)
        : changedMiddleLines(am, bm);

    const lines = touched.map((j) => clamp(prefix + j, b.length) + 1);
    return mergeAdjacent(lines);
  }
}

/**
 * 0-based indices into the post-edit middle that the edit touched.
 *
 * A pure deletion has no post-edit line of its own, so it is attributed to the
 * surviving line that follows it: the definition that lost a line is the one
 * worth pointing at, and that definition still encloses its neighbour.
 */
function changedMiddleLines(am: readonly string[], bm: readonly string[]): number[] {
  const n = am.length;
  const m = bm.length;
  const width = m + 1;
  // dp[i][j] = LCS length of am[i..] and bm[j..].
  const dp = new Int32Array(width * (n + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        am[i] === bm[j]
          ? (dp[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(dp[(i + 1) * width + j] ?? 0, dp[i * width + j + 1] ?? 0);
    }
  }

  const touched: number[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (am[i] === bm[j]) {
      i++;
      j++;
    } else if ((dp[(i + 1) * width + j] ?? 0) >= (dp[i * width + j + 1] ?? 0)) {
      i++; // deleted line: attribute it to bm[j], the surviving successor
      touched.push(j);
    } else {
      touched.push(j);
      j++;
    }
  }
  if (i < n) touched.push(j); // trailing deletions
  while (j < m) touched.push(j++);
  return touched;
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i < to; i++) out.push(i);
  return out;
}

function clamp(index: number, length: number): number {
  return Math.min(Math.max(index, 0), Math.max(length - 1, 0));
}

/** Contiguous or overlapping single-line changes become one hunk. */
function mergeAdjacent(lines: readonly number[]): DiffHunk[] {
  const sorted = [...new Set(lines)].sort((x, y) => x - y);
  const out: DiffHunk[] = [];
  for (const line of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && line <= last.end_line + 1) last.end_line = Math.max(last.end_line, line);
    else out.push({ start_line: line, end_line: line });
  }
  return out;
}
