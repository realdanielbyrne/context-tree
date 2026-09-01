/**
 * §13's `context-tree` command surface.
 *
 * The subcommands are thin: each one parses flags and calls the command
 * function, which is where the behavior and the tests live. `run()` is the only
 * place that turns a failure into an exit code, and the only place that writes
 * to the process — everything below it takes an `Io`.
 */
import { createRequire } from 'node:module';
import { Command, CommanderError, Option } from 'commander';
import { initCommand, type InitHost } from './commands/init.js';
import { importCommand } from './commands/import.js';
import { rebuildCommand } from './commands/rebuild.js';
import { renderCommand } from './commands/render.js';
import { summarizeCommand } from './commands/summarize.js';
import { treeCommand } from './commands/tree.js';
import { evalCommand } from './commands/eval.js';
import type { GlobalOptions } from './context.js';
import { CliError, messageOf, scrubSecrets } from './errors.js';
import { processIo, type Io } from './io.js';

interface GlobalFlags {
  root?: string;
  json?: boolean;
}

/**
 * Accepted both before and after the subcommand, because `context-tree tree
 * --root X` is what people type. `optsWithGlobals` merges the two positions.
 */
function withGlobals(command: Command): Command {
  return command
    .option('--root <dir>', 'store root (default: `root` from context-tree.config.json)')
    .option('--json', 'machine-readable output: one JSON document on stdout');
}

function globals(command: Command): GlobalOptions {
  const flags = command.optsWithGlobals<GlobalFlags>();
  return { root: flags.root, json: flags.json, cwd: process.cwd() };
}

export function buildProgram(io: Io): Command {
  const program = new Command();
  withGlobals(program)
    .name('context-tree')
    .description('Reorganize an agent trace into a summary-headed tree (L0 -> L1 -> L4).')
    .version(cliVersion())
    // Commander must never call process.exit under us: `run()` owns the exit
    // code, and a test drives these functions in-process.
    .exitOverride()
    .configureOutput({
      writeOut: (text) => io.out(stripNewline(text)),
      writeErr: (text) => io.err(stripNewline(text)),
    });

  withGlobals(program.command('init'))
    .description('register the MCP server with a host and scaffold context-tree.config.json')
    .addOption(
      new Option('--host <host>', 'host to configure; "print" writes nothing').choices([
        'claude-code',
        'codex',
        'print',
      ]),
    )
    .option('--force', 'replace an existing context-tree registration')
    .action((options: { host?: InitHost; force?: boolean }, command: Command) => {
      initCommand({ ...globals(command), host: options.host, force: options.force }, io);
    });

  withGlobals(program.command('import'))
    .description('ingest a trace into L0 + L2 and derive L1')
    .argument('<trace.jsonl>', 'L0 trace, or a Claude Code transcript with --from-claude-code')
    .option('--from-claude-code', 'read the file as a Claude Code session transcript')
    .option('--strict', 'fail on the first unreadable line instead of importing the rest')
    .action(
      (
        file: string,
        options: { fromClaudeCode?: boolean; strict?: boolean },
        command: Command,
      ) => {
        importCommand(
          file,
          { ...globals(command), fromClaudeCode: options.fromClaudeCode, strict: options.strict },
          io,
        );
      },
    );

  withGlobals(program.command('rebuild'))
    .description('delete the derived layers and re-derive L1 from L0 + L2 (D8)')
    .option('--yes', 'confirm: this also discards the L3 embeddings')
    .action((options: { yes?: boolean }, command: Command) => {
      rebuildCommand({ ...globals(command), yes: options.yes }, io);
    });

  withGlobals(program.command('render'))
    .description('render the L4 markdown view of the tree')
    .option('--out <file>', 'write the view to this file instead of stdout')
    .option('--views', "write it to the store's own views/ directory")
    .action((options: { out?: string; views?: boolean }, command: Command) => {
      renderCommand({ ...globals(command), out: options.out, views: options.views }, io);
    });

  withGlobals(program.command('summarize'))
    .description('run the §8 summarizer (the one command that spends money)')
    .option('--stale-only', 'only re-summarize what the D4 cascade marked stale')
    .option('--dry-run', 'print the plan and the call count; call no model')
    .action(async (options: { staleOnly?: boolean; dryRun?: boolean }, command: Command) => {
      await summarizeCommand(
        { ...globals(command), staleOnly: options.staleOnly, dryRun: options.dryRun },
        io,
      );
    });

  withGlobals(program.command('tree'))
    .description('one line per node: id, kind, span, staleness, summary version')
    .action((_options: unknown, command: Command) => {
      treeCommand(globals(command), io);
    });

  withGlobals(program.command('eval'))
    .description('run the §15 evaluation harness from eval/')
    .argument('[args...]', 'arguments passed through to the harness')
    .allowUnknownOption()
    .action(async (args: string[], _options: unknown, command: Command) => {
      await evalCommand(args, globals(command), io);
    });

  return program;
}

/** Returns the process exit code; never throws and never calls `process.exit`. */
export async function run(argv: readonly string[], io: Io = processIo): Promise<number> {
  try {
    await buildProgram(io).parseAsync([...argv]);
    return 0;
  } catch (error) {
    // Commander already wrote the message (help, unknown command, bad choice)
    // through the configured output and carries the code it wants.
    if (error instanceof CommanderError) return error.exitCode;
    io.err(`context-tree: ${scrubSecrets(messageOf(error))}`);
    return error instanceof CliError ? error.exitCode : 1;
  }
}

function stripNewline(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

/** The published version, read from the package rather than duplicated here. */
function cliVersion(): string {
  try {
    const pkg = createRequire(import.meta.url)('../package.json') as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
