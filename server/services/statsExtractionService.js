const { logInfo, logWarn } = require('../utils/errorHandler');

class StatsExtractionService {
    constructor(db) {
        this.db = db;
    }

    /**
     * Extract all stats from Tank01 player data
     */
    async extractPlayerStats(playerId, playerData, week, gameId, season) {
        const stats = {
            player_id: playerId,
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

        // Extract each stat category
        this.extractPassingStats(stats, playerData.Passing);
        this.extractRushingStats(stats, playerData.Rushing);
        this.extractReceivingStats(stats, playerData.Receiving);
        this.extractKickingStats(stats, playerData.Kicking);
        this.extractDefensiveStats(stats, playerData.Defense);

        // Check if player has any meaningful stats
        const hasStats = this.hasValidStats(stats);

        return hasStats ? stats : null;
    }

    /**
     * Extract passing statistics
     */
    extractPassingStats(stats, passingData) {
        if (!passingData) return;

        stats.passing_yards = parseInt(passingData.passYds) || 0;
        stats.passing_tds = parseInt(passingData.passTD) || 0;
        stats.interceptions = parseInt(passingData.int) || 0;
        
        if (passingData.passingTwoPointConversion) {
            stats.two_point_conversions_pass = parseInt(passingData.passingTwoPointConversion) || 0;
        }
    }

    /**
     * Extract rushing statistics
     */
    extractRushingStats(stats, rushingData) {
        if (!rushingData) return;

        stats.rushing_yards = parseInt(rushingData.rushYds) || 0;
        stats.rushing_tds = parseInt(rushingData.rushTD) || 0;
        stats.fumbles = (stats.fumbles || 0) + (parseInt(rushingData.fumbles) || 0);
        
        if (rushingData.rushingTwoPointConversion) {
            stats.two_point_conversions_run = parseInt(rushingData.rushingTwoPointConversion) || 0;
        }
    }

    /**
     * Extract receiving statistics
     */
    extractReceivingStats(stats, receivingData) {
        if (!receivingData) return;

        stats.receiving_yards = parseInt(receivingData.recYds) || 0;
        stats.receiving_tds = parseInt(receivingData.recTD) || 0;
        stats.receptions = parseInt(receivingData.receptions) || 0;
        
        if (receivingData.receivingTwoPointConversion) {
            stats.two_point_conversions_rec = parseInt(receivingData.receivingTwoPointConversion) || 0;
        }
    }

    /**
     * Extract kicking statistics
     */
    extractKickingStats(stats, kickingData) {
        if (!kickingData) return;

        stats.field_goals_made = parseInt(kickingData.fgMade) || 0;
        stats.field_goals_attempted = parseInt(kickingData.fgAttempts) || 0;
        stats.extra_points_made = parseInt(kickingData.xpMade) || 0;
        stats.extra_points_attempted = parseInt(kickingData.xpAttempts) || 0;
        
        // Parse field goal distances
        if (kickingData.fgMade && kickingData.fgLong) {
            this.categorizeFieldGoals(stats, kickingData);
        }
    }

    /**
     * Categorize field goals by distance
     */
    categorizeFieldGoals(stats, kickingData) {
        // This is simplified - in reality we'd need to parse play-by-play for exact distances
        const fgMade = parseInt(kickingData.fgMade) || 0;
        const longFG = parseInt(kickingData.fgLong) || 0;
        
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

    /**
     * Extract defensive statistics
     */
    extractDefensiveStats(stats, defenseData) {
        if (!defenseData) return;

        stats.sacks = parseFloat(defenseData.sacks) || 0;
        stats.def_interceptions = parseInt(defenseData.defInt) || 0;
        stats.fumbles_recovered = parseInt(defenseData.fumblesRecovered) || 0;
        stats.def_touchdowns = parseInt(defenseData.defTD) || 0;
        stats.safeties = parseInt(defenseData.safeties) || 0;
    }

    /**
     * Check if player has any meaningful stats
     */
    hasValidStats(stats) {
        return stats.passing_yards > 0 || stats.rushing_yards > 0 || 
               stats.receiving_yards > 0 || stats.field_goals_made > 0 ||
               stats.passing_tds > 0 || stats.rushing_tds > 0 || 
               stats.receiving_tds > 0 || stats.extra_points_made > 0 ||
               stats.sacks > 0 || stats.def_interceptions > 0 ||
               stats.two_point_conversions_pass > 0 || stats.two_point_conversions_run > 0 ||
               stats.two_point_conversions_rec > 0;
    }

    /**
     * Insert player stats into database
     */
    async insertPlayerStats(stats) {
        try {
            // First check if player exists in database
            const player = await this.db.get(
                'SELECT player_id FROM nfl_players WHERE player_id = ?',
                [stats.player_id]
            );
            
            if (!player) {
                // Player doesn't exist - skip this stat entry
                logWarn(`Skipping stats for unknown player ${stats.player_id}`);
                return false;
            }
            
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
            return true;
        } catch (error) {
            logWarn(`Failed to insert stats for player ${stats.player_id}:`, error.message);
            return false;
        }
    }

    /**
     * Batch insert multiple player stats
     */
    async batchInsertStats(statsList) {
        let inserted = 0;
        let failed = 0;

        for (const stats of statsList) {
            const success = await this.insertPlayerStats(stats);
            if (success) {
                inserted++;
            } else {
                failed++;
            }
        }

        if (failed > 0) {
            logWarn(`Batch insert completed: ${inserted} successful, ${failed} failed`);
        }

        return { inserted, failed };
    }
}

module.exports = StatsExtractionService;