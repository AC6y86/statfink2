#!/bin/bash

#############################################################################
# Test Consistency Checker
#
# Runs the full test suite multiple times to detect flaky/inconsistent tests.
# Generates a detailed report of any failures and calculates reliability metrics.
#############################################################################

# Configuration
ITERATIONS=10
LOG_DIR="/tmp/test-consistency-logs"
REPORT_FILE="/tmp/test-consistency-report.txt"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Statistics
TOTAL_RUNS=0
PASSED_RUNS=0
FAILED_RUNS=0
declare -A FAILED_TESTS  # Track which tests failed and how many times

# Initialize
mkdir -p "$LOG_DIR"
rm -f "$LOG_DIR"/*.log "$REPORT_FILE" 2>/dev/null

echo -e "${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║           Test Suite Consistency Checker                    ║${NC}"
echo -e "${CYAN}║           Running $ITERATIONS iterations of test suite              ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""

START_TIME=$(date +%s)

# Run tests multiple times
for i in $(seq 1 $ITERATIONS); do
    TOTAL_RUNS=$((TOTAL_RUNS + 1))
    LOG_FILE="$LOG_DIR/test-run-$i.log"

    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${CYAN}Run $i of $ITERATIONS${NC} ($(date '+%Y-%m-%d %H:%M:%S'))"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

    # Run tests and capture output
    npm run test:all > "$LOG_FILE" 2>&1
    EXIT_CODE=$?

    if [ $EXIT_CODE -eq 0 ]; then
        PASSED_RUNS=$((PASSED_RUNS + 1))
        echo -e "${GREEN}✓ Run $i: PASSED${NC}"
    else
        FAILED_RUNS=$((FAILED_RUNS + 1))
        echo -e "${RED}✗ Run $i: FAILED (exit code: $EXIT_CODE)${NC}"

        # Extract failed test names from Jest output
        grep -E "✕|● " "$LOG_FILE" | while read -r line; do
            # Clean up test name
            TEST_NAME=$(echo "$line" | sed -E 's/^[[:space:]]*●[[:space:]]*//' | sed -E 's/[[:space:]]*\([0-9]+ ms\)$//')
            if [ -n "$TEST_NAME" ]; then
                FAILED_TESTS["$TEST_NAME"]=$((${FAILED_TESTS["$TEST_NAME"]:-0} + 1))
            fi
        done
    fi

    # Show progress stats
    CURRENT_TIME=$(date +%s)
    ELAPSED=$((CURRENT_TIME - START_TIME))
    AVG_TIME=$((ELAPSED / i))
    REMAINING=$((AVG_TIME * (ITERATIONS - i)))

    echo -e "${YELLOW}Progress: $i/$ITERATIONS complete | Pass rate: $((PASSED_RUNS * 100 / TOTAL_RUNS))% | ETA: ${REMAINING}s${NC}"
    echo ""
done

# Generate report
echo -e "${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║                  Generating Report...                        ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}"

{
    echo "==============================================================================="
    echo "                    TEST CONSISTENCY REPORT"
    echo "==============================================================================="
    echo ""
    echo "Generated: $(date '+%Y-%m-%d %H:%M:%S')"
    echo "Total iterations: $ITERATIONS"
    echo "Total runtime: $ELAPSED seconds"
    echo ""
    echo "==============================================================================="
    echo "                         SUMMARY"
    echo "==============================================================================="
    echo ""
    echo "✓ Passed runs:  $PASSED_RUNS / $ITERATIONS ($((PASSED_RUNS * 100 / ITERATIONS))%)"
    echo "✗ Failed runs:  $FAILED_RUNS / $ITERATIONS ($((FAILED_RUNS * 100 / ITERATIONS))%)"
    echo ""

    if [ $FAILED_RUNS -eq 0 ]; then
        echo "🎉 EXCELLENT! All test runs passed consistently."
        echo "   The test suite is stable and reliable."
    elif [ $FAILED_RUNS -lt 3 ]; then
        echo "⚠️  WARNING: Some test runs failed."
        echo "   The test suite shows minor inconsistencies."
    else
        echo "❌ CRITICAL: Multiple test runs failed."
        echo "   The test suite has significant reliability issues."
    fi

    echo ""
    echo "==============================================================================="
    echo "                      DETAILED RESULTS"
    echo "==============================================================================="
    echo ""

    # Show which runs failed
    if [ $FAILED_RUNS -gt 0 ]; then
        echo "Failed runs:"
        for i in $(seq 1 $ITERATIONS); do
            LOG_FILE="$LOG_DIR/test-run-$i.log"
            if grep -q "Test Suites:.*failed" "$LOG_FILE" 2>/dev/null; then
                echo "  - Run $i (log: $LOG_FILE)"

                # Extract summary from log
                SUMMARY=$(grep -A 2 "Test Suites:" "$LOG_FILE" | head -3)
                echo "$SUMMARY" | sed 's/^/    /'
                echo ""
            fi
        done

        echo ""
        echo "==============================================================================="
        echo "                    FLAKY/FAILING TESTS"
        echo "==============================================================================="
        echo ""
        echo "Tests that failed at least once:"
        echo ""

        # Parse all logs for failed test patterns
        for i in $(seq 1 $ITERATIONS); do
            LOG_FILE="$LOG_DIR/test-run-$i.log"
            if [ -f "$LOG_FILE" ]; then
                # Look for FAIL markers and test names
                grep -B 5 "FAIL\|✕" "$LOG_FILE" 2>/dev/null | grep -E "●|FAIL" | sort -u | while read -r line; do
                    echo "  Run $i: $line"
                done
            fi
        done

        echo ""
        echo "==============================================================================="
        echo "                    RECOMMENDATIONS"
        echo "==============================================================================="
        echo ""
        echo "1. Review failed test logs in: $LOG_DIR"
        echo "2. Look for patterns in failures (timing issues, race conditions, etc.)"
        echo "3. Consider adding retries or stabilizing flaky tests"
        echo "4. Check for database/state cleanup issues between tests"
        echo ""
    fi

    echo "==============================================================================="
    echo "                      LOG FILES"
    echo "==============================================================================="
    echo ""
    echo "Individual run logs saved to:"
    for i in $(seq 1 $ITERATIONS); do
        echo "  - $LOG_DIR/test-run-$i.log"
    done
    echo ""

} > "$REPORT_FILE"

# Display report
cat "$REPORT_FILE"

# Final summary with color
echo ""
echo -e "${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
if [ $FAILED_RUNS -eq 0 ]; then
    echo -e "${CYAN}║${GREEN}  ✓ All $ITERATIONS test runs passed! Test suite is stable.    ${CYAN}║${NC}"
else
    echo -e "${CYAN}║${RED}  ✗ $FAILED_RUNS of $ITERATIONS runs failed. Review report above.         ${CYAN}║${NC}"
fi
echo -e "${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "📄 Full report saved to: ${YELLOW}$REPORT_FILE${NC}"
echo -e "📁 Log files saved to: ${YELLOW}$LOG_DIR${NC}"
echo ""

# Exit with failure code if any runs failed
if [ $FAILED_RUNS -gt 0 ]; then
    exit 1
else
    exit 0
fi