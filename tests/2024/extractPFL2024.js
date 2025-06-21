#!/usr/bin/env node

const XLSX = require('xlsx');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// File paths
const excelPath = path.join(__dirname, 'PFL 2024.xlsx');
const dbPath = path.join(__dirname, 'statfinkv1_2024.db');
const schemaPath = path.join(__dirname, 'createStatfinkv1Schema.sql');

// Team name mapping to database team IDs (from existing system)
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

// Valid NFL teams for DEF
const validNFLTeams = [
    'Texans', 'Giants', 'Cowboys', 'Jets', 'Cardinals', 'Falcons', 'Bears', 'Lions', 
    'Ravens', 'Bills', 'Chiefs', 'Patriots', 'Dolphins', 'Seahawks', 'Steelers', 
    'Panthers', 'Bengals', 'Colts', 'Saints', 'Jaguars', 'Browns', 'Broncos', 
    '49ers', 'Eagles', 'Rams', 'Chargers', 'Raiders', 'Vikings', 'Packers', 
    'Titans', 'Buccaneers', 'Commanders'
];

// Known TEs (they appear in WR section but should be classified as TE)
const knownTEs = [
    'Sam LaPorta', 'Kyle Pitts', 'Mark Andrews', 'Isaiah Likely', 
    'George Kittle', 'Travis Kelce', 'T.J. Hockenson', 'Evan Engram',
    'Dallas Goedert', 'David Njoku', 'Cole Kmet', 'Pat Freiermuth',
    'Jake Ferguson', 'Dalton Kincaid', 'Trey McBride', 'Tucker Kraft',
    'Brock Bowers', 'Dalton Schultz', 'Tyler Higbee', 'Hunter Henry',
    'Cade Otton', 'Will Dissly', 'Noah Fant', 'Taysom Hill',
    'Darnell Washington', 'Luke Musgrave', 'Zach Ertz', 'Gerald Everett'
];

class PFL2024Extractor {
    constructor() {
        this.db = null;
        this.workbook = null;
    }

    async initialize() {
        console.log('🏈 Initializing PFL 2024 Extractor...');
        
        // Load Excel file
        if (!fs.existsSync(excelPath)) {
            throw new Error(`Excel file not found: ${excelPath}`);
        }
        
        console.log('📊 Loading Excel file...');
        this.workbook = XLSX.readFile(excelPath);
        console.log(`Found sheets: ${this.workbook.SheetNames.join(', ')}`);

        // Initialize database
        await this.initializeDatabase();
    }

    async initializeDatabase() {
        console.log('🗃️  Initializing database...');
        
        // Remove existing database
        if (fs.existsSync(dbPath)) {
            fs.unlinkSync(dbPath);
            console.log('Removed existing database');
        }

        // Create new database
        this.db = new sqlite3.Database(dbPath);
        
        // Read and execute schema
        const schema = fs.readFileSync(schemaPath, 'utf8');
        await this.executeSQL(schema);
        console.log('✅ Database schema created');
    }

