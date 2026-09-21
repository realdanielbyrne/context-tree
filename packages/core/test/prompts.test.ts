/**
 * §11 fixture-based golden tests for the versioned prompt artifacts.
 *
 * Two things are under test that nothing else can catch: that the markdown on
 * disk is what actually reaches a model (§14.1 — a learned policy has to be able
 * to replace one file), and that the §8 contract the parser enforces is the same
 * contract the prompts ask for.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SummaryContractError } from '../src/contracts/errors.js';
import {
  LEAF_SUMMARY_VERSION,
  ROOT_SUMMARY_VERSION,
  SYSTEM_CONTRACT_VERSION,
  SYSTEM_CONTRACT_VERSIONS,
  TOOL_CONTRACT_RULES,
  leafSummaryPrompt,
  loadPrompt,
  parseSummaryResponse,
  renderTemplate,
  rootSummaryPrompt,
  systemContract,
  type ChildSummary,
  type LeafSummaryInput,
} from '../src/prompts/index.js';
import { ContextTreeError } from '../src/contracts/errors.js';

const PROMPT_DIR = fileURLToPath(new URL('../src/prompts/', import.meta.url));

const LEAF_FIXTURE: LeafSummaryInput = {
  title: 'implement the blob store',
  phaseType: 'implementation',
  nodeIds: ['n_01JAAAAAAAAAAAAAAAAAAAAAAA', 'n_01JBBBBBBBBBBBBBBBBBBBBBBB'],
  detail: 'Edit src/blobs/store.ts: added putBlob() and getBlob().\nRan 3 tests, all passed.',
};

const CHILD_FIXTURE: ChildSummary = {
  nodeId: 'n_01JAAAAAAAAAAAAAAAAAAAAAAA',
  title: 'implement the blob store',
  text: 'Added a content-addressed store under src/blobs.',
  meta: {
    files: [{ path: 'src/blobs/store.ts', start_line: 1, end_line: 40, symbol: 'putBlob' }],
    symbols: ['putBlob'],
    tests: [{ name: 'writes once', status: 'passed' }],
    artifacts: [{ kind: 'ticket', ref: 'CT-1' }],
    open_questions: [],
    decisions: ['sha256 addressing (D8)'],
    node_ids: ['n_01JAAAAAAAAAAAAAAAAAAAAAAA'],
  },
};

/** A reply that satisfies the §8 contract in full — the baseline every rejection test mutates. */
function validReply(): Record<string, unknown> {
  return {
    text: 'Implemented the blob store and covered it with three tests.',
    meta: {
      files: [{ path: 'src/blobs/store.ts', start_line: 12, end_line: 40, symbol: 'putBlob' }],
      symbols: ['putBlob', 'getBlob'],
      tests: [{ name: 'writes once', status: 'passed', detail: '3ms' }],
      artifacts: [{ kind: 'pr', ref: '#12', title: 'blob store' }],
      open_questions: ['Should blobs be fsync-ed?'],
      decisions: ['content addressing by sha256'],
      node_ids: ['n_01JAAAAAAAAAAAAAAAAAAAAAAA'],
    },
  };
}

/** Markdown emphasis is presentation; the instruction is what matters. */
function plain(text: string): string {
  return text.replace(/\*/g, '');
}

function placeholdersIn(template: string): string[] {
  return [...template.matchAll(/\{\{([a-z0-9_]+)\}\}/g)].map((m) => m[1] as string);
}

describe('the markdown file is the versioned artifact (§11, §14.1)', () => {
  it('loads each prompt from the .md on disk, so editing the file changes behavior', () => {
    // If these were inlined string literals, a prompt edit would silently not ship.
    const cases: [string, string][] = [
      [`system-contract.${SYSTEM_CONTRACT_VERSION}.md`, systemContract()],
      [`leaf-summary.${LEAF_SUMMARY_VERSION}.md`, loadPrompt('leaf-summary')],
      [`root-summary.${ROOT_SUMMARY_VERSION}.md`, loadPrompt('root-summary')],
    ];
    for (const [file, loaded] of cases) {
      expect(loaded).toBe(readFileSync(PROMPT_DIR + file, 'utf8'));
    }
  });

  it('caches by name so repeated assembly does not re-read the file each turn', () => {
    expect(loadPrompt('leaf-summary')).toBe(loadPrompt('leaf-summary'));
  });
});

