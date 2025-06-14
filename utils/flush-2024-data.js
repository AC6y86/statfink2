#!/usr/bin/env node

const DatabaseManager = require('./server/database/database');

async function flush2024Data() {
    const db = new DatabaseManager();
    
    try {
        console.log('Starting selective flush of 2024 data...');
        
        await db.beginTransaction();
        
        // Clear 2024 season data only
        console.log('Clearing 2024 player stats...');
        const statsResult = await db.run('DELETE FROM player_stats WHERE season = 2024');
        console.log(`Deleted ${statsResult.changes} player stats records`);
        
        console.log('Clearing 2024 matchups...');
        const matchupsResult = await db.run('DELETE FROM matchups WHERE season = 2024');
        console.log(`Deleted ${matchupsResult.changes} matchup records`);
        
        console.log('Clearing 2024 weekly rosters...');
        const weeklyResult = await db.run('DELETE FROM weekly_rosters WHERE season = 2024');
        console.log(`Deleted ${weeklyResult.changes} weekly roster records`);
        
        // Clear current roster assignments but keep teams and players
        console.log('Clearing current fantasy rosters...');
        const rostersResult = await db.run('DELETE FROM fantasy_rosters');
        console.log(`Deleted ${rostersResult.changes} roster assignment records`);
        
        // Reset team stats but keep team info
        console.log('Resetting team statistics...');
        const teamStatsResult = await db.run(`
            UPDATE teams 
            SET total_points = 0, wins = 0, losses = 0, ties = 0
        `);
        console.log(`Reset stats for ${teamStatsResult.changes} teams`);
        
        // Reset league to week 1 but keep it as 2024 season
        console.log('Resetting league to week 1...');
        await db.run('UPDATE league_settings SET current_week = 1 WHERE league_id = 1');
        
        await db.commit();
        console.log('✅ Successfully flushed 2024 data while preserving structure');
        console.log('Ready for fresh 2024 data import');
        
    } catch (error) {
        await db.rollback();
        console.error('❌ Error during flush operation:', error);
        throw error;
    } finally {
        await db.close();
    }
}

// Run if called directly
if (require.main === module) {
    flush2024Data()
        .then(() => {
            console.log('Flush operation completed successfully');
            process.exit(0);
        })
        .catch((error) => {
            console.error('Flush operation failed:', error);
            process.exit(1);
        });
}

module.exports = flush2024Data;