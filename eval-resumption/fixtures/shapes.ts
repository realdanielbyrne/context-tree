/**
 * The seven session SHAPES the §7 segmenter has to handle, as standalone
 * fixtures. All synthetic (see `build.ts`).
 *
 * The task set in `eval/tasks/` measures a model; these measure the pipeline.
 * They exist separately because a task fixture is chosen for what it asks the
 * agent, and picking task traces that happen to cover every segmenter branch
 * would couple two unrelated jobs — and quietly lose coverage the first time a
 * task was reworded.
 *
 * Each shape names the §7 clause it exercises. `tasks.test.ts` asserts the
 * stated outcome for each; a shape whose outcome nothing asserts is a fixture
 * that cannot fail.
 */
import { buildTrace } from './build.js';
import type { TaskEvent } from '../harness/task-spec.js';

export interface ShapeFixture {
  id: string;
  /** Lines written into the fixture file's `//` header. */
  header: string[];
  events: TaskEvent[];
}

const PARSE_TS = [
  'export function parseAmount(raw: string): number {',
  '  const cleaned = raw.replace(/[$,]/g, "");',
  '  return Math.round(Number(cleaned) * 100);',
  '}',
].join('\n');

/** §7's headline case: one phase per activity kind, in order. */
function cleanProgression(): TaskEvent[] {
  return buildTrace()
    .user('amounts imported from the bank CSV are 100x too small')
    .read('src/import/amount.ts', 'export function parseAmount(raw) { return Number(raw); }')
    .grep('parseAmount', 'src/import/amount.ts:1\nsrc/import/rows.ts:14')
    .say('parseAmount returns dollars; every caller stores minor units. Convert at the parse boundary.')
    .edit('src/import/amount.ts', PARSE_TS)
    .verify('import', '9 passing, 0 failing (import)')
    .openPr('pr/412', 'parse bank amounts as minor units')
    .events();
}

/**
 * Ruling C6, the case that motivated neutral phases: reads and shells dominate
 * a real trace. `Bash` maps to `other`, which is neutral, so this whole run is
 * ONE diagnosis branch. With `neutralPhases: []` it shatters into eleven
 * single-event phases, and the tree stops being worth assembling.
 */
function readDominated(): TaskEvent[] {
  const trace = buildTrace().user('why does the nightly equipment sync drop half the rows?');
  const files = ['sync/pull.ts', 'sync/merge.ts', 'sync/write.ts'];
  for (const file of files) {
    trace
      .read(`src/${file}`, `// ${file}: 40 lines`)
      .shell(`wc -l src/${file}`, `40 src/${file}`)
      .grep('dedupe', `src/${file}:12`);
  }
  return trace.say('every read points at merge.ts dropping rows whose timestamp is null').events();
}

/**
 * §7: "re-edits of one path append spans to the same file node" — but the file
 * node is scoped to the PHASE (`fileKey(phaseIndex, path)`), so the same path
 * edited before and after a verification run is TWO nodes. That is the
 * behaviour a resumed task depends on when it asks about "the earlier edit".
 */
function reeditAcrossPhases(): TaskEvent[] {
  return buildTrace()
    .user('the retry backoff never gives up')
    .edit('src/net/backoff.ts', 'export const nextDelayMs = (n: number): number => 2 ** n * 100;')
    .verifyFails('net', '3 passing, 1 failing (net)', 'expected a ceiling after 5 attempts')
    .edit('src/net/backoff.ts', 'export const nextDelayMs = (n: number): number => Math.min(2 ** n * 100, 30_000);')
    .verify('net', '4 passing, 0 failing (net)')
    .events();
}

/** §7: an explicit `segment_boundary` wins over the tool state machine. */
function explicitBoundary(): TaskEvent[] {
  return buildTrace()
    .user('review the pool change before it ships')
    .read('src/queue/pool.ts', 'export const runPool = async (jobs, cap = 8) => { /* … */ };')
    .boundary('review', 'diagnosis')
    .comment('pr/377', 'cap of 8 matches the summarizer concurrency; approve once the test names it')
    .events();
}

