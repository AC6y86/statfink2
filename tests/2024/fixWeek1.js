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

async function fixWeek1() {
    const dbPath = path.join(__dirname, 'statfinkv1_2024.db');
    const db = new DatabaseManager(dbPath);
    
    // Initialize Tank01 service
    const apiKey = process.env.TANK01_API_KEY;
    if (!apiKey) {
        console.error('❌ TANK01_API_KEY environment variable not set');
        process.exit(1);
    }

    const tank01Service = new Tank01Service(apiKey, db);
    const nflGamesService = new NFLGamesService(db, tank01Service);

    console.log('🔧 Fixing Week 1 2024 NFL Games...\n');

    try {
        // Sync Week 1 specifically
        console.log('=== SYNCING WEEK 1 ===');
        const result = await nflGamesService.syncWeekGames(1, 2024);
        
        if (result.success) {
            console.log(`✅ Week 1: ${result.gamesProcessed} games synced successfully`);
            
            // Verify the data
            const week1Games = await nflGamesService.getWeekGames(1, 2024);
            console.log(`\n📊 Week 1 Verification:`);
            console.log(`Total games: ${week1Games.length}`);
            
            if (week1Games.length > 0) {
                console.log('\n🏈 Week 1 Games:');
                week1Games.forEach(game => {
                    console.log(`${game.away_team} @ ${game.home_team} (${game.away_score}-${game.home_score}) [${game.status}]`);
                });
            }
            
            // Check completion status
            const completion = await nflGamesService.areAllWeekGamesComplete(1, 2024);
            console.log(`\n✅ Week 1 Status:`);
            console.log(`Complete: ${completion.isComplete ? 'Yes' : 'No'}`);
            console.log(`Completed games: ${completion.completedGames}/${completion.totalGames} (${completion.completionPercentage}%)`);
            
        } else {
            console.log(`❌ Week 1 sync failed: ${result.message}`);
        }

    } catch (error) {
        console.error('💥 Fix failed:', error);
    } finally {
        await db.close();
        console.log('\n🔌 Database connection closed');
    }
}

// Run the fix
if (require.main === module) {
    fixWeek1().catch(console.error);
}

module.exports = fixWeek1;