> Markdown equivalent of [context-growth.html](./context-growth.html). The HTML version is the canonical rendering; this file exists so the report is readable and diffable in git.

# Context size per turn in long conversations

Context-tree evaluation program · supplementary note to the loop-8 interim report · September 1, 2026, revised September 2, 2026

> *Status.* Sections 1–3 are the original interim note of 1 September 2026: not a new experiment, but a plot of data already on disk from the runs described in the loop-8 interim report [1], because a reader asked to see context size against turn with both arms on one chart. Loop-8's conclusions are unchanged by it; one of them is sharpened. Section 4, added 2 September 2026, reports a new experiment — the six live runs of the loop-9 real-token lazy gate, which §3 argued for and §5 item 1 specified.

## Abstract

An agent's prompt normally carries the transcript of everything the agent has done, so the prompt grows with the length of the conversation and eventually exceeds the model's context window. Context-tree is a context-management layer that reorganizes that linear conversation into a summary-headed tree: the full history is written to disk, the work is segmented into branches, and the prompt carries a short summary per completed branch instead of the raw events, together with tools the agent calls to fetch any detail back on demand. This note plots context size per turn for context-tree and for the ordinary transcript on the same axes, in the two regimes we have data for. Above context-tree's size threshold, measured offline on a deterministic 200-branch task, the transcript grows by 284 tokens per branch and crosses a 16,384-token window at branch 57 and a 32,768-token window at branch 115, while the tree prompt is constant at 9,062 tokens from branch 70 through branch 200. Below the threshold, measured live on two 60 kB software tasks, the result runs the other way: the tree carries roughly twice the baseline's context per turn — final-turn medians of 39,201 tokens against 19,157 on sw-5-dozen and 36,601 against 20,191 on sw-6-ripple — because the threshold never fired, so the tree showed the whole trace and paid for its own fixed contract on top. The threshold was estimated as characters divided by four, which under-counts code-dense text. Section 4 reports what happened when that estimate was replaced by the provider's own token count of the previous turn. The gate now fires on every run, once, at the ninth to sixteenth call, and the curve behind it flattens: per-turn growth falls from 2,046–4,928 tokens per turn before the crossing to 256–915 after it, below the baseline's own 812–2,094. Final-turn context falls by 35–39% against the loop-8 tree, to medians of 24,299 tokens on sw-5-dozen and 22,837 on sw-6-ripple, but it does not fall below the baseline's 19,157 and 20,191, so half of the published criterion is met and half is not. Total tokens rise rather than fall, by 48% and 77% over the baseline, because the gate reads the previous completed turn and a single batched turn overshoots the 30,000-token budget by 6,657–15,564 tokens, and because the transition itself costs turns. The larger finding is that the criterion was wrong: on a 200,000-token window the largest prompt any of these runs assembled is 45,564 tokens, so a budget derived from the window rather than fixed at a constant would never have crossed at all, and the tree would have stayed devolved — correctly. The mechanism is validated; the criterion is the finding.

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

These two figures are the motivating evidence for the first item of loop 9: measure the threshold with the real tokenizer, so that the switch out of devolved mode happens exactly when the trace would otherwise overflow its zone. When it lands, we expect these curves to stop climbing at the crossing point and run flat, in the manner of Figure 1's green line, and we will re-chart both scenarios to check that they do. Section 4 is that re-chart. The expectation about the shape of the curve was right; the expectation that it would settle below the baseline was not.

## 4. The real-token gate: what happened when it landed

The change §3 asked for landed on 2 September 2026 [4]. The **lazy gate** is the name of the switch that takes context-tree out of devolved mode: the environment variable `EVAL_LAZY_TOKENS` names a token budget, 30,000 for every run here, and while the raw trace fits inside that budget the tree stays devolved. The old comparison was `traceChars / 4 < 30000`. The new one is the provider's own count of the prompt it last billed — `usage.input + usage.cacheRead + usage.cacheWrite` from the previous completed turn, the same three numbers Figures 2 and 3 plot, which every turn already returns at no extra cost. There is no estimate left in the comparison, and no tokenizer to keep in step with whichever model is running.

