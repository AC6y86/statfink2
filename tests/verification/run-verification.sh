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

# Run all verification tests
npm test -- tests/verification

echo ""
echo "📄 Reports generated in: /tmp/verification-reports/"
echo ""
echo "To run individual tests:"
echo "  export TEST_SEASON=$SEASON TEST_WEEK=$WEEK"
echo "  npm test -- tests/verification/player-matching.test.js"
echo "  npm test -- tests/verification/stats-completeness.test.js"
echo "  npm test -- tests/verification/stats-accuracy.test.js"
echo "  npm test -- tests/verification/data-reconciliation.test.js"