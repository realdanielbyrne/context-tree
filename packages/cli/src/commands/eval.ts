/**
 * §15 evaluation harness entry point — deliberately a shell.
 *
 * The harness itself lives in `eval/` (fixtures, arms A–D, checkers, judge) and
 * is not part of the published packages, so this command's whole job is to find
 * it, hand it the arguments, and say something useful when it is not there.
 * Anything more would duplicate the harness's own contract here.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cwdOf, type GlobalOptions } from '../context.js';
import { CliError } from '../errors.js';
import { report, type Io } from '../io.js';

export type EvalOptions = GlobalOptions;

export interface EvalReport {
  harness: string;
  args: string[];
}

/** The built entry point, then the source, so the error can say which case it is. */
const HARNESS_JS = join('eval', 'harness', 'index.js');
const HARNESS_TS = join('eval', 'harness', 'index.ts');

interface HarnessModule {
  runEval?: (args: readonly string[]) => unknown;
}

export async function evalCommand(
  args: readonly string[],
  opts: EvalOptions,
  io: Io,
): Promise<EvalReport> {
  const cwd = cwdOf(opts);
  const built = join(cwd, HARNESS_JS);
  if (!existsSync(built)) {
    throw new CliError(
      existsSync(join(cwd, HARNESS_TS))
        ? `${HARNESS_TS} is TypeScript source: build it (pnpm build) or run the §15 harness through vitest`
        : `the §15 eval harness is not built — expected ${HARNESS_JS} under ${cwd}`,
    );
  }

  const module_ = (await import(pathToFileURL(built).href)) as HarnessModule;
  if (typeof module_.runEval !== 'function') {
    throw new CliError(`${HARNESS_JS} does not export runEval(args) — the §15 harness entry point`);
  }
  await module_.runEval(args);

  const payload: EvalReport = { harness: built, args: [...args] };
  report(io, opts.json, payload, [`ran ${built}`]);
  return payload;
}
