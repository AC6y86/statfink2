# Mock Weeks Testing Framework

This directory contains mock week data for testing various game states and scenarios in the StatFink fantasy football application.

## Overview

Mock weeks use the season identifier `"mock"` and provide deterministic test data for different NFL week scenarios.

## Available Mock Weeks

### Week 1: Pre-Game State
- **Status**: ✅ Implemented
- **Scenario**: Thursday 7:00 PM ET - All games scheduled, none started
- **Tests**: Roster validation, projections, pre-game displays

### Week 2: Post-Week State
- **Status**: ✅ Implemented
- **Scenario**: Tuesday morning - All games finished
- **Tests**: Final scoring, weekly winners, stat accumulation
- **Features**:
  - 16 games all with "Final" status
  - Complete player stats for QB, RB, WR, TE, K positions
  - DST stats for all 32 teams
  - Edge cases: Players with exactly 175 rushing/receiving yards (bonus thresholds)
  - Realistic scoring scenarios including high-scoring games and defensive battles

### Week 3: Mid-Sunday Games
- **Status**: 🔲 Not implemented
- **Scenario**: Sunday 2:30 PM ET - Mixed game states
- **Tests**: Live scoring, partial week scoring, in-progress displays

### Week 4: Active Live Scoring
- **Status**: 🔲 Not implemented
- **Scenario**: Sunday 3:15 PM ET - Stats actively updating
- **Tests**: Real-time updates, scoring plays, UI updates

### Week 5: Thursday Night Only Complete
- **Status**: 🔲 Not implemented
- **Scenario**: Friday morning - Only TNF finished
- **Tests**: Partial week data, early leaders

### Week 6: Sunday Morning In-Progress
- **Status**: 🔲 Not implemented
- **Scenario**: Sunday 1:45 PM ET - All early games running
- **Tests**: Multiple simultaneous games, halftime validation

### Week 7: Complex Mixed States
- **Status**: 🔲 Not implemented
- **Scenario**: Sunday 6:30 PM ET - Various game states including OT
- **Tests**: Overtime handling, complex scoring

### Week 8: Overtime Scenarios
- **Status**: 🔲 Not implemented
- **Scenario**: Multiple OT games
- **Tests**: Extended game handling

### Week 9: Weather Delays
- **Status**: 🔲 Not implemented
- **Scenario**: Games with delays/postponements
- **Tests**: Non-standard game states

### Week 10: Bye Week Testing
- **Status**: 🔲 Not implemented
- **Scenario**: 6 teams on bye
- **Tests**: Roster handling with byes

## Usage

### In Tests

```javascript
const { getMockWeek, loadMockWeek } = require('./mockWeekLoader');

// Get week data
const week1Data = getMockWeek(1);  // Pre-game state
const week2Data = getMockWeek(2);  // Post-week complete state

// Load into test database
await loadMockWeek(db, 2);

// Example: Testing final scoring with week 2 data
describe('Final Week Scoring', () => {
  beforeEach(async () => {
    await loadMockWeek(db, 2);
  });
  
  test('should calculate correct fantasy points for all players', async () => {
    // Your test implementation
  });
});
```

### Using the Loader

```javascript
const { createMockWeekLoader } = require('../mockWeeks');

const loader = createMockWeekLoader(db);
await loader.loadMockWeek(1);

// Get available weeks
const weeks = loader.getAvailableWeeks();
```

## Data Structure

Each week file exports:
- `games`: Array of game objects
- `playerStats`: Array of player stat objects
- `dstStats`: Array of team defense stat objects
- `metadata`: Object with scenario information

## Adding New Mock Weeks

1. Create a new file: `week{number}.js`
2. Follow the structure of existing weeks (e.g., `week2.js`)
3. Include all required game data
4. Add appropriate player/DST stats for the scenario
5. Document the scenario in metadata
6. Update this README

### Example Week 2 Structure
```javascript
const week2Data = {
  season: "mock",
  week: 2,
  scenario: "Post-Week State (All Games Complete)",
  timestamp: "2024-09-17T09:00:00Z",
  
  games: [
    // 16 NFL games with final scores
  ],
  
  playerStats: [
    // Complete stats for offensive players
    // Include edge cases for testing
  ],
  
  dstStats: [
    // Defensive stats for all 32 teams
  ],
  
  metadata: {
    scenario: "Post-Week State",
    description: "All games complete with final scores and full statistics",
    testFocus: ["Final scoring", "Weekly winners", "Stat accumulation", "DST scoring"],
    expectedBehaviors: {
      allGamesFinal: true,
      allStatsComplete: true,
      weeklyWinnerDeterminable: true,
      top11PlayersIdentifiable: true
    }
  }
};
```

## Testing Guidelines

- Always use the `"mock"` season identifier
- Ensure deterministic data (no random values)
- Include edge cases specific to each scenario
- Test both data integrity and UI behavior
- Clean up test data after each test run