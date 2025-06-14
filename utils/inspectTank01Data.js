#!/usr/bin/env node

const Tank01Service = require('../server/services/tank01Service');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

/**
 * Tank01 Data Inspector
 * 
 * This script manually queries Tank01 API to examine the exact structure
 * of player stats data before making changes to the import script.
 * 
 * Focus areas:
 * - Two-point conversions (pass/run/receiving)
 * - Defensive stats (sacks, interceptions, fumble recoveries, defensive TDs)
 * - Return touchdowns (kick returns, punt returns)
 * - Team defense stats (points allowed, yards allowed)
 */

class Tank01DataInspector {
    constructor() {
        this.tank01 = new Tank01Service(process.env.TANK01_API_KEY);
        this.outputDir = path.join(__dirname, 'tank01_samples');
        
        // Games to test - picking some interesting 2024 games
        this.testGames = [
            // Week 1 - likely to have various stats
            { week: 1, season: 2024, description: "Week 1 sample" },
            // Week 5 - mid-season games
            { week: 5, season: 2024, description: "Week 5 sample" },
            // Week 10 - later season games  
            { week: 10, season: 2024, description: "Week 10 sample" },
            // Week 15 - playoff push games
            { week: 15, season: 2024, description: "Week 15 sample" }
        ];
    }

    async run() {
        console.log('🔍 Starting Tank01 Data Inspection...\n');

        if (!process.env.TANK01_API_KEY) {
            throw new Error('TANK01_API_KEY environment variable is required');
        }

        // Create output directory
        if (!fs.existsSync(this.outputDir)) {
            fs.mkdirSync(this.outputDir, { recursive: true });
        }

        try {
            // Test each week
            for (const testWeek of this.testGames) {
                console.log(`\n📅 Inspecting ${testWeek.description} (Week ${testWeek.week}, ${testWeek.season})...`);
                await this.inspectWeek(testWeek.week, testWeek.season, testWeek.description);
                
                // Add delay between weeks to respect rate limits
                await this.delay(3000);
            }

            console.log('\n🎉 Tank01 Data Inspection Complete!');
            console.log(`📁 Sample data saved to: ${this.outputDir}`);
            console.log('\n📋 Review the JSON files to understand Tank01 data structure before updating import script.');

        } catch (error) {
            console.error('❌ Error during Tank01 inspection:', error.message);
            throw error;
        }
    }

    async inspectWeek(week, season, description) {
        try {
            // Get games for this week
            console.log(`  🎮 Fetching games for week ${week}...`);
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

            // Sample first 2 games from this week
            const samplesToInspect = games.slice(0, 2);
            
            for (let i = 0; i < samplesToInspect.length; i++) {
                const game = samplesToInspect[i];
                console.log(`    🔍 Inspecting game ${game.gameID}...`);
                
                await this.inspectGame(game.gameID, week, season, `${description}_game_${i + 1}`);
                
                // Small delay between games
                await this.delay(2000);
            }

        } catch (error) {
            console.error(`  ❌ Error inspecting week ${week}:`, error.message);
        }
    }

    async inspectGame(gameID, week, season, filePrefix) {
        try {
            // Get box score data
            const boxScoreData = await this.tank01.getNFLBoxScore(gameID);
            
            if (!boxScoreData || boxScoreData.error) {
                console.log(`    ⚠️  No box score data for game ${gameID}`);
                return;
            }

            // Save raw data for analysis
            const fileName = `${filePrefix}_${gameID}_raw.json`;
            const filePath = path.join(this.outputDir, fileName);
            fs.writeFileSync(filePath, JSON.stringify(boxScoreData, null, 2));
            console.log(`    💾 Raw data saved: ${fileName}`);

            // Analyze player stats structure
            const analysis = await this.analyzePlayerStats(boxScoreData, gameID);
            
            // Save analysis
            const analysisFileName = `${filePrefix}_${gameID}_analysis.json`;
            const analysisPath = path.join(this.outputDir, analysisFileName);
            fs.writeFileSync(analysisPath, JSON.stringify(analysis, null, 2));
            console.log(`    📊 Analysis saved: ${analysisFileName}`);

            // Log interesting findings
            if (analysis.interestingFindings.length > 0) {
                console.log(`    🎯 Interesting findings:`);
                analysis.interestingFindings.forEach(finding => {
                    console.log(`      - ${finding}`);
                });
            }

        } catch (error) {
            console.error(`    ❌ Error inspecting game ${gameID}:`, error.message);
        }
    }

