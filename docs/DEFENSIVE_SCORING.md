# Defensive Scoring Implementation Guide

## Overview
This document explains the defensive touchdown scoring logic that needs to be implemented to properly handle all types of defensive scores, including the critical distinction between defensive touchdowns and special teams touchdowns.

## Key Issues Discovered

### 1. Blocked Punt/Kick Returns Are Defensive TDs
- **Problem**: Blocked punt returns and blocked kick returns were being categorized as special teams touchdowns (punt_return_tds/kick_return_tds)
- **Solution**: These should count as defensive touchdowns worth 8 points to the team defense
- **Example**: CHI Defense Week 1 - Jonathan Owens' 21 Yd Return of Blocked Punt should be a defensive TD

### 2. Missing Defensive Touchdowns
- The Tank01 API provides a generic `defTD` count in the DST object, but doesn't specify the type
- Scoring plays need to be parsed to determine:
  - Interception return TDs
  - Fumble return TDs  
  - Blocked punt/kick/field goal return TDs

### 3. Special Teams vs Defensive Scoring
- **Defensive TDs** (8 points for team defense):
  - Interception returns for TD
  - Fumble returns for TD
  - Blocked punt/kick/FG returns for TD
  - Safeties (2 points)
- **Special Teams TDs** (20 points for individual player, 0 for defense):
  - Regular punt returns for TD
  - Regular kickoff returns for TD

## Implementation Requirements

### 1. Update Scoring Play Parsing
In the stats sync service, when processing scoring plays:

```javascript
// Check for defensive touchdown types
if (scoreText.includes('interception return') && scoreText.includes('touchdown')) {
    // This is a defensive TD - 8 points for defense
} else if (scoreText.includes('fumble return') && scoreText.includes('touchdown')) {
    // This is a defensive TD - 8 points for defense
} else if (scoreText.includes('blocked') && scoreText.includes('return') && scoreText.includes('touchdown')) {
    // Blocked punt/kick/FG return - defensive TD - 8 points for defense
} else if (scoreText.includes('punt return') && scoreText.includes('touchdown')) {
    // Regular punt return - special teams TD - 20 points for player, 0 for defense
} else if (scoreText.includes('kick return') && scoreText.includes('touchdown')) {
    // Regular kick return - special teams TD - 20 points for player, 0 for defense
}
```

### 2. Process Defensive TDs at Game Level
Since the Tank01 DST data only provides aggregate `defTD` counts without details, you need to:
1. Parse all scoring plays from the game
2. Identify which team's defense scored
3. Properly categorize the type of defensive TD
4. Apply these to the team defense stats

### 3. Database Fields
Ensure these fields are properly populated:
- `def_int_return_tds` - Interception returns for TD
- `def_fumble_return_tds` - Fumble returns AND blocked punt/kick returns for TD
- `kick_return_tds` - Regular kickoff returns (special teams)
- `punt_return_tds` - Regular punt returns (special teams)

### 4. Known Blocked Returns in 2024
These plays need to be categorized as defensive TDs:
1. Week 1: CHI - Jonathan Owens 21 Yd Return of Blocked Punt
2. Week 6: NYG - Ihmir Smith-Marsette 68 Yd Return of Blocked Punt  
3. Week 12: SEA - Coby Bryant 69 Yd Return of Blocked Field Goal
4. Week 17: TB - J.J. Russell 23 Yd Return of Blocked Punt

## Testing
After implementation, verify:
1. CHI Defense Week 1 should have 16 points (1 INT return TD + 1 blocked punt TD)
2. Individual players with punt/kick returns get 20 points
3. Team defenses don't get points for regular punt/kick returns
4. Team defenses DO get 8 points for blocked punt/kick returns

## Key Principle
The determining factor is whether the play was a DEFENSIVE play (blocked kick/punt, interception, fumble recovery) or a SPECIAL TEAMS play (regular return). Defensive plays that result in TDs are worth 8 points to the team defense. Special teams plays are worth 20 points to the individual player only.