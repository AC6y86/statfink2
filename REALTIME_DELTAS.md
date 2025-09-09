# Real-Time Deltas and Bold Stats Documentation

## Overview
The StatFink fantasy football application displays real-time score changes and stat updates through visual indicators:
- **Green Plus Signs (+X.XX)**: Show point increases for players and teams
- **Bold Text**: Highlights recently changed statistics

These indicators appear only for live changes while a user is actively viewing the page, providing immediate visual feedback when scores update.

## Core Design Principles

1. **Clean Initial State**: No indicators on page load or refresh
2. **Session-Based Tracking**: Changes tracked only during active viewing session
3. **30-Second Duration**: All indicators automatically expire after 30 seconds
4. **Memory-Only Storage**: No persistence across page loads or refreshes

## Technical Implementation

### Session Management

```javascript
// Memory-only session state
var sessionStats = {};        // Current session baseline stats
var sessionScores = {};       // Current session baseline scores  
var sessionStartTime = Date.now();  // Track when session started
var isFirstLoad = true;       // Track if this is the first data load
```

The session is initialized on:
- Page load
- Manual refresh
- Tab visibility change (returning to tab)

### Indicator Display Logic

#### Green Delta Signs (+X.XX)
- **Appears when**: Player or team score increases by > 0.01 points
- **Color**: Green (#2e7d32)
- **Format**: `+X.XX` prefix before actual score
- **CSS Class**: `score-delta`
- **Location**: 
  - Individual player point totals
  - Team total scores in matchup headers
  - League sidebar team scores

#### Bold Stats
- **Appears when**: Any individual stat changes (yards, TDs, etc.)
- **CSS Class**: `stat-changed`
- **Applies to**:
  - Individual stat values (passing yards, rushing TDs, etc.)
  - Fantasy point totals
  - Team scores

### Update Flow

#### 1. Initial Page Load
```javascript
function initializeSession() {
    sessionStats = {};
    sessionScores = {};
    sessionStartTime = Date.now();
    isFirstLoad = true;
}
```
- Session starts fresh
- No previous data to compare
- First load flag prevents any indicators

#### 2. First Data Load
```javascript
// In loadMatchup()
if (isFirstLoad) {
    isFirstLoad = false;
    // Future updates will now show indicators
}
```
- Establishes baseline for comparisons
- Sets isFirstLoad to false for subsequent updates
- Still shows no indicators (as intended)

#### 3. Live Updates (Every 30 seconds)
```javascript
async function refreshData() {
    // ... fetch new data ...
    await loadMatchup(currentMatchupId);
}
```

The comparison flow:
1. `compareStats()` compares current vs session baseline
2. Detects changes and calculates deltas
3. Preserves indicators within 30-second window
4. Returns changes object with team1/team2 changes and deltas

#### 4. Display Logic
```javascript
// Delta display
if (hasScoreDelta) {
    pointsDisplay = `<span class="score-delta">${delta > 0 ? '+' : ''}${delta.toFixed(2)}</span> ${points.toFixed(2)}`;
}

// Bold stats
const pointsClass = (playerChangedStats.includes('fantasy_points') || hasScoreDelta) 
    ? 'points fanpts score-changed' 
    : 'points fanpts';
```

### Time Window Management

The 30-second window is enforced by `shouldShowIndicator()`:

```javascript
function shouldShowIndicator(changeTime) {
    if (!changeTime || isFirstLoad) return false;
    const timeSinceChange = Date.now() - changeTime;
    const timeSinceSessionStart = changeTime - sessionStartTime;
    // Only show if change happened after session started and within 30 seconds
    return timeSinceSessionStart > 0 && timeSinceChange <= 30000;
}
```

### Change Detection

#### Stats Comparison
```javascript
// In compareStats()
if (previousValue !== undefined && currentValue !== previousValue) {
    // Value just changed - mark as bold
    changedStats.push(stat);
} else if (shouldShowIndicator(prevPlayer.lastChanged?.[stat])) {
    // Still within 30-second window - keep bold
    changedStats.push(stat);
}
```

#### Delta Calculation
```javascript
const delta = currentPoints - previousPoints;
if (Math.abs(delta) > 0.01) {
    // New change detected
    deltas.team1[player.player_id] = delta;
} else if (shouldShowIndicator(prevPlayer.fantasyPointsLastChanged)) {
    // Still within 30-second window - preserve delta
    deltas.team1[player.player_id] = prevPlayer.fantasyPointsDelta || 0;
}
```

## User Experience

### What Users See

1. **Fresh Page Load**: Clean display with current scores, no indicators
2. **While Watching**: 
   - Score increases show green +X.XX
   - Changed stats appear in bold
   - Indicators persist for 30 seconds
3. **After 30 Seconds**: Indicators fade automatically
4. **On Refresh**: All indicators cleared, fresh baseline

### Example Scenarios

**Scenario 1: Touchdown Scored**
- Player catches TD while user watching
- Receiving yards change → bold for 30 seconds
- Receiving TDs change → bold for 30 seconds  
- Fantasy points increase → green +6.00 for 30 seconds
- Team total increases → green +6.00 for 30 seconds

**Scenario 2: Page Refresh During Game**
- User hits F5 to refresh
- Page reloads with current scores
- No indicators shown (clean state)
- Future changes will show indicators

**Scenario 3: Tab Switch**
- User switches to another tab
- Returns 5 minutes later
- Session resets on visibility change
- No stale indicators shown
- Fresh baseline established

## CSS Styling

```css
/* Green delta indicators */
.score-delta {
    color: #2e7d32;
    font-size: 0.85em;
    font-weight: bold;
    margin-right: 3px;
}

/* Bold changed stats */
.stat-changed {
    font-weight: bold !important;
}

/* Bold score changes */
.score-changed {
    font-weight: bold !important;
}
```

## Files Involved

- **helm/statfink.html**: Main implementation
  - Session management
  - Change detection logic
  - Display rendering
  - Update intervals
  
- **helm/statfink-styles.css**: Visual styling
  - Delta colors and formatting
  - Bold text styling
  
- **scripts/live-update-continuous.js**: Backend updates
  - Triggers data refreshes every 30 seconds
  - Calls API endpoints for live data

## Configuration Constants

- **Update Interval**: 30 seconds (matches backend update frequency)
- **Indicator Duration**: 30 seconds (hardcoded in `shouldShowIndicator`)
- **Delta Threshold**: 0.01 points (minimum change to show)
- **Session Reset Triggers**:
  - Page load/refresh
  - Tab visibility change
  - Manual initialization

## Benefits of This Approach

1. **Clean User Experience**: No confusing stale indicators
2. **Real-Time Awareness**: Immediate visual feedback for changes
3. **Performance**: Memory-only storage, no localStorage overhead
4. **Predictable Behavior**: Consistent 30-second windows
5. **Multi-Tab Friendly**: Each tab maintains independent session

## Potential Future Enhancements

1. **Negative Deltas**: Show red indicators for point losses (fumbles, interceptions)
2. **Configurable Duration**: Allow users to adjust 30-second window
3. **Animation**: Fade in/out effects for indicators
4. **Sound Alerts**: Optional audio for scoring plays
5. **Change History**: Small log of recent changes
6. **Customizable Colors**: User preferences for indicator colors

## Testing Considerations

To test the real-time indicators:

1. **Live Game Testing**:
   - Open page during active games
   - Watch for 30+ seconds
   - Verify indicators appear on score changes
   - Confirm 30-second expiration

2. **Mock Mode Testing**:
   - Use `/statfink/mock/[week]` endpoint
   - Simulates game progression
   - Updates every 30 seconds
   - Good for testing without live games

3. **Session Reset Testing**:
   - Refresh page - should clear all indicators
   - Switch tabs and return - should reset
   - Open multiple tabs - each independent

## Troubleshooting

**Indicators not appearing:**
- Check if `isFirstLoad` is properly set to false
- Verify update interval is running
- Ensure backend is providing updated data

**Indicators persisting too long:**
- Check `shouldShowIndicator()` logic
- Verify timestamps are being updated
- Ensure 30-second window calculation is correct

**Indicators showing on page load:**
- Verify `initializeSession()` is called
- Check `isFirstLoad` flag is true initially
- Ensure `compareStats()` returns empty on first load

## Conclusion

The real-time delta and bold stats system provides immediate, clear feedback for fantasy football scoring changes while maintaining a clean, predictable user interface. The session-based approach ensures users see only relevant, timely information without the confusion of stale indicators from previous sessions.