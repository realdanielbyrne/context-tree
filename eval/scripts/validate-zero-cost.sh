#!/usr/bin/env bash
# Validation: runs all zero-cost experiments to verify reproducibility
# before committing to live runs.

set -euo pipefail

echo "=== Zero-Cost Validation ==="
echo ""

echo "1/5: Ladder curve (branch count)..."
node eval/scripts/ladder-curve.mjs > /tmp/ladder-curve.out 2>&1
echo "   done"

echo "2/5: Re-segmentation (branch depth)..."
node eval/scripts/resegment.mjs > /tmp/resegment.out 2>&1
echo "   done"

echo "3/5: Switch fraction sweep (summary timing)..."
node eval/scripts/switch-fraction-sweep.mjs > /tmp/switch-fraction-sweep.out 2>&1
echo "   done"

echo "4/5: Cache sweep on s1..."
node eval/scripts/cache-sweep.mjs > /tmp/cache-sweep-s1.out 2>&1
echo "   done"

echo "5/5: Unit tests (core, mcp, eval)..."
npx vitest run packages/core packages/mcp eval/test > /tmp/vitest.out 2>&1
RESULT=$?
if [ $RESULT -ne 0 ]; then
  echo "   FAILED — see /tmp/vitest.out"
  exit 1
fi
tail -3 /tmp/vitest.out
echo ""

echo "=== All zero-cost validations passed ==="
