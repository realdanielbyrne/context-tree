#!/usr/bin/env node
/**
 * G0 — DOES AN IN-PLACE EDIT REACH THE PROVIDER?
 *
 * Every context-tree arm rests on one claim that has never been checked: that when the
 * plugin mutates opencode's live message array at
 * `experimental.chat.messages.transform`, the mutation survives into the bytes that go
 * upstream. If it does not, an arm still starts, still completes, still grades and still
 * writes a results file recording `arm: "ct"` and every knob — a control wearing a
 * treatment's label. That is the failure this gate exists to make impossible, and it is
 * not hypothetical: `CT_ARM=ct` with `CT_SANDBOX=0` produces exactly that record today.
 *
 * WHY NOT READ THE PLUGIN'S LOG. The plugin logs what it did to the array; the sidecar
 * logs what it decided. Both sit upstream of the serializer, so both would report success
 * for a mutation the host discards. The relay is the last host-side hop before the
 * provider and cannot see the plugin at all, which is what makes its record evidence.
 *
 * THE DESIGN. A unique token goes into the task statement — the first message, the one the
 * eviction policy always protects, so nothing but the gate can touch it. Two runs on one
 * instance:
 *
 *   control    CT_ARM=ct, no edit        the marker must be on EVERY mediated request
 *   treatment  CT_G0_DROP_FIRST=1        the gate folds that message to a SECOND marker,
 *                                        replaces one tool OUTPUT with a THIRD, and
 *                                        splices the assistant message after it
 *
 * The claim is two-sided, which is what makes it a proof rather than a coincidence: the
 * original marker must leave the wire AND text that exists nowhere except the plugin's
 * replacement must arrive on it. Removal alone could be opencode's doing; an arrival can
 * only mean the edited array is the array being serialized.
 *
 * WHY FOLD AND NOT ONLY SPLICE. The first design spliced the task statement out, and the
 * provider answered `500 Jinja Exception: No user query found in messages` — opencode's
 * loop holds exactly one user message, so removing it leaves a request no template will
 * render. A rejected prompt says nothing about what the provider would have read, while the
 * marker is duly absent: the gate would have called that PASS. So the gate keeps a user
 * message and still exercises `splice`, on the assistant message at index 1, which carries
 * its own tool calls and results and cannot orphan anything.
 *
 * The control is not ceremony. Without it, a missing marker is equally well explained by
 * opencode having dropped the message itself, and the gate would pass on a mechanism that
 * never ran. The treatment's own early turns are a second control: below three messages the
 * gate declines to fire, and the original marker must be there.
 *
 * A gate cell is not a result. The markers perturb the prompt and the edits rewrite the
 * task, so these two runs are evidence about the harness and must never be pooled with a
 * measured arm.
 *
 *   node experiments/context-dedup/g0-mutation-visibility.mjs
 *   CT_G0_INSTANCE=pylint-dev__pylint-4970 node experiments/context-dedup/g0-mutation-visibility.mjs
 *   CT_G0_ONLY=grade node experiments/context-dedup/g0-mutation-visibility.mjs   # re-grade, run nothing
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const WORK = process.env.CT_WORK || '/mnt/data/ctx-swebench';
const RUNS_ROOT = process.env.CT_RUNS_ROOT || join(WORK, 'opencode-runs');
const OUTDIR = join(REPO, 'reports', 'metrics', 'swebench-pilot');

const INSTANCE = process.env.CT_G0_INSTANCE || 'pydata__xarray-6721';
const MODEL = process.env.CT_OPENCODE_MODEL || 'local/HuggingJoost/Swift-Qwen3.8-27B-NVFP4-GGUF';
/**
 * The gate needs three turns, not a solved problem, so the runs are cut short on purpose.
 * A timeout leaves `run_valid: false` in the cell, which is correct — a gate cell is not a
 * result — and the relay appends its rows as each request completes, so the evidence is
 * already on disk when the run is killed.
 */
const TIMEOUT_S = process.env.CT_RUN_TIMEOUT_S || '420';

const ARMS = Object.freeze([
  { name: 'control', tag: process.env.CT_G0_TAG_CONTROL || 'g0-control', drop: false },
  { name: 'treatment', tag: process.env.CT_G0_TAG_TREATMENT || 'g0-drop', drop: true },
]);

const readJsonl = (path) => (existsSync(path)
  ? readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  })
  : []);

