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

async function updateAllGameScores() {
    const dbPath = path.join(__dirname, '../statfinkv1_2024.db');
    const db = new DatabaseManager(dbPath);
    
    const apiKey = process.env.TANK01_API_KEY;
    if (!apiKey) {
        console.error('❌ TANK01_API_KEY not set');
        process.exit(1);
    }

    const tank01Service = new Tank01Service(apiKey, db);
    const nflGamesService = new NFLGamesService(db, tank01Service);

    console.log('🔄 Updating all NFL game scores in statfink_2024.db...\n');

    try {
        // Get all games from the database
        const allGames = await db.all(`
            SELECT game_id, week, home_team, away_team, home_score, away_score, status 
            FROM nfl_games 
            WHERE season = 2024 
            ORDER BY week, game_id
        `);

        if (allGames.length === 0) {
            console.log('❌ No games found in database');
            return;
        }

        console.log(`📊 Found ${allGames.length} games to update\n`);

        // Count games that need updating (currently 0-0)
        const needingUpdate = allGames.filter(g => g.home_score === 0 && g.away_score === 0);
        console.log(`🎯 ${needingUpdate.length} games currently show 0-0 scores`);
        console.log(`✅ ${allGames.length - needingUpdate.length} games already have scores\n`);

        let updated = 0;
        let failed = 0;
        let alreadyHadScores = 0;

        // Process games in batches to avoid overwhelming the API
        const batchSize = 5;
        for (let i = 0; i < allGames.length; i += batchSize) {
            const batch = allGames.slice(i, i + batchSize);
            
            console.log(`📦 Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(allGames.length/batchSize)} (games ${i+1}-${Math.min(i+batchSize, allGames.length)})`);

            for (const game of batch) {
                try {
                    const hadScoresBefore = game.home_score > 0 || game.away_score > 0;
                    
                    // Update the game using our service
                    const success = await nflGamesService.updateGameFromAPI(game.game_id);
                    
                    if (success) {
                        // Check if scores actually changed
                        const updatedGame = await db.get(`
                            SELECT home_score, away_score, status
                            FROM nfl_games 
                            WHERE game_id = ?
                        `, [game.game_id]);
                        
                        const hasScoresNow = updatedGame.home_score > 0 || updatedGame.away_score > 0;
                        
                        if (hadScoresBefore) {
                            alreadyHadScores++;
                            console.log(`  ✓ ${game.away_team} @ ${game.home_team} (Week ${game.week}): Already had scores`);
                        } else if (hasScoresNow) {
                            updated++;
                            console.log(`  ✅ ${game.away_team} @ ${game.home_team} (Week ${game.week}): Updated to ${updatedGame.away_score}-${updatedGame.home_score}`);
                        } else {
                            console.log(`  ⚪ ${game.away_team} @ ${game.home_team} (Week ${game.week}): No scores available (${updatedGame.status})`);
                        }
                    } else {
                        failed++;
                        console.log(`  ❌ ${game.away_team} @ ${game.home_team} (Week ${game.week}): Failed to update`);
                    }
                } catch (error) {
                    failed++;
                    console.log(`  💥 ${game.away_team} @ ${game.home_team} (Week ${game.week}): Error - ${error.message}`);
                }
            }
            
            // Small delay between batches to be nice to the API
            if (i + batchSize < allGames.length) {
                console.log('⏱️  Waiting 2 seconds before next batch...\n');
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        console.log('\n' + '='.repeat(60));
        console.log('📈 UPDATE SUMMARY');
        console.log('='.repeat(60));
        console.log(`Total games processed: ${allGames.length}`);
        console.log(`✅ Successfully updated: ${updated}`);
        console.log(`✓ Already had scores: ${alreadyHadScores}`);
        console.log(`❌ Failed to update: ${failed}`);
        console.log(`⚪ No scores available: ${allGames.length - updated - alreadyHadScores - failed}`);

        // Final verification - count games with scores
        const finalCount = await db.get(`
            SELECT 
                COUNT(*) as total_games,
                COUNT(CASE WHEN home_score > 0 OR away_score > 0 THEN 1 END) as games_with_scores,
                COUNT(CASE WHEN home_score = 0 AND away_score = 0 THEN 1 END) as games_without_scores
            FROM nfl_games 
            WHERE season = 2024
        `);

        console.log('\n📊 FINAL STATUS:');
        console.log(`Games with scores: ${finalCount.games_with_scores}/${finalCount.total_games} (${Math.round(finalCount.games_with_scores/finalCount.total_games*100)}%)`);
        console.log(`Games without scores: ${finalCount.games_without_scores}`);

    } catch (error) {
        console.error('💥 Update failed:', error);
    } finally {
        await db.close();
        console.log('\n🔌 Database connection closed');
    }
}

if (require.main === module) {
    updateAllGameScores().catch(console.error);
}

module.exports = updateAllGameScores;