/** §18: tool-name drift degrades to `other`, is reported in stats, never crashes. */
function unmappedTool(): TaskEvent[] {
  return buildTrace()
    .user('pull the deploy manifest for the api function app')
    .unmapped('frobnicate_widget', { target: 'api', mode: 'manifest' }, 'manifest: 3 slots, 1 healthy')
    .say('the manifest tool is not in TOOL_PHASE, so this turn is bucketed as other')
    .events();
}

/**
 * §12/D9's error tolerance, which is the whole reason tree-sitter is in the
 * pipeline: an agent's mid-edit file does not parse, and ingestion must still
 * produce spans (degraded to diff hunks if it must) rather than fail.
 */
function brokenEdit(): TaskEvent[] {
  return buildTrace()
    .user('extract the tax split out of lineTotal')
    .edit(
      'src/pricing/line.ts',
      [
        'export function lineTotal(cents: number, taxRate: number): number {',
        '  const base = Math.round(cents);',
        '  return Math.round(base * (1 + taxRate));',
        // Deliberately unbalanced: this is what a half-applied edit looks like.
        'export function taxOf(cents: number, taxRate: number): number {',
        '  return Math.round(cents * taxRate);',
        '}',
      ].join('\n'),
    )
    .verifyFails('pricing', '0 passing, 1 failing (pricing)', 'SyntaxError: unexpected token export')
    .events();
}

/**
 * §16 M1's acceptance fixture: 400+ events, segmented in a single O(n) pass
 * under 5 ms and bit-identical across runs. 58 cycles x 7 events + 2 framing
 * turns = 408.
 */
function longSession(): TaskEvent[] {
  const trace = buildTrace().user('normalize every equipment vendor adapter onto the shared meter shape');
  for (let i = 1; i <= 58; i += 1) {
    const path = `src/adapters/vendor${String(i).padStart(2, '0')}.ts`;
    trace
      .read(path, `export const pull${String(i)} = async () => rawMeter(${String(i)});`)
      .say(`vendor ${String(i)} returns a raw meter; wrap it in toMeterReading before it reaches the store`)
      .edit(
        path,
        [
          `export const pull${String(i)} = async (): Promise<MeterReading> => {`,
          `  const raw = await rawMeter(${String(i)});`,
          '  return toMeterReading(raw);',
          '};',
        ].join('\n'),
      )
      .verify(`adapters/vendor${String(i).padStart(2, '0')}`, `2 passing, 0 failing (vendor${String(i)})`);
  }
  return trace.say('58 adapters normalized; the shared meter shape is the only writer now').events();
}

export const SHAPES: readonly ShapeFixture[] = Object.freeze([
  {
    id: 'shape-clean-progression',
    header: [
      'Shape: diagnosis -> implementation -> verification -> delivery, one phase each.',
      '§7 phase progression with no neutral tools in the way.',
    ],
    events: cleanProgression(),
  },
  {
    id: 'shape-read-dominated',
    header: [
      'Shape: reads, greps and shells only — the case that motivated neutral phases.',
      'Ruling C6: `other` extends the open phase, so this is ONE diagnosis branch.',
    ],
    events: readDominated(),
  },
  {
    id: 'shape-reedit-across-phases',
    header: [
      'Shape: one path edited, verified, then edited again.',
      '§7 file nodes are phase-scoped, so this path owns TWO file nodes.',
    ],
    events: reeditAcrossPhases(),
  },
  {
    id: 'shape-explicit-boundary',
    header: ['Shape: an explicit segment_boundary, which §7 honours over the tool state machine.'],
    events: explicitBoundary(),
  },
  {
    id: 'shape-unmapped-tool',
    header: ['Shape: a tool name with no TOOL_PHASE mapping. §18: degrade to `other`, never crash.'],
    events: unmappedTool(),
  },
  {
    id: 'shape-broken-edit',
    header: [
      'Shape: a syntactically broken post-edit file (unbalanced braces).',
      '§12/D9: ingestion must still yield spans for a mid-edit file.',
    ],
    events: brokenEdit(),
  },
  {
    id: 'shape-long-session',
    header: [
      'Shape: 408 events across 58 diagnose/edit/verify cycles.',
      '§16 M1 acceptance: segments in a single O(n) pass, <5 ms, bit-identical.',
    ],
    events: longSession(),
  },
]);
