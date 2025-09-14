const { logInfo, logError } = require('../utils/errorHandler');

class FantasyPointsCalculationService {
    constructor(db, scoringService) {
        this.db = db;
        this.scoringService = scoringService;
    }

    /**
     * Calculate fantasy points for all players in a season
     * Skips DST players initially as they need defensive bonuses calculated first
     */
    async calculateAllFantasyPoints(season) {
        try {
            const allStats = await this.db.all(`
                SELECT 
                    ps.*,
                    p.position
                FROM player_stats ps
                JOIN nfl_players p ON ps.player_id = p.player_id
                WHERE ps.season = ?
                ORDER BY ps.week, ps.player_id
            `, [season]);
            
            logInfo(`  Calculating fantasy points for ${allStats.length} player stats...`);
            
            let updated = 0;
            let skippedDST = 0;
            
            for (const stats of allStats) {
                // Skip DST players for now - they need defensive bonuses calculated first
                if (stats.position === 'DST') {
                    skippedDST++;
                    continue;
                }

                const fantasyPoints = await this.scoringService.calculateFantasyPoints(stats);

                // Add detailed logging for debugging
                if (updated < 5 || (stats.rushing_tds > 0 || stats.receiving_tds > 0 || stats.passing_tds > 0)) {
                    logInfo(`    Updating stat_id ${stats.stat_id}: calculated ${fantasyPoints} points (TDs: ${stats.rushing_tds}/${stats.receiving_tds}/${stats.passing_tds})`);
                }

                const updateResult = await this.db.run(
                    'UPDATE player_stats SET fantasy_points = ? WHERE stat_id = ?',
                    [fantasyPoints, stats.stat_id]
                );

                if (updateResult.changes === 0) {
                    logError(`    WARNING: No rows updated for stat_id ${stats.stat_id}`);
                }

                updated++;

                if (updated % 1000 === 0) {
                    logInfo(`    Progress: ${updated}/${allStats.length - skippedDST} stats updated`);
                }
            }
            
            logInfo(`  ✓ Updated fantasy points for ${updated} players (skipped ${skippedDST} DST players)`);
            
            return {
                success: true,
                updated,
                skippedDST,
                total: allStats.length
            };
            
        } catch (error) {
            logError('Error calculating fantasy points:', error);
            throw error;
        }
    }

    /**
     * Calculate DST fantasy points after defensive bonuses have been applied
     * This method should be called AFTER scoringService.calculateDefensiveBonuses()
     */
    async calculateEndOfWeekDSTBonuses(season) {
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
            `, [season]);
            
            logInfo(`  Calculating DST bonuses for ${dstStats.length} DST stats...`);
            
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
            
            return {
                success: true,
                updated,
                total: dstStats.length
            };
            
        } catch (error) {
            logError('Error calculating DST fantasy points:', error);
            throw error;
        }
    }

    /**
     * Calculate fantasy points for a specific week
     */
    async calculateWeekFantasyPoints(week, season) {
        try {
            const weekStats = await this.db.all(`
                SELECT 
                    ps.*,
                    p.position
                FROM player_stats ps
                JOIN nfl_players p ON ps.player_id = p.player_id
                WHERE ps.week = ? AND ps.season = ?
                ORDER BY ps.player_id
            `, [week, season]);
            
            logInfo(`  Calculating fantasy points for Week ${week}: ${weekStats.length} stats...`);
            
            let updated = 0;
            let skippedDST = 0;
            
            for (const stats of weekStats) {
                // Skip DST players if defensive bonuses haven't been calculated
                if (stats.position === 'DST' && !stats.def_points_allowed_bonus && !stats.def_yards_allowed_bonus) {
                    skippedDST++;
                    continue;
                }
                
                const fantasyPoints = await this.scoringService.calculateFantasyPoints(stats);
                
                await this.db.run(
                    'UPDATE player_stats SET fantasy_points = ? WHERE stat_id = ?',
                    [fantasyPoints, stats.stat_id]
                );
                
                updated++;
            }
            
            logInfo(`  ✓ Week ${week}: Updated ${updated} players${skippedDST > 0 ? `, skipped ${skippedDST} DST` : ''}`);
            
            return {
                success: true,
                week,
                updated,
                skippedDST,
                total: weekStats.length
            };
            
        } catch (error) {
            logError(`Error calculating fantasy points for week ${week}:`, error);
            throw error;
        }
    }

    /**
     * Recalculate fantasy points for a specific player
     */
    async recalculatePlayerPoints(playerId, season) {
        try {
            const playerStats = await this.db.all(`
                SELECT 
                    ps.*,
                    p.position
                FROM player_stats ps
                JOIN nfl_players p ON ps.player_id = p.player_id
                WHERE ps.player_id = ? AND ps.season = ?
                ORDER BY ps.week
            `, [playerId, season]);
            
            let updated = 0;
            
            for (const stats of playerStats) {
                const fantasyPoints = await this.scoringService.calculateFantasyPoints(stats);
                
                await this.db.run(
                    'UPDATE player_stats SET fantasy_points = ? WHERE stat_id = ?',
                    [fantasyPoints, stats.stat_id]
                );
                
                updated++;
            }
            
            return {
                success: true,
                playerId,
                weeksUpdated: updated
            };
            
        } catch (error) {
            logError(`Error recalculating points for player ${playerId}:`, error);
            throw error;
        }
    }

    /**
     * Get top fantasy performers for a week
     */
    async getTopPerformers(week, season, limit = 10) {
        try {
            const topPerformers = await this.db.all(`
                SELECT 
                    ps.player_id,
                    p.name,
                    p.position,
                    p.team,
                    ps.fantasy_points,
                    ps.week
                FROM player_stats ps
                JOIN nfl_players p ON ps.player_id = p.player_id
                WHERE ps.week = ? AND ps.season = ?
                ORDER BY ps.fantasy_points DESC
                LIMIT ?
            `, [week, season, limit]);
            
            return topPerformers;
        } catch (error) {
            logError(`Error getting top performers for week ${week}:`, error);
            throw error;
        }
    }
}

module.exports = FantasyPointsCalculationService;