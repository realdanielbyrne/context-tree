/**
 * EXPERIMENT: rung-1 live probe — NAIVE QA wire-up.
 *
 * WHAT IT TESTS (one variable: amount of context handed to the model):
 *   Single-turn Q&A on the 22 committed s1 questions, graded deterministically
 *   by the fixtures' answer_regexes/literals against the LOCAL 262K model.
 *   Three arms per question, differing ONLY in the context block:
 *     - none   : question alone            (leakage / parametric-answer control)
 *     - source : narrow gold passage       (curated retrieval-unit-sized context)
 *     - wide   : broader gold passage       (superset)
 *   This is the "good naive test" — it is NOT taxing on the algorithm (the answer
 *   already sits in a ~1KB passage; nothing is evicted). Its job is to prove the
 *   instrument: model usable, grading real, token accounting honest — the base the
 *   taxing overflow probes reuse.
 *
 * PRE-REGISTERED FALSIFICATION (fixed before the run; not renegotiated after):
 *   G1 instrument-usable : FALSIFIED if source-arm accuracy < 0.50 (model can't do
 *                          this benchmark even with the gold passage → weak instrument).
 *   G2 context-matters    : FALSIFIED (benchmark guessable / parametric) if
 *                          source_acc - none_acc < 0.20.
 *   G3 curation-preserves : narrow curation preserves answerability IFF
 *                          source_acc >= wide_acc - 0.10 (within noise) at fewer tokens.
 *                          FALSIFIED (narrowing loses answers) if source_acc < wide_acc - 0.10.
 *
 * RERUN: node experiments/rung-1-live-probe/qa-naive.mjs
 *   (needs the local host at CT_LOCAL_BASE_URL, default http://127.0.0.1:8888/v1)
 */
import { generate, grade, loadMergedQuestions, writeResults, gitSha, nowISO, MODEL, WINDOW } from './lib.mjs';

const RUN_ID = `qa-naive-${Date.now()}`;
const ARM_VERSION = 'qa-naive@v1';
const SYSTEM = 'You answer questions about a software project from the provided context. Answer with only the specific value asked for — a path, identifier, quoted string, or number — and nothing else. If the context does not contain the answer, reply exactly: UNKNOWN.';

function buildUser(q, arm) {
  if (arm === 'none') return `Question: ${q.question}`;
  const ctx = arm === 'source' ? q.source_context : q.wide_context;
  return `Context:\n"""\n${ctx}\n"""\n\nQuestion: ${q.question}`;
}

async function main() {
  const questions = loadMergedQuestions();
  console.error(`loaded ${questions.length} de-duplicated questions (unique uid)`);

  const arms = ['none', 'source', 'wide'];
  const cells = [];
  for (const q of questions) {
    for (const arm of arms) {
      const user = buildUser(q, arm);
      const t0 = Date.now();
      const r = await generate({ system: SYSTEM, user, maxTokens: 64, temperature: 0 });
      const g = grade(r.content, q);
      cells.push({
        uid: q.uid, id: q.id, set: q.set, stratum: q.stratum, kind: q.kind, arm,
        correct: g.correct, via: g.via,
        output: r.content.slice(0, 200), finish: r.finish,
        prompt_tokens: r.usage.prompt_tokens ?? null,
        completion_tokens: r.usage.completion_tokens ?? null,
        ctx_chars: arm === 'none' ? 0 : (arm === 'source' ? q.source_context.length : q.wide_context.length),
        ms: Date.now() - t0,
      });
      process.stderr.write(g.correct ? '.' : 'x');
    }
  }
  process.stderr.write('\n');

  const agg = {};
  for (const arm of arms) {
    const rows = cells.filter((c) => c.arm === arm);
    const n = rows.length;
    const correct = rows.filter((c) => c.correct).length;
    const avgPrompt = Math.round(rows.reduce((s, c) => s + (c.prompt_tokens || 0), 0) / n);
    agg[arm] = { n, correct, accuracy: +(correct / n).toFixed(4), avg_prompt_tokens: avgPrompt };
  }
  const g1 = agg.source.accuracy >= 0.50;
  const g2 = (agg.source.accuracy - agg.none.accuracy) >= 0.20;
  const g3 = agg.source.accuracy >= agg.wide.accuracy - 0.10;

  const results = {
    manifest: {
      run_id: RUN_ID, arm_id: ARM_VERSION, experiment: 'rung-1-live-probe / qa-naive',
      model: MODEL, window: WINDOW, host: process.env.CT_LOCAL_BASE_URL || 'http://127.0.0.1:8888/v1',
      grader: 'deterministic regex/literal (no judge)', commit: gitSha(), date: nowISO(),
      falsification: {
        G1_instrument_usable: 'source accuracy >= 0.50',
        G2_context_matters: 'source - none >= 0.20',
        G3_curation_preserves: 'source >= wide - 0.10',
      },
      caveats: [
        'Single-turn, gold passage pre-selected — measures answerability-given-context, NOT retrieval, eviction, or multi-turn dynamics.',
        'Not taxing on the algorithm: answer sits in a ~1KB passage; nothing is evicted. Naive wire-up only.',
        'n=22 questions; directional. Regex grader can over-credit if a literal recurs in prose, under-credit paraphrase.',
      ],
    },
    aggregate: agg,
    gates: { G1_instrument_usable: g1, G2_context_matters: g2, G3_curation_preserves: g3 },
    cells,
  };
  const path = writeResults('rung-1-live-probe', 'results-qa-naive.json', results);

  console.error('\n=== QA-NAIVE RESULTS ===');
  for (const arm of arms) console.error(`  ${arm.padEnd(7)} acc=${agg[arm].accuracy}  (${agg[arm].correct}/${agg[arm].n})  avg_prompt_tok=${agg[arm].avg_prompt_tokens}`);
  console.error(`  G1 instrument-usable (source>=.50): ${g1}`);
  console.error(`  G2 context-matters   (src-none>=.20): ${g2}`);
  console.error(`  G3 curation-preserves(src>=wide-.10): ${g3}`);
  console.error(`  written: ${path}`);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
