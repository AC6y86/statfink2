const { logInfo, logError } = require('./errorHandler');
const ScoringPlayersService = require('../services/scoringPlayersService');

/**
 * Utility script to recalculate fantasy points for all player stats using the new scoring system
 */
async function recalculateAllFantasyPoints(db, scoringService) {
    logInfo('Starting fantasy points recalculation...');
    
    try {
        // Get all player stats from the database
        const allStats = await db.all(`
            SELECT 
                ps.stat_id,
                ps.player_id,
                ps.week,
                ps.season,
                ps.passing_yards,
                ps.passing_tds,
                ps.interceptions,
                ps.rushing_yards,
                ps.rushing_tds,
                ps.receiving_yards,
                ps.receiving_tds,
                ps.receptions,
                ps.fumbles,
                ps.sacks,
                ps.def_interceptions,
                ps.fumbles_recovered,
                ps.def_touchdowns,
                ps.safeties,
                ps.points_allowed,
                ps.yards_allowed,
                ps.field_goals_made,
                ps.field_goals_attempted,
                ps.extra_points_made,
                ps.extra_points_attempted,
                ps.field_goals_0_39,
                ps.field_goals_40_49,
                ps.field_goals_50_plus,
                ps.two_point_conversions_pass,
                ps.two_point_conversions_run,
                ps.two_point_conversions_rec,
                ps.return_tds,
                np.position,
                ps.fantasy_points as old_fantasy_points
            FROM player_stats ps
            JOIN nfl_players np ON ps.player_id = np.player_id
            ORDER BY ps.season DESC, ps.week DESC, ps.stat_id
        `);
        
        logInfo(`Found ${allStats.length} player stat records to recalculate`);
        
        let updatedCount = 0;
        let pointsDifferenceSum = 0;
        const batchSize = 100;
        
        // Process in batches
        for (let i = 0; i < allStats.length; i += batchSize) {
            const batch = allStats.slice(i, i + batchSize);
            const updates = [];
            
            for (const stats of batch) {
                // Add default values for any missing fields that scoring service might expect
                const statsWithDefaults = {
                    ...stats,
                    fumbles_lost: 0,
                    return_tds: 0,
                    two_point_conversions_pass: 0,
                    two_point_conversions_run: 0,
                    two_point_conversions_rec: 0,
                    def_points_allowed_rank: null,
                    def_yards_allowed_rank: null,
                    ...stats // Override with actual values if they exist
                };
                
                // Calculate new fantasy points using the updated scoring system
                const newPoints = await scoringService.calculateFantasyPoints(statsWithDefaults);
                const oldPoints = stats.old_fantasy_points || 0;
                const difference = newPoints - oldPoints;
                
                pointsDifferenceSum += Math.abs(difference);
                
                // Prepare batch update
                updates.push({
                    stat_id: stats.stat_id,
                    fantasy_points: newPoints,
                    old_points: oldPoints,
                    difference: difference
                });
                
                if (Math.abs(difference) > 5) {
                    logInfo(`Significant change for ${stats.player_id} Week ${stats.week}: ${oldPoints} → ${newPoints} (${difference > 0 ? '+' : ''}${difference.toFixed(2)})`);
                }
            }
            
            // Execute batch update
            const updatePromises = updates.map(update => 
                db.run('UPDATE player_stats SET fantasy_points = ? WHERE stat_id = ?', 
                    [update.fantasy_points, update.stat_id])
            );
            
            await Promise.all(updatePromises);
            updatedCount += updates.length;
            
            logInfo(`Processed batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(allStats.length/batchSize)} - Updated ${updatedCount}/${allStats.length} records`);
        }
        
        // Re-mark scoring lineups and update matchup totals from them for every
        // week/season. (The old private recalculateTeamScores here summed the
        // FULL active roster into matchup scores - the corruption documented in
        // docs/DEFENSIVE_SCORING.md - and must not come back.)
        logInfo('Recalculating scoring lineups and matchup totals...');
        const matchups = await db.all('SELECT DISTINCT week, season FROM matchups ORDER BY season DESC, week DESC');

        const scoringPlayersService = new ScoringPlayersService(db);
        for (const matchup of matchups) {
            await scoringPlayersService.calculateScoringPlayers(matchup.week, matchup.season);
        }
        
        logInfo(`Fantasy points recalculation completed!`);
        logInfo(`- Updated ${updatedCount} player stat records`);
        logInfo(`- Average points change: ${(pointsDifferenceSum / allStats.length).toFixed(2)}`);
        logInfo(`- Updated team scores for ${matchups.length} week/season combinations`);
        
        return {
            success: true,
            updatedRecords: updatedCount,
            totalRecords: allStats.length,
            averageChange: pointsDifferenceSum / allStats.length,
            weekSeasonCombinations: matchups.length
        };
        
    } catch (error) {
        logError('Error recalculating fantasy points:', error);
        throw error;
    }
}

module.exports = {
    recalculateAllFantasyPoints
};