*Methods note: the gate has to latch.* The first live replicate with the real-token gate crossed on its ninth call with a 40,158-token prompt, summarized, and on the next call read a prompt below 30,000 — because Zone C then held only the active branch. The gate took that as "the trace fits", re-expanded the whole trace, and crossed a second time two calls later at 43,331 tokens; that run finished in 12 turns and 223,917 tokens [5]. The condition is ill-posed rather than merely noisy. It asks whether the whole trace fits the budget, but after the crossing the prompt no longer contains the whole trace, so the prompt's size is no longer evidence either way, while the trace itself only grows and can never fit again. The crossing is therefore one-way, and the flag that records it latches. A character count could never have exposed this, because a character count only increases. That batch was discarded; everything below is the relaunched, latched batch.

That batch is the context-tree arm only — three replicates on each of sw-5-dozen and sw-6-ripple, claude-sonnet-5, one epoch, on loop-8's standing v6.x flags plus `EVAL_ROOT_KEEP=40` and the latched real-token gate [4]. The native arm never reads this gate, so the `long-v6x` native rows remain a same-code-path baseline; they and the `long-v64` tree rows were run on 1 September 2026, a day before the gate runs, and that date gap is the one asymmetry in the comparison. All six new runs completed and scored 100%, as did all twelve baseline runs.

**Figure 4.** Context size per turn on sw-5-dozen, three arms on one pair of axes. Vertical axis: tokens the model saw on that call, fresh input plus cache reads plus cache writes. Horizontal axis: turn index within the run, counting the first model call as turn 1. Three replicates per arm are drawn as thin lines and the across-replicate median as the heavy line; the median is drawn only while at least two replicates are still running, because a "median" of one run is just that run. Brown is the native transcript baseline (`long-v6x`, 1 September); green is context-tree with the loop-8 characters÷4 gate (`long-v64`, 1 September); blue is context-tree with the real-token gate (`long-v65-gate`, 2 September). The three ringed blue points are the gate crossings, one per replicate, at turns 7, 10 and 10. Each crossing is a spike — the prompt that tripped the gate — after which the blue curve drops and stays roughly level, while the green curve, whose gate never fired, keeps climbing to the end of its runs.

**Figure 4 data** (rendered as a table in this markdown equivalent; blank cells are turns after that run had finished):

| Turn | native r1 | native r2 | native r3 | loop-8 r1 | loop-8 r2 | loop-8 r3 | real-token r1 | real-token r2 | real-token r3 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 1,571 | 1,571 | 1,571 | 4,013 | 4,013 | 4,013 | 4,013 | 4,013 | 4,013 |
| 2 | 1,682 | 1,941 | 1,941 | 4,162 | 4,193 | 4,178 | 4,493 | 4,206 | 4,245 |
| 3 | 2,052 | 9,188 | 9,188 | 5,011 | 4,467 | 4,306 | 4,647 | 4,682 | 4,619 |
| 4 | 9,299 | 9,421 | 9,301 | 5,505 | 4,608 | 4,550 | 4,788 | 5,106 | 4,760 |
| 5 | 9,940 | 9,534 | 9,410 | 20,440 | 4,769 | 4,970 | 5,636 | 12,771 | 5,941 |
| 6 | 10,143 | 11,938 | 9,545 | 36,973 | 5,617 | 19,905 | 6,129 | 20,188 | 6,434 |
| 7 | 10,256 | 11,975 | 9,880 | 37,243 | 6,110 | 36,197 | 21,064 | 36,657 | 13,255 |
| 8 | 10,325 | 16,796 | 16,996 | 37,519 | 21,045 | 36,430 | 28,687 | 22,151 | 20,895 |
| 9 | 10,418 | 16,875 | 17,109 | 37,585 | 37,485 | 36,496 | 28,936 | 22,358 | 22,245 |
| 10 | 10,487 | 16,916 | 17,244 |  | 37,752 |  | 45,564 | 23,356 | 38,799 |
| 11 | 10,534 | 21,275 |  |  | 38,031 |  | 30,916 |  | 22,016 |
| 12 | 10,650 | 21,390 |  |  | 38,097 |  | 32,224 |  | 22,208 |
| 13 | 10,719 | 21,617 |  |  |  |  | 32,566 |  | 22,659 |
| 14 | 10,987 |  |  |  |  |  |  |  | 22,901 |
| 15 | 18,126 |  |  |  |  |  |  |  | 23,183 |
| 16 | 18,767 |  |  |  |  |  |  |  | 24,299 |
| 17 | 18,880 |  |  |  |  |  |  |  |  |
| 18 | 18,949 |  |  |  |  |  |  |  |  |
| 19 | 19,157 |  |  |  |  |  |  |  |  |

