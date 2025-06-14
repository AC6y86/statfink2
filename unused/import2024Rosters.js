#!/usr/bin/env node

const sqlite3 = require('sqlite3').verbose();
const { execSync } = require('child_process');
const path = require('path');

// Database path  
const dbPath = path.join(__dirname, '../fantasy_football.db');

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

// Known TEs (since they don't have a position header in the spreadsheet)
const knownTEs = [
    'Sam LaPorta', 'Kyle Pitts', 'Mark Andrews', 'Isaiah Likely', 
    'George Kittle', 'Travis Kelce', 'T.J. Hockenson', 'Evan Engram',
    'Dallas Goedert', 'David Njoku', 'Cole Kmet', 'Pat Freiermuth',
    'Jake Ferguson', 'Dalton Kincaid', 'Trey McBride', 'Tucker Kraft',
    'Brock Bowers', 'Dalton Schultz', 'Tyler Higbee', 'Hunter Henry'
];

// Valid NFL team names for DEF
const validNFLTeams = [
    'Texans', 'Giants', 'Cowboys', 'Jets', 'Cardinals', 'Falcons', 'Bears', 'Lions', 
    'Ravens', 'Bills', 'Chiefs', 'Patriots', 'Dolphins', 'Seahawks', 'Steelers', 
    'Panthers', 'Bengals', 'Colts', 'Saints', 'Jaguars', 'Browns', 'Broncos', 
    '49ers', 'Eagles', 'Rams', 'Chargers', 'Raiders', 'Vikings', 'Packers', 
    'Titans', 'Buccaneers', 'Commanders'
];

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

