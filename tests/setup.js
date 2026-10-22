// Test setup and teardown
const fs = require('fs');
const path = require('path');

// Use test database. STATFINK_SLOW_DB (set by scripts/nightly-test-run.js) points
// the golden-record recalcs at a COPY of the league database instead of the
// official one; without it, tests get a throwaway DB.
const DEFAULT_TEST_DB = './test_fantasy_football.db';
process.env.DATABASE_PATH = process.env.STATFINK_SLOW_DB || DEFAULT_TEST_DB;
process.env.NODE_ENV = 'test';

// Clean up the throwaway test database after all tests (never the copy)
afterAll(async () => {
  if (process.env.DATABASE_PATH === DEFAULT_TEST_DB && fs.existsSync(DEFAULT_TEST_DB)) {
    fs.unlinkSync(DEFAULT_TEST_DB);
  }
});

// Increase timeout for database operations
jest.setTimeout(10000);
