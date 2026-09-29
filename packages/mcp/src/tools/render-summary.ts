/**
 * A summary fold as the prompt shows it: one sentence, the files it touched, and the call
 * that brings the range back. The form with evidence behind it — a headline with an id and
 * a recall line recovered every planted fact (15/15, `reports/metrics/loop8-interim.md`),
 * while longer summaries cost tokens for no gain and removed the reason to fetch.
 */
import { headline, type Fold, type SummaryMeta } from '@context-tree/core';

const FILES_SHOWN = 6;

export function summaryLine(fold: Fold, summary: { text: string; meta: SummaryMeta }): string {
  const files = [...new Set(summary.meta.files.map((f) => f.path))];
  const shown = files.slice(0, FILES_SHOWN).join(', ') + (files.length > FILES_SHOWN ? `, +${String(files.length - FILES_SHOWN)}` : '');
  return [
    `[summary ${fold.id} · ${headline(summary.text)}`,
    ...(files.length > 0 ? [`files: ${shown}`] : []),
    `recall: fetch {"from_seq":${String(fold.fromSeq)},"to_seq":${String(fold.toSeq)}}]`,
  ].join(' · ');
}
