#!/usr/bin/env node

const path = require('path');
const sqlite3 = require('sqlite3').verbose();
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

// Import the services we need
const NFLGamesService = require('../../server/services/nflGamesService');
const Tank01Service = require('../../server/services/tank01Service');

// Simple database wrapper to match the expected interface
class DatabaseManager {
    constructor(dbPath) {
        this.db = new sqlite3.Database(dbPath);
    }

    run(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.run(sql, params, function(err) {
                if (err) reject(err);
                else resolve({ lastID: this.lastID, changes: this.changes });
            });
        });
    }

    get(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.get(sql, params, (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
    }

    all(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    }

    close() {
        return new Promise((resolve) => {
            this.db.close(resolve);
        });
    }
}

async function sync2024Games() {
    const dbPath = path.join(__dirname, 'statfinkv1_2024.db');
    const db = new DatabaseManager(dbPath);
    
    // Initialize Tank01 service (you'll need your API key)
    const apiKey = process.env.TANK01_API_KEY;
    if (!apiKey) {
        console.error('❌ TANK01_API_KEY environment variable not set');
        console.log('Please set your Tank01 API key:');
        console.log('export TANK01_API_KEY="your_api_key_here"');
        process.exit(1);
    }

    const tank01Service = new Tank01Service(apiKey, db);
    const nflGamesService = new NFLGamesService(db, tank01Service);

    console.log('🏈 Starting 2024 NFL Season Games Sync...\n');

    // 2024 NFL season has 18 weeks
    const season = 2024;
    const weeks = Array.from({length: 18}, (_, i) => i + 1);
    
    let totalGamesSync = 0;
    let successfulWeeks = 0;
    let failedWeeks = 0;

    try {
        for (const week of weeks) {
            console.log(`\n=== SYNCING WEEK ${week} ===`);
            
            try {
                const result = await nflGamesService.syncWeekGames(week, season);
                
                if (result.success) {
                    console.log(`✅ Week ${week}: ${result.gamesProcessed} games synced`);
                    totalGamesSync += result.gamesProcessed;
                    successfulWeeks++;
                } else {
                    console.log(`❌ Week ${week}: ${result.message}`);
                    failedWeeks++;
                }
                
                // Small delay between weeks to be respectful to the API
                if (week < weeks.length) {
                    console.log('⏱️  Waiting 2 seconds before next week...');
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
                
            } catch (weekError) {
                console.error(`❌ Week ${week} failed:`, weekError.message);
                failedWeeks++;
            }
        }

        console.log('\n🎉 2024 NFL SEASON SYNC COMPLETE!');
        console.log('=====================================');
        console.log(`✅ Successful weeks: ${successfulWeeks}`);
        console.log(`❌ Failed weeks: ${failedWeeks}`);
        console.log(`🏈 Total games synced: ${totalGamesSync}`);

        // Show summary by week
        console.log('\n📊 GAMES SUMMARY BY WEEK:');
        console.log('==========================');
        
        for (const week of weeks) {
            try {
                const weekGames = await nflGamesService.getWeekGames(week, season);
                const completion = await nflGamesService.areAllWeekGamesComplete(week, season);
                
                console.log(`Week ${week.toString().padStart(2)}: ${weekGames.length} games, ${completion.completionPercentage}% complete`);
            } catch (error) {
                console.log(`Week ${week.toString().padStart(2)}: Error getting summary`);
            }
        }

        // Show overall stats
        const totalGamesInDB = await db.get('SELECT COUNT(*) as count FROM nfl_games WHERE season = ?', [season]);
        const completedGames = await db.get('SELECT COUNT(*) as count FROM nfl_games WHERE season = ? AND status = "Final"', [season]);
        const liveGames = await db.get('SELECT COUNT(*) as count FROM nfl_games WHERE season = ? AND status IN ("Live", "In Progress")', [season]);
        
        console.log('\n📈 FINAL STATISTICS:');
        console.log('====================');
        console.log(`Total games in database: ${totalGamesInDB.count}`);
        console.log(`Completed games: ${completedGames.count}`);
        console.log(`Live/In-progress games: ${liveGames.count}`);
        
        // Show some example games
        console.log('\n🔍 SAMPLE GAMES:');
        console.log('================');
        const sampleGames = await db.all(`
            SELECT game_id, week, home_team, away_team, home_score, away_score, status
            FROM nfl_games 
            WHERE season = ? 
            ORDER BY week, game_date 
            LIMIT 10
        `, [season]);
        
        sampleGames.forEach(game => {
            console.log(`Week ${game.week}: ${game.away_team} @ ${game.home_team} (${game.away_score}-${game.home_score}) [${game.status}]`);
        });

    } catch (error) {
        console.error('💥 Sync failed:', error);
    } finally {
        await db.close();
        console.log('\n🔌 Database connection closed');
    }
}

// Run the sync
if (require.main === module) {
    sync2024Games().catch(console.error);
}

module.exports = sync2024Games;