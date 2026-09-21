#!/usr/bin/env node
/**
 * The opencode HOST ADAPTER: one Node process per run. It contains no pipeline logic.
 *
 * It does the one thing `@context-tree/mcp` cannot do for itself — feed L0 from a LIVE
 * opencode session — and then starts the package's server on that store:
 *
 *   1. FOLLOW. opencode 1.18.31 keeps sessions in SQLite
 *      (`$XDG_DATA_HOME/opencode/opencode.db`, tables `message` and `part`, each row a JSON
 *      `data` column plus its ids) — the shapes `opencode export` prints, so
 *      `mapOpencodeExport` reads them unchanged. The db is polled read-only rather than
 *      shelling out to `opencode export`, which makes a model call at start-up and would
 *      take a slot from the run it is measuring. Only SETTLED parts are ingested, so L0
 *      stays an append-only prefix. `packages/mcp/dist/bin.js` alone serves a store someone
 *      built earlier; in a SWE-bench cell the only history is the one being produced now.
 *   2. PUBLISH the message index (opencode message id -> L0 seq range) into the session,
 *      which is what lets `context_verdicts` name host messages.
 *   3. SERVE the tool registry (D22) twice over one session: MCP stdio to the agent, and
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
 *   CT_CT_NEUTRAL_PHASES  comma list, or `none` — decides unit granularity (default: config)
 *   CT_CT_ANCHOR, CT_CT_W_*, CT_CT_PRIORITY_HALFLIFE, CT_CT_EVICT_HEADROOM,
 *   CT_CT_SOFT_TARGET_FRAC, CT_CT_REDUCER, CT_CT_DRIFT_K, CT_CT_DRIFT_TAU, CT_CT_RRF_K,
 *   CT_CT_CHUNK_SIZE, CT_CT_CHUNK_OVERLAP, CT_CT_PROTECT_TAIL
 *                      server defaults for the pipeline tools (`pipelineFromEnv`); a value
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
const { TOOLS, createHttpApi, createServer, createSession, pipelineFromEnv, toolContext, withHandlers } = await import(dist('mcp'));
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
 * Follows the session: appends what is new and re-derives L1, and records which L0
 * seqs each opencode message produced.
 *
 * The seq index is what lets a unit (a phase node, which spans seqs) name the
 * messages the plugin must act on. It is built by mapping each message ALONE and
 * walking a cursor — the mapper is deterministic and per-message sequential, so the
 * ranges line up with the whole-document mapping. The sum is asserted against that
 * mapping; a mismatch disables the index rather than returning wrong ranges.
 */
export function makeFollower(handle, { onIndex } = {}) {
  const done = new Set();
  const index = new Map();
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
      // Mapped ALONE and appended immediately, so the index range is what L0 actually
      // received rather than an arithmetic claim about it.
      const start = handle.trace.lastSeq() + 1;
      const mapped = mapOpencodeExport({ messages: [message] }, { startSeq: start - 1, blobs: handle.blobs });
      for (const event of mapped.events) {
        const { seq: _seq, ...rest } = event;
        handle.trace.append(rest);
      }
      done.add(message.info.id);
      if (mapped.events.length > 0) index.set(message.info.id, { start, end: handle.trace.lastSeq() });
      appended += mapped.events.length;
    }
    if (appended === 0) return { appended: 0, total: appendedTotal };

    appendedTotal += appended;
    onIndex?.(new Map(index));
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
 *   SPLICE messages[1] from four messages on — an assistant message, which carries its own
 *         tool calls and results together and so can never orphan a result.
 *
 * It does nothing before three messages: at turn one the array is the task statement alone,
 * and there is nothing to edit that would leave a request worth sending. Those early turns
 * are the within-run control — the original marker must be on the wire there.
 */
