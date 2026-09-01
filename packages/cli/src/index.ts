/**
 * @context-tree/cli — public surface.
 *
 * The command functions are exported alongside the program because they are the
 * unit under test and the reusable half: each one takes options and an `Io` and
 * returns its report, so nothing needs to spawn a process to drive the CLI.
 */
export { buildProgram, run } from './program.js';
export { CliError, messageOf, scrubSecrets } from './errors.js';
export { processIo, report, type Io } from './io.js';
export {
  configFor,
  cwdOf,
  openExistingStore,
  type GlobalOptions,
} from './context.js';
export {
  mapClaudeCodeTranscript,
  type LineFailure,
  type TranscriptOptions,
  type TranscriptResult,
} from './claude-code.js';
export {
  initCommand,
  type InitHost,
  type InitOptions,
  type InitResult,
  type McpRegistration,
} from './commands/init.js';
export { importCommand, type ImportOptions, type ImportResult } from './commands/import.js';
export { rebuildCommand, type RebuildOptions, type RebuildReport } from './commands/rebuild.js';
export { renderCommand, type RenderOptions, type RenderReport } from './commands/render.js';
export {
  summarizeCommand,
  type SummarizeOptions,
  type SummarizeOutcomeReport,
  type SummarizePlanEntry,
  type SummarizeReport,
} from './commands/summarize.js';
export { treeCommand, type TreeOptions, type TreeReport, type TreeRow } from './commands/tree.js';
export { evalCommand, type EvalOptions, type EvalReport } from './commands/eval.js';
