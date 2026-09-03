#!/usr/bin/env bash
# Step 3: Second-scenario cache sweep
#
# The gate for a shipped cache default flip. Runs the cache simulator over a
# SECOND frozen store to validate that the third breakpoint's structural
# properties replicate.
#
# Prerequisites:
#   1. Create the s2 fixture: ingest a different trace through the same pipeline
#      (leaf summarizer tokens ~210k on the cheap model, shared with Step 8).
#   2. The --store flag on cache-sweep.mjs is now functional.
#
# Criteria (pre-registered in iteration 2):
#   - Cache reads non-decreasing on >=90% of turn-to-turn steps outside phase transitions
#   - Median write on writing turns at least 10x below read total on those turns
#   - Median fresh input under 500 tokens per turn
#   - Session cost delta is negative
#   - packages/core/test/cache.test.ts still passes unchanged

set -euo pipefail

echo "=== Step 3: Second-scenario cache sweep ==="

if [ ! -d "eval/fixtures/transplant/s2/store" ]; then
  echo "ERROR: s2 fixture does not exist yet."
  echo "Create it by ingesting a second trace through the pipeline."
  echo "See reports/metrics/tuning-pass-report.md Step 3 for the spec."
  exit 1
fi

echo "Running cache sweep on s2..."
node eval/scripts/cache-sweep.mjs --store=eval/fixtures/transplant/s2/store

echo ""
echo "Running cache sweep on s1 (baseline comparison)..."
node eval/scripts/cache-sweep.mjs

echo ""
echo "Step 3 complete. Compare the two outputs against the pre-registered criteria."
