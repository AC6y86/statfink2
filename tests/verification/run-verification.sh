#!/bin/bash

# Run verification tests for a specific week/season
# Usage: ./run-verification.sh [season] [week]
# Example: ./run-verification.sh 2025 1

SEASON=${1:-2025}
WEEK=${2:-1}

echo "🏈 Running verification tests for Season $SEASON, Week $WEEK"
echo "=================================================="
echo ""

export TEST_SEASON=$SEASON
export TEST_WEEK=$WEEK

# Run all verification tests. NB: the default jest config ignores
# tests/verification/, so the suite must run via the slow config's
# 'verification' project.
npx jest --config jest.config.slow.js --selectProjects verification --runInBand

echo ""
echo "📄 Reports generated in: /tmp/verification-reports/"
echo ""
echo "To run individual tests:"
echo "  export TEST_SEASON=$SEASON TEST_WEEK=$WEEK"
echo "  npx jest --config jest.config.slow.js --selectProjects verification tests/verification/<name>.test.js"