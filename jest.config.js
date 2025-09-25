module.exports = {
  testEnvironment: 'node',
  testMatch: [
    '**/tests/**/*.test.js',
    '**/tests/**/*.spec.js'
  ],
  // Exclude slow tests from default test run
  testPathIgnorePatterns: [
    '/node_modules/',
    '/tests/browser/',
    '/tests/verification/',
    '/tests/integration/recalculateAndVerify2024.test.js',
    '/tests/integration/compareStats2024.test.js',
    '/tests/2024/compareStats2024.test.js',
    '/tests/2025/compareStats2025.test.js'
  ],
  collectCoverageFrom: [
    'server/**/*.js',
    '!server/**/*.test.js',
    '!server/**/*.spec.js',
    '!server/database/schema.sql'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.js'],
  testTimeout: 10000,
  verbose: false,
  maxWorkers: 4, // Increased for faster parallel execution
  // Fast test projects only
  projects: [
    {
      displayName: 'unit',
      testMatch: ['<rootDir>/tests/unit/**/*.test.js'],
      testTimeout: 5000,
      maxWorkers: 4
    },
    {
      displayName: 'integration-fast',
      testMatch: ['<rootDir>/tests/integration/**/*.test.js'],
      testPathIgnorePatterns: [
        'recalculateAndVerify2024',
        'compareStats2024'
      ],
      testTimeout: 15000,
      maxWorkers: 2
    }
  ]
};