export function g0Decisions(messages, foldText) {
  const decisions = messages.map((m) => ({ id: m.id, action: 'keep' }));
  if (messages.length < 3 || !foldText) return decisions;
  decisions[0] = { id: messages[0].id, action: 'fold', text: foldText, g0: true };
  if (messages.length >= 4) decisions[1] = { id: messages[1].id, action: 'drop', g0: true };
  return decisions;
}

/**
 * The HTTP calls, as the evidence the gates read. One `assemble` row per turn — written
 * when `context_verdicts` answers, carrying that turn's `context_evict` if there was one —
 * so a turn with no evict call is visibly a turn where the policy did not fire.
 */
function makeCallLog() {
  let lastEvict = null;
  return ({ tool, ok, ms, input, outcome }) => {
    if (!ok) {
      record({ event: 'assemble_error', tool, ms, error: `${outcome.error?.code}: ${outcome.error?.message}`.slice(0, 800) });
      return;
    }
    const data = outcome.data;
    if (tool === 'context_evict') {
      lastEvict = { turn: data.turn, window: input.window_tokens, reserve: input.reserve_tokens ?? 0, evicted: data.evicted, fired: data.fired, live_before: data.live_tokens_before, live_after: data.live_tokens_after, ms };
      record({ event: 'evict', ...lastEvict });
      return;
    }
    if (tool !== 'context_verdicts') {
      record({ event: 'tool', tool, ms });
      return;
    }
    const evict = lastEvict?.turn === data.turn ? lastEvict : null;
    record({
      event: 'assemble', turn: data.turn, window: evict?.window ?? null, evict_called: evict !== null,
      total: data.total_tokens, kept_tokens: data.kept_tokens, evicted: evict?.evicted ?? [], evicted_total: data.evicted_units,
      live_unit_tokens: evict?.live_after ?? null, ceiling: input.ceiling_tokens ?? null, over_ceiling: data.over_ceiling,
      escalations: data.escalations, protect_tail: data.protect_tail, indexed: data.indexed, ms: ms + (evict?.ms ?? 0),
      dropped: data.decisions.filter((d) => d.action === 'drop').length,
      folded: data.decisions.filter((d) => d.action === 'fold').length,
      fold_unavailable: data.decisions.filter((d) => d.action === 'drop' && d.foldWanted).length,
      ...(G0_DROP_FIRST ? { g0: 'drop_first' } : {}),
    });
  };
}

/** The G0 gate swaps ONE stage behind its name; the transports and the plugin are untouched. */
const g0Verdicts = async (_ctx, input) => {
  const messages = input?.messages ?? [];
  const total = messages.reduce((n, m) => n + (m.tokens ?? 0), 0);
  return {
    ok: true,
    data: { turn: input?.turn ?? 0, indexed: true, total_tokens: total, kept_tokens: total, protect_tail: 0, escalations: 0, over_ceiling: false, evicted_units: 0, decisions: g0Decisions(messages, G0_FOLD_TEXT) },
  };
};

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
  const tools = G0_DROP_FIRST ? withHandlers({ context_verdicts: g0Verdicts }) : TOOLS;
  const contract = process.env.CT_CONTRACT || 'v1';
  const options = { config, handle, retriever, mode: config.mode, session, tools, contract };
  const ctx = toolContext(options);
  const server = createServer(options, ctx);

  const port = Number(process.env.CT_ASSEMBLE_PORT ?? 8899);
  let api = null;
  if (port) {
    try {
      api = await createHttpApi({ ctx, tools, port, token: process.env.CT_ASSEMBLE_TOKEN || '', onCall: makeCallLog() });
    } catch (error) {
      // EADDRINUSE must not take the process down: the agent would lose the MCP tools too.
      record({ event: 'assemble_server_error', error: String(error?.message ?? error) });
      log(`http api error: ${error?.message ?? error}`);
    }
  }

  const follow = makeFollower(handle, { onIndex: (index) => { session.messageIndex = index; } });
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
    record({ event: 'shutdown', signal, turns: session.turn });
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
