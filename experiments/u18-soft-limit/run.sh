#!/usr/bin/env bash
# U18 — does a soft limit context-tree imposes hold accuracy at ~1/3 of the window?
#
# Rerunnable and resumable: every stage reads what is already on disk and runs only what is
# still owed. A finished cell is never re-run (that would be choosing outcomes); a cell is
# owed again only when the INSTRUMENT failed — killed from outside, no model step, a provider
# that never answered (lib.mjs `instrumentFailure`), criteria that cannot see the grade.
#
#   experiments/u18-soft-limit/run.sh                 # all: preflight → gate → waves → analyze
#   experiments/u18-soft-limit/run.sh config|preflight|gate|waves|analyze
#
#   U18_ARMS="off soft hard"  off = host control, soft = silent eviction at W, hard = plumbing-matched control;
#                             stub = soft + evicted turns stay visible as stubs with a recall id (contract v5),
#                             summary = stub + closed phases fold to a headline summary. The table is lib.mjs ARMS.
#   U18_WINDOW=50347          the soft limit, in HEURISTIC tokens (the swept variable)
#   U18_ANCHOR=3              recency anchor: the last A units (phases) are never evictable
#   U18_<KNOB>=...            every other value that still needs a sweep — eviction weights,
#                             half-life, headroom, drift K/tau, RRF k, chunking, reserve, head
#                             allowance, protected tail, neutral phases, contract. The table,
#                             with defaults, is lib.mjs KNOBS; `run.sh config` prints it resolved.
#                             Each arm's tag carries a hash of its knobs, so settings never pool.
#   U18_LOAD_MODEL=1          load Swift-NVFP4 if the server holds something else (evicts it)
#   U18_ALLOW_DIRTY=1         run from an uncommitted tree (recorded in run-log.jsonl)
#   U18_REGATE=1              run another gate attempt: required after a FAIL, and after a
#                             commit that touched the harness since the last PASS
#
# The pinned model, the sandbox, the prompt and the repeat count are NOT knobs. See README.md.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
cd "$REPO"

MODEL_ID="HuggingJoost/Swift-Qwen3.8-27B-NVFP4-GGUF"
MODEL="local/$MODEL_ID"
VARIANT="Swift-Qwen3.8-27B-NVFP4-Q8mix"
SERVED=151040
REPEATS=3
ARMS="${U18_ARMS:-off soft hard}"
GATE_INSTANCE="django__django-11138"
DRIVER="experiments/context-dedup/swebench-opencode.mjs"
PILOT="reports/metrics/swebench-pilot"
OUT="reports/metrics/u18-soft-limit"
RUNS="/mnt/data/ctx-swebench/opencode-runs"
SERVER="http://127.0.0.1:8888"
# What a gate PASS vouches for: a commit touching any of these after the PASS voids it.
HARNESS_PATHS=(experiments/context-dedup packages experiments/u18-soft-limit)
STAGE="${1:-all}"

die() { echo "u18: $*" >&2; exit 1; }
say() { echo "u18: $*" >&2; }

for a in $ARMS; do [[ "$a" =~ ^(off|soft|hard|stub|summary)$ ]] || die "unknown arm '$a' (lib.mjs ARMS)"; done
[[ " $ARMS " == *" off "* && " $ARMS " == *" soft "* ]] || die "U18 needs at least the off and soft arms"
[[ "${CT_SANDBOX:-1}" != 0 ]] || die "CT_SANDBOX=0 refused: an unsandboxed agent can read the gold patch, and the ct arm silently degrades to its control"

set -a; [[ -f .env ]] && . ./.env; set +a
[[ -n "${UNSLOTH_API_KEY:-}" ]] || die "UNSLOTH_API_KEY missing (.env)"

# The driver reads ~30 CT_* variables and a stray one re-shapes an arm without a trace
# (CT_WINDOW re-declares the host context; CT_G0_* turns a cell into a gate cell). Start clean.
for name in $(compgen -e); do if [[ "$name" == CT_* ]]; then unset "$name"; fi; done

# Two runners would take the same owed cell and leave a duplicate only a human can resolve.
if [[ "$STAGE" != analyze && "$STAGE" != config ]]; then
  mkdir -p "$OUT"
  exec 9>"$RUNS/.u18.lock"
  flock -n 9 || die "another run.sh holds $RUNS/.u18.lock"
fi

server_status() { curl -sf -m 10 -H "Authorization: Bearer $UNSLOTH_API_KEY" "$SERVER/api/inference/status"; }

# The server must hold THIS build at THIS window. Checked before EVERY driver call, not once:
# a run is ~13 h, `cell.model` records the pin rather than what was served, and a swap by
# another session would otherwise be invisible.
assert_served() {
  local status; status="$(server_status)" || die "inference server unreachable at $SERVER"
  local got; got="$(jq -r '[.active_model, .gguf_variant, (.context_length|tostring), (.parallel_slots|tostring)] | join(" ")' <<<"$status")"
  [[ "$got" == "$MODEL_ID $VARIANT $SERVED 4" ]] || die "server holds '$got', expected '$MODEL_ID $VARIANT $SERVED 4'"
}

