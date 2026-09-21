/**
 * §13's command surface, tested by calling the command functions — never by
 * spawning a process. What is asserted here is the behavior the plan makes
 * load-bearing: init must merge (a clobbered `.mcp.json` costs the user their
 * other servers), import must survive a bad line (real transcripts have them),
 * rebuild must ask before discarding L3, render must be byte-deterministic
 * (D8), and the money-spending command must be able to plan without spending.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider, type CompletionRequest } from '@context-tree/core';
import {
  importCommand,
  initCommand,
  rebuildCommand,
  renderCommand,
  run,
  summarizeCommand,
  treeCommand,
  type Io,
} from '../src/index.js';

interface Capture extends Io {
  stdout: string[];
  stderr: string[];
}

function capture(): Capture {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
  };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ct-cli-'));
}

const TS = '2026-01-01T00:00:00.000Z';
const FILE_AFTER = 'export function parse(input: string): number {\n  return Number(input);\n}\n';

function writeBlob(blobsDir: string, content: string): string {
  const ref = createHash('sha256').update(content).digest('hex');
  const dir = join(blobsDir, ref.slice(0, 2));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ref.slice(2)), content);
  return ref;
}

/**
 * A five-event L0 trace with its L2 blobs beside it — one read phase and one
 * edit phase, which is the smallest trace whose tree can tell the §7 tool->phase
 * transition apart from "one phase for everything".
 */
function writeL0Fixture(
  dir: string,
  options: { badLineAt?: number; orphanAnnotation?: boolean } = {},
): string {
  const blobsDir = join(dir, 'blobs');
  const userRef = writeBlob(blobsDir, 'fix the parser');
  const outputRef = writeBlob(blobsDir, 'export function parse() {}\n');
  const fileRef = writeBlob(blobsDir, FILE_AFTER);
  const events: Record<string, unknown>[] = [
    { seq: 1, type: 'user_message', ts: TS, blob: userRef },
    { seq: 2, type: 'tool_call', ts: TS, tool: 'Read', path: 'src/a.ts' },
    { seq: 3, type: 'tool_result', ts: TS, call_seq: 2, output_blob: outputRef },
    { seq: 4, type: 'tool_call', ts: TS, tool: 'Edit', path: 'src/a.ts', blob: fileRef },
    { seq: 5, type: 'tool_result', ts: TS, call_seq: 4 },
  ];
  if (options.orphanAnnotation === true) {
    // A §9 note whose subject this trace's segmentation does not produce — the
    // shape a note imported from a foreign store has. Its body IS in L2, so the
    // only thing the replay cannot resolve is the node id.
    const noteRef = writeBlob(blobsDir, 'the parser rewrite supersedes this');
    events.push({ seq: 6, type: 'manual_annotation', ts: TS, node_id: 'n_missing', blob: noteRef });
  }
  const lines = events.map((event) => JSON.stringify(event));
  if (options.badLineAt !== undefined) lines.splice(options.badLineAt - 1, 0, '{ not json at all');
  const path = join(dir, 'trace.jsonl');
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
  return path;
}

interface Workspace {
  cwd: string;
  root: string;
  trace: string;
}

function imported(options: { badLineAt?: number; orphanAnnotation?: boolean } = {}): Workspace {
  const cwd = tempDir();
  const root = join(cwd, 'store');
  const trace = writeL0Fixture(cwd, options);
  importCommand(trace, { cwd, root }, capture());
  return { cwd, root, trace };
}

const savedEnv = {
  codexHome: process.env.CODEX_HOME,
  anthropic: process.env.ANTHROPIC_API_KEY,
  openrouter: process.env.OPENROUTER_API_KEY,
};

beforeEach(() => {
  // Point host detection at a directory that does not exist, and make it
  // impossible for any test to reach a real provider.
  process.env.CODEX_HOME = join(tmpdir(), 'ct-cli-absent-codex-home');
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
});

