import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_FILENAME, DEFAULT_CONFIG, loadApiKeys, loadConfig, resolveConfig } from '../src/config.js';
import { ConfigError } from '../src/contracts/errors.js';

describe('resolveConfig', () => {
  it('keeps Mode A and neutral `other` as the v1 defaults (§19 Q5, Ruling C6)', () => {
    // These two defaults are load-bearing: Mode B changes what the MCP server
    // writes to L0, and a non-neutral `other` re-shapes every tree.
    const cfg = resolveConfig();
    expect(cfg.mode).toBe('tool-backend');
    expect(cfg.neutralPhases).toEqual(['other']);
  });

  it('merges toolPhase over the defaults so a harness can remap without losing the rest', () => {
    const cfg = resolveConfig({ toolPhase: { Bash: 'verification' } });
    expect(cfg.toolPhase.Bash).toBe('verification');
    expect(cfg.toolPhase.Edit).toBe('implementation');
  });

  it('rejects an unknown phase name rather than silently producing an untyped tree', () => {
    expect(() => resolveConfig({ toolPhase: { X: 'nope' as never } })).toThrow(ConfigError);
  });

  it('resolves root against cwd so every layer agrees on one directory', () => {
    const cfg = resolveConfig({ root: '.ct' }, '/tmp/example');
    expect(cfg.root).toBe('/tmp/example/.ct');
  });
});

describe('loadConfig', () => {
  it('falls back to defaults when no config file exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-cfg-'));
    expect(loadConfig(dir).leafModel).toBe(DEFAULT_CONFIG.leafModel);
  });

  it('reads and validates a config file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-cfg-'));
    writeFileSync(join(dir, CONFIG_FILENAME), JSON.stringify({ leafModel: 'x', neutralPhases: [] }));
    const cfg = loadConfig(dir);
    expect(cfg.leafModel).toBe('x');
    expect(cfg.neutralPhases).toEqual([]);
  });

  it('surfaces malformed JSON instead of silently using defaults', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-cfg-'));
    writeFileSync(join(dir, CONFIG_FILENAME), '{not json');
    expect(() => loadConfig(dir)).toThrow(ConfigError);
  });
});

describe('loadApiKeys', () => {
  it('reads keys from the environment only — never from the committed config file', () => {
    expect(loadApiKeys({ ANTHROPIC_API_KEY: 'k' })).toEqual({ anthropic: 'k' });
    expect(loadApiKeys({})).toEqual({});
  });
});
