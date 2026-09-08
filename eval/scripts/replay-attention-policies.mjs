#!/usr/bin/env node
/** Offline, prefix-only mechanism observations over current RunCapture files.
 * Build first: pnpm exec tsc --build eval
 * node eval/scripts/replay-attention-policies.mjs --capture-dir RUN --excerpt-chars 1000
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countTokens } from 'gpt-tokenizer';
import { detectAttentionSignals, selectAttention, selectPayload } from '../../packages/core/dist/attention/index.js';
import { extractFingerprints } from '../../packages/core/dist/retrieve/lexical.js';
import { renderOutcome } from '../dist/sandbox.js';
import { renderToolResult, TOOL_RESULT_TRANSCRIPT_VERSION } from '../dist/transcript.js';

const digest = (text) => createHash('sha256').update(text).digest('hex');
const isContext = (name) => typeof name === 'string' && (name.startsWith('context_') || name === 'annotate');
const meaningful = (response) => (response.text ?? '').trim() !== '' || (response.toolCalls ?? []).length > 0;
const intersection = (a, b) => [...a].filter((item) => b.has(item)).sort();
const sum = (items) => items.reduce((total, item) => total + item, 0);

function loadCapture(directory) {
  const path = resolve(directory);
  const raw = readFileSync(join(path, 'events.jsonl'), 'utf8');
  const rows = raw.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
  for (let index = 0; index < rows.length; index++) {
    if (!Number.isSafeInteger(rows[index].seq) || (index > 0 && rows[index].seq <= rows[index - 1].seq)) throw new Error(`${path}: capture event sequence is invalid`);
  }
  const manifest = rows.find((row) => row.kind === 'manifest')?.value;
  if (manifest?.version !== 1) throw new Error(`${path}: requires a current RunCapture v1 manifest, not historical telemetry`);
  const seen = new Map();
  const blob = (id) => {
    if (typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id)) throw new Error(`${path}: invalid blob reference ${String(id)}`);
    if (!seen.has(id)) {
      const text = readFileSync(join(path, 'blobs', id), 'utf8');
      if (digest(text) !== id) throw new Error(`${path}: blob digest mismatch ${id}`);
      seen.set(id, text);
    }
    return seen.get(id);
  };
  return { path, rows, manifest, blob, seen, eventsSha256: digest(raw), closed: rows.some((row) => row.kind === 'capture_complete') };
}

/** Only data recorded at or before producer.seq can affect these features.
 * Future assistant text and future requests are reserved for outcome labels. */
function producerPrefix(capture, producer, responses) {
  const { rows, blob } = capture;
  const response = responses.filter((item) => item.row.seq < producer.seq).at(-1);
  if (!response) return { unavailable: 'no preceding agent response' };
  const previous = JSON.parse(blob(response.row.value.requestBlob));
  const profile = rows.find((row) => row.kind === 'attention_profile')?.value.profile;
  if (profile?.ledger === true) return { unavailable: 'ledger reconstruction requires source-by-source ledger snapshots' };
  const messages = previous.messages.map(({ cacheBreakpoint: _cache, ...message }) => message);
  messages.push({ role: 'assistant', content: response.result.text });
  let cursor = response.row.seq;
  const prefix = rows.filter((row) => row.seq > cursor && row.seq <= producer.seq);
  const observed = prefix.filter((row) => row.kind === 'attention_tool');
  for (const call of response.result.toolCalls ?? []) {
    let event;
    let output;
    let message;
    let error = false;
    if (observed.length > 0) {
      event = observed.find((row) => row.seq > cursor && row.value.callId === call.id);
      if (!event) return { unavailable: 'a preceding tool outcome is not recorded by this prefix' };
      message = JSON.parse(blob(event.value.messageBlob));
      output = blob(event.value.originalBlob);
      error = event.value.isError === true;
    } else if (call.name === 'read_file') {
      event = prefix.find((row) => row.seq > cursor && row.kind === 'read_file' && row.value.path === call.input.path);
      if (!event) return { unavailable: 'missing read_file outcome or repeat-guard response' };
      output = blob(event.value.blob);
    } else if (call.name === 'write_file' || call.name === 'edit_file') {
      event = prefix.find((row) => row.seq > cursor && row.kind === 'write_file' && row.value.path === call.input.path);
      if (!event) return { unavailable: 'missing edit outcome or repeat-guard response' };
      output = call.name === 'write_file' ? `wrote ${call.input.path} (${String(call.input.content).length} bytes)` : `edited ${call.input.path}`;
    } else if (call.name === 'run_command') {
      const command = prefix.find((row) => row.seq > cursor && row.kind === 'command' && row.value.command === call.input.command);
      event = command && prefix.find((row) => row.seq > command.seq && row.kind === 'command_result');
      if (!event) return { unavailable: 'missing command outcome or repeat-guard response' };
      output = renderOutcome({ ...event.value, stdout: blob(event.value.stdout), stderr: blob(event.value.stderr) });
      error = event.value.exitCode !== 0;
    } else return { unavailable: `unrecorded native tool result: ${call.name}` };
    cursor = event.seq;
    const label = capture.manifest.toolResultRepresentation === TOOL_RESULT_TRANSCRIPT_VERSION
      ? renderToolResult(call, { output: '', isError: error })
      : `[tool_result ${call.name}] ${error ? 'ERROR: ' : ''}`;
    message ??= { role: 'user', content: label + output };
    if (event.seq === producer.seq) {
      return { response, previous, before: messages, call, label, observedMessage: message, original: output, featureCaptureSeq: producer.seq };
    }
    messages.push(message);
  }
  return { unavailable: 'producer does not match the current response tool calls' };
}

