const fs = require('fs');
const path = require('path');
const Database = require('../database/database');

async function importRosterFromFile(filePath) {
    const db = new Database();
    
    try {
        console.log('Reading roster file...');
        const fileContent = fs.readFileSync(filePath, 'utf8');
        const lines = fileContent.split('\n').filter(line => line.trim());
        
        let currentTeamId = null;
        let currentTeamName = '';
        let playersAdded = 0;
        let playersNotFound = 0;
        
        console.log('Processing roster data...');
        
        for (const line of lines) {
            const trimmedLine = line.trim();
            
            // Check if this is a team header (starts with #)
            if (trimmedLine.startsWith('#')) {
                const teamMatch = trimmedLine.match(/#(\w+)\s+(.+)/);
                if (teamMatch) {
                    const teamNumber = teamMatch[1];
                    const ownerName = teamMatch[2];
                    
                    // Map team numbers/letters to team IDs
                    const teamMapping = {
                        '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6,
                        '7': 7, '8': 8, '9': 9, 'a': 10, 'b': 11, 'c': 12
                    };
                    
                    currentTeamId = teamMapping[teamNumber.toLowerCase()];
                    currentTeamName = `Team ${teamNumber} (${ownerName})`;
                    
                    if (currentTeamId) {
                        console.log(`\nProcessing ${currentTeamName}...`);
                        
                        // Update team name to include owner
                        await db.run(
                            'UPDATE teams SET team_name = ?, owner_name = ? WHERE team_id = ?',
                            [`Team ${teamNumber}`, ownerName, currentTeamId]
                        );
                    }
                }
            }
            // Process player lines
            else if (trimmedLine && currentTeamId) {
                // Parse player line: "Player Name Team Position"
                const parts = trimmedLine.split(' ');
                if (parts.length >= 3) {
                    const position = parts[parts.length - 1];
                    const team = parts[parts.length - 2];
                    const playerName = parts.slice(0, -2).join(' ');
                    
                    // Skip empty player names
                    if (!playerName) continue;
                    
                    // Handle defense special case: "DEF TeamAbbv DEF"
                    if (playerName === 'DEF' && position === 'DEF') {
                        // For defenses, the format is "DEF TeamAbbv DEF"
                        let defTeam = normalizeTeamAbbreviation(team);
                        
                        // Try to find the defense in the database
                        const defense = await db.get(
                            'SELECT * FROM nfl_players WHERE position = ? AND team = ?',
                            ['DST', defTeam]
                        );
                        
                        if (defense) {
                            await addPlayerToTeam(db, currentTeamId, defense.player_id, 'DST', defense.name);
                            console.log(`  ✅ Added ${defTeam} defense`);
                            playersAdded++;
                        } else {
                            console.log(`  ⚠️  Defense not found: ${defTeam} DST`);
                            playersNotFound++;
                        }
                    } else {
                        // Find player in database by name and team
                        const normalizedTeam = normalizeTeamAbbreviation(team);
                        const player = await findPlayerByNameAndTeam(db, playerName, normalizedTeam, position);
                        
                        if (player) {
                            await addPlayerToTeam(db, currentTeamId, player.player_id, player.position, player.name);
                            playersAdded++;
                        } else {
                            console.log(`  ⚠️  Player not found: ${playerName} (${team} ${position})`);
                            playersNotFound++;
                        }
                    }
                }
            }
        }
        
        console.log('\n📊 Import Summary:');
        console.log(`✅ Players added to rosters: ${playersAdded}`);
        console.log(`⚠️  Players not found: ${playersNotFound}`);
        console.log(`🎯 Total teams processed: 12`);
        
        // Show roster counts for each team
        console.log('\n📋 Team Roster Counts:');
        for (let teamId = 1; teamId <= 12; teamId++) {
            const count = await db.get(
                'SELECT COUNT(*) as count FROM fantasy_rosters WHERE team_id = ?',
                [teamId]
            );
            const team = await db.get('SELECT team_name, owner_name FROM teams WHERE team_id = ?', [teamId]);
            console.log(`  Team ${teamId} (${team.owner_name}): ${count.count} players`);
        }
        
    } catch (error) {
        console.error('Error importing roster:', error);
    } finally {
        await db.close();
    }
}

function normalizeTeamAbbreviation(team) {
    const teamMap = {
        // Handle common variations
        'Hou': 'HOU', 'Nyg': 'NYG', 'Dal': 'DAL', 'Nyj': 'NYJ', 
        'Ari': 'ARI', 'Atl': 'ATL', 'Chi': 'CHI', 'Det': 'DET',
        'Bal': 'BAL', 'Buf': 'BUF', 'KC': 'KC', 'NE': 'NE',
        'Min': 'MIN', 'Pit': 'PIT', 'Car': 'CAR', 'Sea': 'SEA',
        'Cin': 'CIN', 'Ind': 'IND', 'NO': 'NO', 'Jac': 'JAX',
        'Mia': 'MIA', 'Cle': 'CLE', 'Den': 'DEN', 'SF': 'SF',
        'Phi': 'PHI', 'Was': 'WAS', 'Ten': 'TEN'
    };
    
    return teamMap[team] || team.toUpperCase();
}

async function findPlayerByNameAndTeam(db, playerName, team, position) {
    // First try exact match
    let player = await db.get(
        'SELECT * FROM nfl_players WHERE name = ? AND team = ? AND position = ?',
        [playerName, team, position.toUpperCase()]
    );
    
    if (player) return player;
    
    // Try without position constraint
    player = await db.get(
        'SELECT * FROM nfl_players WHERE name = ? AND team = ?',
        [playerName, team]
    );
    
    if (player) return player;
    
    // Try fuzzy name matching (handle variations)
    const similarPlayers = await db.all(
        'SELECT * FROM nfl_players WHERE team = ? AND position = ? AND (name LIKE ? OR name LIKE ?)',
        [team, position.toUpperCase(), `%${playerName}%`, `${playerName}%`]
    );
    
    if (similarPlayers.length === 1) {
        console.log(`  🔀 Matched "${playerName}" to "${similarPlayers[0].name}"`);
        return similarPlayers[0];
    }
    
    // Try common name variations
    const nameVariations = generateNameVariations(playerName);
    for (const variation of nameVariations) {
        player = await db.get(
            'SELECT * FROM nfl_players WHERE name = ? AND team = ?',
            [variation, team]
        );
        if (player) {
            console.log(`  🔀 Matched "${playerName}" to "${player.name}" via variation`);
            return player;
        }
    }
    
    return null;
}

function generateNameVariations(name) {
    const variations = [];
    
    // Handle common abbreviations and variations
    const nameParts = name.split(' ');
    
    // Try with/without Jr., Sr., etc.
    variations.push(name.replace(/\s+(Jr\.?|Sr\.?|III|II|IV)$/i, ''));
    
    // Try with apostrophes and without
    variations.push(name.replace(/'/g, ''));
    variations.push(name.replace(/'/g, "'"));
    
    // Try with periods and without (for initials)
    variations.push(name.replace(/\./g, ''));
    
    // Try common nickname variations
    const nicknameMap = {
        'D\'Onta': 'DeOnta',
        'D\'Andre': 'DeAndre',
        'Ja\'Marr': 'JaMarr',
        'Ka\'imi': 'Kaimi',
        'De\'Von': 'Devon',
        'Amon-Ra': 'Amon Ra',
        'JuJu': 'Juju'
    };
    
    for (const [original, replacement] of Object.entries(nicknameMap)) {
        if (name.includes(original)) {
            variations.push(name.replace(original, replacement));
        }
        if (name.includes(replacement)) {
            variations.push(name.replace(replacement, original));
        }
    }
    
    return [...new Set(variations)].filter(v => v !== name);
}

async function addPlayerToTeam(db, teamId, playerId, position, playerName) {
    try {
        // Check if player is already on a roster
        const existingRoster = await db.get(
            'SELECT team_id FROM fantasy_rosters WHERE player_id = ?',
            [playerId]
        );
        
        if (existingRoster) {
            if (existingRoster.team_id === teamId) {
                console.log(`  ℹ️  ${playerName} already on this team`);
                return;
            } else {
                console.log(`  ⚠️  ${playerName} already on Team ${existingRoster.team_id}, skipping`);
                return;
            }
        }
        
        // Add player to roster as starter
        await db.run(
            'INSERT INTO fantasy_rosters (team_id, player_id, roster_position) VALUES (?, ?, ?)',
            [teamId, playerId, 'starter']
        );
        
        console.log(`  ✅ Added ${playerName} (${position})`);
        
    } catch (error) {
        console.error(`  ❌ Error adding ${playerName}:`, error.message);
    }
}

// Check if this script is being run directly
if (require.main === module) {
    const filePath = process.argv[2];
    if (!filePath) {
        console.error('Usage: node importRoster.js <path-to-roster-file>');
        process.exit(1);
    }
    
    if (!fs.existsSync(filePath)) {
        console.error(`File not found: ${filePath}`);
        process.exit(1);
    }
    
    importRosterFromFile(filePath);
}

module.exports = { importRosterFromFile };