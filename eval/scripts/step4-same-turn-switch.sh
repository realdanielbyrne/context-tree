#!/usr/bin/env bash
# Step 4: Same-turn switch check live batch
#
# The same-turn gate check is now implemented in eval/src/loop.ts. This batch
# measures its effect: does removing the one-turn overshoot (median 8,306
# tokens on 6 recorded crossings) save tokens without costing turns?
#
# The same-turn check is the ONLY gate now — the old lagged check was removed.
# Running this batch produces "same-turn" measurements; the "lagged" baseline
# is the existing data in eval/results/long-v65-gate/.
#
# Scenarios: sw-5-dozen, sw-6-ripple (only two that cross the switch)
# Agent model: claude-sonnet-5
# Summarizer: claude-haiku-4-5-20251001
# Switch threshold: set via EVAL_LAZY_TOKENS (Zone C share at the chosen W)
# n: 3 replicates per scenario (6 runs total, one epoch)
#
# This declares an epoch boundary. No total-token, turn-count, or cost figure
# from long-v65-gate or earlier may be compared against runs made after it.
#
# Pre-registered criteria (per scenario):
#   1. Crossing turn prompt within 1,000 tokens of threshold in >=5 of 6 runs
#   2. Median total billed tokens at or below baseline (265,428, n=6)
#   3. Median turns no worse than baseline + 2 (sw-5: 13, sw-6: 18)
#   4. No run graded success:false where lagged graded true

set -euo pipefail

MODEL=claude-sonnet-5
PROVIDER=anthropic
LEAF_MODEL=claude-haiku-4-5-20251001
ROOT_MODEL=claude-sonnet-5

echo "=== Step 4: Same-turn switch check live batch ==="
echo "Model: $MODEL"
echo "Provider: $PROVIDER"
echo ""

# Run sw-5-dozen (3 replicates)
for rep in 1 2 3; do
  echo "--- sw-5-dozen replicate $rep ---"
  EVAL_LAZY_TOKENS=30000 EVAL_SUMMARIZE_ON_CLOSE=1 \
    node eval/dist/run.js \
      --benchmarks deepswe-agents-last-exam \
      --scenarios-dir ./eval/scenarios-long \
      --arms context-tree \
      --model "$MODEL" --provider "$PROVIDER" \
      --leaf-model "$LEAF_MODEL" --root-model "$ROOT_MODEL" \
      --window 200000 \
      --cost-cap-usd 5 \
      --run-id "step4-sw5-rep${rep}"
done

# Run sw-6-ripple (3 replicates)
for rep in 1 2 3; do
  echo "--- sw-6-ripple replicate $rep ---"
  EVAL_LAZY_TOKENS=30000 EVAL_SUMMARIZE_ON_CLOSE=1 \
    node eval/dist/run.js \
      --benchmarks deepswe-agents-last-exam \
      --scenarios-dir ./eval/scenarios-long \
      --arms context-tree \
      --model "$MODEL" --provider "$PROVIDER" \
      --leaf-model "$LEAF_MODEL" --root-model "$ROOT_MODEL" \
      --window 200000 \
      --cost-cap-usd 5 \
      --run-id "step4-sw6-rep${rep}"
done

echo ""
echo "Step 4 complete. Results in eval/results/step4-*/"