function payloadProbe(capture, producer, responses, chars) {
  const prefix = producerPrefix(capture, producer, responses);
  if (prefix.unavailable) return { sourceCaptureSeq: producer.seq, tool: producer.tool, status: 'unavailable', reason: prefix.unavailable };
  const window = capture.manifest.options?.window;
  if (!Number.isSafeInteger(window) || window <= 0 || !Number.isSafeInteger(chars) || chars <= 0) {
    return { sourceCaptureSeq: producer.seq, tool: producer.tool, status: 'unavailable', reason: 'requires recorded physical window and explicit excerptChars (profile or CLI)' };
  }
  const terms = typeof prefix.call.input.query === 'string' ? prefix.call.input.query.split(/\s+/).filter(Boolean) : [];
  const withPayload = (text) => ({ ...prefix.previous, messages: [...prefix.before, { role: 'user', content: prefix.label + text }] });
  const baseTokens = countTokens(JSON.stringify(withPayload('')));
  const budget = Math.max(0, window - baseTokens - 1);
  const tokenizer = { count: (text) => Math.max(0, countTokens(JSON.stringify(withPayload(text))) - baseTokens) };
  const originalBlob = producer.value.originalBlob ?? producer.value.blob;
  const recordedSelection = capture.rows.find((row) => row.kind === 'attention_payload' && row.value.sourceSeq === producer.value.resultSeq)?.value.selection;
  const producerTruncated = recordedSelection?.producerStatus === 'producer_truncated';
  const variants = [['whole', 'first'], ['excerpt', 'first'], ['excerpt', 'rarest'], ['structural', 'first']].map(([mode, anchor]) => {
    const selected = selectPayload({ original: { text: prefix.original, blobId: originalBlob, producerTruncated }, mode, availableTokens: budget, tokenizer, excerpt: { chars, terms, anchor } });
    return { mode, anchor, status: selected.status, producerStatus: selected.producerStatus, tokens: selected.tokens, selectedChars: selected.text?.length ?? null, selectedSha256: selected.text === null ? null : digest(selected.text), omittedChars: selected.omittedChars, selectedSpans: selected.selectedSpans };
  });
  const next = responses.find((item) => item.row.seq > producer.seq && meaningful(item.result));
  let outcomes = { exposureKnown: false, nextAssistantCaptureSeq: next?.row.seq ?? null, referencedIdentifiers: null, novelReferencedIdentifiers: null, referencedFraction: null };
  if (next) {
    const request = JSON.parse(capture.blob(next.row.value.requestBlob));
    const exposed = request.messages.some((message) => message.role === prefix.observedMessage.role && message.content === prefix.observedMessage.content);
    if (exposed) {
      const delivered = extractFingerprints(String(prefix.observedMessage.content));
      const referenced = extractFingerprints(`${next.result.text}\n${JSON.stringify(next.result.toolCalls ?? [])}`);
      const known = extractFingerprints(`${prefix.previous.system ?? ''}\n${prefix.before.map((message) => message.content).join('\n')}`);
      const overlap = intersection(delivered, referenced);
      outcomes = { exposureKnown: true, nextAssistantCaptureSeq: next.row.seq, referencedIdentifiers: overlap, novelReferencedIdentifiers: overlap.filter((term) => !known.has(term)), referencedFraction: delivered.size === 0 ? null : overlap.length / delivered.size };
    }
  }
  return {
    sourceCaptureSeq: producer.seq, tool: producer.tool, sourceBlob: originalBlob, status: 'measured',
    features: { prefixThroughCaptureSeq: prefix.featureCaptureSeq, assistantCaptureSeq: prefix.response.row.seq, requestBlob: prefix.response.row.value.requestBlob, terms, matchedTerms: terms.filter((term) => prefix.original.toLowerCase().includes(term.toLowerCase())), physicalWindow: window, availableTokens: budget, excerptChars: chars },
    originalChars: prefix.original.length, originalTokens: countTokens(prefix.original), variants,
    firstVsRarestChanged: variants[1].selectedSha256 !== variants[2].selectedSha256,
    outcomes,
  };
}