afterEach(() => {
  restore('CODEX_HOME', savedEnv.codexHome);
  restore('ANTHROPIC_API_KEY', savedEnv.anthropic);
  restore('OPENROUTER_API_KEY', savedEnv.openrouter);
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe('init', () => {
  it('--host print touches no file, so a user can see the plan without risking their config', () => {
    const cwd = tempDir();
    const io = capture();

    const result = initCommand({ cwd, host: 'print' }, io);

    expect(result.hostConfigWritten).toBe(false);
    expect(result.configWritten).toBe(false);
    expect(readdirSync(cwd)).toEqual([]);
    expect(io.stdout.join('\n')).toContain('nothing written');
  });

  it('merges into an existing .mcp.json, preserving other servers and top-level keys', () => {
    const cwd = tempDir();
    const mcpPath = join(cwd, '.mcp.json');
    writeFileSync(
      mcpPath,
      `${JSON.stringify({ mcpServers: { graft: { command: 'graft-mcp' } }, hooks: ['keep me'] }, null, 2)}\n`,
      'utf8',
    );

    const result = initCommand({ cwd }, capture());

    const doc = JSON.parse(readFileSync(mcpPath, 'utf8')) as {
      mcpServers: Record<string, unknown>;
      hooks: string[];
    };
    expect(doc.mcpServers.graft).toEqual({ command: 'graft-mcp' });
    expect(doc.hooks).toEqual(['keep me']);
    // The registration names the mcp package's bin, never imports it.
    expect(doc.mcpServers['context-tree']).toEqual({
      command: 'context-tree-mcp',
      args: [],
      env: {},
    });
    expect(result.preservedServers).toEqual(['graft']);
    expect(existsSync(join(cwd, 'context-tree.config.json'))).toBe(true);
    expect(result.systemContractPath).toMatch(/system-contract\.v1\.md$/);
  });

  it('refuses a second run without --force, and --force still preserves the other servers', () => {
    const cwd = tempDir();
    writeFileSync(
      join(cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { graft: { command: 'graft-mcp' } } }),
      'utf8',
    );
    initCommand({ cwd }, capture());

    expect(() => initCommand({ cwd }, capture())).toThrow(/--force/);

    const forced = initCommand({ cwd, force: true }, capture());
    expect(forced.preservedServers).toEqual(['graft']);
    const doc = JSON.parse(readFileSync(join(cwd, '.mcp.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(doc.mcpServers).sort()).toEqual(['context-tree', 'graft']);
  });

  it('--host opencode writes opencode.json with the right shape and preserves existing servers', () => {
    const cwd = tempDir();
    const ocPath = join(cwd, 'opencode.json');
    writeFileSync(
      ocPath,
      JSON.stringify({ mcp: { graft: { type: 'local', command: ['graft-mcp'] } } }, null, 2),
      'utf8',
    );

    const result = initCommand({ cwd, host: 'opencode' }, capture());

    const doc = JSON.parse(readFileSync(ocPath, 'utf8')) as {
      mcp: Record<string, { type: string; command: string[]; cwd: string; enabled: boolean; timeout: number }>;
    };
    expect(doc.mcp['context-tree']).toEqual({
      type: 'local',
      command: ['context-tree-mcp'],
      cwd: '.',
      enabled: true,
      timeout: 15000,
    });
    expect(doc.mcp.graft).toBeDefined();
    expect(result.preservedServers).toEqual(['graft']);
  });

  it('--host opencode refuses when opencode.jsonc exists, to avoid stripping comments', () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, 'opencode.jsonc'), '// a comment\n{}', 'utf8');

    expect(() => initCommand({ cwd, host: 'opencode' }, capture())).toThrow(/opencode\.jsonc/);
  });
});

describe('import', () => {
  it('derives the §7 tree from a valid L0 file and hydrates its blobs from the sibling store', () => {
    const cwd = tempDir();
    const root = join(cwd, 'store');
    const trace = writeL0Fixture(cwd);

    const result = importCommand(trace, { cwd, root }, capture());

    expect(result.failures).toEqual([]);
    expect(result.events).toBe(5);
    // Read -> diagnosis, Edit -> implementation: the transition is the tree.
    expect(result.stats.phases).toBe(2);
    expect(result.stats.fileNodes).toBe(1);
    expect(result.stats.nodes).toBe(4);
    expect(result.blobs).toEqual({ written: 0, copied: 3, missing: 0 });

    const rows = treeCommand({ cwd, root }, capture()).nodes;
    expect(rows.map((row) => row.kind)).toEqual(['task', 'phase', 'phase', 'file']);
    expect(rows.map((row) => row.phase)).toEqual([null, 'diagnosis', 'implementation', null]);
  });

  it('reports the malformed line by number and imports the rest', () => {
    const cwd = tempDir();
    const root = join(cwd, 'store');
    const trace = writeL0Fixture(cwd, { badLineAt: 3 });
    const io = capture();

    const result = importCommand(trace, { cwd, root }, io);

    expect(result.failures.map((failure) => failure.line)).toEqual([3]);
    expect(result.events).toBe(5);
    expect(result.stats.phases).toBe(2);
    expect(io.stdout.join('\n')).toContain('line 3:');
  });

  it('says how many annotations the replay could not place, and says nothing when none were lost', () => {
    const cwd = tempDir();
    const root = join(cwd, 'store');
    const io = capture();

    const result = importCommand(writeL0Fixture(cwd, { orphanAnnotation: true }), { cwd, root }, io);

    // Dropping a §9 note silently is the failure D8's replay exists to prevent;
    // an unreported residual count is the same loss, one level quieter.
    expect(result.stats.unresolvedAnnotations).toBe(1);
    expect(io.stdout.join('\n')).toContain('1 annotation(s) could not be replayed');

    const clean = tempDir();
    const cleanIo = capture();
    const cleanResult = importCommand(
      writeL0Fixture(clean),
      { cwd: clean, root: join(clean, 'store') },
      cleanIo,
    );

    expect(cleanResult.stats.unresolvedAnnotations).toBe(0);
    expect(cleanIo.stdout.join('\n')).not.toContain('annotation');
  });

  it('--strict fails on that line and leaves L0 empty — a partial import is opt-out', () => {
    const cwd = tempDir();
    const root = join(cwd, 'store');
    const trace = writeL0Fixture(cwd, { badLineAt: 3 });

    expect(() => importCommand(trace, { cwd, root, strict: true }, capture())).toThrow(/line 3/);

    expect(readFileSync(join(root, 'trace.jsonl'), 'utf8')).toBe('');
  });

  it('--from-claude-code maps a transcript onto L0, skipping non-events and reporting bad lines', () => {
    const cwd = tempDir();
    const root = join(cwd, 'store');
    const transcript = [
      JSON.stringify({ type: 'summary', summary: 'an earlier session' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'fix the parser' }, timestamp: TS }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'reading it' },
            { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'src/a.ts' } },
          ],
        },
        timestamp: TS,
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'export function parse() {}' }],
        },
        timestamp: TS,
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_2', name: 'Write', input: { file_path: 'src/a.ts', content: FILE_AFTER } },
          ],
        },
        timestamp: TS,
      }),
      '{ truncated line',
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_gone', content: 'orphan' }],
        },
      }),
    ].join('\n');
    const path = join(cwd, 'session.jsonl');
    writeFileSync(path, `${transcript}\n`, 'utf8');

    const result = importCommand(path, { cwd, root, fromClaudeCode: true }, capture());

    expect(result.events).toBe(5);
    expect(result.skipped).toBe(1);
    expect(result.failures.map((failure) => failure.line)).toEqual([6, 7]);
    expect(result.stats.phases).toBe(2);
    expect(result.stats.fileNodes).toBe(1);

    const events = readFileSync(join(root, 'trace.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const write = events.find((event) => event.tool === 'Write');
    // §12 parses this blob as a whole file, so only Write's whole-file payload
    // may become one.
    expect(typeof write?.blob).toBe('string');
    const read = events.find((event) => event.tool === 'Read');
    expect(read?.blob).toBeUndefined();
    expect(read?.parent_seq).toBe(2);
  });
});

