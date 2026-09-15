#!/usr/bin/env python3
"""
Attention over history — the GPU half. Replays a real agent transcript through an
open-weights model, reads out per-unit attention, measures the CAUSAL effect of
deleting each unit, and runs the volume-matched ablation arms.

Rerun:
  # stage 1, the cheap kill probe (~4 min GPU, one session)
  PYTHONNOUSERSITE=1 HF_HUB_OFFLINE=1 CT_ATTN_DEVICE=cuda:1 \
    /home/realdanielbyrne/.unsloth/studio/unsloth_studio/bin/python \
    experiments/attention-over-history/measure.py --stage probe

  # stage 2+3, the primary run (~30 min GPU, all committed sessions)
  PYTHONNOUSERSITE=1 HF_HUB_OFFLINE=1 CT_ATTN_DEVICE=cuda:1 \
    /home/realdanielbyrne/.unsloth/studio/unsloth_studio/bin/python \
    experiments/attention-over-history/measure.py --stage primary

Unit tests for everything this file does NOT need a GPU for:
  /mnt/data/ctx-swebench/tooling/venv/bin/python -m unittest discover \
      -s experiments/attention-over-history -p 'test_*.py'


WHY THIS IS NOT `output_attentions=True`
----------------------------------------
The obvious implementation asks transformers for the attention matrices. It is
not merely slow, it is impossible here. At the measured pilot shape — 16 layers,
32 heads, 9,985 tokens — the full set of T x T matrices is

    16 * 32 * 9985^2 * 4 bytes = 204 GB

against 4.9 GiB of spare VRAM. But the experiment never needs a T x T matrix: it
needs ONE ROW, the distribution the final position attends with. That row is
O(L*H*T) — **19.5 MiB measured** — a 10,000x reduction, and it is exact, not an
approximation.

The mechanism is a custom entry in transformers' `AttentionInterface`. Every
attention module dispatches through it AFTER RoPE and AFTER the GQA key
expansion, so the hook sees exactly the query and key the model uses; it computes
softmax(q_last . K^T * scaling), stores the row, and delegates the real output to
SDPA so the forward pass is unperturbed. Verified: every captured row sums to
1.0000, and the forward runs at 0.114 s for 8,289 tokens.

The other memory wall is NOT attention: it is the vocabulary logits. A full
[T, 128256] float tensor OOMs at 2.68 GiB. `logits_to_keep` bounds it to the
continuation window.

WHY LEAVE-ONE-UNIT-OUT IS THE PRIMARY QUANTITY, NOT ATTENTION
-------------------------------------------------------------
Raw attention weights are a contested proxy for causal importance — the
attention-is-not-explanation literature is a decade deep, and this codebase has
already been burned by a signal that correlated with something real but caused
nothing. So the design does not ask the model to be believed. It MEASURES the
counterfactual directly: remove unit u, re-run, and record how much harder the
agent's actual continuation became. That is the ground truth, it needs no
attention export at all, and on this hardware it costs 0.11 s per unit.

Attention is then demoted to what it can honestly be: a CHEAP PREDICTOR of that
expensive truth, whose entire value is its rank correlation with it. The
hypothesis becomes falsifiable without anyone having to agree about what
attention "means".
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import attn_signal as sig  # noqa: E402  (local module; the pure half)

REPO = Path(__file__).resolve().parents[2]
FIXTURES = REPO / "packages" / "cli" / "test" / "fixtures"
OUT_DIR = REPO / "reports" / "metrics" / "attention-over-history"

DEVICE = os.environ.get("CT_ATTN_DEVICE", "cuda:1")
MODEL = os.environ.get("CT_ATTN_MODEL", "meta-llama/Llama-3.2-1B-Instruct")

#: Units younger than this are the protected recency anchor and are never
#: candidates for eviction — mirrors `policies.mjs` DEFAULT_ANCHOR so the offline
#: measurement and the live policy agree about what is evictable.
ANCHOR = int(os.environ.get("CT_ANCHOR", "4"))
#: Fraction of evictable TOKENS each arm must remove. Swept, not assumed.
KEEP_FRACTIONS = (0.15, 0.30, 0.50)
#: Continuation length in tokens for the primary endpoint. Longer is less noisy
#: but drifts further from the decision point; swept in the probe stage.
CONT_TOKENS = int(os.environ.get("CT_CONT_TOKENS", "160"))
#: Tokens of the agent's real next message appended BEFORE the attention readout,
#: so the last row is taken at a genuine generation position rather than at
#: whatever token the previous tool result happened to end on.
#:
#: This is not a detail. Reading the last row at the end of the raw transcript
#: collapsed the partial correlation with the causal effect to +0.05; reading it
#: after a short generation prefix — the model mid-decision, which is the state
#: the hypothesis is actually about — put it at +0.39..+0.66 on the same
#: transcript. The signal is defined at the decision point or it is not defined.
GEN_PREFIX_TOKENS = int(os.environ.get("CT_GEN_PREFIX", "12"))
#: Rows averaged for the readout: the last R query positions of the context.
#: R>1 smooths a single position's idiosyncrasy. Swept over {1, 8, 32}.
READOUT_ROWS = int(os.environ.get("CT_READOUT_ROWS", "1"))
#: Replicates of the random control. One seeded draw gives the comparator no
#: variance estimate, so `lowattn - random` cannot be judged against the spread
#: of `random` itself.
N_RANDOM_DRAWS = int(os.environ.get("CT_RANDOM_DRAWS", "5"))
#: Measured numerical floor of the dNLL endpoint, RMS, from `floor.py` — the
#: disagreement between two numerically-equivalent ways of computing the SAME
#: shape-changing edit (default vs MATH kernel; bf16 GPU vs fp32 CPU). It is NOT
#: zero: an earlier version reported zero from a repeat-scoring probe, which
#: measures determinism rather than accuracy. Re-run `floor.py` if the model,
#: dtype or kernel changes.
FLOOR_RMS_DELTA_NLL = float(os.environ.get("CT_FLOOR_DNLL", "2.48e-2"))
#: Same-device floor (default vs MATH kernel, same GPU, same dtype). This is the
#: one that bounds INTERNAL comparisons — every contrast this design makes is
#: between two forwards on the same card in the same dtype. Gate on this; quote
#: absolute values against the cross-device figure above.
FLOOR_SAME_DEVICE = float(os.environ.get("CT_FLOOR_SAME_DEVICE", "6.30e-3"))
MAX_UNIT_TOKENS = 900
MAX_PROMPT_TOKENS = int(os.environ.get("CT_MAX_PROMPT", "14000"))
#: First turn index measured. Needs enough history for a ranking problem to
#: exist: >= 12 units, of which >= 10 are outside the recency anchor.
START_UPTO = int(os.environ.get("CT_START_UPTO", "14"))
#: V1: a turn is analysable only if this fraction of its units produce a deletion
#: effect above the numerical floor. Below it, the per-unit ranking IS the
#: rounding error and any correlation computed on the turn is meaningless.
MIN_FRACTION_ABOVE_FLOOR = float(os.environ.get("CT_MIN_ABOVE_FLOOR", "0.5"))
#: V1 gates on the SAME-DEVICE floor; see FLOOR_SAME_DEVICE.
GATE_FLOOR = FLOOR_SAME_DEVICE


# ---------------------------------------------------------------------------
# attention capture
# ---------------------------------------------------------------------------

class LastRowCapture:
    """
    Captures the final `n_rows` query positions' attention distributions, per
    layer and head, without ever materialising a T x T matrix.

    THE READOUT MUST HAPPEN ON A FORWARD OVER THE CONTEXT ALONE.
    An earlier version of this file captured during the same forward that scored
    the continuation — i.e. over `cat([ctx, cont])` — so the "last row" was the
    last token of the 160-token CONTINUATION. That is fatal three times over:
    the predictor is conditioned on the very thing it is predicting; the signal
    is not computable at eviction time, so `attn-policy.mjs` could never
    reproduce it; and a large share of the mass lands on continuation tokens that
    do not exist yet. `capture_context` below runs its own forward over the
    context and asserts the captured width equals the context length, so the
    defect cannot recur silently.
    """

    def __init__(self, n_rows: int = 1) -> None:
        self.rows: dict[int, "object"] = {}
        self.enabled = False
        self.n_rows = n_rows

    def install(self):
        import torch
        from transformers import AttentionInterface
        from transformers.integrations.sdpa_attention import sdpa_attention_forward

        def repeat_kv(x, n):
            b, kvh, t, d = x.shape
            if n == 1:
                return x
            return x[:, :, None].expand(b, kvh, n, t, d).reshape(b, kvh * n, t, d)

        def fn(module, query, key, value, attention_mask, dropout=0.0, scaling=None,
               sliding_window=None, **kwargs):
            if self.enabled:
                # This readout reconstructs a DENSE causal row. A sliding-window
                # layer would mask keys the reconstruction still counts, so the
                # captured row would not be the row the model used.
                if sliding_window is not None:
                    raise RuntimeError(
                        f"layer {module.layer_idx} uses sliding_window={sliding_window}; "
                        "the dense last-row reconstruction is invalid for this model")
                with torch.no_grad():
                    r = min(self.n_rows, query.shape[2])
                    q = query[:, :, -r:, :]
                    k = repeat_kv(key, module.num_key_value_groups)
                    s = (q.float() @ k.float().transpose(-1, -2)) * (scaling or 1.0)
                    # causal mask over the captured rows: row j (counting from the
                    # end) may not attend to the final j positions
                    t_len = k.shape[2]
                    for j in range(r):
                        stop = t_len - (r - 1 - j)
                        s[:, :, j, stop:] = float("-inf")
                    a = torch.softmax(s, dim=-1)          # [1, H, r, T]
                    self.rows[module.layer_idx] = a[0].mean(dim=1).cpu()   # [H, T]
            return sdpa_attention_forward(module, query, key, value, attention_mask,
                                          dropout=dropout, scaling=scaling,
                                          sliding_window=sliding_window, **kwargs)

        AttentionInterface.register("ct_lastrow", fn)
        return "ct_lastrow"

    def tensor(self, expect_t: int | None = None) -> np.ndarray:
        """[L, H, T] float64. Asserts the rows are genuine distributions and — the
        guard for the defect described above — that they are exactly as wide as
        the context that was supposed to be read."""
        if not self.rows:
            raise RuntimeError("no attention captured; was `enabled` set?")
        arr = np.stack([self.rows[k].numpy() for k in sorted(self.rows)]).astype(np.float64)
        sums = arr.sum(axis=-1)
        if not np.allclose(sums, 1.0, atol=1e-3):
            raise RuntimeError(f"captured rows are not distributions: "
                               f"sum range {sums.min():.5f}..{sums.max():.5f}")
        if expect_t is not None and arr.shape[-1] != expect_t:
            raise RuntimeError(
                f"attention was captured over {arr.shape[-1]} tokens but the context is "
                f"{expect_t}; the readout ran on the wrong forward pass")
        return arr


# ---------------------------------------------------------------------------
# transcript -> units
# ---------------------------------------------------------------------------

def load_claude_code_units(path: Path, limit: int = 200, skip: int = 10) -> list[str]:
    """
    Flatten a committed Claude Code JSONL transcript into UNITS.

    A unit is one assistant message TOGETHER WITH the tool results it produced —
    the definition `coding-harness/lib.mjs extractUnits` uses (an assistant
    message with tool_calls travels with all its following tool messages), so an
    eviction decision here means the same thing as one in the live A/B.

    An earlier version emitted the assistant message and each tool result as
    SEPARATE units while claiming this pairing in its docstring. Every
    single-unit deletion therefore orphaned a tool_call from its tool_result —
    a malformed transcript that `attn-policy.test.mjs` asserts the live policy
    never produces, so a share of the measured "causal effect" was the model
    reacting to a structural violation rather than to lost information. The
    pairing below is the fix, and `assert_units_wellformed` is the guard.

    `skip` drops the session preamble (hook output, plugin banners), which is
    boilerplate no policy would be asked to rank.
    """
    # Units are built as mutable part-lists and joined at the end, because a
    # tool_result does NOT always arrive immediately after its call: real
    # sessions interleave, and a result can land after a later assistant message.
    # Attaching by ARRIVAL ORDER therefore orphans calls; attaching by
    # `tool_use_id` OWNERSHIP is the only correct rule.
    parts: list[list[str]] = []
    owner: dict[str, int] = {}
    orphan_results = 0

    with path.open() as f:
        for line in f:
            try:
                e = json.loads(line)
            except Exception:
                continue
            if e.get("type") not in ("user", "assistant"):
                continue
            arr = e.get("message", {}).get("content")
            arr = arr if isinstance(arr, list) else []

            if e["type"] == "assistant":
                txt = " ".join(b.get("text", "") for b in arr if b.get("type") == "text")
                calls = [b for b in arr if b.get("type") == "tool_use"]
                for b in calls:
                    txt += (f"\n<tool_call id={b.get('id')} name={b.get('name')}>"
                            f"{json.dumps(b.get('input', {}))[:1500]}</tool_call>")
                txt = txt.strip()
                if not txt:
                    continue
                parts.append([f"[assistant] {txt}"])
                for b in calls:
                    if b.get("id"):
                        owner[b["id"]] = len(parts) - 1
            else:
                results = [b for b in arr if b.get("type") == "tool_result"]
                if results:
                    for tr in results:
                        uid = tr.get("tool_use_id")
                        idx = owner.get(uid)
                        if idx is None:
                            orphan_results += 1     # its call was never emitted
                            continue
                        o = tr.get("content")
                        if isinstance(o, list):
                            o = "".join(x.get("text", "") for x in o)
                        parts[idx].append(f"\n<tool_result for={uid}>"
                                          f"{str(o)[:3000]}</tool_result>")
                else:
                    c = e["message"].get("content")
                    txt = c if isinstance(c, str) else " ".join(
                        b.get("text", "") for b in arr if b.get("type") == "text")
                    txt = (txt or "").strip()
                    if txt:
                        parts.append([f"[user] {txt}"])
            if len(parts) >= limit + skip + 40:      # slack: later results still attach
                break

    units = [f"\n{''.join(p).strip()}\n" for p in parts if len(''.join(p).strip()) >= 40]
    if orphan_results:
        print(f"  [{path.name}] {orphan_results} tool_results whose call was not emitted "
              f"(dropped, not orphaned into a unit)")
    return units[skip:skip + limit]


def dedupe_sessions(paths: list[Path]) -> list[Path]:
    """
    Collapse fixtures that are the SAME session to one file each, keeping the
    longest.

    `claude-code-session-4.jsonl` is a strict prefix-subset of
    `claude-code-session-5.jsonl`: identical `sessionId`
    (11bef7b8-695b-49c0-aa70-4b3a49590f06) and 1584/1584 shared event uuids. The
    five committed fixtures are therefore FOUR distinct sessions.

    This matters more than it looks. Every headline statistic in this design is
    clustered by session, and a session-clustered bootstrap that treats a
    duplicated pair as two independent clusters is anti-conservative in exactly
    the direction that manufactures a positive F2 — the duplicate would vote
    twice. Deduplicating is not tidiness, it is the difference between 4 real
    clusters and 5 fake ones.
    """
    by_sid: dict[str, tuple[int, Path]] = {}
    for p in paths:
        sid, n = None, 0
        with p.open() as f:
            for line in f:
                try:
                    e = json.loads(line)
                except Exception:
                    continue
                n += 1
                if sid is None and e.get("sessionId"):
                    sid = e["sessionId"]
        key = sid or p.name
        if key not in by_sid or n > by_sid[key][0]:
            by_sid[key] = (n, p)
    kept = sorted((v[1] for v in by_sid.values()), key=lambda q: q.name)
    dropped = [p.name for p in paths if p not in kept]
    if dropped:
        print(f"corpus dedup: {len(paths)} files -> {len(kept)} distinct sessions "
              f"(dropped duplicates: {', '.join(dropped)})")
    return kept


def assert_units_wellformed(units: list[str]) -> None:
    """Every tool_result must sit in the same unit as the tool_call it answers.

    This is the structural invariant the live harness guarantees and that the
    previous loader broke. Checked once per session rather than trusted."""
    import re
    for i, u in enumerate(units):
        ids = set(re.findall(r"<tool_call id=([^\s>]+)", u))
        for rid in re.findall(r"<tool_result for=([^>]+)>", u):
            if rid not in ids:
                raise RuntimeError(
                    f"unit {i}: tool_result {rid!r} has no tool_call in the same unit "
                    f"(have {sorted(ids)})")


# ---------------------------------------------------------------------------
# the measurement
# ---------------------------------------------------------------------------

class Replayer:
    def __init__(self, model_name: str = MODEL, device: str = DEVICE):
        import torch
        from transformers import AutoTokenizer, AutoModelForCausalLM
        self.torch = torch
        self.cap = LastRowCapture(n_rows=READOUT_ROWS)
        impl = self.cap.install()
        self.device = device
        self.tok = AutoTokenizer.from_pretrained(model_name)
        self.model = AutoModelForCausalLM.from_pretrained(
            model_name, dtype=torch.bfloat16, attn_implementation=impl).to(device).eval()
        self.head = self.tok("You are a coding assistant. Below is the session "
                             "transcript so far.\n", return_tensors="pt").input_ids[0]

    def encode(self, units: list[str]):
        return [self.tok(u, add_special_tokens=False,
                         return_tensors="pt").input_ids[0][:MAX_UNIT_TOKENS] for u in units]

    def build(self, enc: list, upto: int, gen_prefix=None):
        """Context = pinned head + units[:upto] + a short prefix of the agent's
        real next message. `spans` covers the EVICTABLE units only; the head and
        the generation prefix are outside it and their mass becomes the reported
        sink fraction."""
        chunks, spans, p = [self.head], [], len(self.head)
        for t in enc[:upto]:
            spans.append((p, p + len(t)))
            p += len(t)
            chunks.append(t)
        if gen_prefix is not None and len(gen_prefix):
            chunks.append(gen_prefix)
        return self.torch.cat(chunks).unsqueeze(0).to(self.device), spans

    def cut(self, ids, spans, drop: set[int], filler=None):
        """Remove the dropped units. With `filler`, substitute a same-length span
        of neutral tokens instead of deleting, which holds every later token's
        POSITION fixed.

        The substitution arm is not optional decoration. Deleting a unit does two
        things at once: it removes content, and it shifts every subsequent token
        to a lower position index, changing its RoPE phase. A raw
        leave-one-unit-out effect is the sum of both. Only the difference between
        deletion and same-length substitution isolates the part that is about
        WHAT was removed — which is the only part an eviction policy can act on."""
        seg, prev = [], 0
        for i, (a, b) in enumerate(spans):
            if i in drop:
                seg.append(ids[0, prev:a])
                if filler is not None:
                    seg.append(filler[: b - a].to(ids.device))
                prev = b
        seg.append(ids[0, prev:])
        return self.torch.cat(seg).unsqueeze(0)

    def make_filler(self, n: int):
        """Neutral, low-information padding used by the substitution control."""
        base = self.tok("\n[note] (content elided)\n", add_special_tokens=False,
                        return_tensors="pt").input_ids[0]
        reps = (n // len(base)) + 2
        return self.torch.cat([base] * reps)[:n]

    def score(self, ctx_ids, cont_ids):
        """(next-token logprobs, mean NLL of the teacher-forced continuation).

        NEVER captures attention — see `LastRowCapture`. Capture happens in
        `capture_context`, on a forward over the context alone."""
        torch = self.torch
        full = torch.cat([ctx_ids[0], cont_ids]).unsqueeze(0)
        k = len(cont_ids) + 1
        with torch.no_grad():
            out = self.model(full, use_cache=False, logits_to_keep=k)
        lg = out.logits[0].float()
        nxt = torch.log_softmax(lg[0], dim=-1)
        lp = torch.log_softmax(lg[:len(cont_ids)], dim=-1)
        nll = float(-lp[torch.arange(len(cont_ids)), cont_ids].mean())
        return nxt.cpu().numpy(), nll

    def capture_context(self, ctx_ids):
        """
        Read attention from a forward over the CONTEXT ONLY.

        This is the signal an eviction policy could actually compute: at decision
        time the continuation does not exist. The returned tensor is asserted to
        be exactly `len(ctx)` wide, which is the guard against the readout
        silently drifting onto a longer sequence again.
        """
        torch = self.torch
        self.cap.rows.clear()
        self.cap.enabled = True
        try:
            with torch.no_grad():
                self.model(ctx_ids, use_cache=False, logits_to_keep=1)
        finally:
            self.cap.enabled = False
        return self.cap.tensor(expect_t=int(ctx_ids.shape[1]))


def measure_turn(rp: Replayer, enc: list, upto: int, *, layers: str, head_agg: str,
                 keep_fractions=KEEP_FRACTIONS, seed: int = 0) -> dict | None:
    """One turn: signal, per-unit causal effect, and the matched ablation arms."""
    nxt_unit = enc[upto]
    if len(nxt_unit) < GEN_PREFIX_TOKENS + 24:
        return None
    gen_prefix = nxt_unit[:GEN_PREFIX_TOKENS]
    cont = nxt_unit[GEN_PREFIX_TOKENS:GEN_PREFIX_TOKENS + CONT_TOKENS].to(rp.device)
    ids, spans = rp.build(enc, upto, gen_prefix)
    if ids.shape[1] > MAX_PROMPT_TOKENS or len(spans) < 12:
        return None

    t0 = time.time()
    # (1) attention, from a forward over the CONTEXT ALONE — the only reading a
    #     policy could compute at eviction time.
    attn = rp.capture_context(ids)
    # cache the per-unit-per-layer-per-head tensor so the 15-cell aggregation
    # sweep is recomputed offline from ONE GPU pass instead of fifteen
    unit_lhu = sig._unit_sums(attn, spans).astype(np.float32)
    signal = sig.per_unit_mass(attn, spans, layers=layers, head_agg=head_agg)
    lengths = signal.lengths

    # (2) baseline score, on its own forward, capture OFF
    base_nxt, base_nll = rp.score(ids, cont)

    # --- the CANDIDATE set ---------------------------------------------------
    # Statistics must be computed over exactly the units a policy may evict. The
    # protected recency anchor is out of the policy's reach, so including it in
    # the correlation would let the statistic be carried by units no arm can
    # touch.
    cands = list(range(max(0, len(spans) - ANCHOR)))
    if len(cands) < 10:
        return None

    # --- pre-registered gates on the signal itself ---------------------------
    mass_c = signal.mass[cands]
    g_inert = sig.inertness_gate(mass_c)
    g_relabel = sig.relabelling_gate(mass_c, cands)

    # --- ground truth: leave-one-unit-out, over the candidates ---------------
    # plus the same-length substitution control, so the position-shift component
    # of the deletion effect can be subtracted rather than assumed away.
    filler = rp.make_filler(int(lengths.max()))
    louo_nll, louo_kl, subst_nll = [], [], []
    for i in cands:
        nxt, nll = rp.score(rp.cut(ids, spans, {i}), cont)
        louo_nll.append(sig.delta_nll(base_nll, nll))
        louo_kl.append(sig.kl_divergence(base_nxt, nxt))
        _, nll_s = rp.score(rp.cut(ids, spans, {i}, filler=filler), cont)
        subst_nll.append(sig.delta_nll(base_nll, nll_s))

    # --- V1, the RESOLUTION gate --------------------------------------------
    # A turn whose deletion effects mostly sit under the numerical floor cannot
    # rank its units, so a correlation computed on it is a correlation with
    # rounding error. Early turns are small; their units are small; their
    # deletions are small. This gate is what makes turn selection a property of
    # the endpoint's resolution rather than of where the loop happened to start.
    above = float(np.mean(np.abs(np.asarray(louo_nll)) > GATE_FLOOR))
    g_resolution = sig.GateResult(above >= MIN_FRACTION_ABOVE_FLOOR,
                                  {"fraction_above_floor": above,
                                   "floor": GATE_FLOOR,
                                   "min_fraction": MIN_FRACTION_ABOVE_FLOOR,
                                   "median_abs_dnll": float(np.median(np.abs(louo_nll)))})

    pos = [float(i) for i in cands]
    len_c = [float(lengths[i]) for i in cands]
    dens_c = [float(signal.density[i]) for i in cands]
    corr = {
        "mass_vs_louo": sig.spearman(mass_c, louo_nll),
        "density_vs_louo": sig.spearman(dens_c, louo_nll),
        "position_vs_louo": sig.spearman(pos, louo_nll),
        "length_vs_louo": sig.spearman(len_c, louo_nll),
        "mass_vs_position": sig.spearman(mass_c, pos),
        "mass_vs_length": sig.spearman(mass_c, len_c),
        # THE PRIMARY STATISTIC: does attention beat length at predicting the
        # causal effect, and does it beat position?
        "partial_mass_given_length": sig.partial_spearman(mass_c, louo_nll, len_c),
        "partial_mass_given_length_position": sig.partial_spearman(mass_c, louo_nll, len_c, pos),
        "partial_position_given_length": sig.partial_spearman(pos, louo_nll, len_c),
        # Substitution control: same length in, content out. `subst` isolates the
        # CONTENT effect from the position-shift effect that deletion also causes.
        "mass_vs_subst": sig.spearman(mass_c, subst_nll),
        "position_vs_subst": sig.spearman(pos, subst_nll),
        "partial_mass_given_length_subst": sig.partial_spearman(mass_c, subst_nll, len_c),
        "partial_position_given_length_subst": sig.partial_spearman(pos, subst_nll, len_c),
        "louo_vs_subst": sig.spearman(louo_nll, subst_nll),
        # dKL is computed and stored but is BELOW ITS OWN NUMERICAL FLOOR at this
        # precision (float32 KL from a bf16 forward; ulp ~1e-6 at |log p| ~ 10,
        # while ~45% of values are < 1e-6 and some are negative, which KL cannot
        # be). It is retained only so the defect stays visible in the artefact,
        # and NOTHING may be concluded from it — see DESIGN.md §4.1.
        "UNRELIABLE_mass_vs_louo_kl": sig.spearman(mass_c, louo_kl),
        "UNRELIABLE_louo_nll_vs_louo_kl": sig.spearman(louo_nll, louo_kl),
    }

    # --- volume-matched ablation arms ----------------------------------------
    arms_out = {}
    for frac in keep_fractions:
        target = frac * float(sum(lengths[i] for i in cands))
        # quota seed is deliberately distinct from the control-arm seeds, so the
        # random arm is not correlated with the quota draw that shapes every arm
        quota = sig.stratified_quota(lengths, cands, target, seed=seed + 1000)
        kw = dict(target_tokens=target)
        drops = {
            "lowattn": sig.stratified_drop(sig.order_low_attention(signal.mass, cands), lengths, quota, **kw),
            "highattn": sig.stratified_drop(sig.order_high_attention(signal.mass, cands), lengths, quota, **kw),
            "residattn": sig.stratified_drop(sig.order_residual_attention(signal.mass, cands), lengths, quota, **kw),
            "oldest": sig.stratified_drop(sig.order_oldest(cands), lengths, quota, **kw),
            # CEILING. Ranked by the ground truth itself, but forced through the
            # SAME stratified quota as every other arm, so it cannot win by
            # keeping more tokens or more units. If it could, it would prove
            # nothing — that is the flaw that voided the sensitivity control.
            "oracle": sig.stratified_drop(sig.order_oracle(louo_nll, cands), lengths, quota, **kw),
        }
        # the control gets REPLICATES: one seeded draw gives the comparator no
        # variance estimate at all, so `lowattn - random` could not be judged
        # against the spread of random itself.
        rand_draws = {}
        for s in range(N_RANDOM_DRAWS):
            rand_draws[f"random{s}"] = sig.stratified_drop(
                sig.order_random(cands, seed=seed + s), lengths, quota, **kw)
        cell = {}
        for name, d in {**drops, **rand_draws}.items():
            _, nll = rp.score(rp.cut(ids, spans, set(d.indices)), cont)
            cell[name] = {**d.as_dict(), "delta_nll": sig.delta_nll(base_nll, nll)}
        rvals = [cell[k]["delta_nll"] for k in rand_draws]
        cell["random"] = {**rand_draws["random0"].as_dict(),
                          "delta_nll": float(np.mean(rvals)),
                          "delta_nll_sd": float(np.std(rvals, ddof=1)) if len(rvals) > 1 else 0.0,
                          "n_draws": len(rvals),
                          "splices": float(np.mean([rand_draws[k].splices for k in rand_draws]))}
        selective = {k: drops[k] for k in ("lowattn", "highattn", "residattn", "oracle")}
        selective["random"] = rand_draws["random0"]
        arms_out[str(frac)] = {
            "arms": cell,
            "gate_matching_all": sig.matching_gate({**drops, "random": rand_draws["random0"]}).__dict__,
            "gate_matching_selective": sig.matching_gate(selective).__dict__,
            "gate_treatment_vs_random": sig.treatment_gate(drops["lowattn"], rand_draws["random0"]).__dict__,
            "gate_treatment_vs_oldest": sig.treatment_gate(drops["lowattn"], drops["oldest"]).__dict__,
        }

    return {
        "upto": upto, "n_units": len(spans), "n_candidates": len(cands),
        "prompt_tokens": int(ids.shape[1]), "context_tokens": int(ids.shape[1]),
        "cont_tokens": int(len(cont)),
        "base_nll": base_nll, "sink_fraction": signal.sink_fraction,
        "layers": layers, "head_agg": head_agg,
        "gate_inertness": g_inert.__dict__, "gate_relabelling": g_relabel.__dict__,
        "gate_resolution": g_resolution.__dict__,
        "mass": signal.mass.tolist(), "lengths": lengths.tolist(), "candidates": cands,
        "louo_delta_nll": louo_nll, "UNRELIABLE_louo_kl": louo_kl,
        "subst_delta_nll": subst_nll,
        "correlations": corr, "ablation": arms_out,
        "seconds": time.time() - t0,
        "_unit_lhu": unit_lhu,          # stripped into the .npz sidecar by `run`
    }


def _git_sha() -> str:
    import subprocess
    try:
        return subprocess.run(["git", "rev-parse", "HEAD"], cwd=REPO, capture_output=True,
                              text=True, timeout=10).stdout.strip() or "unknown"
    except Exception:
        return "unknown"


def run(stage: str, sessions: list[Path], layers: str, head_agg: str,
        turn_stride: int, max_turns: int) -> tuple[dict, list]:
    import torch
    import transformers
    rp = Replayer()
    results, tensors = [], []
    skipped = {"too_long": 0, "too_few_units": 0, "short_continuation": 0}
    for path in sessions:
        units = load_claude_code_units(path)
        assert_units_wellformed(units)           # blocker-4 guard, per session
        enc = rp.encode(units)
        n = 0
        for upto in range(START_UPTO, len(enc) - 1, turn_stride):
            r = measure_turn(rp, enc, upto, layers=layers, head_agg=head_agg)
            if r is None:
                skipped["too_long"] += 1          # attributed below by re-check
                continue
            r["session"] = path.name
            tensors.append(r.pop("_unit_lhu"))
            results.append(r)
            n += 1
            c = r["correlations"]
            print(f"{path.name[:28]:28s} u={r['n_units']:3d}/{r['n_candidates']:3d} "
                  f"T={r['prompt_tokens']:6d} sink={r['sink_fraction']*100:4.1f}% "
                  f"mass|len={c['partial_mass_given_length']:+.3f} "
                  f"pos|len={c['partial_position_given_length']:+.3f} "
                  f"mass~pos={c['mass_vs_position']:+.3f} "
                  f"inert={'ok' if r['gate_inertness']['passed'] else 'FAIL'} "
                  f"({r['seconds']:.1f}s)", flush=True)
            if n >= max_turns:
                break
        print(f"  [{path.name}] {n} usable turns from {len(enc)} units", flush=True)
    manifest = {
        "stage": stage, "model": MODEL, "device": DEVICE,
        "anchor": ANCHOR, "cont_tokens": CONT_TOKENS,
        "gen_prefix_tokens": GEN_PREFIX_TOKENS, "readout_rows": READOUT_ROWS,
        "n_random_draws": N_RANDOM_DRAWS, "max_prompt_tokens": MAX_PROMPT_TOKENS,
        "max_unit_tokens": MAX_UNIT_TOKENS, "turn_stride": turn_stride,
        "max_turns_per_session": max_turns,
        "keep_fractions": list(KEEP_FRACTIONS),
        "layers": layers, "head_agg": head_agg,
        "sessions": [p.name for p in sessions],
        "turns_skipped": skipped,
        # reproducibility
        "git_sha": _git_sha(), "torch": torch.__version__,
        "transformers": transformers.__version__, "numpy": np.__version__,
        "dtype": "bfloat16", "attn_impl": "ct_lastrow(sdpa)",
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    return {"manifest": manifest, "turns": results}, tensors


def summarise(res: dict) -> None:
    turns = res["turns"]
    if not turns:
        print("no turns measured")
        return
    allturns = turns
    turns = [t for t in allturns if t["gate_resolution"]["passed"]]
    print(f"\nV1 RESOLUTION GATE: {len(turns)}/{len(allturns)} turns analysable "
          f"(>= {MIN_FRACTION_ABOVE_FLOOR:.0%} of units clear the {GATE_FLOOR:.1e} same-device floor)")
    for t in allturns:
        if not t["gate_resolution"]["passed"]:
            g = t["gate_resolution"]["detail"]
            print(f"    excluded upto={t['upto']:3d} ({g['fraction_above_floor']:.0%} above floor, "
                  f"median |dNLL| {g['median_abs_dnll']:.1e})")
    if not turns:
        print("  NO turn is analysable at this resolution; nothing can be concluded.")
        return
    sessions = sorted(set(t["session"] for t in turns))

    def col(k):
        return np.asarray([t["correlations"][k] for t in turns])

    print(f"\n=== {len(turns)} turns, {len(sessions)} sessions ===")
    print("  (per-turn statistics; the median of per-turn rho is NOT a pooled rho —"
          " both are shown where they differ)")
    for k in ("mass_vs_louo", "density_vs_louo", "position_vs_louo", "length_vs_louo",
              "mass_vs_position", "mass_vs_length",
              "partial_mass_given_length", "partial_position_given_length",
              "partial_mass_given_length_position",
              "mass_vs_subst", "position_vs_subst",
              "partial_mass_given_length_subst", "partial_position_given_length_subst",
              "louo_vs_subst"):
        v = col(k)
        print(f"  {k:38s} median {np.median(v):+.3f}  mean {v.mean():+.3f}  sd {v.std(ddof=1):.3f}")

    # POOLED across all (turn x unit) rows, which is a different animal from the
    # median of per-turn correlations and must not be conflated with it.
    allm, alll, allp, allu, alls = [], [], [], [], []
    for t in turns:
        c = t["candidates"]
        allm += [t["mass"][i] for i in c]
        alll += [t["lengths"][i] for i in c]
        allp += list(range(len(c)))
        allu += t["louo_delta_nll"]
        alls += t["subst_delta_nll"]
    print(f"\n  POOLED over {len(allu)} (turn x unit) rows:")
    print(f"    mass_vs_louo          {sig.spearman(allm, allu):+.3f}")
    print(f"    position_vs_louo      {sig.spearman(allp, allu):+.3f}")
    print(f"    length_vs_louo        {sig.spearman(alll, allu):+.3f}")
    print(f"    partial mass|len      {sig.partial_spearman(allm, allu, alll):+.3f}")
    print(f"    partial position|len  {sig.partial_spearman(allp, allu, alll):+.3f}")
    print(f"    louo_vs_subst         {sig.spearman(allu, alls):+.3f}")

    inert = sum(1 for t in turns if t["gate_inertness"]["passed"])
    relab = sum(1 for t in turns if t["gate_relabelling"]["passed"])
    print(f"\n  inertness gate passed {inert}/{len(turns)};  "
          f"relabelling gate passed {relab}/{len(turns)}")

    # ---- endpoint resolution vs the measured numerical floor -----------------
    floor = GATE_FLOOR
    med_abs = np.array([np.median(np.abs(t["louo_delta_nll"])) for t in turns])
    spread = np.array([np.percentile(t["louo_delta_nll"], 90) -
                       np.percentile(t["louo_delta_nll"], 10) for t in turns])
    print(f"\n  dNLL vs floor ({floor:.1e} RMS, cross-kernel):")
    print(f"    per-turn median |dNLL| : {med_abs.min():.2e}..{med_abs.max():.2e} "
          f"({med_abs.mean()/floor:.1f}x floor)")
    print(f"    per-turn p10-p90 spread: {spread.mean():.2e} ({spread.mean()/floor:.1f}x floor)")
    ties = sum(int((np.abs(np.asarray(t["louo_delta_nll"])) < floor).sum()) for t in turns)
    tot = sum(len(t["louo_delta_nll"]) for t in turns)
    print(f"    rows below the floor (noise-ties): {ties}/{tot} = {100*ties/tot:.0f}%")

    # ---- FALSIFICATION F2 ---------------------------------------------------
    print("\n  F2 (mass|len must EXCEED position|len). Per-session clusters listed"
          " individually; with this few clusters a bootstrap CI is not trustworthy.")
    for lbl, a, b in (("dNLL ", "partial_mass_given_length", "partial_position_given_length"),
                      ("subst", "partial_mass_given_length_subst",
                       "partial_position_given_length_subst")):
        d = col(a) - col(b)
        print(f"    {lbl} overall: median {np.median(d):+.3f} mean {d.mean():+.3f} "
              f"sd {d.std(ddof=1):.3f}  wins {int((d > 0).sum())}/{len(d)}")
        for s in sessions:
            idx = [i for i, t in enumerate(turns) if t["session"] == s]
            ds = d[idx]
            print(f"        {s[:34]:34s} n={len(ds):2d} mean {ds.mean():+.3f} "
                  f"wins {int((ds > 0).sum())}/{len(ds)}")

    # ---- ablation, ALL keep-fractions, with splices partialled out ----------
    pooled = {"lowattn": [], "random": [], "highattn": [], "oldest": [], "residattn": [],
              "splice_lo": [], "splice_rd": []}
    for frac in res["manifest"]["keep_fractions"]:
        key = str(frac)
        cells = [t["ablation"][key] for t in turns if key in t["ablation"]]
        ok = [c for c in cells if c["gate_matching_selective"]["passed"]
              and c["gate_treatment_vs_random"]["passed"]]
        print(f"\n  --- ablation, drop {frac:.0%} of evictable tokens "
              f"({len(ok)}/{len(cells)} cells passed the gates) ---")
        if not ok:
            continue
        for arm in ("oracle", "lowattn", "residattn", "oldest", "random", "highattn"):
            v = np.asarray([c["arms"][arm]["delta_nll"] for c in ok])
            s = np.asarray([float(c["arms"][arm]["splices"]) for c in ok])
            extra = ""
            if arm == "random":
                sd = np.asarray([c["arms"][arm].get("delta_nll_sd", 0.0) for c in ok])
                extra = f"  within-cell sd {sd.mean():.5f} over {ok[0]['arms'][arm].get('n_draws', 1)} draws"
            print(f"    {arm:10s} dNLL mean {v.mean():+.5f} median {np.median(v):+.5f}  "
                  f"splices {s.mean():4.1f}{extra}")
            pooled.setdefault(arm, []).extend(v.tolist())
        pooled["splice_lo"].extend([float(c["arms"]["lowattn"]["splices"]) for c in ok])
        pooled["splice_rd"].extend([float(c["arms"]["random"]["splices"]) for c in ok])
        for base in ("oracle", "lowattn"):
            b = np.asarray([c["arms"][base]["delta_nll"] for c in ok])
            for nm in ("random", "oldest", "highattn"):
                if nm == base:
                    continue
                other = np.asarray([c["arms"][nm]["delta_nll"] for c in ok])
                diff = b - other
                sd = diff.std(ddof=1) if len(diff) > 1 else 0.0
                dd = diff.mean() / sd if sd else 0.0
                flag = "  <- WITHIN FLOOR" if abs(diff.mean()) < FLOOR_SAME_DEVICE else ""
                print(f"    {base:9s} - {nm:9s}: mean {diff.mean():+.5f} sd {sd:.5f} "
                      f"d={dd:+.3f}  wins {int((diff < 0).sum())}/{len(diff)}{flag}")

    # POOLED over all fractions — the pre-registered read, not the best fraction
    lo = np.asarray(pooled["lowattn"]); rd = np.asarray(pooled["random"])
    if len(lo) and len(lo) == len(rd):
        diff = lo - rd
        sd = diff.std(ddof=1) if len(diff) > 1 else 0.0
        print(f"\n  POOLED over all keep-fractions (n={len(diff)} cells) — the pre-registered read:")
        print(f"    lowattn - random: mean {diff.mean():+.5f} sd {sd:.5f} "
              f"d={diff.mean()/sd if sd else 0:+.3f}  wins {int((diff < 0).sum())}/{len(diff)}")
        # MAJOR 7: splice count is itself predictive, and lowattn tends to
        # fragment LESS than random, so the contrast is confounded unless the
        # splice difference is partialled out of it.
        dsp = np.asarray(pooled["splice_lo"]) - np.asarray(pooled["splice_rd"])
        print(f"    splice difference (lowattn - random): mean {dsp.mean():+.2f}, "
              f"lowattn fragments less in {int((dsp < 0).sum())}/{len(dsp)} cells")
        print(f"    rho(splice diff, dNLL diff) = {sig.spearman(dsp, diff):+.3f}  "
              f"(positive => the arm's advantage tracks its fragmentation advantage)")
        keep = np.abs(dsp) <= 1.0
        if keep.sum() >= 3:
            d2 = diff[keep]
            sd2 = d2.std(ddof=1) if len(d2) > 1 else 0.0
            print(f"    restricted to SPLICE-MATCHED cells (|d splices| <= 1, n={int(keep.sum())}): "
                  f"mean {d2.mean():+.5f} d={d2.mean()/sd2 if sd2 else 0:+.3f} "
                  f"wins {int((d2 < 0).sum())}/{len(d2)}")


STAGES = {
    # cheapest thing that could kill the idea: one session, every usable turn
    "probe": dict(sessions=["claude-code-session.jsonl"], turn_stride=1, max_turns=24),
    # every distinct session, every usable turn. NOTE the corpus yields ~4
    # clusters and a few dozen turns, NOT the 200/5 the original design assumed —
    # see DESIGN.md 8.1. This stage is EXPLORATORY on this corpus.
    "primary": dict(sessions=None, turn_stride=1, max_turns=40),
}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--stage", choices=sorted(STAGES), default="probe")
    ap.add_argument("--layers", default="all", choices=sorted(sig.LAYER_SETS))
    ap.add_argument("--head-agg", default="mean", choices=list(sig.HEAD_AGGS))
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    cfg = STAGES[args.stage]
    names = cfg["sessions"] or sorted(p.name for p in FIXTURES.glob("claude-code-session*.jsonl"))
    sessions = [FIXTURES / n for n in names]
    missing = [p for p in sessions if not p.exists()]
    if missing:
        print(f"missing fixtures: {missing}", file=sys.stderr)
        return 2
    sessions = dedupe_sessions(sessions)

    res, tensors = run(args.stage, sessions, args.layers, args.head_agg,
                       cfg["turn_stride"], cfg["max_turns"])
    summarise(res)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    base = f"results-{args.stage}-{args.layers}-{args.head_agg}-{stamp}"
    out = Path(args.out) if args.out else OUT_DIR / f"{base}.json"
    out.write_text(json.dumps(res, indent=1))
    # the cached [L,H,U] tensors make the 15-cell aggregation sweep free: every
    # layer-subset x head-rule combination is a different reduction of these,
    # recomputed offline instead of costing another GPU pass each.
    if tensors:
        npz = out.with_suffix(".npz")
        np.savez_compressed(npz, **{f"t{i}": a for i, a in enumerate(tensors)})
        res["manifest"]["tensor_sidecar"] = npz.name
        out.write_text(json.dumps(res, indent=1))
        print(f"wrote {npz}  ({npz.stat().st_size/2**20:.1f} MiB, {len(tensors)} turns)")
    print(f"\nwrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
