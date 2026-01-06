const { logInfo, logError } = require('./errorHandler');

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
        
        // Update team scores for all weeks/seasons
        logInfo('Recalculating team scores...');
        const matchups = await db.all('SELECT DISTINCT week, season FROM matchups ORDER BY season DESC, week DESC');
        
        for (const matchup of matchups) {
            await recalculateTeamScores(db, matchup.week, matchup.season);
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

/**
 * Recalculate team scores for a specific week/season
 */
async function recalculateTeamScores(db, week, season) {
    try {
        // Get all teams
        const teams = await db.all('SELECT team_id FROM teams');
        
        for (const team of teams) {
            // Calculate total points for starters
            const result = await db.get(`
                SELECT SUM(ps.fantasy_points) as total_points
                FROM weekly_rosters wr
                JOIN player_stats ps ON wr.player_id = ps.player_id
                WHERE wr.team_id = ? AND ps.week = ? AND ps.season = ?
                AND wr.week = ? AND wr.season = ?
                AND wr.roster_position = 'active'
            `, [team.team_id, week, season, week, season]);
            
            const totalPoints = result?.total_points || 0;
            
            // Update matchup scores
            await db.run(`
                UPDATE matchups
                SET team1_scoring_points = ?
                WHERE team1_id = ? AND week = ? AND season = ?
            `, [totalPoints, team.team_id, week, season]);

            await db.run(`
                UPDATE matchups
                SET team2_scoring_points = ?
                WHERE team2_id = ? AND week = ? AND season = ?
            `, [totalPoints, team.team_id, week, season]);
        }
        
    } catch (error) {
        logError(`Error recalculating team scores for Week ${week}, ${season}:`, error);
        throw error;
    }
}

module.exports = {
    recalculateAllFantasyPoints,
    recalculateTeamScores
};