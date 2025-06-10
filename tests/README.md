# Test Suite

This directory contains comprehensive tests for the StatFink Fantasy Football application.

## Test Structure

```
tests/
├── unit/                 # Unit tests for individual components
│   ├── validation.test.js    # Data validation tests
│   ├── scoringService.test.js # Fantasy scoring calculations
│   └── errorHandler.test.js  # Error handling utilities
├── integration/          # Integration tests for database operations
│   └── database.test.js      # Full database operation tests
├── fixtures/             # Test data and sample objects
│   └── sampleData.js         # Sample players, stats, teams
├── setup.js              # Test environment setup
└── README.md             # This file
```

## Running Tests

```bash
# Fast unit tests (recommended for development)
npm run test:fast        # Silent, fastest
npm run test:unit        # With output

# Integration tests (slower, database operations)
npm run test:integration

# All tests
npm test

# Other options
npm run test:watch       # Watch mode
npm run test:coverage    # With coverage report
```

## Test Categories

### Unit Tests (40+ tests passing)
- **Validation Tests**: 16 tests ensuring all data validation rules work correctly
- **Scoring Service Tests**: 12 tests verifying fantasy point calculations for all positions
- **Error Handler Tests**: 12 tests for custom error classes and middleware

### Integration Tests
- **Database Tests**: End-to-end database operations with real SQLite (currently has I/O issues)
- **Full workflow tests**: Complete data flow from input to storage

### Test Coverage
The test suite covers:
- ✅ Input validation for all data types
- ✅ Fantasy scoring calculations (QB, RB, WR, TE, K, DST)
- ✅ Database operations (CRUD for all entities)
- ✅ Error handling and logging
- ✅ Lineup validation
- ✅ Team and matchup management

## Test Environment
- Uses separate test database (`test_fantasy_football.db`)
- Mocked external dependencies where appropriate
- Automatic cleanup after test runs
- 10-second timeout for database operations

## Adding New Tests
When adding new features, ensure you add corresponding tests:

1. **Unit tests** for individual functions/classes
2. **Integration tests** for database operations
3. **Fixtures** for any new sample data needed
4. Update this README if adding new test categories

## Test Data
The `fixtures/sampleData.js` file contains realistic test data including:
- Sample NFL players across all positions
- Valid and invalid data for validation testing
- Sample stats and team data
- Edge cases for thorough testing