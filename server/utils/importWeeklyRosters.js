#!/usr/bin/env node

const sqlite3 = require('sqlite3').verbose();
const { execSync } = require('child_process');
const path = require('path');

// Database path
const dbPath = path.join(__dirname, '../../fantasy_football.db');

// Team name mapping to database team IDs
const teamMapping = {
    'Mitch': 1,
    'Cal': 2, 
    'Eli': 3,
    'Chris': 4,
    'Mike': 5,
    'Joe': 6,
    'Dan': 7,
    'Aaron': 8,
    'Sean': 9,
    'Matt': 10,
    'Bruce': 11,
    'Pete': 12
};

// Position mapping 
const positionMap = {
    'QB': 'QB',
    'RB': 'RB', 
    'WR': 'WR',
    'TE': 'TE',
    'K': 'K',
    'DST': 'DST',
    'D/ST': 'DST'
};

function parsePlayerName(playerText) {
    if (!playerText || playerText === '' || typeof playerText !== 'string') {
        return null;
    }
    
    // Remove leading * (starter indicator)
    let cleanText = playerText.replace(/^\*/, '');
    
    // Extract player name and team
    const match = cleanText.match(/^([^(]+)\(([^)]+)\)/);
    if (match) {
        const playerName = match[1].trim();
        const teamAbbrev = match[2].trim();
        return { name: playerName, team: teamAbbrev };
    }
    
    return null;
}

function isStarter(playerText) {
    return playerText && playerText.toString().startsWith('*');
}

async function extractWeekData(weekNum) {
    console.log(`Extracting Week ${weekNum} data...`);
    
    const pythonScript = `
import openpyxl
import json
import sys

wb = openpyxl.load_workbook('/Users/joepaley/Downloads/PFL 2024.xlsx')
sheet_name = 'Week ${weekNum}'

if sheet_name not in wb.sheetnames:
    print(json.dumps({"error": f"Sheet {sheet_name} not found"}))
    sys.exit(1)

ws = wb[sheet_name]

# Get team names from row 1
team_row = list(ws.iter_rows(min_row=1, max_row=1, values_only=True))[0]
teams = []
for i, cell in enumerate(team_row):
    if cell and cell not in ['', 'PTS']:
        teams.append({"col": i, "name": cell})

# Extract roster data
rosters = {}
current_position = None

for row_num, row in enumerate(ws.iter_rows(min_row=2, values_only=True), 2):
    if not row or not any(cell for cell in row):
        continue
        
    # Check if this is a position header row
    if row[0] and str(row[0]).strip() in ['QB', 'RB', 'WR', 'TE', 'K', 'DST', 'D/ST', 'DEF']:
        current_position = str(row[0]).strip()
        if current_position == 'DEF':
            current_position = 'DST'  # Normalize DEF to DST
        continue
    
    # Skip header rows and non-player data
    first_cell = str(row[0] if row[0] else '').strip()
    if first_cell in ['Texans', 'Giants', 'Cowboys', 'Jets', 'Cardinals', 'Falcons', 'Bears', 'Lions', 'Ravens', 'Bills', 'Chiefs', 'Patriots', 'Dolphins', 'Seahawks', 'Steelers', 'Panthers', 'Bengals', 'Colts', 'Saints', 'Jaguars', 'Browns', 'Broncos', '49ers', 'Eagles', 'Week', 'Record', 'Loss', 'Win', 'PTS']:
        continue
    
    if not current_position:
        continue
        
    # Process each team's player in this row
    for team in teams:
        col_idx = team["col"]
        team_name = team["name"]
        
        if team_name not in rosters:
            rosters[team_name] = []
            
        if col_idx < len(row) and row[col_idx]:
            player_text = str(row[col_idx])
            # Special handling for DST - team names without parentheses
            if current_position == 'DST':
                clean_text = player_text.replace('*', '').strip()
                # Only import valid NFL team names for DST
                valid_teams = ['Texans', 'Giants', 'Cowboys', 'Jets', 'Cardinals', 'Falcons', 'Bears', 'Lions', 'Ravens', 'Bills', 'Chiefs', 'Patriots', 'Dolphins', 'Seahawks', 'Steelers', 'Panthers', 'Bengals', 'Colts', 'Saints', 'Jaguars', 'Browns', 'Broncos', '49ers', 'Eagles', 'Rams', 'Chargers', 'Raiders', 'Vikings', 'Packers', 'Titans', 'Buccaneers', 'Commanders']
                if (clean_text in valid_teams and 
                    not clean_text.replace('.', '').replace('X', '').isdigit() and
                    not player_text.startswith('=')):
                    # For DST, wrap team name in parentheses format
                    formatted_text = f"{clean_text}(DST)"
                    if player_text.startswith('*'):
                        formatted_text = '*' + formatted_text
                    rosters[team_name].append({
                        "position": current_position,
                        "player_text": formatted_text,
                        "is_starter": player_text.startswith('*')
                    })
            else:
                # Regular player handling (must have parentheses)
                if (player_text and player_text.strip() and 
                    '(' in player_text and ')' in player_text and
                    not player_text.replace('*', '').replace('.', '').replace('X', '').isdigit() and
                    not player_text.startswith('=')):
                    rosters[team_name].append({
                        "position": current_position,
                        "player_text": player_text,
                        "is_starter": player_text.startswith('*')
                    })

print(json.dumps(rosters, indent=2))
`;

    try {
        const result = execSync(`python3 -c "${pythonScript.replace(/"/g, '\\"')}"`, { 
            encoding: 'utf8',
            maxBuffer: 1024 * 1024 * 10 // 10MB buffer
        });
        
        return JSON.parse(result);
    } catch (error) {
        console.error(`Error extracting Week ${weekNum}:`, error.message);
        return null;
    }
}

