#!/usr/bin/env node

/**
 * Comprehensive Test Runner
 * Runs all test suites with proper reporting and error handling
 */

const { spawn } = require('child_process');
const COLORS = {
  GREEN: '\x1b[32m',
  RED: '\x1b[31m',
  YELLOW: '\x1b[33m',
  BLUE: '\x1b[34m',
  RESET: '\x1b[0m',
  BOLD: '\x1b[1m'
};

function log(message, color = COLORS.RESET) {
  console.log(`${color}${message}${COLORS.RESET}`);
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['inherit', 'inherit', 'inherit'],
      ...options
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(code);
      } else {
        reject(new Error(`Command failed with exit code ${code}`));
      }
    });

    child.on('error', reject);
  });
}


async function runTestSuite() {
  const startTime = Date.now();
  let failures = 0;
  
  log(`${COLORS.BOLD}${COLORS.BLUE}🧪 StatFink Comprehensive Test Suite${COLORS.RESET}\n`);
  
  try {
    // 1. Run Unit Tests (fast, no dependencies)
    log(`${COLORS.BOLD}1. Running Unit Tests${COLORS.RESET}`, COLORS.BLUE);
    log('   ├─ Service initialization tests');
    log('   ├─ Database connection tests');
    log('   ├─ Tank01Service unit tests');
    log('   ├─ Validation tests');
    log('   ├─ Scoring service tests');
    log('   └─ Error handler tests');
    
    try {
      await runCommand('npm', ['run', 'test:unit']);
      log('✓ Unit tests passed', COLORS.GREEN);
    } catch (error) {
      log('✗ Unit tests failed', COLORS.RED);
      failures++;
    }
    
    console.log();
    
    // 2. Generate Coverage Report
    log(`${COLORS.BOLD}2. Generating Coverage Report${COLORS.RESET}`, COLORS.BLUE);
    try {
      await runCommand('npm', ['run', 'test:coverage']);
      log('✓ Coverage report generated', COLORS.GREEN);
    } catch (error) {
      log('⚠ Coverage report generation failed', COLORS.YELLOW);
    }
    
    console.log();
    
    // 3. Test Summary
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    log(`${COLORS.BOLD}Test Summary${COLORS.RESET}`, COLORS.BLUE);
    log(`Duration: ${duration}s`);
    
    if (failures === 0) {
      log(`${COLORS.BOLD}✅ All test suites passed!${COLORS.RESET}`, COLORS.GREEN);
      log('Your refactoring is safe to proceed.', COLORS.GREEN);
    } else {
      log(`${COLORS.BOLD}❌ ${failures} test suite(s) failed${COLORS.RESET}`, COLORS.RED);
      log('Please fix failing tests before refactoring.', COLORS.RED);
    }
    
    // 4. Next Steps
    console.log();
    log(`${COLORS.BOLD}Next Steps:${COLORS.RESET}`, COLORS.BLUE);
    log('• Review any failing tests above');
    log('• Check coverage report in coverage/lcov-report/index.html');
    log('• Run specific test suites during refactoring:');
    log('  - npm run test:fast (quick unit tests)');
    log('  - npm run test:unit (all unit tests)');
    log('• Re-run this comprehensive suite after major changes');
    
    return failures === 0;
    
  } catch (error) {
    log(`Test suite failed with error: ${error.message}`, COLORS.RED);
    return false;
  }
}

// Run the test suite
if (require.main === module) {
  runTestSuite()
    .then(success => {
      process.exit(success ? 0 : 1);
    })
    .catch(error => {
      log(`Fatal error: ${error.message}`, COLORS.RED);
      process.exit(1);
    });
}

module.exports = { runTestSuite };