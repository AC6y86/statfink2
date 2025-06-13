# Test Database Isolation TODO

## Problem
Tests were writing to the production database (`fantasy_football.db`) due to:
1. DatabaseManager constructor doesn't accept custom database path parameter
2. Environment variable setup timing issues
3. Unit tests attempting to use `:memory:` database being ignored

## Disabled Tests
The following tests have been temporarily disabled using `.skip()` to prevent production database contamination:

### Unit Tests
- `tests/unit/database.test.js` - Database Manager Tests

### Integration Tests  
- `tests/integration/database.test.js` - Database Integration
- `tests/integration/app-lifecycle.test.js` - Application Lifecycle Tests
- `tests/integration/routes-comprehensive.test.js` - Comprehensive Route Testing
- `tests/integration/roster.test.js` - Roster Management Integration
- `tests/integration/dashboard.test.js` - Database Dashboard Integration
- `tests/integration/api-smoke.test.js` - API Smoke Tests - Critical Endpoints
- `tests/integration/tank01.test.js` - Tank01 API Integration

## Required Fixes
1. **Fix DatabaseManager constructor** to accept optional custom database path:
   ```javascript
   constructor(customPath = null) {
       const dbPath = customPath || process.env.DATABASE_PATH || './fantasy_football.db';
   ```

2. **Ensure proper test database isolation** by setting environment variables early

3. **Verify test database creation** and cleanup in teardown

4. **Add database path logging** to verify which database is being used

## Re-enabling Tests
After fixes are implemented:
1. Remove `.skip()` from all disabled test suites
2. Verify tests use isolated test database
3. Run tests to confirm no production database writes
4. Delete this TODO file

## Safe Tests (Still Running)
- `tests/unit/scoringService.test.js` - Uses mock database
- `tests/unit/tank01Service.test.js` - Uses mocked APIs
- `tests/unit/services.test.js` - Uses mocked DatabaseManager
- `tests/unit/validation.test.js` - Pure validation logic
- `tests/unit/errorHandler.test.js` - Error handling utilities
- `tests/integration/contracts.test.js` - External API tests