dirty() { [[ -n "$(git status --porcelain -- . ":!$PILOT/results-*.json" ":!$OUT")" ]]; }

# The knobs are resolved and validated in ONE place (lib.mjs KNOBS); a bad value stops here.
node "$HERE/analyze.mjs" config >/dev/null || die "bad U18_* knob (see above)"
WINDOW="$(node "$HERE/analyze.mjs" env soft | sed -n 's/^CT_CT_WINDOW=//p')"

tag_base() { node "$HERE/analyze.mjs" tag "$1"; }

# One driver invocation. Arm knobs are spelled out in full for every ct arm — including the
# ones left at their defaults — so a changed default upstream cannot move this experiment.
drive() { # arm tag repeat instances
  local arm="$1" tag="$2" repeat="$3" ids="$4"
  local -a armenv=(CT_ARM=off)
  if [[ "$arm" != off ]]; then
    mapfile -t knobs < <(node "$HERE/analyze.mjs" env "$arm")
    # The arm table (lib.mjs ARMS) owns the trigger and anything an arm sets; later entries win.
    armenv=(CT_ARM=ct CT_CT_TRIGGER="$(node "$HERE/analyze.mjs" trigger "$arm")" CT_CT_SUMMARIES=0 CT_CT_CADENCE_N=5 CT_ASSEMBLE_PORT=8899 "${knobs[@]}")
  fi
  assert_served
  jq -nc --arg tag "$tag" --arg arm "$arm" --arg ids "$ids" --arg commit "$(git rev-parse HEAD)" \
     --argjson repeat "$repeat" --argjson dirty "$(dirty && echo true || echo false)" \
     '{ts: (now|todate), tag: $tag, arm: $arm, repeat: $repeat, instances: $ids, commit: $commit, dirty: $dirty}' >> "$OUT/run-log.jsonl"
  env "${armenv[@]}" CT_SANDBOX=1 CT_OPENCODE_MODEL="$MODEL" CT_LOCAL_EXCLUSIVE=1 \
      CT_RUN_TIMEOUT_S=7200 CT_REPEATS=1 CT_REPEAT_START="$repeat" CT_INSTANCES="$ids" CT_TAG="$tag" \
      node "$DRIVER" 2>&1 | tee -a "$RUNS/$tag.log" >&2
}

