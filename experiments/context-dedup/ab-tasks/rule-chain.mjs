/**
 * Task module for the A/B window sweep — MACHINERY DE-RISK (Stage A), not a
 * publication benchmark. A deterministic, gradeable retention task: N rule files
 * applied IN ORDER to a running total, each rule depending on the current parity
 * (so it can't be parallelized — the model must carry state across turns). Filler
 * pads each file so reading it costs context. The publication benchmark is
 * SWE-bench Verified (Stage B); this only proves the sweep harness works.
 *
 * A task module exports { name, system, task, seed(ws), grade(ws)->bool, allowedTools? }.
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const N = +(process.env.CT_RULES || 8);
// Deterministic rules: even total → add a_i ; odd total → subtract b_i.
const RULES = Array.from({ length: N }, (_, i) => ({ a: 3 + i, b: 1 + (i % 3) }));
function expected() {
  let t = 0;
  for (const r of RULES) t += t % 2 === 0 ? r.a : -r.b;
  return t;
}
const filler = (i) => (`Rule file ${i} background: this document describes operational context, precedence, and review notes at length. Integrators cross-reference parameters and confirm conventions before applying. `).repeat(12);

export default {
  name: `rule-chain(N=${N})`,
  system: 'You are an agent in a workspace. Use the tools to read files and run commands. Work step by step; when finished reply with a short message containing DONE and no tool call.',
  task: `Apply ${N} rules to a running total that starts at 0. The rules are in rule_0.txt .. rule_${N - 1}.txt and MUST be applied strictly in order 0,1,2,...  Each file states: "if the current total is EVEN add A, otherwise subtract B" with that file's A and B. After applying all ${N} rules in order, write ONLY the final integer total to answer.txt, then reply DONE.`,
  seed(ws) {
    RULES.forEach((r, i) => {
      const lines = [`# Rule ${i}`, filler(i), `RULE: if the current running total is EVEN, add ${r.a}; otherwise subtract ${r.b}.`, filler(i)];
      writeFileSync(join(ws, `rule_${i}.txt`), lines.join('\n'));
    });
  },
  grade(ws) {
    try {
      const ans = readFileSync(join(ws, 'answer.txt'), 'utf8').trim();
      return new RegExp(`(^|[^-\\d])${expected()}([^\\d]|$)`).test(ans);
    } catch {
      return false;
    }
  },
};
