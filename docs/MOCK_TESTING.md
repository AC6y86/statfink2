# Mock Week Testing System

## Overview

The Mock Week Testing System allows developers and league administrators to test scoring scenarios without waiting for actual NFL games. Mock weeks use the season identifier `"mock"` and provide deterministic game, player, and DST data.

The canonical framework documentation (data structure, loader API, how to add new weeks) lives in `tests/mockWeeks/README.md`. This doc covers how to access and use mock weeks.

## Available Mock Weeks

| Week | Scenario | Tests |
|------|----------|-------|
| 1 | Pre-Game State (Thursday evening, no games started) | Roster validation, pre-game displays |
| 2 | Post-Week State (all 16 games Final, full stats) | Final scoring, weekly winners, bonus thresholds |
| 3 | Mid-Sunday Games (mixed game states) | Live scoring, partial-week scoring, in-progress displays |
| 99 | Games in progress with real player stats and timed updates | Live progression / delta testing |

Other weeks are not implemented — `getMockWeek(n)` throws for missing weeks.

## Accessing Mock Weeks

### Web Interface
```
http://localhost:3000/mocks               # Mock testing index
http://localhost:3000/statfink/mock       # Redirects to /mocks
http://localhost:3000/statfink/mock/1     # Specific mock week in the matchup viewer
```

### API Endpoints
```http
GET /api/nfl-games/mock/{week}/{season}  # Get mock game data
```

## Mock Week Data

Each week file (`tests/mockWeeks/week{N}.js`) exports:
- `games` — array of game objects (teams, scores, status, quarter, time)
- `playerStats` — offensive player stat lines, including edge cases (e.g., players at exact bonus thresholds)
- `dstStats` — team defense stats for all 32 teams
- `metadata` — scenario description and expected behaviors

## Using Mock Weeks in Tests

```javascript
const { getMockWeek, loadMockWeek } = require('../mockWeeks/mockWeekLoader');

// Get week data
const week2Data = getMockWeek(2);

// Load into a test database
await loadMockWeek(db, 2);
```

The loader (`tests/mockWeeks/mockWeekLoader.js`) also supports time progression within a week, and `tests/mockWeeks/index.js` provides game-progression utilities (`initializeGameProgression`, `simulateGameProgression`) for simulating live updates. Delta/live-update scenarios live in `tests/mockWeeks/deltaScenarios.js` with `/mocks/delta-test` as the browser harness.

## Running Tests

```bash
# Browser tests (Puppeteer), including mock week game-time tests
npm run test:browser

# Specific browser test
npm run test:browser -- mockWeekGameTimes.test.js

# Integration tests
npm run test:integration
```

## Creating Custom Mock Weeks

1. Create a new file: `tests/mockWeeks/week{N}.js`
2. Follow the structure of an existing week (e.g., `week2.js`): `games`, `playerStats`, `dstStats`, `metadata`
3. The framework auto-discovers `week*.js` files — no registration needed
4. Document the scenario in `tests/mockWeeks/README.md`

### Guidelines
- Always use the `"mock"` season identifier
- Ensure deterministic data (no random values)
- Include edge cases specific to the scenario (0-0 games, exact bonus-threshold yardage, defensive TDs)
- Never write mock data to the production database

## Debugging

```bash
# View mock week data
node -e "console.log(JSON.stringify(require('./tests/mockWeeks/week1'), null, 2))"
```

### Common Issues

#### Stats Not Updating
- Verify player IDs match between games and stats
- Check week/season parameters (season must be `"mock"`)

#### Scoring Discrepancies
- Check scoring rules: `docs/SCORING_SYSTEM.md`
- Validate DST scoring logic: `docs/DEFENSIVE_SCORING.md`