describe('import --from-opencode', () => {
  it('maps an opencode export onto L0 with monotonic seqs, epoch-ms -> ISO, and tool linkage', () => {
    const cwd = tempDir();
    const root = join(cwd, 'store');
    const fixture = join(__dirname, 'fixtures', 'opencode-session.json');
    const result = importCommand(fixture, { cwd, root, fromOpencode: true }, capture());

    expect(result.format).toBe('opencode');
    expect(result.failures).toEqual([]);
    // 4 messages yield: user_message, assistant_message + read call/result + edit call/result,
    // assistant_message + bash call/result, user_message = 10 events
    // system message is skipped, unknown-future-type is skipped
    expect(result.events).toBe(10);
    expect(result.skipped).toBeGreaterThan(0);

    const events = readFileSync(join(root, 'trace.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    // Monotonic gap-free seqs
    const seqs = events.map((e) => e.seq as number);
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i]).toBe((seqs[i - 1] as number) + 1);
    }

    // tool_call/tool_result linkage
    const readCall = events.find((e) => e.tool === 'read');
    expect(readCall).toBeDefined();
    expect(readCall?.path).toBe('src/auth.ts');
    const readResult = events.find((e) => e.type === 'tool_result' && e.call_seq === readCall?.seq);
    expect(readResult).toBeDefined();

    // edit has blob (whole file content)
    const editCall = events.find((e) => e.tool === 'edit');
    expect(editCall).toBeDefined();
    expect(typeof editCall?.blob).toBe('string');

    // error tool results have error field
    const bashResult = events.find(
      (e) => e.type === 'tool_result' && e.error !== undefined,
    );
    expect(bashResult).toBeDefined();
    expect(bashResult?.error).toContain('test failed');

    // epoch-ms -> ISO: 1725868800000 = 2024-09-09T08:00:00.000Z
    const first = events[0];
    expect(first?.ts).toBe('2024-09-09T08:00:00.000Z');

    // reasoning parts dropped (counted in skipped, not in events)
    const reasoningEvents = events.filter(
      (e) => typeof e.blob === 'string' && (e.blob as string).includes('thinking about'),
    );
    expect(reasoningEvents).toHaveLength(0);
  });

  it('reports failures for a malformed document', () => {
    const cwd = tempDir();
    const root = join(cwd, 'store');
    const path = join(cwd, 'bad.json');
    writeFileSync(path, '"not an object"', 'utf8');
    const result = importCommand(path, { cwd, root, fromOpencode: true }, capture());
    expect(result.events).toBe(0);
    expect(result.failures.length).toBeGreaterThan(0);
  });

  it('handles missing messages array', () => {
    const cwd = tempDir();
    const root = join(cwd, 'store');
    const path = join(cwd, 'empty.json');
    writeFileSync(path, '{"info":{}}', 'utf8');
    const result = importCommand(path, { cwd, root, fromOpencode: true }, capture());
    expect(result.events).toBe(0);
    expect(result.failures.length).toBeGreaterThan(0);
  });
});

