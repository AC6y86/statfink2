#!/usr/bin/env node

/**
 * Recalculate 2024 Season Script
 * 
 * This script performs a complete recalculation of the 2024 fantasy football season,
 * including syncing games, player stats, calculating fantasy points, and updating team scores.
 * 
 * Key Features:
 * - Ensures all 32 NFL team defenses (DST) exist in the database
 * - Fetches all games and player stats from Tank01 API
 * - Properly calculates defensive bonuses before DST fantasy points
 * - Updates all team scores based on weekly rosters
 * 
 * Usage: node utils/recalculate2024season.js
 * 
 * Important DST Handling:
 * - DST player IDs use format: DEF_XXX (e.g., DEF_NYG for Giants defense)
 * - Position must be "DST" not "Defense" or "DEF"
 * - DST fantasy points depend on defensive bonuses being calculated first
 * - Weekly rosters must use matching player IDs (DEF_XXX not DST_XX)
 */

const path = require('path');
const DatabaseManager = require('../server/database/database');
const Tank01Service = require('../server/services/tank01Service');
const NFLGamesService = require('../server/services/nflGamesService');
const ScoringService = require('../server/services/scoringService');
const { logInfo, logError, logWarn } = require('../server/utils/errorHandler');

class Recalculate2024SeasonFixed {
    constructor() {
        this.db = new DatabaseManager();
        this.tank01Service = new Tank01Service(process.env.TANK01_API_KEY, this.db);
        this.nflGamesService = new NFLGamesService(this.db, this.tank01Service);
        this.scoringService = new ScoringService(this.db);
        
        this.season = 2024;
        this.totalWeeks = 17;
    }

    async run() {
        try {
            logInfo('🔄 Starting 2024 season recalculation (fixed version)...');
            
            // Step 0: Ensure DST players exist
            await this.ensureDSTPlayersExist();
            
            // Step 1: Clean existing data
            await this.cleanExistingData();
            
            // Step 2: Sync all weeks
            for (let week = 1; week <= this.totalWeeks; week++) {
                logInfo(`\n📅 Processing Week ${week}...`);
                
                // Sync games for the week
                await this.syncWeekGames(week);
                
                // Sync player stats directly from Tank01 data
                await this.syncWeekStatsDirectly(week);
                
                // Small delay between weeks
                await this.delay(500);
            }
            
            // Step 3: Calculate all fantasy points
            logInfo('\n💯 Calculating fantasy points for all players...');
            await this.calculateAllFantasyPoints();
            
            // Step 4: Calculate defense bonuses for all weeks
            logInfo('\n🛡️ Calculating defense bonuses for all weeks...');
            for (let week = 1; week <= this.totalWeeks; week++) {
                await this.scoringService.calculateDefensiveBonuses(week, this.season);
            }
            
            // Step 5: Recalculate DST fantasy points after bonuses
            logInfo('\n🛡️ Recalculating DST fantasy points...');
            await this.recalculateDSTFantasyPoints();
            
            // Step 6: Recalculate all team scores
            logInfo('\n📊 Recalculating team scores for all weeks...');
            for (let week = 1; week <= this.totalWeeks; week++) {
                await this.recalculateTeamScores(week);
            }
            
            logInfo('\n✅ 2024 season recalculation completed successfully!');
            
            // Print summary
            await this.printSummary();
            
        } catch (error) {
            logError('❌ Fatal error during recalculation:', error);
            throw error;
        } finally {
            // Close database connection
            this.db.close();
        }
    }

    async cleanExistingData() {
        logInfo('🗑️ Cleaning existing 2024 data...');
        
        try {
            // Delete player stats
            const statsResult = await this.db.run(
                'DELETE FROM player_stats WHERE season = ?',
                [this.season]
            );
            logInfo(`  ✓ Deleted ${statsResult.changes} player stat records`);
            
            // Delete NFL games
            const gamesResult = await this.db.run(
                'DELETE FROM nfl_games WHERE season = ?',
                [this.season]
            );
            logInfo(`  ✓ Deleted ${gamesResult.changes} NFL game records`);
            
        } catch (error) {
            logError('Error cleaning data:', error);
            throw error;
        }
    }

