> Markdown equivalent of [loop8-interim.html](./loop8-interim.html). The HTML version is the canonical rendering; this file exists so the report is readable and diffable in git.

# Making an agent's prompt size independent of conversation length

Context-tree evaluation program, loop 8 (interim) · September 1, 2026 · commit `cac9076`

> *Status.* This is an interim report on work in progress: loop 8's verification is complete (including the retrieval probe, §3.4), but the recommendations of §5 are not yet executed. It builds directly on the loop-7 report [1], which introduced the evaluation method, the transcript baseline, the four short tasks (sw-1…sw-4), and the v6.x configuration that this loop starts from; readers wanting the derivation of those should start there. The two design decisions introduced here, D17 and D18, are recorded with full rationale in the project's decision record [2].

## Abstract

An agent's prompt normally contains the transcript of everything it has done, so the prompt grows with the length of the task and eventually exceeds the context window of the model. Context-tree is a context-management layer built to remove that limit: it writes the full history to disk, segments it into phases of work, and assembles the prompt from a bounded working set — one headline line per completed phase, the full detail of the phase in progress, and tools with which the agent can retrieve anything older on demand. Two parts of that working set could still grow without limit: the headline list gains a line per phase, and several metadata lists accumulate across phases. This report describes two changes that cap both (the prompt lists only the 40 most recent phases individually, folding everything older into a single line that says what was removed and how to get it back; no rendered list may exceed 40 entries) and measures the result against the ordinary transcript. On a synthetic 200-phase task the tree prompt is constant at 9,062 tokens from phase 80 onward, while the transcript grows by about 284 tokens per phase and exceeds a 16k context window at phase 56 and a 32k window at phase 113; a live API call per arm at phase 200 confirmed this — the transcript was rejected by the model, the tree prompt was answered. The same evaluation exposed and fixed a caching defect that had been re-writing the same ~33k-token prefix to the provider's cache five times per run. Tokens, turns, and graded accuracy are the primary metrics throughout; dollar figures appear only as derived values at one model's prices. Finally, we tested retrieval of folded material live: asked at phase 200 to recall a decision from phase 10 — whose description appears nowhere in the prompt — without using its vocabulary, the model searched for and recovered all three planted facts in 15 of 15 replicates.

## 1. The question, and terms

We want a conversation with an agent to continue indefinitely — past the context window of whatever model runs it. Throughout this report we compare two ways of building the agent's prompt, holding the model and the task fixed. The **transcript baseline** is the default behaviour of agent harnesses: the prompt contains the full history of the conversation, and the provider's prompt cache makes re-sending it cheap but not free. The **tree** arm is context-tree: the full history is written to disk, and the prompt holds only a bounded working set assembled from three parts — fixed instructions, a summary section, and the detail of the work currently in progress.

The unit of organization is a **phase** (called a *branch* in the code, because phases are children of a task node in a tree): a contiguous stretch of work on one sub-problem, such as diagnosing one bug or migrating one file. When a phase completes, it gets a short summary, and the prompt's summary section carries one such summary per completed phase. At the top of that section sits the **root summary**: an index of the whole task, holding one headline line per completed phase.

Before this loop, two parts of the summary section had no size limit. The root summary gained one headline (50–125 tokens) per completed phase, and it is deliberately exempt from the assembler's overflow rule, so nothing ever shrank it. Several metadata lists (files touched, decisions, open questions) are unions over all phases and grew the same way. Past roughly 70–160 phases the root summary alone would fill the summary section's 8,000-token budget, and the prompt would grow without bound from then on.

## 2. The change: folding

A design review of three candidate fixes (two hierarchical roll-up schemes and one minimal scheme) selected the minimal one: cap what is *rendered*, change nothing about what is *stored*. The root summary now renders headlines for only the 40 most recently completed phases. Every older phase is **folded**: its individual headline is removed from the prompt, and all folded phases together are represented by a single line. Concretely, at phase 200 the root summary begins:

```
marathon task
- branches 1..160 (160 folded: n_23FF…QD01 .. n_23FF…QK78)
  — "Fixed the off-by-one in the parser." .. "Renamed the batch loader."
  — call context_search or context_fetch to recall
- [headline of phase 161]
- [headline of phase 162]
  …
```

A folded phase therefore still exists in full — its events, its summary, its metadata are all on disk and the agent's fetch tools can retrieve any of them by search or by identifier. What it loses is its individual line in the prompt. The second change is the list cap: no rendered metadata list may print more than 40 entries; beyond that it prints "+M more". Together these are the changes we call D17 and D18 in the decision record.

