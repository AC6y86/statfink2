# Draft Import Process for StatFink

This document describes how to import draft results from a CSV file into the StatFink database as weekly rosters.

## Overview

The draft import system converts a CSV export of draft results into weekly_rosters entries with proper Tank01 player IDs. This ensures all players are correctly matched to their database records.

## Prerequisites

1. **Player Database Must Be Current**
   - Run Tank01 player sync before importing to ensure all players exist in the database
   - Set `RAPIDAPI_KEY` environment variable if syncing from Tank01

2. **CSV Format Requirements**
   - Must match the standard draft export format
   - Required columns: `pick, overall, franchise, player, position, NFL team, notes`
   - Header rows before data are automatically handled

## Import Process

### 1. Prepare the CSV File

Place your draft results CSV in an accessible location. The standard format looks like:

```csv
DRAFT SUMMARY
League Name:,PFL 2024
Date Started:,1969-12-31T16:00:02
Mock Draft:,Yes
Draft Type:,order


DRAFT PICKS
pick,overall,franchise,player,position,NFL team,notes
"=""1.01""",1,Mitch,Patrick Mahomes,QB,KC,
"=""1.02""",2,Cal,Josh Allen,QB,BUF,
...
```

### 2. Create a Runner Script

Create a temporary script to run the import. Example for 2025 Week 1:

```javascript
#!/usr/bin/env node

const DatabaseManager = require('./server/database/database');
const DraftImporter = require('./server/utils/draftImporter');
const PlayerSyncService = require('./server/services/playerSyncService');
const Tank01Service = require('./server/services/tank01Service');

const DRAFT_CSV_PATH = '/path/to/draft-results.csv';
const WEEK = 1;
const SEASON = 2025;

async function main() {
    const db = new DatabaseManager();
    
    try {
        // Optional: Sync players from Tank01 first
        if (process.env.RAPIDAPI_KEY) {
            const tank01Service = new Tank01Service(process.env.RAPIDAPI_KEY, db);
            const playerSyncService = new PlayerSyncService(db, tank01Service);
            await playerSyncService.syncPlayers();
        }
        
        // Run the import
        const importer = new DraftImporter(db);
        const result = await importer.importDraft(DRAFT_CSV_PATH, WEEK, SEASON);
        
        console.log('Import successful!', result);
    } finally {
        await db.close();
    }
}

main().catch(console.error);
```

### 3. Run the Import

```bash
node /tmp/runDraftImport2025.js
```

## Key Features

### 100% Player Matching Required
- The import will **fail** if any player cannot be matched to a Tank01 ID
- This ensures data integrity and prevents partial imports

### Automatic Position Normalization
- `PK` → `K` (Kickers)
- `TD` → Team defenses are matched by team name

### Team Mapping
The following owner names are mapped to team IDs:
- Mitch → 1
- Cal → 2
- Eli → 3
- Chris → 4
- Mike → 5
- Joe → 6
- Dan → 7
- Aaron → 8
- Sean → 9
- Matt → 10
- Bruce → 11
- Pete → 12

### Player Matching Strategies
1. **Exact Match**: Name + Position + Team
2. **Name Variations**: Removes Jr./Sr./III suffixes
3. **Team Changes**: Matches by name + position if player changed teams
4. **Free Agents**: Special handling for "fa" team designation
5. **Fuzzy Matching**: Last resort for close name matches

## Troubleshooting

### Unmatched Players
If players fail to match, the import will:
1. Stop immediately (no partial imports)
2. Show detailed error for each unmatched player
3. Suggest similar players in the database

Example error:
```
Unmatched: Deebo Samuel Sr. (WR, WAS)
  Owner: Dan, Pick: 3.07
  Similar players in database:
    - Deebo Samuel Sr. (WR, SF) [3126486]
```

**Common Fixes:**
- Player changed teams: The player might have a new team in real life
- Name variations: Check for different spellings or suffixes
- Missing player: Run Tank01 sync to get latest player data

### Defense Matching Issues
Team defenses use various formats:
- Draft CSV: "Baltimore Ravens" 
- Database: "BAL Defense" or "Baltimore Ravens Defense"

The importer handles these automatically, but verify defense mappings if issues occur.

### Database Errors
- Ensure database file exists and is writable
- Check that schema is up to date
- Verify foreign key constraints are met

## Post-Import Verification

After successful import, verify:
1. All 12 teams have exactly 19 players
2. No duplicate players across teams
3. All positions are represented appropriately
4. Run `recalculate2024season.js` if importing historical data

## Database Structure

Imported rosters are stored in `weekly_rosters` table with:
- `team_id`: Owner's team ID
- `player_id`: Tank01 player ID
- `week`: Week number (e.g., 1 for draft)
- `season`: Year (e.g., 2025)
- `roster_position`: 'active' for all draft picks
- `player_name`, `player_position`, `player_team`: Denormalized for history

## Future Imports

This same process can be used for:
- Mid-season roster snapshots
- Keeper league draft results
- Dynasty startup drafts

Just adjust the WEEK and SEASON parameters accordingly.