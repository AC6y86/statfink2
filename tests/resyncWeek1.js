require('dotenv').config();
const StatsSyncService = require('../server/services/statsSyncService');
const DatabaseManager = require('../server/database/database');
const Tank01Service = require('../server/services/tank01Service');
const ScoringService = require('../server/services/scoringService');

async function resyncWeek1() {
    const db = new DatabaseManager();
    const tank01Service = new Tank01Service(process.env.TANK01_API_KEY, db);
    const scoringService = new ScoringService(db);
    const syncService = new StatsSyncService(db);
    syncService.tank01Service = tank01Service;
    syncService.scoringService = scoringService;
    
    try {
        console.log('Re-syncing Week 1 2024 stats to capture 2-point conversions...');
        const result = await syncService.syncWeeklyStats(1, 2024);
        
        if (result.success) {
            console.log('Sync completed successfully!');
            console.log(result.message);
            
            // Check D'Andre Swift's updated stats
            const swiftStats = await db.get(`
                SELECT * FROM player_stats 
                WHERE player_id = '4259545' AND week = 1 AND season = 2024
            `);
            
            console.log('\nD\'Andre Swift Week 1 stats:');
            console.log('Rushing yards:', swiftStats.rushing_yards);
            console.log('Receiving 2PT conversions:', swiftStats.two_point_conversions_rec);
            console.log('Fantasy points:', swiftStats.fantasy_points);
            
            // Check Caleb Williams' updated stats
            const calebStats = await db.get(`
                SELECT * FROM player_stats 
                WHERE player_id = '4431611' AND week = 1 AND season = 2024
            `);
            
            console.log('\nCaleb Williams Week 1 stats:');
            console.log('Passing yards:', calebStats.passing_yards);
            console.log('Passing TDs:', calebStats.passing_tds);
            console.log('Passing 2PT conversions:', calebStats.two_point_conversions_pass);
            console.log('Fantasy points:', calebStats.fantasy_points);
            
        } else {
            console.error('Sync failed:', result.error);
        }
        
    } catch (error) {
        console.error('Error:', error.message);
    } finally {
        await db.close();
    }
}

resyncWeek1();