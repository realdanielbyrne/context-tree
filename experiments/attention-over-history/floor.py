#!/usr/bin/env python3
"""
Measure the NUMERICAL FLOOR of the dNLL endpoint with a SHAPE-CHANGING edit.

Rerun:
  PYTHONNOUSERSITE=1 HF_HUB_OFFLINE=1 CT_ATTN_DEVICE=cuda:1 \
    /home/realdanielbyrne/.unsloth/studio/unsloth_studio/bin/python \
    experiments/attention-over-history/floor.py

WHY THIS EXISTS, AND WHY THE EARLIER NUMBER WAS WRONG
-----------------------------------------------------
An earlier version of this design reported "the measurement floor is exactly
zero", on the evidence that re-scoring an IDENTICAL tensor twice gives
bit-identical results. That measures DETERMINISM, not ACCURACY. Re-running the
same kernel on the same shape reproduces the same rounding errors, so of course
it agrees with itself.

The quantity that matters is different: `dNLL` is a difference between two
forwards over sequences of DIFFERENT LENGTHS. Changing the sequence length
changes tile boundaries, reduction order and kernel selection, so the two
forwards do not share a rounding path. The floor is therefore the disagreement
between two numerically-equivalent ways of computing the SAME shape-changing
edit. Three probes:

  A. default SDPA kernel vs the MATH backend (different reduction order, same math)
  B. bf16 on GPU vs float32 on CPU (different precision and hardware entirely)
  C. the same edit re-run (determinism only — the number that misled us)

The reported floor is the RMS disagreement of the worst honest pair. Everything
downstream — validity gate V1, the noise-tie fraction, and the claim about how
many decades of dynamic range dNLL really has — is derived from it.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import measure as M           # noqa: E402
import attn_signal as sig     # noqa: E402

DEV = os.environ.get("CT_ATTN_DEVICE", "cuda:1")


def nll_of(model, ctx_ids, cont_ids) -> float:
    full = torch.cat([ctx_ids[0], cont_ids.to(ctx_ids.device)]).unsqueeze(0)
    with torch.no_grad():
        out = model(full, use_cache=False, logits_to_keep=len(cont_ids) + 1)
    lg = out.logits[0].float()
    lp = torch.log_softmax(lg[:len(cont_ids)], dim=-1)
    return float(-lp[torch.arange(len(cont_ids)), cont_ids.to(lg.device)].mean())


def main() -> int:
    rp = M.Replayer()
    units = M.load_claude_code_units(M.FIXTURES / "claude-code-session.jsonl")
    M.assert_units_wellformed(units)
    enc = rp.encode(units)

    import contextlib
    from torch.nn.attention import sdpa_kernel, SDPBackend

    def setup(upto: int, cont_tokens: int = M.CONT_TOKENS, src=None):
        e = enc if src is None else src
        nxt = e[upto]
        gp = nxt[:M.GEN_PREFIX_TOKENS]
        cont = nxt[M.GEN_PREFIX_TOKENS:M.GEN_PREFIX_TOKENS + cont_tokens].to(rp.device)
        ids, spans = rp.build(e, upto, gp)
        cands = list(range(len(spans) - M.ANCHOR))
        return ids, spans, cands, cont

    def sweep(model, ids, spans, cands, cont, backend_ctx=None):
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        with (backend_ctx or contextlib.nullcontext()):
            base = nll_of(model, ids, cont)
            return np.array([nll_of(model, rp.cut(ids, spans, {i}), cont) - base
                             for i in cands])

    def rep(name, a, b):
        e = a - b
        print(f"  {name:38s} max {np.abs(e).max():.3e}   RMS {np.sqrt((e**2).mean()):.3e}")
        return float(np.sqrt((e ** 2).mean()))

    # ---- A. default kernel vs MATH backend ----------------------------------
    # MATH materialises the full T x T score matrix, so it only fits at a reduced
    # context. The floor is length-dependent; this is a LOWER bound measured at
    # ~3k tokens and labelled as such, not silently extrapolated to 10k.
    # MATH allocates 1 x H x T x T x 4 bytes per layer; at H=32 that is 128*T^2
    # bytes, so the context must be chosen by TOKENS, not by unit count.
    # Real units run to 900 tokens, so even 12 of them blow the MATH budget. The
    # probe therefore re-encodes the SAME transcript with a shorter per-unit cap:
    # still real content and still a real shape-changing edit, just a smaller
    # sequence. The resulting floor is labelled as measured at reduced length.
    MATH_T_MAX = int(os.environ.get("CT_FLOOR_MATH_T", "1500"))
    small_cap = 60
    enc_s = [t[:small_cap] for t in enc]
    upto_s = None
    for u in range(12, 60):
        cand_ids, _, cc, _ = setup(u, src=enc_s)
        if cand_ids.shape[1] > MATH_T_MAX or len(cc) < 8:
            break
        upto_s = u
    if upto_s is None:
        print("could not find a context small enough for the MATH probe")
        return 2
    ids_s, spans_s, cands_s, cont_s = setup(upto_s, src=enc_s)
    print(f"\n[A] MATH probe on a re-encoded copy (unit cap {small_cap} tok): "
          f"upto={upto_s}, {ids_s.shape[1]} tok, {len(cands_s)} candidates "
          f"(MATH needs {128*ids_s.shape[1]**2/2**30:.2f} GiB/layer)")
    dA_def = sweep(rp.model, ids_s, spans_s, cands_s, cont_s)
    dA_math = sweep(rp.model, ids_s, spans_s, cands_s, cont_s, sdpa_kernel(SDPBackend.MATH))
    dA_rep = sweep(rp.model, ids_s, spans_s, cands_s, cont_s)

    # ---- full-length working set --------------------------------------------
    upto = 48
    ids, spans, cands, cont = setup(upto)
    print(f"[B] full context: {ids.shape[1]} tok, {len(spans)} units, "
          f"{len(cands)} candidates, continuation {len(cont)} tok")
    d_default = sweep(rp.model, ids, spans, cands, cont)
    d_repeat = sweep(rp.model, ids, spans, cands, cont)

    # ---- B. bf16 GPU vs float32 CPU -----------------------------------------
    print("loading an fp32 CPU copy for the cross-precision probe ...", flush=True)
    from transformers import AutoModelForCausalLM
    cpu = AutoModelForCausalLM.from_pretrained(M.MODEL, dtype=torch.float32,
                                               attn_implementation="sdpa").eval()
    ids_c, cont_c = ids.cpu(), cont.cpu()
    base_c = nll_of(cpu, ids_c, cont_c)
    sub = cands[:20]                     # CPU fp32 is slow; 20 units is enough for RMS
    d_cpu = np.array([nll_of(cpu, rp.cut(ids_c, spans, {i}), cont_c) - base_c for i in sub])
    del cpu

    print("\n=== disagreement on the SAME shape-changing edit ===")
    f_math = rep("A. default vs MATH kernel (~3k ctx)", dA_def, dA_math)
    f_cpu = rep("B. bf16 GPU vs fp32 CPU (full ctx)", d_default[:len(sub)], d_cpu)
    f_rep = rep("C. repeat, same kernel (determinism)", d_default, d_repeat)
    f_repA = rep("C'. repeat at reduced ctx", dA_def, dA_rep)

    floor = max(f_math, f_cpu)
    print(f"\n  FLOOR (worst honest pair, RMS) = {floor:.3e} nats/token")
    print(f"  (the determinism probes report {f_rep:.1e} / {f_repA:.1e} — "
          f"this is the number that misled us)")
    print(f"  suggested constant:  CT_FLOOR_DNLL={floor:.1e}")

    print("\n=== what the floor implies for the endpoint ===")
    a = np.abs(d_default)
    print(f"  per-unit |dNLL|: median {np.median(a):.3e}  p10 {np.percentile(a,10):.3e} "
          f" p90 {np.percentile(a,90):.3e}  max {a.max():.3e}")
    print(f"  median is {np.median(a)/floor:.1f}x the floor")
    print(f"  rows below the floor (noise-ties): {(a < floor).sum()}/{len(a)} "
          f"= {100*(a < floor).sum()/len(a):.0f}%")
    p10, p90 = np.percentile(d_default, 10), np.percentile(d_default, 90)
    print(f"  BETWEEN-UNIT spread p10-p90 = {p90-p10:.3e} = {(p90-p10)/floor:.1f}x the floor")
    print(f"  -> per-unit RANKING near the bottom of the range is floor-limited;")
    print(f"     the between-unit spread is NOT, so aggregate/set-level use survives.")

    # how much does the ranking itself move between kernels?
    # The number that actually governs this design: how reproducible is the
    # per-unit RANK, since every primary statistic is a rank correlation?
    print("\n=== reproducibility of the per-unit RANKING (what the design uses) ===")
    print(f"  spearman(default, MATH)    = {sig.spearman(dA_def, dA_math):+.3f}   "
          f"(same device, same precision, different reduction order; n={len(dA_def)})")
    print(f"  spearman(bf16 GPU, fp32 CPU) = {sig.spearman(d_default[:len(sub)], d_cpu):+.3f}   "
          f"(different device AND precision; n={len(sub)})")
    print(f"  spearman(default, repeat)  = {sig.spearman(d_default, d_repeat):+.3f}   "
          f"(determinism only — uninformative)")
    print("\n  The cross-precision rank correlation is the honest ceiling on how well ANY")
    print("  predictor could correlate with this ground truth. A signal cannot beat the")
    print("  reproducibility of the thing it is predicting.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