describe('the §9 system-prompt contract', () => {
  it('states all three tool-use rules verbatim, because the eval harness scores against them', () => {
    const contract = systemContract();
    expect(TOOL_CONTRACT_RULES).toHaveLength(3);
    for (const rule of TOOL_CONTRACT_RULES) {
      expect(contract).toContain(rule);
    }
  });

  it('names all four MCP tools, since a tool the prompt never mentions is never called', () => {
    const contract = systemContract();
    for (const tool of ['context_fetch', 'context_search', 'context_peek', 'annotate']) {
      expect(contract).toContain(tool);
    }
  });

  it('teaches both §9 failure modes, which are the reason the metadata and the tail rules exist', () => {
    const contract = systemContract();
    // Unknown-unknowns: mitigated only if the model is told to read summary metadata.
    expect(plain(contract)).toMatch(/without\s+expanding/i);
    expect(contract).toMatch(/open questions/i);
    // Accumulation drift: fetched content lives in the tail and is dropped at phase boundaries.
    expect(contract).toMatch(/tail of the transcript|transcript tail/i);
    expect(contract).toMatch(/phase boundary/i);
  });

  it('is frozen Zone A content, so it interpolates nothing (D5: the cache prefix never varies)', () => {
    expect(placeholdersIn(loadPrompt('system-contract'))).toEqual([]);
  });
});

describe('systemContract version selector (loop9-item3 step 1: the Zone A trim)', () => {
  it('defaults to v1, byte-identical to the file on disk — a default drift is a silent epoch shift', () => {
    // The transplant experiment's frozen epoch renders v1 at run time; a default
    // that quietly stopped matching the file would change every recorded run's
    // Zone A prefix without anyone editing v1.md.
    expect(systemContract()).toBe(readFileSync(PROMPT_DIR + `system-contract.${SYSTEM_CONTRACT_VERSION}.md`, 'utf8'));
    expect(systemContract('v1')).toBe(systemContract());
  });

  it('v2 is v1 minus the "Two ways this goes wrong" section, and nothing else changed', () => {
    const v1 = systemContract('v1');
    const v2 = systemContract('v2');
    expect(v1).toContain('Two ways this goes wrong');
    expect(v2).not.toContain('Two ways this goes wrong');
    // Everything v2 keeps is a verbatim prefix of v1 (a clean heading-to-EOF cut,
    // not an edit to the surviving Rules/Tools sections).
    expect(v1.startsWith(v2)).toBe(true);
  });

  it('throws on an unknown version rather than silently falling back to v1', () => {
    let thrown: unknown;
    try {
      systemContract('v9' as never);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ContextTreeError);
    expect((thrown as Error).message).toMatch(/unknown system contract version: v9/);
  });
});

describe('system-contract v4: the pipeline tools', () => {
  it('is v1 plus the pipeline tools — nothing in v1 is reworded, so the two differ only by the addition', () => {
    const v1 = systemContract('v1');
    const v4 = systemContract('v4');
    for (const tool of ['context_units', 'context_classify', 'context_evict', 'context_restore', 'context_reduce', 'context_assemble']) {
      expect(v4).toContain(`\`${tool} `);
      expect(v1).not.toContain(tool);
    }
    const added = v4.slice(v4.indexOf('- `context_units'), v4.indexOf('\n## Two ways this goes wrong'));
    expect(v4.replace(added, '')).toBe(v1);
  });
});

