module.exports = {
  testEnvironment: 'node',
  testMatch: [
    '**/tests/**/*.test.js',
    '**/tests/**/*.spec.js'
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
  testTimeout: 300000, // 5 minutes default for slow tests
  verbose: true, // More verbose for slow tests to show progress
  maxWorkers: 1, // Run slow tests sequentially to avoid resource contention
  // Slow test projects
  projects: [
    {
      displayName: 'slow-integration',
      testMatch: [
        '<rootDir>/tests/integration/recalculateAndVerify2024.test.js',
        '<rootDir>/tests/integration/compareStats2024.test.js',
        '<rootDir>/tests/2024/compareStats2024.test.js',
        '<rootDir>/tests/2025/compareStats2025.test.js'
      ],
      testTimeout: 900000 // 15 minutes for recalculation tests
    },
    {
      displayName: 'browser',
      testMatch: ['<rootDir>/tests/browser/**/*.test.js'],
      preset: 'jest-puppeteer',
      testTimeout: 60000 // 1 minute for browser tests
    },
    {
      displayName: 'verification',
      testMatch: ['<rootDir>/tests/verification/**/*.test.js'],
      testTimeout: 60000 // 1 minute for verification tests
    }
  ]
};