import { describe, it, expect } from 'vitest';

import { judgeFromRow, filesFromRow } from '../../src/adapters/util.js';
import type { ScenarioJudge } from '../src/types.js';

describe('judgeFromRow: judge_files hidden tests', () => {
  it('attaches judge_files to a command judge', () => {
    const judge: ScenarioJudge = judgeFromRow({
      judge_command: 'python3 hidden_test.py',
      judge_files: { 'hidden_test.py': 'assert True\n' },
    });
    expect(judge.kind).toBe('command');
    expect(judge.command).toBe('python3 hidden_test.py');
    expect(judge.files).toEqual({ 'hidden_test.py': 'assert True\n' });
  });

  it('keeps a command judge without files when judge_files is absent', () => {
    const judge: ScenarioJudge = judgeFromRow({ judge_command: 'python3 hidden_test.py' });
    expect(judge.kind).toBe('command');
    expect(judge.files).toBeUndefined();
  });

  it('rejects a malformed judge_files map', () => {
    expect(() => judgeFromRow({ judge_command: 'bash t.sh', judge_files: 'not-an-object' })).toThrow(
      '"judge_files" must be an object',
    );
  });
});

describe('filesFromRow: scenario files', () => {
  it('keeps raising AdapterLoadError for a malformed files map', () => {
    expect(() => filesFromRow('bench', { files: 'nope' }, 'row 1')).toThrow(
      '"files" must be an object of path -> content',
    );
  });
});
