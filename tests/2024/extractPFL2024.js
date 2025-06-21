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

// Valid NFL teams for DST
const validNFLTeams = [
    'Texans', 'Giants', 'Cowboys', 'Jets', 'Cardinals', 'Falcons', 'Bears', 'Lions', 
    'Ravens', 'Bills', 'Chiefs', 'Patriots', 'Dolphins', 'Seahawks', 'Steelers', 
    'Panthers', 'Bengals', 'Colts', 'Saints', 'Jaguars', 'Browns', 'Broncos', 
    '49ers', 'Eagles', 'Rams', 'Chargers', 'Raiders', 'Vikings', 'Packers', 
    'Titans', 'Buccaneers', 'Commanders'
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

    extractWeekData(weekNum) {
        console.log(`\n📅 Extracting Week ${weekNum} data...`);
        
        const sheetName = `Week ${weekNum}`;
        if (!this.workbook.Sheets[sheetName]) {
            throw new Error(`Sheet "${sheetName}" not found in Excel file`);
        }

        const worksheet = this.workbook.Sheets[sheetName];
        const data = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });

        if (data.length === 0) {
            throw new Error(`No data found in sheet "${sheetName}"`);
        }

        // Get team names from first row
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
                    continue;
                }
            }

            if (!currentPosition) continue;

            // Process each team's player in this row
            teams.forEach(team => {
                const cell = row[team.col];
                if (!cell || cell === '') return;

                // Skip numeric values (scores)
                if (typeof cell === 'number' || (typeof cell === 'string' && /^\d*\.?\d+$/.test(cell.trim()))) {
                    return;
                }

                // Skip obviously non-player data
                const cellStr = cell.toString().trim();
                if (cellStr.includes('=') || cellStr === 'PTS' || cellStr.length < 3) {
                    return;
                }

                // Handle DEF specially
                if (currentPosition === 'DEF') {
                    const cleanDEF = cellStr.replace(/^\*/, '').trim();
                    if (validNFLTeams.includes(cleanDEF)) {
                        rosters[team.name].push({
                            position: 'DEF',
                            playerText: cellStr,
                            isStarter: cellStr.startsWith('*')
                        });
                    }
                    return;
                }

                // For other positions, require player format
                const playerInfo = this.parsePlayerName(cellStr);
                if (playerInfo) {
                    rosters[team.name].push({
                        position: currentPosition,
                        playerText: cellStr,
                        playerInfo: playerInfo,
                        isStarter: playerInfo.isStarter
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
                console.error(`❌ ROSTER SIZE ERROR - Week ${weekNum}: Team "${teamName}" has ${playerCount} players (expected 19)`);
                console.error(`Players found:`, rosters[teamName].map(p => p.playerText));
                throw new Error(
                    `ROSTER SIZE ERROR - Week ${weekNum}: Team "${teamName}" has ${playerCount} players (expected 19)`
                );
            }
        }

        // Verify we have all 12 teams
        if (Object.keys(teamPlayerCounts).length !== 12) {
            throw new Error(
                `TEAM COUNT ERROR - Week ${weekNum}: Found ${Object.keys(teamPlayerCounts).length} teams (expected 12)`
            );
        }

        console.log(`✅ Week ${weekNum} validation passed: All 12 teams have exactly 19 players`);

        // Return structured data
        return {
            week: weekNum,
            teams: teams,
            rosters: rosters
        };
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
        
        const { week, rosters } = weekData;
        const isPlayoffWeek = week >= 13;

        for (const [teamName, players] of Object.entries(rosters)) {
            const teamId = teamMapping[teamName];
            if (!teamId) {
                throw new Error(`Unknown team: ${teamName}`);
            }

            let totalTeamPoints = 0;
            let starterPoints = 0;

            // Process each player
            for (const playerEntry of players) {
                let playerName, nflTeam, position;
                
                if (playerEntry.position === 'DEF') {
                    playerName = playerEntry.playerText.replace(/^\*/, '').trim();
                    nflTeam = 'DEF';
                    position = 'DEF';
                } else {
                    playerName = playerEntry.playerInfo.name;
                    nflTeam = playerEntry.playerInfo.team;
                    position = playerEntry.position;
                }

                // Find or create player
                const playerId = await this.findOrCreatePlayer(playerName, position, nflTeam);
                
                // For now, set fantasy points to 0 - this would be extracted from Excel if available
                const fantasyPoints = 0; // TODO: Extract actual points from Excel
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

                if (didScore) {
                    starterPoints += fantasyPoints;
                }
                totalTeamPoints += fantasyPoints;
            }

            // Insert team totals (placeholder values for now)
            await new Promise((resolve, reject) => {
                this.db.run(`
                    INSERT INTO weekly_team_totals 
                    (week, team_id, weekly_points, cumulative_points, wins, losses, is_playoff_week) 
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `, [week, teamId, starterPoints, 0, 0, 0, isPlayoffWeek ? 1 : 0], (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
        }

        console.log(`✅ Week ${week} data inserted successfully`);
    }

    async extractAllWeeks() {
        console.log('\n🚀 Starting extraction of all 17 weeks...');
        
        for (let week = 1; week <= 17; week++) {
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
        
        console.log('\n🎉 ALL 17 WEEKS IMPORTED SUCCESSFULLY');
        
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