/** Synthetic instrument only: demonstrates recency-safe exclusion/readmission
 * and checks source-prefix/supersession invariants without a success claim. */
export function recurrenceProof() {
  const unit = (id, seq, extra = {}) => ({ id, seq, tokens: 10, state: 'resident', fingerprints: [], exchangeId: id, ...extra });
  const pins = ['task', 'plan', 'steering'].map((role, index) => unit(role, index + 1, { role }));
  const api = unit('api', 4, { fingerprints: ['api.encode'] });
  const ui = unit('ui', 8);
  const policy = { excludeIrrelevant: true, pinPlan: true, recency: 'exchange' };
  const run = (units, turn, asOfSeq, queryFingerprints, currentExchangeId, more = {}) => selectAttention({ units, turn, asOfSeq, queryFingerprints, currentExchangeId, policy, ...more });
  const apiTurn = run([...pins, api], 1, 4, ['api.encode'], 'api');
  const dormant = { ...api, relevance: { value: 'irrelevant', turn: 2, sourceSeq: 9, reason: 'synthetic independently labeled UI phase' } };
  const uiTurn = run([...pins, dormant, ui], 2, 9, ['ui.render'], 'ui');
  const testTurn = run([...pins, dormant, ui], 3, 10, ['api.encode'], 'tests');
  const priority = { boost: 1, halfLifeTurns: 1, calibrationId: 'synthetic-only' };
  const refs = [{ unitId: 'api', seq: 5, turn: 1, kind: 'reference' }, { unitId: 'api', seq: 9, turn: 2, kind: 'supersede' }, { unitId: 'api', seq: 10, turn: 3, kind: 'reference' }];
  const beforeSupersession = run([api], 1, 5, [], 'tests', { policy: { priority }, references: refs });
  const afterSupersession = run([api], 3, 10, ['api.encode'], 'tests', { policy: { priority }, references: refs });
  let futureRejected = false;
  try { run([api], 1, 3, [], 'tests'); } catch { futureRejected = true; }
  const allPins = (result) => pins.every((pin) => result.selectedIds.includes(pin.id));
  const checks = {
    apiInitiallyPresent: apiTurn.selectedIds.includes('api'), dormantApiExcluded: !uiTurn.selectedIds.includes('api'),
    apiReadmitted: testTurn.selectedIds.includes('api'), allPinsPreserved: [apiTurn, uiTurn, testTurn].every(allPins),
    creationOrderPreserved: testTurn.selectedIds.join(',') === 'task,plan,steering,api,ui',
    futureSourceRejected: futureRejected, futureSupersessionIgnored: beforeSupersession.audit[0].priority > 0,
    supersededPriorityZeroDespiteLaterReference: afterSupersession.audit[0].priority === 0,
    supersessionDoesNotEraseRelevantHistory: afterSupersession.selectedIds.includes('api'),
  };
  return { scope: 'synthetic mechanism instrument; no live or quality claim', passed: Object.values(checks).every(Boolean), checks, phases: [apiTurn, uiTurn, testTurn].map((result) => result.selectedIds) };
}