Final turn per run: native r1 19,157 at turn 19; native r2 21,617 at turn 13; native r3 17,244 at turn 10; loop-8 r1 37,585 at turn 9; loop-8 r2 38,097 at turn 12; loop-8 r3 36,496 at turn 9; real-token r1 32,566 at turn 13; real-token r2 23,356 at turn 10; real-token r3 24,299 at turn 16.

The heavy median lines of Figure 4, drawn while at least two replicates are still running:

| Turn | native | loop-8 | real-token |
|---|---|---|---|
| 1 | 1,571 | 4,013 | 4,013 |
| 2 | 1,941 | 4,178 | 4,245 |
| 3 | 9,188 | 4,467 | 4,647 |
| 4 | 9,301 | 4,608 | 4,788 |
| 5 | 9,534 | 4,970 | 5,941 |
| 6 | 10,143 | 19,905 | 6,434 |
| 7 | 10,256 | 36,197 | 21,064 |
| 8 | 16,796 | 36,430 | 22,151 |
| 9 | 16,875 | 37,485 | 22,358 |
| 10 | 16,916 |  | 38,799 |
| 11 | 15,905 |  | 26,466 |
| 12 | 16,020 |  | 27,216 |
| 13 | 16,168 |  | 27,613 |

**Figure 5.** Context size per turn on sw-6-ripple, three arms on one pair of axes. Axes, colours, replicate structure and median rule are as in Figure 4; the horizontal axis runs to 33 turns rather than 20 because one real-token replicate took that long, so the scales are not shared with Figure 4. Ringed blue points mark the gate crossings at turns 11, 14 and 16. The long blue replicate is the one discussed below: after its crossing its per-turn context oscillates between 8,357 and 25,471 tokens for another seventeen calls.

**Figure 5 data** (rendered as a table in this markdown equivalent; blank cells are turns after that run had finished):

| Turn | native r1 | native r2 | native r3 | loop-8 r1 | loop-8 r2 | loop-8 r3 | real-token r1 | real-token r2 | real-token r3 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 1,550 | 1,550 | 1,550 | 3,992 | 3,992 | 3,992 | 3,992 | 3,992 | 3,992 |
| 2 | 2,307 | 6,942 | 1,619 | 4,172 | 8,850 | 4,168 | 4,224 | 4,262 | 4,484 |
| 3 | 4,961 | 7,011 | 2,302 | 4,954 | 8,991 | 5,001 | 4,718 | 4,585 | 4,660 |
| 4 | 17,646 | 7,052 | 4,956 | 6,004 | 9,211 | 5,493 | 6,549 | 5,422 | 5,494 |
| 5 | 17,701 | 7,795 | 17,571 | 8,956 | 9,567 | 11,048 | 6,706 | 8,378 | 8,266 |
| 6 | 17,770 | 17,705 | 17,616 | 17,620 | 10,520 | 12,309 | 6,988 | 17,046 | 11,996 |
| 7 | 17,954 | 17,755 | 17,685 | 22,954 | 13,292 | 13,543 | 7,823 | 22,274 | 17,850 |
| 8 | 18,011 | 18,876 | 17,867 | 24,167 | 21,946 | 23,878 | 13,378 | 23,881 | 22,166 |
| 9 | 18,131 | 19,069 | 18,988 | 25,731 | 22,602 | 36,977 | 14,578 | 25,265 | 23,488 |
| 10 | 18,873 | 19,252 | 19,186 | 38,810 | 23,884 | 37,252 | 20,282 | 25,672 | 24,733 |
| 11 | 18,900 |  | 20,050 | 39,087 | 25,891 | 37,493 | 21,710 | 25,934 | 37,812 |
| 12 | 18,969 |  | 20,191 | 39,208 | 31,187 | 37,615 | 22,850 | 27,401 | 21,680 |
| 13 | 19,944 |  |  |  | 32,307 |  | 28,187 | 28,610 | 21,957 |
| 14 | 20,048 |  |  |  | 32,542 |  | 41,286 | 28,965 | 22,837 |
| 15 | 20,117 |  |  |  | 32,870 |  | 20,716 | 29,878 |  |
| 16 | 20,186 |  |  |  |  |  | 20,886 | 30,126 |  |
| 17 | 21,368 |  |  |  |  |  | 21,061 | 9,310 |  |
| 18 | 21,411 |  |  |  |  |  | 21,511 | 13,667 |  |
| 19 | 21,567 |  |  |  |  |  |  | 19,430 |  |
| 20 | 21,678 |  |  |  |  |  |  | 8,357 |  |
| 21 |  |  |  |  |  |  |  | 10,044 |  |
| 22 |  |  |  |  |  |  |  | 11,310 |  |
| 23 |  |  |  |  |  |  |  | 18,579 |  |
| 24 |  |  |  |  |  |  |  | 20,412 |  |
| 25 |  |  |  |  |  |  |  | 20,607 |  |
| 26 |  |  |  |  |  |  |  | 21,262 |  |
| 27 |  |  |  |  |  |  |  | 24,162 |  |
| 28 |  |  |  |  |  |  |  | 24,424 |  |
| 29 |  |  |  |  |  |  |  | 25,471 |  |
| 30 |  |  |  |  |  |  |  | 21,983 |  |
| 31 |  |  |  |  |  |  |  | 22,244 |  |
| 32 |  |  |  |  |  |  |  | 22,893 |  |
| 33 |  |  |  |  |  |  |  | 23,155 |  |

