# Fantasy Football Google Sheets Export Specification

## Document Overview
- **Format**: Two tabs per week
- **Tab Structure**:
  - Tab 1: "Week X" - Detailed player grid with all rosters
  - Tab 2: "Week X Summary" - Simple standings with three ranking views
- **Layout**: Horizontal grid with owners as columns

## Required Data Elements

### 1. Owner Information (12 owners)
- Owner names
- Team names (if different from owner names)
- Current week points
- Cumulative season points
- Win-Loss-Tie record
- Current week opponent
- Match result (Win/Loss/Tie)

### 2. Player Roster Data (per owner)
Each owner must have exactly 19 players total:
- **Quarterbacks (QB)**: 2-3 players
- **Running Backs (RB)**: 5-6 players
- **Wide Receivers (WR)**: 6-7 players (includes TEs)
- **Tight Ends (TE)**: Mixed in with WR section
- **Kickers (K)**: 1-2 players
- **Defense/Special Teams (DST)**: 1-2 players
- **Total**: Exactly 19 players per team (not counting IR)

### 3. Player Information
For each player:
- **Player Name**: Full name
- **NFL Team**: Team abbreviation
- **Position**: QB/RB/WR/TE/K/DST
- **Fantasy Points**: Week's fantasy points
- **Scoring Status**: Whether player is in scoring lineup or on bench
- **Play Status**: Did they play this week

### 4. Scoring Data
- **Individual Player Points**: From database (already calculated)
- **Weekly Team Total**: From database (scoring players only)
- **Cumulative Season Points**: From database (running total through current week)
- **Scoring Player Count**: Number of players in scoring lineup

### 5. Matchup Information
For each of 6 matchups:
- Team 1 name and owner
- Team 1 score
- Team 2 name and owner  
- Team 2 score
- Winner designation
- Point differential

### 6. League Standings
- Rank (1-12)
- Team/Owner name
- Win-Loss-Tie record
- Win percentage
- Weekly points
- Weekly rank
- Cumulative points
- Points per game average
- Current streak (W2, L1, etc.)


## Layout Specification

### Tab 1: "Week X" - Player Grid Tab

#### Header Section (Row 1)
```
[Empty] | Owner1 | PTS | Owner2 | PTS | Owner3 | PTS | ... | Owner12 | PTS
```

#### Player Grid Section (Rows 2-40)
```
Position | Player(Team) | Points | Player(Team) | Points | ...
QB       | Name(Team)   | *XX    | Name(Team)   | XX     | ...
QB       | Name(Team)   | XX     | [Empty]      | [Empty]| ...
QB       | Name(Team)   | X      | Name(Team)   | *XX    | ...
[3-4 empty separator rows]
RB       | Name(Team)   | *XX    | Name(Team)   | *XX    | ...
RB       | Name(Team)   | XX     | Name(Team)   | X      | ...
RB       | Name(Team)   | X      | Name(Team)   | *XX    | ...
RB       | Name(Team)   | *XX    | [Empty]      | [Empty]| ...
RB       | Name(Team)   | XX     | Name(Team)   | XX     | ...
RB       | [Empty]      | [Empty]| Name(Team)   | X      | ...
[3-4 empty separator rows]
WR       | Name(Team)   | *XX    | Name(Team)   | XX     | ...
WR       | Name(Team)   | X      | Name(Team)   | *XX    | ...
WR       | Name(Team)   | XX     | [Empty]      | [Empty]| ...
WR       | Name(Team)   | *XX    | Name(Team)   | X      | ...
WR       | Name(Team)   | X      | Name(Team)   | XX     | ...
WR       | TE Name(Team)| X      | TE Name(Team)| *XX    | ... [TEs mixed in WR section]
WR       | [Empty]      | [Empty]| TE Name(Team)| XX     | ...
[2 empty separator rows]
K        | Name(Team)   | *8.5   | Name(Team)   | 6.5    | ...
K        | Name(Team)   | 2.5    | Name(Team)   | *7     | ...
[1 empty separator row]
DEF      | TeamName     | *5     | TeamName     | X      | ...
DEF      | TeamName     | X      | TeamName     | X      | ...
```

