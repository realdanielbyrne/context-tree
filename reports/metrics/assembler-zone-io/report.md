# Assembler zone I/O — what goes in, what comes out of each zone

**Run:** `assembler-zone-io@v1` · offline · deterministic (no live model) · commit `d6a7f2c`
**Script:** `experiments/rung-0-assembler/zone-io.mjs` · **Raw:** `results.json`
**Input:** synthetic store — root task + 150 phase branches (1 open), each with a fixed-string summary and
raw Zone C detail, plus 12 appended tail results. Drives the **shipped** `ZoneAssembler`, sweeping W.

## What goes in / comes out of each zone

| W | ZoneA | ZoneB (in/drop) | ZoneC | tail | occ% | overWindow |
| ---: | ---: | ---: | ---: | ---: | ---: | :---: |
| 16,384 | 41 | 7987 (55/94) | **56 (−4)** | 8496 | **101.2** | **true (−196)** |
| 32,768 | 41 | 7987 (55/94) | 399 | 8496 | 51.6 | false |
| 65,536 | 41 | 7987 (55/94) | 399 | 8496 | 25.8 | false |
| 131,072 | 41 | 7987 (55/94) | 399 | 8496 | 12.9 | false |
| 200,000 | 41 | 7987 (55/94) | 399 | 8496 | **8.5** | false |

## Findings (the zone contract, observed)

1. **Zone A is byte-constant across every W (41 tok)** — the frozen, cache-stable prefix. Works as designed.
2. **Zone B is CAPPED and does not expand with the window.** It admits 55 of 149 branch summaries (7987
   tok) at *every* W — **94 branches stay dropped even at W=200,000 with 183k tokens free.** The summary
   layer does not use available headroom; it is a fixed-size band, not an adaptive one.
3. **Zone C yields under pressure** — truncated 399→56 (4 events dropped) only at W=16,384.
4. **The tail (undelivered results) is never evicted** — `evictedFromTail=0` even at W=16,384, where the
   prompt **overflows** (`overWindow=true`, remaining −196). Per D6 ("a result appended since the last
   send never leaves"), fresh results are protected, so Zone C is cut first and the prompt overflows
   rather than dropping a new result.
5. **The shipped assembler massively under-fills large windows — 8.5% occupancy at W=200k.** Neither Zone
   B nor the tail grows into headroom. The elastic raw-tail headroom-fill that made raw-content arms win
   is **not in the library** (`appendHeadroom` lived only in the deleted harness — `algorithm.md:176`);
   the shipped tail holds only appended retrieval results.

## Should we even have zones? — partially answered, and the partial answer is skeptical of Zone B

Separating the layers:
- **Zone A (system + tools):** trivially yes — every prompt has it.
- **Zone C + tail (raw content):** yes — the record is consistent that raw content is what produces
  scores.
- **Zone B (the summary tree — the actual thesis): NOT justified on any *tested* regime.** Measured
  **inert-to-harmful** when raw events fit: `flat-events` (no Zone B) 15/25 vs 16/25 with it
  (`algorithm.md:289`, "the null hypothesis for Zone B holds"); verbose summaries *drop* score and
  "displace answer-bearing content without compensating through navigation"
  (`ds-star-tree-tail-iter1`). Its one plausible justification — a **compression layer in the overflow
  regime** (session ≫ window) — **has never been tested** (the regime was never reached).

**This run adds two structural problems that make even that untested justification shaky:** the shipped
Zone B is **capped and non-adaptive** (finding 2), so it cannot function as an overflow compression layer
that grows with the session; and the **headroom-fill is missing** (finding 5), so the shipped assembler
would not reproduce the raw-content arms that actually scored. So: **"should we have Zone B" is open, its
prior is negative, and the current implementation could not fairly test the one hypothesis that would
vindicate it.** Zone A/C/tail are not in question.

## Caveats

- Synthetic store, fixed-string summaries — this characterizes the assembler *contract and budgets*, not
  task quality. Absolute tokens depend on the synthetic content; the *structural* facts (Zone B capped,
  tail protected, large-W under-fill, overflow-before-tail-eviction) are properties of the shipped code.
- Deterministic and rerunnable: `node zone-io.mjs`.
