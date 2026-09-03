#!/usr/bin/env bash
# Step 1: Reply allowance live round
#
# Tests whether dynamic replyAllowance lets small-window models iterate through
# long sessions on progressively shorter replies instead of failing when prompt
# outgrows a fixed ceiling.
#
# Arms: no-limit, maxReplyTokens (window-derived), allowance (replyAllowance)
# Window: 16384 (smallest window where tree arm completes 60/60 runs)
# Reps: 5 per arm per question (180 runs total)
#
# Model: cheap OpenRouter flash models — the experiment measures structural
# reply behavior, not model-specific quality. Candidates in cost order:
#   qwen/qwen3.7-flash         $0.03/M input
#   z-ai/glm-5.3-flash         $0.075/M input
#   deepseek/deepseek-v4-flash  $0.0855/M input
# Pick whichever tool-calls reliably at W=16384. Run a smoke test first.
#
# PREREQUISITES:
#   --reply-mode does not exist yet on transplant.mjs. Adding it is the first
#   task. See tuning-pass-report.md Step 1 for the full experiment spec.

set -euo pipefail

SCENARIO=s1
WINDOW=16384
ARM=tree
REPS=5
MODEL=qwen/qwen3.7-flash
PROVIDER=openrouter

echo "=== Step 1: Reply allowance live round ==="
echo "Scenario: $SCENARIO"
echo "Window: $WINDOW"
echo "Model: $MODEL (via $PROVIDER)"
echo "Arm: $ARM"
echo "Reps: $REPS"
echo ""
echo "NOTE: --reply-mode does not exist yet on transplant.mjs."
echo "Implement it before running this script."
echo "See reports/metrics/tuning-pass-report.md Step 1 for the full spec."
echo ""

# Placeholder — uncomment once --reply-mode is implemented:
# node eval/scripts/transplant.mjs --phase run --scenario "$SCENARIO" \
#   --window "$WINDOW" --model "$MODEL" --provider "$PROVIDER" --arm "$ARM" \
#   --reps "$REPS" --reply-mode no-limit,maxReplyTokens,allowance \
#   --cost-cap-usd 5
