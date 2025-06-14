#!/usr/bin/env node

const Tank01Service = require('../server/services/tank01Service');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
require('dotenv').config();

// Database path
const dbPath = path.join(__dirname, '../fantasy_football.db');

class Backfill2024Stats {
    constructor() {
        this.tank01 = new Tank01Service(process.env.TANK01_API_KEY);
        this.db = new sqlite3.Database(dbPath);
        this.totalStatsImported = 0;
        this.totalGamesProcessed = 0;
        this.errors = [];
    }

    async run() {
        console.log('🏈 Starting 2024 NFL stats backfill from Tank01 API...\n');

        if (!process.env.TANK01_API_KEY) {
            throw new Error('TANK01_API_KEY environment variable is required');
        }

        try {
            // Clear existing 2024 stats and prepare database
            await this.prepareDatabase();

            // Process all 18 regular season weeks (2024 had 18 weeks)
            for (let week = 1; week <= 18; week++) {
                console.log(`\n📅 Processing Week ${week}...`);
                await this.processWeek(week, 2024);
                
                // Add delay between weeks to respect rate limits
                await this.delay(2000);
            }

            // Summary
            console.log('\n🎉 2024 Stats Backfill Complete!');
            console.log(`📊 Summary:`);
            console.log(`  • ${this.totalGamesProcessed} games processed`);
            console.log(`  • ${this.totalStatsImported} player stat records imported`);
            console.log(`  • ${this.errors.length} errors encountered`);

            if (this.errors.length > 0) {
                console.log('\n⚠️  Errors:');
                this.errors.slice(0, 10).forEach((error, index) => {
                    console.log(`  ${index + 1}. ${error}`);
                });
                if (this.errors.length > 10) {
                    console.log(`  ... and ${this.errors.length - 10} more errors`);
                }
            }

        } catch (error) {
            console.error('❌ Error during stats backfill:', error.message);
            throw error;
        } finally {
            this.db.close();
        }
    }

    async prepareDatabase() {
        console.log('🗑️  Preparing database...');
        
        // Add missing columns if they don't exist
        await this.addMissingColumns();
        
        // Clear existing 2024 stats
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
            { column: 'player_name', type: 'TEXT' },
            { column: 'team', type: 'TEXT' },
            { column: 'position', type: 'TEXT' },
            { column: 'game_id', type: 'TEXT' },
            { column: 'raw_stats', type: 'TEXT' },
            { column: 'created_at', type: 'DATETIME' },
            { column: 'two_point_conversions_pass', type: 'INTEGER DEFAULT 0' },
            { column: 'two_point_conversions_run', type: 'INTEGER DEFAULT 0' },
            { column: 'two_point_conversions_rec', type: 'INTEGER DEFAULT 0' }
        ];

        for (const { column, type } of columnsToAdd) {
            try {
                await new Promise((resolve, reject) => {
                    this.db.run(`ALTER TABLE player_stats ADD COLUMN ${column} ${type}`, (err) => {
                        if (err && !err.message.includes('duplicate column name')) {
                            reject(err);
                        } else {
                            resolve();
                        }
                    });
                });
            } catch (error) {
                if (!error.message.includes('duplicate column name')) {
                    console.warn(`Warning adding column ${column}:`, error.message);
                }
            }
        }
        
