const { logInfo, logError, logWarn } = require('./errorHandler');

/**
 * Debug function to undo the Weekly Update (End of Week Tasks)
 * This rolls back all changes made by performWeeklyUpdate in schedulerService
 * 
 * @param {Object} db - Database instance
 * @returns {Object} Result object with success status and details
 */
async function undoWeeklyUpdate(db) {
    const startTime = Date.now();
    const results = {
        standingsDeleted: 0,
        rostersDeleted: 0,
        statsDeleted: 0,
        matchupsReset: 0,
        previousWeek: null,
        newWeek: null,
        errors: []
    };

    // Start a transaction to ensure all operations succeed or fail together
    try {
        await db.run('BEGIN TRANSACTION');
        
        // 1. Get current week from league_settings
        const currentSettings = await db.get(
            'SELECT current_week, season_year FROM league_settings WHERE league_id = 1'
        );
        
        if (!currentSettings) {
            throw new Error('League settings not found');
        }
        
        const currentWeek = currentSettings.current_week;
        const season = currentSettings.season_year;
        results.previousWeek = currentWeek;
        
        // 2. Validate we're not already at week 1
        if (currentWeek <= 1) {
            throw new Error(`Cannot undo week ${currentWeek} - already at the beginning of the season`);
        }
        
        const targetWeek = currentWeek - 1;
        results.newWeek = targetWeek;
        
        logInfo(`Starting undo of weekly update: rolling back from week ${currentWeek} to week ${targetWeek}`);
        
        // 3. Delete standings data for current week
        const standingsResult = await db.run(
            'DELETE FROM weekly_standings WHERE week = ? AND season = ?',
            [currentWeek, season]
        );
        results.standingsDeleted = standingsResult.changes;
        logInfo(`  Deleted ${results.standingsDeleted} standings records for week ${currentWeek}`);
        
        // 4. Delete roster data for current week
        const rostersResult = await db.run(
            'DELETE FROM weekly_rosters WHERE week = ? AND season = ?',
            [currentWeek, season]
        );
        results.rostersDeleted = rostersResult.changes;
        logInfo(`  Deleted ${results.rostersDeleted} roster records for week ${currentWeek}`);
        
        // 5. Delete player stats for current week
        const statsResult = await db.run(
            'DELETE FROM player_stats WHERE week = ? AND season = ?',
            [currentWeek, season]
        );
        results.statsDeleted = statsResult.changes;
        logInfo(`  Deleted ${results.statsDeleted} player stats records for week ${currentWeek}`);
        
        // 6. Reset matchup scores for current week
        const matchupsResult = await db.run(`
            UPDATE matchups
            SET
                team1_scoring_points = 0,
                team2_scoring_points = 0
            WHERE week = ? AND season = ?
        `, [currentWeek, season]);
        results.matchupsReset = matchupsResult.changes;
        logInfo(`  Reset ${results.matchupsReset} matchup scores for week ${currentWeek}`);
        
        // 7. Decrement current week in league_settings
        await db.run(
            'UPDATE league_settings SET current_week = ? WHERE league_id = 1',
            [targetWeek]
        );
        logInfo(`  Updated current week from ${currentWeek} to ${targetWeek}`);
        
        // Commit the transaction
        await db.run('COMMIT');
        
        const duration = Date.now() - startTime;
        logInfo(`Weekly update undo completed successfully in ${duration}ms`, results);
        
        return {
            success: true,
            message: `Successfully rolled back from week ${currentWeek} to week ${targetWeek}`,
            duration,
            results
        };
        
    } catch (error) {
        // Rollback on any error
        try {
            await db.run('ROLLBACK');
        } catch (rollbackError) {
            logError('Failed to rollback transaction', rollbackError);
        }
        
        logError('Failed to undo weekly update', error);
        return {
            success: false,
            message: error.message,
            error: error.toString(),
            results
        };
    }
}

module.exports = { undoWeeklyUpdate };