    async analyzePlayerStats(boxScoreData, gameID) {
        const analysis = {
            gameID,
            timestamp: new Date().toISOString(),
            playerStatsStructure: {},
            twoPointConversions: {
                found: false,
                fieldNames: [],
                examples: []
            },
            defensiveStats: {
                found: false,
                fieldNames: [],
                examples: []
            },
            returnTouchdowns: {
                found: false,
                fieldNames: [],
                examples: []
            },
            teamDefenseStats: {
                found: false,
                fieldNames: [],
                examples: []
            },
            samplePlayers: [],
            interestingFindings: []
        };

        try {
            const playerStats = boxScoreData.playerStats || {};
            
            if (Object.keys(playerStats).length === 0) {
                analysis.interestingFindings.push("No playerStats found in box score data");
                return analysis;
            }

            console.log(`      📊 Analyzing ${Object.keys(playerStats).length} players...`);
            
            // Analyze first 10 players and look for interesting stats
            const playerIds = Object.keys(playerStats).slice(0, 10);
            
            for (const playerId of playerIds) {
                const playerData = playerStats[playerId];
                
                if (!playerData || typeof playerData !== 'object') continue;
                
                // Store sample player for reference
                if (analysis.samplePlayers.length < 3) {
                    analysis.samplePlayers.push({
                        playerId,
                        name: playerData.longName || playerData.name || 'Unknown',
                        position: playerData.pos || playerData.position || 'Unknown',
                        team: playerData.team || playerData.teamAbv || 'Unknown',
                        allFields: Object.keys(playerData)
                    });
                }

                // Look for two-point conversions
                this.searchForTwoPointConversions(playerData, analysis);
                
                // Look for defensive stats
                this.searchForDefensiveStats(playerData, analysis);
                
                // Look for return touchdowns
                this.searchForReturnTouchdowns(playerData, analysis);
                
                // Look for team defense stats
                this.searchForTeamDefenseStats(playerData, analysis);
            }
            
            // Look at top-level structure
            analysis.playerStatsStructure = {
                topLevelKeys: Object.keys(boxScoreData).slice(0, 20),
                hasPlayerStats: !!boxScoreData.playerStats,
                playerStatsKeys: boxScoreData.playerStats ? Object.keys(boxScoreData.playerStats).length : 0
            };
            
        } catch (error) {
            analysis.interestingFindings.push(`Error during analysis: ${error.message}`);
        }

        return analysis;
    }

    searchForTwoPointConversions(playerData, analysis) {
        const twoPointFields = [
            'TwoPoint', 'twoPoint', 'two_point', 'twoPointConversions',
            'twoPointPass', 'twoPointRush', 'twoPointRec',
            'two_point_pass', 'two_point_rush', 'two_point_rec'
        ];
        
        // Check direct fields
        twoPointFields.forEach(field => {
            if (playerData[field] !== undefined) {
                analysis.twoPointConversions.found = true;
                if (!analysis.twoPointConversions.fieldNames.includes(field)) {
                    analysis.twoPointConversions.fieldNames.push(field);
                }
                analysis.twoPointConversions.examples.push({
                    player: playerData.longName || playerData.name || 'Unknown',
                    field,
                    value: playerData[field]
                });
            }
        });

        // Check nested objects
        ['Passing', 'Rushing', 'Receiving'].forEach(category => {
            if (playerData[category] && typeof playerData[category] === 'object') {
                twoPointFields.forEach(field => {
                    if (playerData[category][field] !== undefined) {
                        analysis.twoPointConversions.found = true;
                        const nestedField = `${category}.${field}`;
                        if (!analysis.twoPointConversions.fieldNames.includes(nestedField)) {
                            analysis.twoPointConversions.fieldNames.push(nestedField);
                        }
                        analysis.twoPointConversions.examples.push({
                            player: playerData.longName || playerData.name || 'Unknown',
                            field: nestedField,
                            value: playerData[category][field]
                        });
                    }
                });
            }
        });
    }

