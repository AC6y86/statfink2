#!/usr/bin/env node

const Tank01Service = require('../server/services/tank01Service');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
require('dotenv').config();

// Database path
const dbPath = path.join(__dirname, '../fantasy_football.db');

class Stats2024Fetcher {
    constructor() {
        this.tank01 = new Tank01Service(process.env.TANK01_API_KEY);
        this.db = new sqlite3.Database(dbPath);
        this.totalStatsImported = 0;
        this.totalGamesProcessed = 0;
        this.errors = [];
    }

    async fetchAllStats() {
        console.log('🏈 Starting 2024 NFL stats fetch from Tank01 API...\n');

        if (!process.env.TANK01_API_KEY) {
            throw new Error('TANK01_API_KEY environment variable is required');
        }

        try {
            // Clear existing 2024 stats
            await this.clearExistingStats();

            // Process all 17 regular season weeks
            for (let week = 1; week <= 17; week++) {
                console.log(`\n📅 Processing Week ${week}...`);
                await this.fetchWeekStats(week, 2024);
            }

            // Summary
            console.log('\n🎉 2024 Stats Import Complete!');
            console.log(`📊 Summary:`);
            console.log(`  • ${this.totalGamesProcessed} games processed`);
            console.log(`  • ${this.totalStatsImported} player stat records imported`);
            console.log(`  • ${this.errors.length} errors encountered`);

            if (this.errors.length > 0) {
                console.log('\n⚠️  Errors:');
                this.errors.forEach((error, index) => {
                    console.log(`  ${index + 1}. ${error}`);
                });
            }

        } catch (error) {
            console.error('❌ Error during stats fetch:', error.message);
            throw error;
        } finally {
            this.db.close();
        }
    }

    async clearExistingStats() {
        console.log('🗑️  Clearing existing 2024 stats...');
        
        // First add missing columns if they don't exist
        await this.addMissingColumns();
        
        return new Promise((resolve, reject) => {
            this.db.run('DELETE FROM player_stats WHERE season = 2024', (err) => {
                if (err) {
                    reject(err);
                } else {
                    console.log('✅ Cleared existing 2024 player stats');
                    resolve();
                }
            });
        });
    }

    async addMissingColumns() {
        const columnsToAdd = [
            'ALTER TABLE player_stats ADD COLUMN player_name TEXT',
            'ALTER TABLE player_stats ADD COLUMN team TEXT',
            'ALTER TABLE player_stats ADD COLUMN position TEXT',
            'ALTER TABLE player_stats ADD COLUMN game_id TEXT',
            'ALTER TABLE player_stats ADD COLUMN raw_stats TEXT',
            'ALTER TABLE player_stats ADD COLUMN created_at DATETIME'
        ];

        for (const sql of columnsToAdd) {
            try {
                await new Promise((resolve, reject) => {
                    this.db.run(sql, (err) => {
                        if (err && !err.message.includes('duplicate column name')) {
                            reject(err);
                        } else {
                            resolve();
                        }
                    });
                });
            } catch (error) {
                // Ignore duplicate column errors
                if (!error.message.includes('duplicate column name')) {
                    console.warn('Warning adding column:', error.message);
                }
            }
        }
        
        console.log('✅ Database schema updated');
    }

    async fetchWeekStats(week, season) {
        try {
            // Get all games for this week
            const gamesData = await this.tank01.getNFLGamesForWeek(week, season);
            
            if (!gamesData || typeof gamesData !== 'object') {
                console.log(`  ⚠️  No games data for week ${week}`);
                return;
            }

            // Extract games from the response
            const games = Object.values(gamesData).filter(game => 
                game && typeof game === 'object' && game.gameID
            );

            if (games.length === 0) {
                console.log(`  ⚠️  No games found for week ${week}`);
                return;
            }

            console.log(`  📋 Found ${games.length} games for week ${week}`);

            // Process each game
            for (const game of games) {
                await this.processGame(game.gameID, week, season);
            }

        } catch (error) {
            const errorMsg = `Week ${week}: ${error.message}`;
            this.errors.push(errorMsg);
            console.error(`  ❌ Error fetching week ${week}:`, error.message);
        }
    }