        console.log('✅ Database schema updated');
    }

    async processWeek(week, season) {
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
                // Add small delay between games
                await this.delay(1000);
            }

        } catch (error) {
            const errorMsg = `Week ${week}: ${error.message}`;
            this.errors.push(errorMsg);
            console.error(`  ❌ Error processing week ${week}:`, error.message);
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

            // Process player stats from fantasy points section
            const statsImported = await this.extractPlayerStats(boxScoreData, week, season, gameID);
            
            this.totalStatsImported += statsImported;
            this.totalGamesProcessed++;
            
            console.log(`    ✅ Game ${gameID}: ${statsImported} player stats imported`);

        } catch (error) {
            const errorMsg = `Game ${gameID}: ${error.message}`;
            this.errors.push(errorMsg);
            console.error(`    ❌ Error processing game ${gameID}:`, error.message);
        }
    }

    async extractPlayerStats(boxScoreData, week, season, gameID) {
        let statsImported = 0;

        try {
            // Tank01 stores player stats with player IDs as keys at the top level
            const playerStats = boxScoreData.playerStats || {};
            
            if (Object.keys(playerStats).length === 0) {
                console.log(`      ⚠️  No player stats data found for game ${gameID}`);
                return 0;
            }

            console.log(`      📊 Found ${Object.keys(playerStats).length} players with stats`);

            // Process each player's stats
            for (const [playerId, playerData] of Object.entries(playerStats)) {
                if (playerData && typeof playerData === 'object') {
                    const imported = await this.importPlayerStat(playerId, playerData, week, season, gameID);
                    if (imported) {
                        statsImported++;
                    }
                }
            }

        } catch (error) {
            console.error(`      ❌ Error extracting player stats for game ${gameID}:`, error.message);
        }

        return statsImported;
    }

    async importPlayerStat(playerId, playerData, week, season, gameID) {
        try {
            // Extract player information
            const playerName = playerData.longName || playerData.name || playerData.playerName || 'Unknown';
            const team = playerData.team || playerData.teamAbv || 'UNK';
            const position = playerData.pos || playerData.position || 'UNK';
            
            // Extract stats from nested objects
            const passingStats = playerData.Passing || {};
            const rushingStats = playerData.Rushing || {};
            const receivingStats = playerData.Receiving || {};
            const kickingStats = playerData.Kicking || {};
            const fumbleStats = playerData.Fumbles || {};
            const twoPointStats = playerData.TwoPoint || playerData.twoPoint || {};
            
            // Extract individual stats from their respective sections
            const passingYards = parseInt(passingStats.passYds || 0);
            const passingTds = parseInt(passingStats.passTD || 0);
            const interceptions = parseInt(passingStats.int || 0);
            const passingAttempts = parseInt(passingStats.passAttempts || 0);
            const passingCompletions = parseInt(passingStats.passCompletions || 0);
            
            const rushingYards = parseInt(rushingStats.rushYds || 0);
            const rushingTds = parseInt(rushingStats.rushTD || 0);
            const rushingAttempts = parseInt(rushingStats.carries || 0);
            
            const receivingYards = parseInt(receivingStats.recYds || 0);
            const receivingTds = parseInt(receivingStats.recTD || 0);
            const receptions = parseInt(receivingStats.receptions || 0);
            const targets = parseInt(receivingStats.targets || 0);
            
            const fumbles = parseInt(fumbleStats.fumbles || 0);
            const fieldGoalsMade = parseInt(kickingStats.fgMade || 0);
            const fieldGoalsAttempted = parseInt(kickingStats.fgAtt || 0);
            const extraPointsMade = parseInt(kickingStats.xpMade || 0);
            const extraPointsAttempted = parseInt(kickingStats.xpAttempts || 0);
            
            // Extract 2-point conversion stats (try multiple possible field names)
            const twoPointConversionsPass = parseInt(twoPointStats.pass || twoPointStats.passing || 
                                                   passingStats.twoPointPass || playerData.twoPointPass || 0);
            const twoPointConversionsRun = parseInt(twoPointStats.run || twoPointStats.rushing || 
                                                  rushingStats.twoPointRush || playerData.twoPointRush || 0);
            const twoPointConversionsRec = parseInt(twoPointStats.rec || twoPointStats.receiving || 
                                                  receivingStats.twoPointRec || playerData.twoPointRec || 0);

            // Skip players with no meaningful stats
            if (passingYards === 0 && rushingYards === 0 && 
                receivingYards === 0 && receptions === 0 && fieldGoalsMade === 0 && 
                passingTds === 0 && rushingTds === 0 && receivingTds === 0) {
                // console.log(`Skipping ${playerName} - no stats`);
                return false;
            }
            

            // Insert into database
            return new Promise((resolve, reject) => {
                this.db.run(`
                    INSERT OR REPLACE INTO player_stats 
                    (player_id, week, season, passing_yards, passing_tds, interceptions,
                     rushing_yards, rushing_tds, receiving_yards, receiving_tds, receptions,
                     fumbles, field_goals_made, field_goals_attempted, extra_points_made, 
                     extra_points_attempted, two_point_conversions_pass, two_point_conversions_run, 
                     two_point_conversions_rec, player_name, team, position, 
                     game_id, raw_stats, created_at) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [
                    playerId, week, season, passingYards, passingTds, interceptions,
                    rushingYards, rushingTds, receivingYards, receivingTds, receptions,
                    fumbles, fieldGoalsMade, fieldGoalsAttempted, extraPointsMade, 
                    extraPointsAttempted, twoPointConversionsPass, twoPointConversionsRun, 
                    twoPointConversionsRec, playerName, team, position,
                    gameID, JSON.stringify(playerData), new Date().toISOString()
                ], (err) => {
                    if (err) {
                        console.error(`        ❌ Error inserting ${playerName}: ${err.message}`);
                        reject(err);
                    } else {
                        // console.log(`        ✅ Successfully inserted ${playerName}`);
                        resolve(true);
                    }
                });
            });

        } catch (error) {
            console.error(`        ❌ Error importing player stat for ${playerId}:`, error.message);
            return false;
        }
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// Main execution
async function main() {
    const backfiller = new Backfill2024Stats();
    
    try {
        await backfiller.run();
    } catch (error) {
        console.error('❌ Fatal error:', error.message);
        process.exit(1);
    }
}

// Run if called directly
if (require.main === module) {
    main();
}

module.exports = { Backfill2024Stats };