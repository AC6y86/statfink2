# Test Strategy Documentation

## Test Organization

Tests are now organized into **fast** and **slow** categories to improve developer experience and CI/CD efficiency.

### Fast Tests (Default)
Run with: `npm test` or `npm run test:fast`
- **Unit tests**: All tests in `/tests/unit/` (~3 seconds)
- **Fast integration tests**: Selected tests in `/tests/integration/` (~15 seconds)
  - Excludes: recalculation and comparison tests
- **Expected runtime**: < 20 seconds total

### Slow Tests
Run with: `npm run test:slow`
- **Browser tests**: All tests in `/tests/browser/` (60s timeout each)
- **Verification tests**: All tests in `/tests/verification/` (60s timeout each)
- **Slow integration tests**:
  - `recalculateAndVerify2024.test.js` (10 minute timeout)
  - `compareStats2024.test.js` (10 minute timeout)
- **Stats comparison tests**: Tests in `/tests/2024/` and `/tests/2025/`
- **Expected runtime**: 2-5 minutes

## Available Test Commands

### Primary Commands
- `npm test` - Run fast tests only (default for development)
- `npm run test:fast` - Same as above but with 4 workers
- `npm run test:slow` - Run slow tests only
- `npm run test:all` - Run both fast and slow tests

### Specific Test Categories
- `npm run test:unit` - Unit tests only
- `npm run test:integration` - Fast integration tests only
- `npm run test:integration:slow` - Slow integration tests only
- `npm run test:browser` - Browser tests only
- `npm run test:verify` - Verification tests only

### Other Commands
- `npm run test:watch` - Watch mode for fast tests
- `npm run test:coverage` - Coverage for fast tests
- `npm run test:coverage:all` - Coverage for all tests
- `npm run test:verify2025` - Run 2025 stats comparison
- `npm run test:verify2025:jest` - Run 2025 stats comparison as Jest test

## Timeouts

### Fast Tests
- Unit tests: 5 seconds
- Fast integration tests: 15 seconds
- Default: 10 seconds

### Slow Tests
- Browser tests: 60 seconds
- Verification tests: 60 seconds
- Recalculation tests: 600 seconds (10 minutes)
- Default: 300 seconds (5 minutes)

## CI/CD Strategy

### On Every Commit (PR)
```bash
npm run test:fast
```
- Quick feedback (~20 seconds)
- Catches most issues

### On Merge to Main
```bash
npm run test:all
```
- Full test suite
- Complete validation

### Nightly/Weekly
```bash
npm run test:integration:slow
```
- Full recalculation tests
- Deep data verification

## Development Workflow

1. **During development**: Run `npm test` frequently for quick feedback
2. **Before committing**: Run `npm run test:all` to ensure nothing is broken
3. **Debugging slow tests**: Run specific slow tests individually with increased verbosity

## Configuration Files

- `jest.config.js` - Fast test configuration (default)
- `jest.config.slow.js` - Slow test configuration
- `package.json` - All test scripts defined here

## Tips

- If a test is consistently taking > 15 seconds, move it to the slow category
- Use `jest.setTimeout()` at the top of slow test files to set appropriate timeouts
- Run slow tests overnight or during breaks to validate complex scenarios
- Monitor test execution times and adjust categorization as needed