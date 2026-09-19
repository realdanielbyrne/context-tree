#!/usr/bin/env node
/**
 * The context-tree sidecar: one Node process per run that owns the pipeline
 * `packages/` ships but never calls on a live turn.
 *
 * It does two jobs for one session:
 *
 *   1. MCP server (U5). `@context-tree/mcp` over a store fed from the LIVE
 *      opencode session. `packages/mcp/dist/bin.js` serves a store someone built
 *      earlier; in a SWE-bench cell the only history is the one the agent is
 *      producing right now, so a plain server answers every `context_search` with
 *      nothing and the arm is byte-identical to its control — which is how the
 *      flapsim run came back VOID.
 *   2. Assembly (U18/U19/U20). An HTTP endpoint the opencode plugin calls on every
 *      turn: it runs drift → eviction → retrieval → `assembleFlex` over the tree and
 *      answers with a keep/drop/fold verdict PER MESSAGE.
 *
 * Why the work is here and not in the plugin: the plugin runs inside opencode's bun
 * runtime, and this half needs Node with `better-sqlite3` and tree-sitter. The plugin
 * stays thin so a fault in the pipeline cannot take down the host being measured.
 *
 * Why verdicts are per whole message: opencode keeps a tool call and its result in the
 * same message, so dropping at that granularity can never orphan a result. Re-rendering
 * the transcript from the tree is what invalidated the deleted in-repo harness (D20) —
 * this selects, it never re-renders.
 *
 * Where the history comes from: opencode 1.18.31 keeps sessions in SQLite
 * (`$XDG_DATA_HOME/opencode/opencode.db`, tables `message` and `part`, each row a JSON
 * `data` column plus its ids). Those are the shapes `opencode export` prints, so
 * `mapOpencodeExport` reads them unchanged. We poll the db read-only rather than
 * shelling out to `opencode export`, which makes a model call at start-up and would
 * take a slot from the run it is measuring. Only SETTLED parts are ingested, so L0 stays
 * an append-only prefix.
 *
 * stdout is the MCP transport: everything diagnostic goes to stderr.
 *
 *   CT_MCP_ROOT        context-tree store root   (required)
 *   CT_MCP_DB          opencode.db to follow     (default $XDG_DATA_HOME/opencode/opencode.db)
 *   CT_MCP_POLL_MS                               (default 1500)
 *   CT_MCP_LOG         jsonl: ingest ticks, assembly decisions, the fire-gate record
 *   CT_ASSEMBLE_PORT   0 disables the endpoint   (default 8899, loopback only)
 *   CT_CT_TRIGGER      off | hard | soft | cadence           (default off)
 *   CT_CT_WINDOW       the soft limit in tokens               (default 50347)
 *   CT_CT_HARD_WINDOW  the model's real context               (default 151040)
 *   CT_CT_CADENCE_N    fire every Nth turn in `cadence`       (default 5)
 *   CT_CT_SUMMARIES    1 to fold to summaries instead of dropping
 *   CT_CT_ANCHOR       units never evicted                    (default 4)
 *   CT_CT_REPLY_RESERVE                                       (default 8192)
 *   CT_CT_TOPK         retrieval hits appended as the tail    (default 5)
 *   CT_CT_PROTECT_TAIL messages at the end never dropped      (default 6)
 *   CT_G0_DROP_FIRST   1 = the G0 gate, not an arm (see below)
 */
