const { logInfo, logError } = require('../utils/errorHandler');

class DataCleanupService {
    constructor(db) {
        this.db = db;
    }

    /**
     * Clean all existing data for a season
     */
    async cleanExistingData(season) {
        logInfo(`🗑️ Cleaning existing ${season} data...`);
        
        try {
            // Clean player stats
            const statsDeleted = await this.cleanPlayerStats(season);
            
            // Clean NFL games
            const gamesDeleted = await this.cleanNFLGames(season);
            
            return {
                statsDeleted,
                gamesDeleted,
                success: true
            };
        } catch (error) {
            logError('Error cleaning data:', error);
            throw error;
        }
    }

    /**
     * Delete player stats for a specific season
     */
    async cleanPlayerStats(season) {
        try {
            const result = await this.db.run(
                'DELETE FROM player_stats WHERE season = ?',
                [season]
            );
            
            logInfo(`  ✓ Deleted ${result.changes} player stat records`);
            return result.changes;
        } catch (error) {
            logError(`Error cleaning player stats for season ${season}:`, error);
            throw error;
        }
    }

    /**
     * Delete NFL games for a specific season
     */
    async cleanNFLGames(season) {
        try {
            const result = await this.db.run(
                'DELETE FROM nfl_games WHERE season = ?',
                [season]
            );
            
            logInfo(`  ✓ Deleted ${result.changes} NFL game records`);
            return result.changes;
        } catch (error) {
            logError(`Error cleaning NFL games for season ${season}:`, error);
            throw error;
        }
    }

    /**
     * Clean data for a specific week
     */
    async cleanWeekData(week, season) {
        logInfo(`🗑️ Cleaning data for Week ${week}, ${season}...`);

        try {
            // Clean player stats for the week
            const statsResult = await this.db.run(
                'DELETE FROM player_stats WHERE week = ? AND season = ?',
                [week, season]
            );

            // Clean NFL games for the week
            const gamesResult = await this.db.run(
                'DELETE FROM nfl_games WHERE week = ? AND season = ?',
                [week, season]
            );

            // Reset matchup points to 0 (keep the matchup records but clear the points)
            const matchupsResult = await this.db.run(
                `UPDATE matchups
                 SET team1_scoring_points = 0,
                     team2_scoring_points = 0
                 WHERE week = ? AND season = ?`,
                [week, season]
            );

            logInfo(`  ✓ Deleted ${statsResult.changes} player stats and ${gamesResult.changes} games`);
            logInfo(`  ✓ Reset points for ${matchupsResult.changes} matchups`);

            return {
                statsDeleted: statsResult.changes,
                gamesDeleted: gamesResult.changes,
                matchupsReset: matchupsResult.changes,
                success: true
            };
        } catch (error) {
            logError(`Error cleaning week ${week} data:`, error);
            throw error;
        }
    }

    /**
     * Clean orphaned data (stats without corresponding games, etc.)
     */
    async cleanOrphanedData(season) {
        logInfo('🧹 Cleaning orphaned data...');
        
        try {
            // Delete stats for players that don't exist
            const orphanedStats = await this.db.run(`
                DELETE FROM player_stats 
                WHERE season = ? 
                AND player_id NOT IN (SELECT player_id FROM nfl_players)
            `, [season]);
            
            if (orphanedStats.changes > 0) {
                logInfo(`  ✓ Removed ${orphanedStats.changes} orphaned player stats`);
            }
            
            // Delete stats for games that don't exist
            const orphanedGameStats = await this.db.run(`
                DELETE FROM player_stats 
                WHERE season = ? 
                AND game_id NOT IN (SELECT game_id FROM nfl_games WHERE season = ?)
            `, [season, season]);
            
            if (orphanedGameStats.changes > 0) {
                logInfo(`  ✓ Removed ${orphanedGameStats.changes} stats for non-existent games`);
            }
            
            return {
                orphanedStats: orphanedStats.changes,
                orphanedGameStats: orphanedGameStats.changes,
                success: true
            };
        } catch (error) {
            logError('Error cleaning orphaned data:', error);
            throw error;
        }
    }
}

module.exports = DataCleanupService;