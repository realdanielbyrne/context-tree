#!/usr/bin/env node
/**
 * Zero-live-token audit of scored SUCCESSES.
 *
 * `gradeAnswer` is exact-match against free-form model output, which a fluent
 * model games without intending to. Two ways, both observed on this store
 * (`ds-star-multi-index-report.md` §6): a fabricated transcript citing seq
 * 755-757 in a 754-event trace, and a correct refusal that named the answer
 * string inside a suggested follow-up command. Both scored 1.
 *
 * The fix is not a better grader but a provenance question asked after the
 * fact: could this run have SEEN the literal it produced? A success is earned
 * only if the literal is present in something the run actually read —
 *
 *   PROMPT   the assembled context the arm was built with (rebuilt offline,
 *            deterministically, at the same window and arm as the run)
 *   FETCH    a branch the run expanded, replayed at depth 'full'
 *
 * and unearned otherwise. An unearned success is scored `null`, never `0`:
 * the model did not answer wrongly, the instrument recorded a result it had no
 * basis to record, and a `0` would quietly credit the arm with a failure it
 * never had.
 *
 * A third verdict exists because the harness does not instrument every read.
 * `context_peek` node ids are not recorded on a row (only `context_fetch`
 * branch ids are), so a run that searched, peeked and answered leaves no trace
 * this script can replay. Those rows are UNVERIFIABLE, reported separately,
 * and never counted as fabrications — the audit refuses to convict on absent
 * instrumentation.
 *
 * Independently, every row's `finalText` is checked for cited sequence numbers
 * that do not exist in the trace. That check runs on failures too: a fabricated
 * citation in a wrong answer is the same defect, caught before it scores.
 *
 * Result files reuse question ids across question SETS (`s1-qo01-overflow` is a
 * different question in `questions-overflow.json` and `questions-deep.json`),
 * so every row is keyed to its set from the FILENAME. Aggregating by id alone
 * silently merges two different questions.
 *
 *   node eval/scripts/provenance-audit.mjs [--scenario s1] [--json <path>]
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TreeRetriever } from '@context-tree/core';
import { buildArm, budgetsFor, gradeAnswer, measureRatio, openScenario, requestTokens } from './transplant.mjs';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const FRACTION_SLACK = 0.1;
const RESULT_RE = /^run-W(\d+)-(.+)-questions-(overflow|deep)-(.+)\.json$/;

/**
 * Sequence citations, in the two forms a model produces: prose ("seq 755",
 * "event 755") and the replay format it quotes back ("[755] tool_call"). The
 * replay form is anchored on the event type so a bare bracketed number — a
 * line number, an array index — is never mistaken for a citation.
 */
