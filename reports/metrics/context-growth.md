> Markdown equivalent of [context-growth.html](./context-growth.html). The HTML version is the canonical rendering; this file exists so the report is readable and diffable in git.

# Context size per turn in long conversations

Context-tree evaluation program · supplementary note to the loop-8 interim report · September 1, 2026

> *Status.* This is an interim supplementary note, not a new experiment. It plots data already on disk from the runs described in the loop-8 interim report [1], because a reader asked to see context size against turn with both arms on one chart. Loop-8's conclusions are unchanged by it; one of them is sharpened.

## Abstract

An agent's prompt normally carries the transcript of everything the agent has done, so the prompt grows with the length of the conversation and eventually exceeds the model's context window. Context-tree is a context-management layer that reorganizes that linear conversation into a summary-headed tree: the full history is written to disk, the work is segmented into branches, and the prompt carries a short summary per completed branch instead of the raw events, together with tools the agent calls to fetch any detail back on demand. This note plots context size per turn for context-tree and for the ordinary transcript on the same axes, in the two regimes we have data for. Above context-tree's size threshold, measured offline on a deterministic 200-branch task, the transcript grows by 284 tokens per branch and crosses a 16,384-token window at branch 57 and a 32,768-token window at branch 115, while the tree prompt is constant at 9,062 tokens from branch 70 through branch 200. Below the threshold, measured live on two 60 kB software tasks, the result runs the other way: the tree carries roughly twice the baseline's context per turn — final-turn medians of 39,201 tokens against 19,157 on sw-5-dozen and 36,601 against 20,191 on sw-6-ripple — because the threshold never fired, so the tree showed the whole trace and paid for its own fixed contract on top. The threshold is currently estimated as characters divided by four, which under-counts code-dense text. Replacing that estimate with a real token count is the first item of loop 9; these charts are its motivating evidence, and we expect the live curves to bend flat once it lands.

## 1. Terms, and where the data comes from

A **turn** is one model call inside a run: the harness sends a prompt, the model answers, any tool results come back, and the next turn begins. **Context size per turn** is the number of tokens the model saw on that call — fresh input tokens plus cache-read tokens plus cache-write tokens, as the provider reports them for that request. We add the three because they partition one thing: cached or not, every token in those three counts was in the prompt the model read. Output tokens are excluded; they are not context. Both quantities are provider-independent in the sense that matters here — tokens and turns, never dollars.

We compare two **arms**, holding the model and the task fixed. The **native transcript** baseline (`native` in the harness) is what agent harnesses do by default: the prompt contains the whole conversation, re-sent every turn, with the provider's prompt cache making the repetition cheap but not free. **Context-tree** (`context-tree`) is the candidate described in the abstract.

Two of context-tree's terms appear below. A **branch** is its unit of organization: a contiguous stretch of work on one sub-problem, which gets a summary once it completes; a **fold** is the loop-8 change that keeps the list of those summaries from growing without limit, by giving individual headlines only to the 40 most recent branches and representing everything older with one line that says what was removed and how to retrieve it. Both are derived in [1]. **Devolved mode** is the third term and it governs §3: below a size threshold context-tree shows the whole trace rather than summaries, on the argument that summarizing a short conversation costs money for nothing. In that mode the tree's machinery — segmentation, summarization, folding — is dormant, and the prompt is the raw trace plus the tree's fixed contract, meaning its system prompt and the schemas of its four retrieval tools. Every live run in §3 ran in devolved mode from its first turn to its last.

None of these curves required a new run. Every evaluation run already persists a per-turn record — `turns: TurnRecord[]` in the run's `results.json`, declared at `eval/src/types.ts:52`, carrying the usage split for each model call — so the series in Figures 2 and 3 is reconstructable for any run we still have on disk, including runs from earlier loops. Langfuse mirrors the same numbers remotely, one generation per model call, and is convenient for browsing, but the local files are the authoritative and provider-independent source and are what we read here. Going forward every experiment records this series, and every checkpoint report carries these charts (user directive, 1 September 2026).

## 2. Above the threshold: the marathon

Figure 1 is the regime the architecture was built for. It comes from the marathon harness [2], which replays 200 read–write–verify branches through the real storage and assembly pipeline with no language-model calls at all, and assembles both arms' prompts at every tenth branch. Token counts are the harness's `HeuristicTokenizer`. The run is bit-identical between invocations, which is why the transcript line is straight rather than noisy.