The changes amount to two clauses in one pure function and one render function. All 73 pre-existing tests pass unmodified, which is the intended evidence that behaviour below 40 phases is byte-for-byte unchanged. Forcing folding onto short tasks (keeping 2 headlines instead of 40) changed neither turn counts nor scores.

## 3. Measurements

### 3.1. Prompt size over 200 phases

We built a deterministic harness that replays 200 read–write–verify phases through the real storage and assembly pipeline, with no language-model calls, and assembles both arms' prompts at every tenth phase. Figure 1 shows the comparison.

**Figure 1.** Prompt tokens against completed phases, both arms on the same synthetic task. The transcript grows by a constant 2,840 tokens per ten phases. The tree prompt rises until folding first engages at phase 41 and is then constant at 9,062 tokens; its summary section never exceeds its 8,000-token budget, and the root summary is 1,963 tokens at every checkpoint from phase 60 to 200. The marked points are where the transcript exceeds the 16,384-token window of gpt-3.5-turbo (phase 56) and the 32,768-token window of qwen-2.5-72b (phase 113).

**Figure 1 data** (rendered as table in this markdown equivalent):

| Completed phases | Transcript (tokens) | Tree (tokens) |
|---|---|---|
| 40 | 11,494 | 7,778 |
| 80 | 22,854 | 9,062 |
| 120 | 34,214 | 9,062 |
| 160 | 45,574 | 9,062 |
| 200 | 56,934 | 9,062 |

Threshold-crossing points (transcript line only, interpolated between checkpoints):

| Phase | Event |
|---|---|
| 56 | exceeds the 16,384-token (16k) window of gpt-3.5-turbo |
| 113 | exceeds the 32,768-token (32k) window of qwen-2.5-72b |

We then made one live request per arm at phase 200 against qwen-2.5-72b, a 32k-window model, asking only for an acknowledgement. The transcript prompt (42,690 tokens) was rejected with `context_length_exceeded`; the tree prompt (9,062 tokens) was answered. The probe cost $0.02.

### 3.2. Cost on long tasks, and a caching defect

To measure cost at a longer horizon than our earlier tasks, we built two software tasks whose material alone is about 60 kB: twelve independently buggy modules (sw-5) and an interface migration touching ten dependent files (sw-6). Each has a hidden test suite; a run's **score** is the fraction of hidden cases it passes. Three runs per cell, claude-sonnet-5 in both arms. One term for reading Table 1: **cache-write tokens** count what a run writes *into* the provider's prompt cache; writing the same content repeatedly is pure overhead, so a cache-write total far above the prompt's size indicates that something kept invalidating the cache.

| task · arm | score | turns | tokens | cache-write tok | usd* |
|---|---|---|---|---|---|
| sw-5 · transcript | 100% | 13 | 175,661 | 19,156 | $0.136 |
| sw-5 · tree | 100% | 12 | 233,166 | 35,547 | $0.189 |
| sw-6 · transcript | 100% | 12 | 168,208 | 20,190 | $0.165 |
| sw-6 · tree, before fix | 100% | 12 | 288,678 | 161,938 | $0.521 |
| sw-6 · tree, after fix | 100% | 12 | 244,964 | 33,317 | $0.216 |

**Table 1.** The two long tasks (medians of 3). Every run succeeded with a 100% score; the arms differ in tokens and cache behaviour, not outcome. *Dollar values are derived at claude-sonnet-5 prices and change with the model; the token columns do not. A configuration that summarizes from the first turn was also run and was worse on both tasks; it is omitted for brevity.

The number that demanded explanation is 161,938 cache-write tokens on sw-6, when the task's trace never exceeded about 33k tokens: the same prompt prefix was being written to cache about five times. The mechanism is as follows. Below a size threshold the tree runs in **devolved mode** — it shows the whole trace rather than summaries, on the argument that summarizing a short conversation costs money for nothing. That mode still applied a 30,000-token budget to the trace, and the threshold test estimated size as characters divided by four, while the real tokenizer charges more for code-dense text. So sw-6 exceeded the budget without ever reaching the threshold. Once over budget, the truncation rule recomputed a shared per-block cap on every request; each new tool result moved the cap by a token or two, which altered every truncated block at once and invalidated the whole cached prefix. The fix removes the budget in devolved mode, whose stated contract was always to show the whole trace. Cache-writes fell from 162k to 33k and cost from $0.52 to $0.22.

### 3.3. Comparison with the baseline across all six tasks

