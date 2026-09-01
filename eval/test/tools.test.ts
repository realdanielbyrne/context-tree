/**
 * The sandbox + harness tool executors: containment, round-trips, and the
 * fail-loud error path every tool failure takes (an error TEXT the model can
 * act on, never a throw the loop can't account).
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSandbox, safeJoin } from '../src/sandbox.js';
import { EDIT_FILE, executeHarnessTool, isContextTool, isHarnessTool, pathOf, READ_FILE, RUN_COMMAND, TREE_ZONE_A_TOOL_SCHEMAS_TEXT, WRITE_FILE } from '../src/tools.js';
import type { Scenario } from '../src/types.js';

const emptyScenario: Scenario = { id: 's', benchmark: 'b', task: 't', judge: { kind: 'exact_match', answer: 'x' } };

describe('safeJoin', () => {
  const root = '/tmp/sandbox-root';

  it('resolves relative paths inside the sandbox', () => {
    expect(safeJoin(root, 'src/a.ts')).toBe(join(root, 'src/a.ts'));
    expect(safeJoin(root, './b.txt')).toBe(join(root, 'b.txt'));
  });

  it('tolerates an absolute path by treating it as sandbox-relative', () => {
    expect(safeJoin(root, '/c.txt')).toBe(join(root, 'c.txt'));
  });

  it('refuses any path that climbs out of the sandbox', () => {
    expect(() => safeJoin(root, '../escape.txt')).toThrow(/escapes the sandbox/);
    expect(() => safeJoin(root, 'a/../../escape.txt')).toThrow(/escapes the sandbox/);
  });

  it('refuses empty paths', () => {
    expect(() => safeJoin(root, '  ')).toThrow(/empty path/);
  });
});

describe('harness tools', () => {
  it('write_file -> read_file -> edit_file round-trips inside the sandbox', async () => {
    const sandbox = createSandbox(emptyScenario, 'tools-test');
    try {
      const wrote = await executeHarnessTool(sandbox, WRITE_FILE, { path: 'src/a.txt', content: 'alpha\nbeta\n' });
      expect(wrote.isError).toBe(false);
      expect(wrote.postContent).toContain('alpha');

      const read = await executeHarnessTool(sandbox, READ_FILE, { path: 'src/a.txt' });
      expect(read.output).toBe('alpha\nbeta\n');

      const edited = await executeHarnessTool(sandbox, EDIT_FILE, { path: 'src/a.txt', old_text: 'beta', new_text: 'gamma' });
      expect(edited.postContent).toBe('alpha\ngamma\n');
      expect(sandbox.readFile('src/a.txt')).toBe('alpha\ngamma\n');
    } finally {
      sandbox.cleanup();
    }
  });

  it('run_command executes in the sandbox and reports non-zero exits as tool errors', async () => {
    const sandbox = createSandbox({ ...emptyScenario, files: { 'ok.txt': 'yes' } }, 'cmd-test');
    try {
      const ok = await executeHarnessTool(sandbox, RUN_COMMAND, { command: 'cat ok.txt' });
      expect(ok.isError).toBe(false);
      expect(ok.output).toContain('yes');

      const failed = await executeHarnessTool(sandbox, RUN_COMMAND, { command: 'exit 3' });
      expect(failed.isError).toBe(true);
      expect(failed.output).toContain('exit 3');
    } finally {
      sandbox.cleanup();
    }
  });

  it('edit_file on a missing old_text fails as a message, not a throw', async () => {
    const sandbox = createSandbox({ ...emptyScenario, files: { 'a.txt': 'hello' } }, 'edit-test');
    try {
      const outcome = await executeHarnessTool(sandbox, EDIT_FILE, { path: 'a.txt', old_text: 'nope', new_text: 'x' });
      expect(outcome.isError).toBe(true);
      expect(outcome.output).toContain('does not contain old_text');
    } finally {
      sandbox.cleanup();
    }
  });

  it('unknown tools and bad arguments degrade to error text', async () => {
    const sandbox = createSandbox(emptyScenario, 'unknown-test');
    try {
      const unknown = await executeHarnessTool(sandbox, 'teleport', {});
      expect(unknown.isError).toBe(true);
      expect(unknown.output).toContain('unknown harness tool');

      const bad = await executeHarnessTool(sandbox, READ_FILE, {});
      expect(bad.isError).toBe(true);
      expect(bad.output).toContain('tool error');
    } finally {
      sandbox.cleanup();
    }
  });
});

describe('tool-name predicates and Zone A text', () => {
  it('classifies harness vs context tools, and the Zone A text is stable JSON with all eight tools', () => {
    expect(isHarnessTool('run_command')).toBe(true);
    expect(isContextTool('context_fetch')).toBe(true);
    expect(isContextTool('run_command')).toBe(false);
    const parsed: unknown = JSON.parse(TREE_ZONE_A_TOOL_SCHEMAS_TEXT);
    expect(Array.isArray(parsed)).toBe(true);
    expect((parsed as unknown[]).length).toBe(8);
    expect(TREE_ZONE_A_TOOL_SCHEMAS_TEXT).toContain('context_peek');
  });

  it('pathOf extracts the path argument, sandbox-safe', () => {
    expect(pathOf({ path: 'src/a.ts' })).toBe('src/a.ts');
    expect(pathOf({})).toBeUndefined();
    expect(pathOf({ path: '../escape' })).toBeUndefined();
  });
});

describe('scenario file materialization', () => {
  it('writes scenario files into the sandbox before the agent starts', () => {
    const sandbox = createSandbox(
      { ...emptyScenario, files: { 'docs/readme.md': '# hi' } },
      'materialize-test',
    );
    try {
      expect(sandbox.readFile('docs/readme.md')).toBe('# hi');
    } finally {
      sandbox.cleanup();
    }
  });

  it('sandboxes are unique per call', () => {
    const a = createSandbox(emptyScenario, 'unique');
    const b = createSandbox(emptyScenario, 'unique');
    try {
      expect(a.path).not.toBe(b.path);
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });
});
