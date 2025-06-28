# Mock Weeks Test Documentation

## Overview

This document outlines the mock week testing framework for the StatFink fantasy football application. Mock weeks are designed to test various game states and scenarios that occur throughout an NFL week, ensuring the application correctly handles all possible game conditions.

### Purpose
- Test different game states (scheduled, in-progress, final)
- Validate live scoring updates
- Ensure proper stat calculations at various points in time
- Test edge cases like overtime, delays, and bye weeks

### Season Identifier
All mock test data uses the season identifier: `"mock"`

### Structure
Each week number (1-10+) represents a specific testing scenario with predefined game states, scores, and player statistics.

## Mock Week Scenarios

### Week 1: Pre-Game State (No Games Started)
**Scenario**: Thursday 7:00 PM ET - All games scheduled, none started
- All games have `status: "Scheduled"`
- All scores are 0-0
- No player stats recorded yet
- Tests: 
  - Roster validation before games start
  - Projected points display
  - Game schedule rendering

### Week 2: Post-Week State (All Games Complete)
**Scenario**: Tuesday morning - All games finished
- All games have `status: "Final"`
- Complete scores for all games
- Full player statistics available
- Tests:
  - Final scoring calculations
  - Weekly winner determination
  - Stat accumulation accuracy
  - DST scoring (fewest points/yards allowed)

### Week 3: Mid-Sunday Games
**Scenario**: Sunday 2:30 PM ET - Mixed game states
- Thursday game: `status: "Final"`
- Sunday 1:00 PM games: `status: "InProgress"`, `quarter: "3rd"`, varying time remaining
- Sunday 4:00 PM games: `status: "Scheduled"`
- Sunday/Monday night games: `status: "Scheduled"`
- Tests:
  - Live scoring updates
  - Partial week scoring
  - In-progress game display

 d
## Data Structure Requirements

### Game Data Structure
```javascript
{
  game_id: "mock_2024_01_KC_BAL",  // Format: mock_YYYY_WK_AWAY_HOME
  week: 1,
  season: "mock",
  home_team: "BAL",
  away_team: "KC",
  home_score: 0,
  away_score: 0,
  game_date: "2024-09-05T20:20:00Z",
  status: "Scheduled",  // Scheduled, InProgress, Halftime, Final, Delayed, Postponed, Suspended
  quarter: null,        // 1st, 2nd, 3rd, 4th, OT, OT2, etc.
  time_remaining: null, // "12:34", "0:00", etc.
  venue: "M&T Bank Stadium"
}
```

### Player Stats Structure
```javascript
{
  player_id: "KC_QB1",
  week: 1,
  season: "mock",
  game_id: "mock_2024_01_KC_BAL",
  // Passing stats
  passing_yards: 0,
  passing_tds: 0,
  interceptions: 0,
  // Rushing stats
  rushing_yards: 0,
  rushing_tds: 0,
  // Receiving stats
  receiving_yards: 0,
  receiving_tds: 0,
  receptions: 0,
  // Kicking stats
  field_goals_made: 0,
  extra_points_made: 0,
  // Return stats
  return_tds: 0,
  // Defensive stats (for IDP if applicable)
  sacks: 0,
  def_interceptions: 0,
  fumbles_recovered: 0,
  def_touchdowns: 0,
  safeties: 0,
  // Timestamps
  last_updated: "2024-09-05T20:20:00Z",
  // Meta
  is_playing: false,
  game_status: "Scheduled"
}
```

### Team Defense Stats Structure
```javascript
{
  team_code: "BAL",
  week: 1,
  season: "mock",
  game_id: "mock_2024_01_KC_BAL",
  points_allowed: 0,
  yards_allowed: 0,
  sacks: 0,
  interceptions: 0,
  fumbles_recovered: 0,
  defensive_tds: 0,
  safeties: 0,
  last_updated: "2024-09-05T20:20:00Z"
}
```

## Testing Guidelines

### Using Mock Weeks in Tests

1. **Import Mock Data**
   ```javascript
   const { getMockWeek } = require('./mocks/mockWeeks');
   const week3Data = getMockWeek(3);
   ```

2. **Set Up Test Database**
   ```javascript
   beforeEach(async () => {
     await setupMockSeason('mock');
     await loadMockWeek(3);
   });
   ```

3. **Time-Based Testing**
   - Mock weeks should include specific timestamps
   - Tests can "travel" to different times within the week
   - Use consistent timezone (ET) for all timestamps

### Expected Behaviors

1. **Week 1 (Pre-Game)**
   - All player scores should be 0
   - Rosters should be valid (19 players per team)
   - No scoring players should be marked with asterisks

2. **Week 2 (Post-Week)**
   - All 12 teams should have final scores
   - Top 11 players + 2 DST should contribute to scoring
   - Weekly winner should be determinable

3. **Week 3 (Mid-Games)**
   - Partial scores should be accurate
   - Live game indicators should show
   - Non-started games should show projections

4. **Week 4 (Live Scoring)**
   - Score changes should trigger UI updates
   - Scoring plays should be reflected immediately
   - DST stats should update correctly

### Integration with Test Framework

1. **Database Isolation**
   - Never write mock data to production database
   - Use separate test database or in-memory DB
   - Clean up after each test

2. **Deterministic Data**
   - All random elements should be seeded
   - Stats should be carefully crafted to test edge cases
   - Include players who hit exact yard thresholds (175, 250, etc.)

3. **Performance Testing**
   - Week 6 (many active games) tests performance
   - Measure query times and UI responsiveness
   - Test with realistic data volumes

## Future Enhancements

- Week 11+: Playoff scenarios
- Week 12+: Fantasy playoff testing
- Week 17: Season finale edge cases
- International games (different timezones)
- Multi-week testing scenarios
- Historical replay testing

## Implementation Notes

When implementing these mock weeks:

1. Create a `mockWeeks/` directory in the test folder
2. Each week gets its own file: `week1.js`, `week2.js`, etc.
3. Include a `mockWeekLoader.js` utility for easy test setup
4. Ensure all player IDs match the main fixture data
5. Include at least 2-3 games per time slot for realistic testing
6. Add helper functions for common assertions

Remember: Mock weeks should test the edge cases and scenarios that are difficult to reproduce with real NFL data, ensuring robust handling of all game states throughout the fantasy football season.