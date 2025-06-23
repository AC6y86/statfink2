const { logInfo, logError, logWarn } = require('../utils/errorHandler');
const ScoringPlayParserService = require('./scoringPlayParserService');

class DSTManagementService {
    constructor(db, tank01Service = null) {
        this.db = db;
        this.tank01Service = tank01Service;
        this.scoringPlayParser = new ScoringPlayParserService();
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
                const { addTeamDefenses } = require('../utils/nfl/teamDefenses');
                const Database = require('../database/database');
                
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
     * Process DST stats from game data with scoring play analysis
     */
    async processDSTStats(dstData, game, week, gameId, season) {
        try {
            // Get detailed boxscore data for scoring play analysis
            let scoringPlaysData = null;
            if (this.tank01Service) {
                try {
                    scoringPlaysData = await this.tank01Service.getNFLBoxScore(gameId);
                } catch (error) {
                    logWarn(`Could not fetch detailed boxscore for game ${gameId}:`, error.message);
                }
            }

            // Parse scoring plays to get defensive TD breakdown
            let awayDefensiveBreakdown = null;
            let homeDefensiveBreakdown = null;
            
            if (scoringPlaysData && game.away && game.home) {
                const parsedPlays = this.scoringPlayParser.parseScoringPlays(scoringPlaysData, game.home, game.away);
                awayDefensiveBreakdown = this.scoringPlayParser.getDefensiveTouchdownBreakdown(parsedPlays, game.away);
                homeDefensiveBreakdown = this.scoringPlayParser.getDefensiveTouchdownBreakdown(parsedPlays, game.home);
            }

            // Process away team DST
            if (dstData.away && game.away && game.teamIDHome && game.teamIDAway) {
                const awayTeam = game.away;
                const homeScore = parseInt(game.homePts || dstData.home?.ptsAllowed || 0);
                const homeYards = parseInt(dstData.away?.ydsAllowed || 0);  // Away DST's yards allowed
                
                await this.insertDSTStats(
                    `DEF_${awayTeam}`,
                    week,
                    gameId,
                    dstData.away,
                    homeScore,  // Away DST allowed home team's points
                    homeYards,  // Away DST allowed home team's yards
                    season,
                    awayDefensiveBreakdown
                );
            }
            
            // Process home team DST
            if (dstData.home && game.home && game.teamIDHome && game.teamIDAway) {
                const homeTeam = game.home;
                const awayScore = parseInt(game.awayPts || dstData.away?.ptsAllowed || 0);
                const awayYards = parseInt(dstData.home?.ydsAllowed || 0);  // Home DST's yards allowed
                
                await this.insertDSTStats(
                    `DEF_${homeTeam}`,
                    week,
                    gameId,
                    dstData.home,
                    awayScore,  // Home DST allowed away team's points
                    awayYards,  // Home DST allowed away team's yards
                    season,
                    homeDefensiveBreakdown
                );
            }
        } catch (error) {
            logWarn(`Error processing DST stats for game ${gameId}:`, error.message);
        }
    }

    /**
     * Insert DST stats into the database
     */
    async insertDSTStats(defensePlayerId, week, gameId, dstData, pointsAllowed, yardsAllowed, season, defensiveBreakdown = null) {
        const stats = {
            player_id: defensePlayerId,
            week: week,
            season: season,
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
            def_touchdowns: 0, // Don't use unreliable API defTD field
            safeties: defensiveBreakdown?.safeties || parseInt(dstData.safeties) || 0,
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
            fantasy_points: 0,
            // New defensive TD breakdown fields
            def_int_return_tds: defensiveBreakdown?.def_int_return_tds || 0,
            def_fumble_return_tds: defensiveBreakdown?.def_fumble_return_tds || 0,
            def_blocked_return_tds: defensiveBreakdown?.def_blocked_return_tds || 0,
            kick_return_tds: 0, // These are for individual players, not DST
            punt_return_tds: 0  // These are for individual players, not DST
        };
        
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
                    two_point_conversions_rec, fantasy_points,
                    def_int_return_tds, def_fumble_return_tds, def_blocked_return_tds,
                    kick_return_tds, punt_return_tds
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                stats.two_point_conversions_rec, stats.fantasy_points,
                stats.def_int_return_tds, stats.def_fumble_return_tds, stats.def_blocked_return_tds,
                stats.kick_return_tds, stats.punt_return_tds
            ]);
        } catch (error) {
            logWarn(`Failed to insert stats for player ${stats.player_id}:`, error.message);
        }
    }
}

module.exports = DSTManagementService;