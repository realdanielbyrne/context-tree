#!/usr/bin/env node
/**
 * The opencode HOST ADAPTER: one Node process per run. It contains no pipeline logic.
 *
 * It does the one thing `@context-tree/mcp` cannot do for itself — feed L0 from a LIVE
 * opencode session — and then starts the package's server on that store:
 *
 *   1. FOLLOW. Each event is stamped with its opencode message id (`turn_id`), which is what
 *      makes a pipeline unit — a turn — the same thing as a host message. opencode 1.18.31 keeps sessions in SQLite
 *      (`$XDG_DATA_HOME/opencode/opencode.db`, tables `message` and `part`, each row a JSON
 *      `data` column plus its ids) — the shapes `opencode export` prints, so
 *      `mapOpencodeExport` reads them unchanged. The db is polled read-only rather than
 *      shelling out to `opencode export`, which makes a model call at start-up and would
 *      take a slot from the run it is measuring. Only SETTLED parts are ingested, so L0
 *      stays an append-only prefix. `packages/mcp/dist/bin.js` alone serves a store someone
 *      built earlier; in a SWE-bench cell the only history is the one being produced now.
 *   2. SERVE the tool registry (D22) twice over one session: MCP stdio to the agent, and
 *      loopback HTTP to the plugin (`oc-plugin/`), which holds the eviction POLICY.
 *
 * Why a separate process from the plugin: the plugin runs inside opencode's bun runtime,
 * and the pipeline needs Node with `better-sqlite3` and tree-sitter. A fault here cannot
 * take down the host being measured.
 *
 * stdout is the MCP transport: everything diagnostic goes to stderr.
 *
 *   CT_MCP_ROOT        context-tree store root   (required)
 *   CT_MCP_DB          opencode.db to follow     (default $XDG_DATA_HOME/opencode/opencode.db)
 *   CT_MCP_POLL_MS                               (default 1500)
 *   CT_MCP_LOG         jsonl: ingest ticks, every tool call made over HTTP, the fire-gate record
 *   CT_ASSEMBLE_PORT   the HTTP tool API's port; 0 disables it   (default 8899, loopback only)
 *   CT_ASSEMBLE_TOKEN  bearer token for that API
 *   CT_CONTRACT        system-contract version shipped as MCP instructions (default v1)
 *   CT_CT_NEUTRAL_PHASES  comma list, or `none` — decides PHASE granularity (default: config)
 *   CT_CT_*            server defaults for the pipeline tools. The list is not restated here:
 *                      it is `@context-tree/mcp` PIPELINE_PARAMS (`GET /v1/params`), and a value
 *                      that does not parse stops the process.
 *   CT_G0_DROP_FIRST   1 = the G0 gate, not an arm (see below)
 *
 * The eviction trigger, its windows and the cadence are NOT here. They are the plugin's
 * (`oc-plugin/policy.mjs`): a policy is the sequence of calls a caller makes.
 */
import { existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Experiment scripts load the packages from their build output rather than by
// package name (the established pattern here, and the one that survives being
// bind-mounted into the sandbox at a path node_modules knows nothing about).
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = process.env.CT_REPO_ROOT ?? join(HERE, '..', '..');
const dist = (pkg) => pathToFileURL(join(REPO, 'packages', pkg, 'dist', 'index.js')).href;

const { TreeRetriever, ingest, openTaskStore, resolveConfig } = await import(dist('core'));
const { TOOLS, countActions, createHttpApi, createServer, createSession, pipelineFromEnv, toolContext, withHandlers } = await import(dist('mcp'));
const { mapOpencodeExport } = await import(dist('cli'));

const requireFromCore = createRequire(join(REPO, 'packages', 'core', 'dist', 'index.js'));
const requireFromMcp = createRequire(join(REPO, 'packages', 'mcp', 'dist', 'index.js'));
const Database = requireFromCore('better-sqlite3');
const { StdioServerTransport } = await import(
  pathToFileURL(requireFromMcp.resolve('@modelcontextprotocol/sdk/server/stdio.js')).href
);

const POLL_MS = Number(process.env.CT_MCP_POLL_MS ?? 1500);
const ROOT = process.env.CT_MCP_ROOT;
const DB = process.env.CT_MCP_DB
  ?? join(process.env.XDG_DATA_HOME ?? join(process.env.HOME ?? '', '.local', 'share'), 'opencode', 'opencode.db');
const LOG = process.env.CT_MCP_LOG;
const G0_DROP_FIRST = process.env.CT_G0_DROP_FIRST === '1';
const G0_FOLD_TEXT = process.env.CT_G0_FOLD_TEXT || '';
const G0_REDUCE_TEXT = process.env.CT_G0_REDUCE_TEXT || '';
const G0_STUB_TEXT = process.env.CT_G0_STUB_TEXT || '';

const log = (message) => process.stderr.write(`ct-sidecar: ${message}\n`);
const record = (row) => {
  if (!LOG) return;
  try {
    appendFileSync(LOG, `${JSON.stringify({ ts: new Date().toISOString(), ...row })}\n`);
  } catch {
    // The log is evidence, not the experiment: a failed write must not take the server down.
  }
};

/** A tool part is settled once it has run; a text part once its message is complete. */
function settled(part, message) {
  if (part.type === 'tool') return part.state?.status === 'completed' || part.state?.status === 'error';
  if (part.type === 'text') return typeof message.time?.completed === 'number' || message.role === 'user';
  return true;
}

/**
 * A message is INGESTABLE only once it can never gain another event.
 *
 * Ingesting it earlier corrupts L0, and not visibly: a tool part settles as soon as it
 * has run, while the message's text part settles only when the message completes, and
 * `mapOpencodeExport` emits the text event BEFORE the tool events. So a message caught
 * mid-step maps to `[tool_call, tool_result]` on one poll and
 * `[assistant_message, tool_call, tool_result, …]` on the next — a new event appears in
 * FRONT of one already appended. L0 is append-only, so the assistant message is lost for
 * good, a result is duplicated, and `call_seq` stops pointing at its call.
 */
function ingestable(message) {
  if (message.info.role === 'user') return true;
  if (typeof message.info.time?.completed !== 'number') return false;
  return (message.parts ?? []).every((part) => settled(part, message.info));
}

/**
 * The session as an export-shaped document. The db splits what the export
 * inlines: ids live in columns, the rest in `data`.
 */
function readSession(db, sessionId = null) {
  // One session only. A child session — a `task` subagent, a compaction head — would
  // otherwise interleave into the same L0 by timestamp and into the same index.
  const where = sessionId ? ' WHERE session_id = ?' : '';
  const args = sessionId ? [sessionId] : [];
  const messages = db
    .prepare(`SELECT id, session_id, data, time_created FROM message${where} ORDER BY time_created ASC, id ASC`)
    .all(...args);
  const parts = db
    .prepare(`SELECT id, message_id, session_id, data, time_created FROM part${where} ORDER BY time_created ASC, id ASC`)
    .all(...args);
  const byMessage = new Map();
  for (const row of parts) {
    let parsed;
    try {
      parsed = JSON.parse(row.data);
    } catch {
      continue;
    }
    const part = { ...parsed, id: row.id, messageID: row.message_id, sessionID: row.session_id };
    if (!byMessage.has(row.message_id)) byMessage.set(row.message_id, []);
    byMessage.get(row.message_id).push(part);
  }
  const out = [];
  for (const row of messages) {
    let info;
    try {
      info = JSON.parse(row.data);
    } catch {
      continue;
    }
    info = { ...info, id: row.id, sessionID: row.session_id };
    const own = (byMessage.get(row.id) ?? []).filter((part) => settled(part, info));
    out.push({ info, parts: own });
  }
  return { messages: out };
}

/**
 * Follows the session: appends what is new and re-derives L1. Each message is mapped ALONE
 * and appended immediately, so its events carry its own id as `turn_id` and L0 receives
 * exactly one turn per host message.
 */
export function makeFollower(handle) {
  const done = new Set();
  let sessionId = null;
  let appendedTotal = 0;

  return function tick(db) {
    // The session under test is the one that opened first; everything else is a child.
    if (!sessionId) {
      const first = db.prepare('SELECT session_id FROM message ORDER BY time_created ASC, id ASC LIMIT 1').get();
      if (!first) return { appended: 0, total: appendedTotal };
      sessionId = first.session_id;
    }
    const doc = readSession(db, sessionId);

    let appended = 0;
    for (const message of doc.messages) {
      if (done.has(message.info.id) || !ingestable(message)) continue;
      const mapped = mapOpencodeExport({ messages: [message] }, { startSeq: handle.trace.lastSeq(), blobs: handle.blobs });
      for (const event of mapped.events) {
        const { seq: _seq, ...rest } = event;
        handle.trace.append(rest);
      }
      done.add(message.info.id);
      appended += mapped.events.length;
    }
    if (appended === 0) return { appended: 0, total: appendedTotal };

    appendedTotal += appended;
    const stats = ingest({ handle });
    return { appended, total: appendedTotal, messages: done.size, nodes: stats.stats.nodes, phases: stats.stats.phases };
  };
}

/**
 * G0 — MUTATION VISIBILITY. A gate, not an arm, and deliberately not a policy.
 *
 * Every arm's evidence rests on one unproven claim: that an in-place edit in the plugin
 * survives into the bytes opencode sends. Nothing downstream of the plugin can check it —
 * the plugin's log records its intention, the sidecar's records its verdict, and both sit
 * upstream of the serializer. Only the relay's wire record is evidence.
 *
 * THE GATE MAY NOT BREAK THE REQUEST IT IS MEASURING. Dropping the task statement was the
 * obvious design and it is wrong: opencode's loop holds exactly ONE user message, so
 * splicing it out leaves system + assistant, and this chat template answers
 * `500 Jinja Exception: No user query found in messages`. A rejected prompt says nothing
 * about what the provider would have read, and the missing marker reads as success.
 *
 * So the gate makes both edits the arms make, on the same array, in the same turn:
 *
 *   FOLD  messages[0] -> a replacement carrying a SECOND marker. Two-sided and direct: the
 *         task statement's marker must vanish from the wire and the replacement's must
 *         appear. A user message survives, so the request stays well-formed.
 *   REDUCE the first tool output past messages[1], from five messages on — the edit every
 *         reduction makes. Two-sided like the fold: text that exists nowhere but the
 *         replacement must arrive on the wire.
 *   STUB  the NEXT tool-carrying message after that one, from six messages on — what
 *         `evictMode: 'stub'` does: reasoning parts removed and an output replaced by a tag,
 *         on the same message. The tag's text must arrive, and the request must be accepted.
 *   SPLICE messages[1] from four messages on — an assistant message, which carries its own
 *         tool calls and results together and so can never orphan a result.
 *
 * It does nothing before three messages: at turn one the array is the task statement alone,
 * and there is nothing to edit that would leave a request worth sending. Those early turns
 * are the within-run control — the original marker must be on the wire there.
 */
export function g0Decisions(messages, foldText, reduceText = '', stubText = '') {
  const decisions = messages.map((m) => ({ id: m.id, action: 'keep' }));
  if (messages.length < 3 || !foldText) return decisions;
  decisions[0] = { id: messages[0].id, action: 'fold', text: foldText, g0: true };
  if (messages.length >= 4) decisions[1] = { id: messages[1].id, action: 'drop', g0: true };
  // REDUCE: the first tool-carrying message past the spliced one has its first tool OUTPUT
  // replaced. The call and its result stay paired, so the request stays well-formed.
  const target = reduceText && messages.length >= 5 ? messages.findIndex((m, i) => i >= 2 && m.hasTools) : -1;
  if (target >= 0) decisions[target] = { id: messages[target].id, action: 'reduce', outputs: [{ index: 0, text: reduceText }], g0: true };
  const next = stubText && target >= 0 && messages.length >= 6 ? messages.findIndex((m, i) => i > target && m.hasTools) : -1;
  if (next >= 0) decisions[next] = { id: messages[next].id, action: 'stub', outputs: [{ index: 0, text: stubText }], g0: true };
  return decisions;
}

/** Every HTTP call, as the evidence the gates read: one row per `assemble`, one per `evict`. */
function logCall({ tool, ok, ms, input, outcome }) {
  if (!ok) {
    record({ event: 'assemble_error', tool, ms, error: `${outcome.error?.code}: ${outcome.error?.message}`.slice(0, 800) });
    return;
  }
  const data = outcome.data;
  const actions = data.decisions ? countActions(data.decisions) : null;
  if (tool === 'assemble') {
    const by = (kind) => (data.units ?? []).filter((u) => u.representation === kind).length;
    record({ event: 'assemble', turn: data.turn, window: input.window_tokens, per_unit_budget: data.per_unit_budget, units: data.units?.length ?? 0, tokens_raw: data.tokens_raw, tokens_assembled: data.tokens_assembled, reduced: by('reduce'), folded: by('fold'), actions, ms, ...(G0_DROP_FIRST ? { g0: 'drop_first' } : {}) });
  } else if (tool === 'evict') {
    record({ event: 'evict', turn: data.turn, window: input.window_tokens, reserve: input.reserve_tokens ?? 0, fired: data.fired, evicted: data.evicted, evicted_total: data.evicted_total, stubbed: data.stubbed, stubbed_total: data.stubbed_total, tokens_before: data.tokens_before, tokens_after: data.tokens_after, over_budget: data.over_budget, actions, ms });
  } else {
    record({ event: 'tool', tool, ms });
  }
}

/** The G0 gate swaps ONE stage behind its name; the transports and the plugin are untouched. */
const g0Assemble = async (_ctx, input) => ({
  ok: true,
  data: { turn: input?.turn ?? 0, per_unit_budget: 0, tokens_raw: 0, tokens_assembled: 0, units: [], decisions: g0Decisions(input?.messages ?? [], G0_FOLD_TEXT, G0_REDUCE_TEXT, G0_STUB_TEXT) },
});

function neutralPhasesFromEnv() {
  const raw = process.env.CT_CT_NEUTRAL_PHASES;
  if (raw === undefined || raw === '') return {};
  return { neutralPhases: raw === 'none' ? [] : raw.split(',').map((p) => p.trim()).filter(Boolean) };
}

async function main() {
  if (!ROOT) throw new Error('CT_MCP_ROOT is required');
  mkdirSync(dirname(ROOT), { recursive: true });
  if (LOG) mkdirSync(dirname(LOG), { recursive: true });

  const pipeline = pipelineFromEnv();
  const config = resolveConfig({ root: ROOT, taskTitle: 'swebench task', ...neutralPhasesFromEnv() }, dirname(ROOT));
  const handle = openTaskStore(config);
  const retriever = new TreeRetriever({ store: handle.store, blobs: handle.blobs, trace: handle.trace });
  const session = createSession(pipeline);
  const tools = G0_DROP_FIRST ? withHandlers({ assemble: g0Assemble }) : TOOLS;
  const contract = process.env.CT_CONTRACT || 'v1';
  const options = { config, handle, retriever, mode: config.mode, session, tools, contract };
  const ctx = toolContext(options);
  const server = createServer(options, ctx);

  const port = Number(process.env.CT_ASSEMBLE_PORT ?? 8899);
  let api = null;
  if (port) {
    try {
      api = await createHttpApi({ ctx, tools, port, token: process.env.CT_ASSEMBLE_TOKEN || '', onCall: logCall });
    } catch (error) {
      // EADDRINUSE must not take the process down: the agent would lose the MCP tools too.
      record({ event: 'assemble_server_error', error: String(error?.message ?? error) });
      log(`http api error: ${error?.message ?? error}`);
    }
  }

  const follow = makeFollower(handle);
  let db = null;
  const openDb = () => {
    if (db || !existsSync(DB)) return db;
    // Read-only: opencode owns this file and is writing to it through WAL.
    db = new Database(DB, { readonly: true, fileMustExist: true });
    return db;
  };

  const timer = setInterval(() => {
    try {
      const handleDb = openDb();
      if (!handleDb) return;
      const result = follow(handleDb);
      if (result.appended > 0) record({ event: 'ingest', ...result });
    } catch (error) {
      record({ event: 'ingest_error', error: String(error?.message ?? error) });
    }
  }, POLL_MS);
  timer.unref?.();

  let closing = false;
  const shutdown = (signal) => {
    if (closing) return;
    closing = true;
    clearInterval(timer);
    void api?.close();
    record({ event: 'shutdown', signal, turns: session.turn, evicted: session.evicted.size });
    void server.close().finally(() => {
      try {
        handle.close();
        db?.close();
      } catch {
        // Shutting down: a failed close has nothing left to affect.
      }
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await server.connect(new StdioServerTransport());
  record({ event: 'ready', root: ROOT, db: DB, poll_ms: POLL_MS, http_port: api?.port ?? null, pipeline, neutral_phases: config.neutralPhases, contract, tools: tools.map((t) => t.name), g0_drop_first: G0_DROP_FIRST });
  log(`ready (root=${ROOT}, db=${DB}, poll=${POLL_MS}ms, http=${api?.port ?? 'off'}, anchor=${pipeline.anchor})`);
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().catch((error) => {
    log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
    record({ event: 'fatal', error: String(error?.message ?? error) });
    process.exit(1);
  });
}
