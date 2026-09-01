/**
 * Materializes the fixture catalogue to disk as `.jsonl`.
 *
 * The files are generated and committed, not generated on demand: a task's
 * `trace.fixture` is a path the harness reads at run time, and §17 wants the
 * golden fixtures under version control so a segmenter change shows up as a
 * diff in the derived tree rather than in the input.
 *
 * `fixtureFiles()` returns the bytes rather than writing them, which is what
 * lets `tasks.test.ts` assert byte-stability across two generations without a
 * temp directory dance — a fixture that is not byte-stable makes D8's "L1 is a
 * function of L0" untestable.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serializeTrace } from './build.js';
import { SCENARIOS } from './scenarios.js';
import { SHAPES } from './shapes.js';

export interface GeneratedFile {
  /** Path relative to `eval/fixtures/`. */
  name: string;
  content: string;
}

/** `eval/fixtures/`, resolved from this module so a caller's cwd cannot move it. */
export const FIXTURES_DIR = dirname(fileURLToPath(import.meta.url));

export const TRACES_SUBDIR = 'traces';

export function fixtureFiles(): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  for (const shape of SHAPES) {
    files.push({
      name: join(TRACES_SUBDIR, `${shape.id}.jsonl`),
      content: serializeTrace(shape.header, shape.events),
    });
  }
  for (const scenario of SCENARIOS) {
    files.push({
      name: join(TRACES_SUBDIR, `${scenario.id}.jsonl`),
      content: serializeTrace(scenario.header, scenario.events),
    });
  }
  return files;
}

/** Writes the catalogue under `dir`, returning the absolute paths written. */
export function writeFixtures(dir: string = FIXTURES_DIR): string[] {
  mkdirSync(join(dir, TRACES_SUBDIR), { recursive: true });
  return fixtureFiles().map((file) => {
    const target = join(dir, file.name);
    writeFileSync(target, file.content, 'utf8');
    return target;
  });
}
