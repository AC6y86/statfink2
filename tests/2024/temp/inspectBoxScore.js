#!/usr/bin/env node

const path = require('path');
const sqlite3 = require('sqlite3').verbose();
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });

const Tank01Service = require('../../../server/services/tank01Service');

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

async function inspectBoxScore() {
    const dbPath = path.join(__dirname, '../statfinkv1_2024.db');
    const db = new DatabaseManager(dbPath);
    
    const apiKey = process.env.TANK01_API_KEY;
    if (!apiKey) {
        console.error('❌ TANK01_API_KEY not set');
        process.exit(1);
    }

    const tank01Service = new Tank01Service(apiKey, db);

    console.log('🔍 Deep Inspection of Tank01 Box Score Data...\n');

    try {
        // Use a known game ID
        const gameId = '20240912_BUF@MIA'; // Week 2 BUF @ MIA
        
        console.log(`=== Inspecting Game: ${gameId} ===`);
        const boxScore = await tank01Service.getNFLBoxScore(gameId);
        
        if (!boxScore) {
            console.log('❌ No box score data');
            return;
        }
        
        console.log('📊 FULL BOX SCORE STRUCTURE:');
        console.log('============================');
        
        // Log the complete structure with more detail
        Object.keys(boxScore).forEach(key => {
            const value = boxScore[key];
            const type = typeof value;
            
            console.log(`\\n🔑 ${key} (${type}):`);
            
            if (type === 'string' || type === 'number' || type === 'boolean') {
                console.log(`  ${value}`);
            } else if (Array.isArray(value)) {
                console.log(`  Array with ${value.length} items`);
                if (value.length > 0) {
                    console.log(`  First item keys:`, Object.keys(value[0] || {}));
                }
            } else if (type === 'object' && value !== null) {
                console.log(`  Object keys:`, Object.keys(value));
                
                // Special inspection for likely score containers
                if (['home', 'away', 'teamStats', 'lineScore'].includes(key)) {
                    console.log(`  📋 DETAILED ${key}:`);
                    if (typeof value === 'object') {
                        Object.keys(value).forEach(subKey => {
                            const subValue = value[subKey];
                            if (typeof subValue === 'object' && subValue !== null) {
                                console.log(`    ${subKey}: ${typeof subValue} with keys [${Object.keys(subValue).slice(0, 5).join(', ')}...]`);
                            } else {
                                console.log(`    ${subKey}: ${subValue}`);
                            }
                        });
                    }
                }
            }
        });
        
        // Look specifically for score information
        console.log('\\n🎯 SEARCHING FOR SCORES:');
        console.log('=========================');
        
        // Check lineScore (this often contains quarter-by-quarter scores)
        if (boxScore.lineScore) {
            console.log('📊 Line Score Details:');
            console.log(JSON.stringify(boxScore.lineScore, null, 2));
        }
        
        // Check team stats
        if (boxScore.teamStats) {
            console.log('\\n📈 Team Stats Details:');
            console.log(JSON.stringify(boxScore.teamStats, null, 2));
        }
        
        // Check homeResult/awayResult if they exist
        if (boxScore.homeResult || boxScore.awayResult) {
            console.log('\\n🏆 Game Results:');
            if (boxScore.homeResult) console.log('Home Result:', boxScore.homeResult);
            if (boxScore.awayResult) console.log('Away Result:', boxScore.awayResult);
        }
        
        // Check game status
        if (boxScore.gameStatus) {
            console.log('\\n🚦 Game Status:', boxScore.gameStatus);
        }
        
        // Look for any field containing 'score' or 'point'
        console.log('\\n🔍 FIELDS CONTAINING SCORE/POINT:');
        console.log('==================================');
        Object.keys(boxScore).forEach(key => {
            if (key.toLowerCase().includes('score') || key.toLowerCase().includes('point')) {
                console.log(`Found: ${key} = ${JSON.stringify(boxScore[key])}`);
            }
        });

    } catch (error) {
        console.error('💥 Inspection failed:', error);
    } finally {
        await db.close();
        console.log('\\n🔌 Database connection closed');
    }
}

// Run the inspection
if (require.main === module) {
    inspectBoxScore().catch(console.error);
}

module.exports = inspectBoxScore;