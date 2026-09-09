#!/usr/bin/env node
/** Frozen scientific inputs; resumable scheduling; no calls before evidence gates. */
import { existsSync, mkdirSync, readFileSync, readdirSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapterFor, BENCHMARK_IDS } from '../dist/adapters/index.js';
import { compareCohorts, summarizeCohort } from '../dist/experiment.js';
import { loadWorkspaceEnv } from '../dist/env.js';
import { canonical, sha256, readJson, writeJsonAtomic, configurePolicyEnvironment, deriveCeilingEvidence, deriveHistoricalCeilingEvidence,
  verifyCeilingEvidence, verifyEnvironmentGates, scientificEpoch, scheduleSlots, validateEscalation,
  inspectAttempt, recordInterruptedAttempt, verifyResumedRow } from '../dist/experiment-runner.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const files = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]).sort();
const args = process.argv.slice(2);
if (args[0] === '--derive-ceiling') {
  console.log(JSON.stringify(deriveCeilingEvidence(args.slice(1).map((path) => resolve(path))), null, 2));
  process.exit(0);
}
if (args[0] === '--derive-historical-ceiling') {
  console.log(JSON.stringify(deriveHistoricalCeilingEvidence(args.slice(1).map((path) => resolve(path))), null, 2));
  process.exit(0);
}
const at = args.indexOf('--manifest');
if (at < 0 || !args[at + 1]) throw new Error('usage: --manifest FILE [--dry-run] | --derive-ceiling CAPTURE_DIR [...]');
const manifestPath = resolve(args[at + 1]);
const manifest = readJson(manifestPath);
if (manifest.version !== 1 || !['pilot', 'comparison', 'confirmation'].includes(manifest.stage)) throw new Error('invalid manifest version/stage');
if (!['anthropic', 'openrouter'].includes(manifest.provider) || typeof manifest.model !== 'string' || !manifest.model) throw new Error('explicit provider/model required');
if (!Number.isSafeInteger(manifest.window) || manifest.window <= 0 || !Number.isSafeInteger(manifest.tokenCap) || manifest.tokenCap <= 0) throw new Error('physical window and measured token ceiling required');
if (!Array.isArray(manifest.tasks) || manifest.tasks.length === 0 || new Set(manifest.tasks).size !== manifest.tasks.length) throw new Error('unique task ids required');
// Optional and defaulted, so every manifest written before LHTB existed still
// resolves to exactly the adapter it was written against.
const benchmark = manifest.benchmark ?? 'deepswe';
if (!BENCHMARK_IDS.includes(benchmark)) throw new Error(`unknown benchmark "${benchmark}" — known: ${BENCHMARK_IDS.join(', ')}`);
if (!Array.isArray(manifest.arms) || manifest.arms.length === 0 || new Set(manifest.arms.map((arm) => arm.id)).size !== manifest.arms.length) throw new Error('unique arms required');
if (!Array.isArray(manifest.gates) || manifest.gates.length === 0 || new Set(manifest.gates.map((path) => resolve(path))).size !== manifest.gates.length) throw new Error('distinct environment gates required');
if (manifest.stage === 'pilot' ? manifest.n !== 1 : ![5, 10].includes(manifest.n)) throw new Error('pilot n=1; scored comparisons start n=5 and may escalate once to n=10');
if (manifest.n !== 10 && (manifest.escalation !== undefined || manifest.escalated === true)) throw new Error('escalation is only valid at n=10');

