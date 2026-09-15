/**
 * Scenario loader — turns a directory of prompts into a runnable task module.
 *
 * A scenario is data (system prompt + ordered user turns + release gates + seed
 * files) so that ONE agent workload can drive SEVERAL experiments with only the
 * instrumentation changing. See experiments/scenarios/README.md.
 */
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Workspace predicates. Evaluated against files, never the transcript, so an agent
 *  cannot release a turn by merely claiming to have finished. */
const PREDICATES = {
  exists: (ws, p) => existsSync(join(ws, p)),
  fileMinBytes: (ws, [p, n]) => { try { return statSync(join(ws, p)).size >= n; } catch { return false; } },
  fileContains: (ws, [p, needle]) => { try { return readFileSync(join(ws, p), 'utf8').includes(needle); } catch { return false; } },
  countFiles: (ws, [glob, n]) => { try { return readdirSync(ws).filter((f) => f.endsWith(glob)).length >= n; } catch { return false; } },
};

export function evalGate(ws, gate) {
  if (!gate) return true;
  if (gate.allOf) return gate.allOf.every((g) => evalGate(ws, g));
  if (gate.anyOf) return gate.anyOf.some((g) => evalGate(ws, g));
  const [k, v] = Object.entries(gate)[0] ?? [];
  const fn = PREDICATES[k];
  if (!fn) throw new Error(`unknown gate predicate: ${k}`);
  return fn(ws, v);
}

const walk = (dir, base = dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, base, out); else out.push(relative(base, p));
  }
  return out;
};

export function loadScenario(name, root = HERE) {
  const dir = join(root, name);
  const manifest = JSON.parse(readFileSync(join(dir, 'scenario.json'), 'utf8'));
  const system = readFileSync(join(dir, manifest.system ?? 'system.md'), 'utf8').trim();
  const turns = manifest.turns.map((t) => ({ ...t, text: readFileSync(join(dir, t.file), 'utf8').trim() }));
  const seedDir = join(dir, manifest.seed ?? 'seed');
  const seedFiles = existsSync(seedDir) ? walk(seedDir) : [];

  const seed = (ws) => {
    for (const rel of seedFiles) {
      const dst = join(ws, rel);
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(join(seedDir, rel), dst);
    }
  };

  /**
   * Releases follow-up turns. `hook` fires at the top of each agent turn; `onEnd`
   * fires when the model stops calling tools, so a turn cannot be skipped by an
   * agent that finishes early (runAgent otherwise exits at that point).
   */
  const makeHook = (ws, { fallbackScale = 1 } = {}) => {
    let next = 1;                       // turns[0] is the opening instruction
    const log = [];
    const release = (messages, turn, via) => {
      const t = turns[next];
      if (!t) return false;
      messages.push({ role: 'user', content: t.text });
      log.push({ id: t.id, turn, via });
      next += 1;
      return true;
    };
    return {
      hook(messages, turn) {
        const t = turns[next];
        if (!t) return;
        if (evalGate(ws, t.gate)) release(messages, turn, 'gate');
        else if (t.fallbackTurn && turn >= Math.round(t.fallbackTurn * fallbackScale)) release(messages, turn, 'fallback');
      },
      onEnd(messages, turn) { return turns[next] ? release(messages, turn, 'on-end') : false; },
      state: () => ({ turns_total: turns.length, turns_released: next - 1,
        all_released: next >= turns.length, releases: log }),
    };
  };

  return { name, dir, manifest, system, turns, seedFiles, seed, makeHook,
    describe: () => ({ name, turns: turns.map((t) => ({ id: t.id, chars: t.text.length, gate: t.gate ?? null })),
      seed_files: seedFiles.length, system_chars: system.length }) };
}

/** Adapt a scenario to the coding-harness task-module shape. */
export function scenarioTask(name, { grade, score, allowedTools = null, root = HERE } = {}) {
  const sc = loadScenario(name, root);
  return {
    name: sc.manifest.title ?? name,
    scenario: sc,
    system: sc.system,
    task: sc.turns[0].text,
    allowedTools,
    seed: (ws) => sc.seed(ws),
    makeHook: (ws) => sc.makeHook(ws),
    grade: grade ?? (() => false),
    score: score ?? undefined,
  };
}