    async syncWeekGames(week) {
        try {
            logInfo(`  📋 Syncing games for Week ${week}...`);
            const result = await this.nflGamesService.syncWeekGames(week, this.season);
            
            if (result.success) {
                logInfo(`    ✓ Synced ${result.gamesProcessed} games`);
                
                // Now update scores from boxscore data
                await this.updateGameScoresFromBoxscores(week);
            } else {
                logWarn(`    ⚠ Game sync failed: ${result.message}`);
            }
            
            return result;
        } catch (error) {
            logError(`Error syncing games for Week ${week}:`, error);
            throw error;
        }
    }

    async updateGameScoresFromBoxscores(week) {
        try {
            // Get all games for this week from database
            const games = await this.db.all(`
                SELECT game_id, home_team, away_team, home_score, away_score
                FROM nfl_games 
                WHERE week = ? AND season = ?
            `, [week, this.season]);
            
            logInfo(`    📊 Updating scores for ${games.length} games...`);
            let updated = 0;
            
            for (const game of games) {
                try {
                    // Fetch boxscore data
                    const boxScore = await this.tank01Service.getNFLBoxScore(game.game_id);
                    
                    if (!boxScore) {
                        continue;
                    }
                    
                    // Extract scores
                    let homeScore = 0;
                    let awayScore = 0;
                    
                    if (boxScore.homePts !== undefined && boxScore.awayPts !== undefined) {
                        homeScore = parseInt(boxScore.homePts) || 0;
                        awayScore = parseInt(boxScore.awayPts) || 0;
                    } else if (boxScore.lineScore?.home?.totalPts && boxScore.lineScore?.away?.totalPts) {
                        homeScore = parseInt(boxScore.lineScore.home.totalPts) || 0;
                        awayScore = parseInt(boxScore.lineScore.away.totalPts) || 0;
                    }
                    
                    // Update database if we found scores
                    if (homeScore > 0 || awayScore > 0) {
                        await this.db.run(`
                            UPDATE nfl_games 
                            SET home_score = ?, away_score = ?, last_updated = CURRENT_TIMESTAMP
                            WHERE game_id = ?
                        `, [homeScore, awayScore, game.game_id]);
                        updated++;
                    }
                    
                    // Small delay to avoid rate limiting
                    await this.delay(100);
                    
                } catch (error) {
                    logWarn(`      Failed to update scores for game ${game.game_id}: ${error.message}`);
                }
            }
            
            logInfo(`    ✓ Updated scores for ${updated} games`);
            
        } catch (error) {
            logError(`Error updating game scores for week ${week}:`, error);
        }
    }

    async syncWeekStatsDirectly(week) {
        try {
            logInfo(`  📊 Syncing player stats for Week ${week}...`);
            
            // Get player stats from Tank01 API
            const boxScoreData = await this.tank01Service.getPlayerStats(week, this.season);
            
            if (!boxScoreData) {
                logWarn(`No boxscore data for week ${week}`);
                return;
            }
            
            let statsCount = 0;
            
            // Process each game
            for (const gameId of Object.keys(boxScoreData)) {
                const game = boxScoreData[gameId];
                
                if (!game.playerStats) {
                    logWarn(`No playerStats in game ${gameId}`);
                    continue;
                }
                
                // Process player stats
                for (const playerId of Object.keys(game.playerStats)) {
                    const playerData = game.playerStats[playerId];
                    
                    if (!playerData || !playerData.longName) {
                        continue;
                    }
                    
                    // Use the Tank01 player ID directly
                    const stats = await this.extractPlayerStats(playerId, playerData, week, gameId);
                    if (stats) {
                        await this.insertPlayerStats(stats);
                        statsCount++;
                    }
                }
                
                // Process DST stats
                if (game.DST) {
                    await this.processDSTStats(game.DST, game, week, gameId);
                    statsCount += 2; // home and away DST
                }
            }
            
            logInfo(`    ✓ Synced ${statsCount} player stats`);
            
        } catch (error) {
            logError(`Error syncing stats for Week ${week}:`, error);
            throw error;
        }
    }