    async processGame(gameID, week, season) {
        try {
            console.log(`    🎮 Processing game ${gameID}...`);
            
            // Get box score data
            const boxScoreData = await this.tank01.getNFLBoxScore(gameID);
            
            if (!boxScoreData || boxScoreData.error) {
                console.log(`    ⚠️  No box score data for game ${gameID}`);
                return;
            }

            // Process player stats from box score
            const statsImported = await this.processBoxScore(boxScoreData, week, season, gameID);
            
            this.totalStatsImported += statsImported;
            this.totalGamesProcessed++;
            
            console.log(`    ✅ Game ${gameID}: ${statsImported} player stats imported`);

        } catch (error) {
            const errorMsg = `Game ${gameID}: ${error.message}`;
            this.errors.push(errorMsg);
            console.error(`    ❌ Error processing game ${gameID}:`, error.message);
        }
    }

    async processBoxScore(boxScoreData, week, season, gameID) {
        let statsImported = 0;

        try {
            // Tank01 box score structure varies, need to explore the data structure
            console.log(`    🔍 Analyzing box score structure for game ${gameID}...`);
            
            // Common paths for player stats in Tank01 API
            const possiblePaths = [
                boxScoreData.playerStats,
                boxScoreData.stats,
                boxScoreData.players,
                boxScoreData.fantasyPoints,
                boxScoreData.gameStats
            ];

            // Try to find player stats in the response
            for (const statsPath of possiblePaths) {
                if (statsPath && typeof statsPath === 'object') {
                    console.log(`    📊 Found stats in path: ${Object.keys(statsPath).slice(0, 5)}`);
                    
                    // Process different team stats
                    for (const [key, value] of Object.entries(statsPath)) {
                        if (value && typeof value === 'object') {
                            const imported = await this.processTeamStats(value, week, season, gameID, key);
                            statsImported += imported;
                        }
                    }
                }
            }

            // If no stats found in common paths, explore the structure
            if (statsImported === 0) {
                console.log(`    🔍 Box score structure for game ${gameID}:`, {
                    topLevelKeys: Object.keys(boxScoreData).slice(0, 10),
                    hasTeams: !!boxScoreData.teams,
                    hasHome: !!boxScoreData.home,
                    hasAway: !!boxScoreData.away
                });

                // Try to find stats in home/away team structure
                if (boxScoreData.home || boxScoreData.away) {
                    const teams = [boxScoreData.home, boxScoreData.away].filter(t => t);
                    for (const team of teams) {
                        if (team && team.playerStats) {
                            const imported = await this.processTeamStats(team.playerStats, week, season, gameID, team.teamAbv);
                            statsImported += imported;
                        }
                    }
                }
            }

        } catch (error) {
            console.error(`    ❌ Error processing box score for game ${gameID}:`, error.message);
        }

        return statsImported;
    }

    async processTeamStats(teamStats, week, season, gameID, teamKey) {
        let imported = 0;

        try {
            // teamStats could be an object with different position groups
            for (const [position, players] of Object.entries(teamStats)) {
                if (Array.isArray(players)) {
                    for (const player of players) {
                        if (await this.importPlayerStat(player, week, season, gameID, position)) {
                            imported++;
                        }
                    }
                } else if (players && typeof players === 'object') {
                    // Sometimes players are in nested objects
                    for (const [playerKey, playerData] of Object.entries(players)) {
                        if (playerData && typeof playerData === 'object') {
                            if (await this.importPlayerStat(playerData, week, season, gameID, position)) {
                                imported++;
                            }
                        }
                    }
                }
            }
        } catch (error) {
            console.error(`      ❌ Error processing team stats for ${teamKey}:`, error.message);
        }

        return imported;
    }