**Figure 1.** Context size against branch number on the 200-branch marathon task, both arms on the same axes. The vertical axis is tokens in the assembled prompt; the horizontal axis is the number of completed branches. The upper, brown line is the native transcript baseline, which grows by exactly 284 tokens per branch at every one of the twenty checkpoints. The lower, green line is context-tree: it rises while the root summary fills, folding first engages at branch 41, and from branch 70 through branch 200 the prompt is constant at 9,062 tokens. The two dashed lines are the context windows of two real models; the two ringed points on the transcript line are where it crosses them. This is an offline simulation — no model was called, the token counts are heuristic, and the branches are synthetic work units of uniform size.

**Figure 1 data** (rendered as a table in this markdown equivalent):

| Completed branches | Native transcript (tokens) | Context-tree (tokens) |
|---|---|---|
| 10 | 2,974 | 2,887 |
| 20 | 5,814 | 4,517 |
| 30 | 8,654 | 6,147 |
| 40 | 11,494 | 7,778 |
| 50 | 14,334 | 8,975 |
| 60 | 17,174 | 9,092 |
| 70 | 20,014 | 9,062 |
| 80 | 22,854 | 9,062 |
| 90 | 25,694 | 9,062 |
| 100 | 28,534 | 9,062 |
| 110 | 31,374 | 9,062 |
| 120 | 34,214 | 9,062 |
| 130 | 37,054 | 9,062 |
| 140 | 39,894 | 9,062 |
| 150 | 42,734 | 9,062 |
| 160 | 45,574 | 9,062 |
| 170 | 48,414 | 9,062 |
| 180 | 51,254 | 9,062 |
| 190 | 54,094 | 9,062 |
| 200 | 56,934 | 9,062 |

Threshold crossings on the native transcript line, interpolated linearly between checkpoints:

| Branch | Event |
|---|---|
| 57 | exceeds the 16,384-token window of the gpt-3.5-turbo class |
| 115 | exceeds the 32,768-token window of the qwen-2.5-72b class |

The transcript crosses a 16,384-token window (the gpt-3.5-turbo class) at branch 57 and a 32,768-token window (the qwen-2.5-72b class) at branch 115, interpolating linearly between checkpoints. The loop-8 report quotes 56 and 113 for the same two crossings; the difference comes from the intercept of the fit, is under two branches, and does not affect any conclusion — but the numbers plotted here are the ones this series supports. Context-tree does not cross either line at any horizon the harness reaches.

What Figure 1 is not is a chat. The live confirmation of the same claim is in [1]: at branch 200 one real request per arm was made against a 32,768-token model, and the 42,690-token transcript prompt was rejected with `context_length_exceeded` while the 9,062-token tree prompt was answered.

## 3. Below the threshold: two live tasks

Figures 2 and 3 are the regime our live tasks actually occupy, and they do not favour the candidate. The two scenarios are the long tasks built for loop 8: **sw-5-dozen**, twelve independently buggy modules, and **sw-6-ripple**, an interface migration touching ten dependent files. Each carries about 60 kB of material and a hidden test suite. Both arms ran claude-sonnet-5 with three replicates each, in one batch, so the two arms saw the same code, the same prompts, and the same epoch [3]. All twelve runs completed and scored 100%.

**Figure 2.** Context size per turn on sw-5-dozen (twelve independently buggy modules, ~60 kB of material), all six live runs on the same axes. The vertical axis is the tokens the model saw on that call — fresh input plus cache reads plus cache writes. The horizontal axis is the turn index within the run; a line ends where its run finished, which is why the lines have different lengths. Three lines per arm, one per replicate: brown is the native transcript baseline, green is context-tree. Both arms solved the task in every replicate. The tree starts 2,442 tokens above the baseline on turn 1 and is the smaller of the two through about turn 5; from turn 7 to the end it is clearly larger, ending at a median of 39,201 tokens against the baseline's 19,157.

**Figure 2 data** (rendered as a table in this markdown equivalent; blank cells are turns after that run had finished):