import { existsSync, appendFileSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Experiment scripts load the packages from their build output rather than by
// package name (the established pattern here, and the one that survives being
// bind-mounted into the sandbox at a path node_modules knows nothing about).
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = process.env.CT_REPO_ROOT ?? join(HERE, '..', '..');
const dist = (pkg) => pathToFileURL(join(REPO, 'packages', pkg, 'dist', 'index.js')).href;

const {
  DriftClassifier, HeuristicTokenizer, TreeRetriever, assembleFlex, ensembleRetrieve,
  ingest, mapFlexUnits, openTaskStore, readNodeText, resolveConfig,
} = await import(dist('core'));
const { createServer } = await import(dist('mcp'));
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

export const ARM = Object.freeze({
  trigger: process.env.CT_CT_TRIGGER || 'off',
  softWindow: Number(process.env.CT_CT_WINDOW ?? 50_347),
  hardWindow: Number(process.env.CT_CT_HARD_WINDOW ?? 151_040),
  cadenceN: Number(process.env.CT_CT_CADENCE_N ?? 5),
  summaries: process.env.CT_CT_SUMMARIES === '1',
  anchor: Number(process.env.CT_CT_ANCHOR ?? 4),
  replyReserve: Number(process.env.CT_CT_REPLY_RESERVE ?? 8192),
  /** What the plugin cannot see: opencode's system block, tool schemas and skills. */
  headTokens: Number(process.env.CT_CT_HEAD_TOKENS ?? 12_000),
  topK: Number(process.env.CT_CT_TOPK ?? 5),
  protectTail: Number(process.env.CT_CT_PROTECT_TAIL ?? 6),
});

/**
 * A mistyped knob must stop the run, not quietly turn the arm into its control.
 * `CT_CT_WINDOW=50k` reads as NaN, which `windowForTurn` passes through and the
 * keep-everything path swallows; a NaN reserve makes `evictableTotal > NaN` false, so
 * NOTHING is ever evicted and no error is recorded anywhere.
 */
export function validateArm(arm = ARM) {
  const problems = [];
  const triggers = ['off', 'hard', 'soft', 'cadence'];
  if (!triggers.includes(arm.trigger)) problems.push(`CT_CT_TRIGGER must be one of ${triggers.join('|')}, got "${arm.trigger}"`);
  const positive = {
    CT_CT_WINDOW: arm.softWindow, CT_CT_HARD_WINDOW: arm.hardWindow, CT_CT_CADENCE_N: arm.cadenceN,
    CT_CT_ANCHOR: arm.anchor, CT_CT_TOPK: arm.topK, CT_CT_PROTECT_TAIL: arm.protectTail,
  };
  for (const [name, value] of Object.entries(positive)) {
    if (!Number.isFinite(value) || value <= 0) problems.push(`${name} must be a positive number, got ${value}`);
  }
  for (const [name, value] of [['CT_CT_REPLY_RESERVE', arm.replyReserve], ['CT_CT_HEAD_TOKENS', arm.headTokens]]) {
    if (!Number.isFinite(value) || value < 0) problems.push(`${name} must be a non-negative number, got ${value}`);
  }
  if (Number.isFinite(arm.softWindow) && Number.isFinite(arm.hardWindow) && arm.softWindow > arm.hardWindow) {
    problems.push(`CT_CT_WINDOW (${arm.softWindow}) exceeds CT_CT_HARD_WINDOW (${arm.hardWindow})`);
  }
  if (arm.replyReserve + arm.headTokens >= arm.softWindow) {
    problems.push(`reserve + head (${arm.replyReserve + arm.headTokens}) leaves no room in CT_CT_WINDOW (${arm.softWindow})`);
  }
  return problems;
}

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
export function makeFollower(handle, { onIndex, session = null } = {}) {
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
    // The units the assembler reasons over changed, so any cached rendering of them is stale.
    if (session) session.textCache.clear();
    return { appended, total: appendedTotal, messages: done.size, nodes: stats.stats.nodes, phases: stats.stats.phases };
  };
}

/**
 * The arm, as one number. `assembleFlex` evicts only when unit tokens exceed
 * `window − replyReserve`, so the trigger IS the window we hand it:
 *
 *   off      never evict (the control)
 *   hard     the model's real context — today's shipped default
 *   soft     a limit context-tree imposes, well below the real one (U18)
 *   cadence  that same soft limit, but only every Nth turn (U19)
 */
export function windowForTurn({ trigger, turn, softWindow, hardWindow, cadenceN }) {
  if (trigger === 'hard') return hardWindow;
  if (trigger === 'soft') return softWindow;
  if (trigger === 'cadence') return turn > 0 && turn % cadenceN === 0 ? softWindow : Number.POSITIVE_INFINITY;
  return Number.POSITIVE_INFINITY;
}

/**
 * Turn evicted UNITS into per-message verdicts.
 *
 * Protected, in order of precedence: a message with no L0 range yet (not ingested, so
 * nothing is known about it), the first message (the task statement), and the last
 * `protectTail` messages (the live working set). Everything else is droppable when its
 * seq range overlaps an evicted unit.
 *
 * `fold` replaces a message's content with the unit's summary and is offered only for a
 * text-only message: a message carrying tool parts is keep-or-drop, so a call and its
 * result always travel together.
 */