/**
 * A request the plugin's hook actually mediated.
 *
 * Not "a big request", and NOT a message count. opencode's title-generation call carries
 * three provider messages and never passes through the hook, while the agent's own first
 * turn carries two — so `role` selects exactly the wrong rows. Tool schemas are what only
 * an agent request has. A non-200 is excluded because a rejected request proves nothing
 * about what the provider was willing to read.
 */
const mediated = (wire) => wire
  .filter((r) => (r.counts?.tools ?? 0) > 0 && r.status === 200)
  .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));

function readArm(tag, since) {
  const runDir = join(RUNS_ROOT, tag, `${INSTANCE}__r0`);
  // Rows older than this gate's own marker belong to an earlier attempt in the same tag.
  const wire = readJsonl(join(runDir, 'wire.jsonl')).filter((r) => !since || String(r.ts) >= since);
  const plugin = readJsonl(join(runDir, 'mcp', 'ct-plugin.jsonl')).filter((r) => !since || String(r.ts) >= since);
  const sidecar = readJsonl(join(runDir, 'mcp', 'ct-mcp.jsonl')).filter((r) => !since || String(r.ts) >= since);
  const conv = mediated(wire);
  const marked = (r) => (r.counts?.g0 ?? 0);
  const replaced = (r) => (r.counts?.g0fold ?? 0);
  const reducedOn = (r) => (r.counts?.g0reduce ?? 0);
  const stubbedOn = (r) => (r.counts?.g0stub ?? 0);
  const thoughtOn = (r) => (r.counts?.g0think ?? 0);
  const carriedOn = (r) => (r.counts?.g0carrier ?? 0);

  // The edit happens BEFORE the request leaves, so every mediated request from the first
  // reported edit onward must already show it. An existential "some request lacked the
  // marker" would be satisfied by a subagent session or a retry.
  const edits = plugin.filter((r) => (r.dropped ?? 0) > 0 || (r.text_edited ?? 0) > 0);
  const drops = plugin.filter((r) => (r.dropped ?? 0) > 0);
  const reduces = plugin.filter((r) => (r.outputs_edited ?? 0) > 0);
  const stubs = plugin.filter((r) => (r.parts_removed ?? 0) > 0 && (r.outputs_edited ?? 0) > 0);
  const thinks = plugin.filter((r) => (r.reasoning_edited ?? 0) > 0);
  const afterThink = thinks.length > 0 ? conv.filter((r) => String(r.ts) >= String(thinks[0].ts)) : [];
  const afterStub = stubs.length > 0 ? conv.filter((r) => String(r.ts) >= String(stubs[0].ts)) : [];
  const afterReduce = reduces.length > 0 ? conv.filter((r) => String(r.ts) >= String(reduces[0].ts)) : [];
  const firstEditTs = edits.length > 0 ? String(edits[0].ts) : null;
  const after = firstEditTs ? conv.filter((r) => String(r.ts) >= firstEditTs) : [];
  const before = firstEditTs ? conv.filter((r) => String(r.ts) < firstEditTs) : conv;

  return {
    tag,
    run_dir: runDir,
    requests: wire.length,
    rejected: wire.filter((r) => r.status !== 200).length,
    gaps: wire.length > 0 ? wire[wire.length - 1].n - wire.length : 0,
    conversations: conv.length,
    present: conv.filter((r) => marked(r) >= 1).length,
    missing: conv.filter((r) => marked(r) === 0).length,
    // More than one copy means the agent reproduced it; the marker then rides in a message
    // the gate never drops and the wire can no longer answer the question.
    echoed: conv.filter((r) => marked(r) >= 2).length,
    before_first_drop: before.length,
    before_all_marked: before.length > 0 && before.every((r) => marked(r) >= 1),
    after_first_drop: after.length,
    after_all_clean: after.length > 0 && after.every((r) => marked(r) === 0),
    // The other side of the same claim: removing text could in principle be opencode's
    // doing, but text that exists nowhere except the plugin's replacement can only have
    // arrived because the edited array is the array that was serialized.
    after_all_replaced: after.length > 0 && after.every((r) => replaced(r) >= 1),
    replacement_seen: conv.filter((r) => replaced(r) >= 1).length,
    plugin_loaded: plugin.some((r) => r.event === 'loaded'),
    plugin_turns: plugin.filter((r) => r.turn !== undefined).length,
    plugin_errors: plugin.filter((r) => r.error).length,
    fold_turns: plugin.filter((r) => (r.text_edited ?? 0) > 0).length,
    // The edit every reduction makes: a tool OUTPUT replaced in place. Same two-sided,
    // ordered claim as the fold — text that exists only in the replacement must arrive.
    reduce_turns: reduces.length,
    after_first_reduce: afterReduce.length,
    after_all_reduced: afterReduce.length > 0 && afterReduce.every((r) => reducedOn(r) >= 1),
    reduce_seen: conv.filter((r) => reducedOn(r) >= 1).length,
    // The edit `evictMode: 'stub'` makes: reasoning parts removed and an output tagged, on one message.
    stub_turns: stubs.length,
    after_first_stub: afterStub.length,
    after_all_stubbed: afterStub.length > 0 && afterStub.every((r) => stubbedOn(r) >= 1),
    stub_seen: conv.filter((r) => stubbedOn(r) >= 1).length,
    // A reasoning part replaced in place (the think rule), and a summary riding in a reasoning part
    // with the tool parts gone (a carrier): the two edits the fold arms add.
    think_turns: thinks.length,
    after_first_think: afterThink.length,
    after_all_thought: afterThink.length > 0 && afterThink.every((r) => thoughtOn(r) >= 1),
    think_seen: conv.filter((r) => thoughtOn(r) >= 1).length,
    after_all_carried: afterThink.length > 0 && afterThink.every((r) => carriedOn(r) >= 1),
    carrier_seen: conv.filter((r) => carriedOn(r) >= 1).length,
    drop_turns: drops.length,
    // The sidecar's own account of taking the gate path, so "the flag never arrived" is not
    // reported as "the splice was discarded" — two defects, one symptom.
    sidecar_g0_rows: sidecar.filter((r) => r.event === 'assemble' && r.g0 === 'drop_first').length,
    sidecar_assembles: sidecar.filter((r) => r.event === 'assemble').length,
  };
}

