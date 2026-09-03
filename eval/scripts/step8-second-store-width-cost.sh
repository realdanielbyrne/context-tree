#!/usr/bin/env bash
# Step 8: Create second store and width-cost replicate (placeholder)
# This is dominated by Step 6 and should not be bought yet.
# Resolving the 5,275-token mean gap needs ~246 completed rows per arm
# (~390 attempted at 63% completion rate, ~780 runs, 29M tokens).
# Buy only after Step 6 lands and retrieval floor lifts.

set -euo pipefail

echo "=== Step 8: Second store + width-cost replicate ==="
echo ""
echo "NOT RUNNING - This step is dominated and should not be bought yet."
echo ""
echo "Prerequisites (from Tuning Pass Closing Report):"
echo "  1. Step 6 must land (raw-by-default fetch lifts retrieval floor)"
echo "  2. Retrieval floor must lift from 3.3% (4/120 successes)"
echo ""
echo "When prerequisites met:"
echo "  - ~780 runs at W=32768 cell's median"
echo "  - ~29M tokens"
echo "  - ~$50 at qwen/qwen-2.5-72b-instruct rates"
echo ""
echo "To create second store:"
echo "  python3 eval/scripts/build-ripple-scenario.py  # or build-dozen-scenario.py"
echo "  # Then re-segment under both configurations, locate questions, run structural gates"