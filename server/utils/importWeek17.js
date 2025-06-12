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

async function extractWeek17Data() {
    console.log('Extracting Week 17 data...');
    
    const pythonScript = `
import openpyxl
import json

wb = openpyxl.load_workbook('/Users/joepaley/Downloads/PFL 2024.xlsx')
ws = wb['Week 17 Stats']

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
    if row[0] and str(row[0]).strip() in ['QB', 'RB', 'WR', 'TE', 'K', 'DST', 'D/ST']:
        current_position = str(row[0]).strip()
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
            # Get the points column (next column after player)
            pts_col_idx = col_idx + 1
            pts_value = str(row[pts_col_idx]) if pts_col_idx < len(row) and row[pts_col_idx] else ""
            
            if player_text and player_text.strip() and not player_text.replace('.', '').replace('*', '').isdigit():
                # Determine if starter based on PTS column having *
                is_starter_flag = pts_value.startswith('*') if pts_value else False
                
                rosters[team_name].append({
                    "position": current_position,
                    "player_text": player_text,
                    "is_starter": is_starter_flag,
                    "pts": pts_value
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
        console.error('Error extracting Week 17:', error.message);
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
                            console.log(`    Found existing player: ${playerName} (${position}) with different team`);
                            resolve(row.player_id);
                            return;
                        }
                        
                        // Create new player
                        const newId = `${playerName.replace(/[^a-zA-Z0-9]/g, '')}_${team}_${position}`.toLowerCase();
                        console.log(`    Creating new player: ${playerName} (${position})`);
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

async function importWeek17() {
    const weekData = await extractWeek17Data();
    if (!weekData) {
        console.log('Failed to extract Week 17 data');
        return;
    }
    
    const db = new sqlite3.Database(dbPath);
    
    try {
        // Clear existing Week 17 data
        await new Promise((resolve, reject) => {
            db.run('DELETE FROM weekly_rosters WHERE week = 17 AND season = 2024', (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        
        console.log('Processing Week 17 rosters...');
        
        for (const [teamName, players] of Object.entries(weekData)) {
            const teamId = teamMapping[teamName];
            if (!teamId) {
                console.log(`Warning: Unknown team ${teamName}`);
                continue;
            }
            
            console.log(`\\n  ${teamName} (${players.length} players)`);
            
            for (const playerEntry of players) {
                const playerInfo = parsePlayerName(playerEntry.player_text);
                if (!playerInfo) {
                    console.log(`    Warning: Could not parse player: ${playerEntry.player_text}`);
                    continue;
                }
                
                const position = playerEntry.position === 'D/ST' ? 'DST' : playerEntry.position;
                const isStarterFlag = playerEntry.is_starter;
                
                try {
                    const playerId = await findOrCreatePlayer(db, playerInfo.name, playerInfo.team, position);
                    
                    // Insert into weekly_rosters
                    await new Promise((resolve, reject) => {
                        db.run(`
                            INSERT OR REPLACE INTO weekly_rosters 
                            (team_id, player_id, week, season, roster_position, player_name, player_position, player_team) 
                            VALUES (?, ?, 17, 2024, ?, ?, ?, ?)
                        `, [
                            teamId, 
                            playerId, 
                            isStarterFlag ? 'starter' : 'bench',
                            playerInfo.name,
                            position,
                            playerInfo.team
                        ], (err) => {
                            if (err) reject(err);
                            else resolve();
                        });
                    });
                    
                    console.log(`    ✓ ${playerInfo.name} (${position}) - ${isStarterFlag ? 'Starter' : 'Bench'}`);
                } catch (error) {
                    console.error(`    Error adding ${playerInfo.name}:`, error.message);
                }
            }
        }
        
        console.log('\\n✅ Week 17 import completed!');
        
        // Show summary
        const summary = await new Promise((resolve, reject) => {
            db.get('SELECT COUNT(*) as total, COUNT(CASE WHEN roster_position = "starter" THEN 1 END) as starters FROM weekly_rosters WHERE week = 17 AND season = 2024', (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
        
        console.log(`Imported ${summary.total} players (${summary.starters} starters, ${summary.total - summary.starters} bench)`);
        
    } catch (error) {
        console.error('Error importing Week 17:', error);
    } finally {
        db.close();
    }
}

if (require.main === module) {
    importWeek17().catch(console.error);
}

module.exports = { importWeek17 };