preflight() {
  say "preflight"
  for t in node opencode bwrap socat jq curl pnpm; do command -v "$t" >/dev/null || die "missing tool: $t"; done
  (( $(node -p 'process.versions.node.split(".")[0]') >= 22 )) || die "Node 22+ required"
  [[ -d /mnt/data/ctx-swebench/tooling/opencode-sandbox ]] || die "sandbox assets missing"

  # Result files are this experiment's own output; everything else — the pool definition in
  # selection-v2.json included — decides what a run executes.
  if dirty && [[ "${U18_ALLOW_DIRTY:-0}" != 1 ]]; then
    die "working tree is dirty: every cell records the commit it ran at. Commit first, or U18_ALLOW_DIRTY=1"
  fi

  local status declared
  status="$(server_status)" || die "inference server unreachable at $SERVER"
  if [[ "$(jq -r .active_model <<<"$status")" != "$MODEL_ID" ]]; then
    [[ "${U18_LOAD_MODEL:-0}" == 1 ]] || die "server holds '$(jq -r .active_model <<<"$status")', not $MODEL_ID. Re-run with U18_LOAD_MODEL=1 to load it (this evicts the current model)"
    say "loading $MODEL_ID"
    curl -sf -X POST "$SERVER/api/inference/load" -H "Authorization: Bearer $UNSLOTH_API_KEY" -H 'Content-Type: application/json' \
      -d "{\"model_path\":\"$MODEL_ID\",\"max_seq_length\":0,\"n_parallel\":4,\"force_reload\":true}" >/dev/null || die "load request failed"
    for _ in $(seq 120); do
      status="$(server_status || true)"
      if [[ "$(jq -r '.active_model // empty' <<<"$status")" == "$MODEL_ID" && "$(jq -r '.context_length // 0' <<<"$status")" -gt 0 ]]; then break; fi
      sleep 5
    done
  fi
  assert_served
  declared="$(jq -r --arg m "$MODEL_ID" '.provider.local.models[$m].limit.context' experiments/context-dedup/opencode.json)"
  [[ "$declared" == "$SERVED" ]] || die "opencode.json declares limit.context=$declared for $MODEL_ID, server serves $SERVED"
  node "$HERE/analyze.mjs" config >&2

  say "building packages (the ct arm imports packages/*/dist)"
  pnpm run -s build >&2 || die "build failed"
  say "unit tests"
  node --test experiments/context-dedup/*.test.mjs experiments/u18-soft-limit/*.test.mjs >/dev/null || die "unit tests failed: node --test experiments/context-dedup/*.test.mjs experiments/u18-soft-limit/*.test.mjs"

  # G0: an in-place edit must reach the provider, or every ct arm is a control in disguise.
  local g0="$PILOT/g0-mutation-visibility.json"
  [[ -f "$g0" && "$(jq -r '.pass' "$g0")" == true && "$(jq -r '.model' "$g0")" == "$MODEL" ]] \
    || die "G0 has no PASS on record for $MODEL: node experiments/context-dedup/g0-mutation-visibility.mjs"
  # A PASS vouches for the plugin -> sidecar -> prompt seam AS IT WAS. Once a commit touches
  # that seam the PASS is about other code, and every ct arm is unproven again.
  local seam_changed g0_at
  seam_changed="$(git log -1 --format=%ct -- experiments/context-dedup packages)"
  g0_at="$(date -d "$(jq -r .at "$g0")" +%s)"
  (( g0_at >= seam_changed )) \
    || die "G0 PASS ($(jq -r .at "$g0")) predates the last change to the harness ($(git log -1 --format='%h %cI' -- experiments/context-dedup packages)). Re-run it (~20 min GPU): node experiments/context-dedup/g0-mutation-visibility.mjs"
  say "preflight ok — $MODEL_ID @ $SERVED, commit $(git rev-parse --short HEAD), G0 PASS $(jq -r .at "$g0")"
}

# One gate attempt per tag, appended to the record — a gate that needed three tries says so,
# and a failed attempt's run dir survives to be read.
gate_one() { # arm
  local arm="$1" status n tag head
  status="$(node "$HERE/analyze.mjs" gate-status "$arm")"
  head="$(git log -1 --format=%H -- "${HARNESS_PATHS[@]}")"
  if [[ "$status" == PASS* ]] && git merge-base --is-ancestor "$head" "${status#PASS }" 2>/dev/null; then
    say "gate $arm: PASS on record at ${status#PASS }"; return
  fi
  if [[ "$status" != NONE && "${U18_REGATE:-0}" != 1 ]]; then
    die "gate $arm: last attempt was '$status' and the harness is at $head. Read the record in $OUT and the attempt's mcp/ct-mcp.jsonl, then U18_REGATE=1 for another attempt"
  fi
  n=1; while [[ -e "$PILOT/results-swebench-opencode-$(tag_base "$arm")-gate-a$n.json" || -e "$RUNS/$(tag_base "$arm")-gate-a$n" ]]; do n=$((n + 1)); done
  tag="$(tag_base "$arm")-gate-a$n"
  say "gate $arm attempt $n: one cell on $GATE_INSTANCE (fills the window; solved 3/3 by the control) — ~30 min"
  drive "$arm" "$tag" 0 "$GATE_INSTANCE" || say "gate $arm: the driver exited non-zero"
  node "$HERE/analyze.mjs" gate "$arm" "$tag" || die "gate $arm FAILED — no wave runs on a failed gate"
}

gate() { for arm in $ARMS; do if [[ "$arm" != off ]]; then gate_one "$arm"; fi; done; }

waves() {
  local arm status head
  head="$(git log -1 --format=%H -- "${HARNESS_PATHS[@]}")"
  for arm in $ARMS; do
    [[ "$arm" == off ]] && continue
    status="$(node "$HERE/analyze.mjs" gate-status "$arm")"
    [[ "$status" == PASS* ]] && git merge-base --is-ancestor "$head" "${status#PASS }" 2>/dev/null \
      || die "no current gate PASS for '$arm' (have: $status): run the gate stage first"
  done
  local -a arms=($ARMS)
  local n=${#arms[@]}
  for (( r = 0; r < REPEATS; r++ )); do
    # Rotate the arm order per wave so no arm always runs first (or last) in wall-clock time.
    for (( k = 0; k < n; k++ )); do
      local base owed tag p=0
      arm="${arms[$(( (k + r) % n ))]}"
      base="$(tag_base "$arm")-w$r"
      owed="$(node "$HERE/analyze.mjs" missing "$arm" "$r")"
      [[ -n "$owed" ]] || { say "wave $r $arm: complete"; continue; }
      tag="$base"
      while [[ -f "$PILOT/results-swebench-opencode-$tag.json" ]]; do p=$((p + 1)); tag="$base-p$p"; done
      say "wave $r $arm → $tag: $(tr ',' '\n' <<<"$owed" | wc -l) cell(s)"
      drive "$arm" "$tag" "$r" "$owed" || say "wave $r $arm: driver exited non-zero; re-run this script to resume what is owed"
    done
  done
}

analyze() { node "$HERE/analyze.mjs" report; }

case "$STAGE" in
  config) node "$HERE/analyze.mjs" config ;;
  preflight) preflight ;;
  gate) preflight; gate ;;
  waves) preflight; waves ;;
  analyze) analyze ;;
  all) preflight; gate; waves; analyze ;;
  *) die "usage: run.sh [all|config|preflight|gate|waves|analyze]" ;;
esac