describe('system-contract v3 (loop9b item 2, R10/R11): what a summary cannot carry', () => {
  it('is registered alongside v2 (loop9-item3) without replacing it — the two arms select different files', () => {
    expect(SYSTEM_CONTRACT_VERSIONS).toContain('v1');
    expect(SYSTEM_CONTRACT_VERSIONS).toContain('v2');
    expect(SYSTEM_CONTRACT_VERSIONS).toContain('v3');
  });

  it('systemContract() with no argument still resolves to v1, so every untouched caller is unaffected', () => {
    expect(systemContract()).toBe(systemContract('v1'));
  });

  it('rejects an unregistered version rather than silently resolving nothing', () => {
    expect(() => systemContract('v9' as never)).toThrow(/unknown system contract version/);
  });

  it('keeps exactly three numbered rules, same as v1 — one replaced, none added (G5)', () => {
    const v3 = systemContract('v3');
    expect(v3.match(/^\d+\.\s/gm)).toHaveLength(3);
  });

  it('replaces rule 2 with the "a summary cannot tell you what it said" mechanism statement', () => {
    const v1 = systemContract('v1');
    const v3 = systemContract('v3');
    // v1's rule 2 ("If a summary mentions something you need, fetch that
    // branch") is gone from v3 — the thing under test is a REPLACEMENT of the
    // mechanism, not an addition alongside it.
    expect(v1).toMatch(/fetch that branch/);
    expect(v3).not.toMatch(/fetch that branch/);
    expect(v3).toMatch(/can never tell you what it said/i);
    expect(v3).toContain('depth: "full"');
  });

  it('removes the v1 narrow-fetch instruction that argues against reaching for detail (Graft 1)', () => {
    const v1 = systemContract('v1');
    const v3 = systemContract('v3');
    expect(v1).toMatch(/prefer `file` over a whole branch/);
    expect(v3).not.toMatch(/prefer `file` over a whole branch/);
    // The rest of that paragraph (accumulation + annotate) survives unchanged.
    expect(v3).toMatch(/`annotate` it — that is what persists/);
  });

  it('the root prompt summarizes child summaries, not raw events (§8)', () => {
    expect(loadPrompt('root-summary')).toMatch(/child summar/i);
  });
});

describe('template rendering', () => {
  it('fills every placeholder the leaf template declares', () => {
    const rendered = leafSummaryPrompt(LEAF_FIXTURE);
    for (const key of placeholdersIn(loadPrompt('leaf-summary'))) {
      expect(rendered).not.toContain(`{{${key}}}`);
    }
    expect(rendered).toContain(LEAF_FIXTURE.detail);
    expect(rendered).toContain('n_01JAAAAAAAAAAAAAAAAAAAAAAA, n_01JBBBBBBBBBBBBBBBBBBBBBBB');
  });

  it('fills every placeholder the root template declares, carrying each child id and its metadata', () => {
    const rendered = rootSummaryPrompt({ taskTitle: 'build context-tree', children: [CHILD_FIXTURE] });
    for (const key of placeholdersIn(loadPrompt('root-summary'))) {
      expect(rendered).not.toContain(`{{${key}}}`);
    }
    expect(rendered).toContain('build context-tree');
    expect(rendered).toContain(CHILD_FIXTURE.nodeId);
    // The root call must see the children's rehydration pointers to roll them up (§8).
    expect(rendered).toContain('src/blobs/store.ts');
    expect(rendered).toContain('"decisions"');
  });

  it('throws on an unfilled placeholder, because a prompt shipped with {{files}} in it fails silently', () => {
    expect(() => renderTemplate('before {{detail}} after', {})).toThrowError(/unfilled placeholder\(s\): detail/);
  });

  it('does not rescan interpolated content, so branch detail containing {{x}} is not a template error', () => {
    // Real traces contain template syntax; treating it as a placeholder would make
    // summarization fail on the very content it is summarizing.
    const rendered = renderTemplate('detail: {{detail}}', { detail: 'a literal {{x}} in the trace' });
    expect(rendered).toBe('detail: a literal {{x}} in the trace');
  });
});

