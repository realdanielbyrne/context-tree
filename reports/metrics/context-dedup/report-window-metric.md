# The window metric `W` — what it measures, and the dose–response

## What `W` actually is

`W` is an **artificial per-turn cap on the assembled prompt**, enforced by the assembler *before* the
request is sent. It is deliberately **not** the model's context window — that stays fixed at the 27B's
real **262,144 tokens** in every arm, so the provider never rejects anything and no result is an artifact
of a model limit. `W` simulates a *deployment* window.

**How it is enforced** (`policies.mjs → evictToBudget`):

```
avail = W − head(498) − reserve(512)
keep  = anchors (last A=4 units, never evicted)
        + units in rank order while they still fit avail
```

So three things come out of the same budget, and only the third is negotiable:

| component | size | evictable? |
|---|---|---|
| frozen head (system 132 + task 366) | **498 tok** | never |
| reply reserve | **512 tok** | never (held back for the answer) |
| context units | W − 1010 | yes — this is what eviction fights over |

That fixed tax is why the cap bites harder than it looks: at W=4,700 the head+reserve consume
**21%** of the budget, leaving 3,690 tokens
for actual context; at W=9,500 the same tax is only **11%**.

**Units:** `W` is counted with the harness's `estTokens` = **characters ÷ 4** heuristic, not the
provider's tokenizer. So `W` and the `peak` column are in estimated tokens, while
`total_prompt_tokens` is the provider's real count. They are consistent within an experiment but not
interchangeable.

**Enforcement check:** achieved peak lands ~518 tokens under W at both
levels — exactly the reply reserve being held back — and `cap_violations = 0` everywhere. The cap does
what it says.

## Measurements

| W | cells | pass | 95% CI (Wilson) | achieved peak | total prompt tok (med) | turns | evictions |
|---|---|---|---|---|---|---|---|
| 4,700 | 39 | 15/39 (38%) | 25–54% | 4,182 | 275,246 | 61 | 40 |
| 9,500 | 9 | 8/9 (89%) | 56–98% | 8,971 | 477,501 | 58 | 25 |
| ∞ (uncapped) | 3 | 3/3 (100%) | 44–100% | 20,993 | 632,225 | 53 | 0 |

## Reading it

- **Dose–response is steep.** 38% → 89% → 100% as the cap goes 4,700 → 9,500 → ∞. This is the effect the
  regression picks up as odds ratio 72× per log-unit of W.
- **Cost moves the opposite way.** 275k → 478k → 632k prompt tokens. Capping is *cheaper* and *worse*;
  the operating point is a trade, not an optimum.
- **Only two capped levels exist**, with 39 and 9 cells. "Bigger is much better" is solid; the *shape* of
  the curve between them is unmeasured — the quality cliff could be anywhere in 4,700–9,500. That gap is
  exactly what the next short experiment should fill.
- Single problem (C0), so this curve is for `longbuild`, not for agentic coding in general.

> Charts in the HTML twin: `report-window-metric.html`.