#### Summary Section (After player grid and 1 empty row)
```
WK.      | [Points]       |        | [Points]       |        | ...
CUM      | [Total]        |        | [Total]        |        | ...
         | Opponent(Score)|        | Opponent(Score)|        | ... 
         | Win/Loss       |        | Win/Loss       |        | ...
         | Record         |        | Record         |        | ...
```
Example:
```
WK.      | 61.5           |        | 53.5           |        | ...
CUM      | 133.5          |        | 158            |        | ...
         | Chris(109)     |        | Bruce(139)     |        | ...
         | Loss           |        | Loss           |        | ...
         | 0-2            |        | 1-1            |        | ...
```

#### Bottom Standings Table (After ~20 empty rows)
```
Team     | Week    | Total   | Record
Mitch    | 61.5    | 133.5   | 0-2
Cal      | 53.5    | 158     | 1-1
Eli      | 80.5    | 146.5   | 0-2
Chris    | 109     | 239.5   | 2-0
Mike     | 78.5    | 167.5   | 0-2
Joe      | 117.5   | 241.67  | 2-0
Dan      | 65.5    | 151     | 0-2
Aaron    | 114.5   | 278.17  | 2-0
Sean     | 105.5   | 199.5   | 1-1
Matt     | 80.5    | 166.67  | 1-1
Bruce    | 139     | 222.5   | 2-0
Pete     | 117     | 200     | 1-1
```

### Tab 2: "Week X Summary" - Standings Tab

Layout starts with one empty row, then three side-by-side tables:

```
[Empty row]
Team | Points This Week | [Empty] | Team | Overall Points | [Empty] | Standings |
Bruce| 139              |         | Aaron| 278.17         |         | Chris     | 2-0
Joe  | 117.5            |         | Joe  | 241.67         |         | Joe       | 2-0  
Pete | 117              |         | Chris| 239.5          |         | Aaron     | 2-0
Aaron| 114.5            |         | Bruce| 222.5          |         | Bruce     | 2-0
Chris| 109              |         | Pete | 200            |         | Cal       | 1-1
Sean | 105.5            |         | Sean | 199.5          |         | Sean      | 1-1
Matt | 80.5             |         | Mike | 167.5          |         | Matt      | 1-1
Eli  | 80.5             |         | Matt | 166.67         |         | Pete      | 1-1
Mike | 78.5             |         | Cal  | 158            |         | Mitch     | 0-2
Dan  | 65.5             |         | Dan  | 151            |         | Eli       | 0-2
Mitch| 61.5             |         | Eli  | 146.5          |         | Mike      | 0-2
Cal  | 53.5             |         | Mitch| 133.5          |         | Dan       | 0-2
```

## Data Formatting Rules

### Point Values
- **Scoring player**: `*XX.X` (asterisk prefix)
- **Bench player**: `XX.X` (no prefix)
- **Did not play**: `X`
- **Empty slot**: Blank cell
- **Decimal precision**: 
  - Most positions: 1 decimal (e.g., 14.5)
  - Can show whole numbers without decimal (e.g., 14)

### Player Name Format
- Standard: `FirstName LastName(TeamAbbr)`
- Examples:
  - `Patrick Mahomes(Chiefs)`
  - `Tyreek Hill(Dolphins)`
  - `Davante Adams(Raiders)`
- Defenses: `TeamName` only (e.g., `Chiefs`, `49ers`)

### Team Abbreviations
Standard NFL abbreviations:
- ARI, ATL, BAL, BUF, CAR, CHI, CIN, CLE
- DAL, DEN, DET, GB, HOU, IND, JAX, KC
- LAC, LAR, LV, MIA, MIN, NE, NO, NYG
- NYJ, PHI, PIT, SF, SEA, TB, TEN, WAS