describe('rebuild', () => {
  it('refuses without --yes, because the run discards L3 embeddings that cost money', () => {
    const workspace = imported();

    expect(() => rebuildCommand({ cwd: workspace.cwd, root: workspace.root }, capture())).toThrow(
      /--yes/,
    );

    expect(existsSync(join(workspace.root, 'tree.db'))).toBe(true);
  });

  it('--yes re-derives exactly the same tree from L0 + L2 (D8)', () => {
    const workspace = imported();
    const before = treeCommand(workspace, capture()).nodes;

    const result = rebuildCommand({ ...workspace, yes: true }, capture());

    expect(result.deleted).toContain(join(workspace.root, 'tree.db'));
    const after = treeCommand(workspace, capture()).nodes;
    // Node ids are freshly minted ULIDs; everything derived from L0 is not.
    const shape = (rows: typeof before): unknown[] =>
      rows.map((row) => [row.kind, row.phase, row.title, row.spanStart, row.spanEnd]);
    expect(shape(after)).toEqual(shape(before));
  });

  it('reports the annotations a replay dropped — the rebuild is where that loss happens', () => {
    const workspace = imported({ orphanAnnotation: true });
    const io = capture();

    const result = rebuildCommand({ ...workspace, yes: true }, io);

    expect(result.stats.unresolvedAnnotations).toBe(1);
    expect(io.stdout.join('\n')).toContain('1 annotation(s) could not be replayed');

    const clean = imported();
    const cleanIo = capture();
    const cleanResult = rebuildCommand({ ...clean, yes: true }, cleanIo);

    expect(cleanResult.stats.unresolvedAnnotations).toBe(0);
    expect(cleanIo.stdout.join('\n')).not.toContain('annotation');
  });
});