    async extractPlayerStats(playerId, playerData, week, gameId) {
        const stats = {
            player_id: playerId,
            week: week,
            season: this.season,
            game_id: gameId,
            passing_yards: 0,
            passing_tds: 0,
            interceptions: 0,
            rushing_yards: 0,
            rushing_tds: 0,
            receiving_yards: 0,
            receiving_tds: 0,
            receptions: 0,
            fumbles: 0,
            sacks: 0,
            def_interceptions: 0,
            fumbles_recovered: 0,
            def_touchdowns: 0,
            safeties: 0,
            points_allowed: 0,
            yards_allowed: 0,
            field_goals_made: 0,
            field_goals_attempted: 0,
            extra_points_made: 0,
            extra_points_attempted: 0,
            field_goals_0_39: 0,
            field_goals_40_49: 0,
            field_goals_50_plus: 0,
            two_point_conversions_pass: 0,
            two_point_conversions_run: 0,
            two_point_conversions_rec: 0,
            fantasy_points: 0
        };

        // Extract passing stats
        if (playerData.Passing) {
            const passing = playerData.Passing;
            stats.passing_yards = parseInt(passing.passYds) || 0;
            stats.passing_tds = parseInt(passing.passTD) || 0;
            stats.interceptions = parseInt(passing.int) || 0;
            if (passing.passingTwoPointConversion) {
                stats.two_point_conversions_pass = parseInt(passing.passingTwoPointConversion) || 0;
            }
        }

        // Extract rushing stats
        if (playerData.Rushing) {
            const rushing = playerData.Rushing;
            stats.rushing_yards = parseInt(rushing.rushYds) || 0;
            stats.rushing_tds = parseInt(rushing.rushTD) || 0;
            stats.fumbles = (stats.fumbles || 0) + (parseInt(rushing.fumbles) || 0);
            if (rushing.rushingTwoPointConversion) {
                stats.two_point_conversions_run = parseInt(rushing.rushingTwoPointConversion) || 0;
            }
        }

        // Extract receiving stats
        if (playerData.Receiving) {
            const receiving = playerData.Receiving;
            stats.receiving_yards = parseInt(receiving.recYds) || 0;
            stats.receiving_tds = parseInt(receiving.recTD) || 0;
            stats.receptions = parseInt(receiving.receptions) || 0;
            if (receiving.receivingTwoPointConversion) {
                stats.two_point_conversions_rec = parseInt(receiving.receivingTwoPointConversion) || 0;
            }
        }

        // Extract kicking stats
        if (playerData.Kicking) {
            const kicking = playerData.Kicking;
            stats.field_goals_made = parseInt(kicking.fgMade) || 0;
            stats.field_goals_attempted = parseInt(kicking.fgAttempts) || 0;
            stats.extra_points_made = parseInt(kicking.xpMade) || 0;
            stats.extra_points_attempted = parseInt(kicking.xpAttempts) || 0;
            
            // Parse field goal distances
            if (kicking.fgMade && kicking.fgLong) {
                // This is simplified - in reality we'd need to parse play-by-play for exact distances
                const fgMade = parseInt(kicking.fgMade) || 0;
                const longFG = parseInt(kicking.fgLong) || 0;
                
                if (longFG >= 50) {
                    stats.field_goals_50_plus = 1;
                    stats.field_goals_0_39 = Math.max(0, fgMade - 1);
                } else if (longFG >= 40) {
                    stats.field_goals_40_49 = 1;
                    stats.field_goals_0_39 = Math.max(0, fgMade - 1);
                } else {
                    stats.field_goals_0_39 = fgMade;
                }
            }
        }

        // Extract defensive stats
        if (playerData.Defense) {
            const defense = playerData.Defense;
            stats.sacks = parseFloat(defense.sacks) || 0;
            stats.def_interceptions = parseInt(defense.defInt) || 0;
            stats.fumbles_recovered = parseInt(defense.fumblesRecovered) || 0;
            stats.def_touchdowns = parseInt(defense.defTD) || 0;
            stats.safeties = parseInt(defense.safeties) || 0;
        }

        // Check if player has any meaningful stats
        const hasStats = stats.passing_yards > 0 || stats.rushing_yards > 0 || 
                        stats.receiving_yards > 0 || stats.field_goals_made > 0 ||
                        stats.passing_tds > 0 || stats.rushing_tds > 0 || 
                        stats.receiving_tds > 0 || stats.extra_points_made > 0 ||
                        stats.sacks > 0 || stats.def_interceptions > 0 ||
                        stats.two_point_conversions_pass > 0 || stats.two_point_conversions_run > 0 ||
                        stats.two_point_conversions_rec > 0;

        return hasStats ? stats : null;
    }