Figure 2 places the tree beside the transcript baseline on every task in the current suite, using each arm's current configuration and the same model. Panel (a) shows the success rate: the fraction of attempted runs that passed the task's full hidden test suite. Panels (b) and (c) show the two provider-independent effort measures, total tokens processed and model turns to completion. Table 2 gives the aggregate picture.

**Figure 2.** Both arms on all six tasks, same model (claude-sonnet-5). **(a)** Success rate: a run counts as a success only if it passes the task's entire hidden test suite; the parenthesis gives the raw counts. Eleven of the twelve cells are perfect. The exception matters: the transcript baseline failed two of its five attempts on sw-2, the hardest task — a 60% success rate — while all ten tree attempts succeeded. **(b)** Median total tokens per run: the transcript processes fewer tokens on five of six tasks; sw-2 is the exception because its failed runs still consume tokens all the way to the 40-turn cap, so each transcript attempt averages more tokens than each (always-successful) tree attempt. The worst tree cell is sw-3, at 3.4× the baseline's tokens — the open overhead problem. **(c)** Median turns: the tree reaches the answer in fewer turns on four tasks, equal on sw-6, more on sw-3.

**Figure 2(a): Success rate — runs passing the hidden test suite** (data rendered as table in this markdown equivalent)

| Task | Transcript baseline | Tree |
|---|---|---|
| sw-1 patch | 100% (5 of 5 runs) | 100% (10 of 10) |
| sw-2 multimod | 60% (2 of 5 runs failed) | 100% (10 of 10) |
| sw-3 refactor | 100% (3 of 3) | 100% (6 of 6) |
| sw-4 bughunt | 100% (3 of 3) | 100% (6 of 6) |
| sw-5 dozen | 100% (3 of 3) | 100% (3 of 3) |
| sw-6 ripple | 100% (3 of 3) | 100% (3 of 3) |

**Figure 2(b): Total tokens per run (median)** (data rendered as table in this markdown equivalent)

| Task | Transcript baseline | Tree |
|---|---|---|
| sw-1 patch | 83,848 | 91,124 |
| sw-2 multimod | 302,418 (failed runs included) | 270,924 |
| sw-3 refactor | 35,561 | 121,012 |
| sw-4 bughunt | 42,181 | 56,524 |
| sw-5 dozen | 175,661 | 192,853 |
| sw-6 ripple | 168,208 | 244,964 |

**Figure 2(c): Model turns per run (median)** (data rendered as table in this markdown equivalent)

| Task | Transcript baseline | Tree |
|---|---|---|
| sw-1 patch | 19 | 12.5 |
| sw-2 multimod | 35 (2 runs hit the 40-turn cap) | 25 |
| sw-3 refactor | 9 | 13.5 |
| sw-4 bughunt | 11 | 8.5 |
| sw-5 dozen | 13 | 9 |
| sw-6 ripple | 12 | 12 |

| measure | transcript | tree |
|---|---|---|
| prompt at phase 200 (marathon) | 56,934 tok | 9,062 tok |
| longest conversation a 32k model survives | 113 phases | >200 phases |
| runs succeeded, all A/B batches to date | 20/22 | 62/62 |
| median turns, sw-1 / sw-2 | 19 / 35 | 12.5 / 25 |
| tokens per successful sw-2 run | 524,483 | 273,527 |

**Table 2.** Aggregate comparison, claude-sonnet-5 runs only. The last row divides total tokens spent across all sw-2 attempts by the number of successes — the provider-independent version of cost-per-success; the transcript's two failures make each success nearly twice as expensive in tokens. Both transcript failures hit the 40-turn cap. For short tasks that fit comfortably in the window the transcript processes fewer raw tokens; the tree's advantages are boundedness, reliability, and turn count.

### 3.4. The recall probe

Folding is only safe if the agent can still get folded knowledge back. We tested this live. In the 200-phase marathon store, phase 10 was given distinctive content: a summary recording that the loader's batch size was capped at 50 in `ingest_batches()` (`src/loader.py`) to avoid an out-of-memory crash, with matching underlying events. With the fold engaged, neither that phase's headline nor its title appears anywhere in the prompt — it is covered only by the fold line's generic recall hint. We then asked the model (claude-sonnet-5, 5 replicates per condition, at most 6 turns each): *"We need to undo the temporary limit we agreed on early in this task. What was it, what value did we set, and in which file?"* — a phrasing that shares no vocabulary with the planted content. Two controls separate the failure modes: the same question asked with the original vocabulary (does keyword retrieval work at all?), and the vocabulary-free question with folding disabled (does visibility alone suffice?).

