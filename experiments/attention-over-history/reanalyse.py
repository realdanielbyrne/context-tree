#!/usr/bin/env python3
"""
Re-analyse a saved results JSON offline — no GPU, no model.

Rerun:
  /mnt/data/ctx-swebench/tooling/venv/bin/python \
    experiments/attention-over-history/reanalyse.py <results.json> [--floor 6.3e-3]

WHY THERE ARE TWO FLOORS, AND WHY IT MATTERS
--------------------------------------------
`floor.py` measures two different disagreements and they differ by 4x:

  same-device, different reduction order (default vs MATH kernel)   6.30e-3 RMS
  different device AND precision (bf16 GPU vs fp32 CPU)             2.48e-2 RMS

They answer different questions. The cross-device figure bounds "is this number
physically meaningful in absolute terms" — it is the right floor for quoting a
dNLL to a reader. The same-device figure bounds "can THIS experiment's internal
comparisons be trusted" — every comparison the design makes is between two
forwards on the same GPU in the same dtype, so this is the floor that governs
the validity gate.

Using the cross-device floor for the gate is over-conservative and throws away
most of the corpus; using the same-device floor and then quoting absolute dNLLs
as if they were accurate would be over-claiming. So: gate on the same-device
floor, quote absolute values against the cross-device one, and report both. This
script exists so that choice is a visible, re-runnable parameter rather than a
constant someone has to trust.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import attn_signal as sig  # noqa: E402

FLOOR_SAME_DEVICE = 6.30e-3
FLOOR_CROSS_DEVICE = 2.482e-2


def analyse(res: dict, floor: float, min_frac: float = 0.5) -> dict:
    allturns = res["turns"]
    turns = [t for t in allturns
             if np.mean(np.abs(np.asarray(t["louo_delta_nll"])) > floor) >= min_frac]
    out = {"floor": floor, "n_all": len(allturns), "n_analysable": len(turns),
           "sessions": sorted(set(t["session"] for t in turns))}
    if not turns:
        return out

    col = lambda k: np.asarray([t["correlations"][k] for t in turns])  # noqa: E731
    allm, alll, allp, allu, alls = [], [], [], [], []
    for t in turns:
        c = t["candidates"]
        allm += [t["mass"][i] for i in c]
        alll += [t["lengths"][i] for i in c]
        allp += list(range(len(c)))
        allu += t["louo_delta_nll"]
        alls += t["subst_delta_nll"]

    out["pooled"] = {
        "n_rows": len(allu),
        "mass_vs_louo": sig.spearman(allm, allu),
        "position_vs_louo": sig.spearman(allp, allu),
        "length_vs_louo": sig.spearman(alll, allu),
        "partial_mass_given_length": sig.partial_spearman(allm, allu, alll),
        "partial_position_given_length": sig.partial_spearman(allp, allu, alll),
        "F2_margin_pooled": (sig.partial_spearman(allm, allu, alll)
                             - sig.partial_spearman(allp, allu, alll)),
    }
    d = col("partial_mass_given_length") - col("partial_position_given_length")
    out["per_turn"] = {
        "F2_margin_median": float(np.median(d)), "F2_margin_mean": float(d.mean()),
        "F2_margin_sd": float(d.std(ddof=1)) if len(d) > 1 else 0.0,
        "wins": int((d > 0).sum()), "n": len(d),
    }
    out["per_session"] = {}
    for s in out["sessions"]:
        idx = [i for i, t in enumerate(turns) if t["session"] == s]
        out["per_session"][s] = {"n": len(idx), "mean_margin": float(d[idx].mean()),
                                 "wins": int((d[idx] > 0).sum())}
    ties = int(sum((np.abs(np.asarray(t["louo_delta_nll"])) < floor).sum() for t in turns))
    out["noise_ties_frac"] = ties / max(1, len(allu))

    # ablation, pooled over keep-fractions, with the splice confound exposed
    lo, rd, sl, sr = [], [], [], []
    for t in turns:
        for key, cell in t["ablation"].items():
            if not (cell["gate_matching_selective"]["passed"]
                    and cell["gate_treatment_vs_random"]["passed"]):
                continue
            lo.append(cell["arms"]["lowattn"]["delta_nll"])
            rd.append(cell["arms"]["random"]["delta_nll"])
            sl.append(float(cell["arms"]["lowattn"]["splices"]))
            sr.append(float(cell["arms"]["random"]["splices"]))
    if lo:
        diff = np.asarray(lo) - np.asarray(rd)
        dsp = np.asarray(sl) - np.asarray(sr)
        matched = np.abs(dsp) <= 1.0
        out["ablation"] = {
            "n_cells": len(diff), "mean_diff": float(diff.mean()),
            "d": float(diff.mean() / diff.std(ddof=1)) if len(diff) > 1 and diff.std(ddof=1) else 0.0,
            "wins": int((diff < 0).sum()),
            "mean_splice_diff": float(dsp.mean()),
            "rho_splice_vs_advantage": sig.spearman(dsp, diff),
            "splice_matched_n": int(matched.sum()),
            "splice_matched_mean_diff": float(diff[matched].mean()) if matched.sum() else None,
            "splice_matched_wins": int((diff[matched] < 0).sum()) if matched.sum() else None,
        }
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("results")
    ap.add_argument("--min-frac", type=float, default=0.5)
    args = ap.parse_args()
    res = json.loads(Path(args.results).read_text())

    for name, floor in (("same-device (governs the gate)", FLOOR_SAME_DEVICE),
                        ("cross-device (governs absolute quotes)", FLOOR_CROSS_DEVICE)):
        a = analyse(res, floor, args.min_frac)
        print(f"\n{'='*72}\nFLOOR {floor:.2e}  — {name}")
        print(f"  analysable turns: {a['n_analysable']}/{a['n_all']} "
              f"across {len(a['sessions'])} sessions")
        if a["n_analysable"] == 0:
            continue
        p = a["pooled"]
        print(f"  POOLED over {p['n_rows']} rows:")
        print(f"    mass|len {p['partial_mass_given_length']:+.3f}   "
              f"position|len {p['partial_position_given_length']:+.3f}   "
              f"=> F2 margin {p['F2_margin_pooled']:+.3f}")
        t = a["per_turn"]
        print(f"  PER-TURN margin: median {t['F2_margin_median']:+.3f} "
              f"mean {t['F2_margin_mean']:+.3f} sd {t['F2_margin_sd']:.3f} "
              f"wins {t['wins']}/{t['n']}")
        for s, v in a["per_session"].items():
            print(f"      {s[:34]:34s} n={v['n']:2d} mean {v['mean_margin']:+.3f} "
                  f"wins {v['wins']}/{v['n']}")
        print(f"  noise-ties below floor: {a['noise_ties_frac']*100:.0f}%")
        if "ablation" in a:
            b = a["ablation"]
            print(f"  ABLATION (n={b['n_cells']} cells): lowattn-random mean {b['mean_diff']:+.5f} "
                  f"d={b['d']:+.3f} wins {b['wins']}/{b['n_cells']}")
            print(f"    mean splice diff {b['mean_splice_diff']:+.2f}, "
                  f"rho(splice diff, advantage) = {b['rho_splice_vs_advantage']:+.3f}")
            if b["splice_matched_n"]:
                print(f"    SPLICE-MATCHED cells (n={b['splice_matched_n']}): "
                      f"mean {b['splice_matched_mean_diff']:+.5f} "
                      f"wins {b['splice_matched_wins']}/{b['splice_matched_n']}")
    print(f"\n{'='*72}")
    print("The two floors are not alternatives to choose between for convenience:")
    print("  gate on the same-device floor (internal comparisons are same-device),")
    print("  quote absolute dNLL against the cross-device floor (that is their accuracy).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