| Turn | native r1 | native r2 | native r3 | tree r1 | tree r2 | tree r3 |
|---|---|---|---|---|---|---|
| 1 | 1,571 | 1,571 | 1,571 | 4,013 | 4,013 | 4,013 |
| 2 | 1,682 | 1,941 | 1,941 | 4,173 | 4,443 | 4,193 |
| 3 | 2,052 | 9,188 | 9,188 | 4,314 | 4,584 | 4,373 |
| 4 | 9,299 | 9,421 | 9,301 | 5,502 | 4,939 | 4,988 |
| 5 | 9,940 | 9,534 | 9,410 | 5,996 | 6,205 | 5,263 |
| 6 | 10,143 | 11,938 | 9,545 | 13,544 | 21,140 | 6,285 |
| 7 | 10,256 | 11,975 | 9,880 | 14,206 | 37,569 | 13,173 |
| 8 | 10,325 | 16,796 | 16,996 | 21,604 | 37,856 | 13,940 |
| 9 | 10,418 | 16,875 | 17,109 | 37,987 | 37,958 | 20,537 |
| 10 | 10,487 | 16,916 | 17,244 | 38,230 |  | 24,412 |
| 11 | 10,534 | 21,275 |  | 38,509 |  | 40,897 |
| 12 | 10,650 | 21,390 |  | 39,201 |  | 41,065 |
| 13 | 10,719 | 21,617 |  |  |  | 41,356 |
| 14 | 10,987 |  |  |  |  | 41,602 |
| 15 | 18,126 |  |  |  |  | 41,866 |
| 16 | 18,767 |  |  |  |  | 41,846 |
| 17 | 18,880 |  |  |  |  |  |
| 18 | 18,949 |  |  |  |  |  |
| 19 | 19,157 |  |  |  |  |  |

Final turn per run: native r1 19,157 at turn 19; native r2 21,617 at turn 13; native r3 17,244 at turn 10; tree r1 39,201 at turn 12; tree r2 37,958 at turn 9; tree r3 41,846 at turn 16.

**Figure 3.** Context size per turn on sw-6-ripple (an interface migration touching ten dependent files, ~60 kB of material), all six live runs on the same axes, plotted on the same scales as Figure 2. Axes, colours and replicate structure are as in Figure 2: brown is the native transcript baseline, green is context-tree, three replicates each, lines ending where their runs did. Final-turn median 36,601 tokens for the tree against 20,191 for the baseline.

**Figure 3 data** (rendered as a table in this markdown equivalent; blank cells are turns after that run had finished):

| Turn | native r1 | native r2 | native r3 | tree r1 | tree r2 | tree r3 |
|---|---|---|---|---|---|---|
| 1 | 1,550 | 1,550 | 1,550 | 3,992 | 3,992 | 3,992 |
| 2 | 2,307 | 6,942 | 1,619 | 4,658 | 4,460 | 4,721 |
| 3 | 4,961 | 7,011 | 2,302 | 4,878 | 9,613 | 5,555 |
| 4 | 17,646 | 7,052 | 4,956 | 5,709 | 10,826 | 11,110 |
| 5 | 17,701 | 7,795 | 17,571 | 11,264 | 16,381 | 21,423 |
| 6 | 17,770 | 17,705 | 17,616 | 17,021 | 26,694 | 22,712 |
| 7 | 17,954 | 17,755 | 17,685 | 22,336 | 27,993 | 35,791 |
| 8 | 18,011 | 18,876 | 17,867 | 23,650 | 29,238 | 36,061 |
| 9 | 18,131 | 19,069 | 18,988 | 24,884 | 37,573 | 36,393 |
| 10 | 18,873 | 19,252 | 19,186 | 33,664 | 37,604 |  |
| 11 | 18,900 |  | 20,050 | 33,906 | 37,650 |  |
| 12 | 18,969 |  | 20,191 | 36,522 | 37,648 |  |
| 13 | 19,944 |  |  | 36,512 |  |  |
| 14 | 20,048 |  |  | 36,575 |  |  |
| 15 | 20,117 |  |  | 36,601 |  |  |
| 16 | 20,186 |  |  |  |  |  |
| 17 | 21,368 |  |  |  |  |  |
| 18 | 21,411 |  |  |  |  |  |
| 19 | 21,567 |  |  |  |  |  |
| 20 | 21,678 |  |  |  |  |  |

Final turn per run: native r1 21,678 at turn 20; native r2 19,252 at turn 10; native r3 20,191 at turn 12; tree r1 36,601 at turn 15; tree r2 37,648 at turn 12; tree r3 36,393 at turn 9.

