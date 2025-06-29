const fs = require('fs');
const csv = require('csv-parse/sync');
const { logInfo, logError, logWarn } = require('./errorHandler');

class DraftImporter {
    constructor(db) {
        this.db = db;
        
        // Team owner to team_id mapping
        this.teamMapping = {
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
        
        // Defense team name to abbreviation mapping
        this.defenseMapping = {
            'Baltimore Ravens': 'BAL',
            'Cleveland Browns': 'CLE',
            'San Francisco 49ers': 'SF',
            'Cincinnati Bengals': 'CIN',
            'Dallas Cowboys': 'DAL',
            'New York Jets': 'NYJ',
            'Houston Texans': 'HOU',
            'Buffalo Bills': 'BUF',
            'Kansas City Chiefs': 'KC',
            'Pittsburgh Steelers': 'PIT',
            'Indianapolis Colts': 'IND',
            'New Orleans Saints': 'NO',
            'Denver Broncos': 'DEN',
            'Philadelphia Eagles': 'PHI',
            'Miami Dolphins': 'MIA',
            'Seattle Seahawks': 'SEA',
            'Arizona Cardinals': 'ARI',
            'Atlanta Falcons': 'ATL',
            'Detroit Lions': 'DET',
            'New England Patriots': 'NE',
            'Carolina Panthers': 'CAR',
            'New York Giants': 'NYG',
            'Chicago Bears': 'CHI',
            'Jacksonville Jaguars': 'JAX'
        };
        
        this.matchedPlayers = [];
        this.unmatchedPlayers = [];
    }
    
    /**
     * Main import function
     * @param {string} csvPath - Path to draft results CSV
     * @param {number} week - Week number to import as
     * @param {number} season - Season year
     * @returns {Object} Import results
     */
    async importDraft(csvPath, week, season) {
        logInfo(`Starting draft import for Week ${week}, Season ${season}`);
        logInfo(`CSV Path: ${csvPath}`);
        
        try {
            // 1. Parse CSV file
            const draftPicks = await this.parseCSV(csvPath);
            logInfo(`Parsed ${draftPicks.length} draft picks from CSV`);
            
            // 2. Match all players to Tank01 IDs
            const matchedRosters = await this.matchAllPlayers(draftPicks);
            
            // 3. Check for any unmatched players
            if (this.unmatchedPlayers.length > 0) {
                this.reportUnmatchedPlayers();
                throw new Error(`Failed to match ${this.unmatchedPlayers.length} players. Import aborted.`);
            }
            
            logInfo(`Successfully matched all ${this.matchedPlayers.length} players!`);
            
            // 4. Validate rosters (12 teams x 19 players each)
            this.validateRosters(matchedRosters);
            
            // 5. Clear existing rosters for this week/season
            await this.clearExistingRosters(week, season);
            
            // 6. Insert new rosters
            await this.insertRosters(matchedRosters, week, season);
            
            // 7. Verify import
            const verification = await this.verifyImport(week, season);
            
            return {
                success: true,
                playersImported: this.matchedPlayers.length,
                teamsImported: Object.keys(matchedRosters).length,
                verification
            };
            
        } catch (error) {
            logError('Draft import failed', error);
            throw error;
        }
    }
    
    /**
     * Parse CSV file
     */
    async parseCSV(csvPath) {
        if (!fs.existsSync(csvPath)) {
            throw new Error(`CSV file not found: ${csvPath}`);
        }
        
        const fileContent = fs.readFileSync(csvPath, 'utf8');
        const lines = fileContent.split('\n');
        
        // Find the header line
        let headerIndex = -1;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes('pick,overall,franchise,player,position,NFL team,notes')) {
                headerIndex = i;
                break;
            }
        }
        
        if (headerIndex === -1) {
            throw new Error('Could not find header line in CSV');
        }
        
        const draftPicks = [];
        
        // Process each line after the header manually
        for (let i = headerIndex + 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            
            // Split by comma but handle quoted fields
            const fields = this.parseCSVLine(line);
            
            if (fields.length < 6) continue;
            
            // Clean pick number (remove Excel formula formatting)
            const cleanPick = fields[0].replace(/^"=""/, '').replace(/""+"$/, '').replace(/"/g, '');
            
            const pick = {
                pickNumber: cleanPick,
                overall: parseInt(fields[1]),
                owner: fields[2],
                playerName: fields[3],
                position: fields[4],
                nflTeam: fields[5],
                notes: fields[6] || ''
            };
            
            // Validate required fields
            if (!pick.owner || !pick.playerName || !pick.position) {
                continue;
            }
            
            draftPicks.push(pick);
        }
        
        logInfo(`Parsed ${draftPicks.length} draft picks`);
        return draftPicks;
    }
    