Final turn per run: native r1 21,678 at turn 20; native r2 19,252 at turn 10; native r3 20,191 at turn 12; loop-8 r1 39,208 at turn 12; loop-8 r2 32,870 at turn 15; loop-8 r3 37,615 at turn 12; real-token r1 21,511 at turn 18; real-token r2 23,155 at turn 33; real-token r3 22,837 at turn 14.

The heavy median lines of Figure 5, drawn while at least two replicates are still running:

| Turn | native | loop-8 | real-token |
|---|---|---|---|
| 1 | 1,550 | 3,992 | 3,992 |
| 2 | 2,307 | 4,172 | 4,262 |
| 3 | 4,961 | 5,001 | 4,660 |
| 4 | 7,052 | 6,004 | 5,494 |
| 5 | 17,571 | 9,567 | 8,266 |
| 6 | 17,705 | 12,309 | 11,996 |
| 7 | 17,755 | 13,543 | 17,850 |
| 8 | 18,011 | 23,878 | 22,166 |
| 9 | 18,988 | 25,731 | 23,488 |
| 10 | 19,186 | 37,252 | 24,733 |
| 11 | 19,475 | 37,493 | 25,934 |
| 12 | 19,580 | 37,615 | 22,850 |
| 13 |  |  | 28,187 |
| 14 |  |  | 28,965 |
| 15 |  |  | 25,297 |
| 16 |  |  | 25,506 |
| 17 |  |  | 15,186 |
| 18 |  |  | 17,589 |

**Table 1.** Medians over three replicates per cell, claude-sonnet-5. **final ctx** is context size on the run's last turn; **peak ctx** the largest on any turn; **total tokens** the run's whole token bill, input plus output plus cache reads plus cache writes, so unlike the other context columns it includes output; **turns** the number of model calls; **success** the count of replicates that passed the hidden test suite. Each column is the median of that column, so a row is not necessarily any one run. The two baseline arms are from 1 September 2026, the real-token rows from 2 September.[^usd]

| Scenario / arm | final ctx | peak ctx | total tokens | turns | success |
|---|---|---|---|---|---|
| sw-5-dozen — native transcript | 19,157 | 19,157 | 175,661 | 13 | 3/3 |
| sw-5-dozen — tree, loop-8 gate | 37,585 | 37,585 | 192,853 | 9 | 3/3 |
| sw-5-dozen — tree, real-token gate | 24,299 | 38,799 | 260,700 | 13 | 3/3 |
| sw-6-ripple — native transcript | 20,191 | 20,191 | 168,208 | 12 | 3/3 |
| sw-6-ripple — tree, loop-8 gate | 37,615 | 37,615 | 244,964 | 12 | 3/3 |
| sw-6-ripple — tree, real-token gate | 22,837 | 37,812 | 297,726 | 18 | 3/3 |

