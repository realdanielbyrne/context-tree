/**
 * ============================================================================
 * STRESS TEST: multi-doc synthesis under a hard window
 * ============================================================================
 * Stacks both failure modes under a window ceiling (real, on the 8.2K model, or
 * artificial via CT_WINDOW on a stronger model): FOUR large documents (~2.5K
 * tokens each, ~10K total) each BURYING one unit price needed for the answer.
 * Single-turn; the middleware assembles the context; one variable = the reducer.
 *
 *   raw           — concat all docs (~10K tok) > window → the prompt CANNOT be sent
 *   summarize     — gist per doc: fits, but every buried price is DROPPED
 *   chunk_retrieve — the price span per doc, verbatim: fits AND keeps all 4 prices
 *
 * METRICS: fits_window, prices_present (all 4 in the assembled context — the
 *   MECHANISM metric: did the middleware preserve the needed info), model answer
 *   (contains the sum — arithmetic on top; may wobble on a low-quant model).
 *
 * PREDICTION: raw cannot send; summarize loses the prices (prices_present=false);
 *   chunk_retrieve fits AND keeps them (prices_present=true). The middleware is
 *   REQUIRED under a hard window to both fit AND preserve the answer.
 *
 * RERUN (real 8.2K window):
 *   CT_LOCAL_MODEL=unsloth/Qwen3.8-Flash-Next-GGUF node experiments/coding-harness/hard-window-synthesis.mjs
 * RERUN (strong model, artificial window):
 *   CT_LOCAL_MODEL=unsloth/Qwen3.8-27B-GGUF CT_WINDOW=8192 node .../hard-window-synthesis.mjs
 * ============================================================================
 */
import { generate, MODEL, writeResults, gitSha, nowISO, estTok } from '../rung-1-live-probe/lib.mjs';
import { REDUCERS } from './reducers.mjs';

const WINDOW = +(process.env.CT_WINDOW || 8192);
const ITEMS = [{ name: 'Widget', price: 13 }, { name: 'Gadget', price: 27 }, { name: 'Gizmo', price: 41 }, { name: 'Doohickey', price: 58 }];
const TOTAL = ITEMS.reduce((s, i) => s + i.price, 0); // 139

function makeDoc(name, price) {
  const secs = ['Overview', 'Specifications', 'Materials', 'Assembly', 'Warranty', 'Compliance', 'Shipping',
    'Returns', 'Support', 'Compatibility', 'Maintenance', 'Safety', 'Packaging', 'History', 'Roadmap', 'FAQ'];
  const filler = (s) => `The ${s} section for the ${name} product line describes conventions, procedures, and ` +
    `expectations in detail. Integrators should review this material carefully and cross-reference the catalog ` +
    `for exhaustive parameters. Standard handling and configuration apply throughout, and exceptions are noted ` +
    `where relevant. This information is provided for completeness and does not change frequently between revisions.`;
  const lines = [`# ${name} Product Catalog`, ''];
  for (const s of secs) {
    lines.push(`## ${s}`, (filler(s) + ' ').repeat(3).trim()); // 3x filler → each doc ~3K tokens, 4 docs ~12K > 8192
    if (s === 'Specifications') lines.push(`Pricing note: the ${name} unit price is ${price} dollars per unit (list price, ex-tax).`);
    lines.push('');
  }
  return lines.join('\n');
}

const SYSTEM = 'Answer using ONLY the provided documents. Each document states a unit price. Reply with only the integer sum of the four unit prices, or UNKNOWN if any price is missing.';
const QUESTION = 'Using the catalogs, what is the sum of the unit prices of the Widget, Gadget, Gizmo, and Doohickey (an integer)?';

async function main() {
  const docs = ITEMS.map((i) => makeDoc(i.name, i.price));
  const rawTokens = estTok(docs.join('\n\n'));
  const arms = [];
  for (const name of ['raw', 'summarize', 'chunk_retrieve']) {
    const reducer = name === 'raw' ? REDUCERS.none : REDUCERS[name];
    const ctx = docs.map((d) => reducer({ out: d, task: QUESTION })).join('\n\n---\n\n');
    const ctxTok = estTok(ctx);
    const pricesPresent = ITEMS.every((i) => new RegExp(`\\b${i.price}\\b`).test(ctx));
    const fitsWindow = ctxTok < WINDOW - 256;
    let answer = '', correct = false, err = null;
    if (!fitsWindow) { err = `context ${ctxTok} tok exceeds window ${WINDOW} — cannot send`; }
    else {
      try {
        const r = await generate({ system: SYSTEM, user: `Documents:\n"""\n${ctx}\n"""\n\n${QUESTION}`, maxTokens: 24, temperature: 0, think: false });
        answer = (r.grade_text || '').slice(0, 40); correct = new RegExp(`\\b${TOTAL}\\b`).test(r.grade_text || '');
      } catch (e) { err = String(e.message || e).slice(0, 140); }
    }
    arms.push({ reducer: name, fits_window: fitsWindow, prices_present: pricesPresent, model_correct: correct, answer, ctx_tokens: ctxTok, error: err });
    process.stderr.write(`${name.padEnd(14)} fits=${fitsWindow} ctx=${ctxTok} prices_present=${pricesPresent} correct=${correct} ans=${JSON.stringify(answer)}${err ? ' | ' + err : ''}\n`);
  }
  const s = Object.fromEntries(arms.map((a) => [a.reducer, a]));
  const mechanism_confirmed = !s.raw.fits_window && s.summarize.prices_present === false && s.chunk_retrieve.prices_present === true;
  const end_to_end = mechanism_confirmed && s.chunk_retrieve.model_correct === true;
  const out = {
    manifest: {
      run_id: `hard-window-${Date.now()}`, experiment: 'coding-harness / hard-window multi-doc synthesis',
      model: MODEL, window: WINDOW, n_docs: ITEMS.length, raw_total_tokens: rawTokens, correct_sum: TOTAL,
      seam: 'middleware reducer per document (plugin tool.execute.after payload)', commit: gitSha(), date: nowISO(),
      falsification: 'middleware REQUIRED under a hard window IFF raw cannot send AND summarize loses the prices AND chunk_retrieve keeps them',
      caveats: ['n=1 per arm, temp 0.', 'prices_present is the MECHANISM metric; model_correct (the sum) is arithmetic on a possibly low-quant model.', 'Chunk retrieval is a weak lexical proxy.', 'Text-only stand-in for the PDF/excel/report (session-3) task.'],
    },
    mechanism_confirmed, end_to_end, arms,
  };
  const path = writeResults('coding-harness', 'results-hard-window-synthesis.json', out);
  console.error(`\n=== HARD-WINDOW SYNTHESIS (${MODEL}, window ${WINDOW}, raw docs ~${rawTokens} tok) ===`);
  for (const a of arms) console.error(`  ${a.reducer.padEnd(14)} fits=${a.fits_window ? 'Y' : 'N'} prices_present=${a.prices_present} model_correct=${a.model_correct} ctx=${a.ctx_tokens}`);
  console.error(`\n  MECHANISM confirmed (middleware required to fit+preserve): ${mechanism_confirmed}`);
  console.error(`  end-to-end (chunk arm also answered correctly): ${end_to_end}`);
  console.error(`  written: ${path}`);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