    async processDSTStats(dstData, game, week, gameId) {
        try {
            // Process away team DST
            if (dstData.away && game.away && game.teamIDHome && game.teamIDAway) {
                const awayTeam = game.away;
                const homeScore = parseInt(game.homePts || dstData.home?.ptsAllowed || 0);
                const homeYards = parseInt(dstData.home?.ydsAllowed || 0);
                
                await this.insertDSTStats(
                    `DEF_${awayTeam}`,
                    week,
                    gameId,
                    dstData.away,
                    homeScore,  // Away DST allowed home team's points
                    homeYards   // Away DST allowed home team's yards
                );
            }
            
            // Process home team DST
            if (dstData.home && game.home && game.teamIDHome && game.teamIDAway) {
                const homeTeam = game.home;
                const awayScore = parseInt(game.awayPts || dstData.away?.ptsAllowed || 0);
                const awayYards = parseInt(dstData.away?.ydsAllowed || 0);
                
                await this.insertDSTStats(
                    `DEF_${homeTeam}`,
                    week,
                    gameId,
                    dstData.home,
                    awayScore,  // Home DST allowed away team's points
                    awayYards   // Home DST allowed away team's yards
                );
            }
        } catch (error) {
            logWarn(`Error processing DST stats for game ${gameId}:`, error.message);
        }
    }

    async insertDSTStats(defensePlayerId, week, gameId, dstData, pointsAllowed, yardsAllowed) {
        const stats = {
            player_id: defensePlayerId,
            week: week,
            season: this.season,
            game_id: gameId,
            passing_yards: 0,
            passing_tds: 0,
            interceptions: 0,
            rushing_yards: 0,
            rushing_tds: 0,
            receiving_yards: 0,
            receiving_tds: 0,
            receptions: 0,
            fumbles: 0,
            sacks: parseInt(dstData.sacks) || 0,
            def_interceptions: parseInt(dstData.defensiveInterceptions) || 0,
            fumbles_recovered: parseInt(dstData.fumblesRecovered) || 0,
            def_touchdowns: parseInt(dstData.defTD) || 0,
            safeties: parseInt(dstData.safeties) || 0,
            points_allowed: pointsAllowed,
            yards_allowed: yardsAllowed,
            field_goals_made: 0,
            field_goals_attempted: 0,
            extra_points_made: 0,
            extra_points_attempted: 0,
            field_goals_0_39: 0,
            field_goals_40_49: 0,
            field_goals_50_plus: 0,
            two_point_conversions_pass: 0,
            two_point_conversions_run: 0,
            two_point_conversions_rec: 0,
            fantasy_points: 0
        };
        
        await this.insertPlayerStats(stats);
    }