/**
 * The verdict, as a predicate over the two wire records.
 *
 * The control carries the whole burden of the negative: it says the marker does not go
 * missing on its own. Only then does a missing marker in the treatment mean the splice —
 * and the treatment must also show the marker at least once, or the run never had it and
 * the absence says nothing.
 *
 * `missing === drop_turns` is reported but does not gate: a provider retry sends the same
 * mutated body twice, which breaks the equality without weakening the claim.
 */
export function gradeG0({ control, treatment }) {
  const reasons = [];
  const voids = [];

  // VOID is not FAIL. These say the gate could not ask its question — reporting them as a
  // discarded splice would send someone hunting opencode's serializer for a marker the
  // agent quoted back, or for an arm knob that never arrived.
  for (const side of [control, treatment]) {
    if (side.echoed > 0) voids.push(`${side.tag}: the agent reproduced the marker on ${side.echoed} requests, so its presence no longer identifies the task statement`);
    if (side.plugin_loaded === false) voids.push(`${side.tag}: the plugin never imported — opencode registered no hooks and said nothing`);
    if (side.gaps > 0) voids.push(`${side.tag}: ${side.gaps} wire rows are missing (the relay numbers them); the record is incomplete`);
    if (side.rejected > 0) voids.push(`${side.tag}: the provider rejected ${side.rejected} requests; a refused prompt says nothing about what it would read`);
  }
  if (treatment.fold_turns === 0 && treatment.drop_turns === 0 && treatment.sidecar_g0_rows === 0 && treatment.sidecar_assembles > 0) {
    voids.push('treatment: the sidecar never entered the gate path — CT_G0_DROP_FIRST did not reach it, so nothing was asked to edit');
  }
  if (control.reduce_seen > 0) voids.push(`control: the reduced-output text appeared on ${control.reduce_seen} requests without any edit; it is not unique to the plugin`);
  if (control.think_seen > 0) voids.push(`control: the think tag's text appeared on ${control.think_seen} requests without any edit; it is not unique to the plugin`);
  if (control.carrier_seen > 0) voids.push(`control: the carrier text appeared on ${control.carrier_seen} requests without any edit; it is not unique to the plugin`);
  if (control.stub_seen > 0) voids.push(`control: the stub tag's text appeared on ${control.stub_seen} requests without any edit; it is not unique to the plugin`);
  if (control.replacement_seen > 0) {
    voids.push(`control: the replacement text appeared on ${control.replacement_seen} requests without any edit; it is not unique to the plugin`);
  }

  // The control carries the whole burden of the negative: it says the marker does not go
  // missing on its own. Without it, a missing marker is equally well explained by opencode
  // having dropped the message itself.
  if (control.conversations < 2) reasons.push(`control saw ${control.conversations} hook-mediated requests, needs >= 2`);
  if (control.drop_turns !== 0) reasons.push(`control dropped on ${control.drop_turns} turns; it must drop nothing`);
  if (control.missing !== 0) reasons.push(`control lost the marker on ${control.missing} requests; it must never go missing without the splice`);

  if (treatment.fold_turns === 0) reasons.push('treatment never edited: no plugin turn reports a fold');
  if (treatment.drop_turns === 0) reasons.push('treatment never spliced: no plugin turn reports a drop');
  if (treatment.reduce_turns === 0) reasons.push('treatment never reduced: no plugin turn reports an edited tool output');
  else if (treatment.after_first_reduce === 0) reasons.push('treatment made no mediated request after its first reduction: the run ended too early to observe one');
  else if (!treatment.after_all_reduced) reasons.push("treatment's reduced tool output never reached the provider: an in-place output edit is not what gets serialized");
  if (treatment.stub_turns === 0) reasons.push('treatment never stubbed: no plugin turn reports a message cut to a stub');
  else if (treatment.after_first_stub === 0) reasons.push('treatment made no mediated request after its first stub: the run ended too early to observe one');
  else if (!treatment.after_all_stubbed) reasons.push("treatment's stub tag never reached the provider: a message with its reasoning removed and an output tagged is not what gets serialized");
  if (treatment.think_turns === 0) reasons.push('treatment never replaced a reasoning part: no plugin turn reports one edited');
  else if (treatment.after_first_think === 0) reasons.push('treatment made no mediated request after its first reasoning edit: the run ended too early to observe one');
  else if (!treatment.after_all_thought) reasons.push("treatment's replaced reasoning never reached the provider: a reasoning part edited in place is not what gets serialized");
  else if (!treatment.after_all_carried) reasons.push("treatment's carrier text never reached the provider: a summary in a reasoning part with the tool parts removed is not what gets serialized");
  // ORDERED, not existential. "Some request lacked the marker" is satisfied by a subagent
  // session or a retry; "every request after the first edit lacked it, and every request
  // before it carried it" is satisfied only by the edit.
  if (treatment.before_first_drop === 0) reasons.push('treatment edited from its first mediated request: nothing shows the marker was ever on the wire');
  else if (!treatment.before_all_marked) reasons.push('treatment lost the marker BEFORE it edited anything: something other than the edit is removing it');
  if (treatment.after_first_drop === 0) reasons.push('treatment made no mediated request after its first edit: the run ended too early to observe one');
  else {
    if (!treatment.after_all_clean) reasons.push('treatment kept the original marker on a request made after the edit: the edit did not reach the provider');
    if (!treatment.after_all_replaced) reasons.push('treatment\'s replacement text never reached the provider: the edited array is not the array being serialized');
  }

  return {
    pass: reasons.length === 0 && voids.length === 0,
    void: voids.length > 0,
    reasons,
    voids,
    // The FOLD is what removes the marker, and it fires one turn before the splice does
    // (three messages against four), so the drop count is the wrong thing to compare.
    exact: treatment.missing === treatment.fold_turns,
  };
}

