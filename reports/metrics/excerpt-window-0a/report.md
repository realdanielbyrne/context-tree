# Rung 0a — D-a excerpt-window sweep

**Run id:** `excerpt-window-0a-2026-09-09` · **arm:** `excerpt-window-sweep@v1` · **offline, 0 model calls**
**Code commit:** `d6a7f2c` · **fixture commit:** `7d459f9^` · **script:** `experiments/rung-0a-excerpt-window/sweep.mjs`
**Raw data:** `results.json` (this dir).

## Question tested

Defect D-a: a correctly *ranked* event can be selected and still not contain the answer,
because the fixed-size excerpt window is too narrow and/or anchored at the wrong place. If so,
the retrieval **unit** is the defect, not the ranking.

Sweep: every recovered query × `excerptChars` ∈ {500, 1000, 2000, 4000} × anchor ∈
{`first` (shipped default), `rarest` (shipped), `matched-line-span` (candidate repair, this
script only). Metric: fraction of queries whose **all** `answer_literals` fall inside the excerpt.

## Corpus and the degenerate-null guard

- Recovered rows: 22 raw across `questions{,-deep,-overflow}.json`; **21 after de-duping** one
  byte-identical row shared by the deep/overflow sets.
- **Non-empty anchor terms: 21/21. Anchor term present in the text: 21/21.** The prior sweep's
  degenerate null (empty terms → every anchor identical → measures nothing) does **not** recur here.
- `wide_context` length: 215–2135 chars.

## Results — `allPresentRate` (mean est. tokens returned)

| excerptChars | first | rarest | matched-line-span |
| ---: | :---: | :---: | :---: |
| 500 | 52.4% (113t) | **57.1%** (113t) | 52.4% (113t) |
| **1000 (shipped)** | **90.5%** (196t) | 90.5% (196t) | 90.5% (196t) |
| 2000 | 100.0% (265t) | 100.0% (265t) | 100.0% (265t) |
| 4000 | 100.0% (267t) | 100.0% (267t) | 100.0% (267t) |

19/21 present at the shipped cell; 12/21 (rarest) or 11/21 (first, matched-line-span) at 500;
21/21 at 2000 and above.

## Falsification condition (fixed before the run)

> Falsifies (excerpt window is *not* the defect, item 1a closed) if the literal-present rate at
> the shipped setting `excerptChars=1000, anchor=first` is already ≥ 90%.

**Shipped cell = 90.5% ≥ 90% → condition technically MET — but item 1a is NOT closed**, per the
pre-registered caveat: `text = wide_context` is an answer-*windowed* slice (≤ ~2.1 KB), whereas the
live path excerpts `renderEvent(fullEvent)` — a whole tool output/file read, often tens of KB, with
the answer *not* centred. Excerpting a small answer-centred window loses the answer far less often
than excerpting a real multi-KB event, so **every rate here is an upper bound on production.** A
≥90% here is therefore *inconclusive*; only a rate **below** 90% would have been conclusive. The
s1 event store that would give the true `text` died with `eval/` at `7d459f9` and cannot be
reconstructed from the surviving question rows.

## What actually carries the effect

1. **Window size is the lever; the anchor is not.** At the shipped 1000, all three anchors are
   identical (90.5%). `rarest` beats `first` by exactly **one** query and only at 500; `matched-line-span`
   never beats `first` at any size. D-a's "anchored at the wrong place" sub-claim gets **no support**
   on this corpus — the candidate re-anchor repairs are inert. The lift comes only from a bigger
   window: 500 → ~55%, 1000 → 90.5%, 2000 → 100% (+~69 est. tokens over the shipped cell).

2. **Both residual failures are a distinct failure mode: multi-literal *spanning* answers.**
   The only two queries that fail at 1000 are `s1-q10-spanning` (2 literals 949 chars apart) and
   `s1-q12-spanning` (2 literals 1067 chars apart). Both gaps exceed the 1000-char window, so **no
   single window of any anchor can hold both literals** — the answer spans more than one window.
   This is not a narrow/mis-anchored-window problem; it needs either a larger window (2000 clears
   both here) or emitting multiple excerpt fragments per event.

## Reading for the next rung

- Re-anchoring (`rarest`, `matched-line-span`) is **not** worth pursuing as a D-a repair on this
  evidence.
- The two candidate directions with support are (a) a larger/adaptive `excerptChars` (bounded by
  the token cost measured above), which is **Rung 0c**'s subject; and (b) multi-fragment excerpts
  for spanning answers.
- To make D-a **conclusively** testable rather than upper-bounded, the sweep must run over full
  rendered events — available only from a rebuilt store (e.g. the committed
  `claude-code-session.jsonl`), not from the answer-windowed `wide_context` fields. That is a strictly
  larger experiment than Rung 0a as specified and is noted here as the gap.