### Record Format
- Standard: `W-L` (e.g., `2-0`, `1-1`, `0-2`)
- With ties: `W-L-T` (e.g., `1-0-1`)

## Data Source Rules

### Weekly Points
- Pull directly from database (already calculated)
- Only scoring players counted (marked with `*`)
- No calculation needed in export

### Cumulative Points  
- Pull directly from database
- Already calculated as running total

### Win/Loss Determination
- Pull from database matchup results
- Records already determined and stored

### Roster Validation
- Each team must have exactly 19 players (excluding IR)
- Players on IR are not shown in export
- Scoring lineup must follow league rules:
  - Specific number of each position
  - Legal lineup configuration

## Position Requirements

### Standard Scoring Lineup
Typical configuration (verify with league settings):
- 1 QB
- 2 RB  
- 2 WR
- 1 TE
- 1 FLEX (RB/WR/TE)
- 1 K
- 1 DST
- **Total**: 9 scoring players

### Bench Spots
- Remaining 10 players
- Can be any position
- Shows points but not counted in team total

## Quality Checks

### Data Integrity
1. All 12 owners present
2. Each owner has 19 players (not counting IR)
3. Weekly points from database
4. Records from database
5. Cumulative points from database

### Visual Verification
1. Scoring players marked with asterisk
2. Empty rows between position groups
3. All matchups show winner
4. Standings sorted correctly
5. No duplicate players

### Edge Cases
1. Player on IR - not shown in export
2. Player didn't play - show "X" for points
3. Player traded mid-week - show on new team
4. Bye weeks - player shows "X" or "0"
5. Empty roster slots - leave blank

## Export Metadata
Should track:
- Export timestamp
- Week number
- Season year
- Any warnings or data issues

## Implementation Notes

### Sheet Structure
- Two tabs per week:
  - Tab 1 "Week X": Comprehensive player grid with all rosters and summary
  - Tab 2 "Week X Summary": Simple three-table standings view
- Horizontal layout maximizes screen usage
- Tab 1 contains all detailed data
- Tab 2 provides quick standings overview

### Visual Formatting
- **Headers**: Bold, centered
- **Position labels**: Left column, bold
- **Scoring indicators**: Asterisk prefix inline with points
- **Empty rows**: 
  - 3-4 rows between QB and RB sections
  - 3-4 rows between RB and WR sections
  - 2 rows between WR and K sections
  - 1 row between K and DEF sections
  - 1 row between DEF and summary rows
  - ~20 rows between summary and bottom table
- **Tab 2 Tables**: Three side-by-side tables with different sorts
- **Colors** (optional):
  - Green for wins
  - Red for losses
  - Gray for injured/inactive

### Data Flow
1. Collect roster data from database (excluding IR players)
2. Get scoring vs bench designation from database
3. Get fantasy points from database
4. Get team totals from database
5. Get matchup results from database
6. Get records and standings from database
7. Format for Tab 1 (player grid + summary)
8. Format for Tab 2 (three standings tables)
9. Write both tabs to Google Sheets

### Error Handling
- Validate 19 players per team (excluding IR) before export
- Check for null/missing data
- Log any discrepancies
- Provide clear error messages

## Key Differences Between Tabs

### Tab 1 "Week X" - Detailed View
- Complete player rosters for all 12 owners
- Players organized by position (QB, RB, WR, K, DEF)
- Shows which players are scoring (*) vs bench
- Includes summary rows (WK., CUM, matchup results)
- Bottom table with basic standings
- Everything in one comprehensive view

### Tab 2 "Week X Summary" - Quick Reference
- No player details
- Three focused tables:
  1. Weekly points ranking
  2. Overall points ranking  
  3. Win-loss standings
- Clean, simple layout for quick scanning
- Each table sorted differently for different perspectives

This specification ensures a complete weekly fantasy football export with both detailed player data (Tab 1) and quick reference standings (Tab 2).