export function replayAttentionCapture(directory, options = {}) {
  const capture = loadCapture(directory);
  const { rows, blob } = capture;
  const responses = rows.filter((row) => row.kind === 'response' && row.value.role === 'agent').map((row) => ({ row, result: JSON.parse(blob(row.value.responseBlob)) }));
  const profile = rows.find((row) => row.kind === 'attention_profile')?.value.profile ?? capture.manifest.options?.policyProfile;
  const chars = options.excerptChars ?? profile?.payload?.excerptChars;
  const attentionTools = rows.filter((row) => row.kind === 'attention_tool');
  const producers = attentionTools.length > 0
    ? attentionTools.filter((row) => row.value.executed !== false && (row.value.name === 'read_file' || isContext(row.value.name))).map((row) => ({ ...row, tool: row.value.name }))
    : rows.filter((row) => row.kind === 'read_file').map((row) => ({ ...row, tool: 'read_file' }));
  const payloads = producers.map((producer) => payloadProbe(capture, producer, responses, chars));
  const signals = responses.flatMap(({ row, result }, index) => {
    const next = responses.slice(index + 1).find((item) => meaningful(item.result));
    const recorded = rows.find((entry) => entry.kind === 'attention_signals' && entry.seq > row.seq && (!next || entry.seq < next.row.seq));
    const coordinate = recorded ? recorded.value.sourceSeq : row.seq;
    const detected = detectAttentionSignals(result.text ?? '', coordinate);
    if (recorded && blob(recorded.value.sourceBlob) !== result.text) throw new Error('assistant signal source differs from captured response');
    if (recorded && JSON.stringify(recorded.value.signals) !== JSON.stringify(detected)) throw new Error('recorded signal offsets differ from the current detector; freeze/rebuild the intended epoch');
    return detected.map((signal) => ({
      ...signal, source: recorded ? 'L0_assistant_message' : 'capture_agent_response', sourceCaptureSeq: row.seq, responseBlob: row.value.responseBlob,
      featurePrefixThroughCaptureSeq: row.seq, offsetsValid: result.text.slice(signal.start, signal.end) === signal.phrase,
      outcomes: {
        nextAssistantCaptureSeq: next?.row.seq ?? null,
        contextCallsIssuedWithSignal: (result.toolCalls ?? []).filter((call) => isContext(call.name)).length,
        executedContextCallsBeforeNextAssistant: next ? attentionTools.filter((tool) => tool.seq > row.seq && tool.seq < next.row.seq && tool.value.executed !== false && isContext(tool.value.name)).length : null,
        readFileOutcomesBeforeNextAssistant: next ? payloads.filter((payload) => payload.sourceCaptureSeq > row.seq && payload.sourceCaptureSeq < next.row.seq && payload.tool === 'read_file').length : null,
        referencedIdentifiers: next ? [...new Set(payloads.filter((payload) => payload.sourceCaptureSeq > row.seq && payload.sourceCaptureSeq < next.row.seq).flatMap((payload) => payload.outcomes?.referencedIdentifiers ?? []))].sort() : null,
      },
    }));
  });
  const measured = payloads.filter((payload) => payload.status === 'measured');
  const missing = (requirements) => ({ eligible: false, status: 'missing_labels', missing: requirements });
  const eligibility = {
    H1: missing(['current-turn grounded irrelevance labels', 'independently judged recurring evidence after exclusion']),
    H2: missing(['complete candidate relevance mass', 'known exposed positive and negative useful-evidence labels', 'held-out session/scenario split']),
    H3: missing(['typed source-linked active plan artifact', 'same-epoch plan-only ablation']),
    H4: missing(['labeled true/false sufficiency and topic-shift examples', 'causal usefulness labels; identifier overlap is observational']),
    H5: missing(['explicit demand/envelope labels', 'H2 setting frozen before demand-only comparison']),
    H6: missing(['source-linked current-subtask boundaries', 'exchange/subtask/all ablations at equal n']),
    priority: { ...missing(['exposed candidate/reference labels with positives and negatives', 'held-out calibration split', 'actual changed admission']), nextFetchAuc: null },
  };
  return {
    directory: capture.path, eventsSha256: capture.eventsSha256, closedCapture: capture.closed,
    manifest: { version: capture.manifest.version, runId: capture.manifest.runId, arm: capture.manifest.arm, scenario: capture.manifest.scenario?.id, model: capture.manifest.options?.model },
    scope: 'instrumentation only; no quality, equivalence, or calibrated-default claim',
    coordinates: rows.some((row) => row.kind === 'attention_signals') ? 'L0 and capture sequence, explicitly distinguished' : 'capture sequence only; no native L0 labels available',
    summary: {
      agentResponses: responses.length, meaningfulAgentResponses: responses.filter((response) => meaningful(response.result)).length,
      contextCallsIssued: sum(responses.map(({ result }) => (result.toolCalls ?? []).filter((call) => isContext(call.name)).length)),
      signalCount: signals.length, signalRate: responses.length === 0 ? null : signals.length / responses.length,
      signalsByKind: Object.fromEntries(['sufficiency', 'research_done', 'topic_shift'].map((kind) => [kind, signals.filter((signal) => signal.kind === kind).length])),
      payloadSources: payloads.length, payloadsMeasured: measured.length,
      firstVsRarestChanged: measured.filter((payload) => payload.firstVsRarestChanged).length,
      knownExposureRows: measured.filter((payload) => payload.outcomes.exposureKnown).length,
      referencedFractionMean: (() => { const scores = measured.map((payload) => payload.outcomes.referencedFraction).filter((score) => score !== null); return scores.length === 0 ? null : sum(scores) / scores.length; })(),
      verifiedBlobs: capture.seen.size,
    },
    eligibility, signals, payloads,
  };
}

