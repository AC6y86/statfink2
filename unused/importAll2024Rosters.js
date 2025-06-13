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

async function extractWeekData(weekNum) {
    console.log(`Extracting Week ${weekNum} data...`);
    
    const pythonScript = `
import openpyxl
import json
import sys

wb = openpyxl.load_workbook('/Users/joepaley/Downloads/PFL 2024.xlsx')
sheet_name = 'Week ${weekNum} Stats'

if sheet_name not in wb.sheetnames:
    print(json.dumps({"error": f"Sheet {sheet_name} not found"}))
    sys.exit(0)

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
        
        const data = JSON.parse(result);
        if (data.error) {
            return null;
        }
        return data;
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
    if (!weekData) {
        console.log(`⏭️  Skipping Week ${weekNum}: No data found`);
        return { imported: 0, starters: 0 };
    }
    
    const db = new sqlite3.Database(dbPath);
    
    try {
        // Clear existing week data
        await new Promise((resolve, reject) => {
            db.run('DELETE FROM weekly_rosters WHERE week = ? AND season = 2024', [weekNum], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        
        let totalImported = 0;
        let totalStarters = 0;
        
        for (const [teamName, players] of Object.entries(weekData)) {
            const teamId = teamMapping[teamName];
            if (!teamId) {
                console.log(`    ⚠️  Unknown team: ${teamName}`);
                continue;
            }
            
            for (const playerEntry of players) {
                const playerInfo = parsePlayerName(playerEntry.player_text);
                if (!playerInfo) {
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
                    
                    totalImported++;
                    if (isStarterFlag) totalStarters++;
                    
                } catch (error) {
                    console.error(`    ❌ Error adding ${playerInfo.name}:`, error.message);
                }
            }
        }
        
        console.log(`  ✅ Week ${weekNum}: ${totalImported} players (${totalStarters} starters)`);
        return { imported: totalImported, starters: totalStarters };
        
    } catch (error) {
        console.error(`❌ Error importing Week ${weekNum}:`, error);
        return { imported: 0, starters: 0 };
    } finally {
        db.close();
    }
}

async function createMatchupsForWeek(weekNum) {
    // Use Week 1 matchup pattern for all weeks
    const matchupPattern = [
        [1, 8],   // Mitch vs Aaron
        [3, 6],   // Eli vs Joe  
        [2, 7],   // Cal vs Dan
        [4, 5],   // Chris vs Mike
        [9, 12],  // Sean vs Pete
        [10, 11]  // Matt vs Bruce
    ];
    
    const db = new sqlite3.Database(dbPath);
    
    try {
        // Check if matchups already exist
        const existing = await new Promise((resolve, reject) => {
            db.get('SELECT COUNT(*) as count FROM matchups WHERE week = ? AND season = 2024', [weekNum], (err, row) => {
                if (err) reject(err);
                else resolve(row.count);
            });
        });
        
        if (existing === 0) {
            // Create matchups
            for (const [team1, team2] of matchupPattern) {
                await new Promise((resolve, reject) => {
                    db.run(`
                        INSERT INTO matchups (team1_id, team2_id, week, season, team1_points, team2_points) 
                        VALUES (?, ?, ?, 2024, 0, 0)
                    `, [team1, team2, weekNum], (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });
            }
        }
        
        // Calculate and update scores
        await new Promise((resolve, reject) => {
            db.run(`
                UPDATE matchups SET 
                  team1_points = (
                    SELECT COALESCE(SUM(ps.fantasy_points), 0)
                    FROM weekly_rosters wr
                    JOIN player_stats ps ON wr.player_id = ps.player_id
                    WHERE wr.team_id = matchups.team1_id 
                    AND wr.week = ? AND wr.season = 2024
                    AND ps.week = ? AND ps.season = 2024
                    AND wr.roster_position = 'starter'
                  ),
                  team2_points = (
                    SELECT COALESCE(SUM(ps.fantasy_points), 0)  
                    FROM weekly_rosters wr
                    JOIN player_stats ps ON wr.player_id = ps.player_id
                    WHERE wr.team_id = matchups.team2_id
                    AND wr.week = ? AND wr.season = 2024
                    AND ps.week = ? AND ps.season = 2024
                    AND wr.roster_position = 'starter'
                  )
                WHERE week = ? AND season = 2024
            `, [weekNum, weekNum, weekNum, weekNum, weekNum], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        
    } catch (error) {
        console.error(`❌ Error creating matchups for Week ${weekNum}:`, error);
    } finally {
        db.close();
    }
}

async function main() {
    console.log('🚀 Starting 2024 roster import for all weeks...\n');
    
    let totalImported = 0;
    let totalStarters = 0;
    let weeksImported = 0;
    
    // Import weeks 1-17
    for (let week = 1; week <= 17; week++) {
        const result = await importWeekRosters(week);
        
        if (result.imported > 0) {
            totalImported += result.imported;
            totalStarters += result.starters;
            weeksImported++;
            
            // Create/update matchups for this week
            await createMatchupsForWeek(week);
        }
    }
    
    console.log(`\n🎉 Import Complete!`);
    console.log(`📊 Summary:`);
    console.log(`  • ${weeksImported} weeks imported`);
    console.log(`  • ${totalImported} total player entries`);
    console.log(`  • ${totalStarters} starter designations`);
    console.log(`  • Matchups created/updated for all imported weeks`);
}

if (require.main === module) {
    main().catch(console.error);
}

module.exports = { importWeekRosters, createMatchupsForWeek };