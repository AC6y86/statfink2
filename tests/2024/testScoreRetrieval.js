#!/usr/bin/env node

const path = require('path');
const sqlite3 = require('sqlite3').verbose();
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const Tank01Service = require('../../server/services/tank01Service');

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

async function testScoreRetrieval() {
    const dbPath = path.join(__dirname, 'statfinkv1_2024.db');
    const db = new DatabaseManager(dbPath);
    
    const apiKey = process.env.TANK01_API_KEY;
    if (!apiKey) {
        console.error('❌ TANK01_API_KEY not set');
        process.exit(1);
    }

    const tank01Service = new Tank01Service(apiKey, db);

    console.log('🔍 Testing Score Retrieval from Tank01 API...\n');

    try {
        // Get a few game IDs from our database to test
        const sampleGames = await db.all(`
            SELECT game_id, week, home_team, away_team, status 
            FROM nfl_games 
            WHERE season = 2024 AND status = 'Final'
            LIMIT 5
        `);

        if (sampleGames.length === 0) {
            console.log('❌ No completed games found in database');
            return;
        }

        console.log(`Found ${sampleGames.length} completed games to test:\n`);

        for (const game of sampleGames) {
            console.log(`=== Testing Game: ${game.away_team} @ ${game.home_team} (Week ${game.week}) ===`);
            console.log(`Game ID: ${game.game_id}`);
            
            try {
                // Test 1: Try getNFLBoxScore
                console.log('📊 Trying getNFLBoxScore...');
                const boxScore = await tank01Service.getNFLBoxScore(game.game_id);
                
                if (boxScore) {
                    console.log('✅ Box score data received!');
                    
                    // Look for score fields in the response
                    const scoreFields = ['homeScore', 'awayScore', 'home_score', 'away_score', 
                                       'homeTeamScore', 'awayTeamScore', 'score'];
                    
                    console.log('🔍 Checking for score fields...');
                    scoreFields.forEach(field => {
                        if (boxScore.hasOwnProperty(field)) {
                            console.log(`  Found ${field}: ${boxScore[field]}`);
                        }
                    });
                    
                    // Log top-level structure
                    console.log('📋 Top-level fields in box score:', Object.keys(boxScore).slice(0, 15));
                    
                    // Look for team data
                    if (boxScore.home) {
                        console.log('🏠 Home team data:', typeof boxScore.home, Object.keys(boxScore.home || {}).slice(0, 10));
                    }
                    if (boxScore.away) {
                        console.log('✈️  Away team data:', typeof boxScore.away, Object.keys(boxScore.away || {}).slice(0, 10));
                    }
                    
                    // Look for game info
                    if (boxScore.gameInfo) {
                        console.log('ℹ️  Game info:', Object.keys(boxScore.gameInfo || {}).slice(0, 10));
                    }
                    
                } else {
                    console.log('❌ No box score data returned');
                }
                
            } catch (error) {
                console.log(`❌ Error getting box score: ${error.message}`);
            }
            
            console.log('\n' + '='.repeat(60) + '\n');
            
            // Only test a couple games to avoid rate limits
            if (sampleGames.indexOf(game) >= 1) break;
        }

        // Test 2: Try getLiveScores to see what current format looks like
        console.log('=== Testing getLiveScores ===');
        try {
            const liveScores = await tank01Service.getLiveScores();
            if (liveScores) {
                console.log('✅ Live scores data received!');
                console.log('📋 Top-level fields:', Object.keys(liveScores).slice(0, 10));
                
                // Look at first few entries
                if (Array.isArray(liveScores)) {
                    console.log(`📊 Array with ${liveScores.length} entries`);
                    if (liveScores.length > 0) {
                        console.log('📋 First entry fields:', Object.keys(liveScores[0] || {}).slice(0, 10));
                    }
                } else if (typeof liveScores === 'object') {
                    const keys = Object.keys(liveScores);
                    console.log(`📊 Object with keys: ${keys.slice(0, 10)}`);
                    if (keys.length > 0) {
                        const firstKey = keys[0];
                        console.log(`📋 First entry (${firstKey}):`, Object.keys(liveScores[firstKey] || {}).slice(0, 10));
                    }
                }
            } else {
                console.log('❌ No live scores data returned');
            }
        } catch (error) {
            console.log(`❌ Error getting live scores: ${error.message}`);
        }

    } catch (error) {
        console.error('💥 Test failed:', error);
    } finally {
        await db.close();
        console.log('🔌 Database connection closed');
    }
}

// Run the test
if (require.main === module) {
    testScoreRetrieval().catch(console.error);
}

module.exports = testScoreRetrieval;