The first half of the published criterion is met, and cleanly. The gate fired on every one of the six runs, exactly once, and behind each crossing the curve flattens. Table 2 gives the least-squares slope of context against turn, the same statistic `eval/scripts/ct-growth.mjs` reports, measured separately over the turns up to and including the crossing and over the turns after it. Before the crossing the tree grows at 2,046 to 4,928 tokens per turn; after it, at 256 to 915. For scale, the native baseline's own per-run slopes are 812 to 2,094 tokens per turn on these two scenarios, and the loop-8 tree's are 2,264 to 5,505. So after the crossing the tree is not merely flatter than it was — it grows more slowly than the transcript it is competing with. That is the behaviour Figure 1 predicts and no live run had previously shown.

**Table 2.** One row per real-token replicate. **crossing turn** counts the first model call as turn 1, the convention used by every chart in this note; **logged index** is the number the harness prints in `[eval] lazy gate crossed at turn N`, which is zero-based, so it is always one less. Both are given because the log is the artefact of record and the charts are not. **prompt at crossing** is the context size of the turn that tripped the gate and **over budget** its excess over the 30,000-token budget. **slope** is least squares on context against turn index, in tokens per turn, over turns 1 through the crossing and over the turns strictly after it.

| Run | crossing turn | logged index | prompt at crossing | over budget | slope before | slope after |
|---|---|---|---|---|---|---|
| sw-5-dozen r1 | 10 | 9 | 45,564 | +15,564 | 4,331 | 825 |
| sw-5-dozen r2 | 7 | 6 | 36,657 | +6,657 | 4,928 | 603 |
| sw-5-dozen r3 | 10 | 9 | 38,799 | +8,799 | 3,312 | 417 |
| sw-6-ripple r1 | 14 | 13 | 41,286 | +11,286 | 2,448 | 256 |
| sw-6-ripple r2 | 16 | 15 | 30,126 | +126 | 2,046 | 915 |
| sw-6-ripple r3 | 11 | 10 | 37,812 | +7,812 | 3,177 | 579 |

The second half of the criterion is not met, on either scenario. Final-turn context under the real-token gate is a median 24,299 tokens on sw-5-dozen and 22,837 on sw-6-ripple. Those are 35% and 39% below the loop-8 tree's 37,585 and 37,615, which is a large move in the right direction, but they are still 1.27 and 1.13 times the native baseline's 19,157 and 20,191. The criterion asked for the tree to end below the baseline on at least one scenario, and it ends above on both. Peak context barely moves — 38,799 and 37,812 against loop-8's 37,585 and 37,615 — but its meaning changes: under the loop-8 gate the peak was the last turn, because the curve was still rising when the run ended, and under the real-token gate the peak is the crossing spike in the middle.

**Figure 6.** Cumulative context tokens saved against the native baseline on sw-5-dozen. At each turn the series is the running sum, over all turns so far, of the baseline's median per-turn context minus the tree's; the zero line is therefore the native transcript, and a series below zero means the tree has processed more context than the baseline up to that point. The sign is negative for most of both runs and at the end of both: the loop-8 gate closes 18,014 tokens behind the baseline and the real-token gate 79,226 behind. Both series rise above zero for a few early turns, where the tree's compact opening beats the transcript, and turn down for good once the trace is large. Each arm's cumulative curve is the median across its three replicates, and a replicate that has finished contributes no further tokens, which is why both series level off on the right.

**Figure 6 data** (rendered as a table in this markdown equivalent; two series, both cumulative and both signed against native as zero):

| Turn | loop-8 | real-token |
|---|---|---|
| 1 | -2,442 | -2,442 |
| 2 | -4,679 | -4,746 |
| 3 | 27 | -201 |
| 4 | 4,720 | 4,060 |
| 5 | 9,361 | 7,833 |
| 6 | -966 | 10,944 |
| 7 | -27,283 | 66 |
| 8 | -46,717 | -11,625 |
| 9 | -66,104 | -23,452 |
| 10 | -48,860 | -51,772 |
| 11 | -65,905 | -53,303 |
| 12 | -86,266 | -67,245 |
| 13 | -80,375 | -84,013 |
| 14 | -69,388 | -95,927 |
| 15 | -51,262 | -100,984 |
| 16 | -32,495 | -93,707 |
| 17 | -18,014 | -79,226 |
| 18 | -18,014 | -79,226 |
| 19 | -18,014 | -79,226 |

