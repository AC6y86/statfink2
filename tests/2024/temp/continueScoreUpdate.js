#!/usr/bin/env node

const path = require('path');
const sqlite3 = require('sqlite3').verbose();
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });

const Tank01Service = require('../../../server/services/tank01Service');
const NFLGamesService = require('../../../server/services/nflGamesService');

// Simple database wrapper
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

async function continueScoreUpdate() {
    const dbPath = path.join(__dirname, '../statfinkv1_2024.db');
    const db = new DatabaseManager(dbPath);
    
    const apiKey = process.env.TANK01_API_KEY;
    if (!apiKey) {
        console.error('❌ TANK01_API_KEY not set');
        process.exit(1);
    }

    const tank01Service = new Tank01Service(apiKey, db);
    const nflGamesService = new NFLGamesService(db, tank01Service);

    console.log('🔄 Continuing NFL game score updates...\n');

    try {
        // Get only games that still need updating (0-0 scores)
        const gamesToUpdate = await db.all(`
            SELECT game_id, week, home_team, away_team, home_score, away_score, status 
            FROM nfl_games 
            WHERE season = 2024 AND home_score = 0 AND away_score = 0
            ORDER BY week, game_id
            LIMIT 50
        `);

        if (gamesToUpdate.length === 0) {
            console.log('✅ All games already have scores!');
            
            // Show final summary
            const finalCount = await db.get(`
                SELECT 
                    COUNT(*) as total_games,
                    COUNT(CASE WHEN home_score > 0 OR away_score > 0 THEN 1 END) as games_with_scores
                FROM nfl_games 
                WHERE season = 2024
            `);
            
            console.log(`📊 Final Status: ${finalCount.games_with_scores}/${finalCount.total_games} games have scores`);
            return;
        }

        console.log(`🎯 Found ${gamesToUpdate.length} games that need score updates\n`);

        let updated = 0;
        let failed = 0;

        // Process games individually with progress tracking
        for (let i = 0; i < gamesToUpdate.length; i++) {
            const game = gamesToUpdate[i];
            const progress = `[${i + 1}/${gamesToUpdate.length}]`;
            
            try {
                console.log(`${progress} Processing ${game.away_team} @ ${game.home_team} (Week ${game.week})...`);
                
                const success = await nflGamesService.updateGameFromAPI(game.game_id);
                
                if (success) {
                    // Check if scores were actually updated
                    const updatedGame = await db.get(`
                        SELECT home_score, away_score, status
                        FROM nfl_games 
                        WHERE game_id = ?
                    `, [game.game_id]);
                    
                    const hasScores = updatedGame.home_score > 0 || updatedGame.away_score > 0;
                    
                    if (hasScores) {
                        updated++;
                        console.log(`  ✅ Updated to ${updatedGame.away_score}-${updatedGame.home_score} (${updatedGame.status})`);
                    } else {
                        console.log(`  ⚪ No scores available (${updatedGame.status})`);
                    }
                } else {
                    failed++;
                    console.log(`  ❌ Failed to update`);
                }
                
                // Small delay to be nice to the API
                if (i < gamesToUpdate.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
                
            } catch (error) {
                failed++;
                console.log(`  💥 Error: ${error.message}`);
            }
        }

        console.log('\n' + '='.repeat(50));
        console.log(`📈 Batch Summary: ${updated} updated, ${failed} failed`);
        
        // Show current overall status
        const currentCount = await db.get(`
            SELECT 
                COUNT(*) as total_games,
                COUNT(CASE WHEN home_score > 0 OR away_score > 0 THEN 1 END) as games_with_scores,
                COUNT(CASE WHEN home_score = 0 AND away_score = 0 THEN 1 END) as games_without_scores
            FROM nfl_games 
            WHERE season = 2024
        `);
        
        console.log(`📊 Current Status: ${currentCount.games_with_scores}/${currentCount.total_games} games have scores`);
        console.log(`🎯 Remaining: ${currentCount.games_without_scores} games still need updates`);
        
        if (currentCount.games_without_scores > 0) {
            console.log('\n💡 Run this script again to continue updating the remaining games.');
        } else {
            console.log('\n🎉 All games now have scores!');
        }

    } catch (error) {
        console.error('💥 Update failed:', error);
    } finally {
        await db.close();
        console.log('\n🔌 Database connection closed');
    }
}

if (require.main === module) {
    continueScoreUpdate().catch(console.error);
}

module.exports = continueScoreUpdate;