function run({ tag, drop, marker, foldMarker, reduceMarker, stubMarker, thinkMarker, carrierMarker }) {
  const env = {
    ...process.env,
    CT_ARM: 'ct',
    CT_CT_TRIGGER: 'off',
    CT_G0_MARKER: marker,
    CT_G0_FOLD_MARKER: foldMarker,
    CT_G0_REDUCE_MARKER: reduceMarker,
    CT_G0_STUB_MARKER: stubMarker,
    CT_G0_THINK_MARKER: thinkMarker,
    CT_G0_CARRIER_MARKER: carrierMarker,
    CT_TAG: tag,
    CT_INSTANCES: INSTANCE,
    CT_REPEATS: '1',
    CT_REPEAT_START: '0',
    CT_OPENCODE_MODEL: MODEL,
    CT_LOCAL_EXCLUSIVE: process.env.CT_LOCAL_EXCLUSIVE || '1',
    CT_RUN_TIMEOUT_S: TIMEOUT_S,
    // `CT_SANDBOX=0` would skip openSandbox entirely: no relay, no wire record, and a gate
    // about mutation visibility running with nothing that can see a mutation. The window
    // knobs are re-declarations of the host's context and are not this gate's business.
    CT_SANDBOX: '1',
    CT_WINDOW: '0',
    CT_OUTPUT_CAP: '0',
  };
  // The control must be a control even when the operator exported the knob by hand.
  if (drop) env.CT_G0_DROP_FIRST = '1';
  else delete env.CT_G0_DROP_FIRST;
  console.error(`=== G0 ${tag} (drop_first=${drop}) ===`);
  const r = spawnSync('node', [join(HERE, 'swebench-opencode.mjs')], { env, stdio: 'inherit' });
  if (r.error) throw r.error;
  // Grading a run that never started reads whatever an earlier attempt left in the tag's
  // directory, and answers confidently from it.
  if (r.status !== 0) throw new Error(`G0 ${tag}: the harness exited ${r.status}; nothing to grade`);
  return r.status;
}