    async insertPlayerStats(stats) {
        try {
            await this.db.run(`
                INSERT OR REPLACE INTO player_stats (
                    player_id, week, season, game_id,
                    passing_yards, passing_tds, interceptions,
                    rushing_yards, rushing_tds, receiving_yards,
                    receiving_tds, receptions, fumbles, sacks,
                    def_interceptions, fumbles_recovered, def_touchdowns,
                    safeties, points_allowed, yards_allowed,
                    field_goals_made, field_goals_attempted,
                    extra_points_made, extra_points_attempted,
                    field_goals_0_39, field_goals_40_49, field_goals_50_plus,
                    two_point_conversions_pass, two_point_conversions_run,
                    two_point_conversions_rec, fantasy_points
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                stats.player_id, stats.week, stats.season, stats.game_id,
                stats.passing_yards, stats.passing_tds, stats.interceptions,
                stats.rushing_yards, stats.rushing_tds, stats.receiving_yards,
                stats.receiving_tds, stats.receptions, stats.fumbles, stats.sacks,
                stats.def_interceptions, stats.fumbles_recovered, stats.def_touchdowns,
                stats.safeties, stats.points_allowed, stats.yards_allowed,
                stats.field_goals_made, stats.field_goals_attempted,
                stats.extra_points_made, stats.extra_points_attempted,
                stats.field_goals_0_39, stats.field_goals_40_49, stats.field_goals_50_plus,
                stats.two_point_conversions_pass, stats.two_point_conversions_run,
                stats.two_point_conversions_rec, stats.fantasy_points
            ]);
        } catch (error) {
            logWarn(`Failed to insert stats for player ${stats.player_id}:`, error.message);
        }
    }

    async calculateAllFantasyPoints() {
        try {
            const allStats = await this.db.all(`
                SELECT 
                    ps.*,
                    p.position
                FROM player_stats ps
                JOIN nfl_players p ON ps.player_id = p.player_id
                WHERE ps.season = ?
                ORDER BY ps.week, ps.player_id
            `, [this.season]);
            
            logInfo(`  Calculating fantasy points for ${allStats.length} player stats...`);
            
            let updated = 0;
            for (const stats of allStats) {
                // Skip DST players for now - they need defensive bonuses calculated first
                if (stats.position === 'DST') {
                    continue;
                }
                
                const fantasyPoints = await this.scoringService.calculateFantasyPoints(stats);
                
                await this.db.run(
                    'UPDATE player_stats SET fantasy_points = ? WHERE stat_id = ?',
                    [fantasyPoints, stats.stat_id]
                );
                
                updated++;
                
                if (updated % 1000 === 0) {
                    logInfo(`    Progress: ${updated}/${allStats.length} stats updated`);
                }
            }
            
            logInfo(`  ✓ Updated fantasy points for ${updated} players`);
            
        } catch (error) {
            logError('Error calculating fantasy points:', error);
            throw error;
        }
    }

    async recalculateTeamScores(week) {
        try {
            // Get all teams
            const teams = await this.db.all('SELECT team_id FROM teams');
            
            for (const team of teams) {
                // Calculate total points for starters
                const result = await this.db.get(`
                    SELECT SUM(ps.fantasy_points) as total_points
                    FROM weekly_rosters wr
                    JOIN player_stats ps ON wr.player_id = ps.player_id
                    WHERE wr.team_id = ? AND ps.week = ? AND ps.season = ?
                    AND wr.week = ? AND wr.season = ?
                    AND wr.roster_position = 'active'
                `, [team.team_id, week, this.season, week, this.season]);
                
                const totalPoints = result?.total_points || 0;
                
                // Update matchup scores
                await this.db.run(`
                    UPDATE matchups 
                    SET team1_points = ? 
                    WHERE team1_id = ? AND week = ? AND season = ?
                `, [totalPoints, team.team_id, week, this.season]);
                
                await this.db.run(`
                    UPDATE matchups 
                    SET team2_points = ? 
                    WHERE team2_id = ? AND week = ? AND season = ?
                `, [totalPoints, team.team_id, week, this.season]);
            }
            
            logInfo(`  ✓ Recalculated team scores for Week ${week}`);
            
        } catch (error) {
            logError(`Error recalculating team scores for Week ${week}:`, error);
            throw error;
        }
    }

    async printSummary() {
        try {
            logInfo('\n📈 Final Summary:');
            
            // Count total games
            const gamesCount = await this.db.get(
                'SELECT COUNT(*) as count FROM nfl_games WHERE season = ?',
                [this.season]
            );
            logInfo(`  • Total games: ${gamesCount.count}`);
            
            // Count total player stats
            const statsCount = await this.db.get(
                'SELECT COUNT(*) as count FROM player_stats WHERE season = ?',
                [this.season]
            );
            logInfo(`  • Total player stats: ${statsCount.count}`);
            
            // Count DST stats
            const dstCount = await this.db.get(`
                SELECT COUNT(*) as count 
                FROM player_stats ps
                JOIN nfl_players p ON ps.player_id = p.player_id
                WHERE ps.season = ? AND p.position = 'DST'
            `, [this.season]);
            logInfo(`  • Total DST stats: ${dstCount.count}`);
            
            // Count stats with fantasy points
            const withPoints = await this.db.get(
                'SELECT COUNT(*) as count FROM player_stats WHERE season = ? AND fantasy_points > 0',
                [this.season]
            );
            logInfo(`  • Stats with fantasy points: ${withPoints.count}`);
            
            // Average points per week
            const avgPoints = await this.db.get(`
                SELECT AVG(team1_points + team2_points) as avg_points
                FROM matchups
                WHERE season = ?
            `, [this.season]);
            logInfo(`  • Average points per matchup: ${(avgPoints.avg_points || 0).toFixed(2)}`);
            
        } catch (error) {
            logError('Error printing summary:', error);
        }
    }

    /**
     * Ensures all 32 NFL team defenses exist in the database with correct format
     * This prevents the issue where DST stats exist but can't be linked to players
     */
    async ensureDSTPlayersExist() {
        logInfo('🛡️ Ensuring DST players exist...');
        
        try {
            // First, clean up any duplicate DST entries
            await this.cleanupDSTDuplicates();
            
            // Check current DST count after cleanup
            const dstCount = await this.db.get(
                'SELECT COUNT(*) as count FROM nfl_players WHERE position = ?',
                ['DST']
            );
            
            if (dstCount.count === 0) {
                logInfo('  ⚠️ No DST players found. Running team defenses setup...');
                
                // Import and run the team defenses setup
                const { addTeamDefenses } = require('../server/utils/nfl/teamDefenses');
                const Database = require('../server/database/database');
                
                // Create separate connection for team defenses
                const tempDb = new Database();
                await addTeamDefenses.call({ db: tempDb });
                await tempDb.close();
                
                logInfo('  ✓ Team defenses added');
            } else if (dstCount.count < 32) {
                logInfo(`  ⚠️ Found only ${dstCount.count} DST players, expected 32`);
                // Could add logic here to add missing teams
            } else if (dstCount.count > 32) {
                logInfo(`  ⚠️ Found ${dstCount.count} DST players, expected 32`);
                // Additional cleanup might be needed
            } else {
                logInfo(`  ✓ Found ${dstCount.count} DST players (correct count)`);
            }
            
            // Fix any legacy "Defense" positions to "DST"
            const updateResult = await this.db.run(
                'UPDATE nfl_players SET position = ? WHERE position = ?',
                ['DST', 'Defense']
            );
            
            if (updateResult.changes > 0) {
                logInfo(`  ✓ Updated ${updateResult.changes} Defense positions to DST`);
            }
            
        } catch (error) {
            logError('Error ensuring DST players exist:', error);
            throw error;
        }
    }
    
    /**
     * Cleans up duplicate DST player entries
     * Keeps only the DEF_XXX format and removes other formats
     */
    async cleanupDSTDuplicates() {
        logInfo('  🧹 Cleaning up DST duplicates...');
        
        try {
            // Delete the xxxdefense_xxx_dst format
            const result1 = await this.db.run(`
                DELETE FROM nfl_players 
                WHERE position = 'DST' 
                AND player_id LIKE '%defense_%_dst'
            `);
            
            if (result1.changes > 0) {
                logInfo(`    ✓ Removed ${result1.changes} xxxdefense_xxx_dst entries`);
            }
            
            // Delete entries where team = 'DST'
            const result2 = await this.db.run(`
                DELETE FROM nfl_players 
                WHERE position = 'DST' 
                AND team = 'DST'
            `);
            
            if (result2.changes > 0) {
                logInfo(`    ✓ Removed ${result2.changes} entries with team='DST'`);
            }
            
            // Delete other known duplicate patterns
            const result3 = await this.db.run(`
                DELETE FROM nfl_players 
                WHERE position = 'DST' 
                AND (player_id = 'SF_DST' OR player_id LIKE '%_dst_dst')
            `);
            
            if (result3.changes > 0) {
                logInfo(`    ✓ Removed ${result3.changes} other duplicate entries`);
            }
            
            // Keep only DEF_XXX format - delete any DST that doesn't match this pattern
            const result4 = await this.db.run(`
                DELETE FROM nfl_players 
                WHERE position = 'DST' 
                AND player_id NOT LIKE 'DEF_%'
            `);
            
            if (result4.changes > 0) {
                logInfo(`    ✓ Removed ${result4.changes} non-standard DST entries`);
            }
            
            const totalDeleted = result1.changes + result2.changes + result3.changes + result4.changes;
            if (totalDeleted === 0) {
                logInfo('    ✓ No duplicates found');
            }
            
        } catch (error) {
            logError('Error cleaning up DST duplicates:', error);
            throw error;
        }
    }
    
    /**
     * Recalculates fantasy points for all DST players
     * Must be run AFTER defensive bonuses are calculated
     * DST scoring includes: defensive TDs and bonuses for fewest points/yards allowed
     */
    async recalculateDSTFantasyPoints() {
        try {
            // Get all DST stats including bonus columns
            const dstStats = await this.db.all(`
                SELECT 
                    ps.*,
                    p.position
                FROM player_stats ps
                JOIN nfl_players p ON ps.player_id = p.player_id
                WHERE ps.season = ? AND p.position = 'DST'
                ORDER BY ps.week, ps.player_id
            `, [this.season]);
            
            logInfo(`  Recalculating fantasy points for ${dstStats.length} DST stats...`);
            
            let updated = 0;
            for (const stats of dstStats) {
                const fantasyPoints = await this.scoringService.calculateFantasyPoints(stats);
                
                await this.db.run(
                    'UPDATE player_stats SET fantasy_points = ? WHERE stat_id = ?',
                    [fantasyPoints, stats.stat_id]
                );
                
                updated++;
                
                if (updated % 100 === 0) {
                    logInfo(`    Progress: ${updated}/${dstStats.length} DST stats updated`);
                }
            }
            
            logInfo(`  ✓ Updated fantasy points for ${updated} DST stats`);
            
        } catch (error) {
            logError('Error recalculating DST fantasy points:', error);
            throw error;
        }
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// Main execution
async function main() {
    const recalculator = new Recalculate2024SeasonFixed();
    
    try {
        await recalculator.run();
        process.exit(0);
    } catch (error) {
        logError('Fatal error:', error);
        process.exit(1);
    }
}

// Run if called directly
if (require.main === module) {
    main();
}

module.exports = Recalculate2024SeasonFixed;