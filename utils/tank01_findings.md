# Tank01 API Data Structure Findings

## Summary of Investigation

After manually testing Tank01 API responses from multiple 2024 games, here are the key findings about missing data in our import script:

## 🔍 Key Findings

### 1. ✅ Two-Point Conversions - **FOUND but NOT in playerStats**
- **Location**: `teamStats.away.twoPointConversions` and `teamStats.home.twoPointConversions`
- **Format**: String numbers (e.g., "0", "1")
- **Issue**: Our current script only looks in individual `playerStats`, but 2pt conversions are tracked at team level
- **Action Required**: Need to extract from team stats and attribute to specific players via play-by-play data

### 2. ✅ Team Defense Stats - **FOUND in DST section**
- **Location**: `DST.away` and `DST.home` objects
- **Available Fields**:
  - `defTD` - Defensive touchdowns
  - `defensiveInterceptions` - Interceptions
  - `sacks` - Sacks
  - `fumblesRecovered` - Fumble recoveries  
  - `safeties` - Safeties
  - `ptsAllowed` - Points allowed
  - `ydsAllowed` - Yards allowed
- **Issue**: Our script doesn't extract DST data at all
- **Action Required**: Add DST extraction logic to import script

### 3. ✅ Individual Defensive Stats - **FOUND in Defense section**
- **Location**: `playerStats[playerID].Defense` object for individual players
- **Available Fields**:
  - `Defense.totalTackles`
  - `Defense.soloTackles` 
  - `Defense.qbHits`
- **Issue**: Our script doesn't look in the `Defense` category
- **Action Required**: Add Defense stats extraction for individual players

### 4. ❌ Kick/Punt Return TDs - **NOT FOUND**
- **Searched**: Individual player stats, team stats, DST stats
- **Status**: No return TD data found in any Tank01 responses tested
- **Possible Reasons**: 
  - May be in different field names not searched
  - May be tracked differently in Tank01
  - May require special teams specific API calls
- **Action Required**: Further investigation needed or accept limitation

### 5. ❌ Individual Two-Point Conversions - **NOT FOUND**
- **Searched**: `TwoPoint`, `twoPoint`, nested in `Passing`/`Rushing`/`Receiving`
- **Status**: No individual player 2pt conversion data found
- **Issue**: Tank01 only tracks 2pt conversions at team level
- **Action Required**: Would need play-by-play parsing to attribute to specific players

## 📊 Data Structure Summary

### Player Stats Structure
```javascript
playerStats: {
  "playerID": {
    "longName": "Player Name",
    "team": "TEAM",
    "teamAbv": "TEAM", 
    "Passing": { passYds, passTD, int, passAttempts, passCompletions },
    "Rushing": { rushYds, rushTD, carries },
    "Receiving": { recYds, recTD, receptions, targets },
    "Kicking": { fgMade, fgAttempts, xpMade, xpAttempts },
    "Defense": { totalTackles, soloTackles, qbHits }, // NEW FINDING
    "Fumbles": { fumbles },
    "fantasyPoints": "calculated_value"
  }
}
```

### DST (Team Defense) Structure  
```javascript
DST: {
  "away": {
    "teamAbv": "TEAM",
    "teamID": "3",
    "defTD": "0",                    // NEW: Defensive TDs
    "defensiveInterceptions": "1",   // NEW: Team interceptions  
    "sacks": "2",                   // NEW: Team sacks
    "fumblesRecovered": "0",        // NEW: Team fumble recoveries
    "safeties": "0",                // NEW: Safeties
    "ptsAllowed": "27",             // NEW: Points allowed
    "ydsAllowed": "353"             // NEW: Yards allowed
  },
  "home": { /* same structure */ }
}
```

### Team Stats Structure
```javascript
teamStats: {
  "away": {
    "twoPointConversions": "0",     // NEW: Team 2pt conversions
    "defensiveOrSpecialTeamsTds": "0"
  },
  "home": { /* same structure */ }
}
```

## 🚀 Action Plan

### Immediate Fixes (High Priority)
1. **Add DST stats extraction** - Extract team defense stats from `DST` section
2. **Add individual defense stats** - Extract from `playerStats[id].Defense`
3. **Add database column** for return TDs (even if data not available yet)

### Future Enhancements (Medium Priority) 
1. **Two-point conversion attribution** - Parse play-by-play to attribute team 2pt conversions to specific players
2. **Return TD investigation** - Research if Tank01 has return TD data in other endpoints

### Database Schema Updates Needed
1. Verify `return_tds` column exists (need to add)
2. Ensure all defensive stat columns are properly mapped

## 🔧 Implementation Strategy

1. **Update `backfill2024Stats.js`**:
   - Add DST stats extraction in `extractPlayerStats()` method
   - Add individual Defense stats extraction  
   - Add proper error handling and logging

2. **Create DST player records**:
   - Generate virtual DST "players" for each team 
   - Map DST stats to these virtual players
   - Ensure proper fantasy points calculation

3. **Test on sample data**:
   - Run updated script on a few games first
   - Verify DST stats appear correctly in database
   - Check fantasy points calculations include new stats

This investigation provides a clear roadmap for fixing the missing defensive stats issue in our Tank01 import.