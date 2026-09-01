#!/usr/bin/env node
/** §13: `npm i -g @context-tree/cli` puts this on PATH as `context-tree`. */
import { run } from './program.js';

// Set rather than thrown or exited: pending stdout writes still flush.
process.exitCode = await run(process.argv);