function main() {
  const only = process.env.CT_G0_ONLY || '';
  const markerFile = join(OUTDIR, 'g0-marker.json');
  let marker;
  let foldMarker;
  let reduceMarker;
  let stubMarker;
  let thinkMarker;
  let carrierMarker;
  let since;
  if (only === 'grade') {
    if (!existsSync(markerFile)) throw new Error(`no ${markerFile}: nothing to grade`);
    ({ marker, foldMarker, reduceMarker, stubMarker, thinkMarker, carrierMarker, at: since } = JSON.parse(readFileSync(markerFile, 'utf8')));
  } else {
    marker = `CTG0-${randomBytes(12).toString('hex')}`;
    foldMarker = `CTG0FOLD-${randomBytes(12).toString('hex')}`;
    reduceMarker = `CTG0REDUCE-${randomBytes(12).toString('hex')}`;
    stubMarker = `CTG0STUB-${randomBytes(12).toString('hex')}`;
    thinkMarker = `CTG0THINK-${randomBytes(12).toString('hex')}`;
    carrierMarker = `CTG0CARRIER-${randomBytes(12).toString('hex')}`;
    since = new Date().toISOString();
    mkdirSync(OUTDIR, { recursive: true });
    writeFileSync(markerFile, JSON.stringify({ marker, foldMarker, reduceMarker, stubMarker, thinkMarker, carrierMarker, instance: INSTANCE, at: since }, null, 2));
    for (const arm of ARMS) run({ ...arm, marker, foldMarker, reduceMarker, stubMarker, thinkMarker, carrierMarker });
  }

  const control = readArm(ARMS[0].tag, since);
  const treatment = readArm(ARMS[1].tag, since);
  const verdict = gradeG0({ control, treatment });
  const report = {
    gate: 'G0 mutation visibility',
    question: 'does an in-place splice at experimental.chat.messages.transform reach the provider?',
    marker, fold_marker: foldMarker, reduce_marker: reduceMarker, stub_marker: stubMarker, think_marker: thinkMarker, carrier_marker: carrierMarker, instance: INSTANCE, model: MODEL, at: new Date().toISOString(),
    control, treatment, ...verdict,
  };
  writeFileSync(join(OUTDIR, 'g0-mutation-visibility.json'), `${JSON.stringify(report, null, 2)}\n`);

  const line = (a) => `  ${a.tag.padEnd(12)} requests=${a.requests} mediated=${a.conversations} marked=${a.present} unmarked=${a.missing} before_drop=${a.before_first_drop}/${a.before_all_marked ? 'all marked' : 'NOT all marked'} after_edit=${a.after_first_drop}/${a.after_all_clean ? 'orig gone' : 'ORIG PRESENT'}/${a.after_all_replaced ? 'repl seen' : 'REPL MISSING'} turns=${a.plugin_turns} folds=${a.fold_turns} drops=${a.drop_turns} sidecar_g0=${a.sidecar_g0_rows}`;
  console.error('\n--- G0 mutation visibility ---');
  console.error(`  marker ${marker} -> ${foldMarker} on ${INSTANCE}`);
  console.error(line(control));
  console.error(line(treatment));
  console.error(`  verdict: ${verdict.void ? 'VOID' : verdict.pass ? 'PASS' : 'FAIL'}${verdict.pass && !verdict.exact ? ` (unmarked ${treatment.missing} != fold turns ${treatment.fold_turns}; a retry resends one body)` : ''}`);
  for (const v of verdict.voids) console.error(`    ! ${v}`);
  for (const reason of verdict.reasons) console.error(`    - ${reason}`);
  console.error(`  -> ${join(OUTDIR, 'g0-mutation-visibility.json')}`);
  if (!verdict.pass) process.exitCode = 1;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) main();
