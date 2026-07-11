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

### 3. Special Teams vs Defensive vs Offensive Scoring
- **Defensive TDs** (8 points for team defense):
  - Interception returns for TD
  - Opponent's fumble returned/recovered for TD (a takeaway — the fumbling team was on offense)
  - Blocked punt/kick/FG returns for TD
  - Muffed punt or returner's fumble recovered by the kicking (coverage) team for TD (special-teams takeaway)
  - Safeties (2 points)
- **Special Teams TDs** (20 points for individual player, 0 for defense):
  - Regular punt returns for TD
  - Regular kickoff returns for TD
- **Offensive fumble-recovery TDs** (8 points for the recovering player, 0 for defense):
  - An offensive player recovering his own or a teammate's fumble in (or into) the end zone
  - Own-fumble recoveries are already counted as the player's rushing TD in NFL stats (e.g., Tank Bigsby wk 5 2024)
  - Teammate-fumble recoveries are a "Touchdown Scored (by any player)" for the recoverer (e.g., Trey McBride wk 2 2024)

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

### 4. 2024 Official-Record Corrections
The league's official 2024 record (tests/2024/statfinkv1_2024.db) contained 3
scorekeeping errors under the rules above, corrected by commissioner ruling
(pre-correction copy: backup_data/statfinkv1_2024_pre-correction-2026-07-11.db):
1. Week 2: Trey McBride 3 → 11 — his 0-yd recovery of a teammate's fumble in the
   end zone is an offensive TD (player +8)
2. Week 2: Cardinals DEF 8 → 0 — that same TD had been wrongly credited to the defense
3. Week 4: Falcons DEF 16 → 8 — KhaDarel Hodge's end-zone fumble recovery came on
   an 8-play ATL offensive drive (Bijan Robinson's fumble); offensive TD, not defensive

### 5. 2025 Official-Record Corrections
The as-played 2025 record (statfink2 was the live scorer) contained 16
scorekeeping errors, corrected by commissioner ruling on 2026-07-11. Every
correction was verified against ESPN play-by-play data. Pre-correction copy:
backup_data/fantasy_football_pre-2025-recalc-2026-07-11.db.

Uncredited return TDs (+20 each, per "Kick or Punt Returner" rule; none rostered):
Gibson wk2 (90 KR), M. Washington wk2 (74 PR), Lane wk3 (90 PR), Horton wk3
(95 PR), Raymond wk4 (65 PR), P. Washington wk4 (87 PR) & wk10 (73 PR),
C. Jones wk9 (98 KR), Dike wk9 (67 PR) & wk12 (90 PR), I. Williams wk10
(74 PR), Nwangwu wk10 (99 KR).

Fumble-recovery TDs (per "Defensive Touchdowns — Exact Award Logic"):
- Wk 5: Tyler Lockett +8 / Titans DEF −8 — offensive end-zone recovery on a
  TEN drive, wrongly credited to the defense
- Wk 7: Patriots DEF +8 — Chaisson sack-fumble takeaway TD, dropped by the
  old short-yardage filter (Joe +8 in the wk 7 matchup)
- Wk 15: Woody Marks +8 — recovered Stroud's aborted-snap fumble on a HOU
  drive (Pete +8 in the wk 15 matchup)

Matchup/record effects: wk 12 Pete 54→74 (Ray Davis's correctly-scored KR TD
finally reflected in Pete's scoring lineup) — Pete beats Dan, records become
Pete 7-5 / Dan 4-8; wk 18 Pete matchup value 102.67→85.67 (as-played value was
corrupted by the removed teamScoreService full-roster overwrite bug).

Known limitation: return TDs by defensive players not in nfl_players (Marcus
Jones wk4+wk13, Deonte Banks wk17 — all CBs) are credited to no one. CBs are
not draftable in this league, so the points could never count for any team.

### 6. Known Blocked Returns in 2024
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
The determining question is: **did the ball change possession on the play (or was the kick blocked)?**
- Takeaway and blocked-kick TDs (interception, opponent's fumble, blocked punt/kick/FG, muffed punt recovered by the coverage team) → 8 points to the Team Defense.
- Regular kick/punt return TDs (same possession, special teams) → 20 points to the individual returner only.
- Fumble recoveries by the team already on offense (own or teammate's fumble) → an OFFENSIVE TD: 8 points to the recovering player, nothing to the Team Defense. See docs/SCORING_SYSTEM.md "Defensive Touchdowns — Exact Award Logic".