describe('parseSummaryResponse enforces the §8 content contract', () => {
  it('accepts a clean JSON object and returns the meta unchanged', () => {
    const parsed = parseSummaryResponse(JSON.stringify(validReply()));
    expect(parsed.text).toBe('Implemented the blob store and covered it with three tests.');
    expect(parsed.meta).toEqual(validReply().meta);
  });

  it('accepts a fenced block wrapped in prose, the shape real models actually return', () => {
    const raw = `Here is the summary you asked for:\n\n\`\`\`json\n${JSON.stringify(
      validReply(),
      null,
      2,
    )}\n\`\`\`\n\nLet me know if you want more detail.`;
    expect(parseSummaryResponse(raw).meta.symbols).toEqual(['putBlob', 'getBlob']);
  });

  it('accepts an unfenced object surrounded by prose', () => {
    const raw = `Sure. ${JSON.stringify(validReply())} Done.`;
    expect(parseSummaryResponse(raw).meta.node_ids).toEqual(['n_01JAAAAAAAAAAAAAAAAAAAAAAA']);
  });

  it('throws when there is no JSON at all rather than returning an empty summary', () => {
    expect(() => parseSummaryResponse('I could not summarize that.')).toThrowError(SummaryContractError);
  });

  // Each of these is a rehydration pointer §9 relevance detection depends on, so a
  // missing or malformed one must name itself — silent coercion would hide it forever.
  const rejections: [string, (reply: Record<string, unknown>) => void, RegExp][] = [
    [
      'missing files',
      (reply) => {
        delete (reply.meta as Record<string, unknown>).files;
      },
      /meta\.files: missing required field/,
    ],
    [
      'a test status outside passed|failed|skipped|unknown',
      (reply) => {
        (reply.meta as { tests: Record<string, unknown>[] }).tests[0]!.status = 'green';
      },
      /meta\.tests\[0\]\.status: expected one of passed\|failed\|skipped\|unknown, got "green"/,
    ],
    [
      'an artifact kind outside ticket|pr|url|other',
      (reply) => {
        (reply.meta as { artifacts: Record<string, unknown>[] }).artifacts[0]!.kind = 'linear';
      },
      /meta\.artifacts\[0\]\.kind: expected one of ticket\|pr\|url\|other, got "linear"/,
    ],
    [
      'missing open_questions',
      (reply) => {
        delete (reply.meta as Record<string, unknown>).open_questions;
      },
      /meta\.open_questions: missing required field/,
    ],
    [
      'non-array symbols',
      (reply) => {
        (reply.meta as Record<string, unknown>).symbols = 'putBlob';
      },
      /meta\.symbols: expected an array/,
    ],
    [
      'a file span with no path',
      (reply) => {
        delete (reply.meta as { files: Record<string, unknown>[] }).files[0]!.path;
      },
      /meta\.files\[0\]\.path: missing required field/,
    ],
    [
      'an end_line before start_line',
      (reply) => {
        (reply.meta as { files: Record<string, unknown>[] }).files[0]!.end_line = 3;
      },
      /meta\.files\[0\]\.end_line: expected >= start_line \(12\)/,
    ],
    [
      'missing prose text',
      (reply) => {
        delete reply.text;
      },
      /^text: missing required field/,
    ],
    [
      'missing meta entirely',
      (reply) => {
        delete reply.meta;
      },
      /^meta: missing required field/,
    ],
  ];

  for (const [label, mutate, expected] of rejections) {
    it(`throws SummaryContractError naming the field for ${label}`, () => {
      const reply = validReply();
      mutate(reply);
      let thrown: unknown;
      try {
        parseSummaryResponse(JSON.stringify(reply));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(SummaryContractError);
      expect((thrown as SummaryContractError).code).toBe('E_SUMMARY_CONTRACT');
      expect((thrown as Error).message).toMatch(expected);
    });
  }

  it('accepts empty arrays, because "nothing touched here" is a legitimate summary', () => {
    const reply = validReply();
    reply.meta = {
      files: [],
      symbols: [],
      tests: [],
      artifacts: [],
      open_questions: [],
      decisions: [],
      node_ids: [],
    };
    expect(parseSummaryResponse(JSON.stringify(reply)).meta.files).toEqual([]);
  });

  it('drops tree-sitter-owned span fields a model must not invent (§12)', () => {
    const reply = validReply();
    (reply.meta as { files: Record<string, unknown>[] }).files[0]!.degraded = true;
    expect(parseSummaryResponse(JSON.stringify(reply)).meta.files[0]).not.toHaveProperty('degraded');
  });
});

describe('golden render', () => {
  it('renders the leaf prompt byte-for-byte, so a prompt edit is a deliberate diff', () => {
    expect(leafSummaryPrompt(LEAF_FIXTURE)).toMatchInlineSnapshot(`
      "# Summarize one branch of a context tree

      You are given the raw detail of a single branch — one phase of an agent's work
      on a coding task: its prompts, replies, tool calls and file edits. Write the
      heading that will stand in for that detail from now on.

      A future agent will see your summary instead of the events. It decides what to
      pull back into context using nothing but what you write here. The prose says
      what happened; the metadata is what lets that agent detect relevance **without
      expanding this branch**. A file, symbol, test, ticket or open question you leave
      out is one the future agent cannot know to ask about — so the metadata is the
      part to get right, and empty is honest but silence is not.

      ## Output format

      Reply with a single JSON object and nothing else. No prose before or after it.

      \`\`\`json
      {
        "text": "2-6 sentences of prose: what this phase set out to do, what it actually did, and how it ended.",
        "meta": {
          "files": [{ "path": "src/a.ts", "start_line": 10, "end_line": 42, "symbol": "parseThing" }],
          "symbols": ["parseThing"],
          "tests": [{ "name": "parses a fenced block", "status": "passed", "detail": "optional" }],
          "artifacts": [{ "kind": "ticket", "ref": "SOF-123", "title": "optional" }],
          "open_questions": ["Anything left unresolved when this phase closed."],
          "decisions": ["A choice made here that later work must not silently reverse."],
          "node_ids": ["n_01J..."]
        }
      }
      \`\`\`

      Every field is required. Use \`[]\` for a field with nothing in it — never omit a
      field, never write \`null\`.

      - \`files\` — every file this phase touched. \`path\` repo-relative; \`start_line\`
        and \`end_line\` 1-based and inclusive; \`symbol\` the enclosing function, class
        or method when the detail names one, omitted when it does not. If the detail
        gives you a file with no usable line range, use the range of the edit shown.
      - \`symbols\` — the symbol names changed, deduplicated. Names only.
      - \`tests\` — every test or suite this phase ran. \`status\` must be exactly one of
        \`passed\`, \`failed\`, \`skipped\`, \`unknown\`; use \`unknown\` when the detail shows
        a test running but not its result. Never guess a pass.
      - \`artifacts\` — external references. \`kind\` must be exactly one of \`ticket\`,
        \`pr\`, \`url\`, \`other\`.
      - \`open_questions\` — what was still unanswered when this phase ended, phrased so
        it is answerable by someone who has not read this branch.
      - \`decisions\` — choices whose reversal would be a regression, with the reason
        where the detail gives one.
      - \`node_ids\` — the node ids covered by this branch, copied from NODE IDS below.

      Report only what the detail below supports. Do not infer a test result, a ticket
      number or a line range that is not there.

      ## Branch

      BRANCH TITLE: implement the blob store
      PHASE TYPE: implementation
      NODE IDS: n_01JAAAAAAAAAAAAAAAAAAAAAAA, n_01JBBBBBBBBBBBBBBBBBBBBBBB

      RAW DETAIL:
      Edit src/blobs/store.ts: added putBlob() and getBlob().
      Ran 3 tests, all passed.
      "
    `);
  });
});