// Dotenv first, EVAL reset second, policy-bearing module imports third.
const env = configurePolicyEnvironment(() => loadWorkspaceEnv(root), manifest.environment ?? {});
const { createProvider, loadApiKeys, resolveConfig } = await import('../../packages/core/dist/index.js');
const { parseAttentionProfile } = await import('../dist/attention-loop.js');
const { disabledSink } = await import('../dist/langfuse.js');
const { runScenario } = await import('../dist/loop.js');
const { isArm } = await import('../dist/types.js');
const { dockerRuntime } = await import('../dist/sandbox.js');
for (const arm of manifest.arms) {
  if (!/^[a-zA-Z0-9_.-]+$/.test(arm.id) || !isArm(arm.arm)) throw new Error('invalid arm');
  if (arm.arm === 'attention') arm.profile = parseAttentionProfile(arm.profile);
  else if (arm.profile !== undefined) throw new Error('profile only applies to attention arm');
}
const ceilingEvidence = verifyCeilingEvidence(manifest.ceilingEvidence, manifest.tokenCap, { allowHistorical: manifest.stage === 'pilot' });
const loaded = adapterFor(benchmark).load(resolve(manifest.scenariosDir));
const scenarios = manifest.tasks.map((id) => {
  const scenario = loaded.find((candidate) => candidate.id === id);
  if (!scenario) throw new Error(`unknown public task ${id}`);
  if (scenario.benchmark !== benchmark) throw new Error(`task ${id} is not a ${benchmark} scenario`);
  return scenario;
});
const gateDocuments = manifest.gates.map((path) => readJson(resolve(path)));
const gates = scenarios.map((scenario) => verifyEnvironmentGates(scenario, gateDocuments, dockerRuntime));
// Transport is a FROZEN, MANIFEST-DECLARED field, not a constant, so a change
// to it is visible in the manifest, the epoch and the frozen record rather than
// buried here. The default reproduces the original policy exactly
// (sdkMaxRetries 0, one provider attempt) so every existing manifest is
// unaffected.
//
// Why a manifest may want more than one attempt: `Request timed out` voided the
// native run of the loop3 pilot and 3 of 7 runs in the preceding pass, at prompt
// sizes around 2% of the window where no context policy could be implicated.
// isRetryableStatus(undefined) already returns true, so a timeout IS retryable
// and only attempts:1 suppressed it. Retrying does not hide anything: every
// attempt is recorded and `attempted`/`providerErrors` still report the total,
// which is the same treatment the pre-existing empty-completion retry gets.
const declaredTransport = manifest.transport ?? {};
if (Object.keys(declaredTransport).some((key) => !['sdkMaxRetries', 'attempts', 'timeoutMs'].includes(key))) {
  throw new Error('manifest.transport accepts only sdkMaxRetries, attempts and timeoutMs');
}
const sdkMaxRetries = declaredTransport.sdkMaxRetries ?? 0;
const providerAttempts = declaredTransport.attempts ?? 1;
if (!Number.isSafeInteger(sdkMaxRetries) || sdkMaxRetries < 0) throw new Error('transport.sdkMaxRetries must be a nonnegative integer');
if (!Number.isSafeInteger(providerAttempts) || providerAttempts < 1) throw new Error('transport.attempts must be an integer >= 1');
// A timeout is declared, not defaulted: the SDK's own default is 10 minutes,
// which spends 30 minutes over 3 attempts discovering that a 25 KB request is
// never going to be answered. Fail fast, retry more.
const timeoutMs = declaredTransport.timeoutMs;
if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)) throw new Error('transport.timeoutMs must be a positive integer');
if (manifest.agentMaxTokens !== undefined && (!Number.isSafeInteger(manifest.agentMaxTokens) || manifest.agentMaxTokens <= 0)) {
  throw new Error('agentMaxTokens must be a positive integer');
}
if (manifest.completionNudgeBudget !== undefined && (!Number.isSafeInteger(manifest.completionNudgeBudget) || manifest.completionNudgeBudget < 1)) {
  throw new Error('completionNudgeBudget must be an integer >= 1');
}
// The timeout is meaningless unless generation is bounded: an uncapped reply on
// a slow model exceeds any timeout, so a timeout without a reply cap kills
// legitimate long writes rather than hung calls. Require them together, and
// require the timeout to actually cover the capped generation at the manifest's
// own measured rate.
if (timeoutMs !== undefined && manifest.agentMaxTokens === undefined) {
  throw new Error('transport.timeoutMs requires agentMaxTokens: an uncapped reply cannot be timed out safely');
}
if (timeoutMs !== undefined && manifest.generationTokensPerSecond !== undefined) {
  const needed = 1000 * manifest.agentMaxTokens / manifest.generationTokensPerSecond;
  if (timeoutMs < needed) {
    throw new Error(`transport.timeoutMs ${timeoutMs} is below the ${Math.ceil(needed)}ms a full ${manifest.agentMaxTokens}-token reply needs at ${manifest.generationTokensPerSecond} tok/s`);
  }
}
const transportPolicy = { sdkMaxRetries, retry: { attempts: providerAttempts },
  ...(timeoutMs === undefined ? {} : { timeoutMs }) };
