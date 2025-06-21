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

async function testScoreUpdate() {
    const dbPath = path.join(__dirname, '../statfinkv1_2024.db');
    const db = new DatabaseManager(dbPath);
    
    const apiKey = process.env.TANK01_API_KEY;
    if (!apiKey) {
        console.error('❌ TANK01_API_KEY not set');
        process.exit(1);
    }

    const tank01Service = new Tank01Service(apiKey, db);
    const nflGamesService = new NFLGamesService(db, tank01Service);

    console.log('🔄 Testing NFL Games Service Score Updates...\n');

    try {
        // Get a few completed games that currently show 0-0 scores
        const testGames = await db.all(`
            SELECT game_id, week, home_team, away_team, home_score, away_score, status 
            FROM nfl_games 
            WHERE season = 2024 AND status = 'Final' AND (home_score = 0 AND away_score = 0)
            LIMIT 3
        `);

        if (testGames.length === 0) {
            console.log('❌ No completed games with 0-0 scores found');
            const allGames = await db.all(`
                SELECT game_id, week, home_team, away_team, home_score, away_score, status 
                FROM nfl_games 
                WHERE season = 2024 AND status = 'Final'
                LIMIT 3
            `);
            console.log('📊 Sample completed games:');
            allGames.forEach(game => {
                console.log(`  ${game.away_team} @ ${game.home_team}: ${game.away_score}-${game.home_score} (${game.status})`);
            });
            return;
        }

        console.log(`Found ${testGames.length} games with 0-0 scores to test:\n`);

        for (const game of testGames) {
            console.log(`=== Testing Game: ${game.away_team} @ ${game.home_team} (Week ${game.week}) ===`);
            console.log(`Game ID: ${game.game_id}`);
            console.log(`Current Score: ${game.away_score}-${game.home_score}`);
            
            // Update the game using our service
            const updated = await nflGamesService.updateGameFromAPI(game.game_id);
            
            if (updated) {
                // Check the updated score
                const updatedGame = await db.get(`
                    SELECT home_score, away_score, status, quarter, time_remaining
                    FROM nfl_games 
                    WHERE game_id = ?
                `, [game.game_id]);
                
                console.log(`✅ Updated Score: ${updatedGame.away_score}-${updatedGame.home_score}`);
                console.log(`   Status: ${updatedGame.status}`);
                if (updatedGame.quarter) console.log(`   Quarter: ${updatedGame.quarter}`);
                if (updatedGame.time_remaining) console.log(`   Time: ${updatedGame.time_remaining}`);
            } else {
                console.log('❌ Failed to update game');
            }
            
            console.log('\n' + '='.repeat(60) + '\n');
        }

        // Test summary
        console.log('=== SUMMARY ===');
        const updatedGames = await db.all(`
            SELECT game_id, home_team, away_team, home_score, away_score, status
            FROM nfl_games 
            WHERE game_id IN (${testGames.map(() => '?').join(',')})
        `, testGames.map(g => g.game_id));

        console.log('📊 Results:');
        updatedGames.forEach(game => {
            const hasScore = game.home_score > 0 || game.away_score > 0;
            const icon = hasScore ? '✅' : '❌';
            console.log(`  ${icon} ${game.away_team} @ ${game.home_team}: ${game.away_score}-${game.home_score}`);
        });

    } catch (error) {
        console.error('💥 Test failed:', error);
    } finally {
        await db.close();
        console.log('\n🔌 Database connection closed');
    }
}

if (require.main === module) {
    testScoreUpdate().catch(console.error);
}

module.exports = testScoreUpdate;