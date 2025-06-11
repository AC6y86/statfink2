const fs = require('fs');
const path = require('path');
const DatabaseManager = require('../database/database');

// Team mapping from roster file to database IDs
const TEAM_MAPPING = {
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

// Position mapping for defenses
const TEAM_TO_NFL_TEAM = {
    'Hou': 'HOU',
    'NYG': 'NYG',
    'Dal': 'DAL',
    'NYJ': 'NYJ',
    'Bal': 'BAL',
    'Buf': 'BUF',
    'KC': 'KC',
    'NE': 'NE'
};

async function parseRosterFile(filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').map(line => line.trim()).filter(line => line);
    
    const rosters = {};
    let currentTeam = null;
    
    for (const line of lines) {
        if (line.startsWith('#')) {
            // Extract team name (everything after the number and space)
            const match = line.match(/^#[0-9a-c]\s+(.+)$/);
            if (match) {
                currentTeam = match[1];
                rosters[currentTeam] = [];
            }
        } else if (currentTeam && line) {
            // Parse player line: "Name Team Position" or "DEF Team DEF"
            const parts = line.split(' ');
            
            if (parts.length >= 3) {
                if (parts[0] === 'DEF') {
                    // Defense: "DEF Team DEF"
                    const nflTeam = TEAM_TO_NFL_TEAM[parts[1]] || parts[1];
                    rosters[currentTeam].push({
                        name: `${nflTeam} Defense`,
                        team: nflTeam,
                        position: 'DST'
                    });
                } else {
                    // Regular player: "FirstName LastName Team Position"
                    const position = parts[parts.length - 1];
                    const team = parts[parts.length - 2];
                    const name = parts.slice(0, -2).join(' ');
                    
                    rosters[currentTeam].push({
                        name: name,
                        team: team.toUpperCase(),
                        position: position
                    });
                }
            }
        }
    }
    
    return rosters;
}

async function findPlayerInDatabase(db, playerName, team, position) {
    
    // Try exact match first
    let player = await new Promise((resolve, reject) => {
        db.db.get(
            'SELECT * FROM nfl_players WHERE name = ? AND team = ? AND position = ?',
            [playerName, team, position],
            (err, row) => {
                if (err) reject(err);
                else resolve(row);
            }
        );
    });
    
    if (player) return player;
    
    // Try without team match for players who might have been traded
    player = await new Promise((resolve, reject) => {
        db.db.get(
            'SELECT * FROM nfl_players WHERE name = ? AND position = ?',
            [playerName, position],
            (err, row) => {
                if (err) reject(err);
                else resolve(row);
            }
        );
    });
    
    if (player) return player;
    
    // Try fuzzy name matching (last name only)
    const lastName = playerName.split(' ').pop();
    player = await new Promise((resolve, reject) => {
        db.db.get(
            'SELECT * FROM nfl_players WHERE name LIKE ? AND position = ?',
            [`%${lastName}%`, position],
            (err, row) => {
                if (err) reject(err);
                else resolve(row);
            }
        );
    });
    
    return player;
}

async function importRosterToDatabase(db, rosters, week = 16, season = 2024) {
    
    console.log(`Starting import for Week ${week}, ${season}...`);
    
    // Clear existing roster data for this week
    await new Promise((resolve, reject) => {
        db.db.run(
            'DELETE FROM weekly_rosters WHERE week = ? AND season = ?',
            [week, season],
            (err) => {
                if (err) reject(err);
                else resolve();
            }
        );
    });
    
    console.log(`Cleared existing data for Week ${week}, ${season}`);
    
    let totalImported = 0;
    let notFoundPlayers = [];
    
    for (const [ownerName, players] of Object.entries(rosters)) {
        const teamId = TEAM_MAPPING[ownerName];
        if (!teamId) {
            console.warn(`No team mapping found for owner: ${ownerName}`);
            continue;
        }
        
        console.log(`Processing ${ownerName} (Team ${teamId}) - ${players.length} players`);
        
        for (const rosterPlayer of players) {
            try {
                const dbPlayer = await findPlayerInDatabase(
                    db,
                    rosterPlayer.name,
                    rosterPlayer.team,
                    rosterPlayer.position
                );
                
                if (dbPlayer) {
                    // Insert into weekly_rosters table
                    await new Promise((resolve, reject) => {
                        db.db.run(
                            `INSERT INTO weekly_rosters 
                             (player_id, team_id, week, season, roster_position, player_name, player_position, player_team, snapshot_date)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
                            [dbPlayer.player_id, teamId, week, season, 'starter', dbPlayer.name, dbPlayer.position, dbPlayer.team],
                            (err) => {
                                if (err) reject(err);
                                else resolve();
                            }
                        );
                    });
                    
                    totalImported++;
                    console.log(`  ✅ ${rosterPlayer.name} (${rosterPlayer.position})`);
                } else {
                    notFoundPlayers.push({
                        name: rosterPlayer.name,
                        team: rosterPlayer.team,
                        position: rosterPlayer.position,
                        owner: ownerName
                    });
                    console.log(`  ❌ ${rosterPlayer.name} (${rosterPlayer.position}) - NOT FOUND`);
                }
            } catch (error) {
                console.error(`Error processing ${rosterPlayer.name}:`, error.message);
            }
        }
    }
    
    console.log(`\n=== IMPORT SUMMARY ===`);
    console.log(`Successfully imported: ${totalImported} players`);
    console.log(`Not found: ${notFoundPlayers.length} players`);
    
    if (notFoundPlayers.length > 0) {
        console.log(`\nPlayers not found in database:`);
        notFoundPlayers.forEach(player => {
            console.log(`  - ${player.name} (${player.team} ${player.position}) for ${player.owner}`);
        });
    }
    
    return {
        imported: totalImported,
        notFound: notFoundPlayers.length,
        notFoundPlayers: notFoundPlayers
    };
}

async function main() {
    try {
        const rosterFile = '/Users/joepaley/projects/statfink2/statfink_old/data/master-roster-full.txt';
        
        console.log('Parsing roster file...');
        const rosters = await parseRosterFile(rosterFile);
        
        console.log(`Found ${Object.keys(rosters).length} teams:`);
        Object.keys(rosters).forEach(team => {
            console.log(`  ${team}: ${rosters[team].length} players`);
        });
        
        console.log('\nInitializing database...');
        const db = new DatabaseManager();
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for DB init
        
        console.log('\nStarting database import...');
        const result = await importRosterToDatabase(db, rosters, 16, 2024);
        
        console.log('\n✅ Import completed!');
        console.log(`Imported ${result.imported} players successfully`);
        
        if (result.notFound > 0) {
            console.log(`⚠️  ${result.notFound} players not found in database`);
        }
        
    } catch (error) {
        console.error('Import failed:', error);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = { parseRosterFile, importRosterToDatabase };