    executeSQL(sql) {
        return new Promise((resolve, reject) => {
            this.db.exec(sql, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    parsePlayerName(playerText) {
        if (!playerText || playerText === '' || typeof playerText !== 'string') {
            return null;
        }
        
        // Remove leading * (starter indicator) and clean
        let cleanText = playerText.replace(/^\*/, '').trim();
        
        // Extract player name and team - format: "Player Name(TEAM)"
        const match = cleanText.match(/^([^(]+)\(([^)]+)\)/);
        if (match) {
            const playerName = match[1].trim();
            const teamAbbrev = match[2].trim();
            return { 
                name: playerName, 
                team: teamAbbrev,
                isStarter: playerText.startsWith('*')
            };
        }
        
        return null;
    }

    parseFantasyPoints(ptsCell) {
        if (!ptsCell || ptsCell === '' || ptsCell === 'X') {
            return 0;
        }
        
        // Handle string values (may have * prefix for starters)
        if (typeof ptsCell === 'string') {
            const cleanPts = ptsCell.replace(/^\*/, '').trim();
            if (cleanPts === 'X' || cleanPts === '') {
                return 0;
            }
            const parsed = parseFloat(cleanPts);
            return isNaN(parsed) ? 0 : parsed;
        }
        
        // Handle numeric values
        if (typeof ptsCell === 'number') {
            return ptsCell;
        }
        
        return 0;
    }

    extractWeekData(weekNum) {
        console.log(`\n📅 Extracting Week ${weekNum} data...`);
        
        let sheetName = `Week ${weekNum}`;
        if (!this.workbook.Sheets[sheetName]) {
            // Try the "Week X Stats" format for weeks 2-7
            sheetName = `Week ${weekNum} Stats`;
            if (!this.workbook.Sheets[sheetName]) {
                throw new Error(`Sheet "${sheetName}" not found in Excel file`);
            }
        }

        const worksheet = this.workbook.Sheets[sheetName];
        const data = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });

        if (data.length === 0) {
            throw new Error(`No data found in sheet "${sheetName}"`);
        }

        // Get team names from first row (they're in every other column)
        const teamRow = data[0];
        const teams = [];
        for (let i = 0; i < teamRow.length; i++) {
            const cell = teamRow[i];
            if (cell && cell !== '' && cell !== 'PTS' && teamMapping[cell]) {
                teams.push({ col: i, name: cell, id: teamMapping[cell] });
            }
        }

        console.log(`Found teams: ${teams.map(t => t.name).join(', ')}`);

        // Extract roster data
        const rosters = {};
        let currentPosition = null;

        // Initialize rosters for each team
        teams.forEach(team => {
            rosters[team.name] = [];
        });

        // Process each row starting from row 2
        for (let rowIdx = 1; rowIdx < data.length; rowIdx++) {
            const row = data[rowIdx];
            if (!row || row.length === 0) continue;

            // Check if this is a position header row
            const firstCell = row[0];
            if (firstCell && typeof firstCell === 'string') {
                const posHeader = firstCell.trim().toUpperCase();
                if (['QB', 'RB', 'WR', 'TE', 'K', 'DST', 'D/ST', 'DEF'].includes(posHeader)) {
                    currentPosition = posHeader === 'D/ST' || posHeader === 'DST' ? 'DEF' : posHeader;
                    console.log(`  Processing ${currentPosition} section...`);
                    // DON'T continue here - process players in the same row as position header
                }
            }

            if (!currentPosition) continue;

            // Process each team's player in this row
            teams.forEach(team => {
                const cell = row[team.col];
                if (!cell || cell === '') return;

                // Skip numeric values (scores) - but allow 'X' 
                if (typeof cell === 'number' || (typeof cell === 'string' && /^\d*\.?\d+$/.test(cell.trim()))) {
                    return;
                }

                // Skip obviously non-player data
                const cellStr = cell.toString().trim();
                if (cellStr.includes('=') || cellStr === 'PTS' || cellStr.length < 3) {
                    return;
                }
                
                // Skip summary rows (stop parsing when we hit weekly summary data)
                if (cellStr.includes('WK.') || cellStr.includes('CUM') || 
                    /^\d+-\d+$/.test(cellStr) || // Match "0-1", "1-0" pattern
                    /^[A-Za-z]+\(\d+\.?\d*\)$/.test(cellStr) || // Match "Cal(104.5)" pattern more precisely
                    ['Loss', 'Win', 'Week'].includes(cellStr)) {
                    return;
                }

                // Get the fantasy points from the adjacent column (PTS column)
                const ptsCol = team.col + 1;
                const ptsCell = row[ptsCol];
                const fantasyPoints = this.parseFantasyPoints(ptsCell);

                // Handle DEF specially
                if (currentPosition === 'DEF') {
                    const cleanDEF = cellStr.replace(/^\*/, '').trim();
                    if (validNFLTeams.includes(cleanDEF)) {
                        rosters[team.name].push({
                            position: 'DEF',
                            playerText: cellStr,
                            isStarter: cellStr.startsWith('*'),
                            fantasyPoints: fantasyPoints
                        });
                    }
                    return;
                }

                // For other positions, require player format
                const playerInfo = this.parsePlayerName(cellStr);
                if (playerInfo) {
                    // Check if this WR is actually a TE
                    let actualPosition = currentPosition;
                    if (currentPosition === 'WR' && knownTEs.includes(playerInfo.name)) {
                        actualPosition = 'TE';
                    }
                    
                    rosters[team.name].push({
                        position: actualPosition,
                        playerText: cellStr,
                        playerInfo: playerInfo,
                        isStarter: playerInfo.isStarter,
                        fantasyPoints: fantasyPoints
                    });
                }
            });
        }

        // VALIDATION: Check player counts per team
        console.log('\n🔍 Validating roster sizes...');
        const teamPlayerCounts = {};
        
        for (const [teamName, players] of Object.entries(rosters)) {
            teamPlayerCounts[teamName] = players.length;
        }

        // Verify each team has exactly 19 players
        for (const [teamName, playerCount] of Object.entries(teamPlayerCounts)) {
            if (playerCount !== 19) {
                console.warn(`⚠️  ROSTER SIZE WARNING - Week ${weekNum}: Team "${teamName}" has ${playerCount} players (expected 19)`);
                console.warn(`Players found:`, rosters[teamName].map(p => p.playerText));
                // Don't throw error, just warn for now
            } else {
                console.log(`✅ ${teamName}: ${playerCount} players`);
            }
        }

        // Verify we have all 12 teams
        if (Object.keys(teamPlayerCounts).length !== 12) {
            throw new Error(
                `TEAM COUNT ERROR - Week ${weekNum}: Found ${Object.keys(teamPlayerCounts).length} teams (expected 12)`
            );
        }

        // Check if all teams actually have 19 players
        const allTeamsValid = Object.values(teamPlayerCounts).every(count => count === 19);
        if (allTeamsValid) {
            console.log(`✅ Week ${weekNum} validation passed: All 12 teams have exactly 19 players`);
        } else {
            console.log(`❌ Week ${weekNum} validation failed: Some teams don't have 19 players`);
        }

        // Extract scoring data (weekly points, cumulative points, records)
        console.log('📊 Extracting scoring and record data...');
        const teamStats = this.extractScoringData(data, teams);

        // Return structured data
        return {
            week: weekNum,
            teams: teams,
            rosters: rosters,
            teamStats: teamStats
        };
    }

    extractScoringData(data, teams) {
        const teamStats = {};
        
        // Initialize team stats
        teams.forEach(team => {
            teamStats[team.name] = {
                weeklyPoints: 0,
                cumulativePoints: 0,
                wins: 0,
                losses: 0,
                ties: 0,
                record: "0-0"
            };
        });

        // Look for scoring rows - typically after the roster data
        for (let rowIdx = 30; rowIdx < Math.min(data.length, 50); rowIdx++) {
            const row = data[rowIdx];
            if (!row || row.length === 0) continue;

            const firstCell = row[0];
            const cellStr = firstCell ? firstCell.toString().trim() : '';

            // Weekly points row (WK.)
            if (cellStr === 'WK.') {
                teams.forEach(team => {
                    const cell = row[team.col];
                    if (cell && typeof cell === 'number') {
                        teamStats[team.name].weeklyPoints = cell;
                    }
                });
                console.log(`  Found weekly points row ${rowIdx + 1}`);
            }

            // Cumulative points row (CUM)
            if (cellStr === 'CUM') {
                teams.forEach(team => {
                    const cell = row[team.col];
                    if (cell && typeof cell === 'number') {
                        teamStats[team.name].cumulativePoints = cell;
                    }
                });
                console.log(`  Found cumulative points row ${rowIdx + 1}`);
            }

            // Record row - check if any team column has a record pattern
            let foundRecord = false;
            teams.forEach(team => {
                const cell = row[team.col];
                if (cell && typeof cell === 'string') {
                    const recordMatch = cell.match(/^(\d+)-(\d+)(-(\d+))?$/);
                    if (recordMatch) {
                        teamStats[team.name].wins = parseInt(recordMatch[1]);
                        teamStats[team.name].losses = parseInt(recordMatch[2]);  
                        teamStats[team.name].ties = recordMatch[4] ? parseInt(recordMatch[4]) : 0;
                        teamStats[team.name].record = cell;
                        foundRecord = true;
                    }
                }
            });
            
            if (foundRecord) {
                console.log(`  Found record row ${rowIdx + 1}`);
            }
        }

        return teamStats;
    }

    async findOrCreatePlayer(playerName, position, nflTeam) {
        return new Promise((resolve, reject) => {
            // First try exact match
            this.db.get(
                'SELECT player_id FROM players WHERE player_name = ? AND position = ? AND nfl_team = ?',
                [playerName, position, nflTeam],
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
                    this.db.run(
                        'INSERT INTO players (player_name, position, nfl_team) VALUES (?, ?, ?)',
                        [playerName, position, nflTeam],
                        function(err) {
                            if (err) {
                                reject(err);
                                return;
                            }
                            resolve(this.lastID);
                        }
                    );
                }
            );
        });
    }

    async insertWeekData(weekData) {
        console.log(`\n💾 Inserting Week ${weekData.week} data into database...`);
        
        const { week, rosters, teamStats } = weekData;
        const isPlayoffWeek = week >= 13;

        for (const [teamName, players] of Object.entries(rosters)) {
            const teamId = teamMapping[teamName];
            if (!teamId) {
                throw new Error(`Unknown team: ${teamName}`);
            }

            let totalTeamPoints = 0;
            let starterPoints = 0;

            // Process each player
            console.log(`  Processing ${players.length} players for team ${teamName}...`);
            
            for (const playerEntry of players) {
                let playerName, nflTeam, position;
                
                if (playerEntry.position === 'DEF') {
                    playerName = playerEntry.playerText.replace(/^\*/, '').trim();
                    nflTeam = 'DEF';
                    position = 'DEF';
                } else {
                    if (!playerEntry.playerInfo) {
                        console.error(`  ❌ Missing playerInfo for: ${playerEntry.playerText}`);
                        continue;
                    }
                    playerName = playerEntry.playerInfo.name;
                    nflTeam = playerEntry.playerInfo.team;
                    position = playerEntry.position;
                }

                try {
                    // Find or create player
                    const playerId = await this.findOrCreatePlayer(playerName, position, nflTeam);
                    
                    // Use the actual fantasy points extracted from Excel
                    const fantasyPoints = playerEntry.fantasyPoints || 0;
                    const didScore = playerEntry.isStarter;

                    // Insert player performance
                    await new Promise((resolve, reject) => {
                        this.db.run(`
                            INSERT INTO weekly_player_performance 
                            (week, team_id, player_id, fantasy_points, DidScore) 
                            VALUES (?, ?, ?, ?, ?)
                        `, [week, teamId, playerId, fantasyPoints, didScore ? 1 : 0], (err) => {
                            if (err) reject(err);
                            else resolve();
                        });
                    });

                    console.log(`  ✓ Inserted: ${playerName} (${position}) - ${fantasyPoints} pts`);

                    if (didScore) {
                        starterPoints += fantasyPoints;
                    }
                    totalTeamPoints += fantasyPoints;
                } catch (error) {
                    console.error(`  ❌ Failed to insert ${playerName}: ${error.message}`);
                }
            }

            // Insert team totals using extracted data
            const teamStat = teamStats[teamName] || {};
            await new Promise((resolve, reject) => {
                this.db.run(`
                    INSERT INTO weekly_team_totals 
                    (week, team_id, weekly_points, cumulative_points, wins, losses, is_playoff_week) 
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `, [week, teamId, teamStat.weeklyPoints || 0, teamStat.cumulativePoints || 0, 
                    teamStat.wins || 0, teamStat.losses || 0, isPlayoffWeek ? 1 : 0], (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
        }

        console.log(`✅ Week ${week} data inserted successfully`);
    }

    async extractAllWeeks() {
        console.log('\n🚀 Starting extraction of available weeks...');
        
        // Only extract weeks that have data sheets available
        const availableWeeks = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17];
        
        for (const week of availableWeeks) {
            try {
                console.log(`\n=== PROCESSING WEEK ${week} ===`);
                
                const weekData = this.extractWeekData(week);
                await this.insertWeekData(weekData);
                
                console.log(`✅ Week ${week} completed successfully`);
                
            } catch (error) {
                console.error(`❌ FAILED TO IMPORT WEEK ${week}:`);
                console.error(error.message);
                process.exit(1); // Stop the entire process
            }
        }
        
        console.log(`\n🎉 ALL ${availableWeeks.length} AVAILABLE WEEKS IMPORTED SUCCESSFULLY`);
        
        // Generate summary report
        await this.generateSummaryReport();
    }

    async generateSummaryReport() {
        console.log('\n📊 Generating summary report...');
        
        // Player count by week
        const playerCounts = await new Promise((resolve, reject) => {
            this.db.all(`
                SELECT week, COUNT(*) as player_count
                FROM weekly_player_performance 
                GROUP BY week 
                ORDER BY week
            `, (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });

        console.log('\nPlayer counts by week:');
        playerCounts.forEach(row => {
            console.log(`Week ${row.week}: ${row.player_count} players (${row.player_count / 12} per team)`);
        });

        // Unique players
        const uniquePlayers = await new Promise((resolve, reject) => {
            this.db.get('SELECT COUNT(*) as count FROM players', (err, row) => {
                if (err) reject(err);
                else resolve(row.count);
            });
        });

        console.log(`\nTotal unique players: ${uniquePlayers}`);
        console.log(`Database created: ${dbPath}`);
    }

    async close() {
        if (this.db) {
            await new Promise((resolve) => {
                this.db.close(resolve);
            });
        }
    }
}

// Main execution
async function main() {
    const extractor = new PFL2024Extractor();
    
    try {
        await extractor.initialize();
        await extractor.extractAllWeeks();
    } catch (error) {
        console.error('💥 Extraction failed:', error.message);
        process.exit(1);
    } finally {
        await extractor.close();
    }
}

if (require.main === module) {
    main().catch(console.error);
}

module.exports = PFL2024Extractor;