    /**
     * Parse a single CSV line handling quoted fields
     */
    parseCSVLine(line) {
        const fields = [];
        let current = '';
        let inQuotes = false;
        
        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            const nextChar = line[i + 1];
            
            if (char === '"' && !inQuotes) {
                inQuotes = true;
            } else if (char === '"' && inQuotes && nextChar === '"') {
                current += '"';
                i++; // Skip next quote
            } else if (char === '"' && inQuotes) {
                inQuotes = false;
            } else if (char === ',' && !inQuotes) {
                fields.push(current);
                current = '';
            } else {
                current += char;
            }
        }
        
        fields.push(current); // Don't forget last field
        return fields;
    }
    
    /**
     * Match all players to Tank01 IDs
     */
    async matchAllPlayers(draftPicks) {
        const rosters = {};
        
        // Initialize rosters for each team
        for (const owner of Object.keys(this.teamMapping)) {
            rosters[owner] = [];
        }
        
        // Process each draft pick
        for (const pick of draftPicks) {
            const matchedPlayer = await this.matchPlayer(pick);
            
            if (matchedPlayer) {
                rosters[pick.owner].push(matchedPlayer);
                this.matchedPlayers.push({
                    ...pick,
                    tank01Id: matchedPlayer.player_id,
                    matchedName: matchedPlayer.name
                });
            } else {
                this.unmatchedPlayers.push(pick);
            }
        }
        
        return rosters;
    }
    
    /**
     * Match a single player to Tank01 ID
     */
    async matchPlayer(pick) {
        const { playerName, position, nflTeam } = pick;
        
        // Handle defenses specially
        if (position === 'TD' || position === 'DST' || position === 'DEF') {
            return await this.matchDefense(playerName);
        }
        
        // Normalize position - PK to K for kickers
        const normalizedPosition = position === 'PK' ? 'K' : position;
        
        // Try various matching strategies
        const strategies = [
            // 1. Exact match
            () => this.exactMatch(playerName, normalizedPosition, nflTeam),
            
            // 2. Without suffix (Jr., Sr., III, etc.)
            () => this.matchWithoutSuffix(playerName, normalizedPosition, nflTeam),
            
            // 3. Match by name and position only (player might have switched teams)
            () => this.matchByNameAndPosition(playerName, normalizedPosition),
            
            // 4. Handle free agents
            () => nflTeam === 'fa' ? this.matchFreeAgent(playerName, normalizedPosition) : null,
            
            // 5. Fuzzy name matching
            () => this.fuzzyMatch(playerName, normalizedPosition)
        ];
        
        for (const strategy of strategies) {
            const result = await strategy();
            if (result) {
                logInfo(`Matched: ${playerName} (${position}, ${nflTeam}) → ${result.name} [${result.player_id}]`);
                return result;
            }
        }
        
        return null;
    }
    
    /**
     * Match defense/special teams
     */
    async matchDefense(teamName) {
        // First check if it's already an abbreviation
        let teamAbbr = teamName.toUpperCase();
        
        // If it's a full team name, convert to abbreviation
        if (this.defenseMapping[teamName]) {
            teamAbbr = this.defenseMapping[teamName];
        }
        
        // Query for defense
        const defense = await this.db.get(`
            SELECT player_id, name, position, team
            FROM nfl_players
            WHERE team = ? AND position IN ('DST', 'DEF', 'Defense')
            LIMIT 1
        `, [teamAbbr]);
        
        if (defense) {
            return defense;
        }
        
        // Try alternative query for team defenses
        const altDefense = await this.db.get(`
            SELECT player_id, name, position, team
            FROM nfl_players
            WHERE name LIKE ? AND position IN ('DST', 'DEF', 'Defense')
            LIMIT 1
        `, [`${teamAbbr}%`]);
        
        return altDefense;
    }
    
    /**
     * Exact match strategy
     */
    async exactMatch(playerName, position, nflTeam) {
        return await this.db.get(`
            SELECT player_id, name, position, team
            FROM nfl_players
            WHERE name = ? AND position = ? AND team = ?
        `, [playerName, position, nflTeam]);
    }
    
    /**
     * Match without suffix (Jr., Sr., III, etc.)
     */
    async matchWithoutSuffix(playerName, position, nflTeam) {
        const baseName = playerName.replace(/ (Jr\.|Sr\.|III|II|IV|V)$/i, '').trim();
        
        if (baseName !== playerName) {
            return await this.db.get(`
                SELECT player_id, name, position, team
                FROM nfl_players
                WHERE name LIKE ? AND position = ? AND team = ?
            `, [`${baseName}%`, position, nflTeam]);
        }
        
        return null;
    }
    
    /**
     * Match by name and position only
     */
    async matchByNameAndPosition(playerName, position) {
        const player = await this.db.get(`
            SELECT player_id, name, position, team
            FROM nfl_players
            WHERE name = ? AND position = ?
        `, [playerName, position]);
        
        if (player) {
            logWarn(`Matched ${playerName} despite team mismatch (now on ${player.team})`);
        }
        
        return player;
    }
    
    /**
     * Match free agents
     */
    async matchFreeAgent(playerName, position) {
        // For free agents, just match by name and position
        const player = await this.db.get(`
            SELECT player_id, name, position, team
            FROM nfl_players
            WHERE name = ? AND position = ?
        `, [playerName, position]);
        
        if (player) {
            logInfo(`Matched free agent ${playerName} (now on ${player.team})`);
        }
        
        return player;
    }
    
    /**
     * Fuzzy matching as last resort
     */
    async fuzzyMatch(playerName, position) {
        // Try LIKE matching
        const players = await this.db.all(`
            SELECT player_id, name, position, team
            FROM nfl_players
            WHERE name LIKE ? AND position = ?
        `, [`%${playerName}%`, position]);
        
        if (players.length === 1) {
            logWarn(`Fuzzy matched: ${playerName} → ${players[0].name}`);
            return players[0];
        }
        
        return null;
    }
    
    /**
     * Report unmatched players with suggestions
     */
    reportUnmatchedPlayers() {
        logError(`\n❌ FAILED TO MATCH ${this.unmatchedPlayers.length} PLAYERS:\n`);
        
        for (const pick of this.unmatchedPlayers) {
            console.error(`\nUnmatched: ${pick.playerName} (${pick.position}, ${pick.nflTeam})`);
            console.error(`  Owner: ${pick.owner}, Pick: ${pick.pickNumber}`);
            
            // Show similar players
            this.showSimilarPlayers(pick).then(similar => {
                if (similar.length > 0) {
                    console.error('  Similar players in database:');
                    similar.forEach(p => {
                        console.error(`    - ${p.name} (${p.position}, ${p.team}) [${p.player_id}]`);
                    });
                }
            });
        }
    }
    
    /**
     * Find similar players for suggestions
     */
    async showSimilarPlayers(pick) {
        // Search by partial name match
        const similar = await this.db.all(`
            SELECT player_id, name, position, team
            FROM nfl_players
            WHERE name LIKE ? OR name LIKE ?
            ORDER BY 
                CASE WHEN position = ? THEN 0 ELSE 1 END,
                name
            LIMIT 5
        `, [`%${pick.playerName.split(' ')[1]}%`, `${pick.playerName.split(' ')[0]}%`, pick.position]);
        
        return similar;
    }
    
    /**
     * Validate rosters
     */
    validateRosters(rosters) {
        // Check team count
        const teamCount = Object.keys(rosters).length;
        if (teamCount !== 12) {
            throw new Error(`Expected 12 teams, found ${teamCount}`);
        }
        
        // Check player count per team
        for (const [owner, players] of Object.entries(rosters)) {
            if (players.length !== 19) {
                throw new Error(`Team ${owner} has ${players.length} players (expected 19)`);
            }
        }
        
        // Check for duplicate players
        const allPlayerIds = [];
        for (const players of Object.values(rosters)) {
            for (const player of players) {
                if (allPlayerIds.includes(player.player_id)) {
                    throw new Error(`Duplicate player found: ${player.name} [${player.player_id}]`);
                }
                allPlayerIds.push(player.player_id);
            }
        }
        
        logInfo('✓ Roster validation passed: 12 teams × 19 players');
    }
    
    /**
     * Clear existing rosters
     */
    async clearExistingRosters(week, season) {
        const result = await this.db.run(`
            DELETE FROM weekly_rosters
            WHERE week = ? AND season = ?
        `, [week, season]);
        
        if (result.changes > 0) {
            logInfo(`Cleared ${result.changes} existing roster entries`);
        }
    }
    
    /**
     * Insert rosters into database
     */
    async insertRosters(rosters, week, season) {
        let insertCount = 0;
        
        for (const [owner, players] of Object.entries(rosters)) {
            const teamId = this.teamMapping[owner];
            
            for (const player of players) {
                await this.db.run(`
                    INSERT INTO weekly_rosters (
                        team_id, player_id, week, season, 
                        roster_position, player_name, player_position, player_team
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `, [
                    teamId,
                    player.player_id,
                    week,
                    season,
                    'active', // All draft picks start as active
                    player.name,
                    player.position,
                    player.team
                ]);
                insertCount++;
            }
        }
        
        logInfo(`Inserted ${insertCount} roster entries`);
    }
    
    /**
     * Verify import was successful
     */
    async verifyImport(week, season) {
        const stats = await this.db.get(`
            SELECT 
                COUNT(DISTINCT team_id) as team_count,
                COUNT(*) as total_players,
                COUNT(DISTINCT player_id) as unique_players
            FROM weekly_rosters
            WHERE week = ? AND season = ?
        `, [week, season]);
        
        const perTeam = await this.db.all(`
            SELECT team_id, COUNT(*) as player_count
            FROM weekly_rosters
            WHERE week = ? AND season = ?
            GROUP BY team_id
            ORDER BY team_id
        `, [week, season]);
        
        return {
            teamCount: stats.team_count,
            totalPlayers: stats.total_players,
            uniquePlayers: stats.unique_players,
            perTeam
        };
    }
}

module.exports = DraftImporter;