const replyPolicy = manifest.provider === 'anthropic'
  ? { kind: 'existing-provider-default', defaultMaxTokens: 4096, verifiedModelLimit: false, confirmationEligible: false }
  : { kind: 'no-harness-reply-limit', defaultMaxTokens: null, confirmationEligible: true };
if (manifest.stage === 'confirmation' && !replyPolicy.confirmationEligible) throw new Error('Anthropic confirmation requires a verified advertised model output limit; its existing 4096-token provider default is not qualified');
const common = { provider: manifest.provider, model: manifest.model,
  leafModel: manifest.leafModel ?? manifest.model, rootModel: manifest.rootModel ?? manifest.model, judgeModel: manifest.model,
  maxTurns: Infinity, timeCapMs: Infinity, costCapUsd: null, tokenCap: manifest.tokenCap,
  ...(manifest.agentMaxTokens === undefined ? {} : { agentMaxTokens: manifest.agentMaxTokens }),
  ...(manifest.completionNudgeBudget === undefined ? {} : { completionNudgeBudget: manifest.completionNudgeBudget }),
  window: manifest.window, budgets: manifest.budgets ?? { zoneB: 8000, zoneC: 30000 },
  keepSandbox: false, temperature: manifest.temperature ?? null, transportPolicy, transportRetriesDisabled: sdkMaxRetries === 0 && providerAttempts === 1,
  attemptScope: 'ModelProvider.complete', replyPolicy };
const readInstrument = () => {
  const sourceFiles = ['packages/core/src', 'packages/mcp/src', 'eval/src', 'packages/core/dist', 'packages/mcp/dist', 'eval/dist'].flatMap((directory) => files(join(root, directory)));
  sourceFiles.push(fileURLToPath(import.meta.url), ...['package.json', 'pnpm-lock.yaml', 'eval/package.json', 'packages/core/package.json', 'packages/mcp/package.json'].map((path) => join(root, path)));
  return Object.fromEntries(sourceFiles.map((path) => [path.slice(root.length + 1), sha256(readFileSync(path))]));
};
const instrument = readInstrument();
const server = dockerRuntime.sync(['version', '--format', '{{json .Server}}']);
if (server.exitCode !== 0) throw new Error(`Docker runtime unavailable: ${server.stderr}`);
const frozen = scientificEpoch({ common, arms: manifest.arms, scenarios, environment: env, gates, instrument,
  runtime: { node: process.version, platform: process.platform, architecture: process.arch, docker: JSON.parse(server.stdout) } });
