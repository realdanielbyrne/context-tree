/**
 * Shared 20-question set + deterministic grader for the rung-2 retriever probes.
 * One source of truth so retriever-isolation-live.mjs and knn-embedder-coverage.mjs
 * cannot drift. Corpus = packages/<pkg>/src; each question has a verified
 * ground-truth file and an authored answer regex (matched with flags i,s).
 */
export const QUESTIONS = [
  { id: 'st1', stratum: 'structural', q: 'What functions call excerptAround?', file: 'packages/core/src/retrieve/retriever.ts', answer: ['retriever\\.ts', 'findRelevantCenter', 'searchEvents'] },
  { id: 'st2', stratum: 'structural', q: 'Which file parses edited blobs into minimal enclosing named spans using tree-sitter grammars?', file: 'packages/core/src/spans/extractor.ts', answer: ['extractor\\.ts', 'spans/extractor'] },
  { id: 'st3', stratum: 'structural', q: 'Where is the lexical index built and which function consumes it during search?', file: 'packages/core/src/retrieve/retriever.ts', answer: ['retriever\\.ts', 'buildLexicalIndex', 'lexicalScore'] },
  { id: 'st4', stratum: 'structural', q: 'How does the MCP context_search tool connect to the retriever and providers?', file: 'packages/mcp/src/tools/context-search.ts', answer: ['context-search', 'context_search'] },
  { id: 'li1', stratum: 'literal', q: 'What is the value of the constant RRF_K?', file: 'packages/core/src/retrieve/retriever.ts', answer: ['\\b60\\b'] },
  { id: 'li2', stratum: 'literal', q: 'What is the default excerptChars in the retrieval config?', file: 'packages/core/src/config.ts', answer: ['\\b1[_,]?000\\b'] },
  { id: 'li3', stratum: 'literal', q: 'What DEFAULT_TIMEOUT_MS does the graft provider use?', file: 'packages/core/src/providers/graft.ts', answer: ['\\b20[_,]?000\\b'] },
  { id: 'li4', stratum: 'literal', q: 'What are the default retrieval provider names in the config?', file: 'packages/core/src/config.ts', answer: ['(?=.*graft)(?=.*vector)(?=.*grep)'] },
  { id: 'fz1', stratum: 'fuzzy', q: 'excrptAround', file: 'packages/core/src/retrieve/excerpt.ts', answer: ['excerpt\\.ts', 'excerptAround'] },
  { id: 'fz2', stratum: 'fuzzy', q: 'detctAttentionSignals', file: 'packages/core/src/attention/signals.ts', answer: ['signals\\.ts', 'detectAttentionSignals'] },
  { id: 'fz3', stratum: 'fuzzy', q: 'TreeSiterSpanExtractor', file: 'packages/core/src/spans/extractor.ts', answer: ['extractor\\.ts', 'SpanExtractor'] },
  { id: 'fz4', stratum: 'fuzzy', q: 'buildTopicIndx', file: 'packages/core/src/attention/topic-index.ts', answer: ['topic-index\\.ts', 'buildTopicIndex'] },
  { id: 'h1', stratum: 'semantic', q: 'When someone rewrites an early message, which part works out how much of the previously sent conversation the model host can still reuse without being billed to read it again?', file: 'packages/core/src/cache/prefix.ts', answer: ['prefix\\.ts', 'cache/prefix'] },
  { id: 'h2', stratum: 'semantic', q: 'What imitates the way a language-model host charges for input so a test can prove that a small change to the prompt did not needlessly force the whole thing to be re-read and re-paid?', file: 'packages/core/src/cache/simulator.ts', answer: ['simulator\\.ts', 'cache/simulator'] },
  { id: 'h3', stratum: 'semantic', q: 'Which piece ranks older parts of the dialogue by how likely they still matter and sets aside the ones that no longer bear on the work at hand?', file: 'packages/core/src/attention/policy.ts', answer: ['policy\\.ts', 'attention/policy', 'selectAttention'] },
  { id: 'h4', stratum: 'semantic', q: 'Where is the running record of actions split into stages so that each stage can later be condensed on its own?', file: 'packages/core/src/segment/segment.ts', answer: ['segment\\.ts', 'segment/segment'] },
  { id: 'h5', stratum: 'semantic', q: 'How does the tool judge which earlier passage best answers a request using only word counts, for the case where numeric meaning vectors are not available?', file: 'packages/core/src/retrieve/lexical.ts', answer: ['lexical\\.ts', 'lexicalScore'] },
  { id: 'h6', stratum: 'semantic', q: 'Which part builds the final block of text handed to the model out of a frozen header, short overviews of past work, and the detail of whatever is being worked on now?', file: 'packages/core/src/assemble/assembler.ts', answer: ['assembler\\.ts', 'ZoneAssembler'] },
  { id: 'h7', stratum: 'semantic', q: 'Where are hits from several different lookup helpers combined into one ordered list, taking care that a confident answer from one helper is not buried by noise from the others?', file: 'packages/core/src/providers/merge.ts', answer: ['merge\\.ts', 'providers/merge'] },
  { id: 'h8', stratum: 'semantic', q: 'Which piece judges whether a past step could simply be run again to reproduce its output, so that output need not be carried along?', file: 'packages/core/src/attention/rederive.ts', answer: ['rederive\\.ts', 'isRederivable'] },
];

export function gradeLive(text, answer) {
  const t = text || '';
  for (const rx of answer) { try { if (new RegExp(rx, 'is').test(t)) return true; } catch {} }
  return false;
}