export function planDecisions({ messages, index, evicted, protectTail, summaries }) {
  const spans = evicted.filter((u) => u.start !== null && u.start !== undefined);
  const overlaps = (range) => spans.find((u) => range.start <= u.end && range.end >= u.start);
  const lastIndex = messages.length - 1;
  const folded = new Set();
  const wanted = new Set();
  const decisions = [];

  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    const range = index?.get(message.id);
    const protectedHere = i === 0 || i > lastIndex - protectTail;
    if (!range || protectedHere) {
      decisions.push({ id: message.id, action: 'keep' });
      continue;
    }
    const unit = overlaps(range);
    if (!unit) {
      decisions.push({ id: message.id, action: 'keep' });
      continue;
    }
    const wantsFold = summaries && unit.summary && !folded.has(unit.nodeId);
    if (wantsFold && !message.hasTools) {
      folded.add(unit.nodeId);
      decisions.push({ id: message.id, action: 'fold', text: unit.summary });
      continue;
    }
    // A fold the message shape cannot take is recorded ONCE PER UNIT, not swallowed: in a
    // SWE-bench run nearly every assistant message carries tool parts, so a summaries arm
    // that never finds a text-only message is its own control and must say so.
    const firstMiss = wantsFold && !wanted.has(unit.nodeId);
    if (firstMiss) wanted.add(unit.nodeId);
    decisions.push({ id: message.id, action: 'drop', unit: unit.nodeId, ...(firstMiss ? { foldWanted: true } : {}) });
  }
  return decisions;
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

/** The per-session state the package has nowhere to put (see U2: `lastReferencedTurn`). */
function makeSession() {
  return {
    classifier: new DriftClassifier(),
    tokenizer: new HeuristicTokenizer(),
    turn: 0,
    // nodeId -> the turn the agent last came back to material that unit produced.
    // `buildFlexSource` hardwires this to creation order, which makes reference-recency
    // a second name for positional recency; the whole point of holding it here is that
    // it is a real observation instead.
    referenced: new Map(),
    seqIndex: null,
    // Reference tracking is incremental: re-scanning from seq 1 each turn would stamp
    // the CURRENT turn on every unit that ever touched a file, which is a "wrote a file"
    // flag, not an observation of the agent coming back to something.
    scannedSeq: 0,
    // `readNodeText` re-reads trace.jsonl per node per call; the units only change when
    // the follower appends, which is when this is cleared.
    textCache: new Map(),
  };
}

/** Units for the assembler, with reference-recency taken from what the agent actually revisited. */
function entriesFor(handle, session) {
  const { store, trace, blobs } = handle;
  const phases = store.nodesInCreationOrder().filter((n) => n.kind === 'phase' && n.status !== 'superseded');
  return phases.map((node, order) => {
    const summary = store.currentSummary(node.id);
    const wrote =
      store.descendants(node.id).some((d) => d.kind === 'file') || (node.meta_json.spans?.length ?? 0) > 0;
    let rawText = session.textCache.get(node.id);
    if (rawText === undefined) {
      rawText = readNodeText(node, trace, blobs);
      session.textCache.set(node.id, rawText);
    }
    return {
      node,
      entry: {
        nodeId: node.id,
        order,
        rawText,
        ...(summary !== null ? { summaryText: summary.text } : {}),
        wrote,
        // Never referenced: fall back to when it was created, in the SAME clock as
        // `currentTurn` below — mixing a unit index with a turn count makes the decay
        // term and reference-recency meaningless.
        lastReferencedTurn: session.referenced.get(node.id) ?? 0,
      },
    };
  });
}

/**
 * Mark units the agent has come back to: a unit that wrote a file is "referenced"
 * again when a later tool call touches that same path.
 */
