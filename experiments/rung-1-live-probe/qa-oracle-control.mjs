/**
 * CONTROL for qa-naive: the RAG-oracle / retrieval ceiling.
 *
 * Deterministic, no model. For each question × arm, does the gold answer
 * (answer_regexes OR answer_literals) actually appear IN the context we handed
 * the model? That presence rate is what a perfect retriever ("simple RAG lookup"
 * that returns the passage) scores on answer-presence. Cross-tabbing it with the
 * model's correctness (from results-qa-naive.json) decomposes accuracy into:
 *   retrieval ceiling (answer present)  ×  extraction (model reads it correctly).
 *
 * RERUN: node experiments/rung-1-live-probe/qa-oracle-control.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadMergedQuestions, writeResults, gitSha, nowISO, REPO } from './lib.mjs';

function present(text, q) {
  const t = text || '';
  for (const rx of q.answer_regexes || []) { try { if (new RegExp(rx).test(t)) return true; } catch {} }
  for (const lit of q.answer_literals || []) { if (lit && t.includes(String(lit))) return true; } // exact, case-sensitive
  return false;
}

const model = JSON.parse(readFileSync(join(REPO, 'reports/metrics/rung-1-live-probe/results-qa-naive.json'), 'utf8'));
const correctBy = {}; // uid|arm -> bool  (uid is unique post-dedup)
for (const c of model.cells) correctBy[`${c.uid}|${c.arm}`] = c.correct;

const questions = loadMergedQuestions();
const rows = [];
for (const q of questions) {
  rows.push({
    uid: q.uid, kind: q.kind, stratum: q.stratum,
    present_source: present(q.source_context, q),
    present_wide: present(q.wide_context, q),
    model_source: correctBy[`${q.uid}|source`] ?? null,
    model_wide: correctBy[`${q.uid}|wide`] ?? null,
  });
}

function tab(arm) {
  const pk = `present_${arm}`, mk = `model_${arm}`;
  const n = rows.length;
  const present = rows.filter((r) => r[pk]).length;
  const present_correct = rows.filter((r) => r[pk] && r[mk]).length;   // answer there, model read it
  const present_wrong = rows.filter((r) => r[pk] && !r[mk]).length;    // answer there, model MISSED it (extraction loss)
  const absent = rows.filter((r) => !r[pk]).length;
  const absent_correct = rows.filter((r) => !r[pk] && r[mk]).length;   // answer NOT in passage yet model right (inference/paraphrase/leak)
  const absent_wrong = rows.filter((r) => !r[pk] && !r[mk]).length;    // answer not there, model wrong (unwinnable for a reader)
  return {
    n,
    retrieval_ceiling: +(present / n).toFixed(4),           // what a perfect RAG lookup scores on answer-presence
    model_accuracy: +(rows.filter((r) => r[mk]).length / n).toFixed(4),
    extraction_given_present: present ? +(present_correct / present).toFixed(4) : null, // model's read rate when answer IS there
    present, present_correct, present_wrong, absent, absent_correct, absent_wrong,
  };
}

const out = {
  manifest: {
    experiment: 'rung-1-live-probe / qa-oracle-control',
    purpose: 'Retrieval-ceiling control: is the gold answer literally present in the handed context? Decomposes model accuracy = retrieval ceiling x extraction.',
    grader: 'deterministic answer-presence (regex OR exact literal substring) in the context',
    model_run: model.manifest.run_id, commit: gitSha(), date: nowISO(),
  },
  source: tab('source'),
  wide: tab('wide'),
  rows,
};
const path = writeResults('rung-1-live-probe', 'results-qa-oracle-control.json', out);

for (const arm of ['source', 'wide']) {
  const t = out[arm];
  console.log(`\n[${arm}]`);
  console.log(`  retrieval ceiling (answer present in passage): ${(t.retrieval_ceiling*100).toFixed(1)}%  (${t.present}/${t.n})`);
  console.log(`  model accuracy:                                ${(t.model_accuracy*100).toFixed(1)}%`);
  console.log(`  extraction | answer present:                   ${(t.extraction_given_present*100).toFixed(1)}%  (${t.present_correct}/${t.present})  <- model reading skill`);
  console.log(`  answer PRESENT but model WRONG (extraction loss): ${t.present_wrong}`);
  console.log(`  answer ABSENT from passage (unwinnable for reader): ${t.absent}   of which model still right: ${t.absent_correct}`);
}
console.log(`\nwritten: ${path}`);
