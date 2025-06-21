# TODO Items

## Tank01 Data Import Issues

### Two-Point Conversions - Individual Player Attribution
**Status**: Partially Fixed
- **Issue**: Tank01 API only provides 2pt conversions at team level (`teamStats.twoPointConversions`)
- **Current**: Team totals are available but not attributed to individual players
- **Impact**: Individual players don't get 2pt conversion points in fantasy scoring
- **Possible Solutions**:
  1. Parse play-by-play data to attribute team 2pt conversions to specific players
  2. Accept limitation and only track at team level
  3. Research if Tank01 has individual 2pt data in other endpoints

### Kick/Punt Return Touchdowns  
**Status**: Database Ready, No Data Source
- **Issue**: Tank01 API doesn't appear to provide return TD data
- **Current**: Database has `return_tds` column, scoring service awards 20 points
- **Impact**: Return TDs not being tracked/scored
- **Next Steps**: Research alternative data sources or accept limitation

### Fantasy Points Recalculation Query
**Status**: Fixed
- **Issue**: `recalculateFantasyPoints.js` query was missing newer stat columns
- **Fixed**: Added `two_point_conversions_pass`, `two_point_conversions_run`, `two_point_conversions_rec`, `return_tds` to SELECT query
- **Impact**: Fantasy points recalculation now includes all available stats

---

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