function trackReferences(handle, session) {
  const { store, trace } = handle;
  const owner = new Map();
  for (const node of store.nodesInCreationOrder()) {
    // A file node is keyed by `meta_json.path` (§7) and hangs under the phase that touched it.
    const path = node.kind === 'file' ? node.meta_json?.path : undefined;
    if (!path || !node.parent_id) continue;
    owner.set(path, node.parent_id);
  }
  const last = trace.lastSeq();
  if (last <= session.scannedSeq) return;
  for (const event of trace.read({ from: session.scannedSeq + 1, to: last })) {
    if (event.type !== 'tool_call' || !event.path) continue;
    const unit = owner.get(event.path);
    // A unit is referenced again only by a call that arrived SINCE the last scan, and it
    // keeps the turn it was seen on.
    if (unit) session.referenced.set(unit, session.turn);
  }
  session.scannedSeq = last;
}

async function assembleForTurn({ handle, session, messages, query }) {
  session.turn += 1;
  const total = messages.reduce((n, m) => n + (m.tokens ?? 0), 0);

  // The gate short-circuits the pipeline on purpose: it is testing the seam, not the policy.
  if (G0_DROP_FIRST) {
    const decisions = g0Decisions(messages, G0_FOLD_TEXT);
    return { turn: session.turn, g0: 'drop_first', window: null, total, evicted: [], decisions };
  }

  const window = windowForTurn({ ...ARM, turn: session.turn });

  // The trigger says never evict AND the prompt fits the real context: nothing to do.
  // When it does NOT fit we still assemble, at the real context as a ceiling — the plugin
  // arms run with host compaction off, so an overflow is a hard session error and someone
  // has to keep the prompt inside the window. That ceiling is not the arm; it is the
  // floor under every arm, and a cell that hits it says so through `window`.
  if (!Number.isFinite(window) && total <= ARM.hardWindow) {
    return { turn: session.turn, window: null, evicted: [], decisions: messages.map((m) => ({ id: m.id, action: 'keep' })), total };
  }

  trackReferences(handle, session);
  const pairs = entriesFor(handle, session);
  const { units, corpus } = await mapFlexUnits(pairs.map((p) => p.entry), { classifier: session.classifier });

  let tail = [];
  if (query && corpus.length > 0) {
    const hits = await ensembleRetrieve(query, corpus, undefined, { topK: ARM.topK });
    tail = hits.map((h) => ({ id: h.unitId, text: h.excerpt }));
  }

  // The window has to cover what the assembler cannot see. The system prompt, tool
  // schemas, skills and MCP instructions are assembled AFTER the plugin's hook, so they
  // never appear in `messages` — opencode's fixed overhead alone is ~9,898 tokens.
  // Protected messages are NOT charged here: their content is already inside the units
  // being budgeted, so charging them too would shrink the real operating point far below
  // the window the arm claims to be testing.
  const effectiveWindow = Number.isFinite(window) ? window : ARM.hardWindow;
  const replyReserve = Math.min(effectiveWindow - 1, ARM.replyReserve + ARM.headTokens);

  const prompt = assembleFlex(
    { system: '', userPrompts: [] },
    units,
    session.tokenizer,
    { window: effectiveWindow, replyReserve, anchor: ARM.anchor, tail, currentTurn: session.turn },
  );

  const lastSeq = handle.trace.lastSeq();
  const byNode = new Map(pairs.map((p) => [p.entry.nodeId, p]));
  const evicted = prompt.budgets.evicted.map((nodeId) => {
    const pair = byNode.get(nodeId);
    return {
      nodeId,
      start: pair?.node.span_start_seq ?? null,
      // An OPEN phase has no end yet, and `readNodeText` reads it to the end of the
      // trace — so its span has to reach there too, or the assembler bills the whole
      // tail while only one message is ever dropped for it.
      end: pair?.node.span_end_seq ?? (pair?.node.status === 'open' ? lastSeq : pair?.node.span_start_seq) ?? null,
      summary: pair?.entry.summaryText ?? null,
    };
  });

  let protectTail = ARM.protectTail;
  let decisions = planDecisions({ messages, index: session.seqIndex, evicted, protectTail, summaries: ARM.summaries });
  const kept = (ds) => messages
    .filter((m) => ds.find((d) => d.id === m.id)?.action !== 'drop')
    .reduce((n, m) => n + (m.tokens ?? 0), 0);

  // The ceiling has to HOLD, not merely be aimed at: with host compaction off, a prompt
  // over the real context is a hard session error, and that would kill the arm in exactly
  // the overflowing cells U18 is about while the control simply compacts. The protected
  // tail is the part eviction cannot reach, so when it is what does not fit, it shrinks.
  const ceiling = ARM.hardWindow - ARM.headTokens - ARM.replyReserve;
  let escalations = 0;
  while (kept(decisions) > ceiling && protectTail > 1) {
    protectTail -= 1;
    escalations += 1;
    decisions = planDecisions({ messages, index: session.seqIndex, evicted, protectTail, summaries: ARM.summaries });
  }
  const keptTokens = kept(decisions);

  return {
    turn: session.turn, window: effectiveWindow, total, units: units.length,
    evicted: evicted.map((e) => e.nodeId), tail: tail.length,
    kept_tokens: keptTokens, ceiling, over_ceiling: keptTokens > ceiling, escalations, protect_tail: protectTail,
    decisions,
  };
}

