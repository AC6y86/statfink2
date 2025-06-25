# StatFink Fantasy Football Tests

This directory contains the comprehensive test suite for the StatFink Fantasy Football application.

## Test Structure

```
tests/
├── unit/                     # Unit tests (40 tests - no dependencies)
│   ├── validation.test.js        # Data validation tests (16 tests)
│   ├── scoringService.test.js    # Fantasy scoring calculations (12 tests)
│   └── errorHandler.test.js      # Error handling utilities (12 tests)
├── integration/              # Integration tests (75+ tests - require server)
│   ├── database.test.js          # Database operations (18 tests)
│   ├── tank01.test.js           # Tank01 API integration (8 test groups)
│   ├── dashboard.test.js        # Web dashboard functionality (14 test groups)
│   └── roster.test.js           # Roster management operations (17 tests)
├── fixtures/                 # Test data and sample objects
│   └── sampleData.js             # Sample players, stats, teams
├── mockWeeks/                # Mock week scenarios for comprehensive testing
│   ├── mockWeekLoader.js         # Utility to load mock week data
│   └── week2.js                  # Week 2: Post-Week State (all games complete)
├── setup.js                  # Test environment setup
├── test-runner.js            # Guided test runner script
└── README.md                 # This file
```

## Running Tests

```bash
# Fast unit tests (recommended for development)
npm run test:fast        # Silent, fastest (<1 second)
npm run test:unit        # With output (~1 second)

# Integration tests (require running server)
npm run test:integration # Server-dependent tests (~30 seconds)

# All tests
npm test                 # Complete test suite

# Other options
npm run test:watch       # Watch mode for development
npm run test:coverage    # Generate coverage report

# Guided test runner
node test-runner.js [unit|integration|fast|all|help]
```

## Test Categories

### Unit Tests (40 tests ✅)
- **Validation Tests** (16): Data validation rules, input sanitization
- **Scoring Service Tests** (12): Fantasy point calculations for all positions
- **Error Handler Tests** (12): Custom error classes and middleware
- **Dependencies**: None (completely isolated)
- **Speed**: Very fast (< 1 second)

### Integration Tests (75+ tests 🔗)
- **Database Tests** (18): CRUD operations, transactions, constraints
- **Tank01 API Tests** (8 groups): Health checks, player sync, data transformation
- **Dashboard Tests** (14 groups): Web interface, API integration, admin functions
- **Roster Management Tests** (17): Player add/drop, position changes, validation
- **Dependencies**: Running StatFink server (localhost:3000)
- **Speed**: Moderate (2-30 seconds depending on server state)

## Server-Dependent Tests

The following tests require a running server:

```bash
# Terminal 1: Start the server
npm start

# Terminal 2: Run integration tests
npm run test:integration
```

**Tank01 Integration Tests:**
- Health endpoint validation
- Player synchronization
- API status monitoring
- Error handling

**Dashboard Integration Tests:**
- HTML page serving
- API endpoint integration
- Admin functionality
- Performance benchmarks

## Test Coverage

### ✅ **Complete Coverage Areas**
- Data validation for all entities
- Fantasy scoring (PPR, standard, DST, kickers)
- Error handling and logging
- Database operations (players, teams, rosters, stats)
- API endpoint responses
- Tank01 service integration
- Web dashboard functionality

### 📊 **Test Statistics**
- **Total Tests**: 115+ across unit and integration suites
- **Unit Test Runtime**: < 1 second
- **Integration Test Runtime**: < 30 seconds (with server)
- **Full Suite Runtime**: < 45 seconds

## Test Environment Setup

### Unit Tests
- No external dependencies
- Mocked services and data
- Isolated function testing
- Fast execution for TDD

### Integration Tests
- Real database connections
- Live API calls (when server running)
- End-to-end request/response cycles
- Performance and load testing

## Adding New Tests

### For New Features
1. **API Endpoints**: Add tests to appropriate integration file
2. **Business Logic**: Add unit tests for isolated functions
3. **Database Models**: Extend `database.test.js`
4. **UI Components**: Extend `dashboard.test.js`

### Test Guidelines
- **Unit tests**: Mock all external dependencies
- **Integration tests**: Use real connections, include server checks
- **Performance tests**: Set reasonable timeout expectations
- **Error cases**: Test both success and failure scenarios

## Test Data Management

- **Unit Tests**: Inline mock data or test-specific fixtures
- **Integration Tests**: Uses existing database with sample data
- **Sample Data**: Realistic NFL players, teams, and stats
- **Data Cleanup**: Automatic cleanup between test runs

## Mock Weeks Testing

The `mockWeeks/` directory contains comprehensive test scenarios simulating different states throughout an NFL week. These mock weeks are designed to test various game states and edge cases that are difficult to reproduce with real-time data.

### Available Mock Weeks

- **Week 2: Post-Week State** - All games complete with final scores
  - 16 games all marked as "Final"
  - Complete player stats for all positions (QB, RB, WR, TE, K)
  - DST stats for all 32 teams
  - Edge cases: Players with exactly 175 rushing/receiving yards (bonus thresholds)
  - Use case: Testing final scoring calculations, weekly winner determination, stat accumulation

### Using Mock Weeks in Tests

```javascript
// Example usage in a test file
const { loadMockWeek } = require('../mockWeeks/mockWeekLoader');

describe('Week 2 Final Scoring', () => {
  beforeEach(async () => {
    await loadMockWeek(db, 2); // Load week 2 data
  });
  
  test('should calculate correct fantasy points', async () => {
    // Test implementation
  });
});
```

### Mock Week Data Structure

Each mock week includes:
- **Games**: Complete game information with scores and status
- **Player Stats**: Comprehensive stats for offensive players
- **DST Stats**: Defensive stats for all teams that played
- **Metadata**: Test scenario description and expected behaviors

## Continuous Integration Ready

The test suite is optimized for CI/CD:
- **Parallel execution** support (Jest maxWorkers)
- **Conditional skipping** for server-dependent tests
- **Detailed reporting** for debugging failures
- **Performance benchmarks** for regression detection
- **Environment detection** for local vs CI testing

## Development Workflow

```bash
# During development (fast feedback)
npm run test:fast

# Before committing (comprehensive)
npm run test:unit && npm start & npm run test:integration

# Full validation
npm test
```