**Figure 7.** Cumulative context tokens saved against the native baseline on sw-6-ripple, constructed exactly as Figure 6 and on the same vertical scale. The horizontal axis runs to 33 turns. Final values: 76,074 tokens behind the baseline under the loop-8 gate, 127,864 behind under the real-token gate. The real-token series is the worse of the two here despite its smaller final-turn prompts, because the extra turns it takes are each paid for.

**Figure 7 data** (rendered as a table in this markdown equivalent; two series, both cumulative and both signed against native as zero):

| Turn | loop-8 | real-token |
|---|---|---|
| 1 | -2,442 | -2,442 |
| 2 | -4,307 | -4,397 |
| 3 | -4,343 | -4,116 |
| 4 | 3,433 | 3,925 |
| 5 | 648 | 3,711 |
| 6 | 2,357 | 9,163 |
| 7 | 1,387 | 9,068 |
| 8 | -1,683 | 5,778 |
| 9 | -12,654 | 1,359 |
| 10 | -30,654 | -4,122 |
| 11 | -51,764 | -25,551 |
| 12 | -69,188 | -27,040 |
| 13 | -69,188 | -48,997 |
| 14 | -76,074 | -71,834 |
| 15 | -76,074 | -71,834 |
| 16 | -76,074 | -85,292 |
| 17 | -76,074 | -106,353 |
| 18 | -76,074 | -127,864 |
| 19 | -76,074 | -127,864 |
| 20 | -76,074 | -127,864 |
| 21 | -76,074 | -127,864 |
| 22 | -76,074 | -127,864 |
| 23 | -76,074 | -127,864 |
| 24 | -76,074 | -127,864 |
| 25 | -76,074 | -127,864 |
| 26 | -76,074 | -127,864 |
| 27 | -76,074 | -127,864 |
| 28 | -76,074 | -127,864 |
| 29 | -76,074 | -127,864 |
| 30 | -76,074 | -127,864 |
| 31 | -76,074 | -127,864 |
| 32 | -76,074 | -127,864 |
| 33 | -76,074 | -127,864 |

Total tokens rise rather than fall, and Figures 6 and 7 are where that shows up honestly. Against the native baseline the real-token gate spends 48% more on sw-5-dozen (260,700 against 175,661) and 77% more on sw-6-ripple (297,726 against 168,208); against the loop-8 tree it spends 35% and 22% more. Two mechanisms account for it. The first is overshoot. The gate reads the previous completed turn, so it detects the crossing one call late, and one batched turn on these tasks is expensive: five of the six crossings landed 6,657 to 15,564 tokens above the 30,000-token budget, and only sw-6-ripple's second replicate crossed close to it, 126 tokens above. Those overshoots are the peaks in Table 1, and they are billed at cache-write rates because the whole prefix is rewritten when the tree reorganizes. The second is that the transition costs turns: median turns go from 9 to 13 on sw-5-dozen and from 12 to 18 on sw-6-ripple. The extreme case is sw-6-ripple's second replicate, the long blue line in Figure 5, which ran 33 turns and spent the seventeen calls after its crossing with context oscillating between 8,357 and 25,471 tokens as the agent re-fetched detail it had just had in front of it.

The verdict is that the mechanism works and the criterion was wrong. On a 200,000-token context window the largest prompt any of these eighteen runs ever assembled is 45,564 tokens, leaving 154,436 tokens of headroom. The loop-9 transplant harness already derives its lazy budget from the target window instead of fixing it at a constant — `FRACTIONS.lazy` is 0.35, so 35% of the window, roughly 70,000 tokens on a 200,000-token model before its heuristic-to-BPE correction — and under that derivation not one of these traces would have crossed. The tree would have stayed devolved from the first turn to the last of both tasks, which on this evidence is the right answer: nothing was in danger of overflowing anything. The criterion published in §5 item 1 therefore asked the harness to force a transition the model does not need, and then measured what forcing it costs. What we learned is the cost of the transition, not the value of the tree. The gate itself is now correct — it fires once, on a number the provider supplies rather than a guess, and the growth behind it is slower than the baseline's — and the next question is not how to make the switch cheaper but where the switch belongs.