async function findOrCreatePlayer(db, playerName, team, position) {
    return new Promise((resolve, reject) => {
        // First try exact match
        db.get(
            'SELECT player_id FROM nfl_players WHERE name = ? AND team = ? AND position = ?',
            [playerName, team, position],
            (err, row) => {
                if (err) {
                    reject(err);
                    return;
                }
                
                if (row) {
                    resolve(row.player_id);
                    return;
                }
                
                // Try name-only match
                db.get(
                    'SELECT player_id FROM nfl_players WHERE name = ? AND position = ?',
                    [playerName, position],
                    (err, row) => {
                        if (err) {
                            reject(err);
                            return;
                        }
                        
                        if (row) {
                            resolve(row.player_id);
                            return;
                        }
                        
                        // Create new player
                        const newId = `${playerName.replace(/[^a-zA-Z0-9]/g, '')}_${team}_${position}`.toLowerCase();
                        db.run(
                            'INSERT OR IGNORE INTO nfl_players (player_id, name, team, position) VALUES (?, ?, ?, ?)',
                            [newId, playerName, team, position],
                            function(err) {
                                if (err) {
                                    reject(err);
                                    return;
                                }
                                resolve(newId);
                            }
                        );
                    }
                );
            }
        );
    });
}

async function importWeekRosters(weekNum) {
    const weekData = await extractWeekData(weekNum);
    if (!weekData || weekData.error) {
        console.log(`Skipping Week ${weekNum}: ${weekData?.error || 'No data'}`);
        return;
    }
    
    const db = new sqlite3.Database(dbPath);
    
    try {
        // Clear existing week data
        await new Promise((resolve, reject) => {
            db.run('DELETE FROM weekly_rosters WHERE week = ?', [weekNum], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        
        console.log(`Processing Week ${weekNum} rosters...`);
        
        for (const [teamName, players] of Object.entries(weekData)) {
            const teamId = teamMapping[teamName];
            if (!teamId) {
                console.log(`Warning: Unknown team ${teamName}`);
                continue;
            }
            
            console.log(`  ${teamName} (${players.length} players)`);
            
            for (const playerEntry of players) {
                const playerInfo = parsePlayerName(playerEntry.player_text);
                if (!playerInfo) {
                    console.log(`    Warning: Could not parse player: ${playerEntry.player_text}`);
                    continue;
                }
                
                const position = positionMap[playerEntry.position] || playerEntry.position;
                const isStarterFlag = isStarter(playerEntry.player_text);
                
                try {
                    const playerId = await findOrCreatePlayer(db, playerInfo.name, playerInfo.team, position);
                    
                    // Insert into weekly_rosters
                    await new Promise((resolve, reject) => {
                        db.run(`
                            INSERT OR REPLACE INTO weekly_rosters 
                            (team_id, player_id, week, season, roster_position, player_name, player_position, player_team) 
                            VALUES (?, ?, ?, 2024, ?, ?, ?, ?)
                        `, [
                            teamId, 
                            playerId, 
                            weekNum, 
                            isStarterFlag ? 'starter' : 'bench',
                            playerInfo.name,
                            position,
                            playerInfo.team
                        ], (err) => {
                            if (err) reject(err);
                            else resolve();
                        });
                    });
                    
                    console.log(`    Added: ${playerInfo.name} (${position}) - ${isStarterFlag ? 'Starter' : 'Bench'}`);
                } catch (error) {
                    console.error(`    Error adding ${playerInfo.name}:`, error.message);
                }
            }
        }
        
        console.log(`✅ Week ${weekNum} import completed`);
    } catch (error) {
        console.error(`Error importing Week ${weekNum}:`, error);
    } finally {
        db.close();
    }
}

async function main() {
    console.log('Starting weekly roster import...');
    
    // Import weeks 1-17
    for (let week = 1; week <= 1; week++) {  // Test with just week 1
        await importWeekRosters(week);
    }
    
    console.log('✅ All weekly rosters imported!');
}

if (require.main === module) {
    main().catch(console.error);
}

module.exports = { importWeekRosters };