const { epoch } = frozen;
const output = resolve(manifest.output);
const frozenPath = join(output, 'frozen.json');
if (existsSync(frozenPath) && canonical(readJson(frozenPath)) !== canonical(frozen)) throw new Error('scientific inputs changed; start a new epoch/output (n and output alone do not change the epoch)');
const resultsPath = join(output, 'results.json');
const results = existsSync(resultsPath) ? readJson(resultsPath) : [];
if (!Array.isArray(results)) throw new Error('invalid results ledger');
const armIds = manifest.arms.map((arm) => arm.id);
const slotKey = (slot) => `${slot.scenario}/${slot.arm}/${slot.replicate}`;
const markerFor = (slot, previous) => {
  const arm = manifest.arms.find((candidate) => candidate.id === slot.arm);
  const scenario = scenarios.find((candidate) => candidate.id === slot.scenario);
  if (!arm || !scenario || !Number.isSafeInteger(slot.replicate) || slot.replicate < 1 || slot.replicate > 10) throw new Error('attempt is outside frozen tasks/arms/replicates');
  const runId = `${scenario.id}-${arm.id}-r${slot.replicate}`;
  const options = { ...common, policyProfile: arm.profile, captureDir: join(output, 'captures', runId) };
  const capturePath = join(options.captureDir, `${scenario.benchmark}-${scenario.id}-${arm.arm}`.replace(/[^a-zA-Z0-9_.-]/g, '_'));
  const marker = { version: 1, arm: slot.arm, scenario: slot.scenario, replicate: slot.replicate, runId, epoch, model: manifest.model,
    configHash: sha256(canonical({ ...common, profile: arm.profile, arm: arm.arm, env })), capturePath,
    expectedManifest: { version: 1, runId, arm: arm.arm, scenario: { ...scenario, files: undefined }, options },
    state: previous?.state ?? 'running', startedAt: previous?.startedAt ?? new Date().toISOString() };
  if (previous && canonical(previous) !== canonical(marker)) throw new Error(`attempt marker changed: ${runId}`);
  return marker;
};
const markerPath = (marker) => join(output, 'attempts', `${marker.runId}.json`);
const gateFor = (slot) => gates[scenarios.findIndex((scenario) => scenario.id === slot.scenario)];
const seen = new Set();
for (const row of results) {
  if (seen.has(slotKey(row))) throw new Error('duplicate result slot');
  seen.add(slotKey(row));
  const slot = { arm: row.arm, scenario: row.scenario, replicate: row.replicate };
  const initial = markerFor(slot);
  const marker = markerFor(slot, readJson(markerPath(initial)));
  verifyResumedRow(row, marker, gateFor(marker));
}
const escalatedCandidates = manifest.n === 10 ? validateEscalation(manifest.escalation, output, epoch, armIds, manifest.tasks, results) : [];
const slots = scheduleSlots(armIds, manifest.tasks, manifest.n, escalatedCandidates);
if (results.some((row) => !slots.some((slot) => slotKey(slot) === slotKey(row)))) throw new Error('schedule would discard previously recorded attempts');
if (args.includes('--dry-run')) {
  console.log(JSON.stringify({ epoch, benchmark, tasks: manifest.tasks, arms: armIds, n: manifest.n, escalatedCandidates,
    plannedLogicalRuns: slots.length, existingLogicalRuns: results.length, maximumCallsTokenBudget: manifest.tokenCap * slots.length, ceilingEvidence,
    note: 'Each run may overshoot the measured ceiling by one in-flight response; no model calls made.' }, null, 2));
  process.exit(0);
}
mkdirSync(output, { recursive: true });
const lockPath = join(output, 'runner.lock');
if (existsSync(lockPath)) {
  const pid = readJson(lockPath).pid;
  let alive = true;
  try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error; }
  if (alive) throw new Error(`another runner holds this output (pid ${pid})`);
  unlinkSync(lockPath);
}
const lock = openSync(lockPath, 'wx'); closeSync(lock);
writeJsonAtomic(lockPath, { pid: process.pid, epoch });
let active;
const persistRow = (row) => {
  if (results.some((existing) => slotKey(existing) === slotKey(row))) return;
  results.push(row); writeJsonAtomic(resultsPath, results);
};
const interrupted = (marker, reason) => {
  persistRow(recordInterruptedAttempt(marker, gateFor(marker), reason));
  writeJsonAtomic(markerPath(marker), { ...marker, state: 'settled' });
};
const signal = (name) => {
  try { if (active) interrupted(active, `runner received ${name}; pending provider usage is unknown`); }
  finally { if (existsSync(lockPath)) unlinkSync(lockPath); process.exit(name === 'SIGINT' ? 130 : 143); }
};
const onInterrupt = () => signal('SIGINT');
const onTerminate = () => signal('SIGTERM');
process.once('SIGINT', onInterrupt); process.once('SIGTERM', onTerminate);
try {
  if (!existsSync(frozenPath)) writeJsonAtomic(frozenPath, frozen);
  const schedule = { epoch, stage: manifest.stage, n: manifest.n, escalatedCandidates, manifestPath, manifestSha256: sha256(readFileSync(manifestPath)), ceilingEvidence,
    escalation: manifest.escalation ?? null, slots };
  const schedulePath = join(output, `schedule-n${manifest.n}.json`);
  if (existsSync(schedulePath) && canonical(readJson(schedulePath)) !== canonical(schedule)) throw new Error('registered schedule changed; start a new output');
  if (!existsSync(schedulePath)) writeJsonAtomic(schedulePath, schedule);
  // Before a call there is always a durable marker. Interrupted slots are kept.
  for (const slot of slots) {
    if (seen.has(slotKey(slot))) continue;
    let marker = markerFor(slot);
    if (existsSync(markerPath(marker))) {
      marker = markerFor(slot, readJson(markerPath(marker)));
      interrupted(marker, 'previous process stopped before recording a durable result'); seen.add(slotKey(slot));
    } else if (existsSync(marker.capturePath)) throw new Error(`unregistered capture cannot be assigned a scientific epoch: ${marker.capturePath}`);
  }
  const provider = createProvider(resolveConfig({ provider: manifest.provider }), loadApiKeys(), transportPolicy);
  for (const slot of slots) {
    if (results.some((row) => slotKey(row) === slotKey(slot))) continue;
    if (canonical(readInstrument()) !== canonical(instrument)) throw new Error('instrument changed during the batch; stop before another model call');
    const activeEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('EVAL_')));
    if (canonical(activeEnv) !== canonical(env)) throw new Error('EVAL policy changed during the batch');
    const currentScenario = scenarios.find((candidate) => candidate.id === slot.scenario);
    if (canonical(verifyEnvironmentGates(currentScenario, gateDocuments, dockerRuntime)) !== canonical(gateFor(slot))) throw new Error('gate artifacts or images changed during the batch');
    const marker = markerFor(slot); writeJsonAtomic(markerPath(marker), marker); active = marker;
    console.log(JSON.stringify({ stage: 'run-start', runId: marker.runId, epoch }));
    try {
      const scenario = scenarios.find((candidate) => candidate.id === slot.scenario);
      const arm = manifest.arms.find((candidate) => candidate.id === slot.arm);
      const { result } = await runScenario({ runId: marker.runId, scenario, arm: arm.arm, options: marker.expectedManifest.options, agentProvider: provider, sink: disabledSink() });
      const row = inspectAttempt(marker, gateFor(marker), result); persistRow(row);
      writeJsonAtomic(markerPath(marker), { ...marker, state: 'settled' });
      console.log(JSON.stringify({ stage: 'run-complete', runId: marker.runId, success: row.success, score: row.score, status: row.status, allModelTokens: row.allModelTokens, mechanismEvents: row.mechanismEvents }));
    } catch (error) {
      interrupted(marker, `runner failure: ${String(error)}`);
      console.error(JSON.stringify({ stage: 'run-interrupted', runId: marker.runId, error: String(error) })); throw error;
    } finally { active = undefined; }
  }
  const comparisons = manifest.stage === 'pilot' ? [] : manifest.arms.slice(1).map((arm) => {
    const escalated = escalatedCandidates.includes(arm.id);
    const paired = results.filter((row) => row.replicate <= (escalated ? 10 : 5));
    return { candidate: arm.id, ...compareCohorts(paired, { baseline: armIds[0], candidate: arm.id, model: manifest.model, epoch, primaryScenarios: manifest.tasks, escalated }) };
  });
  const summary = { epoch, stage: manifest.stage, n: manifest.n, escalatedCandidates,
    cohorts: Object.fromEntries(manifest.arms.map((arm) => [arm.id, summarizeCohort(results.filter((row) => row.arm === arm.id))])), comparisons,
    promotion: 'Requires independent review and combined holdout confirmation; this runner never changes defaults.' };
  writeJsonAtomic(join(output, 'summary.json'), summary);
  const checkpoint = join(output, `summary-n${manifest.n}.json`);
  if (existsSync(checkpoint) && canonical(readJson(checkpoint)) !== canonical(summary)) throw new Error('completed checkpoint changed');
  if (!existsSync(checkpoint)) writeJsonAtomic(checkpoint, summary);
} finally {
  process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onTerminate);
  if (existsSync(lockPath)) unlinkSync(lockPath);
}
