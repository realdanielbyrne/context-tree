#!/usr/bin/env python3
"""
Which design parameters actually drive the outcome? Logistic regression + ANOVA
over every A/B cell run with the POST-FIX policies.

Answers, statistically rather than by eyeballing tables:
  1. Does the SELECTION SIGNAL (arm) matter, once window is accounted for?
     -> likelihood-ratio test of  pass ~ window  vs  pass ~ window + arm
  2. How much does WINDOW matter?          -> logistic coefficient / odds ratio
  3. What drives re-reads and turns?       -> OLS ANOVA on the continuous outcomes

Excludes results-ab-longbuild.json (the pre-fix run, whose idle arm was inert)
and rule-chain (different task).

Rerun: /mnt/data/ctx-swebench/tooling/venv/bin/python experiments/context-dedup/stats-parameter-effects.py
"""
import json, glob, os, warnings
import numpy as np
import pandas as pd
import statsmodels.api as sm
import statsmodels.formula.api as smf
from scipy import stats as sps

warnings.filterwarnings("ignore")
OUT = os.path.join(os.path.dirname(__file__), "..", "..", "reports", "metrics", "context-dedup")

# ---- load only post-fix longbuild batches -----------------------------------
FILES = ["results-ab-longbuild-v2-n3.json", "results-ab-longbuild-v2.json"]
FILES += [os.path.basename(p) for p in glob.glob(os.path.join(OUT, "results-ab-longbuild-cadence*.json"))]
rows = []
for fn in FILES:
    p = os.path.join(OUT, fn)
    if not os.path.exists(p):
        continue
    d = json.load(open(p))
    cad = d["manifest"].get("cadence", 1)
    for c in d["cells"]:
        rows.append(dict(
            batch=fn, arm=c["arm"], window=(np.inf if c["window"] is None else c["window"]),
            cadence=cad, pass_=int(bool(c["pass"])), turns=c["turns"] or 0,
            rereads=c["rereads"], evictions=c["evictions"],
            peak=c["peak_history_tokens"], tokens=c["total_prompt_tokens"],
        ))
df = pd.DataFrame(rows)
print(f"cells loaded: {len(df)}  from {df.batch.nunique()} batch file(s)")
print(df.groupby(["window", "arm"]).agg(n=("pass_", "size"), passes=("pass_", "sum")).to_string(), "\n")

capped = df[np.isfinite(df.window)].copy()
capped["logW"] = np.log(capped.window)
capped["arm"] = pd.Categorical(capped.arm, categories=["truncate-tail", "idle", "random"])

print("=" * 72)
print("1. DOES THE SELECTION SIGNAL MATTER, GIVEN THE WINDOW?  (likelihood-ratio test)")
print("=" * 72)
try:
    m0 = smf.logit("pass_ ~ logW", data=capped).fit(disp=0)
    m1 = smf.logit("pass_ ~ logW + C(arm)", data=capped).fit(disp=0)
    lr = 2 * (m1.llf - m0.llf)
    dfree = int(m1.df_model - m0.df_model)
    p = sps.chi2.sf(lr, dfree)
    print(f"  window only        log-lik = {m0.llf:.3f}")
    print(f"  window + arm       log-lik = {m1.llf:.3f}")
    print(f"  LR chi2({dfree}) = {lr:.3f}   p = {p:.4f}")
    print(f"  -> adding the selection signal {'DOES' if p < 0.05 else 'does NOT'} significantly improve fit\n")
    print(m1.summary2().tables[1].to_string(), "\n")
    print("  odds ratios:")
    for k, v in np.exp(m1.params).items():
        print(f"    {k:<28} {v:8.3f}")
except Exception as e:
    print("  logistic fit failed (likely perfect separation):", e)

print()
print("=" * 72)
print("2. ARM EFFECT AT THE TIGHT CAP ONLY (W=4700) — the decisive cells")
print("=" * 72)
t = capped[capped.window == 4700]
tab = t.groupby("arm", observed=True).agg(n=("pass_", "size"), passes=("pass_", "sum"))
tab["rate"] = tab.passes / tab.n
print(tab.to_string())
ct = pd.crosstab(t.arm, t.pass_)
if ct.shape == (3, 2):
    chi2, pchi, _, _ = sps.chi2_contingency(ct)
    print(f"\n  chi2 across the 3 arms: chi2={chi2:.3f}  p={pchi:.4f}"
          f"  -> arms {'differ' if pchi < 0.05 else 'do NOT differ'} at W=4700")
sig = t[t.arm != "random"]
ct2 = pd.crosstab(sig.arm.astype(str), sig.pass_)
if ct2.shape == (2, 2):
    _, p2 = sps.fisher_exact(ct2.values)
    print(f"  idle vs truncate-tail (Fisher): p={p2:.4f}")
rnd = t.assign(signal=(t.arm != "random"))
ct3 = pd.crosstab(rnd.signal, rnd.pass_)
if ct3.shape == (2, 2):
    _, p3 = sps.fisher_exact(ct3.values)
    print(f"  any-signal vs random  (Fisher): p={p3:.4f}")

print()
print("=" * 72)
print("3. WHAT DRIVES THE CONTINUOUS OUTCOMES?  (OLS ANOVA, type II)")
print("=" * 72)
from statsmodels.stats.anova import anova_lm
for dv in ["rereads", "turns", "tokens", "evictions"]:
    try:
        mod = smf.ols(f"{dv} ~ logW + C(arm)", data=capped).fit()
        a = anova_lm(mod, typ=2)
        a["eta_sq"] = a["sum_sq"] / a["sum_sq"].sum()
        print(f"\n  --- {dv} ---")
        print(a[["F", "PR(>F)", "eta_sq"]].to_string())
    except Exception as e:
        print(f"  {dv}: failed ({e})")

if capped.cadence.nunique() > 1:
    print("\n" + "=" * 72)
    print("4. CADENCE EFFECT (runs present)")
    print("=" * 72)
    print(capped.groupby(["cadence", "arm"], observed=True).agg(
        n=("pass_", "size"), rate=("pass_", "mean"), peak=("peak", "median"), rereads=("rereads", "median")).to_string())
else:
    print("\n(cadence sweep not yet complete — only cadence=1 present, so no cadence term fitted)")

summary = dict(cells=len(df), capped=len(capped),
               by_cell=df.groupby(["window", "arm"], observed=True)["pass_"].agg(["size", "sum"]).reset_index().to_dict("records"))
json.dump(summary, open(os.path.join(OUT, "results-stats-parameter-effects.json"), "w"), indent=2, default=str)
print(f"\nwrote results-stats-parameter-effects.json")
