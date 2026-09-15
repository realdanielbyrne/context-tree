/**
 * VERIFY-QA — a task whose shape contains the behaviour the anchor targets.
 *
 * Why this exists. The `longbuild` pilot recorded ZERO re-fetches of resident
 * content, and I wrongly read that as "agents only re-read under eviction". It is
 * a property of the TASK: longbuild is read-spec -> write-code -> run-test, and it
 * never asks the agent to re-assert an earlier fact. Real transcripts re-read
 * constantly, because an agent asked to state something it read earlier will go
 * and CONFIRM rather than answer from memory. That is verification behaviour, and
 * it happens with everything still resident in context.
 *
 * So: phase 1 makes the agent read six dense reference documents. Phase 2 then asks
 * for exact literals drawn from them. An agent that wants to be right will re-read.
 * That re-read is the trigger the anchor arms act on.
 *
 * Documents are sized to fit UNDER the harness's 2000-char tool-output clip, so a
 * plain read leaves the COMPLETE file resident. That matters: an anchor over a
 * clipped fragment asserts something false, which is the defect that invalidated
 * the replay probe and is what report-readloop.md's failed nudge actually measured.
 *
 * Deterministic: fixed documents, fixed questions, exact-match grading, no RNG.
 *
 * Interface: { name, system, task, seed(ws), grade(ws)->bool, score(ws)->{correct,total} }
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const N_DOCS = +(process.env.CT_VQ_DOCS || 6);
const TOPICS = ['limits','codes','naming','windows','routing','audit','quotas','leases','digests','shards',
  'replicas','tokens','cursors','batches','probes','vaults','beacons','ledgers','rosters','gauges'];
/** Deterministic distinctive literals — unguessable, underivable, unique across the corpus. */
function genDocs(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const topic = TOPICS[i % TOPICS.length];
    const tag = `${topic.toUpperCase()}_${Math.floor(i / TOPICS.length) + 1}`;
    out.push({ file: `spec/${String(i + 1).padStart(2, '0')}_${topic}${Math.floor(i / TOPICS.length) || ''}.md`,
      title: `${topic} parameters ${Math.floor(i / TOPICS.length) + 1}`,
      facts: [
        [`${tag}_BUDGET`, String(1000 + i * 37 % 8999)],
        [`${tag}_TIMEOUT_MS`, String(2000 + i * 131 % 7999)],
        [`${tag}_TOKEN`, `${topic.slice(0, 2)}${(i * 7919 % 9999).toString(36)}x${i}`],
      ] });
  }
  return out;
}
const DOCS = genDocs(N_DOCS);

/** Filler that is dense and non-repetitive, so the fact cannot be pattern-matched out. */
const filler = (doc, n) => Array.from({ length: n }, (_, i) =>
  `${doc} note ${i}: operators reconcile the ${['ledger', 'shard', 'lease', 'route', 'digest'][i % 5]} against the ` +
  `${['primary', 'standby', 'archive'][i % 3]} copy before promotion, recording the outcome in the run log; ` +
  `discrepancies escalate to the on-call owner within one cycle.`).join('\n');

const QUESTIONS = DOCS.flatMap((d, di) => d.facts.map(([k, v], fi) => ({
  id: `Q${di * 3 + fi + 1}`, key: k, answer: v, file: d.file,
})));

export default {
  name: `verify-qa(${DOCS.length} docs, ${QUESTIONS.length} exact-literal questions)`,
  system: 'You are an agent in a workspace. Use the tools to read files and run commands. Work step by step. When you are completely finished reply with a short message containing DONE and no tool call.',
  task: [
    `PHASE 1. Read all ${DOCS.length} reference documents in spec/.`,
    'For each one write a single-line summary to summaries.txt in the form "<file>: <summary>".',
    '',
    'PHASE 2. Then answer the following questions. Every answer is an EXACT literal that appears in',
    'the documents. Accuracy matters more than speed: a wrong value is worse than a slow answer.',
    'Write every answer to answers.txt, one per line, in the form "<id>: <value>" and nothing else.',
    '',
    ...QUESTIONS.map((q) => `  ${q.id}. What is the value of ${q.key}?`),
    '',
    'When answers.txt contains all ' + QUESTIONS.length + ' lines, reply DONE.',
  ].join('\n'),
  seed(ws) {
    mkdirSync(join(ws, 'spec'), { recursive: true });
    for (const d of DOCS) {
      const body = [
        `# ${d.title}`, '', filler(d.title, 4), '',
        '## Normative values', '',
        ...d.facts.map(([k, v]) => `- \`${k}\` = ${v}`), '',
        filler(d.title, 4), '',
      ].join('\n');
      writeFileSync(join(ws, d.file), body);
    }
  },
  score(ws) {
    const p = join(ws, 'answers.txt');
    if (!existsSync(p)) return { correct: 0, total: QUESTIONS.length };
    const text = readFileSync(p, 'utf8');
    let correct = 0;
    for (const q of QUESTIONS) {
      const m = text.match(new RegExp(`^\\s*${q.id}\\s*[:=]\\s*(.+)$`, 'mi'));
      if (m && m[1].trim().replace(/[`'"]/g, '') === q.answer) correct += 1;
    }
    return { correct, total: QUESTIONS.length };
  },
  grade(ws) { const s = this.score(ws); return s.correct === s.total; },
};