## 5. Open items and recommendations

1. **Replace the characters÷4 lazy gate with a real token count, then re-run and re-chart sw-5 and sw-6.** Done, 2 September 2026; reported in §4. The stated criterion was that the tree's curve flattens at the crossing instead of tracking the trace, *and* that its final-turn context falls below the baseline's on at least one of the two scenarios. The first half holds — the gate fires once on every run and per-turn growth behind it drops to 256–915 tokens per turn, below the baseline's own. The second does not, on either scenario. The gate also had to be made one-way; the un-latched version crossed twice in one run (§4, methods note). Live runs now do cross into summarized operation, so Figure 1's flat line is no longer established offline only, but it has not yet been shown to pay on a task this size.
2. **Derive the lazy budget once, from the context window, and put the switch at the Zone C fraction.** The finding of §4. Two harnesses currently answer "when should the tree stop showing the raw trace?" two different ways: the evaluation loop reads a constant, `EVAL_LAZY_TOKENS=30000`, which on a 200,000-token model is 15% of the window and fires on traces that were never at risk; the transplant harness derives it as `FRACTIONS.lazy = 0.35` of the window, about 70,000 tokens on the same model, which on these traces never fires at all. Neither number is argued for. The quantity the switch actually protects is Zone C, the zone that holds the active branch in full, so the switch belongs at the Zone C fraction — `FRACTIONS.zoneC`, currently 0.2 — of the same window-derived budget, in one derivation both harnesses import. Until that lands, no comparison of the two arms is measuring the policy we would ship.
3. **Record the same per-turn series for every arm of the loop-9 transplant harness, plain compaction included.** In flight. Compaction is the honest competitor to context-tree in the below-threshold regime — it is what production harnesses actually do — and it belongs on these axes rather than being argued about.
4. **Make these charts a standing section of every checkpoint report.** The data has always been in `results.json`; the omission was in the reporting, not the instrumentation. Per-turn context against turn, both arms, one pair of axes, in every checkpoint from here on.

## References

[1] *Making an agent's prompt size independent of conversation length* — the loop-8 interim report. https://claude.ai/code/artifact/d6875957-086a-4408-9de5-798b31aba6e6 — folding and the list cap (decisions D17 and D18), the marathon harness, the live context-window probe, the recall probe, and the cache-churn fix.

[2] `eval/scripts/marathon.mjs` in the context-tree repository — the deterministic 200-branch harness that produced Figure 1: no language-model calls, `HeuristicTokenizer` for token counts, a checkpoint every ten branches.

[3] The `long-v6x` results batch (Figures 2 and 3: two scenarios × two arms × three replicates, claude-sonnet-5, one epoch) and the `long-v64` batch (tree arm only, after the cache fix), read from each run's `results.json` via `turns: TurnRecord[]`.

[4] `eval/plans/loop9-item1-lazy-gate.md` — the runbook for the real-token gate: the code change in `eval/src/loop.ts`, its regression test, the latch, and the exact run command. Results in `eval/results/long-v65-gate/long-v65-gate-rep{1,2,3}/results.json`; crossings in `eval/results/long-v65-gate.log`.

[5] `eval/results/long-v65-gate-oscillating.log` — the discarded first batch, whose un-latched gate crossed twice on one run.

---

[^usd]: In United States dollars, at the harness's claude-sonnet-5 rates of $2.00 per million input tokens, $10.00 per million output, $0.20 per million cache read and $2.50 per million cache write (`packages/core/src/models/cost.ts`), the median run costs $0.136 on sw-5-dozen and $0.165 on sw-6-ripple under the native transcript baseline, $0.207 and $0.216 under the tree with the loop-8 gate, and $0.334 and $0.336 under the tree with the real-token gate. Dollars appear here once, beside the baseline they are relative to; every claim in this note is made in tokens, turns and graded score.

Supplementary note to loop 8 · Figure 1 from `eval/scripts/marathon.mjs`, offline and deterministic · Figures 2 and 3 from the `long-v6x` live batch, claude-sonnet-5, three replicates per cell, same epoch · Figures 4 to 7 from `long-v6x`, `long-v64` and `long-v65-gate`, tree arms re-run 2 September 2026 against 1 September baselines · September 1, 2026, revised September 2, 2026.
