const path = require('path');
const DatabaseManager = require('../server/database/database');
const ScoringService = require('../server/services/scoringService');
const { recalculateAllFantasyPoints } = require('../server/utils/recalculateFantasyPoints');
const { logInfo, logError } = require('../server/utils/errorHandler');

/**
 * Script to recalculate all 2024 fantasy points using the updated scoring system
 */
async function recalculate2024Scores() {
    let db;
    
    try {
        logInfo('Starting 2024 fantasy points recalculation...');
        
        // Initialize database connection
        db = new DatabaseManager();
        
        // Initialize scoring service
        const scoringService = new ScoringService(db);
        
        // First, calculate defensive bonuses for all 2024 weeks
        logInfo('Calculating defensive bonuses for 2024...');
        const weeks2024 = await db.all(`
            SELECT DISTINCT week 
            FROM player_stats 
            WHERE season = 2024 
            ORDER BY week
        `);
        
        for (const { week } of weeks2024) {
            logInfo(`Processing defensive bonuses for Week ${week}...`);
            await scoringService.calculateDefensiveBonuses(week, 2024);
        }
        
        logInfo(`Calculated defensive bonuses for ${weeks2024.length} weeks in 2024`);
        
        // Filter recalculation to 2024 only by modifying the query temporarily
        const originalRecalc = require('../server/utils/recalculateFantasyPoints');
        
        // Get 2024 stats only (using actual columns from schema)
        const stats2024 = await db.all(`
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
                ps.def_points_allowed_rank,
                ps.def_yards_allowed_rank,
                ps.two_point_conversions_pass,
                ps.two_point_conversions_run,
                ps.two_point_conversions_rec,
                ps.return_tds,
                ps.def_points_allowed_bonus,
                ps.def_yards_allowed_bonus,
                ps.player_name,
                np.position,
                ps.fantasy_points as old_fantasy_points
            FROM player_stats ps
            JOIN nfl_players np ON ps.player_id = np.player_id
            WHERE ps.season = 2024
            ORDER BY ps.week DESC, ps.stat_id
        `);
        
        logInfo(`Found ${stats2024.length} 2024 player stat records to recalculate`);
        
        let updatedCount = 0;
        let pointsDifferenceSum = 0;
        const batchSize = 100;
        const significantChanges = [];
        
        // Process in batches
        for (let i = 0; i < stats2024.length; i += batchSize) {
            const batch = stats2024.slice(i, i + batchSize);
            const updates = [];
            
            for (const stats of batch) {
                // Calculate new fantasy points using the updated scoring system
                const newPoints = await scoringService.calculateFantasyPoints(stats);
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
                
                // Check for 2-point conversions
                const has2PC = (stats.two_point_conversions_pass || 0) + 
                              (stats.two_point_conversions_run || 0) + 
                              (stats.two_point_conversions_rec || 0) > 0;
                
                if (Math.abs(difference) > 5 || has2PC) {
                    significantChanges.push({
                        player_id: stats.player_id,
                        player_name: stats.player_name,
                        week: stats.week,
                        position: stats.position,
                        old_points: oldPoints,
                        new_points: newPoints,
                        difference: difference,
                        has2PC: has2PC,
                        two_point_conversions_pass: stats.two_point_conversions_pass || 0,
                        two_point_conversions_run: stats.two_point_conversions_run || 0,
                        two_point_conversions_rec: stats.two_point_conversions_rec || 0
                    });
                }
            }
            
            // Execute batch update
            const updatePromises = updates.map(update => 
                db.run('UPDATE player_stats SET fantasy_points = ? WHERE stat_id = ?', 
                    [update.fantasy_points, update.stat_id])
            );
            
            await Promise.all(updatePromises);
            updatedCount += updates.length;
            
            logInfo(`Processed batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(stats2024.length/batchSize)} - Updated ${updatedCount}/${stats2024.length} records`);
        }
        
        // Update team scores for all 2024 weeks
        logInfo('Recalculating 2024 team scores...');
        const matchups2024 = await db.all(`
            SELECT DISTINCT week, season 
            FROM matchups 
            WHERE season = 2024 
            ORDER BY week DESC
        `);
        
        for (const matchup of matchups2024) {
            await recalculateTeamScores(db, matchup.week, matchup.season);
        }
        
        // Show significant changes and 2-point conversions
        if (significantChanges.length > 0) {
            logInfo(`\nSignificant changes (>5 points) and 2-point conversions:`);
            
            // First show all 2-point conversions
            const twoPointPlayers = significantChanges.filter(c => c.has2PC);
            if (twoPointPlayers.length > 0) {
                logInfo(`\n2-Point Conversions Found (${twoPointPlayers.length} total):`);
                twoPointPlayers.forEach(change => {
                    let twoPointDetails = [];
                    if (change.two_point_conversions_pass > 0) twoPointDetails.push(`${change.two_point_conversions_pass} pass`);
                    if (change.two_point_conversions_run > 0) twoPointDetails.push(`${change.two_point_conversions_run} run`);
                    if (change.two_point_conversions_rec > 0) twoPointDetails.push(`${change.two_point_conversions_rec} rec`);
                    
                    logInfo(`${change.player_name} (${change.position}) Week ${change.week}: ${twoPointDetails.join(', ')} - Points: ${change.old_points.toFixed(2)} → ${change.new_points.toFixed(2)} (${change.difference > 0 ? '+' : ''}${change.difference.toFixed(2)})`);
                });
            }
            
            // Then show other significant changes
            const otherChanges = significantChanges.filter(c => !c.has2PC && Math.abs(c.difference) > 5);
            if (otherChanges.length > 0) {
                logInfo(`\nOther significant changes (>5 points):`);
                otherChanges.slice(0, 10).forEach(change => {
                    logInfo(`${change.player_name} (${change.position}) Week ${change.week}: ${change.old_points.toFixed(2)} → ${change.new_points.toFixed(2)} (${change.difference > 0 ? '+' : ''}${change.difference.toFixed(2)})`);
                });
                if (otherChanges.length > 10) {
                    logInfo(`... and ${otherChanges.length - 10} more significant changes`);
                }
            }
        }
        
        logInfo(`\n2024 Fantasy points recalculation completed!`);
        logInfo(`- Updated ${updatedCount} player stat records`);
        logInfo(`- Average points change: ${(pointsDifferenceSum / stats2024.length).toFixed(2)}`);
        logInfo(`- Updated team scores for ${matchups2024.length} weeks`);
        logInfo(`- Found ${significantChanges.length} significant changes (>5 points)`);
        
        return {
            success: true,
            updatedRecords: updatedCount,
            totalRecords: stats2024.length,
            averageChange: pointsDifferenceSum / stats2024.length,
            weeksCovered: matchups2024.length,
            significantChanges: significantChanges.length
        };
        
    } catch (error) {
        logError('Error recalculating 2024 fantasy points:', error);
        throw error;
    } finally {
        if (db && db.close) {
            db.close();
        }
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
                JOIN tank01_player_mapping m ON wr.player_id = m.our_player_id
                JOIN player_stats ps ON m.tank01_player_id = ps.player_id
                WHERE wr.team_id = ? AND ps.week = ? AND ps.season = ?
                AND wr.week = ? AND wr.season = ?
                AND wr.roster_position = 'active'
            `, [team.team_id, week, season, week, season]);
            
            const totalPoints = result?.total_points || 0;
            
            // Update matchup scores
            await db.run(`
                UPDATE matchups 
                SET team1_points = ? 
                WHERE team1_id = ? AND week = ? AND season = ?
            `, [totalPoints, team.team_id, week, season]);
            
            await db.run(`
                UPDATE matchups 
                SET team2_points = ? 
                WHERE team2_id = ? AND week = ? AND season = ?
            `, [totalPoints, team.team_id, week, season]);
        }
        
    } catch (error) {
        logError(`Error recalculating team scores for Week ${week}, ${season}:`, error);
        throw error;
    }
}

// Run the recalculation if this script is executed directly
if (require.main === module) {
    recalculate2024Scores()
        .then(result => {
            console.log('\nRecalculation completed successfully!', result);
            process.exit(0);
        })
        .catch(error => {
            console.error('\nRecalculation failed:', error);
            process.exit(1);
        });
}

module.exports = { recalculate2024Scores };