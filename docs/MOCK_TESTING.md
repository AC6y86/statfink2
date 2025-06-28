# Mock Week Testing System

## Overview

The Mock Week Testing System allows developers and league administrators to test live scoring scenarios without waiting for actual NFL games. This system simulates real-time game progression, player statistics updates, and fantasy scoring calculations.

## Features

- **18 Mock Weeks**: Pre-configured test data for weeks 1-18
- **Live Score Simulation**: Progressive score updates during "games"
- **Player Statistics**: Realistic stat generation for all positions
- **Game Status Updates**: Simulates quarters, timeouts, and final scores
- **Integration Testing**: Validates scoring calculations and UI updates

## Accessing Mock Weeks

### Web Interface
```
http://localhost:3000/statfink/mock       # Mock week selection page
http://localhost:3000/statfink/mock/1     # Specific mock week
```

### API Endpoints
```http
GET /api/nfl-games/mock/{week}/{season}  # Get mock game data
```

## Mock Week Structure

### Game Data Format
```javascript
{
  game_id: "mock_2024_01_KC_BAL",
  week: 1,
  season: 2024,
  home_team: "KC",
  away_team: "BAL", 
  home_score: 27,
  away_score: 24,
  status: "Final",
  quarter: "F",
  time_remaining: "0:00",
  game_time: "1:00 PM ET"
}
```

### Player Statistics
Mock weeks include realistic statistics for:
- **Quarterbacks**: Passing yards, TDs, INTs
- **Running Backs**: Rushing/receiving yards, TDs, receptions
- **Wide Receivers**: Receiving yards, TDs, receptions
- **Tight Ends**: Receiving yards, TDs, receptions
- **Kickers**: FG attempts/makes by distance, XPs
- **Defenses**: Points allowed, yards allowed, sacks, turnovers

## Available Mock Weeks

### Week 1-3: Regular Season Games
- Standard scoring scenarios
- Mix of high and low scoring games
- Various player performance levels

### Week 4-8: Edge Cases
- Overtime games
- Defensive/special teams TDs
- Injured player scenarios
- Weather-affected games

### Week 9-12: Division Games
- Rivalry matchups
- Playoff implications
- Close scoring scenarios

### Week 13-17: Fantasy Playoffs
- High-stakes matchups
- Boom/bust performances
- Championship scenarios

### Week 18: Testing Scenarios
- Extreme scoring cases
- System stress testing
- Error condition testing

## Creating Custom Mock Weeks

### 1. Create Mock Week File
```javascript
// tests/mockWeeks/week19.js
module.exports = {
  games: [
    {
      game_id: "mock_2024_19_TB_NO",
      home_team: "TB",
      away_team: "NO",
      home_score: 31,
      away_score: 28,
      status: "Final"
    }
  ],
  stats: {
    "player_123": {
      passing_yards: 350,
      passing_tds: 3,
      interceptions: 1
    }
  }
};
```

### 2. Register Mock Week
```javascript
// tests/mockWeeks/index.js
const mockWeeks = {
  1: require('./week1'),
  // ...
  19: require('./week19')  // Add new week
};
```

## Live Progression Testing

### Simulating Game Progress
Mock weeks can simulate live game progression:

```javascript
// Enable progression for week 1
const progression = {
  enabled: true,
  currentQuarter: 2,
  timeRemaining: "7:23",
  updates: [
    { time: "14:00", type: "touchdown", team: "home", points: 7 },
    { time: "10:30", type: "field_goal", team: "away", points: 3 }
  ]
};
```

### Testing Live Updates
1. Start server with mock mode enabled
2. Navigate to mock week
3. Use browser console to trigger updates:
```javascript
// Simulate quarter change
window.mockGameUpdate('Q3');

// Simulate scoring play
window.mockScoringPlay('touchdown', 'KC');
```

## Integration Testing

### Running Mock Week Tests
```bash
# Run all mock week tests
npm run test:mock

# Test specific week
npm run test:mock -- --week=1

# Test with live progression
npm run test:mock -- --live
```

### Validating Scoring
Mock weeks automatically validate:
- Player fantasy point calculations
- Team total scoring
- Scoring player selection (top 11 + 2 DST)
- Standings updates

### Browser Testing
```bash
# Run Puppeteer tests for mock weeks
npm run test:browser -- mockWeek.test.js
```

## Common Use Cases

### 1. Testing New Scoring Rules
- Modify scoring settings
- Run mock week
- Verify point calculations

### 2. UI Development
- Use mock weeks for consistent data
- Test responsive design
- Validate loading states

### 3. Performance Testing
- Load test with multiple concurrent users
- Measure response times
- Identify bottlenecks

### 4. Bug Reproduction
- Create mock week matching bug conditions
- Consistent reproduction environment
- Regression testing

## Debugging Mock Weeks

### Enable Debug Logging
```javascript
// Set in environment
DEBUG=mock:* npm start

// Or in code
process.env.DEBUG = 'mock:*';
```

### Inspect Mock Data
```bash
# View mock week data
node -e "console.log(JSON.stringify(require('./tests/mockWeeks/week1'), null, 2))"

# Check player stats
sqlite3 fantasy_football.db "SELECT * FROM player_stats WHERE week=1 AND player_id LIKE 'mock_%'"
```

### Common Issues

#### Stats Not Updating
- Verify player IDs match between games and stats
- Check week/season parameters
- Ensure stats sync is enabled

#### Scoring Discrepancies  
- Review scoring rules configuration
- Check player position mappings
- Validate DST scoring logic

#### UI Not Refreshing
- Verify WebSocket connections (if used)
- Check API polling intervals
- Clear browser cache

## Best Practices

### Mock Data Guidelines
- Use realistic scores and stats
- Include variety of game scenarios
- Test edge cases (0-0 games, 70+ point games)
- Match actual NFL constraints

### Testing Strategy
1. **Unit Tests**: Individual scoring calculations
2. **Integration Tests**: Full mock week flows
3. **Browser Tests**: UI interactions
4. **Load Tests**: Multiple concurrent users

### Maintenance
- Update mock data each season
- Add new edge cases as discovered
- Document special test scenarios
- Keep mock weeks synchronized with schema changes

## Advanced Features

### Conditional Logic
```javascript
// Random events during games
if (Math.random() > 0.9) {
  mockInjuryEvent(playerId);
}

// Weather effects
if (mockWeek.weather === 'snow') {
  reducePassingStats(0.8);
}
```

### API Mocking
```javascript
// Override Tank01 API responses
mockTank01Response('/scores', mockWeekData);

// Simulate API failures
mockTank01Error('/stats', 500);
```

### Time Travel
```javascript
// Test specific game times
setMockGameTime('2024-09-08 16:25:00');

// Advance time
advanceMockTime(minutes: 15);
```

## Conclusion

The Mock Week Testing System is an essential tool for development, testing, and demonstration of the StatFink fantasy football platform. It provides consistent, repeatable test scenarios that help ensure system reliability and accuracy.