function citedSeqs(text) {
  const out = new Set();
  const patterns = [
    /\bseq(?:uence)?\s*(?:numbers?|ids?)?\s*[:=#]?\s*(\d{1,6})/gi,
    /\bevents?\s+(?:number\s+)?(\d{1,6})\b/gi,
    /\[(\d{1,6})\]\s*(?:tool_call|tool_result|user_message|assistant_message)/g,
  ];
  for (const re of patterns) {
    for (const match of text.matchAll(re)) out.add(Number(match[1]));
  }
  return [...out];
}

/**
 * Trailing numbers in a list ("seq 755, 756 and 757") that the anchored
 * patterns above miss, admitted only when the row already cites a seq — so a
 * sentence with no citation at all never contributes numbers.
 */
function citedSeqRuns(text) {
  const out = new Set();
  for (const match of text.matchAll(/\bseq(?:uence)?s?\s*[:=#]?\s*(\d{1,6}(?:\s*(?:,|and)\s*\d{1,6})+)/gi)) {
    for (const n of match[1].matchAll(/\d{1,6}/g)) out.add(Number(n[0]));
  }
  return [...out];
}

function textOf(built) {
  const parts = [built.system ?? '', built.context ?? ''];
  for (const message of built.messages ?? []) parts.push(String(message.content ?? ''));
  return parts.join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const scenarioId = argv.includes('--scenario') ? argv[argv.indexOf('--scenario') + 1] : 's1';
  const jsonOut = argv.includes('--json') ? argv[argv.indexOf('--json') + 1] : null;

  const scenario = openScenario(scenarioId);
  try {
    const events = scenario.trace.all();
    const maxSeq = events.reduce((m, e) => Math.max(m, e.seq), 0);
    const retriever = new TreeRetriever({ store: scenario.store, blobs: scenario.blobs, trace: scenario.trace });
    const ratio = measureRatio(scenario);

    const resultsDir = join(scenario.artifacts, 'results');
    const files = readdirSync(resultsDir).filter((name) => RESULT_RE.test(name));
    if (files.length === 0) throw new Error(`no question-set result files under ${resultsDir}`);

    // Question sets, keyed by set name — ids collide across sets by design.
    const sets = new Map();
    for (const set of ['overflow', 'deep']) {
      const path = join(scenario.artifacts, `questions-${set}.json`);
      if (!existsSync(path)) continue;
      const byId = new Map();
      for (const q of JSON.parse(readFileSync(path, 'utf8')).questions) byId.set(q.id, q);
      sets.set(set, byId);
    }

    const replayCache = new Map();
    const replay = (branchId) => {
      if (!replayCache.has(branchId)) {
        let text = '';
        try {
          const outcome = retriever.fetchBranch(branchId, { depth: 'full' });
          text = outcome?.text ?? outcome?.data?.text ?? '';
        } catch {
          text = '';
        }
        replayCache.set(branchId, text);
      }
      return replayCache.get(branchId);
    };

    /**
     * The band the run was actually SERVED, as opposed to the branch it named.
     * `earned-fetch` above replays the whole branch, which is the weaker test and
     * passes a row whose delivered payload never contained the literal — observed
     * on a W=131,072 oracle run that scored on a question no band ever delivered.
     * Reconstructed from the run's own budgets the way the handler sizes it
     * (`_liveHeadroomHeuristic` = live headroom / ratio), using turn 1, which has
     * the most headroom of any turn and so is the most generous reading. This is
     * approximate — later turns are tighter and the append cap re-cuts afterwards —
     * so it is REPORTED, never used to null a row.
     */
    const deliveredText = (branchId, row, budgets) => {
      const window = budgets?.window;
      const prompt = row.turns?.[0]?.promptTokens;
      const ratio = budgets?.ratio;
      if (typeof window !== 'number' || typeof prompt !== 'number' || typeof ratio !== 'number') return null;
      const live = Math.max(0, window - prompt - (budgets.maxReplyTokens ?? 0));
      const query = (row.searchQueries ?? []).find((q) => typeof q === 'string' && q.length > 0) ?? '';
      try {
        const outcome = retriever.fetchBranch(branchId, {
          depth: 'full',
          maxTokens: Math.floor(live / ratio),
          query,
        });
        return outcome?.text ?? '';
      } catch {
        return null;
      }
    };

    const promptCache = new Map();
    const promptText = async (arm, window) => {
      const key = `${arm}@${window}`;
      if (!promptCache.has(key)) {
        let text = '';
        try {
          const budgets = budgetsFor(scenario, window, ratio, FRACTION_SLACK, arm);
          const built = await buildArm(scenario, arm, budgets, {});
          text = textOf(built);
          // Elastic arms hold the raw tail outside `messages`; at turn 1 it fills
          // what prefix + reply leave, so include that rendering in the prompt view.
          if (built.elastic !== undefined) {
            const fixed = requestTokens({ system: built.system, messages: built.messages, tools: built.tools });
            text += `\n${built.elastic.tail(Math.max(0, window - fixed - budgets.maxReplyTokens - 64 - 4), 0).text}`;
          }
        } catch (error) {
          text = '';
          process.stderr.write(`  ! could not rebuild ${key}: ${error.message}\n`);
        }
        promptCache.set(key, text);
      }
      return promptCache.get(key);
    };

    const rows = [];
    for (const file of files.sort()) {
      const [, windowText, , set] = RESULT_RE.exec(file);
      const window = Number(windowText);
      const byId = sets.get(set);
      if (byId === undefined) throw new Error(`${file}: no questions-${set}.json to key against`);
      const payload = JSON.parse(readFileSync(join(resultsDir, file), 'utf8'));

      for (const row of payload.rows ?? []) {
        const question = byId.get(row.question);
        if (question === undefined) throw new Error(`${file}: question ${row.question} absent from questions-${set}.json`);

        const finalText = row.finalText ?? '';
        const cited = [...new Set([...citedSeqs(finalText), ...citedSeqRuns(finalText)])];
        const phantom = cited.filter((seq) => seq > maxSeq || seq < 1);

        let verdict = null;
        // `earned-fetch` asks whether the BRANCH held the literal. `delivered` asks the
        // stricter question — whether the band the run was actually served held it. A row
        // that is earned-fetch but not delivered scored on content it plausibly never saw;
        // it is reported, not nulled, because the headroom is reconstructed rather than
        // recorded.
        let delivered = null;
        if (row.score === 1) {
          const fetched = (row.fetchedIds ?? []).filter((id) => typeof id === 'string');
          // `earned-search`: the literal was inside a SEARCH result as appended after the
          // cap. `tree-snippet-hits` (DS-STAR Fable-interface pass) returns event excerpts
          // in the hit list, so a run can be served the literal without ever fetching; the
          // harness records `answerLiteralPresentAfterCap` per tool call, search calls
          // included, so this is recorded, not reconstructed. Checked after `earned-prompt`
          // so the no-retrieval count keeps its meaning.
          const searchServed = (row.toolCalls ?? []).some(
            (call) => call?.name === 'context_search' && call.answerLiteralPresentAfterCap === true,
          );
          // `prefix-plus-retrieval` fills the prompt per question (recorded per row).
          const prefilled = row.prefill?.answerLiteralInPrefill === true;
          if (prefilled || gradeAnswer(await promptText(row.arm, window), question).success) verdict = 'earned-prompt';
          else if (searchServed) {
            verdict = 'earned-search';
            delivered = true;
          } else if (fetched.some((id) => gradeAnswer(replay(id), question).success)) {
            verdict = 'earned-fetch';
            const bands = fetched.map((id) => deliveredText(id, row, payload.budgets)).filter((t) => t !== null);
            delivered = bands.length === 0 ? null : bands.some((text) => gradeAnswer(text, question).success);
          } else if (row.searched === true && fetched.length === 0) verdict = 'unverifiable';
          else verdict = 'unearned';
        }

        rows.push({
          file,
          set,
          window,
          arm: row.arm,
          question: row.question,
          rep: row.rep,
          score: row.score,
          verdict,
          delivered,
          phantomSeqs: phantom,
          auditedScore: verdict === 'unearned' || verdict === 'unverifiable' ? null : row.score,
        });
      }
    }

    // ── report ──────────────────────────────────────────────────────────────
    const cells = new Map();
    for (const row of rows) {
      const key = `${row.set} ${row.window} ${row.arm}`;
      const cell = cells.get(key) ?? {
        set: row.set,
        window: row.window,
        arm: row.arm,
        n: 0,
        before: 0,
        after: 0,
        nulled: 0,
        unverifiable: 0,
        unearned: 0,
        earnedPrompt: 0,
        fetchedNotDelivered: 0,
        phantomRows: 0,
      };
      cell.n += 1;
      if (row.score === 1) cell.before += 1;
      if (row.auditedScore === 1) cell.after += 1;
      if (row.score === 1 && row.auditedScore === null) cell.nulled += 1;
      if (row.verdict === 'unverifiable') cell.unverifiable += 1;
      if (row.verdict === 'unearned') cell.unearned += 1;
      if (row.verdict === 'earned-prompt') cell.earnedPrompt += 1;
      if (row.delivered === false) cell.fetchedNotDelivered += 1;
      if (row.phantomSeqs.length > 0) cell.phantomRows += 1;
      cells.set(key, cell);
    }

    const ordered = [...cells.values()].sort(
      (a, b) => a.set.localeCompare(b.set) || a.window - b.window || a.arm.localeCompare(b.arm),
    );

    process.stdout.write(`provenance audit — ${scenarioId}, trace max seq ${maxSeq}, ${files.length} result files, ${rows.length} rows\n\n`);
    process.stdout.write('set      W        arm                  n   before  after  nulled  unverif  unearned  noRetrv  phantom\n');
    process.stdout.write('-------- -------- -------------------- --- ------- ------ ------- -------- --------- ------- -------\n');
    for (const c of ordered) {
      process.stdout.write(
        `${c.set.padEnd(8)} ${String(c.window).padEnd(8)} ${c.arm.padEnd(20)} ${String(c.n).padStart(3)} ` +
          `${`${c.before}/${c.n}`.padStart(7)} ${`${c.after}/${c.n}`.padStart(6)} ${String(c.nulled).padStart(7)} ` +
          `${String(c.unverifiable).padStart(8)} ${String(c.unearned).padStart(9)} ` +
          `${`${c.earnedPrompt}/${c.before}`.padStart(7)} ${String(c.phantomRows).padStart(7)}\n`,
      );
    }

    const suspect = rows.filter((r) => r.verdict === 'unearned' || r.verdict === 'unverifiable' || r.phantomSeqs.length > 0);
    if (suspect.length > 0) {
      process.stdout.write(`\nrows needing a human read (${suspect.length}):\n`);
      for (const r of suspect) {
        const phantom = r.phantomSeqs.length > 0 ? ` cites-absent-seq=${r.phantomSeqs.join(',')}` : '';
        process.stdout.write(`  ${r.set}/W${r.window} ${r.arm} ${r.question} rep${r.rep} score=${r.score} ${r.verdict ?? '-'}${phantom}\n`);
      }
    }

    const totals = {
      rows: rows.length,
      scoredBefore: rows.filter((r) => r.score === 1).length,
      scoredAfter: rows.filter((r) => r.auditedScore === 1).length,
      unearned: rows.filter((r) => r.verdict === 'unearned').length,
      earnedSearch: rows.filter((r) => r.verdict === 'earned-search').length,
      unverifiable: rows.filter((r) => r.verdict === 'unverifiable').length,
      fetchedNotDelivered: rows.filter((r) => r.delivered === false).length,
      phantomRows: rows.filter((r) => r.phantomSeqs.length > 0).length,
    };
    process.stdout.write(
      `\ntotal successes ${totals.scoredBefore} -> ${totals.scoredAfter} after audit ` +
        `(${totals.unearned} unearned, ${totals.unverifiable} unverifiable, ${totals.phantomRows} rows cite an absent seq)\n` +
        `of the earned-fetch successes, ${totals.fetchedNotDelivered} scored on a branch whose SERVED band did not carry the literal\n` +
        `${totals.earnedSearch} successes were served the literal inside a search result (earned-search)\n`,
    );

    if (jsonOut !== null) {
      writeFileSync(jsonOut, `${JSON.stringify({ scenario: scenarioId, maxSeq, totals, cells: ordered, rows }, null, 2)}\n`);
      process.stdout.write(`wrote ${jsonOut}\n`);
    }
  } finally {
    scenario.close();
  }
}

await main();