    searchForDefensiveStats(playerData, analysis) {
        const defenseFields = [
            'sacks', 'tackles', 'soloTackles', 'assistedTackles',
            'interceptions', 'passesDefended', 'fumbleRecoveries',
            'forcedFumbles', 'defensiveTDs', 'safeties',
            'def_int', 'def_td', 'def_sacks'
        ];
        
        // Check direct fields
        defenseFields.forEach(field => {
            if (playerData[field] !== undefined && playerData[field] > 0) {
                analysis.defensiveStats.found = true;
                if (!analysis.defensiveStats.fieldNames.includes(field)) {
                    analysis.defensiveStats.fieldNames.push(field);
                }
                analysis.defensiveStats.examples.push({
                    player: playerData.longName || playerData.name || 'Unknown',
                    position: playerData.pos || 'Unknown',
                    field,
                    value: playerData[field]
                });
            }
        });

        // Check for Defense category
        if (playerData.Defense && typeof playerData.Defense === 'object') {
            Object.keys(playerData.Defense).forEach(field => {
                if (playerData.Defense[field] > 0) {
                    analysis.defensiveStats.found = true;
                    const nestedField = `Defense.${field}`;
                    if (!analysis.defensiveStats.fieldNames.includes(nestedField)) {
                        analysis.defensiveStats.fieldNames.push(nestedField);
                    }
                    analysis.defensiveStats.examples.push({
                        player: playerData.longName || playerData.name || 'Unknown',
                        position: playerData.pos || 'Unknown',
                        field: nestedField,
                        value: playerData.Defense[field]
                    });
                }
            });
        }
    }

    searchForReturnTouchdowns(playerData, analysis) {
        const returnFields = [
            'kickReturnTDs', 'puntReturnTDs', 'returnTDs',
            'kick_return_tds', 'punt_return_tds', 'return_tds',
            'kickReturnTouchdowns', 'puntReturnTouchdowns'
        ];
        
        // Check direct fields
        returnFields.forEach(field => {
            if (playerData[field] !== undefined && playerData[field] > 0) {
                analysis.returnTouchdowns.found = true;
                if (!analysis.returnTouchdowns.fieldNames.includes(field)) {
                    analysis.returnTouchdowns.fieldNames.push(field);
                }
                analysis.returnTouchdowns.examples.push({
                    player: playerData.longName || playerData.name || 'Unknown',
                    field,
                    value: playerData[field]
                });
            }
        });

        // Check for Returns category
        if (playerData.Returns && typeof playerData.Returns === 'object') {
            Object.keys(playerData.Returns).forEach(field => {
                if (playerData.Returns[field] > 0) {
                    analysis.returnTouchdowns.found = true;
                    const nestedField = `Returns.${field}`;
                    if (!analysis.returnTouchdowns.fieldNames.includes(nestedField)) {
                        analysis.returnTouchdowns.fieldNames.push(nestedField);
                    }
                    analysis.returnTouchdowns.examples.push({
                        player: playerData.longName || playerData.name || 'Unknown',
                        field: nestedField,
                        value: playerData.Returns[field]
                    });
                }
            });
        }
    }

    searchForTeamDefenseStats(playerData, analysis) {
        // Only check DST players
        const position = playerData.pos || playerData.position || '';
        if (position !== 'DST') return;

        const teamDefenseFields = [
            'pointsAllowed', 'yardsAllowed', 'points_allowed', 'yards_allowed',
            'totalPointsAllowed', 'totalYardsAllowed'
        ];
        
        // Check direct fields
        teamDefenseFields.forEach(field => {
            if (playerData[field] !== undefined) {
                analysis.teamDefenseStats.found = true;
                if (!analysis.teamDefenseStats.fieldNames.includes(field)) {
                    analysis.teamDefenseStats.fieldNames.push(field);
                }
                analysis.teamDefenseStats.examples.push({
                    player: playerData.longName || playerData.name || 'Unknown',
                    team: playerData.team || playerData.teamAbv || 'Unknown',
                    field,
                    value: playerData[field]
                });
            }
        });

        // Check for Defense category
        if (playerData.Defense && typeof playerData.Defense === 'object') {
            Object.keys(playerData.Defense).forEach(field => {
                analysis.teamDefenseStats.found = true;
                const nestedField = `Defense.${field}`;
                if (!analysis.teamDefenseStats.fieldNames.includes(nestedField)) {
                    analysis.teamDefenseStats.fieldNames.push(nestedField);
                }
                analysis.teamDefenseStats.examples.push({
                    player: playerData.longName || playerData.name || 'Unknown',
                    team: playerData.team || playerData.teamAbv || 'Unknown',
                    field: nestedField,
                    value: playerData.Defense[field]
                });
            });
        }
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// Main execution
async function main() {
    const inspector = new Tank01DataInspector();
    
    try {
        await inspector.run();
    } catch (error) {
        console.error('❌ Fatal error:', error.message);
        process.exit(1);
    }
}

// Run if called directly
if (require.main === module) {
    main();
}

module.exports = { Tank01DataInspector };