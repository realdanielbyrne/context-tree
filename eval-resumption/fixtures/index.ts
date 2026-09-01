/**
 * Synthetic fixture catalogue for the §15 benchmark (§17 golden fixtures).
 *
 * Nothing here is derived from a real transcript. See `build.ts`.
 */
export { TraceBuilder, buildTrace, serializeTrace } from './build.js';
export { SHAPES, type ShapeFixture } from './shapes.js';
export { SCENARIOS, scenarioById, type Scenario } from './scenarios.js';
export {
  FIXTURES_DIR,
  TRACES_SUBDIR,
  fixtureFiles,
  writeFixtures,
  type GeneratedFile,
} from './generate.js';
