#!/usr/bin/env node

const Tank01Service = require('../server/services/tank01Service');
require('dotenv').config();

async function testTank01Stats() {
    const tank01 = new Tank01Service(process.env.TANK01_API_KEY);
    
    try {
        console.log('🧪 Testing Tank01 API for 2024 stats...\n');
        
        // Test 1: Get games for week 1
        console.log('1. Testing games for Week 1, 2024...');
        const gamesData = await tank01.getNFLGamesForWeek(1, 2024);
        
        if (gamesData) {
            console.log('✅ Games data received');
            console.log('Games structure:', {
                type: typeof gamesData,
                keys: Object.keys(gamesData).slice(0, 10),
                hasGames: !!gamesData.games
            });
            
            // Extract games
            const games = Object.values(gamesData).filter(game => 
                game && typeof game === 'object' && game.gameID
            );
            
            console.log(`📋 Found ${games.length} games`);
            
            if (games.length > 0) {
                const sampleGame = games[0];
                console.log('Sample game:', {
                    gameID: sampleGame.gameID,
                    away: sampleGame.away,
                    home: sampleGame.home,
                    keys: Object.keys(sampleGame).slice(0, 10)
                });
                
                // Test 2: Get box score for sample game
                console.log(`\n2. Testing box score for game ${sampleGame.gameID}...`);
                const boxScore = await tank01.getNFLBoxScore(sampleGame.gameID);
                
                if (boxScore) {
                    console.log('✅ Box score received');
                    console.log('Box score structure:', {
                        type: typeof boxScore,
                        keys: Object.keys(boxScore).slice(0, 10),
                        hasPlayerStats: !!boxScore.playerStats,
                        hasFantasyPoints: !!boxScore.fantasyPoints,
                        hasStats: !!boxScore.stats,
                        hasHome: !!boxScore.home,
                        hasAway: !!boxScore.away
                    });
                    
                    // Look for player stats in various locations
                    const possibleStatsPaths = [
                        boxScore.playerStats,
                        boxScore.stats,
                        boxScore.fantasyPoints,
                        boxScore.home?.playerStats,
                        boxScore.away?.playerStats
                    ];
                    
                    for (let i = 0; i < possibleStatsPaths.length; i++) {
                        const statsPath = possibleStatsPaths[i];
                        if (statsPath && typeof statsPath === 'object') {
                            console.log(`\n📊 Found stats in path ${i}:`, {
                                keys: Object.keys(statsPath).slice(0, 5),
                                structure: typeof statsPath
                            });
                            
                            // Show sample player data
                            for (const [key, value] of Object.entries(statsPath)) {
                                if (Array.isArray(value) && value.length > 0) {
                                    console.log(`\n👤 Sample ${key} player:`, {
                                        name: value[0].longName || value[0].name || 'unnamed',
                                        position: value[0].pos || value[0].position,
                                        fantasyPoints: value[0].fantasyPoints || value[0].fantasy_points || 'not found',
                                        allKeys: Object.keys(value[0]).slice(0, 10)
                                    });
                                    break;
                                } else if (value && typeof value === 'object') {
                                    const players = Object.values(value);
                                    if (players.length > 0 && players[0] && typeof players[0] === 'object') {
                                        console.log(`\n👤 Sample ${key} player:`, {
                                            name: players[0].longName || players[0].name || 'unnamed',
                                            position: players[0].pos || players[0].position,
                                            fantasyPoints: players[0].fantasyPoints || players[0].fantasy_points || 'not found',
                                            allKeys: Object.keys(players[0]).slice(0, 10)
                                        });
                                        break;
                                    }
                                }
                            }
                            break;
                        }
                    }
                    
                } else {
                    console.log('❌ No box score data received');
                }
            }
        } else {
            console.log('❌ No games data received');
        }
        
    } catch (error) {
        console.error('❌ Error testing Tank01 API:', error.message);
    }
}

// Run the test
testTank01Stats();