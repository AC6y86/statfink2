# Scoring System Clarification

## Overview

StatFink uses the **PFL (Personal Football League)** custom threshold-based scoring system. This is a unique scoring system that rewards players for reaching specific performance thresholds rather than using traditional point-per-stat calculations.

## Current Implementation

### PFL Scoring System
The PFL system uses achievement thresholds as documented in SCORING_SYSTEM.md:

**Passing:**
- 175 yards = 6 points
- 250 yards = 9 points  
- 325 yards = 12 points
- 400 yards = 15 points
- TD Pass = 5 points each

**Rushing:**
- 50 yards = 3 points
- 75 yards = 6 points
- 100 yards = 9 points
- 150 yards = 12 points
- 200 yards = 15 points
- TD Scored = 8 points each

**Receiving:**
- 50 yards = 3 points
- 75 yards = 6 points
- 100 yards = 9 points
- 150 yards = 12 points
- 200 yards = 15 points
- TD Scored = 8 points each

**Defense (DST):**
- Points based on fewest points allowed
- Points based on fewest yards allowed

**Kicking:**
- Field goals and extra points as per PFL rules

### Scoring Players Selection
**Important**: Only the top 11 offensive players + 2 DST count toward team scores:
- 1 QB
- 4 RB
- 4 WR/TE
- 1 K
- 1 Bonus Player (best remaining offensive player)
- 2 DST (fewest points allowed + fewest yards allowed)

## Implementation Details

### PFL Scoring Calculation
```javascript
// server/services/scoringService.js
calculatePFLScore(stats) {
  let points = 0;
  
  // Passing thresholds
  if (stats.passing_yards >= 400) points += 15;
  else if (stats.passing_yards >= 325) points += 12;
  else if (stats.passing_yards >= 250) points += 9;
  else if (stats.passing_yards >= 175) points += 6;
  
  // Rushing thresholds
  if (stats.rushing_yards >= 200) points += 15;
  else if (stats.rushing_yards >= 150) points += 12;
  else if (stats.rushing_yards >= 100) points += 9;
  else if (stats.rushing_yards >= 75) points += 6;
  else if (stats.rushing_yards >= 50) points += 3;
  
  // Receiving thresholds
  if (stats.receiving_yards >= 200) points += 15;
  else if (stats.receiving_yards >= 150) points += 12;
  else if (stats.receiving_yards >= 100) points += 9;
  else if (stats.receiving_yards >= 75) points += 6;
  else if (stats.receiving_yards >= 50) points += 3;
  
  // TDs
  points += stats.passing_tds * 5;
  points += (stats.rushing_tds + stats.receiving_tds) * 8;
  
  return points;
}
```

## Configuration

### Scoring System Configuration

The PFL scoring system is the default and only scoring system used in StatFink. The system is configured through:

1. **Database Configuration**
```sql
-- The scoring_type in league_settings should be 'PFL'
SELECT scoring_type FROM league_settings WHERE league_id = 1;
```

2. **Service Implementation**
```javascript
// server/services/fantasyPointsCalculationService.js
const SCORING_MODE = 'PFL'; // Always PFL
```

## Scoring Validation

### Example Calculation
```javascript
// Test player with known stats
const testStats = {
  passing_yards: 300,
  passing_tds: 2,
  rushing_yards: 50,
  rushing_tds: 1,
  receiving_yards: 0,
  receiving_tds: 0
};

// PFL Calculation:
// Passing: 9 points (250-324 yard threshold)
// Passing TDs: 2 * 5 = 10 points
// Rushing: 3 points (50-74 yard threshold)
// Rushing TDs: 1 * 8 = 8 points
// Total: 9 + 10 + 3 + 8 = 30 points
```

## Season Recalculation

When recalculating scores for the season, the PFL scoring system is applied:

```bash
# Recalculate all scores using PFL system
node utils/recalculate2024season.js

# Verify calculations
sqlite3 fantasy_football.db "SELECT player_name, fantasy_points FROM weekly_player_stats WHERE week = 1 AND season = 2024 ORDER BY fantasy_points DESC LIMIT 10"
```

## Key Features of PFL Scoring

1. **Threshold-Based**: Rewards players for reaching performance milestones
2. **No Reception Points**: Unlike PPR, catches alone don't score points
3. **Balanced Scoring**: Designed to balance QB, RB, and WR values
4. **Defensive Importance**: DST selections can significantly impact scores
5. **Strategic Depth**: Requires careful consideration of which players will hit thresholds

## Troubleshooting

### Common Issues

1. **Incorrect Scores**: Ensure PFL calculation is being used, not traditional scoring
2. **Missing Thresholds**: Verify all threshold levels are properly implemented
3. **DST Scoring**: Confirm defensive scoring uses both points and yards allowed

### Verification Commands
```bash
# Check current scoring system
sqlite3 fantasy_football.db "SELECT * FROM league_settings"

# Verify a player's score calculation
sqlite3 fantasy_football.db "SELECT * FROM weekly_player_stats WHERE player_id = 'PLAYER_ID' AND week = 1"
```

## Conclusion

The PFL scoring system is a unique approach that creates exciting threshold moments during games. Players and teams benefit from reaching specific performance levels rather than accumulating stats incrementally. This system is integral to the StatFink fantasy football experience.