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

**Enforcement check:** achieved peak lands ~519 tokens under W at every
capped level — exactly the reply reserve being held back — and `cap_violations = 0` everywhere. The cap does
what it says.

## Measurements

*One arm only (`truncate-tail`, the incumbent), so every level is comparable. Pooling all arms made them
unlike each other: W=4,700 and W=9,500 carried the deliberately signal-free `random` control while the
interior levels did not, which dragged the endpoints down relative to the middle.*

| W | cells | pass | 95% CI (Wilson) | achieved peak | total prompt tok (med) | turns | evictions |
|---|---|---|---|---|---|---|---|
| 4,700 | 13 | 6/13 (46%) | 23–71% | 4,181 | 273,290 | 61 | 40 |
| 5,500 | 3 | 2/3 (67%) | 21–94% | 4,983 | 308,144 | 58 | 34 |
| 6,500 | 3 | 1/3 (33%) | 6–79% | 5,972 | 374,228 | 61 | 32 |
| 7,500 | 3 | 3/3 (100%) | 44–100% | 6,977 | 409,065 | 58 | 32 |
| 8,500 | 3 | 3/3 (100%) | 44–100% | 7,972 | 426,197 | 56 | 25 |
| 9,500 | 3 | 3/3 (100%) | 44–100% | 8,971 | 499,612 | 61 | 25 |
| ∞ (uncapped) | 3 | 3/3 (100%) | 44–100% | 20,993 | 632,225 | 53 | 0 |

## Reading it

- **Dose–response is steep.** Pass rate by cap, `truncate-tail` only:
  4,700 → 46% (6/13) · 5,500 → 67% (2/3) · 6,500 → 33% (1/3) · 7,500 → 100% (3/3) · 8,500 → 100% (3/3) · 9,500 → 100% (3/3) · ∞ → 100% (3/3).
  Logistic regression on achieved peak, **adjusted for arm**, gives an odds ratio of **42× per e-fold**
  (`report-cadence-confound.md`).
- **Cost moves the opposite way.** 273,290 → 632,225
  prompt tokens across the same span. Capping is *cheaper* and *worse*; the operating point is a trade,
  not an optimum.
- **The curve is NOT monotone point-to-point.** W=6,500 (1/3)
  sits below W=5,500 (2/3). With n=3 at the interior
  levels this is within noise, so the data locate the cliff no better than **5,500–7,500**.
- **W is a stand-in for the thing that actually matters, which is ACHIEVED PEAK.** Once achieved peak
  and arm are in the model, nominal W adds nothing (LR χ²(1)=0.19, p=0.66) and neither does eviction
  cadence (χ²(1)=0.37, p=0.54). W only predicts success *because* it determines peak. See
  `report-cadence-confound.md` — this matters whenever the cap is not enforced every turn.
- Single problem (C0), so this curve is for `longbuild`, not for agentic coding in general.

> Charts in the HTML twin: `report-window-metric.html`.
