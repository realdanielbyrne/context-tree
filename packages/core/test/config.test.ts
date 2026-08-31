import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_FILENAME, DEFAULT_CONFIG, loadApiKeys, loadConfig, loadDotEnv, resolveConfig } from '../src/config.js';
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

describe('loadDotEnv', () => {
  it('populates process.env so §11 env-only keys have something to read', () => {
    // Without this, a key sitting in a .env is invisible: loadApiKeys reads the
    // environment and nothing else ever wrote to it.
    const dir = mkdtempSync(join(tmpdir(), 'ct-env-'));
    writeFileSync(join(dir, '.env'), 'CT_PROBE_ONE=alpha\n');
    delete process.env.CT_PROBE_ONE;
    try {
      const r = loadDotEnv(dir);
      expect(r.applied).toContain('CT_PROBE_ONE');
      expect(process.env.CT_PROBE_ONE).toBe('alpha');
    } finally {
      delete process.env.CT_PROBE_ONE;
    }
  });

  it('never overrides a variable already set, because an explicit KEY=… command must win over a stale file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-env-'));
    writeFileSync(join(dir, '.env'), 'CT_PROBE_TWO=from-file\n');
    process.env.CT_PROBE_TWO = 'from-shell';
    try {
      const r = loadDotEnv(dir);
      expect(process.env.CT_PROBE_TWO).toBe('from-shell');
      expect(r.skipped).toContain('CT_PROBE_TWO');
      expect(r.applied).not.toContain('CT_PROBE_TWO');
    } finally {
      delete process.env.CT_PROBE_TWO;
    }
  });

  it('parses quotes, `export`, comments and blank lines, and ignores junk lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-env-'));
    writeFileSync(
      join(dir, '.env'),
      ['# a comment', '', 'export CT_P3="quoted value"', "CT_P4='single'", 'CT_P5=bare # trailing', 'not a pair'].join('\n'),
    );
    for (const k of ['CT_P3', 'CT_P4', 'CT_P5']) delete process.env[k];
    try {
      loadDotEnv(dir);
      expect(process.env.CT_P3).toBe('quoted value');
      expect(process.env.CT_P4).toBe('single');
      expect(process.env.CT_P5).toBe('bare');
    } finally {
      for (const k of ['CT_P3', 'CT_P4', 'CT_P5']) delete process.env[k];
    }
  });

  it('reports names but never values, because its entire input is secrets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-env-'));
    writeFileSync(join(dir, '.env'), 'CT_SECRET=super-secret-value\n');
    delete process.env.CT_SECRET;
    try {
      const serialized = JSON.stringify(loadDotEnv(dir));
      expect(serialized).toContain('CT_SECRET');
      expect(serialized).not.toContain('super-secret-value');
    } finally {
      delete process.env.CT_SECRET;
    }
  });
});

describe('loadApiKeys aliases', () => {
  it('accepts OPENROUTER_KEY as well as OPENROUTER_API_KEY, because ignoring a key that is plainly present reads as "no key configured"', () => {
    expect(loadApiKeys({ OPENROUTER_KEY: 'k' }).openrouter).toBe('k');
    expect(loadApiKeys({ OPENROUTER_API_KEY: 'canonical', OPENROUTER_KEY: 'alias' }).openrouter).toBe('canonical');
  });
});

describe('provider-aware model defaults', () => {
  it('gives openrouter its namespaced ids, because an Anthropic-native id 404s there', () => {
    // The failure this prevents is a 404 at the first live call, long after
    // config load, on a run that already cost time.
    const cfg = resolveConfig({ provider: 'openrouter' });
    expect(cfg.leafModel).toBe('anthropic/claude-haiku-4.5');
    expect(cfg.rootModel).toBe('anthropic/claude-sonnet-5');
  });

  it('never overrides a model the caller named explicitly', () => {
    const cfg = resolveConfig({ provider: 'openrouter', leafModel: 'z-ai/glm-5.3-flash' });
    expect(cfg.leafModel).toBe('z-ai/glm-5.3-flash');
    expect(cfg.rootModel).toBe('anthropic/claude-sonnet-5');
  });

  it('leaves anthropic on its native ids', () => {
    expect(resolveConfig({ provider: 'anthropic' }).leafModel).toBe('claude-haiku-4-5-20251001');
  });
});