describe('render', () => {
  it('renders a non-empty view that is byte-identical across runs (L4 is a function of L1)', () => {
    const workspace = imported();
    const io = capture();

    const first = renderCommand(workspace, io);
    const second = renderCommand(workspace, capture());

    expect(first.markdown.length).toBeGreaterThan(0);
    expect(second.markdown).toBe(first.markdown);
    expect(io.stdout.join('\n')).toContain('# task');
  });

  it('--out writes the same bytes it would have printed', () => {
    const workspace = imported();
    const out = join(workspace.cwd, 'nested', 'view.md');

    const result = renderCommand({ ...workspace, out }, capture());

    expect(result.written).toEqual([out]);
    expect(readFileSync(out, 'utf8')).toBe(result.markdown);
  });
});

describe('summarize', () => {
  it('--dry-run plans every branch and makes zero provider calls', async () => {
    const workspace = imported();
    const provider = new MockProvider({ queue: [] });

    const result = await summarizeCommand({ ...workspace, dryRun: true, provider }, capture());

    expect(provider.requests).toEqual([]);
    // Two phase leaves plus the root (D2: leaves on the cheap model, root on the strong one).
    expect(result.estimatedCalls).toBe(3);
    expect(result.plan.map((entry) => entry.role)).toEqual(['leaf', 'leaf', 'root']);
    expect(result.cost).toBeNull();
  });

  it('refuses before calling anything when the configured provider has no key (§11)', async () => {
    const workspace = imported();

    await expect(summarizeCommand(workspace, capture())).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it('writes version 1 on every branch and reports the cost meter split by model', async () => {
    const workspace = imported();

    const result = await summarizeCommand({ ...workspace, provider: contractProvider() }, capture());

    expect(result.outcomes.map((outcome) => outcome.status)).toEqual([
      'summarized',
      'summarized',
      'summarized',
    ]);
    expect(treeCommand(workspace, capture()).nodes.map((row) => row.summaryVersion)).toEqual([
      1, 1, 1, 0,
    ]);
    // D2's two models are billed separately, which is what makes the §16 cap
    // meaningful at all.
    expect(result.cost?.entries.map((entry) => entry.calls)).toEqual([2, 1]);
  });
});

/**
 * A provider that satisfies the §8 content contract: it echoes back every node
 * id the prompt named, which is what `contractViolation` requires of a real
 * summary (a summary that omits a child branch hides it from `fetch`).
 */
function contractProvider(): MockProvider {
  return new MockProvider({
    responder: (request: CompletionRequest) => {
      const prompt = request.messages.map((message) => message.content).join('\n');
      const nodeIds = [...new Set(prompt.match(/n_[0-9A-Z]{26}/g) ?? [])];
      return JSON.stringify({
        text: 'what happened in this branch',
        meta: {
          files: [],
          symbols: [],
          tests: [],
          artifacts: [],
          open_questions: [],
          decisions: [],
          node_ids: nodeIds,
        },
      });
    },
  });
}

describe('run', () => {
  it('exits nonzero on an unknown subcommand instead of doing something else', async () => {
    const io = capture();

    const code = await run(['node', 'context-tree', 'summarise'], io);

    expect(code).toBeGreaterThan(0);
    expect(io.stderr.join('\n')).toContain('summarise');
  });

  it('accepts --root after the subcommand and emits parseable JSON for tree', async () => {
    const workspace = imported();
    const io = capture();

    const code = await run(['node', 'context-tree', 'tree', '--root', workspace.root, '--json'], io);

    expect(code).toBe(0);
    const payload = JSON.parse(io.stdout.join('\n')) as { root: string; nodes: unknown[] };
    expect(payload.root).toBe(workspace.root);
    expect(payload.nodes).toHaveLength(4);
  });

  it('turns a command failure into a nonzero code and a single stderr line', async () => {
    const io = capture();

    const code = await run(['node', 'context-tree', 'render', '--root', join(tempDir(), 'absent')], io);

    expect(code).toBe(1);
    expect(io.stderr).toHaveLength(1);
    expect(io.stdout).toEqual([]);
  });
});