The reading is plain. In this regime context-tree carries more context per turn than the baseline it is supposed to improve on. Final-turn medians are 39,201 tokens against 19,157 on sw-5, a factor of 2.0, and 36,601 against 20,191 on sw-6, a factor of 1.8. The peaks tell the same story: the tree reaches 41,866 tokens on sw-5 and 37,650 on sw-6, where the baseline never exceeds 21,617 and 21,678. The first turn is exactly 2,442 tokens more expensive under the tree in both scenarios — that number is the tree's fixed contract, paid before any work is done, and it is identical across the two tasks because it does not depend on the task. For the first five or six turns the two arms interleave, with the tree often the smaller; from about turn 7 the tree is above the baseline in every replicate and stays there.

The cause is the one loop 8 identified and did not yet fix. The lazy threshold that would have switched the tree out of devolved mode never fired, because it estimates trace size as characters divided by four and the real tokenizer charges more than that for code-dense text. So on these tasks the tree never summarized anything: it showed the entire trace, in its own richer event rendering, and added its fixed contract on top. The summary-headed tree that Figure 1 measures was, in these runs, dormant machinery being paid for and not used.

One control rules out the other candidate explanation. Loop 8 also fixed a cache-churn defect, and the tree arm was re-run on the same two scenarios afterwards (the v6.4 batch [3]); final-turn context in those six runs lands between 32,870 and 39,208 tokens, the same band as Figures 2 and 3. That fix changed how often the prefix was re-written to the provider's cache, not how large the prompt was.

Turn counts do not offset the difference, and they do not aggravate it either. On sw-6 the tree finished in 15, 12 and 9 turns against the baseline's 20, 10 and 12; on sw-5 in 12, 9 and 16 against 19, 13 and 10. The medians are 12 against 12 on sw-6 and 12 against 13 on sw-5. So the tree is not buying its larger prompts with extra turns — it simply has larger prompts.

These two figures are the motivating evidence for the first item of loop 9: measure the threshold with the real tokenizer, so that the switch out of devolved mode happens exactly when the trace would otherwise overflow its zone. When it lands, we expect these curves to stop climbing at the crossing point and run flat, in the manner of Figure 1's green line, and we will re-chart both scenarios to check that they do.

## 4. Open items and recommendations

1. **Replace the characters÷4 lazy gate with a real token count, then re-run and re-chart sw-5 and sw-6.** This is the change Figures 2 and 3 argue for. The success criterion is visible on the chart: the tree's curve flattens at the crossing instead of tracking the trace, and its final-turn context falls below the baseline's on at least one of the two scenarios. Until it lands, no live run has ever crossed into summarized operation, so the flat line in Figure 1 remains established offline by construction only.
2. **Record the same per-turn series for every arm of the loop-9 transplant harness, plain compaction included.** In flight. Compaction is the honest competitor to context-tree in the below-threshold regime — it is what production harnesses actually do — and it belongs on these axes rather than being argued about.
3. **Make these charts a standing section of every checkpoint report.** The data has always been in `results.json`; the omission was in the reporting, not the instrumentation. Per-turn context against turn, both arms, one pair of axes, in every checkpoint from here on.

## References

[1] *Making an agent's prompt size independent of conversation length* — the loop-8 interim report. https://claude.ai/code/artifact/d6875957-086a-4408-9de5-798b31aba6e6 — folding and the list cap (decisions D17 and D18), the marathon harness, the live context-window probe, the recall probe, and the cache-churn fix.

[2] `eval/scripts/marathon.mjs` in the context-tree repository — the deterministic 200-branch harness that produced Figure 1: no language-model calls, `HeuristicTokenizer` for token counts, a checkpoint every ten branches.

[3] The `long-v6x` results batch (Figures 2 and 3: two scenarios × two arms × three replicates, claude-sonnet-5, one epoch) and the `long-v64` batch (tree arm only, after the cache fix), read from each run's `results.json` via `turns: TurnRecord[]`.

---

Supplementary note to loop 8 · Figure 1 from `eval/scripts/marathon.mjs`, offline and deterministic · Figures 2 and 3 from the `long-v6x` live batch, claude-sonnet-5, three replicates per cell, same epoch · September 1, 2026.