export function replayAttentionCaptures(directories, options = {}) {
  return {
    version: 1, tokenizer: 'gpt-tokenizer@4.0.0/o200k_base', parameters: { excerptChars: options.excerptChars ?? null },
    implementation: {
      scriptSha256: digest(readFileSync(fileURLToPath(import.meta.url), 'utf8')),
      attentionPolicySha256: digest(readFileSync(new URL('../../packages/core/dist/attention/policy.js', import.meta.url), 'utf8')),
      signalsSha256: digest(readFileSync(new URL('../../packages/core/dist/attention/signals.js', import.meta.url), 'utf8')),
      payloadSha256: digest(readFileSync(new URL('../../packages/core/dist/attention/payload.js', import.meta.url), 'utf8')),
      commandRendererSha256: digest(readFileSync(new URL('../dist/sandbox.js', import.meta.url), 'utf8')),
      toolResultRendererSha256: digest(readFileSync(new URL('../dist/transcript.js', import.meta.url), 'utf8')),
    },
    syntheticRecurrenceProof: recurrenceProof(), runs: directories.map((directory) => replayAttentionCapture(directory, options)),
  };
}

function main(argv) {
  const directories = [];
  let output;
  let excerptChars;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[++i];
    if (value === undefined) throw new Error(`${flag} requires a value`);
    if (flag === '--capture-dir') directories.push(value);
    else if (flag === '--output') output = value;
    else if (flag === '--excerpt-chars') {
      excerptChars = Number(value);
      if (!Number.isSafeInteger(excerptChars) || excerptChars <= 0) throw new Error('--excerpt-chars must be a positive integer');
    } else throw new Error(`unknown argument: ${flag}`);
  }
  if (directories.length === 0) throw new Error('provide at least one --capture-dir RUN');
  const report = replayAttentionCaptures(directories, { excerptChars });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (output) { mkdirSync(dirname(resolve(output)), { recursive: true }); writeFileSync(resolve(output), json); }
  else process.stdout.write(json);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