function startAssembleServer({ port, handle, session, token }) {
  if (!port) return null;
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url.startsWith('/assemble')) {
      res.writeHead(404).end('{}');
      return;
    }
    // The agent shares this loopback and runs with `--auto`. A stray POST would advance
    // the turn counter and shift the cadence phase, so callers prove they are the plugin.
    if (token && req.headers['x-ct-token'] !== token) {
      record({ event: 'assemble_rejected', reason: 'bad-token' });
      res.writeHead(403).end('{}');
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      let out;
      const started = Date.now();
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!Array.isArray(body.messages) || body.messages.length === 0) {
          record({ event: 'assemble_rejected', reason: 'no-messages' });
          res.writeHead(400).end(JSON.stringify({ decisions: [] }));
          return;
        }
        out = await assembleForTurn({ handle, session, messages: body.messages, query: body.query ?? '' });
        record({
          event: 'assemble', ...out, decisions: undefined, ms: Date.now() - started,
          dropped: out.decisions.filter((d) => d.action === 'drop').length,
          folded: out.decisions.filter((d) => d.action === 'fold').length,
          fold_unavailable: out.decisions.filter((d) => d.action === 'drop' && d.foldWanted).length,
        });
      } catch (error) {
        // Fail OPEN: a broken arm must leave the prompt untouched, not break the run.
        record({ event: 'assemble_error', ms: Date.now() - started, error: String(error?.stack ?? error).slice(0, 800) });
        out = { decisions: [], error: String(error?.message ?? error) };
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
    });
  });
  // An EADDRINUSE here would otherwise raise an uncaught 'error' and take the process
  // down, losing the MCP tools as well as assembly for the rest of the run.
  server.on('error', (error) => {
    record({ event: 'assemble_server_error', error: String(error?.message ?? error) });
    log(`assemble server error: ${error?.message ?? error}`);
  });
  server.listen(port, '127.0.0.1');
  return server;
}

async function main() {
  if (!ROOT) throw new Error('CT_MCP_ROOT is required');
  mkdirSync(dirname(ROOT), { recursive: true });
  if (LOG) mkdirSync(dirname(LOG), { recursive: true });

  const problems = validateArm();
  if (problems.length > 0) throw new Error(`arm misconfigured: ${problems.join('; ')}`);

  const config = resolveConfig({ root: ROOT, taskTitle: 'swebench task' }, dirname(ROOT));
  const handle = openTaskStore(config);
  const retriever = new TreeRetriever({ store: handle.store, blobs: handle.blobs, trace: handle.trace });
  const server = createServer({ config, handle, retriever, mode: config.mode });
  const session = makeSession();

  const port = Number(process.env.CT_ASSEMBLE_PORT ?? 8899);
  const assembleServer = startAssembleServer({ port, handle, session, token: process.env.CT_ASSEMBLE_TOKEN || '' });

  const follow = makeFollower(handle, { session, onIndex: (index) => { session.seqIndex = index; } });
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
    assembleServer?.close();
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
  record({ event: 'ready', root: ROOT, db: DB, poll_ms: POLL_MS, assemble_port: port, arm: ARM, g0_drop_first: G0_DROP_FIRST });
  log(`ready (root=${ROOT}, db=${DB}, poll=${POLL_MS}ms, assemble=${port || 'off'}, trigger=${ARM.trigger})`);
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().catch((error) => {
    log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
    record({ event: 'fatal', error: String(error?.message ?? error) });
    process.exit(1);
  });
}