async function extractWeek1Data() {
    console.log('Extracting Week 1 data for fantasy_rosters...');
    
    const pythonScript = `
import openpyxl
import json
import sys

wb = openpyxl.load_workbook('/Users/joepaley/Downloads/PFL 2024.xlsx')
ws = wb['Week 1 Stats']

# Get team names from row 1
team_row = list(ws.iter_rows(min_row=1, max_row=1, values_only=True))[0]
teams = []
for i, cell in enumerate(team_row):
    if cell and cell not in ['', 'PTS']:
        teams.append({"col": i, "name": cell})

# Valid NFL teams for DEF
valid_nfl_teams = [
    'Texans', 'Giants', 'Cowboys', 'Jets', 'Cardinals', 'Falcons', 'Bears', 'Lions', 
    'Ravens', 'Bills', 'Chiefs', 'Patriots', 'Dolphins', 'Seahawks', 'Steelers', 
    'Panthers', 'Bengals', 'Colts', 'Saints', 'Jaguars', 'Browns', 'Broncos', 
    '49ers', 'Eagles', 'Rams', 'Chargers', 'Raiders', 'Vikings', 'Packers', 
    'Titans', 'Buccaneers', 'Commanders'
]

# Extract roster data with minimal filtering - only skip obvious non-players
rosters = {}
current_position = None
wr_count = 0
def_count = 0

for row_num, row in enumerate(ws.iter_rows(min_row=2, max_row=35, values_only=True), 2):
    if not row or not any(cell for cell in row):
        continue
        
    # Check if this is a position header row
    if row[0] and str(row[0]).strip() in ['QB', 'RB', 'WR', 'TE', 'K', 'DST', 'D/ST', 'DEF']:
        current_position = str(row[0]).strip()
        if current_position in ['DST', 'D/ST']:
            current_position = 'DEF'
        wr_count = 0
        def_count = 0
    
    if not current_position:
        continue
    
    if current_position == 'WR':
        wr_count += 1
    
    if current_position == 'DEF':
        def_count += 1
        if def_count > 2:
            continue
        
    # Process each team's player in this row
    for team in teams:
        col_idx = team["col"]
        team_name = team["name"]
        
        if team_name not in rosters:
            rosters[team_name] = []
            
        if col_idx < len(row) and row[col_idx]:
            player_text = str(row[col_idx])
            
            # Very minimal filtering - only skip obvious non-players
            clean_text = player_text.replace('*', '').strip()
            
            # Skip purely numeric values
            if clean_text.replace('.', '').isdigit():
                continue
                
            # Skip formulas
            if clean_text.startswith('='):
                continue
                
            # Skip specific labels
            if clean_text in ['Record', 'Loss', 'Win', 'Week', 'WK.', 'CUM']:
                continue
            
            # Skip rows that contain cumulative data with owner names (like "Cal(104.5)")
            if '(' in clean_text and any(owner in clean_text for owner in ['Mitch', 'Cal', 'Eli', 'Chris', 'Mike', 'Joe', 'Dan', 'Aaron', 'Sean', 'Matt', 'Bruce', 'Pete']):
                if not any(nfl_team in clean_text for nfl_team in valid_nfl_teams):
                    continue
            
            # Handle DEF position specially
            if current_position == 'DEF':
                if clean_text in valid_nfl_teams:
                    rosters[team_name].append({
                        "position": 'DEF',
                        "player_text": f"{clean_text}(DEF)"
                    })
                continue
            
            # For other positions, require parentheses (player format)
            if '(' in player_text and ')' in player_text:
                position = current_position
                if current_position == 'WR' and wr_count == 6:
                    position = 'TE'
                    
                rosters[team_name].append({
                    "position": position,
                    "player_text": player_text
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
        console.error('Error extracting Week 1:', error.message);
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

async function importFantasyRosters() {
    const weekData = await extractWeek1Data();
    if (!weekData) {
        console.log('Error: No data found');
        return;
    }
    
    const db = new sqlite3.Database(dbPath);
    
    try {
        // Clear existing fantasy rosters
        await new Promise((resolve, reject) => {
            db.run('DELETE FROM fantasy_rosters', (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        
        // Clean up bad player entries - be aggressive about removing owner names and scores
        await new Promise((resolve, reject) => {
            db.run(`DELETE FROM nfl_players WHERE 
                name LIKE '=%' OR 
                player_id LIKE '%,%' OR
                name LIKE '%104.5%' OR
                name LIKE '%85.5%' OR
                (name IN ('Cal', 'Dan', 'Mitch', 'Eli', 'Chris', 'Mike', 'Joe', 'Aaron', 'Sean', 'Matt', 'Bruce', 'Pete') AND position = 'K')`, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        
        let totalImported = 0;
        const teamStats = {};
        const positionCounts = {};
        
        for (const [teamName, players] of Object.entries(weekData)) {
            const teamId = teamMapping[teamName];
            if (!teamId) {
                console.log(`Warning: Unknown team ${teamName}`);
                continue;
            }
            
            teamStats[teamName] = 0;
            positionCounts[teamName] = {};
            
            for (const playerEntry of players) {
                const playerInfo = parsePlayerName(playerEntry.player_text);
                if (!playerInfo) {
                    console.log(`Could not parse player: ${playerEntry.player_text}`);
                    continue;
                }
                
                let position = playerEntry.position;
                
                // Double-check TE assignment using known TEs
                if (position === 'WR' && knownTEs.includes(playerInfo.name)) {
                    position = 'TE';
                }
                
                try {
                    const playerId = await findOrCreatePlayer(db, playerInfo.name, playerInfo.team, position);
                    
                    // Insert into fantasy_rosters
                    await new Promise((resolve, reject) => {
                        db.run(`
                            INSERT INTO fantasy_rosters 
                            (team_id, player_id, roster_position, acquisition_date, player_name) 
                            VALUES (?, ?, 'active', date('now'), ?)
                        `, [teamId, playerId, playerInfo.name], (err) => {
                            if (err) reject(err);
                            else resolve();
                        });
                    });
                    
                    totalImported++;
                    teamStats[teamName]++;
                    
                    // Track position counts
                    if (!positionCounts[teamName][position]) {
                        positionCounts[teamName][position] = 0;
                    }
                    positionCounts[teamName][position]++;
                    
                } catch (error) {
                    console.error(`Error adding ${playerInfo.name}:`, error.message);
                }
            }
        }
        
        console.log('\\nImport Summary:');
        console.log(`Total players imported: ${totalImported}`);
        console.log('\\nPlayers per team:');
        for (const [team, count] of Object.entries(teamStats)) {
            console.log(`  ${team}: ${count} players`);
            const positions = positionCounts[team];
            console.log(`    QB: ${positions.QB || 0}, RB: ${positions.RB || 0}, WR: ${positions.WR || 0}, TE: ${positions.TE || 0}, K: ${positions.K || 0}, DEF: ${positions.DEF || 0}`);
        }
        
        if (Object.values(teamStats).some(count => count !== 19)) {
            console.log('\\n⚠️  ERROR: Not all teams have 19 players!');
            process.exit(1);
        } else {
            console.log('\\n✅ All teams have exactly 19 players!');
        }
        
    } catch (error) {
        console.error('Error importing fantasy rosters:', error);
    } finally {
        db.close();
    }
}

if (require.main === module) {
    importFantasyRosters().catch(console.error);
}

module.exports = { importFantasyRosters };