All fifteen runs, across all three conditions, recovered all three facts — the cap, the value 50, and the file — and every run did it the same way: one `context_search` call, then the answer, two turns in total. The probe condition was not even degraded relative to its controls. Total spend: $0.57. Two qualifications keep this result in proportion. The search that executed was the lexical fallback over stored summary text (no embedding model was configured), so this validates lexical search, not vector search. And the planted facts were present in the phase's *summary*; recall of facts that survive only in the raw event log — where a further `context_fetch` hop would be required — was not exercised, since no run needed to fetch. The prepared escalation (a roll-up hierarchy, plan §19) therefore remains unneeded on current evidence.

### 3.5. What did not happen

In all 24 long-task runs, the summarization machinery never engaged: the model solved these 60 kB tasks in 9–16 turns by reading selectively, and the trace never reached the size threshold. The flat line in Figure 1 is therefore established offline by construction, but no live run has yet crossed into summarized operation. The natural next change follows from §3.2: measure the threshold with the real tokenizer rather than characters/4, so that crossing happens exactly when the trace would otherwise overflow its zone.

## 4. Limitations

Three things remain untested or unresolved. First, two edges of retrieval: the probe of §3.4 validated lexical search over summaries, but vector search ran nowhere (no embedder was configured), and no run needed the second hop — fetching raw events for facts absent from every summary. Second, all effort figures come from one model family; the cross-model matrix (GLM, DeepSeek, Qwen, plus deliberately small-window models) has validated plumbing and correct per-model prices but no results yet. Third, the tree still processes more tokens per run than the transcript on five of six tasks, most visibly sw-3 (121k against 36k); the next target there is the size of the fixed instruction section.

## 5. Open items and recommendations

The claim that motivated this loop — that the architecture allows conversation to continue past the context window, indefinitely — is now demonstrated for prompt size, with a live confirmation. The remaining work, in the order we recommend running it (ordered by information gained per unit of spend):

1. **Run the live recall probe — done (§3.4).** 15/15 runs recovered all three planted facts through the fold line, at $0.57 total. The residual retrieval work is the harder variant: plant a fact that appears in *no* summary, only in the raw event log, so the model must chain search → fetch; and repeat the probe with a real embedding model configured.
2. **Measure the size threshold with the real tokenizer.** The characters÷4 estimate caused the §3.2 defect and keeps the summarization machinery dormant on tasks that should engage it. One change, already scoped; afterwards re-run sw-5 and sw-6 to observe the first live crossings into summarized operation, which no run has yet exercised.
3. **Close the short-task overhead gap.** The tree pays a fixed overhead the transcript does not, most visible on sw-3 (121,012 tokens against the transcript's 35,561, and 13.5 turns against 9). The next candidate is a deletion: shrink the fixed instruction section. Success criterion: sw-3 within 50% of the transcript's tokens with no reliability loss.
4. **Populate the benchmark suite.** Adapters exist for Terminal-Bench, HLE-with-tools, AutomationBench, and GDPval-AA but only the DeepSWE-style tasks have data. Load the three public datasets first, then produce the cross-model delta table (GLM-5.3-flash, DeepSeek-V4-flash, Qwen, Claude, plus 16k and 32k small-window models) — plumbing and per-model prices are already validated.
5. **Promote the loop-8 changes to core defaults.** Folding and the list cap currently sit behind an evaluation gate; once the recall probe passes, make them the default assembler behaviour and update decision D2 accordingly.
6. **Consolidate reporting.** Fold loops 7 and 8 into one deep report with the graded-score and token columns the harness now records, so every future comparison reads as transcript-versus-tree deltas at a fixed model, per benchmark — the format of a model page's benchmark table.

## References

[1] *Context-tree vs. transcript: the loop 1–7 evaluation report.* [claude.ai/code/artifact/b3b0e9c7…](https://claude.ai/code/artifact/b3b0e9c7-bc38-4ea1-bb7f-8ad8c2a88f57) — method, baselines, cost-bucket attribution, and the seven-loop history through the v6.x configuration.

[2] *Implementation plan and decision record*, `docs/IMPLEMENTATION_PLAN.md` §3 (decisions D1–D18) in the context-tree repository, commit `cac9076`.

[3] DS-STAR, the iteration methodology adapted for these loops: arXiv:2509.21825.

---

Interim report, loop 8 · ~161 evaluation runs today · configurations: v6.x = deterministic root + no schema text + fetch-as-events + lazy threshold 30k; v6.4 adds the §3.2 fix; fold cap 40 (D17), list cap 40 (D18) · code at commit `cac9076`.