    async importPlayerStat(playerData, week, season, gameID, position) {
        try {
            // Extract key player information
            const playerId = playerData.playerID || playerData.id || playerData.player_id;
            const playerName = playerData.longName || playerData.name || playerData.player_name;
            const team = playerData.team || playerData.teamAbv;
            
            // Extract fantasy points if available
            const fantasyPoints = playerData.fantasyPoints || 
                                playerData.fantasy_points || 
                                playerData.fpts || 
                                this.calculateFantasyPoints(playerData);

            if (!playerId || !playerName) {
                return false; // Skip invalid player data
            }

            // Extract individual stats for the existing schema
            const passingYards = playerData.passYds || playerData.passing_yards || 0;
            const passingTds = playerData.passTD || playerData.passing_tds || 0;
            const interceptions = playerData.passInt || playerData.interceptions || 0;
            const rushingYards = playerData.rushYds || playerData.rushing_yards || 0;
            const rushingTds = playerData.rushTD || playerData.rushing_tds || 0;
            const receivingYards = playerData.recYds || playerData.receiving_yards || 0;
            const receivingTds = playerData.recTD || playerData.receiving_tds || 0;
            const receptions = playerData.rec || playerData.receptions || 0;
            const fumbles = playerData.fumbles || 0;
            const fieldGoalsMade = playerData.fgMade || playerData.field_goals_made || 0;
            const fieldGoalsAttempted = playerData.fgAtt || playerData.field_goals_attempted || 0;
            const extraPointsMade = playerData.xpMade || playerData.extra_points_made || 0;
            const extraPointsAttempted = playerData.xpAtt || playerData.extra_points_attempted || 0;

            // Insert into database with both old and new columns
            return new Promise((resolve, reject) => {
                this.db.run(`
                    INSERT OR REPLACE INTO player_stats 
                    (player_id, week, season, passing_yards, passing_tds, interceptions,
                     rushing_yards, rushing_tds, receiving_yards, receiving_tds, receptions,
                     fumbles, field_goals_made, field_goals_attempted, extra_points_made, 
                     extra_points_attempted, fantasy_points, player_name, team, position, 
                     game_id, raw_stats, created_at) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
                `, [
                    playerId, week, season, passingYards, passingTds, interceptions,
                    rushingYards, rushingTds, receivingYards, receivingTds, receptions,
                    fumbles, fieldGoalsMade, fieldGoalsAttempted, extraPointsMade, 
                    extraPointsAttempted, fantasyPoints || 0, playerName, team, position,
                    gameID, JSON.stringify(playerData)
                ], (err) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(true);
                    }
                });
            });

        } catch (error) {
            console.error(`      ❌ Error importing player stat:`, error.message);
            return false;
        }
    }

    calculateFantasyPoints(stats) {
        // Basic fantasy points calculation if not provided
        let points = 0;

        // Passing stats
        if (stats.passYds) points += stats.passYds * 0.04;
        if (stats.passTD) points += stats.passTD * 4;
        if (stats.passInt) points += stats.passInt * -2;

        // Rushing stats
        if (stats.rushYds) points += stats.rushYds * 0.1;
        if (stats.rushTD) points += stats.rushTD * 6;

        // Receiving stats
        if (stats.recYds) points += stats.recYds * 0.1;
        if (stats.recTD) points += stats.recTD * 6;
        if (stats.rec) points += stats.rec * 0.5; // PPR

        // Kicking stats
        if (stats.fgMade) points += stats.fgMade * 3;
        if (stats.xpMade) points += stats.xpMade * 1;

        return Math.round(points * 100) / 100; // Round to 2 decimal places
    }
}

// Main execution
async function main() {
    const fetcher = new Stats2024Fetcher();
    
    try {
        await fetcher.fetchAllStats();
    } catch (error) {
        console.error('❌ Fatal error:', error.message);
        process.exit(1);
    }
}

// Run if called directly
if (require.main === module) {
    main();
}

module.exports = { Stats2024Fetcher };