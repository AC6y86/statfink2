// Test setup and teardown
const fs = require('fs');
const path = require('path');

// Use test database
process.env.DATABASE_PATH = './test_fantasy_football.db';
process.env.NODE_ENV = 'test';

// Clean up test database after all tests
afterAll(async () => {
  const testDbPath = './test_fantasy_football.db';
  if (fs.existsSync(testDbPath)) {
    fs.unlinkSync(testDbPath);
  }
});

// Increase timeout for database operations
jest.setTimeout(10000);